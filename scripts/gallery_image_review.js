const C = require('./gallery_link_batch_common');
const { fs, path, root, runtime, read, write, alive } = C;
const { execFileSync } = require('child_process');
const { existingMap, imagesOf } = require('./gallery_existing_images');
const refillQueue = require('./gallery_refill_queue');

const overridesFile = base => path.join(base, 'content/attraction-gallery-overrides.json');
const decisionsFile = base => path.join(base, 'content/attraction-gallery-review-decisions.json');
const receiptFile = base => path.join(base, '.runtime/gallery-link-batches/image-review.json');
const qualityFile = base => path.join(base, '.runtime/gallery-link-batches/image-quality-scan.json');
let cache = null;

function runtimeImageMeta(base) {
  const map = new Map();
  const add = state => {
    for (const item of state?.items || []) for (const image of [...(item.selected || []), ...(item.images || [])]) {
      if (image.url) map.set(image.url, image);
    }
  };
  add(read(path.join(base, '.runtime/attraction-gallery-batch/state.json'), {}));
  const runs = path.join(base, '.runtime/gallery-link-batches/runs');
  if (fs.existsSync(runs)) for (const id of fs.readdirSync(runs)) add(read(path.join(runs, id, 'state.json'), {}));
  return map;
}

function localImagePath(base, url) {
  const value = String(url || '');
  if (value.startsWith('/assets/')) return path.join(base, value.slice(1));
  if (value.startsWith('assets/')) return path.join(base, value);
  return null;
}

function buildCatalog(base = root) {
  const map = existingMap(base);
  const runtimeMeta = runtimeImageMeta(base);
  const quality = read(qualityFile(base), { metrics: {} });
  const meta = new Map();
  const provinceDir = path.join(base, 'data/provinces');
  if (fs.existsSync(provinceDir)) for (const file of fs.readdirSync(provinceDir).filter(x => x.endsWith('.json'))) {
    const province = read(path.join(provinceDir, file), {});
    for (const item of province.attractions || []) meta.set(item.id, { province: province.province || '', city: item.city || '', name: item.name || item.id });
  }
  const refs = new Map();
  const cleanupUrls = new Set(refillQueue.cleanupReady(base).flatMap(item => (item.deferredReviewImages || []).filter(image => image.status === 'ready').map(image => `${item.id}\n${image.url}`)));
  for (const [id, item] of map) for (const image of imagesOf(item)) {
    const ids = refs.get(image.url) || new Set(); ids.add(id); refs.set(image.url, ids);
  }
  const all = [];
  for (const [id, item] of map) {
    const info = meta.get(id) || { province: '', city: item.city || '', name: item.name || id };
    const images = imagesOf(item);
    images.forEach((image, index) => {
      const url = image.url;
      const source = String(image.source || image.imageSource?.provider || item.image_source?.provider || 'unknown');
      const reasons = [];
      const qualityReasons = [];
      const sharedCount = refs.get(url)?.size || 1;
      const sharedWith = [...(refs.get(url) || [])].filter(otherId => otherId !== id).map(otherId => meta.get(otherId)?.name || otherId);
      const local = localImagePath(base, url);
      if (local && !fs.existsSync(local)) reasons.push('本地图片文件缺失');
      if (sharedCount > 1) reasons.push(`被 ${sharedCount} 个景点共用`);
      if (/subspot/i.test(source)) reasons.push('来自子景点，建议核对主体');
      if (/海报|宣传|导览|平面图|价目|二维码|拼图|攻略|活动图/i.test(String(image.caption || ''))) reasons.push('标题疑似宣传图或导览图');
      const runtime = runtimeMeta.get(url) || {};
      const measured = quality.metrics?.[url] || {};
      const dimensions = runtime.dimensions || (measured.width ? { width: measured.width, height: measured.height } : null);
      const width = Number(dimensions?.width || dimensions?.[0]) || 0;
      const height = Number(dimensions?.height || dimensions?.[1]) || 0;
      const sharpness = Number(measured.sharpness) || 0;
      if (/panoramio/i.test(`${url} ${image.caption || ''}`)) qualityReasons.push('Panoramio 旧游客照片，建议核对构图与年代感');
      if (width && height && Math.max(width, height) <= 720) qualityReasons.push(`分辨率较低（${width}×${height}）`);
      if (sharpness && sharpness < 180) qualityReasons.push(`清晰度偏低（${Math.round(sharpness)}）`);
      if (measured.brightness && measured.brightness < 35) qualityReasons.push('画面整体过暗');
      if (measured.brightness && measured.brightness > 225) qualityReasons.push('画面整体过亮');
      if (measured.clipping > 0.35) qualityReasons.push('大面积过曝或死黑');
      if (qualityReasons.length) reasons.push(...qualityReasons);
      const riskScore = reasons.reduce((sum, reason) => sum + (reason.includes('缺失') ? 100 : reason.includes('共用') ? 40 : reason.includes('POI') ? 30 : 20), 0);
      all.push({
        id, name: info.name, province: info.province, city: info.city, url,
        displayUrl: url.startsWith('assets/') ? '/' + url : url,
        caption: String(image.caption || ''), source, isCover: url === item.image || index === 0,
        imageCount: images.length, sharedCount, sharedWith, reasons, qualityReasons, riskScore,
        width, height, sharpness: measured.sharpness || null, postRefillReview: cleanupUrls.has(`${id}\n${url}`),
        collected: ['trip_exact', 'amap_exact'].includes(source), removable: images.length > 1,
      });
    });
  }
  all.sort((a, b) => Number(b.postRefillReview) - Number(a.postRefillReview) || b.riskScore - a.riskScore || a.province.localeCompare(b.province, 'zh-CN') || a.city.localeCompare(b.city, 'zh-CN') || a.name.localeCompare(b.name, 'zh-CN'));
  return { map, all };
}

