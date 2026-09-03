const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const selectedPath = path.join(root, '.runtime', 'attraction-gallery-pilot', 'selected.json');
const outputPath = path.join(root, 'content', 'attraction-gallery-overrides.json');

// 搜索引擎返回的商业素材站预览图通常带水印。最终写入层再次拦截，
// 防止旧 selected.json 或其他采集脚本绕过前置筛选。
const globallyBlockedImageParts = [
  '699pic.com', 'nipic.com', 'vcg.com', 'quanjing.com',
  'shutterstock.com', 'gettyimages.com',
];

const excludeByAttraction = {
  // 两张图主体分别是广东省博物馆、赤岗塔；广州塔只在远处，不纳入图库。
  amap_B00140WBI1: [
    'Guangdong_Sheng_Bowuguan',
    'Guangzhou_Chigang_Ta',
  ],
  // 保留建筑本体，剔除只展示钟体的图片。
  amap_B001D09TAA: ['Bronze_bell'],
  // 构图被前景建筑严重遮挡。
  amap_B00150F6D6: ['2014.11.16.162514'],
  // Commons 分类里混入了历史地图截图与地铁 11 号线车厢，均非景区实景。
  amap_B00157AW8O: [
    '2007_Shanghai_Disney_Resort',
    'train_interior_of_Line_11',
    'Shanghai_Metro',
    'sat_view',
    'satellite',
  ],
  // 旧候选来自公开搜索，其中含摄图网水印；改用西栅/东栅准确子 POI 图片。
  amap_B0FFFAPGR4: ['images1.aoyou.com', 'img95.699pic.com', 'n.sinaimg.cn'],
  // 旧候选含摄图网水印与泛张家界百科图，改用景区内金鞭溪、天子山准确子 POI。
  amap_B02E800EFM: ['img1.voc.com.cn', 'img95.699pic.com', 'so1.360tres.com'],
};

