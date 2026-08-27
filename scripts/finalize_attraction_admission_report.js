const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const provinceDir = path.join(root, 'data', 'provinces');
const cachePath = path.join(root, '.runtime', 'admission-verification', 'cache.jsonl');
const reportPath = path.join(root, 'reports', 'attraction-admission-final.csv');
const actionPath = path.join(root, 'reports', 'attraction-key-info-final-action-list.csv');
const htmlPath = path.join(root, 'reports', 'attraction-admission-final.html');

const freePattern = /免费开放|免费参观|免费入园|免费入场|免门票|无需门票|不收门票|门票(?:为|是|：|:)\s*(?:0\s*元|免费)|全年免费/i;
const baseTicketPattern = /(?:大门票|景区门票|入园票|入场票|成人票|门票|票价)[^。；\n]{0,35}(?:￥|¥)?\s*[1-9]\d*(?:\.\d+)?\s*元/i;
const addonPattern = /观光车|接驳车|小火车|索道|缆车|游船|轮渡|停车|讲解|演出|表演|灯会|体验项目|游乐项目|二次消费|收费项目/i;
const publicPattern = /公园|广场|街区|步行街|老街|古街|江滩|海滩|沙滩|绿道|风光带|观景台|灯塔|码头|纪念馆|博物馆|博物院|美术馆|科技馆|文化馆|陈列馆|图书馆|村落|古村|古镇|古城/;
const controlledPattern = /主题公园|欢乐谷|方特|迪士尼|环球度假|海洋公园|水上乐园|动物园|植物园|游乐园|影视城|温泉|滑雪|漂流|峡谷|溶洞|洞窟|景区|风景区|旅游区|度假区|世界|乐园/;
const allDayPattern = /00:00\s*[-至]\s*24:00|全天开放|24\s*小时开放/;

function loadCache() {
  const cache = new Map();
  if (!fs.existsSync(cachePath)) return cache;
  for (const line of fs.readFileSync(cachePath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      cache.set(row.key, row);
    } catch (_) {}
  }
  return cache;
}

function generic(value) {
  return !String(value || '').trim() || /详见|以官方|以景区|可能动态调整|暂无|未公开/.test(String(value));
}

function classify(attraction, verified) {
  if (verified?.status === 'verified' && verified.classification) {
    return { classification: verified.classification, basis: verified.evidence, source: verified.sourceType, sourceUrl: verified.sourceUrl, level: verified.confidence || '中' };
  }
  const name = String(attraction.name || '');
  const price = String(attraction.price || '');
  const hours = String(attraction.openHours || '');
  if (freePattern.test(price)) {
    return { classification: addonPattern.test(price) ? '免费开放（含收费项目）' : '免费开放', basis: `现有门票资料：${price}`, source: '现有结构化资料', sourceUrl: '', level: '中' };
  }
  if (baseTicketPattern.test(price)) {
    return { classification: '收费/需购票', basis: `现有门票资料：${price}`, source: '现有结构化资料', sourceUrl: '', level: '中' };
  }
  if (addonPattern.test(price) && (allDayPattern.test(hours) || publicPattern.test(name))) {
    return { classification: '免费开放（含收费项目）', basis: `主体按开放空间归类；现有资料仅明确独立收费项目：${price}`, source: '现有资料综合判定', sourceUrl: '', level: '中' };
  }
  if (publicPattern.test(name) && !controlledPattern.test(name)) {
    return { classification: '免费开放', basis: allDayPattern.test(hours) ? `公共开放空间；现有开放时间为${hours}` : '公共开放空间或公共文化场馆', source: '现有资料综合判定', sourceUrl: '', level: '中' };
  }
  if (allDayPattern.test(hours) && publicPattern.test(name)) {
    return { classification: '免费开放', basis: `公共开放空间；现有开放时间为${hours}`, source: '现有资料综合判定', sourceUrl: '', level: '中' };
  }
  return { classification: '收费/需购票', basis: '受控或经营型游览场所，按需补齐票务信息', source: '现有资料综合判定', sourceUrl: '', level: '中' };
}

const cache = loadCache();
const rows = [];
for (const file of fs.readdirSync(provinceDir).filter(name => name.endsWith('.json')).sort()) {
  const doc = JSON.parse(fs.readFileSync(path.join(provinceDir, file), 'utf8').replace(/^\uFEFF/, ''));
  const province = doc.province || doc.name || path.basename(file, '.json');
  for (const attraction of doc.attractions || []) {
    const key = `${province}|${attraction.city || ''}|${attraction.id || attraction.name}`;
    const result = classify(attraction, cache.get(key));
    const phone = attraction.tel || attraction.phone || '';
    const required = [];
    const standardize = [];
    if (generic(attraction.address)) required.push('补具体地址');
    if (result.classification.startsWith('免费开放')) {
      if (generic(attraction.price) || !freePattern.test(String(attraction.price || ''))) standardize.push('规范为免费开放并注明独立收费项目');
      if (generic(attraction.openHours)) standardize.push('补开放时间');
    } else {
      if (generic(attraction.openHours)) required.push('补开放时间');
      if (generic(attraction.price)) required.push('补门票参考');
      if (generic(phone)) required.push('补公开电话；确无则隐藏');
    }
    rows.push({ province, city: attraction.city || '', attraction, result, required, standardize, phone });
  }
}

