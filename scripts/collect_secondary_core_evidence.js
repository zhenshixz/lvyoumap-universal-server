const fs = require('fs');
const path = require('path');
const {
  citiesCompatible,
  cityFromAddress,
  normalizeCity,
  normalizeName,
  relatedAttraction,
  sameAttraction,
  temporaryEventReason,
} = require('./core_candidate_quality');
const { isAmapAttractionPoi, sameRatingIdentity } = require('./core_rating_evidence');

const rootDir = path.join(__dirname, '..');
const runtimeDir = path.join(rootDir, '.runtime');
const args = new Map(process.argv.slice(2).map(arg => {
  const match = arg.match(/^--([^=]+)=(.*)$/);
  return match ? [match[1], match[2]] : [arg.replace(/^--/, ''), true];
}));
const provinceName = String(args.get('province') || '');
const maxPages = Math.max(1, Math.min(15, Number(args.get('max-pages') || 10)));

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

function readJson(filePath, fallback = {}) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\r\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function isRecentIso(value, days = 30) {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) && Date.now() - time < days * 24 * 60 * 60 * 1000;
}

function reusableEvidence(evidence) {
  if (!evidence?.source) return false;
  if (evidence.source === 'amap_live_web_service') return Boolean(evidence.type && isAmapAttractionPoi(evidence));
  return ['ctrip_city_sightlist', 'dianping_public_listing', 'official_attraction_site', 'amap_secondary_match'].includes(evidence.source);
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/<[^>]+>/g, '')
    .trim();
}

async function fetchText(url) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0 ChinaTourismMapDataMaintenance/1.0' },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 800));
    }
  }
  throw new Error(`${lastError?.message || '请求失败'}：${url}`);
}

function compactEvidenceName(value, city = '') {
  let name = normalizeName(value);
  const normalizedCity = normalizeCity(city);
  if (normalizedCity && name.startsWith(normalizedCity) && name.length > normalizedCity.length + 2) {
    name = name.slice(normalizedCity.length);
  }
  const provincePrefix = normalizeName(provinceName);
  if (provincePrefix && name.includes(provincePrefix) && name.length > provincePrefix.length + 2) {
    name = name.replace(provincePrefix, '');
  }
  return name
    .replace(/(?:国际|文化|生态)/g, '')
    .replace(/(?:古镇|古城|建筑群|景点群|群)$/g, '')
    .trim();
}

function evidenceNameMatch(left, right, city = '') {
  if (relatedAttraction(left, right, city, city)) return true;
  const a = compactEvidenceName(left, city);
  const b = compactEvidenceName(right, city);
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  return shorter.length >= 4 && longer.includes(shorter) && longer.length - shorter.length <= 4;
}

function uniqueLocalMatch(candidate, records) {
  const matches = records.filter(record => (
    citiesCompatible(candidate.city, record.city)
    && evidenceNameMatch(candidate.name, record.name, candidate.city || record.city)
  ));
  const exact = matches.filter(record => (
    compactEvidenceName(candidate.name, candidate.city || record.city)
    === compactEvidenceName(record.name, candidate.city || record.city)
  ));
  if (exact.length === 1) {
    const match = exact[0];
    return { match: { id: match.id, name: match.name, city: match.city }, ambiguous: false, candidates: [] };
  }
  if (matches.length !== 1) {
    return {
      match: null,
      ambiguous: matches.length > 1,
      candidates: matches.map(item => ({ id: item.id, name: item.name, city: item.city })),
    };
  }
  const match = matches[0];
  return { match: { id: match.id, name: match.name, city: match.city }, ambiguous: false, candidates: [] };
}

function findCoveredCore(candidate, coreAttractions) {
  return coreAttractions.find(item => (
    citiesCompatible(candidate.city, item.city)
    && (
      relatedAttraction(candidate.name, item.name, candidate.city, item.city)
      || (item.aliases || []).some(alias => relatedAttraction(candidate.name, alias, candidate.city, item.city))
      || (item.aliases || []).some(alias => {
        const parent = normalizeName(alias);
        const child = normalizeName(candidate.name);
        const remainder = child.startsWith(parent) ? child.slice(parent.length) : '';
        return parent.length >= 3 && /^(?:嬉水|水上|主题|儿童|森林|冰雪)?(?:乐园|公园|景区|游乐园)$/.test(remainder);
      })
    )
  ));
}

