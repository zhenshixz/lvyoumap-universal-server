const { fs, path, runtime, read, write } = require('./gallery_link_batch_common');
const { spawnSync } = require('child_process');
function resolvePython() {
  const file = path.join(runtime, 'python.json');
  const candidates = [process.env.GALLERY_PYTHON, read(file)?.executable];
  const base = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python');
  if (fs.existsSync(base)) for (const name of fs.readdirSync(base).sort().reverse()) candidates.push(path.join(base, name, 'python.exe'));
  candidates.push('python', 'py');
  const failures = [];
  for (const command of [...new Set(candidates.filter(Boolean))]) {
    const q = spawnSync(command, ['-c', 'import sys; from PIL import Image; import cv2,numpy; print(sys.executable)'], { windowsHide: true, timeout: 20000, encoding: 'utf8' });
    if (q.status === 0) {
      const executable = q.stdout.trim();
      if (fs.existsSync(executable)) { write(file, { executable }); return executable; }
    }
    failures.push({ command, reason: q.error?.code || q.stderr?.trim().slice(-600) || `exit ${q.status}` });
  }
  write(path.join(runtime, 'python-check.json'), failures);
  throw Error('No usable Python with Pillow, opencv-python and numpy. See .runtime/gallery-link-batches/python-check.json');
}
module.exports = { resolvePython };
