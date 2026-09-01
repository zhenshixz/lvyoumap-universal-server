const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const milestoneArg = process.argv.find(value => value.startsWith('--milestone='));
const milestone = milestoneArg ? milestoneArg.slice('--milestone='.length) : (process.env.ATTRACTION_MILESTONE || 'priority-01');
const manifestPath = path.join(root, '.runtime', 'attraction-content-milestones', milestone, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
if (manifest.status !== 'ready_for_preview') throw new Error(`修复批次尚未通过整卡检查：${manifest.status}`);
const port = Number(process.env.PORT || 4183);

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
function injectPanel(html) {
  const rank = value => [...String(value)].reduce((sum, char) => ((sum * 33) + char.charCodeAt(0)) >>> 0, 5381);
  const sorted = values => [...values].sort((left, right) => rank(left.id) - rank(right.id));
  const picked = new Map();
  const take = (values, count) => sorted(values).slice(0, count).forEach(item => picked.set(item.id, item));
  take(manifest.items.filter(item => item.repairKinds.includes('entity')), 5);
  take(manifest.items.filter(item => item.repairKinds.includes('lazy')), 5);
  take(manifest.items.filter(item => item.repairKinds.some(kind => kind === 'guideTemplate' || kind === 'guideMissing')), 10);
  take(manifest.items.filter(item => !picked.has(item.id)), Math.max(0, 20 - picked.size));
  const samples = [...picked.values()].slice(0, 20).map(item => ({ id: item.id, province: item.province, city: item.city, name: item.name, kinds: item.repairKinds }));
  const data = JSON.stringify(samples).replace(/</g, '\\u003c');
  const panel = `<style>#codex-milestone{position:fixed;right:16px;bottom:16px;z-index:99999;background:#fff;border:1px solid #d7e0ea;border-radius:14px;box-shadow:0 12px 36px #17324d33;padding:12px;width:min(410px,calc(100vw - 32px));font:14px/1.5 system-ui,"Microsoft YaHei",sans-serif}#codex-milestone b{color:#0f5da8}#codex-milestone input,#codex-milestone select,#codex-milestone button{box-sizing:border-box;width:100%;margin-top:7px;border-radius:8px;padding:8px;border:1px solid #c8d3df;background:#fff}#codex-milestone select{height:150px}#codex-milestone button{border:0;background:#0878d1;color:#fff;font-weight:700;cursor:pointer}</style><div id="codex-milestone"><b>第一阶段优先修复 · 随机抽查20条</b><div>跨省覆盖简介、旅行指南和懒人攻略，打开即为真实详情卡。</div><input id="cm-search" placeholder="搜索省市或景点名"><select id="cm-select" size="6"></select><button id="cm-open">打开所选景点</button></div><script>(()=>{const all=${data},select=document.getElementById('cm-select'),search=document.getElementById('cm-search');function render(){const q=search.value.trim();select.innerHTML='';for(const item of all.filter(x=>!q||(x.province+x.city+x.name).includes(q))){const o=document.createElement('option');o.value=item.id;o.textContent=item.province+' / '+item.city+' / '+item.name+'（'+item.kinds.join('+')+'）';select.appendChild(o)}if(select.options.length)select.selectedIndex=0}search.oninput=render;render();document.getElementById('cm-open').onclick=async()=>{const item=all.find(x=>x.id===select.value);if(!item)return;const province=await loadProvinceDetailData(item.province);const attraction=(province.attractions||[]).find(x=>x.id===item.id);if(attraction)openDetailModal(attraction)}})();</script>`;
  return html.replace('</body>', `${panel}</body>`);
}
const server = http.createServer((request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname);
    const province = pathname.match(/^\/data\/provinces\/([a-z0-9_-]+)\.json$/i);
    if (province) { response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(patchedProvince(province[1])); return; }
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const sourceApp = relative === 'app.js';
    const file = sourceApp ? path.join(root, 'app.js') : path.resolve(dist, relative);
    if ((!sourceApp && !file.startsWith(`${path.resolve(dist)}${path.sep}`)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404); response.end('Not found'); return; }
    let body = fs.readFileSync(file);
    if (relative === 'index.html') body = Buffer.from(injectPanel(body.toString('utf8')), 'utf8');
    response.writeHead(200, { 'content-type': contentType(file), 'cache-control': 'no-store' }); response.end(body);
  } catch (error) { response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); response.end(error.message); }
});
server.listen(port, '127.0.0.1', () => console.log(`previewUrl=http://127.0.0.1:${port}/`));
