const crypto = require('crypto');
const C = require('./gallery_link_batch_common');

const { fs, path, root, read, write } = C;
const reviewRuntime = path.join(root, '.runtime', 'province-hero-review');
const selectionsFile = path.join(reviewRuntime, 'selections.json');
const MAX_CANDIDATES = 10;
const BAD_SCENE_WORDS = /(售票|票务|游客中心|服务中心|停车场|检票|入口|出口|导览图|平面图|指示牌|标牌|卫生间|厕所)/;
const dimensionCache = new Map();
let baseCatalogCache = null;

function safeImageUrl(value) {
  const url = String(value || '').trim();
  if (/^\/assets\/images\/[A-Za-z0-9_./%+-]+\.(?:jpe?g|png|webp|gif)$/i.test(url) && !url.split('/').includes('..')) return url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : '';
  } catch {
    return '';
  }
}

function candidateId(url) {
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
}

function localImageFile(targetRoot, url) {
  if (!url.startsWith('/assets/images/')) return '';
  const candidate = path.resolve(targetRoot, url.replace(/^\/+/, ''));
  const allowed = path.resolve(targetRoot, 'assets', 'images') + path.sep;
  return candidate.startsWith(allowed) ? candidate : '';
}

function imageDimensions(file) {
  if (dimensionCache.has(file)) return dimensionCache.get(file);
  let result = [0, 0];
  try {
    const size = Math.min(fs.statSync(file).size, 256 * 1024);
    const buffer = Buffer.allocUnsafe(size);
    const descriptor = fs.openSync(file, 'r');
    try { fs.readSync(descriptor, buffer, 0, size, 0); }
    finally { fs.closeSync(descriptor); }
    if (buffer.length >= 24 && buffer.toString('ascii', 1, 4) === 'PNG') {
      result = [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
    }
    if (!result[0] && buffer.length >= 10 && /^GIF8/.test(buffer.toString('ascii', 0, 4))) {
      result = [buffer.readUInt16LE(6), buffer.readUInt16LE(8)];
    }
    if (!result[0] && buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) { offset += 1; continue; }
        const marker = buffer[offset + 1];
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
          result = [buffer.readUInt16BE(offset + 7), buffer.readUInt16BE(offset + 5)];
          break;
        }
        if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) { offset += 2; continue; }
        const length = buffer.readUInt16BE(offset + 2);
        if (length < 2) break;
        offset += 2 + length;
      }
    }
  } catch {}
  dimensionCache.set(file, result);
  return result;
}

function sourceLabel(image, attraction) {
  const provider = image?.imageSource?.provider || image?.provider || attraction?.image_source?.provider;
  if (provider) return String(provider);
  const source = String(image?.source || '').toLowerCase();
  if (source.includes('official')) return '景区官方';
  if (source.includes('trip')) return 'Trip';
  if (source.includes('wiki')) return '公开百科';
  if (source.includes('amap')) return '高德地图';
  return source ? source : '现有图库';
}

function sourceScore(image, url) {
  const text = `${image?.source || ''} ${image?.imageSource?.provider || ''}`.toLowerCase();
  if (text.includes('official') || text.includes('景区官方')) return 42;
  if (text.includes('trip')) return 34;
  if (text.includes('wiki') || text.includes('百科')) return 28;
  if (url.startsWith('/assets/images/')) return 26;
  if (text.includes('amap') || text.includes('高德')) return 8;
  return 14;
}

function attractionScore(attraction, index) {
  const level = String(attraction.level || '').toUpperCase();
  const rating = Number(attraction.rating) || 0;
  const reviews = Math.max(0, Number(attraction.reviewsCount) || 0);
  let score = Math.max(0, 30 - index * 0.22) + rating * 3 + Math.log10(reviews + 1) * 5;
  if (level.includes('5A')) score += 55;
  else if (level.includes('4A')) score += 30;
  else if (level.includes('3A')) score += 12;
  return score;
}

function flattenCandidates(targetRoot, province) {
  const seen = new Set();
  const rows = [];
  for (const [attractionIndex, attraction] of (province.attractions || []).entries()) {
    const rawImages = [
      { url: attraction.image, caption: `${attraction.name}当前封面`, source: 'existing', imageSource: attraction.image_source },
      ...(Array.isArray(attraction.images) ? attraction.images : []),
    ];
    for (const [imageIndex, image] of rawImages.entries()) {
      const url = safeImageUrl(image?.url || image?.image);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const file = localImageFile(targetRoot, url);
      const [width, height] = file && fs.existsSync(file) ? imageDimensions(file) : [0, 0];
      const ratio = width && height ? width / height : 0;
      const caption = String(image?.caption || attraction.name || '').trim();
      let score = attractionScore(attraction, attractionIndex) + sourceScore(image, url) - imageIndex * 2;
      if (width >= 1920) score += 42;
      else if (width >= 1600) score += 34;
      else if (width >= 1200) score += 25;
      else if (width >= 900) score += 10;
      else if (width > 0) score -= 25;
      if (ratio >= 1.75) score += 30;
      else if (ratio >= 1.45) score += 22;
      else if (ratio >= 1.2) score += 8;
      else if (ratio > 0) score -= 45;
      if (BAD_SCENE_WORDS.test(`${attraction.name} ${caption}`)) score -= 85;
      rows.push({
        id: candidateId(url),
        url,
        attractionId: attraction.id || '',
        attractionName: attraction.name || '未命名景点',
        city: attraction.city || '',
        level: attraction.level || '',
        rating: Number(attraction.rating) || null,
        caption,
        source: sourceLabel(image, attraction),
        width,
        height,
        local: !!file,
        score: Math.round(score * 10) / 10,
      });
    }
  }
  return rows.sort((a, b) => b.score - a.score || a.attractionName.localeCompare(b.attractionName, 'zh-CN'));
}

