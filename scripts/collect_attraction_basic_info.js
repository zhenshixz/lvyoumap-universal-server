const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { sameAttraction, normalizeName } = require('./core_candidate_quality');

const execFileAsync = promisify(execFile);

const root = path.resolve(__dirname, '..');
const provinceDir = path.join(root, 'data', 'provinces');
const runtimeDir = path.join(root, '.runtime', 'attraction-basic-info');
const eventPath = path.join(runtimeDir, 'events.jsonl');
const manifestPath = path.join(runtimeDir, 'manifest.json');
const reportPath = path.join(root, 'reports', 'attraction-admission-final.csv');
const actionListPath = path.join(root, 'reports', 'attraction-key-info-final-action-list.csv');
const args = new Map(process.argv.slice(2).map(arg => {
  const match = arg.match(/^--([^=]+)=(.*)$/);
  return match ? [match[1], match[2]] : [arg.replace(/^--/, ''), true];
}));
const refresh = args.has('refresh');
const limit = Math.max(0, Number(args.get('limit') || 0));
const concurrency = Math.max(1, Math.min(12, Number(args.get('concurrency') || 8)));
const amapDelayMs = Math.max(180, Number(args.get('amap-delay') || 260));
const searchDelayMs = Math.max(180, Number(args.get('search-delay') || 300));

function loadLocalEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^(?:"(.*)"|'(.*)')$/, '$1$2').trim();
  }
}

loadLocalEnv(path.join(root, '.env'));
const amapKey = String(process.env.AMAP_WEB_SERVICE_KEY || '').trim();

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

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += char;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  const header = (rows.shift() || []).map(value => value.replace(/^\uFEFF/, ''));
  return rows.filter(values => values.some(Boolean)).map(values => Object.fromEntries(header.map((name, index) => [name, values[index] || ''])));
}

function cleanString(value) {
  if (Array.isArray(value)) return value.map(cleanString).filter(Boolean).join(';');
  if (value && typeof value === 'object') return '';
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function hasConcreteHours(value) {
  const text = cleanString(value);
  return /\d{1,2}[:：]\d{2}|全天开放|24\s*小时/.test(text);
}

function hasConcreteAddress(value) {
  const text = cleanString(value);
  return text.length >= 4 && !/^(?:详见|景区定位|以景区|以官方|暂无|未公开)/.test(text);
}

function hasConcretePhone(value) {
  return /\d{5,}/.test(cleanString(value).replace(/[\s-]/g, ''));
}

const explicitFreePattern = /免费开放|免费参观|免费入园|免费入场|免门票|无需门票|不收门票|门票(?:为|是|：|:)\s*(?:0\s*元|免费)|全年免费/i;
const explicitPaidPattern = /(?:大门票|景区门票|入园票|入场票|成人票|全价票|门票|票价)[^。；\n]{0,55}(?:￥|¥)?\s*[1-9]\d*(?:\.\d+)?\s*元/i;

function hasConcretePrice(value, classification) {
  const text = cleanString(value);
  if (!text) return false;
  if (classification.startsWith('免费开放')) return explicitFreePattern.test(text);
  const candidates = text.match(new RegExp(explicitPaidPattern.source, 'gi')) || [];
  return candidates.some(candidate => !/(?:优惠|半价|老人|老年|儿童|学生|未成年|意外险|观光车|索道|缆车|游船|停车|联票|套票|套餐)/.test(candidate));
}

function requestText(url, timeoutMs = 15000, redirects = 0, requestHeaders = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'http:' ? http : https;
    const request = transport.get(target, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'accept-language': 'zh-CN,zh;q=0.9',
        'accept-encoding': 'identity',
        ...requestHeaders,
      },
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirects < 3) {
        response.resume();
        resolve(requestText(new URL(response.headers.location, target).href, timeoutMs, redirects + 1, requestHeaders));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      response.setEncoding('utf8');
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve(body));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('请求超时')));
    request.on('error', reject);
  });
}

