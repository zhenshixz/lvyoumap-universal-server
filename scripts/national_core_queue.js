const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { runCoreDraftPipeline } = require('./core_draft_pipeline');

const rootDir = path.join(__dirname, '..');
const contentDir = path.join(rootDir, 'content');
const runtimeDir = path.join(rootDir, '.runtime');
const statePath = path.join(runtimeDir, 'national-core-queue.json');
const excluded = new Set(['香港', '澳门', '台湾']);
const args = new Map(process.argv.slice(2).map(arg => {
  const match = arg.match(/^--([^=]+)=(.*)$/);
  return match ? [match[1], match[2]] : [arg.replace(/^--/, ''), true];
}));
const selectedProvinces = new Set(String(args.get('provinces') || '').split(',').map(item => item.trim()).filter(Boolean));

function selected(entry) {
  return !selectedProvinces.size || selectedProvinces.has(entry.province);
}

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

function approvedProvinces() {
  const result = new Set();
  for (const name of fs.readdirSync(contentDir).filter(item => /^core-attractions\.[a-z0-9_-]+\.json$/i.test(item))) {
    const baseline = readJson(path.join(contentDir, name));
    if (baseline.province) result.add(baseline.province);
  }
  return result;
}

function finalDraftReady(slug) {
  const draft = readJson(path.join(runtimeDir, `core-attractions.${slug}.draft.json`), null);
  return Boolean(
    draft
    && draft.baselineStatus === 'multi_source_ready'
    && draft.qualityGate?.passed
    && draft.qualityGate?.secondaryEvidenceComplete !== false
  );
}

function initializeState() {
  const db = readJson(path.join(contentDir, 'db.json'), { provinces: {} });
  const approved = approvedProvinces();
  const previous = readJson(statePath, { provinces: {} });
  const provinces = {};
  for (const [province, data] of Object.entries(db.provinces || {})) {
    const slug = data.id || province;
    const regionPolicy = excluded.has(province) ? 'separate_region_policy' : 'mainland_multi_source';
    const old = previous.provinces?.[province] || {};
    const officialReady = fs.existsSync(path.join(runtimeDir, `core-official-${slug}.json`));
    const otaReady = fs.existsSync(path.join(runtimeDir, `core-ota-${slug}.json`));
    const staleStaticError = ['official_collection_failed', 'ota_collection_failed'].includes(old.lastError) && officialReady && otaReady;
    provinces[province] = {
      province,
      slug,
      regionPolicy,
      recordCount: (data.attractions || []).length,
      approved: approved.has(province),
      officialReady,
      otaReady,
      xhsReady: fs.existsSync(path.join(runtimeDir, `core-popularity-${slug}.json`)),
      secondaryReady: fs.existsSync(path.join(runtimeDir, `core-secondary-evidence-${slug}.json`)),
      draftReady: finalDraftReady(slug),
      lastError: staleStaticError ? '' : (old.lastError || ''),
      updatedAt: old.updatedAt || '',
    };
  }
  const state = {
    version: 1,
    updatedAt: new Date().toISOString(),
    policy: '大陆省级地区使用文旅部+高德+携程+小红书多源规则；港澳台单独建模；队列只生成草稿，不自动批准清单或写入景点。',
    provinces,
  };
  writeJsonAtomic(statePath, state);
  return state;
}

function runNode(script, province, extraArgs = []) {
  const result = spawnSync(process.execPath, [path.join('scripts', script), `--province=${province}`, ...extraArgs], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: false,
  });
  return result.status === 0;
}

function refreshEntry(entry) {
  entry.approved = approvedProvinces().has(entry.province);
  entry.officialReady = fs.existsSync(path.join(runtimeDir, `core-official-${entry.slug}.json`));
  entry.otaReady = fs.existsSync(path.join(runtimeDir, `core-ota-${entry.slug}.json`));
  entry.xhsReady = fs.existsSync(path.join(runtimeDir, `core-popularity-${entry.slug}.json`));
  entry.secondaryReady = fs.existsSync(path.join(runtimeDir, `core-secondary-evidence-${entry.slug}.json`));
  entry.draftReady = finalDraftReady(entry.slug);
  entry.updatedAt = new Date().toISOString();
}

function save(state) {
  state.updatedAt = new Date().toISOString();
  writeJsonAtomic(statePath, state);
}

