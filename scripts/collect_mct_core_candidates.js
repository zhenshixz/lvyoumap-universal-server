const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const contentDir = path.join(rootDir, 'content');
const runtimeDir = path.join(rootDir, '.runtime');
const portalBaseUrl = 'https://lyfw.mct.gov.cn/site/special/province';

const args = new Map(process.argv.slice(2).map(arg => {
  const match = arg.match(/^--([^=]+)=(.*)$/);
  return match ? [match[1], match[2]] : [arg.replace(/^--/, ''), true];
}));
const provinceName = String(args.get('province') || '');

const portalKeys = {
  西藏: 'xizang',
  内蒙古: 'neimenggu',
};

function readJson(filePath, fallback = {}) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\r\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function decodeText(value) {
  return String(value || '')
    .replace(/\\u([0-9a-f]{4})/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/\\"/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function expectedCount(html, label, unit) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`${escaped}[^0-9]{0,12}(\\d+)${unit}`));
  return match ? Number(match[1]) : 0;
}

function directString(record, field) {
  const match = record.match(new RegExp(`${field}:"([^"]*)"`));
  return match ? decodeText(match[1]) : '';
}

function extractGroups(html) {
  const records = [...html.matchAll(/\{id:([^,]+),status_id:[^,]+,type:([^,]+),name:"([^"]+)"([\s\S]*?),weather:/g)]
    .map(match => {
      const body = match[4];
      const picture = body.match(/picture:\["([^"]+)"\]/);
      return {
        sourceRecordId: String(match[1] || '').trim(),
        type: match[2],
        name: decodeText(match[3]),
        picture: picture ? decodeText(picture[1]) : '',
        longitude: directString(body, 'longitude'),
        latitude: directString(body, 'latitude'),
        address: directString(body, 'address'),
        introduce: directString(body, 'introduce'),
      };
    })
    .filter(item => item.name);
  const groups = new Map();
  for (const record of records) {
    if (!groups.has(record.type)) groups.set(record.type, []);
    groups.get(record.type).push(record);
  }
  return [...groups.values()].map(items => {
    const unique = new Map();
    for (const item of items) if (!unique.has(item.name)) unique.set(item.name, item);
    return [...unique.values()];
  });
}

function selectGroupByCount(groups, count, label, score) {
  const matches = groups.filter(group => group.length === count);
  if (!matches.length) throw new Error(`${label}列表解析失败：页面标注 ${count} 个，但没有找到同数量的数据组。`);
  const ranked = matches.map(group => ({ group, score: score(group) })).sort((a, b) => b.score - a.score);
  if (ranked.length > 1 && ranked[0].score === ranked[1].score) throw new Error(`${label}列表解析不唯一：同数量数据组的内容特征无法区分。`);
  return ranked[0].group;
}

async function main() {
  if (!provinceName) throw new Error('请使用 --province=省份。');
  const db = readJson(path.join(contentDir, 'db.json'), { provinces: {} });
  const province = db.provinces?.[provinceName];
  if (!province) throw new Error(`基础数据库中没有找到省份：${provinceName}`);
  const slug = province.id || provinceName;
  const pkey = portalKeys[provinceName] || slug;
  const sourceUrl = `${portalBaseUrl}?pkey=${encodeURIComponent(pkey)}&type=0`;
  const response = await fetch(sourceUrl, {
    headers: { 'user-agent': 'Mozilla/5.0 ChinaTourismMapDataMaintenance/1.0' },
  });
  if (!response.ok) throw new Error(`文化和旅游部大众旅游服务请求失败：HTTP ${response.status}`);
  const html = await response.text();
  const fiveACount = expectedCount(html, '国家5A级景区', '个');
  const resortCount = expectedCount(html, '国家级旅游度假区', '个');
  if (!fiveACount || !resortCount) throw new Error('没有从页面摘要中解析到5A景区或国家级旅游度假区数量。');
  const groups = extractGroups(html);
  const fiveA = selectGroupByCount(groups, fiveACount, '国家5A级景区', group => group.filter(item => !/度假区|酒店|饭店|宾馆/.test(item.name)).length);
  const resorts = selectGroupByCount(groups, resortCount, '国家级旅游度假区', group => group.filter(item => /度假区/.test(item.name)).length);
  const output = {
    province: provinceName,
    collectedAt: new Date().toISOString(),
    sourceUrl,
    source: '中华人民共和国文化和旅游部大众旅游服务',
    fiveACount,
    resortCount,
    fiveA,
    resorts,
  };
  const outputPath = path.join(runtimeDir, `core-official-${slug}.json`);
  writeJson(outputPath, output);
  console.log(`${provinceName}官方来源采集完成：5A景区 ${fiveA.length} 个，国家级旅游度假区 ${resorts.length} 个。`);
  console.log(`结果：${outputPath}`);
}

main().catch(error => {
  console.error(`官方核心候选采集失败：${error.message}`);
  process.exitCode = 1;
});
