const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
if (path.basename(root).toLowerCase() !== 'lvyoumap-universal-serverbeta') throw Error('Beta only');
const runtime = path.join(root, '.runtime', 'gallery-link-batches');
const runs = path.join(runtime, 'runs');
fs.mkdirSync(runs, { recursive: true });
const read = (file, fallback = null) => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } };
function write(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temp, file);
}
function alive(pid) { try { if (!Number.isInteger(pid) || pid <= 0) return false; process.kill(pid, 0); return true; } catch { return false; } }
function tripUrl(value) {
  if (!String(value || '').trim()) return '';
  let u;
  try { u = new URL(String(value).trim()); } catch { throw Error('链接格式不完整，请复制浏览器地址栏中的完整地址'); }
  if (u.protocol !== 'https:') throw Error('链接需要以 https:// 开头');
  if (!['hk.trip.com', 'www.trip.com', 'cn.trip.com'].includes(u.hostname) || u.port || u.username || u.password) throw Error('链接必须来自 hk.trip.com、www.trip.com 或 cn.trip.com');
  if (!/^\/travel-guide\/(?:attraction|shops)\/[^/]+\/[^/]+-\d+\/?$/i.test(u.pathname)) throw Error('需要Trip具体地点详情页，不能使用搜索页或城市列表页');
  return `https://hk.trip.com${u.pathname.replace(/\/$/, '')}/`;
}
// These are supplied or previously browser-verified pages, not automatic search results.
const known = {
  amap_B03AF002D7: ['jingtai/yellow-river-stone-forest-national-geological-park-13412956', '黄河石林国家地质公园', '景泰'],
  amap_B02400TOA1: ['linhai/linghu-lake-scenic-area-10520631', '灵湖景区', '临海'],
  amap_B0FFIKGPKW: ['urumqi-county/urumqi-tianshan-grand-canyon-10522927', '乌鲁木齐天山大峡谷', '乌鲁木齐'],
  amap_B034200JQ6: ['xichang/qionghai-national-wetland-park-80559', '邛海国家湿地公园', '西昌'],
  amap_B015F0IDFZ: ['taiyuan/wenying-ertong-park-77962', '太原市文瀛公园', '太原'],
  amap_B02410407T: ['yongjia/taogongdong-76206', '陶公洞', '永嘉'],
  amap_B02F002K55: ['huizhou/honghua-lake-10546235', '红花湖', '惠州'],
  amap_B03950Q74Q: ['taibai-county/huang-bai-yuan-24650465', '黄柏塬', '太白'],
  amap_B022F00FTA: ['she-county/huizhou-ancient-city-yuliang-dam-and-yuliang-town-58283104', '渔梁坝和渔梁古镇', '歙县'],
};
function draft() {
  const file = path.join(runtime, 'draft.json');
  const existing = read(file);
  if (existing) return existing;
  const pilot = read(path.join(root, '.runtime', 'attraction-gallery-batch', 'link-pilot-10-plus-10.json'));
  if (!pilot?.training || pilot.training.length !== 10) throw Error('Fixed 10-item pilot list missing');
  const value = { revision: 1, savedAt: null, items: pilot.training.map(x => {
    const k = known[x.id];
    return { id: x.id, name: x.name, city: x.city, province: x.province, beforeSelected: x.beforeSelected, url: k ? `https://hk.trip.com/travel-guide/attraction/${k[0]}/` : '', pageName: k?.[1] || '', region: k?.[2] || x.city, skip: false };
  }) };
  write(file, value); return value;
}
function validateDraft(input, current) {
  if (input.revision !== current.revision) throw Error('清单已更新，请刷新后再保存');
  if (!Array.isArray(input.items) || input.items.length !== current.items.length || !input.items.length) throw Error('清单条数不匹配');
  const result = { ...current, revision: current.revision + 1, savedAt: new Date().toISOString(), items: current.items.map((old, index) => {
    const matches = input.items.filter(i=>i.id===old.id);
    if(matches.length!==1) throw Error('清单ID缺失或重复');
    const item = matches[0];
    if (item.id !== old.id) throw Error('清单ID不可变更');
    let url;
    try { url = tripUrl(item.url); } catch (e) { throw Error(`${old.name}：${e.message}`); }
    const pageName = String(item.pageName || '').trim();
    const region = String(item.region || '').trim();
    if (pageName.length > 100 || region.length > 40) throw Error('名称或地域过长');
    return { ...old, url, pageName, region, skip: !!item.skip };
  }) };
  return current.savedAt && JSON.stringify(result.items) === JSON.stringify(current.items) ? current : result;
}
function batchList() {
  return fs.readdirSync(runs).filter(x => /^\d{8}-\d{6}-[a-f0-9]{6}$/.test(x)).sort().reverse().map(id => {
    const s = read(path.join(runs, id, 'state.json'));
    if (!s) return null;
    return { id, createdAt: s.createdAt, status: s.status === 'running' && !alive(s.pid) ? 'interrupted' : s.status, processed: s.items.filter(x => x.done).length, total: s.items.length, candidates: s.items.reduce((a, x) => a + (x.images || []).filter(y => y.accepted).length, 0), current: s.current, heartbeatAt: s.heartbeatAt };
  }).filter(Boolean);
}
function batchPath(id) { if (!/^\d{8}-\d{6}-[a-f0-9]{6}$/.test(id)) throw Error('Invalid batch ID'); return path.join(runs, id); }
function sourcePolicy() {
  const value = read(path.join(runtime, 'source-policy.json'), {});
  const disabledUntil = Date.parse(value.amapDisabledUntil || 0);
  return {
    amapDisabled: Number.isFinite(disabledUntil) && Date.now() < disabledUntil,
    amapDisabledUntil: value.amapDisabledUntil || null,
    amapReason: String(value.amapReason || ''),
  };
}
module.exports = { fs, path, root, runtime, runs, read, write, alive, tripUrl, draft, validateDraft, batchList, batchPath, sourcePolicy };
