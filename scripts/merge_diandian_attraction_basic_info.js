const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const runtimeDir = path.join(root, '.runtime', 'attraction-basic-info');
const manifestPath = path.join(runtimeDir, 'manifest.json');
const eventsPath = path.join(runtimeDir, 'diandian-events.jsonl');

const fieldAliases = {
  address: ['address', '地址', '具体地址'],
  openHours: ['openHours', '开放时间', '营业时间'],
  tel: ['tel', '电话', '联系电话'],
  price: ['price', '门票', '门票参考', '门票价格'],
};

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function unavailable(value) {
  return !value || /^(?:无|未知|未查到|暂无|暂无信息|无法确定|不详|null|undefined|-)$/i.test(value);
}

function valueFor(raw, field) {
  for (const key of fieldAliases[field]) {
    if (Object.prototype.hasOwnProperty.call(raw || {}, key)) return clean(raw[key]);
  }
  const requestedLabel = clean(raw?.字段名称);
  if (fieldAliases[field].some(label => requestedLabel.includes(label))) return clean(raw?.字段值);
  return '';
}

function acceptable(field, value) {
  if (unavailable(value)) return false;
  if (field === 'tel') return /(?:1[3-9]\d{9}|400\d?[-\s]?\d{3}[-\s]?\d{3,4}|0\d{1,3}(?:[-\s]?\d{3,4}){2}|\+?(?:852|853|886)[-\s]?\d{4}[-\s]?\d{3,4})(?:[、;,；]\s*\d{6,})?/.test(value);
  if (field === 'openHours') return /(?:全天|全年|24\s*小时|\d{1,2}[:：]\d{2}|与.*开放时间一致|随.*开放|以.*(?:开放时间|营业情况|当天营业)为准|各子景区.*(?:开放|运营)|需.*以.*行程为准|无固定开放时间|无统一开放时间|暂停开放|关闭)/.test(value);
  if (field === 'price') return /(?:免费|免票|无需门票|无需单独购票|无单独门票|无统一门票|包含于.*门票|已含在.*门票|随.*门票|独立售票|按天或小时收费|\d+(?:\.\d+)?\s*(?:元|港币|澳门币|澳门元|人民币)|港币\s*\$?\s*\d+|暂停开放|关闭|以.*为准)/.test(value);
  if (field === 'address') return value.length >= 4 && /(?:省|市|县|区|镇|乡|街|路|大道|巷|村|景区|公园|号)/.test(value);
  return false;
}

function parseResponse(event) {
  const text = clean(event.response).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    const data = JSON.parse(text);
    if (!Array.isArray(data) || data.length !== event.items.length) return null;
    return data;
  } catch {
    return null;
  }
}

function main() {
  const manifest = readJson(manifestPath);
  const items = new Map(manifest.items.map(item => [item.key, item]));
  const latest = new Map();
  const stats = { successfulBatches: 0, invalidBatches: 0, resolvedFields: 0, noPublicPhone: 0, affectedItems: 0 };

  for (const line of fs.readFileSync(eventsPath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.ok === false) continue;
      const response = parseResponse(event);
      if (!response) { stats.invalidBatches += 1; continue; }
      stats.successfulBatches += 1;
      event.items.forEach((source, index) => latest.set(source.key, { event, source, answer: response[index] }));
    } catch {
      stats.invalidBatches += 1;
    }
  }

  for (const [key, record] of latest) {
    const item = items.get(key);
    if (!item) continue;
    const found = [];
    const noValue = new Set(item.resolvedWithoutValueFields || []);
    const after = { ...(item.after || item.before || {}) };
    for (const field of record.source.fields || []) {
      const value = valueFor(record.answer, field);
      if (field === 'tel' && /无公开电话|暂无公开电话|未公开电话|无公开信息|未查询到|未查到/.test(value)) {
        noValue.add('tel');
        found.push('tel');
        stats.noPublicPhone += 1;
      } else if (acceptable(field, value)) {
        after[field] = value;
        found.push(field);
      }
    }
    if (!found.length) continue;
    stats.affectedItems += 1;
    stats.resolvedFields += found.length;
    item.after = after;
    item.resolvedWithoutValueFields = [...noValue];
    item.changedFields = [...new Set([...(item.changedFields || []), ...found.filter(field => !noValue.has(field))])];
    item.unresolvedFields = (item.unresolvedFields || []).filter(field => !found.includes(field));
    item.sources = [...(item.sources || []), {
      type: 'xiaohongshu_diandian',
      title: `小红书点点 · ${item.name} 基本信息补证`,
      url: record.event.url,
    }];
    item.sources = [...new Map(item.sources.map(source => [`${source.title}|${source.url}`, source])).values()];
    item.warnings = (item.warnings || []).filter(value => !/仍待补充|本轮未找到/.test(value));
    if (noValue.has('tel')) item.warnings.push('点点补证未发现公开联系电话；正式写入时保持电话字段隐藏。');
    item.warnings = [...new Set(item.warnings)];
    item.status = item.unresolvedFields.length ? 'partial' : 'ready';
    item.diandianResearch = { collectedAt: record.event.collectedAt, batch: record.event.batch };
  }

  manifest.generatedAt = new Date().toISOString();
  manifest.status = 'diandian_partial_collected';
  manifest.diandianResearch = { ...stats, generatedAt: manifest.generatedAt };
  manifest.summary.ready = manifest.items.filter(item => item.status === 'ready').length;
  manifest.summary.partial = manifest.items.filter(item => item.status === 'partial').length;
  manifest.summary.unresolved = manifest.items.filter(item => item.status === 'unresolved').length;
  manifest.summary.proposedFields = Object.fromEntries(['address', 'openHours', 'tel', 'price'].map(field => [field,
    manifest.items.filter(item => item.changedFields?.includes(field)).length]));
  manifest.summary.remainingFields = Object.fromEntries(['address', 'openHours', 'tel', 'price'].map(field => [field,
    manifest.items.filter(item => item.unresolvedFields?.includes(field)).length]));
  fs.writeFileSync(`${manifestPath}.tmp`, `${JSON.stringify(manifest, null, 2)}\r\n`, 'utf8');
  fs.renameSync(`${manifestPath}.tmp`, manifestPath);
  console.log(JSON.stringify({ stats, summary: manifest.summary }, null, 2));
}

main();
