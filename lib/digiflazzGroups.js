import { readDB, writeDB } from './db.js';

// Foto per Grup Varian Digiflazz (mis. "Mobile Legends") — ini foto folder/grup, BEDA sama
// foto per-SKU produk (yang jarang diisi admin karena produknya ratusan nominal). Foto grup ini
// yang dipakai buat kartu folder di halaman admin Digiflazz, dan juga jadi thumbnail utama kartu
// grup di katalog publik (menang duluan dibanding foto produk individual di dalam grup itu).

export function getGroupThumbnails() {
  const rows = readDB('digiflazzGroups', []);
  const map = {};
  rows.forEach(r => {
    if (r && r.variantGroup) map[r.variantGroup] = r.thumbnail || '';
  });
  return map;
}

export function getGroupThumbnail(variantGroup) {
  if (!variantGroup) return '';
  return getGroupThumbnails()[variantGroup] || '';
}

export function setGroupThumbnail(variantGroup, thumbnail) {
  const name = String(variantGroup || '').trim();
  if (!name) throw new Error('Nama grup kosong');
  const rows = readDB('digiflazzGroups', []);
  const idx = rows.findIndex(r => r.variantGroup === name);
  if (idx === -1) {
    rows.push({ variantGroup: name, thumbnail: thumbnail || '' });
  } else {
    rows[idx].thumbnail = thumbnail || '';
  }
  writeDB('digiflazzGroups', rows);
  return rows[idx === -1 ? rows.length - 1 : idx];
}
