import express from 'express';
import { requireApiKey } from '../middleware/auth.js';
import { findUserById, deductSaldo } from '../lib/users.js';
import { getActiveProducts, findProductById, countStock } from '../lib/products.js';
import { getOrdersByUser, findOrderById, findOrdersByApiRefId } from '../lib/orders.js';
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

router.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Nextorder Reseller API v1',
    docs: {
      auth: 'Kirim API key lewat header "X-API-Key" (dapatkan/generate dari halaman Profil setelah login).',
      pricing: 'Semua harga di API ini otomatis harga tier Platinum, terlepas dari membership akun kamu.',
      endpoints: [
        'GET  /api/v1/profile',
        'GET  /api/v1/pricelist',
        'POST /api/v1/order        { product_id, qty?, target?, ref_id? }',
        'GET  /api/v1/order/:id',
        'GET  /api/v1/order?limit=20'
      ]
    }
  });
});

// ---------- Profil & saldo akun pemilik API key ----------
router.get('/profile', requireApiKey, (req, res) => {
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

// ---------- Daftar harga (SELALU harga Platinum, lihat catatan di atas) ----------
router.get('/pricelist', requireApiKey, (req, res) => {
  const products = getActiveProducts();
  const data = products.map(p => ({
    product_id: p.id,
    name: p.name,
    category: p.category || '',
    group: p.variantGroup || '',
    provider: p.provider, // manual | digiflazz | indosmm
    price: getPlatinumPrice(p),
    stock: p.provider === 'manual' ? countStock(p) : null, // null = otomatis/gak terbatas stok fisik
    qty_min: p.provider === 'indosmm' ? (Number(p.indosmmMin) || 1) : 1,
    qty_max: p.provider === 'indosmm' ? (Number(p.indosmmMax) || null)
      : (p.provider === 'digiflazz' ? MAX_DIGIFLAZZ_QTY_PER_ORDER : null),
    target_fields: (p.targetFields || []).map(f => ({ key: f.key, label: f.label, required: !!f.required }))
  }));
  res.json({ success: true, data });
});

// ---------- Riwayat order milik pemilik API key ----------
router.get('/order', requireApiKey, (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const orders = getOrdersByUser(req.apiUser.id).slice(0, limit);
  res.json({ success: true, data: formatOrdersForApi(orders) });
});

// ---------- Cek status 1 order ----------
router.get('/order/:id', requireApiKey, (req, res) => {
  const order = findOrderById(req.params.id);
  if (!order || order.userId !== req.apiUser.id) {
    return res.status(404).json({ success: false, message: 'Order tidak ditemukan' });
  }
  res.json({ success: true, data: formatOrdersForApi([order])[0] });
});

// ---------- Bikin transaksi baru ----------
// Body JSON: { product_id, qty? (default 1), target? (objek, mis. {zone_id:'123',user_id:'456'}
// atau {link:'https://...'} buat layanan Jasa Sosmed), ref_id? (buat idempotency, lihat bawah) }
router.post('/order', requireApiKey, async (req, res) => {
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
      apiRefId: refId
    });

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
});

export default router;
