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
  getAllProducts, createProduct, updateProduct, deleteProduct, findProductById, addProductStock, deleteProductStock, getProductCostPrice
} from '../lib/products.js';
import { getAllOrders, findOrderById, createOrder, updateOrderStatus, getStats, getMonthlyRevenueStats } from '../lib/orders.js';
import { notifyOrder } from '../lib/telegram.js';
import { runBackupNow, exportAllData, importAllData } from '../lib/backup.js';
import { getGamePresetList } from '../lib/gamePresets.js';
import { deleteReview, getRecentReviews } from '../lib/reviews.js';
import { checkBalance as checkDigiflazzBalance, searchPriceList as searchDigiflazzPriceList, getPriceList as getDigiflazzPriceList, getPriceListCategories as getDigiflazzCategories, getPriceListBrands as getDigiflazzBrands, getPriceListTypes as getDigiflazzTypes, computeSellPrice } from '../lib/digiflazz.js';
import { getGroupThumbnails, setGroupThumbnail } from '../lib/digiflazzGroups.js';
import { getBalance as getIndosmmBalance, getServiceCategories as getIndosmmCategories, searchServices as searchIndosmmServices, computeSellPrice as computeIndosmmSellPrice, isIndosmmEnabled } from '../lib/indosmm.js';
import {
  getAllFlashSaleItems, getFlashSaleDisplayItems, getFlashSaleSettings, updateFlashSaleSettings,
  addFlashSaleItem, updateFlashSaleItem, deleteFlashSaleItem, reorderFlashSaleItems,
  removeFlashSaleItemsByProductId, utcIsoToWibLocalInput
} from '../lib/flashsale.js';

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
// Panel admin gak boleh keindeks Google sama sekali -- res.locals.noindex dibaca partials/head.ejs
// di SETIAP render admin/*.ejs tanpa perlu tambahin { noindex: true } manual satu-satu.
router.use((req, res, next) => { res.locals.noindex = true; next(); });

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

// ---------- UPLOAD FOTO GRUP DIGIFLAZZ (mis. foto folder "Mobile Legends") ----------
const groupThumbDir = path.join(__dirname, '..', 'public', 'uploads', 'digiflazz-groups');
fs.mkdirSync(groupThumbDir, { recursive: true });

const groupThumbStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, groupThumbDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const unique = Date.now() + '_' + Math.round(Math.random() * 1e6);
    cb(null, `grp_${unique}${ext}`);
  }
});
const uploadGroupThumbRaw = multer({
  storage: groupThumbStorage,
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedExt = /\.(jpe?g|png|webp|gif)$/i;
    const allowedMime = /^image\/(jpeg|png|webp|gif)$/i;
    if (!allowedExt.test(file.originalname) || !allowedMime.test(file.mimetype || '')) {
      return cb(new Error('Format foto harus JPG, PNG, WEBP, atau GIF'));
    }
    cb(null, true);
  }
});
function uploadGroupThumbnail(req, res, next) {
  uploadGroupThumbRaw.single('groupThumbnailFile')(req, res, (err) => {
    if (err) return res.redirect('/admin/digiflazz?error=' + encodeURIComponent(err.message));
    next();
  });
}

// ---------- UPLOAD FOTO CUSTOM FLASH SALE (opsional, override foto produk aslinya) ----------
const flashsaleDir = path.join(__dirname, '..', 'public', 'uploads', 'flashsale');
fs.mkdirSync(flashsaleDir, { recursive: true });

const flashsaleStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, flashsaleDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const unique = Date.now() + '_' + Math.round(Math.random() * 1e6);
    cb(null, `fs_${unique}${ext}`);
  }
});
const uploadFlashsaleRaw = multer({
  storage: flashsaleStorage,
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedExt = /\.(jpe?g|png|webp|gif)$/i;
    const allowedMime = /^image\/(jpeg|png|webp|gif)$/i;
    if (!allowedExt.test(file.originalname) || !allowedMime.test(file.mimetype || '')) {
      return cb(new Error('Format foto harus JPG, PNG, WEBP, atau GIF'));
    }
    cb(null, true);
  }
});
// File foto di form Flash Sale bersifat OPSIONAL (beda dari upload produk/banner yang wajib ada
// filenya sendiri) -- jadi err di sini cuma muncul kalau admin MEMANG upload file tapi formatnya
// salah / kegedean, bukan karena field-nya kosong.
function uploadFlashsaleThumbnail(req, res, next) {
  uploadFlashsaleRaw.single('fsThumbnailFile')(req, res, (err) => {
    if (err) return res.redirect('/admin/flashsale?error=' + encodeURIComponent(err.message));
    next();
  });
}

