const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  citiesCompatible,
  cityFromAddress,
  normalizeCity,
  normalizeName,
  relatedAttraction,
  sameAttraction,
  temporaryEventReason,
} = require('./core_candidate_quality');

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
const ignoreSecondary = args.has('ignore-secondary');

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

function stripAdministrativePrefix(value) {
  // 官方名称通常只带一层属地前缀。连续剥离会把“古文化街旅游区”本体也当成
  // 行政区删除，曾导致“天津古文化街旅游区（津门故里）”只剩“（津门故里）”。
  const next = String(value || '').replace(/^[\u4e00-\u9fa5]{2,10}?(?:自治州|地区|市|县)/, '');
  return next.length >= 2 ? next : value;
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
  for (const value of [name, officialName].filter(Boolean)) {
    const parenthetical = value.match(/^(.{3,}?)[（(][^）)]+[）)]$/)?.[1];
    if (parenthetical) values.push(parenthetical);
    const parts = value.split(/[—-]/).map(part => part.replace(/(?:旅游景区|风景名胜区|风景旅游区|风景区|旅游区|景区)$/, '').trim()).filter(Boolean);
    if (parts.length > 1) {
      values.push(...parts);
      const typeSuffix = parts.map(part => part.match(/(长城|古城|古镇|博物馆|公园|湖|山)$/)?.[1]).find(Boolean);
      if (typeSuffix) {
        for (const part of parts) if (!part.endsWith(typeSuffix)) values.push(`${part}${typeSuffix}`);
      }
    }
  }
  return [...new Set(values)];
}

function localMatchFor(name, city, records) {
  const matches = records.filter(record => sameAttraction(name, record.name, city, record.city));
  if (!matches.length) return { record: null, ambiguous: false };
  const exact = matches.filter(record => normalizeName(record.name) === normalizeName(name));
  if (exact.length === 1) return { record: exact[0], ambiguous: false };
  if (matches.length === 1) return { record: matches[0], ambiguous: false };
  const cityName = normalizeCity(city);
  const cityMatches = cityName ? matches.filter(record => normalizeCity(record.city) === cityName) : [];
  if (cityMatches.length === 1) return { record: cityMatches[0], ambiguous: false };
  return { record: null, ambiguous: true, matches: matches.map(record => ({ id: record.id, name: record.name, city: record.city })) };
}

function findEntity(entities, name, city) {
  return entities.find(entity => (
    relatedAttraction(entity.name, name, entity.city, city)
    || entity.aliases.some(alias => relatedAttraction(alias, name, entity.city, city))
  ));
}

function addCandidate(entities, item, source, records) {
  const knownCities = records.map(record => record.city).filter(Boolean);
  let candidateCity = normalizeCity(item.city) || cityFromAddress(item.address, knownCities);
  const localMatch = localMatchFor(item.name, candidateCity, records);
  if (!candidateCity && localMatch.record?.city) candidateCity = normalizeCity(localMatch.record.city);
  let entity = findEntity(entities, item.name, candidateCity);
  if (!entity) {
    entity = {
      name: item.name,
      city: candidateCity,
      aliases: aliasesFor(item.name),
      sources: [],
      otaRank: 0,
      amapRank: localMatch.record ? records.indexOf(localMatch.record) + 1 : 0,
      matchWarnings: localMatch.ambiguous ? [{ type: 'ambiguous_local_match', matches: localMatch.matches || [] }] : [],
    };
    entities.push(entity);
  }
  if (!entity.sources.includes(source)) entity.sources.push(source);
  if (!entity.city && candidateCity) entity.city = candidateCity;
  if (source === 'ctrip_popularity' && item.rank) entity.otaRank = item.rank;
  if (!entity.amapRank && localMatch.record) entity.amapRank = records.indexOf(localMatch.record) + 1;
  const local = entity.amapRank ? records[entity.amapRank - 1] : null;
  if (local) {
    entity.preferredId = local.id;
    entity.city = entity.city || local.city || '';
    if (!entity.aliases.includes(local.name)) entity.aliases.push(local.name);
  }
  return entity;
}

function findPreferred(recordName, city, records) {
  return localMatchFor(recordName, city, records).record?.id || '';
}

