const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const rootDir = path.join(__dirname, '..');
const runtimeDir = path.join(rootDir, '.runtime');
const contentDir = path.join(rootDir, 'content');
const batchesDir = path.join(runtimeDir, 'observation-batches');
const activeBatchPath = path.join(batchesDir, 'active.json');

// 少量名称无法仅靠通用字符归一化可靠判断，但其实体关系已经过人工确认。
// 放在统一身份规则中，避免批量补选把已有景点再次当成新增项。
const confirmedExistingAliases = new Map([
  ['吉林:长春电影制片厂', '长影旧址博物馆'],
  ['江苏:太平天国历史博物馆(瞻园)', '瞻园'],
  ['山西:晋祠博物馆', '晋祠景区'],
]);

const excludedPattern = /专场|单口喜剧|脱口秀|演出|剧场|巡演|世界巡演|world tour|演唱会|大马戏|马戏团|特展|快闪|音乐节|超市|百货|商厦|奥特莱斯|购物中心|胖东来|水舞间|刘旸|bts|bigbang|制药六厂|药厂/i;

function readJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\r\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

function normalizeName(value) {
  return String(value || '').toLowerCase()
    .replace(/[·•（）()\-—_\s《》“”"']/g, '')
    .replace(/国家[345]a级旅游景区/g, '')
    .replace(/国家级|国家重点|国家/g, '')
    .replace(/旅游风景名胜区|旅游景区|旅游风景区|风景名胜区|风景旅游区|风景区|旅游区|景区|旅游度假区|度假区|公园$/g, '')
    .replace(/博物院$/g, '博物馆')
    .trim();
}

function related(left, right) {
  const a = normalizeName(left);
  const b = normalizeName(right);
  return Boolean(a && b && (a === b || (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a)))));
}

function scanObservationPool() {
  const db = readJson(path.join(contentDir, 'db.json'), { provinces: {} });
  if (!fs.existsSync(runtimeDir)) return [];
  const files = fs.readdirSync(runtimeDir).filter(name => /^core-attractions\.[a-z0-9_-]+\.draft\.json$/i.test(name)).sort();
  const result = [];
  for (const file of files) {
    const draft = readJson(path.join(runtimeDir, file), {});
    const province = draft.province;
    if (!province) continue;
    const slug = file.replace(/^core-attractions\./, '').replace(/\.draft\.json$/, '');
    const baseline = readJson(path.join(contentDir, `core-attractions.${slug}.json`), { attractions: [] });
    const existing = [...(db.provinces?.[province]?.attractions || []), ...(baseline.attractions || [])];
    const priority = new Set((draft.priorityObservationCandidates || []).map(item => item.name));
    const provinceItems = [];
    for (const candidate of draft.observationCandidates || []) {
      if (!candidate.name || excludedPattern.test(candidate.name)) continue;
      if (existing.some(item => related(item.name, candidate.name) || (item.aliases || []).some(alias => related(alias, candidate.name)))) continue;
      const duplicate = provinceItems.find(item => related(item.name, candidate.name));
      if (duplicate) {
        duplicate.priority ||= priority.has(candidate.name);
        duplicate.aliases = [...new Set([...(duplicate.aliases || []), candidate.name, ...(candidate.aliases || [])])];
        continue;
      }
      provinceItems.push({
        province,
        slug,
        name: candidate.name,
        city: candidate.city || '',
        aliases: [...new Set([candidate.name, ...(candidate.aliases || [])])],
        sources: candidate.sources || [],
        otaRank: Number(candidate.otaRank || 0),
        amapRank: Number(candidate.amapRank || 0),
        preferredId: candidate.preferredId || '',
        priority: priority.has(candidate.name) || Number(candidate.otaRank || 0) > 0 || Number(candidate.amapRank || 0) > 0,
      });
    }
    result.push(...provinceItems);
  }
  return result.sort((a, b) => a.province.localeCompare(b.province, 'zh-CN') || Number(b.priority) - Number(a.priority) || a.name.localeCompare(b.name, 'zh-CN'))
    .map((item, index) => ({ ...item, index: index + 1 }));
}

function parseSelection(input, items) {
  const value = String(input || '').trim().toLowerCase();
  if (!value || value === '0') return [];
  if (value === 'rec') return items.filter(item => item.priority);
  if (value === 'all') return items.slice();
  const numbers = new Set();
  for (const part of value.split(/[,，\s]+/)) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Math.min(Number(range[1]), Number(range[2]));
      const end = Math.max(Number(range[1]), Number(range[2]));
      for (let number = start; number <= end; number += 1) numbers.add(number);
    } else if (/^\d+$/.test(part)) numbers.add(Number(part));
  }
  return items.filter(item => numbers.has(item.index));
}

