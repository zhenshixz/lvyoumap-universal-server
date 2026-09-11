const ready = item => item?.status === 'ready_for_user_review' && item.selected?.length >= 3;
const excluded = item => item?.status?.startsWith('excluded_');
function recordBatch(job, items, ids, run, now = Date.now()) {
  const byId = new Map(items.map(x => [x.id, x]));
  const completed = [];
  for (const id of ids) {
    const item = byId.get(id);
    if (item?.backgroundReceipt?.run !== run) continue;
    completed.push(id);
    job.accounted ||= {};
    if (job.accounted[id] === run) continue;
    job.accounted[id] = run;
    job.visits[id] = (job.visits[id] || 0) + 1;
    if (item.retryable && !ready(item)) {
      job.transient[id] = (job.transient[id] || 0) + 1;
      job.nextAt[id] = now + Math.min(3600000, 120000 * 2 ** Math.min(job.transient[id] - 1, 5));
    } else {
      job.attempts[id] = (job.attempts[id] || 0) + 1;
      delete job.nextAt[id];
    }
  }
  return completed;
}
function candidates(job, items, now = Date.now()) {
  const byId = new Map(items.map(x => [x.id, x]));
  const remaining = job.ids.filter(id => !ready(byId.get(id)) && !excluded(byId.get(id)));
  const eligible = remaining.filter(id => byId.get(id)?.status !== 'ready_for_visual_review' && (job.attempts[id] || 0) < 2 && (job.transient[id] || 0) < 8 && (job.failures[id] || 0) < 5);
  const pending = eligible.filter(id => (job.nextAt[id] || 0) <= now).sort((a, b) =>
    (job.visits[a] || 0) - (job.visits[b] || 0) || (job.failures[a] || 0) - (job.failures[b] || 0)
    || (byId.get(b)?.selected?.length || 0) - (byId.get(a)?.selected?.length || 0));
  return { remaining, eligible, pending, wakeAt: Math.min(...eligible.map(id => job.nextAt[id] || now)) };
}
module.exports = { ready, excluded, recordBatch, candidates };