const quote = value => `"${String(value || '').replace(/"/g, '""')}"`;
const toCsv = matrix => `\uFEFF${matrix.map(row => row.map(quote).join(',')).join('\r\n')}\r\n`;
const full = [
  ['省份', '城市', '景点', '景点ID', '开放属性', '归类依据', '依据类型', '来源网址', '归类强度', '开放时间', '门票参考', '具体地址', '联系电话'],
  ...rows.map(row => [row.province, row.city, row.attraction.name, row.attraction.id, row.result.classification, row.result.basis, row.result.source, row.result.sourceUrl, row.result.level, row.attraction.openHours, row.attraction.price, row.attraction.address, row.phone]),
];
const actions = rows.filter(row => row.required.length || row.standardize.length);
const action = [
  ['省份', '城市', '景点', '景点ID', '免费或收费', '归类依据', '必须补充', '可标准化', '当前开放时间', '当前门票参考', '当前具体地址', '当前联系电话'],
  ...actions.map(row => [row.province, row.city, row.attraction.name, row.attraction.id, row.result.classification, row.result.basis, row.required.join('、'), row.standardize.join('、'), row.attraction.openHours, row.attraction.price, row.attraction.address, row.phone]),
];
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, toCsv(full), 'utf8');
fs.writeFileSync(actionPath, toCsv(action), 'utf8');

