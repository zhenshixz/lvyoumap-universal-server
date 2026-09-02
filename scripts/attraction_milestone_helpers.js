const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const milestoneName = process.env.ATTRACTION_MILESTONE || 'priority-01';
const milestoneDir = path.join(root, '.runtime', 'attraction-content-milestones', milestoneName);
const manifestPath = path.join(milestoneDir, 'manifest.json');
const rawDir = path.join(milestoneDir, 'raw');
const labels = ['简介', '春秋', '夏季', '冬季', '穿衣提示', '外部到达', '内部游览', '交通提醒', '住宿1', '住宿2', '美食', '老人', '儿童'];

function readManifest() {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
}
function writeAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\r\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}
function stable(value) {
  return String(value || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\*\*/g, '')
    .replace(/\d+(?:\.\d+)?\s*(?:万)?平方米/g, '')
    .replace(/高\d+(?:\.\d+)?米/g, '')
    .replace(/(?:近期|目前|正在|将于|曾于)[^。；]*(?:活动|演出|赛事)[^。；]*[。；]?/g, '')
    .replace(/(?:夜晚|夜间)[^。；]*(?:表演|灯会|光影秀|喷泉)[^。；]*[。；]?/g, '')
    .replace(/\s+/g, ' ')
    .replace(/，{2,}/g, '，')
    .trim();
}
function field(segment, label) {
  const direct = segment
    .split(/[｜|\r\n]+/)
    .map(value => value.trim())
    .find(value => value.startsWith(`${label}：`) || value.startsWith(`${label}:`));
  if (direct) return direct.slice(label.length + 1).trim();
  const match = segment.match(new RegExp(`${label}[ \\t]*(?:[：:]|\\r?\\n)`));
  if (!match) return '';
  const start = match.index + match[0].length;
  let end = segment.length;
  for (const other of labels) {
    if (other === label) continue;
    const next = segment.slice(start).match(new RegExp(`(?:[｜|][ \\t]*|\\r?\\n[ \\t]*)${other}[ \\t]*(?:[：:]|\\r?\\n)`));
    if (next && start + next.index < end) end = start + next.index;
  }
  return segment.slice(start, end).replace(/^[｜|\s]+|[｜|\s]+$/g, '').trim();
}
function parseGuideBody(body, items) {
  const clean = String(body || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\*\*/g, '');
  const positions = items.map(item => {
    const queryName = `${item.province}${item.city}${item.name}`;
    const promptPosition = clean.lastIndexOf(`景点：`);
    const answerStart = clean.indexOf('ai总结', Math.max(0, promptPosition));
    const searchStart = answerStart >= 0 ? answerStart : Math.max(0, promptPosition + 3);
    const exactPosition = clean.indexOf(queryName, searchStart);
    const namePosition = clean.indexOf(item.name, searchStart);
    const position = exactPosition >= 0 ? exactPosition : namePosition;
    return { item, queryName: exactPosition >= 0 ? queryName : item.name, position };
  })
    .filter(entry => entry.position >= 0).sort((a, b) => a.position - b.position);
  const parsed = {};
  for (let index = 0; index < positions.length; index += 1) {
    const { item, queryName, position } = positions[index];
    let segment = clean.slice(position + queryName.length, positions[index + 1]?.position || clean.length)
      .replace(/\n活动[\s\S]*$/, '').trim()
      .replace(/^\s*(?:ID)?\s*[｜|：:]?\s*amap_[A-Z0-9]+\s*/, '')
      .replace(/^\s*[｜|]\s*/, '');
    const values = Object.fromEntries(labels.map(label => [label, field(segment, label)]));
    if (!values.简介) {
      const boundary = segment.search(/春秋[ \t]*(?:[：:]|\r?\n)/);
      values.简介 = boundary > 0 ? segment.slice(0, boundary).replace(/^[｜|\s]+|[｜|\s]+$/g, '').trim() : '';
    }
    const intro = stable(values.简介);
    const housing1 = values.住宿1.split('^');
    const housing2 = values.住宿2.split('^');
    const food = values.美食.split('^').map(value => value.replace(/[。；]+$/g, '').trim()).filter(Boolean).slice(0, 4);
    const guideData = {
      clothing: { spring_autumn: stable(values.春秋), summer: stable(values.夏季), winter: stable(values.冬季), tips: stable(values.穿衣提示) },
      transport: { external_arrive: stable(values.外部到达), internal_arrive: stable(values.内部游览), internal_traffic: stable(values.内部游览), tips: stable(values.交通提醒) },
      housing: [
        { area: (housing1[0] || '城区').trim(), desc: (housing1.slice(1).join('^') || '按实时交通选择住宿区域。').trim() },
        { area: (housing2[0] || '公共交通沿线').trim(), desc: (housing2.slice(1).join('^') || '便于按实时交通前往景点。').trim() },
      ],
      food,
      special_care: { elderly: stable(values.老人), children: stable(values.儿童) },
    };
    const required = [intro, ...Object.values(guideData.clothing), ...Object.values(guideData.transport), guideData.special_care.elderly, guideData.special_care.children];
    if (intro.length < 25 || required.some(value => !value) || food.length < 3) {
      if (process.env.ATTRACTION_DEBUG === '1') {
        const missing = labels.filter(label => !values[label]);
        console.log(`[guide-parse] ${item.province}${item.city}${item.name}: intro=${intro.length}, food=${food.length}, missing=${missing.join(',') || 'none'}`);
      }
      continue;
    }
    parsed[item.id] = { intro, description: intro, guide_data: guideData, raw: segment };
  }
  return parsed;
}
function guidePrompt(items) {
  return `只回答以下准确省市实体，禁止混入同名异地。每个景点只输出一行，不要Markdown、表格、解释、客套或图片。严格使用“省份+城市+景点名｜简介：…｜春秋：…｜夏季：…｜冬季：…｜穿衣提示：…｜外部到达：…｜内部游览：…｜交通提醒：…｜住宿1：区域^说明｜住宿2：区域^说明｜美食：食物1^食物2^食物3^食物4｜老人：…｜儿童：…”格式，一个字段都不能省略。简介30-55字，其他字段各8-25字，只保留准确可执行信息；禁止面积高度、固定票价班次、门店、活动演出和临时信息。景点：${items.map(item => `${item.province}${item.city}${item.name}`).join('；')}`;
}
function nextGuideItems(limit = 6) {
  return readManifest().items
    .filter(item => item.repairKinds.some(kind => kind === 'guideTemplate' || kind === 'guideMissing') && item.guideStatus !== 'collected')
    .sort((left, right) => (left.guideAttempts || 0) - (right.guideAttempts || 0))
    .slice(0, limit);
}
function saveGuideBody(body, items, batchNumber) {
  const manifest = readManifest();
  const parsed = parseGuideBody(body, items);
  fs.mkdirSync(rawDir, { recursive: true });
  fs.writeFileSync(path.join(rawDir, `guide-${String(batchNumber).padStart(3, '0')}.txt`), body, 'utf8');
  for (const requested of items) {
    const result = parsed[requested.id];
    const item = manifest.items.find(value => value.id === requested.id);
    if (!item) continue;
    item.guideAttempts = (item.guideAttempts || 0) + 1;
    item.lastGuideAttemptAt = new Date().toISOString();
    if (!result) continue;
    item.proposed = { ...item.proposed, intro: result.intro, description: result.description, guide_data: result.guide_data };
    item.sources = [...(item.sources || []).filter(source => source.field !== 'intro+guide_data'), { type: 'xiaohongshu-dian-dian-ai-chat', field: 'intro+guide_data', collectedAt: new Date().toISOString() }];
    item.guideStatus = 'collected';
    item.status = item.repairKinds.includes('lazy') ? 'pending_lazy' : 'collected';
  }
  manifest.status = 'collecting';
  manifest.updatedAt = new Date().toISOString();
  writeAtomic(manifestPath, manifest);
  return { parsed: Object.keys(parsed).length, requested: items.length };
}
function recoverGuideRaw(batchNumber, items) {
  const rawPath = path.join(rawDir, `guide-${String(batchNumber).padStart(3, '0')}.txt`);
  return saveGuideBody(fs.readFileSync(rawPath, 'utf8'), items, batchNumber);
}
function stats() {
  const manifest = readManifest();
  const guideItems = manifest.items.filter(item => item.repairKinds.some(kind => kind === 'guideTemplate' || kind === 'guideMissing'));
  const entityOnly = manifest.items.filter(item => item.repairKinds.includes('entity') && !item.repairKinds.some(kind => kind === 'guideTemplate' || kind === 'guideMissing'));
  return {
    total: manifest.items.length,
    guideTotal: guideItems.length,
    guideCollected: guideItems.filter(item => item.guideStatus === 'collected').length,
    guidePending: guideItems.filter(item => item.guideStatus !== 'collected').length,
    entityOnlyPending: entityOnly.filter(item => item.introStatus !== 'collected').length,
    lazyPending: manifest.items.filter(item => item.repairKinds.includes('lazy') && item.lazyStatus !== 'collected').length,
  };
}