async function requestJson(url, attempts = 2) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return JSON.parse(await requestText(url));
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 500 * attempt));
    }
  }
  throw lastError;
}

function createRequestGate(delayMs) {
  let nextAt = 0;
  let chain = Promise.resolve();
  return async function waitForTurn() {
    const turn = chain.then(async () => {
      const waitMs = Math.max(0, nextAt - Date.now());
      if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
      nextAt = Date.now() + delayMs;
    });
    chain = turn.catch(() => {});
    await turn;
  };
}

const waitForAmap = createRequestGate(amapDelayMs);
const waitForSearch = createRequestGate(searchDelayMs);
let amapQuotaExhausted = false;

async function requestAmapJson(url, attempts = 5) {
  let lastResult = null;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await waitForAmap();
    try {
      const result = await requestJson(url, 1);
      lastResult = result;
      if (String(result.status) === '1') return result;
      const code = `${result.info || ''}|${result.infocode || ''}`;
      if (/USER_DAILY_QUERY_OVER_LIMIT|DAILY_QUERY_OVER_LIMIT/i.test(code)) {
        amapQuotaExhausted = true;
        return result;
      }
      if (!/CUQPS|频率|TOO_FAST|LIMIT/i.test(code)) return result;
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) {
      await new Promise(resolve => setTimeout(resolve, 600 * attempt + Math.floor(Math.random() * 250)));
    }
  }
  if (lastResult) return lastResult;
  throw lastError || new Error('高德请求失败');
}

function amapUrl(endpoint, parameters) {
  const url = new URL(endpoint);
  url.searchParams.set('key', amapKey);
  for (const [key, value] of Object.entries(parameters)) if (value) url.searchParams.set(key, value);
  return url.toString();
}

function amapIdentityMatches(attraction, poi, trustedId = false) {
  const poiCity = cleanString(poi.cityname || poi.city || attraction.city);
  const poiName = cleanString(poi.name).replace(/\((?:暂停开放|临时关闭|已关闭)\)$/i, '');
  return trustedId
    ? sameAttraction(attraction.name, poiName)
    : sameAttraction(attraction.name, poiName, attraction.city, poiCity);
}

function extractAmapPoiId(attraction) {
  const direct = String(attraction.id || '').match(/^amap_([A-Z0-9]+)$/i);
  if (direct) return direct[1];
  const evidenceId = cleanString(attraction.source_evidence?.poiId);
  if (/^[A-Z0-9]{6,}$/i.test(evidenceId)) return evidenceId;
  const evidenceText = JSON.stringify(attraction.source_evidence || {});
  const urlId = evidenceText.match(/amap\.com\/(?:place\/)?([A-Z0-9]{6,})/i);
  return urlId ? urlId[1] : '';
}

