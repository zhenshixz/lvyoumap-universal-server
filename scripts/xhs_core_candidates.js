const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const rootDir = path.join(__dirname, '..');
const runtimeDir = path.join(rootDir, '.runtime');
const profileDir = path.join(runtimeDir, 'xhs-profile');
const args = new Map(process.argv.slice(2).map(arg => {
  const match = arg.match(/^--([^=]+)=(.*)$/);
  return match ? [match[1], match[2]] : [arg.replace(/^--/, ''), true];
}));
const provinceName = String(args.get('province') || '');

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

function findBrowser() {
  return [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean).find(file => fs.existsSync(file));
}

function loginRequired(text) {
  return /登录探索更多内容|登录后查看搜索结果|登录后推荐更懂你的笔记|小红书如何扫码|扫码登录/.test(text);
}

function restricted(text) {
  return /访问受限|操作频繁|请求频繁|当前访问存在异常|网络环境存在风险|稍后再试|账号存在风险/.test(text);
}

function cleanText(value) {
  return String(value || '').replace(/\r/g, '\n').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function parseCandidates(answer) {
  const candidates = [];
  function add(nameValue, cityValue) {
    const name = String(nameValue || '').replace(/^[\d.、）)\-*•]+/, '').replace(/[《》“”]/g, '').trim();
    const city = String(cityValue || '').replace(/(?:市|地区)$/, '').trim();
    if (name.length < 2 || city.length < 2) return;
    if (/景点名|核心景点|所在城市|候选|根据|整理/.test(name) || /城市|景点/.test(city)) return;
    if (!candidates.some(item => item.name === name)) candidates.push({ name, city });
  }
  for (const match of answer.matchAll(/([^\s|｜。，,：:]{2,30})[|｜]\s*([^\s|｜。，,：:]{2,12})/g)) add(match[1], match[2]);
  for (const rawLine of answer.split(/\n+/)) {
    const line = rawLine.trim();
    const match = line.match(/^([^\s：:。]{2,30})[：:]\s*([^。\s，,]{2,12})[。.]/);
    if (match) add(match[1], match[2]);
  }
  return candidates;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function tryResumeAnswer(page) {
  return page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
    const controls = [...document.querySelectorAll('button, [role="button"]')];
    const target = controls.find(element => {
      const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
      const visible = element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
      return visible && /^(继续生成|继续回答|继续|重试|再试一次)$/.test(text);
    });
    if (!target) return false;
    target.click();
    return true;
  }).catch(() => false);
}

function mergeCandidates(target, candidates) {
  for (const candidate of candidates) {
    if (!target.some(item => item.name === candidate.name)) target.push(candidate);
  }
}

