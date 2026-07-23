const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const indexPath = path.join(distDir, 'data', 'provinces-index.json');

for (const requiredPath of [
  path.join(distDir, 'index.html'),
  path.join(distDir, 'app.js'),
  path.join(distDir, 'style.css'),
  indexPath,
  path.join(distDir, 'data', 'search-index.json'),
  path.join(distDir, 'data', 'provinces', 'beijing.json'),
]) {
  if (!fs.existsSync(requiredPath)) throw new Error(`Missing build output: ${requiredPath}`);
}

const index = JSON.parse(fs.readFileSync(indexPath, 'utf8').replace(/^\uFEFF/, ''));
const missing = Object.entries(index).filter(([, province]) => {
  return !province.dataFile
    || !/^[a-z0-9_-]+\.json$/.test(province.dataFile)
    || !fs.existsSync(path.join(distDir, 'data', 'provinces', province.dataFile));
});

if (missing.length > 0) {
  throw new Error(`Province output verification failed: ${missing.map(([name]) => name).join(', ')}`);
}

console.log(`Build verification passed: ${Object.keys(index).length} provinces.`);
