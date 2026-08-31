const fs = require('fs');

const key = fs.readFileSync('.env', 'utf8').match(/^AMAP_WEB_SERVICE_KEY\s*=\s*(.*)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
if (!key) throw new Error('未找到 AMAP_WEB_SERVICE_KEY');

const ids = ['B021B0XP0D', 'B025502BAH', 'B0FFI7K31Q', 'B0FFK8C0HS', 'B0L1GZAXVP', 'B0KD6RJ7TV', 'B000A840SB', 'B0FFH0IXYH', 'B020302227', 'B000A83C1S'];

(async () => {
  for (const id of ids) {
    const url = new URL('https://restapi.amap.com/v5/place/detail');
    url.searchParams.set('key', key);
    url.searchParams.set('id', id);
    url.searchParams.set('show_fields', 'business,photos');
    const response = await fetch(url).then((res) => res.json());
    const poi = response.pois?.[0] || {};
    console.log(JSON.stringify({
      id,
      status: response.status,
      info: response.info,
      name: poi.name,
      address: poi.address,
      tel: poi.tel,
      business: poi.business,
      biz_ext: poi.biz_ext,
      photosCount: poi.photos?.length || 0,
    }));
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
