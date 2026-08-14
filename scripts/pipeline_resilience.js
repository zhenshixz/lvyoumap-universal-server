const USER_ACTION_STATUSES = new Set(['login_required', 'restricted']);
const SAFE_STOP_STATUSES = new Set(['stopped']);

const retryablePatterns = [
  /timeout|timed out|econnreset|econnrefused|enotfound|socket hang up/i,
  /network|navigation|target closed|browser.*closed/i,
  /退出码\s*2|待续跑|回答不完整|部分来源暂未取到/u,
];

const userActionPatterns = [
  /登录状态失效|请.*登录|扫码登录|login required/i,
  /限制访问|访问受限|安全验证|验证码|restricted/i,
];

const hardFailurePatterns = [
  /syntaxerror|referenceerror|typeerror/i,
  /cannot find module|模块不存在|脚本不存在/u,
  /数据冲突|身份冲突|省份冲突|质量门禁.*硬性/u,
];

function classifyStageResult({ status, progress = {}, detail = '' }) {
  if (USER_ACTION_STATUSES.has(progress.status)) {
    return { kind: 'user_action', retry: false, exitCode: 2 };
  }
  if (SAFE_STOP_STATUSES.has(progress.status)) {
    return { kind: 'stopped', retry: false, exitCode: 2 };
  }
  if (status === 0) return { kind: 'complete', retry: false, exitCode: 0 };
  if (userActionPatterns.some(pattern => pattern.test(detail))) {
    return { kind: 'user_action', retry: false, exitCode: 2 };
  }
  if (hardFailurePatterns.some(pattern => pattern.test(detail))) {
    return { kind: 'hard', retry: false, exitCode: 1 };
  }
  if (status === 2 || retryablePatterns.some(pattern => pattern.test(detail))) {
    return { kind: 'retryable', retry: true, exitCode: 2 };
  }
  return { kind: 'hard', retry: false, exitCode: 1 };
}

function sleepSync(ms) {
  if (!ms) return;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, ms);
}

function stagePolicy(script) {
  const policies = {
    'xhs_lazy_guides.js': { maxAttempts: 2, delayMs: 2500 },
    'xhs_research_guides.js': { maxAttempts: 2, delayMs: 2500 },
    'collect_core_details.js': { maxAttempts: 2, delayMs: 1800 },
    'collect_secondary_core_evidence.js': { maxAttempts: 2, delayMs: 1800 },
    'collect_mct_core_candidates.js': { maxAttempts: 2, delayMs: 1800 },
    'collect_ota_core_candidates.js': { maxAttempts: 2, delayMs: 1800 },
  };
  return policies[script] || { maxAttempts: 1, delayMs: 0 };
}

module.exports = {
  classifyStageResult,
  sleepSync,
  stagePolicy,
};
