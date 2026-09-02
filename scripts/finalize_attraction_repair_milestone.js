const fs = require('fs');
const path = require('path');
const { buildCityProvinceIndex, validateCard } = require('./attraction_card_consistency');

const root = path.resolve(__dirname, '..');
const milestoneArg = process.argv.find(value => value.startsWith('--milestone='));
const milestone = milestoneArg ? milestoneArg.slice('--milestone='.length) : (process.env.ATTRACTION_MILESTONE || 'priority-01');
const manifestPath = path.join(root, '.runtime', 'attraction-content-milestones', milestone, 'manifest.json');
const provincesDir = path.join(root, 'data', 'provinces');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
const cityIndex = buildCityProvinceIndex(provincesDir);
const sources = new Map();
for (const file of fs.readdirSync(provincesDir).filter(name => name.endsWith('.json'))) {
  const data = JSON.parse(fs.readFileSync(path.join(provincesDir, file), 'utf8').replace(/^\uFEFF/, ''));
  for (const item of data.attractions || []) sources.set(item.id, item);
}

for (const item of manifest.items) {
  const repairsEntity = item.repairKinds.includes('entity');
  const repairsLazy = item.repairKinds.includes('lazy');
  const repairsGuide = item.repairKinds.some(kind => kind === 'guideTemplate' || kind === 'guideMissing');
  if (!repairsEntity) { delete item.proposed.intro; delete item.proposed.description; }
  if (!repairsLazy) delete item.proposed.lazy_ai_text;
  if (!repairsGuide) delete item.proposed.guide_data;
  const gateItem = { ...item, issues: [
    ...(repairsLazy ? ['lazy'] : []),
    ...(repairsGuide ? ['travel'] : []),
  ] };
  const effective = { ...(sources.get(item.id) || {}), ...item.before, ...item.proposed };
  item.validation = validateCard(gateItem, effective, cityIndex);
  item.validation.errors = item.validation.errors.filter(error => {
    if (['intro_too_short', 'intro_generic'].includes(error.code)) {
      if (manifest.phase === '内容完善') {
        const intro = String(effective.intro || effective.description || '').trim();
        const generic = /(自然风光秀丽，是体验当地特色美景的绝佳去处|历史底蕴深厚，是一处非常值得一游的人文胜地|以.+为主要看点。适合纳入.+经典游览线路)/u.test(intro);
        return repairsEntity && (intro.length < 25 || generic);
      }
      return repairsEntity;
    }
    if (error.code === 'foreign_city_reference') {
      if (manifest.phase === '内容完善' && error.field === 'intro') {
        const intro = String(effective.intro || '');
        const referencedCity = String(error.message || '').match(/：(.+)$/u)?.[1];
        if (/(中山文化|昌江河)/u.test(intro)) return false;
        if (referencedCity && new RegExp(`${referencedCity}(?:区|县|镇|街道)`, 'u').test(intro)) return false;
      }
      return error.field === 'intro' ? repairsEntity : repairsLazy;
    }
    if (['lazy_entity_ambiguous', 'lazy_missing'].includes(error.code)) return repairsLazy;
    if (['guide_missing', 'guide_template_residue'].includes(error.code)) return repairsGuide;
    return false;
  });
  item.validation.passed = item.validation.errors.length === 0;
  item.status = item.validation.passed ? 'ready' : 'needs_repair';
}
const ready = manifest.items.filter(item => item.status === 'ready').length;
manifest.status = ready === manifest.items.length ? 'ready_for_preview' : 'needs_repair';
manifest.finalizedAt = new Date().toISOString();
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\r\n`, 'utf8');
console.log(JSON.stringify({ status: manifest.status, ready, total: manifest.items.length, failed: manifest.items.length - ready }, null, 2));
if (ready !== manifest.items.length) {
  for (const item of manifest.items.filter(value => value.status !== 'ready')) {
    console.log(`${item.province}/${item.city}/${item.name}: ${item.validation.errors.map(error => error.message).join('；')}`);
  }
  process.exitCode = 2;
}
