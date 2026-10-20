'use strict';

// Media Operations Dashboard
//
// A deliberately small, read-only correlation layer. It reads API keys from
// existing service configuration at request time, never sends them to the
// browser, and exposes only sanitized request, queue, history, and subtitle
// data over the private dashboard route.

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const LISTEN_PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const CONFIG = {
  radarr: '/run/radarr-config.xml',
  sonarr: '/run/sonarr-config.xml',
  seerr: '/run/seerr-settings.json',
  seerrLogs: '/run/seerr-logs',
  radarrLogs: '/run/radarr-logs',
  hostPressure: '/run/host-pressure',
  qbitLog: '/run/qbittorrent/qbittorrent.log',
  actionSecret: '/run/dashboard-action-token',
};
const HANDOFF_LOG_FILE_LIMIT = 16;
const HANDOFF_EVENT_LIMIT = 16;
const RADARR_CONTEXT_WINDOW_MS = 5 * 60 * 1000;
const TITLE_CACHE_MS = 5 * 60 * 1000;
const SUBTITLE_ATTENTION_CACHE_MS = 2 * 60 * 1000;
const SUBTITLE_ATTENTION_LIMIT = 30;
const SUBTITLE_ATTENTION_CONCURRENCY = 4;
const PIPELINE_ATTENTION_CACHE_MS = 2 * 60 * 1000;
const PIPELINE_ATTENTION_LIMIT = 30;
const PIPELINE_ATTENTION_CONCURRENCY = 4;
const ACTION_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const ACTION_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const ACTION_LOGIN_ATTEMPTS = 5;
const ACTION_SEARCH_WINDOW_MS = 10 * 60 * 1000;
const ACTION_SEARCH_LIMIT = 5;
const ACTION_GRAB_WINDOW_MS = 10 * 60 * 1000;
const ACTION_GRAB_LIMIT = 3;
const ACTION_RELEASE_CACHE_MS = 10 * 60 * 1000;
const titleCache = new Map();
let subtitleAttentionCache = { at: 0, value: null };
let pipelineAttentionCache = { at: 0, value: null };
const actionSessions = new Map();
const actionLoginAttempts = new Map();

const REQUEST_STATUS = {
  1: 'Pending approval',
  2: 'Approved',
  3: 'Declined',
  4: 'Failed',
  5: 'Completed',
};

function readXmlValue(file, name) {
  const input = fs.readFileSync(file, 'utf8');
  const match = input.match(new RegExp(`<${name}>([^<]+)</${name}>`));
  if (!match) throw new Error(`Missing ${name} configuration`);
  return match[1];
}

function credentials() {
  const seerr = JSON.parse(fs.readFileSync(CONFIG.seerr, 'utf8'));
  if (!seerr.main || !seerr.main.apiKey) throw new Error('Missing Seerr configuration');
  return {
    radarr: readXmlValue(CONFIG.radarr, 'ApiKey'),
    sonarr: readXmlValue(CONFIG.sonarr, 'ApiKey'),
    seerr: seerr.main.apiKey,
  };
}

function requestJson({ host, port, requestPath, apiKey, method = 'GET', body = null }) {
  return new Promise((resolve, reject) => {
    const headers = apiKey ? { 'X-Api-Key': apiKey } : {};
    if (body !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const request = http.request({
      host,
      port,
      path: requestPath,
      method,
      headers,
      timeout: 7000,
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (_) {
          reject(new Error('Invalid JSON response'));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Request timeout')));
    request.on('error', reject);
    if (body !== null) request.write(body);
    request.end();
  });
}

function serviceCall(service, requestPath, keys, options = {}) {
  const target = {
    seerr: { host: 'seerr', port: 5055, apiKey: keys.seerr },
    radarr: { host: 'radarr', port: 7878, apiKey: keys.radarr },
    sonarr: { host: 'sonarr', port: 8989, apiKey: keys.sonarr },
  }[service];
  return requestJson({ ...target, requestPath, ...options });
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value && value.records) ? value.records : [];
}

function safeError(error) {
  return error && error.message === 'Request timeout' ? 'timed out' : 'unavailable';
}

function actionSecret() {
  const secret = fs.readFileSync(CONFIG.actionSecret, 'utf8').trim();
  if (secret.length < 24) throw new Error('Dashboard action passphrase is unavailable');
  return secret;
}

function cleanActor(value) {
  return cleanText(value, 120).replace(/[^a-zA-Z0-9@._:+-]/g, '_') || 'tailnet-user';
}

function auditAction(action, outcome, values = {}) {
  const entry = {
    event: 'dashboard-action',
    at: new Date().toISOString(),
    action,
    outcome,
    actor: cleanActor(values.actor),
  };
  if (Number.isSafeInteger(values.requestId)) entry.requestId = values.requestId;
  if (Number.isSafeInteger(values.movieId)) entry.movieId = values.movieId;
  if (values.release) entry.release = cleanText(values.release, 160);
  console.log(JSON.stringify(entry));
}

function cookieValue(request, name) {
  const cookies = String(request.headers.cookie || '').split(';');
  const prefix = `${name}=`;
  const matched = cookies.find((cookie) => cookie.trim().startsWith(prefix));
  return matched ? matched.trim().slice(prefix.length) : '';
}

function actionClientKey(request) {
  const forwarded = cleanText(request.headers['x-forwarded-for'], 180).split(',')[0];
  return `${cleanActor(request.headers['tailscale-user-login'])}:${forwarded || request.socket.remoteAddress || 'unknown'}`;
}

function actionActor(request) {
  return cleanActor(request.headers['tailscale-user-login'] || request.headers['x-forwarded-user'] || request.socket.remoteAddress);
}

function sameOrigin(request) {
  const origin = cleanText(request.headers.origin, 300);
  const hosts = [request.headers.host, request.headers['x-forwarded-host']]
    .map((value) => cleanText(value, 220))
    .filter(Boolean);
  if (origin && hosts.some((host) => origin === `https://${host}`)) return true;
  // Browsers do not consistently send Origin on same-origin GET requests.
  // A cross-site request cannot carry the Strict session cookie, while this
  // additional fetch-metadata check keeps a GET from becoming an ambient
  // cross-site indexer-search trigger. State-changing methods still require
  // the exact HTTPS Origin above.
  const fetchSite = cleanText(request.headers['sec-fetch-site'], 40);
  return request.method === 'GET' && (fetchSite === 'same-origin' || fetchSite === 'same-site');
}

function trimActionState() {
  const now = Date.now();
  for (const [id, session] of actionSessions) {
    if (session.expiresAt <= now) actionSessions.delete(id);
  }
  for (const [key, attempts] of actionLoginAttempts) {
    if (!attempts.length || now - attempts[attempts.length - 1] > ACTION_LOGIN_WINDOW_MS) actionLoginAttempts.delete(key);
  }
}

function withinLimit(store, key, limit, windowMs) {
  const now = Date.now();
  const recent = (store.get(key) || []).filter((at) => now - at < windowMs);
  if (recent.length >= limit) {
    store.set(key, recent);
    return false;
  }
  recent.push(now);
  store.set(key, recent);
  return true;
}

function actionSession(request) {
  trimActionState();
  const id = cookieValue(request, 'dashboard_action');
  const session = id && actionSessions.get(id);
  if (!session || session.expiresAt <= Date.now()) return null;
  return { id, ...session };
}

function secureEquals(actual, expected) {
  const actualBuffer = Buffer.from(actual, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function readJsonBody(request, maximum = 4096) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > maximum) request.destroy(new Error('Request body too large'));
    });
    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (_) {
        reject(new Error('Invalid JSON'));
      }
    });
    request.on('error', reject);
  });
}

