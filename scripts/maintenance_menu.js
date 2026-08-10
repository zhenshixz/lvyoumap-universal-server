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
  stopped: '已安全停止',
  login_required: '登录已失效',
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
    'scripts/xhs_lazy_guides.js', 'scripts/maintenance_menu.js',
    'scripts/watch_xhs_progress.js',
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
  return runNode('report_core_attractions.js', ['--strict']);
}

function menu() {
  console.clear();
  console.log('============================================================');
  console.log('中国旅游地图 - 全国数据维护总控');
  console.log('============================================================');
  console.log('[1] 扫码登录 / 刷新小红书点点登录状态');
  console.log('[2] 全国懒人攻略增量更新（后台运行）');
  console.log('[3] 指定省份懒人攻略增量更新（后台运行）');
  console.log('[4] 查看当前进度');
  console.log('[5] 打开持续进度窗口');
  console.log('[6] 安全停止后台更新');
  console.log('[7] 查看全国待更新统计');
  console.log('[8] 重新生成数据并完整校验');
  console.log('[0] 退出');
  console.log('============================================================');
  console.log('保护策略：只补缺失项，不覆盖已有合格点点攻略；失败项留待下次续跑。');
}

async function ask(rl, question) {
  return new Promise(resolve => rl.question(question, answer => resolve(answer.trim())));
}

async function main() {
  process.title = '中国旅游地图 - 全国数据维护总控';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  while (true) {
    menu();
    const choice = await ask(rl, '请选择：');
    if (choice === '0') break;
    if (choice === '1') runNode('xhs_lazy_guides.js', ['--login']);
    else if (choice === '2') startBackground();
    else if (choice === '3') {
      const input = await ask(rl, '请输入省级名称（例如：贵州、福建、北京市）：');
      const province = normalizeProvinceName(input);
      if (province) startBackground(province);
      else if (input) console.log('\n没有找到该省份，请使用常见省级名称后重试。');
      else console.log('\n未输入省份，已取消。');
    } else if (choice === '4') showProgress();
    else if (choice === '5') openProgressWindow();
    else if (choice === '6') stopSafely();
    else if (choice === '7') runNode('xhs_lazy_guides.js', ['--stats']);
    else if (choice === '8') console.log(generateAndVerify() ? '\n生成与校验全部通过。' : '\n生成或校验失败，请查看上方信息。');
    else console.log('\n无效选项，请重新选择。');
    await ask(rl, '\n按回车键返回主菜单……');
  }
  rl.close();
}

main().catch(error => {
  console.error(`总控运行失败：${error.message}`);
  process.exitCode = 1;
});
