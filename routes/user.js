import express from 'express';
import { requireLogin } from '../middleware/auth.js';
import { findUserById, updateUser, setPassword, verifyPassword, deductSaldo } from '../lib/users.js';
import { getActiveProducts, findProductById, takeProductStock, countStock } from '../lib/products.js';
import { getOrdersByUser, createOrder, getStats } from '../lib/orders.js';
import { createDeposit, getDeposit, getDepositsByUser } from '../lib/deposit.js';
import { notifyOrder } from '../lib/telegram.js';
import { getConfig } from '../lib/config.js';

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
  res.render('profile', { user, error: null, success: null, config: getConfig() });
});

router.post('/profile', (req, res) => {
  const user = findUserById(req.session.user.id);
  const { email } = req.body;
  updateUser(user.id, { email });
  res.render('profile', { user: findUserById(user.id), error: null, success: 'Profil berhasil diperbarui', config: getConfig() });
});

router.post('/profile/password', (req, res) => {
  const user = findUserById(req.session.user.id);
  const { oldPassword, newPassword, newPassword2 } = req.body;

  if (!verifyPassword(user, oldPassword)) {
    return res.render('profile', { user, error: 'Password lama salah', success: null, config: getConfig() });
  }
  if (newPassword !== newPassword2) {
    return res.render('profile', { user, error: 'Konfirmasi password baru tidak cocok', success: null, config: getConfig() });
  }
  if (newPassword.length < 6) {
    return res.render('profile', { user, error: 'Password minimal 6 karakter', success: null, config: getConfig() });
  }
  setPassword(user.id, newPassword);
  res.render('profile', { user: findUserById(user.id), error: null, success: 'Password berhasil diubah', config: getConfig() });
});

router.get('/produk', (req, res) => {
  res.render('produk', {
    products: getActiveProducts(),
    user: findUserById(req.session.user.id),
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
  const total = product.price * qty;
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
    price: product.price,
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
  res.render('topup', { deposits, config: getConfig(), user: findUserById(req.session.user.id) });
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

export default router;
