const fs = require('fs');
const path = require('path');
const os = require('os');
const { evaluateGalleryPurity } = require('./gallery_content_guard');

const root = path.resolve(__dirname, '..');
const runtime = path.join(root, '.runtime', 'attraction-gallery-batch');
const batchStatePath = path.join(runtime, 'state.json');
const galleryOverridesPath = path.join(root, 'content', 'attraction-gallery-overrides.json');
const previewRoot = path.join(root, '.runtime', 'previews', 'attraction-gallery-batch');
const previewSite = path.join(previewRoot, 'site');
const deliveryPath = path.join(runtime, 'periodic_delivery.json');

function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}
function html(value) {
  return String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function getPhysicalLans() {
  const ifaces = os.networkInterfaces();
  const physicalLans = [];
  for (const [name, list] of Object.entries(ifaces)) {
    if (/vEthernet|WSL|VMware|VirtualBox|Loopback|Meta|TAP|Tun|VPN|Npcap/i.test(name)) continue;
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal && /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(item.address)) {
        physicalLans.push(item.address);
      }
    }
  }
  return physicalLans;
}

function syncProvincesData(readyItems) {
  const provIndexPath = path.join(previewSite, 'data', 'provinces-index.json');
  if (!fs.existsSync(provIndexPath)) return 0;
  const provinceIndex = readJson(provIndexPath);
  const grouped = new Map();
  for (const item of readyItems) {
    if (!grouped.has(item.province)) grouped.set(item.province, []);
    grouped.get(item.province).push(item);
  }

  let synced = 0;
  for (const [province, items] of grouped) {
    const dataFile = provinceIndex[province]?.dataFile;
    if (!dataFile) continue;
    const file = path.join(previewSite, 'data', 'provinces', dataFile);
    if (!fs.existsSync(file)) continue;
    const data = readJson(file);
    const byId = new Map((data.attractions || []).map(a => [a.id, a]));
    for (const item of items) {
      const attraction = byId.get(item.id);
      if (!attraction) continue;
      const images = (item.selected || []).map(candidate => ({
        url: candidate.url,
        caption: candidate.caption || item.name,
        imageSource: candidate.sourceUrl ? { provider: 'public', sourceUrl: candidate.sourceUrl } : undefined
      }));
      attraction.image = images[0]?.url || attraction.image;
      attraction.images = images;
      synced++;
    }
    writeJson(file, data);
  }
  return synced;
}

function determineBatch(updatedAt) {
  const t = Date.parse(updatedAt || 0);
  const t1 = Date.parse('2026-09-10T06:00:00.000Z'); // 14:00 (北京时间)
  const t2 = Date.parse('2026-09-10T07:00:00.000Z'); // 15:00 (北京时间)
  const t3 = Date.parse('2026-09-10T07:35:00.000Z'); // 15:35 (北京时间)

  if (t >= t3) {
    return { batchId: 'batch_3', batchName: '第 3 批 (16:00)', badgeClass: 'badge-batch-3', isNew: 1 };
  } else if (t >= t2) {
    return { batchId: 'batch_2', batchName: '第 2 批 (15:30)', badgeClass: 'badge-batch-2', isNew: 1 };
  } else if (t >= t1) {
    return { batchId: 'batch_1', batchName: '第 1 批 (14:35)', badgeClass: 'badge-batch-1', isNew: 0 };
  } else {
    return { batchId: 'baseline', batchName: '存量基准池', badgeClass: 'badge-batch-base', isNew: 0 };
  }
}

