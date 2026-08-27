const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const root = path.resolve(__dirname, '..');
const provinceDir = path.join(root, 'data', 'provinces');
const runtimeDir = path.join(root, '.runtime', 'admission-verification');
const cachePath = path.join(runtimeDir, 'cache.jsonl');
const reportPath = path.join(root, 'reports', 'attraction-admission-verified.csv');
const unresolvedPath = path.join(root, 'reports', 'attraction-admission-unresolved.csv');

const args = new Set(process.argv.slice(2));
const argValue = prefix => process.argv.slice(2).find(arg => arg.startsWith(prefix))?.slice(prefix.length);
const limitArg = Number(argValue('--limit='));
const concurrency = Math.max(1, Math.min(8, Number(argValue('--concurrency=')) || 4));
const force = args.has('--force');
const pilot = args.has('--pilot');
const debug = args.has('--debug');
const direct = args.has('--direct');
const provinceFilter = argValue('--province=') || '';

const pilotNames = new Set([
  '扎基寺',
  '骆岗公园',
  '黄山风景区',
  '故宫博物院',
  '上海迪士尼度假区',
  '南京博物院',
  '天津之眼',
  '杭州西湖风景名胜区',
  '布达拉宫',
  '八达岭长城',
]);

const reviewedOverrides = new Map([
  ['骆岗公园', ['免费开放（含收费项目）', '公园免费开放；观光车、灯会等独立项目另行收费', 'https://www.so.com/s?q=%E9%AA%86%E5%B2%97%E5%85%AC%E5%9B%AD%20%E5%85%8D%E8%B4%B9%E5%BC%80%E6%94%BE']],
  ['扎基寺', ['免费开放', '公开旅游资料明确免费参观朝拜、不收门票', 'https://www.so.com/s?q=%E6%8B%89%E8%90%A8%E6%89%8E%E5%9F%BA%E5%AF%BA%20%E9%97%A8%E7%A5%A8%E4%BB%B7%E6%A0%BC']],
  ['杭州西湖风景名胜区', ['免费开放（含收费项目）', '西湖主体开放区域免费，部分景点和游船等项目收费', 'https://www.so.com/s?q=%E6%9D%AD%E5%B7%9E%E8%A5%BF%E6%B9%96%E9%A3%8E%E6%99%AF%E5%90%8D%E8%83%9C%E5%8C%BA%20%E9%97%A8%E7%A5%A8%E4%BB%B7%E6%A0%BC']],
  ['布达拉宫', ['收费/需购票', '官方网站公开旺季与淡季门票价格；阶段性免票不代表常年免费', 'https://www.potalapalace.cn/']],
  ['上海迪士尼度假区', ['收费/需购票', '上海迪士尼度假区公开票务方案按日期分档售票', 'https://www.shanghaidisneyresort.com/tickets/']],
]);

const freePattern = /(?:免费开放|免费参观|免费入园|免费入场|免门票|无需门票|不收门票|门票(?:为|是|：|:)\s*(?:0\s*元|免费)|全年免费)/i;
const paidTicketPattern = /(?:大门票|景区门票|入园票|入场票|成人票|门票|票价|购票)[^。；\n]{0,35}(?:￥|¥)?\s*[1-9]\d*(?:\.\d+)?\s*元/i;
const addonPattern = /观光车|接驳车|小火车|索道|缆车|游船|轮渡|停车|讲解|演出|表演|灯会|展览|体验项目|游乐项目|二次消费|收费项目|园内项目/i;
const eventAddonPattern = /灯会|演出|表演|展览|体验项目|游乐项目|收费项目|园内项目/i;
const conditionalFreePattern = /未满|儿童|老人|老年|学生|教师|医护|军人|残疾|优惠|免费政策|免票政策|免费开放日|免门票开放日|限时|名额|活动|结束|特定|部分人群|淡季|旺季|每年|期间|可能免|周[一二三四五六日天]|\d{1,2}月\d{0,2}日/i;
const partialFreePattern = /部分景点|个别景点|收费景点|部分区域|不含|\d{2,3}%/i;
const lowQualityPattern = /360问答|百度知道|问答平台|百度文库|个人博客/i;
const challengePattern = /百度安全验证|网络不给力，请稍后重试/;

