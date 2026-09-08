const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { bufferDimensions } = require('./collect_core_details');
const { parseCtripGallery } = require('./gallery_source_parsers');

const root = path.resolve(__dirname, '..');
const runtime = path.join(root, '.runtime', 'attraction-gallery-batch');
const statePath = path.join(runtime, 'state.json');
const imageDir = path.join(runtime, 'images');
const amapCacheDir = path.join(runtime, 'amap-cache');
const dbPath = path.join(root, 'content', 'db.json');
const galleryPath = path.join(root, 'content', 'attraction-gallery-overrides.json');
const denylistPath = path.join(root, 'content', 'attraction-gallery-image-denylist.json');
const galleryPolicyPath = path.join(root, 'content', 'attraction-gallery-policy.json');
const pageRequests = new Map();

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

const galleryPolicy = readJson(galleryPolicyPath);
const MIN_IMAGES = Number(galleryPolicy.minimumImages);
const TARGET_IMAGES = Number(galleryPolicy.targetImages);
const MAX_IMAGES = Number(galleryPolicy.maximumImages);
if (!(MIN_IMAGES >= 1 && MIN_IMAGES <= TARGET_IMAGES && TARGET_IMAGES <= MAX_IMAGES)) {
  throw new Error('图库规则无效：必须满足 minimumImages <= targetImages <= maximumImages。');
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\r\n`, 'utf8');
  fs.renameSync(`${file}.tmp`, file);
}

function loadEnv() {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim().replace(/^(?:"(.*)"|'(.*)')$/, '$1$2');
    }
  }
}

function argValue(name, fallback = '') {
  const item = process.argv.find(value => value.startsWith(`--${name}=`));
  return item ? item.slice(name.length + 3) : fallback;
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s·•（）()\[\]【】\-_—]/g, '')
    .replace(/国家级|世界文化遗产|世界自然遗产/g, '')
    .replace(/旅游度假区|风景名胜区|旅游景区|风景区|景区|公园|博物馆|博物院/g, '');
}

function galleryEntityExclusionReason(attraction) {
  const name = String(attraction?.name || '');
  if (/(?:标志门店|餐厅|饭店|酒楼|土菜馆|小吃店|烧烤店|火锅店|咖啡店)/.test(name)) {
    return '名称明确属于餐饮门店，不进入景点图库';
  }
  return '';
}

function hdUrl(value) {
  let url = String(value || '').trim().replace(/^http:/i, 'https:');
  if (/store\.is\.autonavi\.com\/showpic\//i.test(url)) {
    if (/([?&])type=/i.test(url)) return url.replace(/([?&])type=[^&]*/i, '$1type=7');
    return `${url}${url.includes('?') ? '&' : '?'}type=7`;
  }
  return url;
}

function stableUrl(value) {
  const url = hdUrl(value);
  // Amap comment photos are user uploads and may contain posters, screenshots,
  // watermarks or unrelated people. They are deliberately not a stable source.
  if (/_AIGC\//i.test(url) || /aos-comment\.amap\.com\//i.test(url)) return false;
  return url.startsWith('/') || /^(?:https:\/\/)(?:store\.is\.autonavi\.com|aos-cdn-image\.amap\.com|lyfw\.mct\.gov\.cn\/_static|upload\.wikimedia\.org|commons\.wikimedia\.org|(?:dimg\d+|youimg\d+)\.c-ctrip\.com)\//i.test(url);
}

function sourceRank(source) {
  return ({ local: 60, mct_official: 55, amap_exact: 50, amap_subspot: 45, curated_subspot: 40, ctrip_exact: 35, wikimedia_exact: 30 })[source] || 0;
}

function urlRank(url) {
  if (String(url).startsWith('/')) return 20;
  if (/store\.is\.autonavi\.com\/showpic\//i.test(url)) return 15;
  if (/aos-cdn-image\.amap\.com\//i.test(url)) return 12;
  if (/(?:dimg\d+|youimg\d+)\.c-ctrip\.com\//i.test(url)) return 10;
  if (/wikimedia\.org\//i.test(url)) return 8;
  if (/aos-comment\.amap\.com\//i.test(url)) return 5;
  return 0;
}

function qualityPass(dimensions, bytes) {
  if (!dimensions || bytes < 70 * 1024) return false;
  const long = Math.max(dimensions.width, dimensions.height);
  const short = Math.min(dimensions.width, dimensions.height);
  const ratio = long / Math.max(1, short);
  return long >= 1000 && short >= 560 && ratio <= 2.5;
}

async function fetchJson(url, timeout = 12000) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'ChinaTourismMapGallery/2.0' },
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function fetchText(url, timeout = 18000) {
  if (!pageRequests.has(url)) pageRequests.set(url, fetchPage(url, timeout));
  return pageRequests.get(url);
}

async function fetchPage(url, timeout) {
  const key = crypto.createHash('sha256').update(url).digest('hex');
  const cacheFile = path.join(runtime, 'page-cache', `${key}.html.gz`);
  const legacyFile = path.join(runtime, 'page-cache', `${key}.html`);
  if (fs.existsSync(cacheFile) && Date.now() - fs.statSync(cacheFile).mtimeMs < 7 * 86400000) {
    return zlib.gunzipSync(fs.readFileSync(cacheFile)).toString('utf8');
  }
  if (fs.existsSync(legacyFile) && Date.now() - fs.statSync(legacyFile).mtimeMs < 7 * 86400000) {
    const html = fs.readFileSync(legacyFile, 'utf8');
    fs.writeFileSync(cacheFile, zlib.gzipSync(html, { level: 6 }));
    fs.rmSync(legacyFile, { force: true });
    return html;
  }
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();
  if (/whaleguard block|captcha|访问过于频繁/i.test(html.slice(0, 3000))) throw new Error('来源限流，保留断点');
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, zlib.gzipSync(html, { level: 6 }));
  return html;
}

function compactPageCache() {
  const directory = path.join(runtime, 'page-cache');
  if (!fs.existsSync(directory)) return;
  for (const file of fs.readdirSync(directory).filter(name => name.endsWith('.html'))) {
    const source = path.join(directory, file);
    const target = `${source}.gz`;
    try {
      if (!fs.existsSync(target)) fs.writeFileSync(target, zlib.gzipSync(fs.readFileSync(source), { level: 6 }));
      fs.rmSync(source, { force: true });
    } catch { /* cache is optional and may be fetched again */ }
  }
  const files = fs.readdirSync(directory).map(name => path.join(directory, name))
    .filter(file => fs.statSync(file).isFile())
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  let bytes = 0;
  for (const [index, file] of files.entries()) {
    const stat = fs.statSync(file);
    bytes += stat.size;
    if (index >= 499 || bytes > 200 * 1024 * 1024 || Date.now() - stat.mtimeMs > 7 * 86400000) fs.rmSync(file, { force: true });
  }
}

async function fetchImage(url) {
  if (url.startsWith('/')) return fs.readFileSync(path.join(root, url.slice(1)));
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36',
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const type = String(response.headers.get('content-type') || '');
  if (!type.startsWith('image/')) throw new Error(`非图片响应 ${type}`);
  return Buffer.from(await response.arrayBuffer());
}

function uniqueCandidates(items, denylist = new Set()) {
  const seen = new Set();
  return items.filter(item => {
    item.url = hdUrl(item.url);
    if (!stableUrl(item.url) || denylist.has(item.url) || seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

function keyPool() {
  return [...new Set([
    ...String(process.env.AMAP_WEB_SERVICE_KEYS || '').split(','),
    String(process.env.AMAP_WEB_SERVICE_KEY || ''),
  ].map(value => value.trim()).filter(Boolean))];
}

async function amapRequest(pathname, params, keys, exhausted) {
  const cacheKey = crypto.createHash('sha1').update(JSON.stringify([pathname, params])).digest('hex');
  const cacheFile = path.join(amapCacheDir, `${cacheKey}.json`);
  if (fs.existsSync(cacheFile)) {
    try {
      return readJson(cacheFile);
    } catch {
      // Broken local cache entries are ignored and refreshed.
    }
  }
  for (let index = 0; index < keys.length; index += 1) {
    if (exhausted.has(index)) continue;
    const url = new URL(`https://restapi.amap.com${pathname}`);
    for (const [key, value] of Object.entries(params)) if (value !== '') url.searchParams.set(key, value);
    url.searchParams.set('key', keys[index]);
    try {
      const payload = await fetchJson(url);
      if (String(payload.status) === '1') {
        writeJson(cacheFile, payload);
        return payload;
      }
      if (/10044|DAILY_QUERY_OVER_LIMIT|USER_DAILY_QUERY_OVER_LIMIT/i.test(`${payload.infocode} ${payload.info}`)) {
        exhausted.add(index);
        continue;
      }
      return null;
    } catch {
      continue;
    }
  }
  return null;
}

