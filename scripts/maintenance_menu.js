const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

const rootDir = path.join(__dirname, '..');
const runtimeDir = path.join(rootDir, '.runtime');
const progressPath = path.join(runtimeDir, 'xhs-lazy-progress.json');
const stopPath = path.join(runtimeDir, 'xhs-lazy-stop.flag');
const logPath = path.join(runtimeDir, 'xhs-lazy-process.log');

const statusNames = {
  starting: '正在启动后台任务',
  login_waiting: '等待扫码登录',
  login_ready: '登录状态可用',
  running: '正在采集',
  generating: '正在生成数据',
  done: '已完成',
  partial: '部分完成，可继续补全',
  stopped: '已安全停止',
  login_required: '登录已失效',
  restricted: '平台限制访问，已安全暂停',
  error: '发生错误',
  recovered: '已恢复采集结果',
};

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

function isProcessAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function runNode(script, args = []) {
  const result = spawnSync(process.execPath, [path.join('scripts', script), ...args], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) console.error(`运行失败：${result.error.message}`);
  return result.status === 0;
}

function checkJavaScript() {
  const files = [
    'app.js', 'server/index.js', 'server/weather-service.js', 'scripts/build.js',
    'scripts/generate_static_data.js', 'scripts/report_core_attractions.js',
    'scripts/collect_mct_core_candidates.js', 'scripts/collect_ota_core_candidates.js',
    'scripts/build_core_baseline.js', 'scripts/xhs_core_candidates.js',
    'scripts/xhs_lazy_guides.js', 'scripts/maintenance_menu.js',
    'scripts/watch_xhs_progress.js', 'scripts/create_maintenance_tasks.js',
    'scripts/core_repair_pipeline.js',
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
  if (progress.message) console.log(`说明：${progress.message}`);
  if (progress.updatedAt) console.log(`更新时间：${new Date(progress.updatedAt).toLocaleString('zh-CN')}`);
  console.log(`日志：${logPath}`);
  console.log('------------------------------------------------');
}

function currentTaskIsRunning() {
  const progress = readJson(progressPath, {});
  return ['starting', 'running', 'generating'].includes(progress.status) && isProcessAlive(progress.pid);
}

function startBackground(province = '') {
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
  const args = [path.join('scripts', 'xhs_lazy_guides.js'), '--write', '--background', '--generate-after'];
  if (province) args.push(`--province=${province}`);
  const child = spawn(process.execPath, args, {
    cwd: rootDir,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  writeJsonAtomic(progressPath, {
    status: 'starting',
    message: '后台任务已启动，正在准备待更新清单。',
    scope: province || '全国',
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
  if (!runNode('generate_static_data.js')) return false;
  if (!checkJavaScript()) return false;
  if (!runNode('build.js')) return false;
  if (!runNode('verify-build.js')) return false;
  return runNode('report_core_attractions.js', ['--all', '--strict']);
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

async function ensureCoreBaseline(rl, province) {
  if (!province) return true;
  const info = provinceInfo(province);
  if (!info) return false;
  const baselinePath = path.join(rootDir, 'content', `core-attractions.${info.slug}.json`);
  if (fs.existsSync(baselinePath)) return true;
  console.log(`\n${province}尚未建立核心景点清单，开始自动建立多源草稿。`);
  console.log('流程：文旅部官方身份 → 携程热门目的地 → 小红书长期口碑 → 高德本地底库交叉匹配。');
  if (!runNode('collect_mct_core_candidates.js', [`--province=${province}`])) return false;
  if (!runNode('collect_ota_core_candidates.js', [`--province=${province}`])) return false;
  const xhsPath = path.join(runtimeDir, `core-popularity-${info.slug}.json`);
  if (isFresh(xhsPath, 90)) {
    console.log('已复用90天内的小红书口碑候选，不重复请求。');
  } else if (!runNode('xhs_core_candidates.js', [`--province=${province}`])) {
    console.log('小红书候选未达到完整性标准，本次不会建立或覆盖核心清单。');
    return false;
  }
  if (!runNode('build_core_baseline.js', [`--province=${province}`])) return false;
  const draftPath = path.join(runtimeDir, `core-attractions.${info.slug}.draft.json`);
  const draft = readJson(draftPath, null);
  if (!draft || draft.baselineStatus !== 'multi_source_ready') {
    console.log('多源草稿不完整，本次停止，不写入正式清单。');
    return false;
  }
  console.log(`\n---------------- ${province}核心清单草稿 ----------------`);
  console.log(`官方5A：${draft.officialCount}　官方度假区候选：${draft.officialResortCandidateCount || 0}　最终纳入：${draft.attractions.length}　待确认：${draft.reviewCandidateCount || 0}`);
  console.log(`现有记录已绑定：${draft.existingRecordBoundCount || 0}　现有库未命中：${draft.existingRecordUnboundCount || 0}　重复别名已合并：${draft.mergedDuplicateCount || 0}`);
  draft.attractions.forEach((item, index) => console.log(`${String(index + 1).padStart(2, '0')}. ${item.name}　${item.preferredId ? '[已绑定现有记录]' : '[现有库未命中，仅列为缺失待办]'}`));
  if (draft.reviewCandidates?.length) console.log(`待确认但暂不纳入：${draft.reviewCandidates.map(item => item.name).join('、')}`);
  console.log('----------------------------------------------------------');
  const approval = await ask(rl, '确认把以上草稿设为该省核心清单？请输入 Y 批准，其他键取消：');
  if (!/^y$/i.test(approval)) {
    console.log('已取消；草稿仍保留，可下次重新检查。');
    return false;
  }
  return runNode('build_core_baseline.js', [`--province=${province}`, '--approve']);
}

async function runHealthCheck(rl, province = '') {
  console.log(`\n开始${province || '全国'}数据体检……`);
  if (province && !await ensureCoreBaseline(rl, province)) return false;
  if (!province) {
    const db = readJson(path.join(rootDir, 'content', 'db.json'), { provinces: {} });
    const approved = fs.readdirSync(path.join(rootDir, 'content')).filter(name => /^core-attractions\.[a-z0-9_-]+\.json$/i.test(name)).length;
    console.log(`全国模式当前体检已批准的 ${approved}/${Object.keys(db.provinces || {}).length} 个省级清单；新增省份请先选择“指定省份”建立并批准。`);
  }
  const reportArgs = province ? [`--province=${province}`] : ['--all'];
  if (!runNode('report_core_attractions.js', reportArgs)) return false;
  const taskArgs = province ? [`--province=${province}`] : [];
  if (!runNode('create_maintenance_tasks.js', taskArgs)) return false;
  if (!runNode('xhs_lazy_guides.js', [...taskArgs, '--stats'])) return false;
  if (!province) return true;
  if (!runNode('core_repair_pipeline.js', [`--province=${province}`])) return false;
  const info = provinceInfo(province);
  const packagePath = path.join(rootDir, 'content', `core-repair-packages.${info.slug}.json`);
  const repairPackage = readJson(packagePath, null);
  if (repairPackage?.status === 'reviewed' && runNode('core_repair_pipeline.js', [`--province=${province}`, '--check'])) {
    const approval = await ask(rl, '补全包已通过全部质量闸门，是否写入正式数据层？请输入 Y 批准，其他键暂不写入：');
    if (/^y$/i.test(approval)) {
      if (!runNode('core_repair_pipeline.js', [`--province=${province}`, '--apply'])) return false;
      if (!runNode('report_core_attractions.js', reportArgs)) return false;
      if (!runNode('create_maintenance_tasks.js', taskArgs)) return false;
    }
  }
  return true;
}

function canStartProvinceCollection(province) {
  if (!province) return true;
  const info = provinceInfo(province);
  const report = readJson(path.join(rootDir, 'reports', `core-attractions-${info.slug}.json`), {});
  const hasMissingIdentity = (report.items || []).some(item => item.status === 'missing' || item.status === 'review');
  if (!hasMissingIdentity) return true;
  const repairPackage = readJson(path.join(rootDir, 'content', `core-repair-packages.${info.slug}.json`), null);
  if (repairPackage?.status === 'reviewed' && Array.isArray(repairPackage.attractions) && repairPackage.attractions.length) return true;
  console.log('\n发现真实缺失景点，但尚无已复核的补全包。');
  console.log('总控已生成缺失档案；为避免重名、错图和旧模板数据，本次不会直接自动新增。');
  return false;
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

async function chooseScope(rl) {
  console.log('\n[1] 全国');
  console.log('[2] 指定省份');
  console.log('[0] 取消');
  const scope = await ask(rl, '请选择范围：');
  if (scope === '0' || !scope) return null;
  if (scope === '1') return '';
  if (scope !== '2') {
    console.log('\n无效范围。');
    return null;
  }
  const input = await ask(rl, '请输入省级名称（例如：贵州、福建、北京市）：');
  const province = normalizeProvinceName(input);
  if (!province) console.log('\n没有找到该省份，请使用常见省级名称后重试。');
  return province || null;
}

async function taskCenter(rl) {
  console.log('\n---------------- 任务中心 ----------------');
  console.log('[1] 查看当前进度');
  console.log('[2] 打开持续进度窗口');
  console.log('[3] 登录 / 刷新小红书点点状态');
  console.log('[4] 安全停止后台任务');
  console.log('[0] 返回');
  const action = await ask(rl, '请选择：');
  if (action === '1') showProgress();
  else if (action === '2') openProgressWindow();
  else if (action === '3') runNode('xhs_lazy_guides.js', ['--login']);
  else if (action === '4') stopSafely();
}

async function main() {
  process.title = '中国旅游地图 - 全国数据维护总控';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  while (true) {
    menu();
    const choice = await ask(rl, '请选择：');
    if (choice === '0') break;
    if (choice === '1') {
      const province = await chooseScope(rl);
      if (province !== null) console.log(await runHealthCheck(rl, province) ? '\n数据体检完成。' : '\n数据体检未完成，请查看上方信息。');
    } else if (choice === '2') {
      const province = await chooseScope(rl);
      if (province !== null && await runHealthCheck(rl, province) && canStartProvinceCollection(province)) startBackground(province);
    } else if (choice === '3') await taskCenter(rl);
    else if (choice === '4') console.log(generateAndVerify() ? '\n生成与校验全部通过。' : '\n生成或校验失败，请查看上方信息。');
    else console.log('\n无效选项，请重新选择。');
    await ask(rl, '\n按回车键返回主菜单……');
  }
  rl.close();
}

main().catch(error => {
  console.error(`总控运行失败：${error.message}`);
  process.exitCode = 1;
});
