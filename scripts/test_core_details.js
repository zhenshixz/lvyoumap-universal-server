const assert = require('assert');
const { allAliases, completeEvidence, parseCtripHtml, sameIdentity } = require('./collect_core_details');
const { localAmapRating } = require('./core_rating_evidence');

const cases = [
  ['国家游泳中心', { name: '水立方（国家游泳中心）', city: '北京' }],
  ['八达岭长城', { name: '八达岭—慕田峪长城旅游区', city: '北京' }],
  ['慕田峪长城', { name: '八达岭—慕田峪长城旅游区', city: '北京' }],
  ['古北水镇', { name: '密云古北水镇国际休闲旅游度假区', city: '北京' }],
  ['北京大运河博物馆', { name: '北京（通州）大运河文化旅游景区', city: '北京' }],
];

for (const [candidate, item] of cases) {
  assert(sameIdentity(candidate, item), `${candidate} 应匹配 ${item.name}`);
}
assert(!sameIdentity('上海欢乐谷', { name: '北京欢乐谷', city: '北京' }), '异地同类景点不得误合并');
assert(allAliases({ name: '八达岭—慕田峪长城旅游区' }).includes('慕田峪长城'), '复合景区应产生组成景点别名');
assert(completeEvidence({ address: '地址', description: '介绍', sources: [{}, {}], routes: [{}, {}], image: { localPath: '/a.jpg', downloadUrl: 'https://example.com/a.jpg' } }), '完整断点应可复用');
assert(!completeEvidence({ address: '地址', sources: [{}] }), '残缺断点不得误判完成');

const ctripFixture = [
  '{"poiName":"目标景区","districtName":"北京","commentScore":4.7,"commentCount":321,"address":"目标地址","introduction":"目标介绍"}',
  '{"poiName":"相邻热门景区","districtName":"北京","commentScore":4.9,"commentCount":99999,"address":"其他地址","introduction":"其他介绍"}',
].join(',');
const parsedCtrip = parseCtripHtml(ctripFixture, { name: '目标景区', city: '北京' });
assert.strictEqual(parsedCtrip.rating, 4.7, '评分必须来自同一 POI');
assert.strictEqual(parsedCtrip.reviews, 321, '点评数必须来自同一 POI');
assert.strictEqual(parsedCtrip.address, '目标地址', '基本资料必须来自同一 POI');

const amapRating = localAmapRating(
  { name: '北京环球度假区', city: '北京' },
  [{ id: 'amap_B123', name: '北京环球度假区', city: '北京', rating: 4.8 }],
);
assert.strictEqual(amapRating.rating, 4.8, '缺少 OTA 分时应可复用高德唯一同实体评分');

console.log('核心资料通用匹配与断点测试通过。');
