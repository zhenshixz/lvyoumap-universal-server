const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, '.runtime', 'attraction-basic-info', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));

const decisions = {
  'anhui|amap_B0FFHFXP0O': { openHours: '全天开放' },
  'anhui|amap_B0K6ACDOFX': { price: '园区入场免费，游乐项目单独收费，以现场公示为准' },
  'anhui|manual_anhui_8f4d8666': { openHours: '度假区公共区域全天开放，各子项目独立营业', price: '公共区域免费，各子项目独立售票' },
  'aomen|amap_B073D00CK5': { openHours: '公共区域全天开放，场内商户独立营业' },
  'fujian|amap_B0FFGPZGYO': { openHours: '开放时间以寺庙当天安排为准' },
  'gansu|amap_B0FFFDOMSB': { address: '甘肃省天水市甘谷县古坡镇古坡草原' },
  'gansu|amap_B0JUXDNOW0': { openHours: '自然开放区域，建议白天前往；临时管控以现场公告为准' },
  'gansu|amap_B0G3DYZKK2': { openHours: '营业时间以商家当天公示为准' },
  'guangxi|amap_B0FFJNCM9D': { openHours: '全天开放', price: '免费开放' },
  'henan|manual_henan_6ad24665': { price: '温泉项目单独售票，以官方渠道当天价格为准' },
  'jiangxi|amap_B0LDKDPBKE': { openHours: '自然开放区域，建议白天前往；临时管控以现场公告为准' },
  'jilin|manual_jilin_87246a7f': { openHours: '县城公共区域全天开放', price: '县城公共区域免费开放，各景点独立收费' },
  'jilin|manual_jilin_130dd6a7': { openHours: '行政区域全天可进入，各景点独立营业', price: '行政区域免费进入，各景点独立收费' },
  'neimenggu|amap_B0FFFFLN4Y': { openHours: '自然开放区域，建议白天前往；临时管控以现场公告为准' },
  'shaanxi|amap_B0FFF6XPAK': { openHours: '实行预约参观，开放时段以预约页面当天公示为准' },
  'shanxi|amap_B0FFMHTFQH': { price: '免费开放' },
  'xinjiang|amap_B038600EVJ': { price: '免费开放' },
  'yunnan|amap_B0FFIPKSD8': { price: '免费开放' },
};

const identityIssues = {
  'xibet|amap_B0J29R2WB6': '点点未找到“西藏阿里万岁山”对应景区，疑似名称或实体归属错误；门票字段不写入，列入后续减法清单。',
};

let resolvedFields = 0;
for (const item of manifest.items) {
  const values = decisions[item.key];
  if (values) {
    item.after = { ...(item.after || item.before || {}), ...values };
    const fields = Object.keys(values);
    item.changedFields = [...new Set([...(item.changedFields || []), ...fields])];
    item.unresolvedFields = (item.unresolvedFields || []).filter(field => !fields.includes(field));
    item.warnings = [...new Set([...(item.warnings || []), '点点两轮补证后按景点实际运营形态完成语义归类；请在隔离预览中重点抽查。'])];
    resolvedFields += fields.length;
  }
  if (identityIssues[item.key]) {
    item.resolvedWithoutValueFields = [...new Set([...(item.resolvedWithoutValueFields || []), ...(item.unresolvedFields || [])])];
    item.unresolvedFields = [];
    item.warnings = [...new Set([...(item.warnings || []), identityIssues[item.key]])];
    item.identityIssue = true;
  }
  if (!(item.unresolvedFields || []).length && (item.status === 'partial' || item.status === 'unresolved')) item.status = 'ready';
}

manifest.generatedAt = new Date().toISOString();
manifest.status = 'diandian_collected_with_edge_case_review';
manifest.edgeCaseReview = { resolvedFields, identityIssues: Object.keys(identityIssues).length, generatedAt: manifest.generatedAt };
manifest.summary.ready = manifest.items.filter(item => item.status === 'ready').length;
manifest.summary.partial = manifest.items.filter(item => item.status === 'partial').length;
manifest.summary.unresolved = manifest.items.filter(item => item.status === 'unresolved').length;
manifest.summary.proposedFields = Object.fromEntries(['address', 'openHours', 'tel', 'price'].map(field => [field, manifest.items.filter(item => item.changedFields?.includes(field)).length]));
manifest.summary.remainingFields = Object.fromEntries(['address', 'openHours', 'tel', 'price'].map(field => [field, manifest.items.filter(item => item.unresolvedFields?.includes(field)).length]));
fs.writeFileSync(`${manifestPath}.tmp`, `${JSON.stringify(manifest, null, 2)}\r\n`, 'utf8');
fs.renameSync(`${manifestPath}.tmp`, manifestPath);
console.log(JSON.stringify({ edgeCaseReview: manifest.edgeCaseReview, summary: manifest.summary }, null, 2));
