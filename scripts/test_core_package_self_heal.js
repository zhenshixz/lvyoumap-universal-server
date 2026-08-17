const assert = require('assert');
const { healAdditionsAgainstExisting, healPackageDuplicates, normalizedEvidenceUrl, sharesStrongEvidence } = require('./core_package_self_heal');

const source = '携程旅行：https://you.ctrip.com/sight/chongqing158/112663.html?scene=online';
assert.equal(normalizedEvidenceUrl(source), 'you.ctrip.com/sight/chongqing158/112663.html');

const generic = {
  id: 'generic', name: '喀斯特旅游区', city: '重庆', lazy_routes: [{ title: '线路一' }],
  source_evidence: { basicInfoSources: [source] },
};
const specific = {
  id: 'specific', name: '武隆喀斯特旅游区', city: '重庆', lazy_routes: [{ title: '线路一' }, { title: '线路二' }],
  source_evidence: { basicInfoSources: ['高德地图：https://www.amap.com/place/B00178VNLG', source] },
};
assert(sharesStrongEvidence(generic, specific));
const healed = healPackageDuplicates({ attractions: [generic, specific] });
assert.equal(healed.packageData.attractions.length, 1, '共享同一实体来源的近似名称应自动合并');
assert.equal(healed.packageData.attractions[0].name, '武隆喀斯特旅游区', '保留信息更完整且名称更具体的记录');
assert.equal(healed.packageData.attractions[0].lazy_routes.length, 2, '合并不得丢失更完整路线');
assert.equal(healed.actions.length, 1);

const ambiguous = healPackageDuplicates({ attractions: [
  { ...generic, id: 'a', source_evidence: { basicInfoSources: ['普通来源：https://example.com/a'] } },
  { ...specific, id: 'b', source_evidence: { basicInfoSources: ['普通来源：https://example.com/b'] } },
] });
assert.equal(ambiguous.packageData.attractions.length, 2, '没有同实体证据时不得仅凭近似名称误合并');

const existing = healAdditionsAgainstExisting({ attractions: [specific], overrides: {} }, {
  attractions: [{ id: 'amap-existing', name: '武隆喀斯特旅游区', city: '重庆' }],
});
assert.equal(existing.packageData.attractions.length, 0, '旧库已有同名实体时不得重复新增');
assert(existing.packageData.overrides['amap-existing'], '应自动转换为旧记录的增强覆盖');
assert.equal(existing.actions[0].type, 'convert_addition_to_override');

const baselineBound = healAdditionsAgainstExisting({ attractions: [{
  ...specific,
  id: 'new-road',
  baselineKey: 'core-road',
  name: '张北草原天路',
  city: '张北',
  source_evidence: { basicInfoSources: ['https://example.com/new-road'] },
}], overrides: {} }, {
  attractions: [{ id: 'amap-road', name: '草原天路', city: '张家口' }],
}, {
  attractions: [{ key: 'core-road', name: '张北草原天路', aliases: ['草原天路'] }],
});
assert.equal(baselineBound.packageData.attractions.length, 0, '已批准核心清单唯一命中时应自动增强旧记录');
assert(baselineBound.packageData.overrides['amap-road']);

const ambiguousBaseline = healAdditionsAgainstExisting({ attractions: [{
  ...specific, id: 'new-museum', baselineKey: 'core-museum', name: '城市博物馆', city: '甲市',
}], overrides: {} }, {
  attractions: [
    { id: 'museum-a', name: '城市博物馆东馆', city: '甲市' },
    { id: 'museum-b', name: '城市博物馆西馆', city: '甲市' },
  ],
}, {
  attractions: [{ key: 'core-museum', name: '城市博物馆', aliases: [] }],
});
assert.equal(ambiguousBaseline.packageData.attractions.length, 1, '核心清单同时命中多个实体时不得自动合并');

const explicitDecision = healAdditionsAgainstExisting({ attractions: [{
  ...specific, id: 'new-museum', baselineKey: 'core-museum', name: '城市博物馆', city: '甲市',
}], overrides: {} }, {
  attractions: [
    { id: 'museum-a', name: '城市博物馆东馆', city: '甲市' },
    { id: 'museum-b', name: '城市博物馆西馆', city: '甲市' },
  ],
}, {
  attractions: [{ key: 'core-museum', name: '城市博物馆', aliases: [] }],
}, {
  'core-museum': { action: 'enhance_existing', existingId: 'museum-b' },
});
assert.equal(explicitDecision.packageData.attractions.length, 0, '总控明确选择后应转换为指定旧记录的增强覆盖');
assert(explicitDecision.packageData.overrides['museum-b']);

const keepDistinct = healAdditionsAgainstExisting({ attractions: [{
  ...specific, id: 'new-museum', baselineKey: 'core-museum', name: '城市博物馆', city: '甲市',
}], overrides: {} }, {
  attractions: [{ id: 'museum-a', name: '城市博物馆', city: '甲市' }],
}, {}, {
  'core-museum': { action: 'keep_new' },
});
assert.equal(keepDistinct.packageData.attractions.length, 1, '总控明确判定为独立景点后不得再自动合并');

console.log('核心补全包自愈测试通过。');
