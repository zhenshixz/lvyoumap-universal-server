const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { runCoreDraftPipeline } = require('./core_draft_pipeline');

const rootDir = path.join(__dirname, '..');
const runtimeDir = path.join(rootDir, '.runtime');
const progressPath = path.join(runtimeDir, 'xhs-lazy-progress.json');
const stopPath = path.join(runtimeDir, 'xhs-lazy-stop.flag');
const logPath = path.join(runtimeDir, 'xhs-lazy-process.log');
const nationalQueuePath = path.join(runtimeDir, 'national-core-queue.json');
const provinceBatches = [
  { name: '京津冀鲁', provinces: ['北京', '天津', '河北', '山东'] },
  { name: '长三角与华东', provinces: ['上海', '江苏', '浙江', '安徽'] },
  { name: '东北', provinces: ['辽宁', '吉林', '黑龙江'] },
  { name: '中部', provinces: ['山西', '河南', '湖北', '湖南'] },
  { name: '华南', provinces: ['广东', '广西', '海南'] },
  { name: '西南与高原', provinces: ['重庆', '四川', '云南', '西藏'] },
  { name: '西北', provinces: ['陕西', '甘肃', '青海', '宁夏', '新疆', '内蒙古'] },
];

const statusNames = {
  starting: '正在启动后台任务',
  login_waiting: '等待扫码登录',
  login_ready: '登录状态可用',
  running: '正在采集',
  generating: '正在生成数据',
  done: '当前子任务已完成',
  guide_done: '懒人攻略采集已完成（非整省验收）',
  experience_done: '结构化旅行资料已完成，正在补齐基本资料与图片',
  research_required: '旧版人工证据前置状态（再次开始会自动迁移并续跑）',
  retry_ready: '部分来源暂未取到，断点已保存，可直接继续',
  preview_ready: '完整资料预览已就绪，等待最终确认',
  partial: '部分完成，可继续补全',
  stopped: '已安全停止',
  login_required: '登录已失效',
  restricted: '平台限制访问，已安全暂停',
  decision_required: '存在景点身份歧义，等待总控选择',
  error: '发生错误',
  recovered: '已恢复采集结果',
};

function localEnvHasAmapKey() {
  const filePath = path.join(rootDir, '.env');
  if (!fs.existsSync(filePath)) return false;
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).some(line => /^\s*AMAP_WEB_SERVICE_KEY\s*=\s*\S+/.test(line));
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\r\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function normalizeProvinceName(input) {
  const db = readJson(path.join(rootDir, 'content', 'db.json'), { provinces: {} });
  const names = Object.keys(db.provinces || {});
  if (names.includes(input)) return input;
  const shortName = input.replace(/特别行政区$|壮族自治区$|回族自治区$|维吾尔自治区$|自治区$|省$|市$/u, '');
  return names.includes(shortName) ? shortName : '';
}

