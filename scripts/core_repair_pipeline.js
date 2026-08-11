const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  deepMerge,
  normalizeAttractionName,
  probablySameAttraction,
  validateManualAttraction,
} = require('./generate_static_data');
const { getQuality } = require('./report_core_attractions');

const rootDir = path.join(__dirname, '..');
const contentDir = path.join(rootDir, 'content');
const runtimeDir = path.join(rootDir, '.runtime');
const reportDir = path.join(rootDir, 'reports');

const args = new Map(process.argv.slice(2).map(arg => {
  const match = arg.match(/^--([^=]+)=(.*)$/);
  return match ? [match[1], match[2]] : [arg.replace(/^--/, ''), true];
}));
const selectedProvince = String(args.get('province') || '');
const mode = args.has('apply') ? 'apply' : args.has('check') ? 'check' : 'prepare';

function readJson(filePath, fallback = {}) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\r\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function backup(filePath) {
  if (!fs.existsSync(filePath)) return '';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(runtimeDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const target = path.join(backupDir, `${path.basename(filePath)}.${stamp}.bak`);
  fs.copyFileSync(filePath, target);
  return target;
}

function runReport(province) {
  const result = spawnSync(process.execPath, [path.join('scripts', 'report_core_attractions.js'), `--province=${province}`], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: false,
  });
  if (result.status !== 0) throw new Error('核心景点报告生成失败。');
}

function readManualRecords() {
  const result = [];
  for (const name of fs.readdirSync(contentDir).filter(item => /^manual-attractions(?:\.[a-z0-9_-]+)?\.json$/i.test(item)).sort()) {
    const layer = readJson(path.join(contentDir, name));
    for (const [province, records] of Object.entries(layer || {})) {
      for (const record of records || []) result.push({ ...record, province, dataFile: name });
    }
  }
  return result;
}

function allProvinceRecords(db, manual, province) {
  const records = (db.provinces?.[province]?.attractions || []).map(item => ({ ...item, province, dataFile: 'db.json' }));
  return [...records, ...manual.filter(item => item.province === province)];
}

function aliasesFor(item) {
  return [item.name, ...(item.aliases || [])].filter(Boolean);
}

function recordMatchesBaseline(record, baselineItem) {
  return aliasesFor(baselineItem).some(alias => probablySameAttraction(record.name, alias));
}

function findOfficialRecord(item, official) {
  const names = new Set(aliasesFor(item).map(normalizeAttractionName));
  return [...(official.fiveA || []), ...(official.resorts || [])].find(record => names.has(normalizeAttractionName(record.name))) || null;
}

function duplicateCandidates(item, records) {
  return records
    .filter(record => recordMatchesBaseline(record, item))
    .map(record => ({ id: record.id, name: record.name, city: record.city || '', dataFile: record.dataFile }));
}

function createDossier(context) {
  const { province, slug, report, baseline, official, records } = context;
  const blockers = report.items.filter(item => item.status !== 'present' || !item.matches?.some(match => match.quality?.ready));
  const items = blockers.map(item => {
    const baselineItem = baseline.attractions.find(entry => entry.key === item.key) || item;
    const officialRecord = findOfficialRecord(baselineItem, official);
    const duplicates = duplicateCandidates(baselineItem, records);
    const existing = item.status === 'present' ? item.matches?.[0] || null : null;
    const requiredActions = [];
    if (item.status === 'missing') requiredActions.push('新增完整景点记录');
    if (item.status === 'review') requiredActions.push('人工确认同名或别名关系，禁止自动新增');
    if (existing && !existing.quality?.ready) requiredActions.push(...(existing.quality?.issues || []).map(issue => `补齐 ${issue}`));
    if (!officialRecord && item.basis?.includes('official_5a')) requiredActions.push('重新采集或人工核验官方身份');
    if (duplicates.length) requiredActions.push('先处理疑似重复记录，不得直接新增');
    return {
      baselineKey: item.key,
      name: item.name,
      aliases: aliasesFor(baselineItem),
      city: item.city || '',
      currentStatus: item.status,
      existing,
      officialRecord,
      duplicateCandidates: duplicates,
      requiredActions: [...new Set(requiredActions)],
      qualityGate: {
        identityResolved: item.status === 'present' || duplicates.length === 0,
        officialEvidenceReady: !item.basis?.includes('official_5a') || Boolean(officialRecord),
        basicInfoReady: Boolean(existing?.quality?.basicComplete),
        travelGuideReady: Boolean(existing?.quality?.guideComplete),
        lazyGuideReady: Boolean(existing?.quality?.lazyComplete),
        sourceTraceabilityReady: Boolean(existing?.quality?.sourceComplete),
        imageReady: Boolean(existing?.quality?.imageResolvable && existing?.quality?.imageSourceComplete),
      },
    };
  });
  return {
    province,
    generatedAt: new Date().toISOString(),
    baselineFile: `content/core-attractions.${slug}.json`,
    reportFile: `reports/core-attractions-${slug}.json`,
    packageFile: `content/core-repair-packages.${slug}.json`,
    policy: '先解决身份与重复，再补基本信息、旅行指南、点点懒人攻略、授权图片和来源；所有质量闸门通过后才允许写入。',
    blockerCount: items.length,
    items,
  };
}

