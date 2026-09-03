const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { bufferDimensions, imageIdentityTokens, parseBaiduImageResults, parseBingImageResults, usableImageQuality } = require('./collect_core_details');

const root = path.resolve(__dirname, '..');
const provinceDir = path.join(root, 'data', 'provinces');
const runtimeDir = path.join(root, '.runtime', 'attraction-gallery-pilot');
const manifestPath = path.join(runtimeDir, 'manifest.json');

const pilotIds = [
  'amap_B0345001JL', // 九寨沟
  'amap_B022F0ML6Z', // 黄山风景区
  'amap_B023B13L9M', // 杭州西湖风景名胜区
  'amap_B02E800EFM', // 张家界国家森林公园
  'amap_B016200MKK', // 平遥古城
  'amap_B0378008PR', // 丽江古城
  'amap_B0FFFAPGR4', // 乌镇风景区
  'amap_B02E700F2Q', // 凤凰古城
  'amap_B000A8UIN8', // 故宫博物院
  'amap_B001809F61', // 沈阳故宫博物院
  'amap_B001D06AOS', // 西安博物院
  'amap_B001D09OYW', // 秦始皇帝陵博物院
  'amap_B00157AW8O', // 上海迪士尼度假区
  'amap_B0FFFYPEE9', // 广州长隆旅游度假区
  'amap_B02500SJWD', // 厦门方特梦幻王国
  'amap_B02140A3J6', // 青岛方特梦幻王国
  'amap_B00140WBI1', // 广州塔
  'amap_B00150F6D6', // 东方明珠广播电视塔
  'amap_B001D09TAA', // 西安钟楼
  'amap_B0FFFEXRIQ', // 海口钟楼
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function loadEnv() {
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].trim().replace(/^(?:"(.*)"|'(.*)')$/, '$1$2');
  }
}

function allAttractions() {
  const result = new Map();
  for (const file of fs.readdirSync(provinceDir).filter(name => name.endsWith('.json'))) {
    const province = readJson(path.join(provinceDir, file));
    for (const attraction of province.attractions || []) {
      if (attraction.id) result.set(attraction.id, { province: province.province, slug: path.basename(file, '.json'), attraction });
    }
  }
  return result;
}

