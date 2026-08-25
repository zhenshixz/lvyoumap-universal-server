
function toHighResImageUrl(url) {
  if (!url || typeof url !== 'string') return url || '';
  if (url.includes('store.is.autonavi.com/showpic/')) {
    if (url.includes('type=7')) return url;
    if (url.includes('type=')) return url.replace(/([?&])type=[^&]*/, '$1type=7');
    return url + (url.includes('?') ? '&type=7' : '?type=7');
  }
  return url;
}
window.toHighResImageUrl = toHighResImageUrl;


function escapeHtml(value = "") {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch] || ch));
}
window.escapeHtml = escapeHtml;

// 中国旅游地图 App 核心逻辑

// 1. 城市到省份的映射
const cityToProvince = {
  "北京": "北京",
  "上海": "上海",
  "成都": "四川",
  "西安": "陕西",
  "杭州": "浙江",
  "丽江": "云南",
  "三亚": "海南",
  "张家界": "湖南",
  "拉萨": "西藏",
  "乌鲁木齐": "新疆"
};

// 热门城市打点数据
const hotCitiesData = [
  { name: "北京", value: [116.4074, 39.9042, 100] },
  { name: "上海", value: [121.4737, 31.2304, 95] },
  { name: "成都", value: [104.0658, 30.5728, 90] },
  { name: "西安", value: [108.9401, 34.3415, 88] },
  { name: "杭州", value: [120.1535, 30.2874, 85] },
  { name: "丽江", value: [100.2330, 26.8721, 80] },
  { name: "三亚", value: [109.5119, 18.2528, 85] },
  { name: "张家界", value: [110.4789, 29.1170, 78] },
  { name: "拉萨", value: [91.1172, 29.6524, 75] },
  { name: "乌鲁木齐", value: [87.6177, 43.7928, 70] }
];

// 口碑美食与旅行计划数据库 (由后端数据接口懒加载填充)
let localCuisineAndItineraries = {};
const STATIC_DATA_VERSION = "20260825_food_national_v11";
const FAVORITES_STORAGE_KEY = "lvyoumap_favorites_v2";
// 回撤开关：改为 false 即可停用沉浸式大图，详情页其余功能不受影响。
const ENABLE_IMMERSIVE_IMAGE_VIEWER = true;
const IMMERSIVE_IMAGE_MAX_UPSCALE = 1.05;

let myChart = null;
let currentSelectedProvince = "";
let currentSelectedAttraction = null;
let favorites = [];
let currentZoom = window.innerWidth <= 768 ? 1.8 : 1.2;
let currentViewMode = "province"; // province or city
let selectedCityFilter = "全部";
let currentAttractionPage = 1;
let selectedFoodCityFilter = "全部";
let currentFoodPage = 1;

// 生成/获取持久化用户ID
const userId = localStorage.getItem('map_user_id') || ('user_' + Math.random().toString(36).substr(2, 9));
localStorage.setItem('map_user_id', userId);

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${url}`);
  }
  return response.json();
}

let echartsLoadPromise = null;
function loadEcharts() {
  if (window.echarts) return Promise.resolve(window.echarts);
  if (echartsLoadPromise) return echartsLoadPromise;

  const loadScript = (src, timeoutMs = 3500) => new Promise((resolve, reject) => {
    const script = document.createElement("script");
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      script.onload = null;
      script.onerror = null;
      reject(new Error(`ECharts load timeout: ${src}`));
    }, timeoutMs);

    script.src = src;
    script.async = true;
    script.onload = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.echarts ? resolve(window.echarts) : reject(new Error(`ECharts loaded without global export: ${src}`));
    };
    script.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`ECharts script failed to load: ${src}`));
    };
    document.head.appendChild(script);
  });

  const sources = [
    "https://cdn.bootcdn.net/ajax/libs/echarts/5.4.3/echarts.min.js",
    "vendor/echarts.min.js?v=5.4.3",
  ];

  echartsLoadPromise = sources.reduce(
    (promise, src) => promise.catch(() => loadScript(src)),
    Promise.reject(),
  );

  return echartsLoadPromise;
}

async function loadProvinceIndexData() {
  return fetchJson(`/data/provinces-index.json?v=${STATIC_DATA_VERSION}`);
}

async function loadProvinceDetailData(provinceName) {
  const provinceIndex = window.tourismData || await loadProvinceIndexData();
  const dataFile = provinceIndex?.[provinceName]?.dataFile;
  if (!dataFile || !/^[a-z0-9_-]+\.json$/.test(dataFile)) {
    throw new Error(`Static data file is unavailable for province: ${provinceName}`);
  }
  return fetchJson(`/data/provinces/${dataFile}?v=${STATIC_DATA_VERSION}`);
}

async function loadProvinceListData(provinceName) {
  return loadProvinceDetailData(provinceName);
}

async function loadProvinceFoodData(provinceName) {
  const detail = await loadProvinceDetailData(provinceName);
  return {
    bestTime: detail.bestTime || "最佳旅行时间：四季皆宜",
    foods: detail.foods || [],
    itineraries: detail.itineraries || [],
  };
}

async function loadAttractionDetailData(attraction) {
  return attraction || null;
}

// 全局智能多级防裂图重定向捕获器 (Multi-Tier Smart Fallback Loader)
window.addEventListener('error', function(e) {
  if (e.target.tagName === 'IMG') {
    const img = e.target;
    const currentSrc = img.src || "";
    
    // 已经加载了最终占位兜底图，停止触发以防死循环
    if (currentSrc.includes('default-thumbnail.jpg')) {
      return;
    }
    
    // 第一级智能级联降级：如果本地图片缺失，直接使用本地占位图，避免线上访问被外部图片服务拖慢。
    if (currentSrc.includes('/assets/images/')) {
      console.warn(`[Image Fallback] Local resource missing: ${currentSrc}. Displaying default-thumbnail.`);
      img.src = '/assets/images/default-thumbnail.jpg';
      return;
    }
    
    // 第二级级联降级：如果网络云图依然不可达，降级展示极致安全的本地灰色占位兜底图
    console.warn(`[Ultimate Fallback] Secondary remote image failed: ${currentSrc}. Displaying default-thumbnail.`);
    img.src = '/assets/images/default-thumbnail.jpg';
  }
}, true);

// 初始化页面
document.addEventListener("DOMContentLoaded", async () => {
  // 🚀 强效缓存击穿：针对微信等顽固 WebView 直接注入 CSS 修正
  const cacheBusterStyle = document.createElement("style");
  cacheBusterStyle.innerHTML = `
    @media (max-width: 1024px) {
      .attraction-card {
        height: auto !important;
        min-height: 115px !important;
        align-items: stretch !important;
      }
      .card-img-wrapper {
        height: auto !important;
        min-height: 115px !important;
        align-self: stretch !important;
      }
      .card-img {
        height: 100% !important;
        object-fit: cover !important;
      }
      .card-info {
        padding: 8px 12px !important;
        justify-content: center !important;
        height: auto !important;
      }
      .card-excerpt {
        white-space: normal !important;
        display: -webkit-box !important;
        -webkit-line-clamp: 2 !important;
        -webkit-box-orient: vertical !important;
        overflow: hidden !important;
        line-height: 1.4 !important;
      }
    }
  `;
  document.head.appendChild(cacheBusterStyle);

  const searchInput = document.getElementById("global-search");
  if (searchInput) {
    searchInput.value = "";
    // 双重延时清除机制，防止部分浏览器（如 Chrome/Edge）的异步表单自动填充 (Autofill) 注入旧数据
    setTimeout(() => { searchInput.value = ""; }, 300);
    setTimeout(() => { searchInput.value = ""; }, 1000);
  }
  initTheme();
  initClock();
  await loadInitialData();
  initEventListeners();
  initRegionControls();
  initAuthSession();
});

function loadLocalFavorites() {
  try {
    const stored = JSON.parse(localStorage.getItem(FAVORITES_STORAGE_KEY) || "[]");
    return Array.isArray(stored) ? stored : [];
  } catch (error) {
    console.warn("Invalid local favorites were ignored:", error);
    return [];
  }
}

async function loadLiveWeather(provinceName) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`/api/weather?province=${encodeURIComponent(provinceName)}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Weather API returned ${response.status}`);
    const payload = await response.json();
    if (!payload?.success || !payload.data) throw new Error("Weather API returned invalid data");
    return payload.data;
  } finally {
    clearTimeout(timeout);
  }
}

function renderWeatherData(weather, { reference = false } = {}) {
  if (!weather) return;
  document.getElementById("dest-weather-temp").textContent = weather.temp || "--";
  const details = [weather.cond || "天气未知"];
  if (weather.humidity !== undefined && weather.humidity !== null) {
    details.push(`湿度${weather.humidity}%`);
  } else if (weather.aqi) {
    details.push(`空气${weather.aqi}`);
  }
  if (reference) details.push("气候参考");
  if (weather.stale) details.push("最近缓存");
  document.getElementById("dest-weather-cond").textContent = details.join(" · ");
}

function saveLocalFavorites() {
  localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(favorites));
}

// 加载 EdgeOne 静态数据与浏览器本机收藏
async function loadInitialData() {
  const loaderEl = document.getElementById("map-loader");
  if (loaderEl) {
    loaderEl.style.display = "flex";
    loaderEl.style.opacity = "1";
  }
  try {
    // 1. 获取所有省份轻量级索引数据。
    window.tourismData = await loadProvinceIndexData();
    // 2. EdgeOne 静态版不伪造云同步，收藏明确保存在当前浏览器。
    favorites = loadLocalFavorites();
  } catch (err) {
    console.error("Failed to load static tourism data:", err);
    showToast("⚠️ 旅游数据加载失败，请刷新页面重试");
  }

  // 3. 初始化并渲染地图
  updateFavoritesCount();
  initMap();
}

function initLazyRouteUpdateMonitor() {
  const widget = document.getElementById("lazy-update-widget");
  const statusEl = document.getElementById("lazy-update-status");
  const metaEl = document.getElementById("lazy-update-meta");
  const fillEl = document.getElementById("lazy-update-bar-fill");
  const startBtn = document.getElementById("lazy-update-start");
  const stopBtn = document.getElementById("lazy-update-stop");

  if (!widget || !statusEl || !metaEl || !fillEl || !startBtn || !stopBtn) return;

  const setLoading = (isLoading) => {
    startBtn.disabled = isLoading;
    stopBtn.disabled = isLoading;
  };

  const render = (progress) => {
    const status = progress.status || "idle";
    const percent = Number(progress.percent || 0);
    const isRunning = status === "running";
    const isStopped = status === "stopped" || status === "error";

    widget.classList.toggle("is-running", isRunning);
    widget.classList.toggle("is-complete", status === "complete");
    widget.classList.toggle("is-warning", isStopped);
    fillEl.style.width = `${Math.max(0, Math.min(100, percent))}%`;

    const statusMap = {
      idle: "未启动",
      running: "正在更新",
      complete: "已完成",
      stopped: "已停止",
      error: "出错",
    };

    statusEl.textContent = statusMap[status] || status;

    if (isRunning) {
      metaEl.textContent = `${progress.completed || 0}/${progress.total || 0} · 已更新 ${progress.updated || 0} · 当前：${progress.currentProvince || ""} ${progress.currentAttraction || ""}`;
    } else if (status === "complete") {
      metaEl.textContent = `完成：更新 ${progress.updated || 0}，跳过 ${progress.skipped || 0}，失败 ${progress.failed || 0}`;
    } else {
      metaEl.textContent = `全库已核验 ${progress.verifiedAttractions || 0}/${progress.totalAttractions || 0}，待更新 ${progress.missingAttractions || 0}`;
    }

    startBtn.style.display = isRunning ? "none" : "inline-flex";
    stopBtn.style.display = isRunning ? "inline-flex" : "none";
  };

  const refresh = async () => {
    try {
      const response = await fetch(`/api/lazy-route-update/progress?t=${Date.now()}`);
      const json = await response.json();
      if (json.success) render(json.data || {});
    } catch {
      statusEl.textContent = "离线";
      metaEl.textContent = "无法连接后端进度接口";
    }
  };

  startBtn.addEventListener("click", async () => {
    setLoading(true);
    try {
      await fetch("/api/lazy-route-update/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      await refresh();
      showToast("懒人攻略后台更新已启动");
    } catch {
      showToast("启动失败，请检查后端服务");
    } finally {
      setLoading(false);
    }
  });

  stopBtn.addEventListener("click", async () => {
    setLoading(true);
    try {
      await fetch("/api/lazy-route-update/stop", { method: "POST" });
      await refresh();
      showToast("已请求停止，当前景点处理完会退出");
    } catch {
      showToast("停止失败，请检查后端服务");
    } finally {
      setLoading(false);
    }
  });

  refresh();
  setInterval(refresh, 5000);
}

// 初始化主题
function initTheme() {
  const savedTheme = localStorage.getItem("theme") || "light";
  if (savedTheme === "dark") {
    document.documentElement.classList.add("dark-theme");
    const themeIcon = document.getElementById("theme-icon");
    if (themeIcon) {
      themeIcon.innerHTML = `<path d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1zM5.99 4.58c-.39-.39-1.03-.39-1.41 0s-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41L5.99 4.58zm12.37 12.37c-.39-.39-1.03-.39-1.41 0s-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41l-1.06-1.06zm1.06-12.37c-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06c.39-.39.39-1.03 0-1.41zm-12.37 12.37c-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06c.39-.39.39-1.03 0-1.41z"/>`;
    }
  } else {
    document.documentElement.classList.remove("dark-theme");
  }
}

// 1. 系统时钟逻辑
function initClock() {
  const timeEl = document.getElementById("systime");
  const updateTime = () => {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    timeEl.textContent = `${hh}:${mm}`;
  };
  updateTime();
  setInterval(updateTime, 60000);
}

// 2. 初始化 ECharts 中国地图
async function initMap() {
  if (myChart) return;

  const chartDom = document.getElementById("map-chart");
  const loaderEl = document.getElementById("map-loader");
  if (loaderEl) {
    loaderEl.style.display = "flex";
    loaderEl.style.opacity = "1";
    const textEl = loaderEl.querySelector(".loader-text");
    if (textEl) textEl.textContent = "正在加载中国地理数据...";
  }

  try {
    await loadEcharts();
  } catch (err) {
    if (loaderEl) {
      loaderEl.style.display = "flex";
      loaderEl.style.opacity = "1";
      const textEl = loaderEl.querySelector(".loader-text");
      if (textEl) textEl.textContent = "地图加载失败，请刷新重试";
    }
    console.error("ECharts failed to load.", err);
    return;
  }

  myChart = echarts.init(chartDom);

  // 隐藏加载动画
  if (loaderEl) {
    loaderEl.style.opacity = "0";
    setTimeout(() => loaderEl.style.display = "none", 500);
  }

  // 注册地图数据
  echarts.registerMap('china', chinaGeoJSON);

  renderMapWithOptions();
  bindMapChartEvents();

  window.addEventListener('resize', () => {
    myChart.resize();
  });
}

// 省份中心坐标 (用于定位选区 Pin 点)
const provinceCapitals = {
  "北京": [116.4074, 39.9042],
  "上海": [121.4737, 31.2304],
  "天津": [117.2008, 39.0841],
  "重庆": [106.5516, 29.5630],
  "河北": [114.5149, 38.0422],
  "山西": [112.5489, 37.8706],
  "辽宁": [123.4315, 41.8057],
  "吉林": [125.3235, 43.8171],
  "黑龙江": [126.6425, 45.7570],
  "江苏": [118.7674, 32.0415],
  "浙江": [120.1535, 30.2874],
  "安徽": [117.2830, 31.8612],
  "福建": [119.3063, 26.0753],
  "江西": [115.8921, 28.6765],
  "山东": [117.0009, 36.6758],
  "河南": [113.6654, 34.7579],
  "湖北": [114.3054, 30.5931],
  "湖南": [112.9823, 28.1941],
  "广东": [113.2644, 23.1292],
  "海南": [110.3312, 20.0319],
  "四川": [104.0658, 30.5728],
  "贵州": [106.7135, 26.5783],
  "云南": [102.7123, 25.0406],
  "陕西": [108.9401, 34.3415],
  "甘肃": [103.8236, 36.0581],
  "青海": [101.7789, 36.6231],
  "西藏": [91.1172, 29.6524],
  "宁夏": [106.2781, 38.4664],
  "新疆": [87.6177, 43.7928],
  "内蒙古": [111.6708, 40.8183],
  "广西": [108.3275, 22.8154],
  "台湾": [121.5090, 25.0443],
  "香港": [114.1734, 22.3090],
  "澳门": [113.5439, 22.1984]
};

// 山川地貌与省份文化特色标记点 (对应参考图：山川大好河山与省份特色 icon 展示)
const landscapeSeriesData = [
  { name: "🐫", value: [86.0, 41.5] },  // 新疆大漠骆驼
  { name: "🏔️", value: [88.0, 31.5] },  // 西藏雪山
  { name: "🐼", value: [102.5, 30.0] }, // 四川大熊猫
  { name: "🏯", value: [108.9, 34.3] }, // 陕西古迹/大雁塔
  { name: "⛩️", value: [116.4, 39.9] }, // 北京故宫/古建筑
  { name: "⛰️", value: [117.1, 36.2] }, // 山东泰山
  { name: "🌉", value: [121.47, 31.23] },// 上海东方明珠/大桥
  { name: "🌴", value: [109.8, 19.2] }, // 海南椰林海岛
  { name: "🏔️", value: [100.5, 26.5] }, // 云南丽江雪山
  { name: "🌲", value: [127.6, 47.8] }, // 黑龙江针叶林
  { name: "🛶", value: [120.15, 29.8] }, // 浙江西湖断桥水乡
  { name: "🎡", value: [113.26, 22.8] }, // 广东地标/港澳摩天轮
  { name: "🐎", value: [113.0, 42.0] },  // 内蒙古大草原奔马
  { name: "❄️", value: [126.0, 43.5] },  // 吉林长白山雾凇雪花
  { name: "🏯", value: [112.5, 31.0] },  // 湖北黄鹤楼/楚韵
  { name: "🧗", value: [111.5, 27.5] },  // 湖南张家界奇峰天梯攀岩
  { name: "🍲", value: [107.0, 29.5] },  // 重庆九宫格火锅
  { name: "🍵", value: [119.8, 33.0] },  // 江苏园林香茗
  { name: "🏡", value: [117.5, 30.5] },  // 安徽徽派古村落宏村
  { name: "🏺", value: [116.0, 28.0] },  // 江西景德镇青花瓷瓶
  { name: "🌸", value: [112.4, 34.6] },  // 河南洛阳国色天香牡丹花
  { name: "🌊", value: [106.0, 26.5] },  // 贵州黄果树瀑布
  { name: "⛵", value: [109.0, 23.8] },  // 广西桂林漓江竹筏
  { name: "🍃", value: [118.2, 25.8] },  // 福建武夷红袍茶树
  { name: "🌙", value: [98.5, 39.5] },   // 甘肃敦煌月牙泉
  { name: "🐂", value: [96.5, 36.2] },   // 青海高寒牦牛
  { name: "🚝", value: [114.5, 38.0] },  // 河北山海关/高铁
  { name: "🍒", value: [106.0, 37.5] },  // 宁夏红宝枸杞
  { name: "🚢", value: [122.5, 41.3] },  // 辽宁大连海港轮船
  { name: "🛕", value: [112.2, 37.5] },  // 山西五台山佛光寺塔
  { name: "🍍", value: [121.2, 24.0] }   // 台湾宝岛凤梨
];

