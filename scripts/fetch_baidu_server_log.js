const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const outputDir = path.join(rootDir, '.runtime', 'baidu-indexing-evidence');
const outputPath = path.join(outputDir, 'server-access.log');

function readLocalEnv() {
  const envPath = path.join(rootDir, '.env');
  if (!fs.existsSync(envPath)) return {};
  const values = {};
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[name] = value;
  }
  return values;
}

function parseArguments(argv) {
  let lines = 100000;
  for (const argument of argv) {
    if (argument.startsWith('--lines=')) lines = Number(argument.slice('--lines='.length));
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isInteger(lines) || lines < 1 || lines > 1000000) {
    throw new Error('--lines must be an integer between 1 and 1000000');
  }
  return { lines };
}

function resolveHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function main() {
  const { lines } = parseArguments(process.argv.slice(2));
  const localEnv = readLocalEnv();
  const target = process.env.LVYOUMAP_SSH_TARGET || localEnv.LVYOUMAP_SSH_TARGET;
  const identityFile = resolveHome(process.env.LVYOUMAP_SSH_KEY || localEnv.LVYOUMAP_SSH_KEY || '~/.ssh/lvyoumap_deploy_ed25519');
  const remoteLog = process.env.LVYOUMAP_NGINX_LOG || localEnv.LVYOUMAP_NGINX_LOG || '/www/wwwlogs/xzmap.xzbest.site.log';

  if (!target || !/^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+$/.test(target)) {
    throw new Error('Set LVYOUMAP_SSH_TARGET in the ignored .env file, for example deploy@server.example.com');
  }
  if (!fs.existsSync(identityFile)) throw new Error(`SSH identity file not found: ${identityFile}`);
  if (!/^\/[A-Za-z0-9_./-]+$/.test(remoteLog)) throw new Error('Invalid LVYOUMAP_NGINX_LOG path');

  const remoteCommand = `tail -n ${lines} -- ${remoteLog}`;
  const result = spawnSync('ssh', [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=15',
    '-o', 'StrictHostKeyChecking=yes',
    '-i', identityFile,
    target,
    remoteCommand,
  ], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`SSH log download failed (${result.status}): ${(result.stderr || '').trim()}`);
  }

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, result.stdout, 'utf8');
  console.log(`Downloaded ${result.stdout.split(/\r?\n/).filter(Boolean).length} log lines to ${outputPath}`);

  for (const analyzerName of ['analyze_baiduspider_log.js', 'analyze_bingbot_log.js']) {
    console.log(`\n=== ${analyzerName} ===`);
    const analyzer = spawnSync(process.execPath, [path.join(__dirname, analyzerName), outputPath], {
      cwd: rootDir,
      stdio: 'inherit',
    });
    if (analyzer.error) throw analyzer.error;
    if (analyzer.status !== 0) throw new Error(`${analyzerName} failed (${analyzer.status})`);
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
