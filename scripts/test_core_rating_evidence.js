const assert = require('assert');
const { applyRatingFallback, isAmapAttractionPoi, liveAmapRating, localAmapRating, sameRatingIdentity } = require('./core_rating_evidence');

assert.strictEqual(isAmapAttractionPoi({ type: '风景名胜;风景名胜;纪念馆' }), true);
assert.strictEqual(isAmapAttractionPoi({ type: '体育休闲服务;休闲场所;游乐场' }), true);
assert.strictEqual(isAmapAttractionPoi({ type: '交通设施服务;公交车站;公交车站相关' }), false);
assert.strictEqual(isAmapAttractionPoi({ type: '交通设施服务;停车场;公共停车场' }), false);
assert.strictEqual(isAmapAttractionPoi({ type: '生活服务;售票处;公园景点售票处' }), false);

const records = [
  { id: 'amap_B1', name: '北京环球度假区', city: '北京', rating: 4.8 },
  { id: 'amap_B2', name: '八达岭长城', city: '北京', rating: 4.7 },
  { id: 'amap_B3', name: '慕田峪长城', city: '北京', rating: 4.8 },
];

assert(sameRatingIdentity({ name: '环球度假区', city: '北京' }, records[0]), '同城标准别名应匹配');
assert(!sameRatingIdentity({ name: '八达岭—慕田峪长城旅游区', city: '北京' }, records[1]), '组合景区不得继承单一组成景点评分');
assert.strictEqual(localAmapRating({ name: '北京环球度假区', city: '北京' }, records).rating, 4.8);
assert.strictEqual(localAmapRating({ name: '八达岭—慕田峪长城旅游区', city: '北京' }, records).rating, 0);
assert.strictEqual(applyRatingFallback({ rating: 4.6, ratingSource: { url: 'https://example.com/ota' } }, localAmapRating({ name: '北京环球度假区', city: '北京' }, records)).rating, 4.6, '已有可靠 OTA 评分优先');
assert.strictEqual(applyRatingFallback({}, localAmapRating({ name: '北京环球度假区', city: '北京' }, records)).rating, 4.8, '缺分时复用唯一高德同实体评分');
assert.strictEqual(localAmapRating(
  { name: '广州长隆旅游度假区', city: '广州' },
  [{ id: 'amap_GZ1', name: '广州长隆旅游度假区', city: '广州', rating: 4.7 }],
).rating, 4.7, '核心清单 preferredId 缩小到单一 POI 后仍必须校验名称和城市');
assert.strictEqual(liveAmapRating(
  { name: '恭王府景区', city: '北京' },
  [{ id: 'B1', name: '恭王府景区', cityname: '北京市', type: '风景名胜;风景名胜;国家级景点', business: { rating: '4.8' } }],
).rating, 4.8, '高德 Web 服务 business.rating 应绑定唯一同实体 POI');
assert.strictEqual(liveAmapRating(
  { name: '八达岭—慕田峪长城旅游区', city: '北京' },
  [{ id: 'B2', name: '八达岭长城', cityname: '北京市', type: '风景名胜;风景名胜;世界遗产', business: { rating: '4.9' } }],
).rating, 0, '实时接口也不得让组合景区继承单一子景点评分');

console.log('全国通用高德评分匹配测试通过。');
