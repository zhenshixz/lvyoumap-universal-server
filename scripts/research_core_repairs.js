const fs = require('fs');
const https = require('https');
const path = require('path');
const { spawnSync } = require('child_process');
const { validateManualAttraction } = require('./generate_static_data');

const rootDir = path.join(__dirname, '..');
const contentDir = path.join(rootDir, 'content');
const runtimeDir = path.join(rootDir, '.runtime');
const reportDir = path.join(rootDir, 'reports');
const stopPath = path.join(runtimeDir, 'xhs-lazy-stop.flag');
const args = new Map(process.argv.slice(2).map(arg => {
  const match = arg.match(/^--([^=]+)=(.*)$/);
  return match ? [match[1], match[2]] : [arg.replace(/^--/, ''), true];
}));
const province = String(args.get('province') || '').trim();
const useManualEvidence = !args.has('no-manual');
if (!province) throw new Error('请使用 --province=省份。');

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
  const value = db.provinces?.[name];
  return value ? { slug: value.id || value.slug, data: value } : null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function download(url, target, redirects = 0, attempts = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('图片重定向次数过多'));
    const request = https.get(url, { headers: { 'User-Agent': 'lvyoumap-maintenance/1.0 (personal travel data project)' } }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        return resolve(download(new URL(response.headers.location, url).toString(), target, redirects + 1, attempts));
      }
      if ([429, 502, 503].includes(response.statusCode) && attempts < 3) {
        response.resume();
        const wait = Number(response.headers['retry-after'] || 3) * 1000 + attempts * 2000;
        return setTimeout(() => resolve(download(url, target, redirects, attempts + 1)), wait);
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`图片请求 HTTP ${response.statusCode}`));
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const temp = `${target}.tmp`;
      const output = fs.createWriteStream(temp);
      response.pipe(output);
      output.on('finish', () => {
        output.close();
        fs.renameSync(temp, target);
        resolve();
      });
      output.on('error', reject);
    });
    request.setTimeout(45000, () => request.destroy(new Error('图片请求超时')));
    request.on('error', reject);
  });
}

function windowsProxy() {
  if (process.env.MAINTENANCE_HTTPS_PROXY) return process.env.MAINTENANCE_HTTPS_PROXY;
  if (process.platform !== 'win32') return '';
  const result = spawnSync('reg.exe', [
    'query',
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    '/v',
    'ProxyServer',
  ], { encoding: 'utf8', windowsHide: true });
  const match = String(result.stdout || '').match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i);
  if (!match) return '';
  const value = match[1].trim();
  const mapped = Object.fromEntries(value.split(';').map(part => part.split('=', 2)).filter(pair => pair.length === 2));
  const endpoint = mapped.https || mapped.http || value;
  return /^https?:\/\//i.test(endpoint) ? endpoint : `http://${endpoint}`;
}

