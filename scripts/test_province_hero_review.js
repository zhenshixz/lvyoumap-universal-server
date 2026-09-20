const assert = require('assert/strict');
const hero = require('./province_hero_review');

const catalog = hero.buildCatalog();
assert.equal(catalog.total, 34);
assert.equal(catalog.provinces.length, 34);
for (const province of catalog.provinces) {
  assert.ok(province.candidates.length >= 5 && province.candidates.length <= 10, `${province.name} candidate count`);
  assert.equal(new Set(province.candidates.map(item => item.id)).size, province.candidates.length, `${province.name} unique candidates`);
  assert.ok(province.candidates.every(item => item.url.startsWith('/') || item.url.startsWith('https://')), `${province.name} safe URLs`);
}
const first = catalog.provinces[0];
const candidate = first.candidates[0];
const validated = hero.validateSelection({ province: first.name, candidateId: candidate.id, focusX: -10, focusY: 130 }, catalog);
assert.equal(validated.selection.focusX, 0);
assert.equal(validated.selection.focusY, 100);
assert.throws(() => hero.validateSelection({ province: first.name, candidateId: 'missing' }, catalog), /候选图片已变化/);
console.log(`PASS: ${catalog.total} provinces, 5-10 unique review candidates each, safe selection validation.`);
