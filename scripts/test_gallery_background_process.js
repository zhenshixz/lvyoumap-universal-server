const assert = require('node:assert/strict');
const { runStage } = require('./gallery_background_process');
(async () => {
  const options = { cwd: __dirname, timeout: 3000, stdio: 'ignore' };
  assert.equal((await runStage(process.execPath, ['-e', 'process.exit(0)'], options)).ok, true);
  assert.equal((await runStage(process.execPath, ['-e', 'process.exit(7)'], options)).code, 7);
  assert.equal((await runStage('nonexistent-gallery-test-command', [], options)).ok, false);
  let childPid;
  const result = await runStage(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { ...options, timeout: 250, onSpawn: pid => { childPid=pid; } });
  assert.equal(result.timedOut, true);
  assert.throws(() => process.kill(childPid, 0), 'timed-out process must be gone before the next stage');
  console.log('PASS: normal exit, nonzero exit, missing executable, timeout and termination before continuation');
})().catch(e => { console.error(e); process.exitCode=1; });
