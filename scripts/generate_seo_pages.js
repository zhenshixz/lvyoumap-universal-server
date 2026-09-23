const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const siteOrigin = 'https://xzmap.xzbest.site';

function parseArguments(argv) {
  const outputArgument = argv.find(argument => argument.startsWith('--output='));
  if (!outputArgument) throw new Error('Missing required --output argument');
  const outputDir = path.resolve(rootDir, outputArgument.slice('--output='.length));
  if (outputDir !== path.join(rootDir, '.dist-next') && outputDir !== path.join(rootDir, 'dist')) {
    throw new Error(`Refusing to generate SEO pages outside a build directory: ${outputDir}`);
  }
  return { outputDir };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function text(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function truncate(value, maxLength) {
  const normalized = text(value);
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function absoluteUrl(value) {
  const normalized = text(value);
  if (!normalized) return `${siteOrigin}/assets/images/china_map_base.png`;
  if (/^https?:\/\//i.test(normalized)) return normalized;
  return `${siteOrigin}/${normalized.replace(/^\/+/, '')}`;
}

function writeFile(outputDir, relativePath, content) {
  const destination = path.join(outputDir, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content, 'utf8');
}

function pageShell({ title, description, canonicalPath, image, body, structuredData }) {
  const canonicalUrl = `${siteOrigin}${canonicalPath}`;
  const safeTitle = escapeHtml(title);
  const safeDescription = escapeHtml(description);
  const imageUrl = absoluteUrl(image);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${safeTitle}</title>
  <meta name="description" content="${safeDescription}">
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="中国旅游地图">
  <meta property="og:title" content="${safeTitle}">
  <meta property="og:description" content="${safeDescription}">
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}">
  <meta property="og:image" content="${escapeHtml(imageUrl)}">
  <link rel="stylesheet" href="/seo.css">
  <style>.brand{display:flex;align-items:center;gap:14px}.map-entry{display:inline-flex;align-items:center;justify-content:center;background:linear-gradient(135deg,rgba(8,127,91,.9),rgba(11,154,114,.82));color:#fff!important;text-decoration:none;font-weight:700;border:1px solid rgba(137,229,196,.78);border-radius:999px;box-shadow:0 8px 24px rgba(7,86,63,.25),0 2px 5px rgba(7,86,63,.16);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);transition:box-shadow .18s ease,background .18s ease}.map-entry:hover{background:linear-gradient(135deg,rgba(8,127,91,.94),rgba(11,154,114,.88));box-shadow:0 9px 26px rgba(7,86,63,.3),0 3px 7px rgba(7,86,63,.2)}.map-entry-float{position:fixed;z-index:10;left:50%;bottom:20px;transform:translateX(-50%);width:min(690px,calc(100% - 40px));padding:12px 22px;font-size:15px;letter-spacing:.02em}.map-entry-float span{margin-left:6px;font-size:20px;line-height:1}.map-entry-float:before{content:'✦';margin-right:9px;color:#b9f3df;font-size:14px}@media(max-width:560px){.site-header{height:auto;min-height:64px;padding-top:10px;padding-bottom:10px}.brand{align-items:flex-start;flex-direction:column;gap:0}.map-entry-float{bottom:12px;width:calc(100% - 24px);padding:11px 14px;font-size:14px}}</style>
  <script type="application/ld+json">${safeJson(structuredData)}</script>
</head>
<body>
  <header class="site-header"><div class="brand"><a href="/">中国旅游地图</a><span>发现中国之美</span></div></header>
  ${body}
  <footer><a href="/">打开互动地图</a><a href="/destinations/index.html">浏览全部省份</a><a href="https://beian.miit.gov.cn/" rel="nofollow">闽ICP备2026018133号</a></footer>
  <a class="map-entry map-entry-float" href="/" aria-label="进入中国旅游地图，发现中国之美">进入中国旅游地图，发现中国之美 <span aria-hidden="true">→</span></a>
</body>
</html>
`;
}

function usefulDetails(attraction) {
  const details = [];
  const address = text(attraction.address);
  const openHours = text(attraction.openHours);
  const price = text(attraction.price);
  const category = text(attraction.category);
  if (address) details.push(['地址', address]);
  if (openHours) details.push(['开放时间', openHours]);
  if (price) details.push(['门票参考', price]);
  if (category) details.push(['景点类型', category]);
  return details;
}

function attractionUrl(provinceId, attractionId) {
  return `/attractions/${provinceId}/${String(attractionId).toLowerCase()}.html`;
}

function generateAttractionPage(outputDir, provinceName, provinceId, attraction) {
  const name = text(attraction.name);
  const city = text(attraction.city) || provinceName;
  const intro = text(attraction.description || attraction.intro);
  const canonicalPath = attractionUrl(provinceId, attraction.id);
  const description = truncate(`${name}位于${city}。${intro} 查看地址、开放时间、游玩信息及长辈和亲子出行提示。`, 150);
  const detailRows = usefulDetails(attraction)
    .map(([label, value]) => `<div class="fact"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join('');
  const elderly = text(attraction.guide_data?.special_care?.elderly);
  const children = text(attraction.guide_data?.special_care?.children);
  const transport = text(attraction.guide_data?.transport?.external_arrive || attraction.guide_data?.transport?.internal_arrive);
  const tips = [
    transport ? `<section><h2>交通与到达</h2><p>${escapeHtml(transport)}</p></section>` : '',
    elderly ? `<section><h2>长辈出行提示</h2><p>${escapeHtml(elderly)}</p></section>` : '',
    children ? `<section><h2>亲子出行提示</h2><p>${escapeHtml(children)}</p></section>` : '',
  ].join('');
  const body = `<main>
    <nav class="breadcrumb" aria-label="面包屑"><a href="/">首页</a><span>›</span><a href="/destinations/index.html">目的地</a><span>›</span><a href="/destinations/${provinceId}.html">${escapeHtml(provinceName)}</a></nav>
    <article class="detail-card">
      <div class="hero-copy"><p class="eyebrow">${escapeHtml(city)}景点</p><h1>${escapeHtml(name)}</h1><p class="lead">${escapeHtml(intro)}</p></div>
      <img class="hero-image" src="${escapeHtml(attraction.image)}" alt="${escapeHtml(name)}" referrerpolicy="no-referrer">
      ${detailRows ? `<dl class="facts">${detailRows}</dl>` : ''}
      ${tips}
      <p class="notice">开放时间、票务及临时安排可能变化，出发前请以景区官方最新公告为准。</p>
      <a class="primary-link" href="/">在互动地图中继续浏览</a>
    </article>
  </main>`;
  const structuredData = [
    {
      '@context': 'https://schema.org',
      '@type': 'TouristAttraction',
      name,
      description: intro,
      image: absoluteUrl(attraction.image),
      address: text(attraction.address) ? {
        '@type': 'PostalAddress',
        addressLocality: city,
        addressRegion: provinceName,
        streetAddress: text(attraction.address),
        addressCountry: 'CN',
      } : undefined,
      url: `${siteOrigin}${canonicalPath}`,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: '中国旅游地图', item: `${siteOrigin}/` },
        { '@type': 'ListItem', position: 2, name: provinceName, item: `${siteOrigin}/destinations/${provinceId}.html` },
        { '@type': 'ListItem', position: 3, name, item: `${siteOrigin}${canonicalPath}` },
      ],
    },
  ];
  writeFile(outputDir, canonicalPath.slice(1), pageShell({
    title: `${name}旅游攻略、开放时间与地址 | ${provinceName}景点 | 中国旅游地图`,
    description,
    canonicalPath,
    image: attraction.image,
    body,
    structuredData,
  }));
  return canonicalPath;
}

function generateProvincePage(outputDir, provinceName, province, attractions) {
  const provinceId = province.id;
  const canonicalPath = `/destinations/${provinceId}.html`;
  const description = truncate(`${provinceName}旅游景点地图与攻略，收录${attractions.length}个景点。${province.description || ''}`, 150);
  const cards = attractions.map(attraction => {
    const url = attractionUrl(provinceId, attraction.id);
    return `<li><a class="place-card" href="${url}"><img src="${escapeHtml(attraction.image)}" alt="" loading="lazy" referrerpolicy="no-referrer"><span><strong>${escapeHtml(attraction.name)}</strong><small>${escapeHtml(attraction.city || provinceName)}</small><em>${escapeHtml(truncate(attraction.description || attraction.intro, 70))}</em></span></a></li>`;
  }).join('');
  const body = `<main>
    <nav class="breadcrumb" aria-label="面包屑"><a href="/">首页</a><span>›</span><a href="/destinations/index.html">目的地</a><span>›</span>${escapeHtml(provinceName)}</nav>
    <section class="listing-hero"><img src="${escapeHtml(province.image)}" alt="${escapeHtml(provinceName)}风景"><div><p class="eyebrow">中国旅游目的地</p><h1>${escapeHtml(provinceName)}旅游景点</h1><p>${escapeHtml(province.description)}</p><strong>共收录 ${attractions.length} 个景点</strong></div></section>
    <ul class="place-grid">${cards}</ul>
  </main>`;
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: `${provinceName}旅游景点`,
    description,
    url: `${siteOrigin}${canonicalPath}`,
    isPartOf: { '@type': 'WebSite', name: '中国旅游地图', url: `${siteOrigin}/` },
  };
  writeFile(outputDir, canonicalPath.slice(1), pageShell({
    title: `${provinceName}旅游景点地图与攻略 | 中国旅游地图`,
    description,
    canonicalPath,
    image: province.image,
    body,
    structuredData,
  }));
  return canonicalPath;
}

function generateDirectoryPage(outputDir, provinceEntries) {
  const canonicalPath = '/destinations/index.html';
  const cards = provinceEntries.map(({ provinceName, province, count }) => `<li><a class="province-card" href="/destinations/${province.id}.html"><img src="${escapeHtml(province.image)}" alt="" loading="lazy"><span><strong>${escapeHtml(provinceName)}</strong><small>${count} 个景点</small><em>${escapeHtml(truncate(province.description, 62))}</em></span></a></li>`).join('');
  const body = `<main><nav class="breadcrumb" aria-label="面包屑"><a href="/">首页</a><span>›</span>目的地</nav><section class="directory-intro"><p class="eyebrow">按省份浏览</p><h1>中国旅游目的地</h1><p>从 34 个省级区域进入，浏览景点介绍、地址、开放时间及长辈和亲子出行提示。</p></section><ul class="province-grid">${cards}</ul></main>`;
  writeFile(outputDir, canonicalPath.slice(1), pageShell({
    title: '中国旅游目的地与景点目录 | 中国旅游地图',
    description: '按省份浏览中国旅游景点，查看景点介绍、地址、开放时间及长辈和亲子出行提示。',
    canonicalPath,
    image: '/assets/images/china_map_base.png',
    body,
    structuredData: {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: '中国旅游目的地与景点目录',
      url: `${siteOrigin}${canonicalPath}`,
      isPartOf: { '@type': 'WebSite', name: '中国旅游地图', url: `${siteOrigin}/` },
    },
  }));
  return canonicalPath;
}

function generateStyles(outputDir) {
  writeFile(outputDir, 'seo.css', `:root{color-scheme:light;--ink:#102a43;--muted:#526777;--line:#d9e4ea;--accent:#087f5b;--surface:#fff;--wash:#f3f8f7}*{box-sizing:border-box}body{margin:0;background:var(--wash);color:var(--ink);font:16px/1.7 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}.site-header{height:64px;padding:0 max(20px,calc((100% - 1120px)/2));display:flex;align-items:center;gap:14px;background:#fff;border-bottom:1px solid var(--line)}.site-header a{font-size:20px;font-weight:800;color:var(--ink);text-decoration:none}.site-header span,.eyebrow,small{color:var(--muted)}main{width:min(1120px,calc(100% - 32px));margin:28px auto 56px}.breadcrumb{display:flex;gap:10px;align-items:center;margin-bottom:18px;color:var(--muted);font-size:14px}.breadcrumb a,footer a{color:#087f5b}.listing-hero,.detail-card,.directory-intro{background:#fff;border:1px solid var(--line);border-radius:18px;overflow:hidden}.listing-hero{display:grid;grid-template-columns:40% 1fr;min-height:280px}.listing-hero img{width:100%;height:100%;object-fit:cover}.listing-hero div,.directory-intro{padding:34px}.eyebrow{margin:0 0 5px;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}h1{margin:0 0 14px;font-size:clamp(30px,5vw,48px);line-height:1.2}h2{font-size:22px;margin:30px 0 8px}.province-grid,.place-grid{list-style:none;padding:0;margin:24px 0;display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.place-card,.province-card{height:100%;display:flex;gap:14px;padding:12px;background:#fff;border:1px solid var(--line);border-radius:14px;color:inherit;text-decoration:none}.place-card:hover,.province-card:hover{border-color:#6bb49c;box-shadow:0 8px 24px #0b6b4d14}.place-card img,.province-card img{width:116px;height:92px;object-fit:cover;border-radius:10px;background:#e8efec}.place-card span,.province-card span{display:flex;min-width:0;flex-direction:column}.place-card strong,.province-card strong{font-size:17px}.place-card small,.province-card small{font-size:13px}.place-card em,.province-card em{margin-top:4px;color:var(--muted);font-size:13px;font-style:normal;line-height:1.45}.detail-card{padding:34px}.hero-copy{max-width:760px}.lead{font-size:18px;color:#334e5b}.hero-image{display:block;width:100%;max-height:560px;margin:24px 0;object-fit:cover;border-radius:14px;background:#e8efec}.facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:26px 0}.fact{padding:14px 16px;background:#f5faf8;border-radius:10px}.fact dt{font-size:13px;color:var(--muted)}.fact dd{margin:3px 0 0}.notice{margin-top:26px;padding:12px 14px;border-left:3px solid #e0a800;background:#fff9db;color:#5f4b00}.primary-link{display:inline-block;margin-top:18px;padding:10px 16px;border-radius:10px;background:var(--accent);color:#fff;text-decoration:none;font-weight:700}footer{display:flex;justify-content:center;flex-wrap:wrap;gap:18px;padding:24px;background:#fff;border-top:1px solid var(--line);font-size:13px}@media(max-width:860px){.province-grid,.place-grid{grid-template-columns:repeat(2,1fr)}.listing-hero{grid-template-columns:1fr}.listing-hero img{height:240px}}@media(max-width:560px){.province-grid,.place-grid{grid-template-columns:1fr}.facts{grid-template-columns:1fr}.detail-card,.directory-intro{padding:22px}.place-card img,.province-card img{width:104px;height:84px}}
`);
}

function main() {
  const { outputDir } = parseArguments(process.argv.slice(2));
  const provinceIndex = readJson(path.join(outputDir, 'data', 'provinces-index.json'));
  const provinceEntries = [];
  const sitemapPaths = ['/', '/destinations/index.html'];
  let attractionCount = 0;

  generateStyles(outputDir);
  for (const [provinceName, province] of Object.entries(provinceIndex)) {
    if (!/^[a-z0-9_-]+$/.test(province.id)) throw new Error(`Unsafe province id: ${province.id}`);
    const provinceData = readJson(path.join(outputDir, 'data', 'provinces', province.dataFile));
    const attractions = Array.isArray(provinceData) ? provinceData : provinceData.attractions;
    if (!Array.isArray(attractions)) throw new Error(`Invalid attractions for ${provinceName}`);
    for (const attraction of attractions) {
      if (!/^[A-Za-z0-9_-]+$/.test(String(attraction.id))) throw new Error(`Unsafe attraction id: ${attraction.id}`);
      sitemapPaths.push(generateAttractionPage(outputDir, provinceName, province.id, attraction));
      attractionCount += 1;
    }
    sitemapPaths.push(generateProvincePage(outputDir, provinceName, province, attractions));
    provinceEntries.push({ provinceName, province, count: attractions.length });
  }
  generateDirectoryPage(outputDir, provinceEntries);

  // Omit lastmod until each content record has its own reliable update date.
  // Using the build time would falsely mark all 5,000+ pages as changed on every deployment.
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapPaths.map(urlPath => `  <url><loc>${siteOrigin}${escapeHtml(urlPath)}</loc></url>`).join('\n')}\n</urlset>\n`;
  writeFile(outputDir, 'sitemap.xml', sitemap);
  writeFile(outputDir, 'robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${siteOrigin}/sitemap.xml\n`);
  writeFile(outputDir, 'seo-build-info.json', `${JSON.stringify({ provinceCount: provinceEntries.length, attractionCount, sitemapUrlCount: sitemapPaths.length, generatedAt: new Date().toISOString() }, null, 2)}\n`);
  console.log(`SEO pages ready: ${provinceEntries.length} provinces, ${attractionCount} attractions, ${sitemapPaths.length} sitemap URLs.`);
}

main();
