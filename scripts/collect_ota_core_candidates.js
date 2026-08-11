const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const runtimeDir = path.join(rootDir, '.runtime');
const args = new Map(process.argv.slice(2).map(arg => {
  const match = arg.match(/^--([^=]+)=(.*)$/);
  return match ? [match[1], match[2]] : [arg.replace(/^--/, ''), true];
}));
const provinceName = String(args.get('province') || '');

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

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, '')
    .trim();
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 ChinaTourismMapDataMaintenance/1.0' },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`请求失败 HTTP ${response.status}：${url}`);
  return response.text();
}

async function discoverCtripDestination(province) {
  const chinaUrl = 'https://you.ctrip.com/sight/china110000.html';
  const html = await fetchText(chinaUrl);
  const escaped = province.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`href="https?:\\/\\/you\\.ctrip\\.com\\/place\\/([^"?]+)\\.html"[^>]*>${escaped}旅游攻略<\\/a>`, 'i'),
    new RegExp(`href="https?:\\/\\/you\\.ctrip\\.com\\/place\\/([^"?]+)\\.html"[^>]*>[^<]*${escaped}[^<]*<\\/a>`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1];
  }
  throw new Error(`没有从携程中国攻略页发现 ${province} 的目的地地址。`);
}

function parseTopAttractions(html) {
  const output = [];
  const regex = /<div class="titleModule_name__[^"]+"><span><a href="([^"]+)"[^>]*>([^<]+)<\/a>/g;
  for (const match of html.matchAll(regex)) {
    const name = decodeHtml(match[2]);
    if (!name || output.some(item => item.name === name)) continue;
    output.push({ name, rank: output.length + 1, url: decodeHtml(match[1]) });
  }
  return output.slice(0, 20);
}

async function main() {
  if (!provinceName) throw new Error('请使用 --province=省份。');
  const db = readJson(path.join(rootDir, 'content', 'db.json'), { provinces: {} });
  const province = db.provinces?.[provinceName];
  if (!province) throw new Error(`基础数据库中没有找到省份：${provinceName}`);
  const destination = await discoverCtripDestination(provinceName);
  const url = `https://you.ctrip.com/sightlist/${destination}.html`;
  const html = await fetchText(url);
  const candidates = parseTopAttractions(html);
  if (candidates.length < 8) throw new Error(`携程榜单只解析到 ${candidates.length} 个候选，拒绝写入。`);
  const output = {
    province: provinceName,
    source: 'ctrip-province-sightlist',
    sourceUrl: url,
    updatedAt: new Date().toISOString(),
    candidates,
  };
  const filePath = path.join(runtimeDir, `core-ota-${province.id || provinceName}.json`);
  writeJson(filePath, output);
  console.log(`${provinceName}携程核心候选采集完成：${candidates.length} 个。`);
  console.log(filePath);
}

main().catch(error => {
  console.error(`OTA候选采集失败：${error.message}`);
  process.exitCode = 1;
});
