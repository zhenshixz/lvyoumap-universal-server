const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const provincesDir = path.join(root, 'data', 'provinces');
const runtimeReportDir = path.join(root, '.runtime', 'reports');
const publicReportDir = path.join(root, 'reports');
const markdownPath = path.join(runtimeReportDir, 'CODEX_ATTRACTION_CONTENT_LAYER_AUDIT.md');
const jsonPath = path.join(runtimeReportDir, 'CODEX_ATTRACTION_CONTENT_LAYER_AUDIT.json');
const htmlPath = path.join(publicReportDir, 'codex-attraction-content-layer-audit.html');

const provinceFiles = fs.readdirSync(provincesDir).filter(name => name.endsWith('.json'));
const provinces = provinceFiles.map(name => JSON.parse(fs.readFileSync(path.join(provincesDir, name), 'utf8').replace(/^\uFEFF/, '')));
const attractions = provinces.flatMap(province => (province.attractions || []).map(attraction => ({ province: province.province, ...attraction })));
const cityProvince = new Map();
for (const row of attractions) {
  const city = String(row.city || '').replace(/(市|地区|自治州|特别行政区)$/u, '');
  if (!city) continue;
  if (!cityProvince.has(city)) cityProvince.set(city, new Set());
  cityProvince.get(city).add(row.province);
}
const placeNames = [...new Set([
  ...provinces.map(item => item.province),
  ...cityProvince.keys(),
])].filter(name => String(name).length >= 2).sort((a, b) => b.length - a.length);

const genericIntroRe = /(自然风光秀丽，是体验当地特色美景的绝佳去处|历史底蕴深厚，是一处非常值得一游的人文胜地|以.+为主要看点。适合纳入.+经典游览线路)/u;
const ambiguityRe = /(国内有(?:好几个|多个|几处)|全国有(?:好几个|多个|多处)|多个同名|主要有两个(?:版本|热门目的地|景点)|可能指(?:的是|多个|两个)|我先按.{0,35}(?:给出|整理|规划|回答)|分别整理.{0,30}(?:路线|方案)|你确认一下(?:是哪个|具体)|你看看是哪一个|最主流的是|默认按.{0,30}(?:整理|回答)|先确认你说的是|如果是其他(?:城市|地点|景区)|根据所在城市参考|不要选错|别和其他)/u;
const travelTemplateRe = /(本地精选爆款|本地特色美食强烈推荐|拍照打卡特色消暑利器|特色招牌菜|正宗地方风味|票价：70元\/人|推荐区域2)/u;
const lowValueNameRe = /(停车场|售票处|游客中心|服务中心|服务区|收费站|卫生间|出入口|入口$|出口$|公交站|地铁站|转盘$|商场$|购物中心|拍摄地$|认领的树|一棵树$)/u;

function compact(value, max = 170) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function ownPlace(row, place) {
  const city = String(row.city || '').replace(/(市|地区|自治州|特别行政区)$/u, '');
  return row.province === place || city === place || city.includes(place) || place.includes(city) || cityProvince.get(place)?.has(row.province);
}

function mismatchedPlaces(row, text) {
  const own = new Set([row.province, String(row.city || '').replace(/(市|地区|自治州|特别行政区)$/u, '')].filter(Boolean));
  return placeNames.filter(place => !own.has(place) && !ownPlace(row, place) && text.includes(place) && !String(row.name || '').includes(place)).filter(place => {
    const escaped = place.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [
      new RegExp(`^.{0,8}${escaped}(?:人|市|的城市|版的|最)`),
      new RegExp(`位于[^。；]{0,28}${escaped}(?:省|市|地区|自治州|特别行政区)`),
      new RegExp(`${escaped}(?:的城市地标|的城市名片|周边最|版的)`),
    ].some(rule => rule.test(text));
  }).slice(0, 5);
}

const issues = [];
function add(row, layer, type, priority, detail) {
  issues.push({ province: row.province, city: row.city || '', id: row.id || '', name: row.name || '', layer, type, priority, detail: compact(detail, 260) });
}

