/**
 * 全局景点图库体系化内容守卫与整组熔断引擎
 * 严禁单点局部修补，全面统一覆盖所有非核心风光、非建筑实景杂质：
 * 1. 室内餐饮美食 / 厨房设施
 * 2. 住宿客房装潢 / 会议空间
 * 3. 游客人像自拍 / 摆拍道具 / 玩具手办文创
 * 4. 周边娱乐设施 / 商业游乐 / 伪景观
 * 5. 施工交通车厢 / 商业广告横幅
 * 6. URL 路径与元数据非风貌特征标签
 */

// 1. 室内商业 / 餐饮美食 / 厨房操作
const REGEX_INDOOR_DINING = /餐厅|饭店|酒楼|咖啡|茶室|茶馆|酒吧|清吧|烤肉|火锅|烧烤|小吃|摊贩|大排档|冷饮|冰淇淋|甜品|甜点|美食|菜品|菜肴|饮品|菜单|价目|后厨|厨房|厨师|包厢|包间|餐桌|餐椅|长桌|酒席|宴席|收银台|前台接待|大堂休息|盥洗|卫生间|洗手间|厕所|马桶/i;

// 2. 住宿客房装潢 / 会议室
const REGEX_HOTEL_ROOM = /客房|标间|大床房|套房|客栈内部|酒店内部|房间内|卧室|床铺|被褥|枕头|卫浴|浴室|浴缸|毛巾架|窗帘|床头柜|沙发|会议室|会议桌|会议长桌|长条会议桌|投影幕|白板|演讲台|报告厅/i;

// 3. 人像自拍写真 / 摆拍道具 / 玩具模型文创
const REGEX_PORTRAIT_PROPS = /自拍|人像|肖像|合影|大头照|汉服写真|婚纱|影楼|棚拍|剪刀手|游客照|正面大特写|脸部|手部|脚部|放大镜|望远镜特写|手持道具|手办|公仔|玩偶|布娃娃|毛绒玩具|模型玩具|恐龙模型|变形金刚|文创雪糕|纪念品|伴手礼|明信片特写|门票特写|票根|打卡本|印章特写|盖章册|手机屏幕|照相机特写/i;

// 4. 周边游乐商业 / 伪景观设施 / 体验项目
const REGEX_AMUSEMENT_COMMERCIAL = /滑翔伞|滑翔机|动力伞|热气球|蹦极|卡丁车|碰碰车|赛车场|彩虹滑梯|彩虹滑道|玻璃滑道|水滑道|漂流滑道|充气城堡|充气蹦床|网红秋千|喊泉|威亚|假花|假树|假山盆景|仿真花|塑料花|假花墙|花车|彩车|巡游车|观光小火车车厢|人偶装|卡通玩偶服|帐篷营地|露营帐篷|商业集市|摆摊|摊位|农家乐|农家院|采摘园|招商|充气拱门/i;

// 5. 施工交通车厢 / 商业广告
const REGEX_CONSTRUCTION_TRAFFIC = /施工围挡|挖掘机|脚手架|塔吊|建筑工地|维修中|大巴车内|客车座椅|飞机机舱|车厢内部|候车室|广告牌|宣传栏|横幅标语|招贴海报/i;

// 6. URL 与路径标识阻断（涵盖餐饮、住宿、人像、玩具、游乐等）
const REGEX_URL_BAD = /(?:restaurant|dining|food|dish|snack|menu|cafe|bar|hotel_photo|room|bed|guestroom|lobby|portrait|selfie|wedding|face|toy|doll|figure|souvenir|glider|paraglide|bungee|kart|slide|inflatable|artificial_flower|parade|camp_tent|construction)/i;

