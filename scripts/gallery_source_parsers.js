// Gallery-specific extraction; does not alter the shared basic-information parser.
function identityName(value) {
  return String(value || '').toLowerCase().replace(/[\s·•（）()\[\]【】\-_—]/g, '')
    .replace(/国家级|世界文化遗产|世界自然遗产/g, '')
    .replace(/旅游度假区|风景名胜区|旅游景区|风景区|景区|公园|博物馆|博物院/g, '');
}

function parseCtripGallery(html, attraction) {
  const script = String(html).match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!script) throw new Error('携程结构化景点数据缺失');
  const detail = JSON.parse(script[1]).props?.pageProps?.initialState?.poiDetail;
  const targetNames = [...new Set([attraction.name, ...(attraction.aliases || [])]
    .map(identityName).filter(Boolean))];
  if (!detail || !targetNames.includes(identityName(detail.poiName))) {
    throw new Error('携程景点实体不匹配');
  }
  // Only the gallery belonging to this entity. Never scan comments, related POIs,
  // introduction HTML or arbitrary imageUrl fields elsewhere on the page.
  const photos = detail.imageInfo?.poiPhotoImageList;
  if (!Array.isArray(photos)) throw new Error('携程景点相册字段缺失');
  return {
    name: detail.poiName,
    city: detail.districtName || '',
    address: detail.address || '',
    poiId: detail.poiId,
    photos: photos.filter(photo => /^https:\/\//i.test(photo.imageUrl || '')).slice(0, 12),
  };
}

function nextData(html) {
  const script = String(html).match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!script) throw new Error('页面结构化数据缺失');
  return JSON.parse(script[1]);
}

function parseTripAttractionGallery(html, expectedPoiId) {
  const appData = nextData(html).props?.pageProps?.initialState?.appData;
  const poi = appData?.poiData;
  if (!poi || String(poi.poiId) !== String(expectedPoiId)) throw new Error('Trip景点实体不匹配');
  const photos = [...(poi.poiImage || []), ...(appData.overviewData?.imageInfo?.slideShowImages || [])];
  const seen = new Set();
  return {
    name: poi.poiSubtitleName || poi.poiName,
    poiId: poi.poiId,
    photos: photos.filter(photo => /^https:\/\/(?:[a-z0-9-]+\.)?tripcdn\.com\//i.test(photo.imageUrl || ''))
      .filter(photo => !seen.has(photo.imageUrl) && seen.add(photo.imageUrl)).slice(0, 12),
  };
}

function parseTripPhotoListGallery(html, expectedName) {
  const groups = nextData(html).props?.pageProps?.picItem?.photoList;
  if (!Array.isArray(groups)) throw new Error('Trip图集结构化数据缺失');
  const target = identityName(expectedName);
  const group = groups.find(item => identityName(item.name) === target);
  if (!group) throw new Error('Trip图集实体不匹配');
  return {
    name: group.name,
    poiId: group.poiId,
    photos: (group.imageDetail || []).filter(photo => /^https:\/\/(?:[a-z0-9-]+\.)?tripcdn\.com\//i.test(photo.imageUrl || '')).slice(0, 12),
  };
}

function parseOfficialSiteGallery(html, source) {
  const pageUrl = new URL(source.url);
  if (pageUrl.protocol !== 'https:') throw new Error('景区官网必须使用 HTTPS');
  let section = String(html || '');
  if (source.sectionStart) {
    const start = section.indexOf(source.sectionStart);
    if (start < 0) throw new Error('景区官网图片区段起点缺失');
    section = section.slice(start);
  }
  if (source.sectionEnd) {
    const end = section.indexOf(source.sectionEnd);
    if (end < 0) throw new Error('景区官网图片区段终点缺失');
    section = section.slice(0, end);
  }
  const includePaths = (Array.isArray(source.includePath) ? source.includePath : [source.includePath])
    .filter(Boolean);
  const seen = new Set();
  const photos = [];
  const pattern = /(?:\b(?:src|data-src|data-original|data-lazy-src)\s*=\s*["']([^"']+)["']|url\(\s*["']?([^"'()]+)["']?\s*\))/gi;
  for (const match of section.matchAll(pattern)) {
    const raw = String(match[1] || match[2] || '').replace(/&amp;/g, '&').trim();
    if (!raw || /^data:/i.test(raw)) continue;
    let imageUrl;
    try {
      imageUrl = new URL(raw, pageUrl);
    } catch {
      continue;
    }
    if (imageUrl.protocol !== 'https:' || imageUrl.hostname !== pageUrl.hostname) continue;
    if (includePaths.length && !includePaths.some(prefix => imageUrl.pathname.startsWith(prefix))) continue;
    if (/(?:^|\/)(?:favicon|logo|icon|sprite|qrcode|qr-code)(?:[._/-]|$)/i.test(imageUrl.pathname)) continue;
    imageUrl.hash = '';
    const url = imageUrl.href;
    if (seen.has(url)) continue;
    seen.add(url);
    photos.push({ imageUrl: url });
  }
  if (!photos.length) throw new Error('景区官网登记区段未找到同域图片');
  return { name: source.entityName || '', photos: photos.slice(0, 40) };
}

module.exports = {
  identityName,
  parseCtripGallery,
  parseTripAttractionGallery,
  parseTripPhotoListGallery,
  parseOfficialSiteGallery,
};