async function collectAmap(attraction, needs) {
  if (!amapKey) return { values: {}, sources: [], warning: '未配置高德 Key' };
  let poiId = extractAmapPoiId(attraction);
  let trustedId = Boolean(poiId);
  if (poiId) {
    const v3 = await requestAmapJson(amapUrl('https://restapi.amap.com/v3/place/detail', { id: poiId, extensions: 'all' }));
    if (String(v3.status) !== '1') throw new Error(`高德 v3：${v3.info || v3.infocode || '请求失败'}`);
    const poi = (v3.pois || []).find(candidate => amapIdentityMatches(attraction, candidate, true));
    if (!poi) throw new Error(`高德 POI 身份不一致：${cleanString(v3.pois?.[0]?.name) || '无结果'}`);
    if (cleanString(poi.id) && cleanString(poi.id).toUpperCase() !== poiId.toUpperCase()) {
      throw new Error(`高德 POI ID 不一致：${cleanString(poi.id)}`);
    }
    return {
      values: {
        address: cleanString(poi.address),
        tel: cleanString(poi.tel),
        openHours: cleanString(poi.biz_ext?.opentime2 || poi.biz_ext?.open_time || poi.biz_ext?.opentime),
      },
      sources: [{ type: 'amap', title: `高德地图 ${cleanString(poi.name)}`, url: `https://www.amap.com/place/${encodeURIComponent(poiId)}` }],
      warning: '',
    };
  }
  let v5;
  v5 = await requestAmapJson(amapUrl('https://restapi.amap.com/v5/place/text', {
    keywords: attraction.name,
    region: attraction.city,
    city_limit: attraction.city ? 'true' : '',
    page_size: '10',
    show_fields: 'business',
  }));
  if (String(v5.status) !== '1') throw new Error(`高德 v5：${v5.info || v5.infocode || '请求失败'}`);
  const poi = (v5.pois || []).find(candidate => amapIdentityMatches(attraction, candidate, trustedId));
  if (!poi) throw new Error(`高德 POI 身份不一致：${cleanString(v5.pois?.[0]?.name) || '无结果'}`);
  if (trustedId && cleanString(poi.id) && cleanString(poi.id).toUpperCase() !== poiId.toUpperCase()) {
    throw new Error(`高德 POI ID 不一致：${cleanString(poi.id)}`);
  }
  poiId ||= cleanString(poi.id);
  const values = {};
  values.address = cleanString(poi.address);
  values.tel = cleanString(poi.business?.tel || poi.tel);
  values.openHours = cleanString(poi.business?.opentime_week || poi.business?.opentime_today);
  let warning = '';
  const needsV3 = (needs.tel && !values.tel) || (needs.openHours && !values.openHours) || (needs.address && !values.address);
  if (poiId && needsV3) {
    try {
      const v3 = await requestAmapJson(amapUrl('https://restapi.amap.com/v3/place/detail', { id: poiId, extensions: 'all' }));
      if (String(v3.status) === '1' && v3.pois?.[0] && amapIdentityMatches(attraction, v3.pois[0], true)) {
        const oldPoi = v3.pois[0];
        values.tel ||= cleanString(oldPoi.tel);
        values.openHours ||= cleanString(oldPoi.biz_ext?.opentime2 || oldPoi.biz_ext?.open_time || oldPoi.biz_ext?.opentime);
        values.address ||= cleanString(oldPoi.address);
      }
    } catch (error) {
      warning = `高德 v3 补充请求失败，已保留 v5 结果：${error.message}`;
    }
  }
  return {
    values,
    sources: [{ type: 'amap', title: `高德地图 ${cleanString(poi.name)}`, url: `https://www.amap.com/place/${encodeURIComponent(poiId)}` }],
    warning,
  };
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

function ticketEvidence(text, attraction) {
  const normalizedTarget = normalizeName(attraction.name);
  const normalizedCity = normalizeName(attraction.city);
  const pattern = /(?:大门票|景区门票|入园票|入场票|成人票|全价票|门票价格|门票|票价)[^。；\n]{0,45}(?:￥|¥)?\s*[1-9]\d*(?:\.\d+)?\s*元[^。；\n]{0,35}/gi;
  const candidates = [];
  for (const match of text.matchAll(pattern)) {
    if (match.index < 200) continue;
    const start = Math.max(0, match.index - 220);
    const end = Math.min(text.length, match.index + match[0].length + 130);
    const context = text.slice(start, end);
    if (!normalizeName(context).includes(normalizedTarget)) continue;
    if (/360问答|百度知道|百度文库|个人博客/.test(context)) continue;
    if (/(?:灯会|演出|表演|索道|缆车|观光车|游船|停车)[^。；]{0,25}(?:门票|票价|成人票)/.test(context)) continue;
    if (/(?:优惠|半价|老人|老年|儿童|学生|未成年|意外险|联票|套票|套餐)[^。；]{0,35}(?:￥|¥)?\s*[1-9]\d*(?:\.\d+)?\s*元/.test(match[0])) continue;
    const statement = match[0].replace(/\s+/g, ' ').trim();
    const priceCount = (statement.match(/\d+(?:\.\d+)?\s*元/g) || []).length;
    if (statement.length > 96 || priceCount > 2) continue;
    if (/(?:\d+\s*元?\s*(?:至|到|[-~～])\s*\d+\s*元|森林竞速|赛车|碰碰车|电瓶车|自行车|高架车|飞椅|套餐)/.test(statement)) continue;
    let score = 1;
    if (/\.gov\.cn|政府|管委会|官方网站|官网/.test(context)) score += 5;
    if (/you\.ctrip\.com|ly\.com|本地宝/.test(context)) score += 2;
    if (/2026年|2025年/.test(context)) score += 1;
    if (/202[0-3]年/.test(context)) score -= 2;
    if (normalizedCity && !normalizedTarget.includes(normalizedCity) && !normalizeName(context).includes(normalizedCity) && score < 6) continue;
    const explicitGeneralTicket = /(?:成人票|成人门票|全价票|大门票|景区门票|入园票|入场票)/.test(statement);
    if (!explicitGeneralTicket && score < 6) continue;
    if (score < 3) continue;
    candidates.push({ statement, context, score });
  }
  return candidates.sort((left, right) => right.score - left.score)[0] || null;
}

async function collectTicket(attraction) {
  const query = `${attraction.city || ''} ${attraction.name} 成人门票 价格 元 官网`.trim();
  const url = `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`;
  await waitForSearch();
  let html = '';
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const curl = process.platform === 'win32' ? 'curl.exe' : 'curl';
      const response = await execFileAsync(curl, [
        '-sS', '-L', '--max-time', '18', '--compressed',
        '-A', 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Mobile Safari/537.36',
        '-H', 'Accept-Language: zh-CN,zh;q=0.9',
        url,
      ], { windowsHide: true, maxBuffer: 12 * 1024 * 1024, timeout: 22000 });
      html = response.stdout;
      if (!/安全验证|访问异常|请输入验证码|Too Many Requests/i.test(html)) break;
      throw new Error('搜索页触发安全验证');
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 800 * attempt));
    }
  }
  if (!html || /安全验证|访问异常|请输入验证码|Too Many Requests/i.test(html)) throw lastError || new Error('搜索页不可用');
  const evidence = ticketEvidence(htmlToText(html), attraction);
  if (!evidence) return { value: '', sources: [{ type: 'search', title: '公开搜索', url }], warning: '未找到与景点实体同条展示的明确成人门票' };
  return {
    value: `${evidence.statement.replace(/[；;，,。\s]*$/, '')}；票价可能动态调整，以景区官方购票渠道当日公示为准`,
    sources: [{ type: 'search', title: '公开搜索摘要', url }],
    warning: evidence.score < 3 ? '票价来自普通公开摘要，写入前需重点抽查' : '',
  };
}

