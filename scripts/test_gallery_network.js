const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createGalleryNetwork } = require('./gallery_network');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gallery-network-test-'));
  let calls = 0;
  const fetch = async url => {
    calls++;
    return new Response(JSON.stringify({ value: 1 }), { status: url.includes('blocked') ? 429 : 200, headers: { 'retry-after': '60' } });
  };
  const network = createGalleryNetwork(dir, { fetch });
  await Promise.all([network.json('https://example.org/ok'), network.json('https://example.org/ok')]);
  assert.equal(calls, 1, 'identical requests must be shared');
  const nextRun = createGalleryNetwork(dir, { fetch });
  assert.deepEqual(await nextRun.json('https://example.org/ok'), { value: 1 });
  assert.equal(calls, 1, 'successful JSON survives restart');
  await assert.rejects(network.json('https://blocked.org/test'), e => !!e.retryAt);
  await assert.rejects(createGalleryNetwork(dir, { fetch }).json('https://blocked.org/other'), e => !!e.retryAt);
  assert.equal(calls, 2, 'cooldown prevents repeated network calls across restarts');
  for (const file of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, file));
  fs.rmdirSync(dir);
  console.log('PASS: response cache, request sharing, persistent rate-limit cooldown');
})().catch(error => { console.error(error); process.exitCode = 1; });
