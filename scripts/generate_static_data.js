const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const dbPath = path.join(rootDir, 'content', 'db.json');
const dataDir = path.join(rootDir, 'data');
const provincesDir = path.join(dataDir, 'provinces');

function getProvinceDataFile(name, province) {
  const id = String(province?.id || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(id)) {
    throw new Error(`Province "${name}" must have an ASCII id before static data can be generated.`);
  }
  return `${id}.json`;
}

function writeJson(filePath, value, { bom = false } = {}) {
  const tempPath = `${filePath}.tmp`;
  const json = JSON.stringify(value)
    .replace(/&/g, '\\u0026')
    .replace(/'/g, '\\u0027')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');
  const content = `${bom ? '\uFEFF' : ''}${json}\r\n`;
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function buildProvinceIndex(provinces) {
  const index = {};

  for (const [name, province] of Object.entries(provinces || {})) {
    index[name] = {
      id: province.id,
      name: province.name,
      province: province.province,
      description: province.description,
      tags: province.tags,
      weather: province.weather,
      bestTime: province.bestTime,
      image: province.image,
      attractionCount: Array.isArray(province.attractions) ? province.attractions.length : 0,
      dataFile: getProvinceDataFile(name, province),
    };
  }

  return index;
}

function buildSearchIndex(provinces) {
  const index = [];

  for (const [provinceName, province] of Object.entries(provinces || {})) {
    for (const attraction of province.attractions || []) {
      index.push({
        province: province.province || provinceName,
        provinceId: province.id || provinceName,
        id: attraction.id,
        name: attraction.name,
        city: attraction.city,
        level: attraction.level,
        rating: attraction.rating,
        reviewsCount: attraction.reviewsCount,
        price: attraction.price,
        intro: attraction.intro,
        address: attraction.address,
        image: attraction.image,
        tags: attraction.tags,
      });
    }
  }

  return index;
}

function main() {
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const provinces = db.provinces || {};

  fs.rmSync(provincesDir, { recursive: true, force: true });
  fs.mkdirSync(provincesDir, { recursive: true });
  writeJson(path.join(dataDir, 'provinces-index.json'), buildProvinceIndex(provinces), { bom: true });
  writeJson(path.join(dataDir, 'search-index.json'), buildSearchIndex(provinces));

  for (const [name, province] of Object.entries(provinces)) {
    writeJson(path.join(provincesDir, getProvinceDataFile(name, province)), province, { bom: true });
  }

  console.log(`Generated ${Object.keys(provinces).length} province files and search index in ${path.relative(rootDir, dataDir)}`);
}

main();
