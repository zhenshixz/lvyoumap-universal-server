const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { normalizeName } = require('./core_candidate_quality');

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, '..');
const runtimeDir = path.join(root, '.runtime', 'attraction-basic-info');
const manifestPath = path.join(runtimeDir, 'manifest.json');
const eventPath = path.join(runtimeDir, 'secondary-events.jsonl');
const args = new Map(process.argv.slice(2).map(value => {
  const match = value.match(/^--([^=]+)=(.*)$/);
  return match ? [match[1], match[2]] : [value.replace(/^--/, ''), true];
}));
const concurrency = Math.max(1, Math.min(10, Number(args.get('concurrency') || 6)));
const limit = Math.max(0, Number(args.get('limit') || 0));
const refresh = args.has('refresh');
const fieldLabels = { address: '地址', openHours: '开放时间', tel: '联系电话', price: '门票价格' };

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function writeJsonAtomic(filePath, value) {
  const temp = `${filePath}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\r\n`, 'utf8');
  fs.renameSync(temp, filePath);
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&apos;|&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ').trim();
}

async function curl(url) {
  const binary = process.platform === 'win32' ? 'curl.exe' : 'curl';
  const result = await execFileAsync(binary, [
    '-sS', '-L', '--max-time', '18', '--compressed',
    '-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
    '-H', 'Accept-Language: zh-CN,zh;q=0.9', url,
  ], { windowsHide: true, timeout: 22000, maxBuffer: 12 * 1024 * 1024 });
  return result.stdout;
}

function parseRss(xml) {
  return [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(match => {
    const block = match[1];
    const read = tag => decodeHtml(block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1]);
    return { title: read('title'), url: read('link'), text: read('description') };
  }).filter(item => item.title && /^https?:\/\//i.test(item.url));
}

function sourceScore(result, item) {
  const url = result.url.toLowerCase();
  const text = `${result.title} ${result.text}`;
  const normalizedText = normalizeName(text);
  const target = normalizeName(item.name);
  if (!target || !normalizedText.includes(target)) return -10;
  let score = 3;
  if (/\.gov\.cn(?:\/|$)|mct\.gov\.cn/.test(url)) score += 7;
  else if (/official|官网|官方网站|管委会|文旅|旅游局/.test(text)) score += 5;
  else if (/baike\.baidu\.com|wikipedia\.org|baike\.com/.test(url)) score += 4;
  else if (/ctrip\.com|trip\.com|ly\.com|qunar\.com|mafengwo\.cn|tripadvisor\.|dianping\.com|meituan\.com|fliggy\.com|tuniu\.com|bendibao\.com/.test(url)) score += 3;
  const city = normalizeName(item.city);
  const province = normalizeName(item.province);
  if (city && normalizedText.includes(city)) score += 2;
  else if (province && normalizedText.includes(province)) score += 1;
  if (/百度知道|百度文库|个人博客|百家号/.test(text)) score -= 4;
  return score;
}

function sentenceAround(text, index, radius = 90) {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

function extractPhone(text) {
  const match = text.match(/(?:咨询电话|景区电话|联系电话|客服电话|服务热线|电话)\s*[：:]?\s*((?:400[-\s]?\d{3}[-\s]?\d{4})|(?:0\d{2,3}[-\s]?\d{7,8})(?:[、;,；]\s*(?:0\d{2,3}[-\s]?\d{7,8}))?)/);
  return match ? match[1].replace(/\s+/g, '') : '';
}

function extractHours(text) {
  const patterns = [
    /(?:开放时间|营业时间|开园时间|入园时间)\s*[：:]?\s*([^。；]{0,90}?\d{1,2}[:：]\d{2}\s*(?:[-—~～至到]\s*\d{1,2}[:：]\d{2})[^。；]{0,45})/,
    /((?:周[一二三四五六日天](?:至周[一二三四五六日天])?[^。；]{0,35})?\d{1,2}[:：]\d{2}\s*(?:[-—~～至到]\s*\d{1,2}[:：]\d{2})[^。；]{0,35})/,
    /(?:开放时间|营业时间)\s*[：:]?\s*((?:全天|全年)开放|24\s*小时开放)/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].replace(/\s+/g, ' ').trim();
  }
  return '';
}

function extractAddress(text) {
  const match = text.match(/(?:景区地址|详细地址|地址)\s*[：:]\s*([^。；|]{5,70})/);
  if (!match) return '';
  const value = match[1].replace(/(?:开放时间|营业时间|联系电话|电话).*$/, '').trim();
  return /(?:省|市|县|区|镇|乡|街|路|大道|巷|村|景区|公园)/.test(value) ? value : '';
}

function extractPrice(text) {
  if (/(?:门票|入园|入场)[^。；]{0,28}(?:免费|0\s*元)|免费开放|无需门票|免门票/.test(text)) {
    return '免费开放；预约、限流及临时开放安排以景区官方公告为准';
  }
  const patterns = [
    /((?:成人票|成人门票|全价票|景区门票|大门票|入园票|入场票)\s*(?:价格|票价)?\s*[：:]?\s*(?:￥|¥)?\s*[1-9]\d*(?:\.\d+)?\s*元(?:\/人)?)/,
    /((?:门票价格|票价)\s*[：:]?\s*(?:￥|¥)?\s*[1-9]\d*(?:\.\d+)?\s*元(?:\/人)?)/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const context = sentenceAround(text, match.index, 70);
    if (/(?:儿童|学生|老人|老年|半价|优惠|索道|缆车|观光车|游船|停车|保险|联票|套票|套餐|起)/.test(match[1])) continue;
    if (/(?:儿童|学生|老人|老年)[^。；]{0,22}(?:票价|价格|门票)/.test(context)) continue;
    return `${match[1].replace(/\s+/g, ' ').trim()}；票价可能动态调整，以景区官方购票渠道当日公示为准`;
  }
  return '';
}

function extractFields(result, item) {
  const text = `${result.title}。${result.text}`;
  const values = {};
  for (const field of item.unresolvedFields || []) {
    if (field === 'address') values.address = extractAddress(text);
    else if (field === 'openHours') values.openHours = extractHours(text);
    else if (field === 'tel') values.tel = extractPhone(text);
    else if (field === 'price') values.price = extractPrice(text);
  }
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value));
}

