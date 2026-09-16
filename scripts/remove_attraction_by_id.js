const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const attractionId = process.argv[2];

if (!/^amap_[A-Z0-9]+$/.test(attractionId || '')) {
  throw new Error('Usage: node scripts/remove_attraction_by_id.js amap_POI_ID');
}

function readJson(relativePath) {
  const filePath = path.join(root, relativePath);
  const source = fs.readFileSync(filePath, 'utf8');
  return {
    filePath,
    bom: source.startsWith('\uFEFF'),
    eol: source.includes('\r\n') ? '\r\n' : '\n',
    pretty: source.split(/\r?\n/).length > 2,
    value: JSON.parse(source.replace(/^\uFEFF/, '')),
  };
}

function writeJson(document) {
  const json = JSON.stringify(document.value, null, document.pretty ? 2 : 0);
  const normalized = json.replace(/\n/g, document.eol);
  const temporaryPath = `${document.filePath}.tmp`;
  fs.writeFileSync(temporaryPath, `${document.bom ? '\uFEFF' : ''}${normalized}${document.eol}`, 'utf8');
  fs.renameSync(temporaryPath, document.filePath);
}

function removeFromArray(array) {
  if (!Array.isArray(array)) return 0;
  const before = array.length;
  for (let index = array.length - 1; index >= 0; index -= 1) {
    if (array[index] === attractionId || array[index]?.id === attractionId) array.splice(index, 1);
  }
  return before - array.length;
}

function removeObjectKey(object) {
  if (!object || typeof object !== 'object' || !Object.hasOwn(object, attractionId)) return 0;
  delete object[attractionId];
  return 1;
}

const changes = [];

for (const relativePath of ['content/attraction-overrides.json', 'content/attraction-display-tags.json']) {
  const document = readJson(relativePath);
  const removed = removeObjectKey(document.value);
  if (removed) writeJson(document);
  changes.push({ file: relativePath, removed });
}

{
  const relativePath = 'content/db.json';
  const document = readJson(relativePath);
  let removed = 0;
  for (const province of Object.values(document.value.provinces || {})) {
    removed += removeFromArray(province.attractions);
  }
  if (removed) writeJson(document);
  changes.push({ file: relativePath, removed });
}

const galleryDraftDirectory = path.join(root, '.runtime/gallery-link-batches/drafts');
const galleryDrafts = fs.existsSync(galleryDraftDirectory)
  ? fs.readdirSync(galleryDraftDirectory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => `.runtime/gallery-link-batches/drafts/${name}`)
  : [];

for (const relativePath of ['.runtime/gallery-link-batches/draft.json', ...galleryDrafts]) {
  const document = readJson(relativePath);
  const removed = removeFromArray(document.value.items);
  if (removed) writeJson(document);
  changes.push({ file: relativePath, removed });
}

{
  const relativePath = '.runtime/attraction-gallery-batch/state.json';
  const document = readJson(relativePath);
  const removed = removeFromArray(document.value.items);
  if (removed) writeJson(document);
  changes.push({ file: relativePath, removed });
}

{
  const relativePath = '.runtime/attraction-gallery-batch/remaining-milestones.json';
  const document = readJson(relativePath);
  const removed = removeFromArray(document.value.ids);
  if (removed) writeJson(document);
  changes.push({ file: relativePath, removed });
}

{
  const relativePath = '.runtime/attraction-gallery-batch/browser-discovery-history.json';
  const document = readJson(relativePath);
  const removed = removeObjectKey(document.value);
  if (removed) writeJson(document);
  changes.push({ file: relativePath, removed });
}

{
  const relativePath = '.runtime/attraction-gallery-batch/codex-background.json';
  const document = readJson(relativePath);
  let removed = removeFromArray(document.value.ids);
  for (const key of ['attempts', 'visits', 'transient', 'nextAt', 'accounted']) {
    removed += removeObjectKey(document.value[key]);
  }
  if (removed) writeJson(document);
  changes.push({ file: relativePath, removed });
}

console.log(JSON.stringify({ attractionId, changes }, null, 2));
