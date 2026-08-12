const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const rootDir = path.join(__dirname, '..');
const runtimeDir = path.join(rootDir, '.runtime');
const profileDir = path.join(runtimeDir, 'xhs-profile');
const progressPath = path.join(runtimeDir, 'xhs-lazy-progress.json');
const samplesPath = path.join(runtimeDir, 'xhs-lazy-samples.json');
const stopPath = path.join(runtimeDir, 'xhs-lazy-stop.flag');
const dbPath = path.join(rootDir, 'content', 'db.json');
const manualPath = path.join(rootDir, 'content', 'manual-attractions.json');
const overridesPath = path.join(rootDir, 'content', 'lazy-guide-overrides.json');

const args = new Map(process.argv.slice(2).map(arg => {
  const match = arg.match(/^--([^=]+)=(.*)$/);
  return match ? [match[1], match[2]] : [arg.replace(/^--/, ''), true];
}));
const loginMode = args.has('login');
const listMode = args.has('list');
const recoverMode = args.has('recover-samples');
const statsMode = args.has('stats');
const background = args.has('background');
const generateAfter = args.has('generate-after');
const visible = loginMode || args.has('visible');
const write = args.has('write');
const force = args.has('force');
const repairOnly = args.has('repair-only');
const refreshDynamic = args.has('refresh-dynamic');
const sanitizeStored = args.has('sanitize-stored');
const provinceFilter = String(args.get('province') || '');
const nameFilter = String(args.get('name') || '');
const limit = Math.max(0, Number(args.get('limit') || 0));
const loginTimeoutMs = Math.max(60000, Number(args.get('login-timeout') || 600000));
const answerWaitMs = Math.max(12000, Number(args.get('answer-wait') || 45000));
const requestDelayMs = Math.max(3000, Number(args.get('request-delay') || 8000));

function nowIso() {
  return new Date().toISOString();
}

function readJson(filePath, fallback = {}) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\r\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function writeProgress(patch) {
  const current = readJson(progressPath, {});
  const next = { ...current, ...patch, pid: process.pid, updatedAt: nowIso() };
  if (next.total > 0) next.percent = Math.round(((next.index || 0) / next.total) * 1000) / 10;
  atomicWriteJson(progressPath, next);
}

