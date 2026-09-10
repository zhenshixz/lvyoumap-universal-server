// Snapshot audit only: never alters collection state or published content.
const fs = require('fs');
const path = require('path');
const { isContaminatedImage } = require('./gallery_content_guard');
const root = path.resolve(__dirname, '..');
const runtime = path.join(root, '.runtime', 'attraction-gallery-batch');
const read = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const state = read(path.join(runtime, 'state.json'));
const current = read(path.join(root, 'content', 'attraction-gallery-overrides.json'));
const denied = new Set(read(path.join(root, 'content', 'attraction-gallery-image-denylist.json')).map(x => x.url));
const issues = [];
const candidates = [];
for (const item of state.items) {
  if (item.status !== 'ready_for_user_review') continue;
  const previous = (current[item.id]?.images || []).map(x => x.url || x);
  if (JSON.stringify(previous) === JSON.stringify((item.selected || []).map(x => x.url))) continue;
  const seen = new Set();
  const selected = (item.selected || []).filter(im => {
    const reason = denied.has(im.url) ? 'denylist' : isContaminatedImage(im, item.name).reason;
    const file = im.reviewFile && path.resolve(root, im.reviewFile);
    const dimensions = im.dimensions || {};
    const key = im.hash || im.url;
    const invalid = reason || !file || !file.startsWith(runtime + path.sep) || !fs.existsSync(file)
      || Math.max(dimensions.width || 0, dimensions.height || 0) < 720
      || Math.min(dimensions.width || 0, dimensions.height || 0) < 400
      || seen.has(key);
    if (invalid) { issues.push({ id: item.id, name: item.name, url: im.url, reason: reason || 'file/dimensions/duplicate' }); return false; }
    seen.add(key); return true;
  }).slice(0, 5);
  if (selected.length >= 3) candidates.push({ ...item, selected });
  else issues.push({ id: item.id, name: item.name, reason: 'fewer_than_three_after_audit' });
}
// Reproducible distributed sample, including the first recent source examples.
const sample = candidates.filter((x, i) => i % Math.max(1, Math.floor(candidates.length / 30)) === 0).slice(0, 30);
const snapshot = { auditedAt: new Date().toISOString(), rule: 'Structural audit only; contact sheets require actual visual inspection before applying.', totalCandidates: candidates.length, issues, items: sample };
fs.writeFileSync(path.join(runtime, 'codex-audit.json'), JSON.stringify(snapshot, null, 2));
console.log(JSON.stringify({ candidates: candidates.length, sample: sample.length, issues: issues.length, names: sample.map(x => x.name) }));
