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
import { runBackupNow } from '../lib/backup.js';
import { getGamePresetList } from '../lib/gamePresets.js';
import { deleteReview, getRecentReviews } from '../lib/reviews.js';
import { checkBalance as checkDigiflazzBalance, searchPriceList as searchDigiflazzPriceList, getPriceList as getDigiflazzPriceList, computeSellPrice } from '../lib/digiflazz.js';

// Tebak gamePreset yang cocok dari nama/brand produk Digiflazz, biar field ID Tujuan
// (termasuk dropdown Server buat game kayak Genshin Impact/Wuthering Waves) otomatis
// kepasang benar pas import, gak perlu diatur manual satu-satu di halaman produk.
//
// Kalau nama game gak dikenali sistem, fallback ke preset "id_only" (1 field User ID
// generik) — BUKAN dikosongkan. Auto top up Digiflazz butuh minimal 1 ID buat dikirim
// sebagai customer_no, jadi produk tanpa field ID Tujuan sama sekali bakal gagal saat
// dibeli. Admin tetap bisa ganti manual ke preset lain / custom di halaman Kelola Produk
// kalau ternyata game itu butuh 2 field (ID + Server) yang belum ada presetnya.
function guessGamePreset(text) {
  const t = String(text || '').toLowerCase();
  if (t.includes('mobile legends') || t.includes('ml ')) return 'mobile_legends';
  if (t.includes('free fire') || t.includes('ff ')) return 'free_fire';
  if (t.includes('genshin')) return 'genshin_impact';
  if (t.includes('wuthering')) return 'wuthering_waves';
  if (t.includes('honkai') || t.includes('star rail') || t.includes('hsr')) return 'honkai_star_rail';
  if (t.includes('pubg')) return 'pubg_mobile';
  if (t.includes('valorant')) return 'valorant';
  return 'id_only';
}

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

// ---------- UPLOAD BANNER IKLAN ----------
const bannerDir = path.join(__dirname, '..', 'public', 'uploads', 'banners');
fs.mkdirSync(bannerDir, { recursive: true });

const bannerStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, bannerDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `banner_${Date.now()}${ext}`);
  }
});
const uploadBanner = multer({
  storage: bannerStorage,
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(jpe?g|png|webp|gif)$/i.test(file.originalname) && /^image\//i.test(file.mimetype || '');
    ok ? cb(null, true) : cb(new Error('Format harus gambar'));
  }
});

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

  // Buat data grafik 7 hari terakhir
  const now = new Date();
  const chartDays = 7;
  const chartLabels = [];
  const chartRevenue = [];
  const chartOrders = [];
  for (let i = chartDays - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const label = d.toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric' });
    const dateStr = d.toISOString().slice(0, 10);
    const dayOrders = orders.filter(o => o.createdAt && o.createdAt.startsWith(dateStr) && o.status !== 'cancelled');
    chartLabels.push(label);
    chartOrders.push(dayOrders.length);
    chartRevenue.push(dayOrders.reduce((s, o) => s + (o.total || 0), 0));
  }

  // Status breakdown untuk donut
  const completed = orders.filter(o => o.status === 'completed').length;
  const processing = orders.filter(o => o.status === 'processing').length;
  const cancelled = orders.filter(o => o.status === 'cancelled').length;

  res.render('admin/dashboard', {
    stats,
    totalUsers: users.length,
    recentOrders: orders.slice(0, 6),
    recentReviews: getRecentReviews(5),
    manualOrders,
    emptyStockProducts,
    config: getConfig(),
    chartLabels: JSON.stringify(chartLabels),
    chartRevenue: JSON.stringify(chartRevenue),
    chartOrders: JSON.stringify(chartOrders),
    statusCompleted: completed,
    statusProcessing: processing,
    statusCancelled: cancelled
  });
});

// Hapus review dari admin
router.post('/review/delete/:id', (req, res) => {
  deleteReview(req.params.id);
  res.redirect('/admin?success=Ulasan dihapus');
});

// ---------- PRODUK ----------
router.get('/produk', (req, res) => {
  res.render('admin/produk', { products: getAllProducts(), config: getConfig(), editProduct: null, gamePresetList: getGamePresetList(), error: req.query.error || null });
});

router.get('/produk/:id/edit', (req, res) => {
  const product = findProductById(req.params.id);
  res.render('admin/produk', { products: getAllProducts(), config: getConfig(), editProduct: product, gamePresetList: getGamePresetList(), error: req.query.error || null });
});

