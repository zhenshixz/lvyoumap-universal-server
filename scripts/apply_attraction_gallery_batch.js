const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const statePath = path.join(root, '.runtime', 'attraction-gallery-batch', 'state.json');
const overridePath = path.join(root, 'content', 'attraction-gallery-overrides.json');
const denylistPath = path.join(root, 'content', 'attraction-gallery-image-denylist.json');
const galleryPolicyPath = path.join(root, 'content', 'attraction-gallery-policy.json');
const dbPath = path.join(root, 'content', 'db.json');
const backupDir = path.join(root, '.runtime', 'backups');
const auditPath = path.join(root, '.runtime', 'attraction-gallery-batch', 'applied.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\r\n`, 'utf8');
  fs.renameSync(temp, file);
}

function publicProvider(candidate) {
  if (['amap_exact', 'amap_subspot', 'curated_subspot'].includes(candidate.source)) return '高德地图';
  if (candidate.source === 'mct_official') return '景区官方';
  if (candidate.source === 'wikimedia_exact') return '公开百科';
  if (candidate.source === 'ctrip_exact') return '景区公开资料';
  return '公开资料';
}

function sourceFor(candidate) {
  const imageSource = { provider: publicProvider(candidate) };
  if (candidate.sourceUrl) imageSource.sourceUrl = candidate.sourceUrl;
  if (candidate.imageSource?.author) imageSource.author = candidate.imageSource.author;
  if (candidate.imageSource?.license) imageSource.license = candidate.imageSource.license;
  return imageSource;
}

function collectAttractions(db) {
  const result = new Map();
  for (const province of Object.values(db.provinces || db)) {
    for (const attraction of province?.attractions || []) {
      if (attraction.id) result.set(attraction.id, attraction);
    }
  }
  return result;
}

function timestamp() {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function main() {
  for (const file of [statePath, overridePath, denylistPath, galleryPolicyPath, dbPath]) {
    if (!fs.existsSync(file)) throw new Error(`缺少必要文件：${path.relative(root, file)}`);
  }

  const state = readJson(statePath);
  const current = readJson(overridePath);
  const policy = readJson(galleryPolicyPath);
  const attractions = collectAttractions(readJson(dbPath));
  const denied = new Set(readJson(denylistPath).map(item => String(item.url || '').trim()).filter(Boolean));
  const ready = (state.items || []).filter(item => item.status === 'ready_for_user_review');

  if (!ready.length) throw new Error('没有可写入的已验收图库。');
  const patches = {};
  let addedCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;
  for (const item of ready) {
    if (!attractions.has(item.id)) throw new Error(`现有数据库找不到：${item.name} (${item.id})`);
    if (!Array.isArray(item.selected)
      || item.selected.length < policy.minimumImages
      || item.selected.length > policy.maximumImages) {
      throw new Error(`${item.name} 未达到${policy.minimumImages}-${policy.maximumImages}张，已停止写入。`);
    }
    const urls = item.selected.map(candidate => String(candidate.url || '').trim());
    if (urls.some(url => !url.startsWith('https://'))) throw new Error(`${item.name} 存在非 HTTPS 图片。`);
    if (new Set(urls).size !== urls.length) throw new Error(`${item.name} 存在重复图片。`);
    if (urls.some(url => denied.has(url))) throw new Error(`${item.name} 命中图片拒绝清单。`);

    const images = item.selected.map(candidate => ({
      url: candidate.url,
      caption: candidate.caption || item.name,
      source: candidate.source,
      ...(candidate.sourcePoiId ? { sourcePoiId: candidate.sourcePoiId } : {}),
      ...(candidate.sourceUrl ? { sourceUrl: candidate.sourceUrl } : {}),
      imageSource: sourceFor(candidate),
    }));
    const patch = {
      image: images[0].url,
      image_source: images[0].imageSource,
      images,
    };
    const existingUrls = (current[item.id]?.images || []).map(image => typeof image === 'string' ? image : image.url);
    if (JSON.stringify(existingUrls) === JSON.stringify(urls) && current[item.id]?.image === patch.image) {
      unchangedCount += 1;
      continue;
    }
    if (current[item.id]) updatedCount += 1;
    else addedCount += 1;
    patches[item.id] = patch;
  }

  if (!Object.keys(patches).length) {
    console.log(`图库无需重复写入：${unchangedCount} 个已与验收结果一致。`);
    return;
  }
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `attraction-gallery-overrides.${timestamp()}.json`);
  fs.copyFileSync(overridePath, backupPath);
  const merged = { ...current, ...patches };
  writeJsonAtomic(overridePath, merged);
  writeJsonAtomic(auditPath, {
    appliedAt: new Date().toISOString(),
    previousCount: Object.keys(current).length,
    addedCount,
    updatedCount,
    unchangedCount,
    totalCount: Object.keys(merged).length,
    pendingCount: (state.items || []).filter(item => item.status === 'pending_sources').length,
    excludedCount: (state.items || []).filter(item => item.status?.startsWith('excluded_')).length,
    backup: path.relative(root, backupPath).replace(/\\/g, '/'),
    items: ready.filter(item => patches[item.id]).map(item => ({ id: item.id, name: item.name, province: item.province })),
  });
  console.log(`图库已写入 beta：新增 ${addedCount}，更新 ${updatedCount}，未变化 ${unchangedCount}，合计 ${Object.keys(merged).length}。`);
  console.log(`待补来源保持不变：${(state.items || []).filter(item => item.status === 'pending_sources').length}；非景点排除：${(state.items || []).filter(item => item.status?.startsWith('excluded_')).length}。`);
  console.log(`自动备份：${path.relative(root, backupPath)}`);
}

try {
  main();
} catch (error) {
  console.error(`图库写入失败：${error.message}`);
  process.exitCode = 1;
}