// 各区定位配置 (华北, 东北, 华东, 华中, 华南, 西南, 西北)
const regionCoordinates = {
  all: { center: [104.3, 35.8], zoom: 1.2 },
  hb: { center: [115.5, 39.5], zoom: 2.2 },
  db: { center: [126.0, 45.0], zoom: 2.1 },
  hd: { center: [118.5, 29.5], zoom: 2.3 },
  hz: { center: [113.0, 31.0], zoom: 2.5 },
  hn: { center: [110.0, 22.5], zoom: 2.6 },
  xn: { center: [99.0, 29.0], zoom: 1.8 },
  xb: { center: [92.0, 39.0], zoom: 1.5 }
};

// 渲染地图
function renderMapWithOptions() {
  if (!myChart) return;

  const isDark = document.documentElement.classList.contains("dark-theme");



  const isProvMode = currentViewMode === "province";

  const mapData = Object.keys(chinaGeoJSON.features).map(key => {
    const provName = chinaGeoJSON.features[key].properties.name;
    const hasData = window.tourismData[provName];
    
    // 自定义省份地形配色 (匹配设计图：多色大好河山感)
    let customStyle = {};
    if (isDark) {
      if (provName === "新疆" || provName === "甘肃" || provName === "青海") {
        customStyle = { areaColor: "rgba(245, 158, 11, 0.12)", borderColor: "rgba(245, 158, 11, 0.3)" };
      } else if (provName === "西藏") {
        customStyle = { areaColor: "rgba(148, 163, 184, 0.12)", borderColor: "rgba(148, 163, 184, 0.3)" };
      } else if (provName === "四川" || provName === "云南" || provName === "贵州") {
        customStyle = { areaColor: "rgba(16, 185, 129, 0.12)", borderColor: "rgba(16, 185, 129, 0.3)" };
      } else {
        customStyle = { areaColor: "#131a2c", borderColor: "rgba(6, 182, 212, 0.15)" };
      }
    } else {
      if (provName === "新疆" || provName === "甘肃" || provName === "青海") {
        customStyle = { areaColor: "#fef9c3", borderColor: "rgba(234, 179, 8, 0.4)" }; // 黄沙大漠
      } else if (provName === "西藏") {
        customStyle = { areaColor: "#f1f5f9", borderColor: "rgba(148, 163, 184, 0.4)" }; // 灰白雪域
      } else if (provName === "四川" || provName === "云南" || provName === "贵州") {
        customStyle = { areaColor: "#dcfce7", borderColor: "rgba(34, 197, 94, 0.4)" }; // 绿色盆地与彩林
      } else {
        customStyle = { areaColor: "#f0fdfa", borderColor: "rgba(20, 184, 166, 0.4)" }; // 江南青绿
      }
    }

    return {
      name: provName,
      value: hasData ? (hasData.attractionCount || (hasData.attractions ? hasData.attractions.length : 0)) : 0,
      itemStyle: customStyle,
      emphasis: {
        itemStyle: {
          areaColor: isDark ? "rgba(6, 182, 212, 0.25)" : "rgba(2, 132, 199, 0.18)"
        }
      },
      select: {
        itemStyle: {
          areaColor: isDark ? "rgba(251, 191, 36, 0.2)" : "rgba(251, 191, 36, 0.15)",
          borderColor: "#fbbf24",
          borderWidth: 2
        }
      }
    };
  });

  // 渲染选中定位 Pin (已改用更高级的 HTML/CSS 胶囊定制渲染，此处设为空以防 ECharts 画布重复绘制)
  const activePinData = [];

  const option = {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      backgroundColor: isDark ? 'rgba(19, 26, 44, 0.95)' : 'rgba(255, 255, 255, 0.95)',
      borderColor: isDark ? 'rgba(6, 182, 212, 0.4)' : 'rgba(2, 132, 199, 0.4)',
      borderWidth: 1,
      textStyle: { color: isDark ? '#fff' : '#0f172a', fontSize: 12 },
      formatter: function (params) {
        if (params.seriesType === 'effectScatter') {
          return `🔥 热门城市: ${params.name}`;
        }
        if (params.seriesType === 'scatter' && params.seriesName === '山川风貌') {
          return `🏔️ 山川地貌节点`;
        }
        const provData = window.tourismData[params.name];
        if (provData) {
          const count = provData.attractionCount || (provData.attractions ? provData.attractions.length : 0);
          return `📍 <strong>${params.name}</strong><br/>推荐景点数: ${count} 个`;
        }
        return `📍 <strong>${params.name}</strong><br/>暂无导览数据`;
      }
    },
    geo: {
      map: 'china',
      roam: true,
      zoom: currentZoom,
      center: [104.3, 35.8],
      label: {
        show: true,
        color: isDark ? 'rgba(255, 255, 255, 0.6)' : 'rgba(15, 23, 42, 0.6)',
        fontSize: 10
      },
      itemStyle: {
        areaColor: isDark ? '#131a2c' : '#f8fafc',
        borderColor: isDark ? 'rgba(6, 182, 212, 0.3)' : 'rgba(2, 132, 199, 0.3)',
        borderWidth: 1,
        shadowColor: isDark ? 'rgba(6, 182, 212, 0.15)' : 'rgba(2, 132, 199, 0.15)',
        shadowBlur: 10,
        shadowOffsetX: 0,
        shadowOffsetY: 4
      },
      emphasis: {
        itemStyle: {
          areaColor: isDark ? 'rgba(6, 182, 212, 0.15)' : 'rgba(2, 132, 199, 0.15)',
          borderColor: isDark ? '#06b6d4' : '#0284c7',
          borderWidth: 1.5
        },
        label: {
          show: true,
          color: isDark ? '#fff' : '#0f172a',
          fontWeight: 'bold'
        }
      },
      select: {
        itemStyle: {
          areaColor: isDark ? 'rgba(251, 191, 36, 0.15)' : 'rgba(2, 132, 199, 0.2)',
          borderColor: isDark ? '#fbbf24' : '#0284c7',
          borderWidth: 2
        },
        label: {
          show: true,
          color: isDark ? '#fff' : '#0f172a',
          fontWeight: 'bold'
        }
      }
    },
    series: [
      {
        name: '省份区块',
        type: 'map',
        map: 'china',
        geoIndex: 0,
        data: mapData,
        selectedMode: 'single'
      },
      {
        name: '山川风貌',
        type: 'scatter',
        coordinateSystem: 'geo',
        data: landscapeSeriesData,
        symbolSize: 1, // 气泡大小设为极小，主要显示 emoji
        silent: true,
        label: {
          show: true,
          formatter: '{b}',
          fontSize: 20,
          position: 'top'
        },
        zlevel: 4
      },
      {
        name: '选中定位标',
        type: 'scatter',
        coordinateSystem: 'geo',
        data: activePinData,
        symbolSize: 46,
        symbolOffset: [0, -18],
        silent: true,
        label: {
          show: true,
          position: 'top',
          formatter: '{b}',
          backgroundColor: isDark ? '#06b6d4' : '#0284c7',
          color: '#fff',
          padding: [3, 8],
          borderRadius: 10,
          fontSize: 10,
          fontWeight: 'bold',
          shadowBlur: 5,
          shadowColor: 'rgba(0,0,0,0.3)'
        },
        itemStyle: {
          borderColor: '#fff',
          borderWidth: 2,
          shadowBlur: 8,
          shadowColor: 'rgba(0,0,0,0.3)'
        },
        zlevel: 5
      },
      {
        name: '热门城市点',
        type: 'effectScatter',
        coordinateSystem: 'geo',
        data: hotCitiesData,
        symbolSize: function (val) {
          return Math.max(8, val[2] / 8);
        },
        showEffectOn: 'render',
        rippleEffect: {
          brushType: 'stroke',
          scale: 3
        },
        label: {
          formatter: '{b}',
          position: 'right',
          show: true,
          color: isDark ? '#cbd5e1' : '#334155',
          fontWeight: '600',
          fontSize: 11,
          textBorderColor: isDark ? '#0b0f19' : '#ffffff',
          textBorderWidth: 2
        },
        itemStyle: {
          color: isDark ? '#06b6d4' : '#0284c7',
          shadowBlur: 10,
          shadowColor: isDark ? '#06b6d4' : '#0284c7'
        },
        zlevel: 3
      }
    ]
  };

  myChart.setOption(option);
  updateCustomPinPosition();
}

// 2.5 实时更新自定义高级定位标 (Custom Map Pin - Image 2 Style)
function updateCustomPinPosition() {
  const pinEl = document.getElementById("custom-map-pin");
  if (!pinEl) return;

  if (!currentSelectedProvince || !provinceCapitals[currentSelectedProvince] || !myChart) {
    pinEl.style.display = "none";
    return;
  }

  const coord = provinceCapitals[currentSelectedProvince];
  // 转换地理经纬度坐标为容器的绝对像素值
  const pixel = myChart.convertToPixel('geo', coord);
  if (pixel && !isNaN(pixel[0]) && !isNaN(pixel[1])) {
    pinEl.style.left = `${pixel[0]}px`;
    pinEl.style.top = `${pixel[1]}px`;
    pinEl.style.display = "block";
    
    // 同步更新头像大图与省份文本
    const destData = window.tourismData[currentSelectedProvince];
    const avatarImg = document.getElementById("pin-avatar-img");
    const labelText = document.getElementById("pin-label-text");
    
    if (destData) {
      if (avatarImg) {
        avatarImg.src = destData.image || "/assets/images/default-thumbnail.jpg";
      }
      if (labelText) {
        labelText.textContent = currentSelectedProvince;
      }
    }
  } else {
    pinEl.style.display = "none";
  }
}

let mapChartEventsBound = false;
function bindMapChartEvents() {
  if (!myChart || mapChartEventsBound) return;
  mapChartEventsBound = true;

  myChart.on('click', (params) => {
    let targetProvince = "";
    
    // 如果点击的是散点城市
    if (params.seriesType === 'effectScatter') {
      const cityName = params.name;
      targetProvince = cityToProvince[cityName] || "";
    } 
    // 如果点击的是省份区块 (2D)
    else if (params.seriesType === 'map') {
      targetProvince = params.name;
    }

    if (targetProvince) {
      selectProvince(targetProvince);
    }
  });

  // 鼠标悬停省份时触发后台图片预加载 (提升平板端查看详情的秒开体验)
  myChart.on('mouseover', (params) => {
    if (params.seriesType === 'map') {
      prefetchProvinceImages(params.name);
    }
  });

  // 监听地图的缩放、拖拽事件，实时渲染同步自定义定位 Pin 位置
  myChart.on('georoam', updateCustomPinPosition);
  window.addEventListener('resize', updateCustomPinPosition);
}

// 3. 事件监听配置
function initEventListeners() {
  // 3.1 地图区块及标记点击事件与图片预加载 (全面兼容 2D / ECharts GL 3D)
  bindMapChartEvents();

  // 3.2 重置控制 (复位为全国，清除高亮和详情)
  document.getElementById("btn-reset").addEventListener("click", () => {
    if (myChart) {
      // 取消地图选区高亮
      myChart.dispatchAction({
        type: 'unselect',
        seriesIndex: 0
      });
      
      // 复位缩放和中心点
      currentZoom = window.innerWidth <= 768 ? 1.8 : 1.2;
      myChart.setOption({
        geo: {
          zoom: currentZoom,
          center: [104.3, 35.8]
        }
      });
    }
    currentSelectedProvince = "";
    updateCustomPinPosition();
    document.getElementById("panel-empty").style.display = "flex";
    document.getElementById("panel-destination").style.display = "none";
    document.getElementById("favorites-panel").classList.remove("active");
    
    renderMapWithOptions();
  });

  // 绑定地图缩放按钮
  document.getElementById("btn-zoom-in").addEventListener("click", () => {
    currentZoom = Math.min(currentZoom + 0.2, 5);
    updateMapZoom();
  });
  document.getElementById("btn-zoom-out").addEventListener("click", () => {
    currentZoom = Math.max(currentZoom - 0.2, 0.5);
    updateMapZoom();
  });

  // 3.3 视图模式切换
  document.getElementById("btn-prov-view").addEventListener("click", (e) => {
    toggleViewMode("province", e.target);
  });

  document.getElementById("btn-city-view").addEventListener("click", (e) => {
    toggleViewMode("city", e.target);
  });



  // 3.4 搜索输入框逻辑
  const searchInput = document.getElementById("global-search");
  searchInput.addEventListener("input", (e) => {
    handleSearch(e.target.value.trim());
  });

  // 3.5 排序方式切换
  const attractionSort = document.getElementById("attraction-sort");
  if (attractionSort) {
    attractionSort.addEventListener("change", () => {
      if (currentSelectedProvince) {
        const destData = window.tourismData[currentSelectedProvince];
        if (destData && destData.attractions) {
          renderAttractionList(destData.attractions);
        }
      }
    });
  }

  // 3.6 收藏夹侧栏切换
  document.getElementById("fav-trigger").addEventListener("click", () => {
    showFavoritesSidebar();
  });

  document.getElementById("fav-close-btn").addEventListener("click", () => {
    document.getElementById("favorites-panel").classList.remove("active");
  });

  // 3.7 景点详情弹窗事件
  const modalImage = document.getElementById("modal-img");
  const modalImageExpand = document.getElementById("modal-image-expand");
  const modalClose = document.getElementById("modal-close");
  const modalBanner = document.querySelector("#detail-modal .modal-banner");

  modalClose.addEventListener("click", () => {
    if (isImmersiveImageViewerOpen()) {
      closeImmersiveImageViewer();
      return;
    }
    closeModal();
  });
  if (ENABLE_IMMERSIVE_IMAGE_VIEWER) {
    modalImageExpand.hidden = false;
    modalImage.addEventListener("click", (event) => {
      if (isImmersiveImageViewerOpen()) return;
      event.stopPropagation();
      openImmersiveImageViewer();
    });
    modalImageExpand.addEventListener("click", (event) => {
      event.stopPropagation();
      openImmersiveImageViewer();
    });
    modalBanner.addEventListener("click", (event) => {
      if (!isImmersiveImageViewerOpen()) return;
      if (event.target.closest(".modal-close-btn, .modal-image-credit, .modal-image-expand")) return;
      if (isPointOutsideContainedImage(modalImage, event.clientX, event.clientY)) {
        closeImmersiveImageViewer();
      }
    });
    modalImage.setAttribute("role", "button");
    modalImage.setAttribute("tabindex", "0");
    modalImage.setAttribute("aria-label", "查看景点大图");
    modalImage.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openImmersiveImageViewer();
      }
    });
    modalImage.addEventListener("load", () => {
      if (isImmersiveImageViewerOpen()) updateImmersiveImageQuality();
    });
    window.addEventListener("resize", () => {
      if (isImmersiveImageViewerOpen()) updateImmersiveImageQuality();
    });
  }
  document.getElementById("detail-modal").addEventListener("click", (e) => {
    if (e.target.id === "detail-modal") closeModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (isImmersiveImageViewerOpen()) {
      closeImmersiveImageViewer();
      return;
    }
    const detailModal = document.getElementById("detail-modal");
    if (detailModal.style.display === "flex") closeModal();
  });

  // 3.8 弹窗内部选项卡切换
  const tabButtons = document.querySelectorAll(".modal-tab-btn");
  tabButtons.forEach(btn => {
    btn.addEventListener("click", (e) => {
      tabButtons.forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-pane").forEach(p => p.classList.remove("active"));

      e.target.classList.add("active");
      const tabId = e.target.getAttribute("data-tab");
      document.getElementById(tabId).classList.add("active");

      if (tabId === "tab-info") {
        triggerScoreAnimation();
      }
    });
  });

  // 3.9 主题切换按钮
  const themeToggle = document.getElementById("theme-toggle");
  if (themeToggle) {
    themeToggle.addEventListener("click", () => {
      document.documentElement.classList.toggle("dark-theme");
      const isDark = document.documentElement.classList.contains("dark-theme");
      localStorage.setItem("theme", isDark ? "dark" : "light");
      
      const themeIcon = document.getElementById("theme-icon");
      if (themeIcon) {
        if (isDark) {
          themeIcon.innerHTML = `<path d="M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1zM5.99 4.58c-.39-.39-1.03-.39-1.41 0s-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41L5.99 4.58zm12.37 12.37c-.39-.39-1.03-.39-1.41 0s-.39 1.03 0 1.41l1.06 1.06c.39.39 1.03.39 1.41 0s.39-1.03 0-1.41l-1.06-1.06zm1.06-12.37c-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06c.39-.39.39-1.03 0-1.41zm-12.37 12.37c-.39-.39-1.03-.39-1.41 0l-1.06 1.06c-.39.39-.39 1.03 0 1.41s1.03.39 1.41 0l1.06-1.06c.39-.39.39-1.03 0-1.41z"/>`;
        } else {
          themeIcon.innerHTML = `<path d="M12.3 22h-.1c-5.5 0-10-4.5-10-10 0-4.8 3.5-8.9 8.2-9.8.5-.1 1 .2 1.2.7.2.5 0 1.1-.4 1.4-2.8 1.9-4.3 5.3-3.6 8.7.6 3 2.9 5.4 5.9 6 3.4.7 6.8-.8 8.7-3.6.3-.4.8-.6 1.3-.4.5.2.8.7.7 1.2-.9 4.7-5 8.2-9.8 8.2z"/>`;
        }
      }
      
      renderMapWithOptions();
    });
  }

  // 3.10 右侧内容栏页签切换
  const destTabButtons = document.querySelectorAll(".dest-tab-btn");
  destTabButtons.forEach(btn => {
    btn.addEventListener("click", (e) => {
      destTabButtons.forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".dest-tab-pane").forEach(p => p.style.display = "none");
      
      e.currentTarget.classList.add("active");
      const tabId = e.currentTarget.getAttribute("data-tab");
      
      if (tabId === "recommend") {
        document.getElementById("pane-recommend").style.display = "flex";
      } else if (tabId === "food") {
        document.getElementById("pane-food").style.display = "flex";
        if (currentSelectedProvince) {
          renderFoodList(currentSelectedProvince);
        }
      }
    });
  });

  // 3.12 底部平板导航栏事件联动
  const bottomNavItems = document.querySelectorAll(".bottom-nav-item");
  bottomNavItems.forEach(item => {
    item.addEventListener("click", (e) => {
      e.preventDefault();
      bottomNavItems.forEach(b => b.classList.remove("active"));
      e.currentTarget.classList.add("active");
      
      const navId = e.currentTarget.id;
      if (navId === "bnav-home") {
        document.getElementById("btn-reset").click();
        document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
        document.getElementById("nav-home").classList.add("active");
      } else if (navId === "bnav-destination") {
        document.getElementById("global-search").focus();
        showToast("🔍 请在上方搜索框输入您想去的省份或热门地名");
      } else if (navId === "bnav-ranking") {
        document.getElementById("btn-city-view").click();
        showToast("🔥 已为您切换至全国热门旅游城市标记");
      } else if (navId === "bnav-strategy") {
        showToast("敬请期待：旅行攻略功能已整合至景点详情中");
      } else if (navId === "bnav-my") {
        showFavoritesSidebar();
      }
    });
  });

  // 3.13 顶部导航栏静态导航项模拟交互
  const headerNavItems = document.querySelectorAll(".nav-item");
  headerNavItems.forEach(item => {
    item.addEventListener("click", (e) => {
      e.preventDefault();
      headerNavItems.forEach(n => n.classList.remove("active"));
      e.currentTarget.classList.add("active");

      const text = e.currentTarget.textContent.trim();
      if (text.includes("首页")) {
        document.getElementById("btn-reset").click();
      } else if (text.includes("目的地")) {
        document.getElementById("global-search").focus();
        showToast("🔍 请输入省份名进行导览");
      } else if (text.includes("景点排行")) {
        document.getElementById("btn-city-view").click();
      } else if (text.includes("旅行攻略")) {
        showToast("敬请期待：旅行攻略功能已整合至景点详情中");
      } else if (text.includes("关于我们")) {
        showToast("ℹ️ 中国旅游地图 Android Tablet 交互原型 1.0.0");
      }
    });
  });

  // 3.14 绑定查看全部景点按钮
  const viewAllBtn = document.getElementById("btn-view-all-attractions");
  if (viewAllBtn) {
    viewAllBtn.addEventListener("click", () => {
      if (currentSelectedProvince) {
        showToast(`📍 正在加载并整理【${currentSelectedProvince}】所有著名景点...`);
      }
    });
  }
}

