const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rootDir = path.join(__dirname, '..');
const progressPath = path.join(rootDir, '.runtime', 'xhs-lazy-progress.json');
const logPath = path.join(rootDir, '.runtime', 'xhs-lazy-process.log');
const statusNames = {
  starting: '正在启动后台任务', login_waiting: '等待扫码登录', login_ready: '登录状态可用', running: '正在采集',
  generating: '正在生成数据', done: '已完成', stopped: '已安全停止',
  login_required: '登录已失效', error: '发生错误', recovered: '已恢复采集结果',
};

function readProgress() {
  try {
    return JSON.parse(fs.readFileSync(progressPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return Number(pid) > 0;
  } catch {
    return false;
  }
}

function render() {
  const progress = readProgress();
  console.clear();
  console.log('============================================================');
  console.log('中国旅游地图 - 懒人攻略实时进度');
  console.log('============================================================');
  if (!progress) {
    console.log('暂无进度记录，请先在总控中启动更新。');
  } else {
    const total = Number(progress.total || 0);
    const index = Number(progress.index || 0);
    const alive = isAlive(progress.pid);
    console.log(`状态：${statusNames[progress.status] || progress.status || '未知'}${alive ? '（后台进程运行中）' : ''}`);
    console.log(`范围：${progress.scope || '未记录'}`);
    console.log(`进度：${index}/${total}${total ? `（${progress.percent || 0}%）` : ''}`);
    console.log(`成功：${progress.success || 0}　失败：${progress.failed || 0}`);
    if (progress.current) console.log(`当前：${progress.current}`);
    if (progress.message) console.log(`说明：${progress.message}`);
    if (progress.updatedAt) console.log(`更新时间：${new Date(progress.updatedAt).toLocaleString('zh-CN')}`);
    console.log(`后台 PID：${progress.pid || '-'}${alive ? '（运行中）' : '（未运行）'}`);
  }
  console.log('------------------------------------------------------------');
  console.log(`详细日志：${logPath}`);
  console.log('每 3 秒自动刷新；按 Q 关闭此窗口。');
}

process.title = '中国旅游地图 - 懒人攻略实时进度';
readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.on('keypress', (_text, key) => {
    if (key?.name === 'q' || (key?.ctrl && key?.name === 'c')) process.exit(0);
  });
}
render();
setInterval(render, 3000);
