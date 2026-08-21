const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { readJson, updateBatch, writeJsonAtomic, filterReviewedPackage, applyCoverageToState } = require('./observation_batch');

const rootDir = path.join(__dirname, '..');
const runtimeDir = path.join(rootDir, '.runtime');
const progressPath = path.join(runtimeDir, 'xhs-lazy-progress.json');
const args = new Map(process.argv.slice(2).map(value => {
  const match = value.match(/^--([^=]+)=(.*)$/);
  return match ? [match[1], match[2]] : [value.replace(/^--/, ''), true];
}));
const manifestPath = String(args.get('manifest') || '');
if (!manifestPath) throw new Error('请使用 --manifest=批次文件。');

function run(script, scriptArgs = []) {
  const result = spawnSync(process.execPath, [path.join('scripts', script), ...scriptArgs], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: false,
  });
  return result.status === 0;
}

function saveProgress(manifest, patch = {}) {
  const done = manifest.provinces.filter(item => ['ready', 'applied', 'resolved'].includes(item.status)).length;
  const failed = manifest.provinces.filter(item => item.status === 'failed').length;
  writeJsonAtomic(progressPath, {
    status: patch.status || 'running',
    stage: 'observation_batch',
    scope: '全国单源观察池批量补全',
    index: done + failed,
    total: manifest.provinces.length,
    percent: manifest.provinces.length ? Math.round((done + failed) / manifest.provinces.length * 1000) / 10 : 0,
    success: manifest.provinces.reduce((sum, item) => sum
      + (['ready', 'applied'].includes(item.status) ? item.selectedKeys.length : 0)
      + (item.resolutions?.length || 0), 0),
    failed: manifest.provinces.reduce((sum, item) => sum + (item.status === 'failed' ? item.selectedKeys.length : 0), 0),
    current: patch.current || '',
    pendingNames: manifest.provinces.filter(item => !['ready', 'applied'].includes(item.status)).flatMap(item => item.selectedNames),
    message: patch.message || '批次正在按省份顺序补全，单省失败不会阻断其他省份。',
    pid: process.pid,
    batchManifest: manifestPath,
    previewUrl: patch.previewUrl || '',
    updatedAt: new Date().toISOString(),
  });
}

function pausedForUserAction() {
  const progress = readJson(progressPath, {});
  return ['login_required', 'restricted', 'decision_required', 'stopped'].includes(progress.status) ? progress : null;
}

function main() {
  let manifest = readJson(manifestPath, null);
  if (!manifest) throw new Error(`批次清单不存在：${manifestPath}`);
  manifest = updateBatch(manifestPath, { status: 'running', pid: process.pid });
  saveProgress(manifest);
  for (const state of manifest.provinces) {
    if (['ready', 'applied', 'resolved'].includes(state.status)) continue;
    state.status = 'running';
    state.attempts = Number(state.attempts || 0) + 1;
    state.startedAt = new Date().toISOString();
    updateBatch(manifestPath, { provinces: manifest.provinces, currentProvince: state.province });
    saveProgress(manifest, { current: state.province, message: `正在补全 ${state.province}：${state.selectedNames.join('、')}` });
    const ok = run('complete_province_pipeline.js', [`--province=${state.province}`, '--skip-preview']);
    const userAction = !ok && pausedForUserAction();
    if (userAction) {
      state.status = 'queued';
      state.error = userAction.message || '等待用户处理后续跑。';
      manifest = updateBatch(manifestPath, {
        status: 'user_action',
        provinces: manifest.provinces,
        currentProvince: state.province,
      });
      saveProgress(manifest, {
        status: userAction.status,
        current: userAction.current || state.province,
        message: `${userAction.message || '需要用户处理。'} 处理后重新进入“全国单源观察池批量补选”即可从当前省份继续。`,
      });
      return;
    }
    try {
      if (!ok) throw new Error('省级完整补全未完成，已保留断点。');
      const coverage = filterReviewedPackage(manifestPath, state.slug);
      applyCoverageToState(state, coverage);
      state.completedAt = new Date().toISOString();
    } catch (error) {
      state.status = 'failed';
      state.error = error.message;
      state.failedAt = new Date().toISOString();
    }
    manifest = updateBatch(manifestPath, { provinces: manifest.provinces, currentProvince: '' });
    saveProgress(manifest);
  }
  const ready = manifest.provinces.filter(item => item.status === 'ready');
  if (!ready.length) {
    manifest = updateBatch(manifestPath, { status: 'retry_ready' });
    saveProgress(manifest, { status: 'retry_ready', message: '本轮暂无可预览项目；全部断点已保留，再次进入批次功能即可续跑。' });
    return;
  }
  if (!run('generate_observation_batch_preview.js', [`--manifest=${manifestPath}`])) {
    manifest = updateBatch(manifestPath, { status: 'retry_ready', error: '全国批次预览生成失败' });
    saveProgress(manifest, { status: 'retry_ready', message: '资料已补全，但批次预览生成失败；再次进入批次功能会自动重试。' });
    return;
  }
  manifest = readJson(manifestPath, manifest);
  const failedCount = manifest.provinces.filter(item => item.status === 'failed').reduce((sum, item) => sum + item.selectedKeys.length, 0);
  manifest = updateBatch(manifestPath, { status: 'preview_ready' });
  saveProgress(manifest, {
    status: 'preview_ready',
    previewUrl: manifest.previewUrl,
    message: `全国批次隔离预览已就绪；${ready.reduce((sum, item) => sum + item.selectedKeys.length, 0)} 项可验收，${failedCount} 项保留断点。`,
  });
}

try {
  main();
} catch (error) {
  const manifest = readJson(manifestPath, { provinces: [] });
  updateBatch(manifestPath, { status: 'retry_ready', error: error.message });
  saveProgress(manifest, { status: 'retry_ready', message: `${error.message}；断点已保留，再次进入批次功能即可续跑。` });
  console.error(error.message);
  process.exitCode = 1;
}
