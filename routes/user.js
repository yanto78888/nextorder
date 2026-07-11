import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { requireLogin } from '../middleware/auth.js';
import {
  findUserById, updateUser, setPassword, verifyPassword, deductSaldo, addSaldo,
  getMembershipDiscount, upgradeMembership
} from '../lib/users.js';
import { getActiveProducts, findProductById, takeProductStock, countStock, updateProduct } from '../lib/products.js';
import { getOrdersByUser, createOrder, getStats } from '../lib/orders.js';
import { createDeposit, getDeposit, getDepositsByUser, cancelDeposit } from '../lib/deposit.js';
import { notifyOrder } from '../lib/telegram.js';
import { getConfig } from '../lib/config.js';
import { getMembershipList, getMembershipTier, applyMemberDiscount } from '../lib/membership.js';
import { getGameIcon } from '../lib/gamePresets.js';
import { createReview, getReviewsByProduct, hasUserReviewed } from '../lib/reviews.js';
import { isDigiflazzEnabled, buildCustomerNo, createTransaction } from '../lib/digiflazz.js';
import { genId } from '../lib/db.js';

const router = express.Router();

// Ambil isian ID Game / Zone ID / UID dll dari form checkout sesuai targetFields produk (ML, FF, Genshin, dst)
function extractTargetData(product, body) {
  const fields = product.targetFields || [];
  const data = {};
  const missing = [];
  fields.forEach(f => {
    const val = (body['target_' + f.key] || '').toString().trim();
    if (f.required && !val) missing.push(f.label);
    if (val) data[f.key] = val;
  });
  return { data, missing };
}

// Format isian target jadi teks rapi buat disimpan di order & dikirim ke laporan Telegram
function formatTargetText(product, data) {
  const fields = product.targetFields || [];
  return fields
    .filter(f => data[f.key])
    .map(f => {
      let val = data[f.key];
      if (f.type === 'select' && Array.isArray(f.options)) {
        const opt = f.options.find(o => o.value === val);
        if (opt) val = opt.label;
      }
      return `${f.label}: ${val}`;
    })
    .join(' | ');
}

// Kirim produk ke user: stok manual dari sistem, atau auto top up game lewat Digiflazz.
// Dipanggil setelah saldo user dipotong, jadi kalau Digiflazz gagal, saldo yang sudah dipotong di-refund di sini.
async function fulfillOrder(product, qty, targetData, targetText) {
  if (product.provider === 'digiflazz' && isDigiflazzEnabled()) {
    const customerNo = buildCustomerNo(product, targetData);
    if (!customerNo) {
      return {
        status: 'cancelled', deliveryMode: 'auto', manualRequired: false,
        detail: '', note: 'Gagal top up: ID tujuan tidak lengkap',
        provider: 'digiflazz', providerRefId: '', providerCustomerNo: '', refund: true
      };
    }

    const refId = genId('DGFLZ');
    try {
      const result = await createTransaction({
        buyerSkuCode: product.digiflazzSku,
        customerNo,
        refId
      });
      const status = String(result.status || '').toLowerCase();

      if (status === 'sukses') {
        return {
          status: 'completed', deliveryMode: 'auto', manualRequired: false,
          detail: result.sn || result.message || 'Top up berhasil',
          note: 'Top up otomatis via Digiflazz',
          provider: 'digiflazz', providerRefId: refId, providerCustomerNo: customerNo, refund: false
        };
      }
      if (status === 'gagal') {
        return {
          status: 'cancelled', deliveryMode: 'auto', manualRequired: false,
          detail: '', note: 'Top up gagal: ' + (result.message || 'ditolak Digiflazz'),
          provider: 'digiflazz', providerRefId: refId, providerCustomerNo: customerNo, refund: true
        };
      }
      // Pending: masih diproses Digiflazz, dicek ulang otomatis oleh background job
      return {
        status: 'processing', deliveryMode: 'auto', manualRequired: false,
        detail: '', note: 'Sedang diproses Digiflazz, tunggu beberapa saat',
        provider: 'digiflazz', providerRefId: refId, providerCustomerNo: customerNo, refund: false
      };
    } catch (err) {
      return {
        status: 'cancelled', deliveryMode: 'auto', manualRequired: false,
        detail: '', note: 'Gagal hubungi Digiflazz: ' + err.message,
        provider: 'digiflazz', providerRefId: refId, providerCustomerNo: customerNo, refund: true
      };
    }
  }

  // Fallback: stok manual dari sistem (perilaku lama)
  const stockAvailable = countStock(product);
  const takenStock = stockAvailable >= qty ? takeProductStock(product.id, qty) : null;
  const isAutoDelivered = Array.isArray(takenStock) && takenStock.length === qty;
  return {
    status: isAutoDelivered ? 'completed' : 'processing',
    deliveryMode: isAutoDelivered ? 'auto' : 'manual',
    manualRequired: !isAutoDelivered,
    detail: isAutoDelivered ? takenStock.map((item, i) => qty > 1 ? `${i + 1}. ${item.value}` : item.value).join('\n') : '',
    note: isAutoDelivered ? 'Dikirim otomatis dari stok sistem' : 'Stok otomatis habis, menunggu admin kirim manual',
    provider: 'manual', providerRefId: '', providerCustomerNo: '', refund: false
  };
}

