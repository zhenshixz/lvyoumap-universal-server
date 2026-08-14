const assert = require('assert');
const { classifyStageResult, stagePolicy } = require('./pipeline_resilience');

assert.equal(classifyStageResult({ status: 0 }).kind, 'complete');
assert.equal(classifyStageResult({ status: 0, progress: { status: 'login_required' } }).kind, 'user_action');
assert.equal(classifyStageResult({ status: 1, progress: { status: 'restricted' } }).kind, 'user_action');
assert.equal(classifyStageResult({ status: 2 }).kind, 'retryable');
assert.equal(classifyStageResult({ status: 1, detail: 'Navigation timeout' }).kind, 'retryable');
assert.equal(classifyStageResult({ status: 1, detail: '小红书登录状态失效。' }).kind, 'user_action');
assert.equal(classifyStageResult({ status: 1, detail: '小红书当前限制访问。' }).kind, 'user_action');
assert.equal(classifyStageResult({ status: 1, detail: 'SyntaxError: Unexpected token' }).kind, 'hard');
assert.equal(stagePolicy('xhs_lazy_guides.js').maxAttempts, 2);
assert.equal(stagePolicy('generate_core_preview.js').maxAttempts, 1);

console.log('Pipeline resilience tests passed.');