function currentCatalog() {
  const file = overridesFile(root);
  const stat = fs.statSync(file);
  const qualityStat = fs.existsSync(qualityFile(root)) ? fs.statSync(qualityFile(root)) : null;
  const queue = refillQueue.queueFile(root);
  const queueStat = fs.existsSync(queue) ? fs.statSync(queue) : null;
  const signature = `${stat.mtimeMs}:${stat.size}:${qualityStat?.mtimeMs || 0}:${qualityStat?.size || 0}:${queueStat?.mtimeMs || 0}:${queueStat?.size || 0}`;
  if (!cache || cache.signature !== signature) cache = { signature, value: buildCatalog(root) };
  return cache.value;
}

function list(params = {}) {
  const scope = ['quality', 'post-refill', 'suspicious', 'collected', 'all'].includes(params.scope) ? params.scope : 'quality';
  const pageSize = Math.max(12, Math.min(80, Number(params.pageSize) || 48));
  const query = String(params.q || '').trim().toLowerCase();
  const catalog = currentCatalog();
  const scan = read(qualityFile(root), { count: 0, scannedAt: null });
  let items = catalog.all;
  if (scope === 'quality') items = items.filter(x => x.qualityReasons.length);
  if (scope === 'post-refill') items = items.filter(x => x.postRefillReview);
  if (scope === 'suspicious') items = items.filter(x => x.reasons.length);
  if (scope === 'collected') items = items.filter(x => x.collected);
  if (query) items = items.filter(x => [x.name, x.province, x.city, x.caption, x.source, x.url].some(value => String(value || '').toLowerCase().includes(query)));
  const defaultSelections = [];
  if (scope === 'quality' || scope === 'post-refill') {
    const selectedByAttraction = new Map();
    for (const item of items) {
      const selected = selectedByAttraction.get(item.id) || 0;
      if (selected < item.imageCount - 1) {
        defaultSelections.push({ id: item.id, url: item.url });
        selectedByAttraction.set(item.id, selected + 1);
      }
    }
  }
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.max(1, Math.min(pages, Number(params.page) || 1));
  const summary = {
    attractions: catalog.map.size,
    images: catalog.all.length,
    suspicious: catalog.all.filter(x => x.reasons.length).length,
    quality: catalog.all.filter(x => x.qualityReasons.length).length,
    shared: catalog.all.filter(x => x.sharedCount > 1).length,
    collected: catalog.all.filter(x => x.collected).length,
    protectedLast: catalog.all.filter(x => !x.removable).length,
    refillPending: refillQueue.pending(root).length,
    postRefillReview: catalog.all.filter(x => x.postRefillReview).length,
    scanned: Number(scan.count) || 0,
    scannedAt: scan.scannedAt || null,
  };
  return { scope, page, pageSize, pages, total: items.length, summary, defaultSelections, items: items.slice((page - 1) * pageSize, page * pageSize) };
}