// 辅助：更新地图缩放
function updateMapZoom() {
  if (myChart) {
    myChart.setOption({
      geo: {
        zoom: currentZoom
      }
    });
    // 同步更新自定义高级定位 Pin 位置
    updateCustomPinPosition();
  }
}

// 辅助：切换视图模式
function toggleViewMode(mode, targetBtn) {
  if (currentViewMode === mode) return;
  
  currentViewMode = mode;
  
  document.querySelectorAll(".toggle-btn").forEach(btn => btn.classList.remove("active"));
  targetBtn.classList.add("active");

  renderMapWithOptions();
}

// 4. 选择目的地逻辑
async function selectProvince(provinceName) {
  let destData = window.tourismData[provinceName];

  if (!destData) {
    alert(`💡 温馨提示: 【${provinceName}】导览数据正在紧张筹备中，系统已为您优先推荐其他热门区域！`);
    return;
  }

  // 如果该省份的详细景点列表未加载，则进行懒加载
  if (!destData.attractions) {
    showToast(`⏳ 正在获取【${provinceName}】最新旅游数据...`);
    try {
      destData = await loadProvinceListData(provinceName);
      window.tourismData[provinceName] = destData;
      
      // 兼容原有的美食和指南读取逻辑
      localCuisineAndItineraries[provinceName] = {
        bestTime: destData.bestTime || "最佳旅行时间：四季皆宜",
        foods: destData.foods || [],
        itineraries: destData.itineraries || []
      };
    } catch (err) {
      console.error("Error fetching province details:", err);
      showToast("⚠️ 获取省份数据失败，请检查网络");
      return;
    }
  } else {
    // 确保即使景点已预先加载，也同步填充美食和指南以防 bestTime 回退
    if (!localCuisineAndItineraries[provinceName]) {
      localCuisineAndItineraries[provinceName] = {
        bestTime: destData.bestTime || "最佳旅行时间：四季皆宜",
        foods: destData.foods || [],
        itineraries: destData.itineraries || []
      };
    }
  }

  currentSelectedProvince = provinceName;

  // 在 ECharts 中选中当前区块
  if (myChart) {
    myChart.dispatchAction({
      type: 'select',
      name: provinceName
    });
  }

  // 更新目的地介绍面板
  document.getElementById("panel-empty").style.display = "none";
  document.getElementById("panel-destination").style.display = "flex";
  document.getElementById("favorites-panel").classList.remove("active");

  // 数据渲染
  document.getElementById("dest-img").src = destData.image;
  document.getElementById("dest-title").textContent = destData.province;
  document.getElementById("dest-desc").textContent = destData.description;
  renderMapWithOptions();
  
  // 先立即显示随版本发布的参考数据；实时接口失败时页面仍保持可用。
  renderWeatherData(destData.weather, { reference: true });
  loadLiveWeather(provinceName)
    .then((weather) => {
      if (currentSelectedProvince === provinceName) renderWeatherData(weather);
    })
    .catch((error) => {
      console.warn(`Live weather unavailable for ${provinceName}; reference data is kept.`, error);
    });
  
  // 最佳时间
  const extraInfo = localCuisineAndItineraries[provinceName];
  document.getElementById("dest-best-time").textContent = extraInfo ? extraInfo.bestTime : "最佳旅行时间：四季皆宜";

  // 渲染标签
  const tagsContainer = document.getElementById("dest-tags-list");
  tagsContainer.innerHTML = "";
  destData.tags.forEach(tag => {
    const span = document.createElement("span");
    span.className = "dest-tag";
    span.textContent = tag;
    tagsContainer.appendChild(span);
  });

  // 重置子标签选项卡到“景点推荐”
  document.querySelectorAll(".dest-tab-btn").forEach(btn => {
    btn.classList.toggle("active", btn.getAttribute("data-tab") === "recommend");
  });
  document.getElementById("pane-recommend").style.display = "flex";
  document.getElementById("pane-food").style.display = "none";


  // 🚀 初始化省内城市级导航分类栏
  selectedCityFilter = "全部";
  currentAttractionPage = 1;
  selectedFoodCityFilter = "全部";
  currentFoodPage = 1;
  renderCityFilterPills(destData.attractions, provinceName);

  // 重新渲染景点列表
  renderAttractionList(destData.attractions);
}

// 🚀 4.5 智能获取景点归属城市 (高精地图匹配与容错地理信息处理)
function getAttractionCity(attr, provinceName) {
  // 0. 优先读取后端数据库已分类存储好的真实 city 字段。
  if (attr.city) {
    return attr.city;
  }

  const name = attr.name || '';
  const address = attr.address || '';
  
  // 1. 景区核心地理标志词及著名景点硬编映射（高等级名胜专属映射表）
  const keywordMap = {
    // 江西
    "庐山": "九江", "鄱阳湖": "九江", "浔阳": "九江",
    "滕王阁": "南昌", "梅岭": "南昌", "湾里": "南昌", "八一": "南昌",
    "三清山": "上饶", "婺源": "上饶", "篁岭": "上饶", "龟峰": "上饶", "弋阳": "上饶",
    "龙虎山": "鹰潭",
    "井冈山": "吉安",
    "古窑": "景德镇", "瑶里": "景德镇", "御窑": "景德镇",
    "武功山": "萍乡",
    "明月山": "宜春", "温汤": "宜春",
    "仙女湖": "新余",
    "三百山": "赣州", "瑞金": "赣州", "郁孤台": "赣州", "通天岩": "赣州", "安远": "赣州",
    "大觉山": "抚州",

    // 四川
    "青城山": "成都", "都江堰": "成都", "大熊猫": "成都", "宽窄巷子": "成都", "锦里": "成都", "武侯祠": "成都", "杜甫草堂": "成都", "金沙遗址": "成都",
    "峨眉山": "乐山", "乐山大佛": "乐山",
    "九寨沟": "阿坝", "黄龙": "阿坝", "四姑娘山": "阿坝", "达古冰川": "阿坝",
    "稻城亚丁": "甘孜", "康定": "甘孜", "海螺沟": "甘孜", "泸定桥": "甘孜",
    "开江": "达州", "明月江": "达州",
    "蜀南竹海": "宜宾", "李庄": "宜宾",
    "死海": "遂宁",
    "阆中古城": "南充",
    "碧峰峡": "雅安",
    "西昌": "凉山", "邛海": "凉山",
    "光雾山": "巴中",
    "三星堆": "德阳",
    "剑门关": "广元",
    "小平故里": "广安",

    // 浙江
    "西湖": "杭州", "千岛湖": "杭州", "西溪湿地": "杭州", "灵隐寺": "杭州", "宋城": "杭州",
    "乌镇": "嘉兴", "西塘": "嘉兴", "南湖": "嘉兴",
    "普陀山": "舟山", "桃花岛": "舟山",
    "雁荡山": "温州", "楠溪江": "温州",
    "鲁迅故里": "绍兴", "沈园": "绍兴", "柯岩": "绍兴", "兰亭": "绍兴",
    "溪口": "宁波", "天一阁": "宁波", "东钱湖": "宁波",
    "横店": "金华", "双龙洞": "金华", "东阳": "金华",
    "神仙居": "台州", "天台山": "台州",
    "古堰画乡": "丽水", "缙云": "丽水",
    "江郎山": "衢州",
    "莫干山": "湖州", "南浔": "湖州",

    // 安徽
    "黄山": "黄山", "西递": "黄山", "宏村": "黄山", "徽州": "黄山",
    "九华山": "池州",
    "天柱山": "安庆",
    "天堂寨": "六安",
    "包公园": "合肥", "三河古镇": "合肥",
    "采石矶": "马鞍山",
    "八里河": "阜阳",
    "琅琊山": "滁州",
    "万佛湖": "六安",

    // 湖南
    "张家界": "张家界", "天门山": "张家界", "武陵源": "张家界", "黄龙洞": "张家界",
    "橘子洲": "长沙", "岳麓山": "长沙", "世界之窗": "长沙",
    "韶山": "湘潭",
    "衡山": "衡阳",
    "岳阳楼": "岳阳", "君山": "岳阳",
    "凤凰古城": "湘西", "矮寨": "湘西",
    "东江湖": "郴州",
    "崀山": "邵阳",
    "桃花源": "常德",

    // 江苏
    "拙政园": "苏州", "留园": "苏州", "虎丘": "苏州", "周庄": "苏州", "同里": "苏州", "寒山寺": "苏州", "金鸡湖": "苏州",
    "夫子庙": "南京", "钟山": "南京", "中山陵": "南京", "玄武湖": "南京", "总统府": "南京",
    "鼋头渚": "无锡", "灵山大佛": "无锡", "拈花湾": "无锡",
    "瘦西湖": "扬州", "个园": "扬州", "何园": "扬州",
    "恐龙城": "常州", "恐龙园": "常州", "天目湖": "常州",
    "金山寺": "镇江", "焦山": "镇江", "北固山": "镇江",
    "花果山": "连云港",
    "麋鹿园": "盐城",
    "濠河": "南通",
    "云龙湖": "徐州",

    // 福建
    "鼓浪屿": "厦门", "曾厝垵": "厦门",
    "武夷山": "南平",
    "三坊七巷": "福州",
    "土楼": "龙岩",
    "湄洲岛": "莆田",
    "清源山": "泉州", "开元寺": "泉州",
    "太姥山": "宁德", "白水洋": "宁德",
    "泰宁": "三明"
  };

  // 优先进行标志性名胜词的强类型查找
  for (const kw in keywordMap) {
    if (name.includes(kw)) {
      return keywordMap[kw];
    }
  }

  // 2. 全国主要地级市/自治州/地区精简字典
  const citiesList = [
    "南昌", "九江", "上饶", "鹰潭", "吉安", "景德镇", "萍乡", "宜春", "新余", "赣州", "抚州",
    "成都", "自贡", "攀枝花", "泸州", "德阳", "绵阳", "广元", "遂宁", "内江", "乐山", "南充", "眉山", "宜宾", "广安", "达州", "雅安", "巴中", "资阳", "阿坝", "甘孜", "凉山",
    "杭州", "宁波", "温州", "绍兴", "湖州", "嘉兴", "金华", "衢州", "舟山", "台州", "丽水",
    "广州", "深圳", "珠海", "汕头", "韶关", "佛山", "江门", "湛江", "茂名", "肇庆", "惠州", "梅州", "汕尾", "河源", "阳江", "清远", "东莞", "中山", "潮州", "揭阳", "云浮",
    "福州", "厦门", "莆田", "三明", "泉州", "漳州", "南平", "龙岩", "宁德",
    "南京", "无锡", "徐州", "常州", "苏州", "南通", "连云港", "淮安", "盐城", "扬州", "镇江", "泰州", "宿迁",
    "济南", "青岛", "淄博", "枣庄", "东营", "烟台", "潍坊", "济宁", "泰安", "威海", "日照", "临沂", "德州", "聊城", "滨州", "菏泽",
    "郑州", "开封", "洛阳", "平顶山", "安阳", "鹤壁", "新乡", "焦作", "濮阳", "许昌", "漯河", "三门峡", "南阳", "商丘", "信阳", "周口", "驻马店",
    "武汉", "黄石", "十堰", "宜昌", "襄阳", "鄂州", "荆门", "孝感", "荆州", "黄冈", "咸宁", "随州", "恩施", "神农架",
    "长沙", "株洲", "湘潭", "衡阳", "邵阳", "岳阳", "常德", "张家界", "益阳", "郴州", "永州", "怀化", "娄底", "湘西",
    "西安", "铜川", "宝鸡", "咸阳", "渭南", "延安", "汉中", "榆林", "安康", "商洛",
    "合肥", "芜湖", "蚌埠", "淮南", "马鞍山", "淮北", "铜陵", "安庆", "黄山", "滁州", "阜阳", "宿州", "六安", "亳州", "池州", "宣城",
    "南宁", "柳州", "桂林", "梧州", "北海", "钦州", "贵港", "玉林", "百色", "贺州", "河池", "来宾", "崇左",
    "海口", "三亚", "儋州",
    "贵阳", "六盘水", "遵义", "安顺", "毕节", "铜仁", "黔西南", "黔东南", "黔南",
    "昆明", "曲靖", "玉溪", "保山", "昭通", "丽江", "普洱", "临沧", "楚雄", "红河", "文山", "西双版纳", "大理", "德宏", "怒江", "迪庆",
    "拉萨", "日喀则", "昌都", "林芝", "山南", "那曲", "阿里",
    "兰州", "嘉峪关", "金昌", "白银", "天水", "武威", "张掖", "平凉", "酒泉", "庆阳", "定西", "陇南", "临夏", "甘南",
    "西宁", "海东", "海北", "黄南", "海南", "果洛", "玉树", "海西",
    "银川", "吴忠", "固原", "中卫",
    "乌鲁木齐", "克拉玛依", "吐鲁番", "哈密", "昌吉", "巴音郭楞", "阿克苏", "喀什", "和田", "伊犁", "阿勒泰",
    "太原", "大同", "阳泉", "长治", "晋城", "朔州", "晋中", "运城", "忻州", "临汾", "吕梁",
    "呼和浩特", "包头", "乌海", "赤峰", "通辽", "鄂尔多斯", "呼伦贝尔", "巴彦淖尔", "乌兰察布", "兴安", "锡林郭勒", "阿拉善",
    "沈阳", "大连", "鞍山", "抚顺", "本溪", "丹东", "锦州", "营口", "阜新", "辽阳", "盘锦", "铁岭", "朝阳", "葫芦岛",
    "长春", "吉林", "四平", "辽源", "通化", "白山", "松原", "白城", "延边",
    "哈尔滨", "齐齐哈尔", "大庆", "伊春", "佳木斯", "牡丹江", "黑河", "绥化", "大兴安岭"
  ];

  // 尝试在景区名称中直接提取地名（最精准）
  for (const city of citiesList) {
    if (name.startsWith(city) || name.includes(city)) {
      return city;
    }
  }

  // 3. 直辖市特判
  const isMunicipality = ["北京", "上海", "天津", "重庆"].includes(provinceName);
  if (isMunicipality) {
    const match = address.match(/(东城|西城|朝阳|海淀|丰台|石景山|门头沟|房山|通州|顺义|昌平|大兴|怀柔|平谷|密云|延庆|黄浦|徐汇|长宁|静安|普陀|虹口|杨浦|闵行|宝山|嘉定|浦东|金山|松江|青浦|奉贤|崇明|和平|河东|河西|南开|河北|红桥|东丽|西青|津南|北辰|武清|宝坻|滨海|宁河|静海|蓟州|渝中|万州|涪陵|大渡口|江北|沙坪坝|九龙坡|南岸|北碚|綦江|大足|渝北|巴南|黔江|长寿|江津|合川|永川|南川|璧山|铜梁|潼南|荣昌|开州|梁平|武隆)/);
    return match ? match[0] : '市区';
  }

  // 4. 地址正则表达式提取（过滤垃圾词与占位符）
  const match = address.match(/(?:省|自治区)?([^省自治区]+?(?:市|自治州|地区|盟|区|县))/);
  if (match) {
    let raw = match[1];
    let clean = raw
      .replace(/市$/, '')
      .replace(/自治州$/, '')
      .replace(/地区$/, '')
      .replace(/盟$/, '')
      .replace(/县$/, '')
      .replace(/区$/, '')
      .replace(/(藏族|羌族|白族|傣族|彝族|土家族|苗族|哈尼族|壮族|回族|蒙古族|哈萨克族|柯尔克孜族)/g, '');
    let result = clean.trim();
    if (result && !result.includes("名胜") && !result.includes("风景") && !result.includes("著名") && !result.includes("观光") && !result.includes("旅游")) {
      return result;
    }
  }

  return '其他';
}