function compactText(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function promptFor(attraction) {
  const name = String(attraction.name || '').trim();
  if (/大马戏/.test(name)) {
    return `只回答“${name}”这个独立演出项目截至当前仍可执行的长辈小孩省力观看攻略。不要写动物世界、欢乐世界、水上乐园或其他长隆园区路线；重点写入场前准备、适合长辈小孩的通用选座原则、观看注意事项和散场避拥挤方法。不要写固定座区编号、票价、固定开演时间、演出时长或临时场次，不建议提前离场；不确定的项目明确提醒查官方。`;
  }
  return `${name}完整景区截至当前仍可执行的长辈小孩省力路线。不要只回答其中一个子景点；不要提供票价、固定开放时间、临时演出场次等易过期信息；不确定的项目明确提醒查官方，不要无关内容（如餐饮推荐）`;
}

function cleanupAnswer(pageText, prompt) {
  let raw = compactText(pageText);
  const promptIndex = raw.indexOf(prompt);
  if (promptIndex >= 0) raw = raw.slice(promptIndex + prompt.length);
  raw = raw
    .replace(/^搜索或者输入任何问题\s*/g, '')
    .replace(/\n?活动\s*$/g, '')
    .replace(/\n?展开更多\s*/g, '\n')
    .replace(/\n?登录后推荐更懂你的笔记[\s\S]*$/g, '')
    .replace(/^(根据小红书.*整理如下[:：]?\s*)/g, '')
    .trim();
  const lines = raw.split(/\n+/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/餐饮|美食|住宿|酒店|饭店|需要我帮你|如果时间充裕|推荐吗|下一步/.test(line));
  return compactText(lines
    .map(line => line
      .replace(/^\d{1,2}:\d{2}\s*[-—–至]\s*\d{1,2}:\d{2}\s*/, '')
      .replace(/\d{1,2}:\d{2}\s*左右/g, '客流较少时')
      .replace(/\d{1,2}:\d{2}/g, '官方当日建议时段'))
    .filter(line => !/(门票|票价|收费|半价|免票|免费|\d+(?:\.\d+)?\s*元|开放时间|闭馆时间|周[一二三四五六日].*(?:闭馆|开放|停演)|无限次)/.test(line))
    .join('\n\n'));
}

function finalSanitizeAnswer(text) {
  let answer = compactText(text)
    .replace(/\d{1,2}:\d{2}\s*左右/g, '客流较少时')
    .replace(/\d{1,2}:\d{2}/g, '官方当日建议时段')
    .replace(/(?:上午|中午|下午|晚上|傍晚|夜间)\s*\d+(?:点|时)(?:半|左右)?/g, '当日较合适时段')
    .replace(/\d+点左右/g, '当日较合适时段');
  const blocks = answer.split(/\n{2,}/).map(block => block.trim()).filter(Boolean);
  answer = blocks.filter(block => !/(你们这次|需要我(?:再)?帮你|还可以帮你|如果需要[，,]?我可以)/.test(block)).join('\n\n');
  if (/大马戏/.test(answer)) {
    answer = answer
      .replace(/提前离场：[^\n]+/g, '散场安排：完整看完演出和谢幕后，再按现场工作人员引导分批离场；提前约好家人集合点和返程上车点。')
      .replace(/不过\d+分钟的演出/g, '不过完整场次的演出')
      .replace(/演出时长约\d+分钟/g, '演出时长以官方当日场次为准');
  }
  return compactText(answer);
}

function sanitizeStoredOverrides() {
  const overrides = readJson(overridesPath, {});
  let changed = 0;
  for (const [id, value] of Object.entries(overrides)) {
    if (!value?.lazy_ai_text) continue;
    const next = finalSanitizeAnswer(value.lazy_ai_text);
    if (next === value.lazy_ai_text) continue;
    value.lazy_ai_text = next;
    changed += 1;
  }
  if (changed) {
    const backup = backupOverrides();
    atomicWriteJson(overridesPath, overrides);
    console.log(`已清理 ${changed} 条已存攻略中的固定时刻或对话式结尾。`);
    if (backup) console.log(`备份：${backup}`);
  } else {
    console.log('已存攻略无需清理。');
  }
}

function answerQuality(text, prompt = '') {
  const answer = compactText(text);
  const lines = answer.split(/\n+/).map(line => line.trim()).filter(Boolean);
  const routeSignals = (answer.match(/路线|游览顺序|观光车|索道|接驳|电梯|扶梯|少走|步行/g) || []).length;
  const audienceSignals = (answer.match(/老人|长辈|小孩|儿童|亲子/g) || []).length;
  const safetySignals = (answer.match(/注意|避开|防滑|预约|公告|开放|体力|台阶/g) || []).length;
  const sections = lines.filter(line => line.length <= 28 && /(路线|顺序|技巧|注意|提醒|建议|省力)/.test(line)).length;
  const showMode = /大马戏|独立演出项目/.test(prompt);
  const showSignals = (answer.match(/入场|选座|座位|观看|声光|散场|退场|出口/g) || []).length;
  const trailing = lines.at(-1) || '';
  const complete = answer.length >= 500
    && (showMode ? showSignals >= 5 : routeSignals >= 2)
    && audienceSignals >= 2
    && safetySignals >= 1
    && sections >= 1
    && !(/(路线|技巧|注意事项|提醒|建议)$/.test(trailing) && trailing.length <= 16)
    && !/登录后查看搜索结果|登录后推荐更懂你的笔记|小红书如何扫码|换个问题试试/.test(answer);
  return { complete, length: answer.length, routeSignals, showSignals, audienceSignals, safetySignals, sections };
}

function isExcludedName(name) {
  return /(火车站|高铁站|汽车站|站前|停车场|停车区|服务区|售票处|卫生间|游客中心|服务中心|入口|出口|检票口|换乘中心|码头售票|普通广场|人民公园)/.test(name)
    || (/(站|停车场|服务区|售票处|卫生间|入口|出口|游客中心|服务中心|广场|公园)$/.test(name) && !/天安门广场/.test(name));
}

function buildCorePreferredIds() {
  const contentDir = path.join(rootDir, 'content');
  const ids = new Set();
  for (const name of fs.readdirSync(contentDir).filter(item => /^core-attractions\.[a-z0-9_-]+\.json$/i.test(item))) {
    const baseline = readJson(path.join(contentDir, name), {});
    for (const attraction of baseline.attractions || []) if (attraction.preferredId) ids.add(attraction.preferredId);
  }
  return ids;
}

const corePreferredIds = buildCorePreferredIds();

function buildAllRecords() {
  const db = readJson(dbPath, { provinces: {} });
  const manual = {};
  for (const name of fs.readdirSync(path.join(rootDir, 'content')).filter(item => /^manual-attractions(?:\.[a-z0-9_-]+)?\.json$/i.test(item)).sort()) {
    const layer = readJson(path.join(rootDir, 'content', name), {});
    for (const [provinceName, additions] of Object.entries(layer)) {
      manual[provinceName] = [...(manual[provinceName] || []), ...(additions || [])];
    }
  }
  for (const name of fs.readdirSync(path.join(rootDir, 'content')).filter(item => /^core-repair-packages\.[a-z0-9_-]+\.json$/i.test(item)).sort()) {
    const repairPackage = readJson(path.join(rootDir, 'content', name), {});
    // A repair package is intentionally exposed to Diandian while it is still
    // collecting.  Requiring "reviewed" here created a deadlock: the package
    // could not pass final review without a Diandian article, while Diandian
    // could not see it until after final review.
    if (!['collecting', 'reviewed'].includes(repairPackage.status) || !repairPackage.province) continue;
    manual[repairPackage.province] = [
      ...(manual[repairPackage.province] || []),
      ...(repairPackage.attractions || []).map(({ baselineKey, ...attraction }) => ({ ...attraction, __repairPackage: true })),
    ];
  }
  const overrides = readJson(overridesPath, {});
  const records = [];
  const ids = new Set();
  for (const [provinceName, province] of Object.entries(db.provinces || {})) {
    for (const attraction of province.attractions || []) {
      records.push({ provinceName, attraction: { ...attraction, ...(overrides[attraction.id] || {}) }, dataLayer: 'db' });
      ids.add(attraction.id);
    }
  }
  for (const [provinceName, additions] of Object.entries(manual || {})) {
    for (const attraction of additions || []) {
      if (ids.has(attraction.id)) continue;
      const { __repairPackage, ...cleanAttraction } = attraction;
      records.push({
        provinceName,
        attraction: { ...cleanAttraction, ...(overrides[attraction.id] || {}) },
        dataLayer: __repairPackage ? 'repair-package' : 'manual',
      });
      ids.add(attraction.id);
    }
  }
  return records;
}

function isPendingTarget({ provinceName, attraction, dataLayer }) {
    if (provinceFilter && provinceName !== provinceFilter) return false;
    if (repairOnly && dataLayer !== 'repair-package') return false;
    if (nameFilter && !String(attraction.name || '').includes(nameFilter)) return false;
    if (isExcludedName(String(attraction.name || '')) && !corePreferredIds.has(attraction.id)) return false;
    const alreadyXhs = attraction.lazy_ai_source?.source === 'xiaohongshu-dian-dian-ai-chat';
    if (!force && alreadyXhs) {
      if (!refreshDynamic) return false;
      const text = String(attraction.lazy_ai_text || '');
      if (!/(?:\d+(?:\.\d+)?\s*元|门票|票价|开放时间|闭馆时间|\d{1,2}:\d{2})/.test(text)) return false;
    }
    return true;
}

function collectRecords() {
  return buildAllRecords()
    .filter(isPendingTarget)
    .sort((a, b) => {
      const repairPriority = Number(b.dataLayer === 'repair-package') - Number(a.dataLayer === 'repair-package');
      return repairPriority || Number(b.attraction.rating || 0) - Number(a.attraction.rating || 0);
    });
}

function printStats() {
  const rows = buildAllRecords();
  const byProvince = new Map();
  for (const row of rows) {
    if (provinceFilter && row.provinceName !== provinceFilter) continue;
    const item = byProvince.get(row.provinceName) || { total: 0, excluded: 0, xhs: 0, pending: 0 };
    item.total += 1;
    if (isExcludedName(String(row.attraction.name || '')) && !corePreferredIds.has(row.attraction.id)) item.excluded += 1;
    else if (row.attraction.lazy_ai_source?.source === 'xiaohongshu-dian-dian-ai-chat') item.xhs += 1;
    else item.pending += 1;
    byProvince.set(row.provinceName, item);
  }
  const result = [...byProvince.entries()]
    .map(([province, value]) => ({ province, ...value }))
    .sort((a, b) => b.pending - a.pending || a.province.localeCompare(b.province, 'zh-Hans-CN'));
  const total = result.reduce((acc, row) => {
    for (const key of ['total', 'excluded', 'xhs', 'pending']) acc[key] += row[key];
    return acc;
  }, { total: 0, excluded: 0, xhs: 0, pending: 0 });
  console.log(JSON.stringify({ scope: provinceFilter || '全国', total, provinces: result }, null, 2));
}

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate));
}

