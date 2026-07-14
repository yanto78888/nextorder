import axios from 'axios';
import crypto from 'crypto';
import { getConfig } from './config.js';

const BASE_URL = 'https://api.digiflazz.com/v1';

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

function getCreds() {
  const cfg = getConfig();
  const df = cfg.digiflazz || {};
  if (!df.username || !df.apiKey) {
    throw new Error('Digiflazz belum dikonfigurasi. Isi Username & API Key di Admin > Pengaturan.');
  }
  return { username: df.username, apiKey: df.apiKey, mode: df.mode || 'live' };
}

export function isDigiflazzEnabled() {
  const cfg = getConfig();
  const df = cfg.digiflazz || {};
  return Boolean(df.enabled && df.username && df.apiKey);
}

// Hitung harga jual dari harga modal Digiflazz + margin.
// marginType/marginValue kalau di-pass null/'' berarti pakai margin default global dari config.
export function computeSellPrice(basePrice, marginType, marginValue) {
  const cfg = getConfig();
  const dfCfg = cfg.digiflazz || {};
  const type = marginType || dfCfg.marginType || 'percent';
  const value = (marginValue !== null && marginValue !== undefined && marginValue !== '')
    ? Number(marginValue)
    : Number(dfCfg.marginValue || 0);

  const base = Number(basePrice) || 0;
  const raw = type === 'fixed' ? (base + value) : (base + (base * value / 100));
  // Bulatkan ke atas kelipatan 100 biar rapi buat harga rupiah (mis. 12.345 -> 12.400)
  return Math.ceil(raw / 100) * 100;
}

// Cek saldo deposit Digiflazz, ditampilkan di dashboard admin biar gampang pantau saldo.
export async function checkBalance() {
  const { username, apiKey } = getCreds();
  const sign = md5(`${username}${apiKey}depo`);
  const res = await axios.post(`${BASE_URL}/cek-saldo`, {
    cmd: 'deposit',
    username,
    sign
  }, { timeout: 15000 });
  return res.data?.data?.deposit ?? null;
}

// Ambil price list dari Digiflazz. cmd: 'prepaid' (produk game/pulsa) atau 'pasca' (pascabayar).
export async function getPriceList(cmd = 'prepaid') {
  const { username, apiKey } = getCreds();
  const sign = md5(`${username}${apiKey}pricelist`);
  const res = await axios.post(`${BASE_URL}/price-list`, {
    cmd,
    username,
    sign
  }, { timeout: 20000 });
  const list = res.data?.data;
  return Array.isArray(list) ? list : [];
}

// Cari produk dari price list Digiflazz by keyword (nama produk / brand / sku) dan/atau kategori,
// dipakai admin buat pilih SKU. Kategori dipisah (gak digabung jadi 1 list random) biar admin
// gampang nyari — mis. cuma mau lihat kategori "Games" doang, bukan ke-mix sama "Pulsa"/"PLN".
export async function searchPriceList(keyword = '', cmd = 'prepaid', category = '') {
  const list = await getPriceList(cmd);
  const kw = keyword.trim().toLowerCase();
  const cat = category.trim().toLowerCase();

  return list
    .filter(item => !cat || String(item.category || '').toLowerCase() === cat)
    .filter(item => !kw ||
      String(item.product_name || '').toLowerCase().includes(kw) ||
      String(item.brand || '').toLowerCase().includes(kw) ||
      String(item.buyer_sku_code || '').toLowerCase().includes(kw)
    )
    .slice(0, 200);
}

// Daftar kategori unik yang tersedia di price list Digiflazz, buat ngisi dropdown filter kategori.
export async function getPriceListCategories(cmd = 'prepaid') {
  const list = await getPriceList(cmd);
  const set = new Set(list.map(item => item.category).filter(Boolean));
  return Array.from(set).sort();
}

// Susun customer_no dari isian target user (ID Game/Zone ID/dll) berdasarkan template produk.
// Template pakai placeholder {key} sesuai targetFields produk, mis. "{userId}{zoneId}".
// Kalau admin tidak isi template custom, default gabungkan value sesuai konvensi Digiflazz per publisher game:
// - Mobile Legends: userId + zoneId digabung LANGSUNG tanpa pemisah, mis. "123456" + "1234" -> "1234561234"
//   (BUKAN "123456.1234" -- titik bikin customer_no yang dikirim ke Digiflazz salah/ditolak).
// - miHoYo (Genshin Impact, Honkai: Star Rail) & Wuthering Waves: uid + server dipisah "|",
//   mis. "800123456|os_asia".
// - Preset lain (termasuk custom): tetap default titik "." seperti sebelumnya.
const CUSTOMER_NO_SEPARATOR_BY_PRESET = {
  mobile_legends: '',
  genshin_impact: '|',
  honkai_star_rail: '|',
  wuthering_waves: '|'
};

