import axios from 'axios';
import { getConfig } from './config.js';

// IndoSMM pakai API "standar SMM Panel" (action=services/add/status/balance/refill/cancel lewat 1
// endpoint, POST application/x-www-form-urlencoded) -- polanya sama kayak dokumentasi resmi yang
// dikasih (class Api di indosmm.id). CATATAN: rate/harga dari IndoSMM diasumsikan sudah dalam
// Rupiah (bukan USD) karena ini panel pasar Indonesia (domain .id) dan seluruh toko ini pakai IDR;
// kalau ternyata akun IndoSMM-nya di-set USD, sesuaikan computeSellPrice() di bawah buat convert
// dulu sebelum dikali margin.
const BASE_URL = 'https://indosmm.id/api/v2';

function getCreds() {
  const cfg = getConfig();
  const sm = cfg.indosmm || {};
  if (!sm.apiKey) {
    throw new Error('IndoSMM belum dikonfigurasi. Isi API Key di Admin > Pengaturan.');
  }
  return { apiKey: sm.apiKey };
}

export function isIndosmmEnabled() {
  const cfg = getConfig();
  const sm = cfg.indosmm || {};
  return Boolean(sm.enabled && sm.apiKey);
}

async function callApi(params) {
  const { apiKey } = getCreds();
  const body = new URLSearchParams({ key: apiKey, ...params });
  const res = await axios.post(BASE_URL, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 20000
  });
  return res.data;
}

// Hitung harga jual per 1000 dari rate modal IndoSMM + margin (persen/nominal tetap per 1000).
// Sama polanya kayak computeSellPrice di lib/digiflazz.js -- kalau marginType/marginValue kosong,
// pakai margin default global dari config.indosmm.
export function computeSellPrice(baseRatePer1000, marginType, marginValue) {
  const cfg = getConfig();
  const smCfg = cfg.indosmm || {};
  const type = marginType || smCfg.marginType || 'percent';
  const value = (marginValue !== null && marginValue !== undefined && marginValue !== '')
    ? Number(marginValue)
    : Number(smCfg.marginValue || 30); // default 30% kalau belum pernah diatur sama sekali

  const base = Number(baseRatePer1000) || 0;
  const raw = type === 'fixed' ? (base + value) : (base + (base * value / 100));
  return Math.ceil(raw / 10) * 10; // dibulatkan ke atas kelipatan 10 (rate per 1000 biasanya kecil)
}

// Total harga jual buat qty tertentu, dibulatkan ke atas per rupiah. rate = harga jual PER 1000.
export function computeTotalForQty(sellRatePer1000, qty) {
  return Math.ceil((Number(sellRatePer1000) || 0) * (Number(qty) || 0) / 1000);
}

export async function getBalance() {
  const data = await callApi({ action: 'balance' });
  if (!data || data.error) throw new Error((data && data.error) || 'Gagal cek saldo IndoSMM');
  return { balance: Number(data.balance) || 0, currency: data.currency || 'IDR' };
}

// Daftar layanan IndoSMM bisa ribuan baris & (kayak Digiflazz) sebaiknya gak ditembak berkali-kali
// dalam waktu singkat, jadi dicache sebentar di memory sama kayak getPriceList() di lib/digiflazz.js.
const SERVICE_CACHE_TTL_MS = 3 * 60 * 1000;
let serviceCache = null; // { data, expiresAt }

export async function getServices() {
  if (serviceCache && serviceCache.expiresAt > Date.now()) return serviceCache.data;
  const data = await callApi({ action: 'services' });
  if (data && data.error) throw new Error(data.error);
  const list = Array.isArray(data) ? data : [];
  serviceCache = { data: list, expiresAt: Date.now() + SERVICE_CACHE_TTL_MS };
  return list;
}

export async function getServiceCategories() {
  const list = await getServices();
  const set = new Set(list.map(s => s.category).filter(Boolean));
  return Array.from(set).sort();
}

// Cari layanan by keyword dan/atau kategori. v1 SENGAJA dibatasi cuma layanan type "Default"
// (link + jumlah standar) -- tipe lain (Custom Comments, Poll, Subscriptions) butuh input & alur
// order yang beda total, di luar cakupan integrasi awal ini.
export async function searchServices(keyword = '', category = '') {
  const list = await getServices();
  const kw = keyword.trim().toLowerCase();
  const cat = category.trim().toLowerCase();
  return list
    .filter(s => !cat || String(s.category || '').toLowerCase() === cat)
    .filter(s => !kw ||
      String(s.name || '').toLowerCase().includes(kw) ||
      String(s.category || '').toLowerCase().includes(kw)
    )
    .filter(s => !s.type || String(s.type).toLowerCase() === 'default')
    .slice(0, 300);
}

