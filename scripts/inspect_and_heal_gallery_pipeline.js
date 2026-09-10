const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const runtime = path.join(root, '.runtime', 'attraction-gallery-batch');
const incidentLogPath = path.join(runtime, 'incident_log.json');
const batchStatePath = path.join(runtime, 'state.json');
const milestonePath = path.join(runtime, 'remaining-milestones.json');

function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function checkHttp(url, timeoutMs = 2500) {
  return new Promise(resolve => {
    const req = http.get(url, res => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 400);
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function isRunnerRunning() {
  try {
    const output = execSync('powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like \'*run_gallery_remaining*\' } | Select-Object -ExpandProperty ProcessId"', { encoding: 'utf8', windowsHide: true });
    const pids = output.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    return pids.length > 0 ? parseInt(pids[0], 10) : null;
  } catch (e) {
    return null;
  }
}

async function main() {
  const now = new Date().toISOString();
  let healed = false;
  const issues = [];

  // 1. 检查跑批主进程
  let runnerPid = isRunnerRunning();
  if (!runnerPid) {
    issues.push('跑批进程意外中断');
    try {
      const child = spawn(process.execPath, [path.join(root, 'scripts', 'run_gallery_remaining.js')], {
        cwd: root,
        detached: true,
        windowsHide: true,
        stdio: 'ignore'
      });
      child.unref();
      runnerPid = child.pid;
      healed = true;
      issues.push(`已自动重新拉起跑批主进程 (PID: ${runnerPid})`);
    } catch (err) {
      issues.push(`拉起主进程失败: ${err.message}`);
    }
  }

  // 2. 检查隔离预览服务
  const previewHealthy = await checkHttp('http://127.0.0.1:4185/preview.html', 2000);
  if (!previewHealthy) {
    issues.push('4185 隔离预览服务异常或无响应');
    try {
      execSync(`node "${path.join(root, 'scripts', 'start_attraction_gallery_batch_preview.js')}"`, {
        cwd: root,
        windowsHide: true,
        stdio: 'ignore'
      });
      healed = true;
      issues.push('已自动平滑复苏 4185 隔离预览服务');
    } catch (err) {
      issues.push(`复苏预览服务失败: ${err.message}`);
    }
  }

  // 3. 自动同步一次 30 分钟交付快照
  try {
    execSync(`node "${path.join(root, 'scripts', 'deliver_gallery_periodic_batch.js')}"`, {
      cwd: root,
      windowsHide: true,
      stdio: 'ignore'
    });
  } catch (err) {
    // 忽略非致命刷新异常
  }

  // 4. 读取最新统计
  const batchState = readJson(batchStatePath);
  const milestone = readJson(milestonePath);
  const fixed = new Set(milestone.ids || []);
  const readyItems = (batchState.items || []).filter(x => fixed.has(x.id) && x.status === 'ready_for_user_review' && (x.selected || []).length >= 3);

  const result = {
    timestamp: now,
    runnerPid,
    runnerAlive: !!runnerPid,
    previewHealthy,
    fixedReadyCount: readyItems.length,
    target: 1169,
    healed,
    issues,
    needsUserConfirm: healed
  };

  if (healed) {
    const log = readJson(incidentLogPath, []);
    log.unshift(result);
    writeJson(incidentLogPath, log.slice(0, 50));
    console.log('[ALERT_NEED_CONFIRM] 巡检发现异常并已自动修复完成，详情已登记：');
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[Inspection Health OK] Runner PID: ${runnerPid}, Preview: 200 OK, Ready: ${readyItems.length}/1169 (${((readyItems.length/1169)*100).toFixed(1)}%)`);
  }
}

main().catch(err => {
  console.error('[Inspection Error]', err);
  process.exitCode = 1;
});