export function buildCustomerNo(product, targetData) {
  const fields = product.targetFields || [];
  const template = (product.digiflazzCustomerNoTemplate || '').trim();

  if (template) {
    return fields.reduce((str, f) => str.split(`{${f.key}}`).join(targetData[f.key] || ''), template);
  }

  const separator = CUSTOMER_NO_SEPARATOR_BY_PRESET[product.gamePreset] ?? '.';

  return fields
    .map(f => targetData[f.key])
    .filter(Boolean)
    .join(separator);
}

// Eksekusi transaksi top up ke Digiflazz. refId harus unik per transaksi (dipakai juga buat cek status ulang).
export async function createTransaction({ buyerSkuCode, customerNo, refId, testing = false }) {
  const { username, apiKey } = getCreds();
  const sign = md5(`${username}${apiKey}${refId}`);

  const payload = {
    username,
    buyer_sku_code: buyerSkuCode,
    customer_no: customerNo,
    ref_id: refId,
    sign
  };
  if (testing) payload.testing = true;

  const res = await axios.post(`${BASE_URL}/transaction`, payload, { timeout: 30000 });
  const data = res.data?.data;
  if (!data) throw new Error('Respons Digiflazz tidak valid');
  return data; // { ref_id, customer_no, buyer_sku_code, message, status, rc, sn, price, buyer_last_saldo, ... }
}

// Cek ulang status transaksi yang masih Pending. Digiflazz: kirim ulang payload transaksi yang sama
// (ref_id sama) akan mengembalikan status terkini tanpa memotong saldo dua kali.
export async function checkTransactionStatus({ buyerSkuCode, customerNo, refId }) {
  return createTransaction({ buyerSkuCode, customerNo, refId, testing: false });
}

// Dipanggil berkala oleh interval global di server.js buat reconcile order Digiflazz yang statusnya
// masih "Pending" di sisi Digiflazz saat pertama kali order dibuat (butuh dicek ulang sampai Sukses/Gagal).
export async function checkPendingDigiflazzOrders() {
  if (!isDigiflazzEnabled()) return;

  // Import lazy di sini biar tidak circular-import (orders.js/users.js/telegram.js gak butuh digiflazz.js).
  const { getAllOrders, updateOrderStatus } = await import('./orders.js');
  const { addSaldo } = await import('./users.js');
  const { notifyOrder } = await import('./telegram.js');
  const { findProductById } = await import('./products.js');

  const pendingOrders = getAllOrders().filter(
    o => o.provider === 'digiflazz' && o.status === 'processing' && o.providerRefId
  );
  if (pendingOrders.length === 0) return;

  for (const order of pendingOrders) {
    const product = order.productId ? findProductById(order.productId) : null;
    if (!product || !product.digiflazzSku) continue;

    try {
      const result = await checkTransactionStatus({
        buyerSkuCode: product.digiflazzSku,
        customerNo: order.providerCustomerNo || '',
        refId: order.providerRefId
      });

      const status = String(result.status || '').toLowerCase();
      if (status === 'sukses') {
        updateOrderStatus(order.id, 'completed', result.sn || result.message || 'Top up berhasil');
        notifyOrder({
          username: order.username,
          productName: order.productName,
          total: order.total,
          orderId: order.id,
          source: 'digiflazz',
          needsManual: false,
          targetText: order.targetText
        }).catch(() => {});
      } else if (status === 'gagal') {
        // Refund saldo user karena transaksi gagal di sisi Digiflazz
        addSaldo(order.userId, order.total);
        updateOrderStatus(order.id, 'cancelled', result.message || 'Top up gagal, saldo dikembalikan');
      }
      // Kalau masih "Pending", biarkan saja, dicek lagi di siklus berikutnya.
    } catch (err) {
      console.error('[digiflazz] Gagal cek status order', order.id, err.message);
    }
  }
}