function cleanText(value, maximum = 220) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function cleanDiagnosticValues(values, maximum = 320) {
  return [...new Set(values.map((value) => cleanText(value, maximum)).filter(Boolean))];
}

function historyEvidence(item) {
  const data = item && item.data && typeof item.data === 'object' && !Array.isArray(item.data) ? item.data : {};
  // These are human-facing Arr failure/status fields. Deliberately do not
  // include GUIDs, download IDs, URLs, or arbitrary metadata in the report.
  return cleanDiagnosticValues([
    item && item.message,
    item && item.reason,
    item && item.errorMessage,
    item && item.failureMessage,
    item && item.statusMessage,
    data.message,
    data.reason,
    data.errorMessage,
    data.failureMessage,
    data.statusMessage,
  ]);
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function queueProgress(size, sizeleft) {
  if (!size) return null;
  return Math.max(0, Math.min(100, Number((((size - sizeleft) / size) * 100).toFixed(1))));
}

async function titleFor(request, keys) {
  const tmdbId = request && request.media && request.media.tmdbId;
  if (!tmdbId) return 'Unknown title';
  const cacheKey = `${request.type}:${tmdbId}`;
  const cached = titleCache.get(cacheKey);
  if (cached && Date.now() - cached.at < TITLE_CACHE_MS) return cached.value;

  try {
    const media = await serviceCall(
      'seerr',
      `/api/v1/${request.type === 'movie' ? 'movie' : 'tv'}/${encodeURIComponent(tmdbId)}`,
      keys,
    );
    const value = cleanText(media.title || media.name || media.originalTitle || media.originalName) || 'Unknown title';
    titleCache.set(cacheKey, { at: Date.now(), value });
    return value;
  } catch (_) {
    return 'Unknown title';
  }
}

function requestSummary(request, title) {
  const media = request.media || {};
  return {
    id: request.id,
    title,
    type: request.type === 'tv' ? 'show' : 'movie',
    status: REQUEST_STATUS[request.status] || 'Unknown',
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    tmdbId: media.tmdbId || null,
    tvdbId: media.tvdbId || null,
    downloadStatus: request.is4k ? media.downloadStatus4k : media.downloadStatus,
    libraryStatus: request.is4k ? media.status4k : media.status,
  };
}

function sidecarsFor(mediaPath) {
  if (typeof mediaPath !== 'string' || !mediaPath.startsWith('/data/media/')) return [];
  const found = [];
  function scan(folder, depth) {
    if (depth > 2 || found.length >= 100) return;
    let entries;
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch (_) {
      return;
    }
    entries.forEach((entry) => {
      const entryPath = path.join(folder, entry.name);
      if (entry.isDirectory()) scan(entryPath, depth + 1);
      if (entry.isFile() && /\.(srt|ass|ssa|vtt)$/i.test(entry.name)) {
        found.push(path.relative(mediaPath, entryPath));
      }
    });
  }
  try {
    scan(mediaPath, 0);
    return found.sort();
  } catch (_) {
    return [];
  }
}

function timelineEvent({ at, stage, level = 'info', message }) {
  return { at: at || null, stage, level, message: cleanText(message) };
}

function recentQbitEvents(sourceTitle) {
  if (!sourceTitle) return [];
  try {
    const lines = fs.readFileSync(CONFIG.qbitLog, 'utf8').split('\n');
    return lines
      .filter((line) => line.includes(sourceTitle))
      .slice(-12)
      .map((line) => {
        const match = line.match(/^\([A-Z]\) ([^ ]+) - (.+)$/);
        return timelineEvent({
          at: match ? match[1] : null,
          stage: 'qBittorrent',
          level: line.startsWith('(W)') || line.startsWith('(C)') ? 'warning' : 'info',
          message: match ? match[2].replace(/Torrent: "[^"]+"/, 'Torrent') : line,
        });
      });
  } catch (_) {
    return [];
  }
}

function logFiles(directory, matcher, limit = HANDOFF_LOG_FILE_LIMIT) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && matcher.test(entry.name))
      .map((entry) => {
        const file = path.join(directory, entry.name);
        return { file, modified: fs.statSync(file).mtimeMs };
      })
      .sort((left, right) => right.modified - left.modified)
      .slice(0, limit)
      .map((entry) => entry.file);
  } catch (_) {
    return [];
  }
}

function logContents(file) {
  try {
    const content = fs.readFileSync(file);
    return file.endsWith('.gz') ? zlib.gunzipSync(content).toString('utf8') : content.toString('utf8');
  } catch (_) {
    return '';
  }
}

function primaryRadarrLogs() {
  return ['radarr.txt', 'radarr.debug.txt']
    .map((name) => path.join(CONFIG.radarrLogs, name))
    .filter((file) => {
      try {
        return fs.statSync(file).isFile();
      } catch (_) {
        return false;
      }
    });
}