// ---------- UPLOAD FOTO PROFIL ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const avatarDir = path.join(__dirname, '..', 'public', 'uploads', 'avatars');
fs.mkdirSync(avatarDir, { recursive: true });

const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, avatarDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const unique = Date.now() + '_' + Math.round(Math.random() * 1e6);
    cb(null, `avatar_${unique}${ext}`);
  }
});
const uploadAvatar = multer({
  storage: avatarStorage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (req, file, cb) => {
    const allowedExt = /\.(jpe?g|png|webp|gif)$/i;
    const allowedMime = /^image\/(jpeg|png|webp|gif)$/i;
    if (!allowedExt.test(file.originalname) || !allowedMime.test(file.mimetype || '')) {
      return cb(new Error('Format foto harus JPG, PNG, WEBP, atau GIF'));
    }
    cb(null, true);
  }
});

// /dashboard lama dipindah ke /produk (home) dan statistiknya digabung ke /profile
router.get('/dashboard', requireLogin, (req, res) => res.redirect('/produk'));

router.get('/profile', requireLogin, (req, res) => {
  const user = findUserById(req.session.user.id);
  const orders = getOrdersByUser(user.id);
  res.render('profile', {
    user, error: req.query.error || null, success: req.query.success || null, config: getConfig(),
    membershipList: getMembershipList(), currentTier: getMembershipTier(user.membership),
    totalOrder: orders.length,
    totalSpent: orders.filter(o => o.status !== 'cancelled').reduce((s, o) => s + o.total, 0),
    recentOrders: orders.slice(0, 5)
  });
});

router.post('/profile', requireLogin, (req, res) => {
  const user = findUserById(req.session.user.id);
  const { email } = req.body;
  updateUser(user.id, { email });
  res.redirect('/profile?success=' + encodeURIComponent('Profil berhasil diperbarui'));
});

// Ganti foto profil (avatar bulat di pojok kanan atas)
router.post('/profile/avatar', requireLogin, (req, res) => {
  uploadAvatar.single('avatarFile')(req, res, (err) => {
    if (err) {
      return res.redirect('/profile?error=' + encodeURIComponent(err.message));
    }
    if (!req.file) {
      return res.redirect('/profile?error=' + encodeURIComponent('Pilih foto terlebih dahulu'));
    }
    const user = findUserById(req.session.user.id);
    updateUser(user.id, { avatar: '/uploads/avatars/' + req.file.filename });
    res.redirect('/profile?success=' + encodeURIComponent('Foto profil berhasil diperbarui'));
  });
});