function previousEvents() {
  const map = new Map();
  if (refresh || !fs.existsSync(eventPath)) return map;
  for (const line of fs.readFileSync(eventPath, 'utf8').split(/\r?\n/)) {
    try { const item = JSON.parse(line); if (item?.key) map.set(item.key, item); } catch (_) {}
  }
  return map;
}

async function research(item) {
  const fields = (item.unresolvedFields || []).map(field => fieldLabels[field]).join(' ');
  const query = `${item.province} ${item.city} ${item.name} ${fields} 官网 携程 同程 Tripadvisor 百科`;
  const searchUrl = `https://cn.bing.com/search?format=rss&q=${encodeURIComponent(query)}`;
  let results = [];
  const warnings = [];
  try { results = parseRss(await curl(searchUrl)); } catch (error) { warnings.push(`互联网检索失败：${error.message}`); }
  const credible = results.map(result => ({ ...result, score: sourceScore(result, item) }))
    .filter(result => result.score >= 5).sort((a, b) => b.score - a.score).slice(0, 6);
  const after = { ...(item.after || item.before || {}) };
  const found = {};
  for (const result of credible) {
    const values = extractFields(result, item);
    for (const [field, value] of Object.entries(values)) {
      if (!found[field]) {
        found[field] = { value, source: result };
        after[field] = value;
      }
    }
  }
  const originalChanged = new Set(item.changedFields || []);
  Object.keys(found).forEach(field => originalChanged.add(field));
  const unresolvedFields = (item.unresolvedFields || []).filter(field => !found[field]);
  const sources = [
    ...(item.sources || []),
    ...credible.map(result => ({ type: 'public_web', title: result.title, url: result.url })),
  ];
  const uniqueSources = [...new Map(sources.map(source => [`${source.title}|${source.url}`, source])).values()];
  return {
    ...item,
    after,
    changedFields: [...originalChanged],
    unresolvedFields,
    sources: uniqueSources,
    warnings: [...new Set([...(item.warnings || []).filter(value => !/未找到与景点实体同条展示/.test(value)), ...warnings,
      ...(unresolvedFields.length ? [`已检索景区官网、政府文旅、公开百科及国内外主流旅游网站，仍待补充：${unresolvedFields.map(field => fieldLabels[field]).join('、')}`] : [])])],
    status: unresolvedFields.length ? (originalChanged.size ? 'partial' : 'unresolved') : 'ready',
    secondaryResearch: {
      query,
      searchUrl,
      checkedAt: new Date().toISOString(),
      credibleSources: credible.length,
      foundFields: Object.keys(found),
    },
  };
}

async function main() {
  const manifest = readJson(manifestPath);
  const allTargets = manifest.items.filter(item => item.unresolvedFields?.length);
  const targets = limit ? allTargets.slice(0, limit) : allTargets;
  const completed = previousEvents();
  const queue = targets.filter(item => !completed.has(item.key));
  let cursor = 0;
  let done = 0;
  async function worker() {
    while (cursor < queue.length) {
      const item = queue[cursor++];
      const result = await research(item);
      completed.set(item.key, result);
      fs.appendFileSync(eventPath, `${JSON.stringify(result)}\n`, 'utf8');
      done += 1;
      if (done % 25 === 0 || done === queue.length) console.log(`[${done}/${queue.length}] 第二轮互联网补证`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, worker));
  const replacements = new Map([...completed].filter(([key]) => allTargets.some(item => item.key === key)));
  manifest.items = manifest.items.map(item => replacements.get(item.key) || item);
  manifest.generatedAt = new Date().toISOString();
  manifest.status = 'secondary_collected';
  manifest.summary.ready = manifest.items.filter(item => item.status === 'ready').length;
  manifest.summary.retained = manifest.items.filter(item => item.status === 'retained').length;
  manifest.summary.partial = manifest.items.filter(item => item.status === 'partial').length;
  manifest.summary.unresolved = manifest.items.filter(item => item.status === 'unresolved').length;
  manifest.summary.proposedFields = Object.fromEntries(Object.keys(fieldLabels).map(field => [field, manifest.items.filter(item => item.changedFields?.includes(field)).length]));
  manifest.summary.remainingFields = Object.fromEntries(Object.keys(fieldLabels).map(field => [field, manifest.items.filter(item => item.unresolvedFields?.includes(field)).length]));
  manifest.secondaryResearch = { targets: allTargets.length, completed: replacements.size, generatedAt: manifest.generatedAt };
  writeJsonAtomic(manifestPath, manifest);
  console.log(JSON.stringify({ secondaryResearch: manifest.secondaryResearch, summary: manifest.summary }, null, 2));
}

main().catch(error => {
  console.error(`第二轮互联网补证失败：${error.message}`);
  process.exitCode = 1;
});
