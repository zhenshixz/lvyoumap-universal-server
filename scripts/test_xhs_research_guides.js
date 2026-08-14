const assert = require('assert');
const { chooseBetterFailure, parseAnswer, routeIsUsable } = require('./xhs_research_guides');

const target = { name: '天津自然博物馆', city: '天津', research: { discoveredSources: [] } };
const answer = '景点全称：天津自然博物馆 景点类型：自然历史博物馆 路线A标题：三楼至一楼省力线 路线A节点：三楼生态展区＞二楼生命展区＞一楼探索展区 路线A体力：2 路线A步行：约2.5公里 路线A提示：先乘直梯到三楼往下逛｜途中可休息 路线B标题：不适用 路线B节点：不适用 路线B体力：不适用 路线B步行：不适用 路线B提示：不适用 外部到达：地铁文化中心站步行可达 入口建议：先存包再参观 内部交通：扶梯和直梯连接 住宿区域：文化中心周边 长辈儿童：长辈建议：多使用电梯；儿童建议：可重点参观互动展区\n\n活动';
const parsed = parseAnswer(answer, target);

assert.equal(parsed.complete, true);
assert.equal(parsed.value.routes.length, 1);
assert.equal(parsed.value.routes[0].nodes.length, 3);
assert.equal(routeIsUsable(parsed.value.routes[0]), true);
assert.equal(routeIsUsable({ title: '不适用', nodes: ['不适用'], physical: 0, walking: '不适用', tips: ['不适用'] }), false);
assert.equal(chooseBetterFailure(
  { answerPreview: answer, issues: ['旧规则误判'] },
  { answerPreview: '问题分析中', issues: ['缺少景点类型', '缺少可执行游览方案'] },
).answerPreview, answer);

console.log('XHS semantic route completeness tests passed.');
