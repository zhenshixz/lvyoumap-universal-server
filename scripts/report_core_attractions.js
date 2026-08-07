const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const dbPath = path.join(rootDir, 'content', 'db.json');
const manualPath = path.join(rootDir, 'content', 'manual-attractions.json');
const baselinePath = path.join(rootDir, 'content', 'core-attractions.guizhou.json');
const reportDir = path.join(rootDir, 'reports');
const reportPath = path.join(reportDir, 'core-attractions-guizhou.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[·•（）()\-—_\s]/g, '')
    .replace(/国家[345]a级旅游景区/g, '')
    .replace(/旅游景区|风景名胜区|风景区|旅游区|景区$/g, '')
    .trim();
}

function buildRecords(db, manual, provinceName) {
  const original = db.provinces?.[provinceName]?.attractions || [];
  const additions = manual?.[provinceName] || [];
  return [
    ...original.map(item => ({ ...item, dataLayer: 'db' })),
    ...additions.map(item => ({ ...item, dataLayer: 'manual' })),
  ];
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
  };
}

function main() {
  const db = readJson(dbPath);
  const manual = fs.existsSync(manualPath) ? readJson(manualPath) : {};
  const baseline = readJson(baselinePath);
  const records = buildRecords(db, manual, baseline.province);
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
    items,
  };

  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\r\n`, 'utf8');
  console.log(`Core attraction report: ${counts.present} present, ${counts.review} review, ${counts.missing} missing.`);
  console.log(`Report: ${path.relative(rootDir, reportPath)}`);
}

main();
