const SOURCE_PLAN_VERSION = 1;

const SOURCE_DEFINITIONS = Object.freeze({
  local: { rank: 65, label: '现有已核对图片', provider: '景区官方' },
  official_site: { rank: 60, label: '景区官网精确图片区段', provider: '景区官方' },
  mct_official: { rank: 55, label: '文旅部名录', provider: '景区官方' },
  amap_exact: { rank: 50, label: '高德精确POI', provider: '高德地图' },
  trip_exact: { rank: 48, label: 'Trip精确POI图库', provider: '景区公开资料' },
  amap_subspot: { rank: 45, label: '高德精确子景点', provider: '高德地图' },
  curated_subspot: { rank: 42, label: '已核对子景点图片', provider: '高德地图' },
  ctrip_exact: { rank: 40, label: '携程实体绑定相册', provider: '景区公开资料' },
  wikimedia_exact: { rank: 35, label: '百科精确实体', provider: '公开百科' },
});

const SOURCE_ORDER = Object.freeze([
  'local', 'official_site', 'mct_official', 'amap_exact', 'trip_exact',
  'amap_subspot', 'curated_subspot', 'ctrip_exact', 'wikimedia_exact',
]);

const DISCOVERY_LIMITS = Object.freeze({
  ctripCityPages: 10,
  ctripPageConcurrency: 5,
  wikimediaNames: 2,
});

const STABLE_IMAGE_HOST = /^(?:store\.is\.autonavi\.com|aos-cdn-image\.amap\.com|lyfw\.mct\.gov\.cn|upload\.wikimedia\.org|commons\.wikimedia\.org|(?:dimg\d+|youimg\d+)\.c-ctrip\.com|(?:[a-z0-9-]+\.)+tripcdn\.com)$/i;

function sourceRank(source) {
  return SOURCE_DEFINITIONS[source]?.rank || 0;
}

function publicProvider(candidate) {
  return SOURCE_DEFINITIONS[candidate?.source]?.provider || '公开资料';
}

function sourceOrderLabels() {
  return SOURCE_ORDER.map(source => SOURCE_DEFINITIONS[source].label);
}

function isStableGalleryUrl(value, trustedOfficialHosts = new Set()) {
  const url = String(value || '').trim();
  if (/_AIGC\//i.test(url) || /aos-comment\.amap\.com\//i.test(url) || /\/sns\/ugccomment\//i.test(url)) return false;
  if (url.startsWith('/')) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      && (trustedOfficialHosts.has(parsed.hostname.toLowerCase()) || STABLE_IMAGE_HOST.test(parsed.hostname));
  } catch {
    return false;
  }
}

function shouldProcessGalleryItem(prior, options = {}) {
  if (!prior) return true;
  if (options.hasDeniedSelection) return true;
  if (!options.repairPending || prior.status !== 'pending_sources') return false;
  return prior.secondaryComplete !== true
    || prior.sourcePlanVersion !== SOURCE_PLAN_VERSION
    || options.retryUnresolved === true;
}

function summarizeSourceAttempts(attempts = []) {
  const summary = {};
  for (const attempt of attempts) {
    const source = String(attempt.source || 'unknown').replace(/^ctrip$/, 'ctrip_exact');
    const current = summary[source] || { found: 0, empty: 0, retryableErrors: 0 };
    if (attempt.result === 'found') current.found += Number(attempt.count) || 1;
    else if (attempt.result === 'retryable_error') current.retryableErrors += 1;
    else current.empty += 1;
    summary[source] = current;
  }
  return summary;
}

module.exports = {
  SOURCE_PLAN_VERSION,
  SOURCE_DEFINITIONS,
  SOURCE_ORDER,
  DISCOVERY_LIMITS,
  sourceRank,
  publicProvider,
  sourceOrderLabels,
  isStableGalleryUrl,
  shouldProcessGalleryItem,
  summarizeSourceAttempts,
};
