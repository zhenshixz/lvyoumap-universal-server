const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const { buildCityProvinceIndex, validateCard } = require('./attraction_card_consistency');
const manifestPath = path.join(root, '.runtime', 'attraction-content-sample', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
const provincesDir = path.join(root, 'data', 'provinces');
const cityProvinceIndex = buildCityProvinceIndex(provincesDir);
const attractionById = new Map();
for (const file of fs.readdirSync(provincesDir).filter(name => name.endsWith('.json'))) {
  const data = JSON.parse(fs.readFileSync(path.join(provincesDir, file), 'utf8').replace(/^\uFEFF/, ''));
  for (const attraction of data.attractions || []) attractionById.set(attraction.id, attraction);
}

const intros = {
  amap_B02340T5OU: '位于安徽省六安市舒城县西南，万佛山以老佛顶、连绵峰林、奇松怪石和山间瀑布为主要看点，森林植被茂密，是集登山观景、地质景观与森林休闲于一体的山岳景区。',
  amap_B000A87KTH: '位于北京市东城区崇文门东大街，是北京内城城垣的重要遗存。园内保存有明代城墙与东南角楼，斑驳城砖和现代城市天际线同框，是了解北京城防历史与古今城市变迁的代表性地点。',
  amap_B0253016EC: '位于福建省泉州市西街北侧，是泉州重要的古代佛教寺院和世界文化遗产点。寺内以东西塔、大雄宝殿、古榕和石刻为核心看点，集中展现泉州多元文化交流与古建筑艺术。',
  amap_B025200C2E: '位于福建省莆田市城厢区，凤凰山公园因山势形似凤凰展翼而得名。公园以山林步道、石室岩古迹、摩崖题刻和城市观景为主要看点，兼具日常休闲、登山健身与人文游览价值。',
  amap_B00140UDHU: '位于广东省广州市番禺区石楼镇，以古采石场形成的红色砂岩峭壁和石刻景观闻名。景区还汇集望海观音、莲花塔、莲花城等人文节点，兼具地质奇观、滨水视野和祈福文化。',
  amap_B0L1GZAXVP: '位于广西防城港市江山半岛白沙湾一带，红白相间的海边灯塔与沙滩、礁石和开阔海面共同构成主要景观。这里适合沿海散步、观景和拍摄日落，是白沙湾具有辨识度的滨海地标。',
  amap_B0FFFDZATL: '位于安徽省六安市金寨县梅山镇，红军广场以革命烈士纪念塔、金寨县革命博物馆、红军纪念堂和烈士纪念区域为核心，是集中了解金寨红色历史、开展纪念瞻仰与爱国主义教育的重要场所。',
  amap_B000A208D5: '位于北京市西城区文华胡同24号，是李大钊1920年至1924年在北京居住的重要旧居。院落保留民国时期三合院格局，并通过复原陈列展示其家庭生活及传播马克思主义、参与创建中国共产党的革命实践。',
  amap_B0354003CR: '位于贵州省遵义市红花岗区凤凰南路一带，是凤凰山脚下连接城市休闲与红色文化体验的公共文化广场。广场及周边设有文化景观和演艺空间，适合散步、观景，并可结合现场安排了解遵义红色文化主题活动。',
  amap_B01C304057: '位于黑龙江省哈尔滨市南岗区东大直街，是哈尔滨具有代表性的佛教寺院。寺院以山门、天王殿、大雄宝殿、三圣殿、藏经楼及七级浮屠等建筑为主要看点，整体沿中轴展开，适合了解近现代东北佛教建筑与宗教文化。',
};

const guides = {
  amap_B0253016EC: {
    clothing: { spring_autumn: '泉州春秋温度较舒适，可穿薄长袖并备轻便外套。', summer: '天气炎热湿润，穿透气衣物并注意遮阳补水。', winter: '早晚偏凉，可准备保暖外套。', tips: '进入寺院衣着得体，穿适合石板路步行的防滑鞋。' },
    transport: { external_arrive: '可先到泉州站，再按实时公交或导航前往西街、开元寺一带；古城核心区优先公共交通。', internal_arrive: '寺内以步行为主，依次参观大雄宝殿、东西塔及主要庭院。', internal_traffic: '寺内无需代步工具，石板路和殿前门槛处注意脚下。', tips: '古城节假日人流较多，停车和临时交通安排以当天信息为准。' },
    housing: [{ area: '泉州古城', desc: '便于步行串联西街、开元寺和钟楼等景点。' }, { area: '丰泽区或公共交通沿线', desc: '住宿选择较多，可按实时交通前往古城。' }],
    food: ['面线糊', '泉州肉粽', '姜母鸭', '四果汤'],
    special_care: { elderly: '寺内整体步行压力不大，可在庭院和古榕附近休息，不必赶完所有殿宇。', children: '在人流密集和殿前门槛处牵好儿童，遵守宗教场所参观秩序。' },
  },
  amap_B025200C2E: {
    clothing: { spring_autumn: '适合轻便长袖和运动鞋，早晚可备薄外套。', summer: '山林湿热，注意防晒、驱蚊和补水。', winter: '准备防风外套，阴雨天气注意保暖。', tips: '园内有坡道和石阶，优先穿防滑、合脚的运动鞋。' },
    transport: { external_arrive: '凤凰山公园位于莆田城区，可乘公交、出租车或自驾前往，具体入口按实时导航选择。', internal_arrive: '园内以步行为主，带老人儿童优先选择人工铺装步道，并按体力决定是否继续登高。', internal_traffic: '公园核心游览不依赖代步工具，收费项目和临时交通以现场公示为准。', tips: '不要把其他城市的凤凰山路线、索道或景交信息套用到这里。' },
    housing: [{ area: '莆田城厢区', desc: '距离公园较近，城市交通和餐饮配套较集中。' }, { area: '莆田站交通沿线', desc: '适合需要兼顾抵离交通的游客，出发前核对通勤时间。' }],
    food: ['莆田卤面', '炝肉', '红团', '海蛎煎'],
    special_care: { elderly: '以铺装步道和石室岩附近为主要范围，感觉疲劳就提前折返，不追求登顶。', children: '石阶、湖边和雨后湿滑路段由家长看护，避免进入非正式林间小路。' },
  },
  amap_B0FFFDZATL: {
    clothing: { spring_autumn: '山区早晚温差较明显，可备轻便外套。', summer: '户外广场日照较强，注意遮阳和补水。', winter: '广场开阔，注意防风保暖。', tips: '纪念区有台阶，建议穿防滑、合脚的运动鞋。' },
    transport: { external_arrive: '先到金寨县城，再乘公交、出租车或自驾前往红军广场；具体线路以当地实时导航为准。', internal_arrive: '景区以步行为主，依次连接广场、革命博物馆、纪念塔和烈士纪念区域。', internal_traffic: '景区以步行为主，依次连接广场、革命博物馆、纪念塔和烈士纪念区域。', tips: '腿脚不便者可优先参观地势相对平缓的广场和博物馆区域，不必强行走完整段台阶。' },
    housing: [{ area: '金寨县城', desc: '餐饮和交通配套较集中，前往红军广场也较方便。' }],
    food: ['金寨吊锅', '山野菜', '当地农家风味'],
    special_care: { elderly: '纪念塔方向有连续台阶，按体力决定是否登高，并在平台处及时休息。', children: '适合结合博物馆展陈进行红色文化学习；纪念区域应保持安静，不在台阶上奔跑。' },
  },
  amap_B000A208D5: {
    clothing: { spring_autumn: '北京春秋多风，可备轻便防风外套。', summer: '院落游览注意遮阳补水。', winter: '胡同与院落区域体感较冷，注意保暖。', tips: '故居面积不大，穿日常舒适鞋即可。' },
    transport: { external_arrive: '可乘地铁或公交到西单、复兴门一带，再步行进入文华胡同；建议优先公共交通。', internal_arrive: '故居内部按院落与展室顺序步行参观，不需要代步工具。', internal_traffic: '故居内部按院落与展室顺序步行参观，不需要代步工具。', tips: '胡同停车条件有限，自驾前应查看实时停车信息。' },
    housing: [{ area: '西城或地铁沿线', desc: '便于串联北京其他历史文化景点，也能减少市区换乘。' }],
    food: ['北京炸酱面', '传统面点', '京味小吃'],
    special_care: { elderly: '院落规模较小、步行压力不大，进出门槛和展室时注意脚下。', children: '可结合复原陈列了解人物生平，控制音量并遵守展室参观规则。' },
  },
  amap_B0354003CR: {
    clothing: { spring_autumn: '天气多变，可备轻便外套和雨具。', summer: '广场开阔，注意遮阳、驱蚊与补水。', winter: '早晚较凉，注意防风保暖。', tips: '以平地步行为主，穿舒适运动鞋即可。' },
    transport: { external_arrive: '文化广场位于遵义城区，可乘公交、出租车或自驾前往，具体路线按实时导航选择。', internal_arrive: '广场内部没有必要乘坐代步工具，沿铺装地面步行游览即可。', internal_traffic: '广场内部没有必要乘坐代步工具，沿铺装地面步行游览即可。', tips: '本条只介绍地面文化广场，不把凤凰山登山线路混入其中。' },
    housing: [{ area: '遵义老城区', desc: '市区交通、餐饮和其他红色文化景点较集中。' }],
    food: ['遵义羊肉粉', '豆花面', '洋芋小吃'],
    special_care: { elderly: '广场整体平坦，可按体力缩短散步范围并在平台或树荫处休息。', children: '水景和开阔区域需由家长看护，不靠近湿滑边缘或在人群中奔跑。' },
  },
};

const basicCorrections = {
  amap_B0FFFDZATL: {
    values: { address: '六安市金寨县梅山镇红村路', openHours: '室外纪念园区全天开放；室内场馆开放安排以官方公告为准', price: '免费开放', tel: '0564-7068506' },
    source: { type: 'scenic-official', field: 'basic', title: '金寨县A级景区基本情况', url: 'https://www.ahjinzhai.gov.cn/public/6596541/38738787.html' },
  },
  amap_B025200C2E: {
    values: { price: '公园实行收费入园；具体票价、优惠政策及园内项目费用以现场公示为准' },
    source: { type: 'public-government', field: 'price', title: '莆田市公园门票政策说明', url: 'https://xzfwzx.putian.gov.cn/zwgk/zcjd/202307/t20230731_1842093.htm' },
  },
  amap_B00140UDHU: {
    values: { openHours: '周一至周日 07:00-17:00；个别设施开放情况以景区当日公告为准', price: '景区实行收费入园；票种、优惠和园内另收费项目以官方购票页为准' },
    source: { type: 'scenic-official', field: 'basic', title: '广州莲花山旅游区游客服务', url: 'https://lhs123.cn/list/1.html' },
  },
};

const lazyGuides = {
  amap_B025200C2E: `带长辈小孩逛凤凰山公园，走铺装路更省力

莆田凤凰山公园既有平缓山林步道，也有通往石室岩的登高路线。带老人和小孩不必追求登顶，按体力随时折返即可。

省力游览路线
- 公园入口：从入口沿树荫较多的人工铺装步道缓慢上行，先适应坡度。
- 六角亭：作为第一处休息点，补水后再决定是否继续登高。
- 石室岩寺：看看古寺、岩石和摩崖题刻；腿脚不便者可把这里作为折返点。
- 龙舌石与观景处：继续向上的台阶增多，只建议体力尚可的家庭前往，之后原路或沿较平缓道路返回。

老人儿童注意
- 整段可预留约两小时，以下山仍有余力为原则。
- 老人可使用登山杖并控制下坡速度，低龄儿童不要在石阶和湿滑岩面奔跑。

避坑提醒
- 雨后只走人工铺装路线，不尝试林间野路。
- 自带饮水并做好防蚊，感觉疲劳就在石室岩提前折返。`,
  amap_B00140UDHU: `莲花山带长辈小孩，代步上山后慢慢走

广州莲花山面积较大，最省力的办法是先确认景区当日接驳方式，用代步完成主要爬升，再在山上选择平缓节点游览，不必下到古采石场最深处。

省力游览路线
- 主要入口：确认观光车运行与停靠位置，乘车或沿主路前往望海观音区域。
- 观音广场：地势相对开阔，可先休息、观景和祈福。
- 莲花塔与莲花城：沿铺装路慢走，在塔外和城墙平台观看狮子洋方向景色。
- 古采石场上方平台：从安全位置俯瞰红色砂岩峭壁，不带老人小孩下走陡峭石阶。
- 莲花仙境或湖边：最后在平缓区域散步，再按现场出口指引返回。

老人儿童注意
- 精华路线约需两至三小时，观音广场、莲花塔外平台和湖边适合休息。
- 石阶和水边由家人搀扶老人、牵好儿童，代步车线路以现场公告为准。

避坑提醒
- 不攀爬未开放岩壁，也不要为拍照靠近无防护的临水或悬崖边缘。`,
  amap_B0FFFDZATL: `红军广场亲子省力参观，博物馆优先

金寨红军广场依山展开，没有索道或景交车。带老人和小孩应减少连续爬台阶，把体力留给博物馆和核心纪念区域，不必勉强走完整条登高线。

省力游览路线
- 双拥广场：先在平坦区域观看室外展陈，适应步行节奏。
- 金寨县革命博物馆：利用室内参观作为休息，结合展品了解金寨红色历史。
- 红军纪念塔：通往纪念塔有连续台阶，慢走并在平台停歇；膝盖不适可放弃此段。
- 红军纪念堂与烈士纪念区域：体力允许再继续参观，之后按原路返回。

老人儿童注意
- 建议安排约一个半至两个小时，广场和博物馆区域适合休息补水。
- 台阶雨后可能湿滑，穿防滑鞋并牵好儿童。

避坑提醒
- 纪念堂、墓园等区域保持安静，不播放外放音乐。
- 开放安排可能变化，出发前查看官方信息，避免按旧攻略跑空。`,
  amap_B0354003CR: `凤凰山文化广场只逛平地，不误入登山线

带老人和小孩逛遵义凤凰山文化广场，原则就是“不爬山、不绕远、随时歇”。本条只游览地面文化广场，不把凤凰山公园、凤凰楼或登山步道混进来。

省力散步路线
- 广场入口：从湘江河畔一侧入口或牌坊进入，先看入口附近的文化浮雕。
- 水景与松竹造景：沿广场轴线慢走，在开阔区域短暂停留。
- 凤阁与龙亭平台：这里适合坐下休息，也方便观察广场整体空间。
- 东部草坪与乔木绿地：最后在树荫和草坪周边散步，再就近离开。

用时与折返
- 全程约四十分钟至一小时，没有必须完成的闭环；老人感到疲劳可从任何节点原路折返。

老人儿童注意
- 水景边和雨后铺装地面可能湿滑，孩子靠近水池时必须由家长看护。

避坑提醒
- 广场无需代步工具，不要被“凤凰山”名称误导去走登山线。
- 遇到活动人流聚集时缩短路线，优先从外围离开。`,
  amap_B01C304057: `极乐寺抓住中轴精华，不在侧院反复绕路

哈尔滨极乐寺整体没有山路，但青砖、石板和殿前门槛较多。带老人和小孩最省力的方式是沿中轴线看主要殿宇，再到东院看七级浮屠。

省力游览路线
- 山门与天王殿：从正门进入后沿中轴前行，先在殿前开阔区域适应环境。
- 大雄宝殿：作为核心参观节点，在殿前稍作休息，不急着连续进入所有配殿。
- 三圣殿与藏经楼：体力有限可只看外部建筑，把精力留给古塔。
- 东院七级浮屠：从主院通往东院，在古塔周边平缓区域观赏，随后按现场通道离开。

老人儿童注意
- 整条路线约一至两小时，老人不必追求每座配殿都进入，孩子不在殿前奔跑。
- 雨雪天气穿防滑保暖鞋，跨越门槛时由家人搀扶老人并照看儿童。

避坑提醒
- 殿内拍摄要求以现场标识为准，保持安静并尊重宗教场所秩序。
- 请香祈福量力而行，不轻信寺外主动兜售或招揽人员。`,
};

const introPrompts = {
  amap_B02340T5OU: '点点批次：安徽六安万佛山、北京明城墙、泉州大开元寺准确简介',
  amap_B000A87KTH: '点点批次：安徽六安万佛山、北京明城墙、泉州大开元寺准确简介',
  amap_B0253016EC: '点点批次：安徽六安万佛山、北京明城墙、泉州大开元寺准确简介',
  amap_B025200C2E: '点点批次：莆田凤凰山公园、广州莲花山、白沙湾灯塔准确简介',
  amap_B00140UDHU: '点点批次：莆田凤凰山公园、广州莲花山、白沙湾灯塔准确简介',
  amap_B0L1GZAXVP: '点点批次：莆田凤凰山公园、广州莲花山、白沙湾灯塔准确简介',
  amap_B0FFFDZATL: '整卡复核补充：安徽金寨红军广场准确简介；结合金寨县政府公开资料。',
  amap_B000A208D5: '整卡复核补充：北京李大钊故居准确简介；结合北京市文物局公开资料。',
  amap_B0354003CR: '整卡复核补充：贵州遵义凤凰山文化广场准确简介；严格排除丹东、深圳等同名山岳实体。',
  amap_B01C304057: '整卡复核补充：哈尔滨极乐寺准确简介；删除春节餐饮等临时性营销内容。',
};

const cardCorrections = {
  amap_B0FFFDZATL: { category: '人文古迹' },
  amap_B0354003CR: { category: '其他' },
};

for (const item of manifest.items) {
  item.proposed ||= {};
  item.sources ||= [];
  if (intros[item.id]) {
    item.proposed.intro = intros[item.id];
    item.proposed.description = intros[item.id];
    item.sources.push({ type: 'xiaohongshu-dian-dian-ai-chat', field: 'intro', prompt: introPrompts[item.id], collectedAt: new Date().toISOString() });
  }
  if (basicCorrections[item.id]) {
    Object.assign(item.proposed, basicCorrections[item.id].values);
    item.sources.push({ ...basicCorrections[item.id].source, collectedAt: new Date().toISOString() });
  }
  if (cardCorrections[item.id]) Object.assign(item.proposed, cardCorrections[item.id]);
  if (guides[item.id]) {
    item.proposed.guide_data = guides[item.id];
    item.sources.push({ type: 'xiaohongshu-dian-dian-ai-chat', field: 'guide_data', prompt: '仅限准确实体的结构化旅行指南；已清理固定票价、开放时间、班次、门店和未核实项目。', collectedAt: new Date().toISOString() });
  }
  if (lazyGuides[item.id]) {
    item.proposed.lazy_ai_text = lazyGuides[item.id];
    item.proposed.lazy_ai_source = { source: 'xiaohongshu-dian-dian-ai-chat', prompt: '省市+景点名锁定实体的文章式老人儿童省力路线；禁止同名异地、衣食住行和易过期信息。', updatedAt: new Date().toISOString() };
    item.sources.push({ type: 'xiaohongshu-dian-dian-ai-chat', field: 'lazy_ai_text', prompt: item.proposed.lazy_ai_source.prompt, collectedAt: new Date().toISOString() });
  }
  const effective = { ...(attractionById.get(item.id) || {}), ...item.before, ...item.proposed };
  item.validation = validateCard(item, effective, cityProvinceIndex);
  item.status = item.validation.passed ? 'ready' : 'incomplete';
  item.unresolved = item.validation.errors.map(error => error.field);
}

const ready = manifest.items.filter(item => item.status === 'ready').length;
manifest.status = ready === manifest.items.length ? 'ready_for_preview' : 'incomplete';
manifest.finalizedAt = new Date().toISOString();
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\r\n`, 'utf8');
console.log(JSON.stringify({ manifestPath, status: manifest.status, ready, total: manifest.items.length }, null, 2));
