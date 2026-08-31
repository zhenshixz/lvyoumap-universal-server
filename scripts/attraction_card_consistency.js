const fs = require('fs');
const path = require('path');

const AMBIGUOUS_LAZY_PATTERNS = [
  /全国有多(?:个|处)/,
  /国内有多(?:个|处)/,
  /我先按[^，。；]{0,24}(?:给你|整理|规划)/,
  /如果是[^，。；]{0,24}(?:请|可再)/,
  /分别对应[^，。；]{0,32}(?:两个|多处)/,
];
const GENERIC_INTRO_PATTERNS = [
  /历史底蕴深厚.{0,18}值得一游/,
  /适合纳入.{0,20}经典游览线路/,
  /以.{0,30}为主要看点。适合/,
];
const TRAVEL_TEMPLATE_PATTERNS = [
  /本地精选爆款/,
  /本地特色美食强烈推荐/,
  /拍照打卡特色消暑利器/,
  /特色招牌菜/,
  /正宗地方风味/,
  /推荐区域\d+/,
  /票价：70元\/人/,
];

function cleanRegion(value) {
  return String(value || '').replace(/(?:壮族|回族|维吾尔|特别行政区|自治区|自治州|地区|省|市)$/g, '').trim();
}

function buildCityProvinceIndex(provincesDir) {
  const index = new Map();
  for (const file of fs.readdirSync(provincesDir).filter(name => name.endsWith('.json'))) {
    const data = JSON.parse(fs.readFileSync(path.join(provincesDir, file), 'utf8').replace(/^\uFEFF/, ''));
    const province = cleanRegion(data.province);
    for (const attraction of data.attractions || []) {
      const city = cleanRegion(attraction.city);
      if (!city || city.length < 2) continue;
      if (!index.has(city)) index.set(city, new Set());
      index.get(city).add(province);
    }
  }
  return index;
}

function validateCard(item, effective, cityProvinceIndex) {
  const errors = [];
  const warnings = [];
  const province = cleanRegion(item.province);
  const city = cleanRegion(item.city);
  const intro = String(effective.intro || effective.description || '').trim();
  const lazy = String(effective.lazy_ai_text || '').trim();
  const combined = [intro, lazy].join('\n');

  if (intro.length < 45) errors.push({ code: 'intro_too_short', field: 'intro', message: '简介过短或仍是通用占位文案' });
  if (GENERIC_INTRO_PATTERNS.some(pattern => pattern.test(intro))) errors.push({ code: 'intro_generic', field: 'intro', message: '简介仍包含旧模板或通用占位表达' });

  const foreignCities = [];
  for (const [candidate, provinces] of cityProvinceIndex) {
    if (candidate === city || candidate.length < 2 || item.name.includes(candidate)) continue;
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const explicitMention = new RegExp(`${escaped}(?:市|州|地区|盟)|(?:位于|前往|到达|导航到|来自|是|按)${escaped}`);
    if (!explicitMention.test(combined)) continue;
    if (!provinces.has(province)) foreignCities.push(candidate);
  }
  if (foreignCities.length) errors.push({ code: 'foreign_city_reference', field: 'intro/lazy_ai_text', message: `出现异地城市：${[...new Set(foreignCities)].slice(0, 6).join('、')}` });

  if (AMBIGUOUS_LAZY_PATTERNS.some(pattern => pattern.test(lazy))) {
    errors.push({ code: 'lazy_entity_ambiguous', field: 'lazy_ai_text', message: '懒人攻略仍在多个同名实体之间摇摆' });
  }
  if (item.issues.includes('lazy') && lazy.length < 180) errors.push({ code: 'lazy_missing', field: 'lazy_ai_text', message: '懒人攻略缺失或过短' });
  if (item.issues.includes('travel') && (!effective.guide_data || typeof effective.guide_data !== 'object')) {
    errors.push({ code: 'guide_missing', field: 'guide_data', message: '旅行指南缺失' });
  }
  const guideText = JSON.stringify(effective.guide_data || {});
  if (TRAVEL_TEMPLATE_PATTERNS.some(pattern => pattern.test(guideText))) {
    errors.push({ code: 'guide_template_residue', field: 'guide_data', message: '旅行指南仍包含旧模板占位或虚构营销表达' });
  }

  if (/广场/.test(item.name) && effective.category === '自然景观') {
    errors.push({ code: 'category_mismatch', field: 'category', message: '广场被错误归为自然景观' });
  }
  if (/(?:故居|寺|遗址)/.test(item.name) && effective.category === '自然景观') {
    errors.push({ code: 'category_mismatch', field: 'category', message: '人文实体被错误归为自然景观' });
  }

  if (!effective.image) errors.push({ code: 'image_missing', field: 'image', message: '图片缺失' });
  else warnings.push({ code: 'image_semantic_review', field: 'image', message: '图片存在；发布前仍需在真实卡片中确认与实体一致' });

  return { passed: errors.length === 0, errors, warnings };
}

module.exports = { buildCityProvinceIndex, validateCard };
