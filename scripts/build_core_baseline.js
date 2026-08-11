const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const rootDir = path.join(__dirname, '..');
const contentDir = path.join(rootDir, 'content');
const runtimeDir = path.join(rootDir, '.runtime');
const officialUrl = 'https://sjfw.mct.gov.cn/site/dataservice/rural?type=10';
const officialPortalUrl = 'https://lyfw.mct.gov.cn/site/special/home';

const args = new Map(process.argv.slice(2).map(arg => {
  const match = arg.match(/^--([^=]+)=(.*)$/);
  return match ? [match[1], match[2]] : [arg.replace(/^--/, ''), true];
}));
const provinceName = String(args.get('province') || '');
const approve = args.has('approve');

function readJson(filePath, fallback = {}) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\r\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&middot;/g, '·')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/<[^>]+>/g, '')
    .trim();
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[·•（）()\-—_\s]/g, '')
    .replace(/国家[345]a级旅游景区/g, '')
    .replace(/国家级|国家重点|国家/g, '')
    .replace(/旅游风景名胜区|旅游景区|旅游风景区|风景名胜区|风景旅游区|风景区|旅游区|景区$/g, '')
    .trim();
}

function stripAdministrativePrefix(value) {
  let name = value;
  for (let index = 0; index < 3; index += 1) {
    const next = name.replace(/^[\u4e00-\u9fa5]{2,10}?(?:自治州|地区|市|县|区)/, '');
    if (next === name || next.length < 2) break;
    name = next;
  }
  return name;
}

function cityFromOfficial(value) {
  const match = value.match(/^([\u4e00-\u9fa5]{2,10}?)(?:市|自治州|地区)/);
  return match ? match[1] : '';
}

function keyFor(name) {
  return `core_${crypto.createHash('sha1').update(name).digest('hex').slice(0, 10)}`;
}

function aliasesFor(name, officialName = '') {
  const values = [name, officialName, name.replace(/(?:旅游景区|风景名胜区|风景旅游区|风景区|旅游区|景区)$/, '')].filter(Boolean);
  return [...new Set(values)];
}

function sameAttraction(left, right) {
  const a = normalizeName(left);
  const b = normalizeName(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  if (shorter.length >= 2 && longer.endsWith(shorter) && longer.length - shorter.length <= 6) return true;
  if (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a))) return true;
  let suffixLength = 0;
  while (suffixLength < a.length && suffixLength < b.length && a[a.length - 1 - suffixLength] === b[b.length - 1 - suffixLength]) suffixLength += 1;
  const suffix = a.slice(a.length - suffixLength);
  const generic = /^(博物馆|纪念馆|度假区|风景区|古城|古镇|公园|广场|旅游区)$/;
  return suffixLength >= 3 && !generic.test(suffix);
}

function localRankFor(name, records) {
  const index = records.findIndex(record => sameAttraction(name, record.name));
  return index >= 0 ? index + 1 : 0;
}

function findEntity(entities, name) {
  return entities.find(entity => sameAttraction(entity.name, name) || entity.aliases.some(alias => sameAttraction(alias, name)));
}

function addCandidate(entities, item, source, records) {
  let entity = findEntity(entities, item.name);
  if (!entity) {
    entity = {
      name: item.name,
      city: item.city || '',
      aliases: aliasesFor(item.name),
      sources: [],
      otaRank: 0,
      amapRank: localRankFor(item.name, records),
    };
    entities.push(entity);
  }
  if (!entity.sources.includes(source)) entity.sources.push(source);
  if (!entity.city && item.city) entity.city = item.city;
  if (source === 'ctrip_popularity' && item.rank) entity.otaRank = item.rank;
  if (!entity.amapRank) entity.amapRank = localRankFor(entity.name, records);
  const local = entity.amapRank ? records[entity.amapRank - 1] : null;
  if (local) {
    entity.preferredId = local.id;
    entity.city = entity.city || local.city || '';
    if (!entity.aliases.includes(local.name)) entity.aliases.push(local.name);
  }
  return entity;
}

function findPreferred(recordName, city, records) {
  const target = normalizeName(recordName);
  const exact = records.filter(record => {
    const candidate = normalizeName(record.name);
    return candidate && target && candidate === target && (!city || !record.city || record.city.includes(city) || city.includes(record.city));
  });
  if (exact.length) return exact[0].id;
  const matches = records.filter(record => sameAttraction(recordName, record.name) && (!city || !record.city || record.city.includes(city) || city.includes(record.city)));
  matches.sort((a, b) => Math.abs(normalizeName(a.name).length - target.length) - Math.abs(normalizeName(b.name).length - target.length));
  return matches[0]?.id || '';
}

