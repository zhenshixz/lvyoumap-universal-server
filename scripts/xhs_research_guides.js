const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { normalizeAttractionName } = require('./generate_static_data');

puppeteer.use(StealthPlugin());

const rootDir = path.join(__dirname, '..');
const runtimeDir = path.join(rootDir, '.runtime');
const contentDir = path.join(rootDir, 'content');
const profileDir = path.join(runtimeDir, 'xhs-profile');
const progressPath = path.join(runtimeDir, 'xhs-lazy-progress.json');
const stopPath = path.join(runtimeDir, 'xhs-lazy-stop.flag');
const args = new Map(process.argv.slice(2).map(arg => {
  const match = arg.match(/^--([^=]+)=(.*)$/);
  return match ? [match[1], match[2]] : [arg.replace(/^--/, ''), true];
}));
const province = String(args.get('province') || '').trim();
const limit = Math.max(0, Number(args.get('limit') || 0));
if (!province) throw new Error('请使用 --province=省份。');

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\r\n`, 'utf8');
  fs.renameSync(temp, filePath);
}

function writeProgress(patch) {
  const current = readJson(progressPath, {});
  const next = { ...current, pid: process.pid, ...patch, scope: `${province}核心景点完整补全`, updatedAt: new Date().toISOString() };
  if (next.total > 0) next.percent = Math.round(((next.index || 0) / next.total) * 1000) / 10;
  writeJsonAtomic(progressPath, next);
}

function provinceInfo() {
  const db = readJson(path.join(contentDir, 'db.json'), { provinces: {} });
  const data = db.provinces?.[province];
  return data ? { slug: data.id || data.slug } : null;
}

function findBrowser() {
  return [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean).find(file => fs.existsSync(file));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loginRequired(text) {
  return /登录探索更多内容|登录后查看搜索结果|登录后推荐更懂你的笔记|小红书如何扫码|扫码登录/.test(text);
}

function restricted(text) {
  return /访问受限|操作频繁|请求频繁|当前访问存在异常|网络环境存在风险|稍后再试|账号存在风险/.test(text);
}

function compact(value) {
  return String(value || '')
    .replace(/\r/g, '\n')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function promptFor(item) {
  return `请只整理“${item.name}”（${item.city || province}）截至当前仍稳定可执行的景区结构和家庭省力游览信息。不要混入同名异地、母景区外的项目，不写票价、固定开放时间、临时演出、班次和排队时间；不确定的动态信息写“以官方当日公告为准”。“景点全称”必须原样复制为“${item.name}”。严格输出以下17个标签；即使平台合并换行，也必须保留每个标签，不要标题、序号、表格或多余解释：\n景点全称：${item.name}\n景点类型：\n路线A标题：\n路线A节点：节点1＞节点2＞节点3＞节点4\n路线A体力：1到5的整数\n路线A步行：\n路线A提示：提示1｜提示2\n路线B标题：\n路线B节点：节点1＞节点2＞节点3＞节点4\n路线B体力：1到5的整数\n路线B步行：\n路线B提示：提示1｜提示2\n外部到达：\n入口建议：\n内部交通：\n住宿区域：\n长辈儿童：分别写长辈与儿童的实用建议。`;
}

function answerAfterPrompt(body, prompt) {
  const text = compact(body);
  const index = text.indexOf(prompt);
  return compact(index >= 0 ? text.slice(index + prompt.length) : text);
}

const OUTPUT_LABELS = ['景点全称', '景点类型', '路线A标题', '路线A节点', '路线A体力', '路线A步行', '路线A提示', '路线B标题', '路线B节点', '路线B体力', '路线B步行', '路线B提示', '外部到达', '入口建议', '内部交通', '住宿区域', '长辈儿童'];

function labeled(answer, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const next = OUTPUT_LABELS.filter(value => value !== label)
    .map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const match = answer.match(new RegExp(`(?:^|\\s)${escaped}[：:]\\s*(.*?)(?=\\s+(?:${next})[：:]|$)`, 's'));
  return match ? match[1].trim() : '';
}

function sanitizeDynamic(value) {
  return String(value || '')
    .replace(/(?:上午|中午|下午|晚上|傍晚|夜间)\s*\d+(?:点|时)(?:半|左右)?/g, '较合适时段')
    .replace(/\d{1,2}[:：]\d{2}/g, '官方当日建议时段')
    .replace(/(?:约)?\d+(?:\.\d+)?\s*元(?:\s*\/\s*人)?/g, '费用以官方当日公告为准')
    .trim();
}

function splitList(value, separators = /[＞>→|｜、]/) {
  return String(value || '').split(separators).map(item => item.trim()).filter(Boolean);
}

function parseAnswer(answer, target) {
  const identity = labeled(answer, '景点全称');
  const expected = normalizeAttractionName(target.name);
  const actual = normalizeAttractionName(identity);
  const authoritativeIdentity = (target.research?.discoveredSources || []).some(source => source.kind === 'official_identity');
  const identityCompatible = Boolean(expected && actual && (
    expected === actual || expected.includes(actual) || actual.includes(expected)
  )) || (authoritativeIdentity && Boolean(identity));
  const routeA = {
    title: labeled(answer, '路线A标题'),
    nodes: splitList(labeled(answer, '路线A节点')),
    physical: Number(labeled(answer, '路线A体力').match(/[1-5]/)?.[0] || 0),
    walking: sanitizeDynamic(labeled(answer, '路线A步行')),
    tips: splitList(sanitizeDynamic(labeled(answer, '路线A提示')), /[|｜]/),
  };
  const routeB = {
    title: labeled(answer, '路线B标题'),
    nodes: splitList(labeled(answer, '路线B节点')),
    physical: Number(labeled(answer, '路线B体力').match(/[1-5]/)?.[0] || 0),
    walking: sanitizeDynamic(labeled(answer, '路线B步行')),
    tips: splitList(sanitizeDynamic(labeled(answer, '路线B提示')), /[|｜]/),
  };
  const family = labeled(answer, '长辈儿童');
  const elderly = family.match(/长辈[：:]?([^；;。]+(?:[。；;][^儿童\n]*)?)/)?.[1]?.trim() || family;
  const children = family.match(/儿童[：:]?(.+)$/)?.[1]?.trim() || family;
  const value = {
    identity,
    category: labeled(answer, '景点类型'),
    routes: [routeA, routeB],
    externalArrive: sanitizeDynamic(labeled(answer, '外部到达')),
    internalArrive: sanitizeDynamic(labeled(answer, '入口建议')),
    internalTraffic: sanitizeDynamic(labeled(answer, '内部交通')),
    housingArea: sanitizeDynamic(labeled(answer, '住宿区域')),
    specialCare: { elderly, children },
  };
  const issues = [];
  if (!identityCompatible) issues.push(`景点身份不一致（回答：${identity || '空'}）`);
  if (!value.category) issues.push('缺少景点类型');
  for (const [index, route] of value.routes.entries()) {
    if (!route.title || route.nodes.length < 4 || !route.physical || !route.walking || route.tips.length < 2) issues.push(`路线${index ? 'B' : 'A'}不完整`);
  }
  for (const key of ['externalArrive', 'internalArrive', 'internalTraffic', 'housingArea']) if (!value[key]) issues.push(`缺少${key}`);
  if (!elderly || !children) issues.push('长辈儿童建议不完整');
  return { complete: issues.length === 0, issues, value };
}

async function resumeIfPossible(page) {
  return page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
    const buttons = [...document.querySelectorAll('button,[role="button"]')];
    const button = buttons.find(node => /^(继续生成|继续回答|继续|重试|再试一次)$/.test((node.innerText || node.textContent || '').trim()) && node.getBoundingClientRect().height > 0);
    if (!button) return false;
    button.click();
    return true;
  }).catch(() => false);
}

async function collectOne(page, target) {
  const basePrompt = promptFor(target);
  let bestFailure = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const prompt = attempt === 1 ? basePrompt : `${basePrompt}\n这是第${attempt}次尝试，请从头完整输出17行。`;
    await page.goto(`https://www.xiaohongshu.com/ai_chat_tab?searchKeyWord=${encodeURIComponent(prompt)}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(1400);
    let best = '';
    let lastGrowth = Date.now();
    let resumed = false;
    const started = Date.now();
    while (Date.now() - started < 22000) {
      const body = await page.evaluate(() => document.body.innerText || '').catch(() => '');
      if (loginRequired(body)) return { ok: false, fatal: 'login_required' };
      if (restricted(body)) return { ok: false, fatal: 'restricted' };
      const answer = answerAfterPrompt(body, prompt);
      if (answer.length > best.length) {
        best = answer;
        lastGrowth = Date.now();
      }
      const parsed = parseAnswer(best, target);
      if (parsed.complete) return { ok: true, prompt: basePrompt, raw: best, ...parsed.value };
      bestFailure = { ok: false, issues: parsed.issues, answerPreview: best.slice(0, 2000) };
      if (Date.now() - lastGrowth > (best ? 3000 : 7000)) {
        if (!resumed && await resumeIfPossible(page)) {
          resumed = true;
          lastGrowth = Date.now();
        } else break;
      }
      await sleep(700);
    }
    if (attempt < 3) await sleep(2500);
  }
  return bestFailure || { ok: false, issues: ['未获得有效回答'] };
}