function asIsoTime(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function logLevel(value) {
  if (/error/i.test(value)) return 'error';
  if (/warn/i.test(value)) return 'warning';
  return 'info';
}

function loggedError(message) {
  const match = message.match(/"errorMessage":"([^"]+)"/i);
  return match ? cleanText(match[1]) : '';
}

function compactSeerrHandoffMessage(message, target) {
  const timeout = message.match(/timeout of (\d+)ms/i);
  const error = loggedError(message);
  if (/Sent request to/i.test(message)) return `Seerr sent this request to ${target}.`;
  if (/Error retrieving .* by/i.test(message) && timeout) return `${target} title lookup timed out after ${timeout[1]} ms.`;
  if (/Failed to add/i.test(message)) return `Seerr could not add the title to ${target}${error ? `: ${error}.` : '.'}`;
  if (/marking status as FAILED/i.test(message)) return `Seerr marked the request failed after the ${target} handoff.`;
  if (timeout) return `${target} handoff timed out after ${timeout[1]} ms.`;
  return safeDiagnosticText(message);
}

function seerrHandoffEvents(request) {
  const target = request.type === 'movie' ? 'Radarr' : 'Sonarr';
  const requestId = Number(request.id);
  const tmdbId = request && request.media && request.media.tmdbId;
  const requestMarker = new RegExp(`"requestId":\\s*${requestId}(?:\\D|$)`);
  const tmdbMarker = tmdbId ? new RegExp(`"tmdbId":\\s*${Number(tmdbId)}(?:\\D|$)`) : null;
  const useful = /Sent request to|Failed to add|marking status as FAILED|Error retrieving .* by|timeout of \d+ms/i;
  const events = [];

  logFiles(CONFIG.seerrLogs, /^seerr-\d{4}-\d{2}-\d{2}\.log(?:\.gz)?$/).forEach((file) => {
    logContents(file).split('\n').forEach((line) => {
      if (!useful.test(line) || (!requestMarker.test(line) && !(tmdbMarker && tmdbMarker.test(line)))) return;
      const match = line.match(/^(\S+) \[([^\]]+)\]\[([^\]]+)\]:\s*(.*)$/);
      if (!match) return;
      const at = asIsoTime(match[1]);
      if (!at) return;
      events.push(timelineEvent({
        at,
        stage: `Seerr → ${target}`,
        level: logLevel(match[2]),
        message: compactSeerrHandoffMessage(match[4], target),
      }));
    });
  });

  return events
    .sort((left, right) => String(left.at).localeCompare(String(right.at)))
    .slice(-HANDOFF_EVENT_LIMIT);
}

function radarrLogTime(value) {
  // Radarr writes local time without an offset. The dashboard shares its TZ,
  // so parsing it locally makes it comparable to Seerr's UTC timestamps.
  return asIsoTime(value.replace(' ', 'T'));
}

function compactRadarrHandoffMessage(component, message) {
  if (/thread pool starvation/i.test(message)) {
    const delay = message.match(/running for "([^"]+)"/i);
    return `Radarr web-server heartbeat was delayed${delay ? ` for ${delay[1]}` : ''}; thread-pool starvation was reported.`;
  }
  if (/database is locked/i.test(message)) return 'Radarr SQLite database was locked; the operation was retried.';
  if (/Unable to retrieve queue and history items from qBittorrent/i.test(message)) return 'Radarr could not retrieve qBittorrent queue and history.';
  if (component === 'Api') {
    const request = message.match(/\[(GET|POST)\]\s+([^?\s]+)/i);
    const status = message.match(/(?:^|[:\s])(\d{3}\.[A-Za-z0-9]+) \((\d+) ms\)/);
    if (request && status) return `${request[1].toUpperCase()} ${request[2]} returned ${status[1]} in ${status[2]} ms.`;
  }
  return safeDiagnosticText(message);
}

function radarrHandoffEvents(handoffEvents, tmdbId) {
  const handoffTimes = handoffEvents
    .map((event) => new Date(event.at).getTime())
    .filter(Number.isFinite);
  if (!handoffTimes.length) return [];
  const events = [];
  const relatedTitle = tmdbId ? `tmdbId=${tmdbId}` : '';

  // The current debug log contains an active failure's exact API duration;
  // the compact main log retains Kestrel/database warnings. Avoid scanning
  // rotated multi-megabyte logs from this read-only diagnostic endpoint.
  primaryRadarrLogs().forEach((file) => {
    logContents(file).split('\n').forEach((line) => {
      const match = line.match(/^(\d{4}-\d{2}-\d{2} \d\d:\d\d:\d\d(?:\.\d+)?)\|([^|]+)\|([^|]+)\|(.*)$/);
      if (!match) return;
      const at = radarrLogTime(match[1]);
      const atMs = at && new Date(at).getTime();
      if (!Number.isFinite(atMs) || !handoffTimes.some((time) => Math.abs(time - atMs) <= RADARR_CONTEXT_WINDOW_MS)) return;
      const component = cleanText(match[3]);
      const message = cleanText(match[4], 1000);
      const duration = Number((message.match(/\((\d+) ms\)/) || [])[1] || 0);
      const movieMutation = component === 'Api' && /^\[POST\]\s+\/api\/v3\/movie(?:[?\s:]|$)/i.test(message);
      const relevant = /thread pool starvation|database is locked|Failed writing to database|Unable to retrieve queue and history items from qBittorrent/i.test(message)
        || (component === 'Api' && (duration >= 10000 || movieMutation || (relatedTitle && message.includes(relatedTitle))));
      if (!relevant) return;
      events.push(timelineEvent({
        at,
        stage: 'Radarr',
        level: /499\./.test(message) ? 'warning' : logLevel(match[2]),
        message: compactRadarrHandoffMessage(component, message),
      }));
    });
  });

  return events
    .sort((left, right) => String(left.at).localeCompare(String(right.at)))
    .slice(-HANDOFF_EVENT_LIMIT);
}

function hostPressure() {
  const result = {};
  ['io', 'memory'].forEach((resource) => {
    try {
      const values = {};
      fs.readFileSync(path.join(CONFIG.hostPressure, resource), 'utf8').trim().split('\n').forEach((line) => {
        const match = line.match(/^(some|full)\s+.*avg10=([0-9.]+).*avg60=([0-9.]+).*avg300=([0-9.]+)/);
        if (match) values[match[1]] = { avg10: Number(match[2]), avg60: Number(match[3]), avg300: Number(match[4]) };
      });
      if (values.some || values.full) result[resource] = values;
    } catch (_) {
      // Pressure data is optional and never affects dashboard availability.
    }
  });
  return Object.keys(result).length ? result : null;
}

