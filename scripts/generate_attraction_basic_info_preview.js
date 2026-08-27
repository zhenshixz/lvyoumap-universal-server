const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const rootDir = path.join(__dirname, '..');
const runtimeDir = path.join(rootDir, '.runtime');
const manifestPath = path.join(runtimeDir, 'attraction-basic-info', 'manifest.json');
const previewsDir = path.join(runtimeDir, 'previews');
const previewRoot = path.join(previewsDir, 'attraction-basic-info');
const stagingRoot = `${previewRoot}.next`;
const previousRoot = `${previewRoot}.previous`;
const serviceName = 'lvyoumap-attraction-basic-info-preview';
const fieldKeys = ['address', 'openHours', 'tel', 'price'];
const fieldLabels = {
  address: '具体地址',
  openHours: '开放时间',
  tel: '联系电话',
  price: '门票参考',
};
const acceptedStatuses = new Set(['ready', 'partial', 'unresolved', 'retained']);

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function assertPreviewPath(filePath) {
  const resolved = path.resolve(filePath);
  const allowedRoot = `${path.resolve(previewsDir)}${path.sep}`;
  if (!resolved.startsWith(allowedRoot)) {
    throw new Error(`拒绝写入隔离预览目录之外的路径：${resolved}`);
  }
  return resolved;
}

function writeJson(filePath, value, { bom = false } = {}) {
  const resolved = assertPreviewPath(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const json = JSON.stringify(value)
    .replace(/&/g, '\\u0026')
    .replace(/'/g, '\\u0027')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');
  fs.writeFileSync(resolved, `${bom ? '\uFEFF' : ''}${json}\r\n`, 'utf8');
}

function writeText(filePath, value) {
  const resolved = assertPreviewPath(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, value, 'utf8');
}

function removePreviewDirectory(directory) {
  const resolved = assertPreviewPath(directory);
  if (fs.existsSync(resolved)) fs.rmSync(resolved, { recursive: true, force: true });
}

function normalizeValue(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeValue).filter(Boolean))];
}

function normalizedFields(value) {
  return stringList(value).filter(field => fieldKeys.includes(field));
}

function normalizeSources(value) {
  if (!Array.isArray(value)) return [];
  return value.map(source => {
    if (typeof source === 'string') return { type: '', title: normalizeValue(source), url: '' };
    return {
      type: normalizeValue(source?.type),
      title: normalizeValue(source?.title || source?.name),
      url: normalizeValue(source?.url || source?.sourceUrl),
    };
  }).filter(source => source.title || source.url);
}

function normalizeFieldObject(value) {
  const result = {};
  for (const field of fieldKeys) {
    if (value && Object.prototype.hasOwnProperty.call(value, field)) {
      result[field] = normalizeValue(value[field]);
    }
  }
  return result;
}

function initialReviewItem(raw, index) {
  const sourceStatus = normalizeValue(raw?.status);
  const warnings = stringList(raw?.warnings);
  if (!acceptedStatuses.has(sourceStatus)) {
    warnings.push(sourceStatus ? `未知采集状态：${sourceStatus}` : '缺少采集状态');
  }
  return {
    key: normalizeValue(raw?.key || `${raw?.slug || ''}|${raw?.id || ''}`),
    province: normalizeValue(raw?.province) || '未知省份',
    slug: normalizeValue(raw?.slug),
    id: normalizeValue(raw?.id),
    name: normalizeValue(raw?.name) || `未命名景点 ${index + 1}`,
    city: normalizeValue(raw?.city),
    sourceStatus,
    status: acceptedStatuses.has(sourceStatus) ? sourceStatus : 'unresolved',
    manifestBefore: normalizeFieldObject(raw?.before),
    proposedAfter: normalizeFieldObject(raw?.after),
    requestedFields: normalizedFields(raw?.requestedFields || raw?.changedFields),
    unresolvedFields: normalizedFields(raw?.unresolvedFields),
    resolvedWithoutValueFields: normalizedFields(raw?.resolvedWithoutValueFields),
    sources: normalizeSources(raw?.sources),
    warnings,
    collectedAt: normalizeValue(raw?.collectedAt),
    before: {},
    after: {},
    changedFields: [],
    mapAvailable: false,
  };
}

