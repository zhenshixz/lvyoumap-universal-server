// Fixed 20% milestones for the remaining gallery work; never publishes content.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { namesFor } = require('./gallery_web_sources');
const { SOURCE_PLAN_VERSION } = require('./gallery_source_policy');
const root = path.resolve(__dirname, '..');
const runtime = path.join(root, '.runtime', 'attraction-gallery-batch');
const manifestFile = path.join(runtime, 'remaining-milestones.json');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const state = () => read(path.join(runtime, 'state.json'));
const save = data => {
  fs.writeFileSync(manifestFile + '.tmp', JSON.stringify(data, null, 2));
  fs.renameSync(manifestFile + '.tmp', manifestFile);
};
const run = (executable, args) => {
  const result = spawnSync(executable, args, { cwd: root, windowsHide: true, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Stage failed: ${args[0]} (exit ${result.status})`);
};
async function main() {
  const manifest = fs.existsSync(manifestFile) ? read(manifestFile) : {
    createdAt: new Date().toISOString(),
    ids: state().items.filter(x => x.status === 'pending_sources').map(x => x.id),
    milestone: 1, attempted: [], status: 'running',
  };
  const target = Math.ceil(manifest.ids.length * manifest.milestone / 5);
  const fixed = new Set(manifest.ids);
  let articleIndex = {};
  try { articleIndex = read(path.join(runtime, 'wikipedia-titles.json')); } catch { /* Optional. */ }
  const articleFound = x => namesFor(x).some(n => articleIndex[n]);
  const freshDiscovery = x => fs.existsSync(path.join(runtime, 'discovered-pages', `${x.id}-trip.json`));
  // Older runs recorded a whole batch even when only its first group ran.
  const actual = new Map(state().items.map(x => [x.id, x]));
  manifest.attempted = [...new Set(manifest.attempted)].filter(id =>
    Date.parse(actual.get(id)?.updatedAt) >= Date.parse(manifest.createdAt) && actual.get(id)?.sourcePlanVersion === SOURCE_PLAN_VERSION);
  save(manifest);
  console.log(`Fixed remaining cohort: ${fixed.size}; milestone ${manifest.milestone}/5 requires ${target} completed galleries.`);
  let cycle = 0;
  while (true) {
    const items = state().items.filter(x => fixed.has(x.id));
    const complete = items.filter(x => x.status === 'ready_for_user_review' && x.selected?.length >= 3);
    manifest.completed = complete.length;
    manifest.updatedAt = new Date().toISOString();
    if (complete.length >= target) {
      manifest.status = 'awaiting_user_review'; save(manifest);
      run('python', ['scripts/render_attraction_gallery_batch.py', `--ids=${complete.map(x => x.id).join(',')}`, '--contact-sheet-items=12']);
      run(process.execPath, ['scripts/start_attraction_gallery_batch_preview.js']);
      console.log(`Milestone ready: ${complete.length}/${fixed.size}; awaiting user review before next 20%.`);
      return;
    }
    const attempted = new Set(manifest.attempted);
    const next = items.filter(x => x.status !== 'ready_for_user_review' && !attempted.has(x.id))
      .sort((a, b) => Number(freshDiscovery(b))-Number(freshDiscovery(a)) || Number(articleFound(b)) - Number(articleFound(a)) || (b.selected?.length || 0) - (a.selected?.length || 0)).slice(0, 24);
    if (!next.length) {
      manifest.status = 'needs_source_strategy'; save(manifest);
      console.log(`Coverage pass ended: ${complete.length}/${target}. Remaining items require source repair; nothing was marked complete or published.`);
      return;
    }
    const ids = next.map(x => x.id).join(',');
    const batchStartedAt = Date.now();
    run(process.execPath, ['scripts/collect_attraction_galleries_batch.js', `--ids=${ids}`, `--max-items=${next.length}`, '--concurrency=4']);
    run('python', ['scripts/render_attraction_gallery_batch.py', `--ids=${ids}`, '--contact-sheet-items=0']);
    const after = state();
    const updatedIds = after.items.filter(x => next.some(n => n.id === x.id) && Date.parse(x.updatedAt) >= batchStartedAt).map(x => x.id);
    const attemptedBatch = updatedIds.length ? updatedIds : next.map(x => x.id);
    manifest.attempted = [...new Set([...manifest.attempted, ...attemptedBatch])];
    const done = after.items.filter(x => fixed.has(x.id) && x.status === 'ready_for_user_review').length;
    manifest.completed = done;
    console.log(`Milestone progress: ${done}/${target}; inspected ${manifest.attempted.length}/${fixed.size}.`);
    save(manifest);
    if (after.resumeAfter && Date.parse(after.resumeAfter) > Date.now()) {
      console.log(`Source cooldown; resume after ${after.resumeAfter}.`);
      while (Date.parse(after.resumeAfter) > Date.now()) await new Promise(resolve => setTimeout(resolve, Math.min(30000, Date.parse(after.resumeAfter) - Date.now())));
    }
    cycle++;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
