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

// BUG LAMA: tiap axios.post ke Digiflazz gagal (400/401/dst), cuma err.message bawaan axios yang
// dipakai ("Request failed with status code 400") -- alasan SEBENARNYA dari Digiflazz (mis. "Invalid
// Payload", "Signature Anda Salah", "IP Anda tidak kami kenali: x.x.x.x", SKU tidak ditemukan, dst)
// ada di BODY response-nya (res.data.data.message, kadang disertai rc & additional_data.validation --
// lihat dok resmi https://developer.digiflazz.com/api_management/seller/base-response-code/), BUKAN
// di err.message. Efeknya: customer & admin cuma lihat "status code 400" doang, gak mungkin tahu ini
// SKU salah / signature salah / IP belum kedaftar / dst -- gak bisa didiagnosis sama sekali. Dipakai
// di semua fungsi yang manggil axios langsung ke Digiflazz di bawah.
function describeDigiflazzError(err) {
  const body = err.response?.data;
  const detail = (body && typeof body === 'object' && body.data && typeof body.data === 'object') ? body.data : body;
  if (detail && typeof detail === 'object') {
    const parts = [];
    if (detail.message) parts.push(String(detail.message));
    const validation = detail.additional_data && detail.additional_data.validation;
    if (validation && typeof validation === 'object') {
      Object.values(validation).forEach(msgs => {
        (Array.isArray(msgs) ? msgs : [msgs]).forEach(m => { if (m) parts.push(String(m)); });
      });
    }
    if (parts.length > 0) {
      const rc = detail.rc ? ` (rc ${detail.rc})` : '';
      const status = err.response.status ? ` [HTTP ${err.response.status}]` : '';
      return `${parts.join('; ')}${rc}${status}`;
    }
  }
  if (err.response) {
    // Ada respons dari Digiflazz tapi bentuknya gak dikenali -- minimal tetap kasih tau kode HTTP-nya
    // daripada cuma "Request failed with status code XXX" yang gak nambah info apa-apa.
    return `Digiflazz membalas HTTP ${err.response.status}${err.message ? `: ${err.message}` : ''}`;
  }
  // Gak ada respons sama sekali (timeout/koneksi putus/DNS gagal, dst) -- err.message axios bawaan
  // ("timeout of 30000ms exceeded", dst) sudah cukup jelas buat kasus ini.
  return err.message;
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
  try {
    const res = await axios.post(`${BASE_URL}/cek-saldo`, {
      cmd: 'deposit',
      username,
      sign
    }, { timeout: 15000 });
    return res.data?.data?.deposit ?? null;
  } catch (err) {
    throw new Error(describeDigiflazzError(err));
  }
}

// Price list Digiflazz bisa berisi ribuan baris & endpoint-nya ada limitasi pemakaian (lihat dok
// resmi Digiflazz), sedangkan filter bertingkat baru (kategori -> brand -> tipe/negara) di halaman
// admin bisa manggil getPriceList() beberapa kali beruntun tiap admin ganti pilihan. Supaya gak
// nembak API Digiflazz berkali-kali dalam waktu singkat, hasil dicache sebentar di memory (per
// proses server, per cmd). TTL sengaja pendek (bukan di-cache lama-lama) biar produk/harga baru
// dari Digiflazz tetap kelihatan gak lama setelah refresh.
const PRICE_LIST_CACHE_TTL_MS = 3 * 60 * 1000;
const priceListCache = new Map(); // cmd -> { data, expiresAt }

// Ambil price list dari Digiflazz. cmd: 'prepaid' (produk game/pulsa) atau 'pasca' (pascabayar).
export async function getPriceList(cmd = 'prepaid') {
  const cached = priceListCache.get(cmd);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const { username, apiKey } = getCreds();
  const sign = md5(`${username}${apiKey}pricelist`);
  let res;
  try {
    res = await axios.post(`${BASE_URL}/price-list`, {
      cmd,
      username,
      sign
    }, { timeout: 20000 });
  } catch (err) {
    throw new Error(describeDigiflazzError(err));
  }
  const list = res.data?.data;
  const data = Array.isArray(list) ? list : [];
  priceListCache.set(cmd, { data, expiresAt: Date.now() + PRICE_LIST_CACHE_TTL_MS });
  return data;
}