function handoffSignal(handoffEvents, arr) {
  const timeout = handoffEvents.find((event) => /timed out after \d+ ms|timeout of \d+ms/i.test(event.message));
  if (!timeout) return null;
  const downstream = arr.found
    ? 'The library manager has a matching record, so inspect its current queue and history before retrying.'
    : 'No matching library-manager record is currently present, so no download pipeline began.';
  return { level: 'error', message: `Seerr’s library-manager handoff timed out. ${downstream}` };
}

function historyEvents(history, stage) {
  return history.slice(0, 30).map((item) => {
    const event = cleanText(item.eventType || 'History event');
    const source = cleanText(item.sourceTitle, 130);
    const evidence = historyEvidence(item);
    const message = [source ? `${event}: ${source}` : event, ...evidence].join(' · ');
    return timelineEvent({
      at: item.date,
      stage,
      level: /failed|warning/i.test(event) ? 'warning' : 'info',
      message,
    });
  });
}

function queueItems(queue, stage) {
  return queue.slice(0, 10).map((item) => {
    const status = cleanText(item.status || item.trackedDownloadStatus || 'Queued');
    const title = cleanText(item.title || 'Download');
    const size = numberOrZero(item.size);
    const sizeleft = numberOrZero(item.sizeleft);
    const messages = cleanDiagnosticValues([
      ...asArray(item.statusMessages).map((message) => message && (message.title || message.messages || message)),
      item.errorMessage,
      item.statusMessage,
    ]);
    return {
      stage,
      title,
      status,
      trackedDownloadStatus: cleanText(item.trackedDownloadStatus),
      trackedDownloadState: cleanText(item.trackedDownloadState),
      protocol: cleanText(item.protocol),
      sizeleft,
      size,
      progress: queueProgress(size, sizeleft),
      eta: cleanText(item.timeleft || item.estimatedCompletionTime, 80),
      messages,
    };
  });
}

async function arrDetail(request, keys) {
  const isMovie = request.type === 'movie';
  const service = isMovie ? 'radarr' : 'sonarr';
  const idParameter = isMovie ? 'tmdbId' : 'tvdbId';
  const externalId = isMovie ? request.media.tmdbId : request.media.tvdbId;
  if (!externalId) return { found: false, service, error: 'No external title identifier' };

  try {
    const lookup = await serviceCall(service, `/api/v3/${isMovie ? 'movie' : 'series'}?${idParameter}=${encodeURIComponent(externalId)}`, keys);
    const media = asArray(lookup)[0];
    if (!media) return { found: false, service };
    const itemId = media.id;
    const [historyResponse, queueResponse] = await Promise.all([
      serviceCall(service, `/api/v3/history/${isMovie ? 'movie' : 'series'}?${isMovie ? 'movieId' : 'seriesId'}=${itemId}&pageSize=30&sortDirection=descending`, keys)
        .catch(() => []),
      serviceCall(service, `/api/v3/queue?${isMovie ? 'movieId' : 'seriesId'}=${itemId}&pageSize=10`, keys)
        .catch(() => []),
    ]);
    const history = asArray(historyResponse);
    const queue = asArray(queueResponse);
    const sourceRecord = history.find((item) => item.sourceTitle);
    const sourceTitle = sourceRecord ? sourceRecord.sourceTitle : '';
    return {
      found: true,
      service,
      id: itemId,
      monitored: Boolean(media.monitored),
      hasFile: Boolean(media.hasFile || (media.statistics && media.statistics.episodeFileCount)),
      path: cleanText(media.path, 320),
      sidecars: sidecarsFor(media.path),
      history,
      queue,
      qbitEvents: recentQbitEvents(sourceTitle),
    };
  } catch (error) {
    return { found: false, service, error: safeError(error) };
  }
}

function releaseValues(value, maximum = 6) {
  return asArray(value)
    .map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') return item.name || item.title || item.value || '';
      return '';
    })
    .map((item) => cleanText(item, 120))
    .filter(Boolean)
    .slice(0, maximum);
}

function releaseQuality(release) {
  const quality = release && release.quality;
  return cleanText(
    (quality && quality.quality && quality.quality.name) || (quality && quality.name) || release.qualityName || 'Unknown quality',
    100,
  );
}

function releaseSummary(release, token) {
  const rejections = releaseValues(release && release.rejections, 8);
  return {
    token,
    title: cleanText(release && release.title, 240) || 'Untitled release',
    quality: releaseQuality(release),
    size: numberOrZero(release && release.size),
    seeders: Math.max(0, Number(release && release.seeders) || 0),
    peers: Math.max(0, Number(release && release.peers) || 0),
    indexer: cleanText((release && (release.indexer || release.indexerName)) || 'Unknown indexer', 120),
    protocol: cleanText(release && release.protocol, 40),
    languages: releaseValues(release && release.languages),
    customFormats: releaseValues(release && release.customFormats),
    rejections,
    manualGrabAllowed: Boolean(release && (release.downloadUrl || release.guid)),
  };
}

async function movieForInteractiveSearch(requestId, keys) {
  const request = await serviceCall('seerr', `/api/v1/request/${encodeURIComponent(requestId)}`, keys);
  if (!request || request.type !== 'movie') {
    const error = new Error('Interactive search is available for movie requests only');
    error.status = 400;
    throw error;
  }
  const arr = await arrDetail(request, keys);
  if (!arr.found || !Number.isSafeInteger(arr.id)) {
    const error = new Error('The movie is not present in Radarr');
    error.status = 404;
    throw error;
  }
  if (arr.hasFile) {
    const error = new Error('The movie already has an imported file');
    error.status = 409;
    throw error;
  }
  return { request, arr, title: await titleFor(request, keys) };
}