function actualFieldValue(attraction, field) {
  if (field === 'tel') return normalizeValue(attraction?.tel || attraction?.phone);
  return normalizeValue(attraction?.[field]);
}

function reviewStatus(item) {
  if (!acceptedStatuses.has(item.sourceStatus)) return 'unresolved';
  if (item.status === 'unresolved') return 'unresolved';
  if (item.unresolvedFields.length) return item.changedFields.length ? 'partial' : 'unresolved';
  if (item.resolvedWithoutValueFields.length) return 'ready';
  if (item.changedFields.length) return item.status === 'partial' ? 'partial' : 'ready';
  return item.status === 'partial' ? 'partial' : 'unchanged';
}

function prepareItem(raw, index, provinceData, search) {
  const item = initialReviewItem(raw, index);
  if (!/^[a-z0-9_-]+$/i.test(item.slug)) item.warnings.push('省份 slug 缺失或格式不正确');
  if (!item.id) item.warnings.push('景点 ID 缺失');

  const attraction = provinceData?.attractions?.find(value => String(value.id) === item.id);
  if (!attraction) {
    item.warnings.push('隔离地图中找不到对应景点，拟更新未应用');
    item.unresolvedFields = [...new Set([...item.unresolvedFields, ...item.requestedFields])];
    item.status = 'unresolved';
    item.after = { ...item.proposedAfter };
    return item;
  }

  item.mapAvailable = true;
  item.before = Object.fromEntries(fieldKeys.map(field => [field, actualFieldValue(attraction, field)]));
  item.after = { ...item.before, ...item.proposedAfter };
  for (const field of fieldKeys) {
    if (Object.prototype.hasOwnProperty.call(item.manifestBefore, field)
      && item.manifestBefore[field] !== item.before[field]) {
      item.warnings.push(`${fieldLabels[field]}的当前值已和采集基线不同`);
    }
  }

  const mayApply = item.sourceStatus === 'ready' || item.sourceStatus === 'partial';
  for (const field of item.requestedFields) {
    if (item.resolvedWithoutValueFields.includes(field)) continue;
    if (!Object.prototype.hasOwnProperty.call(item.proposedAfter, field)) {
      item.warnings.push(`${fieldLabels[field]}标记为变更，但缺少拟更新值`);
      if (!item.unresolvedFields.includes(field)) item.unresolvedFields.push(field);
      continue;
    }
    if (item.before[field] === item.proposedAfter[field]) {
      item.warnings.push(`${fieldLabels[field]}拟更新值与当前值相同`);
      continue;
    }
    if (!mayApply) {
      if (!item.unresolvedFields.includes(field)) item.unresolvedFields.push(field);
      continue;
    }
    attraction[field] = item.proposedAfter[field];
    item.changedFields.push(field);
  }

  if (item.changedFields.length) {
    const searchTarget = search.find(value => String(value.provinceId) === item.slug && String(value.id) === item.id)
      || search.find(value => String(value.id) === item.id);
    if (searchTarget) {
      for (const field of item.changedFields) searchTarget[field] = attraction[field];
    } else {
      item.warnings.push('搜索索引中找不到对应景点；地图详情仍可通过省份数据查看');
    }
  }
  item.status = reviewStatus(item);
  return item;
}