function inferCandidateCity(candidate, officialCandidates, records) {
  if (candidate.city) return normalizeCity(candidate.city);
  const official = [...(officialCandidates.fiveA || []), ...(officialCandidates.resorts || [])]
    .find(item => evidenceNameMatch(item.name, candidate.name));
  if (official?.address) return cityFromAddress(official.address, records.map(item => item.city));
  const local = uniqueLocalMatch(candidate, records).match;
  return normalizeCity(local?.city || '');
}

function parseCtripPage(html) {
  const output = [];
  const regex = /<div class="titleModule_name__[^"]+"><span><a href="([^"]+)"[^>]*>([^<]+)<\/a>/g;
  for (const match of html.matchAll(regex)) {
    const name = decodeHtml(match[2]);
    if (!name || temporaryEventReason(name) || output.some(item => item.name === name)) continue;
    output.push({ name, url: decodeHtml(match[1]) });
  }
  return output;
}

function discoverCitySlug(html, city) {
  const escaped = city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`https?:\\/\\/you\\.ctrip\\.com\\/place\\/([^"?]+)\\.html[^>]*>${escaped}旅游攻略<\\/a>`, 'i');
  return html.match(pattern)?.[1] || '';
}

async function collectCtripEvidence(candidates, provincePageUrl) {
  if (!candidates.length || !provincePageUrl) return { matches: new Map(), warnings: [] };
  const matches = new Map();
  const warnings = [];
  let provinceHtml = '';
  try {
    provinceHtml = await fetchText(provincePageUrl);
  } catch (error) {
    warnings.push(`携程省级页读取失败：${error.message}`);
    return { matches, warnings };
  }
  const byCity = new Map();
  for (const candidate of candidates.filter(item => item.city)) {
    if (!byCity.has(candidate.city)) byCity.set(candidate.city, []);
    byCity.get(candidate.city).push(candidate);
  }
  for (const [city, cityCandidates] of byCity) {
    const slug = discoverCitySlug(provinceHtml, city);
    if (!slug) {
      warnings.push(`携程省级页未发现 ${city} 的城市入口。`);
      continue;
    }
    const unresolved = new Set(cityCandidates.map(item => item.name));
    for (let page = 1; page <= maxPages && unresolved.size; page += 1) {
      const url = `https://you.ctrip.com/sight/${slug}/s0-p${page}.html`;
      let html = '';
      try {
        html = await fetchText(url);
      } catch (error) {
        warnings.push(`${city}携程第${page}页读取失败：${error.message}`);
        break;
      }
      const pageItems = parseCtripPage(html);
      for (const targetName of [...unresolved]) {
        const candidate = cityCandidates.find(item => item.name === targetName);
        const hit = pageItems.find(item => evidenceNameMatch(candidate.name, item.name, city));
        if (!hit) continue;
        matches.set(candidate.name, { source: 'ctrip_city_sightlist', city, page, name: hit.name, url: hit.url });
        unresolved.delete(candidate.name);
      }
      if (!pageItems.length) break;
    }
  }
  return { matches, warnings };
}