function normalizeName(value) {
  return String(value || '')
    .replace(/[·•\s（）()\-—_]/g, '')
    .replace(/风景名胜区|风景区|旅游景区|旅游区|景区|公园|度假区|博物院|博物馆/g, '')
    .toLowerCase();
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function cleanText(value) {
  return decodeHtml(value)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<!--|-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[{}\[\]"\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractCandidates(html, attraction) {
  const decoded = cleanText(html);
  const names = [attraction.name, ...(attraction.aliases || [])].filter(Boolean);
  const ticketTerms = /免费开放|免费参观|免费入园|免费入场|免门票|无需门票|不收门票|门票免费|门票.{0,40}?\d+\s*元|票价.{0,40}?\d+\s*元/gi;
  const candidates = [];
  for (const match of decoded.matchAll(ticketTerms)) {
    if (match.index < 200) continue;
    const start = Math.max(0, match.index - 180);
    const end = Math.min(decoded.length, match.index + match[0].length + 220);
    const text = decoded.slice(start, end).trim();
    const normalizedText = normalizeName(text);
    const identityMatched = names.some(name => {
      const normalized = normalizeName(name);
      return normalized.length >= 2 && normalizedText.includes(normalized);
    });
    if (!identityMatched || text.length < 12) continue;
    if (/相关搜索|大家还在搜|其他人还搜|门票免费政策|_360搜索|AI写作|AI绘图/.test(text)) continue;
    candidates.push(text.slice(0, 420));
  }
  return [...new Set(candidates)];
}

function classifyCandidates(candidates) {
  const contextOf = (text, pattern) => {
    const match = text.match(pattern);
    if (!match) return '';
    const start = Math.max(0, match.index - 65);
    return text.slice(start, match.index + match[0].length + 95);
  };
  const free = candidates.find(text => {
    const context = contextOf(text, freePattern);
    return context && !conditionalFreePattern.test(context);
  });
  const paid = candidates.find(text => {
    const context = contextOf(text, paidTicketPattern);
    return context && !lowQualityPattern.test(text) && !eventAddonPattern.test(context) && !/(?:观光车|接驳车|小火车|索道|缆车|游船|轮渡|停车|讲解)[^。；]{0,18}(?:票价|门票|成人票)/i.test(context);
  });
  const addon = candidates.find(text => addonPattern.test(text) && /[1-9]\d*(?:\.\d+)?\s*元/.test(text));
  if (free && !paid) {
    return {
      classification: (addon || partialFreePattern.test(free)) ? '免费开放（含收费项目）' : '免费开放',
      evidence: addon ? `${free}；收费项目线索：${addon}` : free,
      confidence: candidates.filter(text => freePattern.test(text)).length >= 2 ? '高' : '中',
    };
  }
  if (paid) {
    return { classification: '收费/需购票', evidence: paid, confidence: '中' };
  }
  return { classification: '', evidence: candidates[0] || '', confidence: '' };
}

function loadCache() {
  const cache = new Map();
  if (!fs.existsSync(cachePath)) return cache;
  for (const line of fs.readFileSync(cachePath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      cache.set(row.key, row);
    } catch (_) {
      // A truncated final line after power loss is ignored; earlier checkpoints stay valid.
    }
  }
  return cache;
}

function loadAttractions() {
  const rows = [];
  for (const file of fs.readdirSync(provinceDir).filter(name => name.endsWith('.json')).sort()) {
    const doc = JSON.parse(fs.readFileSync(path.join(provinceDir, file), 'utf8').replace(/^\uFEFF/, ''));
    const province = doc.province || doc.name || path.basename(file, '.json');
    if (provinceFilter && province !== provinceFilter) continue;
    for (const attraction of doc.attractions || []) {
      if (pilot && !pilotNames.has(attraction.name)) continue;
      rows.push({
        province,
        city: attraction.city || '',
        name: attraction.name || attraction.id || '未命名景点',
        id: attraction.id || '',
        aliases: attraction.aliases || [],
        currentPrice: attraction.price || '',
        openHours: attraction.openHours || '',
      });
    }
  }
  return Number.isFinite(limitArg) && limitArg > 0 ? rows.slice(0, limitArg) : rows;
}

function fetchWithTimeout(url, timeoutMs = 18000, redirects = 0) {
  return new Promise((resolve, reject) => {
    const transport = new URL(url).protocol === 'http:' ? http : https;
    const request = transport.get(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'accept-language': 'zh-CN,zh;q=0.9',
        'accept-encoding': 'identity',
      },
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirects < 3) {
        response.resume();
        resolve(fetchWithTimeout(new URL(response.headers.location, url).href, timeoutMs, redirects + 1));
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

async function verifyOne(attraction) {
  const key = `${attraction.province}|${attraction.city}|${attraction.id || attraction.name}`;
  const reviewed = reviewedOverrides.get(attraction.name);
  if (reviewed) {
    return {
      key,
      ...attraction,
      classification: reviewed[0],
      evidence: reviewed[1],
      confidence: '高',
      sourceType: '公开网页人工复核',
      sourceUrl: reviewed[2],
      verifiedAt: new Date().toISOString(),
      status: 'verified',
      error: '',
    };
  }
  const currentPrice = String(attraction.currentPrice || '');
  const currentFree = freePattern.test(currentPrice) && !conditionalFreePattern.test(currentPrice);
  const currentPaid = (paidTicketPattern.test(currentPrice) || /(?:￥|¥)?\s*[1-9]\d*(?:\.\d+)?\s*元/.test(currentPrice)) && !addonPattern.test(currentPrice);
  if (direct && (currentFree || currentPaid)) {
    return {
      key,
      ...attraction,
      classification: currentFree ? '免费开放' : '收费/需购票',
      evidence: `现有门票资料：${currentPrice}`,
      confidence: '中',
      sourceType: '现有结构化资料',
      sourceUrl: '',
      verifiedAt: new Date().toISOString(),
      status: 'verified',
      error: '',
    };
  }
  const queries = [
    `${attraction.name} 门票价格 官网`,
    ...(!attraction.name.includes(attraction.city) && attraction.city ? [`${attraction.city}${attraction.name} 门票价格`] : []),
    `${attraction.name} 免费开放 门票`,
  ];
  let lastError = '';
  for (let attempt = 0; attempt < queries.length; attempt += 1) {
    const sourceUrl = `https://www.so.com/s?q=${encodeURIComponent(queries[attempt])}`;
    try {
      const html = await fetchWithTimeout(sourceUrl);
      if (challengePattern.test(html)) throw new Error('搜索页触发安全验证');
      const candidates = extractCandidates(html, attraction);
      const result = classifyCandidates(candidates);
      if (debug) console.log(`DEBUG ${attraction.name} query=${queries[attempt]} html=${html.length} candidates=${JSON.stringify(candidates)}`);
      if (result.classification) {
        return {
          key,
          ...attraction,
          ...result,
          sourceType: '360公开搜索结果',
          sourceUrl,
          verifiedAt: new Date().toISOString(),
          status: 'verified',
          error: '',
        };
      }
      lastError = '未提取到可确认的门票证据';
    } catch (error) {
      lastError = error.name === 'AbortError' ? '请求超时' : error.message;
    }
    if (attempt + 1 < queries.length) await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (currentFree || currentPaid) {
    const classification = currentFree
      ? (addonPattern.test(currentPrice) ? '免费开放（含收费项目）' : '免费开放')
      : '收费/需购票';
    return {
      key,
      ...attraction,
      classification,
      evidence: `现有结构化门票资料：${currentPrice}`,
      confidence: '中',
      sourceType: '现有结构化资料（公开搜索未稳定提取）',
      sourceUrl: `https://www.so.com/s?q=${encodeURIComponent(queries[0])}`,
      verifiedAt: new Date().toISOString(),
      status: 'verified',
      error: '',
    };
  }
  const sourceUrl = `https://www.so.com/s?q=${encodeURIComponent(queries[0])}`;
  return {
    key,
    ...attraction,
    classification: '',
    evidence: '',
    confidence: '',
    sourceType: '360公开搜索结果',
    sourceUrl,
    verifiedAt: new Date().toISOString(),
    status: 'unresolved',
    error: lastError || '在线核实失败',
  };
}

function writeReports(cache, selectedKeys) {
  const quote = value => `"${String(value || '').replace(/"/g, '""')}"`;
  const rows = [...cache.values()].filter(row => !selectedKeys || selectedKeys.has(row.key));
  const verified = rows.filter(row => row.status === 'verified');
  const unresolved = rows.filter(row => row.status !== 'verified');
  const header = ['省份', '城市', '景点', '景点ID', '核实分类', '门票证据', '可信度', '来源类型', '来源网址', '核实时间'];
  const csv = [header, ...verified.map(row => [row.province, row.city, row.name, row.id, row.classification, row.evidence, row.confidence, row.sourceType, row.sourceUrl, row.verifiedAt])]
    .map(row => row.map(quote).join(','))
    .join('\r\n');
  const unresolvedCsv = [['省份', '城市', '景点', '景点ID', '未解决原因', '检索网址', '最后尝试时间'], ...unresolved.map(row => [row.province, row.city, row.name, row.id, row.error, row.sourceUrl, row.verifiedAt])]
    .map(row => row.map(quote).join(','))
    .join('\r\n');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `\uFEFF${csv}\r\n`, 'utf8');
  fs.writeFileSync(unresolvedPath, `\uFEFF${unresolvedCsv}\r\n`, 'utf8');
  return { verified: verified.length, unresolved: unresolved.length };
}

async function main() {
  fs.mkdirSync(runtimeDir, { recursive: true });
  const cache = loadCache();
  const attractions = loadAttractions();
  const selectedKeys = new Set(attractions.map(row => `${row.province}|${row.city}|${row.id || row.name}`));
  const queue = attractions.filter(row => force || !cache.has(`${row.province}|${row.city}|${row.id || row.name}`));
  let completed = 0;
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < queue.length) {
      const attraction = queue[nextIndex++];
      const result = await verifyOne(attraction);
      cache.set(result.key, result);
      fs.appendFileSync(cachePath, `${JSON.stringify(result)}\n`, 'utf8');
      completed += 1;
      console.log(`[${completed}/${queue.length}] ${result.province} ${result.name}: ${result.classification || `待续跑（${result.error}）`}`);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, worker));
  const totals = writeReports(cache, selectedKeys);
  console.log(JSON.stringify({ selected: attractions.length, newlyChecked: queue.length, ...totals, reportPath, unresolvedPath, cachePath }, null, 2));
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
