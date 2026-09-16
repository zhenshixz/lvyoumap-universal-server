const C = require('./gallery_link_batch_common');
const { fs, path, root, runtime, read, write, batchPath, alive } = C;
const { execFileSync } = require('child_process');
const { imagesOf, existingMap, mergeImages } = require('./gallery_existing_images');
function makePlan(state, selections) {
  if (!Array.isArray(selections) || !selections.length || selections.length > state.items.length) throw Error('请选择要写入的图片');
  const seen = new Set(), existing = existingMap();
  const items = selections.map(choice => {
    const item = state.items.find(i => i.id === choice.id);
    if (!item || seen.has(item.id)) throw Error('验收景点不属于当前批次或重复');
    seen.add(item.id);
    if (!Array.isArray(choice.urls) || choice.urls.length < 1 || choice.urls.length > 5 || new Set(choice.urls).size !== choice.urls.length) throw Error('每个景点选择1–5张不重复的图片');
    const images = choice.urls.map(url => {
      const image = item.images.find(i => i.accepted && i.url === url);
      if (!image) throw Error('所选图片不属于本批合格候选');
      const u = new URL(url);
      if (u.protocol !== 'https:' || u.username || u.password || u.port) throw Error('图片地址无效');
      return { url, caption: item.name, source: image.source === 'trip' ? 'trip_exact' : 'amap_exact', ...(image.source === 'trip' ? { sourceUrl: item.url } : { sourcePoiId: item.id.replace(/^amap_/, '') }), imageSource: { provider: image.source === 'trip' ? '景区公开资料' : '高德地图', ...(image.source === 'trip' ? { sourceUrl: item.url } : {}) } };
    });
    const coverUrl = choice.coverUrl || existing.get(item.id)?.image || images[0].url;
    mergeImages(existing.get(item.id), images, coverUrl);
    return { id: item.id, name: item.name, images, coverUrl };
  });
  return { batchId: state.id, approvedAt: new Date().toISOString(), items };
}
// Injectable paths/build function keep regression tests entirely isolated.
function execute(plan, options = {}) {
  const base = options.root || root, dir = options.dir || batchPath(plan.batchId);
  const target = path.join(base, 'content/attraction-gallery-overrides.json');
  const dataDir = path.join(base, 'data'), stage = path.join(base, '.dist-next'), dist = path.join(base, 'dist');
  const backup = path.join(dir, 'apply-backup'), oldDist = path.join(backup, 'dist');
  const receiptFile = path.join(dir, 'apply.json');
  const previous = read(receiptFile);
  if (previous?.status === 'applied') return previous;
  function restore() {
    const saved = read(path.join(backup, 'metadata.json'));
    if (!saved) return;
    fs.copyFileSync(path.join(backup, 'overrides.json'), target);
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (saved.hadData) fs.cpSync(path.join(backup, 'data'), dataDir, { recursive: true });
    if (fs.existsSync(oldDist)) {
      fs.rmSync(dist, { recursive: true, force: true }); fs.renameSync(oldDist, dist);
    } else if (!saved.hadDist) fs.rmSync(dist, { recursive: true, force: true });
    fs.rmSync(stage, { recursive: true, force: true });
  }
  // A killed process may have written the content but not its completion receipt.
  if (previous && ['applying', 'interrupted'].includes(previous.status)) restore();
  const current = read(target, {}), db = read(path.join(base, 'content/db.json'));
  const ids = new Set(Object.values(db.provinces || db).flatMap(p => (p.attractions || []).map(i => i.id)));
  const denied = new Set(read(path.join(base, 'content/attraction-gallery-image-denylist.json'), []).map(i => i.url));
  const relationDenied = new Set(read(path.join(base, 'content/attraction-gallery-review-decisions.json'), []).filter(i => i.action === 'remove_reference').map(i => `${i.id}\n${i.url}`));
  for (const item of plan.items) {
    if (!ids.has(item.id)) throw Error('数据库不存在景点：' + item.name);
    if (item.images.some(im => denied.has(im.url))) throw Error('图片已在拒绝清单：' + item.name);
    if (item.images.some(im => relationDenied.has(`${item.id}\n${im.url}`))) throw Error('图片已被人工确认不属于该景点：' + item.name);
  }
  const existing = existingMap(base);
  const finalItems = plan.items.map(item => ({ ...item, images: mergeImages(existing.get(item.id), item.images, item.coverUrl) }));
  fs.mkdirSync(backup, { recursive: true });
  fs.copyFileSync(target, path.join(backup, 'overrides.json'));
  const hadData = fs.existsSync(dataDir), hadDist = fs.existsSync(dist);
  fs.rmSync(path.join(backup, 'data'), { recursive: true, force: true });
  if (hadData) fs.cpSync(dataDir, path.join(backup, 'data'), { recursive: true });
  write(path.join(backup, 'metadata.json'), { hadData, hadDist });
  const progress = { status: 'applying', pid: process.pid, batchId: plan.batchId, startedAt: new Date().toISOString(), ids: plan.items.map(i => i.id) };
  write(receiptFile, progress);
  let committed = false;
  try {
    const merged = { ...current };
    for (const item of finalItems) merged[item.id] = { ...current[item.id], image: item.images[0].url, image_source: item.images[0].imageSource, images: item.images };
    write(target, merged);
    (options.build || (() => execFileSync(process.execPath, [path.join(base, 'scripts/build.js'), '--stage-only'], { cwd: base, windowsHide: true, timeout: 300000, stdio: 'inherit' })))();
    const built = new Map();
    for (const file of fs.readdirSync(path.join(stage, 'data/provinces')).filter(f => f.endsWith('.json'))) {
      const p = read(path.join(stage, 'data/provinces', file));
      for (const i of p.attractions || []) built.set(i.id, i);
    }
    for (const item of finalItems) {
      const i = built.get(item.id);
      if (i?.image !== item.images[0].url || JSON.stringify(i.images?.map(x => typeof x === 'string' ? x : x.url)) !== JSON.stringify(item.images.map(x => x.url))) throw Error('构建结果与验收图片不一致：' + item.name);
    }
    if (hadDist) fs.renameSync(dist, oldDist);
    fs.renameSync(stage, dist);
    const receipt = { ...progress, status: 'applied', appliedAt: new Date().toISOString(), count: plan.items.length, imageCount: plan.items.reduce((n, i) => n + i.images.length, 0), selections: plan.items.map(i => ({ id: i.id, urls: i.images.map(im => im.url) })), finalSelections: finalItems.map(i => ({id:i.id,urls:i.images.map(im=>im.url)})), finalImageCount: finalItems.reduce((n,i)=>n+i.images.length,0), policy:'preserve-existing-v1', settled: true, backup: path.relative(base, backup).replace(/\\/g, '/') };
    write(receiptFile, receipt); committed = true;
    // Only the displaced generated dist is removed, never source/online images.
    try { fs.rmSync(oldDist, { recursive: true, force: true }); } catch { /* retain backup on Windows file contention */ }
    return receipt;
  } catch (e) {
    if (!committed) {
      try { restore(); write(receiptFile, { ...progress, status: 'failed', error: e.message, rolledBack: true }); }
      catch (recovery) { write(receiptFile, { ...progress, status: 'interrupted', error: e.message + ';恢复失败:' + recovery.message }); }
    }
    throw e;
  }
}
function main(id) {
  const lockFile = path.join(runtime, 'apply.lock');
  const old = read(lockFile);
  if (alive(old?.pid)) throw Error('已有写入任务');
  if (old) fs.unlinkSync(lockFile);
  if (alive(read(path.join(runtime, 'worker.lock'))?.pid) || alive(read(path.join(root, '.runtime/attraction-gallery-batch/codex-background.lock'))?.pid)) throw Error('采集运行中');
  const fd = fs.openSync(lockFile, 'wx'); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); fs.closeSync(fd);
  try { const dir = batchPath(id); execute(read(path.join(dir, 'approval.json'))); }
  finally { fs.unlinkSync(lockFile); }
}
module.exports = { makePlan, execute };
if (require.main === module) { try { main(process.argv[2]); } catch (e) { console.error(e.message); process.exitCode = 1; } }
