const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { relatedAttraction } = require('./core_candidate_quality');
const { classifyStageResult, sleepSync, stagePolicy } = require('./pipeline_resilience');

const rootDir = path.join(__dirname, '..');
const runtimeDir = path.join(rootDir, '.runtime');

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function runScript(script, province, extraArgs = [], quiet = true) {
  const policy = stagePolicy(script);
  let last = { ok: false, output: '', status: 1, kind: 'hard' };
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    const result = spawnSync(process.execPath, [path.join('scripts', script), `--province=${province}`, ...extraArgs], {
      cwd: rootDir,
      stdio: quiet ? 'pipe' : 'inherit',
      encoding: quiet ? 'utf8' : undefined,
      shell: false,
    });
    const output = quiet ? [result.stdout, result.stderr].filter(Boolean).join('\n').trim() : '';
    const classification = classifyStageResult({ status: result.status, detail: output });
    last = { ok: classification.kind === 'complete', output, status: result.status, kind: classification.kind, attempt };
    if (last.ok || !classification.retry || attempt >= policy.maxAttempts) return last;
    if (!quiet) console.log(`${script} 暂时未完整，${Math.round(policy.delayMs / 1000)} 秒后自动重试。`);
    sleepSync(policy.delayMs);
  }
  return last;
}

function sameDraftItem(left, right) {
  return relatedAttraction(left.name, right.name, left.city, right.city)
    || (left.aliases || []).some(alias => relatedAttraction(alias, right.name, left.city, right.city));
}

function validateDraftArtifacts(initialDraft, secondary, finalDraft) {
  const errors = [];
  if (!initialDraft?.province || !Array.isArray(initialDraft.reviewCandidates)) errors.push('首轮草稿缺失或结构不完整');
  if (!secondary?.province || !Array.isArray(secondary.results)) errors.push('二次证据缺失或结构不完整');
  if (!finalDraft?.province || !Array.isArray(finalDraft.attractions)) errors.push('最终草稿缺失或结构不完整');
  if (errors.length) return { ok: false, errors };
  const missingSecondary = initialDraft.reviewCandidates.filter(candidate => !secondary.results.some(result => sameDraftItem(candidate, result)));
  if (missingSecondary.length) errors.push(`二次证据未覆盖本轮候选：${missingSecondary.map(item => item.name).join('、')}`);
  const observationLeak = (finalDraft.reviewCandidates || []).filter(candidate => finalDraft.attractions.some(item => sameDraftItem(candidate, item)));
  if (observationLeak.length) errors.push(`观察池候选误入最终清单：${observationLeak.map(item => item.name).join('、')}`);
  if (finalDraft.qualityGate?.secondaryEvidenceComplete === false) errors.push('最终草稿仍引用过期二次证据');
  const gateIssues = finalDraft.qualityGate?.selectedIssues || [];
  return { ok: errors.length === 0, errors, gateIssues };
}

function runCoreDraftPipeline({ province, slug, quiet = true, onStage = () => {} }) {
  const draftPath = path.join(runtimeDir, `core-attractions.${slug}.draft.json`);
  const secondaryPath = path.join(runtimeDir, `core-secondary-evidence-${slug}.json`);
  let lastErrors = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    onStage('initial', attempt);
    const initialRun = runScript('build_core_baseline.js', province, ['--ignore-secondary'], quiet);
    if (!initialRun.ok) return { ok: false, code: 'initial_draft_failed', detail: initialRun.output };
    const initialDraft = readJson(draftPath, null);
    onStage('secondary', attempt);
    const secondaryRun = runScript('collect_secondary_core_evidence.js', province, [], quiet);
    if (!secondaryRun.ok) return { ok: false, code: 'secondary_collection_failed', detail: secondaryRun.output };
    const secondary = readJson(secondaryPath, null);
    onStage('final', attempt);
    const finalRun = runScript('build_core_baseline.js', province, [], quiet);
    if (!finalRun.ok) return { ok: false, code: 'final_draft_failed', detail: finalRun.output };
    const finalDraft = readJson(draftPath, null);
    const validation = validateDraftArtifacts(initialDraft, secondary, finalDraft);
    if (validation.ok) return { ok: true, ready: finalDraft.baselineStatus === 'multi_source_ready' && finalDraft.qualityGate?.passed, gateIssues: validation.gateIssues, repaired: attempt > 1, initialDraft, secondary, draft: finalDraft };
    lastErrors = validation.errors;
    onStage('retry', attempt, validation.errors);
  }
  return { ok: false, code: 'draft_invariant_failed', detail: lastErrors.join('；') || '草稿状态自检失败' };
}

module.exports = { runCoreDraftPipeline, validateDraftArtifacts };
