const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { classifyStageResult, sleepSync, stagePolicy } = require('./pipeline_resilience');

const rootDir = path.join(__dirname, '..');
const contentDir = path.join(rootDir, 'content');
const runtimeDir = path.join(rootDir, '.runtime');
const progressPath = path.join(runtimeDir, 'xhs-lazy-progress.json');
const stopPath = path.join(runtimeDir, 'xhs-lazy-stop.flag');
const args = new Map(process.argv.slice(2).map(arg => {
  const match = arg.match(/^--([^=]+)=(.*)$/);
  return match ? [match[1], match[2]] : [arg.replace(/^--/, ''), true];
}));
const province = String(args.get('province') || '').trim();
if (!province) throw new Error('请使用 --province=省份。');

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function writeProgress(patch) {
  const previous = readJson(progressPath, {});
  const next = { ...previous, pid: process.pid, ...patch, scope: `${province}核心景点完整补全`, updatedAt: new Date().toISOString() };
  fs.mkdirSync(runtimeDir, { recursive: true });
  const temp = `${progressPath}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\r\n`, 'utf8');
  fs.renameSync(temp, progressPath);
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\r\n`, 'utf8');
  fs.renameSync(temp, filePath);
}

function isolatePendingGuides(packageData, researchData) {
  const targetIds = new Set((packageData?.attractions || researchData?.attractions || []).map(item => item.id));
  if (!targetIds.size) return;
  const contentPath = path.join(contentDir, 'lazy-guide-overrides.json');
  const runtimePath = path.join(runtimeDir, 'core-lazy-guide-overrides.json');
  const published = readJson(contentPath, {});
  const pending = readJson(runtimePath, {});
  let changed = false;
  for (const id of targetIds) {
    if (!published[id]) continue;
    pending[id] = published[id];
    delete published[id];
    changed = true;
  }
  if (!changed) return;
  writeJsonAtomic(contentPath, published);
  writeJsonAtomic(runtimePath, pending);
  console.log(`已将 ${province} 未批准景点攻略迁入隔离断点层，不影响普通构建。`);
}

class PipelineStageError extends Error {
  constructor(message, kind = 'hard', exitCode = 1) {
    super(message);
    this.kind = kind;
    this.exitCode = exitCode;
  }
}

function run(script, scriptArgs = [], options = {}) {
  const policy = { ...stagePolicy(script), ...options };
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    const result = spawnSync(process.execPath, [path.join('scripts', script), ...scriptArgs], {
      cwd: rootDir,
      stdio: ['inherit', 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: 80 * 1024 * 1024,
      windowsHide: true,
      shell: false,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) throw new PipelineStageError(result.error.message, 'hard', 1);
    const progress = script.startsWith('xhs_') ? readJson(progressPath, {}) : {};
    const detail = `${result.stdout || ''}\n${result.stderr || ''}`;
    const classification = classifyStageResult({ status: result.status, progress, detail });
    if (classification.kind === 'complete') return true;
    if (classification.retry && attempt < policy.maxAttempts) {
      const pendingText = progress.pendingNames?.length ? `，剩余 ${progress.pendingNames.length} 项` : '';
      writeProgress({
        status: 'running',
        message: `${script} 本轮只完成部分数据${pendingText}；${Math.round(policy.delayMs / 1000)} 秒后自动续跑（${attempt + 1}/${policy.maxAttempts}）。`,
      });
      console.log(`\n${script} 已保存断点，短暂等待后自动续跑，不需要人工处理。`);
      sleepSync(policy.delayMs);
      continue;
    }
    const messages = {
      user_action: progress.message || '需要完成平台登录或稍后解除访问限制。',
      stopped: '任务已在安全点停止。',
      retryable: `${script} 已保存所有成功断点，当前仍有少数项目待续跑。`,
      hard: `${script} 发生不可自动恢复的程序或数据错误（退出码 ${result.status}）。`,
    };
    throw new PipelineStageError(messages[classification.kind], classification.kind, classification.exitCode);
  }
  return false;
}

function info() {
  const db = readJson(path.join(contentDir, 'db.json'), { provinces: {} });
  const data = db.provinces?.[province];
  return data ? { slug: data.id || data.slug } : null;
}

function pendingGuides(packageData, researchData) {
  const lazy = {
    ...readJson(path.join(contentDir, 'lazy-guide-overrides.json'), {}),
    ...readJson(path.join(runtimeDir, 'core-lazy-guide-overrides.json'), {}),
  };
  const items = packageData?.attractions || researchData?.attractions || [];
  return items.filter(item => lazy[item.id]?.lazy_ai_source?.source !== 'xiaohongshu-dian-dian-ai-chat');
}

function packageHasPlaceholderImages(packageData) {
  const items = [
    ...(packageData?.attractions || []),
    ...Object.values(packageData?.overrides || {}),
  ];
  return items.some(item => item.image === '/assets/images/default-thumbnail.jpg'
    || item.image_source?.provider === '项目通用占位图'
    || item.imageSource?.provider === '项目通用占位图');
}

function checkStop() {
  if (!fs.existsSync(stopPath)) return;
  writeProgress({ status: 'stopped', message: '已在阶段切换处安全停止；成功结果已保留，下次可继续。' });
  throw new Error('收到安全停止请求。');
}

function main() {
  const provinceInfo = info();
  if (!provinceInfo) throw new Error(`无法识别省份：${province}`);
  const slug = provinceInfo.slug;
  const packagePath = path.join(contentDir, `core-repair-packages.${slug}.json`);
  const researchPath = path.join(runtimeDir, `core-repair-research.${slug}.json`);

  writeProgress({ status: 'running', stage: 'preflight', message: '正在检查核心清单、补全档案和断点数据。', pid: process.pid, index: 0, total: 5, success: 0, failed: 0 });
  let packageData = readJson(packagePath);
  let researchData = readJson(researchPath);
  if (!packageData && !researchData) {
    run('prepare_core_repair_package.js', [`--province=${province}`]);
    packageData = readJson(packagePath);
    researchData = readJson(researchPath);
  }
  checkStop();
  if (!packageData && !researchData) throw new Error('没有生成核心景点资料研究任务，请先确认核心清单。');
  isolatePendingGuides(packageData, researchData);

  if (packageData?.status === 'applied') {
    writeProgress({ status: 'done', stage: 'applied', message: `${province}补全包已经写入 beta，无需重复执行。`, index: 5, total: 5, percent: 100 });
    return;
  }
  if (packageData?.status === 'reviewed' && !packageHasPlaceholderImages(packageData)) {
    writeProgress({ status: 'generating', stage: 'preview', message: '补全包已通过质量门禁，正在恢复或重建隔离预览。', index: 6, total: 7, percent: 86 });
    run('generate_core_preview.js', [`--province=${province}`]);
    packageData = readJson(packagePath);
    const preview = readJson(path.join(runtimeDir, 'previews', slug, 'state.json'));
    if (preview?.status !== 'ready') throw new Error('隔离预览未能进入 ready 状态。');
    const totalItems = (packageData.attractions?.length || 0) + Object.keys(packageData.overrides || {}).length;
    writeProgress({ status: 'preview_ready', stage: 'preview', message: `隔离预览已就绪：${preview.previewUrl}。回到总控再次选择该省完成最终确认。`, index: 7, total: 7, percent: 100, success: totalItems, failed: 0, previewUrl: preview.previewUrl });
    console.log(`${province}已复用 reviewed 补全包并恢复隔离预览；没有重复联网采集，尚未写入 beta。`);
    return;
  }
  if (packageData?.status === 'reviewed' && packageHasPlaceholderImages(packageData)) {
    console.log(`${province}仍有景点缺少真实图片：自动只续跑图片补全，不重复采集点点攻略和路线。`);
  }

  writeProgress({ status: 'running', stage: 'guide', message: '正在补齐缺失景点的点点懒人攻略。', index: 1, total: 5, percent: 20 });
  const guidePending = pendingGuides(packageData, researchData);
  if (guidePending.length) {
    run('xhs_lazy_guides.js', [`--province=${province}`, '--write', '--background', '--repair-only']);
  } else {
    console.log(`${province}点点攻略已齐：复用现有 ${packageData?.attractions?.length || researchData?.attractions?.length || 0} 条，不重复采集。`);
  }
  checkStop();

  packageData = readJson(packagePath);
  researchData = readJson(researchPath);
  if (pendingGuides(packageData, researchData).length) throw new Error('仍有点点攻略未采集成功；已保存断点，下次可继续。');

  writeProgress({ status: 'running', stage: 'experience', message: '正在补齐至少一条可执行游览方案、交通、住宿与长辈儿童建议。', index: 2, total: 7, percent: 29 });
  if (packageData?.status !== 'reviewed') {
    const manualEvidence = readJson(path.join(contentDir, `core-repair-evidence.${slug}.json`), { attractions: {} });
    const readyManual = new Set(Object.entries(manualEvidence.attractions || {})
      .filter(([, value]) => value?.sources?.length >= 2 && value?.routes?.length >= 1 && value?.image?.downloadUrl)
      .map(([key]) => key));
    const experience = readJson(path.join(runtimeDir, `core-experience-evidence.${slug}.json`), { attractions: {} });
    const researchItems = researchData?.attractions || [];
    const missingExperience = researchItems.filter(item => (
      !readyManual.has(item.baselineKey)
      && !experience.attractions?.[item.baselineKey]?.routes?.length
    ));
    if (missingExperience.length) {
      run('xhs_research_guides.js', [`--province=${province}`]);
    }
  }
  checkStop();

  // 评分证据属于可独立更新的数据层。即便完整资料包此前已经 reviewed，
  // 也必须执行一次来源绑定刷新，避免旧断点永久保留 0 分或无来源评分。
  writeProgress({ status: 'running', stage: 'facts', message: '正在交叉核验基本资料，并按“可靠OTA优先、高德唯一同实体兜底”刷新评分。', index: 3, total: 7, percent: 43 });
  run('collect_core_details.js', [`--province=${province}`, '--refresh-ratings', '--refresh-images']);
  checkStop();
  writeProgress({ status: 'running', stage: 'package', message: '正在下载授权高清图并重新生成完整景点资料包。', index: 4, total: 7, percent: 57 });
  run('research_core_repairs.js', [`--province=${province}`]);
  packageData = readJson(packagePath);
  checkStop();

  writeProgress({ status: 'running', stage: 'quality', message: '正在执行完整字段、身份重复、来源和内容风险质量门禁。', index: 5, total: 7, percent: 71 });
  run('core_repair_pipeline.js', [`--province=${province}`, '--finalize']);
  packageData = readJson(packagePath);
  if (packageData?.status !== 'reviewed') throw new Error('补全包未进入 reviewed 状态。');
  checkStop();

  writeProgress({ status: 'generating', stage: 'preview', message: '质量门禁通过，正在生成隔离预览。', index: 6, total: 7, percent: 86 });
  run('generate_core_preview.js', [`--province=${province}`]);
  packageData = readJson(packagePath);
  const preview = readJson(path.join(runtimeDir, 'previews', slug, 'state.json'));
  if (preview?.status !== 'ready') throw new Error('隔离预览未能进入 ready 状态。');

  const totalItems = (packageData.attractions?.length || 0) + Object.keys(packageData.overrides || {}).length;
  writeProgress({ status: 'preview_ready', stage: 'preview', message: `隔离预览已就绪：${preview.previewUrl}。回到总控再次选择该省完成最终确认。`, index: 7, total: 7, percent: 100, success: totalItems, failed: 0, previewUrl: preview.previewUrl });
  console.log(`${province}一键补全已运行到隔离预览；尚未写入 beta。`);
}

try {
  main();
} catch (error) {
  const current = readJson(progressPath, {});
  if (!['login_required', 'restricted', 'stopped'].includes(current.status)) {
    const pendingText = current.pendingNames?.length ? ` 待续跑：${current.pendingNames.join('、')}。` : '';
    const retryable = error.kind === 'retryable';
    writeProgress({
      status: retryable ? 'retry_ready' : 'error',
      message: retryable
        ? `${error.message}${pendingText} 已保留全部成功断点；在总控再次选择“开始/继续”即可续跑，不需要修改文件或返回对话。`
        : `${error.message}${pendingText} 这是需要修复的关键错误，普通资料缺失不会进入此状态。`,
      pid: process.pid,
    });
  }
  console.error(`省级完整补全失败：${error.message}`);
  process.exitCode = error.exitCode || 1;
}
