const fs = require('fs');
const path = require('path');

const rootDir = path.join(__dirname, '..');
const args = new Map(process.argv.slice(2).map(arg => {
  const match = arg.match(/^--([^=]+)=(.*)$/);
  return match ? [match[1], match[2]] : [arg.replace(/^--/, ''), true];
}));
const province = String(args.get('province') || '').trim();
if (!province) throw new Error('请使用 --province=省份。');
const db = JSON.parse(fs.readFileSync(path.join(rootDir, 'content', 'db.json'), 'utf8'));
const slug = db.provinces?.[province]?.id;
if (!slug) throw new Error(`无法识别省份：${province}`);
const statePath = path.join(rootDir, '.runtime', 'previews', slug, 'state.json');
if (!fs.existsSync(statePath)) {
  console.log(`${province}没有正在记录的预览服务。`);
  process.exit(0);
}
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
try { process.kill(Number(state.pid)); } catch {}
state.status = 'stopped';
state.stoppedAt = new Date().toISOString();
fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\r\n`, 'utf8');
console.log(`${province}隔离预览已停止。`);
