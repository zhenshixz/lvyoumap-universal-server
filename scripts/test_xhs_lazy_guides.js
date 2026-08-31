const assert = require('assert');
const { answerQuality, isTransientAnswer, retryPlan, promptFor, isExcludedName } = require('./xhs_lazy_guides');

assert.strictEqual(isTransientAnswer('问题分析中'), true, 'The normal Diandian analysis state must not be treated as an answer.');
assert.strictEqual(isTransientAnswer('正在生成回答……'), true, 'Generation placeholders must remain transient.');
assert.strictEqual(isTransientAnswer('省力路线：先乘观光车，再步行参观核心区域。'), false, 'Real answer text must be retained.');
assert.strictEqual(retryPlan({ reason: 'analysis_only' }).resetPage, true, 'A stalled analysis state should reset the conversation.');
assert.strictEqual(retryPlan({ reason: 'incomplete_answer' }).resetPage, false, 'A partial answer should continue in the same conversation first.');
assert.strictEqual(retryPlan({ reason: 'login_required' }), null, 'Authentication failures require user login instead of blind retries.');
assert.match(promptFor({ name: '凤凰山公园', city: '莆田市' }, '福建'), /福建莆田市凤凰山公园/, 'Prompt must bind the exact province, city and attraction.');
assert.match(promptFor({ name: '凤凰山公园', city: '莆田市' }, '福建'), /完整文章正文/, 'Prompt must request the real lazy-guide article format.');
assert.strictEqual(isExcludedName('凤凰山公园'), false, 'Legitimate parks must be collected instead of blanket-excluded.');
assert.strictEqual(isExcludedName('凤凰山公园停车场'), true, 'Facility POIs must remain excluded.');
assert.strictEqual(answerQuality('全国有多个凤凰山公园，我先按深圳凤凰山整理。\n省力路线：入口到山顶。老人儿童注意台阶。这里有休息点，建议少走路。'.repeat(8)).complete, false, 'Same-name ambiguity must never pass as a complete guide.');

console.log('Xiaohongshu adaptive collection regression passed.');