async function collectLiveAmapEvidence(candidates) {
  const matches = new Map();
  const warnings = [];
  if (!amapWebServiceKey) return { matches, warnings, enabled: false };
  for (const candidate of candidates) {
    try {
      const url = new URL('https://restapi.amap.com/v5/place/text');
      url.searchParams.set('key', amapWebServiceKey);
      url.searchParams.set('keywords', candidate.name);
      url.searchParams.set('region', candidate.city || provinceName);
      url.searchParams.set('city_limit', 'true');
      url.searchParams.set('show_fields', 'business');
      url.searchParams.set('page_size', '10');
      url.searchParams.set('output', 'json');
      const response = await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0 ChinaTourismMapDataMaintenance/1.0' },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (String(data.status) !== '1') throw new Error(data.info || data.infocode || '接口返回失败');
      const pois = (data.pois || []).map(poi => ({
        ...poi,
        city: Array.isArray(poi.cityname) ? poi.cityname[0] : (poi.cityname || poi.pname || candidate.city || provinceName),
      }));
      const unique = [...new Map(pois
        .filter(poi => (
          isAmapAttractionPoi(poi)
          && sameRatingIdentity({ ...candidate, city: candidate.city || provinceName }, poi)
        ))
        .map(poi => [poi.id, poi])).values()];
      if (unique.length !== 1) continue;
      const poi = unique[0];
      matches.set(candidate.name, {
        source: 'amap_live_web_service',
        id: poi.id,
        name: poi.name,
        city: poi.city,
        type: poi.type,
        url: `https://www.amap.com/place/${encodeURIComponent(poi.id)}`,
        verifiedAt: new Date().toISOString().slice(0, 10),
      });
    } catch (error) {
      warnings.push(`${candidate.name} 高德实时补证失败：${error.message}`);
    }
  }
  return { matches, warnings, enabled: true };
}

