const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const sitemapPath = path.join(rootDir, 'dist', 'sitemap-core.xml');
const siteOrigin = 'https://xzmap.xzbest.site';
const siteHost = new URL(siteOrigin).hostname;

function parseArguments(argv) {
  const options = { all: false, dryRun: false, limit: 10, offset: 0, urls: [] };
  for (const argument of argv) {
    if (argument === '--all') options.all = true;
    else if (argument === '--dry-run') options.dryRun = true;
    else if (argument.startsWith('--url=')) options.urls.push(argument.slice('--url='.length));
    else if (argument.startsWith('--limit=')) options.limit = Number(argument.slice('--limit='.length));
    else if (argument.startsWith('--offset=')) options.offset = Number(argument.slice('--offset='.length));
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 2000) {
    throw new Error('--limit must be an integer between 1 and 2000');
  }
  if (!Number.isInteger(options.offset) || options.offset < 0) {
    throw new Error('--offset must be a non-negative integer');
  }
  return options;
}

function readLocalEnv() {
  const envPath = path.join(rootDir, '.env');
  if (!fs.existsSync(envPath)) return {};
  const values = {};
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[name] = value;
  }
  return values;
}

function decodeXml(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function readSitemapUrls() {
  if (!fs.existsSync(sitemapPath)) throw new Error('Missing dist/sitemap-core.xml. Run npm run build first.');
  const xml = fs.readFileSync(sitemapPath, 'utf8');
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => decodeXml(match[1].trim()));
}

function isPriorityUrl(value) {
  const url = new URL(value);
  return url.pathname === '/'
    || url.pathname === '/destinations/index.html'
    || /^\/destinations\/[a-z0-9_-]+\.html$/.test(url.pathname);
}

function validateUrl(value) {
  const url = new URL(value);
  if (url.origin !== siteOrigin) throw new Error(`URL is outside ${siteOrigin}: ${value}`);
  return url.href;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const sitemapUrls = readSitemapUrls();
  const candidates = options.urls.length > 0
    ? options.urls
    : (options.all ? sitemapUrls : sitemapUrls.filter(isPriorityUrl));
  const requestedUrls = options.urls.length > 0
    ? candidates
    : candidates.slice(options.offset, options.offset + options.limit);
  const urls = [...new Set(requestedUrls.map(validateUrl))];

  if (urls.length === 0) throw new Error('No URLs selected for Baidu submission');
  console.log(`Baidu selection: ${urls.length} URLs (offset ${options.offset}, limit ${options.limit}; sitemap total ${sitemapUrls.length})`);
  if (options.dryRun) {
    console.log('Dry run complete; no request was sent.');
    return;
  }

  const localEnv = readLocalEnv();
  const token = process.env.BAIDU_PUSH_TOKEN || localEnv.BAIDU_PUSH_TOKEN;
  if (!token) throw new Error('Missing BAIDU_PUSH_TOKEN in the local .env file');
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(token)) throw new Error('Invalid BAIDU_PUSH_TOKEN format');

  // Baidu's documented examples use the verified host without a URL scheme.
  // Some dashboard examples include https://, which can return "site init fail".
  const query = new URLSearchParams({ site: siteHost, token });
  const response = await fetch(`http://data.zz.baidu.com/urls?${query}`, {
    method: 'POST',
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'user-agent': 'lvyoumap-baidu-submit/1.0',
    },
    body: urls.join('\n'),
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  });
  const rawBody = await response.text();
  let result;
  try {
    result = JSON.parse(rawBody);
  } catch {
    throw new Error(`Baidu returned HTTP ${response.status} with an invalid response`);
  }
  if (!response.ok || result.error) {
    throw new Error(`Baidu submission failed: ${result.message || result.error || `HTTP ${response.status}`}`);
  }
  console.log(`Baidu accepted ${Number(result.success || 0)} URLs; remaining quota: ${result.remain ?? 'unknown'}`);
  if (result.not_same_site?.length) console.log(`Rejected as another site: ${result.not_same_site.length}`);
  if (result.not_valid?.length) console.log(`Rejected as invalid: ${result.not_valid.length}`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
