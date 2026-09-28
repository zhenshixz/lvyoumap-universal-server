const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const fullSitemapPath = path.join(distDir, 'sitemap.xml');
const coreSitemapPath = path.join(distDir, 'sitemap-core.xml');
const keyPath = path.join(rootDir, 'indexnow-key.txt');
const receiptDir = path.join(rootDir, '.runtime', 'indexnow-submissions');
const siteOrigin = 'https://xzmap.xzbest.site';
const endpoint = 'https://api.indexnow.org/indexnow';
const keyLocation = `${siteOrigin}/indexnow-key.txt`;

function parseArguments(argv) {
  const options = { all: false, dryRun: false, force: false, urls: [] };
  for (const argument of argv) {
    if (argument === '--all') options.all = true;
    else if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--force') options.force = true;
    else if (argument.startsWith('--url=')) options.urls.push(argument.slice('--url='.length));
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function decodeXml(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function readSitemapUrls(sitemapPath) {
  if (!fs.existsSync(sitemapPath)) {
    throw new Error(`Missing ${path.relative(rootDir, sitemapPath)}. Run npm run build first.`);
  }
  const xml = fs.readFileSync(sitemapPath, 'utf8');
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => decodeXml(match[1].trim()));
}

function receiptPath(urls) {
  const digest = crypto.createHash('sha256').update(urls.join('\n')).digest('hex').slice(0, 16);
  return path.join(receiptDir, `${digest}.json`);
}

function validateUrl(value) {
  const url = new URL(value);
  if (url.origin !== siteOrigin) throw new Error(`URL is outside ${siteOrigin}: ${value}`);
  return url.href;
}

async function verifyLiveKey(key) {
  const response = await fetch(keyLocation, {
    headers: { 'user-agent': 'lvyoumap-indexnow/1.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Live IndexNow key returned HTTP ${response.status}: ${keyLocation}`);
  const liveKey = (await response.text()).trim();
  if (liveKey !== key) throw new Error(`Live IndexNow key does not match ${path.basename(keyPath)}`);
}

async function submitBatch(key, urls) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'user-agent': 'lvyoumap-indexnow/1.0',
    },
    body: JSON.stringify({
      host: new URL(siteOrigin).hostname,
      key,
      keyLocation,
      urlList: urls,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (response.status !== 200 && response.status !== 202) {
    const body = (await response.text()).trim();
    throw new Error(`IndexNow returned HTTP ${response.status}${body ? `: ${body}` : ''}`);
  }
  return response.status;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const key = fs.readFileSync(keyPath, 'utf8').trim();
  if (!/^[A-Za-z0-9-]{8,128}$/.test(key)) throw new Error('Invalid IndexNow key');

  const sitemapPath = options.all ? fullSitemapPath : coreSitemapPath;
  const sitemapUrls = readSitemapUrls(sitemapPath);
  const requestedUrls = options.urls.length > 0
    ? options.urls.map(validateUrl)
    : sitemapUrls;
  const urls = [...new Set(requestedUrls.map(validateUrl))];
  const receipt = receiptPath(urls);

  if (urls.length === 0) throw new Error('No URLs selected for IndexNow submission');
  console.log(`IndexNow selection: ${urls.length} URLs from ${path.basename(sitemapPath)}`);
  console.log(`Key location: ${keyLocation}`);

  if (fs.existsSync(receipt) && !options.force) {
    const previous = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    console.log(`Exact URL batch was already accepted on ${previous.acceptedAt}; no duplicate request sent.`);
    return;
  }

  if (options.dryRun) {
    console.log('Dry run complete; no request was sent.');
    return;
  }

  await verifyLiveKey(key);
  console.log('Live key verification passed.');

  for (let offset = 0; offset < urls.length; offset += 10000) {
    const batch = urls.slice(offset, offset + 10000);
    const status = await submitBatch(key, batch);
    console.log(`Submitted ${batch.length} URLs: HTTP ${status}`);
  }
  fs.mkdirSync(receiptDir, { recursive: true });
  fs.writeFileSync(receipt, `${JSON.stringify({
    acceptedAt: new Date().toISOString(),
    sitemap: options.urls.length > 0 ? 'explicit URLs' : path.basename(sitemapPath),
    urlCount: urls.length,
  }, null, 2)}\n`, 'utf8');
  console.log('IndexNow notification accepted. Crawling and indexing are still decided by each search engine.');
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
