import express from 'express';
import { requireApiKey } from '../middleware/auth.js';
import { findUserById, deductSaldo, addSaldo } from '../lib/users.js';
import { getActiveProducts, findProductById, countStock } from '../lib/products.js';
import { getOrdersByUser, findOrderById, findOrdersByApiRefId, createOrder, patchOrder } from '../lib/orders.js';
import { createDeposit, getDeposit, getDepositsByUser } from '../lib/deposit.js';
import { creditReferralCommission } from '../lib/referrals.js';
import {
  isHerosmsEnabled, getNumber as getHerosmsNumber, getActivationStatus, finishActivation, cancelActivation
} from '../lib/herosms.js';
import {
  MAX_DIGIFLAZZ_QTY_PER_ORDER, validateQty, computeOrderTotal, formatTargetText,
  getMissingTargetFields, getPlatinumPrice, fulfillAndRecordOrders, summarizeOrders
} from '../lib/orderEngine.js';

// =====================================================================
// API RESELLER (routes/api.js) -- "sistem transaksi via API".
//
// Beda dari checkout web biasa (routes/user.js /order dkk): di sini autentikasi pakai API key
// (bukan session login cookie), dan harga SEMUA transaksi lewat sini SELALU dihitung pakai tier
// Platinum (lib/orderEngine.js getPlatinumPrice) -- gak peduli membership ASLI user pemilik API
// key itu apa. Flash sale tetap menang di atas harga Platinum kalau sedang aktif, sama seperti
// aturan harga di web (lihat getPlatinumPrice).
//
// Semua endpoint di sini balikin JSON dengan bentuk konsisten:
//   sukses -> { success: true, data: ..., message?: '...' }
//   gagal  -> { success: false, message: '...' }
// =====================================================================

const router = express.Router();

// Nama provider ASLI (digiflazz/indosmm) TIDAK PERNAH dikirim ke luar lewat API ini -- diganti
// label generik yang cocok sama nama endpoint order-nya (/order/topup, /order/smm, /order/manual).
// Ini nerusin kebijakan yang sama kayak di tampilan web (lihat lib/orderEngine.js & smm-rules-modal.ejs):
// nama supplier sengaja disembunyikan dari customer/reseller, supaya gak gampang "dilewatin"
// langsung ke supplier aslinya.
function publicProviderLabel(provider) {
  if (provider === 'digiflazz') return 'topup';
  if (provider === 'indosmm') return 'smm';
  if (provider === 'otp') return 'otp';
  return 'manual';
}

function formatOrdersForApi(orders) {
  return orders.map(o => ({
    order_id: o.id,
    product_id: o.productId,
    product_name: o.productName,
    qty: o.qty,
    price: o.price,
    total: o.total,
    status: o.status, // processing | completed | cancelled
    detail: o.detail, // isi kode voucher / SN / hasil produk (cuma keisi kalau status completed)
    note: o.note,
    target: o.targetText,
    created_at: o.createdAt,
    updated_at: o.updatedAt
  }));
}

// Dipakai bareng oleh /pricelist (ringkas) & /product/:id (lengkap, termasuk description/thumbnail/
// usageInstructions yang gak perlu ikut kekirim di list ratusan produk sekaligus).
function formatProductForApi(p, { full = false } = {}) {
  const base = {
    product_id: p.id,
    name: p.name,
    category: p.category || '',
    group: p.variantGroup || '',
    provider: publicProviderLabel(p.provider), // topup | smm | manual | otp -- lihat catatan publicProviderLabel di atas
    price: getPlatinumPrice(p),
    stock: p.provider === 'manual' ? countStock(p) : null, // null = otomatis/gak terbatas stok fisik
    qty_min: p.provider === 'indosmm' ? (Number(p.indosmmMin) || 1) : 1,
    qty_max: p.provider === 'indosmm' ? (Number(p.indosmmMax) || null)
      : (p.provider === 'digiflazz' ? MAX_DIGIFLAZZ_QTY_PER_ORDER : null),
    target_fields: (p.targetFields || []).map(f => ({ key: f.key, label: f.label, required: !!f.required })),
    otp_service: p.provider === 'otp' ? (p.otpServiceName || '') : undefined,
    otp_country: p.provider === 'otp' ? (p.otpCountryName || '') : undefined
  };
  if (!full) return base;
  return {
    ...base,
    description: p.description || '',
    thumbnail: p.thumbnail || '',
    usage_instructions: p.usageInstructions || '' // cuma relevan buat provider manual
  };
}

