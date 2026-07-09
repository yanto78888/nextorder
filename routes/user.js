import express from 'express';
import { requireLogin } from '../middleware/auth.js';
import {
  findUserById, updateUser, setPassword, verifyPassword, deductSaldo,
  getMembershipDiscount, upgradeMembership
} from '../lib/users.js';
import { getActiveProducts, findProductById, takeProductStock, countStock } from '../lib/products.js';
import { getOrdersByUser, createOrder, getStats } from '../lib/orders.js';
import { createDeposit, getDeposit, getDepositsByUser, cancelDeposit } from '../lib/deposit.js';
import { notifyOrder } from '../lib/telegram.js';
import { getConfig } from '../lib/config.js';
import { getMembershipList, getMembershipTier, applyMemberDiscount } from '../lib/membership.js';

const router = express.Router();
router.use(requireLogin);

router.get('/dashboard', (req, res) => {
  const user = findUserById(req.session.user.id);
  const orders = getOrdersByUser(user.id);
  res.render('dashboard', {
    user,
    totalOrder: orders.length,
    totalSpent: orders.filter(o => o.status !== 'cancelled').reduce((s, o) => s + o.total, 0),
    recentOrders: orders.slice(0, 5),
    config: getConfig()
  });
});

router.get('/profile', (req, res) => {
  const user = findUserById(req.session.user.id);
  res.render('profile', {
    user, error: req.query.error || null, success: req.query.success || null, config: getConfig(),
    membershipList: getMembershipList(), currentTier: getMembershipTier(user.membership)
  });
});

router.post('/profile', (req, res) => {
  const user = findUserById(req.session.user.id);
  const { email } = req.body;
  updateUser(user.id, { email });
  const updated = findUserById(user.id);
  res.render('profile', {
    user: updated, error: null, success: 'Profil berhasil diperbarui', config: getConfig(),
    membershipList: getMembershipList(), currentTier: getMembershipTier(updated.membership)
  });
});

router.post('/profile/password', (req, res) => {
  const user = findUserById(req.session.user.id);
  const { oldPassword, newPassword, newPassword2 } = req.body;
  const membershipList = getMembershipList();

  if (!verifyPassword(user, oldPassword)) {
    return res.render('profile', { user, error: 'Password lama salah', success: null, config: getConfig(), membershipList, currentTier: getMembershipTier(user.membership) });
  }
  if (newPassword !== newPassword2) {
    return res.render('profile', { user, error: 'Konfirmasi password baru tidak cocok', success: null, config: getConfig(), membershipList, currentTier: getMembershipTier(user.membership) });
  }
  if (newPassword.length < 6) {
    return res.render('profile', { user, error: 'Password minimal 6 karakter', success: null, config: getConfig(), membershipList, currentTier: getMembershipTier(user.membership) });
  }
  setPassword(user.id, newPassword);
  const updated = findUserById(user.id);
  res.render('profile', { user: updated, error: null, success: 'Password berhasil diubah', config: getConfig(), membershipList, currentTier: getMembershipTier(updated.membership) });
});

// Upgrade membership Gold / Platinum, harga dipotong langsung dari saldo
router.post('/membership/upgrade', (req, res) => {
  try {
    const tierKey = req.body.tier;
    const user = findUserById(req.session.user.id);
    const updated = upgradeMembership(user.id, tierKey);
    req.session.user.membership = updated.membership;
    const tier = getMembershipTier(updated.membership);
    res.redirect('/profile?success=' + encodeURIComponent(`Berhasil upgrade ke member ${tier.label}! Diskon Rp ${tier.discount.toLocaleString('id-ID')} berlaku di setiap pembelian.`));
  } catch (err) {
    res.redirect('/profile?error=' + encodeURIComponent(err.message));
  }
});

