const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');
const root = path.resolve(__dirname, '..');
const runtime = path.join(root, '.runtime', 'attraction-gallery-batch');
const service = 'lvyoumap-gallery-progress';
const configFile = path.join(runtime, 'progress-server.json');
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return {}; } };
const alive = pid => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
function summary() {
  const j = read(path.join(runtime, 'codex-background.json'));
  const s = read(path.join(runtime, 'codex-background-supervisor.json'));
  const p = read(path.join(root, '.runtime', 'previews', 'gallery-background', 'state.json'));
  return {
    service, now: new Date().toISOString(), status: j.status || 'unknown', phase: j.phase,
    workerAlive: alive(j.pid), supervisorAlive: alive(s.pid), supervisorStatus: s.status,
    heartbeatAt: j.heartbeatAt, updatedAt: j.updatedAt, resumeAt: j.resumeAt,
    total: j.total || 0, ready: j.ready || 0, processed: j.processed || 0, excluded: j.excluded || 0,
    unresolved: j.unresolved, waitingRetry: j.waitingRetry || 0, names: j.currentNames || [],
    lastBatch: j.lastBatch, recentIssues: j.recentIssues || [], errors: (j.errors || []).slice(-3),
    restarts: s.restarts || 0, previewPort: p.port, previewCount: p.itemCount, previewAt: p.generatedAt,
    stopRequested: fs.existsSync(path.join(runtime, 'codex-background.stop')),
  };
}
async function health(port) {
  if (!Number.isInteger(port)) return {};
  return new Promise(resolve => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/api/health', timeout: 1500 }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    });
    req.on('timeout', () => req.destroy()); req.on('error', () => resolve({}));
  });
}
async function serve() {
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    const route = req.url.split('?')[0];
    if (route === '/api/health' || route === '/api/progress') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(route === '/api/health' ? { service } : summary())); return;
    }
    const target = route === '/' ? path.join(__dirname, 'gallery-progress.html') : route === '/vue.js' ? require.resolve('vue/dist/vue.global.prod.js') : null;
    if (!target) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', route === '/' ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8');
    fs.createReadStream(target).on('error', () => res.destroy()).pipe(res);
  });
  let port;
  for (port = 4190; port < 4200; port++) {
    const ok = await new Promise((resolve, reject) => {
      const fail = e => { server.removeListener('listening', done); if (e.code === 'EADDRINUSE') resolve(false); else reject(e); };
      const done = () => { server.removeListener('error', fail); resolve(true); };
      server.once('error', fail); server.once('listening', done); server.listen(port, '0.0.0.0');
    });
    if (ok) break;
  }
  if (port === 4200) throw Error('No available progress port.');
  fs.writeFileSync(configFile, JSON.stringify({ pid: process.pid, port }));
}
async function main() {
  if (path.basename(root).toLowerCase() !== 'lvyoumap-universal-serverbeta') throw Error('Run only from beta.');
  require.resolve('vue/dist/vue.global.prod.js');
  if (!process.argv.includes('--start')) return serve();
  let config = read(configFile);
  if ((await health(config.port)).service !== service) {
    const fd = fs.openSync(path.join(runtime, 'progress-server.log'), 'a');
    const child = spawn(process.execPath, [__filename], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
    child.unref(); fs.closeSync(fd);
    for (let i = 0; i < 25; i++) {
      await new Promise(r => setTimeout(r, 200)); config = read(configFile);
      if ((await health(config.port)).service === service) break;
    }
  }
  if ((await health(config.port)).service !== service) throw Error('Progress service health check failed.');
  console.log(`[OK] Local: http://127.0.0.1:${config.port}/`);
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/vEthernet|WSL|VMware|VirtualBox|Loopback|TAP|Tun|VPN|Npcap|Meta/i.test(name)) continue;
    for (const item of list || []) if (item.family === 'IPv4' && !item.internal) console.log(`[OK] LAN: http://${item.address}:${config.port}/`);
  }
  if (process.argv.includes('--open')) {
    const child = spawn('explorer.exe', [`http://127.0.0.1:${config.port}/`], { windowsHide: true, stdio: 'ignore' }); child.on('error', () => {}); child.unref();
  }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { summary };
