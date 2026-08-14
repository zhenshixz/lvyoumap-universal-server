const assert = require('assert');
const { validateDraftArtifacts } = require('./core_draft_pipeline');

const candidate = { name: '示例景区', city: '示例市', aliases: [] };
const initial = { province: '示例省', reviewCandidates: [candidate] };
const secondary = { province: '示例省', results: [{ ...candidate, status: 'unresolved', evidences: [] }] };
const healthy = { province: '示例省', attractions: [{ name: '官方景区', city: '示例市', aliases: [] }], reviewCandidates: [candidate], qualityGate: { secondaryEvidenceComplete: true, selectedIssues: [] } };

assert.strictEqual(validateDraftArtifacts(initial, secondary, healthy).ok, true, '完整同批草稿应通过');
assert.strictEqual(validateDraftArtifacts(initial, { province: '示例省', results: [] }, healthy).ok, false, '过期二次证据必须触发重建');
assert.strictEqual(validateDraftArtifacts(initial, secondary, { ...healthy, attractions: [candidate] }).ok, false, '观察池不得泄漏到最终清单');
const gated = validateDraftArtifacts(initial, secondary, { ...healthy, qualityGate: { secondaryEvidenceComplete: true, selectedIssues: [{ attraction: '坏数据' }] } });
assert.strictEqual(gated.ok, true, '质量问题是业务门禁，不应伪装成程序异常');
assert.strictEqual(gated.gateIssues.length, 1, '质量问题必须完整交给门禁处理');
console.log('全国核心草稿状态机回归测试通过。');
