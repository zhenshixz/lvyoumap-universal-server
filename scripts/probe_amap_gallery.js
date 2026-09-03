const fs = require('fs');
const path = require('path');
const { bufferDimensions } = require('./collect_core_details');

const root = path.resolve(__dirname, '..');
for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
  if (match && !process.env[match[1]]) {
    process.env[match[1]] = match[2].trim().replace(/^(?:"(.*)"|'(.*)')$/, '$1$2');
  }
}

const keys = [...new Set([
  ...String(process.env.AMAP_WEB_SERVICE_KEYS || '').split(','),
  String(process.env.AMAP_WEB_SERVICE_KEY || ''),
].map(value => value.trim()).filter(Boolean))];
const ids = process.argv.slice(2).map(id => id.replace(/^amap_/i, '')).filter(Boolean);
const reviewDir = path.join(root, '.runtime', 'amap-gallery-probe');
fs.mkdirSync(reviewDir, { recursive: true });

function highDefinitionUrl(value) {
  const url = String(value || '').replace(/^http:/i, 'https:');
  if (/([?&])type=/.test(url)) return url.replace(/([?&])type=[^&]*/i, '$1type=7');
  return `${url}${url.includes('?') ? '&' : '?'}type=7`;
}

async function detail(id) {
  for (const key of keys) {
    const url = new URL('https://restapi.amap.com/v5/place/detail');
    url.searchParams.set('key', key);
    url.searchParams.set('id', id);
    url.searchParams.set('show_fields', 'photos');
    try {
      const payload = await fetch(url, { signal: AbortSignal.timeout(10000) }).then(result => result.json());
      if (String(payload.status) === '1') return payload.pois?.[0] || null;
    } catch {
      // 自动尝试下一个 Key。
    }
  }
  return null;
}

(async () => {
  for (const id of ids) {
    const poi = await detail(id);
    console.log(`\n${id} ${poi?.name || '未找到'} 图片 ${poi?.photos?.length || 0} 张`);
    for (const [index, photo] of (poi?.photos || []).entries()) {
      const url = highDefinitionUrl(photo.url);
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
        const buffer = Buffer.from(await response.arrayBuffer());
        const dimensions = bufferDimensions(buffer);
        fs.writeFileSync(path.join(reviewDir, `${id}_${index + 1}.jpg`), buffer);
        console.log(`${index + 1}\t${dimensions?.width || 0}x${dimensions?.height || 0}\t${Math.round(buffer.length / 1024)}KB\t${url}`);
      } catch {
        console.log(`${index + 1}\t读取失败\t${url}`);
      }
    }
  }
})().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
