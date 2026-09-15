const C = require('./gallery_link_batch_common');
const TRIP_432_RETRIES = 0;
const TRIP_432_DELAY_MS = 0;
const transient = reason => /ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|Timeout|timed?\s*out|fetch failed|TypeError|HTTP\s*(429|432|5\d\d)|超时|搜索不可用|未加载完成/i.test(reason || '');
function policyUpgrade(item) {
  if ((item.qualityPolicyVersion || 1) < 2 && (item.images||[]).some(im=>im.reason==='尺寸不足' && im.dimensions?.[0]>540)) return true;
  if (item.discovery?.status==='manual' && (item.discovery.policyVersion||1)<5) return true;
  return false;
}
function classify(item) {
  if (item.trip?.noImageConfirmed || item.noImageClosed) return 'closed';
  if ((item.images || []).some(im => im.accepted)) return 'review';
  if (item.skip) return 'manual';
  if (policyUpgrade(item)) return 'retry';
  if (item.discovery?.status === 'error') return 'retry';
  if (['empty', 'already_attempted'].includes(item.trip?.status)) return 'manual';
  if (item.trip?.status === 'collected') {
    return (item.images || []).some(im => im.source === 'trip' && !im.bytes && transient(im.reason)) ? 'retry' : 'manual';
  }
  if (item.trip?.status === 'error') return transient(item.trip.reason) ? 'retry' : 'manual';
  if (item.discovery?.status === 'manual' || ['identity_review', 'unsupported_layout'].includes(item.trip?.status)) return 'manual';
  if (!item.done) return 'retry';
  // A blank manual-only submission has not attempted Trip search yet.
  return item.trip?.status === 'skipped' && !item.url ? 'new' : 'manual';
}
function history(excludeId) {
  return C.batchList().filter(b => b.id !== excludeId).flatMap(b => {
    const state = C.read(C.path.join(C.batchPath(b.id), 'state.json'));
    return (state?.items || []).filter(item=>item.trip?.status!=='already_attempted').map(item => ({ ...item, batchId: b.id }));
  });
}
function canonical(url) { try { return C.tripUrl(url); } catch { return url || ''; } }
function previousAttempt(item, rows) {
  if (item.url) {
    return rows.find(old => old.id === item.id && canonical(old.url) === canonical(item.url)
      && (old.trip?.noImageConfirmed || ['empty', 'already_attempted'].includes(old.trip?.status)
        || old.trip?.status === 'collected' && classify(old) !== 'retry'));
  }
  const latest = rows.find(old => old.id === item.id);
  return latest && ['manual', 'review', 'closed'].includes(classify(latest)) ? latest : null;
}
module.exports = { TRIP_432_RETRIES, TRIP_432_DELAY_MS, policyUpgrade, transient, classify, history, previousAttempt };