router.post('/profile/password', requireLogin, (req, res) => {
  const user = findUserById(req.session.user.id);
  const { oldPassword, newPassword, newPassword2 } = req.body;

  if (!verifyPassword(user, oldPassword)) {
    return res.redirect('/profile?error=' + encodeURIComponent('Password lama salah'));
  }
  if (newPassword !== newPassword2) {
    return res.redirect('/profile?error=' + encodeURIComponent('Konfirmasi password baru tidak cocok'));
  }
  if (newPassword.length < 6) {
    return res.redirect('/profile?error=' + encodeURIComponent('Password minimal 6 karakter'));
  }
  setPassword(user.id, newPassword);
  res.redirect('/profile?success=' + encodeURIComponent('Password berhasil diubah'));
});

// Upgrade membership Gold / Platinum, harga dipotong langsung dari saldo
router.post('/membership/upgrade', requireLogin, (req, res) => {
  try {
    const tierKey = req.body.tier;
    const user = findUserById(req.session.user.id);
    const updated = upgradeMembership(user.id, tierKey);
    req.session.user.membership = updated.membership;
    const tier = getMembershipTier(updated.membership);
    res.redirect('/profile?success=' + encodeURIComponent(`Berhasil upgrade ke member ${tier.label}! Diskon ${tier.discountPercent}% berlaku di setiap pembelian.`));
  } catch (err) {
    res.redirect('/profile?error=' + encodeURIComponent(err.message));
  }
});

router.get('/produk', (req, res) => {
  // Beranda bisa dibuka tanpa login (mode tamu). Kalau sudah login, tampilkan saldo & diskon member.
  const user = req.session.user ? findUserById(req.session.user.id) : null;
  const discountPercent = user ? getMembershipDiscount(user) : 0;
  const cfg = getConfig();

  const products = getActiveProducts()
    .map(p => ({
      ...p,
      finalPrice: user ? applyMemberDiscount(p.price, user.membership) : p.price,
      icon: getGameIcon(p.gamePreset)
    }));

  // Kelompokkan produk per kategori ala row katalog Netflix (mis. "Digital" menampilkan semua produk digital)
  const categoryOrder = [];
  const grouped = {};
  products.forEach(p => {
    const cat = p.category || 'Umum';
    if (!grouped[cat]) {
      grouped[cat] = [];
      categoryOrder.push(cat);
    }
    grouped[cat].push(p);
  });
  const rows = categoryOrder.map(cat => ({ category: cat, products: grouped[cat] }));

  res.render('produk', {
    products,
    rows,
    memberDiscount: discountPercent,
    user,
    config: cfg,
    banners: (cfg.banners || []).filter(b => b.image),
    marquee: cfg.marquee || {},
    error: req.query.error || null
  });
});

