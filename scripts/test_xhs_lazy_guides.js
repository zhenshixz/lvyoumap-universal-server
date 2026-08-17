const assert = require('assert');
const { isTransientAnswer, retryPlan } = require('./xhs_lazy_guides');

assert.strictEqual(isTransientAnswer('问题分析中'), true, 'The normal Diandian analysis state must not be treated as an answer.');
assert.strictEqual(isTransientAnswer('正在生成回答……'), true, 'Generation placeholders must remain transient.');
assert.strictEqual(isTransientAnswer('省力路线：先乘观光车，再步行参观核心区域。'), false, 'Real answer text must be retained.');
assert.strictEqual(retryPlan({ reason: 'analysis_only' }).resetPage, true, 'A stalled analysis state should reset the conversation.');
assert.strictEqual(retryPlan({ reason: 'incomplete_answer' }).resetPage, false, 'A partial answer should continue in the same conversation first.');
assert.strictEqual(retryPlan({ reason: 'login_required' }), null, 'Authentication failures require user login instead of blind retries.');

console.log('Xiaohongshu adaptive collection regression passed.');
