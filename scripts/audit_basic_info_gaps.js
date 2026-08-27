const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const provinceDir = path.join(root, 'data', 'provinces');
const reportDir = path.join(root, 'reports');
const fields = [
  ['景点介绍', a => a.intro || a.description],
  ['景区等级', a => a.level],
  ['联系电话', a => a.tel || a.phone],
  ['开放时间', a => a.openHours],
  ['门票参考', a => a.price],
  ['景区地址', a => a.address],
  ['公开评分', a => Number(a.rating) > 0 ? String(a.rating) : ''],
  ['特色标签', a => Array.isArray(a.tags) && a.tags.length >= 2 ? a.tags.join('、') : ''],
  ['温馨提示', a => a.tips],
  ['景点图片', a => a.image],
  ['资料来源', a => (a.source_evidence?.basicInfoSources?.length || a.source_evidence?.source || a.source_evidence?.sourceUrl) ? '有' : ''],
  ['更新时间', a => a.source_evidence?.basicInfoUpdatedAt || a.source_evidence?.updatedAt],
];

const genericPatterns = {
  '联系电话': /详见景区公告|暂无|未公开|以官方.*为准/,
  '开放时间': /详见景区公告|开放日期、预约与入场时段可能动态调整|以景区官方.*公告为准/,
  '门票参考': /以官方购票页为准|票务、优惠及独立项目价格可能动态调整|以景区官方.*公示为准/,
  '景区地址': /详见定位|景区定位|详见景区公告|以官方.*为准/,
  '温馨提示': /建议结合景区公告、实时交通和现场开放情况安排行程|动态信息以官方.*为准/,
  '景点介绍': /暂无介绍|具体开放范围、预约和交通安排以景区官方当日公告为准/,
};

const freePricePattern = /(?:全景区|主景区|景区|公园|街区|广场|场馆|基本陈列)?免费开放|免费参观|免费入园|免费入场|免门票|无需门票|不收门票|门票免费|门票\s*(?:为|：|:)\s*(?:0\s*元|免费)|基础门票免费/;
const paidTicketPattern = /(?:门票|票价|成人票|景区票|入园票|套票|购票|售票)[^。；\n]{0,45}(?:￥|¥)?\s*[1-9]\d*(?:\.\d+)?\s*元|(?:￥|¥)\s*[1-9]\d*(?:\.\d+)?/;
const openAllDayPattern = /00:00\s*[-至]\s*24:00|全天开放|24\s*小时开放/;
const openSpacePattern = /广场|步行街|历史文化街区|文化街区|老街|古街|滨江|江滩|海滩|沙滩|绿道|风光带|城市客厅|市民中心|开放公园|城市公园/;
const managedPlacePattern = /主题公园|欢乐谷|方特|迪士尼|环球度假|海洋公园|水上乐园|动物园|植物园|森林公园|湿地公园|地质公园|国家公园|风景区|景区|旅游区|度假区|博物馆|纪念馆|科技馆|美术馆|故居|寺|庙|宫|塔|园林|古镇|古城|山|峡谷|洞|湖|温泉|滑雪/;
const hardPaidPlacePattern = /主题公园|欢乐谷|方特|迪士尼|环球度假|海洋公园|水上乐园|动物园|游乐园|乐园|影视城|温泉|滑雪/;

function fieldState(label, value) {
  const text = String(value || '').trim();
  if (!text) return 'missing';
  if (genericPatterns[label]?.test(text)) return 'generic';
  return 'ready';
}

function classifyAdmission(attraction) {
  const name = String(attraction.name || '');
  const category = String(attraction.category || '');
  const tags = Array.isArray(attraction.tags) ? attraction.tags.join(' ') : String(attraction.tags || '');
  const price = String(attraction.price || '').trim();
  const openHours = String(attraction.openHours || '').trim();
  const profile = `${name} ${category} ${tags}`;
  const hasFreeEvidence = freePricePattern.test(price);
  const hasPaidEvidence = paidTicketPattern.test(price);
  const looksManaged = managedPlacePattern.test(profile);
  const looksOpenSpace = (openSpacePattern.test(profile) || /公园/.test(name)) && !looksManaged;

  if (hasFreeEvidence) {
    return {
      admission: hasPaidEvidence ? '免费开放（含收费项目）' : '免费开放',
      basis: `现有门票资料明确${hasPaidEvidence ? '基础免费、部分项目收费' : '免费'}`,
      certainty: '高',
    };
  }
  if (hasPaidEvidence) {
    return { admission: '收费/需购票', basis: '现有门票资料包含明确票价', certainty: '高' };
  }
  if (openAllDayPattern.test(openHours) && !hardPaidPlacePattern.test(profile)) {
    return { admission: '免费开放', basis: '现有记录为全天开放且无购票证据', certainty: '高' };
  }
  if (looksOpenSpace) {
    return { admission: '免费开放', basis: '开放式公共空间规则归类', certainty: '中' };
  }
  return {
    admission: '收费/需购票',
    basis: looksManaged ? '受控或经营型场所按收费标准补齐' : '无免费依据，按收费标准保守补齐',
    certainty: looksManaged ? '中' : '保守',
  };
}

