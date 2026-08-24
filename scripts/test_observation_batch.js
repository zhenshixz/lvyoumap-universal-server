const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  applyResolutionsToBaseline,
  applyCoverageToState,
  prepareProvinceWorkspace,
  parseSelection,
  scanObservationPool,
} = require('./observation_batch');
const { isBuildReady } = require('./generate_observation_batch_preview');

const items = scanObservationPool();
assert(items.every((item, index) => item.index === index + 1), '观察池序号必须连续。');
assert.strictEqual(new Set(items.map(item => `${item.province}:${item.name}`)).size, items.length, '同省同名候选不得重复。');

const selectionFixtures = Array.from({ length: 6 }, (_, index) => ({ index: index + 1, priority: index < 2 }));
assert.deepStrictEqual(parseSelection('1,3-5', selectionFixtures).map(item => item.index), [1, 3, 4, 5]);
assert.deepStrictEqual(parseSelection('5-3，1', selectionFixtures).map(item => item.index), [1, 3, 4, 5]);
assert.strictEqual(parseSelection('0', items).length, 0);
assert.strictEqual(parseSelection('rec', selectionFixtures).length, 2);
assert.strictEqual(parseSelection('all', selectionFixtures).length, selectionFixtures.length);

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

assert.strictEqual(typeof prepareProvinceWorkspace, 'function', '观察池批次必须提供独立工作区准备能力。');

const partialState = {
  province: '测试省', slug: '__observation_test_missing__', status: 'running',
  selectedKeys: ['a', 'b'], selectedNames: ['A', 'B'],
  originalSelectedKeys: ['a', 'b'], originalSelectedNames: ['A', 'B'],
  workspaceBatchId: 'batch-test', workspacePreparedAt: 'now',
};
applyCoverageToState(partialState, { coveredKeys: ['a'], missingKeys: ['b'] });
assert.strictEqual(partialState.status, 'failed', '部分命中不得提前进入预览。');
assert.deepStrictEqual(partialState.selectedKeys, ['a', 'b'], '部分命中后必须保留整省所选集合以便重建完整包。');
assert.strictEqual(partialState.workspaceBatchId, undefined, '部分补全后应允许重建本批独立工作区。');

const fakeDist = fs.mkdtempSync(path.join(os.tmpdir(), 'lvyoumap-dist-check-'));
for (const relativePath of [
  'index.html', 'app.js', 'style.css',
  path.join('data', 'search-index.json'),
  path.join('data', 'provinces-index.json'),
  path.join('data', 'provinces', 'anhui.json'),
]) {
  const filePath = path.join(fakeDist, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '{}', 'utf8');
}
assert.strictEqual(isBuildReady(fakeDist, ['anhui']), true, '完整构建应通过预览前置检查。');
assert.strictEqual(isBuildReady(fakeDist, ['anhui', 'beijing']), false, '缺少任一省份数据必须触发自动重建。');
fs.rmSync(fakeDist, { recursive: true, force: true });

console.log(`全国单源观察池测试通过：${items.length} 条候选，${items.filter(item => item.priority).length} 条推荐。`);
