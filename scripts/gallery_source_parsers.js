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
  if (!detail || !identityName(attraction.name) || identityName(detail.poiName) !== identityName(attraction.name)) {
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

module.exports = { identityName, parseCtripGallery };