const rows = [];
const classifiedAttractions = [];
let total = 0;
for (const file of fs.readdirSync(provinceDir).filter(name => name.endsWith('.json')).sort()) {
  const doc = JSON.parse(fs.readFileSync(path.join(provinceDir, file), 'utf8').replace(/^\uFEFF/, ''));
  const province = doc.province || doc.name || path.basename(file, '.json');
  for (const attraction of (doc.attractions || [])) {
    total += 1;
    const classification = classifyAdmission(attraction);
    const phone = attraction.tel || attraction.phone;
    const states = {
      '开放时间': fieldState('开放时间', attraction.openHours),
      '门票参考': fieldState('门票参考', attraction.price),
      '景区地址': fieldState('景区地址', attraction.address),
      '联系电话': fieldState('联系电话', phone),
    };
    const required = [];
    const standardized = [];
    const optional = [];
    if (states['景区地址'] !== 'ready') required.push('补具体地址');
    if (classification.admission.startsWith('免费开放')) {
      if (states['门票参考'] !== 'ready' || !freePricePattern.test(String(attraction.price || ''))) standardized.push('补充免费开放依据并规范门票字段');
      if (states['开放时间'] !== 'ready') standardized.push('补充开放时间；确认无限时后可写全天开放');
      if (states['联系电话'] !== 'ready') optional.push('无公开电话可隐藏');
    } else {
      if (states['开放时间'] !== 'ready') required.push('补开放时间');
      if (states['门票参考'] !== 'ready') required.push('补门票参考');
      if (states['联系电话'] !== 'ready') required.push('补联系电话；确无公开电话则隐藏');
    }
    classifiedAttractions.push({
      province,
      city: attraction.city || '',
      name: attraction.name || attraction.id || '未命名景点',
      id: attraction.id || '',
      classification,
      states,
      required,
      standardized,
      optional,
      values: {
        openHours: attraction.openHours || '',
        price: attraction.price || '',
        address: attraction.address || '',
        phone: phone || '',
      },
      source: attraction.source_evidence?.source || '',
    });
    const missing = [];
    const generic = [];
    for (const [label, getter] of fields) {
      const value = String(getter(attraction) || '').trim();
      if (!value) missing.push(label);
      else if (genericPatterns[label]?.test(value)) generic.push(label);
    }
    if (missing.length || generic.length) {
      rows.push({
        province,
        city: attraction.city || '',
        name: attraction.name || attraction.id || '未命名景点',
        id: attraction.id || '',
        missing,
        generic,
      });
    }
  }
}

const countBy = (kind) => {
  const result = {};
  for (const row of rows) for (const field of row[kind]) result[field] = (result[field] || 0) + 1;
  return Object.entries(result).sort((a, b) => b[1] - a[1]);
};
const missingCounts = countBy('missing');
const genericCounts = countBy('generic');
const realMissingRows = rows.filter(row => row.missing.length);
const genericRows = rows.filter(row => row.generic.length);
const keyFields = ['开放时间', '门票参考', '景区地址', '联系电话'];
const keyRows = rows.map(row => ({
  ...row,
  keyMissing: row.missing.filter(field => keyFields.includes(field)),
  keyGeneric: row.generic.filter(field => keyFields.includes(field)),
})).filter(row => row.keyMissing.length || row.keyGeneric.length)
  .sort((a, b) => (b.keyMissing.length * 10 + b.keyGeneric.length) - (a.keyMissing.length * 10 + a.keyGeneric.length));
const hardFieldPattern = /景点介绍|景区等级|开放时间|门票参考|景区地址|公开评分|景点图片/;
const hardRows = rows.filter(row => hardFieldPattern.test(row.missing.join('|')));
const phoneOnlyRows = rows.filter(row => row.missing.includes('联系电话') && !hardFieldPattern.test(row.missing.join('|')));

fs.mkdirSync(reportDir, { recursive: true });
const csvPath = path.join(reportDir, 'attraction-basic-info-gaps.csv');
const mdPath = path.join(reportDir, 'attraction-basic-info-gaps.md');
const quote = value => `"${String(value || '').replace(/"/g, '""')}"`;
const csv = [
  ['省份', '城市', '景点', '景点ID', '真实缺失字段', '占位或泛化字段'].map(quote).join(','),
  ...rows.map(row => [row.province, row.city, row.name, row.id, row.missing.join('、'), row.generic.join('、')].map(quote).join(',')),
].join('\r\n');
fs.writeFileSync(csvPath, `\uFEFF${csv}\r\n`, 'utf8');
const criticalCsvPath = path.join(reportDir, 'attraction-basic-info-critical-gaps.csv');
const criticalCsv = [
  ['省份', '城市', '景点', '景点ID', '核心缺失字段', '占位或泛化字段'].map(quote).join(','),
  ...hardRows.map(row => [row.province, row.city, row.name, row.id, row.missing.join('、'), row.generic.join('、')].map(quote).join(',')),
].join('\r\n');
fs.writeFileSync(criticalCsvPath, `\uFEFF${criticalCsv}\r\n`, 'utf8');
const keyCsvPath = path.join(reportDir, 'attraction-key-info-gaps.csv');
const keyCsv = [
  ['省份', '城市', '景点', '景点ID', '关键项真实缺失', '关键项泛化占位'].map(quote).join(','),
  ...keyRows.map(row => [row.province, row.city, row.name, row.id, row.keyMissing.join('、'), row.keyGeneric.join('、')].map(quote).join(',')),
].join('\r\n');
fs.writeFileSync(keyCsvPath, `\uFEFF${keyCsv}\r\n`, 'utf8');