function safeJsonForHtml(value) {
  return JSON.stringify(value)
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function previewHtml(items, manifest, baseUrl) {
  const summary = {
    total: items.length,
    ready: items.filter(item => item.status === 'ready').length,
    partial: items.filter(item => item.status === 'partial').length,
    unresolved: items.filter(item => item.status === 'unresolved').length,
    unchanged: items.filter(item => item.status === 'unchanged').length,
    changedFields: items.reduce((sum, item) => sum + item.changedFields.length, 0),
    warnings: items.reduce((sum, item) => sum + item.warnings.length, 0),
    unresolvedFields: Object.fromEntries(fieldKeys.map(field => [field, items.filter(item => item.unresolvedFields.includes(field)).length])),
  };
  const embedded = safeJsonForHtml({
    items,
    summary,
    baseUrl,
    generatedAt: manifest.generatedAt || '',
    manifestStatus: manifest.status || '',
  });
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>全国景点基本信息采集审查</title>
<style>
*{box-sizing:border-box}html{background:#f5f7f8}body{margin:0;color:#17212b;background:#f5f7f8;font:14px/1.55 "Microsoft YaHei",Arial,sans-serif;letter-spacing:0}button,input,select{font:inherit;letter-spacing:0}a{color:#16689a}.top{background:#fff;border-bottom:1px solid #dbe1e5}.head{max-width:1480px;margin:0 auto;padding:22px 24px 18px}.headline{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}.head h1{margin:0;font-size:25px;line-height:1.25}.meta{margin-top:6px;color:#66737d}.notice{margin-top:14px;padding:9px 12px;border-left:3px solid #198754;background:#edf8f2;color:#175c3c}.map-link{display:inline-flex;align-items:center;min-height:38px;padding:0 13px;border:1px solid #b8c5cc;background:#fff;color:#1b4f6d;text-decoration:none;white-space:nowrap}.summary{display:grid;grid-template-columns:repeat(6,minmax(120px,1fr));border-bottom:1px solid #dbe1e5;background:#dbe1e5;gap:1px}.stat{background:#fff;padding:14px 22px}.stat b{display:block;font-size:21px;line-height:1.25}.stat span{color:#66737d}.toolbar{position:sticky;top:0;z-index:5;display:grid;grid-template-columns:minmax(220px,1fr) 160px 170px 170px auto;gap:9px;padding:11px max(24px,calc((100vw - 1480px)/2 + 24px));background:#fff;border-bottom:1px solid #dbe1e5}.toolbar input,.toolbar select,.toolbar button{height:38px;border:1px solid #c7d0d6;background:#fff;padding:0 10px}.toolbar button{cursor:pointer;color:#244b62}.content{max-width:1480px;margin:0 auto;padding:18px 24px 32px}.result-line{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:10px;color:#5f6d77}.records{display:grid;gap:10px}.record{background:#fff;border:1px solid #dbe1e5;border-radius:6px}.record-head{display:grid;grid-template-columns:minmax(220px,1.2fr) minmax(150px,.6fr) minmax(210px,.8fr) auto;align-items:center;gap:16px;padding:14px 16px}.record-title{min-width:0}.record-title b{display:block;font-size:16px;overflow-wrap:anywhere}.record-title span,.muted{color:#6c7983}.tag{display:inline-flex;align-items:center;min-height:25px;padding:1px 8px;border-radius:3px;font-size:13px;white-space:nowrap}.ready{background:#e7f5ed;color:#17633f}.partial{background:#fff2d8;color:#805500}.unresolved{background:#fdeaea;color:#9b2f2f}.unchanged{background:#edf1f3;color:#56636c}.field-tags{display:flex;flex-wrap:wrap;gap:5px}.field-tag{padding:2px 7px;background:#eef3f6;color:#415866;border-radius:3px;font-size:12px}.record-actions{display:flex;align-items:center;gap:8px;justify-content:flex-end}.record-actions a,.record-actions button{min-height:34px;border:1px solid #c5d0d6;background:#fff;padding:6px 10px;color:#1b5f86;text-decoration:none;cursor:pointer}.record-body{display:none;border-top:1px solid #e2e7ea;padding:15px 16px 17px}.record.open .record-body{display:block}.diff-wrap{overflow:auto}.diff{width:100%;min-width:800px;border-collapse:collapse}.diff th,.diff td{padding:9px 10px;border-bottom:1px solid #e7ecef;text-align:left;vertical-align:top}.diff th{background:#f1f4f6;color:#475660;white-space:nowrap}.diff .field{width:110px;font-weight:700}.diff .arrow{width:36px;text-align:center;color:#71808a}.old{color:#697780}.new{color:#153d55;font-weight:600}.empty-value{color:#8a969e;font-weight:400}.review-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:15px}.review-grid h3{margin:0 0 7px;font-size:14px}.review-grid ul{margin:0;padding-left:20px}.review-grid li{margin:4px 0;overflow-wrap:anywhere}.warning-text{color:#8a4b00}.unresolved-text{color:#972f2f}.source-type{color:#6b7881}.no-detail{color:#73808a}.pager{display:flex;justify-content:flex-end;align-items:center;gap:8px;margin-top:13px}.pager button{width:38px;height:36px;border:1px solid #c7d0d6;background:#fff;cursor:pointer}.pager button:disabled{opacity:.45;cursor:default}.empty{padding:54px 20px;text-align:center;background:#fff;border:1px solid #dbe1e5;color:#707d86}@media(max-width:980px){.summary{grid-template-columns:repeat(3,1fr)}.toolbar{position:static;grid-template-columns:1fr 1fr;padding:10px 14px}.toolbar input{grid-column:1/-1}.content,.head{padding-left:14px;padding-right:14px}.record-head{grid-template-columns:1fr auto}.record-head>.field-tags{grid-column:1/-1}.review-grid{grid-template-columns:1fr}.headline{display:block}.headline .map-link{margin-top:12px}}@media(max-width:560px){.summary{grid-template-columns:repeat(2,1fr)}.toolbar{grid-template-columns:1fr}.toolbar input{grid-column:auto}.record-head{grid-template-columns:1fr}.record-actions{justify-content:flex-start}.stat{padding:12px 14px}}
.missing-summary{display:flex;gap:18px;align-items:center;padding:10px max(24px,calc((100vw - 1480px)/2 + 24px));background:#fff8e8;border-bottom:1px solid #ead9ad;color:#71520c}.missing-summary span{white-space:nowrap}
</style>
</head>
<body>
<div class="top"><header class="head"><div class="headline"><div><h1>全国景点基本信息采集审查</h1><div class="meta" id="meta"></div></div><a class="map-link" href="${baseUrl}/" target="_blank" rel="noopener">打开隔离地图</a></div><div class="notice">当前页面和地图均来自隔离副本，尚未写入 beta 正式数据。</div></header></div>
<section class="summary" id="summary"></section><section class="missing-summary" id="missing-summary"></section>
<section class="toolbar"><input id="search" placeholder="搜索景点、省份、城市或内容"><select id="province"><option value="">全部省份</option></select><select id="status"><option value="">全部状态</option><option value="ready">可写入预览</option><option value="partial">部分完成</option><option value="unresolved">未解决</option><option value="unchanged">无实际变更</option></select><select id="field"><option value="">全部字段</option><option value="address">具体地址</option><option value="openHours">开放时间</option><option value="tel">联系电话</option><option value="price">门票参考</option></select><button id="reset" type="button">清除筛选</button></section>
<main class="content"><div class="result-line"><span id="result"></span><span>每页 50 条</span></div><div class="records" id="records"></div><div class="pager"><button id="prev" type="button" title="上一页" aria-label="上一页">‹</button><span id="page"></span><button id="next" type="button" title="下一页" aria-label="下一页">›</button></div></main>
<script>
const data=${embedded};const labels={address:'具体地址',openHours:'开放时间',tel:'联系电话',price:'门票参考'};const statusLabels={ready:'本轮补充完成',partial:'部分字段已补充',unresolved:'仍有字段待补充',unchanged:'原值已有效'};const pageSize=50;let page=1,filtered=[];const $=id=>document.getElementById(id);const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));const visible=value=>value?esc(value):'<span class="empty-value">空</span>';const safeUrl=value=>/^https?:\/\//i.test(String(value||''))?String(value):'';
function renderSummary(){const values=[['清单总数',data.summary.total],['本轮补充完成',data.summary.ready],['部分字段已补充',data.summary.partial],['仍有字段待补充',data.summary.unresolved],['拟更新字段',data.summary.changedFields],['警告',data.summary.warnings]];$('summary').innerHTML=values.map(([label,value])=>'<div class="stat"><b>'+value+'</b><span>'+label+'</span></div>').join('');$('missing-summary').innerHTML='<b>待补充字段：</b>'+Object.entries(data.summary.unresolvedFields).map(([field,count])=>'<span>'+esc(labels[field])+' '+count+' 条</span>').join('');const generated=data.generatedAt?new Date(data.generatedAt).toLocaleString('zh-CN'):'未记录';$('meta').textContent='采集生成：'+generated+' · 清单状态：'+(data.manifestStatus||'未记录');}
function fieldTags(item){const changed=item.changedFields.map(field=>'<span class="field-tag">'+esc(labels[field])+'</span>');const noValue=item.resolvedWithoutValueFields.map(field=>'<span class="field-tag">'+esc(labels[field])+(field==='tel'?'确认不公开':'确认不适用')+'</span>');const unresolved=item.unresolvedFields.filter(field=>!item.changedFields.includes(field)).map(field=>'<span class="field-tag">'+esc(labels[field])+'待补</span>');return [...changed,...noValue,...unresolved].join('')||'<span class="muted">无字段变化</span>';}
function diffs(item){const fields=[...new Set([...item.changedFields,...item.resolvedWithoutValueFields,...item.unresolvedFields])];if(!fields.length)return '<div class="no-detail">没有需要对比的字段。</div>';return '<div class="diff-wrap"><table class="diff"><thead><tr><th>字段</th><th>当前值</th><th></th><th>拟更新值 / 结果</th></tr></thead><tbody>'+fields.map(field=>{const noValue=item.resolvedWithoutValueFields.includes(field);const unresolved=item.unresolvedFields.includes(field)&&!item.changedFields.includes(field)&&!noValue;const next=noValue?'<span class="muted">已确认无公开值，前端保持隐藏</span>':(unresolved?'<span class="unresolved-text">仍待补采</span>':visible(item.after[field]));return '<tr><td class="field">'+esc(labels[field])+'</td><td class="old">'+visible(item.before[field])+'</td><td class="arrow">→</td><td class="new">'+next+'</td></tr>'}).join('')+'</tbody></table></div>';}
function sources(item){if(!item.sources.length)return '<span class="muted">未记录可展示来源</span>';return '<ul>'+item.sources.map(source=>{const url=safeUrl(source.url);const title=esc(source.title||source.url||'来源');const link=url?'<a href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">'+title+'</a>':title;return '<li>'+link+(source.type?' <span class="source-type">· '+esc(source.type)+'</span>':'')+'</li>'}).join('')+'</ul>';}
function reviewNotes(item){const unresolved=item.unresolvedFields.length?'<ul>'+item.unresolvedFields.map(field=>'<li class="unresolved-text">'+esc(labels[field])+'尚未补齐</li>').join('')+'</ul>':'<span class="muted">无未解决字段</span>';const warnings=item.warnings.length?'<ul>'+item.warnings.map(value=>'<li class="warning-text">'+esc(value)+'</li>').join('')+'</ul>':'<span class="muted">无警告</span>';return '<div class="review-grid"><div><h3>来源</h3>'+sources(item)+'</div><div><h3>未解决项与警告</h3>'+unresolved+warnings+'</div></div>';}
function record(item,index){const map=item.mapAvailable?'<a href="'+esc(data.baseUrl+'/?previewSearch='+encodeURIComponent(item.name))+'" target="_blank" rel="noopener">进入隔离地图</a>':'';const pending=item.unresolvedFields.length?'：'+item.unresolvedFields.map(field=>labels[field]).join('、'):'';return '<article class="record" data-index="'+index+'"><div class="record-head"><div class="record-title"><b>'+esc(item.name)+'</b><span>'+esc(item.province)+' / '+esc(item.city||'未标城市')+' · '+esc(item.id||'无 ID')+'</span></div><div><span class="tag '+esc(item.status)+'">'+esc(statusLabels[item.status]||item.status)+esc(pending)+'</span></div><div class="field-tags">'+fieldTags(item)+'</div><div class="record-actions">'+map+'<button type="button" data-toggle="'+index+'">查看差异</button></div></div><div class="record-body">'+diffs(item)+reviewNotes(item)+'</div></article>';}
function applyFilters(){const query=$('search').value.trim().toLowerCase(),province=$('province').value,status=$('status').value,field=$('field').value;filtered=data.items.filter(item=>{const haystack=[item.name,item.province,item.city,item.id,...Object.values(item.before),...Object.values(item.after),...item.warnings].join(' ').toLowerCase();const fields=[...item.changedFields,...item.resolvedWithoutValueFields,...item.unresolvedFields];return(!query||haystack.includes(query))&&(!province||item.province===province)&&(!status||item.status===status)&&(!field||fields.includes(field));});const pages=Math.max(1,Math.ceil(filtered.length/pageSize));page=Math.min(page,pages);const slice=filtered.slice((page-1)*pageSize,page*pageSize);$('records').innerHTML=slice.length?slice.map((item,index)=>record(item,index)).join(''):'<div class="empty">没有符合条件的景点</div>';$('result').textContent='共 '+filtered.length+' 条，当前显示 '+(slice.length?((page-1)*pageSize+1)+'-'+((page-1)*pageSize+slice.length):'0');$('page').textContent=page+' / '+pages;$('prev').disabled=page<=1;$('next').disabled=page>=pages;document.querySelectorAll('[data-toggle]').forEach(button=>button.addEventListener('click',()=>{const article=button.closest('.record');article.classList.toggle('open');button.textContent=article.classList.contains('open')?'收起差异':'查看差异';}));}
function reset(){['search','province','status','field'].forEach(id=>$(id).value='');page=1;applyFilters();}const provinces=[...new Set(data.items.map(item=>item.province))].sort((a,b)=>a.localeCompare(b,'zh-CN'));$('province').insertAdjacentHTML('beforeend',provinces.map(value=>'<option value="'+esc(value)+'">'+esc(value)+'</option>').join(''));['search','province','status','field'].forEach(id=>$(id).addEventListener(id==='search'?'input':'change',()=>{page=1;applyFilters();}));$('reset').addEventListener('click',reset);$('prev').addEventListener('click',()=>{page-=1;applyFilters();scrollTo(0,0);});$('next').addEventListener('click',()=>{page+=1;applyFilters();scrollTo(0,0);});renderSummary();applyFilters();
</script>
</body>
</html>`;
}

function portAvailable(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function choosePort() {
  for (let port = 3113; port <= 3120; port += 1) {
    if (await portAvailable(port)) return port;
  }
  throw new Error('预览端口 3113-3120 均不可用。');
}

function requestHealth(port, attempts = 30) {
  return new Promise((resolve, reject) => {
    let remaining = attempts;
    const check = () => {
      const request = http.get(`http://127.0.0.1:${port}/api/health`, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => {
          try {
            const health = JSON.parse(body);
            if (response.statusCode === 200 && health.service === serviceName) return resolve(health);
          } catch (_) {}
          if (--remaining <= 0) return reject(new Error('隔离预览健康检查失败。'));
          setTimeout(check, 300);
        });
      });
      request.on('error', () => {
        if (--remaining <= 0) return reject(new Error('隔离预览服务未能启动。'));
        setTimeout(check, 300);
      });
    };
    check();
  });
}

