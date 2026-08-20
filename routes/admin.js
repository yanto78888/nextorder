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
  getAllProducts, createProduct, updateProduct, deleteProduct, findProductById, addProductStock, deleteProductStock, deleteProductsByGroup, renameProductGroup,
  getAllGroupNames, createGroupName, renameGroupName, deleteGroupName,
  getAllTypeNames, createTypeName, renameTypeName, deleteTypeName
} from '../lib/products.js';
import { getAllOrders, findOrderById, updateOrderStatus, getStats, getMonthlyRevenueStats } from '../lib/orders.js';
import { getWeeklyLeaderboard, getMonthlyLeaderboard } from '../lib/leaderboard.js';
import { notifyWithdrawal } from '../lib/telegram.js';
import {
  getAllWithdrawals, findWithdrawalById, updateWithdrawalStatus, getWithdrawSettings
} from '../lib/withdrawal.js';
import { runBackupNow, exportAllData, importAllData } from '../lib/backup.js';
import { getGamePresetList } from '../lib/gamePresets.js';
import { deleteReview, getRecentReviews } from '../lib/reviews.js';
import { checkBalance as checkDigiflazzBalance, searchPriceList as searchDigiflazzPriceList, getPriceList as getDigiflazzPriceList, getPriceListCategories as getDigiflazzCategories, getPriceListBrands as getDigiflazzBrands, getPriceListTypes as getDigiflazzTypes, computeSellPrice } from '../lib/digiflazz.js';
import { getGroupThumbnails, getGroupThumbnail, setGroupThumbnail, deleteGroupThumbnail } from '../lib/digiflazzGroups.js';
import { getBalance as getIndosmmBalance, getServiceCategories as getIndosmmCategories, searchServices as searchIndosmmServices, computeSellPrice as computeIndosmmSellPrice, isIndosmmEnabled } from '../lib/indosmm.js';
import {
  isHerosmsEnabled, getBalance as getHerosmsBalance, getServicesList as getHerosmsServicesList,
  getCountries as getHerosmsCountries, getPrices as getHerosmsPrices, computeSellPrice as computeHerosmsSellPrice
} from '../lib/herosms.js';
import { sendTestEmail } from '../lib/mailer.js';
import {
  getAllFlashSaleItems, getFlashSaleDisplayItems, getFlashSaleSettings, updateFlashSaleSettings,
  addFlashSaleItem, updateFlashSaleItem, deleteFlashSaleItem, reorderFlashSaleItems,
  removeFlashSaleItemsByProductId, utcIsoToWibLocalInput
} from '../lib/flashsale.js';
import { getAllPromoCodes, createPromoCode, deletePromoCode } from '../lib/promocodes.js';

// Tebak gamePreset yang cocok dari nama/brand produk Digiflazz, biar field ID Tujuan
// (termasuk dropdown Server buat game kayak Genshin Impact/Wuthering Waves) otomatis
// kepasang benar pas import, gak perlu diatur manual satu-satu di halaman produk.
//
// Kalau nama game gak dikenali sistem, fallback ke preset "id_only" (1 field User ID
// generik) — BUKAN dikosongkan. Auto top up Digiflazz butuh minimal 1 ID buat dikirim
// sebagai customer_no, jadi produk tanpa field ID Tujuan sama sekali bakal gagal saat
// dibeli. Admin tetap bisa ganti manual ke preset lain / custom di halaman Kelola Produk
// kalau ternyata game itu butuh 2 field (ID + Server) yang belum ada presetnya.
// category dicek DULUAN (lebih diandalkan daripada nebak dari nama produk) -- kalau kategori
// Digiflazz-nya "Pulsa" atau "Data" (paket data internet), targetnya sudah pasti NOMOR HP,
// bukan User ID/Zone ID kayak game, jadi langsung pakai preset phone_number.
function guessGamePreset(text, category) {
  const cat = String(category || '').toLowerCase();
  if (cat.includes('pulsa') || cat.includes('data')) return 'phone_number';

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

// ---------- UPLOAD GAMBAR OG (SEO Open Graph) ----------
// Disimpan di /public/uploads/seo/ -- path ini yang disimpan ke config.seo.ogImage dan dipakai
// di <meta og:image> & di template email OTP (lib/mailer.js) buat nampilin logo/gambar brand.
const ogImageDir = path.join(__dirname, '..', 'public', 'uploads', 'seo');
fs.mkdirSync(ogImageDir, { recursive: true });
const ogImageStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ogImageDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `og-image${ext}`); // nama tetap (bukan random) supaya URL-nya gak berubah tiap kali upload ulang
  }
});
const uploadOgImage = multer({
  storage: ogImageStorage,
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(jpe?g|png|webp)$/i.test(file.originalname) && /^image\/(jpeg|png|webp)$/i.test(file.mimetype || '');
    ok ? cb(null, true) : cb(new Error('Format OG Image harus JPG, PNG, atau WEBP'));
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
  // Cuma produk Stok Manual yang relevan buat peringatan ini — produk Digiflazz & Jasa Sosmed
  // (IndoSMM) dikirim otomatis oleh sistem lewat API provider (gak pernah nyimpen stockItems),
  // jadi "stockItems kosong" itu normal buat keduanya dan BUKAN berarti kehabisan stok. Dulu di
  // sini cuma provider !== 'digiflazz' yang di-exclude, providernya indosmm kelewatan gak
  // ke-exclude juga -- akibatnya ratusan layanan Jasa Sosmed ikut numpuk di alert "stok kosong"
  // dashboard, padahal bukan produk stok sama sekali. Sekarang pakai whitelist provider === 'manual'
  // langsung, biar kalau nanti ada tipe provider baru lagi gak keulang bug yang sama.
  const emptyStockProducts = getAllProducts().filter(p => p.status === 'active' && p.provider === 'manual' && (!p.stockItems || p.stockItems.length === 0));

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
  const { name, category, description, price, stockNote, stockItems, gamePreset, provider, digiflazzSku, digiflazzCustomerNoTemplate, variantGroup, variantType, costPrice, usageInstructions } = req.body;
  const thumbnail = req.file ? '/uploads/products/' + req.file.filename : '';
  createProduct({ name, category, description, price, stockNote, thumbnail, stockItems, gamePreset, provider, digiflazzSku, digiflazzCustomerNoTemplate, variantGroup, variantType, costPrice, usageInstructions, customTargetFields: parseCustomTargetFields(req.body) });
  res.redirect('/admin/produk');
});

