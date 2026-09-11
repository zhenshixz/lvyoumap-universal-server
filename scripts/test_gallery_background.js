const assert = require('node:assert/strict');
const { recordBatch, candidates } = require('./gallery_background_policy');
const job = () => ({ ids: ['a','b','c'], attempts: {}, visits: {}, transient: {}, nextAt: {}, failures: {} });
const items = [
  { id:'a', status:'pending_sources', backgroundReceipt:{run:'one'}, retryable:true },
  { id:'b', status:'pending_sources', backgroundReceipt:{run:'old'} },
  { id:'c', status:'ready_for_user_review', selected:[1,2,3] }
];
const j = job();
assert.deepEqual(recordBatch(j, items, ['a','b'], 'one', 1000), ['a']);
assert.equal(j.attempts.a, undefined, 'transient failures do not consume valid attempts');
assert.equal(j.visits.b, undefined, 'unexecuted items do not consume visits or attempts');
recordBatch(j, items, ['a','b'], 'one', 1000);
assert.equal(j.visits.a, 1, 'crash recovery must not double-account a committed receipt');
assert.deepEqual(candidates(j, items, 2000).pending, ['b'], 'completed and cooling items must not run');
assert.deepEqual(candidates(j, items, 200000).pending, ['b','a'], 'first coverage has priority over retries');
j.transient.a=8; j.attempts.b=2;
assert.equal(candidates(j, items, 999999).eligible.length, 0, 'bounded retries end with unresolved items');
const k=job();
assert.deepEqual(candidates(k,[{id:'a',status:'excluded_non_attraction'},{id:'b',status:'ready_for_visual_review'},items[2]]).eligible, [], 'excluded and pending-filter candidates must not be recollected');
console.log('PASS: actual receipts, partial batches, idempotent recovery, cooldown, fairness, finite retries, exclusion/filter recovery');
const { replaceCheckpoint } = require('./gallery_checkpoint_io');
let renames = 0;
replaceCheckpoint('unused-test-source', 'unused-test-destination', () => { if (++renames < 3) throw Object.assign(Error('sharing violation'), {code:'EPERM'}); });
assert.equal(renames, 3, 'temporary Windows sharing violation must be retried');
assert.throws(() => replaceCheckpoint('unused', 'unused', () => { throw Object.assign(Error('disk full'), {code:'ENOSPC'}); }), /disk full/);
console.log('PASS: checkpoint sharing violation retry; permanent failures remain explicit');
