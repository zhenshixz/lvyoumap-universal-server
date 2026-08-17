const assert = require('assert');
const { shouldRefreshRatingPreview, provinceFromProgress, validateIncrementalRelease } = require('./maintenance_menu');

assert.strictEqual(shouldRefreshRatingPreview(true, null), false, 'New provinces must build a core baseline first.');
assert.strictEqual(shouldRefreshRatingPreview(true, undefined), false, 'A missing preview is not an old preview.');
assert.strictEqual(shouldRefreshRatingPreview(true, { ratingMode: 'local-snapshot' }), true, 'An old preview should refresh after adding an AMap key.');
assert.strictEqual(shouldRefreshRatingPreview(true, { ratingMode: 'live-amap-enabled' }), false, 'A live AMap preview must not refresh repeatedly.');
assert.strictEqual(shouldRefreshRatingPreview(false, { ratingMode: 'local-snapshot' }), false, 'No key means no live rating refresh.');
assert.strictEqual(provinceFromProgress({ scope: '重庆核心景点完整补全' }), '重庆', 'Preview routing should recover a municipality from progress scope.');
assert.strictEqual(provinceFromProgress({ scope: '上海核心缺失景点补全包' }), '上海', 'Preview routing should recover a province from a legacy scope.');
assert.strictEqual(provinceFromProgress({ scope: '全国' }), '', 'National tasks do not have a province preview.');

const readyItem = key => ({ key, status: 'present', matches: [{ quality: { ready: true } }] });
const reviewItem = key => ({ key, status: 'review', matches: [{ quality: { ready: true } }] });
const incremental = validateIncrementalRelease(
  { items: [reviewItem('old'), reviewItem('approved')] },
  { items: [reviewItem('old'), readyItem('approved')] },
  { attractions: [{ baselineKey: 'approved' }], overrides: {} },
);
assert.strictEqual(incremental.passed, true, 'A pre-existing unrelated issue must not block an approved healthy increment.');
assert.deepStrictEqual(incremental.historicalIssues, ['old']);
const regression = validateIncrementalRelease(
  { items: [readyItem('stable'), reviewItem('approved')] },
  { items: [reviewItem('stable'), readyItem('approved')] },
  { attractions: [{ baselineKey: 'approved' }], overrides: {} },
);
assert.strictEqual(regression.passed, false, 'A newly introduced regression must still block release.');

require('./test_core_report_quality');

console.log('Maintenance state routing regression passed.');