async function interactiveReleaseSearch(requestId, session) {
  const keys = credentials();
  const movie = await movieForInteractiveSearch(requestId, keys);
  const rawReleases = asArray(await serviceCall('radarr', `/api/v3/release?movieId=${movie.arr.id}`, keys));
  const selections = new Map();
  const releases = rawReleases.slice(0, 100).map((release) => {
    const token = crypto.randomBytes(18).toString('base64url');
    selections.set(token, release);
    return releaseSummary(release, token);
  });
  session.releaseSearches.set(String(requestId), {
    at: Date.now(),
    movieId: movie.arr.id,
    title: movie.title,
    selections,
  });
  return { title: movie.title, movieId: movie.arr.id, releases };
}

async function interactiveReleaseGrab(requestId, releaseToken, session) {
  const search = session.releaseSearches.get(String(requestId));
  if (!search || Date.now() - search.at > ACTION_RELEASE_CACHE_MS) {
    const error = new Error('Search results expired. Search again before grabbing a release');
    error.status = 409;
    throw error;
  }
  const release = search.selections.get(releaseToken);
  if (!release || !releaseSummary(release, 'selection').manualGrabAllowed) {
    const error = new Error('The selected release is no longer available');
    error.status = 404;
    throw error;
  }
  const keys = credentials();
  const movie = await movieForInteractiveSearch(requestId, keys);
  if (movie.arr.id !== search.movieId) {
    const error = new Error('The movie record changed. Search again before grabbing a release');
    error.status = 409;
    throw error;
  }
  await serviceCall('radarr', '/api/v3/release', keys, {
    method: 'POST',
    body: JSON.stringify(release),
  });
  session.releaseSearches.delete(String(requestId));
  return { title: movie.title, movieId: movie.arr.id, release: releaseSummary(release, 'selection') };
}

async function arrSubtitleState(request, keys) {
  const isMovie = request.type === 'movie';
  const service = isMovie ? 'radarr' : 'sonarr';
  const idParameter = isMovie ? 'tmdbId' : 'tvdbId';
  const externalId = isMovie ? request.media.tmdbId : request.media.tvdbId;
  if (!externalId) return { found: false };

  try {
    const lookup = await serviceCall(service, `/api/v3/${isMovie ? 'movie' : 'series'}?${idParameter}=${encodeURIComponent(externalId)}`, keys);
    const media = asArray(lookup)[0];
    if (!media) return { found: false };
    return {
      found: true,
      hasFile: Boolean(media.hasFile || (media.statistics && media.statistics.episodeFileCount)),
      sidecars: sidecarsFor(media.path),
    };
  } catch (_) {
    return { found: false };
  }
}

async function mapWithConcurrency(values, maximum, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(values[currentIndex]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(maximum, values.length) }, worker));
  return results;
}

async function missingSubtitleAttention() {
  const cached = subtitleAttentionCache.value;
  if (cached && Date.now() - subtitleAttentionCache.at < SUBTITLE_ATTENTION_CACHE_MS) return cached;

  const keys = credentials();
  const data = await serviceCall('seerr', '/api/v1/request?take=100&sort=modified', keys);
  const requests = asArray(data.results || data);
  const completed = requests.filter((request) => request.status === 5);
  const candidates = completed.slice(0, SUBTITLE_ATTENTION_LIMIT);
  const checked = await mapWithConcurrency(candidates, SUBTITLE_ATTENTION_CONCURRENCY, async (request) => {
    const [title, arr] = await Promise.all([titleFor(request, keys), arrSubtitleState(request, keys)]);
    if (!arr.found || !arr.hasFile || arr.sidecars.length) return null;
    return {
      id: request.id,
      title,
      type: request.type === 'tv' ? 'show' : 'movie',
      level: 'warning',
      message: 'Imported media has no external subtitle sidecars detected.',
    };
  });
  const value = {
    items: checked.filter(Boolean),
    checked: candidates.length,
    truncated: completed.length > candidates.length,
  };
  subtitleAttentionCache = { at: Date.now(), value };
  return value;
}

function pipelineIssue(arr) {
  const stage = arr.service === 'radarr' ? 'Radarr' : 'Sonarr';
  const queue = queueItems(arr.queue || [], stage);
  const queueText = queue.map((entry) => [entry.status, ...entry.messages].join(' ')).join(' ').toLowerCase();
  if (/import[^\n]*(fail|error)|(?:fail|error)[^\n]*import/.test(queueText)) {
    return { level: 'error', message: `${stage} reports a failed import in its active queue.` };
  }
  if (/\b(rejected|ignored)\b/.test(queueText)) {
    return { level: 'warning', message: `${stage} reports a rejected or ignored release in its active queue.` };
  }
  if (/\bstalled\b/.test(queueText)) {
    return { level: 'warning', message: `${stage} reports this download as stalled in its active queue.` };
  }
  if (/\b(failed|failure|error|unavailable|unable)\b/.test(queueText)) {
    return { level: 'error', message: `${stage} reports a download or queue failure.` };
  }

  const historyTypes = (arr.history || []).map((item) => cleanText(item.eventType).toLowerCase());
  if (historyTypes.some((event) => /import.*(fail|error)|(fail|error).*import/.test(event))) {
    return { level: 'error', message: `${stage} history records a failed import.` };
  }
  if (historyTypes.some((event) => /rejected|ignored/.test(event))) {
    return { level: 'warning', message: `${stage} history records a rejected or ignored release.` };
  }
  if (historyTypes.some((event) => /download.*(fail|error)|grab.*(fail|error)/.test(event))) {
    return { level: 'error', message: `${stage} history records a failed download or grab.` };
  }
  return null;
}

async function pipelineAttention() {
  const cached = pipelineAttentionCache.value;
  if (cached && Date.now() - pipelineAttentionCache.at < PIPELINE_ATTENTION_CACHE_MS) return cached;

  const keys = credentials();
  const data = await serviceCall('seerr', '/api/v1/request?take=100&sort=modified', keys);
  const requests = asArray(data.results || data);
  const active = requests.filter((request) => request.status === 1 || request.status === 2);
  const candidates = active.slice(0, PIPELINE_ATTENTION_LIMIT);
  const checked = await mapWithConcurrency(candidates, PIPELINE_ATTENTION_CONCURRENCY, async (request) => {
    const [title, arr] = await Promise.all([titleFor(request, keys), arrDetail(request, keys)]);
    if (!arr.found || arr.hasFile) return null;
    const issue = pipelineIssue(arr);
    return issue && {
      id: request.id,
      title,
      type: request.type === 'tv' ? 'show' : 'movie',
      ...issue,
    };
  });
  const value = {
    items: checked.filter(Boolean),
    checked: candidates.length,
    truncated: active.length > candidates.length,
  };
  pipelineAttentionCache = { at: Date.now(), value };
  return value;
}

