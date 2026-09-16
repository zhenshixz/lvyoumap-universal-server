const C = require('./gallery_link_batch_common');
const { fs, path, root, runtime, read, write, alive } = C;
const { execFileSync } = require('child_process');
const { existingMap, imagesOf } = require('./gallery_existing_images');

const overridesFile = base => path.join(base, 'content/attraction-gallery-overrides.json');
const decisionsFile = base => path.join(base, 'content/attraction-gallery-review-decisions.json');
const receiptFile = base => path.join(base, '.runtime/gallery-link-batches/image-review.json');
let cache = null;

function localImagePath(base, url) {
  const value = String(url || '');
  if (value.startsWith('/assets/')) return path.join(base, value.slice(1));
  if (value.startsWith('assets/')) return path.join(base, value);
  return null;
}

function buildCatalog(base = root) {
  const map = existingMap(base);
  const meta = new Map();
  const provinceDir = path.join(base, 'data/provinces');
  if (fs.existsSync(provinceDir)) for (const file of fs.readdirSync(provinceDir).filter(x => x.endsWith('.json'))) {
    const province = read(path.join(provinceDir, file), {});
    for (const item of province.attractions || []) meta.set(item.id, { province: province.province || '', city: item.city || '', name: item.name || item.id });
  }
  const refs = new Map();
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
      const sharedCount = refs.get(url)?.size || 1;
      const sharedWith = [...(refs.get(url) || [])].filter(otherId => otherId !== id).map(otherId => meta.get(otherId)?.name || otherId);
      const local = localImagePath(base, url);
      if (local && !fs.existsSync(local)) reasons.push('本地图片文件缺失');
      if (sharedCount > 1) reasons.push(`被 ${sharedCount} 个景点共用`);
      if (/subspot/i.test(source)) reasons.push('来自子景点，建议核对主体');
      if (/海报|宣传|导览|平面图|价目|二维码|拼图|攻略|活动图/i.test(String(image.caption || ''))) reasons.push('标题疑似宣传图或导览图');
      const riskScore = reasons.reduce((sum, reason) => sum + (reason.includes('缺失') ? 100 : reason.includes('共用') ? 40 : reason.includes('POI') ? 30 : 20), 0);
      all.push({
        id, name: info.name, province: info.province, city: info.city, url,
        displayUrl: url.startsWith('assets/') ? '/' + url : url,
        caption: String(image.caption || ''), source, isCover: url === item.image || index === 0,
        imageCount: images.length, sharedCount, sharedWith, reasons, riskScore,
        collected: ['trip_exact', 'amap_exact'].includes(source), removable: images.length > 1,
      });
    });
  }
  all.sort((a, b) => b.riskScore - a.riskScore || a.province.localeCompare(b.province, 'zh-CN') || a.city.localeCompare(b.city, 'zh-CN') || a.name.localeCompare(b.name, 'zh-CN'));
  return { map, all };
}

function currentCatalog() {
  const file = overridesFile(root);
  const stat = fs.statSync(file);
  const signature = `${stat.mtimeMs}:${stat.size}`;
  if (!cache || cache.signature !== signature) cache = { signature, value: buildCatalog(root) };
  return cache.value;
}

function list(params = {}) {
  const scope = ['suspicious', 'collected', 'all'].includes(params.scope) ? params.scope : 'suspicious';
  const pageSize = Math.max(12, Math.min(80, Number(params.pageSize) || 48));
  const query = String(params.q || '').trim().toLowerCase();
  const catalog = currentCatalog();
  let items = catalog.all;
  if (scope === 'suspicious') items = items.filter(x => x.reasons.length);
  if (scope === 'collected') items = items.filter(x => x.collected);
  if (query) items = items.filter(x => [x.name, x.province, x.city, x.caption, x.source, x.url].some(value => String(value || '').toLowerCase().includes(query)));
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.max(1, Math.min(pages, Number(params.page) || 1));
  const summary = {
    attractions: catalog.map.size,
    images: catalog.all.length,
    suspicious: catalog.all.filter(x => x.reasons.length).length,
    shared: catalog.all.filter(x => x.sharedCount > 1).length,
    collected: catalog.all.filter(x => x.collected).length,
    protectedLast: catalog.all.filter(x => !x.removable).length,
  };
  return { scope, page, pageSize, pages, total: items.length, summary, items: items.slice((page - 1) * pageSize, page * pageSize) };
}

