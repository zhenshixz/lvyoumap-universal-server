const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const dbPath = path.join(rootDir, 'content', 'db.json');
const baselinePath = path.join(rootDir, 'content', 'core-attractions.guizhou.json');
const reportDir = path.join(rootDir, 'reports');
const reportPath = path.join(reportDir, 'core-attractions-guizhou.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function readManualLayers() {
  const contentDir = path.join(rootDir, 'content');
  const merged = {};
  for (const name of fs.readdirSync(contentDir).filter(item => /^manual-attractions(?:\.[a-z0-9_-]+)?\.json$/i.test(item)).sort()) {
    const layer = readJson(path.join(contentDir, name));
    for (const [provinceName, additions] of Object.entries(layer || {})) {
      merged[provinceName] = [...(merged[provinceName] || []), ...(additions || [])];
    }
  }
  return merged;
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[·•（）()\-—_\s]/g, '')
    .replace(/国家[345]a级旅游景区/g, '')
    .replace(/旅游景区|风景名胜区|风景区|旅游区|景区$/g, '')
    .trim();
}

function deepMerge(target, patch) {
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      target[key] = deepMerge(target[key] && typeof target[key] === 'object' && !Array.isArray(target[key]) ? target[key] : {}, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function buildRecords(db, manual, provinceName, attractionOverrides, lazyOverrides) {
  const original = db.provinces?.[provinceName]?.attractions || [];
  const additions = manual?.[provinceName] || [];
  const records = [
    ...original.map(item => ({ ...item, dataLayer: 'db' })),
    ...additions.map(item => ({ ...item, dataLayer: 'manual' })),
  ];
  return records.map(record => deepMerge(deepMerge(record, attractionOverrides[record.id] || {}), lazyOverrides[record.id] || {}));
}

function getQuality(record) {
  const guide = record.guide_data || {};
  const basicComplete = ['image', 'description', 'intro', 'price'].every(field => String(record[field] || '').trim());
  const guideComplete = ['clothing', 'transport', 'special_care'].every(field => guide[field] && typeof guide[field] === 'object')
    && Array.isArray(guide.housing) && guide.housing.length > 0
    && Array.isArray(guide.food) && guide.food.length >= 3;
  const lazyText = String(record.lazy_ai_text || '').trim();
  const lazyComplete = lazyText.length >= 180
    && /(路线|游览顺序|省力|观光车|索道|接驳|步行)/.test(lazyText)
    && Boolean(record.lazy_ai_source?.source && record.lazy_ai_source?.prompt && record.lazy_ai_source?.updatedAt);
  const sources = record.source_evidence?.basicInfoSources;
  const sourceComplete = record.dataLayer !== 'manual' || (Array.isArray(sources) && sources.length >= 2);
  return {
    ready: basicComplete && guideComplete && lazyComplete && sourceComplete,
    basicComplete,
    guideComplete,
    lazyComplete,
    sourceComplete,
    lazySource: record.lazy_ai_source?.source || '',
  };
}

function matchBaselineItem(item, records) {
  const aliases = [item.name, ...(item.aliases || [])];
  const normalizedAliases = new Set(aliases.map(normalizeName).filter(Boolean));
  const exact = records.filter(record => normalizedAliases.has(normalizeName(record.name)));
  if (exact.length) {
    return { status: 'present', matches: exact.map(toMatchSummary) };
  }

  const possible = records.filter(record => {
    const recordName = normalizeName(record.name);
    if (recordName.length < 4) return false;
    return [...normalizedAliases].some(alias => alias.length >= 4 && (recordName.includes(alias) || alias.includes(recordName)));
  });
  if (possible.length) {
    return { status: 'review', matches: possible.map(toMatchSummary) };
  }

  return { status: 'missing', matches: [] };
}

function toMatchSummary(record) {
  return {
    id: record.id,
    name: record.name,
    city: record.city,
    dataLayer: record.dataLayer,
    quality: getQuality(record),
  };
}

function main() {
  const db = readJson(dbPath);
  const manual = readManualLayers();
  const attractionOverrides = readJson(path.join(rootDir, 'content', 'attraction-overrides.json'));
  const lazyOverrides = readJson(path.join(rootDir, 'content', 'lazy-guide-overrides.json'));
  const baseline = readJson(baselinePath);
  const records = buildRecords(db, manual, baseline.province, attractionOverrides, lazyOverrides);
  const items = baseline.attractions.map(item => ({
    key: item.key,
    name: item.name,
    tier: item.tier,
    evidence: item.evidence,
    ...matchBaselineItem(item, records),
  }));
  const counts = items.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, { present: 0, review: 0, missing: 0 });
  const report = {
    province: baseline.province,
    checkedAt: baseline.checkedAt,
    method: baseline.method,
    baselineCount: items.length,
    recordCount: records.length,
    counts,
    coverage: Number((counts.present / items.length).toFixed(4)),
    readyCount: items.filter(item => item.status === 'present' && item.matches.some(match => match.quality.ready)).length,
    items,
  };

  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\r\n`, 'utf8');
  console.log(`Core attraction report: ${counts.present} present, ${counts.review} review, ${counts.missing} missing.`);
  console.log(`Core attraction quality: ${report.readyCount}/${items.length} ready.`);
  console.log(`Report: ${path.relative(rootDir, reportPath)}`);
  if (process.argv.includes('--strict') && (counts.missing > 0 || counts.review > 0 || report.readyCount !== items.length)) {
    process.exitCode = 1;
  }
}

main();