router.get('/produk', (req, res) => {
  const user = findUserById(req.session.user.id);
  const discount = getMembershipDiscount(user);
  const products = getActiveProducts().map(p => ({
    ...p,
    finalPrice: applyMemberDiscount(p.price, user.membership)
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
    memberDiscount: discount,
    user,
    config: getConfig(),
    error: req.query.error || null
  });
});

router.post('/order', async (req, res) => {
  const user = findUserById(req.session.user.id);
  const product = findProductById(req.body.productId);
  const qty = Math.max(1, parseInt(req.body.qty) || 1);

  if (!product || product.status !== 'active') {
    return res.redirect('/produk?error=Produk tidak tersedia');
  }
  const unitPrice = applyMemberDiscount(product.price, user.membership);
  const total = unitPrice * qty;
  if (user.saldo < total) {
    return res.redirect('/produk?error=Saldo tidak cukup, silakan topup');
  }

  deductSaldo(user.id, total);

  const stockAvailable = countStock(product);
  const takenStock = stockAvailable >= qty ? takeProductStock(product.id, qty) : null;
  const isAutoDelivered = Array.isArray(takenStock) && takenStock.length === qty;

  const order = createOrder({
    userId: user.id,
    username: user.username,
    productId: product.id,
    productName: product.name,
    price: unitPrice,
    qty,
    source: 'user',
    status: isAutoDelivered ? 'completed' : 'processing',
    deliveryMode: isAutoDelivered ? 'auto' : 'manual',
    manualRequired: !isAutoDelivered,
    detail: isAutoDelivered ? takenStock.map((item, i) => qty > 1 ? `${i + 1}. ${item.value}` : item.value).join('\n') : '',
    note: isAutoDelivered ? 'Dikirim otomatis dari stok sistem' : 'Stok otomatis habis, menunggu admin kirim manual'
  });

  notifyOrder({
    username: user.username,
    productName: product.name,
    total: order.total,
    orderId: order.id,
    source: isAutoDelivered ? 'auto' : 'user',
    needsManual: !isAutoDelivered
  }).catch(() => {});

  const msg = isAutoDelivered
    ? 'Order berhasil, stok otomatis sudah dikirim. Cek detail pesanan di riwayat.'
    : 'Order berhasil, stok otomatis sedang habis. Pesanan menunggu admin kirim manual.';
  res.redirect('/riwayat?success=' + encodeURIComponent(msg));
});

router.get('/riwayat', (req, res) => {
  const orders = getOrdersByUser(req.session.user.id);
  res.render('riwayat', {
    orders,
    config: getConfig(),
    user: findUserById(req.session.user.id),
    success: req.query.success || null
  });
});

router.get('/topup', (req, res) => {
  const deposits = getDepositsByUser(req.session.user.id).slice(0, 10);
  res.render('topup', {
    deposits,
    config: getConfig(),
    user: findUserById(req.session.user.id),
    success: req.query.success || null,
    error: req.query.error || null
  });
});

router.post('/api/topup', async (req, res) => {
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

router.get('/api/topup/status/:trxid', (req, res) => {
  const dep = getDeposit(req.params.trxid);
  if (!dep) return res.status(404).json({ error: 'Transaksi tidak ditemukan' });
  if (dep.userId !== req.session.user.id) return res.status(403).json({ error: 'Akses ditolak' });
  res.json({ status: dep.status, amount: dep.amount, total: dep.total });
});

// Batal deposit lewat AJAX (dipakai saat QR sedang tampil)
router.post('/api/topup/cancel/:trxid', async (req, res) => {
  try {
    const dep = await cancelDeposit(req.params.trxid, req.session.user.id);
    res.json({ ok: true, status: dep.status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Batal deposit lewat form biasa (dipakai dari tabel riwayat top up)
router.post('/topup/:trxid/batal', async (req, res) => {
  try {
    await cancelDeposit(req.params.trxid, req.session.user.id);
    res.redirect('/topup?success=' + encodeURIComponent('Transaksi top up berhasil dibatalkan'));
  } catch (err) {
    res.redirect('/topup?error=' + encodeURIComponent(err.message));
  }
});

export default router;
