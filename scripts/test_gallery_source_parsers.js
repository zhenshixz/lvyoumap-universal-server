const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseCtripGallery, parseTripAttractionGallery, parseTripPhotoListGallery,
  parseOfficialSiteGallery } = require('./gallery_source_parsers');
const wrap = initialState => `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({props:{pageProps:{initialState}}})}</script>`;
const poiDetail = { poiName: '测试景点', poiId: 10, imageInfo: {poiPhotoImageList: [
  {imageId: 1, imageUrl: 'https://dimg04.c-ctrip.com/images/exact.jpg'}
]}};
const html = wrap({poiDetail, comments: [{imageUrl: 'https://dimg04.c-ctrip.com/images/comment.jpg'}],
  related: [{imageUrl: 'https://dimg04.c-ctrip.com/images/unrelated.jpg'}]});
assert.deepEqual(parseCtripGallery(html, {name:'测试景点'}).photos.map(p=>p.imageId), [1]);
assert.deepEqual(parseCtripGallery(html, {name:'测试景区', aliases:['测试景点']}).photos.map(p=>p.imageId), [1]);
assert.throws(()=>parseCtripGallery(html, {name:'别的景点'}), /实体不匹配/);
assert.throws(()=>parseCtripGallery('<html>not data</html>', {name:'测试景点'}), /数据缺失/);
assert.throws(()=>parseCtripGallery(wrap({poiDetail:{poiName:'测试景点'}}), {name:'测试景点'}), /相册字段缺失/);
const tripDetail = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({props:{pageProps:{initialState:{appData:{
  poiData:{poiId:20,poiName:'测试景点',poiImage:[{imageUrl:'https://ak-d.tripcdn.com/images/a.jpg'}]},
  overviewData:{imageInfo:{slideShowImages:[{imageUrl:'https://ak-d.tripcdn.com/images/b.jpg'}]}},
}}}}})}</script>`;
assert.deepEqual(parseTripAttractionGallery(tripDetail, 20).photos.map(p=>p.imageUrl), [
  'https://ak-d.tripcdn.com/images/a.jpg', 'https://ak-d.tripcdn.com/images/b.jpg',
]);
assert.throws(()=>parseTripAttractionGallery(tripDetail, 21), /实体不匹配/);
const tripList = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({props:{pageProps:{picItem:{photoList:[
  {poiId:30,name:'测试景点',imageDetail:[{imageUrl:'https://ak-d.tripcdn.com/images/c.jpg'}]},
]}}}})}</script>`;
assert.equal(parseTripPhotoListGallery(tripList, '测试景点').photos.length, 1);
assert.throws(()=>parseTripPhotoListGallery(tripList, '其他景点'), /实体不匹配/);
const official = `<img src="/outside.jpg"><main>START
  <img src="/Uploads/Images/a.jpg"><div style="background:url('/Uploads/Images/b.jpg')"></div>
  <img src="https://other.example/Uploads/Images/c.jpg">END</main>`;
assert.deepEqual(parseOfficialSiteGallery(official, {
  url: 'https://official.example/home', includePath: '/Uploads/Images/', sectionStart: 'START', sectionEnd: 'END',
}).photos.map(photo => photo.imageUrl), [
  'https://official.example/Uploads/Images/a.jpg', 'https://official.example/Uploads/Images/b.jpg',
]);
assert.throws(() => parseOfficialSiteGallery(official, {
  url: 'http://official.example/home', includePath: '/Uploads/Images/',
}), /HTTPS/);
const fixture = path.resolve(__dirname, '../.runtime/attraction-gallery-batch/lingyin.html');
if (fs.existsSync(fixture)) {
  const real = parseCtripGallery(fs.readFileSync(fixture,'utf8'),{name:'灵隐寺'});
  assert.equal(real.photos.length,4);
  assert(real.photos.every(p=>p.width>=1000 && p.imageId));
}
console.log('PASS: official-site/Ctrip/Trip exact entity, gallery-only extraction and missing-data rejection');