function loadCompletedEvents() {
  const completed = new Map();
  if (!fs.existsSync(eventPath)) return completed;
  for (const line of fs.readFileSync(eventPath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event?.key) completed.set(event.key, event);
    } catch (_) {}
  }
  return completed;
}

function loadTargets() {
  const classifications = new Map(parseCsv(fs.readFileSync(reportPath, 'utf8')).map(row => [row['景点ID'], row]));
  const actions = new Map(parseCsv(fs.readFileSync(actionListPath, 'utf8')).map(row => [row['景点ID'], row]));
  const targets = [];
  for (const file of fs.readdirSync(provinceDir).filter(name => name.endsWith('.json')).sort()) {
    const slug = path.basename(file, '.json');
    const doc = readJson(path.join(provinceDir, file), {});
    const province = doc.province || doc.name || slug;
    for (const attraction of doc.attractions || []) {
      const actionRow = actions.get(attraction.id);
      if (!actionRow) continue;
      const classificationRow = classifications.get(attraction.id) || {};
      const classification = actionRow['免费或收费'] || classificationRow['开放属性'] || '收费/需购票';
      const required = cleanString(actionRow['必须补充']);
      const standardize = cleanString(actionRow['可标准化']);
      const requestedFields = {
        address: required.includes('补具体地址'),
        openHours: required.includes('补开放时间'),
        tel: required.includes('补公开电话'),
        price: required.includes('补门票参考') || standardize.includes('规范为免费开放'),
      };
      const needs = {
        address: requestedFields.address && !hasConcreteAddress(attraction.address),
        openHours: requestedFields.openHours && !hasConcreteHours(attraction.openHours),
        tel: requestedFields.tel && !hasConcretePhone(attraction.tel),
        price: requestedFields.price && !hasConcretePrice(attraction.price, classification),
      };
      targets.push({ province, slug, attraction, classification, classificationRow, actionRow, requestedFields, needs });
    }
  }
  return limit ? targets.slice(0, limit) : targets;
}

