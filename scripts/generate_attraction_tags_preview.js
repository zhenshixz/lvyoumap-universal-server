const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, '.runtime', 'attraction-display-tags', 'manifest.json');
const previewRoot = path.join(root, '.runtime', 'previews', 'attraction-display-tags');
const stagingRoot = `${previewRoot}.next`;
const serviceName = 'lvyoumap-attraction-display-tags-preview';

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value)}\r\n`, 'utf8');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

function canUsePort(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '0.0.0.0');
  });
}

async function choosePort() {
  for (let port = 3121; port <= 3130; port += 1) {
    if (await canUsePort(port)) return port;
  }
  throw new Error('预览端口 3121-3130 均被占用。');
}

function lanAddresses(port) {
  return Object.values(os.networkInterfaces()).flat().filter(item =>
    item && item.family === 'IPv4' && !item.internal
  ).map(item => `http://${item.address}:${port}/preview.html`);
}

function stopOldPreview() {
  const statePath = path.join(previewRoot, 'state.json');
  if (!fs.existsSync(statePath)) return;
  try {
    const state = readJson(statePath);
    if (state.serviceName === serviceName && Number.isInteger(state.pid)) process.kill(state.pid);
  } catch (_) {}
}

function patchFrontend(siteDir, version) {
  const appPath = path.join(siteDir, 'app.js');
  let source = fs.readFileSync(appPath, 'utf8');
  source = source.replace(
    /const formattedLevel = formatAttractionLevel\(attr\.level\);\s*const heritageStr = [^;]+;/,
    `const formattedLevel = formatAttractionLevel(attr.level);\n    const heritageStr = (formattedLevel.includes("5A") || attr.level.includes("世界文化遗产")) ? "世界文化遗产" : "国家级风景区";\n    const previewTags = [...new Set((Array.isArray(attr.tags) ? attr.tags : []).map(value => String(value).trim()).filter(Boolean))].slice(0, 3);\n    const previewTagHtml = previewTags.map(value => \`<span class="card-badge-level">\${value}</span>\`).join("");`,
  );
  source = source.replace(
    /\$\{searchLocationBadge\}\s*<span class="card-badge-level">\$\{formattedLevel\}<\/span>\s*<span class="card-badge-heritage">\$\{heritageStr\}<\/span>/,
    '${searchLocationBadge}\n          ${previewTagHtml}',
  );
  source = source.replace(
    /const STATIC_DATA_VERSION\s*=\s*["'][^"']+["'];/,
    `const STATIC_DATA_VERSION = "${version}";`,
  );
  if (!source.includes('const previewTagHtml')) throw new Error('未能替换景点列表标签渲染逻辑。');
  source += `\n;(() => { const q = new URLSearchParams(location.search).get('previewSearch'); if (!q) return; const run = () => { const el = document.getElementById('global-search'); if (!el) return setTimeout(run, 150); el.value = q; el.dispatchEvent(new Event('input', { bubbles: true })); }; setTimeout(run, 400); })();\n`;
  fs.writeFileSync(appPath, source, 'utf8');

  const indexPath = path.join(siteDir, 'index.html');
  const index = fs.readFileSync(indexPath, 'utf8').replace(
    /(<script\b[^>]*\bsrc=["'](?:\.\/|\/)?app\.js)(?:\?[^"']*)?(["'][^>]*>)/i,
    `$1?v=${version}$2`,
  );
  fs.writeFileSync(indexPath, index, 'utf8');
}

function previewIndex(samples, mapUrl) {
  const cards = samples.map(item => `
    <a class="sample" href="${mapUrl}?previewSearch=${encodeURIComponent(item.name)}">
      <img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name)}">
      <div><h2>${escapeHtml(item.name)}</h2><p>${escapeHtml(item.province)} · ${escapeHtml(item.city)}</p>
      <div class="tags">${item.tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join('')}</div></div>
    </a>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>全国景点特色标签隔离预览</title><style>*{box-sizing:border-box}body{margin:0;background:#f4f7f6;color:#17322c;font:14px/1.5 system-ui,"Microsoft YaHei",sans-serif}.wrap{max-width:980px;margin:28px auto;padding:0 18px}header{padding:24px 26px;border-radius:18px;background:linear-gradient(135deg,#168c72,#57b994);color:#fff;box-shadow:0 12px 28px #175c4930}h1{margin:0 0 7px;font-size:26px}header p{margin:0;opacity:.92}.notice{margin:14px 0;padding:10px 14px;background:#fff7dc;border:1px solid #f0d68a;border-radius:10px;color:#70520b}.samples{display:grid;gap:12px}.sample{display:grid;grid-template-columns:130px 1fr;gap:15px;padding:12px;background:#fff;border:1px solid #dce6e2;border-radius:13px;color:inherit;text-decoration:none;box-shadow:0 4px 14px #23483c0a}.sample:hover{border-color:#60b49c}.sample img{width:130px;height:96px;object-fit:cover;border-radius:9px;background:#edf1ef}.sample h2{margin:4px 0 1px;font-size:18px}.sample p{margin:0 0 10px;color:#718078}.tags{display:flex;flex-wrap:wrap;gap:6px}.tags span{padding:3px 8px;border-radius:6px;background:#e7f8f1;color:#08775d;border:1px solid #bce8d8}.actions{display:flex;gap:10px;margin:16px 0}.actions a{padding:9px 14px;border-radius:9px;background:#fff;border:1px solid #b9ccc5;color:#126d59;text-decoration:none;font-weight:700}@media(max-width:600px){.wrap{margin:14px auto}.sample{grid-template-columns:90px 1fr}.sample img{width:90px;height:86px}.sample h2{font-size:16px}}</style></head><body><main class="wrap"><header><h1>全国景点特色标签隔离预览</h1><p>5,664 个景点标签已套用到正式列表卡片的隔离副本。</p></header><div class="notice">尚未写入 beta 内容数据。点击样例可在隔离地图中查看实际搜索列表样式。</div><div class="actions"><a href="${mapUrl}">打开完整隔离地图</a></div><section class="samples">${cards}</section></main></body></html>`;
}

async function waitForHealth(port) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const ok = await new Promise(resolve => {
      const request = http.get(`http://127.0.0.1:${port}/api/health`, response => {
        let body = '';
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve(response.statusCode === 200 && body.includes(serviceName)));
      });
      request.on('error', () => resolve(false));
    });
    if (ok) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('隔离预览服务启动失败。');
}

