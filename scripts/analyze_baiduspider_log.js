const dns = require('dns').promises;
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function parseArguments(argv) {
  const files = [];
  let verifyDns = true;
  for (const argument of argv) {
    if (argument === '--no-dns') verifyDns = false;
    else if (argument.startsWith('--')) throw new Error(`Unknown argument: ${argument}`);
    else files.push(path.resolve(argument));
  }
  if (files.length === 0) throw new Error('Provide one or more Nginx access log files');
  return { files, verifyDns };
}

function readLog(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`Log file not found: ${filePath}`);
  const buffer = fs.readFileSync(filePath);
  return filePath.toLowerCase().endsWith('.gz')
    ? zlib.gunzipSync(buffer).toString('utf8')
    : buffer.toString('utf8');
}

function parseCombinedLine(line) {
  const match = line.match(/^(\S+)\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"([^"]*)"\s+(\d{3})\s+\S+\s+"[^"]*"\s+"([^"]*)"/);
  if (!match) return null;
  const requestParts = match[3].split(' ');
  return {
    ip: match[1],
    time: match[2],
    method: requestParts[0] || '',
    url: requestParts[1] || '',
    status: Number(match[4]),
    userAgent: match[5],
  };
}

async function verifyBaiduIp(ip) {
  let hostnames;
  try {
    hostnames = await dns.reverse(ip);
  } catch (error) {
    return { verified: false, hostnames: [], reason: `PTR lookup failed: ${error.code || error.message}` };
  }
  const baiduHostnames = hostnames.filter(hostname => /(?:^|\.)(?:baidu\.com|baidu\.jp)$/i.test(hostname));
  if (baiduHostnames.length === 0) {
    return { verified: false, hostnames, reason: 'PTR is not under baidu.com or baidu.jp' };
  }
  for (const hostname of baiduHostnames) {
    try {
      const addresses = await dns.lookup(hostname, { all: true });
      if (addresses.some(entry => entry.address === ip)) {
        return { verified: true, hostnames, reason: `Forward lookup matched ${hostname}` };
      }
    } catch {
      // Continue checking the remaining Baidu hostnames.
    }
  }
  return { verified: false, hostnames, reason: 'Forward lookup did not return the original IP' };
}

async function main() {
  const { files, verifyDns } = parseArguments(process.argv.slice(2));
  const entries = [];
  let parsedLines = 0;
  for (const filePath of files) {
    for (const line of readLog(filePath).split(/\r?\n/)) {
      const entry = parseCombinedLine(line);
      if (!entry) continue;
      parsedLines += 1;
      if (/baiduspider/i.test(entry.userAgent)) entries.push({ ...entry, file: filePath });
    }
  }

  console.log(`Parsed ${parsedLines} Nginx combined-log entries; Baiduspider UA matches: ${entries.length}`);
  if (entries.length === 0) {
    console.log('No Baiduspider user-agent entry was found in the supplied logs.');
    return;
  }

  const verification = new Map();
  for (const ip of [...new Set(entries.map(entry => entry.ip))]) {
    verification.set(ip, verifyDns
      ? await verifyBaiduIp(ip)
      : { verified: null, hostnames: [], reason: 'DNS verification skipped' });
  }

  const summary = new Map();
  for (const entry of entries) {
    const result = verification.get(entry.ip);
    const key = `${entry.ip}\t${result.verified === true ? 'verified' : result.verified === false ? 'unverified' : 'unchecked'}\t${entry.status}`;
    summary.set(key, (summary.get(key) || 0) + 1);
  }
  console.log('\nIP\tDNS\tHTTP\tRequests');
  for (const [key, count] of summary) console.log(`${key}\t${count}`);

  console.log('\nDNS verification');
  for (const [ip, result] of verification) {
    console.log(`${ip}\t${result.verified === true ? 'VERIFIED' : result.verified === false ? 'NOT VERIFIED' : 'UNCHECKED'}\t${result.reason}\t${result.hostnames.join(', ') || '-'}`);
  }

  console.log('\nRecent matches');
  for (const entry of entries.slice(-20)) {
    const result = verification.get(entry.ip);
    const state = result.verified === true ? 'verified' : result.verified === false ? 'unverified' : 'unchecked';
    console.log(`${entry.time}\t${entry.ip}\t${state}\t${entry.status}\t${entry.method} ${entry.url}`);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
