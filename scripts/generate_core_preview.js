const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { validateManualAttraction, probablySameAttraction } = require('./generate_static_data');

const rootDir = path.join(__dirname, '..');
const contentDir = path.join(rootDir, 'content');
const runtimeDir = path.join(rootDir, '.runtime');
const args = new Map(process.argv.slice(2).map(arg => {
  const match = arg.match(/^--([^=]+)=(.*)$/);
  return match ? [match[1], match[2]] : [arg.replace(/^--/, ''), true];
}));
const province = String(args.get('province') || '').trim();
const port = Number(args.get('port') || 3108);
if (!province) throw new Error('请使用 --province=省份。');

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\r\n`, 'utf8');
}

function previewBuildFingerprint() {
  const hash = crypto.createHash('sha256');
  for (const relativePath of ['index.html', 'app.js', 'style.css']) {
    const filePath = path.join(rootDir, 'dist', relativePath);
    hash.update(relativePath);
    hash.update(fs.readFileSync(filePath));
  }
  return hash.digest('hex');
}

function provinceInfo(name) {
  const db = readJson(path.join(contentDir, 'db.json'), { provinces: {} });
  const data = db.provinces?.[name];
  return data ? { slug: data.id || data.slug, data } : null;
}

function merge(target, patch) {
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      target[key] = merge(target[key] && typeof target[key] === 'object' && !Array.isArray(target[key]) ? target[key] : {}, value);
    } else {
      target[key] = value;
    }
  }
  return target;
}

function stopPrevious(statePath) {
  const state = readJson(statePath);
  const pid = Number(state?.pid || 0);
  if (!pid) return;
  try { process.kill(pid); } catch {}
}

function waitForHealth(url, attempts = 30) {
  return new Promise((resolve, reject) => {
    let remaining = attempts;
    const check = () => {
      http.get(url, response => {
        response.resume();
        if (response.statusCode === 200) return resolve();
        if (--remaining <= 0) return reject(new Error(`预览健康检查返回 HTTP ${response.statusCode}`));
        setTimeout(check, 300);
      }).on('error', () => {
        if (--remaining <= 0) return reject(new Error('预览服务未能启动。'));
        setTimeout(check, 300);
      });
    };
    check();
  });
}

function previewHtml(items, previewUrl, packageWarnings = []) {
  const links = items.map((item, index) => (
    `<li><span>${String(index + 1).padStart(2, '0')}</span><a href="${previewUrl}/?previewSearch=${encodeURIComponent(item.name)}">${item.name}</a><small>${item.city || province} · ${item.level || item.category}</small></li>`
  )).join('');
  const warningHtml = packageWarnings.length ? `<div class="warnings"><strong>需要人工留意的非阻断项（${packageWarnings.length}）</strong><ul>${packageWarnings.map(value => `<li>${value}</li>`).join('')}</ul></div>` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${province}核心景点补全预览</title><style>body{margin:0;background:#f4f8fb;color:#172033;font:15px/1.6 system-ui,-apple-system,"Microsoft YaHei",sans-serif}.wrap{max-width:900px;margin:36px auto;padding:0 20px}header{background:linear-gradient(135deg,#087fb5,#13a786);color:white;border-radius:18px;padding:28px 30px;box-shadow:0 12px 30px #0a668326}h1{margin:0 0 8px;font-size:28px}p{margin:0;opacity:.9}ol{list-style:none;padding:0;margin:22px 0;display:grid;gap:10px}ol li{display:grid;grid-template-columns:42px 1fr auto;align-items:center;background:white;border:1px solid #dce8ef;border-radius:12px;padding:13px 16px;box-shadow:0 4px 12px #31586c0a}ol li span{color:#0796a3;font-weight:700}a{color:#172033;text-decoration:none;font-weight:700;font-size:16px}a:hover{color:#008bc7}small{color:#6f8190}.note,.warnings{background:#fff8df;border:1px solid #f2d98b;border-radius:12px;padding:14px 18px;margin-top:12px}.warnings{background:#fff4ed;border-color:#f3b58f}.warnings ul{margin:8px 0 0;padding-left:22px}.warnings li{margin:4px 0} @media(max-width:640px){.wrap{margin:18px auto}ol li{grid-template-columns:34px 1fr}small{grid-column:2}}</style></head><body><main class="wrap"><header><h1>${province}核心景点补全预览</h1><p>共 ${items.length} 条；点击景点进入地图搜索结果，再打开详情检查三个页签。</p></header>${warningHtml}<ol>${links}</ol><div class="note">这是隔离预览，不会写入 beta 正式数据。确认全部正常后，回到数据维护总控执行第二次确认。</div></main></body></html>`;
}

function localEnvHasAmapKey() {
  const filePath = path.join(rootDir, '.env');
  if (!fs.existsSync(filePath)) return false;
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).some(line => /^\s*AMAP_WEB_SERVICE_KEY\s*=\s*\S+/.test(line));
}