function downloadWithCurl(url, target) {
  const temp = `${target}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(temp)) fs.unlinkSync(temp);
  const curlArgs = [
    '--location',
    '--fail',
    '--silent',
    '--show-error',
    '--ssl-no-revoke',
    '--max-time',
    '90',
    '--retry',
    '5',
    '--retry-all-errors',
    '--retry-delay',
    '3',
    '--user-agent',
    'lvyoumap-maintenance/1.0 (personal travel data project)',
  ];
  const proxy = windowsProxy();
  if (proxy) curlArgs.push('--proxy', proxy);
  curlArgs.push('--output', temp, url);
  const result = spawnSync('curl.exe', curlArgs, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0 || !fs.existsSync(temp)) {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
    throw new Error(`备用图片下载失败：${String(result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
  }
  fs.renameSync(temp, target);
}

async function downloadResilient(url, target) {
  if (process.platform === 'win32' && windowsProxy()) {
    downloadWithCurl(url, target);
    return;
  }
  try {
    await download(url, target);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
    downloadWithCurl(url, target);
  }
}

function routeDefaults(route, profile, source) {
  const mountain = profile === 'mountain';
  return {
    title: route.title,
    badge: route.badge || (mountain ? '分段量力' : '顺路少折返'),
    suitability: route.suitability || '第一次到访、亲子与长辈同行',
    nodes: route.nodes,
    duration: route.duration || '半天',
    walking: route.walking || (mountain ? '台阶较多，按体力折返' : '以平路步行为主，点位间按现场接驳'),
    physical: Number(route.physical || (mountain ? 4 : 2)),
    tips: route.tips || ['先完成核心点位，再按体力增加支线。', '开放区域、预约与接驳以官方当日公告为准。'],
    sourceTitle: route.sourceTitle || source.title,
    sourceUrl: route.sourceUrl || source.url,
  };
}

function guideDefaults(evidence) {
  const profile = evidence.profile || 'urban';
  const area = evidence.housingArea || evidence.city || province;
  const mountain = profile === 'mountain';
  const resort = profile === 'resort';
  return {
    transport: evidence.transport || {
      external_arrive: evidence.externalArrive || '优先使用轨道交通或景区官方公共接驳；远郊景区按官方交通指南规划往返。',
      internal_arrive: evidence.internalArrive || '到达主入口或游客中心后，先确认预约、开放区域与当天导览信息。',
      internal_traffic: evidence.internalTraffic || (mountain ? '景区内按体力选择步行、索道或接驳，设备开放情况以现场为准。' : '核心区以步行为主，跨片区时使用官方接驳或公共交通。'),
      tips: '返程班次、末班车和临时交通管制可能变化，出发前在官方渠道复核。',
    },
    housing: evidence.housing || [{ area, desc: resort ? '住在度假区或官方接驳覆盖区域，适合早入园和晚间活动。' : '选择轨道交通便利、与下一日行程衔接顺畅的区域，不必只追求景区门口。' }],
    specialCare: evidence.specialCare || {
      elderly: mountain ? '先确定折返点，台阶路段不勉强；索道、接驳与无障碍设施以现场开放为准。' : '减少连续站立和长距离折返，提前确认无障碍入口、电梯及休息点。',
      children: resort ? '提前核对各项目身高、年龄和健康限制，准备推车并保留午休时间。' : '保持在成人视线内，提前约定集合点；场馆内遵守安检和展陈保护要求。',
    },
  };
}

function jpegDimensions(buffer) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

function imageDimensions(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.slice(0, 2).toString('hex') === 'ffd8') return jpegDimensions(buffer);
  if (buffer.slice(1, 4).toString() === 'PNG') return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  return null;
}

async function ensureVerifiedImage(verified, imageTarget) {
  const validExisting = () => {
    if (!fs.existsSync(imageTarget)) return false;
    const dimensions = imageDimensions(imageTarget);
    return Boolean(dimensions && dimensions.width >= 1200 && dimensions.height >= 700 && fs.statSync(imageTarget).size >= 100 * 1024);
  };
  if (validExisting()) return;
  let backupPath = '';
  if (fs.existsSync(imageTarget)) {
    const backupDir = path.join(runtimeDir, 'backups', 'rejected-images');
    fs.mkdirSync(backupDir, { recursive: true });
    backupPath = path.join(backupDir, `${path.basename(imageTarget)}.${Date.now()}.bak`);
    fs.renameSync(imageTarget, backupPath);
  }
  try {
    await downloadResilient(verified.image.downloadUrl, imageTarget);
    if (!validExisting()) throw new Error('下载后的图片仍未达到 1200x700 和 100KB 门槛');
  } catch (error) {
    if (fs.existsSync(imageTarget)) fs.unlinkSync(imageTarget);
    if (backupPath && fs.existsSync(backupPath)) fs.renameSync(backupPath, imageTarget);
    throw error;
  }
}

function clothing(profile) {
  const common = {
    spring_autumn: '采用轻便分层穿搭，准备薄外套和舒适防滑步行鞋，按天气及时增减。',
    summer: '穿透气速干衣物，准备防晒、补水和便携雨具；室内空调环境另备薄外套。',
    winter: '穿保暖防风外套、长裤和防滑鞋，室内外连续游览时采用便于增减的分层穿搭。',
    tips: '以舒适、防滑和便于长时间步行为先；历史建筑、纪念场馆内保持衣着整洁得体。',
  };
  if (profile === 'mountain') common.tips = '山地台阶、坡道和冬季结冰会增加难度，穿防滑鞋并避免雨雪天勉强攀登。';
  if (profile === 'resort') common.tips = '大型度假区步行量容易被低估，舒适鞋和分层穿搭比造型更重要。';
  return common;
}