function healthOnce(port) {
  return new Promise(resolve => {
    if (!Number.isInteger(port) || port < 1) return resolve(null);
    const request = http.get(`http://127.0.0.1:${port}/api/health`, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try { resolve(response.statusCode === 200 ? JSON.parse(body) : null); } catch (_) { resolve(null); }
      });
    });
    request.setTimeout(1200, () => request.destroy());
    request.on('error', () => resolve(null));
  });
}

async function stopPreviousPreview() {
  const state = readJson(path.join(previewRoot, 'state.json'), null);
  if (!state?.pid || state.serviceName !== serviceName) return;
  const health = await healthOnce(Number(state.port));
  if (health?.service !== serviceName) return;
  try { process.kill(Number(state.pid)); } catch (_) {}
  await new Promise(resolve => setTimeout(resolve, 250));
}

function replacePreviewDirectory() {
  removePreviewDirectory(previousRoot);
  if (fs.existsSync(previewRoot)) fs.renameSync(assertPreviewPath(previewRoot), assertPreviewPath(previousRoot));
  try {
    fs.renameSync(assertPreviewPath(stagingRoot), assertPreviewPath(previewRoot));
  } catch (error) {
    if (fs.existsSync(previousRoot) && !fs.existsSync(previewRoot)) {
      fs.renameSync(assertPreviewPath(previousRoot), assertPreviewPath(previewRoot));
    }
    throw error;
  }
  removePreviewDirectory(previousRoot);
}