function mergeDuplicateAttractions(items) {
  const merged = [];
  const mergedNames = [];
  for (const item of items) {
    const canonical = normalizeName(item.name);
    const existing = merged.find(candidate => (
      (item.preferredId && candidate.preferredId === item.preferredId)
      || (canonical && normalizeName(candidate.name) === canonical)
    ));
    if (!existing) {
      merged.push(item);
      continue;
    }
    existing.aliases = [...new Set([...(existing.aliases || []), item.name, ...(item.aliases || [])])];
    existing.basis = [...new Set([...(existing.basis || []), ...(item.basis || [])])];
    existing.evidence = [...new Set([...(existing.evidence || []), ...(item.evidence || [])])];
    mergedNames.push({ kept: existing.name, merged: item.name, preferredId: existing.preferredId || '' });
  }
  return { items: merged, mergedNames };
}

async function readOfficial5A(province) {
  const response = await fetch(officialUrl, { headers: { 'user-agent': 'Mozilla/5.0 ChinaTourismMapDataMaintenance/1.0' } });
  if (!response.ok) throw new Error(`文化和旅游部数据服务请求失败：HTTP ${response.status}`);
  const html = await response.text();
  const escaped = province.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const section = html.match(new RegExp(`<div class="tit"[^>]*>${escaped}</div>\\s*<div class="box"[^>]*>([\\s\\S]*?)</div></div><div class="li"`));
  if (!section) throw new Error(`文化和旅游部数据服务中没有解析到 ${province}。`);
  return [...section[1].matchAll(/<a[^>]*>([\s\S]*?)<\/a>/g)].map(match => {
    const raw = decodeHtml(match[1]);
    const yearMatch = raw.match(/(\d{4}(?:\/\d{4})?年)$/);
    const officialName = raw.replace(/\d{4}(?:\/\d{4})?年$/, '').trim();
    const city = cityFromOfficial(officialName);
    const name = stripAdministrativePrefix(officialName);
    return { name, officialName, city, year: yearMatch ? yearMatch[1] : '' };
  });
}