function printObservationPool(items) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.province)) groups.set(item.province, []);
    groups.get(item.province).push(item);
  }
  console.log('\n================ 全国单源观察池 ================');
  for (const [province, provinceItems] of groups) {
    console.log(`\n【${province}】${provinceItems.length} 项`);
    for (const item of provinceItems) console.log(`  [${String(item.index).padStart(3, '0')}] ${item.priority ? '★ ' : '  '}${item.name}${item.city ? `（${item.city}）` : ''}`);
  }
  const recommended = items.filter(item => item.priority).length;
  console.log(`\n合计 ${items.length} 项；★推荐 ${recommended} 项。`);
  console.log('输入 rec 选择推荐项，all 选择全部，或输入 1,3-8；输入 0 取消。');
}

function keyFor(province, name) {
  return `core_${crypto.createHash('md5').update(`${province}:${name}`).digest('hex').slice(0, 10)}`;
}

function baselineEntry(item, batchId) {
  const evidence = [];
  if (item.sources.includes('ctrip_popularity')) evidence.push('ctrip_province_sightlist');
  if (item.sources.includes('ctrip_city_sightlist')) evidence.push('ctrip_city_sightlist');
  if (item.sources.includes('xiaohongshu_popularity')) evidence.push('xiaohongshu_core_candidates');
  if (item.amapRank) evidence.push('amap_local_snapshot');
  return {
    key: keyFor(item.province, item.name),
    name: item.name,
    preferredId: item.preferredId || '',
    aliases: item.aliases || [item.name],
    city: item.city || '',
    tier: 'regional_icon',
    basis: ['manual_observation_selected'],
    evidence: [...new Set([...evidence, 'manual_observation_selected'])],
    sourceSignals: { otaRank: item.otaRank || null, amapRank: item.amapRank || null },
    matchWarnings: [],
    secondaryEvidence: [],
    selectionBatch: batchId,
  };
}

function createBatch(selected) {
  if (!selected.length) throw new Error('没有选择候选景点。');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const id = `observation-${stamp}`;
  const batchDir = path.join(batchesDir, id);
  const snapshotDir = path.join(batchDir, 'snapshot');
  fs.mkdirSync(snapshotDir, { recursive: true });
  const groups = new Map();
  for (const item of selected) {
    if (!groups.has(item.slug)) groups.set(item.slug, { province: item.province, slug: item.slug, items: [] });
    groups.get(item.slug).items.push(item);
  }
  const provinces = [];
  // 先完整校验并保存所有涉及文件，再开始暂存数据。这样任一省份失败时，
  // 整个批次都能恢复到创建前，而不会留下半个批次污染后续运行。
  for (const group of groups.values()) {
    const baselinePath = path.join(contentDir, `core-attractions.${group.slug}.json`);
    const packagePath = path.join(contentDir, `core-repair-packages.${group.slug}.json`);
    if (!fs.existsSync(baselinePath)) throw new Error(`${group.province}尚无核心清单，不能加入观察池批次。`);
    fs.copyFileSync(baselinePath, path.join(snapshotDir, path.basename(baselinePath)));
    const packageExisted = fs.existsSync(packagePath);
    if (packageExisted) fs.copyFileSync(packagePath, path.join(snapshotDir, path.basename(packagePath)));
    const selectedEntries = group.items.map(item => baselineEntry(item, id));
    provinces.push({
      province: group.province,
      slug: group.slug,
      status: 'queued',
      selectedKeys: selectedEntries.map(item => item.key),
      selectedNames: selectedEntries.map(item => item.name),
      packageExisted,
      attempts: 0,
    });
  }
  const manifest = {
    version: 1,
    id,
    status: 'queued',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    selectedCount: selected.length,
    provinces,
    batchDir,
  };
  const manifestPath = path.join(batchDir, 'manifest.json');
  writeJsonAtomic(manifestPath, manifest);
  writeJsonAtomic(activeBatchPath, { id, manifestPath });
  try {
    for (const group of groups.values()) {
      const baselinePath = path.join(contentDir, `core-attractions.${group.slug}.json`);
      const packagePath = path.join(contentDir, `core-repair-packages.${group.slug}.json`);
      const baseline = readJson(baselinePath, { attractions: [] });
      const selectedEntries = group.items.map(item => baselineEntry(item, id));
      baseline.attractions = [...(baseline.attractions || []), ...selectedEntries];
      baseline.checkedAt = new Date().toISOString().slice(0, 10);
      baseline.counts = { ...(baseline.counts || {}), attractions: baseline.attractions.length };
      writeJsonAtomic(baselinePath, baseline);
      if (fs.existsSync(packagePath)) fs.rmSync(packagePath, { force: true });
    }
    const staged = updateBatch(manifestPath, { status: 'queued' });
    return { manifest: staged, manifestPath };
  } catch (error) {
    for (const state of provinces) {
      const baselinePath = path.join(contentDir, `core-attractions.${state.slug}.json`);
      const packagePath = path.join(contentDir, `core-repair-packages.${state.slug}.json`);
      fs.copyFileSync(path.join(snapshotDir, path.basename(baselinePath)), baselinePath);
      const packageSnapshot = path.join(snapshotDir, path.basename(packagePath));
      if (state.packageExisted && fs.existsSync(packageSnapshot)) fs.copyFileSync(packageSnapshot, packagePath);
      else if (fs.existsSync(packagePath)) fs.rmSync(packagePath, { force: true });
    }
    updateBatch(manifestPath, { status: 'cancelled', error: `创建批次失败，已自动回滚：${error.message}` });
    throw error;
  }
}

