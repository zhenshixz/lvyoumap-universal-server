const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const reportPath = path.join(root, '.runtime', 'reports', 'CODEX_ATTRACTION_CONTENT_QUICK_LIST.json');
const provincesDir = path.join(root, 'data', 'provinces');
const args = process.argv.slice(2);
const milestoneArg = args.find(value => value.startsWith('--milestone='));
const sizeArg = args.find(value => value.startsWith('--size='));
const milestone = milestoneArg ? milestoneArg.slice('--milestone='.length) : 'priority-01';
const outputDir = path.join(root, '.runtime', 'attraction-content-milestones', milestone);
const manifestPath = path.join(outputDir, 'manifest.json');
const requestedSize = sizeArg ? Number(sizeArg.slice('--size='.length)) : 181;
const quotas = { entity: 9, lazy: 14, guideTemplate: 123, guideMissing: 43 };

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}
function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\r\n`, 'utf8');
  fs.renameSync(temp, filePath);
}

const report = readJson(reportPath);
const critical = report.rows.filter(row => row.level === '优先修复');
const targetSize = Math.min(requestedSize, critical.length);
const quotaScale = targetSize / 181;
for (const key of Object.keys(quotas)) quotas[key] = Math.max(1, Math.round(quotas[key] * quotaScale));
const typeToKind = new Map([
  ['疑似串到其他城市实体', 'entity'],
  ['同名景点或实体混淆', 'lazy'],
  ['存量模板假内容', 'guideTemplate'],
  ['缺少结构化指南', 'guideMissing'],
]);
for (const row of critical) row.repairKinds = [...new Set(row.issues.map(issue => typeToKind.get(issue.type)).filter(Boolean))];
const byKind = Object.fromEntries(Object.keys(quotas).map(kind => [kind, critical.filter(row => row.repairKinds.includes(kind))]));
const selected = new Map();
for (const [kind, quota] of Object.entries(quotas)) {
  for (const row of byKind[kind]) {
    if (selected.size >= targetSize || [...selected.values()].filter(value => value.selectedFor.includes(kind)).length >= quota) break;
    const existing = selected.get(row.id);
    if (existing) existing.selectedFor.push(kind);
    else selected.set(row.id, { ...row, selectedFor: [kind] });
  }
}
for (const row of critical) {
  if (selected.size >= targetSize) break;
  if (!selected.has(row.id)) selected.set(row.id, { ...row, selectedFor: ['fill'] });
}

const sourceById = new Map();
for (const file of fs.readdirSync(provincesDir).filter(name => name.endsWith('.json'))) {
  const data = readJson(path.join(provincesDir, file));
  for (const attraction of data.attractions || []) sourceById.set(attraction.id, { slug: path.basename(file, '.json'), attraction });
}
const items = [...selected.values()].map(row => {
  const source = sourceById.get(row.id);
  if (!source) throw new Error(`找不到景点源数据：${row.id}`);
  return {
    province: row.province,
    city: row.city,
    slug: source.slug,
    id: row.id,
    name: row.name,
    repairKinds: row.repairKinds,
    issues: row.issues,
    before: {
      intro: source.attraction.intro || source.attraction.description || '',
      description: source.attraction.description || source.attraction.intro || '',
      category: source.attraction.category || '',
      address: source.attraction.address || '',
      image: source.attraction.image || '',
      guide_data: source.attraction.guide_data || null,
      lazy_ai_text: source.attraction.lazy_ai_text || '',
    },
    proposed: {},
    sources: [],
    status: 'pending',
  };
});

const manifest = {
  version: 1,
  milestone,
  phase: '优先修复',
  targetPercent: 10,
  targetSize,
  sourceTotal: critical.length,
  createdAt: new Date().toISOString(),
  status: 'prepared',
  quotas,
  selectedCounts: Object.fromEntries(Object.keys(quotas).map(kind => [kind, items.filter(item => item.repairKinds.includes(kind)).length])),
  items,
};
writeJsonAtomic(manifestPath, manifest);
console.log(JSON.stringify({ manifestPath, targetSize, actual: items.length, selectedCounts: manifest.selectedCounts }, null, 2));
