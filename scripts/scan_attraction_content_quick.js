const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const auditScript = path.join(root, 'scripts', 'audit_attraction_content_layers.js');
const auditJson = path.join(root, '.runtime', 'reports', 'CODEX_ATTRACTION_CONTENT_LAYER_AUDIT.json');
const outputDir = path.join(root, '.runtime', 'reports');
const jsonPath = path.join(outputDir, 'CODEX_ATTRACTION_CONTENT_QUICK_LIST.json');
const markdownPath = path.join(outputDir, 'CODEX_ATTRACTION_CONTENT_QUICK_LIST.md');
const htmlPath = path.join(root, 'reports', 'codex-attraction-content-quick-list.html');

execFileSync(process.execPath, [auditScript], { cwd: root, stdio: 'ignore' });
const audit = JSON.parse(fs.readFileSync(auditJson, 'utf8').replace(/^\uFEFF/, ''));
const grouped = new Map();
for (const issue of audit.issues || []) {
  const key = `${issue.province}|${issue.id || `${issue.city}|${issue.name}`}`;
  if (!grouped.has(key)) grouped.set(key, { province: issue.province, city: issue.city, id: issue.id, name: issue.name, issues: [] });
  grouped.get(key).issues.push({ layer: issue.layer, type: issue.type, priority: issue.priority, detail: issue.detail });
}

const levelOrder = { '优先修复': 0, '内容完善': 1, '后续减法': 2 };
const rows = [...grouped.values()].map(row => {
  const hasCritical = row.issues.some(issue => issue.priority === '必须修');
  const onlyCleanup = row.issues.every(issue => issue.priority === '后续减法');
  const level = hasCritical ? '优先修复' : onlyCleanup ? '后续减法' : '内容完善';
  const layers = [...new Set(row.issues.map(issue => issue.layer))];
  return { ...row, level, layers, problemCount: row.issues.length };
}).sort((a, b) => levelOrder[a.level] - levelOrder[b.level]
  || b.problemCount - a.problemCount
  || a.province.localeCompare(b.province, 'zh-CN')
  || a.name.localeCompare(b.name, 'zh-CN'));

const counts = Object.fromEntries(Object.keys(levelOrder).map(level => [level, rows.filter(row => row.level === level).length]));
const generatedAt = new Date().toISOString();
fs.mkdirSync(outputDir, { recursive: true });
fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
fs.writeFileSync(jsonPath, `${JSON.stringify({ generatedAt, totalAttractions: audit.totalAttractions, counts, rows }, null, 2)}\r\n`, 'utf8');

