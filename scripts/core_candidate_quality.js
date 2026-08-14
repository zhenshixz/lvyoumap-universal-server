const TEMPORARY_EVENT_PATTERNS = [
  /演唱会/,
  /音乐节/,
  /巡回演出/,
  /见面会/,
  /签售会/,
  /粉丝见面/,
  /脱口秀/,
  /话剧(?:《|\s|$)/,
  /舞剧(?:《|\s|$)/,
  /音乐会(?:《|\s|$)/,
  /创作交流展/,
  /(?:赛事|比赛|马拉松)(?:\s|$)/,
];

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .trim();
}

function temporaryEventReason(value) {
  const name = decodeHtmlEntities(value);
  const matched = TEMPORARY_EVENT_PATTERNS.find(pattern => pattern.test(name));
  if (matched) return '临时演出、赛事或活动，不属于长期景点';
  if (/第[一二三四五六七八九十百\d]+届/.test(name) && /(?:展|节|赛|活动)(?:会|$)/.test(name)) {
    return '带届次的临时活动，不属于长期景点';
  }
  if (/20\d{2}/.test(name) && /(?:演出|展览|展会|音乐|赛事|比赛|活动)/.test(name)) {
    return '带年份的临时活动，不属于长期景点';
  }
  return '';
}

function normalizeCity(value) {
  return String(value || '')
    .replace(/^(?:广东省|广西壮族自治区|新疆维吾尔自治区|宁夏回族自治区|西藏自治区|内蒙古自治区)/, '')
    .replace(/(?:自治州|地区|盟|市|县|区)$/g, '')
    .replace(/\s+/g, '')
    .trim();
}

function citiesCompatible(left, right) {
  const a = normalizeCity(left);
  const b = normalizeCity(right);
  return !a || !b || a === b;
}

function cityFromAddress(address, knownCities = []) {
  const text = String(address || '').replace(/^(?:北京市|天津市|上海市|重庆市)/, match => match.slice(0, -1));
  const normalized = [...new Set(knownCities.map(normalizeCity).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  const known = normalized.find(city => text.includes(`${city}市`) || text.includes(`${city}自治州`) || text.startsWith(city));
  if (known) return known;
  const withoutProvince = text.replace(/^.*?(?:省|自治区)/, '');
  const prefecture = withoutProvince.match(/^([\u4e00-\u9fa5]{2,10}?)(?:市|自治州|地区|盟)/);
  return prefecture ? normalizeCity(prefecture[1]) : '';
}

function normalizeName(value) {
  let name = decodeHtmlEntities(value)
    .toLowerCase()
    .replace(/[·•（）()\-—_\s®™]/g, '')
    .replace(/国家[345]a级旅游景区/g, '')
    .replace(/国家级|国家重点|国家/g, '')
    // Common destination aliases such as “外滩万国建筑群” refer to the
    // destination itself. Keep the rule narrow so “北外滩滨江” remains distinct.
    .replace(/万国建筑群$/, '');
  const suffix = /(?:国际海洋旅游度假区|国际旅游度假区|旅游度假区|旅游风景名胜区|旅游景区|旅游风景区|风景名胜区|风景旅游区|风景区|度假区|旅游区|景区)$/;
  while (suffix.test(name)) name = name.replace(suffix, '');
  return name.trim();
}

function safeParentheticalBase(value) {
  const text = decodeHtmlEntities(value);
  const match = text.match(/^(.{3,}?)[（(]([^）)]+)[）)]$/);
  if (!match) return '';
  const qualifier = match[2];
  if (/(?:东|西|南|北|一|二|三|四|五|一期|二期|区|馆|院|门|楼|峰|谷|湖|山)$/.test(qualifier)) return '';
  return normalizeName(match[1]);
}

function attractionRoot(value) {
  return normalizeName(value)
    .replace(/(?:国际)?(?:旅游)?度假区$/, '')
    .replace(/(?:主题)?(?:乐园|影城)$/, '')
    .trim();
}

function relatedAttraction(left, right, leftCity = '', rightCity = '') {
  if (sameAttraction(left, right, leftCity, rightCity)) return true;
  if (!citiesCompatible(leftCity, rightCity)) return false;
  const normalizedLeft = normalizeName(left);
  const normalizedRight = normalizeName(right);
  const leftBase = safeParentheticalBase(left);
  const rightBase = safeParentheticalBase(right);
  if (leftBase && leftBase === normalizedRight) return true;
  if (rightBase && rightBase === normalizedLeft) return true;
  const a = attractionRoot(left);
  const b = attractionRoot(right);
  if (a && b && a === b && a.length >= 4) return true;
  const isComposite = value => /[与和、,，\/—\-·]/.test(String(value));
  const leftComposite = isComposite(left);
  const rightComposite = isComposite(right);
  if (leftComposite === rightComposite) return false;
  const composite = leftComposite ? left : right;
  const single = leftComposite ? right : left;
  const singleName = normalizeName(single);
  if (!singleName) return false;
  const singleRoot = attractionRoot(single);
  return String(composite).split(/[与和、,，\/—\-·]/).map(attractionRoot).filter(Boolean)
    .some(part => part.length >= 3 && part === singleRoot);
}

function comparisonName(value, city = '') {
  let name = normalizeName(value);
  const normalizedCity = normalizeCity(city);
  const prefixes = normalizedCity ? [`${normalizedCity}市`, `${normalizedCity}地区`, normalizedCity] : [];
  const prefix = prefixes.find(item => name.startsWith(item) && name.length > item.length + 1);
  if (prefix) {
    name = name.slice(prefix.length);
  }
  return name;
}

function sameAttraction(left, right, leftCity = '', rightCity = '') {
  if (!citiesCompatible(leftCity, rightCity)) return false;
  const directA = normalizeName(left);
  const directB = normalizeName(right);
  if (directA && directA === directB) return true;
  const a = comparisonName(left, leftCity);
  const b = comparisonName(right, rightCity);
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  if (!longer.includes(shorter)) return false;
  const bothCitiesKnown = Boolean(normalizeCity(leftCity) && normalizeCity(rightCity));
  const before = longer.slice(0, longer.indexOf(shorter));
  const after = longer.slice(longer.indexOf(shorter) + shorter.length);
  const distinguishingPrefix = /(?:东部|西部|南部|北部|东区|西区|南区|北区|新城|老城)$/;
  if (distinguishingPrefix.test(before)) return false;
  if (shorter.length >= 4 && longer.length - shorter.length <= 4) return true;
  return bothCitiesKnown && shorter.length >= 3 && before.length + after.length <= 8;
}

module.exports = {
  citiesCompatible,
  cityFromAddress,
  decodeHtmlEntities,
  normalizeCity,
  normalizeName,
  relatedAttraction,
  sameAttraction,
  temporaryEventReason,
};