export async function placeOrder({ serviceId, link, quantity }) {
  const data = await callApi({ action: 'add', service: serviceId, link, quantity });
  if (!data || data.error) throw new Error((data && data.error) || 'Order ditolak sistem');
  if (!data.order) throw new Error('Respons sistem tidak valid (tidak ada order id)');
  return { orderId: String(data.order) };
}

export async function checkMultiOrderStatus(orderIds) {
  if (!orderIds || orderIds.length === 0) return {};
  const data = await callApi({ action: 'status', orders: orderIds.join(',') });
  return (data && typeof data === 'object') ? data : {};
}

// ===== RECONCILE ORDER YANG MASIH "processing" =====
// Order SMM gak kayak Digiflazz yang biasanya kelar dalam hitungan detik -- bisa berjam-jam bahkan
// berhari-hari (drip-feed). Job ini jalan berkala (lihat server.js), cek status semua order
// IndoSMM yang masih "processing" sekaligus dalam 1 panggilan (action=status&orders=1,2,3), lalu:
// - Completed        -> order jadi 'completed'
// - Partial          -> SEBAGIAN terkirim: order tetap jadi 'completed' (karena ada yang terkirim),
//                       tapi porsi yang gak terkirim (remains) di-refund PROPORSIONAL ke saldo user.
//                       Dihitung dari proporsi qty yang gak terkirim (remains/qty awal), BUKAN dari
//                       convert "charge" IndoSMM ke Rupiah -- biar gak kena masalah currency/rate
//                       IndoSMM vs harga jual toko yang bisa beda-beda per produk.
// - Canceled         -> full refund, order jadi 'cancelled'
// - selain itu (masih jalan/nunggu) -> dibiarin, dicek lagi ronde berikutnya
export async function checkPendingIndosmmOrders() {
  if (!isIndosmmEnabled()) return;

  const { getAllOrders, updateOrderStatus } = await import('./orders.js');
  const { addSaldo } = await import('./users.js');
  const { notifyOrder } = await import('./telegram.js');

  const pendingOrders = getAllOrders().filter(
    o => o.provider === 'indosmm' && o.status === 'processing' && o.providerRefId
  );
  if (pendingOrders.length === 0) return;

  let statusMap = {};
  try {
    statusMap = await checkMultiOrderStatus(pendingOrders.map(o => o.providerRefId));
  } catch (err) {
    console.error('[indosmm] Gagal cek status pending:', err.message);
    return;
  }

  for (const order of pendingOrders) {
    const info = statusMap[order.providerRefId];
    if (!info || info.error) continue; // belum ada info valid, coba lagi ronde berikutnya

    const status = String(info.status || '').toLowerCase();

    if (status === 'completed') {
      updateOrderStatus(order.id, 'completed', 'Pesanan selesai diproses sistem.');
      notifyOrder({
        username: order.username, productName: order.productName, total: order.total,
        orderId: order.id, source: 'indosmm', needsManual: false, targetText: order.targetText
      }).catch(() => {});
    } else if (status === 'partial') {
      const originalQty = Number(order.qty) || 1;
      const remains = Math.min(originalQty, Number(info.remains) || 0);
      const delivered = originalQty - remains;
      const refundAmount = Math.round((Number(order.total) || 0) * (remains / originalQty));
      if (refundAmount > 0) addSaldo(order.userId, refundAmount);
      updateOrderStatus(
        order.id, 'completed',
        `Terkirim sebagian: ${delivered.toLocaleString('id-ID')} dari ${originalQty.toLocaleString('id-ID')}.` +
        (refundAmount > 0 ? ` Sisanya di-refund Rp ${refundAmount.toLocaleString('id-ID')} ke saldo.` : '')
      );
    } else if (status === 'canceled' || status === 'cancelled') {
      addSaldo(order.userId, order.total);
      updateOrderStatus(order.id, 'cancelled', 'Pesanan dibatalkan sistem, saldo dikembalikan sepenuhnya.');
    }
    // in progress / pending / processing -> dibiarin dulu, dicek lagi ronde berikutnya
  }
}
