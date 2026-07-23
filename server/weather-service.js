const crypto = require('crypto');
const fs = require('fs');
const locations = require('./locations');

const cache = new Map();
let cachedJwt = null;
let cachedJwtExpiresAt = 0;
let cachedPrivateKey = null;

function numberFromEnv(name, fallback, minimum, maximum) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

const config = {
  provider: String(process.env.WEATHER_PROVIDER || 'auto').toLowerCase(),
  cacheMs: numberFromEnv('WEATHER_CACHE_MINUTES', 10, 1, 60) * 60_000,
  staleMs: numberFromEnv('WEATHER_STALE_HOURS', 6, 1, 48) * 3_600_000,
  timeoutMs: numberFromEnv('WEATHER_TIMEOUT_MS', 4000, 1000, 15_000),
  qweatherHost: String(process.env.QWEATHER_API_HOST || '').trim(),
  qweatherApiKey: String(process.env.QWEATHER_API_KEY || '').trim(),
  qweatherKeyId: String(process.env.QWEATHER_KEY_ID || '').trim(),
  qweatherProjectId: String(process.env.QWEATHER_PROJECT_ID || '').trim(),
  qweatherPrivateKeyPath: String(process.env.QWEATHER_PRIVATE_KEY_PATH || '').trim(),
};

function qweatherConfigured() {
  const hasApiKey = Boolean(config.qweatherApiKey);
  const hasJwt = Boolean(
    config.qweatherKeyId
      && config.qweatherProjectId
      && config.qweatherPrivateKeyPath,
  );
  return Boolean(config.qweatherHost && (hasApiKey || hasJwt));
}

function normalizeQWeatherHost() {
  const raw = config.qweatherHost.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!/^[a-z0-9.-]+$/i.test(raw)) throw new Error('Invalid QWEATHER_API_HOST');
  return raw;
}

function createQWeatherJwt() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && cachedJwtExpiresAt - 60 > now) return cachedJwt;

  if (!cachedPrivateKey) {
    cachedPrivateKey = crypto.createPrivateKey(
      fs.readFileSync(config.qweatherPrivateKeyPath, 'utf8'),
    );
  }

  const issuedAt = now - 30;
  const expiresAt = issuedAt + 900;
  const header = Buffer.from(JSON.stringify({
    alg: 'EdDSA',
    kid: config.qweatherKeyId,
  })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: config.qweatherProjectId,
    iat: issuedAt,
    exp: expiresAt,
  })).toString('base64url');
  const unsigned = `${header}.${payload}`;
  const signature = crypto.sign(null, Buffer.from(unsigned), cachedPrivateKey).toString('base64url');
  cachedJwt = `${unsigned}.${signature}`;
  cachedJwtExpiresAt = expiresAt;
  return cachedJwt;
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'User-Agent': 'lvyoumap-universal-server/3.0',
      ...headers,
    },
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!response.ok) throw new Error(`Upstream returned HTTP ${response.status}`);
  return response.json();
}

async function fetchQWeather(province, location) {
  if (!qweatherConfigured()) throw new Error('QWeather is not configured');
  const host = normalizeQWeatherHost();
  const coordinates = `${location.longitude.toFixed(2)},${location.latitude.toFixed(2)}`;
  const headers = {};
  if (config.qweatherApiKey) {
    headers['X-QW-Api-Key'] = config.qweatherApiKey;
  } else {
    headers.Authorization = `Bearer ${createQWeatherJwt()}`;
  }

  const payload = await fetchJson(
    `https://${host}/v7/weather/now?location=${encodeURIComponent(coordinates)}&lang=zh&unit=m`,
    headers,
  );
  if (payload.code !== '200' || !payload.now) {
    throw new Error(`QWeather returned code ${payload.code || 'unknown'}`);
  }

  return {
    province,
    location: location.city,
    temp: `${payload.now.temp}°C`,
    cond: payload.now.text,
    humidity: Number(payload.now.humidity),
    observedAt: payload.now.obsTime || payload.updateTime || new Date().toISOString(),
    source: 'qweather',
    live: true,
  };
}