async function mediaAttention() {
  const [subtitles, pipeline] = await Promise.all([missingSubtitleAttention(), pipelineAttention()]);
  return {
    items: [...subtitles.items, ...pipeline.items],
    checked: subtitles.checked,
    truncated: subtitles.truncated,
    pipelineChecked: pipeline.checked,
    pipelineTruncated: pipeline.truncated,
  };
}

function formatBytes(value) {
  const bytes = numberOrZero(value);
  if (!bytes) return 'unknown';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const amount = bytes / (1024 ** index);
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function safeDiagnosticText(value, maximum = 420) {
  return cleanText(value, maximum)
    .replace(/\b(api[ _-]?key|authorization|token|password|secret)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, '$1: [redacted]')
    .replace(/https?:\/\/[^\s<>"']+/gi, '[URL redacted]')
    .replace(/(^|[\s("'=])\/(?!(?:api)(?:\/|$))(?:[^/\s]+\/)+[^/\s"'<>)]+/g, '$1[path redacted]')
    .replace(/(^|[\s("'=])[a-z]:\\(?:[^\\\s]+\\)+[^\\\s"'<>)]+/gi, '$1[path redacted]');
}

function diagnosticReport(detail, healthState) {
  const { request, arr, queue, timeline, handoff, diagnosticSignal } = detail;
  const lines = [
    '# Media Operations diagnostic report',
    `Generated (UTC): ${new Date().toISOString()}`,
    'Scope: read-only snapshot from Seerr, Radarr/Sonarr, correlated application-log evidence, host pressure counters, qBittorrent matching events, and subtitle-sidecar checks.',
    'Privacy: API keys, credentials, download IDs, GUIDs, URLs, and full media paths are excluded.',
    '',
    '## Request',
    `- Title: ${safeDiagnosticText(request.title)}`,
    `- Seerr request ID: ${request.id}`,
    `- Type: ${safeDiagnosticText(request.type)}`,
    `- Seerr status: ${safeDiagnosticText(request.status)}`,
    `- Created (UTC): ${request.createdAt || 'unknown'}`,
    `- Last updated (UTC): ${request.updatedAt || 'unknown'}`,
    `- TMDB ID: ${request.tmdbId || 'not available'}`,
    `- TVDB ID: ${request.tvdbId || 'not available'}`,
    '',
    '## Service health at report time',
    ...healthState.services.map((service) => `- ${safeDiagnosticText(service.service)}: ${safeDiagnosticText(service.status)}${Number.isFinite(service.latencyMs) ? ` (${service.latencyMs} ms)` : ''}`),
    '',
    '## Library manager state',
    `- Service: ${safeDiagnosticText(arr.service)}`,
    `- Record found: ${arr.found ? 'yes' : 'no'}`,
    `- Monitored: ${arr.monitored ? 'yes' : 'no'}`,
    `- Imported media file: ${arr.hasFile ? 'yes' : 'no'}`,
    `- External subtitle sidecars: ${arr.sidecars.length}`,
  ];

  if (diagnosticSignal) {
    lines.push(`- Explicit Arr signal: ${safeDiagnosticText(diagnosticSignal.level).toUpperCase()} — ${safeDiagnosticText(diagnosticSignal.message)}`);
  }

  if (healthState.hostPressure && healthState.hostPressure.io) {
    const io = healthState.hostPressure.io;
    lines.push('', '## Host pressure at report time');
    if (io.full) lines.push(`- Disk I/O pressure, all tasks stalled: ${io.full.avg10}% / ${io.full.avg60}% / ${io.full.avg300}% (10s / 60s / 300s averages).`);
    if (io.some) lines.push(`- Disk I/O pressure, at least one task stalled: ${io.some.avg10}% / ${io.some.avg60}% / ${io.some.avg300}% (10s / 60s / 300s averages).`);
  }

  lines.push('', '## Seerr → library-manager handoff evidence');
  if (!handoff.length) {
    lines.push('- No retained matching handoff events were available.');
  } else {
    handoff.forEach((event) => {
      lines.push(`- [${safeDiagnosticText(event.level).toUpperCase()}] ${event.at || 'Unknown time'} | ${safeDiagnosticText(event.stage)} | ${safeDiagnosticText(event.message)}`);
    });
  }

  lines.push('', '## Active download / import queue');
  if (!queue.length) {
    lines.push('- No matching active queue entry was returned by the library manager.');
  } else {
    queue.forEach((entry, index) => {
      lines.push(`### Queue item ${index + 1}: ${safeDiagnosticText(entry.title)}`);
      lines.push(`- Stage: ${safeDiagnosticText(entry.stage)}`);
      lines.push(`- Status: ${safeDiagnosticText(entry.status)}`);
      if (entry.trackedDownloadStatus) lines.push(`- Tracked download status: ${safeDiagnosticText(entry.trackedDownloadStatus)}`);
      if (entry.trackedDownloadState) lines.push(`- Tracked download state: ${safeDiagnosticText(entry.trackedDownloadState)}`);
      if (entry.protocol) lines.push(`- Protocol: ${safeDiagnosticText(entry.protocol)}`);
      if (entry.progress !== null) lines.push(`- Progress: ${entry.progress}% (${formatBytes(entry.sizeleft)} remaining of ${formatBytes(entry.size)})`);
      else if (entry.size || entry.sizeleft) lines.push(`- Transfer size: ${formatBytes(entry.sizeleft)} remaining of ${formatBytes(entry.size)}`);
      if (entry.eta) lines.push(`- ETA / expected completion: ${safeDiagnosticText(entry.eta)}`);
      entry.messages.forEach((message) => lines.push(`- Queue message: ${safeDiagnosticText(message)}`));
    });
  }

  lines.push('', '## Recent correlated events');
  if (!timeline.length) {
    lines.push('- No timeline events were available.');
  } else {
    timeline.forEach((event) => {
      lines.push(`- [${safeDiagnosticText(event.level).toUpperCase()}] ${event.at || 'Current state'} | ${safeDiagnosticText(event.stage)} | ${safeDiagnosticText(event.message)}`);
    });
  }

  lines.push(
    '',
    '## Interpretation request for an AI',
    'Based only on this evidence, explain the most likely failure point, distinguish facts from hypotheses, and suggest safe read-only checks before any retry, removal, or configuration change.',
  );
  return `${lines.join('\n')}\n`;
}

async function detailForRequest(id) {
  const keys = credentials();
  const request = await serviceCall('seerr', `/api/v1/request/${encodeURIComponent(id)}`, keys);
  const title = await titleFor(request, keys);
  const seerrHandoff = seerrHandoffEvents(request);
  const arr = await arrDetail(request, keys);
  const radarrHandoff = arr.service === 'radarr' ? radarrHandoffEvents(seerrHandoff, request.media && request.media.tmdbId) : [];
  const handoff = [...seerrHandoff, ...radarrHandoff]
    .sort((left, right) => String(left.at || '').localeCompare(String(right.at || '')));
  const timeline = [
    timelineEvent({ at: request.createdAt, stage: 'Seerr', message: `Request created (${REQUEST_STATUS[request.status] || 'Unknown status'})` }),
    timelineEvent({ at: request.updatedAt, stage: 'Seerr', message: `Current request status: ${REQUEST_STATUS[request.status] || 'Unknown'}` }),
  ];
  timeline.push(...handoff);
  if (arr.found) {
    timeline.push(timelineEvent({
      at: null,
      stage: arr.service === 'radarr' ? 'Radarr' : 'Sonarr',
      level: arr.hasFile ? 'success' : 'info',
      message: arr.hasFile ? 'Imported media file is present' : 'Title is monitored; no imported media file is recorded yet',
    }));
    timeline.push(...historyEvents(arr.history, arr.service === 'radarr' ? 'Radarr' : 'Sonarr'));
    timeline.push(...arr.qbitEvents);
    if (arr.sidecars.length) {
      timeline.push(timelineEvent({ at: null, stage: 'Subtitles', level: 'success', message: `${arr.sidecars.length} external subtitle sidecar(s) present` }));
    }
  } else {
    timeline.push(timelineEvent({ at: null, stage: arr.service === 'radarr' ? 'Radarr' : 'Sonarr', level: 'warning', message: arr.error || 'Title has not reached the library manager yet' }));
  }

  timeline.sort((left, right) => String(right.at || '').localeCompare(String(left.at || '')));
  return {
    request: requestSummary(request, title),
    arr: {
      found: arr.found,
      service: arr.service,
      monitored: arr.monitored || false,
      hasFile: arr.hasFile || false,
      sidecars: arr.sidecars || [],
    },
    queue: queueItems(arr.queue || [], arr.service === 'radarr' ? 'Radarr' : 'Sonarr'),
    timeline,
    handoff,
    diagnosticSignal: handoffSignal(seerrHandoff, arr) || (arr.found ? pipelineIssue(arr) : null),
    links: {
      seerr: 'https://fabjon-hp.tail681ec9.ts.net:5055/',
      radarr: 'https://fabjon-hp.tail681ec9.ts.net:7878/',
      sonarr: 'https://fabjon-hp.tail681ec9.ts.net:8989/',
      qbittorrent: 'https://fabjon-hp.tail681ec9.ts.net:8181/',
      bazarr: 'https://fabjon-hp.tail681ec9.ts.net:6767/',
      lingarr: 'https://fabjon-hp.tail681ec9.ts.net:9876/',
      jellyfin: 'https://fabjon-hp.tail681ec9.ts.net/',
    },
  };
}

async function listRequests() {
  const keys = credentials();
  // Seerr defaults to descending order; its API rejects "descending" as a
  // query value (it accepts only "asc" when an explicit value is needed).
  const data = await serviceCall('seerr', '/api/v1/request?take=100&sort=modified', keys);
  const requests = asArray(data.results || data);
  const summaries = await Promise.all(requests.map(async (request) => requestSummary(request, await titleFor(request, keys))));
  return { requests: summaries, total: data.pageInfo && data.pageInfo.results || summaries.length };
}

async function health() {
  const keys = credentials();
  const tests = await Promise.all(['seerr', 'radarr', 'sonarr'].map(async (service) => {
    const started = process.hrtime.bigint();
    try {
      await serviceCall(service, service === 'seerr' ? '/api/v1/status' : '/api/v3/system/status', keys);
      return { service, status: 'healthy', latencyMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6) };
    } catch (error) {
      return { service, status: safeError(error), latencyMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6) };
    }
  }));
  return {
    services: tests,
    hostPressure: hostPressure(),
    readOnly: false,
    protectedActions: ['interactive-radarr-search', 'interactive-radarr-grab'],
  };
}

function actionCookie(value, maxAge = ACTION_SESSION_TTL_MS / 1000) {
  return `dashboard_action=${value}; Path=/api; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

function actionError(response, status, message) {
  return sendJson(response, status, { error: message });
}

async function startActionSession(request, response) {
  if (!sameOrigin(request)) return actionError(response, 403, 'Use the dashboard’s HTTPS page to unlock actions');
  const clientKey = actionClientKey(request);
  if (!withinLimit(actionLoginAttempts, clientKey, ACTION_LOGIN_ATTEMPTS, ACTION_LOGIN_WINDOW_MS)) {
    auditAction('unlock', 'rate-limited', { actor: actionActor(request) });
    return actionError(response, 429, 'Too many passphrase attempts. Try again later');
  }
  const payload = await readJsonBody(request, 512);
  const code = typeof payload.code === 'string' ? payload.code : '';
  if (!secureEquals(code, actionSecret())) {
    auditAction('unlock', 'denied', { actor: actionActor(request) });
    return actionError(response, 401, 'Action passphrase was not accepted');
  }
  const id = crypto.randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + ACTION_SESSION_TTL_MS;
  const actor = actionActor(request);
  actionSessions.set(id, {
    actor,
    expiresAt,
    releaseSearches: new Map(),
    searchAttempts: new Map(),
    grabAttempts: new Map(),
  });
  auditAction('unlock', 'allowed', { actor });
  return sendJson(response, 200, { expiresAt: new Date(expiresAt).toISOString() }, { 'Set-Cookie': actionCookie(id) });
}

function requireActionSession(request, response) {
  if (!sameOrigin(request)) {
    actionError(response, 403, 'Use the dashboard’s HTTPS page for actions');
    return null;
  }
  const session = actionSession(request);
  if (!session) {
    actionError(response, 401, 'Unlock download actions first');
    return null;
  }
  if (session.actor !== actionActor(request)) {
    auditAction('session', 'actor-mismatch', { actor: actionActor(request) });
    actionError(response, 403, 'This action session is not valid for the current user');
    return null;
  }
  return session;
}

function clearActionSession(request, response) {
  const session = requireActionSession(request, response);
  if (!session) return;
  actionSessions.delete(session.id);
  auditAction('lock', 'allowed', { actor: session.actor });
  return sendJson(response, 200, { locked: true }, { 'Set-Cookie': actionCookie('', 0) });
}

function contentType(file) {
  return file.endsWith('.css') ? 'text/css; charset=utf-8'
    : file.endsWith('.js') ? 'application/javascript; charset=utf-8'
      : 'text/html; charset=utf-8';
}

function sendJson(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  response.end(body);
}

function sendText(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(value),
  });
  response.end(value);
}

function sendFile(response, file) {
  const safeFile = path.basename(file);
  const filePath = path.join(ROOT, safeFile);
  fs.readFile(filePath, (error, body) => {
    if (error) {
      sendJson(response, 404, { error: 'Not found' });
      return;
    }
    response.writeHead(200, {
      'Content-Type': contentType(safeFile),
      'Cache-Control': safeFile === 'index.html' ? 'no-store' : 'public, max-age=300',
      'Content-Length': body.length,
    });
    response.end(body);
  });
}

async function handleInteractiveSearch(request, response, requestId) {
  const session = requireActionSession(request, response);
  if (!session) return;
  if (!withinLimit(session.searchAttempts, String(requestId), ACTION_SEARCH_LIMIT, ACTION_SEARCH_WINDOW_MS)) {
    auditAction('interactive-search', 'rate-limited', { actor: session.actor, requestId: Number(requestId) });
    return actionError(response, 429, 'Search limit reached for this movie. Try again later');
  }
  try {
    const result = await interactiveReleaseSearch(requestId, session);
    auditAction('interactive-search', 'allowed', {
      actor: session.actor,
      requestId: Number(requestId),
      movieId: result.movieId,
    });
    return sendJson(response, 200, result);
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 503;
    const message = Number.isInteger(error.status) ? error.message : 'Radarr interactive search is unavailable';
    auditAction('interactive-search', 'failed', { actor: session.actor, requestId: Number(requestId) });
    return actionError(response, status, message);
  }
}

async function handleInteractiveGrab(request, response, requestId) {
  const session = requireActionSession(request, response);
  if (!session) return;
  if (!withinLimit(session.grabAttempts, String(requestId), ACTION_GRAB_LIMIT, ACTION_GRAB_WINDOW_MS)) {
    auditAction('interactive-grab', 'rate-limited', { actor: session.actor, requestId: Number(requestId) });
    return actionError(response, 429, 'Grab limit reached for this movie. Try again later');
  }
  let payload;
  try {
    payload = await readJsonBody(request, 512);
  } catch (_) {
    return actionError(response, 400, 'Invalid release selection');
  }
  const releaseToken = typeof payload.releaseToken === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(payload.releaseToken)
    ? payload.releaseToken
    : '';
  if (!releaseToken) return actionError(response, 400, 'Invalid release selection');
  try {
    const result = await interactiveReleaseGrab(requestId, releaseToken, session);
    auditAction('interactive-grab', 'submitted', {
      actor: session.actor,
      requestId: Number(requestId),
      movieId: result.movieId,
      release: result.release.title,
    });
    return sendJson(response, 200, {
      message: 'Release submitted to Radarr',
      title: result.title,
      release: result.release,
    });
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 503;
    const message = Number.isInteger(error.status) ? error.message : 'Radarr could not submit the selected release';
    auditAction('interactive-grab', 'failed', { actor: session.actor, requestId: Number(requestId) });
    return actionError(response, status, message);
  }
}

const server = http.createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");

  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (request.method === 'HEAD') {
    response.writeHead(200);
    response.end();
    return;
  }

  try {
    if (request.method === 'POST' && url.pathname === '/api/actions/session') return startActionSession(request, response);
    if (request.method === 'DELETE' && url.pathname === '/api/actions/session') return clearActionSession(request, response);
    const releaseSearch = url.pathname.match(/^\/api\/request\/(\d+)\/releases$/);
    if (request.method === 'GET' && releaseSearch) return handleInteractiveSearch(request, response, releaseSearch[1]);
    const releaseGrab = url.pathname.match(/^\/api\/request\/(\d+)\/releases\/grab$/);
    if (request.method === 'POST' && releaseGrab) return handleInteractiveGrab(request, response, releaseGrab[1]);
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'Method not allowed' });
      return;
    }
    if (url.pathname === '/api/health') return sendJson(response, 200, await health());
    if (url.pathname === '/api/requests') return sendJson(response, 200, await listRequests());
    if (url.pathname === '/api/attention') return sendJson(response, 200, await mediaAttention());
    const diagnostic = url.pathname.match(/^\/api\/request\/(\d+)\/diagnostic\.txt$/);
    if (diagnostic) {
      const [detailForReport, healthForReport] = await Promise.all([
        detailForRequest(diagnostic[1]),
        health(),
      ]);
      return sendText(response, 200, diagnosticReport(detailForReport, healthForReport));
    }
    const detail = url.pathname.match(/^\/api\/request\/(\d+)$/);
    if (detail) return sendJson(response, 200, await detailForRequest(detail[1]));
    if (url.pathname === '/' || url.pathname === '/index.html') return sendFile(response, 'index.html');
    if (url.pathname === '/app.js') return sendFile(response, 'app.js');
    if (url.pathname === '/style.css') return sendFile(response, 'style.css');
    return sendJson(response, 404, { error: 'Not found' });
  } catch (error) {
    // Avoid returning configuration, connection, or upstream response details.
    return sendJson(response, 503, { error: 'A required media service is unavailable' });
  }
});

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(`Media Operations Dashboard listening on port ${LISTEN_PORT}`);
});
