const fs = require('fs');
const path = require('path');
const pipeline = require('./food_pipeline');

const root = path.resolve(__dirname, '..');
const output = path.join(root, '.runtime', 'food-metadata-sample-report.json');
const samples = [
  { region: '北方', kind: '肉食', province: '内蒙古', city: '赤峰', name: '手把肉' },
  { region: '西北', kind: '主食', province: '新疆', city: '吐鲁番', name: '烤包子' },
  { region: '华东', kind: '主食', province: '山东', city: '青岛', name: '鲅鱼水饺' },
  { region: '华东', kind: '菜肴', province: '浙江', city: '杭州', name: '东坡肉' },
  { region: '华中', kind: '小吃', province: '湖南', city: '长沙', name: '长沙臭豆腐' },
  { region: '西南', kind: '主食', province: '云南', city: '蒙自', name: '过桥米线' },
  { region: '东北', kind: '菜肴', province: '黑龙江', city: '哈尔滨', name: '锅包肉' },
  { region: '西北', kind: '小吃', province: '陕西', city: '西安', name: '肉夹馍' },
  { region: '华南', kind: '主食', province: '广西', city: '柳州', name: '螺蛳粉' }
];

async function main() {
  const results = [];
  for (const sample of samples) {
    const result = await pipeline.collectAmapMetadata(sample);
    results.push({ ...sample, ...result });
    console.log(`${sample.province}/${sample.city}/${sample.name}: 匹配 ${result.matched || 0}，评分样本 ${result.ratingSamples || 0}，评分 ${result.rating ?? '无'}，标签 ${result.tags?.join('、') || '无'}`);
  }
  const matchedCoverage = results.filter(item => item.available && item.matched > 0).length;
  const realRatingCoverage = results.filter(item => item.rating !== null && item.rating !== undefined).length;
  const summary = {
    generatedAt: new Date().toISOString(),
    scope: 'cross-region-food-metadata-sample',
    passed: matchedCoverage >= 7 && realRatingCoverage >= 7,
    matchedCoverage,
    realRatingCoverage,
    results
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(`结果：${summary.passed ? '通过' : '未通过'}；真实评分覆盖 ${summary.realRatingCoverage}/${samples.length}`);
  console.log(`报告：${output}`);
  if (!summary.passed) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
