const { spawn, spawnSync } = require('child_process');
function isOwnedOrphan(pid, parentPid) {
  if (!Number.isInteger(pid) || !Number.isInteger(parentPid) || pid <= 0 || parentPid <= 0) return false;
  if (process.platform !== 'win32') return false;
  const command = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if($p -and $p.ParentProcessId -eq ${parentPid} -and $p.CommandLine -match '(collect_attraction_galleries_batch\\.js|render_attraction_gallery_batch\\.py|codex_compact_gallery_cache\\.py|start_attraction_gallery_batch_preview\\.js)'){exit 0}; exit 1`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { windowsHide:true, stdio:'ignore', timeout:10000 });
  if (result.error || result.status === null) throw Error('Unable to verify previous child process; refusing overlapping writers.');
  return result.status === 0;
}
async function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== 'win32') { child.kill('SIGKILL'); return; }
  await new Promise(resolve => {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.once('error', resolve); killer.once('close', resolve);
  });
}
function runStage(command, args, options) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: options.cwd, windowsHide: true, stdio: options.stdio || 'inherit', env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
    options.onSpawn?.(child.pid || null);
    let timedOut = false, error;
    const timer = setTimeout(() => { timedOut = true; options.onTimeout?.(); void terminate(child); }, options.timeout);
    child.once('error', e => { error = e.message; });
    // close, not exit: do not start another writer until all child handles close.
    child.once('close', code => { clearTimeout(timer); resolve({ ok: code === 0 && !timedOut, code, timedOut, error }); });
  });
}
module.exports = { runStage, terminate, isOwnedOrphan };