for (const row of attractions) {
  const basic = `${row.description || ''} ${row.intro || ''}`.trim();
  const lazy = String(row.lazy_ai_text || '').trim();
  const guide = JSON.stringify(row.guide_data || {});
  const wrongPlaces = mismatchedPlaces(row, basic);
  if (wrongPlaces.length) add(row, '基本信息', '疑似串到其他城市实体', '必须修', `检测到：${wrongPlaces.join('、')}；当前：${basic}`);
  if (!basic || genericIntroRe.test(basic)) add(row, '基本信息', basic ? '通用占位简介' : '缺少简介', '应修', basic || '简介为空');

  if (!row.guide_data) add(row, '旅行指南', '缺少结构化指南', '必须修', '前端会因此触发虚构菜名、住宿和交通等旧兜底内容');
  else if (travelTemplateRe.test(guide)) add(row, '旅行指南', '存量模板假内容', '必须修', guide);

  if (!lazy) {
    add(row, '懒人攻略', '缺少文章式攻略', '应修', '没有 lazy_ai_text');
  } else {
    if (ambiguityRe.test(lazy)) add(row, '懒人攻略', '同名景点或实体混淆', '必须修', lazy);
    const hasRoute = /(路线|游览顺序|→|—|先.{0,20}再|入口.{0,40}出口|步行|索道|观光车|接驳)/u.test(lazy);
    const hasAudience = /(老人|长辈|小孩|儿童|亲子|婴儿车)/u.test(lazy);
    if (!ambiguityRe.test(lazy) && (lazy.length < 180 || !hasRoute || !hasAudience)) {
      add(row, '懒人攻略', '内容过短或缺少省力路线要素', '应修', lazy);
    }
  }

  if (lowValueNameRe.test(String(row.name || ''))) add(row, '景点身份', '疑似附属设施或低价值POI', '后续减法', '只列为减法候选，不与内容修复混跑，也不自动删除');
}

const order = { '必须修': 0, '应修': 1, '后续减法': 2 };
issues.sort((a, b) => order[a.priority] - order[b.priority] || a.layer.localeCompare(b.layer, 'zh-Hans-CN') || a.province.localeCompare(b.province, 'zh-Hans-CN'));
const count = predicate => issues.filter(predicate).length;
const groups = [...new Set(issues.map(item => `${item.layer}|${item.type}`))].map(key => {
  const [layer, type] = key.split('|');
  return { layer, type, count: count(item => item.layer === layer && item.type === type) };
});