function loadContext() {
  if (!selectedProvince) throw new Error('请使用 --province=省份。');
  const db = readJson(path.join(contentDir, 'db.json'), { provinces: {} });
  const province = db.provinces?.[selectedProvince];
  if (!province) throw new Error(`基础数据库中没有找到省份：${selectedProvince}`);
  const slug = province.id || selectedProvince;
  const baselinePath = path.join(contentDir, `core-attractions.${slug}.json`);
  if (!fs.existsSync(baselinePath)) throw new Error(`${selectedProvince}尚未批准核心景点清单。`);
  runReport(selectedProvince);
  const reportPath = path.join(reportDir, `core-attractions-${slug}.json`);
  const officialPath = path.join(runtimeDir, `core-official-${slug}.json`);
  if (!fs.existsSync(officialPath)) throw new Error('缺少官方候选数据，请先运行官方来源采集。');
  const manual = readManualRecords();
  return {
    province: selectedProvince,
    slug,
    db,
    baselinePath,
    baseline: readJson(baselinePath),
    report: readJson(reportPath),
    official: readJson(officialPath),
    records: allProvinceRecords(db, manual, selectedProvince),
    packagePath: path.join(contentDir, `core-repair-packages.${slug}.json`),
    dossierPath: path.join(runtimeDir, `core-repairs.${slug}.json`),
  };
}

function validatePackage(context) {
  const packageData = readJson(context.packagePath, null);
  const errors = [];
  const readyAttractions = [];
  const readyOverrides = [];
  if (!packageData) return { packageData: null, errors: ['尚未建立补全包。'], readyAttractions, readyOverrides };
  if (packageData.province !== context.province) errors.push('补全包省份与当前省份不一致。');
  if (packageData.status !== 'reviewed') errors.push('补全包尚未标记为 reviewed。');
  const lazyOverrides = readJson(path.join(contentDir, 'lazy-guide-overrides.json'));
  const existingById = new Map(context.records.map(item => [item.id, item]));
  for (const addition of packageData.attractions || []) {
    const baselineItem = context.baseline.attractions.find(item => item.key === addition.baselineKey);
    if (!baselineItem) {
      errors.push(`新增项 ${addition.name || addition.id} 没有有效 baselineKey。`);
      continue;
    }
    if (!recordMatchesBaseline(addition, baselineItem)) {
      errors.push(`新增项 ${addition.name} 与核心清单名称/别名不一致。`);
      continue;
    }
    if (existingById.has(addition.id)) {
      errors.push(`新增项 ID 已存在：${addition.id}。`);
      continue;
    }
    const duplicate = context.records.find(record => recordMatchesBaseline(record, baselineItem));
    if (duplicate) {
      errors.push(`新增项 ${addition.name} 疑似重复现有 ${duplicate.name}（${duplicate.id}），禁止新增。`);
      continue;
    }
    const candidate = deepMerge(JSON.parse(JSON.stringify(addition)), lazyOverrides[addition.id] || {});
    delete candidate.baselineKey;
    try {
      validateManualAttraction(candidate, context.province);
      readyAttractions.push({ baselineItem, candidate });
    } catch (error) {
      errors.push(error.message);
    }
  }
  const attractionOverrides = readJson(path.join(contentDir, 'attraction-overrides.json'));
  for (const [id, patch] of Object.entries(packageData.overrides || {})) {
    const current = existingById.get(id);
    if (!current) {
      errors.push(`修复项引用不存在的景点 ID：${id}。`);
      continue;
    }
    const candidate = deepMerge(deepMerge(JSON.parse(JSON.stringify(current)), attractionOverrides[id] || {}), patch);
    deepMerge(candidate, lazyOverrides[id] || {});
    try {
      const quality = getQuality(candidate);
      if (!quality.ready || quality.issues.length) throw new Error(`修复项 ${current.name} 仍未通过：${quality.issues.join(', ')}`);
      readyOverrides.push({ id, patch });
    } catch (error) {
      errors.push(error.message);
    }
  }
  return { packageData, errors, readyAttractions, readyOverrides };
}

