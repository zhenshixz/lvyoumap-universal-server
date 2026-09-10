// Decisions made from the six uncropped sheets on 2026-09-10.
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const runtime = path.join(root, '.runtime', 'attraction-gallery-batch');
const read = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const file = path.join(runtime, 'codex-audit.json');
const audit = read(file);
const choices = { 1:[1,2,3], 3:[1,2,3,4,5], 4:[2,3,4], 5:[1,4,5], 6:[1,2,3,4], 7:[1,2,3], 8:[1,2,3,4,5], 9:[1,3,5], 12:[1,2,3,4], 13:[1,2,3], 14:[1,3,5], 16:[1,2,4,5], 18:[1,2,3], 19:[1,2,3], 20:[1,2,3,4], 21:[1,2,3], 26:[2,3,4,5], 27:[1,2,3] };
const rejected = { 11:[1,2,3,4,5], 15:[3], 16:[3], 17:[1,2,3,4,5], 18:[4], 19:[4,5], 24:[1,2,3,4], 25:[3,5], 26:[1] };
const deniedFile = path.join(root, 'content', 'attraction-gallery-image-denylist.json');
const denied = read(deniedFile);
const known = new Set(denied.map(x=>x.url));
const add = (url, reason) => { if(!known.has(url)){ denied.push({url,reason,reviewedAt:new Date().toISOString()}); known.add(url); } };
for (const [n, indices] of Object.entries(rejected)) for (const i of indices) add(audit.items[n-1].selected[i-1].url, '2026-09-10 visual audit: unrelated content, collage, watermark or diagram');
for (const url of require('./gallery_content_guard').KNOWN_POLLUTED_URLS) add(url, 'Known rejected image from previous visual audit');
fs.mkdirSync(path.join(root,'.runtime','backups'),{recursive:true});
fs.copyFileSync(deniedFile,path.join(root,'.runtime','backups','gallery-denylist-before-codex-20260910.json'));
fs.writeFileSync(deniedFile,JSON.stringify(denied,null,2));
const approved = Object.entries(choices).map(([n,indices]) => ({...audit.items[n-1], selected:indices.map(i=>audit.items[n-1].selected[i-1]), contentReview:'codex_visual_review_2026-09-10'}));
fs.writeFileSync(path.join(runtime,'codex-approved.json'),JSON.stringify({reviewedAt:new Date().toISOString(),items:approved},null,2));
const stateFile = path.join(runtime,'state.json');
fs.copyFileSync(stateFile,path.join(root,'.runtime','backups','gallery-state-before-codex-20260910.json'));
const state = read(stateFile);
for (const item of state.items) {
  for (const key of ['selected','qualified']) item[key] = (item[key] || []).filter(im=>!known.has(im.url));
  item.qualifiedCount = item.qualified.length;
  if (item.status === 'ready_for_user_review' && item.selected.length < 3) item.status='pending_sources';
  const selected = approved.find(x=>x.id===item.id);
  if (selected) {item.selected=selected.selected;item.contentReview=selected.contentReview;}
}
fs.writeFileSync(stateFile,JSON.stringify(state,null,2));
console.log(JSON.stringify({approved:approved.length,names:approved.map(x=>x.name),deniedTotal:denied.length}));