function mergeDuplicateAttractions(items) {
  const merged = [];
  const mergedNames = [];
  for (const item of items) {
    const canonical = normalizeName(item.name);
    const existing = merged.find(candidate => (
      (item.preferredId && candidate.preferredId === item.preferredId)
      || (canonical && normalizeName(candidate.name) === canonical && citiesCompatible(candidate.city, item.city))
      || (() => {
        const candidateCanonical = normalizeName(candidate.name);
        const oneNameContainsTheOther = canonical.length >= 3
          && candidateCanonical.length >= 3
          && (canonical.endsWith(candidateCanonical) || candidateCanonical.endsWith(canonical));
        const hasOfficialIdentity = [...(item.basis || []), ...(candidate.basis || [])].includes('official_5a');
        return oneNameContainsTheOther && hasOfficialIdentity && citiesCompatible(candidate.city, item.city);
      })()
    ));
    if (!existing) {
      merged.push(item);
      continue;
    }
    const previousName = existing.name;
    if (!existing.preferredId && item.preferredId) {
      existing.name = item.name;
      existing.preferredId = item.preferredId;
      existing.city = item.city || existing.city;
    }
    existing.aliases = [...new Set([...(existing.aliases || []), previousName, item.name, ...(item.aliases || [])])];
    existing.basis = [...new Set([...(existing.basis || []), ...(item.basis || [])])];
    existing.evidence = [...new Set([...(existing.evidence || []), ...(item.evidence || [])])];
    mergedNames.push({ kept: existing.name, merged: item.name, preferredId: existing.preferredId || '' });
  }
  return { items: merged, mergedNames };
}

