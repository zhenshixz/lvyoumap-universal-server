const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const contentDir = path.join(rootDir, 'content');
const reportsDir = path.join(rootDir, 'reports');
const runtimeDir = path.join(rootDir, '.runtime');

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

function argValue(name) {
  const prefix = `--${name}=`;
  const argument = process.argv.find(item => item.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : '';
}

function isExcludedName(name) {
  return /(火车站|高铁站|汽车站|站前|停车场|停车区|服务区|售票处|卫生间|游客中心|服务中心|入口|出口|检票口|换乘中心|码头售票|普通广场|人民公园)/.test(name)
    || (/(站|停车场|服务区|售票处|卫生间|入口|出口|游客中心|服务中心|广场|公园)$/.test(name) && !/天安门广场/.test(name));
}

function buildRecords() {
  const db = readJson(path.join(contentDir, 'db.json'), { provinces: {} });
  const lazyOverrides = readJson(path.join(contentDir, 'lazy-guide-overrides.json'), {});
  const records = [];
  const ids = new Set();
  for (const [province, value] of Object.entries(db.provinces || {})) {
    for (const attraction of value.attractions || []) {
      records.push({ province, attraction: { ...attraction, ...(lazyOverrides[attraction.id] || {}) } });
      ids.add(attraction.id);
    }
  }
  for (const file of fs.readdirSync(contentDir).filter(name => /^manual-attractions(?:\.[a-z0-9_-]+)?\.json$/i.test(name)).sort()) {
    const layer = readJson(path.join(contentDir, file), {});
    for (const [province, attractions] of Object.entries(layer)) {
      for (const attraction of attractions || []) {
        if (ids.has(attraction.id)) continue;
        records.push({ province, attraction: { ...attraction, ...(lazyOverrides[attraction.id] || {}) } });
        ids.add(attraction.id);
      }
    }
  }
  return records;
}

function main() {
  const provinceFilter = argValue('province');
  const reportFiles = fs.existsSync(reportsDir)
    ? fs.readdirSync(reportsDir).filter(name => /^core-attractions-(?!national).+\.json$/i.test(name)).sort()
    : [];
  const coreReports = reportFiles.map(name => readJson(path.join(reportsDir, name), null)).filter(Boolean)
    .filter(report => !provinceFilter || report.province === provinceFilter);

  const blocking = [];
  const recommended = [];
  const coreIds = new Set();
  for (const report of coreReports) {
    if (report.baselineStatus === 'missing') {
      blocking.push({
        type: 'core_baseline_missing',
        province: report.province,
        name: `${report.province}核心景点基线`,
        reason: 'province_baseline_not_created',
        message: '可继续补全现有景点攻略，但在建立省级核心清单前不能判断核心景点缺失。',
      });
      continue;
    }
    for (const item of report.items || []) {
      for (const match of item.matches || []) if (match.id) coreIds.add(match.id);
      if (item.status === 'missing' || item.status === 'review') {
        blocking.push({ type: `core_${item.status}`, province: report.province, key: item.key, name: item.name, reason: item.reason });
        continue;
      }
      const best = [...(item.matches || [])].sort((a, b) => Number(b.quality?.score || 0) - Number(a.quality?.score || 0))[0];
      if (best?.quality?.issues?.length) {
        recommended.push({ type: 'quality_metadata', province: report.province, id: best.id, name: best.name, score: best.quality.score, issues: best.quality.issues });
      }
    }
  }

  const automatic = buildRecords()
    .filter(row => !provinceFilter || row.province === provinceFilter)
    .filter(row => coreIds.has(row.attraction.id) || !isExcludedName(String(row.attraction.name || '')))
    .filter(row => row.attraction.lazy_ai_source?.source !== 'xiaohongshu-dian-dian-ai-chat')
    .map(row => ({ type: 'xhs_lazy_guide', province: row.province, id: row.attraction.id, name: row.attraction.name }));

  const output = {
    generatedAt: new Date().toISOString(),
    scope: provinceFilter || '全国',
    summary: {
      coreBlocking: blocking.length,
      automaticPending: automatic.length,
      recommendedImprovements: recommended.length,
    },
    blocking,
    automatic,
    recommended,
  };
  writeJson(path.join(reportsDir, 'maintenance-tasks.json'), output);
  writeJson(path.join(runtimeDir, 'maintenance-status.json'), output);
  console.log(`维护任务（${output.scope}）：核心缺失/待确认 ${blocking.length}，可自动补全 ${automatic.length}，建议优化 ${recommended.length}。`);
  console.log(`任务清单：${path.join(reportsDir, 'maintenance-tasks.json')}`);
  if (blocking.length) console.log('存在核心基线或核心景点阻断项；自动补全仍可处理现有景点攻略，但不会把该省误报为核心数据完整。');
}

main();
