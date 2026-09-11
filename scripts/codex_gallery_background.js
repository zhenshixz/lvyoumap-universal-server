// Beta-only resumable worker. The supervisor owns recovery, never collection data.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ready, excluded, recordBatch, candidates } = require('./gallery_background_policy');
const { runStage, terminate, isOwnedOrphan } = require('./gallery_background_process');
const { replaceCheckpoint } = require('./gallery_checkpoint_io');
const root = path.resolve(__dirname, '..');
const runtime = path.join(root, '.runtime', 'attraction-gallery-batch');
const file = suffix => path.join(runtime, 'codex-background' + suffix);
const jobFile = file('.json'), lockFile = file('.lock'), stopFile = file('.stop'), supervisorFile = file('-supervisor.json');
const read = name => JSON.parse(fs.readFileSync(name, 'utf8').replace(/^\uFEFF/, ''));
const write = (name, data) => { fs.writeFileSync(name + '.tmp', JSON.stringify(data, null, 2)); replaceCheckpoint(name + '.tmp', name); };
const alive = pid => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const state = () => read(path.join(runtime, 'state.json'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = message => console.log(new Date().toISOString(), message);
function validate() {
  if (path.basename(root).toLowerCase() !== 'lvyoumap-universal-serverbeta') throw Error('Run only from beta.');
  if (!fs.existsSync(path.join(runtime, 'state.json'))) throw Error('Missing gallery checkpoint.');
  const p = spawnSync('python', ['-c', 'import PIL,cv2,numpy'], { windowsHide: true, timeout: 20000 });
  if (p.status !== 0) throw Error('Python requires Pillow, opencv-python and numpy.');
  require('cheerio'); require('opencc-js'); require.resolve('vue/dist/vue.global.prod.js');
}
function release(name) { try { if (read(name).pid === process.pid) fs.unlinkSync(name); } catch {} }
function acquire(name) {
  if (fs.existsSync(name)) { if (alive(read(name).pid)) throw Error('Already running: ' + name); fs.unlinkSync(name); }
  fs.writeFileSync(name, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
}
let job;
function save() { job.updatedAt = new Date().toISOString(); write(jobFile, job); }
function issue(reason, ids = []) {
  job.errors.push({ at: new Date().toISOString(), reason, ids }); job.errors = job.errors.slice(-60);
  job.lastError = reason; log(reason);
}
async function stage(command, args, label, timeout = 240000) {
  job.phase = label; job.resumeAt = null; job.stageStartedAt = new Date().toISOString(); save();
  const result = await runStage(command, args, {
    cwd: root, timeout,
    onSpawn: pid => { job.childPid = pid; save(); },
    onTimeout: () => log('Stage timeout: ' + label),
  });
  job.childPid = null;
  if (!result.ok) issue(`${label}: ${result.timedOut ? 'timeout' : result.error || 'exit ' + result.code}`, job.currentIds || []);
  save(); return result.ok;
}
function summarize(current) {
  const byId = new Map(current.items.map(x => [x.id, x]));
  const items = job.ids.map(id => byId.get(id)).filter(Boolean);
  job.total = job.ids.length; job.ready = items.filter(ready).length; job.excluded = items.filter(excluded).length;
  job.processed = job.ids.filter(id => job.visits[id] > 0).length;
  job.waitingRetry = job.ids.filter(id => !ready(byId.get(id)) && job.nextAt[id] > Date.now()).length;
  job.unresolved = job.total - job.ready - job.excluded;
  job.currentNames = (job.currentIds || []).map(id => byId.get(id)?.name || id);
  job.recentIssues = items.filter(x => !ready(x) && (x.pendingExplanation || x.error))
    .sort((a,b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 5)
    .map(x => ({ name: x.name, reason: String(x.pendingExplanation || x.error).slice(0, 280) }));
  save();
}
async function waitUntil(until, phase) {
  job.phase = phase; job.resumeAt = new Date(until).toISOString(); save();
  while (Date.now() < until && !fs.existsSync(stopFile)) await sleep(Math.min(5000, until - Date.now()));
  job.resumeAt = null;
}
async function worker() {
  validate(); acquire(lockFile); let heartbeat;
  try {
    job = read(jobFile);
    for (const key of ['attempts', 'visits', 'transient', 'nextAt', 'failures', 'visualFailures']) job[key] ||= {};
    job.errors ||= [];
    if (job.version !== 2) {
      fs.copyFileSync(jobFile, file(`-before-v2-${Date.now()}.json`));
      const legacy = job.attempts; job.attempts = {}; job.legacyUncertain = 0;
      for (const item of state().items) {
        if (!legacy[item.id]) continue;
        if (Date.parse(item.updatedAt) >= Date.parse(job.createdAt)) {
          job.visits[item.id] = 1;
          if (item.retryable) job.transient[item.id] = 1; else job.attempts[item.id] = 1;
        } else job.legacyUncertain++;
      }
      job.version = 2;
    }
    job.pid = process.pid; job.status = 'running'; job.childPid = null;
    if (job.inflight) { recordBatch(job, state().items, job.inflight.ids, job.inflight.run); delete job.inflight; }
    save();
    heartbeat = setInterval(() => { try { job.heartbeatAt = new Date().toISOString(); save(); } catch (e) { console.error('Heartbeat save failed:', e.message); } }, 5000);
    let lastPreview = Number(job.lastPreviewAt || Date.now()), failures = 0;
    while (!fs.existsSync(stopFile)) {
      try {
        const current = state(); summarize(current);
        const visual = current.items.filter(x => job.ids.includes(x.id) && x.status === 'ready_for_visual_review' && (job.visualFailures[x.id] || 0) < 3).slice(0, 8);
        if (visual.length) {
          job.currentIds = visual.map(x => x.id);
          if (!await stage('python', ['scripts/render_attraction_gallery_batch.py', '--ids=' + job.currentIds.join(','), '--contact-sheet-items=0'], 'filtering', 90000)) {
            for (const id of job.currentIds) job.visualFailures[id] = (job.visualFailures[id] || 0) + 1;
            throw Error('Filtering failed; preserving candidates for retry.');
          }
          continue;
        }
        const queue = candidates(job, current.items);
        if (!queue.eligible.length) { job.status = job.unresolved === 0 ? 'awaiting_review' : 'pass_complete_with_unresolved'; break; }
        if (Date.parse(current.resumeAfter) > Date.now()) { await waitUntil(Date.parse(current.resumeAfter) + 1500, 'source_cooldown'); continue; }
        if (!queue.pending.length) { await waitUntil(queue.wakeAt, 'retry_wait'); continue; }
        const ids = queue.pending.slice(0, 8); job.currentIds = ids; summarize(current);
        const run = `${Date.now()}-${process.pid}`; job.inflight = { run, ids }; save();
        log(`Collect ${job.ready}/${job.total}; batch ${ids.join(',')}`);
        const ok = await stage(process.execPath, ['scripts/collect_attraction_galleries_batch.js', '--ids=' + ids.join(','), '--background-run=' + run, '--max-items=8', '--concurrency=4'], 'collecting');
        const after = state(); const completed = recordBatch(job, after.items, ids, run);
        for (const id of ids.filter(id => !completed.includes(id))) {
          if (!ok || !after.resumeAfter) {
            job.failures[id] = (job.failures[id] || 0) + 1;
            job.nextAt[id] = Date.now() + Math.min(1800000, 60000 * 2 ** job.failures[id]);
          }
        }
        job.lastBatch = { at: new Date().toISOString(), requested: ids.length, completed: completed.length, ok };
        delete job.inflight; save();
        if (completed.length && !await stage('python', ['scripts/render_attraction_gallery_batch.py', '--ids=' + completed.join(','), '--contact-sheet-items=0'], 'filtering', 90000)) throw Error('Filtering failed; retrying from checkpoint.');
        await stage('python', ['scripts/codex_compact_gallery_cache.py'], 'compacting', 30000);
        summarize(state());
        if (Date.now() - lastPreview > 30 * 60000) {
          if (await stage(process.execPath, ['scripts/start_attraction_gallery_batch_preview.js', '--background'], 'preview', 120000)) job.lastPreviewAt = Date.now();
          lastPreview = Date.now();
        }
        failures = 0; await waitUntil(Date.now() + (ok ? 1500 : 30000), 'between_batches');
      } catch (error) {
        issue(error.message); failures++;
        await waitUntil(Date.now() + Math.min(300000, failures * 30000), 'recovering');
      }
    }
    if (fs.existsSync(stopFile)) job.status = 'paused';
    job.currentIds = []; summarize(state());
    await stage(process.execPath, ['scripts/start_attraction_gallery_batch_preview.js', '--background'], 'preview', 120000);
    job.phase = 'idle'; save(); log('Finished: ' + job.status);
  } finally { clearInterval(heartbeat); release(lockFile); }
}
async function supervisor() {
  acquire(supervisorFile); const info = { pid: process.pid, status: 'running', restarts: 0 };
  try {
    while (!fs.existsSync(stopFile)) {
      if (fs.existsSync(lockFile) && alive(read(lockFile).pid)) { await sleep(5000); continue; }
      const previous = read(jobFile);
      let orphan = false;
      try { orphan = alive(previous.childPid) && isOwnedOrphan(previous.childPid, previous.pid); }
      catch (error) { info.status = 'orphan_verification_failed'; info.lastError = error.message; write(supervisorFile, info); await sleep(30000); continue; }
      if (orphan) {
        info.status = 'waiting_for_previous_stage'; write(supervisorFile, info);
        if (Date.now() - Date.parse(previous.stageStartedAt || previous.updatedAt) > 5 * 60000) {
          log('Verified orphan stage exceeded recovery deadline; terminating its process tree.');
          await terminate({ pid: previous.childPid, exitCode: null, signalCode: null });
        }
        await sleep(5000); continue;
      }
      const child = spawn(process.execPath, [__filename, '--worker'], { cwd: root, windowsHide: true, stdio: 'inherit' });
      info.workerPid = child.pid; info.status = 'running'; write(supervisorFile, info);
      const watchdog = setInterval(() => {
        try {
          const j = read(jobFile);
          if (j.pid === child.pid && Date.now() - Date.parse(j.heartbeatAt || j.updatedAt) > 10 * 60000) { log('Worker heartbeat stalled; stopping owned process tree.'); void terminate(child); }
        } catch {}
      }, 30000);
      const code = await new Promise(resolve => { child.once('error', () => resolve(-1)); child.once('close', resolve); });
      clearInterval(watchdog);
      if (code === 0 && ['paused', 'awaiting_review', 'pass_complete_with_unresolved'].includes(read(jobFile).status)) break;
      info.restarts++; info.status = 'recovering'; info.lastExit = code; info.updatedAt = new Date().toISOString(); write(supervisorFile, info);
      log('Worker exited; restarting after backoff. Exit ' + code);
      for (let i = 0; i < Math.min(60, info.restarts * 6) && !fs.existsSync(stopFile); i++) await sleep(5000);
    }
  } finally { release(supervisorFile); }
}
async function main() {
  if (path.basename(root).toLowerCase() !== 'lvyoumap-universal-serverbeta') throw Error('Run only from beta.');
  if (process.argv.includes('--stop')) { fs.writeFileSync(stopFile, 'stop after current batch'); console.log('Stop requested; checkpoint preserved.'); return; }
  if (process.argv.includes('--check')) { validate(); console.log('Dependencies and beta path OK'); return; }
  if (process.argv.includes('--start')) {
    validate();
    for (const name of [supervisorFile, lockFile]) if (fs.existsSync(name) && alive(read(name).pid)) { console.log('Already running, PID ' + read(name).pid); return; }
    fs.rmSync(stopFile, { force: true });
    const fd = fs.openSync(file('.log'), 'a');
    const child = spawn(process.execPath, [__filename, '--supervise'], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
    child.unref(); fs.closeSync(fd); await sleep(1800);
    if (!alive(child.pid)) throw Error('Supervisor exited; see codex-background.log');
    console.log('Background supervisor started, PID ' + child.pid); return;
  }
  if (process.argv.includes('--worker')) return worker();
  if (process.argv.includes('--supervise')) return supervisor();
  throw Error('Use --start, --stop or --check.');
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
