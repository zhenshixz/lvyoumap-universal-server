const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const contentDir = path.join(rootDir, 'content');
const runtimeDir = path.join(rootDir, '.runtime');
const reportDir = path.join(rootDir, 'reports');
const args = new Map(process.argv.slice(2).map(arg => {
  const match = arg.match(/^--([^=]+)=(.*)$/);
  return match ? [match[1], match[2]] : [arg.replace(/^--/, ''), true];
}));
const province = String(args.get('province') || '').trim();
if (!province) throw new Error('请使用 --province=省份 指定范围。');

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\r\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function provinceInfo(name) {
  const db = readJson(path.join(contentDir, 'db.json'), { provinces: {} });
  const entry = Object.entries(db.provinces || {}).find(([key]) => key === name);
  return entry ? { slug: entry[1].slug || entry[1].id || '' } : null;
}

function clothing(profile) {
  const profiles = {
    coastal: {
      spring_autumn: '海边风大且天气变化快，建议轻薄防风外套、长裤和防滑运动鞋。',
      summer: '速干衣、防晒帽、防晒霜和补水用品并备，下水项目另带可更换衣物。',
      winter: '准备防风外套和长裤，阴雨、海风较强时体感会明显降低。',
      tips: '滨海栈道、礁石和雨后地面可能湿滑，以防滑鞋为主，不穿拖鞋长距离游览。',
    },
    indoor: {
      spring_autumn: '以轻便整洁衣物和舒适步行鞋为主，室内外温差大时备一件薄外套。',
      summer: '穿透气衣物并备薄外套，展馆或演出场馆空调环境可能偏凉。',
      winter: '常规保暖衣物即可，步行串联周边街区时注意天气变化。',
      tips: '历史建筑、纪念场馆和宗教场所宜衣着得体，避免影响参观秩序。',
    },
    resort: {
      spring_autumn: '轻便分层穿搭最实用，室内项目、户外步行和晚间活动可灵活增减。',
      summer: '速干衣、防晒和雨具并备，室内空调场所给儿童准备薄外套。',
      winter: '准备防风保暖外套和舒适步行鞋，早晚活动注意温差。',
      tips: '大型度假区步行量容易被低估，鞋子舒适度比造型更重要。',
    },
    lake: {
      spring_autumn: '湖区早晚及乘船时风大，建议轻薄防风外套、长裤和防滑鞋。',
      summer: '速干衣、防晒帽、防晒霜和足量饮水并备，尽量避开正午暴晒。',
      winter: '准备保暖防风外套和长裤，湖面及码头体感温度通常更低。',
      tips: '码头、游船和临水步道注意防滑，儿童和长辈上下船时应有人照看。',
    },
    urban: {
      spring_autumn: '轻便衣物、薄外套和舒适步行鞋适合街区与室内外连续游览。',
      summer: '透气速干衣、防晒和补水用品并备，午后安排室内点位更舒适。',
      winter: '准备薄至中等厚度外套，阴雨天增加防水鞋和便携雨具。',
      tips: '城市街区步行和排队时间可能较长，优先穿软底防滑鞋。',
    },
  };
  return profiles[profile] || profiles.urban;
}

function routeFromSeed(route, source, verifiedAt) {
  return {
    title: route.title,
    badge: route.badge,
    suitability: route.suitability,
    nodes: route.nodes,
    duration: route.duration,
    walking: route.walking,
    physical: route.physical,
    tips: route.tips,
    sourceTitle: route.sourceTitle || source.title,
    sourceUrl: route.sourceUrl || source.url,
    verifiedAt,
  };
}

function safeId(value) {
  let hash = 2166136261;
  for (const char of String(value || '')) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `manual_${info.slug}_${(hash >>> 0).toString(16)}`;
}

