const assert = require('assert');
const { allAliases, commonsSemanticScore, completeEvidence, imageIdentityTokens, parseBaiduImageResults, parseBingImageResults, parseCtripHtml, sameIdentity } = require('./collect_core_details');
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
assert(!completeEvidence({ address: '地址', description: '介绍', sources: [{}], routes: [{}, {}], image: { localPath: '/assets/images/default-thumbnail.jpg', placeholder: true } }), '占位图不得被判定为完整资料');
assert(!completeEvidence({ address: '地址', sources: [{}] }), '残缺断点不得误判完成');
assert(allAliases({ name: '小三峡－小小三峡旅游区' }).includes('小三峡'), '全角连接符复合景区应产生组成景点别名');
assert(allAliases({ name: '小三峡－小小三峡旅游区' }).includes('小小三峡'), '全角连接符复合景区应保留第二个组成景点别名');
assert(imageIdentityTokens({ name: '武康路街区', city: '上海' }).includes('武康路'), '图片搜索应去除景区后缀并保留实体关键词');
assert(imageIdentityTokens({ name: '天津之眼摩天轮', city: '天津' }).includes('天津之眼'), '设施型景点图片搜索应同时保留实体主干');
assert(imageIdentityTokens({ name: '溱湖国家湿地公园', city: '泰州' }).includes('溱湖'), '公园型 POI 应保留景点实体主干用于图片核验');
const imagePage = {
  title: 'File:Street View of Wukang Road, Shanghai.JPG',
  imageinfo: [{ width: 4912, height: 3264, extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' }, ImageDescription: { value: '武康路街景，上海' } } }],
};
assert(commonsSemanticScore(imagePage, { name: '武康路街区', city: '上海' }) >= 45, '英文文件名和中文描述应能匹配同一景点');
const mapPage = {
  title: 'File:武康路旅游导览地图.png',
  imageinfo: [{ width: 3000, height: 2000, extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' } } }],
};
assert(commonsSemanticScore(mapPage, { name: '武康路街区', city: '上海' }) < 0, '地图和导览图不得作为景点实景图');

const bingFixture = '<a class="iusc" m="{&quot;murl&quot;:&quot;https://example.com/scenic.jpg&quot;,&quot;purl&quot;:&quot;https://example.com/page&quot;,&quot;t&quot;:&quot;小三峡实景&quot;}"></a>';
assert.deepStrictEqual(parseBingImageResults(bingFixture), [{ imageUrl: 'https://example.com/scenic.jpg', sourceUrl: 'https://example.com/page', title: '小三峡实景' }], '公开图片搜索结果应解析原图和来源页');
const baiduFixture = { data: [{ fromPageTitle: '<strong>天津之眼</strong>实景', width: 1920, height: 1080, replaceUrl: [{ ObjURL: 'https://example.com/tianjin-eye.jpg', FromURL: 'https://example.com/tianjin-eye' }] }] };
assert.deepStrictEqual(parseBaiduImageResults(baiduFixture), [{ imageUrl: 'https://example.com/tianjin-eye.jpg', sourceUrl: 'https://example.com/tianjin-eye', title: '天津之眼实景', declaredWidth: 1920, declaredHeight: 1080 }], '百度图片结果应解析高清原图、来源页和实体标题');

const ctripFixture = [
  '{"poiName":"目标景区","districtName":"北京","commentScore":4.7,"commentCount":321,"address":"目标地址","introduction":"目标介绍","imageUrl":"https://example.com/target.jpg"}',
  '{"poiName":"相邻热门景区","districtName":"北京","commentScore":4.9,"commentCount":99999,"address":"其他地址","introduction":"其他介绍"}',
].join(',');
const parsedCtrip = parseCtripHtml(ctripFixture, { name: '目标景区', city: '北京' });
assert.strictEqual(parsedCtrip.rating, 4.7, '评分必须来自同一 POI');
assert.strictEqual(parsedCtrip.reviews, 321, '点评数必须来自同一 POI');
assert.strictEqual(parsedCtrip.address, '目标地址', '基本资料必须来自同一 POI');
assert.deepStrictEqual(parsedCtrip.imageUrls, ['https://example.com/target.jpg'], '景点页主图必须限定在同一 POI 数据段');

const amapRating = localAmapRating(
  { name: '北京环球度假区', city: '北京' },
  [{ id: 'amap_B123', name: '北京环球度假区', city: '北京', rating: 4.8 }],
);
assert.strictEqual(amapRating.rating, 4.8, '缺少 OTA 分时应可复用高德唯一同实体评分');

console.log('核心资料通用匹配与断点测试通过。');