function introPrompt(items) {
  return `只回答以下准确省市实体，禁止混入同名异地。每个景点只输出一行，严格使用“省份+城市+景点名｜简介：…”格式，不要Markdown、表格、解释、客套或图片。简介35-60字，只写准确位置、景点性质和核心特色；禁止面积高度、票价班次、活动演出、宣传口号和临时信息。景点：${items.map(item => `${item.province}${item.city}${item.name}`).join('；')}`;
}
function parseIntroBody(body, items) {
  const clean = String(body || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\*\*/g, '');
  const answerStart = Math.max(clean.indexOf('ai总结'), clean.lastIndexOf('景点：'));
  const answer = clean.slice(Math.max(0, answerStart)).replace(/\n活动[\s\S]*$/, '');
  const parsed = {};
  const candidates = [...answer.matchAll(/([^\n｜|]{2,120})[｜|]\s*简介[:：]\s*([^\n]+)/g)].map(match => ({
    title: stable(match[1]),
    intro: stable(match[2].replace(/[。\r\n]+$/g, '')),
  })).filter(candidate => candidate.intro.length >= 25);
  const normalized = value => String(value || '').replace(/[省市区县自治州地区特别行政]+/g, '').replace(/[^\p{L}\p{N}]/gu, '');
  const similarity = (left, right) => {
    const a = normalized(left);
    const b = normalized(right);
    if (!a || !b) return 0;
    if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) + 20;
    const chars = new Set(a);
    return [...new Set(b)].filter(char => chars.has(char)).length / Math.max(a.length, b.length);
  };
  for (const item of items) {
    const marker = `${item.name}｜简介：`;
    let position = answer.indexOf(marker);
    while (position >= 0) {
      const prefix = answer.slice(Math.max(0, position - 45), position);
      if (prefix.includes(item.province.slice(0, 2)) && prefix.includes(item.city.slice(0, 2))) break;
      position = answer.indexOf(marker, position + marker.length);
    }
    let intro = '';
    if (position >= 0) {
      const tail = answer.slice(position + marker.length);
      intro = stable((tail.match(/^.*?[。\r\n]/)?.[0] || tail.split(/[｜|]/)[0]).replace(/[。\r\n]+$/g, ''));
    } else {
      const provinceMatches = candidates.filter(candidate => candidate.title.includes(item.province.slice(0, 2)));
      const cityMatches = provinceMatches.filter(candidate => candidate.title.includes(item.city.slice(0, 2)));
      const pool = cityMatches.length ? cityMatches : provinceMatches;
      const candidate = [...pool].sort((left, right) => similarity(right.title, item.name) - similarity(left.title, item.name))[0];
      intro = candidate?.intro || '';
    }
    if (intro.length < 25) continue;
    parsed[item.id] = { intro, description: intro };
  }
  return parsed;
}
function nextIntroItems(limit = 5) {
  return readManifest().items
    .filter(item => item.repairKinds.includes('entity') && !item.repairKinds.some(kind => kind === 'guideTemplate' || kind === 'guideMissing') && item.introStatus !== 'collected')
    .sort((left, right) => (left.introAttempts || 0) - (right.introAttempts || 0))
    .slice(0, limit);
}
function saveIntroBody(body, items, batchNumber) {
  const manifest = readManifest();
  const parsed = parseIntroBody(body, items);
  fs.mkdirSync(rawDir, { recursive: true });
  fs.writeFileSync(path.join(rawDir, `intro-${String(batchNumber).padStart(3, '0')}.txt`), body, 'utf8');
  for (const requested of items) {
    const item = manifest.items.find(value => value.id === requested.id);
    if (!item) continue;
    item.introAttempts = (item.introAttempts || 0) + 1;
    item.lastIntroAttemptAt = new Date().toISOString();
    if (!parsed[item.id]) continue;
    item.proposed = { ...item.proposed, ...parsed[item.id] };
    item.sources = [...(item.sources || []).filter(source => source.field !== 'intro'), { type: 'xiaohongshu-dian-dian-ai-chat', field: 'intro', collectedAt: new Date().toISOString() }];
    item.introStatus = 'collected';
    item.status = item.repairKinds.includes('lazy') ? 'pending_lazy' : 'collected';
  }
  manifest.updatedAt = new Date().toISOString();
  writeAtomic(manifestPath, manifest);
  return { parsed: Object.keys(parsed).length, requested: items.length };
}

