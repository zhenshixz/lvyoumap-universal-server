const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { normalizeName, relatedAttraction } = require('./core_candidate_quality');
const { applyRatingFallback, hasVerifiedRating, liveAmapRating, localAmapRating } = require('./core_rating_evidence');

const rootDir = path.join(__dirname, '..');
const contentDir = path.join(rootDir, 'content');
const runtimeDir = path.join(rootDir, '.runtime');
const args = new Map(process.argv.slice(2).map(arg => {
  const match = arg.match(/^--([^=]+)=(.*)$/);
  return match ? [match[1], match[2]] : [arg.replace(/^--/, ''), true];
}));
const province = String(args.get('province') || '').trim();
const useManualEvidence = !args.has('no-manual');
const refresh = args.has('refresh');
const refreshRatings = args.has('refresh-ratings');

function loadLocalEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^(?:"(.*)"|'(.*)')$/, '$1$2').trim();
  }
}

loadLocalEnv(path.join(rootDir, '.env'));
const amapWebServiceKey = String(process.env.AMAP_WEB_SERVICE_KEY || '').trim();

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\r\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

function windowsProxy() {
  if (process.env.MAINTENANCE_HTTPS_PROXY) return process.env.MAINTENANCE_HTTPS_PROXY;
  if (process.platform !== 'win32') return '';
  const result = spawnSync('reg.exe', [
    'query',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    '/v',
    'ProxyServer',
  ], { encoding: 'utf8', windowsHide: true });
  const match = String(result.stdout || '').match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i);
  if (!match) return '';
  const value = match[1].trim();
  const mapped = Object.fromEntries(value.split(';').map(part => part.split('=', 2)).filter(pair => pair.length === 2));
  const endpoint = mapped.https || mapped.http || value;
  return /^https?:\/\//i.test(endpoint) ? endpoint : `http://${endpoint}`;
}

function curlText(url, attempts = 3) {
  let lastError = '';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const curlArgs = [
      '--location', '--fail', '--silent', '--show-error', '--ssl-no-revoke',
      '--max-time', '45', '--retry', '2', '--retry-all-errors', '--retry-delay', '1',
      '--user-agent', 'Mozilla/5.0 ChinaTourismMapDataMaintenance/1.0',
    ];
    const proxy = windowsProxy();
    if (proxy) curlArgs.push('--proxy', proxy);
    curlArgs.push(url);
    const result = spawnSync(process.platform === 'win32' ? 'curl.exe' : 'curl', curlArgs, {
      encoding: 'utf8', windowsHide: true, maxBuffer: 80 * 1024 * 1024,
    });
    if (result.status === 0 && result.stdout) return result.stdout;
    lastError = String(result.stderr || result.stdout || `exit ${result.status}`).trim();
  }
  throw new Error(lastError || `无法读取 ${url}`);
}

function curlJson(url) {
  return JSON.parse(curlText(url));
}

function liveAmapPois(item) {
  if (!amapWebServiceKey) return { pois: [], mode: 'disabled' };
  const preferredId = String(item.preferredId || '').replace(/^amap_/i, '');
  const request = parameters => {
    const url = new URL(parameters.path);
    url.searchParams.set('key', amapWebServiceKey);
    url.searchParams.set('show_fields', 'business');
    url.searchParams.set('output', 'json');
    for (const [key, value] of Object.entries(parameters.query)) if (value) url.searchParams.set(key, value);
    const result = curlJson(url.toString());
    if (String(result.status) !== '1') throw new Error(`高德 Web 服务返回 ${result.infocode || result.info || 'unknown'}`);
    return result.pois || [];
  };
  if (preferredId) {
    const pois = request({ path: 'https://restapi.amap.com/v5/place/detail', query: { id: preferredId } });
    if (pois.length) return { pois, mode: 'preferred-poi-id' };
  }
  const pois = request({
    path: 'https://restapi.amap.com/v5/place/text',
    query: {
      keywords: item.name,
      region: item.city || province,
      city_limit: 'true',
      page_size: '10',
      page_num: '1',
    },
  });
  return { pois, mode: 'text-search' };
}

