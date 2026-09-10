const assert = require('node:assert/strict');
const { searchLinks, identityIn, qualityScore, createWebSources, specificEntityName, canonicalTripUrl } = require('./gallery_web_sources');
assert(!specificEntityName('植物园'));
assert(specificEntityName('太原植物园'));
assert.equal(canonicalTripUrl('https://hk.trip.com/travel-guide/attraction/guiyang/qianling-mountain-park-75929?curr=HKD&locale=zh-HK'),
  'https://hk.trip.com/travel-guide/attraction/guiyang/qianling-mountain-park-75929/');
assert.deepEqual(searchLinks('<a href="/url?q=https%3A%2F%2Fexample.org%2F"><h3>测试官网</h3></a>',
  'https://www.google.com/search?q=test'), [{ url: 'https://example.org/', title: '测试官网' }]);
assert.equal(searchLinks('<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2F">官网</a>',
  'https://html.duckduckgo.com/html/')[0].url, 'https://example.org/');
assert(identityIn('黃果樹瀑布', { name: '黄果树瀑布', city: '安顺' }));
assert(!identityIn('黄河风景区', { name: '黄果树瀑布', city: '安顺' }));
assert(qualityScore({ dimensions: { width: 1600, height: 1200 } }) > qualityScore({ dimensions: { width: 1000, height: 560 } }));
(async () => {
  const calls = [];
  const web = createWebSources({ trustedOfficialHosts: new Set(), fetchJson: async () => ({}), fetchText: async url => {
    calls.push(url);
    if (url.includes('google.com')) return '<title>Google Search</title><a>click here</a>';
    return '<a class="result__a" href="https://example.org/">测试官网</a>';
  } });
  assert.equal((await web.search('测试官网', () => true))[0].url, 'https://example.org/');
  await web.search('另一个官网', () => true);
  assert.equal(calls.filter(u => u.includes('google.com')).length, 1, 'blocked Google must not delay every item');
  const wiki = createWebSources({ trustedOfficialHosts: new Set(), fetchText: async () => '', fetchJson: async raw => {
    const u = new URL(raw);
    if (u.searchParams.get('action') === 'parse') return { parse: { text: {'*':'<table class="infobox"><tr><td>晋中</td></tr></table><figure><a href="/wiki/File:Qiao.jpg"><img></a><figcaption>乔家大院正门</figcaption></figure>'} } };
    if (u.searchParams.get('prop') === 'imageinfo') return { query: { pages: {1:{title:'File:Qiao.jpg',imageinfo:[{width:1800,height:1200,url:'https://upload.wikimedia.org/Qiao.jpg'}]}}} };
    return {query:{pages:{1:{pageid:1,title:'乔家大院'}}}};
  }});
  assert.equal((await wiki.wikipedia({name:'乔家大院',city:'晋中'}, [])).length, 1, 'infobox location must remain available to entity validation');
  console.log('PASS: Google/DDG links, simplified/traditional names, quality ordering, automatic search failover');
})().catch(error => { console.error(error); process.exitCode = 1; });