const admissionCsvPath = path.join(reportDir, 'attraction-admission-classification.csv');
const admissionCsv = [
  ['省份', '城市', '景点', '景点ID', '开放属性', '归类依据', '归类强度', '开放时间', '门票参考', '具体地址', '联系电话', '现有来源'].map(quote).join(','),
  ...classifiedAttractions.map(row => [row.province, row.city, row.name, row.id, row.classification.admission, row.classification.basis, row.classification.certainty, row.values.openHours, row.values.price, row.values.address, row.values.phone, row.source].map(quote).join(',')),
].join('\r\n');
fs.writeFileSync(admissionCsvPath, `\uFEFF${admissionCsv}\r\n`, 'utf8');

const actionRows = classifiedAttractions
  .filter(row => row.required.length || row.standardized.length)
  .sort((a, b) => (b.required.length * 10 + b.standardized.length) - (a.required.length * 10 + a.standardized.length));
const actionCsvPath = path.join(reportDir, 'attraction-key-info-action-list.csv');
const actionCsv = [
  ['省份', '城市', '景点', '景点ID', '免费或收费', '归类依据', '必须补充', '可标准化', '允许隐藏', '当前开放时间', '当前门票参考', '当前具体地址', '当前联系电话'].map(quote).join(','),
  ...actionRows.map(row => [row.province, row.city, row.name, row.id, row.classification.admission, row.classification.basis, row.required.join('、'), row.standardized.join('、'), row.optional.join('、'), row.values.openHours, row.values.price, row.values.address, row.values.phone].map(quote).join(',')),
].join('\r\n');
fs.writeFileSync(actionCsvPath, `\uFEFF${actionCsv}\r\n`, 'utf8');

const md = [
  '# 全国景点基本信息缺失盘点',
  '',
  `- 扫描景点：${total} 个`,
  `- 存在真实缺失：${realMissingRows.length} 个`,
  `- 核心展示字段缺失（优先处理）：${hardRows.length} 个`,
  `- 四项关键信息存在缺失或占位：${keyRows.length} 个`,
  `- 免费开放类：${classifiedAttractions.filter(row => row.classification.admission.startsWith('免费开放')).length} 个`,
  `- 收费/需购票类：${classifiedAttractions.filter(row => row.classification.admission === '收费/需购票').length} 个`,
  `- 产生四项信息处理动作：${actionRows.length} 个`,
  `- 仅缺电话及增强项：${phoneOnlyRows.length} 个`,
  `- 仅有占位或泛化信息：${rows.filter(row => !row.missing.length && row.generic.length).length} 个`,
  `- 涉及任一问题：${rows.length} 个`,
  `- 完整且非占位：${total - rows.length} 个`,
  '',
  '## 真实缺失字段统计',
  '',
  ...missingCounts.map(([field, count]) => `- ${field}：${count}`),
  '',
  '## 占位或泛化字段统计',
  '',
  ...genericCounts.map(([field, count]) => `- ${field}：${count}`),
  '',
  '## 景点清单',
  '',
  '| 省份 | 城市 | 景点 | 真实缺失 | 占位或泛化 |',
  '|---|---|---|---|---|',
  ...rows.map(row => `| ${row.province} | ${row.city || '-'} | ${String(row.name).replace(/\|/g, '｜')} | ${row.missing.join('、') || '-'} | ${row.generic.join('、') || '-'} |`),
  '',
  '> 本报告只盘点，不修改任何景点数据。开放时间、票价等动态字段使用“以景区公告为准”并非错误，但属于需要后续补强的泛化信息。',
].join('\n');
fs.writeFileSync(mdPath, md, 'utf8');

console.log(JSON.stringify({ total, realMissing: realMissingRows.length, hardMissing: hardRows.length, keyInfoAffected: keyRows.length, freeAdmission: classifiedAttractions.filter(row => row.classification.admission.startsWith('免费开放')).length, paidAdmission: classifiedAttractions.filter(row => row.classification.admission === '收费/需购票').length, actionItems: actionRows.length, phoneOnly: phoneOnlyRows.length, genericOnly: rows.filter(row => !row.missing.length && row.generic.length).length, affected: rows.length, complete: total - rows.length, missingCounts: Object.fromEntries(missingCounts), genericCounts: Object.fromEntries(genericCounts), csvPath, criticalCsvPath, keyCsvPath, admissionCsvPath, actionCsvPath, mdPath }, null, 2));
