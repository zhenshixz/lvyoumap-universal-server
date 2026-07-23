const fs = require('fs');
const http = require('http');
const path = require('path');
const { getWeather, getStatus } = require('./weather-service');

const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
const startedAt = Date.now();

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(payload));
}

function sendStatic(response, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendJson(response, 400, { success: false, error: 'Invalid URL encoding' });
    return;
  }

  const requested = decoded === '/' ? '/index.html' : decoded;
  let filePath = path.resolve(distDir, `.${requested}`);
  if (filePath !== distDir && !filePath.startsWith(`${distDir}${path.sep}`)) {
    sendJson(response, 403, { success: false, error: 'Forbidden' });
    return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    if (path.extname(requested)) {
      sendJson(response, 404, { success: false, error: 'File not found' });
      return;
    }
    filePath = path.join(distDir, 'index.html');
  }
  if (!fs.existsSync(filePath)) {
    sendJson(response, 503, { success: false, error: 'Frontend has not been built' });
    return;
  }

  const extension = path.extname(filePath).toLowerCase();
  const isIndex = path.basename(filePath) === 'index.html';
  response.writeHead(200, {
    'Content-Type': mimeTypes[extension] || 'application/octet-stream',
    'Cache-Control': isIndex ? 'no-cache' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  });
  fs.createReadStream(filePath).pipe(response);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, {
      success: true,
      service: 'lvyoumap-universal-server',
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      weather: getStatus(),
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/weather') {
    try {
      const province = String(url.searchParams.get('province') || '').trim();
      const data = await getWeather(province);
      sendJson(response, 200, { success: true, data });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      console.error(`[weather] ${error.message}`);
      sendJson(response, statusCode, {
        success: false,
        error: statusCode >= 500 ? 'Real-time weather is temporarily unavailable' : error.message,
      });
    }
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    sendJson(response, 404, { success: false, error: 'API route not found' });
    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { success: false, error: 'Method not allowed' });
    return;
  }

  sendStatic(response, url.pathname);
});

server.listen(port, host, () => {
  console.log(`Lvyoumap server listening on http://${host}:${port}`);
});

function shutdown(signal) {
  console.log(`Received ${signal}; shutting down.`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