function loginRequiredText(text) {
  return /登录探索更多内容|登录后查看搜索结果|登录后推荐更懂你的笔记|小红书如何扫码|扫码登录/.test(text);
}

function restrictedText(text) {
  return /访问受限|操作频繁|请求频繁|当前访问存在异常|网络环境存在风险|稍后再试|账号存在风险/.test(text);
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function openBrowser() {
  const executablePath = findBrowser();
  if (!executablePath) throw new Error('Chrome or Edge was not found. Set CHROME_PATH and retry.');
  fs.mkdirSync(runtimeDir, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath,
    headless: (visible || background) ? false : 'new',
    userDataDir: profileDir,
    protocolTimeout: 180000,
    defaultViewport: { width: 1440, height: 1000 },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      ...(background ? ['--window-position=-32000,-32000', '--window-size=1440,1000'] : []),
    ],
  });
  const pages = await browser.pages();
  const page = pages[0] || await browser.newPage();
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(60000);
  return { browser, page };
}

async function waitForLogin(page) {
  const started = Date.now();
  while (Date.now() - started < loginTimeoutMs) {
    const body = await page.evaluate(() => document.body.innerText || '').catch(() => '');
    if (!loginRequiredText(body) && /点点|搜索或者输入任何问题|AI/.test(body)) return true;
    await sleep(1500);
  }
  return false;
}

