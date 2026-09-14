// One-time, evidence-based recovery. Dry run by default; --apply restores only missing images.
const C = require('./gallery_link_batch_common');
const H = require('./gallery_existing_images');
const current = H.existingMap(), before = new Map(), evidence = [];
function add(id, name, images, source) {
  if (!before.has(id)) before.set(id, { id, name, images: [], sources: [] });
  const item = before.get(id);
  item.images = H.mergeImages({ images: item.images }, images); item.sources.push(source);
}
const national = C.read(C.path.join(C.root, '.runtime/attraction-gallery-batch/applied.json'));
if (national?.appliedAt.startsWith('2026-09-11')) {
  const snapshot = C.read(C.path.join(C.root, national.backup));
  const historical = H.existingMap(C.root, C.path.join(C.root, '.runtime/promotion-backups/20260910-163346/data'), snapshot);
  for (const i of national.items) add(i.id, i.name, H.imagesOf(historical.get(i.id)), national.backup);
  evidence.push({ source: 'national', count: national.items.length });
}
for (const b of C.batchList().reverse()) {
  const dir = C.batchPath(b.id), receipt = C.read(C.path.join(dir, 'apply.json'));
  if (receipt?.status !== 'applied' || !receipt.appliedAt.startsWith('2026-09-11')) continue;
  const old = H.existingMap(C.root, C.path.join(dir, 'apply-backup/data'), C.read(C.path.join(dir, 'apply-backup/overrides.json')));
  for (const id of receipt.ids) add(id, current.get(id)?.name, H.imagesOf(old.get(id)), C.path.relative(C.root, dir) + '/apply-backup/data');
  evidence.push({ source: b.id, count: receipt.ids.length });
}
const denied = new Set(C.read(C.path.join(C.root, 'content/attraction-gallery-image-denylist.json'), []).map(i => i.url));
const issues = [], items = [];
for (const item of before.values()) {
  const present = new Set(H.imagesOf(current.get(item.id)).map(im => im.url));
  const missing = item.images.filter(im => !present.has(im.url));
  const images = missing.filter(im => {
    const reason = denied.has(im.url) ? 'denylist' : im.url.startsWith('/') && !C.fs.existsSync(C.path.join(C.root, im.url.slice(1))) ? 'missing local file' : '';
    if (reason) issues.push({ id: item.id, url: im.url, reason });
    return !reason;
  });
  if (images.length) items.push({ ...item, images, coverUrl: current.get(item.id)?.image });
}
const report = { day: '2026-09-11', at: new Date().toISOString(), audited: before.size, evidence, items, issues };
const dir = C.path.join(C.runtime, 'recovery-20260911'); C.fs.mkdirSync(dir, { recursive: true });
const reportFile = C.path.join(dir, 'audit.json');
if (!C.read(C.path.join(dir, 'apply.json'))) C.write(reportFile, report);
console.log(JSON.stringify({ audited: before.size, evidence, affected: items.length, restoreImages: items.reduce((n, i) => n + i.images.length, 0), issues: issues.length }));
if (process.argv.includes('--apply') && items.length) {
  require('./gallery_link_batch_actions').assertIdle();
  const lock = C.path.join(C.runtime, 'apply.lock');
  if (C.fs.existsSync(lock)) C.fs.unlinkSync(lock);
  const fd = C.fs.openSync(lock, 'wx'); C.fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); C.fs.closeSync(fd);
  try {
    const result = require('./gallery_link_batch_apply').execute({ batchId: 'recovery-20260911', items }, { dir });
    console.log(JSON.stringify({ status: result.status, count: result.count, restoredImages: result.imageCount, finalImages: result.finalImageCount }));
  } finally { C.fs.unlinkSync(lock); }
}