async function main() {
  const manifest = readJson(manifestPath);
  const items = Object.values(manifest.items || {});
  if (items.length !== Number(manifest.total) || Number(manifest.pending) !== 0) {
    throw new Error(`标签断点未完成：${items.length}/${manifest.total}。`);
  }
  const dist = path.join(root, 'dist');
  for (const file of ['index.html', 'app.js', 'style.css', path.join('data', 'search-index.json')]) {
    if (!fs.existsSync(path.join(dist, file))) throw new Error(`dist 缺少 ${file}，请先构建。`);
  }
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  fs.mkdirSync(stagingRoot, { recursive: true });
  const siteDir = path.join(stagingRoot, 'site');
  fs.cpSync(dist, siteDir, { recursive: true });

  const byId = new Map(items.map(item => [String(item.id), item]));
  const sampleNames = ['平和县三平风景区三平寺', '剑门关古镇', '西陵峡风景区', '红山森林动物园', '海陵岛大角湾海上丝路旅游区'];
  const samples = [];
  let applied = 0;
  const provincesDir = path.join(siteDir, 'data', 'provinces');
  for (const entry of fs.readdirSync(provincesDir).filter(name => name.endsWith('.json'))) {
    const file = path.join(provincesDir, entry);
    const province = readJson(file);
    let changed = false;
    for (const attraction of province.attractions || []) {
      const collected = byId.get(String(attraction.id));
      if (!collected) continue;
      attraction.tags = collected.tags;
      changed = true;
      applied += 1;
      if (sampleNames.includes(attraction.name)) samples.push({ ...attraction, province: province.province });
    }
    if (changed) writeJson(file, province);
  }
  if (applied !== items.length) throw new Error(`隔离数据匹配不完整：${applied}/${items.length}。`);

  const searchPath = path.join(siteDir, 'data', 'search-index.json');
  const search = readJson(searchPath);
  for (const attraction of search) {
    const collected = byId.get(String(attraction.id));
    if (collected) attraction.tags = collected.tags;
  }
  writeJson(searchPath, search);
  const version = `tag_preview_${Date.now()}`;
  patchFrontend(siteDir, version);

  const port = await choosePort();
  const localBase = `http://127.0.0.1:${port}`;
  fs.writeFileSync(path.join(siteDir, 'preview.html'), previewIndex(samples, `${localBase}/`), 'utf8');
  stopOldPreview();
  fs.rmSync(previewRoot, { recursive: true, force: true });
  fs.renameSync(stagingRoot, previewRoot);
  const finalSite = path.join(previewRoot, 'site');
  const child = spawn(process.execPath, [path.join('server', 'index.js')], {
    cwd: root, detached: true, stdio: 'ignore', windowsHide: true,
    env: { ...process.env, HOST: '0.0.0.0', PORT: String(port), STATIC_DIR: finalSite, SERVICE_NAME: serviceName },
  });
  child.unref();
  await waitForHealth(port);
  const state = { status: 'ready', serviceName, pid: child.pid, port, itemCount: applied, previewUrl: `${localBase}/preview.html`, mapUrl: `${localBase}/`, lanUrls: lanAddresses(port), generatedAt: new Date().toISOString(), sourceDataReadOnly: true };
  writeJson(path.join(previewRoot, 'state.json'), state);
  console.log(JSON.stringify(state, null, 2));
}

main().catch(error => { console.error(`生成景点标签隔离预览失败：${error.message}`); process.exitCode = 1; });
