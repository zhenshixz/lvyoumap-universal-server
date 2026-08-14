const assert = require('assert');
const { relatedAttraction } = require('./core_candidate_quality');

const cases = [
  ['北京环球度假区', '北京环球影城', true, '品牌度假区与主题园常用名应归并'],
  ['水立方(国家游泳中心)', '水立方', true, '安全括号别名应归并'],
  ['鸟巢与水立方', '水立方', true, '组合名称中的完整景点名应识别'],
  ['天坛公园-祈年殿', '天坛公园-回音壁', false, '同一大景区的两个子景点不得互相归并'],
  ['明十三陵-定陵', '明十三陵-长陵', false, '组合景区的两个独立子景点不得互相归并'],
  ['朱家尖大青山景区', '朱家尖-慈航广场', false, '只有模糊前缀相同不得归并'],
  ['武当山风景区-玉虚宫(公园路)', '武当山风景区-元天静乐宫', false, '括号内道路信息不能抹掉子景点身份'],
  ['杭州西湖风景名胜区', '杭州西湖风景名胜区-断桥残雪', true, '整体景区可覆盖明确子景点'],
  ['外滩', '外滩万国建筑群', true, '目的地与其常见建筑群名称应归并'],
  ['外滩', '北外滩滨江', false, '相邻但不同的滨水目的地不得归并'],
  ['上海乐高乐园®度假区', '上海乐高乐园度假区', true, '注册商标符号不应造成重复实体'],
];

for (const [left, right, expected, message] of cases) {
  const actual = relatedAttraction(left, right, '测试市', '测试市');
  assert.strictEqual(actual, expected, `${message}: ${left} / ${right}`);
}

console.log(`Core candidate matching regression passed: ${cases.length} cases.`);