// 🚀 4.6 动态渲染城市级导航筛选胶囊 (Horizontal Scroll Pill bar)
function renderCityFilterPills(attractions, provinceName) {
  const container = document.getElementById("city-filter-container");
  if (!container) return;
  container.innerHTML = "";

  if (!attractions || attractions.length === 0) {
    container.style.display = "none";
    return;
  }
  container.style.display = "flex";

  const cityCounts = { "全部": attractions.length };
  const cities = [];

  attractions.forEach(attr => {
    const city = getAttractionCity(attr, provinceName);
    cityCounts[city] = (cityCounts[city] || 0) + 1;
    if (!cities.includes(city)) {
      cities.push(city);
    }
  });

  // 按照景点数量降序排列城市胶囊，如果有“其他”则固定放在最后
  cities.sort((a, b) => {
    if (a === "其他") return 1;
    if (b === "其他") return -1;
    return cityCounts[b] - cityCounts[a];
  });

  // 创建“全部”胶囊
  const allPill = document.createElement("div");
  allPill.className = `city-pill ${selectedCityFilter === "全部" ? "active" : ""}`;
  allPill.innerHTML = `全部 <span class="city-pill-count">${attractions.length}</span>`;
  allPill.addEventListener("click", () => {
    selectedCityFilter = "全部";
    currentAttractionPage = 1;
    document.querySelectorAll(".city-pill").forEach(p => p.classList.remove("active"));
    allPill.classList.add("active");
    renderAttractionList(attractions);
  });
  container.appendChild(allPill);

  // 创建各城市专属胶囊
  cities.forEach(city => {
    const pill = document.createElement("div");
    pill.className = `city-pill ${selectedCityFilter === city ? "active" : ""}`;
    pill.innerHTML = `${city} <span class="city-pill-count">${cityCounts[city]}</span>`;
    pill.addEventListener("click", () => {
      selectedCityFilter = city;
      currentAttractionPage = 1;
      document.querySelectorAll(".city-pill").forEach(p => p.classList.remove("active"));
      pill.classList.add("active");
      renderAttractionList(attractions);
    });
    container.appendChild(pill);
  });
}

// 格式化景区星级标识为数字化表示 (例如: 国家AAAAA级旅游景区 -> 5A景区)
function formatAttractionLevel(level) {
  if (!level) return "常规景区";
  // 使用负向后瞻正则，防止匹配已替换数字后面的 A
  let formatted = level.replace(/(?<![0-9])A+/g, (match) => {
    if (match.length === 5) return "5A";
    if (match.length === 4) return "4A";
    if (match.length === 3) return "3A";
    if (match.length === 2) return "2A";
    if (match.length === 1) return "1A";
    return match;
  });
  
  formatted = formatted
    .replace(/国家5A级旅游景区/g, "5A景区")
    .replace(/国家4A级旅游景区/g, "4A景区")
    .replace(/国家3A级旅游景区/g, "3A景区")
    .replace(/5A级景区/g, "5A景区")
    .replace(/4A级景区/g, "4A景区")
    .replace(/3A级景区/g, "3A景区")
    .replace(/5A级/g, "5A")
    .replace(/4A级/g, "4A")
    .replace(/3A级/g, "3A");
  return formatted;
}

// 5. 渲染景点列表 (按评分降序默认排序，超10条分页 - 适配高端设计)
function renderAttractionList(attractions, containerId = "attractions-list-container") {
  const container = document.getElementById(containerId);
  container.innerHTML = "";

  if (!attractions || attractions.length === 0) {
    container.innerHTML = `<div class="empty-state" style="padding:20px; border:none; margin:0;">暂无相关景点数据</div>`;
    if (containerId === "attractions-list-container") {
      const countEl = document.getElementById("attractions-count");
      if (countEl) countEl.textContent = "0";
      const paginationContainer = document.getElementById("attractions-pagination");
      if (paginationContainer) paginationContainer.style.display = "none";
    }
    return;
  }

  let sortedAttractions = [...attractions];
  if (containerId === "attractions-list-container") {
    // 🚀 应用城市级过滤
    if (selectedCityFilter !== "全部") {
      sortedAttractions = sortedAttractions.filter(attr => getAttractionCity(attr, currentSelectedProvince) === selectedCityFilter);
    }

    // 🚀 默认按星级评分从高到低排序 (极致简化)
    sortedAttractions.sort((a, b) => b.rating - a.rating);

    const countEl = document.getElementById("attractions-count");
    if (countEl) {
      countEl.textContent = sortedAttractions.length;
    }
  }

  // 🚀 分页控制
  let paginatedAttractions = sortedAttractions;
  const ITEMS_PER_PAGE = 10;
  if (containerId === "attractions-list-container") {
    const totalItems = sortedAttractions.length;
    if (totalItems > ITEMS_PER_PAGE) {
      const startIndex = (currentAttractionPage - 1) * ITEMS_PER_PAGE;
      const endIndex = startIndex + ITEMS_PER_PAGE;
      paginatedAttractions = sortedAttractions.slice(startIndex, endIndex);
      renderPagination(totalItems, ITEMS_PER_PAGE, currentAttractionPage, attractions);
    } else {
      const paginationContainer = document.getElementById("attractions-pagination");
      if (paginationContainer) paginationContainer.style.display = "none";
    }
  }

  paginatedAttractions.forEach((attr, index) => {
    const card = document.createElement("div");
    card.className = "attraction-card";
    
    // 计算全局绝对索引以适配多页时的徽章显示
    const absoluteIndex = containerId === "attractions-list-container" 
      ? (currentAttractionPage - 1) * ITEMS_PER_PAGE + index 
      : index;

    let rankClass = "rank-other";
    if (absoluteIndex === 0) rankClass = "rank-top1";
    else if (absoluteIndex === 1) rankClass = "rank-top2";
    else if (absoluteIndex === 2) rankClass = "rank-top3";
    
    const isFav = favorites.some(f => f.id === attr.id);
    const hasPublicRating = Number(attr.rating) > 0;
    const realCommentCount = attr.source_evidence?.commentCount || attr.reviewsCount || '';
    const commentCountText = String(realCommentCount).trim();
    const sourcePlatform = attr.source_evidence?.ratingSource?.platform || '';
    const legacyAmapSource = /^amap/i.test(String(attr.source_evidence?.source || ''));
    const ratingPlatformText = /高德/.test(`${commentCountText}${sourcePlatform}`) || legacyAmapSource ? '高德地图' : '';
    const reviewCountStr = ratingPlatformText || !commentCountText || /暂无|未公开|无公开|官方认证/.test(commentCountText)
      ? (ratingPlatformText || '暂无公开评价')
      : (/(评价|点评)$/.test(commentCountText) ? commentCountText : `${commentCountText.replace(/条$/, '')}条评价`);
    const formattedLevel = formatAttractionLevel(attr.level);
    const heritageStr = (formattedLevel.includes("5A") || attr.level.includes("世界文化遗产")) ? "世界文化遗产" : "国家级风景区";
    const searchProvince = attr.provinceName || "";
    const searchCity = attr.city && attr.city !== searchProvince ? attr.city : "";
    const searchLocationText = searchProvince
      ? [searchProvince, searchCity].filter(Boolean).join(" · ")
      : "";
    const searchLocationBadge = searchLocationText
      ? `<span class="card-location-badge" title="${searchLocationText}"><span aria-hidden="true">📍</span>${searchLocationText}</span>`
      : "";
    
    card.innerHTML = `
      <div class="card-img-wrapper">
        <img class="card-img" src="${attr.image}" loading="lazy" decoding="async" referrerpolicy="no-referrer" alt="${attr.name}">
        <div class="rank-badge ${rankClass}">${absoluteIndex + 1}</div>
      </div>
      <div class="card-info">
        <div class="card-title-row">
          <h4 class="card-name">${attr.name}</h4>
        </div>
        <div class="card-badges-row">
          ${searchLocationBadge}
          <span class="card-badge-level">${formattedLevel}</span>
          <span class="card-badge-heritage">${heritageStr}</span>
        </div>
        <div class="card-rating-row">
          <span class="card-rating-star">${hasPublicRating ? `★ ${Number(attr.rating).toFixed(1)}` : '暂无公开评分'}</span>
          </div>
        <p class="card-excerpt">“${attr.intro}”</p>
      </div>
      <div class="fav-btn ${isFav ? 'active' : ''}" data-id="${attr.id}" title="${isFav ? '取消收藏' : '加入收藏'}">
        <svg viewBox="0 0 24 24">
          <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
        </svg>
      </div>
    `;

    card.addEventListener("click", (e) => {
      if (e.target.closest(".fav-btn")) {
        e.stopPropagation();
        toggleFavorite(attr);
        return;
      }
      openDetailModal(attr);
    });

    container.appendChild(card);
  });
}

// 🚀 智能分页器渲染函数
function renderPagination(totalItems, itemsPerPage, currentPage, rawAttractions) {
  const container = document.getElementById("attractions-pagination");
  if (!container) return;

  const totalPages = Math.ceil(totalItems / itemsPerPage);
  if (totalPages <= 1) {
    container.style.display = "none";
    return;
  }

  container.style.display = "flex";
  if (window.innerWidth <= 768) {
    container.style.justifyContent = "flex-start";
    container.style.flexWrap = "nowrap";
    container.style.overflowX = "auto";
    container.style.width = "100%";
    container.style.boxSizing = "border-box";
  } else {
    container.style.justifyContent = "center";
    container.style.flexWrap = "nowrap";
    container.style.overflowX = "visible";
    container.style.width = "auto";
  }
  container.innerHTML = "";

  // 1. 上一页
  const prevBtn = document.createElement("button");
  prevBtn.className = `page-btn ${currentPage === 1 ? 'disabled' : ''}`;
  prevBtn.innerHTML = "‹";
  if (currentPage > 1) {
    prevBtn.addEventListener("click", () => {
      currentAttractionPage = currentPage - 1;
      const listScrollEl = document.getElementById("attractions-list-container");
      if (listScrollEl) listScrollEl.scrollTop = 0;
      renderAttractionList(rawAttractions);
    });
  }
  container.appendChild(prevBtn);

  // 2. 页码按钮 (滑动窗口)
  const maxVisiblePages = 9;
  let startPage = Math.max(1, currentPage - Math.floor(maxVisiblePages / 2));
  let endPage = startPage + maxVisiblePages - 1;
  
  if (endPage > totalPages) {
    endPage = totalPages;
    startPage = Math.max(1, endPage - maxVisiblePages + 1);
  }

  if (startPage > 1) {
    const firstBtn = document.createElement("button");
    firstBtn.className = "page-btn";
    firstBtn.textContent = 1;
    firstBtn.addEventListener("click", () => {
      currentAttractionPage = 1;
      document.getElementById("attractions-list-container").scrollTop = 0;
      renderAttractionList(rawAttractions);
    });
    container.appendChild(firstBtn);
    if (startPage > 2) {
      const ellipsis = document.createElement("span");
      ellipsis.textContent = "...";
      ellipsis.style.margin = "0 4px";
      container.appendChild(ellipsis);
    }
  }

  for (let i = startPage; i <= endPage; i++) {
    const pageBtn = document.createElement("button");
    pageBtn.className = `page-btn ${i === currentPage ? 'active' : ''}`;
    pageBtn.textContent = i;
    pageBtn.addEventListener("click", () => {
      if (i === currentPage) return;
      currentAttractionPage = i;
      const listScrollEl = document.getElementById("attractions-list-container");
      if (listScrollEl) listScrollEl.scrollTop = 0;
      renderAttractionList(rawAttractions);
    });
    container.appendChild(pageBtn);
  }

  if (endPage < totalPages) {
    if (endPage < totalPages - 1) {
      const ellipsis = document.createElement("span");
      ellipsis.textContent = "...";
      ellipsis.style.margin = "0 4px";
      container.appendChild(ellipsis);
    }
    const lastBtn = document.createElement("button");
    lastBtn.className = "page-btn";
    lastBtn.textContent = totalPages;
    lastBtn.addEventListener("click", () => {
      currentAttractionPage = totalPages;
      document.getElementById("attractions-list-container").scrollTop = 0;
      renderAttractionList(rawAttractions);
    });
    container.appendChild(lastBtn);
  }

  // 3. 下一页
  const nextBtn = document.createElement("button");
  nextBtn.className = `page-btn ${currentPage === totalPages ? 'disabled' : ''}`;
  nextBtn.innerHTML = "›";
  if (currentPage < totalPages) {
    nextBtn.addEventListener("click", () => {
      currentAttractionPage = currentPage + 1;
      const listScrollEl = document.getElementById("attractions-list-container");
      if (listScrollEl) listScrollEl.scrollTop = 0;
      renderAttractionList(rawAttractions);
    });
  }
  container.appendChild(nextBtn);

  // 💡 Force style overriding for all child buttons (bypass CSS caching)
  Array.from(container.children).forEach(child => {
    if (child.tagName === 'BUTTON') {
      child.style.flexShrink = "0";
      if (window.innerWidth <= 768) {
        child.style.minWidth = "32px";
        child.style.height = "32px";
        child.style.fontSize = "13px";
        child.style.padding = "0 4px";
      }
    }
  });
}

function getNumericPrice(priceText) {
  if (!priceText || priceText.includes("免费") || priceText.includes("免门票")) {
    return 0;
  }
  const match = priceText.match(/\d+/);
  return match ? parseInt(match[0]) : 0;
}

// 6. 搜索输入处理
async function handleSearch(query) {
  if (!query) {
    if (currentSelectedProvince) {
      selectProvince(currentSelectedProvince);
    } else {
      document.getElementById("panel-empty").style.display = "flex";
      document.getElementById("panel-destination").style.display = "none";
    }
    return;
  }

  try {
    const queryClean = query.trim().toLowerCase();
    const exactProvince = Object.values(window.tourismData || {}).find((province) =>
      [province.province, province.name, province.id]
        .filter(Boolean)
        .some((value) => String(value).trim().toLowerCase() === queryClean),
    );
    if (exactProvince) {
      selectProvince(exactProvince.province);
      return;
    }

    const searchIndex = await fetchJson(`/data/search-index.json?v=${STATIC_DATA_VERSION}`);
    const foundAttractions = searchIndex
      .filter((attraction) => [
        attraction.province,
        attraction.provinceId,
        attraction.name,
        attraction.city,
        attraction.level,
        attraction.intro,
        attraction.address,
        ...(Array.isArray(attraction.tags) ? attraction.tags : []),
      ].some((value) => String(value || "").toLowerCase().includes(queryClean)))
      .map((attraction) => ({ ...attraction, provinceName: attraction.province }));

    selectedCityFilter = "全部";
    currentAttractionPage = 1;
    const filterBar = document.getElementById("city-filter-container");
    if (filterBar) filterBar.style.display = "none";

    document.getElementById("panel-empty").style.display = "none";
    document.getElementById("panel-destination").style.display = "flex";
    document.getElementById("dest-img").src = "/assets/images/china_relief_map.png";
    document.getElementById("dest-title").textContent = `搜索: "${query}"`;
    document.getElementById("dest-desc").textContent = `在全国静态数据中检索到 ${foundAttractions.length} 个相关景点。`;
    document.getElementById("dest-weather-temp").textContent = "--";
    document.getElementById("dest-weather-cond").textContent = "全国搜索模式";
    document.getElementById("dest-tags-list").innerHTML = `<span class="dest-tag" style="background:var(--accent-teal);color:#fff;">本地快速检索</span>`;
    renderAttractionList(foundAttractions);
  } catch (err) {
    console.error("Static search error:", err);
    showToast("⚠️ 搜索索引加载失败，请刷新页面重试");
  }
}

// 7. 收藏夹核心逻辑（浏览器本机持久化）

async function toggleFavorite(attraction) {
  const index = favorites.findIndex(f => f.id === attraction.id);
  const isAdding = index === -1;
  
  if (isAdding) {
    const newFavItem = {
      id: attraction.id,
      name: attraction.name,
      image: attraction.image,
      level: attraction.level,
      rating: Number(attraction.rating) > 0 ? Number(attraction.rating) : 0,
      intro: attraction.intro || "已收藏景点",
      price: attraction.price || "免费",
      route: attraction.route || "",
      reviews: attraction.reviews || [],
      provinceId: attraction.provinceId || currentSelectedProvince || attraction.provinceName || 'china'
    };
    
    favorites.push(newFavItem);
    showToast(`💖 已收藏 【${attraction.name}】（保存在本机）`);
  } else {
    favorites.splice(index, 1);
    showToast(`💔 已取消收藏 【${attraction.name}】`);
  }

  saveLocalFavorites();
  updateFavoritesCount();
  renderFavoritesList();

  document.querySelectorAll(`.fav-btn[data-id="${attraction.id}"]`).forEach(btn => {
    btn.classList.toggle("active", isAdding);
  });
}

// 更新收藏数量
function updateFavoritesCount() {
  const count = favorites.length;
  document.getElementById("fav-badge").textContent = count;
  document.getElementById("fav-count").textContent = count;
}

// 显示收藏面板
function showFavoritesSidebar() {
  const panel = document.getElementById("favorites-panel");
  panel.classList.add("active");
  renderFavoritesList();
}

// 渲染收藏列表
function renderFavoritesList() {
  renderAttractionList(favorites, "favorites-list-container");
}

