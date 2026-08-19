const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { normalizeAttractionName, probablySameAttraction } = require('./generate_static_data');

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
  return `请只整理“${item.name}”（${item.city || province}）截至当前仍稳定可执行的景区结构和家庭省力游览信息。不要混入同名异地、母景区外的项目，不写票价、固定开放时间、临时演出、班次和排队时间；不确定的动态信息写“以官方当日公告为准”。“景点全称”必须原样复制为“${item.name}”。至少给出1条真实可执行的游览方案；路线节点按景点实际填写，可以是楼层、展区、街区、观赏重点或活动顺序，不强求数量。只有确实存在明显不同的第二种玩法时才填写路线B，否则路线B各项写“不适用”，禁止为了凑数虚构节点。严格输出以下17个标签；即使平台合并换行，也必须保留每个标签，不要标题、序号、表格或多余解释：\n景点全称：${item.name}\n景点类型：\n路线A标题：\n路线A节点：按实际填写游览顺序或重点\n路线A体力：1到5的整数\n路线A步行：\n路线A提示：至少1条实用提示\n路线B标题：无明显第二种玩法时写不适用\n路线B节点：\n路线B体力：\n路线B步行：\n路线B提示：\n外部到达：\n入口建议：\n内部交通：\n住宿区域：\n长辈儿童：长辈建议：……；儿童建议：……。两项都必须写。`;
}

function answerAfterPrompt(body, prompt) {
  const text = compact(body);
  const index = text.indexOf(prompt);
  return compact(index >= 0 ? text.slice(index + prompt.length) : text)
    .replace(/\n?活动\s*$/u, '')
    .trim();
}