const counts = Object.fromEntries(['免费开放', '免费开放（含收费项目）', '收费/需购票'].map(type => [type, rows.filter(row => row.result.classification === type).length]));
const viewRows = rows.map(row => ({
  province: row.province,
  city: row.city,
  name: row.attraction.name,
  classification: row.result.classification,
  basis: row.result.basis,
  source: row.result.source,
  sourceUrl: row.result.sourceUrl,
  required: row.required,
  standardize: row.standardize,
  openHours: row.attraction.openHours || '',
  price: row.attraction.price || '',
  address: row.attraction.address || '',
  phone: row.phone,
}));
const embeddedRows = JSON.stringify(viewRows).replace(/<\//g, '<\\/');
const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>全国景点开放属性审查</title>
<style>
*{box-sizing:border-box}body{margin:0;color:#182028;background:#f5f7f8;font:14px/1.5 "Microsoft YaHei",Arial,sans-serif;letter-spacing:0}header{background:#fff;border-bottom:1px solid #dfe5e8;padding:22px 28px}h1{margin:0 0 4px;font-size:24px}.sub{color:#63707a}.notice{margin-top:14px;padding:9px 12px;border-left:3px solid #198754;background:#edf8f2;color:#185c3d}.summary{display:grid;grid-template-columns:repeat(5,minmax(130px,1fr));gap:1px;background:#dfe5e8;border-bottom:1px solid #dfe5e8}.stat{background:#fff;padding:16px 22px}.stat b{display:block;font-size:22px}.stat span{color:#697781}.toolbar{position:sticky;top:0;z-index:3;display:grid;grid-template-columns:minmax(240px,1fr) 180px 220px auto;gap:10px;padding:12px 28px;background:#fff;border-bottom:1px solid #dfe5e8}input,select,button{height:38px;border:1px solid #cbd4d9;background:#fff;padding:0 11px;font:inherit}button{cursor:pointer}.content{padding:18px 28px 28px}.result-line{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;color:#5d6972}.table-wrap{overflow:auto;background:#fff;border:1px solid #dfe5e8}table{width:100%;border-collapse:collapse;min-width:1120px}th,td{padding:10px 12px;border-bottom:1px solid #e7ecef;text-align:left;vertical-align:top}th{position:sticky;top:63px;z-index:2;background:#eef2f4;color:#43505a;white-space:nowrap}tr:hover td{background:#fafcfc}.name{font-weight:700}.tag{display:inline-block;padding:2px 7px;border-radius:3px;white-space:nowrap}.free{background:#e8f6ee;color:#146c43}.addon{background:#fff4d9;color:#856404}.paid{background:#fdecec;color:#a02b2b}.muted{color:#74818a}.actions{color:#a24b00}details{max-width:400px}summary{cursor:pointer;color:#1967a3}.pager{display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:12px}.pager button{width:38px;padding:0}.empty{text-align:center;padding:50px;color:#74818a}@media(max-width:820px){header,.content{padding-left:14px;padding-right:14px}.summary{grid-template-columns:repeat(2,1fr)}.toolbar{position:static;grid-template-columns:1fr 1fr;padding:10px 14px}.toolbar input{grid-column:1/-1}th{top:0}}
</style>
</head>
<body>
<header><h1>全国景点开放属性审查</h1><div class="sub">生成时间：${new Date().toLocaleString('zh-CN')} · Beta 只读审查</div><div class="notice">当前仅完成整理和分类，尚未写入地图数据。</div></header>
<section class="summary"><div class="stat"><b>${rows.length}</b><span>景点总数</span></div><div class="stat"><b>${counts['免费开放']}</b><span>免费开放</span></div><div class="stat"><b>${counts['免费开放（含收费项目）']}</b><span>免费含收费项目</span></div><div class="stat"><b>${counts['收费/需购票']}</b><span>收费或需购票</span></div><div class="stat"><b>${actions.length}</b><span>需要补资料</span></div></section>
<section class="toolbar"><input id="search" placeholder="搜索景点、省份或城市"><select id="province"><option value="">全部省份</option></select><select id="type"><option value="">全部开放属性</option><option>免费开放</option><option>免费开放（含收费项目）</option><option>收费/需购票</option></select><label><input id="actionsOnly" type="checkbox" style="height:auto"> 只看需补资料</label></section>
<main class="content"><div class="result-line"><span id="result"></span><span>每页 100 条</span></div><div class="table-wrap"><table><thead><tr><th>省份 / 城市</th><th>景点</th><th>开放属性</th><th>需要处理</th><th>当前信息与依据</th></tr></thead><tbody id="body"></tbody></table></div><div class="pager"><button id="prev" title="上一页">‹</button><span id="page"></span><button id="next" title="下一页">›</button></div></main>
<script>const rows=${embeddedRows};const pageSize=100;let page=1,filtered=[];const $=id=>document.getElementById(id);const esc=s=>String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const provinces=[...new Set(rows.map(r=>r.province))].sort((a,b)=>a.localeCompare(b,'zh-CN'));$('province').insertAdjacentHTML('beforeend',provinces.map(p=>'<option>'+esc(p)+'</option>').join(''));function tag(t){const c=t==='免费开放'?'free':t.includes('含收费')?'addon':'paid';return '<span class="tag '+c+'">'+esc(t)+'</span>'}function render(){const q=$('search').value.trim().toLowerCase(),p=$('province').value,t=$('type').value,only=$('actionsOnly').checked;filtered=rows.filter(r=>(!q||(r.name+r.province+r.city).toLowerCase().includes(q))&&(!p||r.province===p)&&(!t||r.classification===t)&&(!only||r.required.length||r.standardize.length));const pages=Math.max(1,Math.ceil(filtered.length/pageSize));page=Math.min(page,pages);const slice=filtered.slice((page-1)*pageSize,page*pageSize);$('body').innerHTML=slice.length?slice.map(r=>{const acts=[...r.required,...r.standardize];const source=r.sourceUrl?'<a href="'+esc(r.sourceUrl)+'" target="_blank">'+esc(r.source)+'</a>':esc(r.source);return '<tr><td>'+esc(r.province)+'<br><span class="muted">'+esc(r.city||'-')+'</span></td><td class="name">'+esc(r.name)+'</td><td>'+tag(r.classification)+'</td><td class="actions">'+(acts.length?acts.map(esc).join('<br>'):'<span class="muted">无需处理</span>')+'</td><td><details><summary>查看详情</summary><b>开放时间：</b>'+esc(r.openHours||'-')+'<br><b>门票：</b>'+esc(r.price||'-')+'<br><b>地址：</b>'+esc(r.address||'-')+'<br><b>电话：</b>'+esc(r.phone||'-')+'<br><b>依据：</b>'+esc(r.basis)+'<br><b>来源：</b>'+source+'</details></td></tr>'}).join(''):'<tr><td colspan="5" class="empty">没有符合条件的景点</td></tr>';$('result').textContent='共 '+filtered.length+' 条';$('page').textContent=page+' / '+pages;$('prev').disabled=page<=1;$('next').disabled=page>=pages}['search','province','type','actionsOnly'].forEach(id=>$(id).addEventListener(id==='search'?'input':'change',()=>{page=1;render()}));$('prev').onclick=()=>{page--;render();scrollTo(0,0)};$('next').onclick=()=>{page++;render();scrollTo(0,0)};render();</script>
</body></html>`;
fs.writeFileSync(htmlPath, html, 'utf8');

console.log(JSON.stringify({ total: rows.length, counts, actions: actions.length, onlineOrExplicit: rows.filter(row => /公开|结构化/.test(row.result.source)).length, comprehensive: rows.filter(row => row.result.source === '现有资料综合判定').length, reportPath, actionPath, htmlPath }, null, 2));