const generatedAt = new Date().toISOString();
const markdown = `# 全国景点内容分层审计\n\n生成时间：${generatedAt}  \n数据范围：前端实际读取的 ${attractions.length} 条景点。只读审计，没有修改任何景点数据。\n\n## 先看结论\n\n| 层级 | 问题 | 数量 |\n|---|---|---:|\n${groups.map(item => `| ${item.layer} | ${item.type} | ${item.count} |`).join('\n')}\n\n## 正确修复边界\n\n1. **基本信息**：景点简介、地址、电话、开放时间、票价、评分、图片。高德优先补结构化字段，景区官方/公开百科补长简介。\n2. **旅行指南**：衣着、外部交通、内部交通、住宿、美食、老人儿童提示，写入 \`guide_data\`。无数据时禁止前端编造菜名、住宿、70元交通等内容。\n3. **懒人攻略**：写入 \`lazy_ai_text\` 的景点专属长文；至少一条真实节点顺序、省力方式、用时或折返点、休息点、老人儿童和避坑提醒。禁止混入同名异地景点，也不承担美食/住宿/穿衣清单。\n4. **景点身份**：附属设施与低价值 POI 单独留给后续减法，不和本轮内容修复混跑。\n\n完整可筛选清单：\`reports/codex-attraction-content-layer-audit.html\`。\n`;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
const payload = JSON.stringify(issues).replace(/</g, '\\u003c');
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>全国景点内容分层审计</title><style>
body{margin:0;background:#f4f7fb;color:#162033;font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif}.wrap{max-width:1500px;margin:auto;padding:28px}.head{background:linear-gradient(135deg,#0969da,#19a974);color:#fff;border-radius:18px;padding:24px}.head h1{margin:0 0 6px}.summary{display:grid;grid-template-columns:repeat(4,minmax(150px,1fr));gap:12px;margin:18px 0}.card,.panel{background:#fff;border:1px solid #e5eaf1;border-radius:14px;box-shadow:0 4px 16px #18334b0a}.card{padding:16px}.card b{font-size:24px}.panel{padding:16px}.rules{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.rule{background:#f7f9fc;border-radius:10px;padding:12px}.tools{display:flex;gap:10px;flex-wrap:wrap;margin:16px 0}select,input{border:1px solid #ccd5e0;border-radius:9px;padding:9px 11px;background:white}input{min-width:280px;flex:1}.table{overflow:auto;max-height:70vh}table{width:100%;border-collapse:collapse;background:white}th{position:sticky;top:0;background:#edf3f9;text-align:left;z-index:1}th,td{padding:10px;border-bottom:1px solid #e8edf3;vertical-align:top}.pill{display:inline-block;border-radius:99px;padding:2px 8px;white-space:nowrap}.must{background:#ffe5e5;color:#a71d2a}.should{background:#fff1cf;color:#805300}.later{background:#e9eef5;color:#526174}.detail{min-width:420px;max-width:700px;color:#42516a}.empty{padding:30px;text-align:center}@media(max-width:800px){.wrap{padding:12px}.summary,.rules{grid-template-columns:1fr}.detail{min-width:280px}}
</style></head><body><div class="wrap"><section class="head"><h1>全国景点内容分层审计</h1><div>基本信息、旅行指南、懒人攻略、景点身份已经拆开；本页只读，未写入地图。</div></section>
<section class="summary"><div class="card"><div>景点总数</div><b>${attractions.length}</b></div><div class="card"><div>必须修问题</div><b>${count(item => item.priority === '必须修')}</b></div><div class="card"><div>应修问题</div><b>${count(item => item.priority === '应修')}</b></div><div class="card"><div>后续减法</div><b>${count(item => item.priority === '后续减法')}</b></div></section>
<section class="panel"><h2>三层修复边界</h2><div class="rules"><div class="rule"><b>基本信息</b><br>简介、地址、电话、开放时间、票价、评分、图片。</div><div class="rule"><b>旅行指南</b><br>衣着、交通、住宿、美食、老人儿童提示；缺数据时禁止编造。</div><div class="rule"><b>懒人攻略</b><br>景点专属长文路线：真实节点顺序、省力方式、用时/折返、休息和避坑。</div></div></section>
<div class="tools"><select id="priority"><option value="">全部优先级</option><option>必须修</option><option>应修</option><option>后续减法</option></select><select id="layer"><option value="">全部层级</option><option>基本信息</option><option>旅行指南</option><option>懒人攻略</option><option>景点身份</option></select><select id="province"><option value="">全部省份</option></select><input id="query" placeholder="搜索景点、城市、问题或内容"></div>
<section class="panel table"><table><thead><tr><th>优先级</th><th>层级 / 问题</th><th>省市</th><th>景点</th><th>当前问题</th></tr></thead><tbody id="rows"></tbody></table><div class="empty" id="empty" hidden>没有匹配项</div></section></div><script>
const all=${payload};const $=id=>document.getElementById(id);const p=$('province');[...new Set(all.map(x=>x.province))].sort((a,b)=>a.localeCompare(b,'zh-CN')).forEach(x=>p.insertAdjacentHTML('beforeend','<option>'+x+'</option>'));
const E=${JSON.stringify(esc.toString())};function escapeHtml(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}function render(){const q=$('query').value.trim().toLowerCase();const list=all.filter(x=>(!$('priority').value||x.priority===$('priority').value)&&(!$('layer').value||x.layer===$('layer').value)&&(!p.value||x.province===p.value)&&(!q||JSON.stringify(x).toLowerCase().includes(q)));$('rows').innerHTML=list.map(x=>'<tr><td><span class="pill '+(x.priority==='必须修'?'must':x.priority==='应修'?'should':'later')+'">'+x.priority+'</span></td><td><b>'+escapeHtml(x.layer)+'</b><br>'+escapeHtml(x.type)+'</td><td>'+escapeHtml(x.province)+' / '+escapeHtml(x.city)+'</td><td><b>'+escapeHtml(x.name)+'</b><br><small>'+escapeHtml(x.id)+'</small></td><td class="detail">'+escapeHtml(x.detail)+'</td></tr>').join('');$('empty').hidden=!!list.length}['priority','layer','province','query'].forEach(id=>$(id).addEventListener(id==='query'?'input':'change',render));render();
</script></body></html>`;

fs.mkdirSync(runtimeReportDir, { recursive: true });
fs.mkdirSync(publicReportDir, { recursive: true });
fs.writeFileSync(markdownPath, markdown, 'utf8');
fs.writeFileSync(jsonPath, `${JSON.stringify({ generatedAt, totalAttractions: attractions.length, issues }, null, 2)}\r\n`, 'utf8');
fs.writeFileSync(htmlPath, html, 'utf8');
console.log(JSON.stringify({ totalAttractions: attractions.length, totalIssues: issues.length, groups, markdownPath, jsonPath, htmlPath }, null, 2));