// Cari produk dari price list Digiflazz by keyword (nama produk / brand / sku) dan/atau
// kategori+brand+tipe, dipakai admin buat pilih SKU. Kategori/brand/tipe dipisah (gak digabung
// jadi 1 pencarian random) biar admin gampang nyari -- mis. cuma mau lihat "Games" > "Mobile
// Legends" > "Umum" doang, bukan ke-mix sama brand/kategori lain.
export async function searchPriceList(keyword = '', cmd = 'prepaid', category = '', brand = '', type = '') {
  const list = await getPriceList(cmd);
  const kw = keyword.trim().toLowerCase();
  const cat = category.trim().toLowerCase();
  const brd = brand.trim().toLowerCase();
  const typ = type.trim().toLowerCase();

  return list
    .filter(item => !cat || String(item.category || '').toLowerCase() === cat)
    .filter(item => !brd || String(item.brand || '').toLowerCase() === brd)
    .filter(item => !typ || String(item.type || '').toLowerCase() === typ)
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

// Daftar brand/judul unik (mis. "MOBILE LEGENDS", "FREE FIRE", "TELKOMSEL") dalam 1 kategori,
// buat level filter ke-2 di halaman Kelola Digiflazz (Kategori -> Brand/Judul -> Tipe).
export async function getPriceListBrands(cmd = 'prepaid', category = '') {
  const list = await getPriceList(cmd);
  const cat = category.trim().toLowerCase();
  const set = new Set(
    list
      .filter(item => !cat || String(item.category || '').toLowerCase() === cat)
      .map(item => item.brand)
      .filter(Boolean)
  );
  return Array.from(set).sort();
}

// Field "type" bawaan Digiflazz dipakai buat 2 hal yang beda maknanya tapi ditaruh campur di 1
// field yang sama: mode produk (mis. "Umum", "Membership") DAN region/negara buat top up yang
// server-nya kepisah per negara (mis. "Malaysia", "Filipina", "Global"). Digiflazz sendiri gak
// nyediain flag "ini mode / ini negara", jadi dipisah pakai heuristik kata kunci: kalau nama
// tipe-nya kandung salah satu kata umum non-negara (umum/reguler/member) dianggap "mode", sisanya
// dianggap "negara/lainnya". Bukan daftar negara hardcode -- sengaja begitu biar tetap jalan buat
// game apa pun tanpa perlu di-update manual tiap ada game baru dgn negara baru.
const NON_REGION_TYPE_KEYWORDS = ['umum', 'reguler', 'regular', 'member', 'voucher'];
export function classifyPriceListType(type) {
  const t = String(type || '').trim().toLowerCase();
  if (!t) return 'mode';
  return NON_REGION_TYPE_KEYWORDS.some(kw => t.includes(kw)) ? 'mode' : 'region';
}

// Daftar tipe unik dalam 1 kategori+brand, sudah dipisah jadi 2 grup buat filter level ke-3:
// - modes: "Umum", "Membership", dst
// - regions: nama negara/region kayak "Malaysia", "Indonesia", "Global", dst
// Kalau brand cuma punya <=1 tipe total (kebanyakan Pulsa/Data/PLN cuma "Umum" doang), dropdown
// tipe ini gak perlu ditampilkan sama sekali di UI -- biar gak makan tempat buat pilihan yg gak ada gunanya.
export async function getPriceListTypes(cmd = 'prepaid', category = '', brand = '') {
  const list = await getPriceList(cmd);
  const cat = category.trim().toLowerCase();
  const brd = brand.trim().toLowerCase();
  const set = new Set(
    list
      .filter(item => !cat || String(item.category || '').toLowerCase() === cat)
      .filter(item => !brd || String(item.brand || '').toLowerCase() === brd)
      .map(item => item.type)
      .filter(Boolean)
  );
  const modes = [];
  const regions = [];
  Array.from(set).sort().forEach(t => (classifyPriceListType(t) === 'mode' ? modes : regions).push(t));
  return { modes, regions };
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

  let res;
  try {
    res = await axios.post(`${BASE_URL}/transaction`, payload, { timeout: 30000 });
  } catch (err) {
    // Ini sumber laporan bug "Gagal menghubungi sistem top up: Request failed with status code
    // 400" -- sebelum ini cuma err.message axios yang dipakai (generik, gak kebaca alasannya sama
    // sekali). Sekarang alasan ASLI dari Digiflazz (mis. "Invalid Payload", "Signature Anda Salah",
    // SKU tidak ditemukan, IP belum kedaftar) ikut ditampilkan -- lihat describeDigiflazzError di atas.
    throw new Error(describeDigiflazzError(err));
  }
  const data = res.data?.data;
  if (!data) throw new Error('Respons Digiflazz tidak valid');
  return data; // { ref_id, customer_no, buyer_sku_code, message, status, rc, sn, price, buyer_last_saldo, ... }
}

// Cek ulang status transaksi yang masih Pending. Digiflazz: kirim ulang payload transaksi yang sama
// (ref_id sama) akan mengembalikan status terkini tanpa memotong saldo dua kali.
export async function checkTransactionStatus({ buyerSkuCode, customerNo, refId }) {
  return createTransaction({ buyerSkuCode, customerNo, refId, testing: false });
}

// Dipakai bareng dari 2 jalur: (1) checkPendingDigiflazzOrders() polling di bawah, dan (2) webhook
// Digiflazz real-time (routes/webhook.js). SAMA ALASANNYA kayak markDepositPaid/markOrderQrisPaid
// di lib/deposit.js & lib/orderQris.js -- satu logic aja buat nentuin apa yang terjadi ke order
// begitu tau hasil akhirnya (Sukses/Gagal), gak peduli ketauannya dari polling atau webhook.
//
// SELALU BACA ULANG status order LANGSUNG SEBELUM bertindak (bukan percaya order yang sudah
// di-fetch sebelumnya) -- biar aman kalau webhook & polling kebetulan nyampe bareng buat order yang
// sama: yang nyampe duluan menang, yang belakangan lihat status udah bukan 'processing' lagi &
// otomatis berhenti (gak dobel refund / dobel notif / dobel tandain sukses).
async function resolveDigiflazzOrder(orderId, result) {
  const { getAllOrders, updateOrderStatus } = await import('./orders.js');
  const { addSaldo, findUserById } = await import('./users.js');
  const { notifyOrder } = await import('./telegram.js');
  const { reverseFlashSaleSale } = await import('./flashsale.js');
  const { creditReferralCommission } = await import('./referrals.js');

  const order = getAllOrders().find(o => o.id === orderId);
  if (!order || order.status !== 'processing') return null; // udah diproses jalur lain / bukan order valid

  const status = String(result.status || '').toLowerCase();
  if (status === 'sukses') {
    updateOrderStatus(order.id, 'completed', result.sn || result.message || 'Top up berhasil');
    // Komisi referral BARU dikreditkan DI SINI (bukan pas checkout tadi) -- order Digiflazz masih
    // 'processing' pas checkout (baru beneran 'completed' belakangan lewat webhook/polling ini).
    // Kalau dikreditkan pas checkout kayak dulu, order yang ternyata GAGAL di sisi Digiflazz
    // (lihat cabang 'gagal' di bawah, saldo di-refund ke buyer) tetap bikin referrer kepotong
    // komisi dari transaksi yang sebenarnya gak jadi -- gak bisa "ditarik balik" lagi karena
    // saldo referrer udah kepakai/ditarik. Kreditkan cuma pas beneran 'completed' = gak akan
    // pernah ada komisi buat transaksi yang gagal.
    const buyer = findUserById(order.userId);
    if (buyer) creditReferralCommission({ buyer, orderTotal: order.total, orderId: order.id });
    notifyOrder({
      username: order.username,
      productName: order.productName,
      total: order.total,
      orderId: order.id,
      source: 'digiflazz',
      needsManual: false,
      targetText: order.targetText,
      orderStatus: 'completed'
    }).catch(() => {});
    return 'completed';
  }
  if (status === 'gagal') {
    // Refund saldo user karena transaksi gagal di sisi Digiflazz
    addSaldo(order.userId, order.total, {
      reason: `Refund top up gagal: ${order.productName}`,
      refType: 'order',
      refId: order.id
    });
    updateOrderStatus(order.id, 'cancelled', result.message || 'Top up gagal, saldo dikembalikan');
    // Lihat catatan lengkap soal ini di versi lama fungsi ini (sebelum di-refactor) -- angka
    // "Terjual" dihitung live dari order.status jadi otomatis benar begitu status di atas jadi
    // 'cancelled', tapi soldCount Flash Sale MASIH counter manual jadi tetap perlu dibalikin manual.
    if (order.usedFlashPrice) reverseFlashSaleSale(order.productId, order.qty);
    return 'cancelled';
  }
  return 'pending'; // masih pending di sisi Digiflazz, gak ada yang perlu dilakukan
}

// Dipakai route webhook Digiflazz (routes/webhook.js). Payload webhook Digiflazz punya BENTUK
// DATA PERSIS SAMA kayak response createTransaction/checkTransactionStatus di atas (ref_id, status,
// sn, message, dst -- lihat dok resmi developer.digiflazz.com/api/buyer/webhook), jadi tinggal
// dioper ke resolveDigiflazzOrder yang sama, gak butuh logic konversi apa pun. Berlaku buat event
// X-Digiflazz-Event "create" MAUPUN "update" -- keduanya diproses dengan cara yang sama (idempotent
// lewat pengecekan status 'processing' di resolveDigiflazzOrder), jadi gak perlu dibedain di sini.
export async function processDigiflazzWebhook(payload) {
  const data = payload && payload.data;
  if (!data || !data.ref_id) {
    return { matched: false, reason: 'Payload tidak lengkap (tidak ada data.ref_id)' };
  }

  const { getAllOrders } = await import('./orders.js');
  const order = getAllOrders().find(o => o.provider === 'digiflazz' && o.providerRefId === String(data.ref_id));
  if (!order) {
    return { matched: false, reason: `Tidak ada order dengan ref_id ${data.ref_id}` };
  }

  const outcome = await resolveDigiflazzOrder(order.id, data);
  if (outcome === null) {
    return { matched: false, reason: 'Order sudah tidak berstatus processing (keburu diproses jalur lain, atau event duplikat)' };
  }
  return { matched: true, orderId: order.id, outcome };
}

// Validasi X-Hub-Signature sesuai dok resmi Digiflazz: HMAC-SHA1 dari RAW body pakai secret yang
// dikonfigurasi di dashboard Digiflazz (Atur Koneksi > API > Webhook) sebagai key, dibandingkan ke
// header "sha1=<hex>". WAJIB pakai raw body (bukan JSON yang sudah di-parse-ulang-stringify), karena
// urutan key/whitespace bisa beda dan bikin HMAC-nya gak pernah cocok walau secret-nya benar.
//
// timingSafeEqual dipakai di sini (beda dari perbandingan secret key biasa di bagian lain aplikasi)
// karena ini SPESIFIK perbandingan HMAC signature -- kasus baku yang timing attack-nya well-known.
export function verifyDigiflazzSignature(rawBody, signatureHeader, secret) {
  if (!secret || !signatureHeader) return false;
  const expected = 'sha1=' + crypto.createHmac('sha1', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signatureHeader));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Dipanggil berkala oleh interval global di server.js buat reconcile order Digiflazz yang statusnya
// masih "Pending" di sisi Digiflazz saat pertama kali order dibuat (butuh dicek ulang sampai Sukses/Gagal).
export async function checkPendingDigiflazzOrders() {
  if (!isDigiflazzEnabled()) return;

  // Import lazy di sini biar tidak circular-import (orders.js/users.js/telegram.js gak butuh digiflazz.js).
  const { getAllOrders } = await import('./orders.js');
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
      await resolveDigiflazzOrder(order.id, result);
    } catch (err) {
      console.error('[digiflazz] Gagal cek status order', order.id, err.message);
    }
  }
}