function collectStatic(state) {
  const limit = Math.max(0, Number(args.get('limit') || 0));
  let processed = 0;
  for (const entry of Object.values(state.provinces)) {
    if (!selected(entry) || entry.regionPolicy !== 'mainland_multi_source' || entry.approved) continue;
    if (limit && processed >= limit) break;
    console.log(`\n========== ${entry.province}：官方与OTA ========== `);
    entry.lastError = '';
    if (!entry.officialReady && !runNode('collect_mct_core_candidates.js', entry.province)) {
      entry.lastError = 'official_collection_failed';
      refreshEntry(entry);
      save(state);
      continue;
    }
    if (!entry.otaReady && !runNode('collect_ota_core_candidates.js', entry.province)) {
      entry.lastError = 'ota_collection_failed';
      refreshEntry(entry);
      save(state);
      continue;
    }
    refreshEntry(entry);
    save(state);
    processed += 1;
  }
  console.log(`\n静态来源批次完成：本次处理 ${processed} 个省级地区。`);
}

function collectXhs(state) {
  const limit = Math.max(0, Number(args.get('limit') || 0));
  let processed = 0;
  for (const entry of Object.values(state.provinces)) {
    if (!selected(entry) || entry.regionPolicy !== 'mainland_multi_source' || entry.approved) continue;
    if (!entry.officialReady || !entry.otaReady || entry.xhsReady) continue;
    if (limit && processed >= limit) break;
    console.log(`\n========== ${entry.province}：小红书口碑候选 ========== `);
    entry.lastError = runNode('xhs_core_candidates.js', entry.province) ? '' : 'xhs_collection_failed';
    refreshEntry(entry);
    save(state);
    if (entry.lastError) {
      console.log('口碑采集失败或受限，本批次在安全点停止；下次可从当前省份继续。');
      break;
    }
    // 先生成首轮草稿以暴露单源候选，再定向补证并重建最终草稿。
    const pipeline = runCoreDraftPipeline({ province: entry.province, slug: entry.slug, quiet: false });
    if (!pipeline.ok) {
      entry.lastError = 'draft_build_failed';
      save(state);
      break;
    }
    refreshEntry(entry);
    save(state);
    processed += 1;
  }
  console.log(`\n口碑与草稿批次完成：本次处理 ${processed} 个省级地区。`);
}

function buildReadyDrafts(state) {
  let built = 0;
  for (const entry of Object.values(state.provinces)) {
    if (!selected(entry) || entry.regionPolicy !== 'mainland_multi_source' || entry.approved) continue;
    if (!entry.officialReady || !entry.otaReady || !entry.xhsReady) continue;
    if (entry.draftReady && entry.secondaryReady) continue;
    console.log(`\n========== ${entry.province}：生成多源草稿 ========== `);
    const pipeline = runCoreDraftPipeline({ province: entry.province, slug: entry.slug, quiet: false });
    const ready = pipeline.ok;
    entry.lastError = ready ? '' : 'draft_build_failed';
    refreshEntry(entry);
    save(state);
    if (entry.draftReady) built += 1;
  }
  console.log(`\n草稿生成完成：本次新增 ${built} 份。`);
}

function reviewDrafts(state) {
  const rows = Object.values(state.provinces).filter(entry => (
    selected(entry)
    && !entry.approved
    && fs.existsSync(path.join(runtimeDir, `core-attractions.${entry.slug}.draft.json`))
  ));
  if (!rows.length) {
    console.log('当前选择中没有可复核的多源草稿。');
    return 0;
  }
  console.log('\n---------------- 多源核心清单草稿 ----------------');
  for (const entry of rows) {
    const draft = readJson(path.join(runtimeDir, `core-attractions.${entry.slug}.draft.json`), {});
    console.log(`\n【${entry.province}】`);
    console.log(`  核心景点：${draft.attractions?.length || 0} 个`);
    console.log(`  已有完整记录可绑定：${draft.existingRecordBoundCount || 0} 个`);
    console.log(`  需要后续补全资料：${draft.existingRecordUnboundCount || 0} 个`);
    console.log(`  二次补证后仍待人工：${draft.reviewCandidateCount || 0} 个`);
    console.log(`  质量门禁：${draft.qualityGate?.passed ? '通过' : '未通过'}`);
    console.log('  说明：这里只确认核心名单；基本信息、攻略和图片将在下一阶段补全。');
    const cityGroups = new Map();
    for (const item of draft.attractions || []) {
      const city = item.city || '城市待核验';
      if (!cityGroups.has(city)) cityGroups.set(city, []);
      cityGroups.get(city).push(item.name);
    }
    console.log('  按城市查看：');
    for (const [city, names] of cityGroups) {
      console.log(`    ${city}（${names.length}）`);
      for (let index = 0; index < names.length; index += 3) {
        console.log(`      ${names.slice(index, index + 3).join('　')}`);
      }
    }
    if (draft.existingRecordUnboundNames?.length) {
      console.log('  下一阶段需要补全完整资料：');
      draft.existingRecordUnboundNames.forEach(name => console.log(`    - ${name}`));
    }
    if (draft.qualityGate?.filteredTemporaryOtaCandidates?.length) {
      console.log(`  已过滤临时活动：${draft.qualityGate.filteredTemporaryOtaCandidates.length} 个（技术明细已写入草稿）`);
    }
    if (draft.reviewCandidates?.length) {
      console.log('  二次补证后仍待人工（不会写入核心清单）：');
      for (const item of draft.reviewCandidates) {
        console.log(`    - ${item.name}${item.city ? `（${item.city}）` : ''}`);
      }
    }
  }
  console.log('----------------------------------------------------');
  return rows.length;
}