async function main() {
  if (!provinceName) throw new Error('请使用 --province=省份。');
  const db = readJson(path.join(rootDir, 'content', 'db.json'), { provinces: {} });
  const province = db.provinces?.[provinceName];
  if (!province) throw new Error(`基础数据库中没有找到省份：${provinceName}`);
  const slug = province.id || provinceName;
  const draftPath = path.join(runtimeDir, `core-attractions.${slug}.draft.json`);
  const draft = readJson(draftPath, null);
  if (!draft) throw new Error('尚未生成首轮核心清单草稿，无法进行二次补证。');
  const officialCandidates = readJson(path.join(runtimeDir, `core-official-${slug}.json`), { fiveA: [], resorts: [] });
  const ota = readJson(path.join(runtimeDir, `core-ota-${slug}.json`), {});
  const records = province.attractions || [];
  const manualEvidence = readJson(path.join(rootDir, 'content', 'core-evidence-overrides.json'), { provinces: {} });
  const provinceEvidence = manualEvidence.provinces?.[provinceName] || [];
  const previousEvidence = readJson(path.join(runtimeDir, `core-secondary-evidence-${slug}.json`), null);
  const canReusePrevious = previousEvidence?.province === provinceName && isRecentIso(previousEvidence.collectedAt, 30);
  const candidates = (draft.reviewCandidates || []).map(item => ({
    ...item,
    city: inferCandidateCity(item, officialCandidates, records),
  }));
  const results = [];
  const needsCtrip = [];
  for (const candidate of candidates) {
    const evidences = [];
    const verifiedOverride = provinceEvidence.find(item => (
      citiesCompatible(candidate.city, item.city)
      && evidenceNameMatch(candidate.name, item.name, candidate.city || item.city)
      && /^https:\/\//.test(item.sourceUrl || '')
      && item.verifiedAt
    ));
    if (verifiedOverride) {
      if (!candidate.city && verifiedOverride.city) candidate.city = normalizeCity(verifiedOverride.city);
      evidences.push({
        source: verifiedOverride.source || 'official_attraction_site',
        name: verifiedOverride.name,
        city: verifiedOverride.city,
        title: verifiedOverride.sourceTitle,
        url: verifiedOverride.sourceUrl,
        relation: verifiedOverride.relation || '',
        verifiedAt: verifiedOverride.verifiedAt,
      });
    }
    const covered = findCoveredCore(candidate, draft.attractions || []);
    if (covered) {
      results.push({ ...candidate, status: 'covered_by_core', coveredBy: { key: covered.key, name: covered.name, city: covered.city }, evidences });
      continue;
    }
    if (candidate.sources.includes('official_national_resort')) {
      evidences.push({ source: 'mct_official_identity', name: candidate.name, city: candidate.city });
    }
    const local = uniqueLocalMatch(candidate, records);
    if (local.match) evidences.push({ source: 'amap_secondary_match', ...local.match });
    if (!local.match && local.ambiguous) {
      evidences.push({ source: 'amap_ambiguous', candidates: local.candidates });
    }
    const independent = new Set([
      ...(candidate.sources || []),
      ...evidences.filter(item => item.source !== 'amap_ambiguous').map(item => item.source),
    ]);
    const authoritative = candidate.sources.includes('official_national_resort');
    const result = { ...candidate, status: authoritative || independent.size >= 2 ? 'verified' : 'unresolved', evidences };
    results.push(result);
    if (result.status === 'unresolved') needsCtrip.push(result);
  }
  const ctrip = await collectCtripEvidence(needsCtrip, ota.sourceUrl || '');
  for (const result of results.filter(item => item.status === 'unresolved')) {
    const hit = ctrip.matches.get(result.name);
    if (!hit) continue;
    result.evidences.push(hit);
    result.status = 'verified';
  }
  const stillUnresolved = results.filter(item => item.status === 'unresolved');
  const liveAmap = await collectLiveAmapEvidence(stillUnresolved);
  for (const result of stillUnresolved) {
    const hit = liveAmap.matches.get(result.name);
    if (!hit) continue;
    result.evidences.push(hit);
    result.status = 'verified';
  }
  const unresolved = results.filter(item => item.status === 'unresolved');
  if (canReusePrevious) {
    for (const result of unresolved) {
      const previous = (previousEvidence.results || []).find(item => (
        item.status === 'verified'
        && relatedAttraction(result.name, item.name, result.city, item.city)
      ));
      const evidences = (previous?.evidences || []).filter(reusableEvidence);
      if (!evidences.length) continue;
      result.evidences.push(...evidences);
      result.status = 'verified';
      result.reusedFromVerifiedCache = true;
    }
  }
  const finalUnresolved = results.filter(item => item.status === 'unresolved');
  const output = {
    province: provinceName,
    collectedAt: new Date().toISOString(),
    policy: '首轮单源候选使用官方身份、城市级携程分页和高德本地POI进行定向补证；组合景区、括号别名与品牌度假区名称会归并。仍只有单源的候选进入观察池，不直接纳入。',
    sourceAvailability: {
      mctOfficial: true,
      amapLocalSnapshot: true,
      amapLiveWebService: liveAmap.enabled,
      ctripCityPages: Boolean(ota.sourceUrl),
      curatedOfficialPages: Boolean(provinceEvidence.length),
      dianping: false,
      dianpingNote: '大众点评无稳定公开检索接口，暂不作为无人值守硬依赖；未获取到可核验页面时不得计分。',
    },
    candidateCount: candidates.length,
    verifiedCount: results.filter(item => item.status === 'verified').length,
    coveredByCoreCount: results.filter(item => item.status === 'covered_by_core').length,
    reusedVerifiedCount: results.filter(item => item.reusedFromVerifiedCache).length,
    unresolvedCount: finalUnresolved.length,
    unresolvedNames: finalUnresolved.map(item => item.name),
    warnings: [...ctrip.warnings, ...liveAmap.warnings],
    results,
  };
  const outputPath = path.join(runtimeDir, `core-secondary-evidence-${slug}.json`);
  writeJson(outputPath, output);
  console.log(`${provinceName}单源候选二次补证完成：确认 ${output.verifiedCount} 个，已被现有核心覆盖 ${output.coveredByCoreCount} 个，仍待人工 ${output.unresolvedCount} 个。`);
  if (output.unresolvedCount) console.log(`仍待人工：${output.unresolvedNames.join('、')}`);
  for (const warning of output.warnings) console.log(`[提示] ${warning}`);
  console.log(`证据文件：${outputPath}`);
}

main().catch(error => {
  console.error(`二次补证失败：${error.message}`);
  process.exitCode = 1;
});
