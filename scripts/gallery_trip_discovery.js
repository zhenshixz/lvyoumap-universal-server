const { fs, path, runtime, read, write, tripUrl } = require('./gallery_link_batch_common');
const simplify = require('opencc-js').Converter({ from: 'tw', to: 'cn' });
const DISCOVERY_POLICY_VERSION = 6;
const norm = s => simplify(String(s || '')).replace(/[\s\p{P}]/gu, '');
const regionKey = s => norm(s).replace(/特别行政区|维吾尔族自治区|壮族自治区|回族自治区|蒙古族自治区|自治州|地区|市$/g, '');
function queryVariants(item) {
  const original = String(item.name || '').trim();
  const variants = [original];
  variants.push(...original.split(/[·、（）()]/).map(x => x.trim()).filter(x => x.length >= 2));
  const suffixes = [
    '国家级旅游度假区', '省级旅游度假区', '国际旅游度假区', '旅游度假区',
    '国家级自然保护区', '风景名胜区', '自然保护区', '旅游区', '风景区', '景区', '旧址', '遗址'
  ];
  for (const value of [...variants]) for (const suffix of suffixes) if (value.endsWith(suffix) && value.length > suffix.length + 1) {
    const base = value.slice(0, -suffix.length).trim();
    variants.push(base);
    const city = String(item.city || item.region || '').trim();
    if (city && base.startsWith(city) && base.length > city.length + 1) variants.push(base.slice(city.length));
    break;
  }
  return [...new Set(variants)].filter(x => x.length >= 2);
}
function select(item, candidates, options = {}) {
  const region = norm(['香港', '澳门'].includes(item.province) ? item.province : item.city || item.region);
  const requested = norm(item.name);
  const requestedNames = [requested, ...(options.names || queryVariants(item)).map(norm)].filter(Boolean);
  const wantedRegion = regionKey(region);
  const sameRegion = c => wantedRegion && c.region.split(/[·•]/).some(r => { const k=regionKey(r); return k===wantedRegion || k.includes(wantedRegion) || wantedRegion.includes(k); });
  const nameFit = c => {
    const name = norm(c.name);
    if (requestedNames.some(wanted => name === wanted || name.includes(wanted) || wanted.includes(name))) return true;
    // Short canonical names such as 红门 may appear as a suffix of a parent title.
    if (requested.length >= 2) {
      for (let i=0;i<=requested.length-2;i++) if (name.includes(requested.slice(i, i+2))) return true;
    }
    return false;
  };
  const index = candidates.findIndex(c => sameRegion(c) && nameFit(c));
  const matchedName = index >= 0 ? norm(candidates[index].name) : '';
  const aliasMatch = index >= 0 && requestedNames.slice(1).some(wanted => matchedName === wanted || matchedName.includes(wanted) || wanted.includes(matchedName));
  return index >= 0
    ? {status:'matched', ...candidates[index], policyVersion:DISCOVERY_POLICY_VERSION, selectionRule:matchedName===requested?'first_same_region_exact':(aliasMatch||options.alias?'first_same_region_alias':'first_same_region_fuzzy'), selectedRank:index+1, requestedName:item.name, requestedCity:item.city || item.region, matchedRegion:candidates[index].region, nameMatch:matchedName===requested, candidates:candidates.slice(0,12)}
    : {status:'manual', policyVersion:DISCOVERY_POLICY_VERSION, reason:'没有同地域且名称可对应的搜索结果，请手填链接', candidates:candidates.slice(0,12)};
}
class Discovery {
  async open() {
    if (this.browser?.connected) return;
    const executablePath = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(p => p && fs.existsSync(p));
    if (!executablePath) throw Error('未找到Chrome或Edge，安装后重试');
    this.browser = await require('puppeteer-core').launch({ executablePath, headless: true, userDataDir: path.join(runtime, 'trip-search-profile'), timeout: 30000, protocolTimeout: 30000, args: ['--disable-background-networking', '--no-first-run'] });
    this.page = await this.browser.newPage();
    await this.page.setViewport({ width: 1280, height: 900 });
    await this.page.setRequestInterception(true);
    this.page.on('request', r => { (['image', 'media', 'font'].includes(r.resourceType()) ? r.abort() : r.continue()).catch(() => {}); });
  }
  async search(keyword) {
    const response = await this.page.goto('https://hk.trip.com/global-gssearch/searchlist/search/?keyword=' + encodeURIComponent(keyword), { waitUntil: 'domcontentloaded', timeout: 25000 });
    if (!response?.ok()) throw Error('Trip搜索HTTP ' + response?.status());
    await this.page.waitForFunction(() => /[0-9,]+個搜尋結果|沒有.*結果|暫無.*結果/.test(document.body.innerText), { timeout: 18000 });
    const candidates = await this.page.evaluate(() => Array.from(document.querySelectorAll('.gl-search-result_list-content')).map(el => {
      const a = el.querySelector('.gl-search-result_list-title a');
      return { name: a?.textContent?.trim(), url: a?.href, region: el.querySelector('.gl-search-result_list-position')?.textContent?.trim() || '' };
    }).filter(c => c.url && /\/travel-guide\/(attraction|shops)\//.test(c.url)));
    for (const c of candidates) c.url = tripUrl(c.url);
    return candidates;
  }
  async find(item) {
    const file = path.join(runtime, 'trip-discovery-cache.json');
    const cache = read(file, {}), key = JSON.stringify([item.name, item.city, item.province]);
    if (cache[key]?.status === 'matched' && cache[key].policyVersion === DISCOVERY_POLICY_VERSION) return { ...cache[key], cached: true };
    let last;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.open();
        let candidates = await this.search(item.name);
        let result = select(item, candidates);
        const queries = [item.name];
        const aliases = queryVariants(item).slice(1);
        for (const alias of aliases) {
          if (result.status === 'matched') break;
          queries.push(alias);
          candidates = [...candidates, ...await this.search(alias)];
          result = select(item, candidates, { names: queryVariants({...item, name: alias}), alias: true });
        }
        if (result.status === 'manual' && !result.reason.startsWith('存在多个') && item.city && candidates.some(c => norm(c.name) === norm(item.name))) {
          const query = item.city + ' ' + item.name;
          queries.push(query);
          candidates = [...candidates, ...await this.search(query)];
          result = select(item, candidates);
        }
        result = { ...result, queries, queryVariants: queryVariants(item), searchedAt: new Date().toISOString() };
        if (result.status === 'matched') { cache[key] = result; write(file, cache); }
        return result;
      } catch (e) { last = e; await this.close(); }
    }
    throw Error('Trip搜索不可用或页面未加载完成：' + last.message.slice(0, 140));
  }
  async close() { if (this.browser) await this.browser.close().catch(() => {}); this.browser = null; }
}
function draftView(value) {
  const retryPolicy = require('./gallery_retry_policy');
  const history = retryPolicy.history();
  const closed = new Set(history.filter(i=>i.trip?.noImageConfirmed).map(i=>i.id));
  const items=value.items.map(item=>{
    if(closed.has(item.id)&&!item.url) return {...item,autoSelection:null,noImageClosed:true,discoveryReason:'Trip确认无图库，仅占位图；已关闭补图，无需整理'};
    if(item.url || item.skip) return {...item, autoSelection:null};
    const selection=select(item,item.discoveryCandidates||[], { names: queryVariants(item) });
    const attempted=item.queueType!=='replacement'&&selection.status==='matched' ? retryPolicy.previousAttempt({...item,url:selection.url},history) : null;
    if(attempted) {
      const rejected=[...new Set((attempted.images||[]).filter(x=>!x.accepted).map(x=>x.reason).filter(Boolean))].join('、');
      const supplied=attempted.trip?.available;
      const detail=attempted.trip?.status==='collected'
        ? `该自动候选已采集${Number.isFinite(supplied)?`（来源提供${supplied}张）`:''}${rejected?`，未纳入原因：${rejected}`:''}；重复运行同一链接无效，请更换链接`
        : '该自动候选此前已处理；重复运行同一链接无效，请更换链接';
      return {...item,autoSelection:null,attemptedSelection:selection,discoveryReason:detail};
    }
    return {...item, autoSelection:selection.status==='matched'?selection:null,
      discoveryReason:item.queueReason || (selection.status==='matched'?'已自动选择同城市首项，启动自动采集即可，无需手填':item.discoveryReason)};
  });
  items.sort((a,b)=>Number(!!a.autoSelection)-Number(!!b.autoSelection));
  return {...value,items};
}
module.exports = { Discovery, select, queryVariants, draftView };
