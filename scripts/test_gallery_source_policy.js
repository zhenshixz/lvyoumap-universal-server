const assert = require('node:assert/strict');
const { SOURCE_PLAN_VERSION, DISCOVERY_LIMITS, sourceRank, publicProvider, sourceOrderLabels,
  isStableGalleryUrl, shouldProcessGalleryItem, summarizeSourceAttempts } = require('./gallery_source_policy');

assert(sourceRank('official_site') > sourceRank('amap_exact'));
assert.equal(publicProvider({ source: 'trip_exact' }), '景区公开资料');
assert.equal(publicProvider({ source: 'wikimedia_exact' }), '公开百科');
assert(sourceOrderLabels().includes('景区官网精确图片区段'));
assert.equal(DISCOVERY_LIMITS.ctripCityPages, 10);
assert.equal(DISCOVERY_LIMITS.ctripPageConcurrency, 5);
assert(isStableGalleryUrl('https://store.is.autonavi.com/showpic/example?type=7'));
assert(!isStableGalleryUrl('https://aos-comment.amap.com/example.jpg'));
assert(isStableGalleryUrl('https://official.example/gallery/a.jpg', new Set(['official.example'])));
assert(shouldProcessGalleryItem(null, { repairPending: true }));
assert(shouldProcessGalleryItem({ status: 'pending_sources', secondaryComplete: false }, { repairPending: true }));
assert(shouldProcessGalleryItem({ status: 'pending_sources', secondaryComplete: true }, { repairPending: true }));
assert(!shouldProcessGalleryItem({
  status: 'pending_sources', secondaryComplete: true, sourcePlanVersion: SOURCE_PLAN_VERSION,
}, { repairPending: true }));
assert(shouldProcessGalleryItem({
  status: 'pending_sources', secondaryComplete: true, sourcePlanVersion: SOURCE_PLAN_VERSION,
}, { repairPending: true, retryUnresolved: true }));
assert.deepEqual(summarizeSourceAttempts([
  { source: 'ctrip', result: 'found', count: 3 },
  { source: 'ctrip', result: 'retryable_error' },
]), { ctrip_exact: { found: 3, empty: 0, retryableErrors: 1 } });

console.log('PASS: gallery source policy, retry versioning, stable hosts and public labels');
