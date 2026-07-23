const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const outputDir = path.join(rootDir, 'dist');

if (path.dirname(outputDir) !== rootDir || path.basename(outputDir) !== 'dist') {
  throw new Error(`Refusing to clean unexpected output directory: ${outputDir}`);
}

function copyFile(relativePath) {
  const source = path.join(rootDir, relativePath);
  const destination = path.join(outputDir, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function copyDirectory(relativePath) {
  fs.cpSync(path.join(rootDir, relativePath), path.join(outputDir, relativePath), {
    recursive: true,
    force: true,
    filter: (source) => !path.basename(source).startsWith('.'),
  });
}

function listFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(fullPath));
    if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

function hashFile(relativePath) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(outputDir, relativePath)))
    .digest('hex')
    .slice(0, 12);
}

execFileSync(process.execPath, [path.join(rootDir, 'scripts', 'generate_static_data.js')], {
  cwd: rootDir,
  stdio: 'inherit',
});

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

for (const file of ['index.html', 'app.js', 'style.css', 'china.json', 'china_geo.js']) {
  copyFile(file);
}
for (const directory of ['assets', 'data', 'vendor']) {
  copyDirectory(directory);
}

const indexPath = path.join(outputDir, 'index.html');
let indexHtml = fs.readFileSync(indexPath, 'utf8');
indexHtml = indexHtml
  .replace(/style\.css(?:\?v=[^"']*)?/g, `style.css?v=${hashFile('style.css')}`)
  .replace(/china_geo\.js(?:\?v=[^"']*)?/g, `china_geo.js?v=${hashFile('china_geo.js')}`)
  .replace(/app\.js(?:\?v=[^"']*)?/g, `app.js?v=${hashFile('app.js')}`);
fs.writeFileSync(indexPath, indexHtml, 'utf8');

const files = listFiles(outputDir);
const nonAsciiPaths = files
  .map((file) => path.relative(outputDir, file))
  .filter((relativePath) => /[^\x00-\x7F]/.test(relativePath));
if (nonAsciiPaths.length > 0) {
  throw new Error(`Deployment paths must be ASCII-only:\n${nonAsciiPaths.join('\n')}`);
}

const totalBytes = files.reduce((sum, file) => sum + fs.statSync(file).size, 0);
const largest = files
  .map((file) => ({ file, size: fs.statSync(file).size }))
  .sort((a, b) => b.size - a.size)[0];

const buildInfo = {
  version: process.env.GITHUB_SHA || process.env.BUILD_VERSION || 'local',
  builtAt: new Date().toISOString(),
  files: files.length,
};
fs.writeFileSync(path.join(outputDir, 'build-info.json'), `${JSON.stringify(buildInfo, null, 2)}\n`);

console.log(`Universal server frontend ready: ${path.relative(rootDir, outputDir)}`);
console.log(`Files: ${files.length + 1}; total: ${(totalBytes / 1024 / 1024).toFixed(2)} MiB`);
console.log(`Largest: ${path.relative(outputDir, largest.file)} (${(largest.size / 1024 / 1024).toFixed(2)} MiB)`);
