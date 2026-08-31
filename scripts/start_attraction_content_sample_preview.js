const fs = require('fs');
const http = require('http');
const path = require('path');
const { buildCityProvinceIndex, validateCard } = require('./attraction_card_consistency');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const manifestPath = path.join(root, '.runtime', 'attraction-content-sample', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
if (manifest.status !== 'ready_for_preview') throw new Error(`样本尚未就绪：${manifest.status}`);
const port = Number(process.env.PORT || 4182);

const cityProvinceIndex = buildCityProvinceIndex(path.join(root, 'data', 'provinces'));
const gateFailures = [];
for (const item of manifest.items) {
  const data = JSON.parse(fs.readFileSync(path.join(root, 'data', 'provinces', `${item.slug}.json`), 'utf8').replace(/^\uFEFF/, ''));
  const source = (data.attractions || []).find(attraction => attraction.id === item.id) || {};
  const validation = validateCard(item, { ...source, ...item.before, ...item.proposed }, cityProvinceIndex);
  if (!validation.passed) gateFailures.push(`${item.province}/${item.city}/${item.name}: ${validation.errors.map(error => error.message).join('、')}`);
}
if (gateFailures.length) throw new Error(`整卡一致性检查未通过：\n${gateFailures.join('\n')}`);

function contentType(file) {
  return ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2' })[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function patchedProvince(slug) {
  const file = path.join(root, 'data', 'provinces', `${slug}.json`);
  const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  for (const item of manifest.items.filter(value => value.slug === slug)) {
    const index = (data.attractions || []).findIndex(attraction => attraction.id === item.id);
    if (index >= 0) data.attractions[index] = { ...data.attractions[index], ...item.proposed };
  }
  return Buffer.from(`${JSON.stringify(data)}\r\n`, 'utf8');
}

function injectReviewPanel(html) {
  const samples = manifest.items.map(item => ({ id: item.id, province: item.province, city: item.city, name: item.name, issues: item.issues }));
  const injection = `<style>#codex-sample-review{position:fixed;right:18px;bottom:18px;z-index:99999;background:#fff;border:1px solid #d7e0ea;border-radius:14px;box-shadow:0 12px 36px #17324d33;padding:12px;width:min(390px,calc(100vw - 36px));font:14px/1.5 system-ui,"Microsoft YaHei",sans-serif}#codex-sample-review b{color:#0f5da8}#codex-sample-review select,#codex-sample-review button{box-sizing:border-box;margin-top:8px;border-radius:8px;padding:9px;border:1px solid #c8d3df}#codex-sample-review select{width:100%;background:#fff}#codex-sample-review button{width:100%;border:0;background:#0878d1;color:#fff;font-weight:700;cursor:pointer}</style><div id="codex-sample-review"><b>10条内容修复 · 隔离预览</b><div>选择景点后直接打开真实详情页。</div><select id="codex-sample-select"></select><button id="codex-sample-open">打开所选景点</button></div><script>(()=>{const samples=${JSON.stringify(samples).replace(/</g, '\\u003c')};const select=document.getElementById('codex-sample-select');for(const item of samples){const option=document.createElement('option');option.value=item.id;option.textContent=item.province+' / '+item.city+' / '+item.name+'（'+item.issues.join('+')+'）';select.appendChild(option)}document.getElementById('codex-sample-open').onclick=async()=>{const item=samples.find(value=>value.id===select.value);if(!item)return;const province=await loadProvinceDetailData(item.province);const attraction=(province.attractions||[]).find(value=>value.id===item.id);if(attraction)openDetailModal(attraction)};})();</script>`;
  return html.replace('</body>', `${injection}</body>`);
}

const server = http.createServer((request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname);
    const provinceMatch = pathname.match(/^\/data\/provinces\/([a-z0-9_-]+)\.json$/i);
    if (provinceMatch) {
      const body = patchedProvince(provinceMatch[1]);
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(body);
      return;
    }
    let relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const servedSourceApp = relative === 'app.js';
    let file = servedSourceApp ? path.join(root, 'app.js') : path.resolve(dist, relative);
    if ((!servedSourceApp && !file.startsWith(`${path.resolve(dist)}${path.sep}`)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404); response.end('Not found'); return;
    }
    let body = fs.readFileSync(file);
    if (relative === 'index.html') body = Buffer.from(injectReviewPanel(body.toString('utf8')), 'utf8');
    response.writeHead(200, { 'content-type': contentType(file), 'cache-control': 'no-store' });
    response.end(body);
  } catch (error) {
    response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(error.message);
  }
});

server.listen(port, '127.0.0.1', () => console.log(`previewUrl=http://127.0.0.1:${port}/`));
