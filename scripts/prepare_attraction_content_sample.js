const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const runtimeDir = path.join(root, '.runtime', 'attraction-content-sample');
const manifestPath = path.join(runtimeDir, 'manifest.json');
const provincesDir = path.join(root, 'data', 'provinces');

const targets = [
  { id: 'amap_B02340T5OU', issues: ['basic'] },
  { id: 'amap_B000A87KTH', issues: ['basic'] },
  { id: 'amap_B0253016EC', issues: ['basic'] },
  { id: 'amap_B025200C2E', issues: ['basic', 'lazy'] },
  { id: 'amap_B00140UDHU', issues: ['basic', 'lazy'] },
  { id: 'amap_B0L1GZAXVP', issues: ['basic'] },
  { id: 'amap_B0FFFDZATL', issues: ['travel', 'lazy'] },
  { id: 'amap_B000A208D5', issues: ['travel'] },
  { id: 'amap_B0354003CR', issues: ['travel', 'lazy'] },
  { id: 'amap_B01C304057', issues: ['lazy'] },
];

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
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
  return fs.readdirSync(provincesDir).filter(name => name.endsWith('.json')).flatMap(file => {
    const data = readJson(path.join(provincesDir, file), {});
    return (data.attractions || []).map(attraction => ({ province: data.province, slug: path.basename(file, '.json'), attraction }));
  });
}

function compact(value) {
  if (Array.isArray(value)) return value.map(compact).filter(Boolean).join('；');
  if (value && typeof value === 'object') return '';
  return String(value || '').replace(/\s+/g, ' ').trim();
}

async function amapDetail(id, key) {
  if (!key || !/^amap_([A-Z0-9]+)$/i.test(id)) return { status: 'unavailable', reason: '未配置高德 Web 服务 Key' };
  const poiId = id.replace(/^amap_/i, '');
  const url = new URL('https://restapi.amap.com/v5/place/detail');
  url.searchParams.set('key', key);
  url.searchParams.set('id', poiId);
  url.searchParams.set('show_fields', 'business,photos,navi');
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) }).then(result => result.json());
  if (String(response.status) !== '1' || !response.pois?.[0]) {
    return { status: 'failed', reason: `${response.info || '高德无结果'} (${response.infocode || '-'})` };
  }
  const poi = response.pois[0];
  return {
    status: 'ready',
    poiId: compact(poi.id),
    name: compact(poi.name),
    province: compact(poi.pname),
    city: compact(poi.cityname),
    district: compact(poi.adname),
    address: compact(poi.address),
    tel: compact(poi.business?.tel || poi.tel),
    openHours: compact(poi.business?.opentime_week || poi.business?.opentime_today),
    rating: compact(poi.business?.rating),
    type: compact(poi.type),
    location: compact(poi.location),
    entrance: compact(poi.navi?.entr_location),
    photos: (poi.photos || []).slice(0, 4).map(photo => ({ title: compact(photo.title), url: compact(photo.url) })).filter(photo => photo.url),
    sourceUrl: `https://www.amap.com/place/${encodeURIComponent(poiId)}`,
  };
}

const exhaustedKeySlots = new Set();
async function amapDetailWithPool(id, keys) {
  let last = { status: 'unavailable', reason: '未配置高德 Web 服务 Key' };
  for (let index = 0; index < keys.length; index += 1) {
    if (exhaustedKeySlots.has(index)) continue;
    const result = await amapDetail(id, keys[index]);
    last = { ...result, keySlot: index + 1 };
    if (result.status === 'ready') return last;
    if (/DAILY_QUERY_OVER_LIMIT|USER_DAILY_QUERY_OVER_LIMIT|10044/i.test(result.reason || '')) {
      exhaustedKeySlots.add(index);
      continue;
    }
    return last;
  }
  if (keys.length && exhaustedKeySlots.size === keys.length) {
    return { status: 'quota_exhausted', reason: '所有配置的高德 Key 今日额度均已达到上限' };
  }
  return last;
}

(async () => {
  loadEnv();
  const amapKeys = [...new Set([
    ...String(process.env.AMAP_WEB_SERVICE_KEYS || '').split(','),
    String(process.env.AMAP_WEB_SERVICE_KEY || ''),
  ].map(value => value.trim()).filter(Boolean))];
  const records = allAttractions();
  const previous = readJson(manifestPath, {});
  const items = [];
  for (const target of targets) {
    const record = records.find(item => item.attraction.id === target.id);
    if (!record) throw new Error(`找不到样本景点：${target.id}`);
    const attraction = record.attraction;
    const previousItem = (previous.items || []).find(item => item.id === target.id) || {};
    const amap = await amapDetailWithPool(target.id, amapKeys).catch(error => ({ status: 'failed', reason: error.message }));
    items.push({
      province: record.province,
      slug: record.slug,
      city: attraction.city || '',
      id: attraction.id,
      name: attraction.name,
      issues: target.issues,
      before: {
        intro: attraction.intro || attraction.description || '',
        address: attraction.address || '',
        tel: attraction.tel || attraction.phone || '',
        openHours: attraction.openHours || '',
        rating: attraction.rating || '',
        guide_data: attraction.guide_data || null,
        lazy_ai_text: attraction.lazy_ai_text || '',
      },
      amap,
      proposed: previousItem.proposed || {},
      sources: previousItem.sources || [],
    });
  }
  const manifest = {
    version: 1,
    status: 'collecting',
    generatedAt: new Date().toISOString(),
    note: '仅用于10条隔离样本；不得直接写入beta内容或正式Git。',
    items,
  };
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\r\n`, 'utf8');
  console.log(JSON.stringify({ manifestPath, count: items.length, amapReady: items.filter(item => item.amap.status === 'ready').length, amapFailures: items.filter(item => item.amap.status !== 'ready').map(item => `${item.province}/${item.name}:${item.amap.reason}`) }, null, 2));
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