async function fetchWttr(province, location) {
  const payload = await fetchJson(
    `https://wttr.in/${encodeURIComponent(location.city)}?format=j1&lang=zh`,
  );
  const current = payload.current_condition?.[0];
  if (!current) throw new Error('wttr.in returned no current conditions');
  const localized = current.lang_zh?.[0]?.value;
  const english = current.weatherDesc?.[0]?.value;

  return {
    province,
    location: location.city,
    temp: `${current.temp_C}°C`,
    cond: localized || english || '天气未知',
    humidity: Number(current.humidity),
    observedAt: current.localObsDateTime || new Date().toISOString(),
    source: 'wttr.in',
    live: true,
  };
}

function weatherCodeText(code) {
  const descriptions = {
    0: '晴',
    1: '大部晴朗',
    2: '多云',
    3: '阴',
    45: '有雾',
    48: '雾凇',
    51: '小毛毛雨',
    53: '毛毛雨',
    55: '强毛毛雨',
    61: '小雨',
    63: '中雨',
    65: '大雨',
    71: '小雪',
    73: '中雪',
    75: '大雪',
    80: '阵雨',
    81: '较强阵雨',
    82: '强阵雨',
    85: '阵雪',
    86: '强阵雪',
    95: '雷雨',
    96: '雷雨伴小冰雹',
    99: '雷雨伴大冰雹',
  };
  return descriptions[code] || '天气未知';
}

async function fetchOpenMeteo(province, location) {
  const query = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    current: 'temperature_2m,relative_humidity_2m,weather_code',
    timezone: 'Asia/Shanghai',
  });
  const payload = await fetchJson(`https://api.open-meteo.com/v1/forecast?${query}`);
  if (!payload.current) throw new Error('Open-Meteo returned no current conditions');

  return {
    province,
    location: location.city,
    temp: `${Math.round(payload.current.temperature_2m)}°C`,
    cond: weatherCodeText(Number(payload.current.weather_code)),
    humidity: Number(payload.current.relative_humidity_2m),
    observedAt: payload.current.time || new Date().toISOString(),
    source: 'open-meteo',
    live: true,
  };
}

function providerOrder() {
  if (config.provider === 'qweather') return ['qweather'];
  if (config.provider === 'open-meteo') return ['open-meteo'];
  if (config.provider === 'wttr') return ['wttr'];
  if (config.provider !== 'auto') throw new Error(`Unsupported WEATHER_PROVIDER: ${config.provider}`);
  return qweatherConfigured()
    ? ['qweather', 'open-meteo', 'wttr']
    : ['open-meteo', 'wttr'];
}

async function getWeather(province) {
  const location = locations[province];
  if (!location) throw Object.assign(new Error('Unsupported province'), { statusCode: 400 });

  const now = Date.now();
  const cached = cache.get(province);
  if (cached && cached.expiresAt > now) {
    return { ...cached.data, cached: true };
  }

  const errors = [];
  for (const provider of providerOrder()) {
    try {
      let data;
      if (provider === 'qweather') data = await fetchQWeather(province, location);
      if (provider === 'open-meteo') data = await fetchOpenMeteo(province, location);
      if (provider === 'wttr') data = await fetchWttr(province, location);
      cache.set(province, {
        data,
        expiresAt: now + config.cacheMs,
        staleUntil: now + config.staleMs,
      });
      return data;
    } catch (error) {
      errors.push(`${provider}: ${error.message}`);
    }
  }

  if (cached && cached.staleUntil > now) {
    return { ...cached.data, live: false, stale: true, cached: true };
  }

  const error = new Error(`All weather providers failed: ${errors.join('; ')}`);
  error.statusCode = 503;
  throw error;
}

function getStatus() {
  return {
    provider: config.provider,
    qweatherConfigured: qweatherConfigured(),
    cachedLocations: cache.size,
  };
}

module.exports = { getWeather, getStatus };