router.post('/order', requireLogin, async (req, res) => {
  const user = findUserById(req.session.user.id);
  const product = findProductById(req.body.productId);
  const qty = Math.max(1, parseInt(req.body.qty) || 1);

  if (!product || product.status !== 'active') {
    return res.redirect('/produk?error=Produk tidak tersedia');
  }

  const { data: targetData, missing } = extractTargetData(product, req.body);
  if (missing.length > 0) {
    return res.redirect(`/produk/${product.id}?error=` + encodeURIComponent(`Lengkapi dulu: ${missing.join(', ')}`));
  }
  const targetText = formatTargetText(product, targetData);

  const unitPrice = applyMemberDiscount(product.price, user.membership);
  const total = unitPrice * qty;
  if (user.saldo < total) {
    return res.redirect('/produk?error=Saldo tidak cukup, silakan topup');
  }

  deductSaldo(user.id, total);

  const delivery = await fulfillOrder(product, qty, targetData, targetText);
  if (delivery.refund) addSaldo(user.id, total); // refund saldo kalau Digiflazz gagal

  const order = createOrder({
    userId: user.id,
    username: user.username,
    productId: product.id,
    productName: product.name,
    price: unitPrice,
    qty,
    source: 'user',
    status: delivery.status,
    deliveryMode: delivery.deliveryMode,
    manualRequired: delivery.manualRequired,
    targetText,
    detail: delivery.detail,
    note: delivery.note,
    provider: delivery.provider,
    providerRefId: delivery.providerRefId,
    providerCustomerNo: delivery.providerCustomerNo
  });

  notifyOrder({
    username: user.username,
    productName: product.name,
    total: order.total,
    orderId: order.id,
    source: delivery.status === 'completed' ? 'auto' : 'user',
    needsManual: delivery.manualRequired,
    targetText
  }).catch(() => {});

  // Update total terjual di produk (tidak dihitung kalau transaksi Digiflazz gagal & saldo di-refund)
  if (!delivery.refund) {
    updateProduct(product.id, { totalSold: (product.totalSold || 0) + qty });
  }

  if (delivery.refund) {
    return res.redirect('/produk?error=' + encodeURIComponent(delivery.note + ', saldo sudah dikembalikan'));
  }

  const msg = delivery.status === 'completed'
    ? 'Order berhasil, produk sudah dikirim.'
    : delivery.status === 'processing' && delivery.provider === 'digiflazz'
      ? 'Order berhasil, top up sedang diproses otomatis.'
      : 'Order berhasil, stok otomatis sedang habis. Pesanan menunggu admin kirim manual.';
  res.redirect(`/riwayat/${order.id}?success=` + encodeURIComponent(msg));
});

router.get('/riwayat', requireLogin, (req, res) => {
  const orders = getOrdersByUser(req.session.user.id);
  res.render('riwayat', {
    orders,
    config: getConfig(),
    user: findUserById(req.session.user.id),
    success: req.query.success || null
  });
});

// Invoice/struk 1 order, dipakai buat halaman detail setelah order berhasil maupun dilihat dari riwayat
router.get('/riwayat/:id', requireLogin, (req, res) => {
  const order = getOrdersByUser(req.session.user.id).find(o => o.id === req.params.id);
  if (!order) return res.redirect('/riwayat?error=' + encodeURIComponent('Order tidak ditemukan'));
  res.render('invoice', {
    order,
    config: getConfig(),
    user: findUserById(req.session.user.id),
    success: req.query.success || null
  });
});

// Order dengan qty > 3 dikirim dalam bentuk file .txt biar gak numpuk di halaman
router.get('/riwayat/:id/download', requireLogin, (req, res) => {
  const order = getOrdersByUser(req.session.user.id).find(o => o.id === req.params.id);
  if (!order || !order.detail) return res.status(404).send('Detail order tidak ditemukan');
  const filename = `${order.productName.replace(/[^a-z0-9]+/gi, '-')}-${order.id}.txt`;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(order.detail);
});

router.get('/topup', requireLogin, (req, res) => {
  const deposits = getDepositsByUser(req.session.user.id).slice(0, 10);
  res.render('topup', {
    deposits,
    config: getConfig(),
    user: findUserById(req.session.user.id),
    success: req.query.success || null,
    error: req.query.error || null
  });
});