function parseCustomTargetFields(body) {
  const keys = [].concat(body['customFieldKey[]'] || []);
  const labels = [].concat(body['customFieldLabel[]'] || []);
  const placeholders = [].concat(body['customFieldPlaceholder[]'] || []);
  const requireds = [].concat(body['customFieldRequired[]'] || []);
  return keys.map((key, i) => ({
    key,
    label: labels[i] || '',
    placeholder: placeholders[i] || '',
    required: requireds.includes(key)
  })).filter(f => f.key && f.label);
}

router.post('/produk', uploadThumbnail, (req, res) => {
  const { name, category, description, price, stockNote, stockItems, gamePreset, provider, digiflazzSku, digiflazzCustomerNoTemplate, variantGroup } = req.body;
  const thumbnail = req.file ? '/uploads/products/' + req.file.filename : '';
  createProduct({ name, category, description, price, stockNote, thumbnail, stockItems, gamePreset, provider, digiflazzSku, digiflazzCustomerNoTemplate, variantGroup, customTargetFields: parseCustomTargetFields(req.body) });
  res.redirect('/admin/produk');
});

router.post('/produk/:id', uploadThumbnail, (req, res) => {
  const { name, category, description, price, stockNote, status, stockItems, gamePreset, provider, digiflazzSku, digiflazzCustomerNoTemplate, variantGroup } = req.body;
  const partial = { name, category, description, price, stockNote, status, stockItems, gamePreset, provider, digiflazzSku, digiflazzCustomerNoTemplate, variantGroup, customTargetFields: parseCustomTargetFields(req.body) };
  // Foto hanya diganti kalau admin upload file baru, kalau tidak foto lama tetap dipakai
  if (req.file) partial.thumbnail = '/uploads/products/' + req.file.filename;
  updateProduct(req.params.id, partial);
  res.redirect('/admin/produk');
});

