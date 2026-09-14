const C = require('./gallery_link_batch_common');
const { fs, path, root, runtime, read, alive, draft } = C;
const { spawn, spawnSync } = require('child_process');
const os = require('os');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function healthy() {
  const config = read(path.join(runtime, 'server.json'));
  if (!config?.port) return null;
  try {
    const r = await fetch(`http://127.0.0.1:${config.port}/api/health`, { signal: AbortSignal.timeout(1000) });
    const body = await r.json();
    if (body.service === 'gallery-link-batch-v1' && body.root === root) return config;
  } catch {} return null;
}
function detach(script, logName) {
  const fd = fs.openSync(path.join(runtime, logName), 'a');
  const child = spawn(process.execPath, [path.join(__dirname, script)], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
  child.on('error', e => console.error(e.message)); child.unref(); fs.closeSync(fd); return child;
}
async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw Error('Node.js 24+ required');
  for (const module of ['vue', 'cheerio', 'opencc-js', 'puppeteer-core']) require.resolve(module);
  const command = process.argv[2] || 'form';
  if (!['form', 'run', 'preview'].includes(command)) throw Error('Expected form, run or preview');
  if (['form', 'run', 'preview'].includes(command)) {
    const python = require('./gallery_link_batch_python').resolvePython();
    console.log(`Python: ${python}`);
    if (process.argv.includes('--check-only')) { console.log('Dependency check: OK. No batch started.'); return; }
    if (command === 'run' && !draft().savedAt) throw Error('Save your list on the webpage first.');
  }
  let config = await healthy();
  if (!config) {
    detach('gallery_link_batch_server.js', 'server.log');
    for (let i = 0; i < 30 && !config; i++) { await sleep(200); config = await healthy(); }
    if (!config) throw Error('Service did not start. See .runtime/gallery-link-batches/server.log');
  }
  if (command === 'run') {
    await require('./gallery_link_batch_actions').start({ revision: draft().revision });
    console.log('Batch status ready. Closing this window will not stop background work.');
  }
  const route = command === 'form' ? 'form' : command === 'run' ? 'progress' : 'preview';
  const url = `http://127.0.0.1:${config.port}/#${route}`;
  console.log(`Local: ${url}`);
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    if (/virtual|vethernet|wsl|loopback|clash|tun|vpn/i.test(name)) continue;
    for (const nic of entries || []) if (nic.family === 'IPv4' && !nic.internal && !nic.address.startsWith('198.18.')) console.log(`LAN (read-only): http://${nic.address}:${config.port}/#${route}`);
  }
  console.log('Health check: OK. No content publishing.');
  if (!process.argv.includes('--no-open')) spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', `Start-Process '${url}'`], { windowsHide: true, stdio: 'ignore' }).unref();
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
