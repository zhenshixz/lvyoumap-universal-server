// One resumable writer; publishes previews only, never content or formal Git.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const runtime = path.join(root, '.runtime', 'attraction-gallery-batch');
const jobFile = path.join(runtime, 'codex-background.json');
const lockFile = path.join(runtime, 'codex-background.lock');
const stopFile = path.join(runtime, 'codex-background.stop');
const logFile = path.join(runtime, 'codex-background.log');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const write = (file, value) => { fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2)); fs.renameSync(file + '.tmp', file); };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const state = () => read(path.join(runtime, 'state.json'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = text => console.log(new Date().toISOString(), text);
function validate() {
  if (path.basename(root).toLowerCase() !== 'lvyoumap-universal-serverbeta') throw Error('Run only from beta.');
  for (const file of ['state.json']) if (!fs.existsSync(path.join(runtime, file))) throw Error('Missing ' + file);
  const p = spawnSync('python', ['-c', 'import PIL,cv2,numpy'], { windowsHide: true });
  if (p.status !== 0) throw Error('Python requires Pillow, opencv-python and numpy.');
  require('cheerio'); require('opencc-js');
}
async function stage(command, args, timeout = 240000) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: root, windowsHide: true, stdio: 'inherit', env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
    let timer;
    const finish = code => { clearTimeout(timer); resolve(code === 0); };
    child.once('error', () => finish(-1)); child.once('exit', finish);
    timer = setTimeout(() => {
      log('Stage timeout; retaining completed checkpoints: ' + args[0]);
      child.kill();
    }, timeout);
  });
}
async function main() {
  validate();
  if (process.argv.includes('--check')) { console.log('Dependencies and beta path OK'); return; }
  if (process.argv.includes('--stop')) { fs.writeFileSync(stopFile, 'stop after current batch'); console.log('Stop requested; checkpoint is preserved.'); return; }
  if (process.argv.includes('--start')) {
    if (fs.existsSync(lockFile) && alive(read(lockFile).pid)) { console.log('Already running, PID ' + read(lockFile).pid); return; }
    fs.rmSync(stopFile, { force: true });
    const fd = fs.openSync(logFile, 'a');
    const child = spawn(process.execPath, [__filename], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
    child.unref(); fs.closeSync(fd);
    await sleep(1800);
    if (!alive(child.pid)) throw Error('Worker exited. See ' + logFile);
    console.log('Background started. PID ' + child.pid + '\nStatus: ' + jobFile + '\nLog: ' + logFile);
    return;
  }
  if (fs.existsSync(lockFile)) {
    if (alive(read(lockFile).pid)) throw Error('Another worker owns collection state.');
    fs.unlinkSync(lockFile);
  }
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
  let job;
  try {
    job = fs.existsSync(jobFile) ? read(jobFile) : { createdAt: new Date().toISOString(), attempts: {}, errors: [], ids: state().items.filter(x => x.status === 'pending_sources' || x.status === 'ready_for_visual_review').map(x => x.id) };
    job.status = 'running'; job.pid = process.pid;
    let lastPreview = 0;
    while (!fs.existsSync(stopFile)) {
      const current = state();
      const byId = new Map(current.items.map(x => [x.id, x]));
      const ready = x => x && x.status === 'ready_for_user_review' && x.selected?.length >= 3;
      job.ready = job.ids.filter(id => ready(byId.get(id))).length;
      job.total = job.ids.length; job.updatedAt = new Date().toISOString();
      write(jobFile, job);
      if (Date.now() - lastPreview > 30 * 60000) {
        await stage(process.execPath, ['scripts/start_attraction_gallery_batch_preview.js', '--background'], 120000);
        lastPreview = Date.now();
      }
      // Complete a first pass before bounded retries. No endlessly retried last item.
      const pending = job.ids.filter(id => !ready(byId.get(id)) && (job.attempts[id] || 0) < 2)
        .sort((a, b) => (job.attempts[a] || 0) - (job.attempts[b] || 0)
          || (byId.get(b)?.selected?.length || 0) - (byId.get(a)?.selected?.length || 0));
      if (!pending.length) { job.status = job.ready === job.total ? 'awaiting_review' : 'pass_complete_with_unresolved'; break; }
      const ids = pending.slice(0, 8);
      job.currentIds = ids; write(jobFile, job);
      log(`Collect ${job.ready}/${job.total}; batch ${ids.join(',')}`);
      const ok = await stage(process.execPath, ['scripts/collect_attraction_galleries_batch.js', '--ids=' + ids.join(','), '--max-items=8', '--concurrency=4']);
      for (const id of ids) job.attempts[id] = (job.attempts[id] || 0) + 1;
      if (!ok) job.errors.push({ at: new Date().toISOString(), ids, reason: 'collector_timeout_or_exit' });
      await stage('python', ['scripts/render_attraction_gallery_batch.py', '--ids=' + ids.join(','), '--contact-sheet-items=0'], 90000);
      job.errors = job.errors.slice(-100); write(jobFile, job);
      // Compact only new review files; external image URLs are never changed.
      await stage('python', ['scripts/codex_compact_gallery_cache.py'], 180000);
      await sleep(ok ? 1500 : 15000);
    }
    if (fs.existsSync(stopFile)) job.status = 'paused';
    job.currentIds = []; job.updatedAt = new Date().toISOString(); write(jobFile, job);
    await stage(process.execPath, ['scripts/start_attraction_gallery_batch_preview.js', '--background'], 120000);
    log('Finished: ' + job.status);
  } finally { fs.rmSync(lockFile, { force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
