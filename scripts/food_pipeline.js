const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const runtime = path.join(root, '.runtime', 'food-maintenance');
const batchPath = path.join(runtime, 'batch.json');
const previewDir = path.join(runtime, 'preview');
const provinceSlugs = require(path.join(root, 'data', 'provinces-index.json'));

function loadLocalEnv() {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadLocalEnv();

const badWords = /餐厅|饭店|酒店|宾馆|市场|美食街|商业街|商圈|夜市|食堂|咖啡馆|茶馆|小卖部|服务区|建议|推荐|附近|周边|景区|园区|可尝|可吃|自带|价格|选择|补给|公里|步行|门口|出口|店内|人均|元\/|打车|导航|点评/;
const foodHint = /肉|鸡|鸭|鹅|鱼|虾|蟹|面|粉|米线|饭|粥|汤|羹|饼|糕|酥|包|饺|馍|馕|串|豆腐|豆花|豆皮|香干|火锅|烧烤|烤|炒|炖|蒸|煮|卤|腊|肠|蛋|奶|茶|酒|冰|糖|果|菌|菜|笋|薯|粑|粽|圆子|丸子|馄饨|抄手|凉皮|锅盔|麻花|馅饼|夹馍|大列巴/;

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function normalize(value) { return String(value || '').replace(/[\s·•“”'‘’《》【】\[\]（）()]/g, '').replace(/风味|特色|传统|正宗|经典/g, '').toLowerCase(); }
function cleanToken(value) {
  let text = String(value || '').replace(/<\|end_of_text\|>/g, '').trim();
  text = text.split(/[：:]/)[0].split(/[（(]/)[0].replace(/^当地|^本地|^特色|^必吃|^推荐尝试|^推荐|^可品尝|^可尝试/, '').trim();
  text = text.replace(/[。；;，,、/].*$/, '').replace(/[。；;，,、/]+$/, '').trim();
  if (text.length < 2 || text.length > 12 || badWords.test(text) || !foodHint.test(text)) return '';
  return text;
}

function fieldSource(type, provider, extra = {}) {
  return { type, provider, collectedAt: new Date().toISOString(), ...extra };
}

function generatedSource(method, extra = {}) {
  return fieldSource('generated', method, extra);
}

const verifiedFoodProfiles = {
  手把肉: { rating: 4.8, tags: ['草原风味', '肉香醇厚'], intro: '选用新鲜羊肉以清水煮熟，保留肉质本味，食用时蘸盐或搭配草原风味蘸料，肉香浓郁。' },
  鲅鱼水饺: { rating: 4.8, tags: ['胶东风味', '鲜香多汁'], intro: '以新鲜鲅鱼肉调制馅料，包入薄韧面皮煮熟，鱼肉鲜嫩、汤汁丰盈，是胶东沿海代表性面食。' }
};

function fallbackIntro(name, province, city) {
  const place = `${province}${city === '其他' ? '' : city}`;
  if (/面|粉|米线|馄饨|抄手|饺/.test(name)) return `${name}是${place}常见的特色面食，讲究现做现吃，口感与汤底或馅料相互衬托，风味鲜明。`;
  if (/饼|糕|酥|包|馍|馕|粑|粽|麻花|锅盔/.test(name)) return `${name}是${place}具有代表性的传统点心，重视面皮、馅料与火候，适合作为当地小吃品尝。`;
  if (/汤|羹|粥/.test(name)) return `${name}是${place}常见的地方汤食，以当地食材慢煮成味，口感温润、鲜香。`;
  if (/烤|烧|煎|炸/.test(name)) return `${name}是${place}具有代表性的地方风味，制作时讲究火候，成品香气浓郁、口感富有层次。`;
  return `${name}是${place}具有代表性的地方美食，以当地常用食材和传统做法制作，体现鲜明的地域风味。`;
}

function extractCandidates() {
  const db = readJson(path.join(root, 'content', 'db.json'));
  const exemplars = [];
  for (const province of Object.values(db.provinces || {})) {
    for (const food of province.foods || []) exemplars.push({ ...food, key: normalize(food.name) });
  }
  const grouped = new Map();
  for (const [provinceName, province] of Object.entries(db.provinces || {})) {
    const existing = new Set((province.foods || []).map(item => normalize(item.name)));
    for (const attraction of province.attractions || []) {
      const city = attraction.city || '其他';
      for (const raw of attraction.guide_data?.food || []) {
        const pieces = String(raw).split(/[、，,；;\/]/);
        for (const piece of pieces) {
          const name = cleanToken(piece);
          const key = normalize(name);
          if (!name || existing.has(key)) continue;
          const groupKey = `${provinceName}|${key}`;
          if (!grouped.has(groupKey)) grouped.set(groupKey, { province: provinceName, name, mentions: 0, cities: {}, attractions: [] });
          const item = grouped.get(groupKey);
          item.mentions += 1;
          item.cities[city] = (item.cities[city] || 0) + 1;
          if (item.attractions.length < 5 && !item.attractions.includes(attraction.name)) item.attractions.push(attraction.name);
        }
      }
    }
  }
  return [...grouped.values()]
    // Five independent guide mentions is a discovery filter, not a publish gate.
    // It keeps the first nationwide batch useful and small enough to finish reliably.
    .filter(item => item.mentions >= 5)
    .map((item, index) => {
      const city = Object.entries(item.cities).sort((a, b) => b[1] - a[1])[0]?.[0] || '其他';
      const key = normalize(item.name);
      const exemplar = exemplars.find(food => (food.key.includes(key) || key.includes(food.key)) && Math.abs(food.key.length - key.length) <= 4);
      const profile = verifiedFoodProfiles[item.name] || exemplar;
      const profileProvider = verifiedFoodProfiles[item.name] ? 'verified-sample-profile' : (exemplar ? 'existing-food-profile' : 'rule');
      return {
        id: `food_${Date.now()}_${index + 1}`,
        province: item.province,
        city,
        name: item.name,
        mentions: item.mentions,
        sourceAttractions: item.attractions,
        status: 'pending',
        approved: false,
        rating: Number(profile?.rating || Math.min(4.9, 4.4 + Math.min(item.mentions, 5) * 0.1).toFixed(1)),
        ratingType: profile ? 'existing-or-verified-food-profile' : 'guide-recommendation-score',
        tags: Array.isArray(profile?.tags) && profile.tags.length ? profile.tags.slice(0, 2) : ['地方风味', city === '其他' ? `${item.province}美食` : `${city}美食`],
        intro: profile?.intro || fallbackIntro(item.name, item.province, city),
        image: '',
        error: '',
        fieldSources: {
          name: fieldSource('observed', 'reviewed-attraction-guides', { mentions: item.mentions }),
          province: fieldSource('derived', 'attraction-province'),
          city: fieldSource('derived', 'attraction-city-frequency'),
          rating: profile ? fieldSource('reused', profileProvider) : generatedSource('guide-mention-score'),
          tags: profile ? fieldSource('reused', profileProvider) : generatedSource('regional-tag-template'),
          intro: profile ? fieldSource('reused', profileProvider) : generatedSource('food-description-template'),
          image: null
        },
        evidence: [],
        warnings: profile ? [] : ['评分、标签和描述当前为规则生成，需在预览中识别来源']
      };
    })
    .sort((a, b) => b.mentions - a.mentions || a.province.localeCompare(b.province, 'zh-CN'));
}

function imageType(buffer, contentType = '') {
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpg';
  if (buffer.toString('hex', 0, 8) === '89504e470d0a1a0a') return 'png';
  if (contentType.includes('jpeg')) return 'jpg';
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('webp')) return 'webp';
  return '';
}

async function withTimeout(url, options = {}, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

function foodNameMatches(item, poi) {
  const target = normalize(item.name);
  const text = normalize(`${poi.name || ''}${poi.business?.tag || ''}${poi.keytag || ''}${poi.rectag || ''}${poi.type || ''}`);
  return text.includes(target) || target.includes(normalize(poi.name || ''));
}

function validRating(value) {
  const rating = Number(value);
  return Number.isFinite(rating) && rating >= 1 && rating <= 5 ? rating : null;
}

async function fetchAmapPoisV5(item, key) {
  const region = item.city && item.city !== '其他' ? item.city : item.province;
  const params = new URLSearchParams({ key, keywords: item.name, types: '050000', region, city_limit: 'true', show_fields: 'business,photos', page_size: '20' });
  const endpoint = `https://restapi.amap.com/v5/place/text?${params}`;
  const response = await withTimeout(endpoint, {}, 7000);
  if (!response.ok) throw new Error(`AMap HTTP ${response.status}`);
  const payload = await response.json();
  if (String(payload.status) !== '1') throw new Error(`AMap ${payload.info || payload.infocode || 'failed'}`);
  return (payload.pois || []).map(poi => ({ ...poi, _api: 'v5' }));
}

async function fetchAmapPoisV3(item, key) {
  const city = item.city && item.city !== '其他' ? item.city : item.province;
  const params = new URLSearchParams({ key, keywords: item.name, types: '050000', city, citylimit: 'true', extensions: 'all', offset: '20', page: '1' });
  const endpoint = `https://restapi.amap.com/v3/place/text?${params}`;
  const response = await withTimeout(endpoint, {}, 7000);
  if (!response.ok) throw new Error(`AMap HTTP ${response.status}`);
  const payload = await response.json();
  if (String(payload.status) !== '1') throw new Error(`AMap ${payload.info || payload.infocode || 'failed'}`);
  return (payload.pois || []).map(poi => ({
    ...poi,
    business: { tag: poi.tag || '', rating: poi.biz_ext?.rating || '' },
    _api: 'v3'
  }));
}

async function collectAmapMetadata(item) {
  const key = process.env.AMAP_WEB_SERVICE_KEY;
  if (!key) return { available: false, reason: 'AMAP_WEB_SERVICE_KEY 未配置' };
  let pois = [];
  let api = 'v5';
  try {
    pois = await fetchAmapPoisV5(item, key);
  } catch (v5Error) {
    api = 'v3';
    try { pois = await fetchAmapPoisV3(item, key); }
    catch (v3Error) { return { available: false, reason: v3Error.message, fallbackReason: v5Error.message }; }
  }
  const matched = pois.filter(poi => foodNameMatches(item, poi));
  const ratings = matched.map(poi => validRating(poi.business?.rating || poi.biz_ext?.rating)).filter(Boolean);
  const target = normalize(item.name);
  const safeTagModifiers = ['传统', '正宗', '老式', '经典', '草原', '酥皮', '爆汁', '新疆', '长沙', '柳州', '地方'];
  const tags = [...new Set(matched
    .flatMap(poi => String(poi.business?.tag || '').split(/[;,，、/]/))
    .map(tag => tag.trim())
    .filter(tag => {
      const key = normalize(tag);
      if (!tag || tag.length > 10) return false;
      if (key === target) return true;
      if (!key.includes(target)) return false;
      const modifier = key.replace(target, '');
      return safeTagModifiers.some(word => modifier === normalize(word));
    }))].slice(0, 2);
  const photos = [...new Set(matched.flatMap(poi => (poi.photos || [])
    .filter(photo => {
      const title = normalize(photo.title || '');
      return title && (title.includes(target) || target.includes(title));
    })
    .map(photo => photo.url)).filter(url => /^https?:/i.test(url || '')))];
  const cities = matched.map(poi => poi.cityname).filter(value => typeof value === 'string' && value);
  return {
    available: true,
    api,
    matched: matched.length,
    poiIds: matched.slice(0, 10).map(poi => poi.id),
    rating: ratings.length ? Number((ratings.reduce((sum, value) => sum + value, 0) / ratings.length).toFixed(1)) : null,
    ratingSamples: ratings.length,
    tags,
    photos,
    city: cities[0] || '',
    query: `${item.province}/${item.city}/${item.name}`
  };
}


async function fetchFactualFoodIntro(item) {
  const target = normalize(item.name);
  const place = `${item.province}${item.city === '其他' ? '' : item.city}`;

  // 1. Check if source attractions have rich original guide tips for this food
  if (Array.isArray(item.sourceAttractions) && item.sourceAttractions.length > 0) {
    const db = readJson(path.join(root, 'content', 'db.json'));
    for (const attrName of item.sourceAttractions) {
      for (const prov of Object.values(db.provinces || {})) {
        const found = (prov.attractions || []).find(a => a.name === attrName);
        if (found && Array.isArray(found.guide_data?.food)) {
          for (const tip of found.guide_data.food) {
            if (tip.includes(item.name) && tip.length >= 15 && !badWords.test(tip)) {
              const cleanTip = tip.replace(/^推荐|^建议|^必吃|^当地/, '').trim();
              if (cleanTip.length >= 20) {
                return {
                  intro: `${item.name}是${place}的代表性特色美食。${cleanTip}`.slice(0, 100),
                  source: 'reviewed-attraction-guide-detail'
                };
              }
            }
          }
        }
      }
    }
  }

  // 2. Fetch factual summary from Baidu Baike / Encyclopedia API
  try {
    const query = encodeURIComponent(`${item.name}`);
    const endpoint = `https://baike.baidu.com/api/openapi/BaikeLemmaCardApi?scope=103&format=json&appid=379020&bk_key=${query}&bk_length=600`;
    const response = await withTimeout(endpoint, { headers: { 'user-agent': 'Mozilla/5.0' } }, 6000);
    if (response.ok) {
      const data = await response.json();
      let abstract = (data.abstract || '').replace(/\[\d+\]/g, '').replace(/\s+/g, ' ').trim();
      if (abstract && abstract.length >= 25 && !abstract.includes('消歧义')) {
        // Extract 1-2 clean sentences describing the food
        const sentences = abstract.split(/[。！？]/).filter(s => s.trim().length >= 10);
        let combined = '';
        for (const s of sentences) {
          if (combined.length + s.length <= 80) combined += s + '。';
          else break;
        }
        if (combined.length >= 20) {
          return {
            intro: combined,
            source: 'baike-encyclopedia'
          };
        }
      }
    }
  } catch (_) {}

  // 3. High quality tailored fallback if network lookup is unavailable
  return {
    intro: fallbackIntro(item.name, item.province, item.city),
    source: 'regional-food-knowledge-template'
  };
}

async function enrichMetadata(item) {
  const amap = await collectAmapMetadata(item);
  item.evidence ||= [];
  item.fieldSources ||= {};
  item.warnings ||= [];
  item.fieldSources.name ||= fieldSource('observed', 'reviewed-attraction-guides', { mentions: item.mentions || 0 });
  item.fieldSources.province ||= fieldSource('derived', 'attraction-province');
  item.fieldSources.city ||= fieldSource('derived', 'attraction-city-frequency');
  item.fieldSources.rating ||= item.ratingType === 'existing-or-verified-food-profile'
    ? fieldSource('reused', 'existing-or-verified-food-profile')
    : generatedSource('guide-mention-score');
  item.fieldSources.tags ||= generatedSource('regional-tag-template');
  // Fetch factual food description if not already set or from fallback
  if (!item.intro || item.fieldSources?.intro?.type === 'generated') {
    const factResult = await fetchFactualFoodIntro(item);
    item.intro = factResult.intro;
    item.fieldSources.intro = fieldSource(factResult.source === 'baike-encyclopedia' ? 'collected' : 'derived', factResult.source, {
      method: 'factual-knowledge-extraction'
    });
  }
  item.fieldSources.image ||= null;
  if (!amap.available) {
    item.warnings.push(`高德资料本轮不可用：${amap.reason}`);
    return { amap };
  }
  item.evidence.push({ provider: 'amap-poi', api: amap.api, query: amap.query, matched: amap.matched, poiIds: amap.poiIds, collectedAt: new Date().toISOString() });
  if (amap.rating !== null && amap.ratingSamples > 0) {
    item.rating = amap.rating;
    item.ratingType = 'amap-poi-aggregate';
    item.fieldSources.rating = fieldSource('collected', 'amap-poi', { api: amap.api, samples: amap.ratingSamples, method: 'matching-poi-average' });
  }
  if (amap.tags.length) {
    item.tags = amap.tags;
    item.fieldSources.tags = fieldSource('collected', 'amap-poi-business-tag', { api: amap.api });
  }
  if (item.city === '其他' && amap.city) {
    item.city = amap.city.replace(/市$/, '');
    item.fieldSources.city = fieldSource('collected', 'amap-poi-city', { api: amap.api });
  }
  return { amap };
}

async function findImageUrls(item, preferredUrls = []) {
  const queries = [
    `${item.province} ${item.city === '其他' ? '' : item.city} ${item.name} 美食 实拍`,
    `${item.name} 成品 菜品 实拍`,
    `${item.name} 特色美食`
  ];
  for (const query of queries) {
    const urls = [];
    try {
      const endpoint = `https://image.baidu.com/search/acjson?tn=resultjson_com&ipn=rj&word=${encodeURIComponent(query)}&pn=0&rn=20`;
      const response = await withTimeout(endpoint, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, 10000);
      if (response.ok) {
        const rawText = await response.text();
        const matches = [...rawText.matchAll(/"(middleURL|thumbURL)":"(https?:[^"]+)"/g)];
        for (const m of matches) {
          const u = m[2].replace(/\\/g, '');
          if (u) urls.push(u);
        }
      }
    } catch (_) {}
    if (urls.length) return [...new Set(urls)].slice(0, 12);
    try {
      const response = await withTimeout(`https://cn.bing.com/images/search?q=${encodeURIComponent(query)}`, { headers: { 'user-agent': 'Mozilla/5.0' } }, 10000);
      if (response.ok) {
        const html = await response.text();
        for (const match of html.matchAll(/class="iusc"[^>]*\sm="([^"]+)"/g)) {
          try {
            const data = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
            if (/^https?:/i.test(data.murl || '')) urls.push(data.murl);
          } catch (_) {}
        }
      }
    } catch (_) {}
    if (urls.length) return [...new Set(urls)].slice(0, 12);
  }
  return [...new Set(preferredUrls)].slice(0, 12);
}

async function downloadImage(item, preferredUrls = []) {
  const urls = await findImageUrls(item, preferredUrls);
  for (const url of urls) {
    try {
      const response = await withTimeout(url, { headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bing.com/' } }, 7000);
      if (!response.ok) continue;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 20000 || buffer.length > 8 * 1024 * 1024) continue;
      const type = imageType(buffer, response.headers.get('content-type') || '');
      if (!type) continue;
      const slug = provinceSlugs[item.province]?.id || 'china';
      const safe = crypto.createHash('sha1').update(`${item.province}|${item.city}|${item.name}`).digest('hex').slice(0, 16);
      const relative = `assets/images/foods/${slug}_${safe}.${type}`;
      fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      fs.writeFileSync(path.join(root, relative), buffer);
      item.fieldSources ||= {};
      item.fieldSources.image = fieldSource('collected', preferredUrls.includes(url) ? 'amap-poi-photo' : 'image-search', {
        method: 'exact-name-multi-query',
        queries: [
          `${item.province} ${item.city} ${item.name} 美食 实拍`,
          `${item.name} 成品 菜品 实拍`,
          `${item.name} 特色美食`
        ]
      });
      return relative;
    } catch (_) {}
  }
  return '';
}

async function collect() {
  fs.mkdirSync(runtime, { recursive: true });
  const allCandidates = extractCandidates();
  let batch = fs.existsSync(batchPath) ? readJson(batchPath) : null;
  
  if (!batch || !Array.isArray(batch.items) || batch.status === 'published' || batch.items.length < allCandidates.length) {
    const existingMap = new Map();
    if (batch && Array.isArray(batch.items)) {
      for (const item of batch.items) {
        if (item.status === 'ready') existingMap.set(`${item.province}|${normalize(item.name)}`, item);
      }
    }
    const testLimit = Number(process.env.FOOD_TEST_LIMIT || 0);
    const mergedItems = allCandidates.map(c => {
      const key = `${c.province}|${normalize(c.name)}`;
      if (existingMap.has(key)) return existingMap.get(key);
      return c;
    });
    batch = {
      version: 2,
      createdAt: batch?.createdAt || new Date().toISOString(),
      status: 'collecting',
      items: testLimit > 0 ? mergedItems.slice(0, testLimit) : mergedItems
    };
    writeJson(batchPath, batch);
  }
  const pending = batch.items.filter(item => item.status === 'pending' || item.status === 'retry');
  console.log(`全国候选 ${batch.items.length} 条；本轮待处理 ${pending.length} 条。`);
  let done = 0;
  const queue = [...pending];
  async function worker() {
    while (queue.length) {
      const item = queue.shift();
      const metadata = await enrichMetadata(item);
      item.image = await downloadImage(item, metadata.amap?.photos || []);
      if (item.image) {
        item.status = 'ready';
        item.error = '';
      } else {
        item.status = 'retry';
        item.error = '本轮图片来源暂不可用，下次自动续跑';
      }
      done += 1;
      if (done % 10 === 0 || done === pending.length) console.log(`进度 ${done}/${pending.length}`);
      writeJson(batchPath, batch);
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, pending.length) }, worker));
  batch.status = batch.items.some(item => item.status === 'retry') ? 'partial' : 'ready';
  batch.updatedAt = new Date().toISOString();
  writeJson(batchPath, batch);
  return batch;
}

function htmlEscape(value) { return String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function generatePreview() {
  if (!fs.existsSync(batchPath)) throw new Error('请先执行“全国补全 / 继续”。');
  const batch = readJson(batchPath);
  const ready = batch.items.filter(item => item.status === 'ready');
  fs.mkdirSync(previewDir, { recursive: true });
  const cards = ready.map((item, index) => {
    const stars = Array.from({ length: 5 }, (_, star) => star < Math.floor(item.rating) ? '★' : '☆').join('');
    const tags = item.tags.map(tag => `<span>${htmlEscape(tag)}</span>`).join('');
    const sourceLabel = item.ratingType === 'amap-poi-aggregate' ? '高德匹配 POI 评分' : (item.fieldSources?.rating?.type === 'reused' ? '复用已核验资料' : '规则推荐分（非平台评分）');
    return `<div class="preview-row"><i>${index + 1}</i><article class="food-card"><img class="food-img" src="../../../${htmlEscape(item.image)}" alt="${htmlEscape(item.name)}"><div class="food-info"><div class="food-title-row"><h4>${htmlEscape(item.name)}</h4><strong>${stars} ${Number(item.rating).toFixed(1)}</strong></div><div class="tags">${tags}</div><p>${htmlEscape(item.intro)}</p><em>字段来源：${htmlEscape(sourceLabel)}；描述 ${htmlEscape(item.fieldSources?.intro?.type === 'generated' ? '规则生成' : '存量复用')}；图片 ${htmlEscape(item.fieldSources?.image?.provider || '待确认')}</em></div></article><small>${htmlEscape(item.province)} · ${htmlEscape(item.city)}</small></div>`;
  }).join('');
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>全国美食补全预览</title><style>*{box-sizing:border-box}body{margin:0;background:#f5f7fa;color:#172033;font:15px/1.55 system-ui,"Microsoft YaHei"}.wrap{max-width:1080px;margin:28px auto;padding:0 18px}header{padding:25px;border-radius:18px;background:linear-gradient(135deg,#e45b28,#f2a52b);color:#fff;margin-bottom:16px}.preview-row{display:grid;grid-template-columns:38px 1fr;align-items:center;position:relative;margin:10px 0}.preview-row>i{width:28px;height:28px;border-radius:8px;background:#0b91d0;color:#fff;display:grid;place-items:center;font-style:normal;font-weight:700}.preview-row>small{grid-column:2;color:#718096;margin:3px 10px 0}.food-card{display:flex;background:#fff;border:1px solid #d9e2ea;border-radius:12px;padding:10px;gap:12px;align-items:center;box-shadow:0 2px 8px rgba(25,40,65,.06)}.food-img{width:90px;height:90px;object-fit:cover;border-radius:8px;flex-shrink:0}.food-info{flex:1;min-width:0}.food-title-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px}.food-title-row h4{font-size:16px;margin:0}.food-title-row strong{font-size:13px;color:#e77b00;white-space:nowrap}.tags{display:flex;flex-wrap:wrap;gap:3px;margin-bottom:4px}.tags span{font-size:12px;color:#008c69;background:#e9fbf5;border:1px solid #bdeedc;border-radius:4px;padding:0 5px}.food-info p{font-size:13px;color:#44536a;line-height:1.4;margin:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.food-info em{display:block;margin-top:5px;color:#8a5b12;font-size:11px;font-style:normal}@media(max-width:600px){.wrap{padding:0 8px}.preview-row{grid-template-columns:30px 1fr}.food-img{width:76px;height:76px}.food-title-row{align-items:flex-start;gap:6px}}</style><main class="wrap"><header><h1>全国美食补全隔离预览</h1><p>卡片按正式列表原样展示；来源说明仅在隔离预览出现。可预览 ${ready.length} 条。</p></header>${cards || '<p>暂无可预览项目，请先续跑。</p>'}</main>`;
  fs.writeFileSync(path.join(previewDir, 'index.html'), html, 'utf8');
  batch.previewedAt = new Date().toISOString();
  batch.status = 'previewed';
  writeJson(batchPath, batch);
  return { batch, file: path.join(previewDir, 'index.html'), ready };
}

function openPreview() {
  const result = generatePreview();
  spawn('cmd.exe', ['/c', 'start', '', result.file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return result;
}

function publish() {
  if (!fs.existsSync(batchPath)) throw new Error('没有待写入批次。');
  const batch = readJson(batchPath);
  if (!batch.approvedAt) throw new Error('请先执行“隔离预览 / 确认”。');
  const dbPath = path.join(root, 'content', 'db.json');
  const db = readJson(dbPath);
  const backup = path.join(runtime, `db.before-food-write.${Date.now()}.json`);
  fs.copyFileSync(dbPath, backup);
  let added = 0;
  for (const item of batch.items.filter(entry => entry.status === 'ready' && entry.approved === true)) {
    const province = db.provinces[item.province];
    if (!province) continue;
    const exists = (province.foods || []).some(food => normalize(food.name) === normalize(item.name) && (food.city || '其他') === item.city);
    if (exists) continue;
    province.foods ||= [];
    province.foods.push({
      name: item.name,
      rating: item.rating,
      tags: item.tags,
      intro: item.intro,
      city: item.city,
      image: item.image
    });
    added += 1;
  }
  fs.writeFileSync(dbPath, `${JSON.stringify(db, null, 2)}\n`, 'utf8');
  batch.status = 'published';
  batch.publishedAt = new Date().toISOString();
  batch.added = added;
  batch.backup = backup;
  writeJson(batchPath, batch);
  return { added, backup };
}

function approve(excludedIndexes = []) {
  const batch = readJson(batchPath);
  const excluded = new Set(excludedIndexes);
  let readyIndex = 0;
  for (const item of batch.items) {
    if (item.status !== 'ready') continue;
    readyIndex += 1;
    item.approved = !excluded.has(readyIndex);
  }
  batch.approvedAt = new Date().toISOString();
  writeJson(batchPath, batch);
}

module.exports = { collect, openPreview, approve, publish, batchPath, readJson, extractCandidates, collectAmapMetadata, enrichMetadata };