function patchPreviewFrontend(siteDir, version) {
  const appPath = path.join(siteDir, 'app.js');
  const appSource = fs.readFileSync(appPath, 'utf8');
  const versionedApp = appSource.replace(
    /const STATIC_DATA_VERSION\s*=\s*["'][^"']+["'];/,
    `const STATIC_DATA_VERSION = "${version}";`,
  );
  if (versionedApp === appSource) throw new Error('隔离预览无法更新静态数据版本。');
  writeText(appPath, `${versionedApp}\n;(() => { const q = new URLSearchParams(location.search).get('previewSearch'); if (!q) return; const run = () => { const el = document.getElementById('global-search'); if (!el) return setTimeout(run, 200); el.value = q; el.dispatchEvent(new Event('input', { bubbles: true })); }; setTimeout(run, 500); })();\n`);

  const indexPath = path.join(siteDir, 'index.html');
  const indexSource = fs.readFileSync(indexPath, 'utf8');
  const versionedIndex = indexSource.replace(
    /(<script\b[^>]*\bsrc=["'](?:\.\/|\/)?app\.js)(?:\?[^"']*)?(["'][^>]*>)/i,
    `$1?v=${version}$2`,
  );
  if (versionedIndex === indexSource) throw new Error('隔离预览无法更新入口脚本版本。');
  writeText(indexPath, versionedIndex);
}