const markdown = `# 全国景点内容快速扫描名单\n\n生成时间：${generatedAt}  \n扫描景点：${audit.totalAttractions} 条  \n发现需处理景点：${rows.length} 条\n\n| 队列 | 景点数 | 含义 |\n|---|---:|---|\n| 优先修复 | ${counts['优先修复']} | 实体错配、同名混入、旅行指南假模板等明确错误 |\n| 内容完善 | ${counts['内容完善']} | 通用简介、缺少指南或攻略等质量不足 |\n| 后续减法 | ${counts['后续减法']} | 附属设施或低价值 POI，只记录、不自动删除 |\n\n完整名单请打开：\`reports/codex-attraction-content-quick-list.html\`。\n`;
fs.writeFileSync(markdownPath, markdown, 'utf8');

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
const payload = JSON.stringify(rows).replace(/</g, '\\u003c');
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>全国景点内容快速扫描名单</title><style>
body{margin:0;background:#f4f7fb;color:#172033;font:14px/1.55 system-ui,"Microsoft YaHei",sans-serif}.wrap{max-width:1500px;margin:auto;padding:24px}.hero{padding:22px;border-radius:18px;background:linear-gradient(135deg,#1769d2,#17a673);color:#fff}.hero h1{margin:0 0 5px}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:16px 0}.card,.panel{background:#fff;border:1px solid #e2e8f0;border-radius:13px}.card{padding:15px}.card b{font-size:25px}.tools{display:flex;gap:9px;flex-wrap:wrap;margin:14px 0}.tools select,.tools input{padding:9px 11px;border:1px solid #cbd5e1;border-radius:8px;background:#fff}.tools input{flex:1;min-width:260px}.panel{overflow:auto;max-height:72vh}table{width:100%;border-collapse:collapse}th{position:sticky;top:0;background:#edf3f8;text-align:left;z-index:1}th,td{padding:10px;border-bottom:1px solid #e8edf3;vertical-align:top}.pill{display:inline-block;border-radius:99px;padding:2px 8px;white-space:nowrap}.critical{background:#ffe4e4;color:#a51d2d}.improve{background:#fff0c9;color:#805200}.cleanup{background:#e9eef5;color:#526174}.issues{min-width:480px}.issue{margin:0 0 6px}.issue b{color:#334155}@media(max-width:800px){.wrap{padding:10px}.stats{grid-template-columns:1fr 1fr}.issues{min-width:320px}}
</style></head><body><div class="wrap"><section class="hero"><h1>全国景点内容快速扫描名单</h1><div>同一景点的问题已合并；本页只读，不会修改地图数据。</div></section><section class="stats"><div class="card">扫描景点<br><b>${audit.totalAttractions}</b></div><div class="card">优先修复<br><b>${counts['优先修复']}</b></div><div class="card">内容完善<br><b>${counts['内容完善']}</b></div><div class="card">后续减法<br><b>${counts['后续减法']}</b></div></section><div class="tools"><select id="level"><option value="">全部队列</option><option>优先修复</option><option>内容完善</option><option>后续减法</option></select><select id="province"><option value="">全部省份</option></select><select id="layer"><option value="">全部层级</option><option>基本信息</option><option>旅行指南</option><option>懒人攻略</option><option>景点身份</option></select><input id="query" placeholder="搜索景点、城市或问题"></div><section class="panel"><table><thead><tr><th>队列</th><th>省市</th><th>景点</th><th>问题合并清单</th></tr></thead><tbody id="rows"></tbody></table></section></div><script>
const all=${payload};const $=id=>document.getElementById(id);const province=$('province');[...new Set(all.map(x=>x.province))].sort((a,b)=>a.localeCompare(b,'zh-CN')).forEach(x=>province.insertAdjacentHTML('beforeend','<option>'+x+'</option>'));function e(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}function render(){const q=$('query').value.trim().toLowerCase();const list=all.filter(x=>(!$('level').value||x.level===$('level').value)&&(!province.value||x.province===province.value)&&(!$('layer').value||x.layers.includes($('layer').value))&&(!q||JSON.stringify(x).toLowerCase().includes(q)));$('rows').innerHTML=list.map(x=>'<tr><td><span class="pill '+(x.level==='优先修复'?'critical':x.level==='内容完善'?'improve':'cleanup')+'">'+x.level+'</span></td><td>'+e(x.province)+' / '+e(x.city)+'</td><td><b>'+e(x.name)+'</b><br><small>'+e(x.id)+'</small></td><td class="issues">'+x.issues.map(i=>'<div class="issue"><b>'+e(i.layer)+' · '+e(i.type)+'</b>：'+e(i.detail)+'</div>').join('')+'</td></tr>').join('')}['level','province','layer','query'].forEach(id=>$(id).addEventListener(id==='query'?'input':'change',render));render();
</script></body></html>`;
fs.writeFileSync(htmlPath, html, 'utf8');

console.log(`扫描完成：${audit.totalAttractions} 条景点`);
console.log(`优先修复：${counts['优先修复']}；内容完善：${counts['内容完善']}；后续减法：${counts['后续减法']}`);
console.log(`名单：${htmlPath}`);
if (process.argv.includes('--open') && process.platform === 'win32') {
  spawn('cmd', ['/c', 'start', '', htmlPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