// ---------- IMPORT DATABASE (upload file .json hasil "Download Backup (JSON)") ----------
// Disimpan di memory (bukan disk) -- filenya cuma dibaca sekali buat JSON.parse lalu dibuang,
// gak perlu nyimpen file mentahnya di server.
const uploadDbImportRaw = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB, longgar buat toko yang datanya udah banyak
  fileFilter: (req, file, cb) => {
    if (!/\.json$/i.test(file.originalname)) {
      return cb(new Error('File harus format .json (hasil "Download Backup (JSON)" di halaman ini)'));
    }
    cb(null, true);
  }
});
function uploadDatabaseFile(req, res, next) {
  uploadDbImportRaw.single('dbFile')(req, res, (err) => {
    if (err) return renderSettings(req, res, { accountError: err.message });
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
  // Cuma produk Stok Manual yang relevan buat peringatan ini — produk Digiflazz dikirim otomatis
  // oleh sistem via API (gak pernah nyimpen stockItems), jadi "stockItems kosong" itu normal buat
  // Digiflazz dan BUKAN berarti kehabisan stok. Tanpa filter ini semua produk Digiflazz bakal selalu
  // nongol di sini padahal gak ada masalah — makanya dipisah sama seperti di /admin/produk & /admin/digiflazz.
  const emptyStockProducts = getAllProducts().filter(p => p.status === 'active' && p.provider !== 'digiflazz' && (!p.stockItems || p.stockItems.length === 0));

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

  // Data grafik penjualan bulanan (12 bulan ke belakang) -- Pendapatan Kotor (omzet) vs
  // Pendapatan Bersih (omzet - modal). Selalu dihitung 12 bulan penuh; toggle 6/12 bulan di
  // halaman tinggal slice(-6) di sisi client, gak perlu request ulang ke server.
  const monthly = getMonthlyRevenueStats(12);

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
    monthlyLabels: JSON.stringify(monthly.map(m => m.label)),
    monthlyGross: JSON.stringify(monthly.map(m => m.gross)),
    monthlyNet: JSON.stringify(monthly.map(m => m.net)),
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
  const { name, category, description, price, stockNote, stockItems, gamePreset, provider, digiflazzSku, digiflazzCustomerNoTemplate, variantGroup, costPrice } = req.body;
  const thumbnail = req.file ? '/uploads/products/' + req.file.filename : '';
  createProduct({ name, category, description, price, stockNote, thumbnail, stockItems, gamePreset, provider, digiflazzSku, digiflazzCustomerNoTemplate, variantGroup, costPrice, customTargetFields: parseCustomTargetFields(req.body) });
  res.redirect('/admin/produk');
});

router.post('/produk/:id', uploadThumbnail, (req, res) => {
  const { name, category, description, price, stockNote, status, stockItems, gamePreset, provider, digiflazzSku, digiflazzCustomerNoTemplate, variantGroup, costPrice } = req.body;
  const existing = findProductById(req.params.id);
  // Produk IndoSMM pakai field "link" TETAP (dikunci sejak import, checkout-nya hard-code baca
  // targetData.link) -- form generik ini gak nampilin editor field custom buat provider ini
  // (lihat views/admin/produk.ejs), tapi kita JUGA harus jaga di sisi server: JANGAN kirim
  // gamePreset/customTargetFields ke updateProduct sama sekali buat produk indosmm, soalnya kalau
  // dikirim (walau kosong) updateProduct bakal nganggep itu perintah "kosongin ulang targetFields"
  // dan bikin field "link"-nya lenyap -- checkout produk ini jadi selalu gagal "link belum diisi".
  const isIndosmmProduct = existing && existing.provider === 'indosmm';
  const partial = {
    name, category, description, price, stockNote, status, stockItems, provider,
    digiflazzSku, digiflazzCustomerNoTemplate, variantGroup, costPrice
  };
  if (!isIndosmmProduct) {
    partial.gamePreset = gamePreset;
    partial.customTargetFields = parseCustomTargetFields(req.body);
  }
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
  removeFlashSaleItemsByProductId(req.params.id);
  res.redirect('/admin/produk');
});

// ---------- FLASH SALE (nav khusus, kelola item + jadwal countdown) ----------

function renderFlashSalePage(req, res, extra = {}) {
  const items = getFlashSaleDisplayItems({ onlyActive: false });
  const usedProductIds = new Set(getAllFlashSaleItems().map(it => it.productId));
  const availableProducts = getAllProducts()
    .filter(p => p.status === 'active' && !usedProductIds.has(p.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  const settings = getFlashSaleSettings();

  // Daftar kategori dari produk yang masih bisa dipilih -- dipakai buat dropdown "Pilih Kategori"
  // di form Tambah Produk (biar admin gak harus scroll 1 dropdown gede isi semua produk campur).
  // Filter kategori->produknya sendiri dikerjakan di sisi client dari atribut data-category tiap
  // <option> (lihat admin/flashsale.ejs), jadi gak perlu kirim salinan data produk lagi sebagai JSON.
  const categories = [...new Set(availableProducts.map(p => p.category || 'Umum'))].sort((a, b) => a.localeCompare(b));

  res.render('admin/flashsale', {
    config: getConfig(),
    items,
    settings,
    endsAtLocal: utcIsoToWibLocalInput(settings.endsAt),
    availableProducts,
    categories,
    error: null,
    success: null,
    ...extra
  });
}

router.get('/flashsale', (req, res) => {
  renderFlashSalePage(req, res);
});

router.post('/flashsale/settings', (req, res) => {
  const { fsEnabled, fsEndsAt, fsTitle } = req.body;
  updateFlashSaleSettings({ enabled: !!fsEnabled, endsAt: fsEndsAt, title: fsTitle });
  renderFlashSalePage(req, res, { success: 'Pengaturan Flash Sale disimpan' });
});

router.post('/flashsale/add', uploadFlashsaleThumbnail, (req, res) => {
  const { productId, flashPrice, badge, quota } = req.body;
  try {
    if (!productId) throw new Error('Pilih produk yang mau dimasukkan Flash Sale');
    if (!flashPrice || Number(flashPrice) <= 0) throw new Error('Isi harga Flash Sale-nya (harus lebih dari 0)');
    const thumbnail = req.file ? '/uploads/flashsale/' + req.file.filename : '';
    addFlashSaleItem({ productId, flashPrice, badge, thumbnail, quota });
    renderFlashSalePage(req, res, { success: 'Produk ditambahkan ke Flash Sale' });
  } catch (err) {
    renderFlashSalePage(req, res, { error: err.message });
  }
});

router.post('/flashsale/:id/update', uploadFlashsaleThumbnail, (req, res) => {
  const { flashPrice, badge, active, quota, resetSold } = req.body;
  const partial = {
    flashPrice,
    badge,
    active: active === 'on' || active === 'true',
    quota,
    resetSold: resetSold === 'on' || resetSold === 'true'
  };
  // Foto cuma diganti kalau admin upload file baru di form edit ini; kalau tidak ada file baru,
  // foto lama (custom atau ikut foto produk) tetap dipakai apa adanya.
  if (req.file) partial.thumbnail = '/uploads/flashsale/' + req.file.filename;
  updateFlashSaleItem(req.params.id, partial);
  renderFlashSalePage(req, res, { success: 'Item Flash Sale diperbarui' });
});

router.post('/flashsale/:id/hapus', (req, res) => {
  deleteFlashSaleItem(req.params.id);
  renderFlashSalePage(req, res, { success: 'Item Flash Sale dihapus' });
});

// Dipanggil lewat fetch() dari drag-and-drop di admin/flashsale.ejs -- express.json() global
// di server.js udah nangkep body JSON-nya, jadi di sini tinggal pakai req.body langsung.
router.post('/flashsale/reorder', (req, res) => {
  const { orderedIds } = req.body;
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    return res.status(400).json({ ok: false, error: 'orderedIds harus array' });
  }
  reorderFlashSaleItems(orderedIds);
  res.json({ ok: true });
});

// ---------- DIGIFLAZZ PRODUCTS (nav khusus, kelola produk auto topup + margin) ----------

function renderDigiflazzPage(req, res, extra = {}) {
  const digiflazzProducts = getAllProducts().filter(p => p.provider === 'digiflazz');
  res.render('admin/digiflazz', {
    config: getConfig(),
    digiflazzProducts,
    groupThumbnails: getGroupThumbnails(),
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

// Daftar kategori Digiflazz (Games, Pulsa, Data, PLN, dst) buat dropdown filter di halaman kelola
router.get('/digiflazz/categories', async (req, res) => {
  try {
    const categories = await getDigiflazzCategories('prepaid');
    res.json({ ok: true, categories });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Level filter ke-2: daftar Brand/Judul (mis. "MOBILE LEGENDS", "TELKOMSEL") dalam 1 kategori.
router.get('/digiflazz/brands', async (req, res) => {
  try {
    const category = req.query.category || '';
    const brands = await getDigiflazzBrands('prepaid', category);
    res.json({ ok: true, brands });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Level filter ke-3: tipe dalam 1 kategori+brand, sudah dipisah "modes" (Umum/Membership/dst)
// dan "regions" (Malaysia/Indonesia/Global/dst) -- lihat classifyPriceListType() di lib/digiflazz.js.
router.get('/digiflazz/types', async (req, res) => {
  try {
    const category = req.query.category || '';
    const brand = req.query.brand || '';
    const types = await getDigiflazzTypes('prepaid', category, brand);
    res.json({ ok: true, ...types });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Cari produk Digiflazz + preview harga jual (base + margin default) buat halaman kelola khusus ini.
// Difilter bertingkat lewat query ?category=&brand=&type=, gak dicampur — biar hasil pencarian fokus
// (mis. cuma "Games" > "Mobile Legends" > "Umum").
router.get('/digiflazz/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    const category = req.query.category || '';
    const brand = req.query.brand || '';
    const type = req.query.type || '';
    const raw = await searchDigiflazzPriceList(q, 'prepaid', category, brand, type);
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

// Import atau update 1 produk Digiflazz jadi produk lokal. Dipakai bareng oleh route form-post
// "/digiflazz/import" (1 produk, tombol "Import" per baris) dan "/digiflazz/import-batch"
// (JSON, banyak produk sekaligus lewat checkbox) supaya logic-nya gak kembar/gampang beda perilaku.
function importOrUpdateDigiflazzProduct({ buyerSkuCode, productName, category, brand, basePrice, gamePreset, marginType, marginValue }) {
  if (!buyerSkuCode || !productName) {
    throw new Error('SKU dan nama produk wajib diisi');
  }
  const existing = getAllProducts().find(p => p.provider === 'digiflazz' && p.digiflazzSku === buyerSkuCode);
  const base = Number(basePrice) || 0;
  const sellPrice = computeSellPrice(base, marginType || null, marginValue !== '' && marginValue != null ? marginValue : null);
  const detectedPreset = gamePreset || guessGamePreset(`${productName} ${brand || ''}`);

  if (existing) {
    updateProduct(existing.id, {
      name: productName,
      price: sellPrice,
      digiflazzBasePrice: base,
      marginType: marginType || '',
      marginValue: marginValue !== '' && marginValue != null ? marginValue : null
    });
    return { created: false, product: existing };
  }

  const product = createProduct({
    name: productName,
    category: category || 'Games',
    description: '',
    price: sellPrice,
    provider: 'digiflazz',
    digiflazzSku: buyerSkuCode,
    digiflazzBasePrice: base,
    variantGroup: brand || '',
    gamePreset: detectedPreset,
    marginType: marginType || '',
    marginValue: marginValue !== '' && marginValue != null ? marginValue : null
  });
  return { created: true, product };
}

// Import/update produk Digiflazz TERPILIH sekaligus (checkbox di UI), masing-masing baris boleh
// bawa nama/judul sendiri (custom title, hasil admin edit di kolom nama sebelum submit) -- gantiin
// "Import Semua Hasil" yang lama (all-or-nothing) jadi lebih presisi: admin pilih baris mana aja
// yang mau ditambah lewat checkbox (termasuk bisa "pilih semua" via checkbox header).
router.post('/digiflazz/import-batch', async (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (items.length === 0) {
      return res.status(400).json({ ok: false, error: 'Tidak ada produk yang dipilih.' });
    }

    let created = 0;
    let updated = 0;
    const errors = [];
    items.forEach(item => {
      try {
        const result = importOrUpdateDigiflazzProduct({
          buyerSkuCode: item.buyerSkuCode,
          productName: (item.productName || '').trim(),
          category: item.category,
          brand: item.brand,
          basePrice: item.basePrice
        });
        if (result.created) created++; else updated++;
      } catch (err) {
        errors.push(`${item.buyerSkuCode || '?'}: ${err.message}`);
      }
    });

    res.json({
      ok: true,
      created,
      updated,
      errors,
      message: `${created} produk baru ditambahkan${updated > 0 ? `, ${updated} produk yang udah ada diperbarui` : ''}.${errors.length > 0 ? ` ${errors.length} baris gagal.` : ''}`
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Simpan margin default global (dipakai semua produk digiflazz yang tidak punya override sendiri)
router.post('/digiflazz/margin', (req, res) => {
  const marginType = req.body.marginType === 'fixed' ? 'fixed' : 'percent';
  const marginValue = Number(req.body.marginValue) || 0;
  updateConfig({ digiflazz: { marginType, marginValue } });

  // Margin default baru harus LANGSUNG kepakai ke harga jual produk yang belum punya margin
  // sendiri -- sebelumnya cuma config-nya yang keupdate, harga produk yang udah keimport tetep
  // pakai margin lama sampai admin klik "Sinkron Semua Harga" (padahal itu wajarnya cuma perlu
  // buat ambil harga MODAL terbaru dari Digiflazz). Di sini kita hitung ulang harga JUAL pakai
  // harga modal yang udah ke-cache lokal (digiflazzBasePrice), jadi gak perlu manggil API
  // Digiflazz lagi -- cepat & gak kena rate limit. computeSellPrice otomatis pakai margin produk
  // masing-masing kalau ada override, atau margin default (yang baru aja disimpan) kalau kosong.
  const products = getAllProducts().filter(p => p.provider === 'digiflazz');
  let updated = 0;
  products.forEach(p => {
    const sellPrice = computeSellPrice(p.digiflazzBasePrice, p.marginType || null, p.marginValue);
    if (sellPrice !== p.price) {
      updateProduct(p.id, { price: sellPrice });
      updated++;
    }
  });

  renderDigiflazzPage(req, res, { success: `Margin default berhasil disimpan. ${updated} produk (tanpa margin sendiri) langsung ikut diperbarui harganya.` });
});

// Import 1 produk dari price list Digiflazz jadi produk lokal (nama produk boleh diedit dulu di
// UI sebelum submit -- itu yang jadi fitur "buat judul sendiri"). Respons JSON (bukan render ulang
// halaman) supaya baris itu aja yang keupdate di UI, gak ilang filter/hasil pencarian yang lagi dibuka.
router.post('/digiflazz/import', (req, res) => {
  try {
    const { buyerSkuCode, productName, category, brand, basePrice, gamePreset, marginType, marginValue } = req.body;
    const result = importOrUpdateDigiflazzProduct({ buyerSkuCode, productName, category, brand, basePrice, gamePreset, marginType, marginValue });

    res.json({
      ok: true,
      created: result.created,
      message: result.created
        ? `Produk "${productName}" berhasil diimport dari Digiflazz.`
        : `SKU ${buyerSkuCode} sudah pernah diimport, harga & data produk diperbarui.`
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
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

// Upload/ganti foto folder buat 1 Grup Varian Digiflazz (mis. "Mobile Legends"), dipakai di kartu
// grup halaman admin ini dan otomatis jadi thumbnail kartu grup di katalog publik.
router.post('/digiflazz/group/:group/thumbnail', uploadGroupThumbnail, (req, res) => {
  try {
    const groupName = decodeURIComponent(req.params.group);
    if (!req.file) return renderDigiflazzPage(req, res, { error: 'Pilih file foto dulu' });
    setGroupThumbnail(groupName, '/uploads/digiflazz-groups/' + req.file.filename);
    renderDigiflazzPage(req, res, { success: `Foto grup "${groupName}" berhasil diperbarui.` });
  } catch (err) {
    renderDigiflazzPage(req, res, { error: err.message });
  }
});

// ---------- INDOSMM (Jasa Sosmed: followers/likes/views dkk) ----------
// Polanya sengaja dibikin mirip halaman Kelola Digiflazz di atas (cari+filter, checkbox multi
// import, margin default & per-produk) biar admin yang udah biasa pakai itu gak perlu belajar
// UI baru lagi. Bedanya cuma filter di sini cuma Kategori + kata kunci (gak ada level Brand/Tipe
// kayak Digiflazz) karena data kategori IndoSMM sudah 1 string gabungan per layanan (mis.
// "Instagram - Followers [Guaranteed]"), gak punya struktur brand/tipe terpisah yang bisa digali.
function renderIndosmmPage(req, res, extra = {}) {
  const indosmmProducts = getAllProducts().filter(p => p.provider === 'indosmm');
  res.render('admin/indosmm', {
    config: getConfig(),
    indosmmProducts,
    error: null,
    success: null,
    ...extra
  });
}

router.get('/indosmm', (req, res) => {
  renderIndosmmPage(req, res);
});

router.get('/indosmm/categories', async (req, res) => {
  try {
    const categories = await getIndosmmCategories();
    res.json({ ok: true, categories });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.get('/indosmm/search', async (req, res) => {
  try {
    const q = req.query.q || '';
    const category = req.query.category || '';
    const raw = await searchIndosmmServices(q, category);
    const linkedIds = new Set(getAllProducts().filter(p => p.provider === 'indosmm').map(p => p.indosmmServiceId));
    const results = raw.map(item => ({
      ...item,
      sellPricePreview: computeIndosmmSellPrice(item.rate, null, null),
      alreadyImported: linkedIds.has(String(item.service))
    }));
    res.json({ ok: true, results });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Import/update 1 produk IndoSMM, dipakai bareng oleh route single & batch (sama kayak
// importOrUpdateDigiflazzProduct di atas) biar logic-nya gak kembar/gampang beda perilaku.
function importOrUpdateIndosmmProduct({ serviceId, productName, category, ratePer1000, min, max, marginType, marginValue }) {
  if (!serviceId || !productName) {
    throw new Error('Service ID dan nama produk wajib diisi');
  }
  const existing = getAllProducts().find(p => p.provider === 'indosmm' && p.indosmmServiceId === String(serviceId));
  const rate = Number(ratePer1000) || 0;
  const sellPrice = computeIndosmmSellPrice(rate, marginType || null, marginValue !== '' && marginValue != null ? marginValue : null);

  if (existing) {
    updateProduct(existing.id, {
      name: productName,
      price: sellPrice,
      indosmmRatePer1000: rate,
      indosmmMin: min,
      indosmmMax: max,
      marginType: marginType || '',
      marginValue: marginValue !== '' && marginValue != null ? marginValue : null
    });
    return { created: false, product: existing };
  }

  const product = createProduct({
    name: productName,
    category: category || 'Jasa Sosmed',
    description: '',
    price: sellPrice,
    provider: 'indosmm',
    indosmmServiceId: String(serviceId),
    indosmmRatePer1000: rate,
    indosmmMin: min,
    indosmmMax: max,
    gamePreset: 'custom',
    customTargetFields: [
      { key: 'link', label: 'Link Target (postingan/profil/video)', placeholder: 'https://...', required: true }
    ],
    marginType: marginType || '',
    marginValue: marginValue !== '' && marginValue != null ? marginValue : null
  });
  return { created: true, product };
}

router.post('/indosmm/import', (req, res) => {
  try {
    const { serviceId, productName, category, ratePer1000, min, max, marginType, marginValue } = req.body;
    const result = importOrUpdateIndosmmProduct({ serviceId, productName, category, ratePer1000, min, max, marginType, marginValue });
    res.json({
      ok: true,
      created: result.created,
      message: result.created
        ? `Produk "${productName}" berhasil diimport dari IndoSMM.`
        : `Service ${serviceId} sudah pernah diimport, harga & data produk diperbarui.`
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/indosmm/import-batch', async (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (items.length === 0) {
      return res.status(400).json({ ok: false, error: 'Tidak ada layanan yang dipilih.' });
    }

    let created = 0;
    let updated = 0;
    const errors = [];
    items.forEach(item => {
      try {
        const result = importOrUpdateIndosmmProduct({
          serviceId: item.serviceId,
          productName: (item.productName || '').trim(),
          category: item.category,
          ratePer1000: item.ratePer1000,
          min: item.min,
          max: item.max
        });
        if (result.created) created++; else updated++;
      } catch (err) {
        errors.push(`${item.serviceId || '?'}: ${err.message}`);
      }
    });

    res.json({
      ok: true,
      created,
      updated,
      errors,
      message: `${created} layanan baru ditambahkan${updated > 0 ? `, ${updated} yang udah ada diperbarui` : ''}.${errors.length > 0 ? ` ${errors.length} baris gagal.` : ''}`
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/indosmm/margin', (req, res) => {
  const { marginType, marginValue } = req.body;
  updateConfig({ indosmm: { marginType, marginValue: marginValue === '' ? null : Number(marginValue) } });
  renderIndosmmPage(req, res, { success: 'Margin default IndoSMM berhasil disimpan.' });
});

router.post('/indosmm/:id/margin', (req, res) => {
  try {
    const { marginType, marginValue } = req.body;
    const product = findProductById(req.params.id);
    if (!product || product.provider !== 'indosmm') throw new Error('Produk tidak ditemukan');
    const sellPrice = computeIndosmmSellPrice(product.indosmmRatePer1000, marginType || null, marginValue !== '' ? marginValue : null);
    updateProduct(product.id, {
      marginType: marginType || '',
      marginValue: marginValue !== '' ? Number(marginValue) : null,
      price: sellPrice
    });
    renderIndosmmPage(req, res, { success: `Margin produk "${product.name}" berhasil diperbarui.` });
  } catch (err) {
    renderIndosmmPage(req, res, { error: err.message });
  }
});

// Lepas produk dari IndoSMM -- jadi produk manual biasa (safety valve kalau admin mau berhenti
// auto-order lewat IndoSMM buat produk ini, tanpa harus hapus produknya).
router.post('/indosmm/:id/unlink', (req, res) => {
  try {
    const product = findProductById(req.params.id);
    if (!product || product.provider !== 'indosmm') throw new Error('Produk tidak ditemukan');
    updateProduct(product.id, { provider: 'manual' });
    renderIndosmmPage(req, res, { success: `Produk "${product.name}" dilepas dari IndoSMM, sekarang jadi produk manual.` });
  } catch (err) {
    renderIndosmmPage(req, res, { error: err.message });
  }
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

  let productName, price, costPrice = 0;
  if (productId) {
    const product = findProductById(productId);
    if (!product) return res.redirect('/admin/order?error=Produk tidak ditemukan');
    productName = product.name;
    price = product.price;
    costPrice = getProductCostPrice(product);
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
    detail: detail || '',
    costPrice
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
function renderUsersPage(req, res, extra = {}) {
  res.render('admin/users', {
    users: getAllUsers(),
    config: getConfig(),
    membershipList: getMembershipList(),
    error: null,
    success: null,
    ...extra
  });
}

router.get('/users', (req, res) => {
  renderUsersPage(req, res);
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

router.post('/users/:id/password', (req, res) => {
  const target = findUserById(req.params.id);
  if (!target) return renderUsersPage(req, res, { error: 'User tidak ditemukan' });

  const { newPassword, newPassword2 } = req.body;
  if (!newPassword || newPassword.length < 6) {
    return renderUsersPage(req, res, { error: `Password baru buat "${target.username}" minimal 6 karakter` });
  }
  if (newPassword !== newPassword2) {
    return renderUsersPage(req, res, { error: `Konfirmasi password baru buat "${target.username}" tidak cocok` });
  }

  setPassword(target.id, newPassword);
  renderUsersPage(req, res, { success: `Password "${target.username}" berhasil diganti.` });
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

// Cek saldo IndoSMM via AJAX, ditampilkan di halaman settings
router.get('/settings/indosmm/saldo', async (req, res) => {
  try {
    const { balance, currency } = await getIndosmmBalance();
    res.json({ ok: true, balance, currency });
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
    indosmmEnabled, indosmmApiKey,
    botToken, chatId, notifyOnDeposit, notifyOnOrder, notifyOnRegister,
    ownerWhatsapp,
    seoSiteUrl, seoMetaDescription, seoMetaKeywords, seoOgImage,
    groupEnabled, groupTitle, groupMessage, groupLink, groupButtonText,
    marqueeEnabled, marqueeText
  } = req.body;

  const categories = (catalogCategories || 'Games')
    .split(',')
    .map(c => c.trim())
    .filter(Boolean);

  updateConfig({
    siteName, siteTagline, ownerWhatsapp,
    seo: {
      siteUrl: String(seoSiteUrl || '').trim().replace(/\/+$/, ''),
      metaDescription: String(seoMetaDescription || '').trim().slice(0, 160),
      metaKeywords: String(seoMetaKeywords || '').trim(),
      ogImage: String(seoOgImage || '').trim()
    },
    catalog: { categories: categories.length > 0 ? categories : ['Games'] },
    qris: { qrString, merchantCode, apiKey, feePercent: parseFloat(feePercent), depositMin: parseInt(depositMin), expiredMinutes: parseInt(expiredMinutes) },
    digiflazz: { enabled: digiflazzEnabled === 'on', username: digiflazzUsername || '', apiKey: digiflazzApiKey || '' },
    indosmm: { enabled: indosmmEnabled === 'on', apiKey: indosmmApiKey || '' },
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

// Download seluruh database (semua tabel) jadi 1 file .json langsung dari browser -- gak butuh
// Telegram diisi dulu kayak backup otomatis di atas. File ini juga yang dipakai buat Import/Pulihkan.
router.get('/settings/backup/export-json', (req, res) => {
  const bundle = exportAllData();
  const cfg = getConfig();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${(cfg.siteName || 'nexorder').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-backup-${stamp}.json`;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(JSON.stringify(bundle, null, 2));
});

// Pulihkan/Import database dari file .json (hasil download di atas, atau backup lama). MENIMPA
// data yang ada sekarang -- makanya importAllData() otomatis nyimpen snapshot data lama dulu
// sebelum ditimpa (lihat lib/backup.js) sebagai jaring pengaman.
router.post('/settings/backup/import', uploadDatabaseFile, (req, res) => {
  try {
    if (!req.file) {
      return renderSettings(req, res, { accountError: 'Pilih dulu file .json backup yang mau dipulihkan' });
    }
    const bundle = JSON.parse(req.file.buffer.toString('utf-8'));
    const result = importAllData(bundle);
    renderSettings(req, res, {
      success: `✅ Database berhasil dipulihkan (${result.restored} tabel: ${result.tableNames.join(', ')}). Data lama otomatis disimpan sebagai cadangan di server sebelum ditimpa.`
    });
  } catch (err) {
    const msg = err instanceof SyntaxError ? 'File bukan JSON yang valid' : err.message;
    renderSettings(req, res, { accountError: 'Gagal memulihkan database: ' + msg });
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