function sanitizeLazyText(text) {
  return String(text || '')
    .replace(/(?:上午|中午|下午|晚上|傍晚|夜间)\s*\d+(?:点|时)(?:半|左右)?/g, '当日较合适时段')
    .replace(/\d{1,2}:\d{2}/g, '官方当日建议时段')
    .split(/\n{2,}/)
    .filter(block => !/(\d+(?:\.\d+)?\s*元|你们大概|你们这次|需要我(?:再)?帮你|还可以帮你)/.test(block))
    .join('\n\n')
    .trim();
}

function buildAttraction(workspaceItem, evidence, foods, lazy) {
  const verifiedAt = evidence.verifiedAt || new Date().toISOString().slice(0, 10);
  const firstSource = evidence.sources[0];
  const guide = guideDefaults(evidence);
  return {
    baselineKey: workspaceItem.baselineKey,
    id: workspaceItem.id,
    name: workspaceItem.name,
    city: evidence.city || workspaceItem.city || province,
    rating: Number.isFinite(Number(evidence.rating)) ? Number(evidence.rating) : 0,
    reviewsCount: evidence.reviewsCount || '暂无公开平台评分',
    image: evidence.image.localPath,
    description: evidence.description,
    intro: evidence.intro || workspaceItem.intro,
    level: evidence.level,
    category: evidence.category,
    tags: evidence.tags || [evidence.category, evidence.profile === 'indoor' ? '室内参观' : '城市地标'],
    address: evidence.address || workspaceItem.address,
    openHours: evidence.openHours || '开放日期、预约与入场时段可能动态调整，出发前以景区官方当日公告为准',
    price: evidence.price || '票务、优惠及独立项目价格可能动态调整，以景区官方购票渠道当日公示为准',
    tips: evidence.tips || '先确认预约、开放区域和入场证件；动态信息以官方当日公告为准。',
    profile: evidence.profile || 'urban',
    sources: evidence.sources,
    routes: evidence.routes.map(route => routeDefaults(route, evidence.profile, firstSource)),
    transport: guide.transport,
    housing: guide.housing,
    food: evidence.food || foods,
    specialCare: guide.specialCare,
    lazyTips: evidence.lazyTips || '路线用于降低折返和体力消耗；开放区域、预约、接驳及演出安排以官方当日公告为准。',
    imageSource: {
      title: evidence.image.title,
      author: evidence.image.author,
      provider: evidence.image.provider || 'Wikimedia Commons',
      license: evidence.image.license,
      licenseUrl: evidence.image.licenseUrl,
      sourceUrl: evidence.image.sourceUrl,
      width: evidence.image.width,
      height: evidence.image.height,
    },
    guide_data: {
      clothing: clothing(evidence.profile),
      transport: guide.transport,
      housing: guide.housing,
      food: evidence.food || foods,
      special_care: guide.specialCare,
    },
    lazy_routes: evidence.routes.map(route => ({
      ...routeDefaults(route, evidence.profile, firstSource),
      verifiedAt,
    })),
    lazy_tips: evidence.lazyTips || '路线用于降低折返和体力消耗；开放区域、预约、接驳及演出安排以官方当日公告为准。',
    lazy_ai_text: sanitizeLazyText(lazy.lazy_ai_text),
    lazy_ai_source: lazy.lazy_ai_source,
    quality_policy: { forbiddenTerms: evidence.forbiddenTerms || [] },
    source_evidence: {
      source: '文化和旅游主管部门、景区官方渠道与开放知识库交叉核验',
      basicInfoSources: evidence.sources.map(source => `${source.title}：${source.url}`),
      ratingSource: evidence.ratingSource || null,
      basicInfoUpdatedAt: verifiedAt,
      note: '开放、预约、票价、交通和演出属于动态信息，出发前以官方当日公告为准。',
    },
    image_source: {
      title: evidence.image.title,
      author: evidence.image.author,
      provider: evidence.image.provider || 'Wikimedia Commons',
      license: evidence.image.license,
      licenseUrl: evidence.image.licenseUrl,
      sourceUrl: evidence.image.sourceUrl,
      width: evidence.image.width,
      height: evidence.image.height,
    },
  };
}

