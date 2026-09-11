const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { publicProvider } = require('./gallery_source_policy');

const root = path.resolve(__dirname, '..');
const sourceSite = path.join(root, 'dist');
const runtime = path.join(root, '.runtime', 'attraction-gallery-batch');
const batchStatePath = path.resolve(root, process.argv.find(a => a.startsWith('--state='))?.slice(8) || path.join(runtime, 'state.json'));
const galleryPolicyPath = path.join(root, 'content', 'attraction-gallery-policy.json');
const galleryOverridesPath = path.join(root, 'content', 'attraction-gallery-overrides.json');
const previewRoot = path.join(root, '.runtime', 'previews', process.argv.includes('--background') ? 'gallery-background' : 'attraction-gallery-batch');
const stagingRoot = `${previewRoot}.next`;
const previewStatePath = path.join(previewRoot, 'state.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\r\n`, 'utf8');
}

function html(value) {
  return String(value || '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function linkDirectory(target, destination) {
  if (!fs.existsSync(target)) return;
  fs.symlinkSync(target, destination, process.platform === 'win32' ? 'junction' : 'dir');
}

function copyFile(name, site) {
  const source = path.join(sourceSite, name);
  if (!fs.existsSync(source)) return;
  fs.copyFileSync(source, path.join(site, name));
}

function freePort(start = process.argv.includes('--background') ? 4187 : 4185) {
  return new Promise((resolve, reject) => {
    const tryPort = port => {
      const server = net.createServer();
      server.once('error', error => {
        server.close();
        if (error.code === 'EADDRINUSE' && port < start + 30) return tryPort(port + 1);
        reject(error);
      });
      server.once('listening', () => server.close(() => resolve(port)));
      server.listen(port, '127.0.0.1');
    };
    tryPort(start);
  });
}

function health(port) {
  return new Promise(resolve => {
    const request = http.get(`http://127.0.0.1:${port}/api/health`, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    request.setTimeout(1200, () => { request.destroy(); resolve(null); });
    request.on('error', () => resolve(null));
  });
}

async function stopOldPreview() {
  if (!fs.existsSync(previewStatePath)) return;
  const old = readJson(previewStatePath);
  const status = await health(Number(old.port));
  if (status?.service === 'lvyoumap-gallery-batch-preview' && Number.isInteger(Number(old.pid))) {
    try { process.kill(Number(old.pid)); } catch { /* already stopped */ }
  }
}

function buildIndex(items, mapBase, policy, title = '全国景点图库隔离预览', note = '') {
  const cards = items.map(item => `<a class="card" href="${mapBase}/?previewSearch=${encodeURIComponent(item.name)}">
    <b>${html(item.name)}</b><span>${html(item.province)} · ${html(item.city)}</span>
    <small>检查：${item.selected.length}张均属该景点、清晰、无水印；手机切换与大图加载正常</small>
  </a>`).join('');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>全国景点图库隔离预览</title><style>*{box-sizing:border-box}body{margin:0;background:#f4f7fb;color:#172033;font:15px/1.5 system-ui,"Microsoft YaHei"}.wrap{max-width:1100px;margin:28px auto;padding:0 18px}header{padding:24px;border-radius:18px;background:linear-gradient(135deg,#1677ff,#14b8a6);color:white}header h1{margin:0 0 7px;font-size:25px}header p{margin:3px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(245px,1fr));gap:10px;margin-top:16px}.card{display:flex;flex-direction:column;gap:4px;padding:14px;background:white;border:1px solid #dbe4ef;border-radius:12px;color:inherit;text-decoration:none;box-shadow:0 2px 8px #1e293b0d}.card:hover{border-color:#1677ff}.card span{color:#64748b}.card small{color:#8a5b12}@media(max-width:600px){.wrap{margin:12px auto;padding:0 9px}header{padding:18px}.grid{grid-template-columns:1fr}}</style>
  <main class="wrap"><header><h1>${html(title)}</h1><p>本页共 ${items.length} 个候选景点，只影响隔离预览，不写入 beta 数据。</p><p>${html(note)}</p><p>全局规则：目标${policy.targetImages}张，${policy.minimumImages}-${policy.maximumImages}张均可通过；点击景点后检查全部图片。</p></header><p><a href="preview.html">本轮新增候选</a> · <a href="previous-review.html">此前积累候选</a> · <a href="all-review.html">全部候选</a></p><section class="grid">${cards}</section></main></html>`;
}

function writeReviewIndexes(site, items, policy) {
  const jobPath = path.join(runtime, 'codex-background.json');
  const ids = new Set(fs.existsSync(jobPath) ? readJson(jobPath).ids : []);
  const fresh = items.filter(item => ids.has(item.id));
  const previous = items.filter(item => !ids.has(item.id));
  const note = '范围：9月10日下午启动的2111项补源任务中，目前达到数量门槛的候选；不是仅午夜后的新增，也不代表已通过人工审图。';
  fs.writeFileSync(path.join(site, 'preview.html'), buildIndex(fresh, '', policy, '本轮补源 · 新增候选验收', note));
  fs.writeFileSync(path.join(site, 'previous-review.html'), buildIndex(previous, '', policy, '此前积累 · 候选待审', '这些候选不属于本轮2111项补源池，仍未写入当前图库，不代表此前已经验收通过。'));
  fs.writeFileSync(path.join(site, 'all-review.html'), buildIndex(items, '', policy, '全部候选 · 隔离预览'));
  console.log(`Review groups: new=${fresh.length}, previous=${previous.length}, all=${items.length}`);
}

async function main() {
  if (!fs.existsSync(sourceSite) || !fs.existsSync(batchStatePath)) throw new Error('缺少 dist 或图库批次状态，请先完成构建和批处理。');
  const batch = readJson(batchStatePath);
  const policy = readJson(galleryPolicyPath);
  const current = readJson(galleryOverridesPath);
  const ready = batch.items.filter(item => item.status === 'ready_for_user_review'
    && item.selected?.length >= policy.minimumImages && item.selected.length <= policy.maximumImages);
  const reviewItems = ready.filter(item => {
    const existing = (current[item.id]?.images || []).map(image => typeof image === 'string' ? image : image.url);
    const selected = item.selected.map(image => image.url);
    return JSON.stringify(existing) !== JSON.stringify(selected);
  });
  if (!reviewItems.length && !process.argv.includes('--background')) throw new Error('当前没有新增或发生变化的3-5张图库需要复核。');

  if (process.argv.includes('--index-only')) {
    // Only list candidates whose exact images are already in the served snapshot.
    const site = path.join(previewRoot, 'site');
    const index = readJson(path.join(site, 'data', 'provinces-index.json'));
    const snapshot = new Map();
    for (const value of Object.values(index)) {
      const data = readJson(path.join(site, 'data', 'provinces', value.dataFile));
      for (const item of data.attractions || []) snapshot.set(item.id, item);
    }
    const matching = reviewItems.filter(item => JSON.stringify((snapshot.get(item.id)?.images || []).map(x => typeof x === 'string' ? x : x.url)) === JSON.stringify(item.selected.map(x => x.url)));
    writeReviewIndexes(site, matching, policy);
    return;
  }

  await stopOldPreview();
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  const site = path.join(stagingRoot, 'site');
  fs.mkdirSync(site, { recursive: true });
  for (const name of ['index.html', 'app.js', 'style.css', 'china.json', 'china_geo.js', 'build-info.json']) copyFile(name, site);
  fs.cpSync(path.join(sourceSite, 'data'), path.join(site, 'data'), { recursive: true, force: true });
  linkDirectory(path.join(sourceSite, 'assets'), path.join(site, 'assets'));
  linkDirectory(path.join(sourceSite, 'vendor'), path.join(site, 'vendor'));

  const provinceIndex = readJson(path.join(site, 'data', 'provinces-index.json'));
  const grouped = new Map();
  for (const item of reviewItems) {
    if (!grouped.has(item.province)) grouped.set(item.province, []);
    grouped.get(item.province).push(item);
  }
  let applied = 0;
  for (const [province, items] of grouped) {
    const dataFile = provinceIndex[province]?.dataFile;
    if (!dataFile) throw new Error(`找不到${province}的数据文件。`);
    const file = path.join(site, 'data', 'provinces', dataFile);
    const data = readJson(file);
    const byId = new Map((data.attractions || []).map(item => [item.id, item]));
    for (const item of items) {
      const attraction = byId.get(item.id);
      if (!attraction) throw new Error(`隔离数据中找不到${province}·${item.name}。`);
      const images = item.selected.map(candidate => ({
        url: candidate.url,
        caption: candidate.caption || item.name,
        imageSource: candidate.sourceUrl ? { provider: publicProvider(candidate), sourceUrl: candidate.sourceUrl } : undefined,
      }));
      attraction.image = images[0].url;
      attraction.images = images;
      applied += 1;
    }
    writeJson(file, data);
  }
  if (applied !== reviewItems.length) throw new Error(`预览写入数量不一致：${applied}/${reviewItems.length}`);

  const token = `gallery_preview_${Date.now()}`;
  const appPath = path.join(site, 'app.js');
  let app = fs.readFileSync(appPath, 'utf8').replace(/const STATIC_DATA_VERSION\s*=\s*["'][^"']+["'];/, `const STATIC_DATA_VERSION = "${token}";`);
  app += `\n;(() => { const q=new URLSearchParams(location.search).get('previewSearch'); if(!q)return; const run=()=>{const el=document.getElementById('global-search');if(!el)return setTimeout(run,150);el.value=q;el.dispatchEvent(new Event('input',{bubbles:true}));};setTimeout(run,450);})();\n`;
  fs.writeFileSync(appPath, app, 'utf8');
  const indexPath = path.join(site, 'index.html');
  fs.writeFileSync(indexPath, fs.readFileSync(indexPath, 'utf8').replace(
    /(src=["'])app\.js(?:\?v=[^"']*)?(["'])/g,
    `$1app.js?v=${token}$2`,
  ), 'utf8');

  fs.rmSync(previewRoot, { recursive: true, force: true });
  fs.renameSync(stagingRoot, previewRoot);
  const finalSite = path.join(previewRoot, 'site');
  const port = await freePort();
  const localBase = `http://127.0.0.1:${port}`;
  if (process.argv.includes('--background')) writeReviewIndexes(finalSite, reviewItems, policy);
  else fs.writeFileSync(path.join(finalSite, 'preview.html'), buildIndex(reviewItems, '', policy).replace('<p><a href="preview.html">本轮新增候选</a> · <a href="previous-review.html">此前积累候选</a> · <a href="all-review.html">全部候选</a></p>', ''));
  const child = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: { ...process.env, HOST: '0.0.0.0', PORT: String(port), STATIC_DIR: finalSite, SERVICE_NAME: 'lvyoumap-gallery-batch-preview' },
  });
  child.unref();
  let verifiedHealth = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    verifiedHealth = await health(port);
    if (verifiedHealth?.service === 'lvyoumap-gallery-batch-preview') break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (verifiedHealth?.service !== 'lvyoumap-gallery-batch-preview') throw new Error('预览进程未通过健康检查，请检查端口或服务启动日志。');
  const ifaces = os.networkInterfaces();
  const physicalLans = [];
  for (const [name, list] of Object.entries(ifaces)) {
    if (/vEthernet|WSL|VMware|VirtualBox|Loopback|Meta|TAP|Tun|VPN|Npcap/i.test(name)) continue;
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) {
        if (/^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(item.address)) {
          physicalLans.push(item.address);
        }
      }
    }
  }
  const lanUrls = physicalLans.map(ip => `http://${ip}:${port}/`);
  writeJson(path.join(previewRoot, 'state.json'), {
    status: 'ready',
    pid: child.pid,
    port,
    itemCount: reviewItems.length,
    previewUrl: `${localBase}/`,
    mapUrl: `${localBase}/`,
    indexUrl: `${localBase}/preview.html`,
    physicalIp: physicalLans[0] || '127.0.0.1',
    lanUrls,
    generatedAt: new Date().toISOString(),
    sourceDataReadOnly: true
  });
  console.log(`\n==================================================`);
  console.log(`  【全国景点图库】隔离预览地图服务已就绪`);
  console.log(`  本轮待验收景点：${reviewItems.length} 个（数据沙箱隔离，未修改正式库）`);
  console.log(`--------------------------------------------------`);
  console.log(`  🗺️ 电脑本地地图：${localBase}/`);
  console.log(`  📋 待审清单索引：${localBase}/preview.html`);
  for (const ip of physicalLans) {
    console.log(`  📱 手机局域网地图：http://${ip}:${port}/`);
    console.log(`  📱 手机待审清单：http://${ip}:${port}/preview.html`);
  }
  console.log(`==================================================\n`);
}

main().catch(error => {
  console.error(`图库隔离预览失败：${error.message}`);
  process.exitCode = 1;
});
