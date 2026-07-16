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

export function addFlashSaleItem({ productId, flashPrice, badge, thumbnail, quota }) {
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
    thumbnail: thumbnail || '', // foto custom (opsional) -- kosong berarti pakai foto produk aslinya
    quota: Math.max(0, Number(quota) || 0), // 0 = tanpa batas kuota
    soldCount: 0, // jumlah terjual SELAMA jadi Flash Sale (bukan totalSold produk secara keseluruhan)
    active: true,
    order: maxOrder + 1,
    createdAt: new Date().toISOString()
  };
  items.push(item);
  saveFlashSaleItems(items);
  return item;
}

export function updateFlashSaleItem(id, { flashPrice, badge, active, thumbnail, quota, resetSold }) {
  const items = getAllFlashSaleItems();
  const item = items.find(it => it.id === id);
  if (!item) return null;
  if (flashPrice !== undefined) item.flashPrice = Math.max(0, Number(flashPrice) || 0);
  if (badge !== undefined) item.badge = String(badge).trim().slice(0, 24);
  if (active !== undefined) item.active = !!active;
  if (thumbnail) item.thumbnail = thumbnail; // cuma diganti kalau ada foto baru yang diupload
  if (quota !== undefined) item.quota = Math.max(0, Number(quota) || 0);
  if (resetSold) item.soldCount = 0; // buat "restart" ronde Flash Sale tanpa perlu hapus & tambah ulang
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

// Kuota 0/kosong = tanpa batas (gak pernah dianggap "habis"). Kuota > 0 dibandingkan ke soldCount
// (jumlah yang sudah kebeli SELAMA jadi Flash Sale) -- begitu soldCount >= quota, item ini otomatis
// dianggap habis: hilang dari tampilan customer (lihat getFlashSaleDisplayItems onlyActive) dan harga
// flash-nya berhenti berlaku (lihat getActiveFlashPriceForProduct), balik ke harga normal.
export function isFlashSaleQuotaReached(item) {
  return !!(item && item.quota > 0 && (item.soldCount || 0) >= item.quota);
}

// Dipanggil setelah checkout SUKSES (bukan yang direfund/gagal) buat produk yang harga flash-nya
// kepakai. Nambahin soldCount item Flash Sale yang match, biar kuota "misal 10, kalau udah 10 auto
// hilang" bisa dihitung dari pembelian riil, bukan cuma totalSold produk secara umum.
export function recordFlashSaleSale(productId, qty = 1) {
  const items = getAllFlashSaleItems();
  const item = items.find(it => it.productId === productId && it.active !== false);
  if (!item) return;
  item.soldCount = (item.soldCount || 0) + Math.max(1, Number(qty) || 1);
  saveFlashSaleItems(items);
}

// Item + data produk aslinya digabung jadi satu buat ditampilkan (kartu carousel & halaman admin).
// Produk yang sudah dihapus/dinonaktifkan otomatis gak ikut nongol (bukan error, cuma dilewati).
// onlyActive=true (tampilan customer di beranda/carousel) JUGA nyaring item yang kuotanya udah
// tercapai. onlyActive=false (halaman kelola admin) TETAP nampilin item itu (ditandai quotaReached)
// biar admin masih bisa naikin kuota / reset jumlah terjual, bukan malah "hilang" dari daftar kelola.
export function getFlashSaleDisplayItems({ onlyActive = true } = {}) {
  const items = getAllFlashSaleItems()
    .filter(it => !onlyActive || it.active !== false)
    .filter(it => !onlyActive || !isFlashSaleQuotaReached(it))
    .sort((a, b) => (a.order || 0) - (b.order || 0));

  return items
    .map(item => {
      const product = findProductById(item.productId);
      if (!product) return null;
      if (onlyActive && product.status !== 'active') return null;
      const stockCount = product.stockItems ? product.stockItems.length : 0;
      const quota = item.quota || 0;
      const soldCount = item.soldCount || 0;
      return {
        id: item.id,
        productId: product.id,
        name: product.variantGroup || product.name,
        thumbnail: item.thumbnail || product.thumbnail || '', // foto custom Flash Sale menang, fallback foto produk
        category: product.category || '',
        icon: product.icon || '',
        originalPrice: product.price,
        flashPrice: item.flashPrice,
        badge: item.badge || '',
        active: item.active !== false,
        isAuto: product.provider === 'digiflazz',
        stockCount,
        productStatus: product.status,
        quota,
        soldCount,
        remaining: quota > 0 ? Math.max(0, quota - soldCount) : null,
        quotaReached: isFlashSaleQuotaReached(item)
      };
    })
    .filter(Boolean);
}

// Harga flash SATU-SATUNYA (bukan per-role) buat productId tertentu, atau null kalau produk itu
// gak lagi flash sale / sale-nya lagi mati/expired / kuotanya udah tercapai. null artinya "pakai
// harga normal seperti biasa" -- dicek di sini juga (bukan cuma pas render halaman) supaya begitu
// kuota tercapai, checkout langsung ikutan pakai harga normal lagi, gak bisa "kebobolan" lewat
// halaman produk yang sempat ke-cache/telat refresh di browser user.
export function getActiveFlashPriceForProduct(productId) {
  if (!isFlashSaleRunning()) return null;
  const item = getAllFlashSaleItems().find(it => it.productId === productId && it.active !== false);
  if (!item || isFlashSaleQuotaReached(item)) return null;
  return item.flashPrice;
}

// Pengganti "user ? applyMemberDiscount(product.price, user.membership) : product.price" di semua
// tempat yang menentukan harga jual produk. Flash sale SELALU menang & SAMA buat reguler/gold/
// platinum/tamu sekalipun -- diskon membership sengaja tidak digabung/ditumpuk di atas harga flash.
export function getEffectivePrice(product, user) {
  const flashPrice = getActiveFlashPriceForProduct(product.id);
  if (flashPrice != null) return flashPrice;
  return user ? applyMemberDiscount(product.price, user.membership) : product.price;
}