function formatDepositForApi(d) {
  return {
    trxid: d.trxid,
    amount: d.amount,
    fee: d.fee,
    kode_unik: d.kodeUnik,
    total: d.total,
    status: d.status, // pending | paid | expired | cancelled
    created_at: d.createdAt,
    expired_at: d.expiredAt,
    paid_at: d.paidAt || null
  };
}

router.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Nextorder Reseller API v1',
    docs: {
      full_docs: `${req.protocol}://${req.get('host')}/dokumentasi-api`,
      auth: 'Kirim API key lewat header "X-API-Key" (dapatkan/generate dari halaman Profil setelah login).',
      pricing: 'Semua harga di API ini otomatis harga tier Platinum, terlepas dari membership akun kamu.',
      endpoints: [
        'GET  /api/v1/profile',
        'GET  /api/v1/saldo',
        'GET  /api/v1/pricelist',
        'GET  /api/v1/product/:id',
        'POST /api/v1/order/topup  { product_id, qty?, target?, ref_id? }  -- produk Top Up Game/Pulsa',
        'POST /api/v1/order/smm    { product_id, qty?, target?, ref_id? }  -- produk Jasa Sosmed',
        'POST /api/v1/order/manual { product_id, qty?, target?, ref_id? }  -- produk stok manual',
        'POST /api/v1/order/otp    { product_id, ref_id? }                 -- sewa nomor OTP',
        'POST /api/v1/order/otp/:id/cancel                                 -- batalkan sewa OTP & refund',
        'GET  /api/v1/order/:id',
        'GET  /api/v1/order?limit=20',
        'POST /api/v1/deposit      { amount }',
        'GET  /api/v1/deposit/:trxid',
        'GET  /api/v1/deposit?limit=20'
      ]
    }
  });
});

// ---------- Profil & saldo akun pemilik API key ----------
router.get('/profile', requireApiKey('transaction'), (req, res) => {
  const u = req.apiUser;
  res.json({
    success: true,
    data: {
      username: u.username,
      email: u.email || '',
      saldo: u.saldo || 0,
      membership: u.membership || 'reguler'
    }
  });
});

// ---------- Cek saldo cepat (ambil ulang data TERBARU, gak dari cache req.apiUser awal) ----------
router.get('/saldo', requireApiKey('transaction'), (req, res) => {
  const u = findUserById(req.apiUser.id);
  res.json({ success: true, data: { saldo: u ? (u.saldo || 0) : 0 } });
});

// ---------- Daftar harga (ringkas, SELALU harga Platinum, lihat catatan di atas) ----------
router.get('/pricelist', requireApiKey('transaction'), (req, res) => {
  const data = getActiveProducts().map(p => formatProductForApi(p, { full: false }));
  res.json({ success: true, data });
});

// ---------- Detail 1 produk (lengkap: nama, harga, deskripsi, thumbnail, cara pakai, dll) ----------
router.get('/product/:id', requireApiKey('transaction'), (req, res) => {
  const product = findProductById(req.params.id);
  if (!product || product.status !== 'active') {
    return res.status(404).json({ success: false, message: 'Produk tidak ditemukan / tidak aktif' });
  }
  res.json({ success: true, data: formatProductForApi(product, { full: true }) });
});

// ---------- Riwayat order milik pemilik API key ----------
router.get('/order', requireApiKey('transaction'), (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const orders = getOrdersByUser(req.apiUser.id).slice(0, limit);
  res.json({ success: true, data: formatOrdersForApi(orders) });
});

