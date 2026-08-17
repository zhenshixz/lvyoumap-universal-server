const assert = require('assert');
const { shouldRefreshRatingPreview, provinceFromProgress } = require('./maintenance_menu');

assert.strictEqual(shouldRefreshRatingPreview(true, null), false, 'New provinces must build a core baseline first.');
assert.strictEqual(shouldRefreshRatingPreview(true, undefined), false, 'A missing preview is not an old preview.');
assert.strictEqual(shouldRefreshRatingPreview(true, { ratingMode: 'local-snapshot' }), true, 'An old preview should refresh after adding an AMap key.');
assert.strictEqual(shouldRefreshRatingPreview(true, { ratingMode: 'live-amap-enabled' }), false, 'A live AMap preview must not refresh repeatedly.');
assert.strictEqual(shouldRefreshRatingPreview(false, { ratingMode: 'local-snapshot' }), false, 'No key means no live rating refresh.');
assert.strictEqual(provinceFromProgress({ scope: '重庆核心景点完整补全' }), '重庆', 'Preview routing should recover a municipality from progress scope.');
assert.strictEqual(provinceFromProgress({ scope: '上海核心缺失景点补全包' }), '上海', 'Preview routing should recover a province from a legacy scope.');
assert.strictEqual(provinceFromProgress({ scope: '全国' }), '', 'National tasks do not have a province preview.');

require('./test_core_report_quality');

console.log('Maintenance state routing regression passed.');