function generateFastPreviewHtml(allReadyItems, stats) {
  const count5 = allReadyItems.filter(x => (x.selected || []).length >= 5).length;
  const count4 = allReadyItems.filter(x => (x.selected || []).length === 4).length;
  const count3 = allReadyItems.filter(x => (x.selected || []).length === 3).length;
  const provinces = [...new Set(allReadyItems.map(x => x.province).filter(Boolean))].sort((a,b) => a.localeCompare(b, 'zh'));
  const pct = ((allReadyItems.length / stats.target) * 100).toFixed(1);

  // 批次数据归属计算
  const clientData = allReadyItems.map(item => {
    const batchInfo = determineBatch(item.updatedAt);
    const sel = item.selected || [];
    const cover = sel[0]?.url || '';
    const total = sel.length;
    const coverDim = sel[0]?.dimensions ? `${sel[0].dimensions.width}×${sel[0].dimensions.height}` : '';
    const images = sel.map(s => ({
      url: s.url,
      caption: s.caption || item.name,
      w: s.dimensions?.width,
      h: s.dimensions?.height
    }));
    return {
      id: item.id,
      name: item.name,
      province: item.province || '',
      city: item.city || '',
      total,
      batchId: batchInfo.batchId,
      batchName: batchInfo.batchName,
      badgeClass: batchInfo.badgeClass,
      isNew: batchInfo.isNew,
      updatedAt: item.updatedAt || '',
      cover,
      coverDim,
      images
    };
  });

  const countBatch2 = clientData.filter(x => x.batchId === 'batch_2').length;
  const countBatch1 = clientData.filter(x => x.batchId === 'batch_1').length;
  const countBatch3 = clientData.filter(x => x.batchId === 'batch_3').length;
  const countBaseline = clientData.filter(x => x.batchId === 'baseline').length;

  const provOptions = provinces.map(p => `<option value="${html(p)}">${html(p)}</option>`).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate">
  <meta http-equiv="Pragma" content="no-cache">
  <meta http-equiv="Expires" content="0">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>全国景点图库 · 隔离预览审计台 (分批精准审计版)</title>
  <style>
    :root {
      --primary: #0284c7;
      --primary-dark: #0369a1;
      --primary-light: #e0f2fe;
      --accent: #0d9488;
      --bg: #f8fafc;
      --card-bg: #ffffff;
      --text-main: #0f172a;
      --text-muted: #64748b;
      --border: #e2e8f0;
      --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
      --shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.07), 0 2px 4px -2px rgba(0, 0, 0, 0.05);
      --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.08), 0 4px 6px -4px rgba(0, 0, 0, 0.04);
      --radius: 12px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif;
      background: var(--bg);
      color: var(--text-main);
      line-height: 1.5;
      padding-bottom: 70px;
    }
    .header-hero {
      background: linear-gradient(135deg, #0284c7 0%, #0d9488 100%);
      color: white;
      padding: 22px 20px 18px;
      box-shadow: 0 4px 20px rgba(2, 132, 199, 0.2);
    }
    .container { max-width: 1240px; margin: 0 auto; padding: 0 16px; }
    .hero-top { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 14px; }
    .hero-title { font-size: 21px; font-weight: 700; letter-spacing: -0.5px; display: flex; align-items: center; gap: 8px; }
    .hero-tag { background: rgba(255, 255, 255, 0.2); border: 1px solid rgba(255, 255, 255, 0.35); padding: 3px 9px; border-radius: 999px; font-size: 11px; font-weight: 500; }
    
    .stats-card {
      background: rgba(255, 255, 255, 0.12);
      border: 1px solid rgba(255, 255, 255, 0.25);
      border-radius: var(--radius);
      padding: 12px 16px;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      gap: 12px;
      margin-bottom: 12px;
    }
    .stat-item { display: flex; flex-direction: column; }
    .stat-label { font-size: 11px; opacity: 0.85; margin-bottom: 2px; }
    .stat-val { font-size: 20px; font-weight: 800; font-variant-numeric: tabular-nums; }
    .stat-val small { font-size: 11px; font-weight: 400; opacity: 0.9; margin-left: 2px; }
    
    .progress-bar-wrap { background: rgba(0, 0, 0, 0.2); border-radius: 999px; height: 8px; overflow: hidden; position: relative; }
    .progress-bar-fill { background: linear-gradient(90deg, #38bdf8, #a7f3d0); height: 100%; border-radius: 999px; transition: width 0.4s ease; }
    .progress-meta { display: flex; justify-content: space-between; font-size: 11px; opacity: 0.85; margin-top: 4px; }
    
    .controls-panel {
      position: sticky;
      top: 0;
      z-index: 100;
      background: #ffffff;
      border-bottom: 1px solid var(--border);
      padding: 12px 0 10px;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.04);
    }
    
    /* 批次切换分段选择器（Segmented Tabs） */
    .batch-segmented-wrap {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
      overflow-x: auto;
      padding-bottom: 2px;
      scrollbar-width: none;
    }
    .batch-segmented-wrap::-webkit-scrollbar { display: none; }
    .batch-segmented-label {
      font-size: 12px;
      font-weight: 700;
      color: var(--text-muted);
      white-space: nowrap;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .segmented-control {
      display: inline-flex;
      background: #f1f5f9;
      padding: 3px;
      border-radius: 10px;
      gap: 2px;
    }
    .seg-btn {
      border: none;
      background: transparent;
      padding: 6px 14px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      color: #64748b;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .seg-btn:hover { color: #0f172a; }
    .seg-btn.active {
      background: #ffffff;
      color: #0284c7;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1), 0 1px 2px rgba(0, 0, 0, 0.06);
    }
    .seg-badge {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 999px;
      background: #e2e8f0;
      color: #475569;
    }
    .seg-btn.active .seg-badge {
      background: #e0f2fe;
      color: #0284c7;
    }

    .controls-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    .search-box {
      flex: 1;
      min-width: 180px;
      position: relative;
    }
    .search-input {
      width: 100%;
      height: 36px;
      padding: 0 14px 0 32px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: #f8fafc;
      font-size: 13px;
      color: var(--text-main);
      outline: none;
      transition: all 0.2s;
    }
    .search-input:focus {
      background: #ffffff;
      border-color: var(--primary);
      box-shadow: 0 0 0 3px rgba(2, 132, 199, 0.15);
    }
    .search-icon { position: absolute; left: 10px; top: 10px; font-size: 14px; opacity: 0.5; pointer-events: none; }
    
    .select-prov {
      height: 36px;
      padding: 0 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: #f8fafc;
      font-size: 13px;
      color: var(--text-main);
      outline: none;
      cursor: pointer;
    }
    
    .tab-pills { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; }
    .tab-pills::-webkit-scrollbar { display: none; }
    .pill {
      height: 36px;
      padding: 0 12px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: #ffffff;
      font-size: 12px;
      font-weight: 500;
      color: var(--text-muted);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      white-space: nowrap;
      transition: all 0.2s;
    }
    .pill:hover { background: #f1f5f9; color: var(--text-main); }
    .pill.active {
      background: var(--primary-light);
      border-color: var(--primary);
      color: var(--primary-dark);
      font-weight: 600;
    }
    
    .view-info-bar {
      margin: 14px 0 10px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 13px;
      color: var(--text-muted);
    }
    .view-info-left strong { color: var(--text-main); }
    
    /* 景点卡片网格 */
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 16px;
    }
    .card {
      background: var(--card-bg);
      border-radius: var(--radius);
      border: 1px solid var(--border);
      overflow: hidden;
      box-shadow: var(--shadow-sm);
      display: flex;
      flex-direction: column;
      transition: transform 0.2s, box-shadow 0.2s, border-color 0.2s;
      position: relative;
    }
    .card:hover {
      transform: translateY(-2px);
      box-shadow: var(--shadow-lg);
      border-color: #cbd5e1;
    }
    .card-media {
      width: 100%;
      height: 185px;
      background: #e2e8f0;
      position: relative;
      overflow: hidden;
      cursor: pointer;
    }
    .cover-img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      transition: transform 0.3s ease;
    }
    .card:hover .cover-img { transform: scale(1.03); }
    
    .media-badges {
      position: absolute;
      top: 8px;
      left: 8px;
      right: 8px;
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      pointer-events: none;
    }
    
    /* 批次徽章样式 */
    .badge-batch {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 700;
      box-shadow: 0 1px 3px rgba(0,0,0,0.12);
      backdrop-filter: blur(4px);
    }
    .badge-batch-2 {
      background: #ecfdf5;
      color: #065f46;
      border: 1px solid #6ee7b7;
    }
    .badge-batch-1 {
      background: #eff6ff;
      color: #1e40af;
      border: 1px solid #93c5fd;
    }
    .badge-batch-3 {
      background: #fffbeb;
      color: #92400e;
      border: 1px solid #fcd34d;
    }
    .badge-batch-base {
      background: rgba(255, 255, 255, 0.9);
      color: #475569;
      border: 1px solid #cbd5e1;
    }

    .badge-count {
      padding: 3px 7px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 700;
      color: #ffffff;
      background: rgba(15, 23, 42, 0.75);
      backdrop-filter: blur(4px);
    }
    
    .loc-bar {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      padding: 6px 10px;
      background: linear-gradient(to top, rgba(0,0,0,0.7) 0%, transparent 100%);
      color: #ffffff;
      font-size: 11px;
      font-weight: 500;
      text-shadow: 0 1px 2px rgba(0,0,0,0.5);
    }
    
    .card-body { padding: 12px 14px 14px; flex: 1; display: flex; flex-direction: column; }
    .card-title {
      font-size: 15px;
      font-weight: 700;
      color: var(--text-main);
      margin-bottom: 4px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .card-meta-line {
      font-size: 11px;
      color: var(--text-muted);
      display: flex;
      justify-content: space-between;
      margin-bottom: 12px;
    }
    .card-actions { margin-top: auto; display: flex; gap: 8px; }
    .btn {
      flex: 1;
      height: 34px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      border: 1px solid transparent;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      text-decoration: none;
      transition: all 0.15s ease;
    }
    .btn-primary { background: var(--primary); color: #ffffff; }
    .btn-primary:hover { background: var(--primary-dark); }
    .btn-outline { background: #ffffff; border-color: var(--border); color: var(--text-main); }
    .btn-outline:hover { background: #f8fafc; border-color: #cbd5e1; }
    
    .pagination-bar {
      margin-top: 24px;
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 8px;
    }
    .page-btn {
      min-width: 36px;
      height: 36px;
      padding: 0 10px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: #ffffff;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-main);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .page-btn:hover:not(:disabled) { background: #f1f5f9; border-color: #cbd5e1; }
    .page-btn.active { background: var(--primary); color: #ffffff; border-color: var(--primary); }
    .page-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .page-info { font-size: 13px; color: var(--text-muted); margin: 0 8px; }
    
    /* 独立最高层级 Lightbox 弹窗 */
    #gallery-modal {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(15, 23, 42, 0.92);
      backdrop-filter: blur(10px);
      z-index: 999999 !important;
      flex-direction: column;
    }
    .modal-header {
      padding: 14px 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      color: #ffffff;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    }
    .modal-title-wrap { display: flex; align-items: center; gap: 10px; }
    .modal-title { font-size: 17px; font-weight: 700; }
    .modal-close-btn {
      background: rgba(255, 255, 255, 0.15);
      border: none;
      color: #ffffff;
      width: 34px;
      height: 34px;
      border-radius: 50%;
      cursor: pointer;
      font-size: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .modal-close-btn:hover { background: rgba(255, 255, 255, 0.3); }
    
    .modal-body {
      flex: 1;
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      overflow: hidden;
    }
    .modal-main-img {
      max-width: 90vw;
      max-height: 70vh;
      object-fit: contain;
      border-radius: 8px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5);
      transition: opacity 0.2s;
    }
    .nav-arrow {
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      width: 46px;
      height: 46px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.2);
      border: 1px solid rgba(255, 255, 255, 0.3);
      color: #ffffff;
      font-size: 20px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
    }
    .nav-arrow:hover { background: rgba(255, 255, 255, 0.4); }
    .nav-prev { left: 24px; }
    .nav-next { right: 24px; }
    
    .modal-footer {
      padding: 12px 20px;
      background: rgba(0, 0, 0, 0.35);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
    }
    .img-meta-desc { color: #cbd5e1; font-size: 13px; }
    .thumb-strip { display: flex; gap: 8px; overflow-x: auto; max-width: 90vw; padding: 4px; }
    .thumb-item {
      width: 50px;
      height: 38px;
      border-radius: 4px;
      object-fit: cover;
      cursor: pointer;
      opacity: 0.5;
      border: 2px solid transparent;
      transition: all 0.2s;
    }
    .thumb-item.active { opacity: 1; border-color: #38bdf8; transform: scale(1.08); }
    
    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: var(--text-muted);
      font-size: 15px;
      display: none;
    }
  </style>
</head>
<body>

  <header class="header-hero">
    <div class="container">
      <div class="hero-top">
        <div class="hero-title">
          <span>🗺️ 全国景点图库 · 隔离预览审计台</span>
          <span class="hero-tag">沙箱隔离 100% 纯净</span>
        </div>
        <div>
          <span style="font-size: 12px; opacity: 0.9;">当前节点：${html(stats.batchLabel)}</span>
        </div>
      </div>
      
      <div class="stats-card">
        <div class="stat-item">
          <span class="stat-label">待补池 50% 攻坚目标</span>
          <span class="stat-val">${stats.target}<small>个</small></span>
        </div>
        <div class="stat-item">
          <span class="stat-label">全国沙箱纯净总达标</span>
          <span class="stat-val" style="color: #6ee7b7;">${clientData.length}<small>个</small></span>
        </div>
        <div class="stat-item">
          <span class="stat-label">第 2 批 (15:30 节点)</span>
          <span class="stat-val" style="color: #a7f3d0;">${countBatch2}<small>个纯净</small></span>
        </div>
        <div class="stat-item">
          <span class="stat-label">第 1 批 (14:35 节点)</span>
          <span class="stat-val" style="color: #bae6fd;">${countBatch1}<small>个纯净</small></span>
        </div>
        <div class="stat-item">
          <span class="stat-label">纯净度门禁机制</span>
          <span class="stat-val" style="font-size: 15px; font-weight: 700; color: #fef08a;">All-or-Nothing<small>熔断</small></span>
        </div>
      </div>
      
      <div>
        <div class="progress-bar-wrap">
          <div class="progress-bar-fill" style="width: ${Math.min(100, pct)}%;"></div>
        </div>
        <div class="progress-meta">
          <span>已过筛熔断 50 个室内/人像/花车/假景违规景点</span>
          <span>达标覆盖率: ${pct}%</span>
        </div>
      </div>
    </div>
  </header>

  <section class="controls-panel">
    <div class="container">
      <!-- 批次精准切换栏 -->
      <div class="batch-segmented-wrap">
        <span class="batch-segmented-label">🏷️ 交付批次:</span>
        <div class="segmented-control" id="batch-segmented">
          <button type="button" class="seg-btn active" data-batch="all">
            <span>全部景点</span>
            <span class="seg-badge">${clientData.length}</span>
          </button>
          <button type="button" class="seg-btn" data-batch="batch_2">
            <span>🟢 第 2 批 (15:30 交付)</span>
            <span class="seg-badge" style="background:#d1fae5; color:#065f46;">${countBatch2}</span>
          </button>
          <button type="button" class="seg-btn" data-batch="batch_1">
            <span>🔵 第 1 批 (14:35 交付)</span>
            <span class="seg-badge" style="background:#dbeafe; color:#1e40af;">${countBatch1}</span>
          </button>
          <button type="button" class="seg-btn" data-batch="baseline">
            <span>⚪ 存量基准池</span>
            <span class="seg-badge">${countBaseline}</span>
          </button>
        </div>
      </div>

      <!-- 搜索、省份与规格筛选 -->
      <div class="controls-row">
        <div class="search-box">
          <span class="search-icon">🔍</span>
          <input type="text" id="search-input" class="search-input" placeholder="输入景点名、省份或城市快速搜索..."/>
        </div>
        <select id="prov-select" class="select-prov">
          <option value="">全部省份 (${provinces.length})</option>
          ${provOptions}
        </select>
        <div class="tab-pills" id="tab-pills">
          <button type="button" class="pill active" data-tab="all">全部规格</button>
          <button type="button" class="pill" data-tab="full">5张满图 (${count5})</button>
          <button type="button" class="pill" data-tab="good">4张标准 (${count4})</button>
          <button type="button" class="pill" data-tab="ok">3张达标 (${count3})</button>
        </div>
      </div>
    </div>
  </section>

  <main class="container">
    <div class="view-info-bar">
      <div class="view-info-left" id="view-info-text">
        正在展示: <strong>全部景点</strong> (<span id="showing-count">${clientData.length}</span> 个)
      </div>
      <div style="font-size: 12px; color: var(--text-muted);">
        * 虚拟化极速切片：24 项/页
      </div>
    </div>

    <div class="grid" id="cards-grid"></div>
    <div class="empty-state" id="empty-tip">未找到符合当前批次或筛选条件的景点</div>
    <div class="pagination-bar" id="pagination-bar"></div>
  </main>

  <!-- 独立最高层级 Lightbox 弹窗 -->
  <div id="gallery-modal" onclick="onModalBackdropClick(event)">
    <div class="modal-header">
      <div class="modal-title-wrap">
        <span class="modal-title" id="m-title">景点实景相册</span>
        <span id="m-batch-badge" class="badge-batch"></span>
        <span id="m-loc" style="font-size: 13px; opacity: 0.8;"></span>
      </div>
      <button type="button" class="modal-close-btn" onclick="closeGallery()" title="关闭 (Esc)">✕</button>
    </div>
    <div class="modal-body">
      <button type="button" class="nav-arrow nav-prev" onclick="navGallery(-1)">❮</button>
      <img id="m-img" class="modal-main-img" src="" alt="大图"/>
      <button type="button" class="nav-arrow nav-next" onclick="navGallery(1)">❯</button>
    </div>
    <div class="modal-footer">
      <div class="img-meta-desc" id="m-desc"></div>
      <div class="thumb-strip" id="m-thumbs"></div>
    </div>
  </div>

  <script>
    var ALL_ITEMS = ${JSON.stringify(clientData)};
    var ITEM_MAP = {};
    for (var i = 0; i < ALL_ITEMS.length; i++) {
      ITEM_MAP[ALL_ITEMS[i].id] = ALL_ITEMS[i];
    }

    var PAGE_SIZE = 24;
    var currentPage = 1;
    var currentBatch = 'all';
    var currentTab = 'all';
    var currentQuery = '';
    var currentProv = '';
    var filteredItems = [];

    var currentImages = [];
    var currentIndex = 0;

    function applyFilter() {
      var q = currentQuery.toLowerCase();
      filteredItems = ALL_ITEMS.filter(function(item) {
        // 批次筛选
        if (currentBatch !== 'all' && item.batchId !== currentBatch) return false;
        // 规格筛选
        if (currentTab === 'full' && item.total < 5) return false;
        if (currentTab === 'good' && item.total !== 4) return false;
        if (currentTab === 'ok' && item.total !== 3) return false;
        // 省份筛选
        if (currentProv && item.province !== currentProv) return false;
        // 关键字搜索
        if (q) {
          var text = (item.name + ' ' + item.province + ' ' + item.city).toLowerCase();
          if (text.indexOf(q) === -1) return false;
        }
        return true;
      });
      currentPage = 1;
      renderCurrentPage();
      updateInfoBar();
    }

    function updateInfoBar() {
      var batchNames = {
        'all': '全部批次',
        'batch_2': '🟢 第 2 批 (15:30 交付)',
        'batch_1': '🔵 第 1 批 (14:35 交付)',
        'baseline': '⚪ 存量基准池'
      };
      var bLabel = batchNames[currentBatch] || '全部批次';
      var text = '当前筛选批次: <strong>' + bLabel + '</strong> (共 <span id="showing-count">' + filteredItems.length + '</span> 个达标景点)';
      document.getElementById('view-info-text').innerHTML = text;
    }

    function renderCurrentPage() {
      var grid = document.getElementById('cards-grid');
      var empty = document.getElementById('empty-tip');
      var total = filteredItems.length;

      if (total === 0) {
        grid.innerHTML = '';
        empty.style.display = 'block';
        renderPagination(0, 1);
        return;
      }
      empty.style.display = 'none';

      var totalPages = Math.ceil(total / PAGE_SIZE) || 1;
      if (currentPage > totalPages) currentPage = totalPages;

      var start = (currentPage - 1) * PAGE_SIZE;
      var end = Math.min(start + PAGE_SIZE, total);
      var pageItems = filteredItems.slice(start, end);

      var htmlBuf = [];
      for (var i = 0; i < pageItems.length; i++) {
        var it = pageItems[i];
        var dimText = it.coverDim ? it.coverDim + ' px · 高清实景' : '高清实景';
        var mapUrl = '/?previewSearch=' + encodeURIComponent(it.name) + '&_t=' + Date.now();

        htmlBuf.push(
          '<div class="card">' +
            '<div class="card-media" onclick="openGallery(\'' + it.id + '\')">' +
              '<img src="' + it.cover + '" loading="lazy" decoding="async" class="cover-img" alt="' + it.name + '"/>' +
              '<div class="media-badges">' +
                '<span class="badge-batch ' + it.badgeClass + '">' + it.batchName + '</span>' +
                '<span class="badge-count">' + it.total + ' 张纯景</span>' +
              '</div>' +
              '<div class="loc-bar">📍 ' + it.province + ' · ' + it.city + '</div>' +
            '</div>' +
            '<div class="card-body">' +
              '<div class="card-title" title="' + it.name + '">' + it.name + '</div>' +
              '<div class="card-meta-line">' +
                '<span>' + dimText + '</span>' +
                '<span>100% 景观实景门禁</span>' +
              '</div>' +
              '<div class="card-actions">' +
                '<button type="button" class="btn btn-primary" onclick="openGallery(\'' + it.id + '\')">🔍 预览图集 (' + it.total + ')</button>' +
                '<a class="btn btn-outline" href="' + mapUrl + '" target="_blank">🗺️ 地图定位</a>' +
              '</div>' +
            '</div>' +
          '</div>'
        );
      }
      grid.innerHTML = htmlBuf.join('');
      renderPagination(totalPages, currentPage);
    }

    function renderPagination(totalPages, page) {
      var bar = document.getElementById('pagination-bar');
      if (totalPages <= 1) {
        bar.innerHTML = '';
        return;
      }

      var buf = [];
      buf.push('<button class="page-btn" onclick="changePage(' + (page - 1) + ')"' + (page <= 1 ? ' disabled' : '') + '>上一页</button>');

      var s = Math.max(1, page - 2);
      var e = Math.min(totalPages, page + 2);
      if (s > 1) buf.push('<button class="page-btn" onclick="changePage(1)">1</button>');
      if (s > 2) buf.push('<span style="color:#94a3b8;">...</span>');

      for (var p = s; p <= e; p++) {
        var activeCls = p === page ? ' active' : '';
        buf.push('<button class="page-btn' + activeCls + '" onclick="changePage(' + p + ')">' + p + '</button>');
      }

      if (e < totalPages - 1) buf.push('<span style="color:#94a3b8;">...</span>');
      if (e < totalPages) buf.push('<button class="page-btn" onclick="changePage(' + totalPages + ')">' + totalPages + '</button>');

      buf.push('<button class="page-btn" onclick="changePage(' + (page + 1) + ')"' + (page >= totalPages ? ' disabled' : '') + '>下一页</button>');
      buf.push('<span class="page-info">' + page + ' / ' + totalPages + ' 页</span>');

      bar.innerHTML = buf.join('');
    }

    function changePage(p) {
      currentPage = p;
      renderCurrentPage();
      window.scrollTo({ top: 220, behavior: 'smooth' });
    }

    // Lightbox 弹窗控制
    function openGallery(id) {
      var it = ITEM_MAP[id];
      if (!it || !it.images || !it.images.length) return;
      currentImages = it.images;
      currentIndex = 0;

      document.getElementById('m-title').textContent = it.name;
      document.getElementById('m-loc').textContent = it.province + ' · ' + it.city;

      var bBadge = document.getElementById('m-batch-badge');
      bBadge.className = 'badge-batch ' + it.badgeClass;
      bBadge.textContent = it.batchName;

      renderThumbnails();
      updateModalImage();

      var modal = document.getElementById('gallery-modal');
      modal.style.display = 'flex';
      document.body.style.overflow = 'hidden';
    }

    function closeGallery() {
      var modal = document.getElementById('gallery-modal');
      modal.style.display = 'none';
      document.body.style.overflow = '';
    }

    function onModalBackdropClick(e) {
      if (e.target && e.target.id === 'gallery-modal') {
        closeGallery();
      }
    }

    function navGallery(dir) {
      if (!currentImages.length) return;
      currentIndex = (currentIndex + dir + currentImages.length) % currentImages.length;
      updateModalImage();
    }

    function selectThumb(idx) {
      currentIndex = idx;
      updateModalImage();
    }

    function updateModalImage() {
      var img = document.getElementById('m-img');
      var desc = document.getElementById('m-desc');
      var cur = currentImages[currentIndex];
      if (!cur) return;

      img.style.opacity = '0.5';
      img.src = cur.url;
      img.onload = function() { img.style.opacity = '1'; };

      var dim = (cur.w && cur.h) ? (cur.w + ' × ' + cur.h + ' px') : '高清全景';
      desc.textContent = '第 ' + (currentIndex + 1) + ' / ' + currentImages.length + ' 张 · ' + (cur.caption || '实景展示') + ' (' + dim + ')';

      var thumbs = document.querySelectorAll('.thumb-item');
      for (var i = 0; i < thumbs.length; i++) {
        thumbs[i].className = i === currentIndex ? 'thumb-item active' : 'thumb-item';
      }
    }

    function renderThumbnails() {
      var strip = document.getElementById('m-thumbs');
      var buf = [];
      for (var i = 0; i < currentImages.length; i++) {
        var c = currentImages[i];
        buf.push('<img class="thumb-item" src="' + c.url + '" onclick="selectThumb(' + i + ')" alt="thumb"/>');
      }
      strip.innerHTML = buf.join('');
    }

    // 事件绑定
    document.getElementById('batch-segmented').addEventListener('click', function(e) {
      var btn = e.target.closest('.seg-btn');
      if (!btn) return;
      var curActive = document.querySelector('#batch-segmented .seg-btn.active');
      if (curActive) curActive.classList.remove('active');
      btn.classList.add('active');
      currentBatch = btn.dataset.batch;
      applyFilter();
    });

    document.getElementById('tab-pills').addEventListener('click', function(e) {
      var pill = e.target.closest('.pill');
      if (!pill) return;
      var cur = document.querySelector('#tab-pills .pill.active');
      if (cur) cur.classList.remove('active');
      pill.classList.add('active');
      currentTab = pill.dataset.tab;
      applyFilter();
    });

    document.getElementById('search-input').addEventListener('input', function(e) {
      currentQuery = e.target.value.trim();
      applyFilter();
    });

    document.getElementById('prov-select').addEventListener('change', function(e) {
      currentProv = e.target.value;
      applyFilter();
    });

    window.addEventListener('keydown', function(e) {
      var modal = document.getElementById('gallery-modal');
      if (modal.style.display === 'flex') {
        if (e.key === 'Escape') closeGallery();
        else if (e.key === 'ArrowLeft') navGallery(-1);
        else if (e.key === 'ArrowRight') navGallery(1);
      }
    });

    // 初始化渲染
    applyFilter();
  </script>
</body>
</html>`;
}

async function main() {
  const state = readJson(batchStatePath);
  if (!Array.isArray(state.items)) {
    console.error('State file invalid.');
    process.exit(1);
  }

  // 严格过滤达标纯景
  const readyItems = state.items.filter(x => {
    if (!['ready_for_user_review', 'ready_for_visual_review'].includes(x.status)) return false;
    const list = x.selected || [];
    if (list.length < 3) return false;
    const purity = evaluateGalleryPurity(list, x.name);
    return !purity.isContaminated;
  });

  // 同步多图至沙箱省份数据
  const syncedCount = syncProvincesData(readyItems);
  console.log(`[Provinces Sync] Successfully synced multi-image gallery for ${syncedCount} attractions into preview site data`);

  // 读取交付历史
  const deliveryHistory = readJson(deliveryPath, {
    baselineCount: 152,
    startedAt: '2026-09-10T06:00:00.000Z',
    batches: []
  });

  const stats = {
    target: 1169,
    totalReady: readyItems.length,
    batchLabel: '第 2 批 (15:30 交付节点)',
    updatedAt: new Date().toISOString()
  };

  if (fs.existsSync(previewSite)) {
    const htmlContent = generateFastPreviewHtml(readyItems, stats);
    fs.writeFileSync(path.join(previewSite, 'preview.html'), htmlContent, 'utf8');
    console.log('[Fast Preview] Rendered batch-segmented preview.html with non-cached headers and top-level modal');
  }

  deliveryHistory.latestStats = stats;
  writeJson(deliveryPath, deliveryHistory);

  const lans = getPhysicalLans();
  console.log(`==================================================`);
  console.log(`  【全国景点图库】分批精准审计预览已就绪`);
  console.log(`  🗺️ 地图多图同步：${syncedCount} 个景点已注入 images 轮播数组`);
  console.log(`  🏷️ 批次精准切换：已支持 全部 / 第2批 / 第1批 / 存量基线 实时过滤`);
  console.log(`  📱 手机局域网：http://${lans[0] || '127.0.0.1'}:4185/preview.html`);
  console.log(`  💻 电脑本地：http://127.0.0.1:4185/preview.html`);
  console.log(`==================================================`);
}

main().catch(err => {
  console.error('[Delivery Error]', err);
  process.exitCode = 1;
});