async function collectOne(target, previous = null) {
  const { province, slug, attraction, classification, classificationRow, actionRow, requestedFields, needs } = target;
  const key = `${slug}|${attraction.id}`;
  const before = {
    address: cleanString(attraction.address),
    openHours: cleanString(attraction.openHours),
    tel: cleanString(attraction.tel),
    price: cleanString(attraction.price),
  };
  const after = { ...before, ...(previous?.after || {}) };
  const effectiveNeeds = Object.fromEntries(Object.entries(needs).map(([field, needed]) => [
    field,
    needed && !(previous?.changedFields || []).includes(field),
  ]));
  const sources = [...(previous?.sources || [])];
  const warnings = (previous?.warnings || []).filter(value => !/USER_DAILY_QUERY_OVER_LIMIT|CUQPS|请求超时|搜索页触发安全验证/.test(value));
  let amap = { values: {}, sources: [], warning: '' };
  if (effectiveNeeds.address || effectiveNeeds.openHours || effectiveNeeds.tel) {
    try { amap = await collectAmap(attraction, effectiveNeeds); }
    catch (error) { warnings.push(error.message); }
    sources.push(...amap.sources);
    if (amap.warning) warnings.push(amap.warning);
    if (effectiveNeeds.address && hasConcreteAddress(amap.values.address)) after.address = amap.values.address;
    if (effectiveNeeds.openHours && hasConcreteHours(amap.values.openHours)) after.openHours = amap.values.openHours;
    if (effectiveNeeds.tel && hasConcretePhone(amap.values.tel)) after.tel = amap.values.tel;
  }
  if (effectiveNeeds.price) {
    if (classification === '免费开放') {
      after.price = '免费开放；预约、限流及临时开放安排以景区官方公告为准';
      sources.push({ type: 'classification', title: classificationRow['依据类型'] || '开放属性审查', url: classificationRow['来源网址'] || '' });
    } else if (classification === '免费开放（含收费项目）') {
      after.price = '主体区域免费开放；园内交通、演出或体验项目可能另行收费，以现场公示为准';
      sources.push({ type: 'classification', title: classificationRow['依据类型'] || '开放属性审查', url: classificationRow['来源网址'] || '' });
    } else {
      try {
        const ticket = await collectTicket(attraction);
        sources.push(...ticket.sources);
        if (ticket.value) after.price = ticket.value;
        if (ticket.warning) warnings.push(ticket.warning);
      } catch (error) {
        warnings.push(`门票采集失败：${error.message}`);
      }
    }
  }
  const changedFields = Object.keys(after).filter(field => after[field] && after[field] !== before[field]);
  const unresolvedFields = Object.entries(needs).filter(([field, needed]) => needed && !changedFields.includes(field)).map(([field]) => field);
  const retainedFields = Object.entries(requestedFields)
    .filter(([field, requested]) => requested && !needs[field] && !changedFields.includes(field))
    .map(([field]) => field);
  const hasRequestedChanges = changedFields.length > 0;
  const status = unresolvedFields.length
    ? (hasRequestedChanges ? 'partial' : 'unresolved')
    : (hasRequestedChanges ? 'ready' : 'retained');
  return {
    key,
    province,
    slug,
    id: attraction.id,
    name: attraction.name,
    city: attraction.city || '',
    classification,
    before,
    after,
    requestedFields: Object.keys(requestedFields).filter(field => requestedFields[field]),
    changedFields,
    unresolvedFields,
    retainedFields,
    action: {
      required: cleanString(actionRow['必须补充']),
      standardize: cleanString(actionRow['可标准化']),
    },
    sources: [...new Map(sources.filter(source => source?.title).map(source => [`${source.title}|${source.url}`, source])).values()],
    warnings: [...new Set(warnings.filter(Boolean))],
    status,
    collectedAt: new Date().toISOString(),
  };
}

