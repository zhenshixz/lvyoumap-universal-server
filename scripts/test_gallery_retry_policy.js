const assert=require('assert/strict');
const {classify,previousAttempt}=require('./gallery_retry_policy');
const url='https://hk.trip.com/travel-guide/attraction/city/place-123/';
const exhausted={id:'a',url,done:true,trip:{status:'collected'},images:[{source:'trip',bytes:123,accepted:false,reason:'尺寸不足'}]};
assert.equal(classify(exhausted),'manual');
assert.ok(previousAttempt({...exhausted,url:url+'?locale=zh-HK'},[exhausted]));
assert.equal(previousAttempt({...exhausted,url:url.replace('123','456')},[exhausted]),undefined);
assert.equal(classify({...exhausted,images:[{source:'trip',accepted:false,reason:'ECONNRESET'}]}),'retry');
assert.equal(classify({...exhausted,trip:{status:'error',reason:'HTTP 503'}}),'retry');
assert.equal(classify({...exhausted,trip:{status:'empty'},images:[]}),'manual');
assert.equal(classify({done:true,discovery:{status:'manual'},trip:{status:'skipped'}}),'manual');
assert.equal(classify({done:true,trip:{status:'skipped'},url:''}),'new');
assert.equal(classify({done:false,discovery:{status:'error'}}),'retry');
assert.ok(previousAttempt({id:'a',url:''},[exhausted]));
assert.equal(previousAttempt({id:'b',url},[exhausted]),undefined);
console.log('PASS: quality exhaustion, canonical URL suppression, changed URL, transient retry, manual discovery.');

const {parseTripAttractionGallery}=require('./gallery_source_parsers');
function page(poi,imageInfo){return '<script id="__NEXT_DATA__">'+JSON.stringify({props:{pageProps:{initialState:{appData:{poiData:poi,overviewData:{imageInfo}}}}}})+'</script>';}
const poi={poiId:123,poiName:'占位测试',poiImageCount:0,defaultUrl:'https://ak-d.tripcdn.com/images/default.jpg',poiImage:[{imageUrl:'https://ak-d.tripcdn.com/images/default.jpg'}]};
const info={imageCount:0,showGallery:false};
const placeholder=parseTripAttractionGallery(page(poi,info),123);
assert.equal(placeholder.noImageConfirmed,true);assert.equal(placeholder.photos.length,0);
assert.equal(parseTripAttractionGallery(page({...poi,poiImageCount:1},{imageCount:1,showGallery:true}),123).photos.length,1);
assert.equal(parseTripAttractionGallery(page({...poi,poiImageCount:undefined},{}),123).noImageConfirmed,undefined);
const closed={id:'closed',url,trip:{status:'no_image_available',noImageConfirmed:true}};
assert.equal(classify(closed),'closed');assert.ok(previousAttempt({id:'closed',url:''},[closed]));
assert.equal(previousAttempt({...closed,url:url.replace('123','456')},[closed]),undefined);
console.log('PASS: explicit placeholder closed; real and unknown galleries preserved; new URL remains eligible.');