function scanQuality(options = {}) {
  const base = options.root || root;
  if (path.basename(base).toLowerCase() !== 'lvyoumap-universal-serverbeta' && !options.allowTestRoot) throw Error('Beta only');
  if (!options.skipIdleCheck) require('./gallery_link_batch_actions').assertIdle();
  execFileSync(require('./gallery_link_batch_python').resolvePython(), [path.join(base, 'scripts/scan_gallery_image_quality.py')], { cwd: base, windowsHide: true, timeout: 300000, stdio: 'pipe' });
  cache = null;
  return list({ scope: 'quality', page: 1 });
}

function makeDeletePlan(selections, options = {}) {
  const base = options.root || root;
  if (!Array.isArray(selections) || !selections.length || selections.length > 1000) throw Error('请选择 1–1000 张要移除的图片');
  const catalog = buildCatalog(base);
  const grouped = new Map(), seen = new Set();
  for (const selection of selections) {
    const id = String(selection?.id || ''), url = String(selection?.url || '');
    const key = `${id}\n${url}`;
    if (!id || !url || seen.has(key)) throw Error('图片选择缺失或重复');
    seen.add(key);
    if (!catalog.all.some(x => x.id === id && x.url === url)) throw Error('图片已变化，请刷新审查页后重选');
    if (!grouped.has(id)) grouped.set(id, new Set()); grouped.get(id).add(url);
  }
  const items = [];
  for (const [id, removeUrls] of grouped) {
    const existing = catalog.map.get(id), before = imagesOf(existing);
    const removed = [...removeUrls].map(url => {
      const row = catalog.all.find(image => image.id === id && image.url === url);
      return {
        url,
        source: row?.source || 'unknown',
        reasons: row?.reasons || [],
        wasCover: !!row?.isCover,
      };
    });
    const remaining = before.filter(image => !removeUrls.has(image.url));
    if (!remaining.length) throw Error(`${existing?.name || id} 至少需要保留 1 张图片，请取消勾选其中一张`);
    const cover = removeUrls.has(existing.image) ? remaining[0].url : existing.image || remaining[0].url;
    const index = remaining.findIndex(image => image.url === cover);
    if (index > 0) remaining.unshift(...remaining.splice(index, 1));
    const info = catalog.all.find(image => image.id === id) || {};
    const deferredReviewImages = remaining.length === 1 ? catalog.all.filter(image => image.id === id && image.url === remaining[0].url).map(image => ({ url: image.url, source: image.source, reasons: image.qualityReasons.length ? image.qualityReasons : ['删除时因最后一张保护，补图后复审'] })) : [];
    items.push({ id, name: existing?.name || id, province: info.province || '', city: info.city || '', beforeUrls: before.map(x => x.url), removeUrls: [...removeUrls], removed, remaining, deferredReviewImages, coverUrl: remaining[0].url });
  }
  return { id: new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 17), createdAt: new Date().toISOString(), items };
}

