const assert = require('assert');
const { validateCard } = require('./attraction_card_consistency');

const cities = new Map([
  ['遵义', new Set(['贵州'])],
  ['丹东', new Set(['辽宁'])],
  ['深圳', new Set(['广东'])],
]);
const item = { province: '贵州', city: '遵义', name: '凤凰山文化广场', issues: ['travel', 'lazy'] };
const base = {
  intro: '位于贵州省遵义市红花岗区凤凰南路一带，是凤凰山脚下连接城市休闲与红色文化体验的公共文化广场，适合散步、观景和了解遵义红色文化。',
  lazy_ai_text: '凤凰山文化广场只逛平地，不误入登山线。\n\n省力散步路线\n- 从广场入口沿铺装地面到文化景观区。\n- 在休息平台短暂停留，再沿外围平缓道路返回。\n\n老人儿童注意\n- 雨后地面湿滑，儿童靠近水景时由家长看护。\n\n避坑提醒\n- 本条只介绍地面文化广场，不进入凤凰山登山步道。'.repeat(2),
  guide_data: { transport: { external_arrive: '按实时导航前往' } },
  category: '其他',
  image: 'https://example.com/a.jpg',
};

assert.equal(validateCard(item, base, cities).passed, true);
assert(validateCard(item, { ...base, intro: '被誉为辽东第一险峰，位于丹东市。' }, cities).errors.some(error => error.code === 'foreign_city_reference'));
assert(validateCard(item, { ...base, lazy_ai_text: '全国有多个凤凰山，我先按深圳给你规划。'.repeat(12) }, cities).errors.some(error => error.code === 'lazy_entity_ambiguous'));
assert(validateCard(item, { ...base, intro: '历史底蕴深厚，是一处非常值得一游的人文胜地。' }, cities).errors.some(error => error.code === 'intro_generic'));
assert(validateCard(item, { ...base, category: '自然景观' }, cities).errors.some(error => error.code === 'category_mismatch'));
assert(validateCard(item, { ...base, guide_data: { housing: [{ area: '推荐区域2', desc: '占位内容' }] } }, cities).errors.some(error => error.code === 'guide_template_residue'));

console.log('attraction_card_consistency: ok');