// State in-memory buat nampilin info "kapan terakhir auto-sync harga jalan" di halaman admin
// (lihat getLastAutoSyncInfo() di bawah). SENGAJA cuma in-memory (ke-reset kalau proses
// restart/deploy ulang), bukan disimpan ke data/config.json -- ini cuma info sekilas buat admin
// pantau, bukan data penting yang wajib awet lintas restart.
let lastAutoSync = null; // { at: ISOString, updated, notFound, total, error }

// Sinkron ulang SEMUA harga produk Digiflazz dari price list Digiflazz terbaru: 1x fetch price
// list, dicocokkan per SKU produk yang sudah diimport, harga jual dihitung ulang pakai margin
// masing-masing produk (atau margin default global kalau produk itu gak punya override). SATU
// logic ini dipakai bareng oleh 2 jalur: (1) tombol "Sinkron Semua Harga" di halaman admin
// (routes/admin.js POST /digiflazz/sync-all), dan (2) job otomatis di bawah
// (autoSyncDigiflazzPrices) yang jalan sendiri tiap 30 menit lewat interval global di server.js --
// diekstrak jadi 1 fungsi biar hasilnya SELALU konsisten antara sinkron manual & otomatis, gak
// ada 2 implementasi kepisah yang diam-diam bisa beda perilaku kalau salah satu diubah belakangan
// tapi yang satunya lupa diikutin.
export async function syncAllDigiflazzPrices() {
  // Import lazy di sini biar tidak circular-import -- konsisten sama pola lazy-import fungsi lain
  // di file ini (lihat resolveDigiflazzOrder & checkPendingDigiflazzOrders di atas), walau
  // products.js sendiri sebenarnya gak butuh apa pun dari digiflazz.js.
  const { getAllProducts, updateProductPrices } = await import('./products.js');

  const list = await getPriceList('prepaid');
  const priceMap = new Map(list.map(item => [item.buyer_sku_code, item.price]));
  const products = getAllProducts().filter(p => p.provider === 'digiflazz');
  const updates = [];
  let notFound = 0;
  products.forEach(p => {
    const basePrice = priceMap.get(p.digiflazzSku);
    if (basePrice === undefined) { notFound++; return; }
    const sellPrice = computeSellPrice(basePrice, p.marginType || null, p.marginValue);
    updates.push({ id: p.id, digiflazzBasePrice: basePrice, price: sellPrice });
  });
  // 1x baca + 1x tulis file buat SEMUA produk sekaligus (lihat komentar lengkap di
  // updateProductPrices, lib/products.js) -- bukan updateProduct() per-produk di dalam loop yang
  // N kali baca+tulis file yang sama secara blocking, biar auto-sync tiap 30 menit gak bikin
  // server lag walau produk Digiflazz-nya ratusan/ribuan.
  const updated = updateProductPrices(updates);
  return { updated, notFound, total: products.length };
}

