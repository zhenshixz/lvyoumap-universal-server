const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const manifestPath = path.join(root, '.runtime', 'attraction-display-tags', 'manifest.json');
const outputPath = path.join(root, 'content', 'attraction-display-tags.json');

if (!fs.existsSync(manifestPath)) throw new Error(`标签断点不存在：${manifestPath}`);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
const items = Object.values(manifest.items || {});
if (items.length !== Number(manifest.total) || Number(manifest.pending) !== 0) {
  throw new Error(`标签断点尚未完成：${items.length}/${manifest.total}，剩余 ${manifest.pending}。`);
}

const output = {};
for (const item of items) {
  const id = String(item.id || '').trim();
  const tags = [...new Set((Array.isArray(item.tags) ? item.tags : []).map(value => String(value).trim()).filter(Boolean))];
  if (!id || tags.length !== 3) throw new Error(`标签数据无效：${item.name || id || '未知景点'}`);
  output[id] = { tags };
}

const ordered = Object.fromEntries(Object.entries(output).sort(([left], [right]) => left.localeCompare(right)));
const tempPath = `${outputPath}.tmp`;
fs.writeFileSync(tempPath, `${JSON.stringify(ordered, null, 2)}\r\n`, 'utf8');
fs.renameSync(tempPath, outputPath);
console.log(`已写入 ${Object.keys(ordered).length} 个景点的正式特色标签：${path.relative(root, outputPath)}`);
