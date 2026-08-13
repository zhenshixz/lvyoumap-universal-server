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
    .replace(/国际休闲旅游度假区|国际旅游度假区|旅游度假区|文化旅游景区|旅游景区|风景名胜区|风景区|旅游区|景区$/g, '')
    .trim();
}

function sameRatingIdentity(target, record) {
  if (!target || !record || !citiesCompatible(target.city, record.city)) return false;
  if (isCompositeName(target.name) !== isCompositeName(record.name)) return false;
  const left = compactName(target.name, target.city);
  const right = compactName(record.name, record.city);
  if (!left || !right) return false;
  if (left === right) return true;
  return sameAttraction(target.name, record.name, target.city, record.city)
    && Math.abs(left.length - right.length) <= 4;
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
  const matches = candidates.filter(record => Number(record.rating) > 0 && sameRatingIdentity(target, record));
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
  liveAmapRating,
  localAmapRating,
  sameRatingIdentity,
};
