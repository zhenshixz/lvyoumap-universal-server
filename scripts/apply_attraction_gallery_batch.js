const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const statePath = path.join(root, '.runtime', 'attraction-gallery-batch', 'state.json');
const overridePath = path.join(root, 'content', 'attraction-gallery-overrides.json');
const denylistPath = path.join(root, 'content', 'attraction-gallery-image-denylist.json');
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
  for (const file of [statePath, overridePath, denylistPath, dbPath]) {
    if (!fs.existsSync(file)) throw new Error(`缺少必要文件：${path.relative(root, file)}`);
  }

  const state = readJson(statePath);
  const current = readJson(overridePath);
  const attractions = collectAttractions(readJson(dbPath));
  const denied = new Set(readJson(denylistPath).map(item => String(item.url || '').trim()).filter(Boolean));
  const ready = (state.items || []).filter(item => item.status === 'ready_for_user_review');

  if (!ready.length) throw new Error('没有可写入的已验收图库。');
  const patches = {};
  for (const item of ready) {
    if (!attractions.has(item.id)) throw new Error(`现有数据库找不到：${item.name} (${item.id})`);
    if (current[item.id]) throw new Error(`为防止覆盖旧图库，发现重复 ID：${item.name} (${item.id})`);
    if (!Array.isArray(item.selected) || item.selected.length !== 5) {
      throw new Error(`${item.name} 未达到恰好5张，已停止写入。`);
    }
    const urls = item.selected.map(candidate => String(candidate.url || '').trim());
    if (urls.some(url => !url.startsWith('https://'))) throw new Error(`${item.name} 存在非 HTTPS 图片。`);
    if (new Set(urls).size !== 5) throw new Error(`${item.name} 存在重复图片。`);
    if (urls.some(url => denied.has(url))) throw new Error(`${item.name} 命中图片拒绝清单。`);

    const images = item.selected.map(candidate => ({
      url: candidate.url,
      caption: candidate.caption || item.name,
      source: candidate.source,
      ...(candidate.sourcePoiId ? { sourcePoiId: candidate.sourcePoiId } : {}),
      ...(candidate.sourceUrl ? { sourceUrl: candidate.sourceUrl } : {}),
      imageSource: sourceFor(candidate),
    }));
    patches[item.id] = {
      image: images[0].url,
      image_source: images[0].imageSource,
      images,
    };
  }

  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `attraction-gallery-overrides.${timestamp()}.json`);
  fs.copyFileSync(overridePath, backupPath);
  writeJsonAtomic(overridePath, { ...current, ...patches });
  writeJsonAtomic(auditPath, {
    appliedAt: new Date().toISOString(),
    previousCount: Object.keys(current).length,
    addedCount: Object.keys(patches).length,
    totalCount: Object.keys(current).length + Object.keys(patches).length,
    pendingCount: (state.items || []).filter(item => item.status !== 'ready_for_user_review').length,
    backup: path.relative(root, backupPath).replace(/\\/g, '/'),
    items: ready.map(item => ({ id: item.id, name: item.name, province: item.province })),
  });
  console.log(`图库已写入 beta：新增 ${Object.keys(patches).length}，保留 ${Object.keys(current).length}，合计 ${Object.keys(current).length + Object.keys(patches).length}。`);
  console.log(`未完成候选保持不变：${(state.items || []).filter(item => item.status !== 'ready_for_user_review').length}。`);
  console.log(`自动备份：${path.relative(root, backupPath)}`);
}

try {
  main();
} catch (error) {
  console.error(`图库写入失败：${error.message}`);
  process.exitCode = 1;
}