function makeDeletePlan(selections, options = {}) {
  const base = options.root || root;
  if (!Array.isArray(selections) || !selections.length || selections.length > 100) throw Error('请选择 1–100 张要移除的图片');
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
    const remaining = before.filter(image => !removeUrls.has(image.url));
    if (!remaining.length) throw Error(`${existing?.name || id} 至少需要保留 1 张图片，请取消勾选其中一张`);
    const cover = removeUrls.has(existing.image) ? remaining[0].url : existing.image || remaining[0].url;
    const index = remaining.findIndex(image => image.url === cover);
    if (index > 0) remaining.unshift(...remaining.splice(index, 1));
    items.push({ id, name: existing?.name || id, beforeUrls: before.map(x => x.url), removeUrls: [...removeUrls], remaining, coverUrl: remaining[0].url });
  }
  return { id: new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 17), createdAt: new Date().toISOString(), items };
}

function executeDelete(plan, options = {}) {
  const base = options.root || root;
  if (path.basename(base).toLowerCase() !== 'lvyoumap-universal-serverbeta' && !options.allowTestRoot) throw Error('Beta only');
  if (!options.skipIdleCheck) require('./gallery_link_batch_actions').assertIdle();
  const target = overridesFile(base), decisions = decisionsFile(base);
  const dataDir = path.join(base, 'data'), stage = path.join(base, '.dist-next'), dist = path.join(base, 'dist');
  const reviewRuntime = path.join(base, '.runtime/gallery-link-batches/image-review-backups');
  const backup = options.dir || path.join(reviewRuntime, plan.id), oldDist = path.join(backup, 'dist');
  const receipt = receiptFile(base);
  fs.mkdirSync(backup, { recursive: true });
  const hadData = fs.existsSync(dataDir), hadDist = fs.existsSync(dist), hadDecisions = fs.existsSync(decisions);
  fs.copyFileSync(target, path.join(backup, 'overrides.json'));
  if (hadDecisions) fs.copyFileSync(decisions, path.join(backup, 'decisions.json'));
  fs.rmSync(path.join(backup, 'data'), { recursive: true, force: true });
  if (hadData) fs.cpSync(dataDir, path.join(backup, 'data'), { recursive: true });
  write(path.join(backup, 'metadata.json'), { hadData, hadDist, hadDecisions });
  const progress = { status: 'applying', pid: process.pid, startedAt: new Date().toISOString(), planId: plan.id, backup: path.relative(base, backup).replace(/\\/g, '/') };
  write(receipt, progress);
  const restore = () => {
    fs.copyFileSync(path.join(backup, 'overrides.json'), target);
    if (hadDecisions) fs.copyFileSync(path.join(backup, 'decisions.json'), decisions); else fs.rmSync(decisions, { force: true });
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
      if (!decisionKeys.has(key)) oldDecisions.push({ id: item.id, name: item.name, url, action: 'remove_reference', reason: '人工审图确认错图或无关图', recordedAt: new Date().toISOString() });
    }
    write(decisions, oldDecisions);
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
    const result = { ...progress, status: 'applied', appliedAt: new Date().toISOString(), attractionCount: plan.items.length, removedCount: plan.items.reduce((n, x) => n + x.removeUrls.length, 0), physicalFilesDeleted: 0 };
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

module.exports = { buildCatalog, list, makeDeletePlan, executeDelete, deleteImages };