// 已确认的问题样本指纹黑名单（绝对物理拦截）
const KNOWN_POLLUTED_URLS = new Set([
  'https://dimg04.c-ctrip.com/images/1A0t1g000001gvzt8BB11.jpg', // 上李水库放大镜
  'https://dimg04.c-ctrip.com/images/1mi6f12000s9od5dz6853.jpg', // 石板岩会议室
  'https://dimg04.c-ctrip.com/images/1mi5712000s9oddhu319F.jpg', // 石板岩客房
  'https://dimg04.c-ctrip.com/images/1mi5e12000s9od7tw48A2.jpg', // 石板岩阳台
  'https://dimg04.c-ctrip.com/images/1mi1a12000qnfjpjxD60B.webp', // 丽江植物园花车
  'https://dimg04.c-ctrip.com/images/0HJ2m12000g6ej0zpD983.jpg', // 丽江假花墙
  'https://dimg04.c-ctrip.com/images/1mi1112000si6p0ve86E5.jpg', // 丽江农家院
  'https://store.is.autonavi.com/showpic/a1a97f28c2dd0f2d5c094edb18c10dcc?type=7', // 丽江高德滑翔伞
  'https://store.is.autonavi.com/showpic/f355bb7160f979d70000003327980635?type=7', // 丽江高德水潭
]);

/**
 * 单图系统化纯净度判定
 */
function isContaminatedImage(img, attractionName = '') {
  if (!img || !img.url) return { bad: false };
  
  if (KNOWN_POLLUTED_URLS.has(img.url)) {
    return { bad: true, reason: '命中已知劣质/张冠李戴黑名单指纹' };
  }

  const text = (img.caption || '') + ' ' + (img.title || '') + ' ' + (img.url || '');

  if (REGEX_INDOOR_DINING.test(text)) {
    return { bad: true, reason: '包含室内餐饮/美食后厨等非风貌特征' };
  }
  if (REGEX_HOTEL_ROOM.test(text)) {
    return { bad: true, reason: '包含酒店客房/住宿装潢/会议长桌等非景点实景特征' };
  }
  if (REGEX_PORTRAIT_PROPS.test(text)) {
    return { bad: true, reason: '包含游客自拍/人像特写/手办道具微距等非自然实景特征' };
  }
  if (REGEX_AMUSEMENT_COMMERCIAL.test(text)) {
    return { bad: true, reason: '包含周边游乐设施/花车假景观/商户农家乐等非核心风貌特征' };
  }
  if (REGEX_CONSTRUCTION_TRAFFIC.test(text)) {
    return { bad: true, reason: '包含施工工地/交通车厢/商业标语等干扰特征' };
  }
  if (REGEX_URL_BAD.test(img.url)) {
    return { bad: true, reason: '图片 URL 包含非风光路径标签特征' };
  }

  // 极度扁平的横幅广告或纵向切条过滤
  if (img.dimensions && img.dimensions.width && img.dimensions.height) {
    const ratio = img.dimensions.width / img.dimensions.height;
    if (ratio > 4.0 || ratio < 0.25) {
      return { bad: true, reason: '图片长宽比异常（疑似条形横幅或切片广告）' };
    }
  }

  return { bad: false };
}

/**
 * 全局整组熔断器（All-or-Nothing 铁律）
 * 坚决不搞单点侥幸留存！只要图集中出现 1 张被污染图片，立即判定整组受污染，强制全量熔断清退！
 */
function evaluateGalleryPurity(images, attractionName = '') {
  const list = Array.isArray(images) ? images : [];
  if (list.length === 0) {
    return { isContaminated: true, reason: '图集为空', contaminatedCount: 0 };
  }

  for (let i = 0; i < list.length; i++) {
    const res = isContaminatedImage(list[i], attractionName);
    if (res.bad) {
      return {
        isContaminated: true,
        reason: '第 ' + (i + 1) + ' 张图片存在杂质污染（' + res.reason + '），全组强制熔断！',
        badIndex: i,
        badUrl: list[i].url
      };
    }
  }

  return { isContaminated: false };
}

module.exports = {
  isContaminatedImage,
  evaluateGalleryPurity,
  KNOWN_POLLUTED_URLS
};
