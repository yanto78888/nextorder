import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_DATA_DIR = path.join(__dirname, '..', 'data');

// Vercel serverless filesystem is read-only except /tmp.
// For demo deploys on Vercel, copy bundled JSON files to /tmp first.
// Note: /tmp is ephemeral, so use a real database before production.
const DATA_DIR = process.env.VERCEL === '1'
  ? path.join('/tmp', 'nexorder-data')
  : SOURCE_DATA_DIR;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (process.env.VERCEL === '1' && fs.existsSync(SOURCE_DATA_DIR)) {
    for (const file of fs.readdirSync(SOURCE_DATA_DIR)) {
      if (!file.endsWith('.json')) continue;
      const src = path.join(SOURCE_DATA_DIR, file);
      const dest = path.join(DATA_DIR, file);
      if (!fs.existsSync(dest)) {
        fs.copyFileSync(src, dest);
      }
    }
  }
}

ensureDataDir();

// Simple write queue per file to avoid concurrent write corruption
const queues = {};

function filePath(name) {
  ensureDataDir();
  return path.join(DATA_DIR, `${name}.json`);
}

export function readDB(name, fallback = []) {
  try {
    const raw = fs.readFileSync(filePath(name), 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
}

function _writeNow(name, data) {
  ensureDataDir();
  const tmp = filePath(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath(name));
}

export function writeDB(name, data) {
  // chain writes so they never interleave
  const prev = queues[name] || Promise.resolve();
  const next = prev.then(() => _writeNow(name, data)).catch(() => _writeNow(name, data));
  queues[name] = next;
  return next;
}

export function genId(prefix = '') {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}${Date.now().toString(36).toUpperCase()}${rand}`;
}