function compactSources(item, baseline, official) {
  const result = [];
  const push = (title, url, kind) => {
    if (!url || result.some(entry => entry.url === url)) return;
    result.push({ title, url, kind });
  };
  if (item.officialRecord) {
    push(official.source || '文化和旅游部大众旅游服务', official.sourceUrl, 'official_identity');
  }
  const baselineItem = (baseline.attractions || []).find(entry => entry.key === item.baselineKey);
  const sourceUrls = baseline.sources || {};
  for (const source of baselineItem?.evidence || []) {
    const url = sourceUrls[source];
    if (/^https:\/\//i.test(String(url || ''))) push(source, url, 'candidate_evidence');
  }
  for (const evidence of baselineItem?.secondaryEvidence || []) {
    if (/^https:\/\//i.test(String(evidence.url || ''))) push(evidence.source || '二次补证', evidence.url, 'secondary_evidence');
  }
  return result;
}

function buildResearchWorkspace(dossier, baseline, official, existingPackage) {
  const previousByKey = new Map((existingPackage?.attractions || []).map(item => [item.baselineKey, item]));
  const attractions = (dossier.items || []).map(item => {
    const previous = previousByKey.get(item.baselineKey) || {};
    const officialRecord = item.officialRecord || {};
    const baselineItem = (baseline.attractions || []).find(entry => entry.key === item.baselineKey) || {};
    const discoveredSources = compactSources(item, baseline, official);
    return {
      ...previous,
      baselineKey: item.baselineKey,
      preferredId: previous.preferredId || baselineItem.preferredId || '',
      id: previous.id || safeId(item.baselineKey || item.name),
      name: item.name,
      city: previous.city || item.city || province,
      address: previous.address || officialRecord.address || '',
      intro: previous.intro || officialRecord.introduce || '',
      coordinates: previous.coordinates || (officialRecord.longitude && officialRecord.latitude ? {
        longitude: officialRecord.longitude,
        latitude: officialRecord.latitude,
      } : undefined),
      research: {
        status: previous.research?.status || 'pending',
        discoveredSources,
        required: [
          '基本信息至少两个可核验来源',
          '开放与预约规则（动态内容只写官方核验提示）',
          '旅行指南：交通、住宿区域、美食、长辈与儿童建议',
          '至少一条真实可执行且有来源的游览方案；确有不同玩法时可补第二条',
          '可追溯且许可明确的图片',
          '小红书点点懒人攻略',
        ],
      },
    };
  });
  const packageData = {
    province,
    status: 'researching',
    createdAt: existingPackage?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    policy: '研究阶段只保存已找到的事实和来源；缺失字段保持为空，不用旧模板或占位内容冒充完整资料。',
    seedFile: path.relative(rootDir, seedPath).replace(/\\/g, '/'),
    dossierFile: path.relative(rootDir, dossierPath).replace(/\\/g, '/'),
    attractions,
    overrides: existingPackage?.overrides || {},
  };
  writeJsonAtomic(researchWorkspacePath, packageData);
  const researchReport = {
    province,
    status: 'researching',
    generatedAt: packageData.updatedAt,
    total: attractions.length,
    instruction: '总控会先采集点点攻略；基本信息、路线和图片只有达到可核验标准后才会进入正式补全包。',
    items: attractions.map(item => ({
      baselineKey: item.baselineKey,
      name: item.name,
      city: item.city,
      discoveredSourceCount: item.research.discoveredSources.length,
      discoveredSources: item.research.discoveredSources,
      hasOfficialBasicInfo: Boolean(item.address && item.intro),
      pending: item.research.required,
    })),
  };
  writeJsonAtomic(researchPath, researchReport);
  console.log(`${province}资料研究任务已建立：${attractions.length} 个景点。`);
  console.log('当前状态：researching（可先采集点点攻略；其余资料继续核验，未达标不会写入正式数据）。');
  console.log(`研究报告：${researchPath}`);
}

const info = provinceInfo(province);
if (!info?.slug) throw new Error(`无法识别省份：${province}`);
const seedPath = path.join(contentDir, `core-repair-seeds.${info.slug}.json`);
const packagePath = path.join(contentDir, `core-repair-packages.${info.slug}.json`);
const dossierPath = path.join(runtimeDir, `core-repairs.${info.slug}.json`);
const researchWorkspacePath = path.join(runtimeDir, `core-repair-research.${info.slug}.json`);
const researchPath = path.join(reportDir, `core-research-${info.slug}.json`);
const seed = readJson(seedPath);
if (!seed || seed.province !== province || !Array.isArray(seed.attractions) || !seed.attractions.length) {
  const dossier = readJson(dossierPath);
  const baseline = readJson(path.join(contentDir, `core-attractions.${info.slug}.json`));
  const official = readJson(path.join(runtimeDir, `core-official-${info.slug}.json`), {});
  if (!dossier?.items?.length || !baseline?.attractions?.length) {
    throw new Error('缺少核心补全档案或已批准核心清单，请先执行数据体检。');
  }
  buildResearchWorkspace(dossier, baseline, official, readJson(researchWorkspacePath));
  process.exit(0);
}
const existing = readJson(packagePath);
if (existing?.status === 'applied') {
  console.log(`${province}补全包已应用，不重复生成。`);
  process.exit(0);
}
const verifiedAt = seed.verifiedAt || new Date().toISOString().slice(0, 10);
const researchWorkspace = readJson(researchWorkspacePath, { attractions: [] });
const targetByBaseline = new Map((researchWorkspace.attractions || []).map(item => [item.baselineKey, item.preferredId || '']));
const preparedItems = seed.attractions.map(item => {
  if (!item.sources?.length) throw new Error(`${item.name} 至少需要一个可追溯基本信息来源。`);
  if (!item.routes?.length) throw new Error(`${item.name} 至少需要一条已核验的可执行游览方案。`);
  return {
    baselineKey: item.baselineKey,
    targetId: item.targetId || targetByBaseline.get(item.baselineKey) || '',
    id: item.id,
    name: item.name,
    city: item.city,
    rating: item.rating,
    reviewsCount: item.reviewsCount || '多平台热门',
    image: item.image,
    description: item.description,
    intro: item.intro,
    level: item.level,
    category: item.category,
    tags: item.tags,
    address: item.address,
    openHours: item.openHours,
    price: item.price,
    tips: item.tips,
    guide_data: {
      clothing: clothing(item.profile),
      transport: item.transport,
      housing: item.housing,
      food: item.food,
      special_care: item.specialCare,
    },
    lazy_routes: item.routes.map(route => routeFromSeed(route, item.sources[0], verifiedAt)),
    lazy_tips: item.lazyTips,
    quality_policy: item.lazyGuidePolicy || {},
    source_evidence: {
      source: item.sourceLabel || '文化和旅游主管部门、景区官方渠道与主流OTA交叉核验',
      basicInfoSources: item.sources.map(source => `${source.title}：${source.url}`),
      ratingSource: item.source_evidence?.ratingSource || null,
      basicInfoUpdatedAt: verifiedAt,
      note: item.sourceNote || '开放、预约、票价和交通为动态信息，出发前以官方当日公告为准。',
    },
    image_source: item.imageSource,
    quality_status: {
      reviewRequired: Boolean(item.qualityWarnings?.length),
      warnings: item.qualityWarnings || [],
    },
  };
});
const attractions = preparedItems.filter(item => !item.targetId).map(item => {
  const clean = { ...item };
  delete clean.targetId;
  return clean;
});
const overrides = { ...(seed.overrides || {}) };
for (const item of preparedItems.filter(value => value.targetId)) {
  const targetId = item.targetId;
  const patch = { ...item, id: targetId };
  delete patch.baselineKey;
  delete patch.targetId;
  overrides[targetId] = { ...(overrides[targetId] || {}), ...patch };
}
const packageData = {
  province,
  status: existing?.status === 'reviewed' ? 'reviewed' : 'collecting',
  createdAt: existing?.createdAt || new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  policy: '官方身份与基本信息优先；主流OTA只作游客视角补充；图片必须可追溯；点点懒人攻略完成后才能进入最终质量闸门。',
  warnings: seed.warnings || [],
  seedFile: path.relative(rootDir, seedPath).replace(/\\/g, '/'),
  attractions,
  overrides,
};
writeJsonAtomic(packagePath, packageData);
console.log(`${province}补全包已建立：新增 ${attractions.length}，增强现有 ${Object.keys(packageData.overrides).length}。`);
console.log(`状态：collecting（下一步只采集该补全包的点点攻略）。`);
console.log(`文件：${packagePath}`);
