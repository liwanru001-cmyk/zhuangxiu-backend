const fs = require('node:fs/promises');
const path = require('node:path');

const HISTORY_DAYS = 7;
const DAILY_LIMIT = 1024 * 1024;
const QUEUE_LIMIT = 500;
const METHOD = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/;
const PRODUCT_API = /^\/api\/(?:admin|auth|notes|users|renovation|marketplace|consultations|reports|projects|entity-relations|billing|location|public|product-library|media-uploads|mcp)(?:\/|$)/;
const adminPath = '/api/admin/backend-alerts';

function dateKey(date) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function safePath(value) {
  return value.split('/').map(part => {
    if (!part || /^[a-z][a-z_-]{0,31}$/.test(part) || /^:[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(part)) return part;
    return ':value';
  }).slice(0, 14).join('/');
}

function capture(req, res) {
  const pathname = (req.originalUrl || '').split('?')[0];
  if ((!pathname.startsWith('/api/') && pathname !== '/health') ||
      pathname === adminPath || pathname.startsWith(adminPath + '/') ||
      !METHOD.test(req.method)) return null;

  const missing = res.statusCode === 404 && res.locals.unmatchedApi === true && PRODUCT_API.test(pathname);
  if (!missing && (res.statusCode < 500 || res.statusCode > 599)) return null;

  const route = req.route?.path;
  return {
    method: req.method,
    route: safePath(!missing && typeof route === 'string' ? (req.baseUrl || '') + route : pathname),
    status: res.statusCode,
  };
}

function createBackendAlerts(directory, { clock = () => new Date(), onError = console.error } = {}) {
  let pending = Promise.resolve();
  let queued = 0;
  let currentDay;
  let currentSize;
  let storageError = false;
  let dropped = 0;
  const logFile = day => path.join(directory, day + '.jsonl');

  async function append(day, line) {
    if (day !== currentDay) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const size = await fs.stat(logFile(day)).then(info => info.size, err => {
        if (err.code === 'ENOENT') return 0;
        throw err;
      });
      currentDay = day;
      currentSize = size;
      const cutoff = dateKey(new Date(new Date(day + 'T00:00:00+08:00').getTime() - (HISTORY_DAYS - 1) * 86400000));
      for (const file of await fs.readdir(directory)) {
        if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file) && file.slice(0, 10) < cutoff) {
          await fs.rm(path.join(directory, file), { force: true });
        }
      }
    }
    if (currentSize >= DAILY_LIMIT) {
      dropped++;
      return;
    }
    await fs.appendFile(logFile(day), line, { mode: 0o600 });
    currentSize += Buffer.byteLength(line);
  }

  function record(event) {
    if (queued >= QUEUE_LIMIT) {
      dropped++;
      return;
    }
    const now = clock();
    const day = dateKey(now);
    const line = JSON.stringify({ ...event, at: now.toISOString() }) + '\n';
    queued++;
    pending = pending.then(() => append(day, line)).then(() => {
      storageError = false;
    }).catch(err => {
      if (!storageError) onError('Backend alert storage failed', err.code || err.message);
      storageError = true;
      dropped++;
    }).finally(() => { queued--; });
  }

  function middleware(req, res, next) {
    res.once('finish', () => {
      const event = capture(req, res);
      if (event) record(event);
    });
    next();
  }

  async function list(days) {
    await pending;
    const now = clock();
    const groups = new Map();
    let truncated = storageError || dropped > 0;
    const counts = { missing: 0, server: 0 };
    for (let age = 0; age < days; age++) {
      const day = dateKey(new Date(now.getTime() - age * 86400000));
      const contents = await fs.readFile(logFile(day), 'utf8').catch(err => {
        if (err.code === 'ENOENT') return '';
        throw err;
      });
      if (Buffer.byteLength(contents) >= DAILY_LIMIT) truncated = true;
      for (const line of contents.trim().split('\n').filter(Boolean)) {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          truncated = true;
          continue;
        }
        const { method, route, status, at } = event;
        const key = JSON.stringify([method, route, status]);
        const group = groups.get(key) || { method, route, status, first_at: at, last_at: at, count: 0 };
        group.count++;
        if (at < group.first_at) group.first_at = at;
        if (at > group.last_at) group.last_at = at;
        groups.set(key, group);
        counts[status === 404 ? 'missing' : 'server']++;
      }
    }
    const rows = [...groups.values()].sort((a, b) => b.last_at.localeCompare(a.last_at));
    return { counts, rows: rows.slice(0, 200), total: rows.length, truncated, checked_at: now.toISOString() };
  }

  return { middleware, list };
}

module.exports = { adminPath, createBackendAlerts };
