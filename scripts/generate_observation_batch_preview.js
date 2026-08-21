const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { probablySameAttraction, validateManualAttraction } = require('./generate_static_data');
const { readJson, updateBatch } = require('./observation_batch');

const rootDir = path.join(__dirname, '..');
const runtimeDir = path.join(rootDir, '.runtime');
const contentDir = path.join(rootDir, 'content');
const args = new Map(process.argv.slice(2).map(value => {
  const match = value.match(/^--([^=]+)=(.*)$/);
  return match ? [match[1], match[2]] : [value.replace(/^--/, ''), true];
}));
const manifestPath = String(args.get('manifest') || '');
if (!manifestPath) throw new Error('请使用 --manifest=批次文件。');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\r\n`, 'utf8');
}

function merge(target, patch) {
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) target[key] = merge(target[key] && typeof target[key] === 'object' && !Array.isArray(target[key]) ? target[key] : {}, value);
    else target[key] = value;
  }
  return target;
}

function copyLocalImage(item, siteDir) {
  if (!item?.image?.startsWith('/')) return;
  const source = path.join(rootDir, item.image.slice(1));
  const target = path.join(siteDir, item.image.slice(1));
  if (!fs.existsSync(source)) throw new Error(`${item.name} 本地图片文件不存在：${item.image}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function stopPreviews() {
  const root = path.join(runtimeDir, 'previews');
  if (!fs.existsSync(root)) return;
  for (const directory of fs.readdirSync(root, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const state = readJson(path.join(root, directory.name, 'state.json'), null);
    if (state?.pid) try { process.kill(Number(state.pid)); } catch {}
  }
}

function portAvailable(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

function waitForHealth(url, attempts = 30) {
  return new Promise((resolve, reject) => {
    const check = remaining => http.get(url, response => {
      response.resume();
      if (response.statusCode === 200) return resolve();
      if (remaining <= 1) return reject(new Error('批次预览健康检查失败。'));
      setTimeout(() => check(remaining - 1), 300);
    }).on('error', () => remaining <= 1 ? reject(new Error('批次预览服务未能启动。')) : setTimeout(() => check(remaining - 1), 300));
    check(attempts);
  });
}

function previewHtml(items, baseUrl, failed) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.province)) groups.set(item.province, []);
    groups.get(item.province).push(item);
  }
  const sections = [...groups].map(([province, values]) => `<section><h2>${province}<small>${values.length} 项</small></h2><div class="cards">${values.map(item => `<a href="${baseUrl}/?previewSearch=${encodeURIComponent(item.name)}"><b>${item.name}</b><span>${item.city || province} · 检查基本信息、旅行指南、懒人攻略与大图</span></a>`).join('')}</div></section>`).join('');
  const failure = failed.length ? `<aside><b>${failed.reduce((sum, item) => sum + item.selectedKeys.length, 0)} 项本轮未完成，已保留断点，不影响下列成功项验收：</b>${failed.map(item => `<div>${item.province}：${item.selectedNames.join('、')}（${item.error || '待续跑'}）</div>`).join('')}</aside>` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>全国单源景点批次预览</title><style>body{margin:0;background:#f3f7fa;color:#172033;font:15px/1.6 system-ui,-apple-system,"Microsoft YaHei",sans-serif}.wrap{max-width:1080px;margin:32px auto;padding:0 20px}header{padding:28px 32px;border-radius:20px;background:linear-gradient(135deg,#087fb5,#16a47f);color:#fff}h1{margin:0 0 6px}section{margin:22px 0}h2{display:flex;gap:10px;align-items:center}h2 small{font-size:13px;color:#648091}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px}.cards a{display:flex;flex-direction:column;padding:14px 16px;border:1px solid #d8e5ec;border-radius:12px;background:#fff;color:#172033;text-decoration:none}.cards a:hover{border-color:#0797aa}.cards span{color:#718391;font-size:13px;margin-top:3px}aside{margin:18px 0;padding:15px 18px;border:1px solid #efbd8d;border-radius:12px;background:#fff6ed}aside div{margin-top:5px}</style></head><body><main class="wrap"><header><h1>全国单源景点批量补全预览</h1><div>共 ${items.length} 项；逐项点击检查。确认后只需回到总控批准一次。</div></header>${failure}${sections}</main></body></html>`;
}