function applyPackage(context, validation) {
  if (validation.errors.length) throw new Error(`质量闸门未通过：\n- ${validation.errors.join('\n- ')}`);
  const manualPath = path.join(contentDir, `manual-attractions.${context.slug}-core.json`);
  const manualLayer = readJson(manualPath, {});
  const existing = manualLayer[context.province] || [];
  const ids = new Set(existing.map(item => item.id));
  for (const { candidate } of validation.readyAttractions) {
    if (!ids.has(candidate.id)) existing.push(candidate);
  }
  manualLayer[context.province] = existing;
  const manualBackup = backup(manualPath);
  writeJsonAtomic(manualPath, manualLayer);

  const overridePath = path.join(contentDir, 'attraction-overrides.json');
  const overrides = readJson(overridePath, {});
  for (const { id, patch } of validation.readyOverrides) overrides[id] = deepMerge(overrides[id] || {}, patch);
  const overrideBackup = validation.readyOverrides.length ? backup(overridePath) : '';
  if (validation.readyOverrides.length) writeJsonAtomic(overridePath, overrides);

  const baselineBackup = backup(context.baselinePath);
  for (const { baselineItem, candidate } of validation.readyAttractions) baselineItem.preferredId = candidate.id;
  context.baseline.checkedAt = new Date().toISOString().slice(0, 10);
  writeJsonAtomic(context.baselinePath, context.baseline);
  const packageBackup = backup(context.packagePath);
  validation.packageData.status = 'applied';
  validation.packageData.appliedAt = new Date().toISOString();
  validation.packageData.appliedAttractionIds = validation.readyAttractions.map(item => item.candidate.id);
  validation.packageData.appliedOverrideIds = validation.readyOverrides.map(item => item.id);
  writeJsonAtomic(context.packagePath, validation.packageData);
  return { manualPath, manualBackup, overrideBackup, baselineBackup, packageBackup };
}

function main() {
  const context = loadContext();
  const dossier = createDossier(context);
  writeJsonAtomic(context.dossierPath, dossier);
  console.log(`${context.province}补全档案：${dossier.blockerCount} 个阻塞项。`);
  console.log(`档案：${context.dossierPath}`);
  if (mode === 'prepare') {
    console.log(fs.existsSync(context.packagePath) ? `检测到补全包：${context.packagePath}` : `尚无补全包；请按档案建立：${context.packagePath}`);
    return;
  }
  const validation = validatePackage(context);
  if (validation.errors.length) {
    console.log('补全包尚未通过质量闸门：');
    validation.errors.forEach(error => console.log(`- ${error}`));
    process.exitCode = 2;
    return;
  }
  console.log(`质量闸门通过：新增 ${validation.readyAttractions.length}，修复 ${validation.readyOverrides.length}。`);
  if (mode === 'apply') {
    const result = applyPackage(context, validation);
    console.log(`已写入：${result.manualPath}`);
    console.log('已同步核心清单绑定；原文件已生成时间戳备份，可回撤。');
  }
}

try {
  main();
} catch (error) {
  console.error(`核心缺失修复失败：${error.message}`);
  process.exitCode = 1;
}
