const fs = require('fs');
const path = require('path');
const { evaluateGalleryPurity, isContaminatedImage } = require('./gallery_content_guard');

const root = path.resolve(__dirname, '..');
const runtime = path.join(root, '.runtime', 'attraction-gallery-batch');
const statePath = path.join(runtime, 'state.json');
const milestonePath = path.join(runtime, 'remaining-milestones.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

async function main() {
  console.log('==================================================');
  console.log('  【全局景点图库】全量体系化内容过筛与整组熔断启动');
  console.log('==================================================');

  const state = readJson(statePath);
  const milestone = readJson(milestonePath);
  const fixedIds = new Set(milestone.ids || []);

  let inspectedCount = 0;
  let passedPureCount = 0;
  let circuitBrokenCount = 0;
  const circuitBrokenList = [];

  for (const item of state.items) {
    if (item.status !== 'ready_for_user_review' && item.status !== 'ready_for_visual_review') continue;
    inspectedCount++;

    const check = evaluateGalleryPurity(item.selected || item.qualified, item.name);
    if (check.isContaminated) {
      circuitBrokenCount++;
      circuitBrokenList.push({
        name: `${item.province}·${item.name}`,
        id: item.id,
        reason: check.reason,
        badUrl: check.badUrl
      });

      // 铁律：整组熔断清零，绝不搞残留侥幸！
      item.selected = [];
      item.qualified = [];
      item.qualifiedCount = 0;
      item.status = 'pending_sources';
      item.updatedAt = new Date().toISOString();
      item.circuitBrokenReason = check.reason;
    } else {
      passedPureCount++;
    }
  }

  // 从 milestone.attempted 中移除被熔断重置的景点，允许重新流水线采集
  if (circuitBrokenList.length > 0) {
    const brokenSet = new Set(circuitBrokenList.map(x => x.id));
    milestone.attempted = (milestone.attempted || []).filter(id => !brokenSet.has(id));
    writeJson(milestonePath, milestone);
  }

  writeJson(statePath, state);

  console.log(`\n🔍 全量过筛待审景点：${inspectedCount} 个`);
  console.log(`✅ 100% 纯净景观建筑达标：${passedPureCount} 个`);
  console.log(`⛔ 触发【整组熔断清退】景点：${circuitBrokenCount} 个\n`);

  if (circuitBrokenList.length > 0) {
    console.log('--- 熔断清退景点明细 ---');
    circuitBrokenList.forEach((x, idx) => {
      console.log(` [${idx + 1}] ${x.name}: ${x.reason}`);
    });
    console.log('-------------------------\n');
  }

  // 立即刷新沙箱多图数据与预览页面
  console.log('[Sync & Refresh] Refreshing preview site and sync provinces data...');
  const { execSync } = require('child_process');
  execSync(`node "${path.join(root, 'scripts', 'deliver_gallery_periodic_batch.js')}"`, {
    cwd: root,
    windowsHide: true,
    stdio: 'inherit'
  });
}

main().catch(err => {
  console.error('[Circuit Break Error]', err);
  process.exitCode = 1;
});