// 自动来源仍不足 5 张时，经分辨率探测与实体核对后补入的候选。
// 保留来源页，后续可重新探测或替换，不写入本地图片。
const supplementalByAttraction = {
  amap_B0FFFAPGR4: [
    { url: 'https://store.is.autonavi.com/showpic/0d3db572be90f3481eabf93ca86ec7aa?type=7', caption: '乌镇西栅雪景', source: 'amap', sourcePoiId: 'B023D02SCY' },
    { url: 'https://store.is.autonavi.com/showpic/a2c066207271d2aae1bc2c5567e03f04?type=7', caption: '乌镇西栅水巷夜景', source: 'amap', sourcePoiId: 'B023D02SCY' },
    { url: 'https://store.is.autonavi.com/showpic/6e5bb13d9eead9a8df8aaffedb28144b?type=7', caption: '乌镇东栅水乡实景', source: 'amap', sourcePoiId: 'B023D03VEN' },
  ],
  amap_B02E800EFM: [
    { url: 'https://store.is.autonavi.com/showpic/27ce2081a340e314ca7bf9fee893c57c?type=7', caption: '张家界国家森林公园金鞭溪', source: 'amap', sourcePoiId: 'B0FFF3O6X7' },
    { url: 'https://aos-comment.amap.com/B0FFFPNBKF/comment/content_media_external_file_1000187716_ss__1758332415442_90641964.jpg?type=7', caption: '张家界国家森林公园袁家界峰林', source: 'amap', sourcePoiId: 'B0FFFPNBKF' },
    { url: 'https://aos-comment.amap.com/B02E80MWZH/comment/131348ffc8671ec5a01be10bb6b37f36_2048_2048_80.jpg?type=7', caption: '张家界国家森林公园天子山峰林', source: 'amap', sourcePoiId: 'B02E80MWZH' },
  ],
  amap_B00157AW8O: [
    {
      url: 'https://static.shanghaidisneyresort.com/tridion/prod/zh-cn/system/images/shdr-theme-park-shanghai-disneyland-park-hero-new_tcm1874-114991.jpg',
      caption: '上海迪士尼乐园官方全景',
      source: 'official',
      sourceUrl: 'https://www.shanghaidisneyresort.com/zh-cn/experience?group=attraction',
      imageSource: { provider: '上海迪士尼度假区官方', sourceUrl: 'https://www.shanghaidisneyresort.com/zh-cn/experience?group=attraction' },
    },
    {
      url: 'https://static.shanghaidisneyresort.com/tridion/prod/zh-cn/system/images/shdr-att-tron-lightcycle-power-run-hero-new_tcm1874-114865.jpg',
      caption: '创极速光轮官方实景',
      source: 'official',
      sourceUrl: 'https://www.shanghaidisneyresort.com/zh-cn/experience?group=attraction',
      imageSource: { provider: '上海迪士尼度假区官方', sourceUrl: 'https://www.shanghaidisneyresort.com/zh-cn/experience?group=attraction' },
    },
  ],
  amap_B02E700F2Q: [
    { url: 'https://www.sunriver.cn/upload/at/image/20241128/17327621622063704LxN.jpg', caption: '凤凰古城沱江夜景', source: 'public-search', sourceUrl: 'https://www.sunriver.cn/index.php/news/info/311.html' },
    { url: 'https://img.rednet.cn/2024/06-23/ffc6046d-0f39-4f00-b876-a28d9240e991.jpg', caption: '凤凰古城灯火夜景', source: 'public-search', sourceUrl: 'https://hn.rednet.cn/content/646840/67/14024310.html' },
  ],
  amap_B001809F61: [
    { url: 'https://bluebird-story.com/wp-content/uploads/2019/04/1ebb1b89e17644500461133def58dcf1.jpeg', caption: '沈阳故宫宫殿院落', source: 'public-search', sourceUrl: 'https://bluebird-story.com/shenyang-gugong/' },
    { url: 'https://iqh.ruc.edu.cn/images/2024-12/921b25cc241048f584d4e2d48369f1df.jpeg', caption: '沈阳故宫大政殿', source: 'public-search', sourceUrl: 'https://iqh.ruc.edu.cn/xwdt/cf5322d0fe1d4b2b9bae2adef8b9f0c3.htm' },
  ],
  amap_B001D06AOS: [
    { url: 'https://pic.kts.g.mi.com/63225d6065d126895f79df5ea9fc4bff5555476733313702982.jpg', caption: '西安博物院建筑与园区', source: 'public-search', sourceUrl: 'https://game.xiaomi.com/viewpoint/1410699077_1773928975155_16' },
    { url: 'https://so1.360tres.com/t018a49370d047e9aa6.jpg', caption: '西安博物院入口', source: 'public-search', sourceUrl: 'https://baike.so.com/gallery/list?eid=5815291&ghid=first&pic_idx=1&sid=6028103' },
  ],
  amap_B02500SJWD: [
    { url: 'https://dimg04.c-ctrip.com/images/1lo3612000cdmkyh28437.jpg', caption: '厦门方特水上游乐项目', source: 'public-search', sourceUrl: 'https://gs.ctrip.com/html5/you/sight/xiamen21/140141.html' },
    { url: 'https://gotravellingworld.com/wp-content/uploads/2025/11/1763008492-1-1024x683.jpg', caption: '厦门方特梦幻王国入口', source: 'public-search', sourceUrl: 'https://gotravellingworld.com/xiamen-fantawild-adventure/' },
  ],
  amap_B02140A3J6: [
    { url: 'https://img.guanhai.com.cn/a/10001/202307/2b66d6d3765f205afca61751cc13cdec.jpeg', caption: '青岛方特入口广场', source: 'public-search', sourceUrl: 'https://www.dailyqd.com/guanhai/263243_1.html' },
    { url: 'https://live.staticflickr.com/65535/53715979900_f3d5457123_k.jpg', caption: '青岛方特梦幻王国入口', source: 'public-search', sourceUrl: 'https://darkridedatabase.com/exploring-fantawild-part-2-dreamland/' },
  ],
  amap_B00140WBI1: [
    { url: 'https://commons.wikimedia.org/wiki/Special:Redirect/file/Canton%20Tower%20at%20night.jpg?width=1920', caption: '广州塔夜景', source: 'wikimedia', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Canton_Tower_at_night.jpg' },
    { url: 'https://commons.wikimedia.org/wiki/Special:Redirect/file/Canton%20Tower%20at%20night%2001.jpg?width=1600', caption: '广州塔灯光夜景', source: 'wikimedia', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Canton_Tower_at_night_01.jpg' },
  ],
  amap_B00150F6D6: [
    { url: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/c/cf/2014.11.16.165255_Oriental_Pearl_Tower_Shanghai.jpg/1920px-2014.11.16.165255_Oriental_Pearl_Tower_Shanghai.jpg', caption: '东方明珠塔身近景', source: 'wikimedia', sourceUrl: 'https://commons.wikimedia.org/wiki/File:2014.11.16.165255_Oriental_Pearl_Tower_Shanghai.jpg' },
  ],
  amap_B001D09TAA: [
    { url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1c/VM_5510_Xian_Bell_Tower.jpg/1920px-VM_5510_Xian_Bell_Tower.jpg', caption: '西安钟楼建筑全景', source: 'wikimedia', sourceUrl: 'https://commons.wikimedia.org/wiki/File:VM_5510_Xian_Bell_Tower.jpg' },
  ],
};

function cleanImage(image) {
  const result = {
    // 正式站点为 HTTPS；已通过候选下载验证的 HTTP 图片统一升级协议，
    // 避免手机浏览器因 mixed content 将图片永久卡在加载状态。
    url: String(image.url || '').replace(/^http:/i, 'https:'),
    caption: image.caption,
    source: image.source,
  };
  if (image.sourcePoiId) result.sourcePoiId = image.sourcePoiId;
  if (image.sourceUrl) result.sourceUrl = image.sourceUrl;
  if (image.imageSource) result.imageSource = image.imageSource;
  return result;
}

const selected = JSON.parse(fs.readFileSync(selectedPath, 'utf8'));
const current = fs.existsSync(outputPath)
  ? JSON.parse(fs.readFileSync(outputPath, 'utf8').replace(/^\uFEFF/, ''))
  : {};

for (const [id, images] of Object.entries(selected)) {
  const blocked = excludeByAttraction[id] || [];
  const seen = new Set();
  const accepted = [...images, ...(supplementalByAttraction[id] || [])]
    .filter(image => !globallyBlockedImageParts.some(part => image.url.toLowerCase().includes(part)))
    .filter(image => !blocked.some(part => image.url.includes(part)))
    .filter(image => image.url && !seen.has(image.url) && seen.add(image.url))
    .slice(0, 5)
    .map(cleanImage);
  if (accepted.length < 5) throw new Error(`${id} 视觉筛选后不足 5 张，停止写入。`);
  current[id] = { images: accepted };
}

fs.writeFileSync(outputPath, `${JSON.stringify(current, null, 2)}\r\n`, 'utf8');
console.log(`已写入 ${Object.keys(selected).length} 个试点图库，原有图库已保留。`);
