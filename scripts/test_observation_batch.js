const assert = require('assert');
const {
  applyResolutionsToBaseline,
  parseSelection,
  scanObservationPool,
} = require('./observation_batch');

const items = scanObservationPool();
assert(items.length > 0, '观察池不应为空。');
assert(items.every((item, index) => item.index === index + 1), '观察池序号必须连续。');
assert.strictEqual(new Set(items.map(item => `${item.province}:${item.name}`)).size, items.length, '同省同名候选不得重复。');

assert.deepStrictEqual(parseSelection('1,3-5', items).map(item => item.index), [1, 3, 4, 5]);
assert.deepStrictEqual(parseSelection('5-3，1', items).map(item => item.index), [1, 3, 4, 5]);
assert.strictEqual(parseSelection('0', items).length, 0);
assert.strictEqual(parseSelection('rec', items).length, items.filter(item => item.priority).length);
assert.strictEqual(parseSelection('all', items).length, items.length);

const resolutionResult = applyResolutionsToBaseline({
  attractions: [
    { key: 'same', name: '旧名', aliases: ['旧名'], selectionBatch: 'batch-1' },
    { key: 'event', name: '临时演出', selectionBatch: 'batch-1' },
    { key: 'history', name: '历史清单项' },
  ],
}, {
  resolutions: [
    { key: 'same', name: '旧名', type: 'already_present', existingName: '正式名称' },
    { key: 'event', name: '临时演出', type: 'excluded_non_attraction' },
    { key: 'history', name: '历史清单项', type: 'excluded_non_attraction' },
  ],
}, 'batch-1', [{ id: 'existing-1', name: '正式名称' }]);
assert.strictEqual(resolutionResult.bound, 1, '已存在同实体应绑定真实景点 ID。');
assert.strictEqual(resolutionResult.removed, 1, '本批次非景点候选应被移除。');
assert.strictEqual(resolutionResult.baseline.attractions.find(item => item.key === 'same').preferredId, 'existing-1');
assert(resolutionResult.baseline.attractions.some(item => item.key === 'history'), '不得删除历史核心清单项。');

console.log(`全国单源观察池测试通过：${items.length} 条候选，${items.filter(item => item.priority).length} 条推荐。`);
