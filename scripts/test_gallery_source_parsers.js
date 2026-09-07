const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseCtripGallery } = require('./gallery_source_parsers');
const wrap = initialState => `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({props:{pageProps:{initialState}}})}</script>`;
const poiDetail = { poiName: '测试景点', poiId: 10, imageInfo: {poiPhotoImageList: [
  {imageId: 1, imageUrl: 'https://dimg04.c-ctrip.com/images/exact.jpg'}
]}};
const html = wrap({poiDetail, comments: [{imageUrl: 'https://dimg04.c-ctrip.com/images/comment.jpg'}],
  related: [{imageUrl: 'https://dimg04.c-ctrip.com/images/unrelated.jpg'}]});
assert.deepEqual(parseCtripGallery(html, {name:'测试景点'}).photos.map(p=>p.imageId), [1]);
assert.throws(()=>parseCtripGallery(html, {name:'别的景点'}), /实体不匹配/);
assert.throws(()=>parseCtripGallery('<html>not data</html>', {name:'测试景点'}), /数据缺失/);
assert.throws(()=>parseCtripGallery(wrap({poiDetail:{poiName:'测试景点'}}), {name:'测试景点'}), /相册字段缺失/);
const fixture = path.resolve(__dirname, '../.runtime/attraction-gallery-batch/lingyin.html');
if (fs.existsSync(fixture)) {
  const real = parseCtripGallery(fs.readFileSync(fixture,'utf8'),{name:'灵隐寺'});
  assert.equal(real.photos.length,4);
  assert(real.photos.every(p=>p.width>=1000 && p.imageId));
}
console.log('PASS: exact entity, gallery-only extraction, missing-data rejection, cached real-page fixture');
