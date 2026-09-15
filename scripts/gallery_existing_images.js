const C = require('./gallery_link_batch_common');
function imagesOf(item) {
  if (!item) return [];
  const list = (item.images || []).map(im => typeof im === 'string' ? { url: im } : { ...im });
  if (item.image && !list.some(im => im.url === item.image)) list.unshift({ url: item.image, imageSource: item.image_source });
  return [...new Map(list.filter(im => im.url).map(im => [im.url, im])).values()];
}
function existingMap(base = C.root, dataDir = C.path.join(base, 'data'), overrides) {
  const map = new Map(), folder = C.path.join(dataDir, 'provinces');
  if (C.fs.existsSync(folder)) for (const file of C.fs.readdirSync(folder).filter(f => f.endsWith('.json'))) {
    const value = C.read(C.path.join(folder, file), {});
    for (const i of value?.attractions || []) map.set(i.id, i);
  }
  overrides ??= C.read(C.path.join(base, 'content/attraction-gallery-overrides.json'), {});
  for (const [id, value] of Object.entries(overrides)) map.set(id, { ...map.get(id), ...value });
  return map;
}
function mergeImages(existing, additions, coverUrl) {
  const images = imagesOf(existing), urls = new Set(images.map(im => im.url));
  for (const im of additions) if (!urls.has(im.url)) { images.push(im); urls.add(im.url); }
  if (!images.length && !coverUrl) return [];
  const cover = coverUrl || existing?.image || images[0]?.url;
  if (!urls.has(cover)) throw Error('封面不属于保留的旧图或本批选中新图');
  const index = images.findIndex(im => im.url === cover);
  if (index > 0) images.unshift(...images.splice(index, 1));
  return images;
}
module.exports = { imagesOf, existingMap, mergeImages };
