const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const db = JSON.parse(fs.readFileSync(path.join(rootDir, 'content', 'db.json'), 'utf8'));
const runtimeDir = path.join(rootDir, '.runtime');

const samples = [
  {
    province: '湖南',
    name: '长沙臭豆腐',
    expectedCity: '长沙',
    officialSources: [
      'https://whhlyt.hunan.gov.cn/whhlyt/news/sxxw/202306/t20230625_29383504.html',
      'https://www.hunan.gov.cn/jxxx/hxwh/cls/201307/t20130724_4874962.html'
    ]
  },
  {
    province: '云南',
    name: '过桥米线',
    expectedCity: '蒙自',
    officialSources: [
      'https://nync.yn.gov.cn/html/2022/tianjianyibanli2022_0606/387099.html?cid=4560',
      'https://yjglt.yn.gov.cn/html/2024/youyizhongjiaoyunnandeshenghuo_0828/4029929.html'
    ]
  },
  {
    province: '黑龙江',
    name: '锅包肉',
    expectedCity: '哈尔滨',
    officialSources: [
      'https://wlt.hlj.gov.cn/wlt/c116547/202502/c00_31813160.shtml',
      'https://gxt.hlj.gov.cn/gxt/c107067/202306/c00_31643460.shtml'
    ]
  }
];

function imageType(buffer) {
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.length >= 8 && buffer.toString('hex', 0, 8) === '89504e470d0a1a0a') return 'png';
  return 'unknown';
}

function validate(sample) {
  const province = db.provinces[sample.province];
  if (!province) throw new Error(`省份不存在：${sample.province}`);
  const food = (province.foods || []).find(item => item.name === sample.name);
  if (!food) throw new Error(`存量美食不存在：${sample.province}/${sample.name}`);
  const imagePath = path.join(rootDir, food.image || '');
  const exists = Boolean(food.image) && fs.existsSync(imagePath);
  const detectedType = exists ? imageType(fs.readFileSync(imagePath)) : 'missing';
  const extension = path.extname(imagePath).slice(1).toLowerCase();
  return {
    province: sample.province,
    name: sample.name,
    storedCity: food.city || '其他',
    expectedCity: sample.expectedCity,
    cityNeedsCorrection: (food.city || '其他') !== sample.expectedCity,
    image: food.image,
    imageExists: exists,
    imageType: detectedType,
    imageExtensionMismatch: exists && extension === 'jpg' && detectedType !== 'jpeg',
    officialSources: sample.officialSources,
    passed: exists && detectedType !== 'unknown' && sample.officialSources.length > 0
  };
}

fs.mkdirSync(runtimeDir, { recursive: true });
const results = samples.map(validate);
const report = {
  generatedAt: new Date().toISOString(),
  mode: 'read-only-pilot',
  passed: results.every(item => item.passed),
  results,
  conclusions: {
    stablePrimarySource: 'official-local-government-or-culture-tourism',
    stableLocalSource: 'existing-foods-and-reviewed-attraction-guide-food-mentions',
    optionalSources: ['amap-poi', 'ctrip', 'xiaohongshu'],
    hardBlocks: ['invalid-json', 'missing-name-or-province', 'broken-or-wrong-image', 'exact-duplicate-in-same-province-and-city'],
    warningsOnly: ['city-unknown', 'single-source', 'rating-missing', 'optional-network-source-unavailable']
  }
};

const output = path.join(runtimeDir, 'food-source-pilot.json');
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`Food source pilot: ${report.passed ? 'PASS' : 'FAIL'}`);
for (const item of results) {
  console.log(`${item.province}/${item.name}: city ${item.storedCity} -> ${item.expectedCity}; image=${item.imageType}${item.imageExtensionMismatch ? ' (extension mismatch)' : ''}`);
}
console.log(`Report: ${output}`);