// 8. 详情弹窗逻辑
async function openDetailModal(attraction) {
  // =========================================================
  // 🚀 高智能商用级【数据沙箱与真拟合拦截器】 (Data Sanitizer & Synthesizer)
  // =========================================================
  const detailedAttraction = await loadAttractionDetailData(attraction);
  if (detailedAttraction) {
    attraction = { ...attraction, ...detailedAttraction };
  }

  // 如果是收藏夹等轻量对象，尝试从 window.tourismData 补全 guide_data，如果不存在则懒加载对应省份数据
  let found = (attraction.guide_data || attraction.openHours || attraction.route || attraction.lazy_routes) ? attraction : null;
  if (!found && window.tourismData) {
    for (const pName in window.tourismData) {
      const pData = window.tourismData[pName];
      if (pData && pData.attractions) {
        found = pData.attractions.find(a => a.id === attraction.id || a.name === attraction.name);
        if (found) break;
      }
    }
  }

  if (!found) {
    let provName = "";
    if (attraction.provinceId) {
      for (const pName in window.tourismData) {
        if (window.tourismData[pName].id === attraction.provinceId || pName === attraction.provinceId) {
          provName = pName;
          break;
        }
      }
    }
    if (!provName && attraction.city) {
      provName = cityToProvince[attraction.city] || "";
    }
    if (provName && window.tourismData[provName]) {
      if (!window.tourismData[provName].attractions) {
        try {
          const provinceDetail = await loadProvinceListData(provName);
          window.tourismData[provName] = provinceDetail;
          found = provinceDetail.attractions.find(a => a.id === attraction.id || a.name === attraction.name);
        } catch (e) {
          console.error("Failed to fetch province details in modal lookup:", e);
        }
      }
    }
  }

  if (found) {
    attraction = found;
  }

  const isMountain = /(山|峰|岳|岭|谷|岩|洞|大峡谷|关)/.test(attraction.name);
  const isWater = /(湖|江|河|海|岛|湾|瀑布|湿地|溪|滩|泉)/.test(attraction.name);
  const city = attraction.city || "景区";

  // 1. 物理拦截与过滤地址、避坑贴士、路线中残留的江西庐山牯岭镇模板旧数据
  if (attraction.address && attraction.address.includes("牯岭镇") && !attraction.name.includes("庐山")) {
    attraction.address = `${city}市周边核心旅游景区开发区`;
  }
  if (attraction.tips && (attraction.tips.includes("牯岭镇") || attraction.tips.includes("避暑山庄")) && !attraction.name.includes("庐山")) {
    attraction.tips = `建议提前1-2天在线上实名预约【${attraction.name}】的门票。旺季时建议早起避开排队，多乘坐观光接驳车，节省腿部体力。`;
  }
  if (attraction.route && (attraction.route.includes("牯岭镇") || attraction.route.includes("A -> B") || attraction.route.includes("A->B"))) {
    attraction.route = isMountain 
      ? "正门入口 -> 接驳观光车 -> 索道上山 -> 核心主峰 -> 观景台 -> 索道下山 -> 步行出口"
      : (isWater ? "游客码头 -> 豪华画舫游湖 -> 精华湖心岛 -> 环湖长廊 -> 出口" : "主入口 -> 核心地标打卡 -> 园林幽径 -> 出口");
  }

  // 2. 物理判定未爬取(Dirty)景点的假字段泄漏，智能本地真实场景拟合灌注
  const hasMockLeaked = !attraction.guide_clothing || 
                        attraction.guide_clothing.includes("牯岭镇") || 
                        attraction.guide_clothing.includes("避暑山庄") ||
                        (attraction.guide_food && attraction.guide_food.includes("牯岭镇"));

  if (hasMockLeaked && !attraction.name.includes("庐山")) {
    // 穿衣指南真实场景拟合
    attraction.guide_clothing = `【四季穿搭】景区四季气候温和，温差适中。春秋季出行建议携带轻薄防风外套；夏季日照充足，强烈建议备好物理防晒帽、墨镜及遮阳伞；由于步行游览较多，【核心提示】必须穿一双平底防滑运动鞋，保证出行安全。`;
    
    // 美食真实场景拟合
    let f1 = isMountain ? "高山滋补土鸡" : "招牌清蒸湖鲜";
    let f2 = isMountain ? "极鲜山珍清汤" : "地道特色全鱼宴";
    let f3 = "招牌文创雪糕";
    if (city && city !== "景区") {
      f1 = `${city}特色招牌菜`;
      f2 = `${city}正宗地方风味`;
    }
    attraction.guide_food = `【舌尖美味】强烈推荐：1. ${f1}（本地精选爆款，肥嫩多汁）；2. ${f2}（本地特色美食强烈推荐）；3. ${f3}（拍照打卡特色消暑利器）。建议错开饭点高峰期，在景区周边商圈老字号享用更地道。`;
    
    // 住宿真实场景拟合
    let primaryHotel = isMountain ? '山脚服务区/品质连锁酒店' : '核心景区大门周边';
    let secondaryHotel = isMountain ? '半山观景度假民宿' : '景区周边临水特色客栈';
    attraction.guide_housing = `【住宿优选】首选住在【${primaryHotel}】，各类生活配套完善，出行、购物及餐饮极方便；如想深入体验自然特色，建议入住【${secondaryHotel}】，环境清幽安静，可饱览壮丽日出。`;
    
    // 交通真实场景拟合
    attraction.guide_transport = `【交通出行】首选推荐搭乘公共交通/地铁/大巴直达景区正门。自驾游旅客请导航至景区官方停车场，在节假日期间注意提早出行以避开拥堵路段。`;
    
    // 懒人攻略必须来自数据库中的真实路线字段，不在前端自动合成。
  }

  currentSelectedAttraction = attraction;

  const modalImage = document.getElementById("modal-img");
  modalImage.src = attraction.image;
  modalImage.alt = attraction.name;

  const imageCredit = document.getElementById("modal-image-credit");
  const imageSource = attraction.image_source;
  if (imageSource?.sourceUrl) {
    imageCredit.textContent = `图片：${imageSource.author || imageSource.provider} · ${imageSource.license || "查看来源"}`;
    imageCredit.href = imageSource.sourceUrl;
    imageCredit.hidden = false;
  } else {
    imageCredit.textContent = "";
    imageCredit.removeAttribute("href");
    imageCredit.hidden = true;
  }
  document.getElementById("modal-title").textContent = attraction.name;
  document.getElementById("modal-level").textContent = formatAttractionLevel(attraction.level);
  document.getElementById("modal-hotness").textContent = attraction.hotness || "⭐⭐⭐⭐⭐";
  document.getElementById("modal-intro").textContent = attraction.intro || "暂无介绍";
  const hoursVal = attraction.openHours || "详见景区公告";
  const priceVal = attraction.price || "免费";
  const addressVal = attraction.address || "详见定位";

  const hoursEl = document.getElementById("modal-hours");
  const priceEl = document.getElementById("modal-price");
  const addressEl = document.getElementById("modal-address");

  hoursEl.textContent = hoursVal;
  priceEl.textContent = priceVal;
  addressEl.textContent = addressVal;

  if (hoursEl.closest('.meta-item')) hoursEl.closest('.meta-item').setAttribute('data-tooltip', hoursVal);
  if (priceEl.closest('.meta-item')) priceEl.closest('.meta-item').setAttribute('data-tooltip', priceVal);
  if (addressEl.closest('.meta-item')) addressEl.closest('.meta-item').setAttribute('data-tooltip', addressVal);

  const sourceNames = getAttractionSourceNames(attraction);
  const sourceText = sourceNames.length ? sourceNames.join(" / ") : "高德地图";
  const sourcePill = document.getElementById("modal-source-pill");
  if (sourcePill) sourcePill.textContent = sourceNames[0] || "高德数据";
  const dataSourceEl = document.getElementById("modal-data-source");
  if (dataSourceEl) dataSourceEl.textContent = sourceText;
  const infoLevelEl = document.getElementById("modal-info-level");
  if (infoLevelEl) infoLevelEl.textContent = formatAttractionLevel(attraction.level);
  const phoneEl = document.getElementById("modal-phone");
  if (phoneEl) phoneEl.textContent = attraction.tel || attraction.phone || "详见景区公告";
  const durationEl = document.getElementById("modal-duration");
  if (durationEl) durationEl.textContent = inferVisitDuration(attraction);
  const bestSeasonEl = document.getElementById("modal-best-season");
  if (bestSeasonEl) bestSeasonEl.textContent = inferBestSeason(attraction);
  const featureSummaryEl = document.getElementById("modal-feature-summary");
  if (featureSummaryEl) featureSummaryEl.textContent = getFeatureSummary(attraction);
  const sourceUpdatedEl = document.getElementById("modal-source-updated");
  if (sourceUpdatedEl) sourceUpdatedEl.textContent = getSourceUpdatedText(attraction);
  const basicTipEl = document.getElementById("modal-basic-tip");
  if (basicTipEl) basicTipEl.textContent = attraction.tips || "建议结合景区公告、实时交通和现场开放情况安排行程。";
  renderModalFeatureTags(attraction);

  // ==========================================
  // 🌟 动态渲染【热门子景点】(sub_spots) 画廊
  // ==========================================
  const subspotsContainer = document.getElementById("modal-subspots-container");
  const subspotsPill = document.getElementById("modal-subspots-count-pill");
  const subspotsGrid = document.getElementById("modal-subspots-grid");
  if (subspotsContainer && subspotsGrid) {
    if (attraction.sub_spots && Array.isArray(attraction.sub_spots) && attraction.sub_spots.length > 0) {
      if (subspotsPill) subspotsPill.textContent = `${attraction.sub_spots.length} 处精选`;
      subspotsGrid.setAttribute("data-count", String(Math.min(attraction.sub_spots.length, 6)));
      subspotsGrid.innerHTML = attraction.sub_spots.map(s => `
        <div class="subspot-cell-card" data-name="${escapeHtml(s.name)}" data-img="${escapeHtml(s.image)}" onclick="viewSubspotLargeImage(this.dataset.name, toHighResImageUrl(this.dataset.img))">
          <div class="subspot-img-box">
            <img src="${escapeHtml(s.image)}" alt="${escapeHtml(s.name)}" loading="lazy">
          </div>
          <div class="subspot-cell-name">${escapeHtml(s.name)}</div>
        </div>
      `).join('');
      subspotsContainer.style.display = "block";
    } else {
      subspotsContainer.style.display = "none";
      subspotsGrid.innerHTML = "";
    }
  }


  const scorePanel = document.getElementById("score-chart-panel");
  const scoreKeys = ["scenery", "traffic", "cost", "service", "crowd"];
  const hasRealScores = attraction.scores && scoreKeys.every(key => Number.isFinite(Number(attraction.scores[key])) && Number(attraction.scores[key]) > 0);
  if (scorePanel) {
    scorePanel.style.display = hasRealScores ? "flex" : "none";
  }
  // ==========================================
  // 重构 1：高保真【旅行指南】(衣食住行) 动态渲染
  // ==========================================
  const guideContainer = document.getElementById("guide-strip-container");
  if (guideContainer) {
    const isMountain = /(山|峰|岳|岭|谷|岩|洞|大峡谷)/.test(attraction.name);
    const isWater = /(湖|江|河|海|岛|湾|瀑布|湿地|溪)/.test(attraction.name);

    // 智能推断与提取物理信息
    const clothesVal = attraction.guide_clothing || "";
    const foodVal = attraction.guide_food || "";
    const housingVal = attraction.guide_housing || "";
    const transportVal = attraction.guide_transport || "";

    // 1. 穿衣指南季节与建议
    let springTemp = "10-20°C，早晚温差大";
    let springDesc = "建议：薄外套+长裤+运动鞋";
    let summerTemp = "20-28°C，多雨多雾";
    let summerDesc = "建议：速干衣+防晒用品+轻便鞋";
    let winterTemp = "-5-8°C，部分路段结冰";
    let winterDesc = "建议：羽绒服+保暖内衣+防滑鞋";
    let clothingTips = ["建议采用洋葱式穿衣法", "随身携带一件防风外套", "穿着厚底防滑登山鞋/运动鞋"];
    
    if (isMountain) {
      springTemp = "6-15°C，山顶风力大";
      springDesc = "建议：冲锋衣+保暖外套+防风帽";
      summerTemp = "15-24°C，山区气候多变";
      summerDesc = "建议：速干衣+防雨外套+备用袜";
      winterTemp = "-10-2°C，山顶气温极低";
      winterDesc = "建议：重度防寒羽绒服+手套+冰爪";
      clothingTips = ["山顶温度比山下低5-8°C", "防滑登山鞋/厚底鞋是安全前提", "千万别穿平底皮鞋或细高跟"];
    } else if (isWater) {
      springTemp = "12-22°C，水面体感偏凉";
      springDesc = "建议：长袖防风衫+薄长裤+防滑鞋";
      summerTemp = "22-31°C，日光折射极强";
      summerDesc = "建议：防晒服+遮阳帽+遮阳镜+拖鞋";
      winterTemp = "0-8°C，冷风刺骨";
      winterDesc = "建议：防风大衣+围巾+防冻手套";
      clothingTips = ["高倍数防晒霜与防蚊液是刚需", "拍照出片建议穿色彩鲜艳的长裙", "备一双备用鞋袜以防玩水弄湿"];
    }
    if (clothesVal) clothingTips.unshift(clothesVal);

    // 2. 交通出行
    let localStations = attraction.name.includes("庐山") ? "庐山站、九江站" : (attraction.city ? `${attraction.city}站、${attraction.city}东站` : "周边高铁/枢纽站");
    let trainStation = `推荐到达：${localStations}，出站后可乘大巴/打车前往景区`;
    let driveTip = `导航 “${attraction.name}”，山路弯道多，注意安全驾驶`;
    let busPrice = "覆盖主要景点，省时省力。票价：70元/人（七日内有效）";
    let cableTip = "可直达山顶，节省体力。旺季排队时间较长";
    let walkTip = "适合体力较好者。部分路段较陡，注意安全";
    
    let transportTips = ["旺季景区内停车困难", "索道旺季排队时间长", "山区打车较困难", "不建议完全徒步游览"];
    if (transportVal) transportTips.unshift(transportVal);

    // 3. 住宿建议 (Strict Dynamic Binding)
    let hotelAreas = [];
    let price1 = "150-300元", price2 = "300-600元", price3 = "600元以上";
    let housingTips = ["旺季房源紧张，建议提前预订", "节假日热门酒店容易满房", "部分客栈条件有限，谨慎选择"];
    if (isMountain) housingTips.push("山间/山顶温差大，注意保暖");

    if (housingVal) {
      housingTips.unshift(housingVal);
      // 优先按照新版爬虫的 "|" 进行严格切分，否则兼容旧版的标点切分
      let splitRegex = housingVal.includes('|') ? /\|/ : /[，、；。.]+/;
      const parts = housingVal.replace(/【[^】]+】/g, "").split(splitRegex).map(p => p.trim()).filter(p => p.length >= 2);
      
      const descPool = [
        "配套完善，餐饮购物便利，出行首选",
        "环境舒适，住宿体验极佳，特色推荐",
        "价格亲民，性价比高，适合预算有限游客",
        "交通枢纽周边，商圈核心地带"
      ];
      
      parts.forEach((p, idx) => {
        if (idx < 3) {
           let tag = idx === 0 ? "首选" : (idx === 1 ? "特色" : "经济");
           let img = `assets/images/dynamic_hotel_${encodeURIComponent(p.substring(0,15))}.jpg?v=${STATIC_DATA_VERSION}`;
           hotelAreas.push({ name: p.length > 18 ? p.substring(0, 18) + '...' : p, tag, desc: descPool[idx], img });
        }
      });
    }



    // 4. 餐饮特色 (Strict Dynamic Binding)
    let foodsList = [];
    let foodTips = ["景区内餐厅建议错峰用餐", "旺季建议提前预订餐厅", "部分路段餐饮选择较少"];
    if (isMountain) foodTips.unshift("山顶餐饮价格偏高，建议自带干粮");

    if (foodVal) {
      foodTips.unshift(foodVal);
      let splitRegex = foodVal.includes('|') ? /\|/ : /[，、；。.]+/;
      const parts = foodVal.replace(/【[^】]+】/g, "").split(splitRegex).map(p => p.trim()).filter(p => p.length > 1);
      
      const descPool = [
        "地道招牌，风味绝佳，强烈推荐",
        "本地传统特色，经典必尝",
        "特色风味小吃，打卡首选",
        "人气美食，不可错过"
      ];
      
      parts.forEach((p, idx) => {
        if (idx < 3) {
           let img = `assets/images/dynamic_food_${encodeURIComponent(p.substring(0,15))}.jpg?v=${STATIC_DATA_VERSION}`;
           foodsList.push({ name: p.length > 15 ? p.substring(0, 15) + '...' : p, desc: descPool[idx], img });
        }
      });
    }


    
    let primaryDining = isMountain ? "景区索道口/山顶服务区" : "景区正门周边区域";
    if (housingVal && housingVal.includes("区")) {
      const match = housingVal.match(/([^，、；。\s]+区)/);
      if (match) primaryDining = match[1] + " (首选)";
    } else if (attraction.city) {
      primaryDining = attraction.city + "区/周边商圈";
    }
    
    let diningAreas = [primaryDining, "景区内指定餐饮服务区"];
    // (Duplicate foodTips declaration removed)

    // 清空超长爬取文本导致的视觉溢出，仅显示精短干货，超长文移至小贴士中
    const cleanupTips = (tips) => {
      return tips.map(t => {
        let clean = t.replace(/【[^】]+】/g, "").trim();
        if (clean.length > 38) clean = clean.substring(0, 36) + "...";
        return clean;
      }).filter(t => t.length > 2);
    };

    const cleanClothingTips = cleanupTips(clothingTips);
    const cleanTransportTips = cleanupTips(transportTips);
    const cleanHousingTips = cleanupTips(housingTips);
    const cleanFoodTips = cleanupTips(foodTips);

    
    
    const escGuide = (value = "") => String(value ?? "").replace(/[&<>"']/g, ch => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[ch]));

    if (attraction.guide_data) {
      const gd = attraction.guide_data;
      const guideNoiseRe = /20\d{2}[-/]\d{1,2}[-/]\d{1,2}|小红书|笔记|点赞|评论|自由的白|丸子小姐|等烟雨|现实版|民宿合集|汇景轻奢|闯入|必冲|保姆级|攻略图|姐妹们|家人们|住行整理|实用指南|衣食住行|^m\s*以下/;
      const cleanGuideText = (value, fallback = "") => {
        const raw = String(value || "").replace(/\s+/g, " ").trim();
        if (!raw || guideNoiseRe.test(raw)) return fallback;
        return raw;
      };
      const rawClothingGuide = gd.clothing || {};
      const rawTransportGuide = gd.transport || {};
      const rawSpecialGuide = gd.special_care || {};
      const clothingGuide = {
        spring_autumn: cleanGuideText(rawClothingGuide.spring_autumn, springDesc),
        summer: cleanGuideText(rawClothingGuide.summer, summerDesc),
        winter: cleanGuideText(rawClothingGuide.winter, winterDesc),
        tips: cleanGuideText(rawClothingGuide.tips, cleanClothingTips.join(" ｜ "))
      };
      const transportGuide = {
        external_arrive: cleanGuideText(rawTransportGuide.external_arrive, trainStation.replace("推荐到达：", "")),
        internal_arrive: cleanGuideText(rawTransportGuide.internal_arrive, driveTip.replace("导航", "")),
        internal_traffic: cleanGuideText(rawTransportGuide.internal_traffic, isMountain ? cableTip : busPrice),
        tips: cleanGuideText(rawTransportGuide.tips, cleanTransportTips.join(" ｜ "))
      };
      const specialGuide = {
        elderly: cleanGuideText(rawSpecialGuide.elderly, "少走路、避开高峰，优先选择交通便利和休息点充足的线路。"),
        children: cleanGuideText(rawSpecialGuide.children, "注意补水防晒，行程放松，避开过长步行和拥挤时段。")
      };
      const housingGuide = Array.isArray(gd.housing) && gd.housing.length
        ? gd.housing.slice(0, 2).map((h, idx) => ({
          area: cleanGuideText(h?.area, idx === 0 ? "推荐住宿" : `推荐区域${idx + 1}`),
          desc: cleanGuideText(h?.desc, "优先选择景区周边或交通便利区域，方便往返和用餐。")
        }))
        : [{ area: "推荐住宿", desc: "优先选择景区周边或交通便利区域，方便往返和用餐。" }];
      const rawFoodGuide = Array.isArray(gd.food) && gd.food.length
        ? gd.food.map(item => cleanGuideText(item, "")).filter(Boolean).slice(0, 8)
        : cleanFoodTips.slice(0, 6);
      const foodGuide = rawFoodGuide.length ? rawFoodGuide : cleanFoodTips.slice(0, 6);

      const realHotelAreas = housingGuide.map((h, idx) => {
        let tag = idx === 0 ? "首选" : (idx === 1 ? "特色" : "经济");
        let img = `assets/images/dynamic_hotel_${encodeURIComponent((h.area || "").substring(0,15))}.jpg?v=${STATIC_DATA_VERSION}`;
        return { name: h.area || `推荐区域${idx + 1}`, tag, desc: h.desc || "交通便利", img };
      });

      const realFoodsList = foodGuide.slice(0, 3).map((f, idx) => {
        let desc = idx === 0 ? "地道招牌，风味绝佳" : (idx === 1 ? "本地传统特色，必尝" : "特色小吃，打卡首选");
        let img = `assets/images/dynamic_food_${encodeURIComponent(f.substring(0,15))}.jpg?v=${STATIC_DATA_VERSION}`;
        return { name: f, desc, img };
      });

      const realHousingTips = ["旺季房源紧张，建议提前预订", "节假日热门酒店容易满房", "部分客栈条件有限，谨慎选择"];
      if (isMountain) realHousingTips.push("山间温差大，注意夜间保暖");
      
      const realFoodTips = ["景区内餐厅建议错峰用餐", "热门美食街注意防范拥挤", "部分路段餐饮选择较少", "海鲜或特产购买前先询价"];
      const guideCard = (icon, title, desc, tone = "blue") => `
        <div class="guide-lite-card">
          <span class="guide-lite-card-icon guide-lite-icon-${tone}">${icon}</span>
          <div class="guide-lite-card-copy">
            <span class="guide-lite-card-title">${escGuide(title)}</span>
            <span class="guide-lite-card-desc">${escGuide(desc)}</span>
          </div>
        </div>
      `;
      const guideTip = (icon, label, text, tone = "green") => `
        <div class="guide-lite-tip guide-lite-tip-${tone}">
          <span>${icon}</span>
          <p><strong>${escGuide(label)}</strong>${escGuide(text)}</p>
        </div>
      `;

      guideContainer.innerHTML = `
        <div class="guide-lite-wrap">
          <div class="guide-modern-section">
            <div class="guide-modern-header blue-header">
              <div class="guide-modern-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M4 8V19C4 20.1046 4.89543 21 6 21H18C19.1046 21 20 20.1046 20 19V8"/><path d="M4 8L9 3H15L20 8"/><path d="M12 3V21"/>
                </svg>
              </div>
              <h3>穿衣与出行建议</h3>
            </div>

            <div class="clothing-grid">
              <div class="clothing-card">
                <div class="clothing-icon-box" style="color: #10b981; background: #ecfdf5;">🌿</div>
                <div class="clothing-info">
                  <span class="clothing-season">春秋季节</span>
                  <span class="clothing-desc">${escGuide(clothingGuide.spring_autumn || springDesc)}</span>
                </div>
              </div>
              <div class="clothing-card">
                <div class="clothing-icon-box" style="color: #f59e0b; background: #fffbeb;">☀️</div>
                <div class="clothing-info">
                  <span class="clothing-season">夏季</span>
                  <span class="clothing-desc">${escGuide(clothingGuide.summer || summerDesc)}</span>
                </div>
              </div>
              <div class="clothing-card">
                <div class="clothing-icon-box" style="color: #3b82f6; background: #eff6ff;">❄️</div>
                <div class="clothing-info">
                  <span class="clothing-season">冬季</span>
                  <span class="clothing-desc">${escGuide(clothingGuide.winter || winterDesc)}</span>
                </div>
              </div>
            </div>

            <div class="modern-tips-banner blue-tips">
              <strong>💡 穿衣贴士：</strong> ${escGuide(clothingGuide.tips || cleanClothingTips.join(" ｜ "))}
            </div>
          </div>

          <div class="guide-modern-section">
            <div class="guide-modern-header green-header">
              <div class="guide-modern-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="4" y="6" width="16" height="11" rx="2"/><path d="M6 17V19C6 19.5523 6.44772 20 7 20C7.55228 20 8 19.5523 8 19V17"/><path d="M16 17V19C16 19.5523 16.4477 20 17 20C17.5523 20 18 19.5523 18 19V17"/><circle cx="8" cy="14" r="1"/><circle cx="16" cy="14" r="1"/>
                </svg>
              </div>
              <h3>交通出行</h3>
            </div>

            <div class="transport-grid">
              <div class="transport-card" onclick="this.classList.toggle('expanded')">
                <div class="transport-icon-box" style="color: #3b82f6; background: #eff6ff;">✈️</div>
                <div class="transport-card-text">
                  <span class="transport-card-label">外省抵达</span>
                  <span class="transport-card-desc">${escGuide(transportGuide.external_arrive || trainStation.replace("推荐到达：", ""))}</span>
                </div>
              </div>
              <div class="transport-card" onclick="this.classList.toggle('expanded')">
                <div class="transport-icon-box" style="color: #10b981; background: #ecfdf5;">🚌</div>
                <div class="transport-card-text">
                  <span class="transport-card-label">市内接驳</span>
                  <span class="transport-card-desc">${escGuide(transportGuide.internal_arrive || driveTip.replace("导航", ""))}</span>
                </div>
              </div>
              <div class="transport-card" onclick="this.classList.toggle('expanded')">
                <div class="transport-icon-box" style="color: #f59e0b; background: #fffbeb;">🚡</div>
                <div class="transport-card-text">
                  <span class="transport-card-label">内部交通</span>
                  <span class="transport-card-desc">${escGuide(transportGuide.internal_traffic || (isMountain ? cableTip : busPrice))}</span>
                </div>
              </div>
            </div>

            <div class="modern-tips-banner green-tips">
              <strong>💡 交通避坑：</strong> ${escGuide(transportGuide.tips || cleanTransportTips.join(" ｜ "))}
            </div>
          </div>

          <div class="guide-modern-section">
            <div class="guide-modern-header purple-header">
              <div class="guide-modern-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
                  <polyline points="9 22 9 12 15 12 15 22"></polyline>
                </svg>
              </div>
              <h3>住宿建议</h3>
            </div>
            
            <div class="hotel-grid">
              ${realHotelAreas.map(area => `
                <div class="transport-card" style="border-color: rgba(139, 92, 246, 0.15);">
              <div class="transport-icon-box" style="color: #8b5cf6; background: #f3e8ff;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4v16"/><path d="M2 8h18a2 2 0 0 1 2 2v10"/><path d="M2 17h20"/><path d="M6 8v9"/></svg>
              </div>
              <div class="transport-card-text" style="flex: 1;">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; width: 100%; gap: 4px;">
                  <span class="transport-card-label" style="line-height: 1.2;">${area.name.split('（')[0].split('(')[0]}</span>
                  <span style="flex-shrink: 0; font-size:10px; padding:2px 6px; border-radius:4px; background-color:${area.tag === '首选' ? 'rgba(16,185,129,0.1)' : (area.tag === '特色' ? 'rgba(59,130,246,0.1)' : 'rgba(100,116,139,0.1)')}; color:${area.tag === '首选' ? '#10b981' : (area.tag === '特色' ? '#3b82f6' : '#64748b')};">${area.tag}</span>
                </div>
                <span class="transport-card-desc" style="margin-top: 4px;">${area.desc}</span>
              </div>
            </div>
              `).join("")}
            </div>

            <div class="modern-tips-banner purple-tips">
              <strong>💡 住宿避坑：</strong> ${escGuide(realHousingTips.join(" ｜ "))}
            </div>
          </div>

          <div class="guide-modern-section">
            <div class="guide-modern-header orange-header">
              <div class="guide-modern-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M18 8h1a4 4 0 0 1 0 8h-1"></path>
                  <path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"></path>
                  <line x1="6" y1="1" x2="6" y2="4"></line>
                  <line x1="10" y1="1" x2="10" y2="4"></line>
                  <line x1="14" y1="1" x2="14" y2="4"></line>
                </svg>
              </div>
              <h3>餐饮特色</h3>
            </div>
            
            <div class="food-grid">
              ${realFoodsList.map(food => `
                <div class="transport-card" style="border-color: rgba(245, 158, 11, 0.15);">
              <div class="transport-icon-box" style="color: #f59e0b; background: #fffbeb;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2v0a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/></svg>
              </div>
              <div class="transport-card-text">
                <span class="transport-card-label">${food.name}</span>
                <span class="transport-card-desc">${food.desc}</span>
              </div>
            </div>
              `).join("")}
            </div>

            <div class="modern-tips-banner orange-tips">
              <strong>💡 美食贴士：</strong> ${escGuide(realFoodTips.join(" ｜ "))}
            </div>
          </div>

          <section class="guide-modern-section">
            <div class="guide-modern-header red-header">
              <div class="guide-modern-icon">🛡</div>
              <h3>老幼关怀与注意事项</h3>
            </div>
            <div class="guide-lite-card-grid">
              ${guideCard("👴", "长辈出行提示", specialGuide.elderly || "少走路、避开高峰，优先选择交通便利和休息点充足的线路。", "red")}
              ${guideCard("👶", "亲子儿童提示", specialGuide.children || "注意补水防晒，行程放松，避开过长步行和拥挤时段。", "pink")}
            </div>
          </section>
        </div>
      `;
    } else {
      guideContainer.innerHTML = `

      <div class="guide-modern-section">
        <div class="guide-modern-header blue-header">
          <div class="guide-modern-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 8V19C4 20.1046 4.89543 21 6 21H18C19.1046 21 20 20.1046 20 19V8"/>
              <path d="M4 8L9 3H15L20 8"/>
              <path d="M12 3V21"/>
            </svg>
          </div>
          <h3>穿衣指南</h3>
        </div>
        
        <div class="clothing-grid">
          <div class="clothing-card">
            <div class="clothing-icon-box" style="color: #10b981; background: #ecfdf5;">🌿</div>
            <div class="clothing-info">
              <span class="clothing-season">春秋 <span style="font-size:11px;color:var(--text-muted);">(3-5/9-11月)</span></span>
              <span class="clothing-desc">${springDesc}</span>
            </div>
          </div>
          <div class="clothing-card">
            <div class="clothing-icon-box" style="color: #f59e0b; background: #fffbeb;">☀️</div>
            <div class="clothing-info">
              <span class="clothing-season">夏季 <span style="font-size:11px;color:var(--text-muted);">(6-8月)</span></span>
              <span class="clothing-desc">${summerDesc}</span>
            </div>
          </div>
          <div class="clothing-card">
            <div class="clothing-icon-box" style="color: #3b82f6; background: #eff6ff;">❄️</div>
            <div class="clothing-info">
              <span class="clothing-season">冬季 <span style="font-size:11px;color:var(--text-muted);">(12-2月)</span></span>
              <span class="clothing-desc">${winterDesc}</span>
            </div>
          </div>
        </div>
        
        <div class="modern-tips-banner blue-tips">
          <strong>💡 小贴士：</strong> ${cleanClothingTips.join(' ｜ ')}
        </div>
      </div>

      <div class="guide-modern-section">
        <div class="guide-modern-header green-header">
          <div class="guide-modern-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="4" y="6" width="16" height="11" rx="2"/>
              <path d="M6 17V19C6 19.5523 6.44772 20 7 20C7.55228 20 8 19.5523 8 19V17"/>
              <path d="M16 17V19C16 19.5523 16.4477 20 17 20C17.5523 20 18 19.5523 18 19V17"/>
              <circle cx="8" cy="14" r="1"/><circle cx="16" cy="14" r="1"/>
            </svg>
          </div>
          <h3>交通出行</h3>
        </div>
        
        <div class="transport-grid">
          <div class="transport-card" onclick="this.classList.toggle('expanded')">
            <div class="transport-icon-box" style="color: #3b82f6; background: #eff6ff;">🚆</div>
            <div class="transport-card-text">
              <span class="transport-card-label">高铁/火车</span>
              <span class="transport-card-desc">${trainStation.replace("推荐到达：", "")}</span>
            </div>
          </div>
          <div class="transport-card" onclick="this.classList.toggle('expanded')">
            <div class="transport-icon-box" style="color: #10b981; background: #ecfdf5;">🚗</div>
            <div class="transport-card-text">
              <span class="transport-card-label">自驾游</span>
              <span class="transport-card-desc">${driveTip.replace("导航", "")}</span>
            </div>
          </div>
          <div class="transport-card" onclick="this.classList.toggle('expanded')">
            <div class="transport-icon-box" style="color: #f59e0b; background: #fffbeb;">🚡</div>
            <div class="transport-card-text">
              <span class="transport-card-label">内部交通</span>
              <span class="transport-card-desc">${isMountain ? cableTip : busPrice}</span>
            </div>
          </div>
        </div>

        <div class="modern-tips-banner green-tips">
          <strong>💡 避坑：</strong> ${cleanTransportTips.join(' ｜ ')}
        </div>
      </div>
      <!-- 03 住宿建议 -->
      <div class="guide-modern-section">
        <div class="guide-modern-header purple-header">
          <div class="guide-modern-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 21h18"></path><path d="M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16"></path><path d="M9 7h6"></path><path d="M9 11h6"></path><path d="M9 15h6"></path>
            </svg>
          </div>
          <h3>住宿建议</h3>
        </div>
        
        <div class="hotel-grid">
          ${hotelAreas.map(area => `
            <div class="transport-card" style="border-color: rgba(139, 92, 246, 0.15);">
              <div class="transport-icon-box" style="color: #8b5cf6; background: #f3e8ff;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4v16"/><path d="M2 8h18a2 2 0 0 1 2 2v10"/><path d="M2 17h20"/><path d="M6 8v9"/></svg>
              </div>
              <div class="transport-card-text" style="flex: 1;">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; width: 100%; gap: 4px;">
                  <span class="transport-card-label" style="line-height: 1.2;">${area.name.split('（')[0].split('(')[0]}</span>
                  <span style="flex-shrink: 0; font-size:10px; padding:2px 6px; border-radius:4px; background-color:${area.tag === '首选' ? 'rgba(16,185,129,0.1)' : (area.tag === '特色' ? 'rgba(59,130,246,0.1)' : 'rgba(100,116,139,0.1)')}; color:${area.tag === '首选' ? '#10b981' : (area.tag === '特色' ? '#3b82f6' : '#64748b')};">${area.tag}</span>
                </div>
                <span class="transport-card-desc" style="margin-top: 4px;">${area.desc}</span>
              </div>
            </div>
          `).join("")}
        </div>

        <div class="modern-tips-banner purple-tips">
          <strong>💡 住宿避坑：</strong> ${escGuide(cleanHousingTips.join(" ｜ "))}
        </div>
      </div>

      <!-- 04 餐饮特色 -->
      <div class="guide-modern-section">
        <div class="guide-modern-header orange-header">
          <div class="guide-modern-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 8h1a4 4 0 0 1 0 8h-1"></path>
              <path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8z"></path>
              <line x1="6" y1="1" x2="6" y2="4"></line>
              <line x1="10" y1="1" x2="10" y2="4"></line>
              <line x1="14" y1="1" x2="14" y2="4"></line>
            </svg>
          </div>
          <h3>餐饮特色</h3>
        </div>
        
        <div class="food-grid">
          ${foodsList.map(food => `
            <div class="transport-card" style="border-color: rgba(245, 158, 11, 0.15);">
              <div class="transport-icon-box" style="color: #f59e0b; background: #fffbeb;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2v0a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/></svg>
              </div>
              <div class="transport-card-text">
                <span class="transport-card-label">${food.name}</span>
                <span class="transport-card-desc">${food.desc}</span>
              </div>
            </div>
          `).join("")}
        </div>

        <div class="modern-tips-banner orange-tips">
          <strong>💡 美食贴士：</strong> ${escGuide(cleanFoodTips.join(" ｜ "))}
        </div>
      </div>
    `;
    }
  }

  // ==========================================
  // 重构 2：高保真【懒人攻略】(三大省力路线) 动态渲染
  // ==========================================
  const metricsContainer = document.getElementById("lazy-header-metrics");
  const routeListContainer = document.getElementById("lazy-route-list");
  
  if (metricsContainer && routeListContainer) {
    const escapeLazyHtml = (value = "") => String(value ?? "").replace(/[&<>"']/g, ch => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[ch]));
    const renderLazyAiAnswer = (text = "") => {
      const lines = String(text || "")
        .replace(/\r/g, "\n")
        .split("\n")
        .map(line => line.trim())
        .filter(Boolean)
        .filter(line => !/^ai总结\d*篇笔记生成/.test(line))
        .filter(line => !/餐饮|美食|住宿|酒店|饭店|需要我帮你|如果需要.*帮你|大概计划|如果时间充裕|推荐吗/.test(line));

      return lines.map((line, idx) => {
        const hadBullet = /^[•·\-\d.、]\s*/.test(line);
        const plain = line
          .replace(/​​/g, "")
          .replace(/^\s*[•·\-]\s*/, "")
          .trim();
        let clean = escapeLazyHtml(plain).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
        clean = clean.replace(/^([^：:]{2,18})([：:])/, "<strong>$1$2</strong>");
        const headingText = plain.replace(/\*\*/g, "");
        if (idx === 0 && !hadBullet && headingText.length <= 36) {
          return `<h3>${clean}</h3>`;
        }
        if (!hadBullet && /^[^：:]{2,24}$/.test(headingText) && /(路线|行程|省力|原则|对比|门票|费用|技巧|避坑|注意|设施|贴士|建议|推荐)/.test(headingText)) {
          return `<h4>${clean}</h4>`;
        }
        if (hadBullet || /^[^：:]{2,18}[：:]/.test(headingText)) return `<li>${clean}</li>`;
        return `<p>${clean}</p>`;
      }).join("");
    };

    if (attraction.lazy_ai_text) {
      const lazyBottomBar = document.querySelector("#tab-lazy .lazy-bottom-bar");
      if (lazyBottomBar) lazyBottomBar.style.display = "none";
      metricsContainer.innerHTML = "";
      metricsContainer.style.display = "none";
      routeListContainer.innerHTML = `
        <article class="lazy-ai-answer">
          ${renderLazyAiAnswer(attraction.lazy_ai_text)}
        </article>
      `;
      const tipsBar = document.getElementById("modal-lazy-tips-bar");
      if (tipsBar) {
        tipsBar.textContent = "长辈小孩省力路线已由 AI 整理，出行前请以景区公告和现场开放为准。";
      }
    } else {
    const lazyBottomBar = document.querySelector("#tab-lazy .lazy-bottom-bar");
    if (lazyBottomBar) lazyBottomBar.style.display = "flex";
    metricsContainer.style.display = "grid";

    const isMountain = /(山|峰|岳|岭|谷|岩|洞|大峡谷)/.test(attraction.name);
    const isWater = /(湖|江|河|海|岛|湾|瀑布|湿地|溪)/.test(attraction.name);

    const hasVerifiedLazyRoutes = Array.isArray(attraction.lazy_routes) && attraction.lazy_routes.length > 0;
    const bestDur = isMountain ? "1天" : "半天 ~ 1天";
    const bestEntry = "上午 8:30 前";
    const recIndex = attraction.hotness ? attraction.hotness : "98%";
    const verifiedRouteText = hasVerifiedLazyRoutes
      ? attraction.lazy_routes.slice(0, 2).map(route => [
          route.badge,
          route.suitability,
          Array.isArray(route.nodes) ? route.nodes.join(" ") : "",
          Array.isArray(route.tips) ? route.tips.join(" ") : "",
        ].join(" ")).join(" ")
      : "";
    let lazyKey = "分段游览";
    if (/索道|缆车/.test(verifiedRouteText)) lazyKey = "索道/缆车";
    else if (/观光车|电瓶车|摆渡车/.test(verifiedRouteText)) lazyKey = "观光车";
    else if (/游船/.test(verifiedRouteText)) lazyKey = "游船代步";
    else if (/电梯|扶梯|无障碍|轮椅/.test(verifiedRouteText)) lazyKey = "无障碍";

    metricsContainer.innerHTML = hasVerifiedLazyRoutes ? `
      <div class="metric-card">
        <div class="metric-icon-box metric-icon-green">✅</div>
        <div class="metric-info">
          <span class="metric-label">真实线路</span>
          <span class="metric-value">2 条</span>
        </div>
      </div>
      <div class="metric-card">
        <div class="metric-icon-box metric-icon-blue">🚡</div>
        <div class="metric-info">
          <span class="metric-label">省力关键</span>
          <span class="metric-value">${lazyKey}</span>
        </div>
      </div>
      <div class="metric-card">
        <div class="metric-icon-box metric-icon-orange">🕘</div>
        <div class="metric-info">
          <span class="metric-label">建议入园</span>
          <span class="metric-value">${bestEntry}</span>
        </div>
      </div>
    ` : `
      <div class="metric-card">
        <div class="metric-icon-box metric-icon-green">🔎</div>
        <div class="metric-info">
          <span class="metric-label">真实线路</span>
          <span class="metric-value">补全中</span>
        </div>
      </div>
      <div class="metric-card">
        <div class="metric-icon-box metric-icon-blue">🧭</div>
        <div class="metric-info">
          <span class="metric-label">路线类型</span>
          <span class="metric-value">${isMountain ? "徒步动线" : "参观动线"}</span>
        </div>
      </div>
      <div class="metric-card">
        <div class="metric-icon-box metric-icon-orange">⭐</div>
        <div class="metric-info">
          <span class="metric-label">路线质量</span>
          <span class="metric-value">核验后显示</span>
        </div>
      </div>
    `;

    let routesData = [];

    if (hasVerifiedLazyRoutes) {
      routesData = attraction.lazy_routes.slice(0, 2).map((route, idx) => ({
        num: idx + 1,
        title: route.title || `省力路线 ${idx + 1}`,
        badge: route.badge || (route.suitability || "已核验"),
        badgeClass: idx === 0 ? "badge-green" : (idx === 1 ? "badge-blue" : "badge-orange"),
        nodes: Array.isArray(route.nodes) ? route.nodes.slice(0, 8) : [],
        duration: route.duration || "详见景区公告",
        walking: route.walking || "按现场体力调整",
        physical: Number(route.physical || 1.5),
        reasons: Array.isArray(route.tips) ? route.tips.slice(0, 4) : ["以景区公开路线资料整理", "适合老幼按体力分段游览"],
        boxClass: idx === 0 ? "reason-green" : (idx === 1 ? "reason-blue" : "reason-orange"),
        boxTitle: route.boxTitle || "✅ 真实路线依据",
        sourceTitle: route.sourceTitle || "来源资料",
        sourceUrl: route.sourceUrl || "",
        verifiedAt: route.verifiedAt || "",
        isVerified: true
      }));
    } else {
      routesData = [];
    }

    if (routesData.length === 0) {
      routeListContainer.innerHTML = `
        <div class="lazy-empty-panel">
          <div class="lazy-empty-main">
            <div class="lazy-empty-icon">🔎</div>
            <div>
              <div class="lazy-empty-title">攻略正在补全</div>
              <div class="lazy-empty-desc">我们正在整理适合长辈和小孩的真实参观动线，完成后会直接显示两条路线。</div>
            </div>
          </div>
          <div class="lazy-empty-tags">
            <span>真实来源</span>
            <span>分类路线</span>
            <span>自动显示</span>
          </div>
        </div>
      `;
    } else {
      routeListContainer.innerHTML = routesData.map(route => {
      // 物理生成星星 rating
      let starsHtml = "";
      for (let s = 1; s <= 5; s++) {
        if (s <= Math.ceil(route.physical)) {
          starsHtml += '<span class="spec-star-filled">★</span>';
        } else {
          starsHtml += '<span class="spec-star-empty">☆</span>';
        }
      }

      return `
        <div class="lazy-route-card ${route.isVerified ? "verified-route-card" : ""}">
          <div class="route-img-box">
            <span class="route-badge ${route.badgeClass}">${route.badge}</span>
            <div style="font-size:48px; color:rgba(255,255,255,0.25); user-select:none;">🗺️</div>
          </div>
          <div class="route-detail-box">
            <div class="route-title-row">
              <span class="route-card-title">线路 ${route.num}：${route.title}</span>
              <span class="route-recommend-tag">${route.badge}</span>
            </div>
            <!-- 水平连线节点 -->
            <div class="route-flow-row">
              ${route.nodes.map((node, nIdx) => `
                <span class="route-node">${node}</span>
                ${nIdx < route.nodes.length - 1 ? '<span class="route-arrow">→</span>' : ''}
              `).join("")}
            </div>
            <!-- 规格详情 -->
            <div class="route-specs-row">
              <div class="spec-item">⏱️ 游玩时长: <strong style="color:var(--text-primary); font-weight:600;">${route.duration}</strong></div>
              <div class="spec-item">🚶 步行时间: <strong style="color:var(--text-primary); font-weight:600;">${route.walking}</strong></div>
              <div class="spec-item">📊 体力指数: ${starsHtml}</div>
            </div>
            ${route.sourceUrl ? `
              <div class="route-source-row">
                来源：<a href="${route.sourceUrl}" target="_blank" rel="noopener noreferrer">${route.sourceTitle}</a>
                ${route.verifiedAt ? `<span>核验：${route.verifiedAt}</span>` : ""}
              </div>
            ` : ""}
          </div>
          <div class="route-reason-box">
            <div class="reason-card ${route.boxClass}">
              <div class="reason-card-title">${route.boxTitle}</div>
              <ul class="reason-card-list">
                ${route.reasons.map(res => `<li>${res}</li>`).join("")}
              </ul>
            </div>
          </div>
        </div>
      `;
      }).join("");
    }

    // 同步底部小贴士
    const tipsBar = document.getElementById("modal-lazy-tips-bar");
    if (tipsBar) {
      tipsBar.textContent = hasVerifiedLazyRoutes
        ? (attraction.lazy_tips || "路线已按真实来源整理，建议结合现场开放情况调整。")
        : "攻略补全中，可先查看基本信息和旅行指南。";
    }
    }
  }

  const reviewsContainer = document.getElementById("modal-reviews-list");
  if (reviewsContainer) {
    reviewsContainer.innerHTML = "";
  if (attraction.reviews && attraction.reviews.length > 0) {
    attraction.reviews.forEach(rev => {
      const item = document.createElement("div");
      item.className = "review-item";
      
      let stars = "";
      for (let s = 0; s < 5; s++) {
        stars += s < rev.rating ? "★" : "☆";
      }

      item.innerHTML = `
        <div class="review-meta">
          <div class="review-user-info">
            <div class="user-avatar">${rev.user[0]}</div>
            <div>
              <div class="review-username">${rev.user}</div>
              <div class="review-stars">${stars}</div>
            </div>
          </div>
          <div class="review-date">${rev.date}</div>
        </div>
        <p class="review-content">${rev.content}</p>
      `;
      reviewsContainer.appendChild(item);
    });
  } else {
    reviewsContainer.innerHTML = `<p style="color:var(--text-muted);font-size:13px;padding:15px;">暂无游客评价数据</p>`;
    }
  }

  document.querySelectorAll(".modal-tab-btn").forEach(btn => btn.classList.remove("active"));
  document.querySelectorAll(".tab-pane").forEach(pane => pane.classList.remove("active"));
  document.querySelector('.modal-tab-btn[data-tab="tab-info"]').classList.add("active");
  document.getElementById("tab-info").classList.add("active");

  const modal = document.getElementById("detail-modal");
  modal.style.display = "flex";

  setTimeout(triggerScoreAnimation, 80);
}

function getAttractionSourceNames(attraction) {
  const evidence = attraction.source_evidence || {};
  const rawSources = Array.isArray(evidence.basicInfoSources) ? evidence.basicInfoSources : [];
  const names = rawSources.map(source => {
    const text = String(source);
    if (text.includes("高德")) return "高德";
    if (text.includes("携程")) return "携程";
    if (text.includes("同程")) return "同程";
    return text.replace(/[:：].*$/, "").slice(0, 8);
  });
  if (evidence.source) {
    const source = String(evidence.source);
    if (source.includes("amap")) names.unshift("高德");
    else names.unshift(source.slice(0, 8));
  }
  return [...new Set(names)].slice(0, 3);
}

function inferVisitDuration(attraction) {
  const name = attraction.name || "";
  const category = attraction.category || "";
  if (/(迪士尼|海洋公园|乐园|影视城|长城|故宫|环球)/.test(name)) return "1天";
  if (/(山|峡谷|森林|国家公园|风景名胜区|景区)/.test(name)) return "半天-1天";
  if (/(博物馆|美术馆|纪念馆|故居|寺|庙|塔|楼|街|广场|码头)/.test(name + category)) return "1-3小时";
  return "2-4小时";
}

function inferBestSeason(attraction) {
  const name = attraction.name || "";
  const city = attraction.city || "";
  if (/(滑雪|冰雪|雪乡|冰雕)/.test(name)) return "冬季";
  if (/(海|岛|湾|滩|湖|湿地|港|鼓浪屿|厦门|三亚|深圳|珠海)/.test(name + city)) return "春秋季";
  if (/(花|樱|桃|油菜|牡丹)/.test(name)) return "春季";
  if (/(山|峡谷|森林|草原)/.test(name)) return "春秋季";
  return "全年适宜";
}

function getFeatureSummary(attraction) {
  const tags = [
    ...(Array.isArray(attraction.tags) ? attraction.tags : []),
    attraction.category,
    formatAttractionLevel(attraction.level),
  ].filter(Boolean).map(tag => String(tag).replace(/景区$/, ""));
  const fallback = [];
  const name = attraction.name || "";
  if (/(鼓浪屿|故宫|博物馆|古城|寺|庙|楼|塔|街)/.test(name)) fallback.push("历史建筑", "人文漫游");
  if (/(海|岛|湾|湖|山|峰|谷|森林|湿地)/.test(name)) fallback.push("自然风光");
  if (/(夜市|乐园|摩天轮|观景台|广场)/.test(name)) fallback.push("城市打卡");
  const items = [...new Set([...tags, ...fallback])].filter(Boolean).slice(0, 4);
  return items.length ? items.join(" · ") : "经典景点 · 休闲游览";
}

function getSourceUpdatedText(attraction) {
  const evidence = attraction.source_evidence || {};
  const raw = evidence.basicInfoUpdatedAt || evidence.updatedAt;
  if (!raw) return "信息已整理";
  const date = String(raw).slice(0, 10);
  return date ? `更新于 ${date}` : "信息已整理";
}

function renderModalFeatureTags(attraction) {
  const container = document.getElementById("modal-feature-tags");
  if (!container) return;
  const candidates = [
    ...(Array.isArray(attraction.tags) ? attraction.tags : []),
    attraction.category,
    formatAttractionLevel(attraction.level),
  ].filter(Boolean);
  const tags = [...new Set(candidates.map(tag => String(tag).trim()).filter(tag => tag && tag !== "常规景区"))].slice(0, 5);
  container.innerHTML = tags.map(tag => `<span>${tag}</span>`).join("");
}

// 沉浸式大图：复用现有详情层，避免出现“弹窗套弹窗”。
function isImmersiveImageViewerOpen() {
  return document.getElementById("detail-modal")?.classList.contains("image-viewer-active") || false;
}

function isPointOutsideContainedImage(image, clientX, clientY) {
  const rect = image.getBoundingClientRect();
  if (!image.naturalWidth || !image.naturalHeight || !rect.width || !rect.height) return false;

  const naturalRatio = image.naturalWidth / image.naturalHeight;
  const containerRatio = rect.width / rect.height;
  let renderedWidth = rect.width;
  let renderedHeight = rect.height;

  if (naturalRatio > containerRatio) {
    renderedHeight = rect.width / naturalRatio;
  } else {
    renderedWidth = rect.height * naturalRatio;
  }

  const left = rect.left + (rect.width - renderedWidth) / 2;
  const right = left + renderedWidth;
  const top = rect.top + (rect.height - renderedHeight) / 2;
  const bottom = top + renderedHeight;
  return clientX < left || clientX > right || clientY < top || clientY > bottom;
}

function updateImmersiveImageQuality() {
  const modal = document.getElementById("detail-modal");
  const image = document.getElementById("modal-img");
  const note = document.getElementById("modal-image-quality-note");
  if (!modal || !image || !note || !image.naturalWidth || !image.naturalHeight) return;

  const availableWidth = window.innerWidth;
  const availableHeight = window.innerHeight;
  const containScale = Math.min(
    availableWidth / image.naturalWidth,
    availableHeight / image.naturalHeight,
  );
  const shouldProtectNativeSize = containScale > IMMERSIVE_IMAGE_MAX_UPSCALE;

  modal.classList.toggle("image-viewer-native-size", shouldProtectNativeSize);
  if (shouldProtectNativeSize) {
    modal.style.setProperty("--viewer-image-native-width", `${image.naturalWidth}px`);
    modal.style.setProperty("--viewer-image-native-height", `${image.naturalHeight}px`);
    note.textContent = `原图 ${image.naturalWidth}×${image.naturalHeight}，已按原始尺寸显示`;
    note.hidden = false;
  } else {
    modal.style.removeProperty("--viewer-image-native-width");
    modal.style.removeProperty("--viewer-image-native-height");
    note.textContent = "";
    note.hidden = true;
  }
}

function openImmersiveImageViewer() {
  if (!ENABLE_IMMERSIVE_IMAGE_VIEWER || isImmersiveImageViewerOpen()) return;
  const modal = document.getElementById("detail-modal");
  const closeButton = document.getElementById("modal-close");
  modal.classList.add("image-viewer-active");
  closeButton.title = "返回详情";
  closeButton.setAttribute("aria-label", "返回景点详情");
  updateImmersiveImageQuality();
}

function closeImmersiveImageViewer() {
  const modal = document.getElementById("detail-modal");
  const closeButton = document.getElementById("modal-close");
  const qualityNote = document.getElementById("modal-image-quality-note");
  modal.classList.remove("image-viewer-active", "image-viewer-native-size");
  modal.style.removeProperty("--viewer-image-native-width");
  modal.style.removeProperty("--viewer-image-native-height");
  qualityNote.hidden = true;
  qualityNote.textContent = "";
  closeButton.title = "关闭";
  closeButton.setAttribute("aria-label", "关闭景点详情");
}

// 关闭弹窗
function closeModal() {
  closeImmersiveImageViewer();
  document.getElementById("detail-modal").style.display = "none";
  
  const fills = ["scenery", "traffic", "cost", "service", "crowd"];
  fills.forEach(key => {
    const el = document.getElementById(`fill-${key}`);
    if (el) el.style.width = "0%";
  });
}

// 辅助：口碑分数条滑动动画
function triggerScoreAnimation() {
  const scoreKeys = ["scenery", "traffic", "cost", "service", "crowd"];
  const scorePanel = document.getElementById("score-chart-panel");
  const scores = currentSelectedAttraction && currentSelectedAttraction.scores;
  const hasRealScores = scores && scoreKeys.every(key => Number.isFinite(Number(scores[key])) && Number(scores[key]) > 0);
  if (!hasRealScores) {
    if (scorePanel) scorePanel.style.display = "none";
    scoreKeys.forEach(key => {
      const labelEl = document.getElementById(`score-${key}`);
      if (labelEl) labelEl.textContent = "";
      const fillEl = document.getElementById(`fill-${key}`);
      if (fillEl) fillEl.style.width = "0";
    });
    return;
  }
  if (scorePanel) scorePanel.style.display = "flex";
  
  const fillKeys = scoreKeys;
  
  fillKeys.forEach(key => {
    const scoreVal = scores[key] || 4.5;
    const percentage = (scoreVal / 5.0) * 100;
    
    const labelEl = document.getElementById(`score-${key}`);
    if (labelEl) labelEl.textContent = scoreVal.toFixed(1) + " / 5.0";
    
    const fillEl = document.getElementById(`fill-${key}`);
    if (fillEl) fillEl.style.width = `${percentage}%`;
  });
}

// 🚀 10. 动态渲染美食城市分类胶囊
function renderFoodCityFilterPills(foods, provinceName) {
  const container = document.getElementById("food-city-filter-container");
  if (!container) return;
  container.innerHTML = "";

  if (!foods || foods.length === 0) {
    container.style.display = "none";
    return;
  }
  container.style.display = "flex";

  const uniqueFoodNames = new Set();
  foods.forEach(f => uniqueFoodNames.add(f.name));
  const uniqueCount = uniqueFoodNames.size;

  const cityCounts = { "全部": uniqueCount };
  const cities = [];

  foods.forEach(food => {
    const city = food.city || "其他";
    cityCounts[city] = (cityCounts[city] || 0) + 1;
    if (!cities.includes(city)) {
      cities.push(city);
    }
  });

  // 按照美食数量降序排列城市胶囊
  cities.sort((a, b) => cityCounts[b] - cityCounts[a]);

  // 创建“全部”胶囊
  const allPill = document.createElement("div");
  allPill.className = `city-pill ${selectedFoodCityFilter === "全部" ? "active" : ""}`;
  allPill.innerHTML = `全部 <span class="city-pill-count">${uniqueCount}</span>`;
  allPill.addEventListener("click", () => {
    selectedFoodCityFilter = "全部";
    currentFoodPage = 1;
    document.querySelectorAll("#food-city-filter-container .city-pill").forEach(p => p.classList.remove("active"));
    allPill.classList.add("active");
    renderFoodList(provinceName);
  });
  container.appendChild(allPill);

  // 创建各城市专属胶囊
  cities.forEach(city => {
    const pill = document.createElement("div");
    pill.className = `city-pill ${selectedFoodCityFilter === city ? "active" : ""}`;
    pill.innerHTML = `${city} <span class="city-pill-count">${cityCounts[city]}</span>`;
    pill.addEventListener("click", () => {
      selectedFoodCityFilter = city;
      currentFoodPage = 1;
      document.querySelectorAll("#food-city-filter-container .city-pill").forEach(p => p.classList.remove("active"));
      pill.classList.add("active");
      renderFoodList(provinceName);
    });
    container.appendChild(pill);
  });
}

// 🚀 10.1 渲染美食分页器
function renderFoodPagination(totalItems, itemsPerPage, currentPage, rawFoods, provinceName) {
  const container = document.getElementById("foods-pagination");
  if (!container) return;

  const totalPages = Math.ceil(totalItems / itemsPerPage);
  if (totalPages <= 1) {
    container.style.display = "none";
    return;
  }

  container.style.display = "flex";
  if (window.innerWidth <= 768) {
    container.style.justifyContent = "flex-start";
    container.style.flexWrap = "nowrap";
    container.style.overflowX = "auto";
    container.style.width = "100%";
    container.style.boxSizing = "border-box";
  } else {
    container.style.justifyContent = "center";
    container.style.flexWrap = "nowrap";
    container.style.overflowX = "visible";
    container.style.width = "auto";
  }
  container.innerHTML = "";

  // 1. 上一页
  const prevBtn = document.createElement("button");
  prevBtn.className = `page-btn ${currentPage === 1 ? 'disabled' : ''}`;
  prevBtn.innerHTML = "‹";
  if (currentPage > 1) {
    prevBtn.addEventListener("click", () => {
      currentFoodPage = currentPage - 1;
      const listScrollEl = document.getElementById("foods-list-container");
      if (listScrollEl) listScrollEl.scrollTop = 0;
      renderFoodList(provinceName);
    });
  }
  container.appendChild(prevBtn);

  // 2. 页码按钮
  for (let i = 1; i <= totalPages; i++) {
    const pageBtn = document.createElement("button");
    pageBtn.className = `page-btn ${i === currentPage ? 'active' : ''}`;
    pageBtn.textContent = i;
    pageBtn.addEventListener("click", () => {
      if (i === currentPage) return;
      currentFoodPage = i;
      const listScrollEl = document.getElementById("foods-list-container");
      if (listScrollEl) listScrollEl.scrollTop = 0;
      renderFoodList(provinceName);
    });
    container.appendChild(pageBtn);
  }

  // 3. 下一页
  const nextBtn = document.createElement("button");
  nextBtn.className = `page-btn ${currentPage === totalPages ? 'disabled' : ''}`;
  nextBtn.innerHTML = "›";
  if (currentPage < totalPages) {
    nextBtn.addEventListener("click", () => {
      currentFoodPage = currentPage + 1;
      const listScrollEl = document.getElementById("foods-list-container");
      if (listScrollEl) listScrollEl.scrollTop = 0;
      renderFoodList(provinceName);
    });
  }
  container.appendChild(nextBtn);

  // 💡 Force style overriding for all child buttons (bypass CSS caching)
  Array.from(container.children).forEach(child => {
    if (child.tagName === 'BUTTON') {
      child.style.flexShrink = "0";
      if (window.innerWidth <= 768) {
        child.style.minWidth = "32px";
        child.style.height = "32px";
        child.style.fontSize = "13px";
        child.style.padding = "0 4px";
      }
    }
  });
}

// 🚀 10.2 渲染美食列表 (按城市级筛选并支持分页)
async function ensureProvinceFoodData(provinceName) {
  if (!localCuisineAndItineraries[provinceName]) {
    localCuisineAndItineraries[provinceName] = { bestTime: "最佳旅行时间：四季皆宜", foods: null, itineraries: null };
  }

  const extraInfo = localCuisineAndItineraries[provinceName];
  if (Array.isArray(extraInfo.foods)) return extraInfo;

  const loaded = await loadProvinceFoodData(provinceName);
  localCuisineAndItineraries[provinceName] = {
    ...extraInfo,
    bestTime: loaded.bestTime || extraInfo.bestTime || "最佳旅行时间：四季皆宜",
    foods: loaded.foods || [],
    itineraries: loaded.itineraries || [],
  };

  return localCuisineAndItineraries[provinceName];
}

async function renderFoodList(provinceName) {
  const container = document.getElementById("foods-list-container");
  container.innerHTML = "";
  
  const FOOD_ITEMS_PER_PAGE = 10;
  
  let extraInfo = localCuisineAndItineraries[provinceName];
  if (!extraInfo || !Array.isArray(extraInfo.foods)) {
    container.innerHTML = `<div class="empty-state" style="padding:20px; border:none; margin:0;">正在加载美食推荐...</div>`;
    try {
      extraInfo = await ensureProvinceFoodData(provinceName);
    } catch (err) {
      console.error("Failed to load food data:", err);
      container.innerHTML = `<div class="empty-state" style="padding:20px; border:none; margin:0;">美食推荐加载失败，请稍后重试</div>`;
      return;
    }
  }

  if (!extraInfo || !extraInfo.foods || extraInfo.foods.length === 0) {
    container.innerHTML = `<div class="empty-state" style="padding:20px; border:none; margin:0;">暂无美食推荐数据</div>`;
    const filterContainer = document.getElementById("food-city-filter-container");
    if (filterContainer) filterContainer.style.display = "none";
    const paginationContainer = document.getElementById("foods-pagination");
    if (paginationContainer) paginationContainer.style.display = "none";
    return;
  }

  // 渲染城市分类胶囊
  renderFoodCityFilterPills(extraInfo.foods, provinceName);

  // 应用城市级过滤
  let filteredFoods = [...extraInfo.foods];
  if (selectedFoodCityFilter !== "全部") {
    filteredFoods = filteredFoods.filter(food => (food.city || "其他") === selectedFoodCityFilter);
  } else {
    // 自动去重，防止不同城市间分发到相同招牌特色菜时在列表里大量重复显现
    const seen = new Set();
    filteredFoods = filteredFoods.filter(food => {
      if (seen.has(food.name)) return false;
      seen.add(food.name);
      return true;
    });
  }

  // 默认按评分降序排序
  filteredFoods.sort((a, b) => b.rating - a.rating);

  // 分页处理
  let paginatedFoods = filteredFoods;
  if (filteredFoods.length > FOOD_ITEMS_PER_PAGE) {
    const startIndex = (currentFoodPage - 1) * FOOD_ITEMS_PER_PAGE;
    const endIndex = startIndex + FOOD_ITEMS_PER_PAGE;
    paginatedFoods = filteredFoods.slice(startIndex, endIndex);
    renderFoodPagination(filteredFoods.length, FOOD_ITEMS_PER_PAGE, currentFoodPage, extraInfo.foods, provinceName);
  } else {
    const paginationContainer = document.getElementById("foods-pagination");
    if (paginationContainer) paginationContainer.style.display = "none";
  }
  
  paginatedFoods.forEach(food => {
    const card = document.createElement("div");
    card.className = "food-card";
    
    let stars = "";
    const fullStars = Math.floor(food.rating);
    for (let i = 0; i < 5; i++) {
      stars += i < fullStars ? "★" : "☆";
    }
    
    let tagsHTML = food.tags ? food.tags.map(t => `<span class="card-badge-level">${t}</span>`).join('') : '';

    card.innerHTML = `
      <img class="food-img" src="${food.image}" loading="lazy" decoding="async" referrerpolicy="no-referrer" alt="${food.name}">
      <div class="food-info">
        <div class="food-title-row">
          <h4 class="food-name">${food.name}</h4>
          <span class="food-rating">${stars} ${food.rating.toFixed(1)}</span>
        </div>
        <div style="margin-bottom: 4px; display: flex; flex-wrap: wrap; gap: 2px;">${tagsHTML}</div>
        <p class="food-desc">${food.intro}</p>
      </div>
    `;
    container.appendChild(card);
  });
}

// 11. 渲染攻略路线列表
function renderStrategyList(provinceName) {
  const container = document.getElementById("strategies-list-container");
  container.innerHTML = "";
  
  const extraInfo = localCuisineAndItineraries[provinceName];
  if (!extraInfo || !extraInfo.itineraries || extraInfo.itineraries.length === 0) {
    container.innerHTML = `<div class="empty-state" style="padding:20px; border:none; margin:0;">暂无旅行计划数据</div>`;
    return;
  }
  
  extraInfo.itineraries.forEach(item => {
    const card = document.createElement("div");
    card.className = "strategy-card";
    
    card.innerHTML = `
      <div class="strategy-step-num">${item.step}</div>
      <div class="strategy-info">
        <h4 class="strategy-title">${item.title}</h4>
        <p class="strategy-desc">${item.desc}</p>
      </div>
    `;
    container.appendChild(card);
  });
}

// 12. 智能提示气泡 (Toast)
function showToast(message) {
  let toast = document.getElementById("app-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "app-toast";
    toast.style.cssText = `
      position: fixed;
      bottom: 80px;
      left: 50%;
      transform: translateX(-50%) translateY(20px);
      background: rgba(15, 23, 42, 0.95);
      border: 1px solid var(--accent-cyan);
      color: #fff;
      padding: 10px 20px;
      border-radius: 30px;
      font-size: 13px;
      font-weight: 500;
      z-index: 1000;
      box-shadow: 0 10px 25px rgba(0,0,0,0.3), var(--shadow-glow);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.3s, transform 0.3s cubic-bezier(0.18, 0.89, 0.32, 1.28);
    `;
    document.body.appendChild(toast);
  }
  
  toast.textContent = message;
  toast.style.opacity = "1";
  toast.style.transform = "translateX(-50%) translateY(0)";

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(-50%) translateY(20px)";
  }, 2200);
}

// 13. 初始化地区导航侧栏点击事件
function initRegionControls() {
  const regionBtns = document.querySelectorAll(".region-btn");
  regionBtns.forEach(btn => {
    btn.addEventListener("click", (e) => {
      const target = e.currentTarget;
      regionBtns.forEach(b => b.classList.remove("active"));
      target.classList.add("active");
      
      const region = target.getAttribute("data-region");
      const coords = regionCoordinates[region];
      
      if (coords && myChart) {
        currentZoom = coords.zoom;
        myChart.setOption({
          geo: {
            center: coords.center,
            zoom: currentZoom
          }
        });
        showToast(`📍 已定位至 ${target.querySelector('.region-text').textContent} 区域`);
      }
    });
  });
}

// 14. 高性能后台图片预加载引擎 (支持按需懒加载数据并缓存图片)
const prefetchedProvinces = new Set();
async function prefetchProvinceImages(provinceName) {
  if (prefetchedProvinces.has(provinceName)) return;
  prefetchedProvinces.add(provinceName);
  
  let destData = window.tourismData ? window.tourismData[provinceName] : null;
  if (!destData) return;
  
  let attractions = destData.attractions;
  if (!attractions) {
    try {
      const provinceDetail = await loadProvinceListData(provinceName);
      window.tourismData[provinceName] = provinceDetail;
      attractions = provinceDetail.attractions;
    } catch (e) {
      return;
    }
  }
  
  if (attractions) {
    // 异步预加载最核心的前 3 张景点大图到浏览器缓存中，免去弹窗开启时的白屏等待
    attractions.slice(0, 3).forEach(attr => {
      if (attr.image) {
        const img = new Image();
        img.src = attr.image;
      }
    });
  }
}



// 18. 商业化安全会话状态机管理 (JWT 及跨端云同步面板)
let currentUsername = localStorage.getItem('map_jwt_username') || '';

function initAuthSession() {
  const profileEl = document.querySelector('.user-profile');
  const loginModal = document.getElementById('login-modal');

  // EdgeOne 稳定版不提供虚假的云账户能力；收藏仅保存在当前浏览器。
  if (profileEl) {
    profileEl.style.cursor = 'pointer';
    profileEl.title = '收藏保存在当前浏览器';
    const spanEl = profileEl.querySelector('span');
    if (spanEl) spanEl.textContent = '本机';
    profileEl.addEventListener('click', () => showToast('当前为本机模式：收藏保存在此浏览器中'));
  }
  if (loginModal) loginModal.remove();
  return;

  /* Legacy server account flow retained below for local backend reference. */
  if (profileEl) {
    profileEl.style.cursor = 'pointer';
    const spanEl = profileEl.querySelector('span');
    if (currentUsername) {
      spanEl.textContent = currentUsername;
      spanEl.style.color = 'var(--accent-teal)';
    } else {
      spanEl.textContent = '我的';
      spanEl.style.color = 'var(--text-color)';
    }
    
    profileEl.addEventListener('click', () => {
      if (currentUsername) {
        if (confirm(`👤 当前已登录账户: ${currentUsername}\n是否退出登录？`)) {
          localStorage.removeItem('map_jwt_token');
          localStorage.removeItem('map_jwt_username');
          currentUsername = '';
          spanEl.textContent = '我的';
          spanEl.style.color = 'var(--text-color)';
          showToast('🔒 账户已安全退出');
          favorites = [];
          updateFavoritesCount();
          renderFavoritesList();
        }
      } else {
        openLoginModal();
      }
    });
  }
  
  document.getElementById('login-close').addEventListener('click', closeLoginModal);
  document.getElementById('login-modal').addEventListener('click', (e) => {
    if (e.target.id === 'login-modal') closeLoginModal();
  });
  
  let isRegisterMode = false;
  const switchBtn = document.getElementById('btn-switch-register');
  const modalTitle = document.querySelector('#login-modal h3');
  const submitBtn = document.getElementById('btn-submit-login');
  
  switchBtn.addEventListener('click', () => {
    isRegisterMode = !isRegisterMode;
    if (isRegisterMode) {
      modalTitle.textContent = '创建您的旅行账户';
      submitBtn.textContent = '立即注册并探索';
      switchBtn.textContent = '已有账号？返回登录';
    } else {
      modalTitle.textContent = '畅游中国 · 登录旅行账户';
      submitBtn.textContent = '立即安全登录';
      switchBtn.textContent = '没有账号？立即极速注册';
    }
  });
  
  submitBtn.addEventListener('click', async () => {
    const usernameInput = document.getElementById('login-username').value.trim();
    const passwordInput = document.getElementById('login-password').value.trim();
    
    if (!usernameInput || !passwordInput) {
      showToast('⚠️ 手机号和密码不能为空');
      return;
    }
    if (usernameInput.length < 11) {
      showToast('⚠️ 请输入正确的11位手机号');
      return;
    }
    
    const apiPath = isRegisterMode ? '/api/auth/register' : '/api/auth/login';
    submitBtn.textContent = isRegisterMode ? '正在极速注册...' : '正在验证身份...';
    submitBtn.disabled = true;
    
    try {
      const response = await fetch(apiPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: usernameInput, password: passwordInput })
      });
      const resJson = await response.json();
      
      if (resJson.success) {
        const uData = resJson.data;
        localStorage.setItem('map_jwt_token', uData.token);
        localStorage.setItem('map_jwt_username', uData.username);
        localStorage.setItem('map_user_id', uData.userId);
        
        currentUsername = uData.username;
        if (profileEl) {
          const spanEl = profileEl.querySelector('span');
          spanEl.textContent = currentUsername;
          spanEl.style.color = 'var(--accent-teal)';
        }
        
        showToast(isRegisterMode ? '🎉 账户注册成功，已自动登录' : '🔑 登录成功，同步已开启');
        closeLoginModal();
        
        await loadInitialData();
      } else {
        showToast(`❌ ${resJson.message || '操作失败，请重试'}`);
      }
    } catch (e) {
      showToast('⚠️ 无法联通认证服务器，请检查网络');
    } finally {
      submitBtn.textContent = isRegisterMode ? '立即注册账号' : '立即安全登录';
      submitBtn.disabled = false;
    }
  });
}

function openLoginModal() {
  document.getElementById('login-modal').style.display = 'flex';
}

function closeLoginModal() {
  document.getElementById('login-modal').style.display = 'none';
}


let _subspotOriginalModalImg = '';
let _subspotOriginalModalTitle = '';

function viewSubspotLargeImage(subName, subImg) {
  const modalImg = document.getElementById('modal-img');
  const modalTitle = document.getElementById('modal-title');
  const detailModal = document.getElementById('detail-modal');
  if (modalImg && modalTitle && detailModal) {
    if (!_subspotOriginalModalImg) {
      _subspotOriginalModalImg = modalImg.src;
      _subspotOriginalModalTitle = modalTitle.textContent;
    }
    modalImg.src = subImg;
    modalTitle.textContent = modalTitle.textContent.split(' · ')[0] + ' · ' + subName;
    detailModal.classList.add('image-viewer-active');
    const closeBtn = document.getElementById('modal-close');
    if (closeBtn) {
      closeBtn.title = '返回详情';
      closeBtn.setAttribute('aria-label', '返回景点详情');
    }
  }
}
window.viewSubspotLargeImage = viewSubspotLargeImage;

window.openDetailModal = openDetailModal;
window.closeModal = closeModal;
