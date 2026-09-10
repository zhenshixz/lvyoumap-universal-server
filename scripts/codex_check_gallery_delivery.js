const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const root = path.resolve(__dirname,'..');
const file = path.join(root,'.runtime/attraction-gallery-batch/codex-approved.json');
(async()=>{
  const snapshot = JSON.parse(fs.readFileSync(file,'utf8'));
  const browser = await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try {
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:4185/preview.html');
    const urls = [...new Set(snapshot.items.flatMap(x=>x.selected.map(y=>y.url)))];
    const results=[];
    for(let i=0;i<urls.length;i+=8) {
      results.push(...await page.evaluate(async list=>Promise.all(list.map(url=>new Promise(resolve=>{
        const image=new Image(); const timer=setTimeout(()=>resolve({url,ok:false,reason:'timeout'}),12000);
        image.referrerPolicy='no-referrer';
        image.onload=()=>{clearTimeout(timer);resolve({url,ok:true,width:image.naturalWidth,height:image.naturalHeight});};
        image.onerror=()=>{clearTimeout(timer);resolve({url,ok:false,reason:'load_error'});};image.src=url;
      }))),urls.slice(i,i+8)));
    }
    fs.writeFileSync(path.join(root,'.runtime/attraction-gallery-batch/codex-browser-check.json'),JSON.stringify(results,null,2));
    console.log(JSON.stringify({checked:results.length,loaded:results.filter(x=>x.ok).length,failed:results.filter(x=>!x.ok).map(x=>({url:x.url,reason:x.reason}))}));
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
