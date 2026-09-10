// Resolve exact encyclopedia titles in batches, not one full-text search per POI.
// This creates a discovery index only; it never changes content or completion.
const fs = require('fs');
const path = require('path');
const { namesFor } = require('./gallery_web_sources');
const { createGalleryNetwork } = require('./gallery_network');
const root = path.resolve(__dirname, '..');
const runtime = path.join(root, '.runtime/attraction-gallery-batch');
const output = path.join(runtime, 'wikipedia-titles.json');
const read = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const network = createGalleryNetwork(path.join(runtime, 'api-cache'));
async function main() {
  const ids = new Set(read(path.join(runtime, 'remaining-milestones.json')).ids);
  const entities = Object.values(read(path.join(root, 'content/db.json')).provinces)
    .flatMap(p => p.attractions || []).filter(a => ids.has(a.id));
  const index = fs.existsSync(output) ? read(output) : {};
  const names = [...new Set(entities.flatMap(namesFor))].filter(n => !Object.hasOwn(index, n));
  for (let i = 0; i < names.length; i += 50) {
    const batch = names.slice(i, i + 50);
    const url = 'https://zh.wikipedia.org/w/api.php?' + new URLSearchParams({
      action:'query', format:'json', titles:batch.join('|'), redirects:'1', converttitles:'1',
    });
    let data;
    try { data = await network.json(url, 15000); }
    catch (e) {
      if (!e.retryAt) {
        console.log(`Title batch network failure retained for retry: ${e.message}`);
        continue;
      }
      console.log('Encyclopedia request cooling; exact-title queue retained.');
      while (Date.parse(e.retryAt) > Date.now()) await new Promise(r => setTimeout(r, Math.min(30000, Date.parse(e.retryAt)-Date.now())));
      i -= 50; continue;
    }
    const q = data.query;
    if (!q?.pages) throw new Error('Missing encyclopedia title response; not caching absence.');
    const mapping = new Map([...(q.normalized || []), ...(q.converted || []), ...(q.redirects || [])].map(x => [x.from,x.to]));
    const pages = new Map(Object.values(q.pages).map(x => [x.title,x]));
    for (const name of batch) {
      let title = name; const seen = new Set();
      while (mapping.has(title) && !seen.has(title)) {seen.add(title);title=mapping.get(title);}
      const page = pages.get(title);
      if (page) index[name] = page.pageid > 0 && page.missing === undefined ? {title:page.title,pageid:page.pageid} : null;
    }
    fs.writeFileSync(output + '.tmp', JSON.stringify(index)); fs.renameSync(output + '.tmp', output);
    const matched = entities.filter(a => namesFor(a).some(n => index[n])).length;
    console.log(`Exact titles ${Math.min(i+50,names.length)}/${names.length}; ${matched}/${ids.size} entities have article candidates.`);
  }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
