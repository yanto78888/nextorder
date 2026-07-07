import { readDB, writeDB } from './db.js';

export function getConfig() {
  return readDB('config', {});
}

export function updateConfig(partial) {
  const current = getConfig();
  const merged = deepMerge(current, partial);
  writeDB('config', merged);
  return merged;
}

function deepMerge(target, source) {
  const out = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object'
    ) {
      out[key] = deepMerge(target[key], source[key]);
    } else {
      out[key] = source[key];
    }
  }
  return out;
}
