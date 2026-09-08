const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const state = readJson(path.join(root, '.runtime', 'attraction-gallery-batch', 'state.json'));
const index = readJson(path.join(root, 'data', 'provinces-index.json'));
const denylist = new Set(readJson(path.join(root, 'content', 'attraction-gallery-image-denylist.json')).map(item => item.url));
const byId = new Map();

for (const province of Object.values(index)) {
  const data = readJson(path.join(root, 'data', 'provinces', province.dataFile));
  for (const attraction of data.attractions || []) byId.set(attraction.id, attraction);
}

const ready = (state.items || []).filter(item => item.status === 'ready_for_user_review');
const errors = [];
for (const item of ready) {
  const attraction = byId.get(item.id);
  if (!attraction) {
    errors.push(`${item.name}: 构建数据不存在`);
    continue;
  }
  const images = Array.isArray(attraction.images) ? attraction.images : [];
  const urls = images.map(image => typeof image === 'string' ? image : image.url);
  const effective = [...new Set([attraction.image, ...urls].filter(Boolean))];
  if (images.length !== 5 || effective.length !== 5) errors.push(`${item.name}: 最终不是5张`);
  if (attraction.image !== urls[0]) errors.push(`${item.name}: 封面与首图不一致`);
  if (urls.some(url => denylist.has(url))) errors.push(`${item.name}: 命中拒绝清单`);
  if (images.some(image => image.source === 'public-search')) errors.push(`${item.name}: 混入通用搜索图片`);
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`图库构建检查通过：${ready.length}/${ready.length} 个景点均为5张唯一图片，封面一致，无拒绝图及通用搜索图。`);
}
