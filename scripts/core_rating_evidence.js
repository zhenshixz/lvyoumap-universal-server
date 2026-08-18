const { citiesCompatible, normalizeName, sameAttraction } = require('./core_candidate_quality');

function isCompositeName(value) {
  return /[与和、,，\/—\-]/.test(String(value || ''));
}

function compactName(value, city = '') {
  let name = normalizeName(value);
  const normalizedCity = normalizeName(city);
  if (normalizedCity && name.startsWith(normalizedCity) && name.length > normalizedCity.length + 2) {
    name = name.slice(normalizedCity.length);
  }
  return name
    .replace(/(?:国家)?[345]a级(?:旅游)?(?:景区|旅游区|风景区|度假区)$/i, '')
    .replace(/国际休闲旅游度假区|国际旅游度假区|旅游度假区|文化旅游景区|旅游景区|风景名胜区|国家湿地公园|湿地公园|国家森林公园|森林公园|国家地质公园|地质公园|风景区|旅游区|景区$/g, '')
    .trim();
}

function sameRatingIdentity(target, record) {
  if (!target || !record || !citiesCompatible(target.city, record.city)) return false;
  const right = compactName(record.name, record.city);
  if (!right) return false;
  const targetNames = [...new Set([target.name, ...(target.aliases || [])].filter(Boolean))];
  return targetNames.some(targetName => {
    if (isCompositeName(targetName) !== isCompositeName(record.name)) return false;
    const left = compactName(targetName, target.city);
    if (!left) return false;
    if (left === right) return true;
    return sameAttraction(targetName, record.name, target.city, record.city)
      && Math.abs(left.length - right.length) <= 4;
  });
}

function isAmapAttractionPoi(record) {
  const type = String(record?.type || '');
  if (!type) return false;
  if (/(?:交通设施服务|停车场|公交车站|住宿服务|餐饮服务|购物服务|售票处|公共设施|公司企业|医疗保健服务)/.test(type)) {
    return false;
  }
  return /(?:风景名胜|博物馆|纪念馆|图书馆|美术馆|科技馆|文化馆|展览馆|游乐场|主题乐园|水上活动中心|公园广场|城市广场|旅游景点)/.test(type);
}

function localAmapRating(target, records) {
  const matches = (records || []).filter(record => (
    Number(record.rating) > 0
    && /^amap_/i.test(String(record.id || ''))
    && sameRatingIdentity(target, record)
  ));
  if (matches.length !== 1) {
    return {
      rating: 0,
      reason: matches.length > 1 ? '高德快照存在多个同名候选' : '高德快照没有唯一同实体记录',
      candidates: matches.map(item => ({ id: item.id, name: item.name, city: item.city, rating: item.rating })),
    };
  }
  const match = matches[0];
  const poiId = String(match.id).replace(/^amap_/i, '');
  return {
    rating: Number(match.rating),
    reviewsCount: '高德地图',
    ratingSource: {
      platform: '高德地图',
      title: `高德地图 ${match.name}`,
      url: `https://www.amap.com/place/${encodeURIComponent(poiId)}`,
      poiId,
      evidenceMode: 'local-amap-snapshot',
      verifiedAt: new Date().toISOString().slice(0, 10),
    },
    matchedRecord: { id: match.id, name: match.name, city: match.city },
  };
}

function liveAmapRating(target, pois) {
  const candidates = (pois || []).map(poi => ({
    ...poi,
    city: Array.isArray(poi.cityname) ? poi.cityname[0] : (poi.cityname || poi.pname || target.city),
    rating: Number(poi.business?.rating || 0),
  }));
  const matches = candidates.filter(record => (
    Number(record.rating) > 0
    && isAmapAttractionPoi(record)
    && sameRatingIdentity(target, record)
  ));
  const unique = [...new Map(matches.map(item => [item.id, item])).values()];
  if (unique.length !== 1) {
    return {
      rating: 0,
      reason: unique.length > 1 ? '高德实时接口存在多个同名候选' : '高德实时接口没有唯一同实体评分',
      candidates: unique.map(item => ({ id: item.id, name: item.name, city: item.city, rating: item.rating })),
    };
  }
  const match = unique[0];
  return {
    rating: match.rating,
    reviewsCount: '高德地图',
    ratingSource: {
      platform: '高德地图',
      title: `高德地图 ${match.name}`,
      url: `https://www.amap.com/place/${encodeURIComponent(match.id)}`,
      poiId: match.id,
      evidenceMode: 'live-amap-web-service',
      verifiedAt: new Date().toISOString().slice(0, 10),
    },
    matchedRecord: { id: match.id, name: match.name, city: match.city },
  };
}

function hasVerifiedRating(value) {
  return Number(value?.rating) > 0 && /^https:\/\//i.test(String(value?.ratingSource?.url || ''));
}

function applyRatingFallback(value, fallback) {
  if (hasVerifiedRating(value) || !hasVerifiedRating(fallback)) return value;
  return {
    ...value,
    rating: fallback.rating,
    reviewsCount: fallback.reviewsCount,
    ratingSource: fallback.ratingSource,
  };
}

module.exports = {
  applyRatingFallback,
  hasVerifiedRating,
  isAmapAttractionPoi,
  liveAmapRating,
  localAmapRating,
  sameRatingIdentity,
};