async function amapDetail(id, keys, exhausted) {
  const payload = await amapRequest('/v5/place/detail', {
    id: String(id || '').replace(/^amap_/i, ''),
    show_fields: 'photos',
  }, keys, exhausted);
  return payload?.pois?.[0] || null;
}

async function amapNamedPoi(name, city, keys, exhausted) {
  const payload = await amapRequest('/v5/place/text', {
    keywords: name,
    region: city || '',
    city_limit: city ? 'true' : 'false',
    show_fields: 'photos',
    page_size: '10',
  }, keys, exhausted);
  const target = normalizeName(name);
  return (payload?.pois || []).find(poi => {
    const candidate = normalizeName(poi.name);
    return candidate && target && candidate === target;
  }) || null;
}

function commonsCandidate(page, attraction) {
  const info = page?.imageinfo?.[0];
  if (!info) return null;
  const meta = info.extmetadata || {};
  const text = `${page.title || ''} ${meta.ImageDescription?.value || ''} ${meta.Categories?.value || ''}`;
  const target = normalizeName(attraction.name);
  const normalized = normalizeName(text.replace(/<[^>]*>/g, ' '));
  const noise = /地图|导览|路线|海报|截图|地铁|列车|车厢|站台|logo|二维码|\bmap\b|screenshot|metro|subway|train/i;
  const license = String(meta.LicenseShortName?.value || meta.UsageTerms?.value || '');
  if (!target || !normalized.includes(target) || noise.test(text) || !/(CC|public domain|公有领域)/i.test(license)) return null;
  if (Number(info.width || 0) < 1000 || Number(info.height || 0) < 560) return null;
  const url = info.thumburl || info.url;
  if (!stableUrl(url)) return null;
  return {
    url,
    caption: String(page.title || '').replace(/^File:/i, ''),
    source: 'wikimedia_exact',
    sourceUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(String(page.title || '').replace(/ /g, '_'))}`,
  };
}

async function wikimediaExact(attraction) {
  try {
    const searchUrl = new URL('https://www.wikidata.org/w/api.php');
    Object.entries({ action: 'wbsearchentities', search: attraction.name, language: 'zh', uselang: 'zh', format: 'json', limit: '5', origin: '*' })
      .forEach(([key, value]) => searchUrl.searchParams.set(key, value));
    const result = await fetchJson(searchUrl);
    const target = normalizeName(attraction.name);
    const hit = (result.search || []).find(item => [item.label, item.match?.text, ...(item.aliases || [])]
      .some(value => normalizeName(value) === target));
    if (!hit) return [];
    const entity = (await fetchJson(`https://www.wikidata.org/wiki/Special:EntityData/${hit.id}.json`)).entities?.[hit.id];
    const file = entity?.claims?.P18?.[0]?.mainsnak?.datavalue?.value || '';
    const category = entity?.claims?.P373?.[0]?.mainsnak?.datavalue?.value || '';
    const pages = {};
    if (file) {
      const url = new URL('https://commons.wikimedia.org/w/api.php');
      Object.entries({ action: 'query', titles: `File:${file}`, prop: 'imageinfo', iiprop: 'url|size|extmetadata', iiurlwidth: '1800', format: 'json', origin: '*' })
        .forEach(([key, value]) => url.searchParams.set(key, value));
      Object.assign(pages, (await fetchJson(url)).query?.pages || {});
    }
    if (category) {
      const url = new URL('https://commons.wikimedia.org/w/api.php');
      Object.entries({ action: 'query', generator: 'categorymembers', gcmtitle: `Category:${category}`, gcmtype: 'file', gcmlimit: '30', prop: 'imageinfo', iiprop: 'url|size|extmetadata', iiurlwidth: '1800', format: 'json', origin: '*' })
        .forEach(([key, value]) => url.searchParams.set(key, value));
      Object.assign(pages, (await fetchJson(url)).query?.pages || {});
    }
    return Object.values(pages).map(page => commonsCandidate(page, attraction)).filter(Boolean);
  } catch {
    return [];
  }
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, '')
    .trim();
}