function isTransientAnswer(text) {
  const value = compact(text).replace(/\n?活动\s*$/u, '').trim();
  return !value || /^(?:问题分析中|正在分析(?:问题)?|正在思考(?:中)?|正在生成(?:回答)?|生成中|加载中|请稍候)[.。…]*$/u.test(value);
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

function usableText(value) {
  const text = String(value || '').trim();
  return Boolean(text && !/^(?:无|暂无|不适用|没有|无固定路线)$/u.test(text));
}

function routeIsUsable(route) {
  return usableText(route?.title)
    && Array.isArray(route?.nodes)
    && route.nodes.some(usableText)
    && Number(route?.physical) >= 1
    && usableText(route?.walking)
    && Array.isArray(route?.tips)
    && route.tips.some(usableText);
}

function failureQuality(failure) {
  const answerLength = compact(failure?.answerPreview).length;
  const issuePenalty = Array.isArray(failure?.issues) ? failure.issues.length * 25 : 0;
  return answerLength - issuePenalty;
}

function chooseBetterFailure(previous, next) {
  if (!previous) return next;
  if (!next) return previous;
  return failureQuality(next) > failureQuality(previous) ? next : previous;
}

function answerIdentityCompatible(identity, target) {
  const actual = normalizeAttractionName(identity);
  if (!actual) return false;
  return [target?.name, ...(target?.aliases || [])].filter(Boolean).some(name => {
    const expected = normalizeAttractionName(name);
    return Boolean(expected && (
      expected === actual
      || expected.includes(actual)
      || actual.includes(expected)
      || probablySameAttraction(name, identity)
    ));
  });
}

function parseAnswer(answer, target) {
  const identity = labeled(answer, '景点全称');
  const identityCompatible = answerIdentityCompatible(identity, target);
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
  const family = labeled(answer, '长辈儿童').replace(/\s*活动\s*$/u, '').trim();
  const elderly = (
    family.match(/长辈(?:建议)?[：:]?\s*([\s\S]*?)(?=儿童(?:建议)?[：:]?)/u)?.[1]
    || answer.match(/(?:^|\s)长辈建议[：:]\s*([\s\S]*?)(?=\s+儿童建议[：:])/u)?.[1]
    || ''
  ).replace(/[；;。\s]+$/u, '').trim();
  const children = (
    family.match(/儿童(?:建议)?[：:]?\s*([\s\S]+)$/u)?.[1]
    || answer.match(/(?:^|\s)儿童建议[：:]\s*([\s\S]+?)\s*$/u)?.[1]
    || ''
  ).replace(/\s*活动\s*$/u, '').trim();
  const routeCandidates = [routeA, routeB];
  const value = {
    identity,
    category: labeled(answer, '景点类型'),
    routes: routeCandidates.filter(routeIsUsable),
    externalArrive: sanitizeDynamic(labeled(answer, '外部到达')),
    internalArrive: sanitizeDynamic(labeled(answer, '入口建议')),
    internalTraffic: sanitizeDynamic(labeled(answer, '内部交通')),
    housingArea: sanitizeDynamic(labeled(answer, '住宿区域')),
    specialCare: { elderly, children },
  };
  const issues = [];
  if (!identityCompatible) issues.push(`景点身份不一致（回答：${identity || '空'}）`);
  if (!value.category) issues.push('缺少景点类型');
  if (!value.routes.length) issues.push('缺少可执行游览方案');
  for (const key of ['externalArrive', 'internalArrive', 'internalTraffic', 'housingArea']) if (!value[key]) issues.push(`缺少${key}`);
  // Keep the gate semantic and tolerant: short but complete advice is valid;
  // only empty fragments or visibly truncated punctuation are rejected.
  const careComplete = value => value.length >= 4 && !/[，、；：,:;]$/u.test(value);
  if (!careComplete(elderly) || !careComplete(children)) issues.push('长辈儿童建议不完整');
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
  const attempts = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const prompt = attempt === 1 ? basePrompt : `${basePrompt}\n这是第${attempt}次尝试，请从头完整输出17行。`;
    if (attempt > 1) {
      await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await sleep(350);
    }
    await page.goto(`https://www.xiaohongshu.com/ai_chat_tab?searchKeyWord=${encodeURIComponent(prompt)}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(700);
    let best = '';
    let lastGrowth = Date.now();
    let resumed = false;
    let sawTransient = false;
    const started = Date.now();
    while (Date.now() - started < 28000) {
      const body = await page.evaluate(() => document.body.innerText || '').catch(() => '');
      if (loginRequired(body)) return { ok: false, fatal: 'login_required' };
      if (restricted(body)) return { ok: false, fatal: 'restricted' };
      const answer = answerAfterPrompt(body, prompt);
      if (isTransientAnswer(answer)) {
        sawTransient = sawTransient || Boolean(answer);
      } else if (answer.length > best.length) {
        best = answer;
        lastGrowth = Date.now();
      }
      const parsed = parseAnswer(best, target);
      if (parsed.complete) return { ok: true, prompt: basePrompt, raw: best, attempts: [...attempts, { attempt, reason: 'ok', length: best.length }], ...parsed.value };
      bestFailure = chooseBetterFailure(bestFailure, { ok: false, issues: parsed.issues, answerPreview: best.slice(0, 2000) });
      if (best && Date.now() - lastGrowth > 3200) {
        if (!resumed && await resumeIfPossible(page)) {
          resumed = true;
          lastGrowth = Date.now();
        }
      }
      await sleep(500);
    }
    attempts.push({ attempt, reason: best ? 'incomplete_answer' : (sawTransient ? 'analysis_only' : 'empty_answer'), length: best.length });
    if (attempt < 3) await sleep(best ? 800 : 1200);
  }
  return { ...(bestFailure || { ok: false, issues: ['未获得有效回答'] }), attempts };
}

async function main() {
  if (!province) throw new Error('请使用 --province=省份。');
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
  // Re-check saved checkpoints with the current parser. This prevents an old,
  // overly permissive parser from permanently marking truncated answers done.
  for (const item of workspace.attractions) {
    const saved = output.attractions[item.baselineKey];
    if (!saved?.raw) continue;
    const checked = parseAnswer(saved.raw, item);
    if (checked.complete) {
      output.attractions[item.baselineKey] = { ...saved, ...checked.value };
      continue;
    }
    output.failures[item.baselineKey] = chooseBetterFailure(output.failures[item.baselineKey], {
      name: item.name,
      ok: false,
      issues: checked.issues,
      answerPreview: saved.raw,
      attempts: saved.attempts || [],
      updatedAt: new Date().toISOString(),
    });
    delete output.attractions[item.baselineKey];
  }
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
    writeProgress({ status: 'experience_done', stage: 'experience', message: `${province}结构化旅行资料已齐。`, current: '', pendingNames: [], index: workspace.attractions.length, total: workspace.attractions.length, success: workspace.attractions.length, failed: 0 });
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
      writeProgress({ status: 'running', stage: 'experience', message: '正在采集至少一条可执行游览方案与家庭出行结构。', current: `${province}/${item.name}`, index, total: pending.length, success, failed });
      const result = await collectOne(page, item);
      if (result.fatal) throw Object.assign(new Error(result.fatal === 'login_required' ? '小红书登录状态失效。' : '小红书当前限制访问。'), { code: result.fatal });
      if (result.ok) {
        output.attractions[item.baselineKey] = { ...result, source: 'xiaohongshu-dian-dian-ai-chat', collectedAt: new Date().toISOString() };
        delete output.failures[item.baselineKey];
        success += 1;
      } else {
        const previousFailure = output.failures[item.baselineKey];
        const nextFailure = { name: item.name, ...result, updatedAt: new Date().toISOString() };
        output.failures[item.baselineKey] = chooseBetterFailure(previousFailure, nextFailure);
        failed += 1;
      }
      output.updatedAt = new Date().toISOString();
      writeJsonAtomic(outputPath, output);
      writeProgress({ status: 'running', stage: 'experience', current: `${province}/${item.name}`, index: index + 1, total: pending.length, success, failed });
      await sleep(2000);
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
    const remainingNames = remaining.map(item => item.name);
    writeProgress({
      status: 'retry_ready',
      stage: 'experience',
      message: `待续跑：${remainingNames.join('、')}。其余成功断点已保存，下次只处理这些项目。`,
      current: remainingNames.length === 1 ? `${province}/${remainingNames[0]}` : '',
      pendingNames: remainingNames,
      index: workspace.attractions.length - remaining.length,
      total: workspace.attractions.length,
      success: workspace.attractions.length - remaining.length,
      failed: remaining.length,
    });
    console.log(`${province}结构化旅行资料完成 ${workspace.attractions.length - remaining.length}/${workspace.attractions.length}；待续跑：${remainingNames.join('、')}。`);
    process.exitCode = 2;
  } else {
    writeProgress({ status: 'experience_done', stage: 'experience', message: `${province}结构化旅行资料已完成。`, current: '', pendingNames: [], index: workspace.attractions.length, total: workspace.attractions.length, success: workspace.attractions.length, failed: 0 });
    console.log(`${province}结构化旅行资料已完成：${workspace.attractions.length}/${workspace.attractions.length}。`);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`结构化旅行资料采集失败：${error.message}`);
    process.exitCode = process.exitCode || 1;
  });
}

module.exports = { answerIdentityCompatible, chooseBetterFailure, isTransientAnswer, parseAnswer, promptFor, routeIsUsable };