function executeDelete(plan, options = {}) {
  const base = options.root || root;
  if (path.basename(base).toLowerCase() !== 'lvyoumap-universal-serverbeta' && !options.allowTestRoot) throw Error('Beta only');
  if (!options.skipIdleCheck) require('./gallery_link_batch_actions').assertIdle();
  const target = overridesFile(base), decisions = decisionsFile(base), queue = refillQueue.queueFile(base);
  const dataDir = path.join(base, 'data'), stage = path.join(base, '.dist-next'), dist = path.join(base, 'dist');
  const reviewRuntime = path.join(base, '.runtime/gallery-link-batches/image-review-backups');
  const backup = options.dir || path.join(reviewRuntime, plan.id), oldDist = path.join(backup, 'dist');
  const receipt = receiptFile(base);
  fs.mkdirSync(backup, { recursive: true });
  const hadData = fs.existsSync(dataDir), hadDist = fs.existsSync(dist), hadDecisions = fs.existsSync(decisions), hadQueue = fs.existsSync(queue);
  fs.copyFileSync(target, path.join(backup, 'overrides.json'));
  write(path.join(backup, 'delete-plan.json'), plan);
  if (hadDecisions) fs.copyFileSync(decisions, path.join(backup, 'decisions.json'));
  if (hadQueue) fs.copyFileSync(queue, path.join(backup, 'refill-queue.json'));
  fs.rmSync(path.join(backup, 'data'), { recursive: true, force: true });
  if (hadData) fs.cpSync(dataDir, path.join(backup, 'data'), { recursive: true });
  write(path.join(backup, 'metadata.json'), { hadData, hadDist, hadDecisions, hadQueue });
  const progress = { status: 'applying', pid: process.pid, startedAt: new Date().toISOString(), planId: plan.id, backup: path.relative(base, backup).replace(/\\/g, '/') };
  write(receipt, progress);
  const restore = () => {
    fs.copyFileSync(path.join(backup, 'overrides.json'), target);
    if (hadDecisions) fs.copyFileSync(path.join(backup, 'decisions.json'), decisions); else fs.rmSync(decisions, { force: true });
    if (hadQueue) fs.copyFileSync(path.join(backup, 'refill-queue.json'), queue); else fs.rmSync(queue, { force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (hadData) fs.cpSync(path.join(backup, 'data'), dataDir, { recursive: true });
    if (fs.existsSync(oldDist)) { fs.rmSync(dist, { recursive: true, force: true }); fs.renameSync(oldDist, dist); }
    fs.rmSync(stage, { recursive: true, force: true });
  };
  try {
    const effective = existingMap(base), current = read(target, {}), next = { ...current };
    for (const item of plan.items) {
      const now = imagesOf(effective.get(item.id)).map(x => x.url);
      if (JSON.stringify(now) !== JSON.stringify(item.beforeUrls)) throw Error(`${item.name} 图片已变化，请刷新审查页后重选`);
      const first = item.remaining[0];
      next[item.id] = { ...current[item.id], image: first.url, image_source: first.imageSource || effective.get(item.id)?.image_source, images: item.remaining };
    }
    write(target, next);
    const oldDecisions = read(decisions, []), decisionKeys = new Set(oldDecisions.map(x => `${x.id}\n${x.url}`));
    for (const item of plan.items) for (const url of item.removeUrls) {
      const key = `${item.id}\n${url}`;
      const removed = item.removed?.find(image => image.url === url) || {};
      if (!decisionKeys.has(key)) oldDecisions.push({
        id: item.id,
        name: item.name,
        url,
        action: 'remove_reference',
        reason: '人工审图确认错图、无关图或低质图',
        source: removed.source || 'unknown',
        detectedReasons: removed.reasons || [],
        wasCover: !!removed.wasCover,
        remainingCount: item.remaining.length,
        reviewBatchId: plan.id,
        needsReplacement: item.remaining.length < refillQueue.TARGET_IMAGES,
        recordedAt: new Date().toISOString(),
      });
    }
    write(decisions, oldDecisions);
    const refill = refillQueue.recordDeletion(plan, base);
    (options.build || (() => execFileSync(process.execPath, [path.join(base, 'scripts/build.js'), '--stage-only'], { cwd: base, windowsHide: true, timeout: 300000, stdio: 'inherit' })))();
    const built = new Map();
    for (const file of fs.readdirSync(path.join(stage, 'data/provinces')).filter(x => x.endsWith('.json'))) {
      const province = read(path.join(stage, 'data/provinces', file), {});
      for (const item of province.attractions || []) built.set(item.id, item);
    }
    for (const item of plan.items) {
      const urls = imagesOf(built.get(item.id)).map(x => x.url);
      if (item.removeUrls.some(url => urls.includes(url)) || JSON.stringify(urls) !== JSON.stringify(item.remaining.map(x => x.url))) throw Error(`构建结果未正确移除图片：${item.name}`);
    }
    if (hadDist) fs.renameSync(dist, oldDist);
    fs.renameSync(stage, dist);
    const result = { ...progress, ...refill, status: 'applied', appliedAt: new Date().toISOString(), attractionCount: plan.items.length, removedCount: plan.items.reduce((n, x) => n + x.removeUrls.length, 0), physicalFilesDeleted: 0 };
    write(receipt, result);
    try { fs.rmSync(oldDist, { recursive: true, force: true }); } catch { /* keep safe backup */ }
    cache = null;
    return result;
  } catch (error) {
    try { restore(); write(receipt, { ...progress, status: 'failed', error: error.message, rolledBack: true }); }
    catch (recovery) { write(receipt, { ...progress, status: 'interrupted', error: `${error.message}; 恢复失败：${recovery.message}` }); }
    cache = null;
    throw error;
  }
}

function deleteImages(input, options = {}) {
  const plan = makeDeletePlan(input?.selections, options);
  return executeDelete(plan, options);
}

module.exports = { buildCatalog, list, scanQuality, makeDeletePlan, executeDelete, deleteImages };
