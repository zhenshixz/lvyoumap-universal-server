const C = require('./gallery_link_batch_common');
const { fs, path, root, runtime, runs, read, write, alive, draft, batchList, batchPath, tripUrl, sourcePolicy } = C;
const { load } = require('cheerio');
const { parseTripAttractionGallery, parseTripShopGallery } = require('./gallery_source_parsers');
const simplify = require('opencc-js').Converter({ from: 'tw', to: 'cn' });
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const { TRIP_432_RETRIES, TRIP_432_DELAY_MS, classify, history, previousAttempt, transient, policyUpgrade } = require('./gallery_retry_policy');
const lockFile = path.join(runtime, 'worker.lock');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let state, dir, heartbeat, awake, discovery, ownsLock = false;
const autoDiscover = process.argv.includes('--auto-discover');
const retryTransientOnly = process.argv.includes('--retry-transient-only');
const resumeIpBlocked = process.argv.includes('--resume-ip-blocked');
const now = () => new Date().toISOString();
const norm = s => simplify(String(s || '')).replace(/[\s·（）()\-_—]/g, '');
function checkpoint() { state.heartbeatAt = now(); write(path.join(dir, 'state.json'), state); }
function errorText(e) { return String(e.code || e.cause?.code || e.message || e.name).replace(/key=[^&\s]+/gi, 'key=[redacted]').slice(0, 240); }
function imageAllowed(url, source) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  return source === 'trip' ? /(^|\.)tripcdn\.com$/.test(u.hostname) : /(^|\.)(amap\.com|autonavi\.com)$/.test(u.hostname);
}
async function fetchBounded(url, kind, request = {}) {
  let last;
  const tripPage = kind === 'page' && new URL(url).hostname === 'hk.trip.com';
  const attempts = 2;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url, { ...request, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'zh-CN,zh;q=0.9', ...request.headers }, signal: AbortSignal.timeout(12000), redirect: 'error' });
      if (!response.ok) {
        const e = Error(`HTTP ${response.status}`);
        e.retry = response.status === 429 || response.status === 432 || response.status >= 500;
        if (response.status === 432 && tripPage) {
          const count = (state.tripThrottle?.consecutive432 || 0) + 1;
          const delayMs = TRIP_432_DELAY_MS;
          state.tripThrottle = { consecutive432: count, total432: (state.tripThrottle?.total432 || 0) + 1,
            lastAt: now(), delayMs, reason: 'Trip WhaleGuard HTTP 432' };
          e.delayMs = delayMs;
          e.ipBlocked = true;
          state.current.phase = '检测到 HTTP 432，暂停等待切换 IP';
          checkpoint();
        }
        await response.body?.cancel(); throw e;
      }
      if (kind === 'image' && !response.headers.get('content-type')?.startsWith('image/')) { await response.body?.cancel(); throw Error('响应不是图片'); }
      let bytes = 0; const chunks = [];
      const limit = kind === 'image' ? 24 * 1024 * 1024 : 16 * 1024 * 1024;
      for await (const chunk of response.body) { bytes += chunk.length; if (bytes > limit) throw Error('响应超过大小限制'); chunks.push(chunk); }
      return Buffer.concat(chunks);
    } catch (e) {
      last = e;
      if (e.ipBlocked || attempt === attempts - 1 || !(e.retry || e.name === 'TimeoutError' || e.name === 'TypeError')) break;
      const delayMs = e.delayMs || 2000;
      state.current.phase = e.delayMs ? `Trip风控冷却 ${Math.ceil(delayMs / 1000)}秒` : '短暂重试等待';
      checkpoint(); await sleep(delayMs);
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
  if (!item.url) { item.trip = { status: 'skipped', reason: item.discovery?.reason || '未填写Trip地址' }; return; }
  const url = tripUrl(item.url), poiId = new URL(url).pathname.match(/-(\d+)\/$/)[1];
  const html = (await fetchBounded(url, 'page')).toString('utf8');
  if (state.tripThrottle?.consecutive432) {
    state.tripThrottle.recoveredAt = now();
    state.tripThrottle.consecutive432 = 0;
  }
  let parsed;
  if (new URL(url).pathname.startsWith('/travel-guide/shops/')) {
    const payload = JSON.parse((await fetchBounded('https://hk.trip.com/restapi/soa2/27316/SearchPoiImageInfo', 'page', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ poiId: Number(poiId), videoId: null, locale: 'zh-HK', pageIndex: 1, pageSize: 20 }),
    })).toString('utf8'));
    parsed = parseTripShopGallery(html, payload, poiId);
  } else parsed = parseTripAttractionGallery(html, poiId);
  if (parsed.noImageConfirmed) {
    item.trip = {status:'no_image_available',reason:'Trip确认无图库，仅默认占位图；已关闭补图',poiId,noImageConfirmed:true,evidence:parsed.evidence,sourceUrl:url};
    item.noImageClosed=true; return;
  }
  const $ = load(html);
  // Name plus the leading detail section's region, excluding nearby recommendations.
  const leading = simplify($('body').text()).split(/其他旅客|附近的酒店|附近的景点/)[0];
  const nameMatch = [item.name, item.pageName].filter(Boolean).map(norm).includes(norm(parsed.name));
  const regionMatch = !item.region || leading.includes(simplify(item.region));
  // The saved URL is the user's explicit entity approval. Keep heuristic checks
  // as review hints only; Trip frequently prefixes a parent attraction/city.
  item.trip = { name: parsed.name || item.name, poiId, nameMatch, regionMatch, available: parsed.available ?? parsed.photos.length };
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
  const resumeId = process.argv.find(a => a.startsWith('--resume='))?.slice(9);
  const retryInput = (retryTransientOnly || resumeIpBlocked) && resumeId ? read(path.join(batchPath(resumeId), 'input.json')) : null;
  const input = retryInput || draft();
  if (!input.savedAt && !autoDiscover && !retryTransientOnly && !resumeIpBlocked) throw Error('请先在清单网页点击保存');
  const latest = resumeId ? batchList().find(b => b.id === resumeId) : batchList()[0];
  if (resumeId && !latest) throw Error('找不到需要继续的批次');
  const previous = latest ? read(path.join(batchPath(latest.id), 'state.json')) : null;
  const reviewBlocked = previous?.items?.filter(x => (retryTransientOnly
    ? classify(x) === 'retry'
    : ['identity_review', 'unsupported_layout'].includes(x.trip?.status) || classify(x) === 'retry')
    && !(x.images || []).some(y => y.accepted)) || [];
  const quickRetryTargets = retryTransientOnly ? reviewBlocked.map(x => ({
    id: x.id, name: x.name, reason: x.trip?.reason || x.discovery?.reason || '临时网络失败',
  })) : [];
  const originalItems = previous ? (read(path.join(batchPath(latest.id), 'input.json'))?.items || previous.items) : [];
  const sameInput = previous && (retryTransientOnly || resumeIpBlocked || (!!previous.autoDiscover === autoDiscover && (previous.revision === input.revision || (input.draftId && previous.draftId === input.draftId && JSON.stringify(originalItems.map(i => [i.id,i.url,i.skip])) === JSON.stringify(input.items.map(i => [i.id,i.url,i.skip]))))));
  if (previous && (retryTransientOnly || resumeIpBlocked || ['running', 'interrupted', 'ip_blocked'].includes(previous.status) || reviewBlocked.length) && sameInput) {
    state = previous; dir = batchPath(latest.id);
    if (retryTransientOnly && !reviewBlocked.length) throw Error('本批没有可重跑的风控或网络失败项');
    state.amapQuota = false; // A resumed session may be on a new day.
    for (const item of reviewBlocked) {
      item.done=false; delete item.trip; delete item.result;
      const upgrade=policyUpgrade(item);
      item.images=(item.images||[]).filter(im=>(im.bytes || !transient(im.reason)) && !(upgrade && im.reason==='尺寸不足' && im.dimensions?.[0]>540));
      if(upgrade && item.discovery?.status==='manual') delete item.discovery;
      write(path.join(dir, `${item.id}.json`),item.images);
    }
  } else {
    const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(/[-: ]/g, '');
    const id = stamp.slice(0, 8) + '-' + stamp.slice(8) + '-' + crypto.randomBytes(3).toString('hex');
    dir = path.join(runs, id); fs.mkdirSync(dir);
    write(path.join(dir, 'input.json'), input);
    state = { id, autoDiscover, revision: input.revision, draftId: input.draftId, createdAt: now(), items: input.items.map(x => ({ ...x, done: false, images: [] })) };
  }
  fs.mkdirSync(path.join(dir, 'raw'), { recursive: true });
  state.pid = process.pid; state.status = 'running'; delete state.error; delete state.ipBlocked; state.current = { phase: '准备' }; checkpoint();
  if (retryTransientOnly) state.quickRetry = { startedAt: now(), itemCount: quickRetryTargets.length, reason: '用户切换IP后快速重跑', items: quickRetryTargets };
  heartbeat = setInterval(checkpoint, 3000);
  const policy = sourcePolicy();
  const key = policy.amapDisabled ? '' : amapKey();
  state.sourcePolicy = policy;
  const python = require('./gallery_link_batch_python').resolvePython();
  const earlier = history(state.id);
  let searchFailures = 0;
  if (autoDiscover) discovery = new (require('./gallery_trip_discovery').Discovery)();
  for (const item of state.items) {
    if (item.done) continue;
    if (item.skip) { item.done = true; item.result = '已跳过'; checkpoint(); continue; }
    if (!item.url && item.discoveryCandidates?.length) {
      const cached = require('./gallery_trip_discovery').select(item, item.discoveryCandidates);
      if (cached.status === 'matched') {
        item.discovery = {...cached, reusedDraftCandidates:true, searchedAt:null, selectedAt:now(), queries:[item.name]};
        item.url = cached.url;
      }
    }
    const previous = previousAttempt(item, earlier);
    if (previous) {
      if (previous.trip?.noImageConfirmed) { item.trip={...previous.trip}; item.noImageClosed=true; item.done=true; item.result='当前图源无图，已关闭补图'; checkpoint(); continue; }
      item.trip = {status:'already_attempted',reason:item.url?'该Trip链接已成功尝试，不重复采集；请换链接或图源':'该景点需人工补充不同链接，不重复自动搜索',previousBatch:previous.batchId};
      item.done=true; item.result='等待更换链接或图源'; checkpoint(); continue;
    }
    const manifest = path.join(dir, `${item.id}.json`);
    const previousQA = read(manifest, []);
    item.images = [
      ...(item.images || []).map(x => previousQA.find(y => y.url === x.url && y.accepted !== undefined) || x),
      ...previousQA.filter(y => !(item.images || []).some(x => x.url === y.url)),
    ];
    if (autoDiscover && !item.url && item.discovery?.status !== 'manual') {
      state.current = { name: item.name, phase: 'Trip站内搜索与地域匹配' }; checkpoint();
      try {
        item.discovery = await discovery.find(item);
        searchFailures = 0;
        if (item.discovery.status === 'matched') { item.url = item.discovery.url; delete item.trip; }
      } catch (e) {
        item.discovery = { status: 'error', reason: errorText(e) }; checkpoint();
        searchFailures++;
        if (searchFailures >= 2) throw Error('连续两项搜索服务失败，已保留断点；网络恢复后点击自动搜索续跑');
        continue;
      }
      checkpoint();
    }
    state.current = { name: item.name, phase: 'Trip详情页与图片' }; checkpoint();
    if (!item.trip?.status) { try { await collectTrip(item); } catch (e) { item.trip = { status: 'error', reason: errorText(e) }; checkpoint(); if (e.ipBlocked) throw e; } }
    state.current.phase = '高德首图'; checkpoint();
    if (!item.amap?.status) { try { await collectAmap(item, key, policy); } catch (e) { item.amap = { status: 'error', reason: errorText(e) }; } checkpoint(); }
    state.current.phase = '图片筛选与缩略图'; checkpoint();
    write(manifest, item.images);
    const q = spawnSync(python, [path.join(__dirname, 'gallery_link_batch_quality.py'), manifest], { windowsHide: true, timeout: 60000, encoding: 'utf8' });
    if (q.status !== 0) throw Error('图片处理失败，请检查Python依赖；再次启动可续跑');
    item.images = read(manifest); item.qualityPolicyVersion = 2; item.done = true;
    const count = item.images.filter(x => x.accepted).length;
    item.result = item.trip?.noImageConfirmed ? '当前图源无图，已关闭补图' : count ? `${count}张候选，待人工验收` : '暂无合格候选'; checkpoint();
  }
  if (state.items.some(i => !i.done)) throw Error('部分搜索失败，已保留成功结果；点击自动搜索继续未完成项');
  write(path.join(dir, 'manual-pending.json'), state.items.filter(i => !i.skip && !i.trip?.noImageConfirmed && !i.images.some(im => im.accepted)).map(i => ({id:i.id,name:i.name,city:i.city,reason:i.discovery?.reason || i.trip?.reason || '未取得合格图片',url:i.url})));
  state.status = 'completed'; delete state.error; state.completedAt = now(); state.current = null; checkpoint();
}
async function run() {
  state = undefined; dir = undefined;
  if (process.platform === 'win32') {
    awake = require('child_process').spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'gallery_keep_awake.ps1'), '-WorkerPid', String(process.pid)], { windowsHide: true, stdio: 'ignore' });
    awake.on('error', () => {});
  }
  try { await main(); }
  catch (e) { if (state) { state.status = e.ipBlocked ? 'ip_blocked' : 'interrupted'; state.error = e.ipBlocked ? 'Trip 返回 HTTP 432，任务已暂停；请切换 IP 后继续' : errorText(e); if(e.ipBlocked) state.ipBlocked={at:now(),item:state.current?.name||'',reason:'HTTP 432'}; checkpoint(); } if(!e.ipBlocked) throw e; }
  finally { await discovery?.close(); clearInterval(heartbeat); awake?.kill(); if (ownsLock) { fs.unlinkSync(lockFile); ownsLock = false; } }
}
module.exports = { run };
if (require.main === module) run().catch(e => { console.error(errorText(e)); process.exitCode = 1; });