// ---------- Cek status 1 order ----------
router.get('/order/:id', requireApiKey('transaction'), async (req, res) => {
  const order = findOrderById(req.params.id);
  if (!order || order.userId !== req.apiUser.id) {
    return res.status(404).json({ success: false, message: 'Order tidak ditemukan' });
  }
  // Order OTP yang masih "processing" dicek LIVE ke HeroSMS di sini -- beda dari order lain
  // (topup/smm/manual) yang statusnya sudah final begitu fulfillAndRecordOrders() selesai. OTP
  // butuh dicek ulang tiap kali di-poll karena kodenya bisa masuk kapan saja.
  let current = order;
  if (order.provider === 'otp' && order.status === 'processing') {
    try {
      const result = await getActivationStatus(order.providerRefId);
      if (result.state === 'code' || result.state === 'waiting_retry') {
        current = patchOrder(order.id, { status: 'completed', detail: result.code, note: 'Kode OTP diterima' });
        // Komisi referral juga berlaku buat produk OTP -- lihat catatan lengkap di routes/user.js
        // GET /otp/status/:id/check (bug yang sama, dua jalur beda buat cek status yang sama).
        const otpBuyer = findUserById(order.userId);
        if (otpBuyer) creditReferralCommission({ buyer: otpBuyer, orderTotal: order.total, orderId: order.id });
        finishActivation(order.providerRefId).catch(() => {});
      } else if (result.state === 'cancelled') {
        current = patchOrder(order.id, { status: 'cancelled', note: 'Aktivasi dibatalkan oleh provider' });
      }
    } catch (_) { /* biarin status apa adanya kalau lagi gagal cek ke provider */ }
  }
  res.json({ success: true, data: formatOrdersForApi([current])[0] });
});

