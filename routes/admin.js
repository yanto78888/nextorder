import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { requireAdmin } from '../middleware/auth.js';
import { getConfig, updateConfig } from '../lib/config.js';
import { getAllUsers, findUserById, updateUser, addSaldo, setPassword, verifyPassword } from '../lib/users.js';
import { getMembershipList } from '../lib/membership.js';
import {
  getAllProducts, createProduct, updateProduct, deleteProduct, findProductById, addProductStock, deleteProductStock
} from '../lib/products.js';
import { getAllOrders, findOrderById, createOrder, updateOrderStatus, getStats } from '../lib/orders.js';
import { notifyOrder } from '../lib/telegram.js';

const router = express.Router();
router.use(requireAdmin);

// ---------- UPLOAD FOTO PRODUK ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.join(__dirname, '..', 'public', 'uploads', 'products');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const unique = Date.now() + '_' + Math.round(Math.random() * 1e6);
    cb(null, `prod_${unique}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024 }, // 3MB
  fileFilter: (req, file, cb) => {
    const allowedExt = /\.(jpe?g|png|webp|gif)$/i;
    const allowedMime = /^image\/(jpeg|png|webp|gif)$/i;
    if (!allowedExt.test(file.originalname) || !allowedMime.test(file.mimetype || '')) {
      return cb(new Error('Format foto harus JPG, PNG, WEBP, atau GIF'));
    }
    cb(null, true);
  }
});

// Bungkus multer supaya error (misal file terlalu besar / format salah) tidak bikin app crash,
// tapi redirect balik dengan pesan error yang rapi.
function uploadThumbnail(req, res, next) {
  upload.single('thumbnailFile')(req, res, (err) => {
    if (err) {
      const redirectTo = req.params.id ? `/admin/produk/${req.params.id}/edit` : '/admin/produk';
      return res.redirect(redirectTo + '?error=' + encodeURIComponent(err.message));
    }
    next();
  });
}

function renderSettings(req, res, extra = {}) {
  res.render('admin/settings', {
    config: getConfig(),
    adminUser: findUserById(req.session.user.id),
    success: null,
    accountError: null,
    ...extra
  });
}

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
  res.render('admin/produk', { products: getAllProducts(), config: getConfig(), editProduct: null, error: req.query.error || null });
});

router.get('/produk/:id/edit', (req, res) => {
  const product = findProductById(req.params.id);
  res.render('admin/produk', { products: getAllProducts(), config: getConfig(), editProduct: product, error: req.query.error || null });
});

router.post('/produk', uploadThumbnail, (req, res) => {
  const { name, category, description, price, stockNote, stockItems } = req.body;
  const thumbnail = req.file ? '/uploads/products/' + req.file.filename : '';
  createProduct({ name, category, description, price, stockNote, thumbnail, stockItems });
  res.redirect('/admin/produk');
});

router.post('/produk/:id', uploadThumbnail, (req, res) => {
  const { name, category, description, price, stockNote, status, stockItems } = req.body;
  const partial = { name, category, description, price, stockNote, status, stockItems };
  // Foto hanya diganti kalau admin upload file baru, kalau tidak foto lama tetap dipakai
  if (req.file) partial.thumbnail = '/uploads/products/' + req.file.filename;
  updateProduct(req.params.id, partial);
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
  res.render('admin/users', { users: getAllUsers(), config: getConfig(), membershipList: getMembershipList() });
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

router.post('/users/:id/membership', (req, res) => {
  const tier = req.body.membership;
  if (['reguler', 'gold', 'platinum'].includes(tier)) {
    updateUser(req.params.id, { membership: tier });
  }
  res.redirect('/admin/users');
});

// ---------- SETTINGS ----------
router.get('/settings', (req, res) => {
  renderSettings(req, res);
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

  renderSettings(req, res, { success: 'Pengaturan berhasil disimpan' });
});

// Ubah username/password admin dari halaman Settings.
router.post('/settings/account', (req, res) => {
  const admin = findUserById(req.session.user.id);
  const currentPassword = req.body.currentPassword || '';
  const newUsername = (req.body.newUsername || '').trim();
  const newPassword = req.body.newPassword || '';
  const newPassword2 = req.body.newPassword2 || '';

  if (!admin) {
    return res.redirect('/logout');
  }

  if (!verifyPassword(admin, currentPassword)) {
    return renderSettings(req, res, { accountError: 'Password admin saat ini salah' });
  }

  const updates = {};
  const changeUsername = newUsername && newUsername !== admin.username;
  const changePassword = newPassword || newPassword2;

  if (!changeUsername && !changePassword) {
    return renderSettings(req, res, { accountError: 'Isi username baru atau password baru terlebih dahulu' });
  }

  if (changeUsername) {
    if (newUsername.length < 3 || newUsername.length > 32) {
      return renderSettings(req, res, { accountError: 'Username harus 3-32 karakter' });
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(newUsername)) {
      return renderSettings(req, res, { accountError: 'Username hanya boleh huruf, angka, titik, strip, dan underscore' });
    }
    const usernameTaken = getAllUsers().some(u =>
      u.id !== admin.id && String(u.username).toLowerCase() === newUsername.toLowerCase()
    );
    if (usernameTaken) {
      return renderSettings(req, res, { accountError: 'Username sudah dipakai user lain' });
    }
    updates.username = newUsername;
  }

  if (changePassword) {
    if (newPassword !== newPassword2) {
      return renderSettings(req, res, { accountError: 'Konfirmasi password baru tidak cocok' });
    }
    if (newPassword.length < 6) {
      return renderSettings(req, res, { accountError: 'Password baru minimal 6 karakter' });
    }
  }

  if (Object.keys(updates).length > 0) updateUser(admin.id, updates);
  if (changePassword) setPassword(admin.id, newPassword);

  const freshAdmin = findUserById(admin.id);
  req.session.user = {
    ...req.session.user,
    id: freshAdmin.id,
    username: freshAdmin.username,
    role: freshAdmin.role,
    email: freshAdmin.email
  };

  renderSettings(req, res, { success: 'Username/password admin berhasil diperbarui' });
});

export default router;
