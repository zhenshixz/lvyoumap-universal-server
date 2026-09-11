// Offline regression: no real source requests, draft changes or user batch creation.
const assert = require('assert/strict');
const C = require('./gallery_link_batch_common');
const { fs, path, root, write, read } = C;
const { spawnSync } = require('child_process');
const testRoot = fs.mkdtempSync(path.join(C.runtime, 'selftest-'));
async function test() {
  assert.equal(C.tripUrl('https://hk.trip.com/travel-guide/attraction/test/lake-123/?locale=zh-HK'), 'https://hk.trip.com/travel-guide/attraction/test/lake-123/');
  assert.throws(() => C.tripUrl('https://localhost/travel-guide/attraction/test/lake-123/'));
  assert.throws(() => C.tripUrl('https://hk.trip.com@evil.invalid/travel-guide/attraction/test/lake-123/'));
  const snapshot = { revision: 1, items: Array.from({ length: 10 }, (_, i) => ({ id: `amap_B${i}`, name: '灵湖景区', region: '临海', url: '' })) };
  assert.throws(() => C.validateDraft({ ...snapshot, revision: 2 }, snapshot));
  const saved = C.validateDraft(snapshot, snapshot); assert.equal(saved.revision, 2); assert.ok(saved.savedAt);
  // Generate a deterministic image fixture; this test needs no downloaded photos.
  const imageFile = path.join(testRoot, 'fixture.jpg');
  const generated = spawnSync('python', ['-c', 'from PIL import Image; import sys; im=Image.linear_gradient("L").resize((1600,1000)).convert("RGB"); im.save(sys.argv[1])', imageFile], { windowsHide: true, timeout: 10000 });
  assert.equal(generated.status, 0);
  const bytes = fs.readFileSync(imageFile);
  C.runtime = testRoot;
  // The QA confinement deliberately remains within the real runs parent, in a
  // non-batch-shaped test directory excluded from the UI's batch listing.
  C.runs = path.join(root, '.runtime/gallery-link-batches/runs', path.basename(testRoot));
  fs.mkdirSync(C.runs);
  C.batchList = () => [];
  C.batchPath = id => path.join(C.runs, id);
  C.sourcePolicy = () => ({ amapDisabled: false, amapDisabledUntil: null, amapReason: '' });
  C.draft = () => ({ revision: 1, savedAt: new Date().toISOString(), items: [
    { id: 'amap_B02400TOA1', name: '灵湖景区', region: '临海', url: 'https://hk.trip.com/travel-guide/attraction/linhai/lake-10520631/', images: [] },
    { id: 'amap_B000000002', name: '另一个景点', region: '临海', url: 'https://hk.trip.com/travel-guide/attraction/linhai/lake-10520631/', images: [] },
  ] });
  let imageRequests = 0, amapRequests = 0;
  const realFetch = global.fetch;
  global.fetch = async url => {
    const u = new URL(url);
    if (u.hostname === 'hk.trip.com') {
      const appData = { poiData: { poiId: 10520631, poiName: '灵湖景区', poiImage: [{ imageUrl: 'https://ak-d.tripcdn.com/images/fixture.jpg' }] } };
      return new Response(`<html><body>灵湖景区 地址：浙江临海<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { initialState: { appData } } } })}</script></body></html>`);
    }
    if (u.hostname === 'restapi.amap.com') { amapRequests++; return new Response(JSON.stringify({ status: '1', pois: [{ id: u.searchParams.get('id'), name: '灵湖景区', photos: [{ url: 'https://aos-comment.amap.com/fixture.jpg' }, { url: 'https://aos-comment.amap.com/never-download.jpg' }] }] })); }
    assert.ok(!u.pathname.includes('never-download')); imageRequests++; return new Response(bytes, { headers: { 'Content-Type': 'image/jpeg' } });
  };
  try {
    const worker = require('./gallery_link_batch_worker');
    await worker.run();
    const id = fs.readdirSync(C.runs)[0];
    const stateFile = path.join(C.runs, id, 'state.json');
    const state = read(stateFile);
    assert.equal(state.status, 'completed');
    assert.equal(state.items[0].images.filter(x => x.accepted).length, 1, 'cross-source duplicate rejected');
    assert.equal(state.items[1].trip.status, 'collected', 'saved URL overrides heuristic name mismatch');
    assert.equal(state.items[1].trip.nameMatch, false);
    assert.equal(imageRequests, 4, 'only one Amap image per POI');
    assert.equal(fs.readdirSync(path.join(C.runs, id, 'raw')).length, 0, 'raw cleanup after saved references');
    // Simulate a batch produced by the old heuristic blocker. Only that item
    // should reopen; the first completed item must not be downloaded again.
    state.status = 'completed'; state.pid = 99999999;
    state.items[1].trip = { status: 'identity_review' };
    state.items[1].done = true; state.items[1].images = [];
    write(stateFile, state);
    write(path.join(C.runs, id, `${state.items[1].id}.json`), []);
    C.batchList = () => [{ id }];
    // Worker captures batchList at import; its closure below is swapped through
    // reimport to model a fresh process resuming the interrupted checkpoint.
    delete require.cache[require.resolve('./gallery_link_batch_worker')];
    await require('./gallery_link_batch_worker').run();
    assert.equal(fs.readdirSync(C.runs).length, 1, 'resume reuses the same batch');
    assert.equal(imageRequests, 5, 'targeted repair downloads only the formerly blocked Trip source');
    const beforeAmap=amapRequests;
    C.sourcePolicy=()=>({amapDisabled:true,amapReason:'test monthly pause'}); C.batchList=()=>[];
    delete require.cache[require.resolve('./gallery_link_batch_worker')];
    await require('./gallery_link_batch_worker').run();
    assert.equal(amapRequests,beforeAmap,'monthly pause must issue zero Amap requests');
    console.log('PASS: URL/revision guards, source identity, first Amap only, cross-source dedup, checkpoints, resume, isolated raw cleanup.');
  } finally { global.fetch = realFetch; }
}
test().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => {
  // Both exact resolved paths were created by this test; no user image references exist.
  for (const p of [testRoot, C.runs]) {
    const absolute = path.resolve(p);
    assert.ok(absolute.startsWith(path.join(root, '.runtime/gallery-link-batches') + path.sep));
    assert.ok(path.basename(absolute).startsWith('selftest-'));
    fs.rmSync(absolute, { recursive: true, force: true });
  }
});
