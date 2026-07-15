import { readDB, writeDB, genId } from './db.js';
import { getConfig, updateConfig } from './config.js';
import { findProductById } from './products.js';
import { applyMemberDiscount } from './membership.js';

// =====================================================================
// FLASH SALE
// Item flash sale BUKAN produk baru -- tiap item cuma nunjuk ke productId
// produk yang udah ada (lewat lib/products.js) plus harga flashPrice yang
// menang di atas harga normal + diskon membership SELAMA sale itu aktif.
// Disimpan terpisah di data/flashsale.json (array), sedangkan setting
// section-nya (on/off, batas waktu countdown, judul) nebeng di config.json
// key "flashSale", pola yang sama kayak banners/marquee/qris.
// =====================================================================

export function getAllFlashSaleItems() {
  return readDB('flashsale', []);
}

function saveFlashSaleItems(items) {
  writeDB('flashsale', items);
}

export function getFlashSaleSettings() {
  const cfg = getConfig();
  return {
    enabled: !!(cfg.flashSale && cfg.flashSale.enabled),
    endsAt: (cfg.flashSale && cfg.flashSale.endsAt) || '',
    title: (cfg.flashSale && cfg.flashSale.title) || 'Flash Sale'
  };
}

// Input <input type="datetime-local"> dari form ("YYYY-MM-DDTHH:mm") gak bawa info zona waktu
// sama sekali. Nextorder ini buat pasar Indonesia, jadi nilainya SENGAJA dianggap jam WIB
// (UTC+7) secara eksplisit di sini -- supaya waktu berakhir Flash Sale gak ikut geser kalau
// VPS-nya kebetulan di-set UTC (umum buat VPS baru) bukan Asia/Jakarta.
function wibLocalInputToUtcIso(localStr) {
  if (!localStr) return '';
  const d = new Date(`${localStr}:00+07:00`);
  return isNaN(d.getTime()) ? '' : d.toISOString();
}

// Kebalikannya: dari ISO UTC yang tersimpan, balikin string "YYYY-MM-DDTHH:mm" versi jam WIB
// buat ngisi ulang value input datetime-local pas halaman Settings-nya dibuka lagi.
export function utcIsoToWibLocalInput(isoUtc) {
  if (!isoUtc) return '';
  const d = new Date(isoUtc);
  if (isNaN(d.getTime())) return '';
  const wib = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  return wib.toISOString().slice(0, 16);
}

export function updateFlashSaleSettings({ enabled, endsAt, title }) {
  updateConfig({
    flashSale: {
      enabled: !!enabled,
      endsAt: wibLocalInputToUtcIso(endsAt),
      title: (title || 'Flash Sale').trim()
    }
  });
}

// Section dianggap "sedang berjalan" kalau di-toggle aktif DAN (belum diisi batas waktu ATAU
// batas waktunya belum lewat). Admin isi tanggal kosong = flash sale terus nyala tanpa hitung mundur.
export function isFlashSaleRunning() {
  const s = getFlashSaleSettings();
  if (!s.enabled) return false;
  if (!s.endsAt) return true;
  return new Date(s.endsAt).getTime() > Date.now();
}

export function findFlashSaleItem(id) {
  return getAllFlashSaleItems().find(it => it.id === id) || null;
}

export function addFlashSaleItem({ productId, flashPrice, badge }) {
  const items = getAllFlashSaleItems();
  if (items.some(it => it.productId === productId)) {
    throw new Error('Produk ini sudah ada di daftar Flash Sale');
  }
  const maxOrder = items.reduce((m, it) => Math.max(m, it.order || 0), -1);
  const item = {
    id: genId('FS'),
    productId,
    flashPrice: Math.max(0, Number(flashPrice) || 0),
    badge: (badge || '').trim().slice(0, 24),
    active: true,
    order: maxOrder + 1,
    createdAt: new Date().toISOString()
  };
  items.push(item);
  saveFlashSaleItems(items);
  return item;
}

export function updateFlashSaleItem(id, { flashPrice, badge, active }) {
  const items = getAllFlashSaleItems();
  const item = items.find(it => it.id === id);
  if (!item) return null;
  if (flashPrice !== undefined) item.flashPrice = Math.max(0, Number(flashPrice) || 0);
  if (badge !== undefined) item.badge = String(badge).trim().slice(0, 24);
  if (active !== undefined) item.active = !!active;
  saveFlashSaleItems(items);
  return item;
}

export function deleteFlashSaleItem(id) {
  saveFlashSaleItems(getAllFlashSaleItems().filter(it => it.id !== id));
}

// Dipanggil dari routes/admin.js pas admin hapus produk di Kelola Produk -- biar gak ada item
// Flash Sale nyangkut nunjuk ke productId yang udah gak ada (yang juga gak akan keliatan lagi
// di halaman manage-nya karena getFlashSaleDisplayItems nyaring produk yang null).
export function removeFlashSaleItemsByProductId(productId) {
  saveFlashSaleItems(getAllFlashSaleItems().filter(it => it.productId !== productId));
}

// orderedIds = array id sesuai urutan baru hasil drag di admin.
export function reorderFlashSaleItems(orderedIds) {
  const items = getAllFlashSaleItems();
  orderedIds.forEach((id, idx) => {
    const item = items.find(it => it.id === id);
    if (item) item.order = idx;
  });
  saveFlashSaleItems(items);
}

// Item + data produk aslinya digabung jadi satu buat ditampilkan (kartu carousel & halaman admin).
// Produk yang sudah dihapus/dinonaktifkan otomatis gak ikut nongol (bukan error, cuma dilewati).
export function getFlashSaleDisplayItems({ onlyActive = true } = {}) {
  const items = getAllFlashSaleItems()
    .filter(it => !onlyActive || it.active !== false)
    .sort((a, b) => (a.order || 0) - (b.order || 0));

  return items
    .map(item => {
      const product = findProductById(item.productId);
      if (!product) return null;
      if (onlyActive && product.status !== 'active') return null;
      const stockCount = product.stockItems ? product.stockItems.length : 0;
      return {
        id: item.id,
        productId: product.id,
        name: product.variantGroup || product.name,
        thumbnail: product.thumbnail || '',
        category: product.category || '',
        icon: product.icon || '',
        originalPrice: product.price,
        flashPrice: item.flashPrice,
        badge: item.badge || '',
        active: item.active !== false,
        isAuto: product.provider === 'digiflazz',
        stockCount,
        productStatus: product.status
      };
    })
    .filter(Boolean);
}

// Harga flash SATU-SATUNYA (bukan per-role) buat productId tertentu, atau null kalau produk itu
// gak lagi flash sale / sale-nya lagi mati/expired. null artinya "pakai harga normal seperti biasa".
export function getActiveFlashPriceForProduct(productId) {
  if (!isFlashSaleRunning()) return null;
  const item = getAllFlashSaleItems().find(it => it.productId === productId && it.active !== false);
  return item ? item.flashPrice : null;
}

// Pengganti "user ? applyMemberDiscount(product.price, user.membership) : product.price" di semua
// tempat yang menentukan harga jual produk. Flash sale SELALU menang & SAMA buat reguler/gold/
// platinum/tamu sekalipun -- diskon membership sengaja tidak digabung/ditumpuk di atas harga flash.
export function getEffectivePrice(product, user) {
  const flashPrice = getActiveFlashPriceForProduct(product.id);
  if (flashPrice != null) return flashPrice;
  return user ? applyMemberDiscount(product.price, user.membership) : product.price;
}
