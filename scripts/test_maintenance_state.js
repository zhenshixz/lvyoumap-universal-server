const assert = require('assert');
const { shouldRefreshRatingPreview } = require('./maintenance_menu');

assert.strictEqual(shouldRefreshRatingPreview(true, null), false, 'New provinces must build a core baseline first.');
assert.strictEqual(shouldRefreshRatingPreview(true, undefined), false, 'A missing preview is not an old preview.');
assert.strictEqual(shouldRefreshRatingPreview(true, { ratingMode: 'local-snapshot' }), true, 'An old preview should refresh after adding an AMap key.');
assert.strictEqual(shouldRefreshRatingPreview(true, { ratingMode: 'live-amap-enabled' }), false, 'A live AMap preview must not refresh repeatedly.');
assert.strictEqual(shouldRefreshRatingPreview(false, { ratingMode: 'local-snapshot' }), false, 'No key means no live rating refresh.');

console.log('Maintenance state routing regression passed.');
