// Gallery-specific extraction; does not alter the shared basic-information parser.
const { isContaminatedImage } = require('./gallery_content_guard');

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
    photos: photos
      .filter(photo => /^https:\/\//i.test(photo.imageUrl || ''))
      .filter(photo => !isContaminatedImage({ url: photo.imageUrl, title: photo.title, caption: photo.caption }, detail.poiName).bad)
      .slice(0, 12),
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
  const imageInfo = appData.overviewData?.imageInfo;
  // Trip supplies a decorative defaultUrl even when the entity has no gallery.
  if (poi.poiImageCount === 0 && imageInfo?.imageCount === 0 && imageInfo.showGallery === false) {
    return { name:poi.poiSubtitleName || poi.poiName, poiId:poi.poiId, photos:[], available:0,
      noImageConfirmed:true, evidence:{poiImageCount:0,imageCount:0,showGallery:false,defaultUrl:poi.defaultUrl || ''} };
  }
  const photos = [...(poi.poiImage || []), ...(appData.overviewData?.imageInfo?.slideShowImages || [])];
  const seen = new Set();
  return {
    name: poi.poiSubtitleName || poi.poiName,
    poiId: poi.poiId,
    photos: photos.filter(photo => /^https:\/\/(?:[a-z0-9-]+\.)?tripcdn\.com\//i.test(photo.imageUrl || ''))
      .filter(photo => !isContaminatedImage({ url: photo.imageUrl, title: photo.title }, poi.poiSubtitleName || poi.poiName).bad)
      .filter(photo => !seen.has(photo.imageUrl) && seen.add(photo.imageUrl)).slice(0, 12),
  };
}

function parseTripShopGallery(html, payload, expectedPoiId) {
  const state = nextData(html).props?.pageProps?.initialState;
  if (String(state?.poiId) !== String(expectedPoiId)) throw Error('Trip购物详情页地点ID不匹配');
  if (String(payload?.resultCode) !== '0' || !Array.isArray(payload.imageInfo)) throw Error('Trip购物图库接口未返回有效图片列表');
  const seen = new Set();
  return {
    poiId: expectedPoiId,
    name: '',
    available: Number(payload.imageCount) || payload.imageInfo.length,
    photos: payload.imageInfo.filter(photo => /^https:\/\/(?:[a-z0-9-]+\.)?tripcdn\.com\//i.test(photo.imageUrl || ''))
      .filter(photo => !isContaminatedImage({ url: photo.imageUrl, title: photo.title }).bad)
      .filter(photo => !seen.has(photo.imageUrl) && seen.add(photo.imageUrl)).slice(0, 12),
  };
}

function parseTripPhotoGallery(payload) {
  if (!payload || payload.ResponseStatus?.Ack !== 'Success') throw new Error('Trip完整图库接口异常');
  // Keep the explicit officialPhoto field; recommended/UGC pools need separate content review.
  const groups = [payload.officialPhoto];
  const seen = new Set();
  const photos = groups.flatMap(group => Array.isArray(group?.photoList) ? group.photoList : [])
    .filter(photo => /^https:\/\/(?:[a-z0-9-]+\.)?(?:tripcdn\.com|c-ctrip\.com)\//i.test(photo.imageUrl || ''))
    .filter(photo => !seen.has(photo.imageUrl) && seen.add(photo.imageUrl))
    .filter(photo => !isContaminatedImage({ url: photo.imageUrl, title: photo.title }).bad)
    .map(photo => ({
      imageUrl: photo.imageUrl,
      title: photo.title || '',
      width: Number(photo.width) || 0,
      height: Number(photo.height) || 0,
    }));
  if (!photos.length) throw new Error('Trip完整图库为空');
  return photos;
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
    photos: (group.imageDetail || []).filter(photo => /^https:\/\/(?:[a-z0-9-]+\.)?tripcdn\.com\//i.test(photo.imageUrl || ''))
      .filter(photo => !isContaminatedImage({ url: photo.imageUrl, title: photo.title }, group.name).bad).slice(0, 12),
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
    if (/\.(?:js|css|html?|svg|ico)(?:$)/i.test(imageUrl.pathname)) continue;
    if (/(?:^|\/)(?:favicon|logo|icon|sprite|qrcode|qr-code)(?:\d|[._/-]|$)/i.test(imageUrl.pathname)) continue;
    imageUrl.hash = '';
    const url = imageUrl.href;
    if (seen.has(url)) continue;
    if (isContaminatedImage({ url }, source.entityName || '').bad) continue;
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
  parseTripShopGallery,
  parseTripPhotoGallery,
  parseTripPhotoListGallery,
  parseOfficialSiteGallery,
};