async function main() {
  if (!provinceName) throw new Error('请使用 --province=省份。');
  const db = readJson(path.join(contentDir, 'db.json'), { provinces: {} });
  const province = db.provinces?.[provinceName];
  if (!province) throw new Error(`基础数据库中没有找到省份：${provinceName}`);
  const slug = province.id || provinceName;
  const official = await readOfficial5A(provinceName);
  if (!official.length) throw new Error(`${provinceName} 的国家5A名单为空，拒绝生成。`);
  const popularityPath = path.join(runtimeDir, `core-popularity-${slug}.json`);
  const popularity = readJson(popularityPath, { candidates: [] });
  const otaPath = path.join(runtimeDir, `core-ota-${slug}.json`);
  const ota = readJson(otaPath, { candidates: [] });
  const officialCandidatePath = path.join(runtimeDir, `core-official-${slug}.json`);
  const officialCandidates = readJson(officialCandidatePath, { fiveA: [], resorts: [] });
  if (officialCandidates.fiveA?.length && officialCandidates.fiveA.length !== official.length) {
    throw new Error(`文旅部两个官方入口的5A数量不一致（${official.length} / ${officialCandidates.fiveA.length}），拒绝自动建立清单。`);
  }
  const records = province.attractions || [];
  const attractions = [];
  const entities = [];

  for (const item of official) {
    attractions.push({
      key: keyFor(`${provinceName}:${item.name}`),
      name: item.name,
      preferredId: findPreferred(item.name, item.city, records),
      aliases: aliasesFor(item.name, item.officialName),
      city: item.city,
      tier: 'national',
      basis: ['official_5a'],
      evidence: ['mct_national_5a_2025'],
      officialYear: item.year,
    });
  }

  for (const item of officialCandidates.resorts || []) addCandidate(entities, item, 'official_national_resort', records);
  for (const item of ota.candidates || []) addCandidate(entities, item, 'ctrip_popularity', records);
  for (const item of popularity.candidates || []) addCandidate(entities, item, 'xiaohongshu_popularity', records);

  const selected = [];
  const reviewCandidates = [];
  for (const entity of entities) {
    if (attractions.some(existing => sameAttraction(existing.name, entity.name) || existing.aliases.some(alias => sameAttraction(alias, entity.name)))) continue;
    const crossPlatform = entity.sources.includes('ctrip_popularity') && entity.sources.includes('xiaohongshu_popularity');
    const strongAmap = entity.amapRank > 0 && entity.amapRank <= 50;
    const crossWithAmap = strongAmap && entity.sources.length >= 1;
    const officialResort = entity.sources.includes('official_national_resort');
    const officialCrossSource = officialResort && (strongAmap || entity.sources.length >= 2);
    const target = crossPlatform || crossWithAmap || officialCrossSource ? selected : reviewCandidates;
    target.push(entity);
  }
  selected.sort((a, b) => {
    const sourceDiff = b.sources.length - a.sources.length;
    if (sourceDiff) return sourceDiff;
    const rankA = a.otaRank || a.amapRank || 9999;
    const rankB = b.otaRank || b.amapRank || 9999;
    return rankA - rankB;
  });
  for (const item of selected.slice(0, 20)) {
    attractions.push({
      key: keyFor(`${provinceName}:${item.name}`),
      name: item.name,
      preferredId: item.preferredId || findPreferred(item.name, item.city, records),
      aliases: item.aliases,
      city: item.city || '',
      tier: 'regional_icon',
      basis: [item.sources.includes('official_national_resort') ? 'official_resort_cross_source' : 'cross_source_popularity'],
      evidence: [
        ...(item.sources.includes('official_national_resort') ? ['mct_national_tourism_resort'] : []),
        ...(item.sources.includes('ctrip_popularity') ? ['ctrip_province_sightlist'] : []),
        ...(item.sources.includes('xiaohongshu_popularity') ? ['xiaohongshu_core_candidates'] : []),
        ...(item.amapRank ? ['amap_local_snapshot'] : []),
      ],
      sourceSignals: { otaRank: item.otaRank || null, amapRank: item.amapRank || null },
    });
  }

  const deduplicated = mergeDuplicateAttractions(attractions);
  const finalAttractions = deduplicated.items;
  const unboundAttractions = finalAttractions.filter(item => !item.preferredId).map(item => item.name);
  const baseline = {
    province: provinceName,
    checkedAt: new Date().toISOString().slice(0, 10),
    baselineStatus: popularity.candidates?.length && ota.candidates?.length && officialCandidates.resorts?.length ? 'multi_source_ready' : 'sources_incomplete',
    method: '高德5330条本地快照作为候选底库；文化和旅游部国家5A作为硬基线，国家级旅游度假区作为官方补充候选；携程与小红书用于判断跨区域认知和长期口碑。非5A至少命中两个维度才进入推荐清单，单源结果只进入待确认区。',
    sourcePolicy: {
      official: '确认国家5A身份与评定年份；国家级旅游度假区需再命中高德、携程或小红书之一才进入核心清单',
      xiaohongshu: '发现官方名单之外的长期高频游客目的地，不用于确认等级、票价和开放时间',
      amap: '复用既有高德POI底库做候选发现、名称匹配和本地相对排序，不单独决定核心身份',
      ctrip: '判断跨区域游客认知和长期旅行热度，不固化动态评分与票价',
      restriction: '非5A需跨来源命中；单源候选不直接进入核心清单；总控不会覆盖已有合格景点数据',
    },
    sources: {
      mct_national_5a_2025: officialUrl,
      mct_national_tourism_resort: officialCandidates.sourceUrl || officialPortalUrl,
      xiaohongshu_core_candidates: 'https://www.xiaohongshu.com/ai_chat_tab',
      ctrip_province_sightlist: ota.sourceUrl || '',
      amap_local_snapshot: 'content/db.json',
    },
    amapSnapshotCount: Object.values(db.provinces || {}).reduce((sum, item) => sum + (item.attractions || []).length, 0),
    officialCount: official.length,
    officialResortCandidateCount: officialCandidates.resorts?.length || 0,
    popularityCount: finalAttractions.filter(item => !item.evidence.includes('mct_national_5a_2025')).length,
    existingRecordBoundCount: finalAttractions.length - unboundAttractions.length,
    existingRecordUnboundCount: unboundAttractions.length,
    existingRecordUnboundNames: unboundAttractions,
    mergedDuplicateCount: deduplicated.mergedNames.length,
    mergedDuplicates: deduplicated.mergedNames,
    reviewCandidateCount: reviewCandidates.length,
    reviewCandidates,
    attractions: finalAttractions,
  };

  const draftPath = path.join(runtimeDir, `core-attractions.${slug}.draft.json`);
  writeJson(draftPath, baseline);
  console.log(`${provinceName}核心候选：官方5A ${baseline.officialCount} 个，多源补充 ${baseline.popularityCount} 个，共 ${finalAttractions.length} 个；另有单源待确认 ${baseline.reviewCandidateCount} 个。`);
  console.log(`现有记录绑定：${baseline.existingRecordBoundCount} 个；现有库未命中：${baseline.existingRecordUnboundCount} 个${unboundAttractions.length ? `（${unboundAttractions.join('、')}）` : ''}；同ID/同规范名合并：${baseline.mergedDuplicateCount} 个。`);
  console.log(`草稿：${draftPath}`);
  if (approve) {
    if (baseline.baselineStatus !== 'multi_source_ready') throw new Error('携程或小红书候选尚未采集，拒绝批准来源不完整的基线。');
    const targetPath = path.join(contentDir, `core-attractions.${slug}.json`);
    writeJson(targetPath, baseline);
    console.log(`已建立省级核心清单：${targetPath}`);
  }
}

main().catch(error => {
  console.error(`建立核心清单失败：${error.message}`);
  process.exitCode = 1;
});