function chooseCandidates(rows, limit = MAX_CANDIDATES) {
  const chosen = [];
  const attractionCounts = new Map();
  for (const maxPerAttraction of [1, 2, 3]) {
    for (const row of rows) {
      if (chosen.length >= limit) break;
      if (chosen.some(item => item.id === row.id)) continue;
      const count = attractionCounts.get(row.attractionId) || 0;
      if (count >= maxPerAttraction) continue;
      chosen.push(row);
      attractionCounts.set(row.attractionId, count + 1);
    }
  }
  return chosen.slice(0, limit);
}

function selections(targetRoot = root) {
  const file = targetRoot === root ? selectionsFile : path.join(targetRoot, '.runtime', 'province-hero-review', 'selections.json');
  return read(file, { version: 1, updatedAt: null, selections: {} });
}

function buildBaseCatalog(targetRoot) {
  const index = read(path.join(targetRoot, 'data', 'provinces-index.json'), {});
  const provinces = [];
  for (const [name, item] of Object.entries(index)) {
    const detail = read(path.join(targetRoot, 'data', 'provinces', item.dataFile || `${item.id}.json`), {});
    const all = flattenCandidates(targetRoot, detail);
    const currentFile = localImageFile(targetRoot, safeImageUrl(item.image));
    const [currentWidth, currentHeight] = currentFile && fs.existsSync(currentFile) ? imageDimensions(currentFile) : [0, 0];
    provinces.push({
      name,
      id: item.id,
      currentImage: safeImageUrl(item.image),
      currentWidth,
      currentHeight,
      candidates: chooseCandidates(all),
      allCandidates: all,
    });
  }
  return provinces;
}

function buildCatalog(targetRoot = root) {
  const saved = selections(targetRoot);
  const base = targetRoot === root
    ? (baseCatalogCache ||= buildBaseCatalog(targetRoot))
    : buildBaseCatalog(targetRoot);
  const provinces = base.map(item => {
    const selection = saved.selections?.[item.name] || null;
    let candidates = item.candidates;
    if (selection && !candidates.some(candidate => candidate.id === selection.candidateId)) {
      const selectedCandidate = item.allCandidates.find(candidate => candidate.id === selection.candidateId || candidate.url === selection.url);
      if (selectedCandidate) candidates = [selectedCandidate, ...candidates.slice(0, MAX_CANDIDATES - 1)];
    }
    const { allCandidates, ...publicItem } = item;
    return { ...publicItem, candidates, selection };
  });
  return { version: 1, updatedAt: saved.updatedAt, selectedCount: provinces.filter(item => item.selection).length, total: provinces.length, provinces };
}

function normalizeFocus(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 50;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function validateSelection(input, catalog = buildCatalog()) {
  const province = catalog.provinces.find(item => item.name === String(input?.province || ''));
  if (!province) throw Error('省份不存在');
  const candidate = province.candidates.find(item => item.id === String(input?.candidateId || ''));
  if (!candidate) throw Error('候选图片已变化，请刷新后重新选择');
  return {
    province: province.name,
    selection: {
      candidateId: candidate.id,
      url: candidate.url,
      attractionId: candidate.attractionId,
      attractionName: candidate.attractionName,
      city: candidate.city,
      source: candidate.source,
      width: Number(input?.width) || candidate.width || 0,
      height: Number(input?.height) || candidate.height || 0,
      focusX: normalizeFocus(input?.focusX),
      focusY: normalizeFocus(input?.focusY),
      savedAt: new Date().toISOString(),
    },
  };
}

function saveSelection(input) {
  const catalog = buildCatalog();
  const normalized = validateSelection(input, catalog);
  fs.mkdirSync(reviewRuntime, { recursive: true });
  const value = selections();
  value.version = 1;
  value.updatedAt = normalized.selection.savedAt;
  value.selections = value.selections || {};
  value.selections[normalized.province] = normalized.selection;
  write(selectionsFile, value);
  return buildCatalog();
}

module.exports = {
  MAX_CANDIDATES,
  imageDimensions,
  buildCatalog,
  validateSelection,
  saveSelection,
};