function normalizeUrl(value) {
  let url = String(value || '').trim();
  if (/^http:\/\/(?:store\.is\.autonavi\.com|aos-cdn-image\.amap\.com|aos-comment\.amap\.com)/i.test(url)) {
    url = url.replace(/^http:/i, 'https:');
  }
  if (!/^https?:\/\//i.test(url) && !url.startsWith('/')) return '';
  if (/store\.is\.autonavi\.com\/showpic\//i.test(url)) {
    if (/([?&])type=/.test(url)) return url.replace(/([?&])type=[^&]*/i, '$1type=7');
    return `${url}${url.includes('?') ? '&' : '?'}type=7`;
  }
  return url;
}

function uniqueImages(items) {
  const seen = new Set();
  return items.filter(item => {
    item.url = normalizeUrl(item.url);
    if (!item.url || seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

function windowsProxy() {
  if (process.env.MAINTENANCE_HTTPS_PROXY) return process.env.MAINTENANCE_HTTPS_PROXY;
  if (process.platform !== 'win32') return '';
  const result = spawnSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyServer'], {
    encoding: 'utf8', windowsHide: true,
  });
  const match = String(result.stdout || '').match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i);
  if (!match) return '';
  const value = match[1].trim();
  const mapped = Object.fromEntries(value.split(';').map(part => part.split('=', 2)).filter(pair => pair.length === 2));
  const endpoint = mapped.https || mapped.http || value;
  return /^https?:\/\//i.test(endpoint) ? endpoint : `http://${endpoint}`;
}

function curl(url, { json = false, text = false } = {}) {
  const args = [
    '--location', '--fail', '--silent', '--show-error', '--ssl-no-revoke',
    '--connect-timeout', '4', '--max-time', '12', '--retry', '0',
    '--user-agent', 'Mozilla/5.0 ChinaTourismMapGallery/1.0',
  ];
  if (json) args.push('--compressed', '--header', 'Accept: application/json,text/plain,*/*', '--referer', 'https://image.baidu.com/');
  const proxy = windowsProxy();
  if (proxy) args.push('--proxy', proxy);
  args.push(url);
  const result = spawnSync(process.platform === 'win32' ? 'curl.exe' : 'curl', args, {
    encoding: json || text ? 'utf8' : null,
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0 || !result.stdout) throw new Error(String(result.stderr || `curl exit ${result.status}`).trim());
  return json ? JSON.parse(result.stdout) : result.stdout;
}

function fallbackImageCandidates(attraction) {
  const query = `${attraction.name} ${attraction.city || ''} 景区 实景`;
  const tokens = imageIdentityTokens({ name: attraction.name, city: attraction.city || '' });
  const noise = /地图|卫星|导览|路线|攻略|海报|门票|二维码|logo|标志|示意图|平面图|效果图|壁纸|素材|网页|截图|地铁|列车|车厢|轨道交通|\bmap\b|satellite|screenshot|website|\bmetro\b|\bsubway\b|\btrain\b|line\s*\d+/i;
  // 商业素材站的搜索预览通常自带大面积水印，不能进入最终图库。
  const watermarkedSource = /699pic|摄图网|nipic|昵图网|vcg\.com|视觉中国|quanjing|全景视觉|shutterstock|gettyimages/i;
  const rawCandidates = [];
  try {
    const baiduUrl = `https://image.baidu.com/search/acjson?tn=resultjson_com&ipn=rj&ct=201326592&fp=result&word=${encodeURIComponent(query)}&pn=0&rn=30`;
    rawCandidates.push(...parseBaiduImageResults(curl(baiduUrl, { json: true })));
  } catch {
    // 空结果或访问失败时由备用来源继续，不阻断批次。
  }
  if (rawCandidates.length < 8) {
    try {
      const bingUrl = `https://cn.bing.com/images/search?q=${encodeURIComponent(query)}&setlang=zh-hans&cc=cn`;
      rawCandidates.push(...parseBingImageResults(curl(bingUrl, { text: true })));
    } catch {
      // 百度候选不足且备用搜索失败时，由后续百科源继续，不阻断。
    }
  }
  try {
    const entityName = normalizeIdentity(attraction.name);
    return rawCandidates
      .filter(item => !noise.test(`${item.title} ${item.sourceUrl}`))
      .filter(item => !watermarkedSource.test(`${item.title} ${item.imageUrl} ${item.sourceUrl}`))
      // 搜索结果只能在标题明确对应完整景点实体时自动进入候选；仅命中城市、
      // 品牌或一个弱关键词不再自动通过，宁可留下缺口给确定来源补齐。
      .filter(item => {
        const titleName = normalizeIdentity(item.title || '');
        return entityName.length >= 3 && titleName.length >= 3
          && (titleName.includes(entityName) || entityName.includes(titleName));
      })
      .filter(item => !item.declaredWidth || (item.declaredWidth >= 800 && item.declaredHeight >= 450))
      .map(item => ({
        url: item.imageUrl,
        caption: item.title || attraction.name,
        source: 'public-search',
        sourceUrl: item.sourceUrl,
      }))
      .slice(0, 12);
  } catch {
    return [];
  }
}

function normalizeIdentity(value) {
  return String(value || '').toLowerCase().replace(/[\s·•（）()\-_]/g, '').replace(/风景名胜区|旅游度假区|旅游景区|风景区|景区|博物馆/g, '');
}

function commonsCandidatesFromPages(pages, attraction, trustedCategory = false) {
  const tokens = imageIdentityTokens({ name: attraction.name, city: attraction.city || '' });
  // Commons 分类中可能混有到达景区的地铁、地图、网页截图等关联资料。
  // 即使分类本身可信，这些也不是景点实景，必须先做全局语义排除。
  const mediaNoise = /地图|卫星|导览|路线|网页|截图|地铁|列车|车厢|站台|轨道交通|\bmap\b|satellite|sat[ _-]?view|screenshot|website|\bmetro\b|\bsubway\b|\btrain\b|train[ _-]?interior|line[ _-]?\d+|station|platform/i;
  return Object.values(pages || {}).flatMap(page => {
    const info = page.imageinfo?.[0];
    if (!info) return [];
    const meta = info.extmetadata || {};
    const identityText = `${page.title || ''} ${meta.ImageDescription?.value || ''} ${meta.Categories?.value || ''}`.toLowerCase();
    if (mediaNoise.test(identityText)) return [];
    // 分类成员也可能只是交通、周边设施或附属区域。分类归属不再等同于实体命中，
    // 必须由图片自身的标题/描述明确命中景点实体。
    const relevant = tokens.some(token => identityText.includes(token));
    const license = String(meta.LicenseShortName?.value || meta.UsageTerms?.value || '');
    if (!relevant || !/(?:CC\s*BY|CC0|public domain|公有领域)/i.test(license)) return [];
    if (Number(info.width || 0) < 800 || Number(info.height || 0) < 450) return [];
    const imageUrl = info.thumburl || info.url || '';
    if (!/^https?:\/\//i.test(imageUrl)) return [];
    return [{
      url: imageUrl,
      caption: String(page.title || '').replace(/^File:/i, '') || attraction.name,
      source: 'wikimedia',
      sourceUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(String(page.title || '').replace(/ /g, '_'))}`,
      imageSource: {
        provider: 'Wikimedia Commons',
        author: String(meta.Artist?.value || 'Wikimedia Commons').replace(/<[^>]+>/g, '').slice(0, 100),
        license,
        sourceUrl: `https://commons.wikimedia.org/wiki/${encodeURIComponent(String(page.title || '').replace(/ /g, '_'))}`,
      },
    }];
  });
}

function wikimediaImageCandidates(attraction) {
  try {
    const searchUrl = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(attraction.name)}&language=zh&uselang=zh&format=json&limit=5&origin=*`;
    const search = curl(searchUrl, { json: true });
    const targetName = normalizeIdentity(attraction.name);
    const hit = (search.search || []).find(item => {
      const labels = [item.label, item.match?.text, ...(item.aliases || [])].map(normalizeIdentity);
      return labels.some(label => label === targetName || (label.length >= 3 && (label.includes(targetName) || targetName.includes(label))));
    });
    if (hit) {
      const entityUrl = `https://www.wikidata.org/wiki/Special:EntityData/${hit.id}.json`;
      const entity = curl(entityUrl, { json: true }).entities?.[hit.id];
      const fileName = entity?.claims?.P18?.[0]?.mainsnak?.datavalue?.value || '';
      const category = entity?.claims?.P373?.[0]?.mainsnak?.datavalue?.value || '';
      const pages = {};
      if (fileName) {
        const fileUrl = `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(`File:${fileName}`)}&prop=imageinfo&iiprop=url%7Csize%7Cextmetadata&iiurlwidth=1600&format=json&origin=*`;
        Object.assign(pages, curl(fileUrl, { json: true }).query?.pages || {});
      }
      if (category) {
        const categoryUrl = `https://commons.wikimedia.org/w/api.php?action=query&generator=categorymembers&gcmtitle=${encodeURIComponent(`Category:${category}`)}&gcmtype=file&gcmlimit=30&prop=imageinfo&iiprop=url%7Csize%7Cextmetadata&iiurlwidth=1600&format=json&origin=*`;
        Object.assign(pages, curl(categoryUrl, { json: true }).query?.pages || {});
      }
      const matched = commonsCandidatesFromPages(pages, attraction, true);
      if (matched.length) return matched.slice(0, 12);
    }
  } catch {
    // Wikidata 或 Commons 暂时不可用时继续搜索源，不阻断批次。
  }
  try {
    const mediaUrl = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(attraction.name)}&gsrnamespace=6&gsrlimit=20&prop=imageinfo&iiprop=url%7Csize%7Cextmetadata&iiurlwidth=1600&format=json&origin=*`;
    return commonsCandidatesFromPages(curl(mediaUrl, { json: true }).query?.pages || {}, attraction, false).slice(0, 8);
  } catch {
    return [];
  }
}

function probeCandidate(candidate, itemId, index) {
  try {
    let buffer;
    if (candidate.url.startsWith('/')) buffer = fs.readFileSync(path.join(root, candidate.url.slice(1)));
    else buffer = curl(candidate.url);
    const dimensions = bufferDimensions(buffer);
    const ratio = dimensions ? dimensions.width / Math.max(1, dimensions.height) : 0;
    const ok = usableImageQuality(dimensions, buffer.length) && ratio >= 0.78 && ratio <= 2.8;
    if (!ok) return { ...candidate, quality: { ok: false, dimensions, bytes: buffer.length, ratio } };
    const localName = `${itemId.replace(/[^a-z0-9_-]/gi, '_')}_${String(index + 1).padStart(2, '0')}.img`;
    const localPath = path.join(runtimeDir, 'candidates', localName);
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, buffer);
    return {
      ...candidate,
      quality: { ok: true, dimensions, bytes: buffer.length, ratio },
      reviewFile: path.relative(root, localPath),
    };
  } catch (error) {
    return { ...candidate, quality: { ok: false, reason: error.message } };
  }
}

function rankGalleryCandidates(items) {
  const sourcePriority = { existing: 5, amap: 4, 'reviewed-subspot': 3, wikimedia: 2, 'public-search': 1 };
  return [...items].sort((left, right) => {
    const sourceGap = (sourcePriority[right.source] || 0) - (sourcePriority[left.source] || 0);
    if (sourceGap) return sourceGap;
    // 同一可靠来源存在多张图时，优先保留像素和有效文件体积更大的版本，
    // 不再机械采用 API 返回顺序。
    const leftPixels = (left.quality?.dimensions?.width || 0) * (left.quality?.dimensions?.height || 0);
    const rightPixels = (right.quality?.dimensions?.width || 0) * (right.quality?.dimensions?.height || 0);
    if (rightPixels !== leftPixels) return rightPixels - leftPixels;
    return (right.quality?.bytes || 0) - (left.quality?.bytes || 0);
  });
}

async function amapDetail(id, keys, exhausted) {
  const poiId = id.replace(/^amap_/i, '');
  for (let index = 0; index < keys.length; index += 1) {
    if (exhausted.has(index)) continue;
    const url = new URL('https://restapi.amap.com/v5/place/detail');
    url.searchParams.set('key', keys[index]);
    url.searchParams.set('id', poiId);
    url.searchParams.set('show_fields', 'photos');
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(12000) }).then(result => result.json());
      if (String(response.status) === '1') return response.pois?.[0] || null;
      if (/10044|DAILY_QUERY_OVER_LIMIT|USER_DAILY_QUERY_OVER_LIMIT/i.test(`${response.infocode} ${response.info}`)) {
        exhausted.add(index);
        continue;
      }
      return null;
    } catch {
      continue;
    }
  }
  return null;
}

async function main() {
  loadEnv();
  const keys = [...new Set([
    ...String(process.env.AMAP_WEB_SERVICE_KEYS || '').split(','),
    String(process.env.AMAP_WEB_SERVICE_KEY || ''),
  ].map(value => value.trim()).filter(Boolean))];
  if (!keys.length) throw new Error('未配置高德 Web 服务 Key。');

  const records = allAttractions();
  if (process.argv.includes('--repair-shortages')) {
    if (!fs.existsSync(manifestPath)) throw new Error('请先生成候选池。');
    const selectedPath = path.join(runtimeDir, 'selected.json');
    if (!fs.existsSync(selectedPath)) throw new Error('请先运行视觉筛选脚本。');
    const manifest = readJson(manifestPath);
    const selected = readJson(selectedPath);
    const shortages = manifest.items.filter(item => (selected[item.id] || []).length < 5);
    console.log(`仅补视觉筛选后不足 5 张的 ${shortages.length} 个景点。`);
    for (let index = 0; index < shortages.length; index += 1) {
      const item = shortages[index];
      const attraction = records.get(item.id)?.attraction;
      if (!attraction) continue;
      // 国内公共搜索通常一次即可覆盖景区官网与主流旅游站，先走这一层；
      // 只有仍不足 5 张时才调用请求次数更多的公开百科。
      let candidates = uniqueImages([...item.candidates, ...fallbackImageCandidates(attraction)]);
      candidates = candidates.slice(0, 24).map((candidate, candidateIndex) => candidate.quality
        ? candidate
        : probeCandidate(candidate, item.id, candidateIndex));
      let qualified = rankGalleryCandidates(candidates.filter(candidate => candidate.quality?.ok));
      if (qualified.length < 5) {
        candidates = uniqueImages([...candidates, ...wikimediaImageCandidates(attraction)])
          .slice(0, 30)
          .map((candidate, candidateIndex) => candidate.quality
            ? candidate
            : probeCandidate(candidate, item.id, candidateIndex));
        qualified = rankGalleryCandidates(candidates.filter(candidate => candidate.quality?.ok));
      }
      item.candidates = candidates;
      item.qualified = qualified.slice(0, 12);
      item.candidateCount = candidates.length;
      item.qualifiedCount = item.qualified.length;
      item.needsFallback = item.qualified.length < 5;
      console.log(`[${index + 1}/${shortages.length}] ${item.name}: 候选 ${item.qualified.length} 张`);
    }
    manifest.generatedAt = new Date().toISOString();
    manifest.rule = '每个已启用图库必须有5张合格图；视觉筛选后仅对缺口景点按需补源。';
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\r\n`, 'utf8');
    console.log('缺口定点补图完成。');
    return;
  }
  const exhausted = new Set();
  const items = [];
  fs.mkdirSync(runtimeDir, { recursive: true });

  for (let index = 0; index < pilotIds.length; index += 1) {
    const id = pilotIds[index];
    const record = records.get(id);
    if (!record) throw new Error(`未找到试点景点：${id}`);
    const attraction = record.attraction;
    const poi = await amapDetail(id, keys, exhausted);
    let candidates = uniqueImages([
      { url: attraction.image, caption: `${attraction.name}现有封面`, source: 'existing' },
      ...(poi?.photos || []).map(photo => ({ url: photo.url, caption: photo.title || attraction.name, source: 'amap', sourcePoiId: poi.id })),
      ...(attraction.sub_spots || []).map(subspot => ({ url: subspot.image, caption: subspot.name, source: 'reviewed-subspot', sourcePoiId: subspot.id || '' })),
    ]);
    candidates = candidates.slice(0, 16).map((candidate, candidateIndex) => probeCandidate(candidate, id, candidateIndex));
    let qualified = rankGalleryCandidates(candidates.filter(candidate => candidate.quality?.ok)).slice(0, 5);
    if (qualified.length < 5) {
      const combined = uniqueImages([
        ...candidates,
        ...fallbackImageCandidates(attraction),
      ]).slice(0, 16);
      candidates = combined.map((candidate, candidateIndex) => candidate.quality
        ? candidate
        : probeCandidate(candidate, id, candidateIndex));
      qualified = rankGalleryCandidates(candidates.filter(candidate => candidate.quality?.ok)).slice(0, 5);
    }
    if (qualified.length < 5) {
      const combined = uniqueImages([
        ...candidates,
        ...wikimediaImageCandidates(attraction),
      ]).slice(0, 16);
      candidates = combined.map((candidate, candidateIndex) => candidate.quality
        ? candidate
        : probeCandidate(candidate, id, candidateIndex));
      qualified = rankGalleryCandidates(candidates.filter(candidate => candidate.quality?.ok)).slice(0, 5);
    }
    items.push({
      id,
      name: attraction.name,
      province: record.province,
      city: attraction.city || '',
      category: attraction.category || '',
      candidates,
      qualified,
      candidateCount: candidates.length,
      qualifiedCount: qualified.length,
      needsFallback: qualified.length < 5,
    });
    console.log(`[${index + 1}/${pilotIds.length}] ${attraction.name}: ${qualified.length} 张通过基础检查${qualified.length < 5 ? '，仍需补充来源' : ''}`);
  }

  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    rule: '目标3-5张合格图，不以低质量图片凑数；当前文件仅为候选池，不直接写入内容。',
    keySlotsUsed: keys.length,
    exhaustedKeySlots: [...exhausted].map(index => index + 1),
    items,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\r\n`, 'utf8');
  console.log(`候选池已生成：${path.relative(root, manifestPath)}`);
}

main().catch(error => {
  console.error(`图库试点候选采集失败：${error.message}`);
  process.exitCode = 1;
});
