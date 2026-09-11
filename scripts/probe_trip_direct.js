// Bounded, cookie-free link trial. Writes only an isolated runtime report.
const fs = require('fs');
const path = require('path');
const { load } = require('cheerio');
const { parseTripAttractionGallery } = require('./gallery_source_parsers');
const simplify = require('opencc-js').Converter({ from: 'tw', to: 'cn' });
async function main() {
  const root = path.resolve(__dirname, '..');
  if (path.basename(root).toLowerCase() !== 'lvyoumap-universal-serverbeta') throw Error('Beta only');
  const [url, expectedName, expectedCity] = process.argv.slice(2);
  const parsedUrl = new URL(url);
  const poiId = parsedUrl.pathname.match(/-(\d+)\/?$/)?.[1];
  if (parsedUrl.hostname !== 'hk.trip.com' || !poiId || !expectedName || !expectedCity) throw Error('Expected exact Trip URL, name and city');
  const dir = path.join(root, '.runtime', 'attraction-gallery-batch', 'link-pilot', `trip-${poiId}`);
  fs.mkdirSync(dir, { recursive: true });
  const report = { url, expectedName, expectedCity, poiId, at: new Date().toISOString(), pages: [], images: [], browserCookiesUsed: false };
  const started = Date.now();
  let photos = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const begin = Date.now();
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'zh-CN,zh;q=0.9' }, signal: AbortSignal.timeout(8000) });
      if (!response.ok) { report.pages.push({ status: response.status, ms: Date.now() - begin }); break; }
      const html = await response.text(), parsed = parseTripAttractionGallery(html, poiId);
      const body = simplify(load(html)('title,body').text());
      const identity = simplify(parsed.name) === expectedName && body.includes(expectedCity);
      report.pages.push({ status: response.status, identity, name: parsed.name, count: parsed.photos.length, ms: Date.now() - begin });
      if (!identity) break;
      photos = parsed.photos.slice(0, 5);
    } catch (error) { report.pages.push({ error: error.message, cause: error.cause?.code || error.cause?.message }); break; }
  }
  // No API/WAF retries or guessed image transformations: use exact page URLs.
  for (let offset = 0; offset < photos.length; offset += 2) {
    await Promise.all(photos.slice(offset, offset + 2).map(async (photo, position) => {
      const index = offset + position, entry = { index, url: photo.imageUrl };
      try {
        const response = await fetch(photo.imageUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14)' }, signal: AbortSignal.timeout(8000) });
        entry.status = response.status;
        if (response.ok) { const data = Buffer.from(await response.arrayBuffer()); entry.bytes = data.length; entry.file = path.join(dir, `${index + 1}.jpg`); fs.writeFileSync(entry.file, data); }
      } catch (error) { entry.error = error.message; entry.cause = error.cause?.code || error.cause?.message; }
      report.images.push(entry);
    }));
  }
  report.elapsedMs = Date.now() - started;
  fs.writeFileSync(path.join(dir, 'direct-probe.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ pages: report.pages, downloaded: report.images.filter(x => x.file).length, elapsedMs: report.elapsedMs, report: path.relative(root, path.join(dir, 'direct-probe.json')) }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