// ---------- OTP: sewa nomor virtual terima SMS ----------
// Beda dari /order/topup|smm|manual (lewat processOrderRequest generik) -- order OTP siklusnya
// "beli -> dapat nomor -> tunggu kode (poll GET /order/:id) -> selesai/batal", jadi butuh endpoint
// sendiri. target/qty TIDAK dipakai di sini (1 request = 1 nomor).
router.post('/order/otp', requireApiKey('transaction'), async (req, res) => {
  try {
    const body = req.body || {};
    const productId = body.product_id;
    const refId = body.ref_id ? String(body.ref_id).trim().slice(0, 100) : '';
    if (!productId) return res.status(400).json({ success: false, message: 'product_id wajib diisi' });

    if (refId) {
      const existing = findOrdersByApiRefId(req.apiUser.id, refId);
      if (existing.length > 0) {
        return res.json({
          success: true,
          message: 'ref_id ini sudah pernah diproses sebelumnya, hasil sebelumnya dikembalikan (idempotent).',
          data: formatOrdersForApi(existing)
        });
      }
    }

    const product = findProductById(productId);
    if (!product || product.provider !== 'otp' || product.status !== 'active') {
      return res.status(404).json({ success: false, message: 'Produk OTP tidak ditemukan / tidak aktif' });
    }
    if (!isHerosmsEnabled()) {
      return res.status(400).json({ success: false, message: 'Layanan OTP sedang tidak aktif' });
    }

    const user = findUserById(req.apiUser.id);
    if (user.saldo < product.price) {
      return res.status(402).json({ success: false, message: 'Saldo tidak cukup', data: { saldo: user.saldo, required: product.price } });
    }

    // Minta nomor DULU, baru potong saldo kalau berhasil -- sama seperti alur web (routes/user.js).
    let activationId, phoneNumber;
    try {
      ({ activationId, phoneNumber } = await getHerosmsNumber({ serviceCode: product.otpServiceCode, countryId: product.otpCountryId }));
    } catch (err) {
      return res.status(400).json({ success: false, message: err.message });
    }

    deductSaldo(user.id, product.price, { reason: `Sewa nomor OTP: ${product.name} (API)`, refType: 'order' });

    const order = createOrder({
      userId: user.id, username: user.username, productId: product.id, productName: product.name,
      price: product.price, qty: 1, total: product.price, source: 'api',
      status: 'processing', deliveryMode: 'auto', manualRequired: false, targetText: '',
      detail: '', note: 'Menunggu SMS masuk', provider: 'otp',
      providerRefId: activationId, providerCustomerNo: phoneNumber, costPrice: 0, apiRefId: refId
    });

    res.json({
      success: true,
      message: 'Nomor berhasil didapat, tunggu SMS masuk lalu poll GET /order/:id untuk kodenya.',
      data: formatOrdersForApi([order])
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Batalkan sewa nomor OTP (HANYA bisa selama kode belum masuk) -- refund penuh kalau berhasil.
router.post('/order/otp/:id/cancel', requireApiKey('transaction'), async (req, res) => {
  const order = findOrderById(req.params.id);
  if (!order || order.userId !== req.apiUser.id || order.provider !== 'otp') {
    return res.status(404).json({ success: false, message: 'Order OTP tidak ditemukan' });
  }
  if (order.status !== 'processing') {
    return res.status(400).json({ success: false, message: `Order ini sudah berstatus "${order.status}", tidak bisa dibatalkan lagi` });
  }
  try {
    await cancelActivation(order.providerRefId);
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message });
  }
  const updated = patchOrder(order.id, { status: 'cancelled', note: 'Dibatalkan oleh reseller via API, saldo dikembalikan' });
  addSaldo(order.userId, order.total, { reason: `Refund pembatalan OTP (API): ${order.productName}`, refType: 'order', refId: order.id });
  res.json({ success: true, message: 'Order dibatalkan, saldo dikembalikan.', data: formatOrdersForApi([updated])[0] });
});

// ---------- Bikin transaksi baru ----------
// Endpoint order DIPISAH per jenis produk (bukan 1 endpoint gabungan) karena bentuk `target` dan
// arti `qty` beda jauh antar provider -- misahin endpoint-nya sekalian nyegah integrator kirim
// payload jenis yang salah ke jenis produk yang salah (mis. ngirim {link:...} ke produk Top Up
// Game). Ketiganya berbagi logic yang SAMA (processOrderRequest) supaya konsisten, cuma beda
// validasi provider + pesan errornya.
//
// Body JSON (sama buat ketiganya): { product_id, qty? (default 1), target? (objek, isinya
// beda-beda tergantung endpoint, lihat dokumentasi tiap endpoint), ref_id? (buat idempotency,
// SANGAT disarankan diisi -- lihat penjelasan di bawah) }
async function processOrderRequest(req, res, { expectedProvider, label }) {
  try {
    const body = req.body || {};
    const productId = body.product_id;
    const qty = Math.max(1, parseInt(body.qty) || 1);
    const targetData = (body.target && typeof body.target === 'object') ? body.target : {};
    // ref_id: ID request dari sisi reseller sendiri (opsional, TAPI SANGAT disarankan diisi).
    // Kalau reseller nge-retry request yang sama persis (mis. request pertama sukses diproses
    // tapi responsenya gak sempat diterima reseller karena timeout), request kedua dengan
    // ref_id yang SAMA gak akan bikin order/potongan saldo baru lagi -- cukup dibalikin hasil
    // yang sama kayak request pertama. Tanpa ref_id, retry di sisi reseller bisa bikin
    // pesanan & potongan saldo DOBEL.
    const refId = body.ref_id ? String(body.ref_id).trim().slice(0, 100) : '';

    if (!productId) {
      return res.status(400).json({ success: false, message: 'product_id wajib diisi' });
    }

    if (refId) {
      const existing = findOrdersByApiRefId(req.apiUser.id, refId);
      if (existing.length > 0) {
        return res.json({
          success: true,
          message: 'ref_id ini sudah pernah diproses sebelumnya, hasil sebelumnya dikembalikan (idempotent).',
          data: formatOrdersForApi(existing)
        });
      }
    }

    const product = findProductById(productId);
    if (!product || product.status !== 'active') {
      return res.status(404).json({ success: false, message: 'Produk tidak ditemukan / tidak aktif' });
    }

    if (product.provider !== expectedProvider) {
      return res.status(400).json({
        success: false,
        message: `Produk ini bukan produk ${label}. Cek field "provider" di /pricelist buat tahu jenis produknya, lalu pakai endpoint yang sesuai: /order/topup, /order/smm, atau /order/manual.`
      });
    }

    const qtyError = validateQty(product, qty);
    if (qtyError) return res.status(400).json({ success: false, message: qtyError });

    const missing = getMissingTargetFields(product, targetData);
    if (missing.length > 0) {
      return res.status(400).json({ success: false, message: `Lengkapi dulu: ${missing.join(', ')}` });
    }
    const targetText = formatTargetText(product, targetData);

    const unitPrice = getPlatinumPrice(product);
    const total = computeOrderTotal(product, unitPrice, qty);

    // Ambil ulang data user PALING BARU (bukan req.apiUser yang diambil pas awal request) --
    // saldo bisa aja sudah berubah kalau ada request/transaksi lain yang lagi jalan bersamaan.
    const user = findUserById(req.apiUser.id);
    if (user.saldo < total) {
      return res.status(402).json({
        success: false,
        message: 'Saldo tidak cukup',
        data: { saldo: user.saldo, required: total }
      });
    }

    deductSaldo(user.id, total, {
      reason: `Pembelian ${product.name}${qty > 1 ? ` (${qty}x)` : ''} (API)`,
      refType: 'order'
    });

    const orders = await fulfillAndRecordOrders({
      user, product, qty, targetData, targetText,
      notifySource: 'api',
      paidNote: 'Dibayar via API (saldo)',
      unitPriceOverride: unitPrice,
      sourceOverride: 'api',
      apiRefId: refId,
      paymentMethod: 'Saldo (API Reseller, Lunas)'
    });

    // Komisi referral juga berlaku buat order lewat API reseller (bukan cuma checkout web biasa)
    // -- "setiap transaksi sukses" itu APAPUN jalurnya, gak dibatasin cuma yang lewat web. Dihitung
    // dari order yang udah PASTI 'completed' di titik ini aja -- yang masih 'processing' baru
    // dikreditkan belakangan pas beneran selesai, lihat catatan lengkap di routes/user.js.
    const netSuccessTotal = orders.filter(o => o.status === 'completed').reduce((sum, o) => sum + o.total, 0);
    if (netSuccessTotal > 0) {
      creditReferralCommission({ buyer: user, orderTotal: netSuccessTotal, orderId: orders[0].id });
    }

    const defaultMsg = orders.length === 1
      ? (orders[0].status === 'completed'
        ? 'Order berhasil, produk sudah dikirim.'
        : orders[0].status === 'cancelled'
          ? orders[0].note + ', saldo sudah dikembalikan'
          : 'Order diterima, sedang diproses otomatis.')
      : null;

    res.json({
      success: true,
      message: summarizeOrders(orders) || defaultMsg,
      data: formatOrdersForApi(orders)
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
}

// Top Up Game/Pulsa (produk provider "digiflazz"). target = ID tujuan (mis. {user_id, zone_id}).
router.post('/order/topup', requireApiKey('transaction'), (req, res) => processOrderRequest(req, res, {
  expectedProvider: 'digiflazz', label: 'Top Up Game/Pulsa'
}));

// Jasa Sosmed / SMM (produk provider "indosmm"). target = { link }. qty = jumlah asli (mis. 1000 followers).
router.post('/order/smm', requireApiKey('transaction'), (req, res) => processOrderRequest(req, res, {
  expectedProvider: 'indosmm', label: 'Jasa Sosmed'
}));

// Produk stok manual (produk provider "manual"). target biasanya gak dipakai (kosongkan/hilangkan).
router.post('/order/manual', requireApiKey('transaction'), (req, res) => processOrderRequest(req, res, {
  expectedProvider: 'manual', label: 'Manual (Stok)'
}));

// ---------- Deposit / Top Up saldo via API ----------
// Bikin transaksi QRIS baru buat isi saldo. Pembayaran TETAP lewat scan QR (dibayar dari
// e-wallet/m-banking mana aja, sama kayak alur web) -- job checkPendingDeposits() di server.js
// yang jalan di background otomatis nge-cek pembayaran masuk & nambah saldo begitu lunas, JADI
// TIDAK ADA endpoint/webhook terpisah buat "konfirmasi bayar" -- cukup polling GET /deposit/:trxid
// dari sisi reseller sampai status-nya berubah jadi "paid".
router.post('/deposit', requireApiKey('deposit'), async (req, res) => {
  try {
    const amount = parseInt(req.body?.amount);
    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'amount wajib diisi (angka, dalam Rupiah)' });
    }
    const user = findUserById(req.apiUser.id);
    const dep = await createDeposit(user, amount);
    res.json({
      success: true,
      message: 'Scan QR berikut untuk membayar. Saldo otomatis bertambah begitu pembayaran diterima.',
      data: { ...formatDepositForApi(dep), qr_image_base64: dep.imageBase64 }
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// ---------- Cek status 1 deposit (buat polling sampai status jadi "paid") ----------
router.get('/deposit/:trxid', requireApiKey('deposit'), (req, res) => {
  const dep = getDeposit(req.params.trxid);
  if (!dep || dep.userId !== req.apiUser.id) {
    return res.status(404).json({ success: false, message: 'Transaksi deposit tidak ditemukan' });
  }
  res.json({ success: true, data: formatDepositForApi(dep) });
});

// ---------- Riwayat deposit milik pemilik API key ----------
router.get('/deposit', requireApiKey('deposit'), (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const deposits = getDepositsByUser(req.apiUser.id).slice(0, limit);
  res.json({ success: true, data: deposits.map(formatDepositForApi) });
});

export default router;