function approveDrafts(state) {
  let approved = 0;
  for (const entry of Object.values(state.provinces)) {
    if (!selected(entry) || entry.approved || !entry.draftReady) continue;
    const draftPath = path.join(runtimeDir, `core-attractions.${entry.slug}.draft.json`);
    const draft = readJson(draftPath, {});
    if (draft.baselineStatus !== 'multi_source_ready' || !draft.qualityGate?.passed) {
      console.log(`跳过 ${entry.province}：多源材料不完整或质量门禁未通过。`);
      continue;
    }
    const targetPath = path.join(contentDir, `core-attractions.${entry.slug}.json`);
    if (fs.existsSync(targetPath)) continue;
    fs.copyFileSync(draftPath, targetPath);
    entry.approved = true;
    entry.updatedAt = new Date().toISOString();
    approved += 1;
    console.log(`已批准 ${entry.province} 核心清单：${targetPath}`);
  }
  save(state);
  console.log(`本次批准 ${approved} 份省级核心清单。`);
}

function summary(state) {
  const rows = Object.values(state.provinces);
  const mainland = rows.filter(item => item.regionPolicy === 'mainland_multi_source');
  const pending = mainland.filter(item => !item.approved && selected(item));
  const counts = {
    total: rows.length,
    mainland: mainland.length,
    approved: mainland.filter(item => item.approved).length,
    remainingMainland: pending.length,
    officialReady: pending.filter(item => item.officialReady).length,
    otaReady: pending.filter(item => item.otaReady).length,
    xhsReady: pending.filter(item => item.xhsReady).length,
    secondaryReady: pending.filter(item => item.secondaryReady).length,
    draftReady: pending.filter(item => item.draftReady).length,
    errors: pending.filter(item => item.lastError).length,
    separateRegions: rows.filter(item => item.regionPolicy === 'separate_region_policy').map(item => item.province),
  };
  const nextForXhs = pending.filter(item => item.officialReady && item.otaReady && !item.xhsReady).slice(0, 5).map(item => item.province);
  const errors = pending.filter(item => item.lastError).map(item => ({ province: item.province, error: item.lastError }));
  if (args.has('json')) {
    console.log(JSON.stringify({ updatedAt: state.updatedAt, counts, nextForXhs, errors }, null, 2));
    return;
  }
  console.log('\n---------------- 队列概览 ----------------');
  console.log(`大陆省级地区：${counts.mainland} 个　已批准：${counts.approved} 个　当前范围待处理：${counts.remainingMainland} 个`);
  console.log(`静态来源就绪：${Math.min(counts.officialReady, counts.otaReady)} 个　口碑候选就绪：${counts.xhsReady} 个　二次补证就绪：${counts.secondaryReady} 个　可复核草稿：${counts.draftReady} 个`);
  if (nextForXhs.length) console.log(`下一批待口碑采集：${nextForXhs.join('、')}`);
  if (errors.length) console.log(`需要处理的失败项：${errors.map(item => item.province).join('、')}`);
  console.log('--------------------------------------------');
}

function main() {
  const state = initializeState();
  if (args.has('collect-static')) collectStatic(state);
  if (args.has('collect-xhs')) collectXhs(state);
  if (args.has('build-drafts')) buildReadyDrafts(state);
  if (args.has('review')) reviewDrafts(state);
  if (args.has('approve-drafts')) approveDrafts(state);
  summary(initializeState());
  if (args.has('json')) console.log(`队列文件：${statePath}`);
}

try {
  main();
} catch (error) {
  console.error(`全国核心队列失败：${error.message}`);
  process.exitCode = 1;
}
