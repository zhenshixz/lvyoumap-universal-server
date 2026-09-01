const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const milestoneArg = process.argv.find(value => value.startsWith('--milestone='));
const milestone = milestoneArg ? milestoneArg.slice('--milestone='.length) : (process.env.ATTRACTION_MILESTONE || 'priority-01');
const runtimeDir = path.join(root, '.runtime', 'attraction-content-milestones', milestone);
const manifestPath = path.join(runtimeDir, 'manifest.json');
const attractionPath = path.join(root, 'content', 'attraction-overrides.json');
const lazyPath = path.join(root, 'content', 'lazy-guide-overrides.json');

function readJson(filePath, fallback = {}) {
  return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')) : fallback;
}
function merge(target, patch) {
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      target[key] = merge(target[key] && typeof target[key] === 'object' && !Array.isArray(target[key]) ? target[key] : {}, value);
    } else target[key] = value;
  }
  return target;
}
function writeAtomic(filePath, value) {
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\r\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

const manifest = readJson(manifestPath, null);
if (!manifest || manifest.status !== 'ready_for_preview') throw new Error('当前修复批次尚未通过隔离预览门禁。');
const failed = manifest.items.filter(item => item.status !== 'ready' || item.validation?.passed !== true);
if (failed.length) throw new Error(`仍有 ${failed.length} 条未通过，拒绝写入。`);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = path.join(root, '.runtime', 'backups', `attraction-repair-${milestone}-${stamp}`);
fs.mkdirSync(backupDir, { recursive: true });
for (const filePath of [attractionPath, lazyPath, manifestPath]) {
  if (fs.existsSync(filePath)) fs.copyFileSync(filePath, path.join(backupDir, path.basename(filePath)));
}

const attraction = readJson(attractionPath, {});
const lazy = readJson(lazyPath, {});
for (const item of manifest.items) {
  const proposed = { ...(item.proposed || {}) };
  const lazyPatch = {};
  for (const key of ['lazy_ai_text', 'lazy_ai_source']) {
    if (Object.prototype.hasOwnProperty.call(proposed, key)) {
      lazyPatch[key] = proposed[key];
      delete proposed[key];
    }
  }
  if (lazyPatch.lazy_ai_text && !lazyPatch.lazy_ai_source) {
    const source = (item.sources || []).find(value => value.field === 'lazy_ai_text');
    lazyPatch.lazy_ai_source = {
      source: 'xiaohongshu-dian-dian-ai-chat',
      prompt: '省份、城市与景点名共同锁定实体的省力游览攻略；包含路线、亮点、老人儿童提示和避坑提醒。',
      updatedAt: source?.collectedAt || manifest.finalizedAt || new Date().toISOString(),
    };
  }
  if (Object.keys(proposed).length) attraction[item.id] = merge(attraction[item.id] || {}, proposed);
  if (Object.keys(lazyPatch).length) lazy[item.id] = merge(lazy[item.id] || {}, lazyPatch);
}
writeAtomic(attractionPath, attraction);
writeAtomic(lazyPath, lazy);
const receipt = { appliedAt: new Date().toISOString(), count: manifest.items.length, backupDir };
writeAtomic(path.join(runtimeDir, 'applied.json'), receipt);
manifest.status = 'applied_to_beta';
manifest.appliedAt = receipt.appliedAt;
manifest.backupDir = backupDir;
writeAtomic(manifestPath, manifest);
console.log(JSON.stringify(receipt, null, 2));
