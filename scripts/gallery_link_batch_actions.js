const C = require('./gallery_link_batch_common');
const { fs, path, root, runtime, runs, read, write, alive, draft, batchPath, batchList } = C;
const { spawn } = require('child_process');
const crypto = require('crypto');
const draftsDir = path.join(runtime, 'drafts');
fs.mkdirSync(draftsDir, { recursive: true });
const stamp = () => new Date().toISOString().replace(/[^0-9]/g, '') + '-' + crypto.randomBytes(3).toString('hex');
function states() { return batchList().map(b => read(path.join(batchPath(b.id), 'state.json'))); }
function receipt(id) {
  const value = read(path.join(batchPath(id), 'apply.json'));
  if (value?.status === 'applying' && !alive(value.pid)) return { ...value, status: 'interrupted', error: '写入进程已中断，请点击恢复写入；将先恢复备份。' };
  return value;
}
function assertIdle() {
  if (alive(read(path.join(runtime, 'apply.lock'))?.pid)) throw Error('正在写入Beta，请等待完成');
  for (const file of [path.join(runtime, 'worker.lock'), path.join(root, '.runtime/attraction-gallery-batch/codex-background.lock')]) {
    if (alive(read(file)?.pid)) throw Error('采集正在运行，请等待当前任务结束');
  }
  for (const s of states()) {
    const r = receipt(s.id);
    if (r?.status === 'applying') throw Error('正在写入Beta，请等待完成');
    if (r?.status === 'interrupted') throw Error('上次写入中断，请先在该批次恢复写入');
  }
}
function archive(value) {
  const id = value.draftId || stamp();
  write(path.join(draftsDir, id + '.json'), { ...value, draftId: id });
  return id;
}
function draftList() {
  return fs.readdirSync(draftsDir).filter(x => /^[0-9]+-[a-f0-9]{6}\.json$/.test(x)).sort().reverse().map(file => {
    const d = read(path.join(draftsDir, file));
    return { id: file.slice(0, -5), count: d.items.length, savedAt: d.savedAt, createdAt: d.createdAt };
  });
}
function saveDraft(input) {
  const next = C.validateDraft(input, draft());
  next.draftId = archive(next);
  write(path.join(runtime, 'draft.json'), next);
  return next;
}
function pool(mode = 'new') {
  const source = read(path.join(root, '.runtime/attraction-gallery-batch/state.json'), { items: [] });
  const published = read(path.join(root, 'content/attraction-gallery-overrides.json'), {});
  const attempted = new Set(), waiting = new Set(), settled = new Set();
  for (const s of states()) {
    const applied = read(path.join(batchPath(s.id), 'apply.json'));
    if (applied?.status === 'applied') for (const id of applied.ids) settled.add(id);
    for (const i of s.items) {
      attempted.add(i.id);
      if (s.status !== 'completed' || (i.images || []).some(im => im.accepted)) waiting.add(i.id);
    }
  }
  const reserved = new Set();
  for (const d of draftList()) for (const i of read(path.join(draftsDir, d.id + '.json')).items) if (!attempted.has(i.id)) reserved.add(i.id);
  for (const i of draft().items) if (!attempted.has(i.id)) reserved.add(i.id);
  return source.items.filter(i => i.id && !String(i.status).startsWith('excluded_') && !String(i.status).startsWith('ready_for_') && !published[i.id] && !settled.has(i.id) && !waiting.has(i.id) && !reserved.has(i.id)
    && (mode === 'retry' ? attempted.has(i.id) : !attempted.has(i.id)));
}
function generate(input) {
  assertIdle();
  const count = Number(input.count);
  if (!Number.isInteger(count) || count < 1 || count > 100) throw Error('请输入1–100之间的整数');
  const current = draft();
  if (input.revision !== current.revision) throw Error('清单已更新，请刷新');
  const available = pool(input.mode);
  if (!available.length) throw Error('当前条件下没有可生成的景点');
  archive(current);
  const value = { draftId: stamp(), revision: current.revision + 1, createdAt: new Date().toISOString(), savedAt: null, mode: input.mode || 'new', items: available.slice(0, count).map(i => ({ id: i.id, name: i.name, province: i.province, city: i.city || '', region: i.city || '', beforeSelected: i.selected?.length || 0, url: '', skip: false })) };
  archive(value); write(path.join(runtime, 'draft.json'), value);
  return value;
}
function restore(input) {
  assertIdle();
  if (!/^[0-9]+-[a-f0-9]{6}$/.test(input.id)) throw Error('Invalid draft ID');
  const current = draft();
  if (input.revision !== current.revision) throw Error('清单已更新，请刷新');
  const value = read(path.join(draftsDir, input.id + '.json'));
  if (!value) throw Error('清单不存在');
  archive(current); value.revision = current.revision + 1;
  archive(value); write(path.join(runtime, 'draft.json'), value); return value;
}
function detach(script, args, log) {
  const fd = fs.openSync(log, 'a');
  const child = spawn(process.execPath, [path.join(__dirname, script), ...args], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
  child.on('error', e => console.error(e.message)); child.unref(); fs.closeSync(fd); return child;
}
async function start(input) {
  const lock = read(path.join(runtime, 'worker.lock'));
  if (alive(lock?.pid)) return { running: true };
  assertIdle();
  const current = draft();
  if (input.revision !== current.revision || !current.savedAt) throw Error('请先保存当前清单');
  const match = states().find(s => s.revision === current.revision || (current.draftId && s.draftId === current.draftId && JSON.stringify(s.items.map(i => [i.id,i.url,i.skip])) === JSON.stringify(current.items.map(i => [i.id,i.url,i.skip]))));
  if (match?.status === 'completed' && !match.items.some(i => i.trip?.status === 'identity_review')) return { id: match.id, completed: true };
  require('./gallery_link_batch_python').resolvePython();
  const child = detach('gallery_link_batch_worker.js', match ? ['--resume=' + match.id] : [], path.join(runtime, 'worker.log'));
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 100));
    const s = states().find(s => s.pid === child.pid);
    if (s) return { id: s.id, running: true };
    if (!alive(child.pid)) throw Error('启动失败，请查看worker.log');
  }
  return { running: true };
}
async function apply(input) {
  const old = receipt(input.id);
  if (old?.status === 'applied' || old?.status === 'applying') return old;
  // Recovery of an interrupted transaction must be allowed for its own batch.
  if (old?.status !== 'interrupted') assertIdle();
  else if (alive(read(path.join(runtime, 'worker.lock'))?.pid)) throw Error('请等待采集结束');
  const dir = batchPath(input.id);
  const s = read(path.join(dir, 'state.json'));
  if (s?.status !== 'completed') throw Error('请等批次处理结束');
  const { makePlan } = require('./gallery_link_batch_apply');
  const plan = makePlan(s, input.selections);
  write(path.join(dir, 'approval.json'), plan);
  const child = detach('gallery_link_batch_apply.js', [input.id], path.join(dir, 'apply.log'));
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, 100));
    const value = receipt(input.id);
    if (value?.pid === child.pid && ['applying', 'applied', 'failed'].includes(value.status)) return value;
    if (!alive(child.pid)) throw Error('写入启动失败，请查看该批次apply.log');
  }
  throw Error('写入准备超时，请稍后查看当前批次状态');
}
module.exports = { receipt, pool, draftList, saveDraft, generate, restore, start, apply, assertIdle };