function readJson(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function previewBuildFingerprint() {
  try {
    const hash = crypto.createHash('sha256');
    for (const relativePath of ['index.html', 'app.js', 'style.css']) {
      const filePath = path.join(rootDir, 'dist', relativePath);
      if (!fs.existsSync(filePath)) return '';
      hash.update(relativePath);
      hash.update(fs.readFileSync(filePath));
    }
    return hash.digest('hex');
  } catch {
    return '';
  }
}

function processIsRunning(pid) {
  const numericPid = Number(pid || 0);
  if (!numericPid) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch {
    return false;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function runNode(script, args = [], options = {}) {
  const quiet = Boolean(options.quiet);
  const result = spawnSync(process.execPath, [path.join('scripts', script), ...args], {
    cwd: rootDir,
    stdio: quiet ? 'pipe' : 'inherit',
    encoding: quiet ? 'utf8' : undefined,
    shell: false,
  });
  if (result.error) console.error(`运行失败：${result.error.message}`);
  if (quiet && result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    if (details) console.error(`\n${details}`);
  }
  return result.status === 0;
}

function printStep(index, total, title, detail = '') {
  console.log(`\n[${index}/${total}] ${title}`);
  if (detail) console.log(`      ${detail}`);
}

function printNamesByCity(attractions) {
  const groups = new Map();
  for (const item of attractions || []) {
    const city = item.city || '城市待核验';
    if (!groups.has(city)) groups.set(city, []);
    groups.get(city).push(item.name);
  }
  for (const [city, names] of groups) {
    console.log(`  ${city}（${names.length}）`);
    for (let index = 0; index < names.length; index += 3) {
      console.log(`    ${names.slice(index, index + 3).join('　')}`);
    }
  }
}

function checkJavaScript() {
  const files = [
    'app.js', 'server/index.js', 'server/weather-service.js', 'scripts/build.js',
    'scripts/generate_static_data.js', 'scripts/report_core_attractions.js',
    'scripts/collect_mct_core_candidates.js', 'scripts/collect_ota_core_candidates.js',
    'scripts/build_core_baseline.js', 'scripts/collect_secondary_core_evidence.js',
    'scripts/xhs_core_candidates.js',
    'scripts/xhs_lazy_guides.js', 'scripts/maintenance_menu.js',
    'scripts/watch_xhs_progress.js', 'scripts/create_maintenance_tasks.js',
    'scripts/core_repair_pipeline.js', 'scripts/prepare_core_repair_package.js',
    'scripts/research_core_repairs.js', 'scripts/complete_province_pipeline.js',
    'scripts/generate_core_preview.js', 'scripts/stop_core_preview.js',
    'scripts/national_core_queue.js', 'scripts/observation_batch.js',
    'scripts/run_observation_batch.js', 'scripts/generate_observation_batch_preview.js',
  ];
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { cwd: rootDir, stdio: 'inherit', shell: false });
    if (result.status !== 0) return false;
  }
  return true;
}

function showProgress() {
  const progress = readJson(progressPath, null);
  if (!progress) {
    console.log('\n暂无采集进度。');
    return;
  }
  const alive = isProcessAlive(progress.pid);
  const total = Number(progress.total || 0);
  const index = Number(progress.index || 0);
  console.log('\n---------------- 当前任务进度 ----------------');
  console.log(`状态：${statusNames[progress.status] || progress.status || '未知'}${alive ? '（后台进程运行中）' : ''}`);
  console.log(`范围：${progress.scope || '未记录'}`);
  console.log(`进度：${index}/${total}${total ? `（${progress.percent || 0}%）` : ''}`);
  console.log(`成功：${progress.success || 0}　失败：${progress.failed || 0}`);
  if (progress.current) console.log(`当前：${progress.current}`);
  if (progress.pendingNames?.length) console.log(`待续跑：${progress.pendingNames.join('、')}`);
  if (progress.message) console.log(`说明：${progress.message}`);
  if (progress.previewUrl) console.log(`预览：${progress.previewUrl}`);
  if (progress.status === 'guide_done') {
    const province = normalizeProvinceName(String(progress.scope || '').replace(/核心缺失景点补全包$/u, ''));
    if (province) {
      const info = provinceInfo(province);
      const research = readJson(path.join(runtimeDir, `core-repair-research.${info.slug}.json`), null);
      if (research?.status === 'researching') {
        const attractions = research.attractions || [];
        const basicReady = attractions.filter(item => item.address && item.intro).length;
        console.log(`整省阶段：完整资料待补全（基本信息 ${basicReady}/${attractions.length}，路线和合规图片尚未全部核验）`);
        console.log('网页验收：尚未开放；完整资料通过门禁后才生成待验收预览。');
      }
    }
  }
  if (progress.updatedAt) console.log(`更新时间：${new Date(progress.updatedAt).toLocaleString('zh-CN')}`);
  console.log(`日志：${logPath}`);
  console.log('------------------------------------------------');
}

function currentTaskIsRunning() {
  const progress = readJson(progressPath, {});
  return ['starting', 'running', 'generating'].includes(progress.status) && isProcessAlive(progress.pid);
}

function startBackground(province = '', options = {}) {
  fs.mkdirSync(runtimeDir, { recursive: true });
  if (currentTaskIsRunning()) {
    console.log('\n已有采集任务正在运行，请先查看进度或安全停止，不能重复启动。');
    showProgress();
    return false;
  }
  if (fs.existsSync(stopPath)) fs.rmSync(stopPath, { force: true });
  if (fs.existsSync(logPath) && fs.statSync(logPath).size > 5 * 1024 * 1024) {
    fs.copyFileSync(logPath, `${logPath}.previous.log`);
    fs.truncateSync(logPath, 0);
  }
  const logFd = fs.openSync(logPath, 'a');
  const args = options.repairOnly
    ? [path.join('scripts', 'complete_province_pipeline.js'), `--province=${province}`]
    : [path.join('scripts', 'xhs_lazy_guides.js'), '--write', '--background', '--generate-after', ...(province ? [`--province=${province}`] : [])];
  const child = spawn(process.execPath, args, {
    cwd: rootDir,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  writeJsonAtomic(progressPath, {
    status: 'starting',
    message: '后台任务已启动，正在准备待更新清单。',
    scope: options.repairOnly ? `${province}核心景点完整补全` : (province || '全国'),
    index: 0,
    total: 0,
    success: 0,
    failed: 0,
    pid: child.pid,
    updatedAt: new Date().toISOString(),
  });
  child.unref();
  fs.closeSync(logFd);
  console.log(`\n已启动${province || '全国'}增量更新，后台进程 PID：${child.pid}`);
  console.log('可以关闭总控窗口；以后重新打开仍可查看进度或安全停止。');
  console.log(`运行日志：${logPath}`);
  return true;
}

function openProgressWindow() {
  const child = spawn(process.execPath, [path.join('scripts', 'watch_xhs_progress.js')], {
    cwd: rootDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  console.log('\n已打开持续进度窗口；在该窗口按 Q 可关闭。');
}

function provinceFromProgress(progress = {}) {
  const rawScope = String(progress.scope || progress.province || '')
    .replace(/核心景点完整补全|核心缺失景点补全包|核心景点补全包|核心景点补全/u, '')
    .trim();
  return normalizeProvinceName(rawScope);
}

function openCurrentTaskView() {
  const progress = readJson(progressPath, null);
  if (!progress) {
    console.log('\n暂无当前任务。请先从主菜单选择 [1] 体检或 [2] 开始补全。');
    return false;
  }

  if (progress.batchManifest) {
    const batch = readJson(progress.batchManifest, null);
    if (batch?.previewUrl && ['preview_ready', 'partially_applied'].includes(batch.status)) {
      console.log(`\n正在打开全国单源批次隔离预览：${batch.previewUrl}`);
      return openUrl(batch.previewUrl);
    }
  }

  const province = provinceFromProgress(progress);
  if (province) {
    let ready = previewStateFor(province);
    if (!ready && progress.status === 'preview_ready') {
      console.log(`\n${province}隔离预览服务未运行或版本已更新，正在自动恢复……`);
      if (runNode('generate_core_preview.js', [`--province=${province}`], { quiet: true })) {
        ready = previewStateFor(province);
      }
    }
    if (ready?.preview?.previewUrl) {
      console.log(`\n正在打开${province}隔离预览：${ready.preview.previewUrl}`);
      if (!openUrl(ready.preview.previewUrl)) console.log(`请手动访问：${ready.preview.previewUrl}`);
      return true;
    }
    if (progress.status === 'preview_ready') {
      console.log(`\n${province}隔离预览自动恢复失败，请从主菜单选择 [2] 和${province}重新生成；补全数据不会丢失。`);
      return false;
    }
  }

  if (progress.status === 'preview_ready' && progress.previewUrl) {
    console.log(`\n正在打开隔离预览：${progress.previewUrl}`);
    return openUrl(progress.previewUrl);
  }

  openProgressWindow();
  return true;
}

function stopSafely() {
  fs.mkdirSync(runtimeDir, { recursive: true });
  if (!currentTaskIsRunning()) {
    console.log('\n当前没有正在运行的采集任务。');
    return;
  }
  fs.writeFileSync(stopPath, String(Date.now()), 'utf8');
  console.log('\n已发出安全停止请求。当前景点处理完成后会停止，已经成功保存的数据不会丢失。');
}

function generateAndVerify() {
  console.log('\n开始重新生成并校验……');
  // 兼容历史观察池批次：把“已有同实体 / 非景点”的终态结论正式
  // 收口到核心清单，避免批次显示完成而全国校验仍把它们算作缺失。
  const observationTools = require('./observation_batch');
  const activeObservation = observationTools.activeBatch();
  if (activeObservation) {
    const resolution = observationTools.persistBatchResolutions(activeObservation.manifestPath);
    if (resolution.bound || resolution.removed) {
      console.log(`已自动收口观察池归类：绑定已有景点 ${resolution.bound} 项，移除非景点候选 ${resolution.removed} 项。`);
    }
    if (resolution.unresolved.length) {
      console.log(`仍有 ${resolution.unresolved.length} 项身份绑定待处理；将继续生成，最终校验会准确报告。`);
    }
  }
  if (!runNode('generate_static_data.js')) return false;
  if (!checkJavaScript()) return false;
  if (!runNode('build.js')) return false;
  if (!runNode('verify-build.js')) return false;
  if (!runNode('report_core_attractions.js', ['--all'])) return false;
  const nationalReport = readJson(path.join(rootDir, 'reports', 'core-attractions-national.json'), null);
  if (!nationalReport || !Number.isFinite(nationalReport.provinceCount) || nationalReport.provinceCount < 1) {
    console.log('全国质量报告结构异常，发布已停止。');
    return false;
  }
  const unresolved = Number(nationalReport.missing || 0) + Number(nationalReport.review || 0)
    + Math.max(0, Number(nationalReport.present || 0) - Number(nationalReport.readyCount || 0));
  if (unresolved) {
    console.log(`质量报告另有 ${unresolved} 个普通待治理项，已记录但不阻断其余合格数据发布。`);
  }
  return true;
}

function provinceInfo(provinceName) {
  const db = readJson(path.join(rootDir, 'content', 'db.json'), { provinces: {} });
  const province = db.provinces?.[provinceName];
  return province ? { ...province, slug: province.id || provinceName } : null;
}

function isFresh(filePath, days) {
  if (!fs.existsSync(filePath)) return false;
  return Date.now() - fs.statSync(filePath).mtimeMs < days * 24 * 60 * 60 * 1000;
}

function identityConflictFiles() {
  if (!fs.existsSync(runtimeDir)) return [];
  return fs.readdirSync(runtimeDir)
    .filter(name => /^core-identity-conflicts\.[a-z0-9_-]+\.json$/i.test(name))
    .map(name => ({ filePath: path.join(runtimeDir, name), data: readJson(path.join(runtimeDir, name), {}) }))
    .filter(item => item.data?.pending?.length);
}

async function resolveIdentityConflicts(rl) {
  const files = identityConflictFiles();
  if (!files.length) {
    console.log('\n当前没有待处理的景点身份歧义。');
    return true;
  }
  let selected = files[0];
  if (files.length > 1) {
    console.log('\n待处理省份：');
    files.forEach((item, index) => console.log(`[${index + 1}] ${item.data.province}（${item.data.pending.length} 项）`));
    const selection = Number(await ask(rl, '请选择省份编号，输入 0 返回：'));
    if (!selection) return false;
    selected = files[selection - 1];
    if (!selected) {
      console.log('编号无效。');
      return false;
    }
  }
  const decisionsPath = path.join(rootDir, 'content', 'core-identity-decisions.json');
  const decisions = readJson(decisionsPath, { version: 1, provinces: {} });
  decisions.version = 1;
  decisions.provinces ||= {};
  decisions.provinces[selected.data.province] ||= {};
  const unresolved = [];
  for (const conflict of selected.data.pending) {
    console.log('\n============================================================');
    console.log(`待补景点：${conflict.incoming.name}（${conflict.incoming.city || '城市待核验'}）`);
    console.log(`原因：${conflict.reason}`);
    console.log('请选择它与现有记录的关系：');
    conflict.existing.forEach((item, index) => console.log(`[${index + 1}] 同一景点，增强现有：${item.name}（${item.city || '城市待核验'}，${item.id}）`));
    const keepNew = conflict.existing.length + 1;
    console.log(`[${keepNew}] 不是同一景点，保留为独立新景点`);
    console.log('[0] 暂缓本项，稍后再决定');
    const answer = Number(await ask(rl, '请选择：'));
    if (answer >= 1 && answer <= conflict.existing.length) {
      const existing = conflict.existing[answer - 1];
      decisions.provinces[selected.data.province][conflict.baselineKey] = {
        action: 'enhance_existing', existingId: existing.id,
        incomingName: conflict.incoming.name, existingName: existing.name,
        decidedAt: new Date().toISOString(),
      };
      console.log(`已记录：${conflict.incoming.name} 将增强现有 ${existing.name}。`);
    } else if (answer === keepNew) {
      decisions.provinces[selected.data.province][conflict.baselineKey] = {
        action: 'keep_new', incomingName: conflict.incoming.name,
        decidedAt: new Date().toISOString(),
      };
      console.log(`已记录：${conflict.incoming.name} 保留为独立新景点。`);
    } else {
      unresolved.push(conflict);
      console.log('已暂缓，不会写入或误合并。');
    }
    writeJsonAtomic(decisionsPath, decisions);
  }
  writeJsonAtomic(selected.filePath, { ...selected.data, pending: unresolved, updatedAt: new Date().toISOString() });
  if (!unresolved.length) {
    const progress = readJson(progressPath, {});
    writeJsonAtomic(progressPath, {
      ...progress,
      status: 'retry_ready',
      message: `${selected.data.province}身份歧义已在总控完成选择；返回主菜单按 [2] 继续即可自动续跑。`,
      updatedAt: new Date().toISOString(),
    });
  }
  return true;
}

function validOfficialCache(value) {
  return Boolean(value?.province && Array.isArray(value.fiveA) && value.fiveA.length && Array.isArray(value.resorts) && value.sourceUrl);
}

function validOtaCache(value) {
  return Boolean(value?.province && Array.isArray(value.candidates) && value.candidates.length && value.sourceUrl);
}

function collectWithCacheFallback({ label, filePath, maxAgeDays, valid, script, province }) {
  const cached = readJson(filePath, null);
  if (isFresh(filePath, maxAgeDays) && valid(cached)) {
    console.log(`      复用${maxAgeDays}天内有效缓存，避免重复联网。`);
    return cached;
  }
  if (runNode(script, [`--province=${province}`], { quiet: true })) return readJson(filePath, null);
  if (valid(cached)) {
    console.log(`      ${label}刷新暂时失败，已安全复用上次有效缓存。`);
    return cached;
  }
  console.log(`      ${label}当前不可用且没有有效缓存，已保留断点；下次可直接继续。`);
  return null;
}

async function ensureCoreBaseline(rl, province) {
  if (!province) return true;
  const info = provinceInfo(province);
  if (!info) return false;
  const baselinePath = path.join(rootDir, 'content', `core-attractions.${info.slug}.json`);
  if (fs.existsSync(baselinePath)) return true;
  console.log(`\n============================================================`);
  console.log(`${province}核心景点清单 · 自动建立`);
  console.log('只生成本地草稿；最后仍需你确认，未确认不会写入正式清单。');
  console.log('============================================================');

  printStep(1, 6, '采集文旅部官方名单');
  const official = collectWithCacheFallback({
    label: '文旅部官方来源',
    filePath: path.join(runtimeDir, `core-official-${info.slug}.json`),
    maxAgeDays: 30,
    valid: validOfficialCache,
    script: 'collect_mct_core_candidates.js',
    province,
  });
  if (!official) return false;
  console.log(`      完成：5A景区 ${official.fiveA?.length || 0} 个，国家级旅游度假区 ${official.resorts?.length || 0} 个。`);

  printStep(2, 6, '采集携程长期热门候选');
  const ota = collectWithCacheFallback({
    label: '携程长期榜单',
    filePath: path.join(runtimeDir, `core-ota-${info.slug}.json`),
    maxAgeDays: 30,
    valid: validOtaCache,
    script: 'collect_ota_core_candidates.js',
    province,
  });
  if (!ota) return false;
  console.log(`      完成：长期景点 ${ota.candidates?.length || 0} 个，过滤临时活动 ${ota.rejectedCandidates?.length || 0} 个。`);

  printStep(3, 6, '采集小红书长期口碑候选');
  const xhsPath = path.join(runtimeDir, `core-popularity-${info.slug}.json`);
  if (isFresh(xhsPath, 90)) {
    const xhs = readJson(xhsPath, {});
    console.log(`      复用90天内结果：${xhs.candidates?.length || 0} 个，不重复请求。`);
  } else if (!runNode('xhs_core_candidates.js', [`--province=${province}`], { quiet: true })) {
    console.log('小红书候选未达到完整性标准，本次不会建立或覆盖核心清单。');
    return false;
  } else {
    const xhs = readJson(xhsPath, {});
    console.log(`      完成：长期口碑候选 ${xhs.candidates?.length || 0} 个。`);
  }

  printStep(4, 6, '交叉匹配、二次补证与状态自检');
  const pipeline = runCoreDraftPipeline({
    province,
    slug: info.slug,
    quiet: true,
    onStage(stage, attempt, errors = []) {
      if (stage === 'retry') console.log(`      检测到旧断点不一致，正在自动重建（${errors.join('；')}）。`);
      else if (attempt === 1 && stage === 'initial') console.log('      正在生成同批首轮草稿。');
    },
  });
  if (!pipeline.ok) {
    console.log(`      自动恢复未完成：${pipeline.detail || pipeline.code}`);
    console.log('      已保留现有成功断点；下次直接选择本省即可续跑。');
    return false;
  }
  const initialDraft = pipeline.initialDraft;
  const secondary = pipeline.secondary;
  console.log(`      首轮纳入 ${initialDraft.attractions?.length || 0} 个；需要二次补证 ${initialDraft.reviewCandidateCount || 0} 个。`);

  printStep(5, 6, '核验二次证据与观察池');
  console.log(`      确认 ${secondary.verifiedCount || 0} 个；已有核心覆盖 ${secondary.coveredByCoreCount || 0} 个；进入观察池 ${secondary.unresolvedCount || 0} 个。`);

  printStep(6, 6, '生成最终草稿并执行质量门禁');
  const draft = pipeline.draft;
  if (!draft || draft.baselineStatus !== 'multi_source_ready') {
    console.log('      未通过：草稿材料不完整，因此暂时不能批准。');
    if (draft?.blockingReviewCandidates?.length) {
      console.log('      阻断项：以下省榜高热度景点完成二次补证后仍只有一个可靠来源：');
      draft.blockingReviewCandidates.forEach(item => console.log(`        - ${item.name}${item.city ? `（${item.city}）` : ''}`));
    }
    console.log('      系统不会丢弃这些候选，也不会让它们绕过门禁；质量问题修复后可重新运行。');
    console.log('      当前草稿已保留，本次没有修改正式清单。');
    return false;
  }
  console.log(`      通过。`);

  console.log(`\n====================== 最终结果 ======================`);
  console.log(`核心景点：${draft.attractions.length} 个`);
  console.log(`已匹配现有资料：${draft.existingRecordBoundCount || 0} 个`);
  console.log(`需要后续补全资料：${draft.existingRecordUnboundCount || 0} 个`);
  console.log(`单源观察池：${draft.observationCandidateCount || 0} 个（保留但暂不纳入）`);
  console.log(`质量门禁：${draft.qualityGate?.passed ? '通过' : '未通过'}`);
  console.log('说明：这里只确认“哪些景点属于核心名单”，不代表景点完整资料已经补齐。');

  console.log('\n核心景点（按城市分组）：');
  printNamesByCity(draft.attractions);

  if (draft.existingRecordUnboundNames?.length) {
    console.log('\n下一阶段需要补全完整资料：');
    draft.existingRecordUnboundNames.forEach(name => console.log(`  - ${name}`));
  }
  if (draft.observationCandidates?.length) {
    console.log('\n单源观察池（不阻断本省继续，后续有新证据会自动晋级）：');
    draft.observationCandidates.forEach(item => console.log(`  - ${item.name}${item.city ? `（${item.city}）` : ''}`));
  }
  console.log('=======================================================');
  const approval = await ask(rl, '确认把以上草稿设为该省核心清单？请输入 Y 批准，其他键取消：');
  if (!/^y$/i.test(approval)) {
    console.log('已取消；草稿仍保留，可下次重新检查。');
    return false;
  }
  const approved = runNode('build_core_baseline.js', [`--province=${province}`, '--approve'], { quiet: true });
  if (approved) console.log(`已批准 ${province} 核心清单。后续进入完整资料补全阶段。`);
  return approved;
}

async function runHealthCheck(rl, province = '') {
  console.log(`\n============================================================`);
  console.log(`${province || '全国'}数据体检`);
  console.log('============================================================');
  if (province && !await ensureCoreBaseline(rl, province)) return false;
  if (!province) {
    const db = readJson(path.join(rootDir, 'content', 'db.json'), { provinces: {} });
    const approved = fs.readdirSync(path.join(rootDir, 'content')).filter(name => /^core-attractions\.[a-z0-9_-]+\.json$/i.test(name)).length;
    console.log(`全国模式当前体检已批准的 ${approved}/${Object.keys(db.provinces || {}).length} 个省级清单；新增省份请先选择“指定省份”建立并批准。`);
  }
  const reportArgs = province ? [`--province=${province}`] : ['--all'];
  console.log('\n[1/4] 检查核心景点覆盖与完整度');
  if (!runNode('report_core_attractions.js', reportArgs, { quiet: true })) return false;
  const info = province ? provinceInfo(province) : null;
  const report = province ? readJson(path.join(rootDir, 'reports', `core-attractions-${info.slug}.json`), {}) : {};
  if (province) {
    console.log(`      核心名单 ${report.baselineCount || 0} 个：资料就绪 ${report.readyCount || 0} 个，待核验 ${report.counts?.review || 0} 个，真实缺失 ${report.counts?.missing || 0} 个。`);
  }
  const taskArgs = province ? [`--province=${province}`] : [];
  console.log('\n[2/4] 生成统一维护任务');
  if (!runNode('create_maintenance_tasks.js', taskArgs, { quiet: true })) return false;
  const tasks = readJson(path.join(rootDir, 'reports', 'maintenance-tasks.json'), {});
  console.log(`      阻塞项 ${tasks.blocking?.length || 0} 个，可自动补全 ${tasks.automatic?.length || 0} 个，建议优化 ${tasks.recommended?.length || 0} 个。`);

  console.log('\n[3/4] 统计小红书攻略采集状态');
  if (!runNode('xhs_lazy_guides.js', [...taskArgs, '--stats'], { quiet: true })) return false;
  if (province) {
    const provinceData = readJson(path.join(rootDir, 'content', 'db.json'), { provinces: {} }).provinces?.[province];
    const total = provinceData?.attractions?.length || 0;
    const complete = (provinceData?.attractions || []).filter(item => item.lazy_ai_source?.source === 'xiaohongshu-dian-dian-ai-chat').length;
    console.log(`      基础库共 ${total} 条；已保存点点攻略 ${complete} 条。`);
  }
  if (!province) return true;

  const unresolvedCoreCount = (report.counts?.missing || 0) + (report.counts?.review || 0);
  if (unresolvedCoreCount === 0) {
    console.log('\n[4/4] 检查核心缺失景点补全状态');
    console.log('      核心名单已经全部就绪，无需重复建立补全档案。');
    console.log('\n体检完成：结果已经保存。该省可直接进入日常增量维护或发布验收。');
    return true;
  }

  console.log('\n[4/4] 准备核心缺失景点补全档案');
  if (!runNode('core_repair_pipeline.js', [`--province=${province}`], { quiet: true })) return false;
  const packagePath = path.join(rootDir, 'content', `core-repair-packages.${info.slug}.json`);
  let repairPackage = readJson(packagePath, null);
  const researchWorkspacePath = path.join(runtimeDir, `core-repair-research.${info.slug}.json`);
  let researchWorkspace = readJson(researchWorkspacePath, null);
  const dossier = readJson(path.join(runtimeDir, `core-repairs.${info.slug}.json`), {});
  console.log(`      需要处理 ${dossier.blockerCount || 0} 个核心景点。`);
  if (!repairPackage && dossier.blockerCount > 0) {
    const prepared = runNode('prepare_core_repair_package.js', [`--province=${province}`], { quiet: true });
    if (prepared) {
      repairPackage = readJson(packagePath, null);
      researchWorkspace = readJson(researchWorkspacePath, null);
    }
  }
  const statusLabels = {
    researching: '资料研究任务已建立，可先采集点点攻略；基本信息、路线和图片继续核验',
    collecting: '稳定资料已备齐，待采集点点懒人攻略',
    reviewed: '补全包已复核，准备质量校验',
    applied: '补全包已经应用',
  };
  const repairState = repairPackage || researchWorkspace;
  if (!repairState) {
    console.log('      当前阶段：补全档案已经生成，完整补全包尚未建立。');
    console.log('      下一步：为这些景点补齐基本信息、旅行指南、懒人攻略、可靠图片和来源。');
    console.log('      保护措施：不生成占位内容，不直接新增，不影响现有正常景点。');
  } else {
    console.log(`      当前阶段：${statusLabels[repairState.status] || `补全包状态 ${repairState.status || '未知'}`}。`);
  }
  if (repairState?.status === 'researching') {
    const research = readJson(path.join(rootDir, 'reports', `core-research-${info.slug}.json`), {});
    const sourced = (research.items || []).filter(item => item.discoveredSourceCount >= 2).length;
    const officialBasic = (research.items || []).filter(item => item.hasOfficialBasicInfo).length;
    console.log(`      研究进度：${research.total || repairState.attractions?.length || 0} 个待补；${officialBasic} 个已有官方基础信息，${sourced} 个已有至少两条候选来源。`);
    console.log('      下一步可先采集点点攻略；基本信息、路线和图片未核验完整前不会写入正式数据。');
  }
  if (repairPackage?.status === 'collecting') {
    const repairTargets = runNode('xhs_lazy_guides.js', [`--province=${province}`, '--repair-only', '--list'], { quiet: true });
    const lazyOverrides = readJson(path.join(rootDir, 'content', 'lazy-guide-overrides.json'), {});
    const pending = (repairPackage.attractions || []).filter(item => lazyOverrides[item.id]?.lazy_ai_source?.source !== 'xiaohongshu-dian-dian-ai-chat');
    if (!pending.length) {
      if (!runNode('core_repair_pipeline.js', [`--province=${province}`, '--finalize'], { quiet: true })) return false;
      repairPackage = readJson(packagePath, null);
      console.log('      点点攻略已齐，补全包已通过最终质量闸门。');
    } else if (repairTargets) {
      console.log(`      待采集点点攻略 ${pending.length} 个；下一步会只处理这批缺失景点。`);
    }
  }
  if (repairPackage?.status === 'reviewed') {
    if (!runNode('core_repair_pipeline.js', [`--province=${province}`, '--check'], { quiet: true })) return false;
    const previewState = readJson(path.join(runtimeDir, 'previews', info.slug, 'state.json'), null);
    const currentBuildFingerprint = previewBuildFingerprint();
    const previewNeedsRebuild = previewState?.status !== 'ready'
      || !processIsRunning(previewState?.pid)
      || !currentBuildFingerprint
      || previewState.buildFingerprint !== currentBuildFingerprint
      || new Date(previewState.generatedAt || 0).getTime() < new Date(repairPackage.updatedAt || 0).getTime();
    if (previewNeedsRebuild && !runNode('generate_core_preview.js', [`--province=${province}`], { quiet: true })) return false;
    const preview = readJson(path.join(runtimeDir, 'previews', info.slug, 'state.json'), null);
    console.log(`      隔离预览已就绪：${preview?.previewUrl || '生成失败'}`);
    console.log('      体检只报告状态，不会在这里写入 beta。请从主菜单 [2] 进入最终验收。');
  }
  console.log('\n体检完成：结果已经保存。返回主菜单后可选择“开始 / 继续增量补全”。');
  return true;
}

function provinceCollectionMode(province) {
  if (!province) return { allowed: true, repairOnly: false };
  const info = provinceInfo(province);
  const report = readJson(path.join(rootDir, 'reports', `core-attractions-${info.slug}.json`), {});
  const hasMissingIdentity = (report.items || []).some(item => item.status === 'missing' || item.status === 'review');
  if (!hasMissingIdentity) return { allowed: true, repairOnly: false };
  const repairPackage = readJson(path.join(rootDir, 'content', `core-repair-packages.${info.slug}.json`), null);
  const researchWorkspace = readJson(path.join(runtimeDir, `core-repair-research.${info.slug}.json`), null);
  if (['researching', 'collecting', 'reviewed'].includes(repairPackage?.status) && Array.isArray(repairPackage.attractions) && repairPackage.attractions.length) {
    return { allowed: true, repairOnly: ['researching', 'collecting'].includes(repairPackage.status) };
  }
  if (researchWorkspace?.status === 'researching' && Array.isArray(researchWorkspace.attractions) && researchWorkspace.attractions.length) {
    return { allowed: true, repairOnly: true };
  }
  console.log('\n发现真实缺失景点，但尚无已复核的补全包。');
  console.log('当前还不能开始攻略采集，因为缺失景点尚未具备基本信息、图片和路线框架。');
  console.log('请先完成补全包；为避免重名、错图和旧模板数据，本次不会直接自动新增。');
  return { allowed: false, repairOnly: false };
}

function previewStateFor(province) {
  const info = provinceInfo(province);
  if (!info) return null;
  const packagePath = path.join(rootDir, 'content', `core-repair-packages.${info.slug}.json`);
  const repairPackage = readJson(packagePath, null);
  const preview = readJson(path.join(runtimeDir, 'previews', info.slug, 'state.json'), null);
  if (repairPackage?.status !== 'reviewed' || preview?.status !== 'ready') return null;
  if (!processIsRunning(preview.pid)) return null;
  const packageIds = [
    ...(repairPackage.attractions || []).map(item => item.id),
    ...Object.keys(repairPackage.overrides || {}),
  ].sort();
  const previewIds = (preview.attractionIds || []).slice().sort();
  if (JSON.stringify(packageIds) !== JSON.stringify(previewIds)) return null;
  if (new Date(preview.generatedAt).getTime() < new Date(repairPackage.updatedAt).getTime()) return null;
  const currentBuildFingerprint = previewBuildFingerprint();
  if (!currentBuildFingerprint || preview.buildFingerprint !== currentBuildFingerprint) return null;
  if (localEnvHasAmapKey() && preview.ratingMode !== 'live-amap-enabled') return null;
  return { info, repairPackage, preview };
}

function openUrl(url) {
  if (!url) return false;
  try {
    const child = process.platform === 'win32'
      ? spawn('explorer.exe', [url], { detached: true, stdio: 'ignore', windowsHide: false })
      : spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch (error) {
    console.log(`无法自动打开浏览器，请手动访问：${url}`);
    return false;
  }
}

function captureFiles(filePaths) {
  return filePaths.map(filePath => ({
    filePath,
    existed: fs.existsSync(filePath),
    content: fs.existsSync(filePath) ? fs.readFileSync(filePath) : null,
  }));
}

function restoreFiles(snapshot) {
  for (const item of snapshot) {
    if (item.existed) {
      fs.mkdirSync(path.dirname(item.filePath), { recursive: true });
      fs.writeFileSync(item.filePath, item.content);
    } else if (fs.existsSync(item.filePath)) {
      fs.rmSync(item.filePath, { force: true });
    }
  }
}

function reportItemReady(item) {
  return item?.status === 'present' && (item.matches || []).some(match => match.quality?.ready === true);
}

function validateIncrementalRelease(beforeReport, afterReport, repairPackage) {
  const beforeIssues = new Set((beforeReport?.items || []).filter(item => !reportItemReady(item)).map(item => item.key));
  const afterItems = new Map((afterReport?.items || []).map(item => [item.key, item]));
  const expectedKeys = new Set([
    ...(repairPackage?.attractions || []).map(item => item.baselineKey),
    ...Object.values(repairPackage?.overrides || {}).map(item => item.baselineKey),
  ].filter(Boolean));
  const unresolvedApproved = [...expectedKeys].filter(key => !reportItemReady(afterItems.get(key)));
  const newRegressions = [...afterItems.values()]
    .filter(item => !reportItemReady(item) && !beforeIssues.has(item.key))
    .map(item => item.key);
  const historicalIssues = [...afterItems.values()]
    .filter(item => !reportItemReady(item) && beforeIssues.has(item.key) && !expectedKeys.has(item.key))
    .map(item => item.key);
  return {
    passed: unresolvedApproved.length === 0 && newRegressions.length === 0,
    expectedCount: expectedKeys.size,
    unresolvedApproved,
    newRegressions,
    historicalIssues,
  };
}

function buildSelectedProvince(province) {
  const info = provinceInfo(province);
  runNode('report_core_attractions.js', [`--province=${province}`], { quiet: true });
  const reportPath = path.join(rootDir, 'reports', `core-attractions-${info.slug}.json`);
  const beforeReport = readJson(reportPath, { items: [] });
  const repairPackage = readJson(path.join(rootDir, 'content', `core-repair-packages.${info.slug}.json`), {});
  const transactionFiles = [
    path.join(rootDir, 'content', `manual-attractions.${info.slug}-core.json`),
    path.join(rootDir, 'content', 'attraction-overrides.json'),
    path.join(rootDir, 'content', `core-attractions.${info.slug}.json`),
    path.join(rootDir, 'content', `core-repair-packages.${info.slug}.json`),
  ];
  const snapshot = captureFiles(transactionFiles);
  const alreadyApplied = repairPackage.status === 'applied';
  console.log(alreadyApplied
    ? '\n检测到该补全包已写入 beta，正在执行幂等重建与验收……'
    : '\n正在写入 beta 并重新生成可访问数据……');
  const steps = [
    ...(!alreadyApplied ? [() => runNode('core_repair_pipeline.js', [`--province=${province}`, '--apply'])] : []),
    () => runNode('generate_static_data.js'),
    () => checkJavaScript(),
    () => runNode('build.js'),
    () => runNode('verify-build.js'),
    () => runNode('report_core_attractions.js', [`--province=${province}`]),
  ];
  let incrementalGate = null;
  const pipelinePassed = steps.every(step => step());
  if (pipelinePassed) {
    incrementalGate = validateIncrementalRelease(beforeReport, readJson(reportPath, { items: [] }), repairPackage);
    if (!incrementalGate.passed) {
      if (incrementalGate.unresolvedApproved.length) console.log(`本次批准项仍未就绪：${incrementalGate.unresolvedApproved.join('、')}`);
      if (incrementalGate.newRegressions.length) console.log(`本次写入引入新问题：${incrementalGate.newRegressions.join('、')}`);
    }
  }
  if (!pipelinePassed || !incrementalGate?.passed) {
    console.log(`\n${province}最终验收未通过，正在自动回滚本次写入……`);
    restoreFiles(snapshot);
    runNode('generate_static_data.js', [], { quiet: true });
    runNode('build.js', [], { quiet: true });
    console.log('已恢复到批准前状态；隔离预览和已采集资料仍保留，可修复后继续，不会留下半成品。');
    return false;
  }
  console.log(`增量验收通过：本次批准的 ${incrementalGate.expectedCount} 个核心项均已就绪，且未引入新问题。`);
  if (incrementalGate.historicalIssues.length) {
    console.log(`另有 ${incrementalGate.historicalIssues.length} 个批准前已存在的待治理项，已保留到维护任务，不阻断本次合格写入。`);
  }
  runNode('create_maintenance_tasks.js', [`--province=${province}`], { quiet: true });
  runNode('stop_core_preview.js', [`--province=${province}`], { quiet: true });
  writeJsonAtomic(progressPath, {
    status: 'done',
    stage: 'applied',
    scope: `${province}核心景点完整补全`,
    message: `${province}已写入 beta，静态数据、构建与本次增量验收全部通过。`,
    index: 5,
    total: 5,
    percent: 100,
    success: info ? readJson(path.join(rootDir, 'reports', `core-attractions-${info.slug}.json`), {}).readyCount || 0 : 0,
    failed: 0,
    updatedAt: new Date().toISOString(),
  });
  return true;
}

async function runProvinceCompletion(rl, province) {
  const provinceMeta = provinceInfo(province);
  const previousPreview = provinceMeta
    ? readJson(path.join(runtimeDir, 'previews', provinceMeta.slug, 'state.json'), null)
    : null;
  // A missing preview is a new province, not an old preview that needs a rating refresh.
  // Without this guard, configuring an AMap key skips core-baseline creation and starts
  // the repair pipeline before the province has an approved core list.
  if (shouldRefreshRatingPreview(localEnvHasAmapKey(), previousPreview)) {
    console.log('\n检测到新配置的高德 Web 服务 Key，先刷新该省评分证据并重建隔离预览。');
    console.log('这一步不会写入 beta；完成后再次选择该省进行最终验收。');
    return startBackground(province, { repairOnly: true });
  }
  const ready = previewStateFor(province);
  if (ready) {
    console.log(`\n============================================================`);
    console.log(`${province}完整补全 · 最终验收`);
    console.log('============================================================');
    const totalItems = (ready.repairPackage.attractions?.length || 0) + Object.keys(ready.repairPackage.overrides || {}).length;
    console.log(`待写入景点：${totalItems} 个（新增 ${ready.repairPackage.attractions?.length || 0}，增强现有 ${Object.keys(ready.repairPackage.overrides || {}).length}）`);
    printNamesByCity(ready.repairPackage.attractions || []);
    if (ready.repairPackage.warnings?.length) {
      console.log(`\n非阻断警告 ${ready.repairPackage.warnings.length} 条（请在隔离预览重点检查）：`);
      ready.repairPackage.warnings.forEach(value => console.log(`- ${value}`));
    }
    console.log(`\n隔离预览：${ready.preview.previewUrl}`);
    openUrl(ready.preview.previewUrl);
    console.log('请在预览中逐项检查：基本信息、旅行指南、懒人攻略和大图。');
    const approval = await ask(rl, '确认无误并写入 beta？请输入 Y 批准，其他键暂不写入：');
    if (!/^y$/i.test(approval)) {
      console.log('已保留 reviewed 补全包和隔离预览，beta 数据未修改。');
      return true;
    }
    return buildSelectedProvince(province);
  }

  if (!await runHealthCheck(rl, province)) return false;
  const afterHealth = previewStateFor(province);
  if (afterHealth) {
    console.log('\n隔离预览已生成。再次从主菜单选择 [2] 和同一省份即可完成最终验收。');
    openUrl(afterHealth.preview.previewUrl);
    return true;
  }
  const mode = provinceCollectionMode(province);
  if (!mode.allowed) return false;
  return startBackground(province, { repairOnly: mode.repairOnly });
}

function startObservationBatch(manifestPath) {
  if (currentTaskIsRunning()) {
    console.log('\n已有后台任务正在运行，不能重复启动。');
    showProgress();
    return false;
  }
  if (fs.existsSync(stopPath)) fs.rmSync(stopPath, { force: true });
  const logFd = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, [path.join('scripts', 'run_observation_batch.js'), `--manifest=${manifestPath}`], {
    cwd: rootDir, detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true,
  });
  child.unref();
  fs.closeSync(logFd);
  writeJsonAtomic(progressPath, {
    status: 'starting', stage: 'observation_batch', scope: '全国单源观察池批量补全',
    message: '全国批次已启动；正在按省份顺序补全，失败项会保留断点。',
    index: 0, total: 0, success: 0, failed: 0, pid: child.pid,
    batchManifest: manifestPath, updatedAt: new Date().toISOString(),
  });
  console.log(`\n全国单源批次已在后台启动（PID ${child.pid}）。`);
  console.log('可以关闭总控；稍后从任务中心查看进度，完成后同一入口会打开统一预览。');
  return true;
}

async function applyObservationBatch(manifestPath) {
  const tools = require('./observation_batch');
  let manifest = tools.readJson(manifestPath, null);
  if (!manifest) return false;
  const resolution = tools.persistBatchResolutions(manifestPath);
  if (resolution.bound || resolution.removed) {
    console.log(`\n已收口批次归类：绑定已有景点 ${resolution.bound} 项，移除非景点候选 ${resolution.removed} 项。`);
  }
  if (resolution.unresolved.length) {
    console.log(`另有 ${resolution.unresolved.length} 项无法自动绑定，将保留给最终校验准确提示。`);
  }
  let success = 0;
  let failed = 0;
  for (const state of manifest.provinces || []) {
    if (['applied', 'resolved'].includes(state.status)) continue;
    // 同一省存在失败项时，也必须允许已经完成且通过预览的项目独立写入。
    // 失败项继续保留断点，不能再拖住该省的全部成功项目。
    if (state.status !== 'ready' && !(state.readyKeys || []).length) continue;
    // Re-filter immediately before the irreversible apply step. This also handles
    // old batches whose saved package predates a later identity/non-attraction decision.
    const coverage = tools.filterReviewedPackage(manifestPath, state.slug);
    tools.applyCoverageToState(state, coverage);
    manifest = tools.updateBatch(manifestPath, { provinces: manifest.provinces });
    const keysToApply = [...(state.readyKeys || [])];
    const namesToApply = [...(state.readyNames || [])];
    if (!keysToApply.length) continue;
    state.selectedKeys = keysToApply;
    state.selectedNames = namesToApply;
    state.status = 'ready';
    console.log(`\n正在写入 ${state.province}（${state.selectedNames.length} 项）……`);
    if (buildSelectedProvince(state.province)) {
      const remainingKeys = [...(state.pendingKeys || [])];
      const remainingNames = [...(state.pendingNames || [])];
      state.status = remainingKeys.length ? 'failed' : 'applied';
      state.appliedAt = new Date().toISOString();
      success += state.selectedKeys.length;
      if (remainingKeys.length) {
        state.selectedKeys = remainingKeys;
        state.selectedNames = remainingNames;
        state.error = `${remainingKeys.length} 项保留断点。`;
      }
    } else {
      state.status = 'failed';
      state.error = '最终写入或增量验收失败，已自动回滚该省。';
      failed += state.selectedKeys.length;
    }
    manifest = tools.updateBatch(manifestPath, { provinces: manifest.provinces });
  }
  const pending = manifest.provinces.filter(item => ['failed', 'queued'].includes(item.status));
  manifest = tools.updateBatch(manifestPath, {
    status: pending.length ? 'retry_ready' : 'applied',
    appliedAt: new Date().toISOString(), summary: { applied: success, failed },
  });
  writeJsonAtomic(progressPath, {
    status: pending.length ? 'retry_ready' : 'done', stage: 'observation_batch_applied',
    scope: '全国单源观察池批量补全',
    index: manifest.provinces.filter(item => item.status === 'applied').length,
    total: manifest.provinces.length,
    percent: manifest.provinces.length ? Math.round(manifest.provinces.filter(item => item.status === 'applied').length / manifest.provinces.length * 1000) / 10 : 100,
    success, failed, pendingNames: pending.flatMap(item => item.selectedNames),
    message: pending.length ? `已写入 ${success} 项；${failed} 项保留断点。` : `本批次 ${success} 项已全部写入 beta。`,
    batchManifest: manifestPath, updatedAt: new Date().toISOString(),
  });
  console.log(pending.length ? `\n已写入 ${success} 项；${failed} 项已回滚并保留断点。` : `\n本批次 ${success} 项已全部写入 beta。`);
  return failed === 0;
}

async function observationBatchControl(rl) {
  const tools = require('./observation_batch');
  const active = tools.activeBatch();
  if (active && !['applied', 'cancelled'].includes(active.manifest.status)) {
    const { manifestPath } = active;
    let manifest = active.manifest;
    if (manifest.status === 'retry_ready') manifest = tools.reconcileBatch(manifestPath);
    const applied = manifest.provinces.filter(item => item.status === 'applied').reduce((sum, item) => sum + item.selectedKeys.length, 0);
    const resolved = manifest.provinces.reduce((sum, item) => sum + (item.resolutions?.length || 0), 0);
    const ready = manifest.provinces.filter(item => item.status === 'ready').reduce((sum, item) => sum + item.selectedKeys.length, 0);
    const pending = manifest.provinces.filter(item => ['queued', 'running', 'failed'].includes(item.status))
      .reduce((sum, item) => sum + (item.pendingKeys?.length || item.selectedKeys.length), 0);
    console.log(`\n当前批次：共 ${manifest.selectedCount} 项；已写入 ${applied}，已归类 ${resolved}，待预览 ${ready}，待续跑 ${pending}。`);
    if (manifest.status === 'running' || currentTaskIsRunning()) {
      showProgress();
      return true;
    }
    if (manifest.status === 'user_action') {
      const progress = readJson(progressPath, {});
      showProgress();
      if (progress.status === 'login_required') {
        console.log('请先在任务中心选择 [3] 完成登录，再回到 [6] 续跑。');
        return true;
      }
      if (progress.status === 'decision_required') {
        console.log('请先在任务中心选择 [5] 处理景点身份歧义，再回到 [6] 续跑。');
        return true;
      }
      if (progress.status === 'restricted') {
        const retry = await ask(rl, '平台限制期间断点已保存。现在尝试续跑？请输入 Y，其他键稍后再试：');
        if (!/^y$/i.test(retry)) return true;
      }
      tools.updateBatch(manifestPath, { status: 'retry_ready', currentProvince: '' });
      console.log('已确认前置问题解除，正在从保存的省份和景点断点继续。');
      return startObservationBatch(manifestPath);
    }
    if (pending > 0) {
      if (manifest.status === 'preview_ready' || manifest.previewUrl) {
        manifest = tools.updateBatch(manifestPath, { status: 'retry_ready', previewUrl: '', previewItemCount: 0, currentProvince: '' });
      }
      console.log(`已完成的 ${ready} 项会保留；现在只续跑剩余 ${pending} 项，不会提前写入半个批次。`);
      return startObservationBatch(manifestPath);
    }
    if (ready > 0 && manifest.status !== 'preview_ready') {
      console.log('全部所选景点已经补齐，正在生成统一隔离预览。');
      return startObservationBatch(manifestPath);
    }
    if (manifest.status === 'preview_ready' && ready > 0) {
      const previewState = readJson(path.join(runtimeDir, 'previews', 'observation-batch', 'state.json'), null);
      if (previewState?.batchId !== manifest.id || !processIsRunning(previewState?.pid)) {
        console.log('旧预览服务已经失效，正在依据当前批次自动重建；不会重复联网采集。');
        tools.updateBatch(manifestPath, { status: 'retry_ready', previewUrl: '', previewItemCount: 0 });
        return startObservationBatch(manifestPath);
      }
      if (manifest.previewUrl) {
        console.log(`统一隔离预览：${manifest.previewUrl}`);
        openUrl(manifest.previewUrl);
      }
      const approval = await ask(rl, '确认预览中的成功项无误并一次写入 beta？请输入 Y 批准，其他键保留不写：');
      if (/^y$/i.test(approval)) return applyObservationBatch(manifestPath);
      console.log('批次资料、预览和断点均已保留，beta 尚未写入。');
      return true;
    }
    console.log('正在从已保存断点继续；已成功项目不会重复采集。');
    return startObservationBatch(manifestPath);
  }

  const items = tools.scanObservationPool();
  if (!items.length) {
    console.log('\n当前没有可补选的单源观察池候选。');
    return true;
  }
  tools.printObservationPool(items);
  const selected = tools.parseSelection(await ask(rl, '请选择要恢复并补全的景点：'), items);
  if (!selected.length) {
    console.log('\n未选择任何景点。');
    return true;
  }
  const groups = new Map();
  for (const item of selected) {
    if (!groups.has(item.province)) groups.set(item.province, []);
    groups.get(item.province).push(item.name);
  }
  console.log(`\n已选择 ${selected.length} 项，涉及 ${groups.size} 个省份：`);
  for (const [province, names] of groups) console.log(`  ${province}：${names.join('、')}`);
  const approval = await ask(rl, '确认建立安全批次并立即开始完整补全？请输入 Y，其他键取消：');
  if (!/^y$/i.test(approval)) return true;
  const batch = tools.createBatch(selected);
  return startObservationBatch(batch.manifestPath);
}

function menu() {
  console.clear();
  console.log('============================================================');
  console.log('中国旅游地图 - 全国数据维护总控');
  console.log('============================================================');
  console.log('[1] 一键数据体检（发现缺失并生成任务清单）');
  console.log('[2] 开始 / 继续增量补全（后台运行，可断点续跑）');
  console.log('[3] 任务中心（登录、进度、停止）');
  console.log('[4] 生成发布数据并完整验收');
  console.log('[0] 退出');
  console.log('============================================================');
  console.log('保护策略：只补缺失项，不覆盖已有合格点点攻略；失败项留待下次续跑。');
}

async function ask(rl, question) {
  return new Promise(resolve => rl.question(question, answer => resolve(answer.trim())));
}

function provinceStatus(province) {
  const info = provinceInfo(province);
  if (!info) return '未知';
  const baselinePath = path.join(rootDir, 'content', `core-attractions.${info.slug}.json`);
  if (fs.existsSync(baselinePath)) {
    const report = readJson(path.join(rootDir, 'reports', `core-attractions-${info.slug}.json`), {});
    if (report.baselineCount && report.readyCount === report.baselineCount) return '完整资料已通过验收';
    return '核心清单已建立，完整资料待补全';
  }
  const queue = readJson(nationalQueuePath, { provinces: {} }).provinces?.[province] || {};
  const draft = readJson(path.join(runtimeDir, `core-attractions.${info.slug}.draft.json`), null);
  if (draft?.baselineStatus === 'multi_source_ready' && draft.qualityGate?.secondaryEvidenceComplete !== false) return '核心清单待人工批准';
  if (draft && !draft.qualityGate?.secondaryEvidenceComplete) return '核心候选待二次补证';
  if (queue.lastError) return '当前阶段失败，可断点续跑';
  if (queue.xhsReady) return '核心候选已完成口碑验证，待生成清单草稿';
  if (queue.officialReady && queue.otaReady) return '核心候选待口碑验证';
  if (queue.officialReady || queue.otaReady) return '核心候选来源采集中';
  return '核心候选来源待采集';
}

async function chooseScope(rl) {
  console.log('\n[1] 推荐批次（每批3-6省，可断点续跑）');
  console.log('[2] 单个省份（编号选择）');
  console.log('[3] 全国概览（只查看，不批量请求平台）');
  console.log('[0] 取消');
  const scope = await ask(rl, '请选择范围：');
  if (scope === '0' || !scope) return null;
  if (scope === '3') return { type: 'all', label: '全国概览', provinces: [] };
  if (scope === '1') {
    console.log('');
    provinceBatches.forEach((batch, index) => {
      const states = batch.provinces.map(item => `${item}:${provinceStatus(item)}`).join('　');
      console.log(`[${index + 1}] ${batch.name}（${batch.provinces.join('、')}）`);
      console.log(`    状态：${states}`);
    });
    const selected = Number(await ask(rl, '请选择批次编号：'));
    const batch = provinceBatches[selected - 1];
    return batch ? { type: 'batch', label: batch.name, provinces: batch.provinces } : null;
  }
  if (scope !== '2') {
    console.log('\n无效范围。');
    return null;
  }
  const db = readJson(path.join(rootDir, 'content', 'db.json'), { provinces: {} });
  const names = Object.keys(db.provinces || {});
  console.log('');
  names.forEach((name, index) => console.log(`[${String(index + 1).padStart(2, '0')}] ${name}　${provinceStatus(name)}`));
  const selected = Number(await ask(rl, '请选择省份编号：'));
  const province = names[selected - 1];
  return province ? { type: 'province', label: province, provinces: [province] } : null;
}

async function runNationalScope(rl, scope, collect) {
  const selectedArgs = scope.provinces.length ? [`--provinces=${scope.provinces.join(',')}`] : [];
  if (!scope.provinces.length) {
    console.log('\n全国批量采集为避免平台限制，必须先选择推荐批次；当前仅显示队列概览。');
    return runNode('national_core_queue.js');
  }
  if (!runNode('national_core_queue.js', [...selectedArgs, '--collect-static'])) return false;
  if (!collect) return runNode('national_core_queue.js', [...selectedArgs, '--review']);
  console.log(`\n开始 ${scope.label} 核心候选口碑验证。此阶段用于确认核心景点名单，不代表完整景点资料已经补齐。`);
  console.log('登录失效或访问受限时会在当前省安全停止，下次选择同一批次即可续跑。');
  if (!runNode('national_core_queue.js', [...selectedArgs, '--collect-xhs', '--build-drafts', '--review'])) return false;
  const approval = await ask(rl, '确认批准本批次中已完成的多源核心清单草稿？请输入 Y 批准，其他键暂不写入：');
  if (!/^y$/i.test(approval)) {
    console.log('已保留草稿，未写入省级核心清单。');
    return true;
  }
  if (!runNode('national_core_queue.js', [...selectedArgs, '--approve-drafts'])) return false;
  for (const province of scope.provinces) {
    const info = provinceInfo(province);
    if (!info || !fs.existsSync(path.join(rootDir, 'content', `core-attractions.${info.slug}.json`))) continue;
    if (!runNode('report_core_attractions.js', [`--province=${province}`])) return false;
    if (!runNode('core_repair_pipeline.js', [`--province=${province}`])) return false;
  }
  return true;
}

async function taskCenter(rl) {
  console.log('\n---------------- 任务中心 ----------------');
  console.log('[1] 查看当前进度');
  console.log('[2] 打开当前任务（运行中看进度，待验收打开隔离预览）');
  console.log('[3] 登录 / 刷新小红书点点状态');
  console.log('[4] 安全停止后台任务');
  console.log('[5] 处理景点身份歧义（同名、跨城市、多实体）');
  console.log('[6] 全国单源观察池批量补选（多选后自动补全、统一预览、一次写入）');
  console.log('[0] 返回');
  const action = await ask(rl, '请选择：');
  if (action === '1') showProgress();
  else if (action === '2') openCurrentTaskView();
  else if (action === '3') runNode('xhs_lazy_guides.js', ['--login']);
  else if (action === '4') stopSafely();
  else if (action === '5') await resolveIdentityConflicts(rl);
  else if (action === '6') await observationBatchControl(rl);
}

async function main() {
  process.title = '中国旅游地图 - 全国数据维护总控';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  while (true) {
    menu();
    const choice = await ask(rl, '请选择：');
    if (choice === '0') break;
    if (choice === '1') {
      const scope = await chooseScope(rl);
      if (scope) {
        const ok = scope.type === 'province' ? await runHealthCheck(rl, scope.provinces[0]) : await runNationalScope(rl, scope, false);
        console.log(ok ? '\n数据体检完成。' : '\n数据体检未完成，请查看上方信息。');
      }
    } else if (choice === '2') {
      const scope = await chooseScope(rl);
      if (scope?.type === 'province') {
        const province = scope.provinces[0];
        await runProvinceCompletion(rl, province);
      } else if (scope) {
        await runNationalScope(rl, scope, true);
      }
    } else if (choice === '3') await taskCenter(rl);
    else if (choice === '4') console.log(generateAndVerify() ? '\n生成与校验全部通过。' : '\n生成或校验失败，请查看上方信息。');
    else console.log('\n无效选项，请重新选择。');
    await ask(rl, '\n按回车键返回主菜单……');
  }
  rl.close();
}

function shouldRefreshRatingPreview(hasAmapKey, previousPreview) {
  return Boolean(hasAmapKey && previousPreview && previousPreview.ratingMode !== 'live-amap-enabled');
}

if (require.main === module) {
  main().catch(error => {
    console.error(`总控运行失败：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { shouldRefreshRatingPreview, provinceFromProgress, validateIncrementalRelease, buildSelectedProvince, observationBatchControl, applyObservationBatch };
