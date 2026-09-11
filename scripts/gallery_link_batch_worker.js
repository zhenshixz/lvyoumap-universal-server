const C = require('./gallery_link_batch_common');
const { fs, path, root, runtime, runs, read, write, alive, draft, batchList, batchPath, tripUrl, sourcePolicy } = C;
const { load } = require('cheerio');
const { parseTripAttractionGallery } = require('./gallery_source_parsers');
const simplify = require('opencc-js').Converter({ from: 'tw', to: 'cn' });
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const lockFile = path.join(runtime, 'worker.lock');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let state, dir, heartbeat, awake, ownsLock = false;
const now = () => new Date().toISOString();
const norm = s => simplify(String(s || '')).replace(/[\s·（）()\-_—]/g, '');
function checkpoint() { state.heartbeatAt = now(); write(path.join(dir, 'state.json'), state); }
function errorText(e) { return String(e.code || e.cause?.code || e.message || e.name).replace(/key=[^&\s]+/gi, 'key=[redacted]').slice(0, 240); }
function imageAllowed(url, source) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  return source === 'trip' ? /(^|\.)tripcdn\.com$/.test(u.hostname) : /(^|\.)(amap\.com|autonavi\.com)$/.test(u.hostname);
}
async function fetchBounded(url, kind) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'zh-CN,zh;q=0.9' }, signal: AbortSignal.timeout(12000), redirect: 'error' });
      if (!response.ok) {
        const e = Error(`HTTP ${response.status}`); e.retry = response.status === 429 || response.status >= 500;
        await response.body?.cancel(); throw e;
      }
      if (kind === 'image' && !response.headers.get('content-type')?.startsWith('image/')) { await response.body?.cancel(); throw Error('响应不是图片'); }
      let bytes = 0; const chunks = [];
      const limit = kind === 'image' ? 24 * 1024 * 1024 : 16 * 1024 * 1024;
      for await (const chunk of response.body) { bytes += chunk.length; if (bytes > limit) throw Error('响应超过大小限制'); chunks.push(chunk); }
      return Buffer.concat(chunks);
    } catch (e) {
      last = e;
      if (attempt || !(e.retry || e.name === 'TimeoutError' || e.name === 'TypeError')) break;
      state.current.phase = '短暂重试等待'; checkpoint(); await sleep(2000);
    }
  }
  throw last;
}
async function download(item, url, source, index) {
  const key = crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
  const existing = item.images.find(x => x.url === url);
  if (existing?.raw || existing?.file) return;
  const image = { source, index, url };
  try {
    if (!imageAllowed(url, source)) throw Error('图片主机不在来源白名单');
    const data = await fetchBounded(url, 'image');
    image.raw = `raw/${item.id}-${source}-${key}.jpg`; image.bytes = data.length;
    fs.writeFileSync(path.join(dir, image.raw), data);
  } catch (e) { image.reason = errorText(e); image.accepted = false; }
  item.images.push(image); checkpoint();
}
async function collectTrip(item) {
  if (!item.url) { item.trip = { status: 'skipped', reason: '未填写Trip地址' }; return; }
  const url = tripUrl(item.url), poiId = new URL(url).pathname.match(/-(\d+)\/$/)[1];
  const html = (await fetchBounded(url, 'page')).toString('utf8');
  const parsed = parseTripAttractionGallery(html, poiId);
  const $ = load(html);
  // Name plus the leading detail section's region, excluding nearby recommendations.
  const leading = simplify($('body').text()).split(/其他旅客|附近的酒店|附近的景点/)[0];
  const nameMatch = [item.name, item.pageName].filter(Boolean).map(norm).includes(norm(parsed.name));
  const regionMatch = !item.region || leading.includes(simplify(item.region));
  // The saved URL is the user's explicit entity approval. Keep heuristic checks
  // as review hints only; Trip frequently prefixes a parent attraction/city.
  item.trip = { name: parsed.name, poiId, nameMatch, regionMatch, available: parsed.photos.length };
  const photos = parsed.photos.slice(0, 5);
  for (let i = 0; i < photos.length; i += 2) await Promise.all(photos.slice(i, i + 2).map((p, j) => download(item, p.imageUrl, 'trip', i + j + 1)));
  item.trip.status = photos.length ? 'collected' : 'empty';
}
function amapKey() {
  const vars = {};
  if (fs.existsSync(path.join(root, '.env'))) for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/); if (m) vars[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return vars.AMAP_WEB_SERVICE_KEY || process.env.AMAP_WEB_SERVICE_KEY || '';
}
async function collectAmap(item, key, policy) {
  if (policy.amapDisabled) {
    item.amap = { status: 'temporarily_disabled', reason: policy.amapReason || `高德临时停用至 ${policy.amapDisabledUntil}` };
    return;
  }
  if (!key) { item.amap = { status: 'missing_key', reason: 'beta .env未配置高德Key' }; return; }
  if (state.amapQuota) { item.amap = { status: 'quota', reason: '本批次已遇高德额度限制，跳过重复请求' }; return; }
  const u = new URL('https://restapi.amap.com/v5/place/detail');
  u.search = new URLSearchParams({ key, id: item.id.replace(/^amap_/, ''), show_fields: 'photos' }).toString();
  const data = JSON.parse((await fetchBounded(u.href, 'page')).toString('utf8'));
  if (data.status !== '1') {
    if (['10003', '10004', '10044'].includes(data.infocode)) state.amapQuota = true;
    item.amap = { status: 'api_error', reason: `${data.infocode}: ${data.info}` }; return;
  }
  const poi = data.pois?.find(p => p.id === item.id.replace(/^amap_/, ''));
  if (!poi) throw Error('高德未返回精确POI');
  item.amap = { name: poi.name, available: poi.photos?.length || 0 };
  if (poi.photos?.[0]?.url) { await download(item, poi.photos[0].url, 'amap', 1); item.amap.status = 'collected'; }
  else item.amap.status = 'empty';
}
async function main() {
  if (alive(read(path.join(runtime, 'apply.lock'))?.pid)) throw Error('正在写入Beta，请等待完成');
  const old = read(lockFile);
  if (alive(old?.pid)) throw Error('已有批处理运行，请查看进度');
  if (old) fs.unlinkSync(lockFile);
  const fd = fs.openSync(lockFile, 'wx'); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: now() })); fs.closeSync(fd); ownsLock = true;
  const input = draft(); if (!input.savedAt) throw Error('请先在清单网页点击保存');
  const resumeId = process.argv.find(a => a.startsWith('--resume='))?.slice(9);
  const latest = resumeId ? batchList().find(b => b.id === resumeId) : batchList()[0];
  if (resumeId && !latest) throw Error('找不到需要继续的批次');
  const previous = latest ? read(path.join(batchPath(latest.id), 'state.json')) : null;
  const reviewBlocked = previous?.items?.filter(x => x.trip?.status === 'identity_review' && !(x.images || []).some(y => y.accepted)) || [];
  const sameInput = previous && (previous.revision === input.revision || (input.draftId && previous.draftId === input.draftId && JSON.stringify(previous.items.map(i => [i.id,i.url,i.skip])) === JSON.stringify(input.items.map(i => [i.id,i.url,i.skip]))));
  if (previous && (['running', 'interrupted'].includes(previous.status) || reviewBlocked.length) && sameInput) {
    state = previous; dir = batchPath(latest.id);
    state.amapQuota = false; // A resumed session may be on a new day.
    for (const item of reviewBlocked) { item.done = false; delete item.trip; delete item.result; }
  } else {
    const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(/[-: ]/g, '');
    const id = stamp.slice(0, 8) + '-' + stamp.slice(8) + '-' + crypto.randomBytes(3).toString('hex');
    dir = path.join(runs, id); fs.mkdirSync(dir);
    write(path.join(dir, 'input.json'), input);
    state = { id, revision: input.revision, draftId: input.draftId, createdAt: now(), items: input.items.map(x => ({ ...x, done: false, images: [] })) };
  }
  fs.mkdirSync(path.join(dir, 'raw'), { recursive: true });
  state.pid = process.pid; state.status = 'running'; state.current = { phase: '准备' }; checkpoint();
  heartbeat = setInterval(checkpoint, 3000);
  const policy = sourcePolicy();
  const key = policy.amapDisabled ? '' : amapKey();
  state.sourcePolicy = policy;
  const python = require('./gallery_link_batch_python').resolvePython();
  for (const item of state.items) {
    if (item.done) continue;
    if (item.skip) { item.done = true; item.result = '已跳过'; checkpoint(); continue; }
    const manifest = path.join(dir, `${item.id}.json`);
    const previousQA = read(manifest, []);
    item.images = [
      ...(item.images || []).map(x => previousQA.find(y => y.url === x.url && y.accepted !== undefined) || x),
      ...previousQA.filter(y => !(item.images || []).some(x => x.url === y.url)),
    ];
    state.current = { name: item.name, phase: 'Trip详情页与图片' }; checkpoint();
    if (!item.trip?.status) { try { await collectTrip(item); } catch (e) { item.trip = { status: 'error', reason: errorText(e) }; } checkpoint(); }
    state.current.phase = '高德首图'; checkpoint();
    if (!item.amap?.status) { try { await collectAmap(item, key, policy); } catch (e) { item.amap = { status: 'error', reason: errorText(e) }; } checkpoint(); }
    state.current.phase = '图片筛选与缩略图'; checkpoint();
    write(manifest, item.images);
    const q = spawnSync(python, [path.join(__dirname, 'gallery_link_batch_quality.py'), manifest], { windowsHide: true, timeout: 60000, encoding: 'utf8' });
    if (q.status !== 0) throw Error('图片处理失败，请检查Python依赖；再次启动可续跑');
    item.images = read(manifest); item.done = true;
    const count = item.images.filter(x => x.accepted).length;
    item.result = count ? `${count}张候选，待人工验收` : '暂无合格候选'; checkpoint();
  }
  state.status = 'completed'; state.completedAt = now(); state.current = null; checkpoint();
}
async function run() {
  state = undefined; dir = undefined;
  if (process.platform === 'win32') {
    awake = require('child_process').spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'gallery_keep_awake.ps1'), '-WorkerPid', String(process.pid)], { windowsHide: true, stdio: 'ignore' });
    awake.on('error', () => {});
  }
  try { await main(); }
  catch (e) { if (state) { state.status = 'interrupted'; state.error = errorText(e); checkpoint(); } throw e; }
  finally { clearInterval(heartbeat); awake?.kill(); if (ownsLock) { fs.unlinkSync(lockFile); ownsLock = false; } }
}
module.exports = { run };
if (require.main === module) run().catch(e => { console.error(errorText(e)); process.exitCode = 1; });