async function main() {
  if (!fs.existsSync(reportPath)) throw new Error('缺少开放属性最终清单，请先生成审查报告。');
  if (!fs.existsSync(actionListPath)) throw new Error('缺少用户确认的行动清单，采集已停止。');
  if (!amapKey) throw new Error('AMAP_WEB_SERVICE_KEY 未配置，无法采集基本信息。');
  fs.mkdirSync(runtimeDir, { recursive: true });
  if (refresh && fs.existsSync(eventPath)) fs.unlinkSync(eventPath);
  const targets = loadTargets();
  const completed = refresh ? new Map() : loadCompletedEvents();
  const queue = targets.filter(target => {
    const previous = completed.get(`${target.slug}|${target.attraction.id}`);
    if (!previous) return true;
    if (['ready', 'retained'].includes(previous.status)) return false;
    return (previous.warnings || []).some(value => /USER_DAILY_QUERY_OVER_LIMIT|CUQPS|请求超时|搜索页触发安全验证/.test(value));
  });
  let nextIndex = 0;
  let newlyCompleted = 0;
  let lastPrint = 0;
  async function worker() {
    while (nextIndex < queue.length) {
      if (amapQuotaExhausted) return;
      const target = queue[nextIndex++];
      const key = `${target.slug}|${target.attraction.id}`;
      const result = await collectOne(target, completed.get(key));
      completed.set(result.key, result);
      fs.appendFileSync(eventPath, `${JSON.stringify(result)}\n`, 'utf8');
      newlyCompleted += 1;
      if (newlyCompleted - lastPrint >= 25 || newlyCompleted === queue.length) {
        lastPrint = newlyCompleted;
        const ready = [...completed.values()].filter(item => item.status === 'ready').length;
        const partial = [...completed.values()].filter(item => item.status === 'partial').length;
        console.log(`[${newlyCompleted}/${queue.length}] 已采集：新增完整 ${ready}，部分 ${partial}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, worker));
  const items = targets.map(target => completed.get(`${target.slug}|${target.attraction.id}`)).filter(Boolean);
  const summary = {
    targets: targets.length,
    completed: items.length,
    ready: items.filter(item => item.status === 'ready').length,
    retained: items.filter(item => item.status === 'retained').length,
    partial: items.filter(item => item.status === 'partial').length,
    unresolved: items.filter(item => item.status === 'unresolved').length,
    proposedFields: Object.fromEntries(['address', 'openHours', 'tel', 'price'].map(field => [field, items.filter(item => item.changedFields.includes(field)).length])),
    remainingFields: Object.fromEntries(['address', 'openHours', 'tel', 'price'].map(field => [field, items.filter(item => item.unresolvedFields.includes(field)).length])),
  };
  const manifest = { version: 1, status: amapQuotaExhausted ? 'paused_quota' : 'collected', generatedAt: new Date().toISOString(), summary, items };
  writeJsonAtomic(manifestPath, manifest);
  console.log(JSON.stringify({ ...summary, manifestPath }, null, 2));
  if (amapQuotaExhausted) throw new Error('高德当日额度已耗尽，已保存断点并暂停。');
}

main().catch(error => {
  console.error(`全国基本信息采集失败：${error.message}`);
  process.exitCode = 1;
});