async function main() {
  if (!provinceName) throw new Error('请使用 --province=省份。');
  const db = readJson(path.join(rootDir, 'content', 'db.json'), { provinces: {} });
  const province = db.provinces?.[provinceName];
  if (!province) throw new Error(`基础数据库中没有找到省份：${provinceName}`);
  const executablePath = findBrowser();
  if (!executablePath) throw new Error('没有找到 Chrome 或 Edge。');
  fs.mkdirSync(runtimeDir, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath,
    headless: false,
    userDataDir: profileDir,
    defaultViewport: { width: 1440, height: 1000 },
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  try {
    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    await page.goto('https://www.xiaohongshu.com/explore', { waitUntil: 'domcontentloaded' });
    await sleep(3000);
    let body = await page.evaluate(() => document.body.innerText || '');
    if (loginRequired(body)) throw new Error('小红书未登录，请先在总控任务中心完成登录。');
    if (restricted(body)) throw new Error('小红书当前限制访问，请稍后再试，不要反复刷新。');
    const prompt = `请整理${provinceName}省适合作为全国旅游地图核心景点的口碑目的地候选。参考小红书长期高频真实讨论，不要只列5A；兼顾自然、人文、古城古村、博物馆、度假区和城市地标；排除普通公园、普通商场、车站、景区内部小景点和只适合本地短途的点。严格每行输出：景点名｜所在城市。只输出18到25行，不要序号、理由、标题或其他文字。`;
    const collected = [];
    const attemptStats = [];
    const attemptAnswers = [];
    const filePath = path.join(runtimeDir, `core-popularity-${province.id || provinceName}.json`);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const attemptPrompt = attempt === 1 ? prompt : `${prompt}\n这是第${attempt}次尝试，请从头完整输出，不要在中途停止。`;
      console.log(`正在请求点点（第 ${attempt}/3 次）……`);
      if (attempt > 1) await page.goto('about:blank', { waitUntil: 'domcontentloaded' });
      await page.goto(`https://www.xiaohongshu.com/ai_chat_tab?searchKeyWord=${encodeURIComponent(attemptPrompt)}`, { waitUntil: 'domcontentloaded' });
      await sleep(1500);
      let best = '';
      let stable = 0;
      let resumed = false;
      let lastGrowthAt = Date.now();
      const started = Date.now();
      while (Date.now() - started < 20000) {
        body = await page.evaluate(() => document.body.innerText || '').catch(() => '');
        if (loginRequired(body)) throw new Error('小红书登录状态失效。');
        if (restricted(body)) throw new Error('小红书当前限制访问，任务已安全停止。');
        const index = body.indexOf(attemptPrompt);
        const answer = cleanText(index >= 0 ? body.slice(index + attemptPrompt.length) : body);
        if (answer.length > best.length) {
          best = answer;
          stable = 0;
          lastGrowthAt = Date.now();
        } else if (answer === best && best) stable += 1;
        const parsed = parseCandidates(best);
        mergeCandidates(collected, parsed);
        if (parsed.length >= 18 && stable >= 2) {
          const output = {
            province: provinceName,
            source: 'xiaohongshu-dian-dian-ai-chat',
            prompt,
            updatedAt: new Date().toISOString(),
            attempts: [...attemptStats, { attempt, parsed: parsed.length, resumed }],
            candidates: parsed.slice(0, 25),
          };
          writeJson(filePath, output);
          console.log(`${provinceName}口碑核心候选采集完成：${output.candidates.length} 个。`);
          console.log(filePath);
          return;
        }
        const initialGrace = parsed.length === 0 ? 8000 : 3000;
        if (Date.now() - lastGrowthAt >= initialGrace) {
          if (!resumed && await tryResumeAnswer(page)) {
            resumed = true;
            lastGrowthAt = Date.now();
            console.log('回答停止增长，已尝试继续生成。');
          } else {
            console.log(`第 ${attempt} 次回答停止在 ${parsed.length} 个候选，立即重试。`);
            break;
          }
        }
        await sleep(700);
      }
      const parsed = parseCandidates(best);
      attemptStats.push({ attempt, parsed: parsed.length, resumed });
      attemptAnswers.push(best.slice(0, 12000));
      mergeCandidates(collected, parsed);
    }
    if (collected.length >= 18) {
      const output = {
        province: provinceName,
        source: 'xiaohongshu-dian-dian-ai-chat',
        prompt,
        updatedAt: new Date().toISOString(),
        attempts: attemptStats,
        candidates: collected.slice(0, 25),
      };
      writeJson(filePath, output);
      console.log(`${provinceName}口碑核心候选经重试合并完成：${output.candidates.length} 个。`);
      console.log(filePath);
      return;
    }
    const partialPath = path.join(runtimeDir, `core-popularity-${province.id || provinceName}.partial.json`);
    writeJson(partialPath, { province: provinceName, prompt, updatedAt: new Date().toISOString(), attempts: attemptStats, candidates: collected, rawAnswers: attemptAnswers });
    throw new Error(`连续3次回答均不完整，合并后只有 ${collected.length} 个候选；诊断草稿已保留。`);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch(error => {
  console.error(`口碑候选采集失败：${error.message}`);
  process.exitCode = 1;
});