async function scrapeOne(page, target) {
  const prompt = promptFor(target.attraction);
  const url = `https://www.xiaohongshu.com/ai_chat_tab?searchKeyWord=${encodeURIComponent(prompt)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(1800);
  const initialBody = await page.evaluate(() => document.body.innerText || '');
  if (loginRequiredText(initialBody)) return { ok: false, reason: 'login_required', prompt };
  if (restrictedText(initialBody)) return { ok: false, reason: 'restricted', prompt };

  const started = Date.now();
  let best = '';
  let stable = 0;
  while (Date.now() - started < answerWaitMs) {
    const body = await page.evaluate(() => document.body.innerText || '');
    if (restrictedText(body)) return { ok: false, reason: 'restricted', prompt, answerPreview: best.slice(0, 1000) };
    const answer = cleanupAnswer(body, prompt);
    if (answer.length > best.length) {
      best = answer;
      stable = 0;
    } else if (answer === best && answer.length > 0) {
      stable += 1;
    }
    const sanitized = finalSanitizeAnswer(best);
    const quality = answerQuality(sanitized, prompt);
    if (quality.complete && stable >= 2) return { ok: true, prompt, answer: sanitized, quality };
    await sleep(1000);
  }
  const sanitized = finalSanitizeAnswer(best);
  return { ok: false, reason: 'incomplete_answer', prompt, answerPreview: sanitized.slice(0, 1000), quality: answerQuality(sanitized, prompt) };
}

function backupOverrides() {
  if (!fs.existsSync(overridesPath)) return '';
  const backupDir = path.join(runtimeDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `lazy-guide-overrides.${nowIso().replace(/[:.]/g, '-')}.json`);
  fs.copyFileSync(overridesPath, backupPath);
  return backupPath;
}

async function runLogin() {
  writeProgress({ status: 'login_waiting', message: '请在浏览器中扫码登录小红书点点。' });
  const { browser, page } = await openBrowser();
  try {
    await page.goto('https://www.xiaohongshu.com/ai_chat_tab', { waitUntil: 'domcontentloaded', timeout: 60000 });
    const loggedIn = await waitForLogin(page);
    if (!loggedIn) throw new Error('等待登录超时，请重新运行登录命令。');
    writeProgress({ status: 'login_ready', message: '登录状态已保存，可以运行全国或指定省份的增量采集。' });
    console.log('Xiaohongshu login is ready. The profile was saved locally.');
  } finally {
    await browser.close().catch(() => {});
  }
}

async function runCollection() {
  const allTargets = collectRecords();
  const targets = limit > 0 ? allTargets.slice(0, limit) : allTargets;
  if (!targets.length) {
    writeProgress({
      status: 'done',
      message: '当前范围没有待更新目标。',
      scope: provinceFilter || '全国',
      current: '',
      index: 0,
      total: 0,
      percent: 0,
      success: 0,
      failed: 0,
    });
    console.log('No pending targets.');
    return;
  }
  if (fs.existsSync(stopPath)) fs.rmSync(stopPath, { force: true });
  const results = [];
  let success = 0;
  let failed = 0;
  let backup = '';
  let overrides = readJson(overridesPath, {});
  writeProgress({
    status: 'running',
    message: write ? '正在增量采集并写入攻略覆盖层。' : '正在试跑，不写文件。',
    scope: provinceFilter || '全国',
    index: 0,
    total: targets.length,
    success,
    failed,
    stack: '',
  });
  const { browser, page } = await openBrowser();
  try {
    await page.goto('https://www.xiaohongshu.com/explore', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);
    const homeBody = await page.evaluate(() => document.body.innerText || '').catch(() => '');
    if (loginRequiredText(homeBody)) {
      writeProgress({ status: 'login_required', message: '登录已失效，请先在总控任务中心完成登录。', index: 0, total: targets.length, success, failed });
      return;
    }
    if (restrictedText(homeBody)) {
      writeProgress({ status: 'restricted', message: '小红书当前限制自动访问，任务已暂停；请稍后从总控继续，不要反复扫码。', index: 0, total: targets.length, success, failed });
      return;
    }
    for (let index = 0; index < targets.length; index += 1) {
      if (fs.existsSync(stopPath)) break;
      const target = targets[index];
      const current = `${target.provinceName}/${target.attraction.name}`;
      writeProgress({ status: 'running', current, index, total: targets.length, success, failed });
      let result;
      try {
        result = await scrapeOne(page, target);
        if (result.reason === 'incomplete_answer') {
          writeProgress({ status: 'running', message: `${current} 回答不完整，等待 3 秒后自动刷新重试一次。`, current, index, total: targets.length, success, failed });
          await sleep(3000);
          const retry = await scrapeOne(page, target);
          if (retry.ok || Number(retry.quality?.length || 0) > Number(result.quality?.length || 0)) result = retry;
        }
      } catch (error) {
        result = { ok: false, reason: 'error', error: error.message, prompt: promptFor(target.attraction) };
      }
      results.push({ province: target.provinceName, id: target.attraction.id, name: target.attraction.name, dataLayer: target.dataLayer, ...result });
      if (result.reason === 'login_required') {
        writeProgress({ status: 'login_required', message: '登录已失效，请先运行 npm run xhs:login。', current, index, total: targets.length, success, failed });
        break;
      }
      if (result.reason === 'restricted') {
        writeProgress({ status: 'restricted', message: '小红书触发访问限制，任务已安全暂停；已保存的结果不会丢失，请稍后续跑。', current, index, total: targets.length, success, failed });
        break;
      }
      if (result.ok) {
        success += 1;
        if (write) {
          if (!backup) backup = backupOverrides();
          overrides[target.attraction.id] = {
            lazy_ai_text: result.answer,
            lazy_ai_source: {
              source: 'xiaohongshu-dian-dian-ai-chat',
              prompt: result.prompt,
              updatedAt: nowIso(),
            },
          };
          atomicWriteJson(overridesPath, overrides);
        }
      } else {
        failed += 1;
      }
      atomicWriteJson(samplesPath, results.slice(-100));
      writeProgress({ status: 'running', current, index: index + 1, total: targets.length, success, failed, backup });
      await sleep(requestDelayMs);
    }
  } finally {
    await browser.close().catch(() => {});
  }
  const stopped = fs.existsSync(stopPath);
  const finalProgress = readJson(progressPath, {});
  if (!['login_required', 'restricted'].includes(finalProgress.status)) {
    const status = stopped ? 'stopped' : (failed > 0 ? 'partial' : 'done');
    const message = stopped ? '已在安全点停止。' : (failed > 0 ? '任务已完成，失败项保留到下次续跑。' : '采集完成。');
    writeProgress({ status, message, success, failed, backup });
  }
  const hasPendingRepairPackage = results.some(row => row.ok && row.dataLayer === 'repair-package');
  if (generateAfter && write && success > 0 && hasPendingRepairPackage && !['login_required', 'restricted'].includes(finalProgress.status)) {
    writeProgress({
      status: stopped ? 'stopped' : 'done',
      message: '补全包攻略已保存；请回到总控进行质量闸门确认，批准写入后再生成发布数据。',
      success,
      failed,
      backup,
    });
  } else if (generateAfter && write && success > 0 && !['login_required', 'restricted'].includes(finalProgress.status)) {
    writeProgress({ status: 'generating', message: '采集结果已保存，正在重新生成静态数据。', success, failed, backup });
    const generated = spawnSync(process.execPath, [path.join('scripts', 'generate_static_data.js')], {
      cwd: rootDir,
      stdio: 'inherit',
      shell: false,
    });
    if (generated.status !== 0) {
      writeProgress({ status: 'error', message: '攻略已保存，但静态数据生成失败，请在总控中运行生成与校验。', success, failed, backup });
      process.exitCode = 1;
      return;
    }
    writeProgress({ status: stopped ? 'stopped' : 'done', message: stopped ? '已停止，成功结果已生成。' : '采集完成，静态数据已更新。', success, failed, backup });
  }
  if (failed > 0) process.exitCode = 2;
}

function recoverAcceptedSamples() {
  const samples = readJson(samplesPath, []);
  let overrides = readJson(overridesPath, {});
  let backup = '';
  let recovered = 0;
  for (const row of samples) {
    const answer = row.answer || row.answerPreview || '';
    const quality = answerQuality(answer);
    if (!row.id || overrides[row.id] || !quality.complete) continue;
    if (!backup) backup = backupOverrides();
    overrides[row.id] = {
      lazy_ai_text: answer,
      lazy_ai_source: {
        source: 'xiaohongshu-dian-dian-ai-chat',
        prompt: row.prompt,
        updatedAt: nowIso(),
      },
    };
    recovered += 1;
  }
  atomicWriteJson(overridesPath, overrides);
  writeProgress({ status: 'recovered', message: `Recovered ${recovered} complete captured answers.`, recovered, backup });
  console.log(`Recovered ${recovered} complete captured answers.`);
}

async function main() {
  fs.mkdirSync(runtimeDir, { recursive: true });
  if (loginMode) await runLogin();
  else if (sanitizeStored) sanitizeStoredOverrides();
  else if (recoverMode) recoverAcceptedSamples();
  else if (statsMode) printStats();
  else if (listMode) {
    const targets = collectRecords();
    console.log(JSON.stringify(targets.map(target => ({ province: target.provinceName, id: target.attraction.id, name: target.attraction.name, source: target.attraction.lazy_ai_source?.source || 'missing' })), null, 2));
  }
  else await runCollection();
}

main().catch(error => {
  writeProgress({ status: 'error', message: error.message, stack: error.stack });
  console.error(error);
  process.exitCode = 1;
});