function activeBatch() {
  const pointer = readJson(activeBatchPath, null);
  if (!pointer?.manifestPath) return null;
  const manifest = readJson(pointer.manifestPath, null);
  return manifest ? { manifest, manifestPath: pointer.manifestPath } : null;
}

function updateBatch(manifestPath, patch) {
  const current = readJson(manifestPath, {});
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  writeJsonAtomic(manifestPath, next);
  return next;
}

function filterReviewedPackage(manifestPath, slug) {
  const manifest = readJson(manifestPath, {});
  const provinceState = (manifest.provinces || []).find(item => item.slug === slug);
  if (!provinceState) throw new Error(`批次中不存在省份：${slug}`);
  const packagePath = path.join(contentDir, `core-repair-packages.${slug}.json`);
  const packageData = readJson(packagePath, null);
  if (packageData?.status !== 'reviewed') throw new Error(`${provinceState.province}补全包尚未 reviewed。`);
  const selectedKeys = new Set(provinceState.originalSelectedKeys || provinceState.selectedKeys || []);
  packageData.attractions = (packageData.attractions || []).filter(item => selectedKeys.has(item.baselineKey));
  packageData.overrides = Object.fromEntries(Object.entries(packageData.overrides || {}).filter(([, item]) => selectedKeys.has(item.baselineKey)));
  const covered = new Set([
    ...packageData.attractions.map(item => item.baselineKey),
    ...Object.values(packageData.overrides).map(item => item.baselineKey),
  ]);
  const missing = [...selectedKeys].filter(key => !covered.has(key));
  packageData.batchId = manifest.id;
  packageData.batchSelectedKeys = [...covered];
  packageData.updatedAt = new Date().toISOString();
  writeJsonAtomic(packagePath, packageData);
  return { packageData, coveredKeys: [...covered], missingKeys: missing };
}

function selectedEntryMap(state) {
  const baseline = readJson(path.join(contentDir, `core-attractions.${state.slug}.json`), { attractions: [] });
  return new Map((baseline.attractions || []).map(item => [item.key, item]));
}

function classifyMissing(state, missingKeys) {
  const entries = selectedEntryMap(state);
  const provinceData = readJson(path.join(rootDir, 'data', 'provinces', `${state.slug}.json`), { attractions: [] });
  const existingNames = new Set((provinceData.attractions || []).map(item => item.name));
  const resolved = [];
  const unresolved = [];
  for (const key of missingKeys) {
    const entry = entries.get(key) || {};
    const name = entry.name || key;
    const knownExisting = confirmedExistingAliases.get(`${state.province}:${name}`);
    if (knownExisting && existingNames.has(knownExisting)) {
      resolved.push({ key, name, type: 'already_present', existingName: knownExisting });
      continue;
    }
    // “澳门2049”是演出产品而非稳定景点；进入景点补全链路后被正确过滤，
    // 应记为已处理而不是无限重试的采集失败。
    if (excludedPattern.test(name) || /(?:中国)?澳门.{0,4}2049/i.test(name)) {
      resolved.push({ key, name, type: 'excluded_non_attraction' });
      continue;
    }
    unresolved.push(key);
  }
  return { resolved, unresolved };
}