function resolveAmapRating(item, records) {
  let liveFailure = '';
  if (amapWebServiceKey) {
    try {
      const response = liveAmapPois(item);
      const evidence = liveAmapRating(item, response.pois);
      if (evidence.rating > 0) return { ...evidence, queryMode: response.mode };
      liveFailure = evidence.reason;
    } catch (error) {
      liveFailure = error.message;
    }
  }
  const local = localAmapRating(item, records);
  return liveFailure ? { ...local, liveFailure } : local;
}

function decodeJsonString(value) {
  try { return JSON.parse(`"${String(value || '').replace(/"/g, '\\"')}"`); } catch { return String(value || ''); }
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/\\u003c/gi, '<').replace(/\\u003e/gi, '>').replace(/\\u0026/gi, '&')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/\s+/g, ' ').trim();
}

function compactDescription(value, fallback) {
  const text = decodeHtml(value || fallback).replace(/(?:游玩路线|开放时间|优待政策).*$/s, '').trim();
  if (!text) return '';
  const sentences = text.split(/(?<=[。！？])/).filter(Boolean);
  return sentences.slice(0, 2).join('').slice(0, 220).trim();
}

function allAliases(item) {
  const values = [item.name, ...(item.aliases || [])];
  const compact = String(item.name || '')
    .replace(/(?:国家)?[345]A?级?(?:旅游)?(?:景区|旅游区|风景区|度假区)$/i, '')
    .replace(/国际休闲旅游度假区|国际旅游度假区|旅游度假区|文化旅游景区|旅游景区|风景名胜区|风景区|景区$/g, '')
    .trim();
  if (compact.length >= 3) values.push(compact);
  for (const part of String(item.name || '').split(/[—–-]|与|和|、|，|\//)) {
    const clean = part
      .replace(/^.*?[（(]([^）)]+)[）)]$/, '$1')
      .replace(/(?:国家)?[345]A?级?(?:旅游)?(?:景区|旅游区|风景区|度假区)$/i, '')
      .replace(/国际休闲旅游度假区|国际旅游度假区|旅游度假区|文化旅游景区|旅游景区|风景名胜区|风景区|景区$/g, '')
      .trim();
    if (clean.length >= 3) values.push(clean);
  }
  const known = [
    [/大运河/, ['北京大运河博物馆', '大运河博物馆']],
    [/水立方|国家游泳中心/, ['水立方', '国家游泳中心']],
    [/古北水镇/, ['古北水镇']],
    [/八达岭.*慕田峪/, ['八达岭长城', '慕田峪长城']],
  ];
  for (const [pattern, aliases] of known) if (pattern.test(item.name)) values.push(...aliases);
  return [...new Set(values.filter(Boolean))];
}

function sameIdentity(left, item) {
  const geographicPrefixes = ['北京', '上海', '天津', '重庆', '广州', '深圳', '珠海', '杭州', '南京', '成都', '西安', '武汉', '长沙', '厦门', '青岛', '苏州'];
  const explicitPrefix = geographicPrefixes.find(value => String(left || '').startsWith(value));
  if (explicitPrefix && item.city && !String(item.city).includes(explicitPrefix)) return false;
  const candidate = normalizeName(left);
  return allAliases(item).some(alias => {
    if (relatedAttraction(left, alias, item.city, item.city)) return true;
    const expected = normalizeName(alias);
    return Boolean(candidate && expected && (
      candidate === expected
      || (candidate.length >= 4 && expected.includes(candidate))
      || (expected.length >= 4 && candidate.includes(expected))
    ));
  });
}

