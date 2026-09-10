// Consume only newly discovered, city-verified Trip pages; never publishes content.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const runtime = path.join(root, '.runtime', 'attraction-gallery-batch');
const stateFile = path.join(runtime, 'state.json');
const milestoneFile = path.join(runtime, 'remaining-milestones.json');
const discoveryDir = path.join(runtime, 'discovered-pages');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, windowsHide: true, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${args[0]} failed with exit ${result.status}`);
};

function freshIds() {
  const state = read(stateFile);
  const byId = new Map(state.items.map(item => [item.id, item]));
  const forceAll = process.argv.includes('--all-verified') || process.argv.includes('--all');
  return fs.readdirSync(discoveryDir)
    .filter(name => name.endsWith('-trip.json'))
    .flatMap(name => {
      const page = read(path.join(discoveryDir, name));
      const id = name.slice(0, -'-trip.json'.length);
      const item = byId.get(id);
      const verified = (page.links || [page]).some(link => link.cityVerified === true);
      const discoveredAt = Date.parse(page.discoveredAt || page.verifiedAt || 0);
      const updatedAt = Date.parse(item?.updatedAt || 0);
      return item?.status === 'pending_sources' && verified && (discoveredAt > updatedAt || forceAll) ? [id] : [];
    });
}

function updateProgress() {
  const state = read(stateFile);
  const manifest = read(milestoneFile);
  const fixed = new Set(manifest.ids);
  const complete = state.items.filter(item => fixed.has(item.id)
    && item.status === 'ready_for_user_review' && item.selected?.length >= 3).length;
  manifest.completed = complete;
  manifest.updatedAt = new Date().toISOString();
  fs.writeFileSync(milestoneFile, JSON.stringify(manifest, null, 2) + '\n');
  return { complete, target: Math.ceil(manifest.ids.length * manifest.milestone / 5) };
}

function main() {
  const ids = freshIds();
  if (!ids.length) {
    const progress = updateProgress();
    console.log(`No fresh Trip pages. Milestone progress: ${progress.complete}/${progress.target}.`);
    return;
  }
  console.log(`Consuming ${ids.length} newly verified Trip pages.`);
  run(process.execPath, ['scripts/collect_attraction_galleries_batch.js', `--ids=${ids.join(',')}`,
    `--max-items=${ids.length}`, '--concurrency=8', '--fast-secondary']);
  run('python', ['scripts/render_attraction_gallery_batch.py', `--ids=${ids.join(',')}`, '--contact-sheet-items=0']);
  const progress = updateProgress();
  console.log(`Milestone progress: ${progress.complete}/${progress.target}.`);
}

main();