function lazyPrompt(items) {
  return `只为以下准确省市实体写懒人攻略，禁止回答同名异地、禁止扩展到其他景点。每个景点单独输出，标题必须原样写省份+城市+景点名。正文依次包含：一句话建议、推荐路线、游览亮点、老人提示、儿童提示、避坑提醒。路线以该景点内部真实游览顺序为主；没有复杂线路时写一条简短游览顺序，不得编造节点。不要住宿、美食、穿衣、固定票价、固定班次、临时活动和客套话。景点：${items.map(item => `${item.province}${item.city}${item.name}`).join('；')}`;
}
function parseLazyBody(body, items) {
  const clean = String(body || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\*\*/g, '').trim();
  const parsed = {};
  for (const item of items) {
    const queryName = `${item.province}${item.city}${item.name}`;
    const promptPosition = clean.lastIndexOf(`景点：${queryName}`);
    if (promptPosition < 0) continue;
    let text = clean.slice(promptPosition + `景点：${queryName}`.length)
      .replace(/^\s*(?:ai总结\d+篇笔记生成)?\s*/i, '')
      .replace(/\n活动[\s\S]*$/, '')
      .trim();
    const answerTitle = [queryName, `${item.province}${item.name}`, `${item.city}${item.name}`]
      .find(title => text.includes(title));
    if (answerTitle) text = text.slice(text.indexOf(answerTitle) + answerTitle.length).trim();
    const hasRoute = /推荐路线|游览路线|游览顺序|路线/.test(text);
    const hasElderly = /老人|长辈/.test(text);
    const hasChildren = /儿童|孩子|小孩/.test(text);
    const hasPitfall = /避坑|提醒|注意/.test(text);
    const ambiguity = /如果你指的是|全国有好几个|另一个是|方案二|其他同名/.test(text);
    if (text.length < 220 || !hasRoute || !hasElderly || !hasChildren || !hasPitfall || ambiguity) continue;
    parsed[item.id] = text;
  }
  return parsed;
}
function nextLazyItems(limit = 4) {
  return readManifest().items
    .filter(item => item.repairKinds.includes('lazy') && item.lazyStatus !== 'collected')
    .sort((left, right) => (left.lazyAttempts || 0) - (right.lazyAttempts || 0))
    .slice(0, limit);
}
function saveLazyBody(body, items, batchNumber) {
  const manifest = readManifest();
  const parsed = parseLazyBody(body, items);
  fs.mkdirSync(rawDir, { recursive: true });
  fs.writeFileSync(path.join(rawDir, `lazy-${String(batchNumber).padStart(3, '0')}.txt`), body, 'utf8');
  for (const requested of items) {
    const item = manifest.items.find(value => value.id === requested.id);
    if (!item) continue;
    item.lazyAttempts = (item.lazyAttempts || 0) + 1;
    item.lastLazyAttemptAt = new Date().toISOString();
    if (!parsed[item.id]) continue;
    item.proposed = { ...item.proposed, lazy_ai_text: parsed[item.id] };
    item.sources = [...(item.sources || []).filter(source => source.field !== 'lazy_ai_text'), { type: 'xiaohongshu-dian-dian-ai-chat', field: 'lazy_ai_text', collectedAt: new Date().toISOString() }];
    item.lazyStatus = 'collected';
    item.status = 'collected';
  }
  manifest.updatedAt = new Date().toISOString();
  writeAtomic(manifestPath, manifest);
  return { parsed: Object.keys(parsed).length, requested: items.length };
}

module.exports = { guidePrompt, introPrompt, lazyPrompt, nextGuideItems, nextIntroItems, nextLazyItems, parseGuideBody, parseIntroBody, parseLazyBody, recoverGuideRaw, saveGuideBody, saveIntroBody, saveLazyBody, stats };
