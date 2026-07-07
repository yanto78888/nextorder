import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { getConfig, updateConfig } from '../lib/config.js';
import { getAllUsers, findUserById, updateUser, addSaldo } from '../lib/users.js';
import {
  getAllProducts, createProduct, updateProduct, deleteProduct, findProductById, addProductStock, deleteProductStock
} from '../lib/products.js';
import { getAllOrders, findOrderById, createOrder, updateOrderStatus, getStats } from '../lib/orders.js';
import { notifyOrder } from '../lib/telegram.js';

const router = express.Router();
router.use(requireAdmin);

router.get('/', (req, res) => {
  const stats = getStats();
  const users = getAllUsers();
  const orders = getAllOrders().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const manualOrders = orders.filter(o => o.manualRequired && o.status === 'processing');
  const emptyStockProducts = getAllProducts().filter(p => p.status === 'active' && (!p.stockItems || p.stockItems.length === 0));
  res.render('admin/dashboard', {
    stats,
    totalUsers: users.length,
    recentOrders: orders.slice(0, 8),
    manualOrders,
    emptyStockProducts,
    config: getConfig()
  });
});

// ---------- PRODUK ----------
router.get('/produk', (req, res) => {
  res.render('admin/produk', { products: getAllProducts(), config: getConfig(), editProduct: null });
});

router.get('/produk/:id/edit', (req, res) => {
  const product = findProductById(req.params.id);
  res.render('admin/produk', { products: getAllProducts(), config: getConfig(), editProduct: product });
});

router.post('/produk', (req, res) => {
  const { name, category, description, price, stockNote, thumbnail, stockItems } = req.body;
  createProduct({ name, category, description, price, stockNote, thumbnail, stockItems });
  res.redirect('/admin/produk');
});

router.post('/produk/:id', (req, res) => {
  const { name, category, description, price, stockNote, thumbnail, status, stockItems } = req.body;
  updateProduct(req.params.id, { name, category, description, price, stockNote, thumbnail, status, stockItems });
  res.redirect('/admin/produk');
});


router.post('/produk/:id/stock', (req, res) => {
  addProductStock(req.params.id, req.body.stockItems || '');
  res.redirect('/admin/produk/' + req.params.id + '/edit');
});

router.post('/produk/:id/stock/:stockId/hapus', (req, res) => {
  deleteProductStock(req.params.id, req.params.stockId);
  res.redirect('/admin/produk/' + req.params.id + '/edit');
});

router.post('/produk/:id/hapus', (req, res) => {
  deleteProduct(req.params.id);
  res.redirect('/admin/produk');
});

// ---------- ORDER ----------
router.get('/order', (req, res) => {
  const orders = getAllOrders().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.render('admin/order', { orders, config: getConfig(), products: getAllProducts(), users: getAllUsers() });
});

router.post('/order/:id/status', async (req, res) => {
  const { status, detail } = req.body;
  updateOrderStatus(req.params.id, status, detail);
  res.redirect('/admin/order');
});

// Kirim pesanan manual oleh admin
router.post('/order/manual', async (req, res) => {
  const { userId, productId, customName, customPrice, note, detail, status } = req.body;
  const user = findUserById(userId);
  if (!user) return res.redirect('/admin/order?error=User tidak ditemukan');

  let productName, price;
  if (productId) {
    const product = findProductById(productId);
    if (!product) return res.redirect('/admin/order?error=Produk tidak ditemukan');
    productName = product.name;
    price = product.price;
  } else {
    productName = customName || 'Order Manual';
    price = Number(customPrice) || 0;
  }

  const order = createOrder({
    userId: user.id,
    username: user.username,
    productId: productId || null,
    productName,
    price,
    qty: 1,
    source: 'admin',
    status: status || 'completed',
    deliveryMode: 'manual',
    manualRequired: false,
    note: note || '',
    detail: detail || ''
  });

  notifyOrder({
    username: user.username,
    productName,
    total: order.total,
    orderId: order.id,
    source: 'admin'
  }).catch(() => {});

  res.redirect('/admin/order');
});

// ---------- USERS ----------
router.get('/users', (req, res) => {
  res.render('admin/users', { users: getAllUsers(), config: getConfig() });
});

router.post('/users/:id/saldo', (req, res) => {
  const amount = parseInt(req.body.amount);
  if (amount) addSaldo(req.params.id, amount);
  res.redirect('/admin/users');
});

router.post('/users/:id/status', (req, res) => {
  updateUser(req.params.id, { status: req.body.status });
  res.redirect('/admin/users');
});

router.post('/users/:id/role', (req, res) => {
  updateUser(req.params.id, { role: req.body.role });
  res.redirect('/admin/users');
});

// ---------- SETTINGS ----------
router.get('/settings', (req, res) => {
  res.render('admin/settings', { config: getConfig(), success: null });
});

router.post('/settings', (req, res) => {
  const {
    siteName, siteTagline,
    qrString, merchantCode, apiKey, feePercent, depositMin, expiredMinutes,
    botToken, chatId, notifyOnDeposit, notifyOnOrder, notifyOnRegister,
    ownerWhatsapp
  } = req.body;

  updateConfig({
    siteName,
    siteTagline,
    ownerWhatsapp,
    qris: {
      qrString,
      merchantCode,
      apiKey,
      feePercent: parseFloat(feePercent),
      depositMin: parseInt(depositMin),
      expiredMinutes: parseInt(expiredMinutes)
    },
    telegram: {
      botToken,
      chatId,
      notifyOnDeposit: notifyOnDeposit === 'on',
      notifyOnOrder: notifyOnOrder === 'on',
      notifyOnRegister: notifyOnRegister === 'on'
    }
  });

  res.render('admin/settings', { config: getConfig(), success: 'Pengaturan berhasil disimpan' });
});

export default router;