function ctripProvincePages() {
  const result = new Map();
  result.detailUrls = new Map();
  const add = (province, name, url) => {
    if (!province || !name || !/^https:\/\/you\.ctrip\.com\/sight\//i.test(url || '')) return;
    const key = `${province}\u0000${normalizeName(name)}`;
    const urls = result.detailUrls.get(key) || new Set();
    urls.add(url); result.detailUrls.set(key, urls);
  };
  for (const file of fs.readdirSync(path.join(root, '.runtime')).filter(name => /^core-ota-.+\.json$/i.test(name))) {
    try {
      const data = readJson(path.join(root, '.runtime', file));
      for (const item of data.candidates || []) add(data.province, item.name, item.url);
    } catch { /* Ignore malformed historical snapshots. */ }
  }
  for (const file of fs.readdirSync(path.join(root, '.runtime')).filter(name => /^core-secondary-evidence-.+\.json$/i.test(name))) {
    try {
      const data = readJson(path.join(root, '.runtime', file));
      for (const item of data.results || []) {
        for (const evidence of item.evidences || []) add(data.province, evidence.name, evidence.url);
      }
    } catch { /* Only reuse readable, explicitly named source records. */ }
  }
  if (fs.existsSync(statePath)) {
    for (const item of readJson(statePath).items || []) {
      for (const image of item.qualified || []) add(item.province, item.name, image.sourceUrl);
    }
  }
  for (const file of fs.readdirSync(path.join(root, 'content')).filter(name => /^core-attractions\..+\.json$/i.test(name))) {
    try {
      const data = readJson(path.join(root, 'content', file));
      if (data.province && data.sources?.ctrip_province_sightlist) result.set(data.province, data.sources.ctrip_province_sightlist);
      if (data.province && data.ctrip_province_sightlist) result.set(data.province, data.ctrip_province_sightlist);
    } catch {
      // 单个历史清单格式异常不阻断全批次。
    }
  }
  return result;
}

function mctOfficialImages() {
  const result = new Map();
  for (const file of fs.readdirSync(path.join(root, '.runtime')).filter(name => /^core-official-.+\.json$/i.test(name))) {
    try {
      const data = readJson(path.join(root, '.runtime', file));
      for (const item of [...(data.fiveA || []), ...(data.resorts || [])]) {
        const key = `${data.province}\u0000${normalizeName(item.name)}`;
        if (!item.picture || result.has(key)) continue;
        const url = String(item.picture).startsWith('http')
          ? item.picture
          : `https://lyfw.mct.gov.cn/_static/${String(item.picture).replace(/^\/+/, '')}`;
        result.set(key, { url, sourceUrl: data.sourceUrl || '' });
      }
    } catch {
      // A malformed historical province snapshot does not block the batch.
    }
  }
  return result;
}

async function ctripExact(attraction, province, provincePages) {
  const base = provincePages.get(province);
  const existing = provincePages.detailUrls.get(`${province}\u0000${normalizeName(attraction.name)}`);
  let detailUrl = existing?.size === 1 ? [...existing][0] : '';
  if (!detailUrl && base) {
    const target = normalizeName(attraction.name);
    const slug = base.match(/\/sightlist\/([^/?]+)\.html/)?.[1];
    // The province listing ignores ?keyword=. Reuse actual listing pages across
    // attractions, with a bounded page budget, rather than repeating fake searches.
    for (let page = 1; page <= (slug ? 3 : 1) && !detailUrl; page += 1) {
      const listUrl = page === 1 ? base : `https://you.ctrip.com/sight/${slug}/s0-p${page}.html`;
      const listHtml = await fetchText(listUrl);
      const links = [...listHtml.matchAll(/<div class="titleModule_name__[^"]+"><span><a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)]
        .map(match => ({ url: decodeHtml(match[1]), name: decodeHtml(match[2]) }));
      for (const link of links) {
        const url = new URL(link.url, 'https://you.ctrip.com').href;
        if (!/^https:\/\/you\.ctrip\.com\/sight\//i.test(url)) continue;
        if (normalizeName(link.name) === target) detailUrl = url;
      }
      if (!links.length) break;
    }
  }
  if (!detailUrl) return [];
  const detail = parseCtripGallery(await fetchText(detailUrl), attraction);
  return detail.photos.filter(photo => stableUrl(photo.imageUrl))
      .map(photo => ({
        url: photo.imageUrl,
        caption: attraction.name,
        source: 'ctrip_exact',
        sourceUrl: detailUrl,
        sourceField: 'poiDetail.imageInfo.poiPhotoImageList',
        sourcePoiId: detail.poiId,
        sourceImageId: photo.imageId,
      }));
}

async function probe(candidate, attractionId, index) {
  try {
    const buffer = await fetchImage(candidate.url);
    const dimensions = bufferDimensions(buffer);
    if (!qualityPass(dimensions, buffer.length)) {
      return { ...candidate, accepted: false, reason: '分辨率或文件体积不足', dimensions, bytes: buffer.length };
    }
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const extension = buffer.slice(0, 2).toString('hex') === 'ffd8' ? 'jpg' : 'img';
    const file = path.join(imageDir, `${hash}.${extension}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buffer);
    return {
      ...candidate,
      accepted: true,
      dimensions,
      bytes: buffer.length,
      hash,
      reviewFile: path.relative(root, file).replace(/\\/g, '/'),
    };
  } catch (error) {
    return { ...candidate, accepted: false, reason: error.message };
  }
}

function buildCohort(db, existing, state, limit) {
  const byId = new Map();
  for (const province of Object.values(db.provinces)) {
    for (const attraction of province.attractions || []) {
      if (attraction.id) byId.set(attraction.id, { province: province.province || province.name, attraction });
    }
  }
  const cohort = [];
  const seen = new Set();
  const retain = id => {
    if (!byId.has(id) || seen.has(id) || cohort.length >= limit) return;
    cohort.push(id); seen.add(id);
  };
  for (const id of state.cohortIds || []) retain(id);
  for (const item of state.items || []) retain(item.id);
  const groups = Object.values(db.provinces).map(province => ({
    province: province.province || province.name,
    attractions: (province.attractions || [])
      .filter(item => item.id && !existing[item.id] && !seen.has(item.id))
      .sort((left, right) => (Number(right.rating) || 0) - (Number(left.rating) || 0)),
  }));
  for (let round = 0; cohort.length < limit; round += 1) {
    let added = 0;
    for (const group of groups) {
      const attraction = group.attractions[round];
      if (!attraction) continue;
      if (seen.has(attraction.id)) continue;
      cohort.push(attraction.id); seen.add(attraction.id);
      added += 1;
      if (cohort.length >= limit) break;
    }
    if (!added) break;
  }
  state.cohortIds = cohort;
  return cohort.map(id => byId.get(id)).filter(Boolean);
}

async function collectOne(record, keys, exhausted, provincePages, officialImages, denylist, previous, options = {}) {
  const { attraction, province } = record;
  const retryAmap = !previous || previous.amapComplete !== true;
  const exact = retryAmap && attraction.id.startsWith('amap_') ? await amapDetail(attraction.id, keys, exhausted) : null;
  const candidates = [];
  if (stableUrl(attraction.image)) {
    const local = String(attraction.image).startsWith('/');
    candidates.push({ url: attraction.image, caption: `${attraction.name}现有主图`, source: local ? 'local' : 'amap_exact', sourcePoiId: attraction.id.replace(/^amap_/i, '') });
  }
  const official = officialImages.get(`${province}\u0000${normalizeName(attraction.name)}`);
  if (official && stableUrl(official.url)) {
    candidates.push({
      url: official.url,
      caption: `${attraction.name}文旅部官方名录图片`,
      source: 'mct_official',
      sourceUrl: official.sourceUrl,
    });
  }
  // Amap v5 currently returns at most three official POI photos. Keep that
  // bounded set; user-comment photos are excluded separately.
  for (const photo of (exact?.photos || []).slice(0, 3)) {
    candidates.push({ url: photo.url, caption: photo.title || attraction.name, source: 'amap_exact', sourcePoiId: exact.id });
  }
  // 历史 ID 可能不是当前高德主 POI。只接受同城市、名称规范化后完全一致的
  // 平台内部结果，若命中另一个准确 POI，可获得同一实体的另一套照片。
  const namedExact = retryAmap ? await amapNamedPoi(attraction.name, attraction.city, keys, exhausted) : null;
  if (namedExact && namedExact.id !== exact?.id && normalizeName(namedExact.name) === normalizeName(attraction.name)) {
    for (const photo of (namedExact.photos || []).slice(0, 3)) {
      candidates.push({ url: photo.url, caption: photo.title || attraction.name, source: 'amap_exact', sourcePoiId: namedExact.id });
    }
  }
  for (const subspot of retryAmap ? (attraction.sub_spots || []) : []) {
    if (stableUrl(subspot.image)) candidates.push({ url: subspot.image, caption: subspot.name, source: 'curated_subspot', sourcePoiId: String(subspot.id || '').replace(/^amap_/i, '') });
    const poi = subspot.id?.startsWith('amap_')
      ? await amapDetail(subspot.id, keys, exhausted)
      : await amapNamedPoi(subspot.name, attraction.city, keys, exhausted);
    for (const photo of (poi?.photos || []).slice(0, 3)) {
      candidates.push({ url: photo.url, caption: `${attraction.name} · ${subspot.name}`, source: 'amap_subspot', sourcePoiId: poi.id });
    }
  }
  const probed = [];
  const attempts = [];
  const attempted = new Set();
  for (const old of uniqueCandidates(previous?.qualified || [], denylist)) {
    try {
      const buffer = fs.readFileSync(path.join(root, old.reviewFile));
      const expected = old.reviewCompacted ? old.reviewHash : old.hash;
      if (!expected || crypto.createHash('sha256').update(buffer).digest('hex') !== expected) throw new Error('旧缓存内容变化');
      probed.push(old); attempted.add(old.url);
    } catch { candidates.push(old); }
  }
  const goodCount = () => new Set(probed.filter(item => item.accepted).map(item => item.hash)).size;
  const check = async items => {
    const fresh = uniqueCandidates(items, denylist).filter(item => !attempted.has(item.url)).slice(0, 18);
    for (let offset = 0; offset < fresh.length; offset += 3) {
      const chunk = fresh.slice(offset, offset + 3);
      chunk.forEach(item => attempted.add(item.url));
      probed.push(...await Promise.all(chunk.map(item => probe(item, attraction.id, probed.length))));
    }
  };
  await check(candidates);
  // Primary exact sources may naturally provide up to the configured maximum.
  // Expensive secondary lookups run only below the minimum, so 3-4 good images
  // are not needlessly chased to five.
  if (!options.primaryOnly && goodCount() < MIN_IMAGES) {
    try {
      const photos = await ctripExact(attraction, province, provincePages);
      attempts.push({ source: 'ctrip', result: photos.length ? 'found' : 'no_exact_page', count: photos.length });
      await check(photos);
    } catch (error) { attempts.push({ source: 'ctrip', result: 'retryable_error', reason: error.message }); }
  }
  if (!options.primaryOnly && goodCount() < MIN_IMAGES) await check(await wikimediaExact(attraction));
  const seenHash = new Set();
  const qualified = probed
    .filter(item => item.accepted)
    .sort((left, right) => sourceRank(right.source) - sourceRank(left.source)
      || urlRank(right.url) - urlRank(left.url)
      || (right.dimensions.width * right.dimensions.height) - (left.dimensions.width * left.dimensions.height))
    .filter(item => !seenHash.has(item.hash) && seenHash.add(item.hash));
  return {
    id: attraction.id,
    name: attraction.name,
    province,
    city: attraction.city || '',
    status: qualified.length >= MIN_IMAGES ? 'ready_for_visual_review' : 'pending_sources',
    qualifiedCount: qualified.length,
    qualified: qualified.slice(0, 10),
    attempts,
    amapComplete: previous?.amapComplete === true || !!(exact || namedExact),
    primaryComplete: previous?.primaryComplete === true || options.primaryOnly || !!(exact || namedExact),
    secondaryComplete: previous?.secondaryComplete === true || !options.primaryOnly,
    updatedAt: new Date().toISOString(),
    rejectedCount: probed.length - qualified.length,
    rejected: probed.filter(item => !item.accepted).map(item => ({ url: item.url, source: item.source, reason: item.reason })),
  };
}

async function main() {
  loadEnv();
  compactPageCache();
  if (process.argv.includes('--compact-cache-only')) {
    console.log('页面缓存压缩和容量整理完成。');
    return;
  }
  const keys = keyPool();
  if (!keys.length) console.warn('未配置高德 Key，继续复用缓存及其他稳定来源。');
  const limit = Math.max(1, Number(argValue('limit', '100')) || 100);
  const concurrency = Math.min(6, Math.max(1, Number(argValue('concurrency', '4')) || 4));
  const reset = process.argv.includes('--reset');
  const repairPending = process.argv.includes('--repair-pending');
  const primaryOnly = process.argv.includes('--primary-only');
  const retryUnresolved = process.argv.includes('--retry-unresolved');
  const maxItems = Math.max(1, Number(argValue('max-items', String(limit))) || limit);
  const db = readJson(dbPath);
  const galleries = readJson(galleryPath);
  const old = !reset && fs.existsSync(statePath) ? readJson(statePath) : null;
  const state = old?.items ? old : {
    version: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    limit,
    rule: galleryPolicy.rule,
    sourceOrder: ['现有稳定图', '文旅部官方名录', '高德精确POI', '已确认子景点高德POI', '携程精确景点详情页前两张', 'Wikidata/Wikimedia精确实体'],
    items: [],
  };
  // Changing batch size or resuming must never discard existing progress.
  state.version = 5; state.limit = limit; state.galleryPolicy = galleryPolicy; state.rule = galleryPolicy.rule;
  state.sourceOrder = ['现有已核对图片', '文旅部名录', '高德精确POI', '携程实体绑定相册', '百科精确实体'];
  const targets = buildCohort(db, galleries, state, limit);
  for (const target of targets) {
    const reason = galleryEntityExclusionReason(target.attraction);
    if (!reason) continue;
    const excluded = {
      id: target.attraction.id,
      name: target.attraction.name,
      province: target.province,
      city: target.attraction.city || '',
      status: 'excluded_non_attraction',
      exclusionReason: reason,
      updatedAt: new Date().toISOString(),
    };
    const position = state.items.findIndex(item => item.id === excluded.id);
    if (position >= 0) state.items[position] = excluded;
    else state.items.push(excluded);
  }
  const previousItems = new Map(state.items.map(item => [item.id, item]));
  const exhausted = new Set();
  const provincePages = ctripProvincePages();
  const officialImages = mctOfficialImages();
  const denylist = new Set((fs.existsSync(denylistPath) ? readJson(denylistPath) : []).map(item => hdUrl(item.url)));
  fs.mkdirSync(runtime, { recursive: true });
  const remaining = targets.filter(target => {
    const prior = previousItems.get(target.attraction.id);
    return !prior || (repairPending && ((prior.status === 'pending_sources'
      && (prior.secondaryComplete !== true || retryUnresolved))
      || (prior.selected || []).some(image => denylist.has(hdUrl(image.url)))));
  }).sort((a, b) => String(previousItems.get(a.attraction.id)?.updatedAt || '')
    .localeCompare(String(previousItems.get(b.attraction.id)?.updatedAt || ''))).slice(0, maxItems);
  for (let index = 0; index < remaining.length; index += concurrency) {
    const group = remaining.slice(index, index + concurrency);
    const results = await Promise.all(group.map(async target => {
      const prior = previousItems.get(target.attraction.id);
      try {
        return await collectOne(target, keys, exhausted, provincePages, officialImages, denylist, prior, { primaryOnly });
      } catch (error) {
        return { ...prior, id: target.attraction.id, name: target.attraction.name, province: target.province,
          status: 'pending_sources', qualified: prior?.qualified || [], qualifiedCount: prior?.qualifiedCount || 0,
          error: error.message };
      }
    }));
    for (const result of results) {
      const position = state.items.findIndex(item => item.id === result.id);
      if (position >= 0) state.items[position] = result;
      else state.items.push(result);
      console.log(`[本轮 ${index + results.indexOf(result) + 1}/${remaining.length}] ${result.province}·${result.name}: ${result.qualifiedCount} 张 ${result.status === 'ready_for_visual_review' ? '待视觉复核' : '待补来源'}`);
    }
    state.updatedAt = new Date().toISOString();
    state.cohortSize = state.cohortIds.length;
    state.runMode = primaryOnly ? 'primary-only' : 'full';
    state.exhaustedKeySlots = [...exhausted].map(value => value + 1);
    writeJson(statePath, state);
    // Amap exhaustion does not prevent official/OTA candidates from completing.
  }
  state.updatedAt = new Date().toISOString();
  state.cohortSize = state.cohortIds.length;
  state.runMode = primaryOnly ? 'primary-only' : 'full';
  writeJson(statePath, state);
  const ready = state.items.filter(item => ['ready_for_visual_review', 'ready_for_user_review'].includes(item.status)).length;
  const pending = state.items.filter(item => item.status === 'pending_sources').length;
  const excluded = state.items.filter(item => item.status === 'excluded_non_attraction').length;
  console.log(`图库采集完成：${state.items.length} 个，${ready} 个达到${MIN_IMAGES}-${MAX_IMAGES}张基础门槛，${pending} 个保持待补，${excluded} 个非景点已排除。`);
  console.log(`状态文件：${path.relative(root, statePath)}`);
}

main().catch(error => {
  console.error(`全国图库批处理失败：${error.message}`);
  process.exitCode = 1;
});
