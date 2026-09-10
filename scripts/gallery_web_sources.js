const { load } = require('cheerio');
const fs = require('fs');
const path = require('path');
const simplify = require('opencc-js').Converter({ from: 'tw', to: 'cn' });
const { identityName, parseTripAttractionGallery, parseTripPhotoGallery } = require('./gallery_source_parsers');

const noise = /logo|favicon|二维码|导览图|地图|海报|招聘|广告|示意图|地图|\bmap\b|screenshot/i;
const normalize = value => identityName(simplify(String(value || '').normalize('NFKC')));
const normalizeFull = value => simplify(String(value || '').normalize('NFKC')).toLowerCase().replace(/[\s·•（）()\[\]【】\-_—]/g, '');
const text = ($, selector) => $(selector).text().replace(/\s+/g, ' ').trim();
function namesFor(a) {
  const city = String(a.city || '').replace(/市$/, '');
  const base = [...new Set([a.name, ...(a.aliases || []), city && !a.name.startsWith(city) ? city + a.name : '',
    city && a.name.startsWith(city) ? a.name.slice(city.length) : ''].filter(Boolean))];
  const extras = [];
  for (const n of base) {
    if (n.includes('·') || n.includes('•')) {
      for (const seg of n.split(/[·•]/)) {
        const s = seg.trim();
        if (s.length >= 3) extras.push(s);
      }
    }
    if (/^古[^s]{3,}$/.test(n)) {
      extras.push(n.slice(1));
    }
    const clean = n.replace(/旅游度假区|文化旅游区|生态旅游区|风景名胜区|旅游风景区|国家湿地公园|国家森林公园|国家地质公园|文化旅游景区|旅游景区|风景区|旅游区|景区$/g, '').trim();
    if (clean.length >= 3 && clean !== n) {
      extras.push(clean);
      if (city && !clean.startsWith(city)) extras.push(city + clean);
    }
  }
  return [...new Set([...base, ...extras])];
}
function identityIn(value, a) {
  const haystack = normalize(value);
  const full = normalizeFull(value);
  return namesFor(a).some(name => {
    const core = normalize(name);
    const exact = normalizeFull(name);
    return (core.length >= 3 && haystack.includes(core)) || (core.length >= 2 && full === exact);
  });
}
function specificEntityName(value) {
  return !/^(?:植物园|公园|博物馆|博物院|总统府|广场|风景区|景区|寺庙|海滩|古镇|古文化街道)$/.test(simplify(String(value || '')));
}
function canonicalTripUrl(value) {
  const url = new URL(value);
  url.hostname = 'hk.trip.com';
  url.search = ''; url.hash = '';
  url.pathname = url.pathname.replace(/\/$/, '') + '/';
  return url.href;
}
function absolute(value, base) {
  try { const u = new URL(value, base); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch { return ''; }
}
function searchLinks(html, base) {
  const $ = load(html);
  const elements = $('a.result__a, li.b_algo h2 a').toArray();
  if (new URL(base).hostname.endsWith('google.com')) {
    $('a').has('h3').each((i, e) => elements.push(e));
  }
  return $(elements).map((i, el) => {
    let url = absolute($(el).attr('href'), base);
    try {
      const u = new URL(url);
      if (u.searchParams.has('uddg')) url = u.searchParams.get('uddg');
      if (u.hostname.endsWith('google.com') && u.pathname === '/url') url = u.searchParams.get('q') || u.searchParams.get('url') || '';
      if (u.hostname.endsWith('bing.com') && u.searchParams.get('u')?.startsWith('a1')) {
        url = Buffer.from(u.searchParams.get('u').slice(2), 'base64url').toString();
      }
    } catch { return null; }
    return { url, title: $(el).text().trim() };
  }).get().filter(x => x && /^https?:\/\//.test(x.url));
}

// Search discovers pages only. Search-engine image URLs never enter a gallery.
function createWebSources({ fetchText, fetchJson, postJson, trustedOfficialHosts, discoveryDir }) {
  let titleIndex = {};
  try { titleIndex = JSON.parse(fs.readFileSync(path.join(discoveryDir, '..', 'wikipedia-titles.json'), 'utf8')); } catch { /* Optional batch discovery. */ }
  let active = 0;
  let googleUnavailableUntil = 0;
  const waiters = [];
  function cacheFile(a, kind) { return discoveryDir && path.join(discoveryDir, `${String(a.id).replace(/[^a-z0-9_-]/gi, '_')}-${kind}.json`); }
  function remember(a, kind, link) {
    const file = cacheFile(a, kind);
    if (!file) return;
    fs.mkdirSync(discoveryDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...link, attractionName: a.name, city: a.city, verifiedAt: new Date().toISOString() }));
  }
  async function resolveLinks(a, kind, query, accept) {
    const file = cacheFile(a, kind);
    if (file && fs.existsSync(file)) {
      try { const link = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (link.attractionName === a.name && link.city === a.city) {
          const links = (link.links || [link]).filter(accept);
          if (links.length) return links;
        }
      } catch { /* Re-discover a damaged cache. */ }
    }
    return search(query, accept);
  }
  async function search(query, accept) {
    if (active >= 2) await new Promise(resolve => waiters.push(resolve));
    else active++;
    try {
      const endpoints = [
        ...(Date.now() >= googleUnavailableUntil ? [`https://www.google.com/search?q=${encodeURIComponent(query)}&udm=14`] : []),
        `https://cn.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-hans&cc=cn`,
        `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      ];
      const errors = [];
      for (const url of endpoints) {
        try {
          const html = await fetchText(url, 5000);
          const allLinks = searchLinks(html, url);
          if (new URL(url).hostname === 'www.google.com' && !allLinks.length) googleUnavailableUntil = Date.now() + 30 * 60 * 1000;
          const links = allLinks.filter(accept);
          if (links.length) return links.slice(0, 4);
          errors.push('搜索结果未命中目标页面');
        } catch (e) {
          if (new URL(url).hostname === 'www.google.com') googleUnavailableUntil = Date.now() + 30 * 60 * 1000;
          errors.push(e.message);
        }
      }
      throw new Error(errors.join('; '));
    } finally {
      const next = waiters.shift();
      if (next) next(); else active--;
    }
  }

  async function official(a, attempts) {
    const excluded = /(?:^|\.)(?:trip\.com|ctrip\.com|baidu\.com|wikipedia\.org|zhihu\.com|sohu\.com|163\.com|sina\.com\.cn|qq\.com|toutiao\.com|mafengwo\.cn|douyin\.com|xiaohongshu\.com|bendibao\.com)$/;
    const queryName = a.city && !a.name.includes(a.city) ? `${a.city} ${a.name}` : a.name;
    const links = await resolveLinks(a, 'official', `${queryName} 官网`, x => {
      try { return identityIn(x.title, a) && !excluded.test(new URL(x.url).hostname); } catch { return false; }
    });
    const candidates = [];
    for (const link of links.slice(0, 2)) {
      try {
        const html = await fetchText(link.url, 10000);
        const $ = load(html);
        $('script,style').remove();
        const title = text($, 'title,h1');
        const body = text($, 'body');
        const city = String(a.city || '').replace(/市$/, '');
        const government = /\.gov\.cn$/.test(new URL(link.url).hostname);
        const operatorText = text($, 'footer,[class*=footer],[id*=footer], [class*=copyright]') || body.slice(-1800);
        const operatorVerified = government || (identityIn(operatorText, a) && /版权所有|版權所有|Copyright|主办|主辦/i.test(operatorText));
        // Official identity requires the entity heading plus site/operator evidence,
        // not just a search snippet containing the word "官网".
        if (!identityIn(title, a) || !operatorVerified
          || (city && !simplify(body).includes(city))) throw new Error('官网实体或地域证据未通过');
        const host = new URL(link.url).hostname;
        trustedOfficialHosts.add(host);
        remember(a, 'official', link);
        const pages = [{ url: link.url, html }];
        const children = $('a[href]').map((i, e) => ({ label: $(e).text(), url: absolute($(e).attr('href'), link.url) }))
          .get().filter(x => /风光|風光|美图|美圖|图集|圖集|景点介绍|景點介紹|景区风采|景區風采/.test(x.label)
            && x.url && new URL(x.url).hostname === host).slice(0, 2);
        const childResults = await Promise.allSettled(children.map(async child => ({ url: child.url, html: await fetchText(child.url, 8000) })));
        for (const r of childResults) if (r.status === 'fulfilled') pages.push(r.value);
        for (const page of pages) {
          const p = load(page.html);
          p('script,style,nav,footer,header').remove();
          p('img').each((i, el) => {
            const label = p(el).attr('alt') || p(el).attr('title') || '';
            const raw = p(el).attr('data-original') || p(el).attr('data-src') || p(el).attr('src');
            const url = absolute(raw, page.url);
            if (!url || noise.test(label + ' ' + url) || !/\.(?:jpe?g|png|webp)(?:\?|$)/i.test(url)) return;
            if (new URL(url).hostname !== host) return;
            candidates.push({ url, caption: label || a.name, source: 'official_site', sourceUrl: page.url,
              identityEvidence: { title, city, discoveredBy: 'web-search' } });
          });
        }
        attempts.push({ source: 'official_discovery', result: candidates.length ? 'found' : 'empty', count: candidates.length, url: link.url });
        if (candidates.length >= 5) break;
      } catch (error) { attempts.push({ source: 'official_discovery', result: 'page_rejected', url: link.url, reason: error.message }); }
    }
    return candidates.slice(0, 18);
  }

  async function trip(a, attempts) {
    const links = await resolveLinks(a, 'trip', `${a.city || ''} ${a.name} site:trip.com/travel-guide/attraction/`, x =>
      /https:\/\/(?:[\w-]+\.)?trip\.com\/travel-guide\/attraction\//i.test(x.url) && identityIn(x.title, a));
    const candidates = [];
    for (const link of links.slice(0, 2)) {
      try {
        link.url = canonicalTripUrl(link.url);
        const id = link.url.match(/-(\d+)\/?(?:\?|$)/)?.[1];
        if (!id) continue;
        let parsed = {name:a.name,photos:[]};
        {
          const html = await fetchText(link.url, 10000);
          parsed = parseTripAttractionGallery(html, id);
          const $ = load(html);
          const city = String(a.city || '').replace(/市$/, '');
          const exactNames = namesFor(a).map(normalize);
          if (!exactNames.includes(normalize(parsed.name)) || (city && !simplify(text($, 'title,body')).includes(city))) throw new Error('Trip实体名称或地域不匹配');
        }
        let photos = parsed.photos;
        try {
          photos = parseTripPhotoGallery(await postJson('https://www.trip.com/restapi/soa2/19912/getTripPoiPhotoGallery', {
            poiId: Number(id), index: 1, count: 20, typeList: [1, 2, 3, 4, 5], tagId: '',
          }, 12000));
          attempts.push({ source: 'trip_full_gallery', result: 'found', count: photos.length, poiId: id });
        } catch (error) {
          // Browser-verified links skip the detail-page identity request above. If
          // the gallery API is blocked by its WAF, actually load the public page
          // and use its embedded lead gallery instead of returning an empty set.
          if (!photos.length) {
            try {
              const html = await fetchText(link.url, 10000);
              parsed = parseTripAttractionGallery(html, id);
              photos = parsed.photos;
            } catch (pageError) {
              attempts.push({ source: 'trip_page_fallback', result: 'retryable_error', reason: pageError.message, poiId: id });
            }
          }
          attempts.push({ source: 'trip_full_gallery', result: 'fallback_to_page', reason: error.message,
            count: photos.length, poiId: id });
        }
        remember(a, 'trip', link);
        attempts.push({ source: 'trip_discovery', result: photos.length ? 'found' : 'empty', count: photos.length, poiId: id, url: link.url });
        candidates.push(...photos.map(photo => ({ url: photo.imageUrl, caption: photo.title || parsed.name, source: 'trip_exact',
          sourceUrl: link.url, sourcePoiId: id })));
        if (candidates.length >= 5) break;
      } catch (error) { attempts.push({ source: 'trip_discovery', result: 'retryable_error', reason: error.message, url: link.url }); }
    }
    return [...new Map(candidates.map(candidate => [candidate.url, candidate])).values()];
  }

  async function wikipedia(a, attempts) {
    const city = String(a.city || '').replace(/市$/, '');
    const names = namesFor(a);
    const query = `${city} ${a.name}`;
    const api = params => 'https://zh.wikipedia.org/w/api.php?' + new URLSearchParams({ format: 'json', origin: '*', ...params });
    // Exact title resolution is cheaper than full-text search and also follows
    // the encyclopedia's own redirects/traditional-name normalization.
    const indexed = names.map(n => titleIndex[n]).filter(Boolean);
    const resolved = indexed.length ? {query:{pages:Object.fromEntries(indexed.map(p => [p.pageid,p])),redirects:names.filter(n=>titleIndex[n]).map(n=>({from:n,to:titleIndex[n].title}))}}
      : await fetchJson(api({ action: 'query', titles: names.slice(0, 8).join('|'), redirects: '1', converttitles: '1' }), 10000);
    let hits = Object.values(resolved.query?.pages || {}).filter(p => p.pageid > 0 && p.missing === undefined);
    if (!hits.length) {
      const search = await fetchJson(api({ action: 'query', list: 'search', srsearch: query, srlimit: '3' }), 10000);
      hits = search.query?.search || [];
    }
    const redirectedNames = (resolved.query?.redirects || []).filter(r => names.some(n => normalize(n) === normalize(r.from))).map(r => r.to);
    for (const hit of hits) {
      if (![...names, ...redirectedNames].some(n => normalize(n) === normalize(hit.title))) continue;
      const parsed = (await fetchJson(api({ action: 'parse', pageid: String(hit.pageid), prop: 'text|displaytitle|properties', redirects: '1' }), 10000)).parse;
      if (!parsed?.text?.['*']) continue;
      if (parsed.properties?.some(p => p.name === 'disambiguation')) continue;
      const $ = load(parsed.text['*']);
      // Location is often present only in the infobox. Validate it before
      // removing navigation/infobox images from the candidate image scope.
      if (city && !simplify(text($, 'body')).includes(city)) continue;
      $('.navbox,.vertical-navbox,.reflist,.metadata,.infobox').remove();
      const files = [];
      const embedded = [];
      $('figure, .thumb, .gallerybox').each((i, el) => {
        const caption = $(el).find('figcaption,.thumbcaption,.gallerytext').text().trim();
        if (noise.test(caption)) return;
        $(el).find('img[data-file-width][data-file-height]').each((j, img) => {
          const width = Number($(img).attr('data-file-width'));
          const height = Number($(img).attr('data-file-height'));
          const raw = absolute($(img).attr('src'), 'https://zh.wikipedia.org/');
          if (Math.max(width,height) < 1000 || Math.min(width,height) < 560 || !raw) return;
          const url = new URL(raw);
          if (!/^(?:upload|thumb)\.wikimedia\.org$/.test(url.hostname) || !/\.(?:jpg|jpeg|png|webp)$/i.test(url.pathname)) return;
          // Wikimedia article markup supplies real original dimensions and
          // the standard thumbnail URL. No second imageinfo API call is needed.
          url.pathname = url.pathname.replace(/\/\d+px-([^/]+)$/, '/1600px-$1');
          url.search = '';
          embedded.push({url:url.href,caption:caption || $(img).attr('alt') || hit.title,source:'wikimedia_exact',
            sourceUrl:`https://zh.wikipedia.org/?curid=${hit.pageid}`,identityEvidence:{pageTitle:hit.title,city,field:'article-figure'}});
        });
        $(el).find('a[href]').each((j, link) => {
          const href = $(link).attr('href') || '';
          const match = decodeURIComponent(href).match(/(?:\/wiki\/|^\.\/)(?:File|文件|檔案):(.+)/i);
          if (match && !/\.(?:svg|gif|pdf|tiff?)(?:$|\?)/i.test(match[1])) files.push({ title: `File:${match[1].split('#')[0]}`, caption });
        });
      });
      if (embedded.length) {
        const photos = [...new Map(embedded.map(p=>[p.url,p])).values()].slice(0,20);
        attempts.push({source:'wikipedia_article',result:'found',count:photos.length,title:hit.title});
        return photos;
      }
      const unique = [...new Map(files.map(x => [x.title.replace(/_/g, ' '), x])).values()].slice(0, 20);
      if (!unique.length) continue;
      const metadata = await fetchJson(api({ action: 'query', titles: unique.map(x => x.title).join('|'), prop: 'imageinfo',
        iiprop: 'url|size', iiurlwidth: '1600' }), 10000);
      const photos = Object.values(metadata.query?.pages || {}).flatMap(page => {
        const info = page.imageinfo?.[0];
        if (!info || Math.max(info.width, info.height) < 1000 || Math.min(info.width, info.height) < 560) return [];
        const url = info.thumburl || info.url;
        const label = unique.find(x => x.title.replace(/_/g, ' ') === page.title)?.caption || page.title;
        return [{ url, caption: label, source: 'wikimedia_exact', sourceUrl: `https://zh.wikipedia.org/?curid=${hit.pageid}`,
          identityEvidence: { pageTitle: hit.title, city, field: 'article-figure' } }];
      });
      attempts.push({ source: 'wikipedia_article', result: photos.length ? 'found' : 'empty', count: photos.length, title: hit.title });
      return photos;
    }
    attempts.push({ source: 'wikipedia_article', result: 'no_exact_page', count: 0 });
    return [];
  }
  return { official, trip, wikipedia, search };
}

function qualityScore(image) {
  const w = Number(image.dimensions?.width || 0), h = Number(image.dimensions?.height || 0);
  // Resolution gains saturate: a huge file cannot crowd out every other source.
  return Math.min(Math.min(w, h), 1400) / 14 + Math.min(Math.max(w, h), 2200) / 44;
}
module.exports = { createWebSources, searchLinks, identityIn, namesFor, qualityScore, specificEntityName, simplify, canonicalTripUrl };