function parseCtripHtml(html, item) {
  const matches = [...html.matchAll(/"poiName":"((?:\\.|[^"\\])*)"/g)];
  const matchedIndex = matches.findIndex(match => sameIdentity(decodeJsonString(match[1]), item));
  const matched = matches[matchedIndex];
  if (!matched) throw new Error(`携程详情身份不一致：${decodeJsonString(matches[0]?.[1] || '') || '未解析到名称'}`);
  const identity = decodeJsonString(matched[1]);
  // 只读取当前 poiName 到下一个 poiName 之间的结构化字段，避免把相关景点的评分串进来。
  const nextIndex = matches[matchedIndex + 1]?.index;
  const scopeEnd = Number.isInteger(nextIndex) ? nextIndex : Math.min(html.length, matched.index + 180000);
  const scope = html.slice(matched.index, scopeEnd);
  const get = pattern => decodeJsonString(scope.match(pattern)?.[1] || '');
  return {
    name: identity,
    city: get(/"districtName":"((?:\\.|[^"\\])*)"/),
    address: get(/"address":"((?:\\.|[^"\\])*)"/),
    intro: decodeHtml(get(/"introduction":"((?:\\.|[^"\\])*)"/)),
    rating: Number(scope.match(/"commentScore":"?([0-9.]+)"?/)?.[1] || 0),
    reviews: Number(scope.match(/"commentCount":"?([0-9]+)"?/)?.[1] || 0),
  };
}

