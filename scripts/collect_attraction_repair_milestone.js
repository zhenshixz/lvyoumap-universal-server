const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const root = path.resolve(__dirname, '..');
const milestoneArg = process.argv.find(value => value.startsWith('--milestone='));
const milestone = milestoneArg ? milestoneArg.slice('--milestone='.length) : 'content-01';
process.env.ATTRACTION_MILESTONE = milestone;
const helpers = require('./attraction_milestone_helpers');
const runtime = path.join(root, '.runtime');
const profile = path.join(runtime, 'xhs-profile');
const progressPath = path.join(runtime, 'attraction-content-milestones', milestone, 'progress.json');

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function writeProgress(value) {
  const temporary = `${progressPath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ ...value, updatedAt: new Date().toISOString() }, null, 2)}\r\n`, 'utf8');
  fs.renameSync(temporary, progressPath);
}
function browserPath() {
  return [process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].find(value => value && fs.existsSync(value));
}
function loginRequired(text) { return /登录探索更多内容|登录后查看搜索结果|扫码登录/.test(text); }
function restricted(text) { return /访问受限|操作频繁|请求频繁|网络环境存在风险|稍后再试/.test(text); }

async function collectBody(page, prompt, parse, expected, timeoutMs = 14000) {
  const url = `https://www.xiaohongshu.com/ai_chat_tab?searchKeyWord=${encodeURIComponent(prompt)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const started = Date.now();
  let best = '';
  let bestCount = 0;
  let stable = 0;
  while (Date.now() - started < timeoutMs) {
    const body = await page.evaluate(() => document.body.innerText || '').catch(() => '');
    if (loginRequired(body)) throw new Error('小红书登录状态已失效');
    if (restricted(body)) throw new Error('小红书当前访问受限，请稍后续跑');
    const count = Object.keys(parse(body)).length;
    if (count > bestCount || (count === bestCount && body.length > best.length)) {
      best = body;
      bestCount = count;
      stable = 0;
    } else if (count === bestCount && body.length === best.length) stable += 1;
    if (bestCount === expected && stable >= 2) return best;
    await sleep(400);
  }
  return best;
}

async function run() {
  const executablePath = browserPath();
  if (!executablePath) throw new Error('找不到 Chrome 或 Edge');
  const browser = await puppeteer.launch({
    executablePath,
    headless: false,
    userDataDir: profile,
    protocolTimeout: 180000,
    defaultViewport: { width: 1360, height: 900 },
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-position=-32000,-32000', '--window-size=1360,900'],
  });
  const pages = await browser.pages();
  const page = pages[0] || await browser.newPage();
  page.setDefaultTimeout(60000);
  let batch = 0;
  let failures = 0;
  try {
    while (true) {
      let intro = helpers.nextIntroItems(5);
      if (intro.length) {
        const attemptLevel = Math.min(...intro.map(item => Number(item.introAttempts || 0)));
        const adaptiveSize = attemptLevel === 0 ? 5 : (attemptLevel === 1 ? 3 : 1);
        intro = intro.slice(0, adaptiveSize);
      }
      const lazy = intro.length ? [] : helpers.nextLazyItems(1);
      const items = intro.length ? intro : lazy;
      if (!items.length) break;
      batch += 1;
      const kind = intro.length ? 'intro' : 'lazy';
      const prompt = intro.length ? helpers.introPrompt(items) : helpers.lazyPrompt(items);
      const parse = body => intro.length ? helpers.parseIntroBody(body, items) : helpers.parseLazyBody(body, items);
      writeProgress({ status: 'running', milestone, batch, kind, current: items.map(item => `${item.province}/${item.city}/${item.name}`), stats: helpers.stats(), failures });
      let body = '';
      let parsed = 0;
      const maxAttempts = intro.length ? 1 : 2;
      for (let recovery = 0; recovery < 4 && parsed === 0; recovery += 1) {
        for (let attempt = 1; attempt <= maxAttempts && parsed < items.length; attempt += 1) {
          body = await collectBody(page, prompt, parse, items.length, intro.length ? 9000 : 18000);
          parsed = Object.keys(parse(body)).length;
          if (parsed < items.length) await sleep(900);
        }
        const analysisStall = parsed === 0 && /问题分析中|正在分析(?:问题)?|正在思考(?:中)?/.test(body);
        if (!analysisStall) break;
        if (recovery >= 3) throw new Error('点点连续停留在问题分析中，任务已保留断点并安全暂停');
        writeProgress({ status: 'recovering', milestone, batch, kind, message: `点点停留在分析状态，正在进行第 ${recovery + 1} 次自愈`, current: items.map(item => `${item.province}/${item.city}/${item.name}`), stats: helpers.stats(), failures });
        await page.goto('https://www.xiaohongshu.com/explore', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await sleep((recovery + 1) * 5000);
      }
      const result = intro.length ? helpers.saveIntroBody(body, items, batch) : helpers.saveLazyBody(body, items, batch);
      if (result.parsed < result.requested) failures += result.requested - result.parsed;
      await sleep(700);
    }
    writeProgress({ status: 'done', milestone, stats: helpers.stats(), failures });
  } finally {
    await browser.close().catch(() => {});
  }
}

run().catch(error => {
  writeProgress({ status: 'paused', milestone, error: error.message, stats: helpers.stats() });
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
