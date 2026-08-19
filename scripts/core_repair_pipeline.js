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
const { healAdditionsAgainstExisting, healPackageDuplicates } = require('./core_package_self_heal');

const rootDir = path.join(__dirname, '..');
const contentDir = path.join(rootDir, 'content');
const runtimeDir = path.join(rootDir, '.runtime');
const reportDir = path.join(rootDir, 'reports');
const identityDecisionsPath = path.join(contentDir, 'core-identity-decisions.json');

const args = new Map(process.argv.slice(2).map(arg => {
  const match = arg.match(/^--([^=]+)=(.*)$/);
  return match ? [match[1], match[2]] : [arg.replace(/^--/, ''), true];
}));
const selectedProvince = String(args.get('province') || '');
const mode = args.has('apply') ? 'apply' : args.has('check') ? 'check' : args.has('finalize') ? 'finalize' : 'prepare';

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
  const names = aliasesFor(item);
  return [...(official.fiveA || []), ...(official.resorts || [])].find(record => (
    names.some(name => probablySameAttraction(name, record.name))
  )) || null;
}

function blockingQualityIssues(quality) {
  const warningOnly = new Set(['source.basicInfoSingleSource', 'source.basicInfoTraceability']);
  return (quality?.issues || []).filter(issue => !warningOnly.has(issue));
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

function validatePackage(context, options = {}) {
  const requireReviewed = options.requireReviewed !== false;
  const packageData = readJson(context.packagePath, null);
  const identityDecisions = readJson(identityDecisionsPath, { provinces: {} }).provinces?.[context.province] || {};
  const errors = [];
  const readyAttractions = [];
  const readyOverrides = [];
  if (!packageData) return { packageData: null, errors: ['尚未建立补全包。'], readyAttractions, readyOverrides };
  if (packageData.province !== context.province) errors.push('补全包省份与当前省份不一致。');
  if (requireReviewed && packageData.status !== 'reviewed') errors.push('补全包尚未完成最终复核。');
  if (!requireReviewed && !['collecting', 'reviewed'].includes(packageData.status)) errors.push('补全包尚未进入资料采集阶段。');
  const lazyOverrides = {
    ...readJson(path.join(contentDir, 'lazy-guide-overrides.json')),
    ...readJson(path.join(runtimeDir, 'core-lazy-guide-overrides.json')),
  };
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
    if (duplicate && identityDecisions[addition.baselineKey]?.action !== 'keep_new') {
      errors.push(`新增项 ${addition.name} 疑似重复现有 ${duplicate.name}（${duplicate.id}），禁止新增。`);
      continue;
    }
    const candidate = deepMerge(JSON.parse(JSON.stringify(addition)), lazyOverrides[addition.id] || {});
    const policy = candidate.quality_policy || {};
    const lazyText = String(candidate.lazy_ai_text || '');
    const contentRisks = [];
    if (/\d{1,2}[:：]\d{2}|(?:上午|中午|下午|晚上|傍晚|夜间)\s*\d+(?:点|时)|\d+点左右/.test(lazyText)) contentRisks.push('含固定时刻');
    if (/\d+(?:\.\d+)?\s*元/.test(lazyText)) contentRisks.push('含固定价格');
    if (/(你们这次|需要我(?:再)?帮你|还可以帮你|如果需要[，,]?我可以)/.test(lazyText)) contentRisks.push('含对话式结尾');
    for (const term of policy.forbiddenTerms || []) {
      if (term && lazyText.includes(term)) contentRisks.push(`含禁用内容“${term}”`);
    }
    if (contentRisks.length) {
      errors.push(`${addition.name} 懒人攻略内容风险：${[...new Set(contentRisks)].join('、')}。请重新采集或人工复核。`);
      continue;
    }
    delete candidate.baselineKey;
    delete candidate.quality_policy;
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
      const blockers = blockingQualityIssues(quality);
      if (!quality.ready || blockers.length) throw new Error(`修复项 ${current.name} 仍未通过：${blockers.join(', ')}`);
      readyOverrides.push({ id, patch, baselineKey: patch.baselineKey || '' });
    } catch (error) {
      errors.push(error.message);
    }
  }
  return { packageData, errors, readyAttractions, readyOverrides };
}

