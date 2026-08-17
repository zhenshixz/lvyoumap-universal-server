const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const contentDir = path.join(rootDir, 'content');
const reportDir = path.join(rootDir, 'reports');
const dbPath = path.join(contentDir, 'db.json');

function readJson(filePath, fallback = {}) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function argValue(name) {
  const prefix = `--${name}=`;
  const argument = process.argv.find(item => item.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : '';
}

function readManualLayers() {
  const merged = {};
  for (const name of fs.readdirSync(contentDir).filter(item => /^manual-attractions(?:\.[a-z0-9_-]+)?\.json$/i.test(item)).sort()) {
    const layer = readJson(path.join(contentDir, name));
    for (const [provinceName, additions] of Object.entries(layer || {})) {
      merged[provinceName] = [...(merged[provinceName] || []), ...(additions || [])];
    }
  }
  return merged;
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[·•（）()\-—_\s]/g, '')
    .replace(/国家[345]a级旅游景区/g, '')
    .replace(/国家级|国家重点|国家/g, '')
    .replace(/旅游风景名胜区|旅游景区|旅游风景区|风景名胜区|风景旅游区|风景区|旅游区|景区$/g, '')
    .trim();
}

function deepMerge(target, patch) {
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      target[key] = deepMerge(target[key] && typeof target[key] === 'object' && !Array.isArray(target[key]) ? target[key] : {}, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function buildRecords(db, manual, provinceName, attractionOverrides, lazyOverrides) {
  const recordsById = new Map();
  for (const item of db.provinces?.[provinceName]?.attractions || []) {
    recordsById.set(item.id, { ...item, dataLayer: 'db' });
  }
  for (const item of manual?.[provinceName] || []) {
    if (!recordsById.has(item.id)) recordsById.set(item.id, { ...item, dataLayer: 'manual' });
  }
  return [...recordsById.values()].map(record => (
    deepMerge(deepMerge(record, attractionOverrides[record.id] || {}), lazyOverrides[record.id] || {})
  ));
}

function getQuality(record) {
  const guide = record.guide_data || {};
  const basicChecks = {
    image: Boolean(String(record.image || '').trim()),
    description: Boolean(String(record.description || '').trim()),
    intro: Boolean(String(record.intro || '').trim()),
    price: Boolean(String(record.price || '').trim()),
  };
  const guideChecks = {
    clothing: Boolean(guide.clothing && typeof guide.clothing === 'object'),
    transport: Boolean(guide.transport && typeof guide.transport === 'object'),
    housing: Array.isArray(guide.housing) && guide.housing.length > 0,
    food: Array.isArray(guide.food) && guide.food.length >= 3,
    specialCare: Boolean(guide.special_care && typeof guide.special_care === 'object'),
  };
  const lazyText = String(record.lazy_ai_text || '').trim();
  const lazyChecks = {
    article: lazyText.length >= 180,
    routeSignals: /(路线|游览顺序|省力|观光车|索道|接驳|步行)/.test(lazyText),
    traceableSource: Boolean(record.lazy_ai_source?.source && record.lazy_ai_source?.prompt && record.lazy_ai_source?.updatedAt),
  };
  const basicSources = record.source_evidence?.basicInfoSources;
  const sourceCount = Array.isArray(basicSources) ? basicSources.length : 0;
  const reviewedSingleSource = record.dataLayer === 'manual'
    && sourceCount === 1
    && record.quality_status?.reviewRequired === true;
  const sourceComplete = record.dataLayer !== 'manual' || sourceCount >= 2 || reviewedSingleSource;
  const imageSourceComplete = Boolean(record.image_source?.sourceUrl && record.image_source?.license);
  const imageResolvable = /^https?:\/\//i.test(String(record.image || ''))
    || (String(record.image || '').startsWith('/') && fs.existsSync(path.join(rootDir, String(record.image).replace(/^\//, ''))));

  const basicComplete = Object.values(basicChecks).every(Boolean);
  const guideComplete = Object.values(guideChecks).every(Boolean);
  const lazyComplete = Object.values(lazyChecks).every(Boolean);
  const issues = [];
  for (const [key, value] of Object.entries(basicChecks)) if (!value) issues.push(`basic.${key}`);
  for (const [key, value] of Object.entries(guideChecks)) if (!value) issues.push(`guide.${key}`);
  for (const [key, value] of Object.entries(lazyChecks)) if (!value) issues.push(`lazy.${key}`);
  if (!sourceComplete) issues.push('source.basicInfo');
  else if (reviewedSingleSource) issues.push('source.basicInfoSingleSource');
  else if (sourceCount === 0) issues.push('source.basicInfoTraceability');
  if (!imageResolvable) issues.push('image.unresolvable');
  if (!imageSourceComplete) issues.push('image.sourceOrLicense');

  const identityScore = record.id && record.name && record.city ? 15 : 0;
  const basicScore = Math.round(Object.values(basicChecks).filter(Boolean).length / 4 * 20);
  const guideScore = Math.round(Object.values(guideChecks).filter(Boolean).length / 5 * 20);
  const lazyScore = (lazyChecks.article ? 8 : 0) + (lazyChecks.routeSignals ? 4 : 0) + (lazyChecks.traceableSource ? 8 : 0);
  const imageScore = (basicChecks.image ? 5 : 0) + (imageResolvable ? 5 : 0) + (imageSourceComplete ? 5 : 0);
  const sourceScore = sourceCount >= 2 ? 10 : (record.dataLayer === 'db' || sourceCount === 1 ? 5 : 0);
  const score = identityScore + basicScore + guideScore + lazyScore + imageScore + sourceScore;

  return {
    ready: basicComplete && guideComplete && lazyComplete && sourceComplete,
    score,
    band: score >= 90 && issues.length === 0 ? 'stable' : score >= 80 ? 'improve' : score >= 60 ? 'incomplete' : 'priority',
    basicComplete,
    guideComplete,
    lazyComplete,
    sourceComplete,
    imageResolvable,
    imageSourceComplete,
    lazySource: record.lazy_ai_source?.source || '',
    issues,
  };
}

function toMatchSummary(record) {
  return {
    id: record.id,
    name: record.name,
    city: record.city,
    dataLayer: record.dataLayer,
    quality: getQuality(record),
  };
}

function matchBaselineItem(item, records) {
  const aliases = [item.name, ...(item.aliases || [])];
  const normalizedAliases = new Set(aliases.map(normalizeName).filter(Boolean));
  const exact = records.filter(record => normalizedAliases.has(normalizeName(record.name)));
  const expectedCities = new Set(item.cities || (item.city ? [item.city] : []));
  const cityMatches = matches => !expectedCities.size || matches.some(record => expectedCities.has(record.city));

  if (item.preferredId) {
    const preferred = records.find(record => record.id === item.preferredId);
    // preferredId is written only after the isolated preview has been approved.
    // The record set is already scoped to one province, while `city` may use a
    // prefecture, county or district label.  Do not turn an approved identity
    // binding back into a review merely because those administrative levels
    // differ (for example 张家口 vs 蔚县).
    if (preferred) {
      return {
        status: 'present',
        reason: 'preferred_id',
        matches: [toMatchSummary(preferred)],
        alternatives: exact.filter(record => record.id !== item.preferredId).map(toMatchSummary),
      };
    }
  }

  if (exact.length === 1 && cityMatches(exact)) return { status: 'present', reason: 'exact_alias', matches: exact.map(toMatchSummary) };
  if (exact.length) {
    return {
      status: 'review',
      reason: cityMatches(exact) ? 'multiple_exact_matches' : 'city_mismatch',
      matches: exact.map(toMatchSummary),
    };
  }

  const possible = records.filter(record => {
    const recordName = normalizeName(record.name);
    if (recordName.length < 3) return false;
    return [...normalizedAliases].some(alias => alias.length >= 3 && (recordName.includes(alias) || alias.includes(recordName)));
  });
  if (possible.length) return { status: 'review', reason: 'fuzzy_name_match', matches: possible.map(toMatchSummary) };
  return { status: 'missing', reason: 'no_match', matches: [] };
}

function createProvinceReport(baselineFile, db, manual, attractionOverrides, lazyOverrides) {
  const baseline = readJson(baselineFile);
  const records = buildRecords(db, manual, baseline.province, attractionOverrides, lazyOverrides);
  const items = baseline.attractions.map(item => ({
    key: item.key,
    name: item.name,
    city: item.city || '',
    tier: item.tier,
    basis: item.basis || [],
    evidence: item.evidence || [],
    preferredId: item.preferredId || '',
    ...matchBaselineItem(item, records),
  }));
  const counts = items.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, { present: 0, review: 0, missing: 0 });
  const readyCount = items.filter(item => item.status === 'present' && item.matches.some(match => match.quality.ready)).length;
  const qualityBands = { stable: 0, improve: 0, incomplete: 0, priority: 0, missing: counts.missing, review: counts.review };
  const issueCounts = {};
  for (const item of items) {
    if (item.status !== 'present') continue;
    const best = [...item.matches].sort((a, b) => b.quality.score - a.quality.score)[0];
    qualityBands[best.quality.band] += 1;
    for (const issue of best.quality.issues) issueCounts[issue] = (issueCounts[issue] || 0) + 1;
  }
  const slug = path.basename(baselineFile).match(/^core-attractions\.(.+)\.json$/i)?.[1] || baseline.province;
  return {
    slug,
    report: {
      province: baseline.province,
      checkedAt: baseline.checkedAt,
      method: baseline.method,
      sourcePolicy: baseline.sourcePolicy || {},
      baselineCount: items.length,
      recordCount: records.length,
      counts,
      coverage: items.length ? Number((counts.present / items.length).toFixed(4)) : 0,
      readyCount,
      qualityBands,
      issueCounts,
      items,
    },
  };
}

function main() {
  const selectedProvince = argValue('province');
  const strict = process.argv.includes('--strict');
  const db = readJson(dbPath, { provinces: {} });
  const baselineFiles = fs.readdirSync(contentDir)
    .filter(name => /^core-attractions\.[a-z0-9_-]+\.json$/i.test(name))
    .map(name => path.join(contentDir, name))
    .filter(file => !selectedProvince || readJson(file).province === selectedProvince)
    .sort();
  fs.mkdirSync(reportDir, { recursive: true });
  if (!baselineFiles.length && selectedProvince) {
    const province = db.provinces?.[selectedProvince];
    if (!province) throw new Error(`基础数据库中没有找到省份：${selectedProvince}`);
    const slug = province.id || selectedProvince;
    const reportPath = path.join(reportDir, `core-attractions-${slug}.json`);
    const report = {
      province: selectedProvince,
      baselineStatus: 'missing',
      generatedAt: new Date().toISOString(),
      baselineCount: null,
      recordCount: (province.attractions || []).length,
      counts: null,
      coverage: null,
      readyCount: null,
      qualityBands: {},
      issueCounts: {},
      items: [],
      message: '该省尚未建立核心景点基线；可以继续检查和补全现有景点，但不能据此判断核心景点是否缺失。',
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\r\n`, 'utf8');
    console.log(`${selectedProvince}：尚未建立核心景点清单，已登记为待办；现有 ${report.recordCount} 条景点仍可继续检查。`);
    console.log(`提示：本次结果不能代表 ${selectedProvince} 的核心景点已经完整。`);
    if (strict) process.exitCode = 1;
    return;
  }
  if (!baselineFiles.length) throw new Error('没有找到核心景点清单。');

  const manual = readManualLayers();
  const attractionOverrides = readJson(path.join(contentDir, 'attraction-overrides.json'));
  const lazyOverrides = readJson(path.join(contentDir, 'lazy-guide-overrides.json'));

  const summaries = [];
  let strictFailed = false;
  for (const baselineFile of baselineFiles) {
    const { slug, report } = createProvinceReport(baselineFile, db, manual, attractionOverrides, lazyOverrides);
    const reportPath = path.join(reportDir, `core-attractions-${slug}.json`);
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\r\n`, 'utf8');
    summaries.push({
      province: report.province,
      baselineCount: report.baselineCount,
      counts: report.counts,
      readyCount: report.readyCount,
      qualityBands: report.qualityBands,
      report: path.relative(rootDir, reportPath),
    });
    console.log(`${report.province}: ${report.counts.present} present, ${report.counts.review} review, ${report.counts.missing} missing; ${report.readyCount}/${report.baselineCount} ready.`);
    if (report.counts.missing || report.counts.review || report.readyCount !== report.baselineCount) strictFailed = true;
  }

  const national = {
    generatedAt: new Date().toISOString(),
    provinceCount: summaries.length,
    baselineCount: summaries.reduce((sum, item) => sum + item.baselineCount, 0),
    present: summaries.reduce((sum, item) => sum + item.counts.present, 0),
    review: summaries.reduce((sum, item) => sum + item.counts.review, 0),
    missing: summaries.reduce((sum, item) => sum + item.counts.missing, 0),
    readyCount: summaries.reduce((sum, item) => sum + item.readyCount, 0),
    provinces: summaries,
  };
  if (!selectedProvince) {
    fs.writeFileSync(path.join(reportDir, 'core-attractions-national.json'), `${JSON.stringify(national, null, 2)}\r\n`, 'utf8');
    console.log(`National summary: ${national.present} present, ${national.review} review, ${national.missing} missing; ${national.readyCount}/${national.baselineCount} ready.`);
  }
  if (strict && strictFailed) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  getQuality,
  matchBaselineItem,
  normalizeName,
};
