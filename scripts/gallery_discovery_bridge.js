// Local task-only UI: browser-visible search results -> durable source candidates.
// No image/content publication and no access outside the fixed remaining cohort.
const fs = require('fs');
const path = require('path');
const http = require('http');
const {pinyin} = require('pinyin-pro');
const {namesFor,identityIn,simplify} = require('./gallery_web_sources');
const {identityName} = require('./gallery_source_parsers');
const root = path.resolve(__dirname,'..');
const runtime = path.join(root,'.runtime/attraction-gallery-batch');
const dir = path.join(runtime,'discovered-pages');
const history = path.join(runtime,'browser-discovery-history.json');
const read = file => JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const esc = s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
const fixed = new Set(read(path.join(runtime,'remaining-milestones.json')).ids);
const records = new Map(Object.values(read(path.join(root,'content/db.json')).provinces).flatMap(p=>p.attractions||[]).map(a=>[a.id,a]));
let visited = fs.existsSync(history)?read(history):{};
const DISCOVERY_VERSION = 3;
const compact = value => simplify(String(value || '')).toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]/g,'');
const latin = value => String(value || '').toLowerCase().replace(/[^a-z]/g,'');
const cityLatin = value => latin(pinyin(String(value || '').replace(/市$/,''), {toneType:'none'}));
function queue() {
  return read(path.join(runtime,'state.json')).items.filter(x=>fixed.has(x.id)&&x.status==='pending_sources'&&visited[x.id]?.discoveryVersion!==DISCOVERY_VERSION)
    .sort((a,b)=>(b.selected?.length||0)-(a.selected?.length||0)).slice(0,24);
}
http.createServer(async(req,res)=>{
  if(req.method==='POST'&&req.url==='/results') {
    try {
      let body='';for await(const chunk of req){body+=chunk;if(body.length>2e6)throw Error('Payload too large');}
      const results=JSON.parse(new URLSearchParams(body).get('results'));
      fs.mkdirSync(dir,{recursive:true});let found=0;
      for(const result of results){
        const a=records.get(result.id);if(!a||!fixed.has(a.id))throw Error('Unknown cohort ID');
        const city=String(a.city||'').replace(/市$/,'');
        const links=(result.links||[]).filter(l=>/^https:\/\/(?:[\w-]+\.)?trip\.com\/travel-guide\/attraction\//.test(l.url||'')
          &&identityIn(l.title,a)
          &&(!city||compact(l.context).includes(compact(city))||latin(l.context).includes(cityLatin(city))))
          .map(l=>{const u=new URL(l.url);u.hostname='hk.trip.com';u.search='';u.hash='';return{...l,url:u.href,cityVerified:true};});
        const norm=s=>identityName(simplify(s));
        links.sort((a1,b)=>Number(namesFor(a).some(n=>norm(n)===norm(b.title)))-Number(namesFor(a).some(n=>norm(n)===norm(a1.title))));
        const unique=[...new Map(links.map(l=>[l.url,l])).values()].slice(0,2);
        const now=new Date().toISOString();
        visited[a.id]={name:a.name,city:a.city,checkedAt:now,candidatePages:unique.length,discoveryVersion:DISCOVERY_VERSION};
        if(unique.length){
          fs.writeFileSync(path.join(dir,`${a.id}-trip.json`),JSON.stringify({attractionName:a.name,city:a.city,links:unique,discoveredAt:now,discoveredBy:'trip-native-browser-search'}));found++;
        }
      }
      fs.writeFileSync(history,JSON.stringify(visited));
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(`<p id="saved">Saved ${results.length} searches; ${found} matched source candidates.</p><a href="/">Next batch</a>`);
    }catch(e){res.writeHead(400);res.end(e.message);}return;
  }
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
  res.end(`<!doctype html><meta charset="utf-8"><title>图库来源发现队列</title><style>body{font:16px sans-serif;margin:24px;background:#fafafa}td{padding:5px 16px}textarea{display:block;width:90%;height:100px}</style><h1>图库来源发现队列</h1><p>仅保存候选链接，不写入地图。已搜索${Object.keys(visited).length}个。</p><table><thead><tr><th>ID</th><th>景点</th><th>城市</th></tr></thead><tbody>${queue().map(x=>`<tr><td>${esc(x.id)}</td><td>${esc(x.name)}</td><td>${esc(x.city)}</td></tr>`).join('')}</tbody></table><form method="POST" action="/results"><label>搜索结果 JSON<textarea name="results" aria-label="搜索结果 JSON"></textarea></label><button>保存候选结果</button></form>`);
}).listen(4191,'127.0.0.1',()=>console.log('Discovery queue: http://127.0.0.1:4191/'));