router.post('/api/topup', requireLogin, async (req, res) => {
  try {
    const user = findUserById(req.session.user.id);
    const amount = parseInt(req.body.amount);
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Jumlah tidak valid' });
    const deposit = await createDeposit(user, amount);
    res.json({ ok: true, deposit });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/api/topup/status/:trxid', requireLogin, (req, res) => {
  const dep = getDeposit(req.params.trxid);
  if (!dep) return res.status(404).json({ error: 'Transaksi tidak ditemukan' });
  if (dep.userId !== req.session.user.id) return res.status(403).json({ error: 'Akses ditolak' });
  res.json({ status: dep.status, amount: dep.amount, total: dep.total });
});

// Batal deposit lewat AJAX (dipakai saat QR sedang tampil)
router.post('/api/topup/cancel/:trxid', requireLogin, async (req, res) => {
  try {
    const dep = await cancelDeposit(req.params.trxid, req.session.user.id);
    res.json({ ok: true, status: dep.status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Batal deposit lewat form biasa (dipakai dari tabel riwayat top up)
router.post('/topup/:trxid/batal', requireLogin, async (req, res) => {
  try {
    await cancelDeposit(req.params.trxid, req.session.user.id);
    res.redirect('/topup?success=' + encodeURIComponent('Transaksi top up berhasil dibatalkan'));
  } catch (err) {
    res.redirect('/topup?error=' + encodeURIComponent(err.message));
  }
});

// Setelah QRIS terbayar, buat order otomatis dari saldo yang sudah masuk
router.get('/order/qris-confirm', requireLogin, async (req, res) => {
  try {
    const pending = req.session.pendingQrisOrder;
    const { trxid } = req.query;

    if (!pending || pending.depositTrxid !== trxid) {
      return res.redirect('/produk?error=' + encodeURIComponent('Sesi order tidak ditemukan'));
    }

    const dep = getDeposit(trxid);
    if (!dep || dep.status !== 'paid') {
      return res.redirect('/produk?error=' + encodeURIComponent('Pembayaran belum dikonfirmasi'));
    }

    const user = findUserById(req.session.user.id);
    const product = findProductById(pending.productId);
    const qty = pending.qty || 1;

    if (!product || product.status !== 'active') {
      return res.redirect('/produk?error=' + encodeURIComponent('Produk tidak tersedia'));
    }

    const unitPrice = applyMemberDiscount(product.price, user.membership);
    const total = unitPrice * qty;

    if (user.saldo < total) {
      return res.redirect('/produk?error=' + encodeURIComponent('Saldo tidak cukup setelah deposit'));
    }

    deductSaldo(user.id, total);

    const delivery = await fulfillOrder(product, qty, pending.targetData || {}, pending.targetText || '');
    if (delivery.refund) addSaldo(user.id, total); // refund saldo kalau Digiflazz gagal

    const order = createOrder({
      userId: user.id,
      username: user.username,
      productId: product.id,
      productName: product.name,
      price: unitPrice,
      qty,
      source: 'user',
      status: delivery.status,
      deliveryMode: delivery.deliveryMode,
      manualRequired: delivery.manualRequired,
      targetText: pending.targetText || '',
      detail: delivery.detail,
      note: delivery.refund ? delivery.note : 'Dibayar via QRIS',
      provider: delivery.provider,
      providerRefId: delivery.providerRefId,
      providerCustomerNo: delivery.providerCustomerNo
    });

    if (!delivery.refund) {
      updateProduct(product.id, { totalSold: (product.totalSold || 0) + qty });
    }
    notifyOrder({ username: user.username, productName: product.name, total: order.total, orderId: order.id, source: 'qris', needsManual: delivery.manualRequired, targetText: pending.targetText || '' }).catch(() => {});

    delete req.session.pendingQrisOrder;

    if (delivery.refund) {
      return res.redirect('/produk?error=' + encodeURIComponent(delivery.note + ', saldo sudah dikembalikan'));
    }

    const msg = delivery.status === 'completed'
      ? 'Pembayaran QRIS berhasil! Produk sudah dikirim.'
      : delivery.status === 'processing' && delivery.provider === 'digiflazz'
        ? 'Pembayaran QRIS berhasil! Top up sedang diproses otomatis.'
        : 'Pembayaran QRIS berhasil! Pesanan menunggu admin kirim manual.';
    res.redirect(`/riwayat/${order.id}?success=` + encodeURIComponent(msg));
  } catch (err) {
    res.redirect('/produk?error=' + encodeURIComponent(err.message));
  }
});

// ==================== DETAIL PRODUK ====================
router.get('/produk/:id', (req, res) => {
  const user = req.session.user ? findUserById(req.session.user.id) : null;
  const product = findProductById(req.params.id);
  if (!product || product.status !== 'active') {
    return res.redirect('/produk?error=Produk tidak ditemukan');
  }
  const finalPrice = user ? applyMemberDiscount(product.price, user.membership) : product.price;
  const reviews = getReviewsByProduct(product.id);
  const hasReviewed = user ? hasUserReviewed(user.id, product.id) : false;

  // Kalau produk ini punya variantGroup (mis. "Mobile Legends"), tampilkan juga produk lain
  // di grup yang sama sebagai pilihan nominal yang bisa diklik di halaman yang sama (tanpa reload).
  const variants = product.variantGroup
    ? getActiveProducts()
        .filter(p => p.variantGroup === product.variantGroup)
        .map(p => ({
          id: p.id,
          name: p.name,
          price: p.price,
          finalPrice: user ? applyMemberDiscount(p.price, user.membership) : p.price,
          thumbnail: p.thumbnail,
          targetFields: p.targetFields || [],
          stockCount: countStock(p),
          provider: p.provider
        }))
        .sort((a, b) => a.price - b.price)
    : [];

  res.render('produk-detail', {
    product,
    finalPrice,
    variants,
    reviews,
    hasReviewed,
    user,
    config: getConfig(),
    error: req.query.error || null,
    success: req.query.success || null
  });
});

// Submit ulasan (rating + komentar) — 1x per user per produk
router.post('/produk/:id/review', requireLogin, (req, res) => {
  const user = findUserById(req.session.user.id);
  const product = findProductById(req.params.id);
  if (!product) return res.redirect('/produk');

  try {
    const { avg, count } = createReview({
      userId: user.id,
      username: user.username,
      productId: product.id,
      productName: product.name,
      rating: req.body.rating,
      comment: req.body.comment
    });
    // Sync rating ke produk
    updateProduct(product.id, {
      rating: Math.round(avg * 10) / 10,
      ratingCount: count
    });
    res.redirect(`/produk/${product.id}?success=Ulasan kamu berhasil dikirim! ⭐`);
  } catch (err) {
    res.redirect(`/produk/${product.id}?error=${encodeURIComponent(err.message)}`);
  }
});

// QRIS order init: buat deposit untuk total produk, lalu redirect ke halaman topup-like dengan QR
router.post('/order/qris-init', requireLogin, async (req, res) => {
  try {
    const user = findUserById(req.session.user.id);
    const product = findProductById(req.body.productId);
    const qty = Math.max(1, parseInt(req.body.qty) || 1);

    if (!product || product.status !== 'active') {
      return res.redirect('/produk?error=Produk tidak tersedia');
    }

    const { data: targetData, missing } = extractTargetData(product, req.body);
    if (missing.length > 0) {
      return res.redirect(`/produk/${product.id}?error=` + encodeURIComponent(`Lengkapi dulu: ${missing.join(', ')}`));
    }
    const targetText = formatTargetText(product, targetData);

    const unitPrice = applyMemberDiscount(product.price, user.membership);
    const total = unitPrice * qty;

    const deposit = await createDeposit(user, total);

    // Simpan info order pending ke session supaya bisa dikonfirmasi setelah deposit berhasil
    req.session.pendingQrisOrder = {
      productId: product.id,
      qty,
      targetText,
      targetData,
      depositTrxid: deposit.trxid
    };

    res.render('order-qris', {
      deposit,
      product,
      qty,
      total,
      targetText,
      user,
      config: getConfig()
    });
  } catch (err) {
    res.redirect(`/produk/${req.body.productId}?error=${encodeURIComponent(err.message)}`);
  }
});

export default router;
