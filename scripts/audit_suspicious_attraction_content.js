const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const provincesDir = path.join(root, "data", "provinces");
const outDir = path.join(root, ".runtime", "reports");
const outPath = path.join(outDir, "CODEX_SUSPICIOUS_ATTRACTION_AUDIT.md");
const publishedProvinces = fs.readdirSync(provincesDir)
  .filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(fs.readFileSync(path.join(provincesDir, name), "utf8").replace(/^\uFEFF/, "")));

const rows = [];
for (const province of publishedProvinces) {
  const provinceName = province.province;
  for (const attraction of province.attractions || []) {
    rows.push({ province: provinceName, ...attraction });
  }
}

const provinceNames = publishedProvinces.map((province) => province.province);
const cityNames = [...new Set(rows.map((item) => item.city).filter(Boolean))]
  .map((name) => String(name).replace(/(市|地区|自治州|特别行政区)$/u, ""))
  .filter((name) => name.length >= 2);
const placeNames = [...new Set([...provinceNames, ...cityNames])].sort((a, b) => b.length - a.length);
const placeProvinceMap = new Map();
for (const item of rows) {
  const city = String(item.city || "").replace(/(市|地区|自治州|特别行政区)$/u, "");
  if (!city) continue;
  if (!placeProvinceMap.has(city)) placeProvinceMap.set(city, new Set());
  placeProvinceMap.get(city).add(item.province);
}

const genericIntroRe = /(自然风光秀丽，是体验当地特色美景的绝佳去处|历史底蕴深厚，是一处非常值得一游的人文胜地|以.+为主要看点。适合纳入.+经典游览线路)/u;
const ambiguityRe = /(国内有(?:好几个|多个|几处)|全国有(?:好几个|多个|多处)|多个同名|主要有两个(?:版本|热门目的地|景点)|可能指(?:的是|多个|两个)|我先按.{0,35}(?:给出|整理|规划)|分别整理.{0,30}(?:路线|方案)|你确认一下(?:是哪个|具体)|你看看是哪一个|最主流的是|默认按.{0,30}(?:整理|回答)|先确认你说的是|如果是其他(?:城市|地点|景区)|如果是.{0,20}可以告诉我(?:再调整)?|不要选错|别和其他)/u;
const visibleTemplateRe = /(本地精选爆款|本地特色美食强烈推荐|拍照打卡特色消暑利器|特色招牌菜|正宗地方风味|票价：70元\/人|推荐区域2)/u;
const lowValueNameRe = /(停车场|售票处|游客中心|服务中心|服务区|收费站|卫生间|出入口|入口$|出口$|公交站|地铁站|转盘$|码头$|商场$|购物中心|拍摄地$|打卡点$|观景台$|纪念碑$|认领的树|一棵树$|剧场$|市民广场$|中心广场$|文化广场$|休闲广场$|商业广场$|时代广场$|世纪广场$)/u;