router.post('/produk/:id', uploadThumbnail, (req, res) => {
  const { name, category, description, price, stockNote, status, stockItems, gamePreset, provider, digiflazzSku, digiflazzCustomerNoTemplate, variantGroup, variantType, costPrice, usageInstructions } = req.body;
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
    digiflazzSku, digiflazzCustomerNoTemplate, variantGroup, variantType, costPrice, usageInstructions
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

// ---------- KODE PROMO ----------

function renderPromoPage(req, res, extra = {}) {
  const items = getAllPromoCodes().slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.render('admin/promo', {
    config: getConfig(),
    items,
    error: null,
    success: null,
    ...extra
  });
}

router.get('/promo', (req, res) => {
  renderPromoPage(req, res);
});

router.post('/promo/add', (req, res) => {
  const { code, discountPercent, minPurchase, maxUses } = req.body;
  try {
    const promo = createPromoCode({ code, discountPercent, minPurchase, maxUses });
    renderPromoPage(req, res, { success: `Kode promo "${promo.code}" dibuat` });
  } catch (err) {
    renderPromoPage(req, res, { error: err.message });
  }
});

router.post('/promo/:id/hapus', (req, res) => {
  deletePromoCode(req.params.id);
  renderPromoPage(req, res, { success: 'Kode promo dihapus' });
});

// ---------- DIGIFLAZZ PRODUCTS (nav khusus, kelola produk auto topup + margin) ----------

function renderDigiflazzPage(req, res, extra = {}) {
  const digiflazzProducts = getAllProducts().filter(p => p.provider === 'digiflazz');
  res.render('admin/digiflazz', {
    config: getConfig(),
    digiflazzProducts,
    groupThumbnails: getGroupThumbnails(),
    groupNames: getAllGroupNames(),
    typeNames: getAllTypeNames(),
    searchResults: [],
    searchQuery: '',
    error: null,
    success: null,
    ...extra
  });
}

router.get('/digiflazz', (req, res) => {
  renderDigiflazzPage(req, res, {
    error: req.query.error || null,
    success: req.query.success || null
  });
});

// ---- Kelola daftar Grup & Tipe Nominal tersimpan (dropdown sumber pas nambah/import produk) ----
router.post('/digiflazz/grup/tambah', (req, res) => {
  try {
    const g = createGroupName(req.body.name);
    renderDigiflazzPage(req, res, { success: `Grup "${g.name}" dibuat. Sekarang bisa dipilih pas nambah/import produk.` });
  } catch (err) {
    renderDigiflazzPage(req, res, { error: err.message });
  }
});

router.post('/digiflazz/grup/:id/edit', (req, res) => {
  try {
    const r = renameGroupName(req.params.id, req.body.name, 'digiflazz');
    renderDigiflazzPage(req, res, {
      success: `Grup "${r.oldName}" diganti nama jadi "${r.newName}"${r.affectedCount > 0 ? ` (${r.affectedCount} produk ikut pindah)` : ''}.`
    });
  } catch (err) {
    renderDigiflazzPage(req, res, { error: err.message });
  }
});

router.post('/digiflazz/grup/:id/hapus', (req, res) => {
  try {
    const r = deleteGroupName(req.params.id, 'digiflazz');
    r.deletedProducts.forEach(p => removeFlashSaleItemsByProductId(p.id));
    deleteGroupThumbnail(r.group.name);
    renderDigiflazzPage(req, res, {
      success: `Grup "${r.group.name}" dihapus${r.deletedProducts.length > 0 ? ` (${r.deletedProducts.length} produk ikut terhapus)` : ''}.`
    });
  } catch (err) {
    renderDigiflazzPage(req, res, { error: err.message });
  }
});

router.post('/digiflazz/tipe/tambah', (req, res) => {
  try {
    const t = createTypeName(req.body.name);
    renderDigiflazzPage(req, res, { success: `Tipe "${t.name}" dibuat. Sekarang bisa dipilih pas nambah/import produk.` });
  } catch (err) {
    renderDigiflazzPage(req, res, { error: err.message });
  }
});

router.post('/digiflazz/tipe/:id/edit', (req, res) => {
  try {
    const r = renameTypeName(req.params.id, req.body.name, 'digiflazz');
    renderDigiflazzPage(req, res, {
      success: `Tipe "${r.oldName}" diganti nama jadi "${r.newName}"${r.affectedCount > 0 ? ` (${r.affectedCount} produk ikut diperbarui)` : ''}.`
    });
  } catch (err) {
    renderDigiflazzPage(req, res, { error: err.message });
  }
});

router.post('/digiflazz/tipe/:id/hapus', (req, res) => {
  try {
    const t = deleteTypeName(req.params.id);
    renderDigiflazzPage(req, res, { success: `Tipe "${t.name}" dihapus dari daftar pilihan.` });
  } catch (err) {
    renderDigiflazzPage(req, res, { error: err.message });
  }
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
function importOrUpdateDigiflazzProduct({ buyerSkuCode, productName, category, brand, basePrice, gamePreset, marginType, marginValue, variantGroup, variantType }) {
  if (!buyerSkuCode || !productName) {
    throw new Error('SKU dan nama produk wajib diisi');
  }
  const existing = getAllProducts().find(p => p.provider === 'digiflazz' && p.digiflazzSku === buyerSkuCode);
  const base = Number(basePrice) || 0;
  const sellPrice = computeSellPrice(base, marginType || null, marginValue !== '' && marginValue != null ? marginValue : null);
  const detectedPreset = gamePreset || guessGamePreset(`${productName} ${brand || ''}`, category);
  // Grup: kalau admin PILIH grup dari dropdown (halaman "Kelola Grup & Tipe"), pakai itu -- kalau
  // dibiarkan default/kosong, jatuh balik ke nama brand mentah dari Digiflazz (perilaku lama,
  // tetap dipertahankan biar import cepat tanpa harus pilih grup manual tiap kali kalau gak perlu).
  const resolvedGroup = (variantGroup && String(variantGroup).trim()) || brand || '';
  const resolvedType = (variantType && String(variantType).trim()) || '';

  if (existing) {
    updateProduct(existing.id, {
      name: productName,
      price: sellPrice,
      digiflazzBasePrice: base,
      marginType: marginType || '',
      marginValue: marginValue !== '' && marginValue != null ? marginValue : null,
      variantGroup: resolvedGroup,
      variantType: resolvedType
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
    variantGroup: resolvedGroup,
    variantType: resolvedType,
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
    // Grup & Tipe dipilih SEKALI di toolbar buat seluruh batch ini (bukan per-baris) -- sesuai
    // alur kerja wajarnya: admin lagi import 1 baris produk dari game/kategori yang sama,
    // jadi masuk akal semuanya ditandai grup/tipe yang sama juga.
    const batchGroup = req.body.variantGroup || '';
    const batchType = req.body.variantType || '';

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
          basePrice: item.basePrice,
          variantGroup: batchGroup,
          variantType: batchType
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
    const { buyerSkuCode, productName, category, brand, basePrice, gamePreset, marginType, marginValue, variantGroup, variantType } = req.body;
    const result = importOrUpdateDigiflazzProduct({ buyerSkuCode, productName, category, brand, basePrice, gamePreset, marginType, marginValue, variantGroup, variantType });

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

// Lepas SEMUA produk Digiflazz sekaligus jadi manual -- biar admin gak perlu klik "Lepas" satu-satu
// per produk kalau mau berhenti total dari auto top up Digiflazz. Stok manual masing-masing produk
// tetap kosong (sama kayak lepas 1x1), admin isi stoknya sendiri lewat halaman Kelola Produk kalau perlu.
router.post('/digiflazz/unlink-all', (req, res) => {
  const products = getAllProducts().filter(p => p.provider === 'digiflazz');
  products.forEach(p => updateProduct(p.id, { provider: 'manual' }));
  renderDigiflazzPage(req, res, {
    success: products.length > 0
      ? `${products.length} produk berhasil dilepas dari Digiflazz, sekarang jadi produk stok manual.`
      : 'Tidak ada produk Digiflazz yang terhubung.'
  });
});

// Lepas produk Digiflazz yang DICENTANG doang (bukan semua, bukan satu-satu) -- id dikirim
// sebagai hidden input 'ids' (bisa banyak) lewat form yang disuntik JS di sisi client.
router.post('/digiflazz/unlink-selected', (req, res) => {
  const rawIds = req.body.ids;
  const ids = Array.isArray(rawIds) ? rawIds : (rawIds ? [rawIds] : []);
  // Jaga-jaga: cuma proses id yang beneran produk Digiflazz, biar gak bisa disalahgunakan
  // buat "lepas" produk manual/indosmm lewat endpoint ini.
  const products = getAllProducts().filter(p => ids.includes(p.id) && p.provider === 'digiflazz');
  products.forEach(p => updateProduct(p.id, { provider: 'manual' }));
  renderDigiflazzPage(req, res, {
    success: products.length > 0
      ? `${products.length} produk terpilih berhasil dilepas dari Digiflazz, sekarang jadi produk stok manual.`
      : 'Tidak ada produk yang dicentang.'
  });
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

// Hapus SATU GRUP Digiflazz sekaligus (semua nominal di dalamnya), bukan satu-satu manual --
// dipakai tombol "Hapus Grup" di kartu folder halaman ini. Ikut bersihin: item Flash Sale yang
// masih nunjuk ke produk-produk itu (biar gak jadi data nyangkut), dan foto grupnya.
router.post('/digiflazz/group/:group/hapus', (req, res) => {
  const groupName = decodeURIComponent(req.params.group);
  try {
    const deleted = deleteProductsByGroup(groupName, 'digiflazz');
    deleted.forEach(p => removeFlashSaleItemsByProductId(p.id));
    deleteGroupThumbnail(groupName);
    renderDigiflazzPage(req, res, { success: `Grup "${groupName}" dihapus (${deleted.length} produk).` });
  } catch (err) {
    renderDigiflazzPage(req, res, { error: err.message });
  }
});

// Masukkan/pindahkan produk-produk TERPILIH (checkbox) dalam 1 grup ke Tipe Nominal (tab)
// tertentu sekaligus -- dipakai toolbar "Masukkan ke Tab" di tiap kartu grup halaman ini.
// Tab kosong ('') berarti "Tanpa Tab" (otomatis jatuh ke bucket "Reguler" default di tampilan
// publik & di kartu grup ini, sama kayak logic showVariantTypeTabs di routes/user.js). Cuma
// produk Digiflazz yang beneran anggota grup ini yang diproses, biar id nyasar dari grup lain
// gak bisa nyelonong lewat form yang dimanipulasi.
router.post('/digiflazz/group/:group/set-type', (req, res) => {
  const groupName = decodeURIComponent(req.params.group);
  const rawIds = req.body.ids;
  const ids = Array.isArray(rawIds) ? rawIds : (rawIds ? [rawIds] : []);
  const variantType = String(req.body.variantType || '').trim();
  try {
    const products = getAllProducts().filter(p => ids.includes(p.id) && p.provider === 'digiflazz' && p.variantGroup === groupName);
    products.forEach(p => updateProduct(p.id, { variantType }));
    renderDigiflazzPage(req, res, {
      success: products.length > 0
        ? `${products.length} produk di grup "${groupName}" dimasukkan ke tab "${variantType || 'Tanpa Tab'}".`
        : 'Tidak ada produk yang dicentang.'
    });
  } catch (err) {
    renderDigiflazzPage(req, res, { error: err.message });
  }
});

// Ganti nama tampilan 1 grup (mis. brand mentah dari Digiflazz "ML" -> nama custom "Mobile
// Legends: Bang Bang") -- semua nominal di dalamnya ikut pindah otomatis. Foto folder yang udah
// di-upload (kalau ada) ikut dipindah ke nama baru juga, biar gak "ilang" gara-gara nyangkut di
// nama lama yang udah gak dipakai produk manapun lagi.
router.post('/digiflazz/group/:group/rename', (req, res) => {
  const oldName = decodeURIComponent(req.params.group);
  const newName = String(req.body.newName || '').trim();
  try {
    const count = renameProductGroup(oldName, newName, 'digiflazz');
    if (count > 0) {
      const thumb = getGroupThumbnail(oldName);
      if (thumb) {
        setGroupThumbnail(newName, thumb);
        deleteGroupThumbnail(oldName);
      }
    }
    renderDigiflazzPage(req, res, { success: `Grup "${oldName}" diganti nama jadi "${newName}" (${count} produk).` });
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
function importOrUpdateIndosmmProduct({ serviceId, productName, category, ratePer1000, min, max, description, marginType, marginValue }) {
  if (!serviceId || !productName) {
    throw new Error('Service ID dan nama produk wajib diisi');
  }
  const existing = getAllProducts().find(p => p.provider === 'indosmm' && p.indosmmServiceId === String(serviceId));
  const rate = Number(ratePer1000) || 0;
  const sellPrice = computeIndosmmSellPrice(rate, marginType || null, marginValue !== '' && marginValue != null ? marginValue : null);
  const desc = String(description || '').trim();

  if (existing) {
    updateProduct(existing.id, {
      name: productName,
      price: sellPrice,
      indosmmRatePer1000: rate,
      indosmmMin: min,
      indosmmMax: max,
      // description CUMA ditimpa kalau ada isinya dari IndoSMM -- biar deskripsi custom yang
      // sempat diedit admin lewat /admin/produk gak ke-timpa ke kosong pas re-import/update rate.
      ...(desc ? { description: desc } : {}),
      marginType: marginType || '',
      marginValue: marginValue !== '' && marginValue != null ? marginValue : null
    });
    return { created: false, product: existing };
  }

  const product = createProduct({
    name: productName,
    category: category || 'Jasa Sosmed',
    description: desc,
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
    const { serviceId, productName, category, ratePer1000, min, max, description, marginType, marginValue } = req.body;
    const result = importOrUpdateIndosmmProduct({ serviceId, productName, category, ratePer1000, min, max, description, marginType, marginValue });
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
          max: item.max,
          description: item.description
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

// Lepas SEMUA layanan IndoSMM sekaligus jadi manual -- biar admin gak perlu klik "Lepas" satu-satu
// per layanan kalau mau berhenti total dari auto-order Jasa Sosmed.
router.post('/indosmm/unlink-all', (req, res) => {
  const products = getAllProducts().filter(p => p.provider === 'indosmm');
  products.forEach(p => updateProduct(p.id, { provider: 'manual' }));
  renderIndosmmPage(req, res, {
    success: products.length > 0
      ? `${products.length} layanan berhasil dilepas dari IndoSMM, sekarang jadi produk manual.`
      : 'Tidak ada layanan IndoSMM yang terhubung.'
  });
});

// Lepas layanan IndoSMM yang DICENTANG doang (bukan semua, bukan satu-satu)
router.post('/indosmm/unlink-selected', (req, res) => {
  const rawIds = req.body.ids;
  const ids = Array.isArray(rawIds) ? rawIds : (rawIds ? [rawIds] : []);
  const products = getAllProducts().filter(p => ids.includes(p.id) && p.provider === 'indosmm');
  products.forEach(p => updateProduct(p.id, { provider: 'manual' }));
  renderIndosmmPage(req, res, {
    success: products.length > 0
      ? `${products.length} layanan terpilih berhasil dilepas dari IndoSMM, sekarang jadi produk manual.`
      : 'Tidak ada layanan yang dicentang.'
  });
});

// ---------- OTP (HeroSMS: nomor virtual terima SMS) ----------
function renderOtpPage(req, res, extra = {}) {
  const otpProducts = getAllProducts().filter(p => p.provider === 'otp');
  res.render('admin/otp', {
    otpProducts,
    config: getConfig(),
    success: null,
    error: null,
    ...extra
  });
}

router.get('/otp', (req, res) => {
  renderOtpPage(req, res);
});

router.get('/otp/services', async (req, res) => {
  try {
    const services = await getHerosmsServicesList();
    res.json({ ok: true, services });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.get('/otp/countries', async (req, res) => {
  try {
    const countries = await getHerosmsCountries();
    res.json({ ok: true, countries });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Cek harga live 1 kombinasi service+country sebelum diimport jadi produk (preview harga jual)
router.get('/otp/price', async (req, res) => {
  try {
    const { service, country } = req.query;
    if (!service || !country) throw new Error('Pilih service dan country dulu');
    const rows = await getHerosmsPrices(service, country);
    const match = rows.find(r => String(r.countryId) === String(country) && r.serviceCode === service) || rows[0];
    if (!match) return res.json({ ok: true, found: false });
    res.json({
      ok: true,
      found: true,
      cost: match.cost,
      count: match.count,
      sellPricePreview: computeHerosmsSellPrice(match.cost, null, null)
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/otp/import', (req, res) => {
  try {
    const { serviceCode, serviceName, countryId, countryName, productName, category, baseCostRub, marginType, marginValue } = req.body;
    if (!serviceCode || !countryId || !productName) throw new Error('Service, negara, dan nama produk wajib diisi');

    const existing = getAllProducts().find(
      p => p.provider === 'otp' && p.otpServiceCode === serviceCode && p.otpCountryId === String(countryId)
    );
    const cost = Number(baseCostRub) || 0;
    const sellPrice = computeHerosmsSellPrice(cost, marginType || null, marginValue !== '' && marginValue != null ? marginValue : null);

    if (existing) {
      updateProduct(existing.id, {
        name: productName,
        price: sellPrice,
        otpBaseCostRub: cost,
        marginType: marginType || '',
        marginValue: marginValue !== '' && marginValue != null ? Number(marginValue) : null
      });
      return res.json({ ok: true, created: false, message: `Produk "${productName}" sudah ada, harga diperbarui.` });
    }

    createProduct({
      name: productName,
      category: category || 'OTP',
      price: sellPrice,
      provider: 'otp',
      otpServiceCode: serviceCode,
      otpServiceName: serviceName || serviceCode,
      otpCountryId: String(countryId),
      otpCountryName: countryName || '',
      otpBaseCostRub: cost,
      marginType: marginType || '',
      marginValue: marginValue !== '' && marginValue != null ? Number(marginValue) : null
    });
    res.json({ ok: true, created: true, message: `Produk OTP "${productName}" berhasil ditambahkan.` });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Bulk import: tambah SEMUA kombinasi service yang dipilih × semua negara yang dipilih sekaligus
// (atau semua service × 1 negara, atau 1 service × semua negara) -- biar admin gak perlu klik
// 1 per 1 kalau mau import banyak sekaligus. Harga diambil live dari HeroSMS per kombinasi.
// Kombinasi yang stocknya 0 (count === 0) DILEWATI otomatis biar gak bikin produk zombie.
router.post('/otp/import-bulk', async (req, res) => {
  try {
    const { serviceCodes, countryIds, category, marginType, marginValue } = req.body;
    // serviceCodes & countryIds bisa array (dari checkbox) atau string tunggal
    const svcList = [].concat(serviceCodes || []).filter(Boolean);
    const ctyList = [].concat(countryIds || []).filter(Boolean);
    if (!svcList.length || !ctyList.length) throw new Error('Pilih minimal 1 layanan dan 1 negara');

    const [services, countries, allPrices] = await Promise.all([
      getHerosmsServicesList(),
      getHerosmsCountries(),
      getHerosmsPrices() // tanpa filter = ambil semua harga sekaligus (lebih efisien dari loop per-kombinasi)
    ]);

    const svcMap = Object.fromEntries(services.map(s => [s.code, s.name]));
    const ctyMap = Object.fromEntries(countries.map(c => [String(c.id), c.eng || c.name]));

    let created = 0, updated = 0, skipped = 0;
    const errors = [];

    for (const svc of svcList) {
      for (const cty of ctyList) {
        try {
          const match = allPrices.find(p =>
            String(p.serviceCode) === String(svc) && String(p.countryId) === String(cty)
          );
          // Lewati kalau harga tidak ditemukan atau stok 0
          if (!match || Number(match.count) === 0) { skipped++; continue; }

          const cost = Number(match.cost) || 0;
          const sellPrice = computeHerosmsSellPrice(cost, marginType || null, marginValue !== '' && marginValue != null ? marginValue : null);
          const svcName = svcMap[svc] || svc;
          const ctyName = ctyMap[String(cty)] || cty;
          const productName = `OTP ${svcName} - ${ctyName}`;

          const existing = getAllProducts().find(
            p => p.provider === 'otp' && p.otpServiceCode === svc && p.otpCountryId === String(cty)
          );

          if (existing) {
            updateProduct(existing.id, { name: productName, price: sellPrice, otpBaseCostRub: cost, marginType: marginType || '', marginValue: marginValue !== '' && marginValue != null ? Number(marginValue) : null });
            updated++;
          } else {
            createProduct({ name: productName, category: category || 'OTP', price: sellPrice, provider: 'otp', otpServiceCode: svc, otpServiceName: svcName, otpCountryId: String(cty), otpCountryName: ctyName, otpBaseCostRub: cost, marginType: marginType || '', marginValue: marginValue !== '' && marginValue != null ? Number(marginValue) : null });
            created++;
          }
        } catch (err) {
          errors.push(`${svc}×${cty}: ${err.message}`);
        }
      }
    }

    res.json({ ok: true, created, updated, skipped, errors, message: `Selesai: ${created} ditambah, ${updated} diperbarui, ${skipped} dilewati (stok 0/harga tidak ada)` });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/otp/margin', (req, res) => {
  const { marginType, marginValue } = req.body;
  updateConfig({ herosms: { marginType, marginValue: marginValue === '' ? null : Number(marginValue) } });
  renderOtpPage(req, res, { success: 'Margin default OTP berhasil disimpan.' });
});

router.post('/otp/:id/margin', (req, res) => {
  const { marginType, marginValue } = req.body;
  const product = findProductById(req.params.id);
  if (!product) return renderOtpPage(req, res, { error: 'Produk tidak ditemukan' });
  const sellPrice = computeHerosmsSellPrice(product.otpBaseCostRub, marginType || null, marginValue !== '' && marginValue != null ? marginValue : null);
  updateProduct(product.id, {
    price: sellPrice,
    marginType: marginType || '',
    marginValue: marginValue !== '' && marginValue != null ? Number(marginValue) : null
  });
  renderOtpPage(req, res, { success: `Margin produk "${product.name}" disimpan.` });
});

// Sinkron ulang harga SEMUA produk OTP dari harga live HeroSMS terbaru (mirip /digiflazz/sync-all)
router.post('/otp/sync-all', async (req, res) => {
  const products = getAllProducts().filter(p => p.provider === 'otp');
  let updated = 0;
  const errors = [];
  for (const p of products) {
    try {
      const rows = await getHerosmsPrices(p.otpServiceCode, p.otpCountryId);
      const match = rows.find(r => String(r.countryId) === String(p.otpCountryId) && r.serviceCode === p.otpServiceCode) || rows[0];
      if (!match) { errors.push(`${p.name}: harga tidak ditemukan`); continue; }
      const sellPrice = computeHerosmsSellPrice(match.cost, p.marginType || null, p.marginValue ?? null);
      updateProduct(p.id, { price: sellPrice, otpBaseCostRub: match.cost });
      updated++;
    } catch (err) {
      errors.push(`${p.name}: ${err.message}`);
    }
  }
  renderOtpPage(req, res, {
    success: `${updated} dari ${products.length} produk OTP berhasil disinkron.`,
    error: errors.length > 0 ? errors.join('; ') : null
  });
});

router.post('/otp/:id/unlink', (req, res) => {
  updateProduct(req.params.id, { provider: 'manual' });
  renderOtpPage(req, res, { success: 'Produk dilepas dari OTP, jadi produk manual biasa.' });
});

// ---------- ORDER ----------
router.get('/order', (req, res) => {
  const orders = getAllOrders().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.render('admin/order', {
    orders, config: getConfig(),
    success: req.query.success || null,
    error: req.query.error || null
  });
});

// BUG: handler ini async tapi TIDAK ada try/catch -- updateOrderStatus() throw Error('Order tidak
// ditemukan') kalau id-nya gak match (mis. order sudah kehapus, atau double-submit form yang telat).
// Di async function, throw sinkron kayak gitu jadi PROMISE REJECTED, bukan exception biasa -- Express
// 4 gak otomatis nangkep itu, jadinya unhandled rejection. Sejak Node 15+, unhandled rejection bikin
// SELURUH PROSES CRASH (sudah dicoba reproduksi manual, proses langsung mati kena 1 request ini doang)
// -- bukan cuma request itu yang gagal, tapi WHOLE SITE down buat semua user sampai PM2 restart.
router.post('/order/:id/status', async (req, res) => {
  try {
    const { status, detail } = req.body;
    updateOrderStatus(req.params.id, status, detail);
    res.redirect('/admin/order');
  } catch (err) {
    res.redirect('/admin/order?error=' + encodeURIComponent(err.message));
  }
});

// ---------- PENARIKAN SALDO ----------
router.get('/penarikan', (req, res) => {
  const withdrawals = getAllWithdrawals().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.render('admin/penarikan', {
    withdrawals,
    settings: getWithdrawSettings(),
    config: getConfig(),
    success: req.query.success || null,
    error: req.query.error || null
  });
});

router.post('/penarikan/settings', (req, res) => {
  const enabled = req.body.enabled === 'on';
  const min = parseInt(req.body.min) || 20000;
  updateConfig({ withdraw: { enabled, min } });
  res.redirect('/admin/penarikan?success=' + encodeURIComponent('Pengaturan penarikan saldo disimpan'));
});

router.post('/penarikan/:id/selesai', (req, res) => {
  const w = findWithdrawalById(req.params.id);
  if (!w) return res.redirect('/admin/penarikan?error=' + encodeURIComponent('Pengajuan tidak ditemukan'));
  if (w.status !== 'pending') return res.redirect('/admin/penarikan?error=' + encodeURIComponent('Pengajuan ini sudah diproses sebelumnya'));
  updateWithdrawalStatus(w.id, 'completed', req.body.adminNote || '');
  res.redirect('/admin/penarikan?success=' + encodeURIComponent(`Penarikan ${w.id} ditandai selesai`));
});

// Tolak pengajuan -- saldo yang tadi dipotong pas pengajuan dibuat DIKEMBALIKAN penuh ke user di sini.
router.post('/penarikan/:id/tolak', (req, res) => {
  const w = findWithdrawalById(req.params.id);
  if (!w) return res.redirect('/admin/penarikan?error=' + encodeURIComponent('Pengajuan tidak ditemukan'));
  if (w.status !== 'pending') return res.redirect('/admin/penarikan?error=' + encodeURIComponent('Pengajuan ini sudah diproses sebelumnya'));
  const note = req.body.adminNote || 'Ditolak admin';
  updateWithdrawalStatus(w.id, 'rejected', note);
  addSaldo(w.userId, w.amount, {
    reason: `Refund penarikan saldo ditolak: ${note}`,
    refType: 'withdrawal',
    refId: w.id
  });
  res.redirect('/admin/penarikan?success=' + encodeURIComponent(`Penarikan ${w.id} ditolak, saldo user dikembalikan`));
});

// ---------- LIVE TRANSAKSI API ----------
// Dashboard buat pantau transaksi yang masuk lewat API reseller (routes/api.js, order.source
// === 'api') secara live. Halaman pertama render langsung isinya (biar first paint gak nunggu
// JS), lalu JS di halaman polling endpoint /data di bawah tiap beberapa detik buat data terbaru
// -- dan endpoint yang SAMA juga dipakai buat search (server-side, nyari ke SEMUA histori order
// API, bukan cuma yang lagi ke-load di layar).
function getLiveApiTransactions(q = '') {
  const query = String(q || '').trim().toLowerCase();
  let list = getAllOrders().filter(o => o.source === 'api');
  if (query) {
    list = list.filter(o =>
      o.id.toLowerCase().includes(query) ||
      (o.username || '').toLowerCase().includes(query) ||
      (o.productName || '').toLowerCase().includes(query) ||
      (o.apiRefId || '').toLowerCase().includes(query) ||
      (o.providerRefId || '').toLowerCase().includes(query)
    );
  }
  return list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 200);
}

router.get('/live-transaksi', (req, res) => {
  res.render('admin/live-transaksi', {
    orders: getLiveApiTransactions(req.query.q),
    q: req.query.q || '',
    config: getConfig()
  });
});

router.get('/live-transaksi/data', (req, res) => {
  res.json({ success: true, data: getLiveApiTransactions(req.query.q) });
});

// ---------- LEADERBOARD & REWARD ----------
router.get('/leaderboard', (req, res) => {
  res.render('admin/leaderboard', {
    weekly: getWeeklyLeaderboard(10),
    monthly: getMonthlyLeaderboard(10),
    config: getConfig(),
    success: req.query.success || null,
    error: req.query.error || null
  });
});

router.post('/leaderboard/reward', (req, res) => {
  const { userId, username, period } = req.body;
  const amount = parseInt(req.body.amount);
  if (!userId || !amount || amount <= 0) {
    return res.redirect('/admin/leaderboard?error=' + encodeURIComponent('Data reward tidak valid'));
  }
  const periodLabel = period === 'monthly' ? 'Bulanan' : 'Mingguan';
  addSaldo(userId, amount, {
    reason: `Reward Leaderboard ${periodLabel} dari admin`,
    refType: 'reward'
  });
  res.redirect('/admin/leaderboard?success=' + encodeURIComponent(`Reward Rp ${amount.toLocaleString('id-ID')} berhasil dikirim ke ${username}`));
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
  if (amount) {
    addSaldo(req.params.id, amount, {
      reason: `Penyesuaian saldo oleh admin (${req.session.user.username})`,
      refType: 'admin',
      refId: req.session.user.id
    });
  }
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

// Cek saldo HeroSMS via AJAX, ditampilkan di halaman settings
router.get('/settings/herosms/saldo', async (req, res) => {
  try {
    const { balance, currency } = await getHerosmsBalance();
    res.json({ ok: true, balance, currency });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Kirim email percobaan via AJAX di halaman settings -- buat mastiin kredensial SMTP yang baru
// diisi admin beneran valid SEBELUM dipakai beneran di alur Lupa Password user.
router.post('/settings/smtp/test', async (req, res) => {
  const to = String((req.body && req.body.to) || '').trim();
  if (!to) return res.status(400).json({ ok: false, error: 'Isi dulu email tujuan tes' });
  try {
    await sendTestEmail(to);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/settings', (req, res, next) => {
  // Wrap multer di sini (bukan pakai middleware langsung) biar error multer (format salah /
  // file terlalu besar) bisa ditangani gracefully, bukan crash ke global error handler.
  uploadOgImage.single('seoOgImageFile')(req, res, (err) => {
    if (err) return res.redirect('/admin/settings?error=' + encodeURIComponent('Upload OG Image gagal: ' + err.message));
    handleSettingsSave(req, res);
  });
});

function handleSettingsSave(req, res) {
  const {
    siteName, siteTagline,
    catalogCategories,
    qrString, merchantCode, apiKey, secretKey, feePercent, depositMin, expiredMinutes,
    digiflazzEnabled, digiflazzUsername, digiflazzApiKey, digiflazzWebhookSecret,
    indosmmEnabled, indosmmApiKey,
    herosmsEnabled, herosmsApiKey, herosmsRubToIdr, herosmsMarginType, herosmsMarginValue, herosmsWebhookSecret,
    googleEnabled, googleClientId, googleClientSecret,
    smtpHost, smtpPort, smtpSecure, smtpUser, smtpPass, smtpFromName, smtpFromEmail,
    botToken, chatId, notifyOnDeposit, notifyOnOrder, notifyOnRegister, notifyOnWithdrawal,
    ownerWhatsapp,
    seoSiteUrl, seoMetaDescription, seoMetaKeywords,
    groupEnabled, groupTitle, groupMessage, groupLink, groupButtonText,
    marqueeEnabled, marqueeText,
    referralPercent
  } = req.body;

  const categories = (catalogCategories || 'Games')
    .split(',')
    .map(c => c.trim())
    .filter(Boolean);

  // PROTEKSI: field identitas & SEO ini kalau kekirim KOSONG pas Simpan, JANGAN ditimpa jadi
  // kosong -- pertahankan nilai yang lama (sama pola kayak googleClientSecret di bawah). User
  // melaporkan field-field ini "tiba-tiba hilang semua" walau siteName itu required di HTML
  // (harusnya browser nolak kirim kosong) -- belum ketemu satu penyebab pasti yang bisa
  // direproduksi dari kode, tapi apa pun pemicunya, proteksi ini nutup jalan buat data penting
  // ke-timpa jadi kosong tanpa sengaja. Kalau admin BENERAN mau ngosongin salah satu field ini
  // (mis. WhatsApp Owner), tetap bisa lewat isi spasi lalu simpan, atau minta bantuan lagi.
  const prevCfg = getConfig();
  const keepIfBlank = (newVal, oldVal) => {
    const trimmed = String(newVal || '').trim();
    return trimmed ? newVal : (oldVal || '');
  };

  updateConfig({
    siteName: keepIfBlank(siteName, prevCfg.siteName),
    siteTagline: keepIfBlank(siteTagline, prevCfg.siteTagline),
    ownerWhatsapp: keepIfBlank(ownerWhatsapp, prevCfg.ownerWhatsapp),
    seo: {
      siteUrl: keepIfBlank(String(seoSiteUrl || '').trim().replace(/\/+$/, ''), (prevCfg.seo || {}).siteUrl),
      metaDescription: keepIfBlank(String(seoMetaDescription || '').trim().slice(0, 160), (prevCfg.seo || {}).metaDescription),
      metaKeywords: String(seoMetaKeywords || '').trim(),
      // OG Image: kalau ada file yang diupload, pakai path barunya; kalau tidak (field file kosong),
      // pertahankan nilai lama (sama pola keepIfBlank) biar gambar lama gak ke-hapus cuma karena
      // admin simpan pengaturan lain tanpa upload ulang.
      ogImage: req.file ? '/uploads/seo/' + req.file.filename : keepIfBlank('', (prevCfg.seo || {}).ogImage)
    },
    catalog: { categories: categories.length > 0 ? categories : ['Games'] },
    qris: { qrString, merchantCode, apiKey, secretKey: (secretKey || '').trim(), feePercent: parseFloat(feePercent), depositMin: parseInt(depositMin), expiredMinutes: parseInt(expiredMinutes) },
    digiflazz: { enabled: digiflazzEnabled === 'on', username: digiflazzUsername || '', apiKey: digiflazzApiKey || '', webhookSecret: (digiflazzWebhookSecret || '').trim() },
    indosmm: { enabled: indosmmEnabled === 'on', apiKey: indosmmApiKey || '' },
    herosms: {
      enabled: herosmsEnabled === 'on', apiKey: herosmsApiKey || (getConfig().herosms || {}).apiKey || '',
      rubToIdr: parseFloat(herosmsRubToIdr) || 170,
      marginType: herosmsMarginType || 'percent',
      marginValue: herosmsMarginValue !== undefined ? Number(herosmsMarginValue) : 30,
      webhookSecret: (herosmsWebhookSecret || '').trim() || (getConfig().herosms || {}).webhookSecret || ''
    },
    // Client Secret: kalau field ini dikosongin pas nyimpen (mis. admin cuma mau ganti Client ID
    // doang, gak pengen ngetik ulang secret-nya), JANGAN ditimpa jadi kosong -- pertahankan yang
    // lama. Ini beda dari field lain karena secret gak pernah ditampilkan balik ke form (lihat
    // renderSettings), jadi kalau field kosong = "gak diubah", bukan "dikosongin sengaja".
    google: {
      enabled: googleEnabled === 'on',
      clientId: googleClientId || '',
      clientSecret: googleClientSecret ? googleClientSecret : (getConfig().google || {}).clientSecret || ''
    },
    // SMTP Password: sama kayak Google Client Secret di atas -- field ini gak pernah ditampilkan
    // balik ke form (lihat renderSettings), jadi kalau dikirim kosong pas Simpan artinya "gak
    // diubah", BUKAN "sengaja dikosongin" -- pertahankan password yang lama biar admin gak perlu
    // ketik ulang App Password tiap kali cuma mau ganti field lain di section ini.
    smtp: {
      host: (smtpHost || '').trim(),
      port: parseInt(smtpPort) || 587,
      secure: smtpSecure === 'on',
      user: (smtpUser || '').trim(),
      pass: smtpPass ? smtpPass : (getConfig().smtp || {}).pass || '',
      fromName: (smtpFromName || '').trim(),
      fromEmail: (smtpFromEmail || '').trim()
    },
    telegram: { botToken, chatId, notifyOnDeposit: notifyOnDeposit === 'on', notifyOnOrder: notifyOnOrder === 'on', notifyOnRegister: notifyOnRegister === 'on', notifyOnWithdrawal: notifyOnWithdrawal === 'on' },
    community: { groupEnabled: groupEnabled === 'on', groupTitle, groupMessage, groupLink, groupButtonText },
    marquee: { enabled: marqueeEnabled === 'on', text: marqueeText || '' },
    // Komisi referral: satu persentase SAMA RATA buat SEMUA jenis transaksi (produk digital,
    // manual, apapun metode bayarnya) -- lihat lib/referrals.js creditReferralCommission().
    // Fallback ke default lama (1%) kalau field dikirim kosong/bukan angka, biar gak kesimpen NaN.
    referral: {
      percent: (referralPercent !== undefined && referralPercent !== '' && !isNaN(parseFloat(referralPercent))) ? parseFloat(referralPercent) : 1
    }
    // NOTE: "banners" sengaja tidak disentuh di sini. Banner dikelola sepenuhnya lewat
    // /admin/settings/banner/add dan /admin/settings/banner/delete/:id (form terpisah di halaman
    // settings), supaya klik "Simpan Pengaturan" tidak pernah menimpa/menghapus banner yang sudah ada.
  });

  renderSettings(req, res, { success: 'Pengaturan berhasil disimpan' });
}

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