async function main() {
  const info = provinceInfo();
  if (!info) throw new Error(`无法识别省份：${province}`);
  const workspacePath = path.join(runtimeDir, `core-repair-research.${info.slug}.json`);
  const outputPath = path.join(runtimeDir, `core-experience-evidence.${info.slug}.json`);
  const workspace = readJson(workspacePath, {});
  if (!workspace.attractions?.length) throw new Error('缺少景点资料研究工作区。');
  const output = readJson(outputPath, { province, version: 1, attractions: {}, failures: {} });
  output.province = province;
  output.version = 1;
  output.attractions ||= {};
  output.failures ||= {};
  for (const item of workspace.attractions) {
    const failed = output.failures[item.baselineKey];
    if (!failed?.answerPreview || output.attractions[item.baselineKey]?.routes?.length) continue;
    const recovered = parseAnswer(failed.answerPreview, item);
    if (!recovered.complete) continue;
    output.attractions[item.baselineKey] = {
      ok: true,
      prompt: promptFor(item),
      raw: failed.answerPreview,
      ...recovered.value,
      source: 'xiaohongshu-dian-dian-ai-chat',
      collectedAt: failed.updatedAt || new Date().toISOString(),
      recoveredFromCheckpoint: true,
    };
    delete output.failures[item.baselineKey];
  }
  writeJsonAtomic(outputPath, output);
  const pendingAll = workspace.attractions.filter(item => !output.attractions[item.baselineKey]?.routes?.length);
  const pending = limit ? pendingAll.slice(0, limit) : pendingAll;
  if (!pending.length) {
    writeProgress({ status: 'experience_done', stage: 'experience', message: `${province}结构化旅行资料已齐。`, index: workspace.attractions.length, total: workspace.attractions.length, success: workspace.attractions.length, failed: 0 });
    console.log(`${province}结构化旅行资料已齐，不重复采集。`);
    return;
  }
  const executablePath = findBrowser();
  if (!executablePath) throw new Error('没有找到 Chrome 或 Edge。');
  const browser = await puppeteer.launch({
    executablePath,
    headless: false,
    userDataDir: profileDir,
    protocolTimeout: 180000,
    defaultViewport: { width: 1440, height: 1000 },
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--window-position=-32000,-32000', '--window-size=1440,1000'],
  });
  let success = 0;
  let failed = 0;
  try {
    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    await page.goto('https://www.xiaohongshu.com/explore', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);
    const home = await page.evaluate(() => document.body.innerText || '').catch(() => '');
    if (loginRequired(home)) throw Object.assign(new Error('小红书登录状态失效。'), { code: 'login_required' });
    if (restricted(home)) throw Object.assign(new Error('小红书当前限制访问。'), { code: 'restricted' });
    for (let index = 0; index < pending.length; index += 1) {
      if (fs.existsSync(stopPath)) break;
      const item = pending[index];
      writeProgress({ status: 'running', stage: 'experience', message: '正在采集两条可解析路线与家庭出行结构。', current: `${province}/${item.name}`, index, total: pending.length, success, failed });
      const result = await collectOne(page, item);
      if (result.fatal) throw Object.assign(new Error(result.fatal === 'login_required' ? '小红书登录状态失效。' : '小红书当前限制访问。'), { code: result.fatal });
      if (result.ok) {
        output.attractions[item.baselineKey] = { ...result, source: 'xiaohongshu-dian-dian-ai-chat', collectedAt: new Date().toISOString() };
        delete output.failures[item.baselineKey];
        success += 1;
      } else {
        output.failures[item.baselineKey] = { name: item.name, ...result, updatedAt: new Date().toISOString() };
        failed += 1;
      }
      output.updatedAt = new Date().toISOString();
      writeJsonAtomic(outputPath, output);
      writeProgress({ status: 'running', stage: 'experience', current: `${province}/${item.name}`, index: index + 1, total: pending.length, success, failed });
      await sleep(5000);
    }
  } catch (error) {
    if (error.code === 'login_required') writeProgress({ status: 'login_required', message: error.message, success, failed });
    else if (error.code === 'restricted') writeProgress({ status: 'restricted', message: `${error.message} 已保存断点，下次继续。`, success, failed });
    throw error;
  } finally {
    await browser.close().catch(() => {});
  }
  const remaining = workspace.attractions.filter(item => !output.attractions[item.baselineKey]?.routes?.length);
  if (remaining.length) {
    writeProgress({ status: 'retry_ready', stage: 'experience', message: `${remaining.length}项已保存断点，可直接继续。`, index: workspace.attractions.length - remaining.length, total: workspace.attractions.length, success: workspace.attractions.length - remaining.length, failed: remaining.length });
    console.log(`${province}结构化旅行资料完成 ${workspace.attractions.length - remaining.length}/${workspace.attractions.length}；失败项已保留，下次自动续跑。`);
    process.exitCode = 2;
  } else {
    writeProgress({ status: 'experience_done', stage: 'experience', message: `${province}结构化旅行资料已完成。`, index: workspace.attractions.length, total: workspace.attractions.length, success: workspace.attractions.length, failed: 0 });
    console.log(`${province}结构化旅行资料已完成：${workspace.attractions.length}/${workspace.attractions.length}。`);
  }
}

main().catch(error => {
  console.error(`结构化旅行资料采集失败：${error.message}`);
  process.exitCode = process.exitCode || 1;
});