function selfHealPackage(context) {
  const packageData = readJson(context.packagePath, null);
  if (!packageData) return [];
  const decisions = readJson(identityDecisionsPath, { provinces: {} }).provinces?.[context.province] || {};
  const deduplicated = healPackageDuplicates(packageData);
  const aligned = healAdditionsAgainstExisting(
    deduplicated.packageData,
    { attractions: context.records },
    context.baseline,
    decisions,
  );
  const actions = [...deduplicated.actions, ...aligned.actions];
  const pending = [];
  for (const item of aligned.packageData.attractions || []) {
    if (decisions[item.baselineKey]?.action === 'keep_new') continue;
    const baselineItem = context.baseline.attractions.find(candidate => candidate.key === item.baselineKey);
    if (!baselineItem) continue;
    const candidates = context.records.filter(record => recordMatchesBaseline(record, baselineItem));
    if (!candidates.length) continue;
    pending.push({
      baselineKey: item.baselineKey,
      incoming: { id: item.id, name: item.name, city: item.city || '' },
      existing: candidates.map(candidate => ({ id: candidate.id, name: candidate.name, city: candidate.city || '', dataFile: candidate.dataFile || '' })),
      reason: candidates.length > 1 ? '核心清单同时命中多个现有实体' : '名称接近但缺少足够同实体证据',
    });
  }
  const conflictPath = path.join(runtimeDir, `core-identity-conflicts.${context.slug}.json`);
  writeJsonAtomic(conflictPath, { province: context.province, updatedAt: new Date().toISOString(), pending });
  if (!actions.length) return { actions: [], pending, conflictPath };
  const packageBackup = backup(context.packagePath);
  writeJsonAtomic(context.packagePath, {
    ...aligned.packageData,
    updatedAt: new Date().toISOString(),
    selfHealActions: [...(packageData.selfHealActions || []), ...actions],
  });
  console.log(`质量门禁已自动修复 ${actions.length} 个唯一同实体重复项。`);
  if (packageBackup) console.log(`原补全包备份：${packageBackup}`);
  return { actions, pending, conflictPath };
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
  for (const { baselineItem, candidate } of validation.readyAttractions) {
    baselineItem.preferredId = candidate.id;
    const mergedKeys = candidate.self_heal?.mergedBaselineKeys || [];
    const mergedAliases = candidate.self_heal?.mergedAliases || [];
    for (const item of context.baseline.attractions) {
      if (mergedKeys.includes(item.key)
        || mergedAliases.some(alias => probablySameAttraction(item.name, alias))) {
        item.preferredId = candidate.id;
      }
    }
  }
  for (const { id, patch, baselineKey } of validation.readyOverrides) {
    if (!baselineKey) continue;
    const baselineItem = context.baseline.attractions.find(item => item.key === baselineKey);
    if (baselineItem) baselineItem.preferredId = id;
    const mergedKeys = patch.self_heal?.mergedBaselineKeys || [];
    const mergedAliases = patch.self_heal?.mergedAliases || [];
    for (const item of context.baseline.attractions) {
      if (mergedKeys.includes(item.key)
        || mergedAliases.some(alias => probablySameAttraction(item.name, alias))) {
        item.preferredId = id;
      }
    }
  }
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
  const selfHeal = selfHealPackage(context);
  if (selfHeal.pending.length) {
    console.log('发现需要业务确认的景点身份歧义：');
    selfHeal.pending.forEach(item => console.log(`- ${item.incoming.name}：${item.existing.map(value => `${value.name}（${value.city || '城市待核验'}）`).join('、')}`));
    console.log('请在总控 [3] 任务中心选择“处理景点身份歧义”，完成后再按 [2] 继续。');
    process.exitCode = 2;
    return;
  }
  const validation = validatePackage(context, { requireReviewed: mode !== 'finalize' });
  if (validation.errors.length) {
    console.log('补全包尚未通过质量闸门：');
    validation.errors.forEach(error => console.log(`- ${error}`));
    process.exitCode = 2;
    return;
  }
  if (mode === 'finalize') {
    if (validation.packageData.status !== 'reviewed') {
      const packageBackup = backup(context.packagePath);
      validation.packageData.status = 'reviewed';
      validation.packageData.reviewedAt = new Date().toISOString().slice(0, 10);
      validation.packageData.reviewedAtIso = new Date().toISOString();
      writeJsonAtomic(context.packagePath, validation.packageData);
      console.log(`${context.province}补全包已通过全部质量闸门，状态已更新为 reviewed。`);
      if (packageBackup) console.log(`原补全包备份：${packageBackup}`);
    } else {
      console.log(`${context.province}补全包已经是 reviewed 状态。`);
    }
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
