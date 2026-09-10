const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

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

// 非景点自然建筑实景特征识别正则
const BAD_IMAGE_REGEX = /餐厅|咖啡|客房|酒店房间|客栈内部|美食|菜品|饮品|自拍|人像|会议|体验|道具|手办|公仔|玩具|放大镜|1A0t1g000001gvzt8BB11|1mi6f12000s9od5dz6853|1mi5712000s9oddhu319F|1mi5e12000s9od7tw48A2|1mi1a12000qnfjpjxD60B/i;

function isBadImage(img, attractionName) {
  if (!img || !img.url) return false;
  if (BAD_IMAGE_REGEX.test(img.url) || BAD_IMAGE_REGEX.test(img.caption || '')) return true;
  // 针对特定已知问题的图片哈希或URL精准阻断
  const badUrls = [
    'https://dimg04.c-ctrip.com/images/1A0t1g000001gvzt8BB11.jpg', // 上李水库恐龙放大镜
    'https://dimg04.c-ctrip.com/images/1mi6f12000s9od5dz6853.jpg', // 石板岩餐厅
    'https://dimg04.c-ctrip.com/images/1mi5712000s9oddhu319F.jpg', // 石板岩客房
    'https://dimg04.c-ctrip.com/images/1mi5e12000s9od7tw48A2.jpg', // 石板岩阳台
    'https://dimg04.c-ctrip.com/images/1mi1a12000qnfjpjxD60B.webp', // 丽江植物园花车
  ];
  if (badUrls.includes(img.url)) return true;
  return false;
}

async function main() {
  console.log('[Purge UGC] Starting full scan to clean impure UGC images...');
  const state = readJson(statePath);
  const milestone = readJson(milestonePath);
  const fixedIds = new Set(milestone.ids || []);

  let purgedImagesCount = 0;
  let resetAttractionsCount = 0;
  let cleansedAttractionsCount = 0;
  const resetNames = [];

  for (const item of state.items) {
    const origSelected = item.selected || [];
    const origQualified = item.qualified || [];

    // 过滤杂质图
    const cleanSelected = origSelected.filter(img => {
      const bad = isBadImage(img, item.name);
      if (bad) purgedImagesCount++;
      return !bad;
    });
    const cleanQualified = origQualified.filter(img => !isBadImage(img, item.name));

    if (cleanSelected.length !== origSelected.length || cleanQualified.length !== origQualified.length) {
      item.selected = cleanSelected;
      item.qualified = cleanQualified;
      item.qualifiedCount = cleanQualified.length;

      // 评估是否仍达到 3-5 张门槛
      if (cleanSelected.length >= 3) {
        cleansedAttractionsCount++;
        console.log(`[Cleaned & Retained] ${item.province}·${item.name}: 剔除杂图后保留 ${cleanSelected.length} 张纯净实景`);
      } else {
        // 不足 3 张，重置状态回退到待补池
        item.status = 'pending_sources';
        item.updatedAt = new Date().toISOString();
        resetAttractionsCount++;
        resetNames.push(`${item.province}·${item.name}`);
        console.log(`[Reset to Pending] ${item.province}·${item.name}: 纯净图仅余 ${cleanSelected.length} 张，已回退至待补池重新采集`);
      }
    }
  }

  // 从 milestone.attempted 中移除被重置的景点 ID，让 runner 优先重跑
  if (resetNames.length > 0) {
    const resetIdSet = new Set(state.items.filter(x => resetNames.includes(`${x.province}·${x.name}`)).map(x => x.id));
    milestone.attempted = (milestone.attempted || []).filter(id => !resetIdSet.has(id));
    writeJson(milestonePath, milestone);
  }

  writeJson(statePath, state);

  console.log('==================================================');
  console.log(`  【全量杂图清洗与重跑复位完毕】`);
  console.log(`  🗑️ 剔除劣质 UGC 杂图：${purgedImagesCount} 张`);
  console.log(`  ✨ 净化并达标保留：${cleansedAttractionsCount} 个景点`);
  console.log(`  🔄 纯净图不足重置回退：${resetAttractionsCount} 个景点 (${resetNames.slice(0, 10).join(', ')}${resetNames.length > 10 ? '...' : ''})`);
  console.log('==================================================');

  // 1. 无损平滑重启后台跑批 runner，让其以全新源头解析器重跑
  console.log('[Runner Restart] Restarting runner with updated UGC-free pipeline...');
  try {
    const pids = execSync('powershell.exe -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like \'*run_gallery_remaining*\' } | Select-Object -ExpandProperty ProcessId"', { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    for (const pid of pids) {
      try { process.kill(parseInt(pid, 10)); } catch (e) {}
    }
  } catch (e) {}

  const newRunner = spawn(process.execPath, [path.join(root, 'scripts', 'run_gallery_remaining.js')], {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: 'ignore'
  });
  newRunner.unref();
  console.log(`[Runner Restart] New clean runner started with PID: ${newRunner.pid}`);

  // 2. 重新同步沙箱数据与预览
  console.log('[Preview Refresh] Refreshing preview site and province data...');
  execSync(`node "${path.join(root, 'scripts', 'deliver_gallery_periodic_batch.js')}"`, {
    cwd: root,
    windowsHide: true,
    stdio: 'inherit'
  });
}

main().catch(err => {
  console.error('[Purge Error]', err);
  process.exitCode = 1;
});