// Dipanggil berkala oleh interval global di server.js (tiap 30 menit) buat auto-sinkron HARGA
// semua produk Digiflazz -- beda dari checkPendingDigiflazzOrders() di atas (itu ngecek STATUS
// order yang masih pending, bukan harga produk). Tujuannya: kalau Digiflazz update harga modal di
// tengah hari, harga jual di toko otomatis ikut ke-update dalam waktu maksimal 30 menit, admin
// gak perlu inget klik "Sinkron Semua Harga" manual tiap saat. Skip sendiri (gak ngapa-ngapain,
// gak nge-log error) kalau Digiflazz belum aktif/lengkap dikonfigurasi.
export async function autoSyncDigiflazzPrices() {
  if (!isDigiflazzEnabled()) return;
  try {
    const { updated, notFound, total } = await syncAllDigiflazzPrices();
    lastAutoSync = { at: new Date().toISOString(), updated, notFound, total, error: null };
    if (total > 0) {
      console.log(`[digiflazz] Auto-sync harga (tiap 30 menit): ${updated}/${total} produk disinkron${notFound > 0 ? `, ${notFound} SKU tidak ditemukan di price list` : ''}.`);
    }
  } catch (err) {
    lastAutoSync = { at: new Date().toISOString(), updated: 0, notFound: 0, total: 0, error: err.message };
    console.error('[digiflazz] Auto-sync harga gagal:', err.message);
  }
}

// Info "kapan terakhir auto-sync jalan & hasilnya" buat ditampilkan di halaman admin
// (views/admin/digiflazz.ejs) -- null kalau belum pernah jalan sama sekali sejak proses ini start
// (mis. baru habis restart, belum genap 30 menit).
export function getLastAutoSyncInfo() {
  return lastAutoSync;
}
