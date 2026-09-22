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
  path.join(distDir, 'robots.txt'),
  path.join(distDir, 'sitemap.xml'),
  path.join(distDir, 'destinations', 'index.html'),
  path.join(distDir, 'destinations', 'beijing.html'),
  path.join(distDir, 'seo-build-info.json'),
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

const seoInfo = JSON.parse(fs.readFileSync(path.join(distDir, 'seo-build-info.json'), 'utf8'));
const expectedAttractionCount = Object.values(index).reduce((sum, province) => sum + Number(province.attractionCount || 0), 0);
if (seoInfo.provinceCount !== Object.keys(index).length || seoInfo.attractionCount !== expectedAttractionCount) {
  throw new Error(`SEO page count mismatch: ${JSON.stringify(seoInfo)}`);
}

const robots = fs.readFileSync(path.join(distDir, 'robots.txt'), 'utf8');
if (!robots.includes('Sitemap: https://xzmap.xzbest.site/sitemap.xml')) {
  throw new Error('robots.txt does not reference the production sitemap');
}

const sitemap = fs.readFileSync(path.join(distDir, 'sitemap.xml'), 'utf8');
const sitemapUrlCount = (sitemap.match(/<url>/g) || []).length;
if (sitemapUrlCount !== seoInfo.sitemapUrlCount || !sitemap.includes('/attractions/beijing/')) {
  throw new Error(`Sitemap verification failed: ${sitemapUrlCount} URLs`);
}

console.log(`Build verification passed: ${Object.keys(index).length} provinces, ${seoInfo.attractionCount} SEO attraction pages.`);