async function main() {
  const info = provinceInfo(province);
  if (!info) throw new Error(`无法识别省份：${province}`);
  const packagePath = path.join(contentDir, `core-repair-packages.${info.slug}.json`);
  const packageData = readJson(packagePath);
  if (packageData?.status !== 'reviewed') throw new Error(`${province}补全包尚未通过质量闸门。`);
  const lazyOverrides = {
    ...readJson(path.join(contentDir, 'lazy-guide-overrides.json'), {}),
    ...readJson(path.join(runtimeDir, 'core-lazy-guide-overrides.json'), {}),
  };
  const additions = (packageData.attractions || []).map(item => {
    const candidate = merge(JSON.parse(JSON.stringify(item)), lazyOverrides[item.id] || {});
    delete candidate.baselineKey;
    delete candidate.quality_policy;
    validateManualAttraction(candidate, province);
    return candidate;
  });
  const overrideEntries = Object.entries(packageData.overrides || {});
  if (!additions.length && !overrideEntries.length) throw new Error('补全包中没有可预览景点。');

  const previewRoot = path.join(runtimeDir, 'previews', info.slug);
  const siteDir = path.join(previewRoot, 'site');
  const statePath = path.join(previewRoot, 'state.json');
  stopPrevious(statePath);
  if (fs.existsSync(previewRoot)) fs.rmSync(previewRoot, { recursive: true, force: true });
  fs.mkdirSync(previewRoot, { recursive: true });
  fs.cpSync(path.join(rootDir, 'dist'), siteDir, { recursive: true });

  const provincePath = path.join(siteDir, 'data', 'provinces', `${info.slug}.json`);
  const provinceData = readJson(provincePath);
  if (!provinceData?.attractions) throw new Error(`预览基础数据不存在：${provincePath}`);
  for (const addition of additions) {
    const duplicate = provinceData.attractions.find(item => item.id === addition.id || probablySameAttraction(item.name, addition.name));
    if (duplicate) throw new Error(`隔离预览发现疑似重复：${addition.name} / ${duplicate.name}`);
    provinceData.attractions.push(addition);
    if (addition.image.startsWith('/')) {
      const source = path.join(rootDir, addition.image.slice(1));
      const target = path.join(siteDir, addition.image.slice(1));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
    }
  }
  const previewOverrides = [];
  for (const [id, patch] of overrideEntries) {
    const target = provinceData.attractions.find(item => item.id === id);
    if (!target) throw new Error(`隔离预览找不到待增强景点：${id}`);
    merge(target, patch);
    validateManualAttraction(target, province);
    previewOverrides.push(target);
    if (target.image?.startsWith('/')) {
      const source = path.join(rootDir, target.image.slice(1));
      const targetPath = path.join(siteDir, target.image.slice(1));
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(source, targetPath);
    }
  }
  writeJson(provincePath, provinceData);

  const searchPath = path.join(siteDir, 'data', 'search-index.json');
  const search = readJson(searchPath, []);
  additions.forEach(item => search.push({
    province,
    provinceId: info.slug,
    id: item.id,
    name: item.name,
    city: item.city,
    level: item.level,
    rating: item.rating,
    reviewsCount: item.reviewsCount,
    price: item.price,
    intro: item.intro,
    address: item.address,
    image: item.image,
  }));
  for (const item of previewOverrides) {
    const target = search.find(record => record.id === item.id);
    if (target) merge(target, item);
  }
  writeJson(searchPath, search);

  const indexPath = path.join(siteDir, 'data', 'provinces-index.json');
  const index = readJson(indexPath, {});
  if (index[province]) index[province].attractionCount = provinceData.attractions.length;
  writeJson(indexPath, index);

  const appPath = path.join(siteDir, 'app.js');
  fs.appendFileSync(appPath, `\n;(() => { const q = new URLSearchParams(location.search).get('previewSearch'); if (!q) return; const run = () => { const el = document.getElementById('global-search'); if (!el) return setTimeout(run, 200); el.value = q; el.dispatchEvent(new Event('input', { bubbles: true })); }; setTimeout(run, 500); })();\n`, 'utf8');
  const previewUrl = `http://127.0.0.1:${port}`;
  const previewItems = [...additions, ...previewOverrides];
  fs.writeFileSync(path.join(siteDir, 'preview.html'), previewHtml(previewItems, previewUrl, packageData.warnings || []), 'utf8');

  const child = spawn(process.execPath, [path.join('server', 'index.js')], {
    cwd: rootDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), STATIC_DIR: siteDir, SERVICE_NAME: `lvyoumap-preview-${info.slug}` },
  });
  child.unref();
  await waitForHealth(`${previewUrl}/api/health`);
  const state = { province, slug: info.slug, pid: child.pid, port, siteDir, previewUrl: `${previewUrl}/preview.html`, status: 'ready', generatedAt: new Date().toISOString(), buildFingerprint: previewBuildFingerprint(), attractionIds: previewItems.map(item => item.id), ratingMode: localEnvHasAmapKey() ? 'live-amap-enabled' : 'local-snapshot' };
  writeJson(statePath, state);
  console.log(`${province}隔离预览已生成：新增 ${additions.length}，增强现有 ${previewOverrides.length}。`);
  console.log(`预览清单：${state.previewUrl}`);
  console.log('预览不会修改 beta 正式数据。');
}

main().catch(error => {
  console.error(`生成隔离预览失败：${error.message}`);
  process.exitCode = 1;
});