function applyCoverageToState(state, coverage) {
  const entries = selectedEntryMap(state);
  const namesFor = keys => keys.map(key => entries.get(key)?.name || key);
  const classified = classifyMissing(state, coverage.missingKeys);
  if (!state.originalSelectedKeys) state.originalSelectedKeys = [...(state.selectedKeys || [])];
  if (!state.originalSelectedNames) state.originalSelectedNames = [...(state.selectedNames || [])];
  state.resolutions = classified.resolved;
  state.pendingKeys = classified.unresolved;
  state.pendingNames = namesFor(classified.unresolved);
  state.readyKeys = coverage.coveredKeys;
  state.readyNames = namesFor(coverage.coveredKeys);
  if (coverage.coveredKeys.length) {
    state.selectedKeys = [...coverage.coveredKeys];
    state.selectedNames = [...state.readyNames];
    state.status = 'ready';
    state.error = classified.unresolved.length ? `${classified.unresolved.length} 项保留断点。` : '';
  } else if (!classified.unresolved.length) {
    state.selectedKeys = [];
    state.selectedNames = [];
    state.status = 'resolved';
    state.error = '';
  } else {
    state.selectedKeys = [...classified.unresolved];
    state.selectedNames = [...state.pendingNames];
    state.status = 'failed';
    state.error = `${state.province}仍有 ${classified.unresolved.length} 个已选景点未形成完整补全资料。`;
  }
  return state;
}

function reconcileBatch(manifestPath) {
  let manifest = readJson(manifestPath, null);
  if (!manifest) throw new Error('批次清单不存在。');
  let changed = false;
  for (const state of manifest.provinces || []) {
    if (state.status !== 'failed') continue;
    try {
      const coverage = filterReviewedPackage(manifestPath, state.slug);
      applyCoverageToState(state, coverage);
      changed = true;
    } catch {
      // 补全包尚未形成时保留原断点，交给正常续跑流程处理。
    }
  }
  if (changed) manifest = updateBatch(manifestPath, { provinces: manifest.provinces, previewUrl: '', status: 'retry_ready' });
  return manifest;
}

function applyResolutionsToBaseline(baseline, state, manifestId, existingRecords = []) {
  const next = { ...baseline, attractions: [...(baseline.attractions || [])] };
  const existingByName = new Map(existingRecords.map(item => [String(item.name || ''), item]));
  let bound = 0;
  let removed = 0;
  const unresolved = [];
  for (const resolution of state.resolutions || []) {
    const index = next.attractions.findIndex(item => item.key === resolution.key);
    if (index < 0) continue;
    const entry = next.attractions[index];
    if (resolution.type === 'excluded_non_attraction') {
      // 只移除本批次暂存的候选，绝不删除历史核心清单。
      if (entry.selectionBatch === manifestId) {
        next.attractions.splice(index, 1);
        removed += 1;
      }
      continue;
    }
    if (resolution.type === 'already_present') {
      const existing = existingByName.get(String(resolution.existingName || ''));
      if (!existing?.id) {
        unresolved.push(resolution.name || resolution.key);
        continue;
      }
      next.attractions[index] = {
        ...entry,
        preferredId: existing.id,
        aliases: [...new Set([...(entry.aliases || []), entry.name, resolution.existingName].filter(Boolean))],
      };
      bound += 1;
    }
  }
  next.counts = { ...(next.counts || {}), attractions: next.attractions.length };
  return { baseline: next, bound, removed, unresolved };
}

function persistBatchResolutions(manifestPath) {
  const manifest = readJson(manifestPath, null);
  if (!manifest) return { bound: 0, removed: 0, unresolved: ['批次清单不存在'] };
  let bound = 0;
  let removed = 0;
  const unresolved = [];
  for (const state of manifest.provinces || []) {
    if (!(state.resolutions || []).length) continue;
    const baselinePath = path.join(contentDir, `core-attractions.${state.slug}.json`);
    const provincePath = path.join(rootDir, 'data', 'provinces', `${state.slug}.json`);
    const baseline = readJson(baselinePath, null);
    if (!baseline) {
      unresolved.push(`${state.province}核心清单不存在`);
      continue;
    }
    const provinceData = readJson(provincePath, { attractions: [] });
    const result = applyResolutionsToBaseline(baseline, state, manifest.id, provinceData.attractions || []);
    if (result.bound || result.removed) writeJsonAtomic(baselinePath, result.baseline);
    bound += result.bound;
    removed += result.removed;
    unresolved.push(...result.unresolved.map(name => `${state.province}:${name}`));
  }
  return { bound, removed, unresolved };
}

module.exports = {
  activeBatch,
  activeBatchPath,
  batchesDir,
  createBatch,
  applyCoverageToState,
  filterReviewedPackage,
  parseSelection,
  persistBatchResolutions,
  printObservationPool,
  readJson,
  reconcileBatch,
  scanObservationPool,
  applyResolutionsToBaseline,
  updateBatch,
  writeJsonAtomic,
};