function mergeEvidenceItem(automaticValue = {}, manualValue = {}) {
  const merged = { ...automaticValue, ...manualValue };
  merged.image = { ...(automaticValue.image || {}), ...(manualValue.image || {}) };
  // 旧版自动采集没有记录评分来源，不能在覆盖资料缺少评分时悄悄继承。
  // 新版自动评分必须绑定到同一 POI 的 ratingSource；人工资料显式填写的评分优先。
  const manualHasRating = Object.prototype.hasOwnProperty.call(manualValue, 'rating');
  const automaticRatingVerified = Boolean(automaticValue.ratingSource?.url);
  if (!manualHasRating && !automaticRatingVerified) {
    delete merged.rating;
    delete merged.reviewsCount;
    delete merged.ratingSource;
  }
  return merged;
}

async function main() {
  const info = provinceInfo(province);
  if (!info) throw new Error(`无法识别省份：${province}`);
  const workspacePath = path.join(runtimeDir, `core-repair-research.${info.slug}.json`);
  const autoEvidencePath = path.join(runtimeDir, `core-repair-evidence.${info.slug}.auto.json`);
  const manualEvidencePath = path.join(contentDir, `core-repair-evidence.${info.slug}.json`);
  const seedPath = path.join(contentDir, `core-repair-seeds.${info.slug}.json`);
  const reportPath = path.join(reportDir, `core-completion-${info.slug}.json`);
  const progressPath = path.join(runtimeDir, 'province-completion-progress.json');
  const workspace = readJson(workspacePath);
  const automaticEvidence = readJson(autoEvidencePath, { attractions: {} });
  const manualEvidence = useManualEvidence ? readJson(manualEvidencePath, { attractions: {} }) : { attractions: {} };
  const automaticAttractions = automaticEvidence.attractions || {};
  const manualAttractions = manualEvidence.attractions || {};
  const attractionKeys = [...new Set([...Object.keys(automaticAttractions), ...Object.keys(manualAttractions)])];
  const evidence = {
    ...automaticEvidence,
    ...manualEvidence,
    attractions: Object.fromEntries(attractionKeys.map(key => [
      key,
      mergeEvidenceItem(automaticAttractions[key], manualAttractions[key]),
    ])),
    minorNotes: [...new Set([...(automaticEvidence.minorNotes || []), ...(manualEvidence.minorNotes || [])])],
  };
  const evidenceLabel = useManualEvidence && fs.existsSync(manualEvidencePath)
    ? `${path.relative(rootDir, autoEvidencePath)} + ${path.relative(rootDir, manualEvidencePath)}（人工覆盖优先）`
    : path.relative(rootDir, autoEvidencePath);
  const lazyOverrides = {
    ...readJson(path.join(contentDir, 'lazy-guide-overrides.json'), {}),
    ...readJson(path.join(runtimeDir, 'core-lazy-guide-overrides.json'), {}),
  };
  if (!workspace?.attractions?.length) throw new Error('缺少资料研究任务，请先由总控完成核心景点体检。');
  if (!evidence?.attractions || Array.isArray(evidence.attractions) || typeof evidence.attractions !== 'object') {
    throw new Error(`自动核验证据清单结构无效：${evidenceLabel}`);
  }
  const evidenceEntries = Object.entries(evidence.attractions);
  if (!evidenceEntries.length) throw new Error(`自动核验证据清单为空：${evidenceLabel}`);
  const malformedEvidence = evidenceEntries
    .filter(([, item]) => !item || typeof item !== 'object' || !item.city || !item.description || !item.image?.downloadUrl)
    .map(([key]) => key);
  if (malformedEvidence.length) {
    throw new Error(`自动核验证据清单含无效条目：${malformedEvidence.join('、')}`);
  }
  const blockers = [];
  const items = [];
  const foods = (info.data.foods || []).map(item => item.name).filter(Boolean).slice(0, 4);
  writeJsonAtomic(progressPath, { province, stage: 'researching', current: '', completed: 0, total: workspace.attractions.length, updatedAt: new Date().toISOString() });
  for (let index = 0; index < workspace.attractions.length; index += 1) {
    if (fs.existsSync(stopPath)) {
      writeJsonAtomic(progressPath, { province, stage: 'stopped', current: '', completed: index, total: workspace.attractions.length, updatedAt: new Date().toISOString() });
      throw new Error('已按安全停止请求暂停；已完成的图片和资料会在下次复用。');
    }
    const workspaceItem = workspace.attractions[index];
    const verified = evidence.attractions[workspaceItem.baselineKey] || evidence.attractions[workspaceItem.name];
    const lazy = lazyOverrides[workspaceItem.id];
    writeJsonAtomic(progressPath, { province, stage: 'researching', current: workspaceItem.name, completed: index, total: workspace.attractions.length, updatedAt: new Date().toISOString() });
    if (!verified) { blockers.push(`${workspaceItem.name}：没有已核验证据条目`); continue; }
    if (!lazy?.lazy_ai_text || !lazy?.lazy_ai_source) { blockers.push(`${workspaceItem.name}：点点懒人攻略尚未完成`); continue; }
    if (!Array.isArray(verified.sources) || verified.sources.length < 2) { blockers.push(`${workspaceItem.name}：基本资料来源少于2个`); continue; }
    if (!Array.isArray(verified.routes) || verified.routes.length < 2) { blockers.push(`${workspaceItem.name}：可执行路线少于2条`); continue; }
    const imageTarget = path.join(rootDir, verified.image.localPath.replace(/^\//, '').replace(/\//g, path.sep));
    try {
      await ensureVerifiedImage(verified, imageTarget);
      const dimensions = imageDimensions(imageTarget);
      if (!dimensions || dimensions.width < 1200 || dimensions.height < 700) throw new Error(`真实尺寸不足（${dimensions?.width || 0}x${dimensions?.height || 0}）`);
      if (fs.statSync(imageTarget).size < 100 * 1024) throw new Error('图片文件过小');
      verified.image.width = dimensions.width;
      verified.image.height = dimensions.height;
      const item = buildAttraction(workspaceItem, verified, foods, lazy);
      const clean = JSON.parse(JSON.stringify(item));
      delete clean.baselineKey;
      delete clean.quality_policy;
      validateManualAttraction(clean, province);
      items.push(item);
    } catch (error) {
      blockers.push(`${workspaceItem.name}：${error.message}`);
    }
  }
  const report = {
    province,
    generatedAt: new Date().toISOString(),
    total: workspace.attractions.length,
    ready: items.length,
    blockerCount: blockers.length,
    blockers,
    minorNotes: evidence.minorNotes || [],
    policy: '关键字段、两条路线、两个来源和可追溯高清图为硬门槛；动态信息不固化；小问题记录但不阻断。',
  };
  writeJsonAtomic(reportPath, report);
  if (blockers.length) {
    writeJsonAtomic(progressPath, { province, stage: 'blocked', current: '', completed: items.length, total: workspace.attractions.length, blockers, updatedAt: new Date().toISOString() });
    console.log(`${province}完整资料暂未通过：${items.length}/${workspace.attractions.length}。`);
    blockers.forEach(item => console.log(`- ${item}`));
    process.exitCode = 2;
    return;
  }
  writeJsonAtomic(seedPath, { province, verifiedAt: new Date().toISOString().slice(0, 10), policy: report.policy, attractions: items });
  const prepared = spawnSync(process.execPath, [path.join('scripts', 'prepare_core_repair_package.js'), `--province=${province}`], { cwd: rootDir, stdio: 'inherit', shell: false });
  if (prepared.status !== 0) throw new Error('完整补全包生成失败。');
  writeJsonAtomic(progressPath, { province, stage: 'package_ready', current: '', completed: items.length, total: items.length, report: path.relative(rootDir, reportPath).replace(/\\/g, '/'), updatedAt: new Date().toISOString() });
  console.log(`${province}完整资料已备齐：${items.length}/${items.length}；补全包进入质量门禁。`);
}

main().catch(error => {
  console.error(`自动研究失败：${error.message}`);
  process.exitCode = 1;
});
