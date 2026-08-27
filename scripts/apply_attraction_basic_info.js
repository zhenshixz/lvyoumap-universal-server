const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const runtime = path.join(root, '.runtime', 'attraction-basic-info');
const manifestPath = path.join(runtime, 'manifest.json');
const provincesDir = path.join(root, 'data', 'provinces');
const overridesPath = path.join(root, 'content', 'attraction-overrides.json');
const fields = ['address', 'openHours', 'tel', 'price'];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function valueOf(attraction, field) {
  if (field === 'tel') return String(attraction.tel || attraction.phone || '').trim();
  return String(attraction[field] || '').trim();
}

function atomicJson(filePath, value) {
  const temp = `${filePath}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value)}\r\n`, 'utf8');
  fs.renameSync(temp, filePath);
}

const manifest = readJson(manifestPath);
if (manifest.status !== 'diandian_collected_with_edge_case_review') {
  throw new Error(`清单尚未完成最终审查：${manifest.status}`);
}
if (Object.values(manifest.summary?.remainingFields || {}).some(Number)) {
  throw new Error('清单仍有待补字段，拒绝写入。');
}

const candidates = manifest.items.filter(item => item.changedFields?.some(field => fields.includes(field)));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = path.join(root, '.runtime', 'backups', `attraction-basic-info-${stamp}`);
fs.mkdirSync(backupDir, { recursive: true });

const provinceData = new Map();
for (const slug of [...new Set(candidates.map(item => item.slug))].sort()) {
  const source = path.join(provincesDir, `${slug}.json`);
  if (!fs.existsSync(source)) throw new Error(`省份文件不存在：${source}`);
  provinceData.set(slug, readJson(source));
}
const overrides = fs.existsSync(overridesPath) ? readJson(overridesPath) : {};
if (fs.existsSync(overridesPath)) fs.copyFileSync(overridesPath, path.join(backupDir, 'attraction-overrides.json'));
fs.copyFileSync(manifestPath, path.join(backupDir, 'manifest.json'));

const report = { backupDir, attractionsUpdated: 0, fieldsUpdated: 0, alreadyApplied: 0, conflicts: [], missing: [] };
const touched = new Set();
for (const item of candidates) {
  const data = provinceData.get(item.slug);
  const attraction = data?.attractions?.find(value => String(value.id) === String(item.id));
  if (!attraction) {
    report.missing.push({ key: item.key, name: item.name });
    continue;
  }
  let updated = 0;
  for (const field of item.changedFields.filter(value => fields.includes(value))) {
    const current = valueOf(attraction, field);
    const baseline = String(item.before?.[field] || '').trim();
    const proposed = String(item.after?.[field] || '').trim();
    if (!proposed || current === proposed) {
      if (current === proposed) report.alreadyApplied += 1;
      continue;
    }
    if (current !== baseline) {
      report.conflicts.push({ key: item.key, name: item.name, field, baseline, current, proposed });
      continue;
    }
    overrides[item.id] ||= {};
    overrides[item.id][field] = proposed;
    updated += 1;
    report.fieldsUpdated += 1;
  }
  if (updated) {
    report.attractionsUpdated += 1;
    touched.add(item.slug);
  }
}

atomicJson(overridesPath, overrides);
report.provincesUpdated = touched.size;
report.target = path.relative(root, overridesPath);
report.completedAt = new Date().toISOString();
fs.writeFileSync(path.join(runtime, 'apply-report.json'), `${JSON.stringify(report, null, 2)}\r\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
