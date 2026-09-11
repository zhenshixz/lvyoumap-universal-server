const fs = require('fs');
const wait = new Int32Array(new SharedArrayBuffer(4));
function replaceCheckpoint(source, destination, rename = fs.renameSync) {
  for (let attempt = 0; ; attempt++) {
    try { rename(source, destination); return; }
    catch (error) {
      // Windows readers/antivirus can briefly deny replacement. Keep the old
      // complete checkpoint, never fall back to truncating the destination.
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 39) throw error;
      Atomics.wait(wait, 0, 0, 50);
    }
  }
}
module.exports = { replaceCheckpoint };
