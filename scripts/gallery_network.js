const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createGalleryNetwork(cacheDir, options = {}) {
  const request = options.fetch || fetch;
  const states = new Map();
  const pending = new Map();
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const stateFile = path.join(cacheDir, 'cooldowns.json');
  try {
    for (const [key, value] of Object.entries(JSON.parse(fs.readFileSync(stateFile, 'utf8')))) {
      if (value.until > Date.now()) states.set(key, { next: 0, until: value.until });
    }
  } catch { /* First run. */ }
  function saveCooldowns() {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(Object.fromEntries([...states].filter(([, s]) => s.until > Date.now()))));
  }
  function bucket(url) {
    const host = new URL(url).hostname;
    if (/wikimedia\.org$|wikidata\.org$|wikipedia\.org$/.test(host)) return [host, 1500];
    if (/duckduckgo\.com$|bing\.com$|google\.com$/.test(host)) return [host, 2200];
    if (/trip\.com$/.test(host)) {
      return new URL(url).pathname.includes('/getTripPoiPhotoGallery') ? ['trip-gallery', 200] : ['trip-page', 400];
    }
    return [host, 100];
  }
  function cooling(key, state) {
    const error = new Error(`${key} 来源限流冷却至 ${new Date(state.until).toISOString()}`);
    error.retryAt = new Date(state.until).toISOString();
    return error;
  }
  async function sourceFetch(url, init) {
    const [key, interval] = bucket(url);
    const state = states.get(key) || { next: 0, until: 0 };
    states.set(key, state);
    if (state.until > Date.now()) throw cooling(key, state);
    const start = Math.max(Date.now(), state.next);
    state.next = start + interval;
    if (start > Date.now()) await pause(start - Date.now());
    if (state.until > Date.now()) throw cooling(key, state);
    const response = await request(url, init);
    if ([403, 429, 430, 432].includes(response.status)) {
      const retry = response.headers.get('retry-after');
      const seconds = /^\d+$/.test(retry || '') ? Number(retry) : (Date.parse(retry) - Date.now()) / 1000;
      state.until = Date.now() + Math.max(60, Math.min(Number.isFinite(seconds) ? seconds : 120, 600)) * 1000;
      saveCooldowns();
      throw cooling(key, state);
    }
    return response;
  }
  async function json(url, timeout = 12000) {
    url = String(url);
    if (pending.has(url)) return pending.get(url);
    const task = (async () => {
      const file = path.join(cacheDir, crypto.createHash('sha256').update(url).digest('hex') + '.json');
      try { if (Date.now() - fs.statSync(file).mtimeMs < 7 * 86400000) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* Fetch. */ }
      // Timeout starts when the request is dispatched, after the host queue.
      const init = { headers: { 'User-Agent': 'LvyoumapGallery/3.0' } };
      Object.defineProperty(init, 'signal', { enumerable: true, get: () => AbortSignal.timeout(timeout) });
      const response = await sourceFetch(url, init);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data.error) throw new Error(data.error.info || data.error.code || '来源API异常');
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data));
      return data;
    })();
    pending.set(url, task);
    try { return await task; } catch (error) { pending.delete(url); throw error; }
  }
  async function postJson(url, body, timeout = 12000) {
    url = String(url);
    const payload = JSON.stringify(body || {});
    const cacheKey = `POST ${url}\n${payload}`;
    if (pending.has(cacheKey)) return pending.get(cacheKey);
    const task = (async () => {
      const file = path.join(cacheDir, crypto.createHash('sha256').update(cacheKey).digest('hex') + '.json');
      try { if (Date.now() - fs.statSync(file).mtimeMs < 7 * 86400000) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* Fetch. */ }
      const init = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0',
          'x-ctx-useragent': 'Mozilla/5.0',
          Referer: 'https://hk.trip.com/',
        },
        body: payload,
      };
      Object.defineProperty(init, 'signal', { enumerable: true, get: () => AbortSignal.timeout(timeout) });
      const response = await sourceFetch(url, init);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data.error || data.ResponseStatus?.Ack === 'Failure') {
        throw new Error(data.error?.info || data.ResponseStatus?.Errors?.[0]?.Message || '来源API异常');
      }
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data));
      return data;
    })();
    pending.set(cacheKey, task);
    try { return await task; } catch (error) { pending.delete(cacheKey); throw error; }
  }
  return { sourceFetch, json, postJson, cooldowns: () => [...states].filter(([, s]) => s.until > Date.now()).map(([host, s]) => ({ host, retryAt: new Date(s.until).toISOString() })) };
}
module.exports = { createGalleryNetwork };