function compact(value, max = 120) {
  const text = String(value || "").replace(/\s+/g, " ").trim().replace(/\|/g, "｜");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function md(value) {
  return compact(value).replace(/\r?\n/g, " ");
}

function isOwnPlace(item, place) {
  const city = String(item.city || "").replace(/(市|地区|自治州|特别行政区)$/u, "");
  const sameProvinceCity = placeProvinceMap.get(place)?.has(item.province);
  return item.province === place || city === place || city.includes(place) || place.includes(city) || sameProvinceCity;
}

function otherPlaces(item, text) {
  const own = new Set([
    item.province,
    String(item.city || "").replace(/(市|地区|自治州|特别行政区)$/u, "")
  ].filter(Boolean));
  return placeNames.filter((place) => !own.has(place) && !isOwnPlace(item, place) && text.includes(place) && !item.name.includes(place)).slice(0, 5);
}

function strongOtherPlaces(item, text) {
  return otherPlaces(item, text).filter((place) => {
    const escaped = place.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rules = [
      new RegExp(`^.{0,8}${escaped}(?:人|市|的城市|喀斯特|少有|最|版)`),
      new RegExp(`位于[^。；]{0,28}${escaped}(?:省|市|地区|自治州|特别行政区)`),
      new RegExp(`适合纳入${escaped}经典游览线路`),
      new RegExp(`${escaped}(?:人从小|人心里|家庭周末|的城市地标|的城市名片|少有的|周边最|版的)`)
    ];
    return rules.some((rule) => rule.test(text));
  });
}

const genericIntros = [];
const entityMismatches = [];
const ambiguousGuides = [];
const lowValueCandidates = [];
const missingGuideData = [];
const storedTemplateResidue = [];

for (const item of rows) {
  const basicText = `${item.description || ""} ${item.intro || ""}`;
  const lazyText = String(item.lazy_ai_text || "");
  const guideText = JSON.stringify(item.guide_data || {});
  const basicOtherPlaces = strongOtherPlaces(item, basicText);

  if (genericIntroRe.test(basicText)) {
    genericIntros.push({ ...item, issue: compact(item.intro || item.description) });
  }
  if (basicOtherPlaces.length) {
    entityMismatches.push({ ...item, places: basicOtherPlaces, issue: compact(item.intro || item.description, 180) });
  }
  if (ambiguityRe.test(lazyText)) {
    ambiguousGuides.push({ ...item, places: otherPlaces(item, lazyText), issue: compact(lazyText, 180) });
  }
  if (lowValueNameRe.test(item.name)) {
    lowValueCandidates.push({ ...item, issue: "名称更像附属设施、普通城市节点或临时打卡点，需判断是否值得作为独立景点。" });
  }
  if (!item.guide_data) {
    missingGuideData.push(item);
  }
  if (visibleTemplateRe.test(`${basicText} ${lazyText} ${guideText}`)) {
    storedTemplateResidue.push({ ...item, issue: "存量字段含明显模板词。" });
  }
}

const levelCounts = rows.reduce((acc, item) => {
  const key = item.level || "未填写";
  acc[key] = (acc[key] || 0) + 1;
  return acc;
}, {});

function provinceSummary(items) {
  const counts = items.reduce((acc, item) => {
    acc[item.province] = (acc[item.province] || 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

function table(items, mapper, limit = Infinity) {
  if (!items.length) return "无。\n";
  const selected = items.slice(0, limit);
  const lines = ["| 省份/城市 | 景点 | 问题 |", "|---|---|---|"];
  for (const item of selected) {
    lines.push(`| ${md(item.province)} / ${md(item.city)} | ${md(item.name)} | ${md(mapper(item), 240)} |`);
  }
  if (items.length > selected.length) lines.push(`\n> 其余 ${items.length - selected.length} 条见下方省份统计，后续可按批次处理。`);
  return `${lines.join("\n")}\n`;
}

const generatedAt = new Date().toISOString();
const report = `# 全国景点异常内容只读盘点

生成时间：${generatedAt}  
数据源：前端实际读取的 \`data/provinces/*.json\`（由历史库、人工补充层和覆盖层构建后的结果）  
范围：${rows.length} 条景点；本报告没有修改任何景点数据。

## 一眼结论

| 类别 | 数量 | 性质 |
|---|---:|---|
| 基本介绍出现其他省市，疑似实体错配 | ${entityMismatches.length} | 高优先级，通常是明确错误 |
| 懒人攻略含“同名/默认按另一个景点回答”等信号 | ${ambiguousGuides.length} | 高优先级，需重采或人工确认实体 |
| 缺少结构化 \`guide_data\` | ${missingGuideData.length} | 会触发前端编造衣食住行，是图中假内容的直接来源 |
| 使用通用占位介绍 | ${genericIntros.length} | 内容质量问题，不代表景点本身应删除 |
| 名称像附属设施/普通节点/临时打卡点 | ${lowValueCandidates.length} | 减法候选，需要人工判断，不应自动删除 |
| 存量数据内含明显模板词 | ${storedTemplateResidue.length} | 需清理 |

景点等级字段分布：${Object.entries(levelCounts).map(([key, count]) => `${key} ${count}条`).join("；")}。如果绝大多数都叫“国家级景点”，这个字段本身不具备区分价值，也不等于真实 A 级资质。

## A. 明确优先处理：基本介绍疑似串到其他城市

判定方式：只扫描景点的 \`description/intro\`，若其中出现与所属省市不一致的其他省市名则列入。路线中正常出现“从成都出发”等内容不在此规则内。

${table(entityMismatches, (item) => `检测到其他地点：${item.places.join("、")}；当前文本：${item.issue}`)}

## B. 明确优先处理：懒人攻略存在同名实体误判信号

${table(ambiguousGuides, (item) => `${item.places.length ? `疑似串到：${item.places.join("、")}；` : ""}${item.issue}`)}

## C. 图中“瞎写”内容的系统性来源

前端 \`app.js\` 对缺少结构化指南的景点，会临时拼出以下内容：

- “强烈推荐：1. 某城市特色招牌菜（本地精选爆款，肥嫩多汁）”
- “某城市正宗地方风味”
- “招牌文创雪糕（拍照打卡特色消暑利器）”
- “覆盖主要景点，省时省力。票价：70元/人（七日内有效）”
- 通用住宿、穿衣、交通建议

这不是可靠采集结果。当前 ${missingGuideData.length} 条景点缺少 \`guide_data\`，都有触发此类假内容的风险。按省份统计：

${provinceSummary(missingGuideData).map(([province, count]) => `- ${province}：${count} 条`).join("\n")}

涉及景点：

${provinceSummary(missingGuideData).map(([province]) => {
  const names = missingGuideData.filter((item) => item.province === province).map((item) => item.name);
  return `- **${province}**：${names.join("、")}`;
}).join("\n")}

## D. 通用占位介绍

这类景点可能真实且有价值，但介绍没有提供任何景点特征。

${provinceSummary(genericIntros).map(([province, count]) => `- ${province}：${count} 条`).join("\n")}

前 120 条明细：

${table(genericIntros, (item) => item.issue, 120)}

## E. 疑似低价值或不宜独立展示的 POI

这里只是“减法候选”，不会自动删除；知名广场、观景台、纪念碑仍可能值得保留。

${table(lowValueCandidates, (item) => item.issue)}

## 建议讨论顺序

1. 先删除前端编造内容的机制：无可靠数据时显示“暂无/以官方信息为准”，不要生成具体菜名、票价和交通方式。
2. 再修 A、B 两组确定性错配；凤凰广场属于 B 类。
3. 批量补写通用占位介绍，但保留景点本身。
4. 最后逐省审核 E 类减法候选，避免误删知名地标。
`;

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, report, "utf8");

console.log(JSON.stringify({
  total: rows.length,
  entityMismatches: entityMismatches.length,
  ambiguousGuides: ambiguousGuides.length,
  missingGuideData: missingGuideData.length,
  genericIntros: genericIntros.length,
  lowValueCandidates: lowValueCandidates.length,
  storedTemplateResidue: storedTemplateResidue.length,
  levelCounts,
  outPath
}, null, 2));