// Cari produk dari price list Digiflazz (dipakai admin buat pilih SKU pas bikin/edit produk)
router.get('/produk/digiflazz/search', async (req, res) => {
  try {
    const results = await searchDigiflazzPriceList(req.query.q || '', 'prepaid');
    res.json({ ok: true, results });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
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

// ---------- DIGIFLAZZ PRODUCTS (nav khusus, kelola produk auto topup + margin) ----------

function renderDigiflazzPage(req, res, extra = {}) {
  const digiflazzProducts = getAllProducts().filter(p => p.provider === 'digiflazz');
  res.render('admin/digiflazz', {
    config: getConfig(),
    digiflazzProducts,
    searchResults: [],
    searchQuery: '',
    error: null,
    success: null,
    ...extra
  });
}

router.get('/digiflazz', (req, res) => {
  renderDigiflazzPage(req, res);
});

// Cari produk Digiflazz + preview harga jual (base + margin default) buat halaman kelola khusus ini
router.get('/digiflazz/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    const raw = await searchDigiflazzPriceList(q, 'prepaid');
    const linkedSkus = new Set(getAllProducts().filter(p => p.provider === 'digiflazz').map(p => p.digiflazzSku));
    const results = raw.map(item => ({
      ...item,
      sellPricePreview: computeSellPrice(item.price, null, null),
      alreadyImported: linkedSkus.has(item.buyer_sku_code)
    }));
    res.json({ ok: true, results });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Simpan margin default global (dipakai semua produk digiflazz yang tidak punya override sendiri)
router.post('/digiflazz/margin', (req, res) => {
  const marginType = req.body.marginType === 'fixed' ? 'fixed' : 'percent';
  const marginValue = Number(req.body.marginValue) || 0;
  updateConfig({ digiflazz: { marginType, marginValue } });
  renderDigiflazzPage(req, res, { success: 'Margin default berhasil disimpan' });
});

// Import 1 produk dari price list Digiflazz jadi produk lokal
router.post('/digiflazz/import', (req, res) => {
  try {
    const {
      buyerSkuCode, productName, category, brand, basePrice,
      gamePreset, marginType, marginValue
    } = req.body;

    if (!buyerSkuCode || !productName) {
      return renderDigiflazzPage(req, res, { error: 'SKU dan nama produk wajib diisi' });
    }

    // Cegah double-import SKU yang sama
    const existing = getAllProducts().find(p => p.provider === 'digiflazz' && p.digiflazzSku === buyerSkuCode);
    const base = Number(basePrice) || 0;
    const sellPrice = computeSellPrice(base, marginType || null, marginValue !== '' ? marginValue : null);
    const detectedPreset = gamePreset || guessGamePreset(`${productName} ${brand || ''}`);

    if (existing) {
      updateProduct(existing.id, {
        name: productName,
        price: sellPrice,
        digiflazzBasePrice: base,
        marginType: marginType || '',
        marginValue: marginValue !== '' ? marginValue : null
      });
      return renderDigiflazzPage(req, res, { success: `SKU ${buyerSkuCode} sudah pernah diimport, harga & data produk diperbarui.` });
    }

    createProduct({
      name: productName,
      category: category || 'Games',
      description: `Auto top up ${productName} via Digiflazz`,
      price: sellPrice,
      provider: 'digiflazz',
      digiflazzSku: buyerSkuCode,
      digiflazzBasePrice: base,
      variantGroup: brand || '',
      gamePreset: detectedPreset,
      marginType: marginType || '',
      marginValue: marginValue !== '' ? marginValue : null
    });

    renderDigiflazzPage(req, res, { success: `Produk "${productName}" berhasil diimport dari Digiflazz.` });
  } catch (err) {
    renderDigiflazzPage(req, res, { error: err.message });
  }
});

// Set margin override khusus 1 produk (kosongkan buat pakai margin default global lagi) + hitung ulang harga jual
router.post('/digiflazz/:id/margin', (req, res) => {
  try {
    const product = findProductById(req.params.id);
    if (!product || product.provider !== 'digiflazz') {
      return renderDigiflazzPage(req, res, { error: 'Produk Digiflazz tidak ditemukan' });
    }
    const marginType = req.body.marginType || '';
    const marginValue = req.body.marginValue !== '' ? req.body.marginValue : null;
    const sellPrice = computeSellPrice(product.digiflazzBasePrice, marginType || null, marginValue);
    updateProduct(product.id, { marginType, marginValue, price: sellPrice });
    renderDigiflazzPage(req, res, { success: `Margin "${product.name}" diperbarui, harga jual: Rp ${sellPrice.toLocaleString('id-ID')}` });
  } catch (err) {
    renderDigiflazzPage(req, res, { error: err.message });
  }
});

// Sinkron ulang 1 produk: ambil harga modal terbaru dari Digiflazz, hitung ulang harga jual pakai margin yang ada
router.post('/digiflazz/:id/resync', async (req, res) => {
  try {
    const product = findProductById(req.params.id);
    if (!product || product.provider !== 'digiflazz') {
      return renderDigiflazzPage(req, res, { error: 'Produk Digiflazz tidak ditemukan' });
    }
    const list = await getDigiflazzPriceList('prepaid');
    const match = list.find(item => item.buyer_sku_code === product.digiflazzSku);
    if (!match) {
      return renderDigiflazzPage(req, res, { error: `SKU ${product.digiflazzSku} tidak ditemukan di price list Digiflazz` });
    }
    const sellPrice = computeSellPrice(match.price, product.marginType || null, product.marginValue);
    updateProduct(product.id, { digiflazzBasePrice: match.price, price: sellPrice });
    renderDigiflazzPage(req, res, { success: `Harga "${product.name}" disinkron: modal Rp ${match.price.toLocaleString('id-ID')} -> jual Rp ${sellPrice.toLocaleString('id-ID')}` });
  } catch (err) {
    renderDigiflazzPage(req, res, { error: err.message });
  }
});

// Sinkron ulang SEMUA produk digiflazz sekaligus (1x fetch price list, dicocokkan per SKU)
router.post('/digiflazz/sync-all', async (req, res) => {
  try {
    const list = await getDigiflazzPriceList('prepaid');
    const priceMap = new Map(list.map(item => [item.buyer_sku_code, item.price]));
    const products = getAllProducts().filter(p => p.provider === 'digiflazz');
    let updated = 0;
    let notFound = 0;
    products.forEach(p => {
      const basePrice = priceMap.get(p.digiflazzSku);
      if (basePrice === undefined) { notFound++; return; }
      const sellPrice = computeSellPrice(basePrice, p.marginType || null, p.marginValue);
      updateProduct(p.id, { digiflazzBasePrice: basePrice, price: sellPrice });
      updated++;
    });
    renderDigiflazzPage(req, res, { success: `${updated} produk berhasil disinkron.${notFound > 0 ? ` ${notFound} SKU tidak ditemukan di price list (mungkin sudah tidak aktif).` : ''}` });
  } catch (err) {
    renderDigiflazzPage(req, res, { error: err.message });
  }
});

// Lepas produk dari Digiflazz (jadi produk manual biasa, stok manual kosong)
router.post('/digiflazz/:id/unlink', (req, res) => {
  updateProduct(req.params.id, { provider: 'manual' });
  renderDigiflazzPage(req, res, { success: 'Produk dilepas dari Digiflazz, sekarang jadi produk stok manual.' });
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

// Cek saldo Digiflazz via AJAX, ditampilkan di halaman settings
router.get('/settings/digiflazz/saldo', async (req, res) => {
  try {
    const deposit = await checkDigiflazzBalance();
    res.json({ ok: true, deposit });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/settings', (req, res) => {
  const {
    siteName, siteTagline,
    catalogCategories,
    qrString, merchantCode, apiKey, feePercent, depositMin, expiredMinutes,
    digiflazzEnabled, digiflazzUsername, digiflazzApiKey,
    botToken, chatId, notifyOnDeposit, notifyOnOrder, notifyOnRegister,
    ownerWhatsapp,
    groupEnabled, groupTitle, groupMessage, groupLink, groupButtonText,
    marqueeEnabled, marqueeText
  } = req.body;

  const categories = (catalogCategories || 'Games')
    .split(',')
    .map(c => c.trim())
    .filter(Boolean);

  updateConfig({
    siteName, siteTagline, ownerWhatsapp,
    catalog: { categories: categories.length > 0 ? categories : ['Games'] },
    qris: { qrString, merchantCode, apiKey, feePercent: parseFloat(feePercent), depositMin: parseInt(depositMin), expiredMinutes: parseInt(expiredMinutes) },
    digiflazz: { enabled: digiflazzEnabled === 'on', username: digiflazzUsername || '', apiKey: digiflazzApiKey || '' },
    telegram: { botToken, chatId, notifyOnDeposit: notifyOnDeposit === 'on', notifyOnOrder: notifyOnOrder === 'on', notifyOnRegister: notifyOnRegister === 'on' },
    community: { groupEnabled: groupEnabled === 'on', groupTitle, groupMessage, groupLink, groupButtonText },
    marquee: { enabled: marqueeEnabled === 'on', text: marqueeText || '' }
    // NOTE: "banners" sengaja tidak disentuh di sini. Banner dikelola sepenuhnya lewat
    // /admin/settings/banner/add dan /admin/settings/banner/delete/:id (form terpisah di halaman
    // settings), supaya klik "Simpan Pengaturan" tidak pernah menimpa/menghapus banner yang sudah ada.
  });

  renderSettings(req, res, { success: 'Pengaturan berhasil disimpan' });
});

// Trigger backup data manual dari tombol di halaman settings (di luar jadwal otomatis 5 jam)
router.post('/settings/backup/now', async (req, res) => {
  const result = await runBackupNow();
  if (result.ok) {
    renderSettings(req, res, { success: '✅ Backup berhasil dikirim ke Telegram' });
  } else if (result.reason === 'no-telegram-config') {
    renderSettings(req, res, { accountError: 'Isi dulu Bot Token & Chat ID Telegram sebelum backup manual' });
  } else {
    renderSettings(req, res, { accountError: 'Backup gagal: ' + (result.reason || 'unknown error') });
  }
});

// Upload banner baru
router.post('/settings/banner/add', (req, res) => {
  uploadBanner.single('bannerImage')(req, res, (err) => {
    if (err) return res.redirect('/admin/settings?error=' + encodeURIComponent(err.message));
    if (!req.file) return res.redirect('/admin/settings?error=Pilih gambar banner');
    const cfg = getConfig();
    const banners = cfg.banners || [];
    banners.push({
      id: 'b' + Date.now(),
      image: '/uploads/banners/' + req.file.filename,
      link: req.body.bannerLinkNew || '',
      title: req.body.bannerTitleNew || 'Banner'
    });
    updateConfig({ banners });
    res.redirect('/admin/settings?success=Banner berhasil ditambahkan');
  });
});

// Hapus banner
router.post('/settings/banner/delete/:id', (req, res) => {
  const cfg = getConfig();
  const banners = (cfg.banners || []).filter(b => b.id !== req.params.id);
  updateConfig({ banners });
  res.redirect('/admin/settings?success=Banner dihapus');
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