async function main() {
  let manifest = readJson(manifestPath, null);
  if (!manifest) throw new Error('批次清单不存在。');
  const readyStates = manifest.provinces.filter(item => item.status === 'ready');
  if (!readyStates.length) throw new Error('批次中没有可预览省份。');
  const previewRoot = path.join(runtimeDir, 'previews', 'observation-batch');
  const stagingRoot = `${previewRoot}.next`;
  const siteDir = path.join(stagingRoot, 'site');
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  fs.mkdirSync(stagingRoot, { recursive: true });
  fs.cpSync(path.join(rootDir, 'dist'), siteDir, { recursive: true });
  const searchPath = path.join(siteDir, 'data', 'search-index.json');
  const search = readJson(searchPath, []);
  const lazyOverrides = {
    ...readJson(path.join(contentDir, 'lazy-guide-overrides.json'), {}),
    ...readJson(path.join(runtimeDir, 'core-lazy-guide-overrides.json'), {}),
  };
  const previewItems = [];
  for (const state of readyStates) {
    const packageData = readJson(path.join(contentDir, `core-repair-packages.${state.slug}.json`), null);
    if (packageData?.status !== 'reviewed') throw new Error(`${state.province}补全包状态已变化，请重新续跑。`);
    const provincePath = path.join(siteDir, 'data', 'provinces', `${state.slug}.json`);
    const provinceData = readJson(provincePath, null);
    if (!provinceData?.attractions) throw new Error(`${state.province}静态数据不存在。`);
    for (const raw of packageData.attractions || []) {
      const item = JSON.parse(JSON.stringify(raw));
      merge(item, lazyOverrides[item.id] || {});
      delete item.baselineKey;
      delete item.quality_policy;
      validateManualAttraction(item, state.province);
      if (provinceData.attractions.some(existing => existing.id === item.id || probablySameAttraction(existing.name, item.name))) throw new Error(`${state.province}发现疑似重复：${item.name}`);
      provinceData.attractions.push(item);
      copyLocalImage(item, siteDir);
      search.push({ province: state.province, provinceId: state.slug, ...item });
      previewItems.push({ ...item, province: state.province });
    }
    for (const [id, patch] of Object.entries(packageData.overrides || {})) {
      const target = provinceData.attractions.find(item => item.id === id);
      if (!target) throw new Error(`${state.province}找不到待增强景点：${id}`);
      merge(target, patch);
      merge(target, lazyOverrides[id] || {});
      validateManualAttraction(target, state.province);
      copyLocalImage(target, siteDir);
      const searchTarget = search.find(item => item.id === id);
      if (searchTarget) merge(searchTarget, target);
      previewItems.push({ ...target, province: state.province });
    }
    writeJson(provincePath, provinceData);
  }
  writeJson(searchPath, search);
  const version = `observation_batch_${Date.now()}`;
  const appPath = path.join(siteDir, 'app.js');
  fs.writeFileSync(appPath, fs.readFileSync(appPath, 'utf8').replace(/const STATIC_DATA_VERSION\s*=\s*["'][^"']+["'];/, `const STATIC_DATA_VERSION = "${version}";`) + `\n;(() => { const q=new URLSearchParams(location.search).get('previewSearch'); if(!q)return; const run=()=>{const el=document.getElementById('global-search');if(!el)return setTimeout(run,200);el.value=q;el.dispatchEvent(new Event('input',{bubbles:true}));};setTimeout(run,500);})();\n`, 'utf8');
  const indexPath = path.join(siteDir, 'index.html');
  fs.writeFileSync(indexPath, fs.readFileSync(indexPath, 'utf8').replace(/(<script\b[^>]*\bsrc=["'](?:\.\/|\/)?app\.js)(?:\?[^"']*)?(["'][^>]*>)/i, `$1?v=${version}$2`), 'utf8');
  stopPreviews();
  await new Promise(resolve => setTimeout(resolve, 250));
  fs.rmSync(previewRoot, { recursive: true, force: true });
  fs.renameSync(stagingRoot, previewRoot);
  let port = 3108;
  while (port < 3113 && !await portAvailable(port)) port += 1;
  if (port >= 3113) throw new Error('预览端口 3108-3112 均被占用。');
  const finalSiteDir = path.join(previewRoot, 'site');
  const child = spawn(process.execPath, [path.join('server', 'index.js')], { cwd: rootDir, detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), STATIC_DIR: finalSiteDir, SERVICE_NAME: 'lvyoumap-observation-batch-preview' } });
  child.unref();
  await waitForHealth(`http://127.0.0.1:${port}/api/health`);
  const baseUrl = `http://127.0.0.1:${port}`;
  fs.writeFileSync(path.join(finalSiteDir, 'preview.html'), previewHtml(previewItems, baseUrl, manifest.provinces.filter(item => item.status === 'failed')), 'utf8');
  writeJson(path.join(previewRoot, 'state.json'), { status: 'ready', pid: child.pid, port, previewUrl: `${baseUrl}/preview.html`, manifestPath, batchId: manifest.id, itemCount: previewItems.length, generatedAt: new Date().toISOString() });
  manifest = updateBatch(manifestPath, { previewUrl: `${baseUrl}/preview.html`, previewItemCount: previewItems.length });
  console.log(`全国单源批次预览已生成：${manifest.previewUrl}`);
}

main().catch(error => {
  console.error(`生成全国批次预览失败：${error.message}`);
  process.exitCode = 1;
});