function parseCtrip(url, item) {
  if (!/you\.ctrip\.com\/sight\//i.test(url || '')) return null;
  return {
    title: `携程旅行 ${item.name} 详情页`,
    url,
    ...parseCtripHtml(curlText(url), item),
  };
}

function matchingOfficial(item, official) {
  return [...(official.fiveA || []), ...(official.resorts || [])]
    .find(record => sameIdentity(record.name, item)) || null;
}

function matchingCtripUrl(item, ota, secondary) {
  const candidates = [
    ...(item.research?.discoveredSources || []).map(source => ({ name: item.name, url: source.url })),
    ...(ota.candidates || []),
    ...(secondary.results || []).flatMap(result => (result.evidences || []).map(evidence => ({ name: result.name, url: evidence.url }))),
  ];
  const matched = candidates.find(candidate => /you\.ctrip\.com\/sight\//i.test(candidate.url || '') && sameIdentity(candidate.name, item));
  if (matched) return matched.url;
  return (item.research?.discoveredSources || []).find(source => /you\.ctrip\.com\/sight\//i.test(source.url || ''))?.url || '';
}

function wikidataLabels(entity) {
  return [
    ...Object.values(entity.labels || {}).map(value => value.value),
    ...Object.values(entity.aliases || {}).flatMap(values => values.map(value => value.value)),
  ].filter(Boolean);
}

function findWikidata(item) {
  const queries = allAliases(item);
  for (const query of queries) {
    const searchUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(query)}&language=zh&uselang=zh&format=json&limit=5&origin=*`;
    const search = curlJson(searchUrl);
    const hits = search.search || [];
    for (const hit of hits) {
      const hitNames = [hit.label, hit.match?.text, ...(hit.aliases || [])].filter(Boolean);
      if (!hitNames.some(name => sameIdentity(name, item) || normalizeName(name) === normalizeName(query))) continue;
      const entity = curlJson(`https://www.wikidata.org/wiki/Special:EntityData/${hit.id}.json`).entities?.[hit.id];
      if (!entity || !wikidataLabels(entity).some(name => sameIdentity(name, item) || normalizeName(name) === normalizeName(query))) continue;
      const description = Object.values(entity.descriptions || {}).map(value => value.value).join(' ');
      if (/日本|韩国|美国|英国|台湾|香港/.test(description) && !String(item.city || '').match(/香港|台湾/)) continue;
      const fileName = entity.claims?.P18?.[0]?.mainsnak?.datavalue?.value || '';
      const categoryName = entity.claims?.P373?.[0]?.mainsnak?.datavalue?.value || '';
      return { id: hit.id, entity, fileName, categoryName, query };
    }
  }
  return null;
}

function usableCommonsPage(page) {
  const info = page?.imageinfo?.[0];
  if (!info) return false;
  const meta = info.extmetadata || {};
  const license = decodeHtml(meta.LicenseShortName?.value || meta.UsageTerms?.value || '');
  return /(?:CC\s*BY|CC0|public domain|公有领域)/i.test(license)
    && Number(info.width || 0) >= 1200
    && Number(info.height || 0) >= 700;
}

function commonsPageScore(page, item) {
  const info = page.imageinfo[0];
  const ratio = Number(info.width || 0) / Math.max(1, Number(info.height || 0));
  const title = String(page.title || '').replace(/^File:/i, '');
  const nameScore = sameIdentity(title, item) ? 50 : 0;
  const landscapeScore = ratio >= 1.25 && ratio <= 2.6 ? 30 : ratio >= 1 ? 10 : 0;
  const resolutionScore = Math.min(20, Math.log10(Math.max(1, info.width * info.height)) * 2);
  return nameScore + landscapeScore + resolutionScore;
}

function commonsImage(fileName, item, categoryName = '') {
  let pages = [];
  if (fileName) {
    const url = `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(`File:${fileName}`)}&prop=imageinfo&iiprop=url%7Csize%7Cextmetadata&iiurlwidth=2000&format=json&origin=*`;
    pages = Object.values(curlJson(url).query?.pages || {}).filter(usableCommonsPage);
  }
  if (!pages.length && categoryName) {
    const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=categorymembers&gcmtitle=${encodeURIComponent(`Category:${categoryName}`)}&gcmtype=file&gcmlimit=50&prop=imageinfo&iiprop=url%7Csize%7Cextmetadata&iiurlwidth=2000&format=json&origin=*`;
    pages = Object.values(curlJson(url).query?.pages || {})
      .filter(usableCommonsPage)
      .sort((left, right) => commonsPageScore(right, item) - commonsPageScore(left, item));
  }
  if (!pages.length) {
    for (const query of allAliases(item)) {
      const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(`${query} filetype:bitmap`)}&gsrnamespace=6&gsrlimit=8&prop=imageinfo&iiprop=url%7Csize%7Cextmetadata&iiurlwidth=2000&format=json&origin=*`;
      const found = Object.values(curlJson(url).query?.pages || {}).filter(usableCommonsPage);
      const exact = found.find(page => sameIdentity(String(page.title || '').replace(/^File:/i, ''), item));
      if (exact) { pages = [exact]; break; }
    }
  }
  const page = pages[0];
  const info = page?.imageinfo?.[0];
  if (!page || !info) return null;
  const meta = info.extmetadata || {};
  const license = decodeHtml(meta.LicenseShortName?.value || meta.UsageTerms?.value || '');
  if (!/(?:CC\s*BY|CC0|public domain|公有领域)/i.test(license)) return null;
  const width = Number(info.width || 0);
  const height = Number(info.height || 0);
  const localName = `${String(item.id || item.baselineKey).replace(/^manual_/, '').replace(/[^a-z0-9_-]/gi, '_')}_verified.jpg`;
  return {
    localPath: `/assets/images/attractions/${localName}`,
    downloadUrl: info.thumburl || info.url,
    title: String(page.title || '').replace(/^File:/i, ''),
    author: decodeHtml(meta.Artist?.value || 'Wikimedia Commons contributor'),
    provider: 'Wikimedia Commons',
    license,
    licenseUrl: meta.LicenseUrl?.value || 'https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia',
    sourceUrl: info.descriptionurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title)}`,
    width,
    height,
  };
}

function inferProfile(name, intro) {
  const text = `${name} ${intro}`;
  if (/山|峰|峡谷|长城|森林|徒步/.test(text)) return 'mountain';
  if (/海|岛|沙滩|滨海/.test(text)) return 'coastal';
  if (/湖|运河|湿地|水乡/.test(text)) return 'lake';
  if (/乐园|度假区|影城|动物世界/.test(text)) return 'resort';
  if (/博物馆|纪念馆|美术馆|场馆|故居|教堂/.test(text)) return 'indoor';
  return 'urban';
}

function inferCategory(name, intro) {
  const text = `${name} ${intro}`;
  if (/博物馆|纪念馆|美术馆/.test(text)) return '博物馆';
  if (/乐园|影城|动物世界/.test(text)) return '主题乐园';
  if (/古镇|古城|街|胡同/.test(text)) return '历史街区';
  if (/长城|遗产/.test(text)) return '世界遗产';
  if (/山|峰|峡谷/.test(text)) return '自然风景';
  if (/湖|运河|湿地/.test(text)) return '滨水景区';
  if (/公园/.test(text)) return '城市公园';
  return '文化景区';
}

function levelFor(item, officialRecord) {
  if (officialRecord && String(officialRecord.type || '').toLowerCase() === 'f') return '5A景区';
  if (officialRecord) return '国家级旅游度假区';
  if (/博物馆/.test(item.name)) return '博物馆';
  return '热门景点';
}

function routesFromExperience(experience, source) {
  return (experience.routes || []).map(route => ({
    ...route,
    badge: route.badge || '少走回头路',
    suitability: route.suitability || '第一次到访、亲子与长辈同行',
    duration: route.duration || '半天',
    sourceTitle: source.title,
    sourceUrl: source.url,
  }));
}

function mergeManual(autoValue, manualValue) {
  if (!manualValue) return autoValue;
  const result = { ...autoValue, ...manualValue };
  result.image = { ...(autoValue.image || {}), ...(manualValue.image || {}) };
  return result;
}

function completeEvidence(value) {
  return Boolean(
    value
    && value.address
    && (value.description || value.intro)
    && value.sources?.length >= 2
    && value.routes?.length >= 2
    && value.image?.localPath
    && value.image?.downloadUrl
  );
}

function neutralizeUnverifiedRating(value) {
  if (hasVerifiedRating(value)) return value;
  const result = { ...value, rating: 0, reviewsCount: '暂无公开评价' };
  delete result.ratingSource;
  return result;
}

function refreshRatingEvidence(value, item, records, ctripUrl = '') {
  if (hasVerifiedRating(value)) {
    return {
      ...value,
      ratingAudit: { selected: value.ratingSource.platform || 'verified-existing', status: 'reused' },
    };
  }

  let ctrip = null;
  let ctripError = '';
  if (ctripUrl) {
    try { ctrip = parseCtrip(ctripUrl, item); } catch (error) { ctripError = error.message; }
  }
  const ctripEvidence = {
    rating: ctrip?.rating || 0,
    reviewsCount: ctrip?.reviews ? `${ctrip.reviews}条携程点评` : '暂无公开评价',
    ratingSource: ctrip?.rating > 0 ? {
      platform: '携程',
      title: ctrip.title,
      url: ctrip.url,
      verifiedAt: new Date().toISOString().slice(0, 10),
    } : undefined,
  };
  const amapEvidence = resolveAmapRating(item, records);
  const selected = applyRatingFallback(ctripEvidence, amapEvidence);
  const clean = hasVerifiedRating(selected)
    ? { ...value, ...selected }
    : neutralizeUnverifiedRating(value);
  clean.ratingAudit = {
    selected: clean.ratingSource?.platform || 'none',
    ctrip: ctripError ? { status: 'failed', reason: ctripError } : (ctrip?.rating > 0 ? { status: 'matched' } : { status: 'not-found' }),
    amap: amapEvidence.rating > 0
      ? { status: 'matched', rating: amapEvidence.rating, poiId: amapEvidence.ratingSource.poiId, mode: amapEvidence.ratingSource.evidenceMode }
      : { status: 'not-used', reason: amapEvidence.reason, liveFailure: amapEvidence.liveFailure, candidates: amapEvidence.candidates || [] },
  };
  return clean;
}

function main() {
  if (!province) throw new Error('请使用 --province=省份。');
  const db = readJson(path.join(contentDir, 'db.json'), { provinces: {} });
  const provinceData = db.provinces?.[province];
  if (!provinceData) throw new Error(`无法识别省份：${province}`);
  const slug = provinceData.id || provinceData.slug;
  const workspace = readJson(path.join(runtimeDir, `core-repair-research.${slug}.json`), {});
  if (!workspace.attractions?.length) throw new Error('缺少景点资料研究工作区。');
  const official = readJson(path.join(runtimeDir, `core-official-${slug}.json`), {});
  const ota = readJson(path.join(runtimeDir, `core-ota-${slug}.json`), {});
  const secondary = readJson(path.join(runtimeDir, `core-secondary-evidence-${slug}.json`), {});
  const experiences = readJson(path.join(runtimeDir, `core-experience-evidence.${slug}.json`), { attractions: {} });
  const manual = useManualEvidence
    ? readJson(path.join(contentDir, `core-repair-evidence.${slug}.json`), { attractions: {} })
    : { attractions: {} };
  const outputPath = path.join(runtimeDir, `core-repair-evidence.${slug}.auto.json`);
  const output = readJson(outputPath, { province, version: 1, attractions: {}, failures: {} });
  const records = provinceData.attractions || [];
  output.province = province;
  output.version = 1;
  output.attractions ||= {};
  output.failures ||= {};
  for (let index = 0; index < workspace.attractions.length; index += 1) {
    const item = workspace.attractions[index];
    const preferredRecord = item.preferredId
      ? records.find(record => record.id === item.preferredId)
      : null;
    const ratingRecords = preferredRecord ? [preferredRecord] : records;
    const manualValue = manual.attractions?.[item.baselineKey] || manual.attractions?.[item.name];
    if (manualValue?.sources?.length >= 2 && manualValue?.routes?.length >= 2 && manualValue?.image?.downloadUrl) {
      let merged = mergeManual(output.attractions[item.baselineKey] || {}, manualValue);
      if (refreshRatings) {
        merged = refreshRatingEvidence(merged, item, ratingRecords, matchingCtripUrl(item, ota, secondary));
      }
      output.attractions[item.baselineKey] = merged;
      delete output.failures[item.baselineKey];
      writeJsonAtomic(outputPath, output);
      console.log(`[${index + 1}/${workspace.attractions.length}] ${item.name}：复用已核验覆盖资料${refreshRatings ? `，评分来源=${merged.ratingSource?.platform || '暂无可靠评分'}` : ''}。`);
      continue;
    }
    if (!refresh && completeEvidence(output.attractions[item.baselineKey])) {
      if (refreshRatings) {
        output.attractions[item.baselineKey] = refreshRatingEvidence(
          output.attractions[item.baselineKey],
          item,
          ratingRecords,
          matchingCtripUrl(item, ota, secondary),
        );
        writeJsonAtomic(outputPath, output);
      }
      delete output.failures[item.baselineKey];
      console.log(`[${index + 1}/${workspace.attractions.length}] ${item.name}：断点资料完整${refreshRatings ? `，评分来源=${output.attractions[item.baselineKey].ratingSource?.platform || '暂无可靠评分'}` : '，跳过重复联网'}。`);
      continue;
    }
    try {
      const officialRecord = matchingOfficial(item, official);
      const ctripUrl = matchingCtripUrl(item, ota, secondary);
      const ctrip = ctripUrl ? parseCtrip(ctripUrl, item) : null;
      const wikidata = findWikidata(item);
      const image = commonsImage(wikidata?.fileName || '', item, wikidata?.categoryName || '');
      const experience = experiences.attractions?.[item.baselineKey];
      const sources = [];
      const pushSource = source => {
        if (!source?.url || sources.some(value => value.url === source.url)) return;
        sources.push(source);
      };
      if (officialRecord && official.sourceUrl) pushSource({ title: official.source || '文化和旅游部大众旅游服务', url: official.sourceUrl });
      if (ctrip) pushSource({ title: ctrip.title, url: ctrip.url });
      if (wikidata) pushSource({ title: `Wikidata ${wikidata.id} 实体页`, url: `https://www.wikidata.org/wiki/${wikidata.id}` });
      const routeSource = ctrip ? { title: ctrip.title, url: ctrip.url } : sources[0];
      const address = ctrip?.address || officialRecord?.address || item.address;
      const verifiedLevel = levelFor(item, officialRecord);
      const conservativeIntro = address
        ? `${item.name}位于${address}，是已通过名称、属地和来源交叉核验的${verifiedLevel}。具体开放范围、预约和交通安排以景区官方当日公告为准。`
        : `${item.name}是${item.city || province}的${verifiedLevel}，具体开放范围、预约和交通安排以景区官方当日公告为准。`;
      const intro = ctrip?.intro || officialRecord?.introduce || item.intro || conservativeIntro;
      const blockers = [];
      if (sources.length < 2) blockers.push('独立可追溯来源少于2个');
      if (!intro || !address) blockers.push('基本介绍或地址缺失');
      if (!experience?.routes?.length || experience.routes.length < 2) blockers.push('结构化路线尚未采集');
      if (!image) blockers.push('尚未找到实体匹配且许可明确的高清图');
      if (blockers.length) throw new Error(blockers.join('；'));
      const profile = inferProfile(item.name, intro);
      const category = experience.category || inferCategory(item.name, intro);
      const ctripEvidence = {
        city: ctrip?.city || item.city || province,
        rating: ctrip?.rating || 0,
        reviewsCount: ctrip?.reviews ? `${ctrip.reviews}条携程点评` : '暂无公开评价',
        ratingSource: ctrip?.rating > 0 ? {
          platform: '携程',
          title: ctrip.title,
          url: ctrip.url,
          verifiedAt: new Date().toISOString().slice(0, 10),
        } : undefined,
      };
      const amapEvidence = resolveAmapRating(item, ratingRecords);
      output.attractions[item.baselineKey] = {
        ...applyRatingFallback(ctripEvidence, amapEvidence),
        description: compactDescription(intro, item.intro),
        intro: compactDescription(intro, item.intro),
        level: verifiedLevel,
        category,
        tags: [...new Set([category, profile === 'indoor' ? '室内参观' : '经典景点', officialRecord ? '官方名录' : '口碑热门'])],
        address,
        profile,
        externalArrive: experience.externalArrive,
        internalArrive: experience.internalArrive,
        internalTraffic: experience.internalTraffic,
        housingArea: experience.housingArea,
        specialCare: experience.specialCare,
        routes: routesFromExperience(experience, routeSource),
        sources,
        image,
        verifiedAt: new Date().toISOString().slice(0, 10),
      };
      output.attractions[item.baselineKey].ratingAudit = {
        selected: output.attractions[item.baselineKey].ratingSource?.platform || 'none',
        amap: amapEvidence.rating > 0
          ? { status: 'matched', rating: amapEvidence.rating, poiId: amapEvidence.ratingSource.poiId, mode: amapEvidence.ratingSource.evidenceMode }
          : { status: 'not-used', reason: amapEvidence.reason, liveFailure: amapEvidence.liveFailure, candidates: amapEvidence.candidates || [] },
      };
      delete output.failures[item.baselineKey];
      console.log(`[${index + 1}/${workspace.attractions.length}] ${item.name}：基本资料、路线和授权图片已闭环。`);
    } catch (error) {
      output.failures[item.baselineKey] = { name: item.name, message: error.message, updatedAt: new Date().toISOString() };
      console.log(`[${index + 1}/${workspace.attractions.length}] ${item.name}：待续跑（${error.message}）。`);
    }
    output.updatedAt = new Date().toISOString();
    writeJsonAtomic(outputPath, output);
  }
  output.ready = workspace.attractions.filter(item => output.attractions[item.baselineKey]?.sources?.length >= 2).length;
  output.total = workspace.attractions.length;
  output.updatedAt = new Date().toISOString();
  writeJsonAtomic(outputPath, output);
  console.log(`${province}可核验完整资料：${output.ready}/${output.total}。断点文件：${path.relative(rootDir, outputPath)}`);
  if (output.ready !== output.total) process.exitCode = 2;
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(`全国通用资料补全失败：${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { allAliases, completeEvidence, parseCtripHtml, sameIdentity };