async function main() {
  if (!fs.existsSync(manifestPath)) throw new Error(`采集清单不存在：${manifestPath}`);
  const manifestSource = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestSource.replace(/^\uFEFF/, ''));
  if (!Array.isArray(manifest.items)) throw new Error('采集清单格式无效：items 必须是数组。');
  if (!manifest.items.length) throw new Error('采集清单中没有可预览景点。');

  const slugs = [...new Set(manifest.items.map(item => normalizeValue(item?.slug)).filter(Boolean))];
  const distDir = path.join(rootDir, 'dist');
  const required = ['index.html', 'app.js', 'style.css', path.join('data', 'search-index.json')];
  const missing = required.filter(relative => !fs.existsSync(path.join(distDir, relative)));
  if (missing.length) throw new Error(`现有 dist 不完整：${missing.join('、')}`);

  removePreviewDirectory(stagingRoot);
  fs.mkdirSync(assertPreviewPath(stagingRoot), { recursive: true });
  const siteDir = path.join(stagingRoot, 'site');
  fs.cpSync(distDir, assertPreviewPath(siteDir), { recursive: true });
  const searchPath = path.join(siteDir, 'data', 'search-index.json');
  const search = readJson(searchPath, []);
  if (!Array.isArray(search)) throw new Error('隔离副本的搜索索引格式无效。');

  const provinceDocuments = new Map();
  for (const slug of slugs) {
    if (!/^[a-z0-9_-]+$/i.test(slug)) continue;
    const provincePath = path.join(siteDir, 'data', 'provinces', `${slug}.json`);
    provinceDocuments.set(slug, {
      path: provincePath,
      data: readJson(provincePath, null),
      changed: false,
    });
  }

  const seenKeys = new Map();
  const items = manifest.items.map((raw, index) => {
    const slug = normalizeValue(raw?.slug);
    const document = provinceDocuments.get(slug);
    const key = `${slug}|${normalizeValue(raw?.id)}`;
    const duplicate = seenKeys.has(key);
    if (!duplicate) seenKeys.set(key, 'pending');
    let item;
    if (duplicate) {
      item = initialReviewItem(raw, index);
      const attraction = document?.data?.attractions?.find(value => String(value.id) === item.id);
      if (attraction) {
        item.mapAvailable = true;
        item.before = Object.fromEntries(fieldKeys.map(field => [field, actualFieldValue(attraction, field)]));
        item.after = { ...item.before, ...item.proposedAfter };
      } else {
        item.after = { ...item.proposedAfter };
      }
      item.warnings.push('采集清单中存在重复景点，重复项未应用');
      item.status = 'unresolved';
      item.unresolvedFields = [...new Set([...item.unresolvedFields, ...item.requestedFields])];
    } else {
      item = prepareItem(raw, index, document?.data, search);
    }
    if (!duplicate && item.changedFields.length && document) {
      document.changed = true;
      seenKeys.set(key, 'applied');
    }
    return item;
  });

  for (const document of provinceDocuments.values()) {
    if (document.changed) writeJson(document.path, document.data, { bom: true });
  }
  if (items.some(item => item.changedFields.length)) writeJson(searchPath, search);

  const version = `basic_info_preview_${Date.now()}`;
  patchPreviewFrontend(siteDir, version);
  const port = await choosePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  writeText(path.join(siteDir, 'preview.html'), previewHtml(items, manifest, baseUrl));

  await stopPreviousPreview();
  replacePreviewDirectory();
  const finalSiteDir = path.join(previewRoot, 'site');
  const child = spawn(process.execPath, [path.join('server', 'index.js')], {
    cwd: rootDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      STATIC_DIR: finalSiteDir,
      SERVICE_NAME: serviceName,
    },
  });
  child.unref();
  try {
    await requestHealth(port);
  } catch (error) {
    try { process.kill(child.pid); } catch (_) {}
    throw error;
  }

  const state = {
    status: 'ready',
    serviceName,
    pid: child.pid,
    port,
    previewUrl: `${baseUrl}/preview.html`,
    mapUrl: `${baseUrl}/`,
    siteDir: finalSiteDir,
    manifestPath: path.relative(rootDir, manifestPath),
    manifestGeneratedAt: manifest.generatedAt || '',
    manifestFingerprint: crypto.createHash('sha256').update(manifestSource).digest('hex'),
    generatedAt: new Date().toISOString(),
    itemCount: items.length,
    appliedItemCount: items.filter(item => item.changedFields.length).length,
    appliedFieldCount: items.reduce((sum, item) => sum + item.changedFields.length, 0),
    unresolvedItemCount: items.filter(item => item.status === 'unresolved').length,
    warningCount: items.reduce((sum, item) => sum + item.warnings.length, 0),
    sourceDataReadOnly: true,
  };
  writeJson(path.join(previewRoot, 'state.json'), state);
  console.log(`全国景点基本信息隔离预览已生成：${state.previewUrl}`);
  console.log(`拟更新 ${state.appliedItemCount} 个景点、${state.appliedFieldCount} 个字段；未解决 ${state.unresolvedItemCount} 个景点。`);
  console.log('正式数据未修改。');
}

if (require.main === module) {
  main().catch(error => {
    try { removePreviewDirectory(stagingRoot); } catch (_) {}
    console.error(`生成全国景点基本信息隔离预览失败：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { fieldKeys, previewHtml };
