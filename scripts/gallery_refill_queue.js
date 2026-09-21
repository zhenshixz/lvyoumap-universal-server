const C = require('./gallery_link_batch_common');
const { path, read, write } = C;

const TARGET_IMAGES = 3;
const queueFile = base => path.join(base, 'content/attraction-gallery-refill-queue.json');

function load(base = C.root) {
  const value = read(queueFile(base), { version: 1, updatedAt: null, items: [] });
  const items = Array.isArray(value.items) ? value.items : [];
  // Older deletion batches only stored the count when one protected image remained.
  // Hydrate that image from current Beta data so it enters post-refill review later.
  const overrides = read(path.join(base, 'content/attraction-gallery-overrides.json'), {});
  for (const item of items) {
    if (item.status !== 'pending' || item.remainingCount !== 1 || (item.deferredReviewImages || []).length) continue;
    const gallery = overrides[item.id];
    const image = gallery?.image || gallery?.images?.[0]?.url;
    if (!image) continue;
    item.deferredReviewImages = [{ url: image, source: 'existing', reasons: ['删除时因最后一张保护，补图后复审'], status: 'waiting_refill', flaggedAt: item.updatedAt || item.createdAt || null }];
    item.cleanupReviewStatus = 'waiting_refill';
  }
  return { version: 1, updatedAt: value.updatedAt || null, items };
}

function save(base, value) {
  const next = { version: 1, updatedAt: new Date().toISOString(), items: value.items || [] };
  write(queueFile(base), next);
  return next;
}

function pending(base = C.root) {
  return load(base).items.filter(item => item.status === 'pending');
}

function cleanupReady(base = C.root) {
  return load(base).items.filter(item => item.cleanupReviewStatus === 'pending' && (item.deferredReviewImages || []).some(image => image.status === 'ready'));
}

function recordDeletion(plan, base = C.root) {
  const queue = load(base);
  const byId = new Map(queue.items.map(item => [item.id, item]));
  let refillQueuedCount = 0;
  let cleanupReviewedCount = 0;
  const recordedAt = new Date().toISOString();
  for (const item of plan.items) {
    const previous = byId.get(item.id);
    const removedUrls = new Set(item.removeUrls || []);
    const priorDeferred = previous?.deferredReviewImages || [];
    const reviewedDeferred = priorDeferred.filter(image => removedUrls.has(image.url));
    cleanupReviewedCount += reviewedDeferred.length;
    const deferredReviewImages = [
      ...priorDeferred.filter(image => !removedUrls.has(image.url)),
      ...(item.deferredReviewImages || []).filter(image => !priorDeferred.some(old => old.url === image.url)).map(image => ({
        ...image,
        reviewBatchId: plan.id,
        flaggedAt: recordedAt,
        status: 'waiting_refill',
      })),
    ];
    const needsReplacement = item.remaining.length < TARGET_IMAGES;
    if (needsReplacement) refillQueuedCount++;
    const removedImages = [
      ...(previous?.removedImages || []),
      ...(item.removed || []).map(image => ({ ...image, reviewBatchId: plan.id, removedAt: recordedAt })),
    ];
    const reviewBatchIds = [...new Set([...(previous?.reviewBatchIds || []), plan.id])];
    let cleanupReviewStatus = previous?.cleanupReviewStatus || null;
    if (deferredReviewImages.some(image => image.status === 'ready')) cleanupReviewStatus = 'pending';
    else if (deferredReviewImages.length) cleanupReviewStatus = 'waiting_refill';
    else if (reviewedDeferred.length) cleanupReviewStatus = 'completed';
    const next = {
      ...(previous || {}),
      id: item.id,
      name: item.name,
      province: item.province || previous?.province || '',
      city: item.city || previous?.city || '',
      status: needsReplacement ? 'pending' : (previous?.status === 'pending' ? 'pending' : previous?.status || 'not_required'),
      targetImageCount: TARGET_IMAGES,
      remainingCount: item.remaining.length,
      removedImages,
      deferredReviewImages,
      cleanupReviewStatus,
      reviewBatchIds,
      reason: '人工审图删除错图、无关图或低质图后补图',
      createdAt: previous?.createdAt || recordedAt,
      updatedAt: recordedAt,
    };
    if (needsReplacement) {
      delete next.completedAt;
      delete next.completedBatchId;
      delete next.finalImageCount;
    }
    byId.set(item.id, next);
  }
  queue.items = [...byId.values()];
  save(base, queue);
  return { refillQueuedCount, cleanupReviewedCount };
}

function complete(items, batchId, base = C.root) {
  const queue = load(base);
  const completedAt = new Date().toISOString();
  let completedCount = 0;
  for (const result of items) {
    const item = queue.items.find(entry => entry.id === result.id && entry.status === 'pending');
    if (!item) continue;
    completedCount++;
    item.status = 'completed';
    item.completedAt = completedAt;
    item.completedBatchId = batchId;
    item.finalImageCount = result.finalImageCount;
    item.updatedAt = completedAt;
    const finalUrls = new Set(result.urls || []);
    for (const image of item.deferredReviewImages || []) {
      if (image.status === 'waiting_refill' && finalUrls.has(image.url) && result.finalImageCount >= TARGET_IMAGES) image.status = 'ready';
    }
    if ((item.deferredReviewImages || []).some(image => image.status === 'ready')) item.cleanupReviewStatus = 'pending';
  }
  if (completedCount) save(base, queue);
  return completedCount;
}

module.exports = { TARGET_IMAGES, queueFile, load, save, pending, cleanupReady, recordDeletion, complete };