function evidencePlatform(value) {
  if (/^mct_|^official_/.test(value)) return 'mct';
  if (/^ctrip_/.test(value)) return 'ctrip';
  if (/^xiaohongshu_/.test(value)) return 'xiaohongshu';
  if (/^amap_/.test(value)) return 'amap';
  if (/^dianping_/.test(value)) return 'dianping';
  if (/^official_attraction_site$/.test(value)) return 'official_site';
  return value;
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
  const secondaryEvidence = ignoreSecondary
    ? {}
    : readJson(path.join(runtimeDir, `core-secondary-evidence-${slug}.json`), {});
  if (officialCandidates.fiveA?.length && officialCandidates.fiveA.length !== official.length) {
    throw new Error(`文旅部两个官方入口的5A数量不一致（${official.length} / ${officialCandidates.fiveA.length}），拒绝自动建立清单。`);
  }
  const records = province.attractions || [];
  const attractions = [];
  const entities = [];
  const filteredOtaFromCache = [];
  const durableOtaCandidates = (ota.candidates || []).filter(item => {
    const reason = temporaryEventReason(item.name);
    if (reason) filteredOtaFromCache.push({ ...item, reason });
    return !reason;
  });
  const rejectedOtaCandidates = [...(ota.rejectedCandidates || []), ...filteredOtaFromCache]
    .filter((item, index, values) => values.findIndex(candidate => candidate.name === item.name) === index);

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
  for (const item of durableOtaCandidates) addCandidate(entities, item, 'ctrip_popularity', records);
  for (const item of popularity.candidates || []) addCandidate(entities, item, 'xiaohongshu_popularity', records);

  // 二次证据文件可能来自旧草稿。先按“尚未应用二次证据”的状态计算本轮真实待补证集合，
  // 后面只有当每一项都能在证据文件中找到对应结果时，才允许草稿进入可审批状态。
  const initialReviewEntities = entities.filter(entity => {
    const alreadyCovered = attractions.some(existing => (
      relatedAttraction(existing.name, entity.name, existing.city, entity.city)
      || existing.aliases.some(alias => relatedAttraction(alias, entity.name, existing.city, entity.city))
    ));
    if (alreadyCovered) return false;
    const platforms = new Set(entity.sources.map(evidencePlatform));
    const crossPlatform = platforms.size >= 2;
    const crossWithAmap = entity.amapRank > 0 && entity.sources.length >= 1;
    const officialResort = entity.sources.includes('official_national_resort');
    return !crossPlatform && !crossWithAmap && !officialResort;
  });
  const secondaryMissingInputNames = initialReviewEntities.filter(entity => (
    !(secondaryEvidence.results || []).some(result => Boolean(findEntity([entity], result.name, result.city)))
  )).map(entity => entity.name);
  const secondaryResultsCoverCurrentDraft = secondaryMissingInputNames.length === 0;

  for (const result of secondaryEvidence.results || []) {
    const entity = findEntity(entities, result.name, result.city);
    if (!entity) continue;
    entity.secondaryEvidence = result.evidences || [];
    if (!entity.city && result.city) entity.city = normalizeCity(result.city);
    if (result.status === 'covered_by_core') {
      entity.coveredByCore = result.coveredBy || null;
      continue;
    }
    for (const evidence of result.evidences || []) {
      if (!['amap_secondary_match', 'amap_live_web_service', 'ctrip_city_sightlist', 'dianping_public_listing', 'official_attraction_site'].includes(evidence.source)) continue;
      if (!entity.sources.includes(evidence.source)) entity.sources.push(evidence.source);
      if (['amap_secondary_match', 'amap_live_web_service'].includes(evidence.source) && evidence.id) {
        const recordIndex = records.findIndex(record => record.id === evidence.id);
        if (recordIndex >= 0) {
          entity.preferredId = evidence.id;
          entity.amapRank = recordIndex + 1;
          entity.city = entity.city || records[recordIndex].city || '';
          if (!entity.aliases.includes(records[recordIndex].name)) entity.aliases.push(records[recordIndex].name);
        }
      }
    }
  }

  const selected = [];
  const reviewCandidates = [];
  for (const entity of entities) {
    if (entity.coveredByCore) continue;
    if (attractions.some(existing => (
      relatedAttraction(existing.name, entity.name, existing.city, entity.city)
      || existing.aliases.some(alias => relatedAttraction(alias, entity.name, existing.city, entity.city))
    ))) continue;
    const platforms = new Set(entity.sources.map(evidencePlatform));
    const crossPlatform = platforms.size >= 2;
    const validAmap = entity.amapRank > 0;
    const crossWithAmap = validAmap && entity.sources.length >= 1;
    const officialResort = entity.sources.includes('official_national_resort');
    const target = crossPlatform || crossWithAmap || officialResort ? selected : reviewCandidates;
    target.push(entity);
  }
  selected.sort((a, b) => {
    const sourceDiff = b.sources.length - a.sources.length;
    if (sourceDiff) return sourceDiff;
    const rankA = a.otaRank || a.amapRank || 9999;
    const rankB = b.otaRank || b.amapRank || 9999;
    return rankA - rankB;
  });
  for (const item of selected) {
    attractions.push({
      key: keyFor(`${provinceName}:${item.name}`),
      name: item.name,
      preferredId: item.preferredId || findPreferred(item.name, item.city, records),
      aliases: item.aliases,
      city: item.city || '',
      tier: 'regional_icon',
      basis: [item.sources.includes('official_national_resort') ? 'official_national_resort' : 'cross_source_popularity'],
      evidence: [
        ...(item.sources.includes('official_national_resort') ? ['mct_national_tourism_resort'] : []),
        ...(item.sources.includes('ctrip_popularity') ? ['ctrip_province_sightlist'] : []),
        ...(item.sources.includes('ctrip_city_sightlist') ? ['ctrip_city_sightlist'] : []),
        ...(item.sources.includes('xiaohongshu_popularity') ? ['xiaohongshu_core_candidates'] : []),
        ...(item.amapRank ? ['amap_local_snapshot'] : []),
        ...(item.sources.includes('amap_live_web_service') ? ['amap_live_web_service'] : []),
        ...(item.sources.includes('dianping_public_listing') ? ['dianping_public_listing'] : []),
        ...(item.sources.includes('official_attraction_site') ? ['official_attraction_site'] : []),
      ],
      sourceSignals: { otaRank: item.otaRank || null, amapRank: item.amapRank || null },
      matchWarnings: item.matchWarnings || [],
      secondaryEvidence: item.secondaryEvidence || [],
    });
  }

  const deduplicated = mergeDuplicateAttractions(attractions);
  const finalAttractions = deduplicated.items;
  const unboundAttractions = finalAttractions.filter(item => !item.preferredId).map(item => item.name);
  const selectedIssues = [];
  for (const item of finalAttractions) {
    const eventReason = temporaryEventReason(item.name);
    if (eventReason) selectedIssues.push({ type: 'temporary_event_selected', attraction: item.name, reason: eventReason });
    const preferred = item.preferredId ? records.find(record => record.id === item.preferredId) : null;
    if (preferred && !citiesCompatible(item.city, preferred.city)) {
      selectedIssues.push({
        type: 'cross_city_binding',
        attraction: item.name,
        attractionCity: item.city || '',
        record: preferred.name,
        recordCity: preferred.city || '',
      });
    }
    const evidencePlatforms = new Set(item.evidence.map(evidencePlatform));
    const officialIdentity = item.evidence.includes('mct_national_5a_2025') || item.evidence.includes('mct_national_tourism_resort');
    if (!officialIdentity && evidencePlatforms.size < 2) {
      selectedIssues.push({ type: 'insufficient_cross_source_evidence', attraction: item.name, evidence: item.evidence });
    }
  }
  const secondaryRequired = initialReviewEntities.length > 0;
  const secondaryComplete = !secondaryRequired || (
    secondaryEvidence.province === provinceName && secondaryResultsCoverCurrentDraft
  );
  const sourcesComplete = Boolean(
    popularity.candidates?.length
    && ota.candidates?.length
    && Array.isArray(officialCandidates.resorts)
    && officialCandidates.sourceUrl
    && secondaryComplete
  );
  // 单一口碑/OTA 来源只能证明“值得继续观察”，不能证明实体身份，也不应阻断整省。
  // 真正阻断条件由 sourcesComplete（官方/采集链路缺失）和 selectedIssues
  //（已经纳入正式清单的实体、城市或证据错误）负责。
  const blockingReviewCandidates = [];
  const observationCandidates = reviewCandidates;
  const priorityObservationCandidates = observationCandidates.filter(item => (
    item.sources.includes('ctrip_popularity') && item.otaRank > 0
  ));
  const qualityGate = {
    passed: sourcesComplete && selectedIssues.length === 0 && blockingReviewCandidates.length === 0,
    sourcesComplete,
    selectedIssueCount: selectedIssues.length,
    selectedIssues,
    filteredTemporaryOtaCount: rejectedOtaCandidates.length,
    filteredTemporaryOtaCandidates: rejectedOtaCandidates,
    secondaryEvidenceComplete: secondaryComplete,
    secondaryInputCandidateCount: initialReviewEntities.length,
    secondaryMissingInputNames,
    unresolvedAfterSecondaryCount: reviewCandidates.length,
    blockingSingleSourceCount: blockingReviewCandidates.length,
    observationCount: observationCandidates.length,
    priorityObservationCount: priorityObservationCandidates.length,
    note: '质量门禁只阻断来源链路缺失或已入选项目的关键质量错误；单源候选完成二次补证后仍无法确认时进入观察池，不写入核心清单，也不阻断整省。省榜高位单源候选标记为优先观察，后续获得新证据时自动晋级。',
  };
  const baseline = {
    province: provinceName,
    checkedAt: new Date().toISOString().slice(0, 10),
    baselineStatus: !sourcesComplete ? 'sources_incomplete' : (qualityGate.passed ? 'multi_source_ready' : 'quality_gate_blocked'),
    method: '高德5330条本地快照作为候选底库；文化和旅游部国家5A与国家级旅游度假区作为官方基线；携程与小红书用于判断跨区域认知和长期口碑。首轮单源候选继续使用城市级携程分页与高德POI定向补证，仍不能确认的结果才进入人工待确认区。',
    sourcePolicy: {
      official: '国家5A与国家级旅游度假区均以文化和旅游部结构化名录确认身份；度假区保留地址与坐标用于城市校验',
      xiaohongshu: '发现官方名单之外的长期高频游客目的地，不用于确认等级、票价和开放时间',
      amap: '复用既有高德POI底库做候选发现、名称匹配和本地相对排序，不单独决定核心身份',
      ctrip: '判断跨区域游客认知和长期旅行热度，不固化动态评分与票价',
      restriction: '非官方候选需跨平台命中；首轮单源候选必须完成定向二次补证；总控不会覆盖已有合格景点数据',
    },
    sources: {
      mct_national_5a_2025: officialUrl,
      mct_national_tourism_resort: officialCandidates.sourceUrl || officialPortalUrl,
      xiaohongshu_core_candidates: 'https://www.xiaohongshu.com/ai_chat_tab',
      ctrip_province_sightlist: ota.sourceUrl || '',
      ctrip_city_sightlist: '携程各城市景点分页（由省级攻略页发现城市入口）',
      amap_local_snapshot: 'content/db.json',
      dianping: '当前未接入，不计入本次交叉验证',
      official_attraction_site: 'content/core-evidence-overrides.json 中人工核验的景点官网页面',
    },
    sourceAvailability: {
      officialMct: true,
      ctrip: Boolean(ota.candidates?.length),
      ctripCityPages: Boolean(secondaryEvidence.sourceAvailability?.ctripCityPages),
      xiaohongshu: Boolean(popularity.candidates?.length),
      amapLocalSnapshot: true,
      amapLiveWebService: Boolean(secondaryEvidence.sourceAvailability?.amapLiveWebService),
      dianping: Boolean(secondaryEvidence.sourceAvailability?.dianping),
    },
    qualityGate,
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
    blockingReviewCandidateCount: blockingReviewCandidates.length,
    blockingReviewCandidates,
    priorityObservationCandidateCount: priorityObservationCandidates.length,
    priorityObservationCandidates,
    observationCandidateCount: observationCandidates.length,
    observationCandidates,
    reviewCandidates,
    secondaryEvidenceSummary: secondaryEvidence.province === provinceName ? {
      candidateCount: secondaryEvidence.candidateCount || 0,
      verifiedCount: secondaryEvidence.verifiedCount || 0,
      coveredByCoreCount: secondaryEvidence.coveredByCoreCount || 0,
      unresolvedCount: secondaryEvidence.unresolvedCount || 0,
      warnings: secondaryEvidence.warnings || [],
    } : null,
    attractions: finalAttractions,
  };

  const draftPath = path.join(runtimeDir, `core-attractions.${slug}.draft.json`);
  writeJson(draftPath, baseline);
  console.log(`${provinceName}核心候选：官方5A ${baseline.officialCount} 个，官方度假区与多源补充 ${baseline.popularityCount} 个，共 ${finalAttractions.length} 个；二次补证后仍待人工 ${baseline.reviewCandidateCount} 个。`);
  console.log(`本次有效来源：文旅部官方、携程省级/城市分页、高德本地快照、小红书；大众点评${baseline.sourceAvailability.dianping ? '已获取可核验证据' : '无稳定公开接口，未计分'}。`);
  if (qualityGate.filteredTemporaryOtaCount) {
    console.log(`已过滤携程临时活动 ${qualityGate.filteredTemporaryOtaCount} 个：${qualityGate.filteredTemporaryOtaCandidates.map(item => item.name).join('、')}`);
  }
  console.log(`现有记录绑定：${baseline.existingRecordBoundCount} 个；现有库未命中：${baseline.existingRecordUnboundCount} 个${unboundAttractions.length ? `（${unboundAttractions.join('、')}）` : ''}；同ID/同规范名合并：${baseline.mergedDuplicateCount} 个。`);
  console.log(`质量门禁：${qualityGate.passed ? `通过（观察池保留 ${qualityGate.observationCount} 个普通单源候选）` : `未通过（${qualityGate.selectedIssueCount} 个入选项问题，${qualityGate.blockingSingleSourceCount} 个高热度单源候选仍需补证）`}。`);
  for (const issue of qualityGate.selectedIssues) console.log(`  [阻断] ${issue.attraction}：${issue.type}`);
  console.log(`草稿：${draftPath}`);
  if (approve) {
    if (baseline.baselineStatus !== 'multi_source_ready' || !baseline.qualityGate?.passed) throw new Error('多源材料不完整或质量门禁未通过，拒绝批准核心清单。');
    const targetPath = path.join(contentDir, `core-attractions.${slug}.json`);
    writeJson(targetPath, baseline);
    console.log(`已建立省级核心清单：${targetPath}`);
  }
}

main().catch(error => {
  console.error(`建立核心清单失败：${error.message}`);
  process.exitCode = 1;
});
