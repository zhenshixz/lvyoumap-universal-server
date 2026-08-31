const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const runtimeDir = path.join(root, '.runtime', 'attraction-content-sample');
const manifestPath = path.join(runtimeDir, 'manifest.json');
const attractionOverridesPath = path.join(root, 'content', 'attraction-overrides.json');
const lazyOverridesPath = path.join(root, 'content', 'lazy-guide-overrides.json');

function readJson(filePath, fallback = {}) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
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

function writeAtomic(filePath, value) {
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\r\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

const manifest = readJson(manifestPath, null);
if (!manifest || manifest.status !== 'ready_for_preview') throw new Error('10条样本尚未全部通过隔离预览门禁，拒绝写入。');
if (!Array.isArray(manifest.items) || manifest.items.length !== 10) throw new Error('样本数量异常，拒绝写入。');
const failed = manifest.items.filter(item => item.status !== 'ready' || item.validation?.passed !== true);
if (failed.length) throw new Error(`仍有未通过项目：${failed.map(item => item.name).join('、')}`);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = path.join(root, '.runtime', 'backups', `attraction-content-sample-${stamp}`);
fs.mkdirSync(backupDir, { recursive: true });
for (const filePath of [attractionOverridesPath, lazyOverridesPath, manifestPath]) {
  if (fs.existsSync(filePath)) fs.copyFileSync(filePath, path.join(backupDir, path.basename(filePath)));
}

const attractionOverrides = readJson(attractionOverridesPath, {});
const lazyOverrides = readJson(lazyOverridesPath, {});
const results = [];
for (const item of manifest.items) {
  const proposed = { ...(item.proposed || {}) };
  const lazyPatch = {};
  for (const field of ['lazy_ai_text', 'lazy_ai_source']) {
    if (Object.prototype.hasOwnProperty.call(proposed, field)) {
      lazyPatch[field] = proposed[field];
      delete proposed[field];
    }
  }
  attractionOverrides[item.id] = deepMerge(attractionOverrides[item.id] || {}, proposed);
  if (Object.keys(lazyPatch).length) lazyOverrides[item.id] = deepMerge(lazyOverrides[item.id] || {}, lazyPatch);
  results.push({
    id: item.id,
    province: item.province,
    city: item.city,
    name: item.name,
    attractionFields: Object.keys(proposed),
    lazyFields: Object.keys(lazyPatch),
  });
}

writeAtomic(attractionOverridesPath, attractionOverrides);
writeAtomic(lazyOverridesPath, lazyOverrides);
const receipt = { appliedAt: new Date().toISOString(), backupDir, count: results.length, results };
writeAtomic(path.join(runtimeDir, 'applied.json'), receipt);
console.log(JSON.stringify(receipt, null, 2));
