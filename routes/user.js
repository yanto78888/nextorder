import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { requireLogin } from '../middleware/auth.js';
import {
  findUserById, updateUser, setPassword, verifyPassword, deductSaldo, addSaldo,
  getMembershipDiscount, upgradeMembership, generateApiKey, revokeApiKey
} from '../lib/users.js';
import { getActiveProducts, findProductById, countStock } from '../lib/products.js';
import { getOrdersByUser, getAllOrders, getStats, getTotalSoldMap, updateOrderStatus, patchOrder, getPublicDailyStats, getPublicMonthlyStats } from '../lib/orders.js';
import { maskUsername, maskTarget } from '../lib/masking.js';
import { getWeeklyLeaderboard, getMonthlyLeaderboard } from '../lib/leaderboard.js';
import { createDeposit, getDeposit, getDepositsByUser, cancelDeposit } from '../lib/deposit.js';
import {
  createOrderQrisPayment, getOrderQrisPayment, cancelOrderQrisPayment
} from '../lib/orderQris.js';
import {
  createWithdrawalRecord, getWithdrawalsByUser, getWithdrawSettings
} from '../lib/withdrawal.js';
import { notifyWithdrawal } from '../lib/telegram.js';
import {
  isHerosmsEnabled, getNumber as getHerosmsNumber, getActivationStatus, finishActivation, cancelActivation
} from '../lib/herosms.js';
import { createOrder } from '../lib/orders.js';
import { getSaldoLedgerByUser, getSaldoLedgerSummary } from '../lib/saldoLedger.js';
import { getConfig } from '../lib/config.js';
import { getMembershipList, getMembershipTier } from '../lib/membership.js';
import { getGameIcon } from '../lib/gamePresets.js';
import { createReview, getReviewsByGroup, getReviewStats, getAllReviewStatsMap, hasUserReviewedGroup, hasUserPurchasedGroup, resolveReviewGroupKey } from '../lib/reviews.js';
import { getGroupThumbnail, getGroupThumbnails } from '../lib/digiflazzGroups.js';
import {
  isIndosmmEnabled, getServices as getIndosmmServices, cancelOrder as cancelIndosmmOrder,
  requestRefill as requestIndosmmRefill
} from '../lib/indosmm.js';
import { getFlashSaleDisplayItems, getFlashSaleSettings, isFlashSaleRunning, getEffectivePrice, getActiveFlashPriceForProduct, recordFlashSaleSale, createPriceResolver } from '../lib/flashsale.js';
import {
  MAX_DIGIFLAZZ_QTY_PER_ORDER, validateQty, computeOrderTotal, formatTargetText,
  fulfillAndRecordOrders, summarizeOrders
} from '../lib/orderEngine.js';

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
    recentOrders: orders.slice(0, 5),
    apiBaseUrl: `${req.protocol}://${req.get('host')}/api/v1`,
    noindex: true
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

  // Akun yang daftar/login lewat Google belum tentu punya password lokal (password: '') --
  // di kondisi itu ini artinya "bikin password pertama kali", jadi field password lama dilewati
  // (gak ada yang bisa dicocokkan). Akun yang udah punya password tetap wajib isi password lama
  // dengan benar sebelum bisa diganti, seperti biasa.
  const isCreatingFirstPassword = !user.password;
  if (!isCreatingFirstPassword && !verifyPassword(user, oldPassword)) {
    return res.redirect('/profile?error=' + encodeURIComponent('Password lama salah'));
  }
  if (newPassword !== newPassword2) {
    return res.redirect('/profile?error=' + encodeURIComponent('Konfirmasi password baru tidak cocok'));
  }
  if (!newPassword || newPassword.length < 6) {
    return res.redirect('/profile?error=' + encodeURIComponent('Password minimal 6 karakter'));
  }
  setPassword(user.id, newPassword);
  const msg = isCreatingFirstPassword
    ? 'Password berhasil dibuat. Sekarang kamu juga bisa login pakai username & password, gak cuma lewat Google.'
    : 'Password berhasil diubah';
  res.redirect('/profile?success=' + encodeURIComponent(msg));
});

// Putuskan akun Google yang tersambung ke profil. Wajib sudah punya password lokal dulu --
// kalau belum, akun ini SATU-SATUNYA cara login-nya ya lewat Google, jadi diputus di sini artinya
// user bisa langsung terkunci dari akunnya sendiri.
router.post('/profile/google/disconnect', requireLogin, (req, res) => {
  const user = findUserById(req.session.user.id);
  if (!user.googleId) {
    return res.redirect('/profile?error=' + encodeURIComponent('Akun ini belum terhubung ke Google'));
  }
  if (!user.password) {
    return res.redirect('/profile?error=' + encodeURIComponent('Buat password login dulu sebelum memutuskan akun Google, supaya kamu tetap bisa login setelahnya'));
  }
  updateUser(user.id, { googleId: '' });
  res.redirect('/profile?success=' + encodeURIComponent('Akun Google berhasil diputuskan dari profil ini'));
});

// Validasi format IP SEDERHANA (bukan RFC lengkap) -- terima IPv4 ATAU IPv6, cukup buat nyaring
// salah ketik jelas (teks acak, dll), bukan validator alamat IP yang bulet-bulet benar.
function isValidIpv4(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every(p => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

function isValidIpv6(ip) {
  if (!ip.includes(':')) return false;
  return /^[0-9a-fA-F:]+$/.test(ip) && ip.length >= 3 && ip.length <= 45;
}

function isValidIp(ip) {
  if (!ip || typeof ip !== 'string') return false;
  const trimmed = ip.trim();
  return isValidIpv4(trimmed) || isValidIpv6(trimmed);
}

// Generate/regenerate API key buat "sistem transaksi via API" (routes/api.js). Regenerate
// otomatis bikin key LAMA gak berlaku lagi (langsung ketimpa), jadi kalau key lama sempat bocor,
// tinggal klik generate ulang. `scope` WAJIB 'transaction' atau 'deposit' -- keduanya key
// terpisah (lihat catatan lengkap di lib/users.js). `ipv6` WAJIB diisi kalau ini generate
// PERTAMA KALI; kalau regenerate dan field-nya dikosongkan, IP yang sudah terdaftar dipakai lagi.
router.post('/profile/api-key/generate', requireLogin, (req, res) => {
  const scope = req.body.scope === 'deposit' ? 'deposit' : 'transaction';
  const user = findUserById(req.session.user.id);
  const existingIp = scope === 'deposit' ? user.apiKeyDepositIp : user.apiKeyTransactionIp;
  const ipv6 = (req.body.ipv6 || '').trim() || existingIp;

  if (!isValidIp(ipv6)) {
    return res.redirect('/profile?error=' + encodeURIComponent('Alamat IP wajib diisi dengan format IPv4 atau IPv6 yang valid (mis. 103.10.20.30 atau 2001:db8::1)'));
  }

  generateApiKey(user.id, scope, ipv6);
  const scopeLabel = scope === 'deposit' ? 'Deposit' : 'Transaksi';
  res.redirect('/profile?success=' + encodeURIComponent(`API Key ${scopeLabel} berhasil dibuat & terdaftar untuk IP ${ipv6}. Simpan baik-baik, jangan dibagikan ke orang lain.`));
});

router.post('/profile/api-key/revoke', requireLogin, (req, res) => {
  const scope = req.body.scope === 'deposit' ? 'deposit' : 'transaction';
  revokeApiKey(req.session.user.id, scope);
  const scopeLabel = scope === 'deposit' ? 'Deposit' : 'Transaksi';
  res.redirect('/profile?success=' + encodeURIComponent(`API Key ${scopeLabel} berhasil dicabut. Integrasi yang masih pakai key lama otomatis berhenti bisa akses.`));
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

// Kelompokkan produk per kategori ala row katalog Netflix (mis. "Umum" / "Membership" masing-
// masing jadi 1 row), dipakai bareng oleh /produk dan /daftar-harga biar 2 halaman itu konsisten.
//
// Urutan & isi row ikutin Admin > Pengaturan > "Kategori yang Ditampilkan di Katalog"
// (config.catalog.categories) KALAU field itu sudah diisi admin -- itu sesuai keterangan di
// halaman Setting-nya sendiri ("Kategori di luar daftar ini tidak akan tampil"), tapi sebelum
// perbaikan ini field-nya cuma kesimpen doang, gak pernah beneran dipakai buat nyusun katalog.
// Kalau field itu KOSONG/belum pernah diisi admin, fallback ke urutan kemunculan pertama produk
// (perilaku lama) -- biar situs yang belum sempat atur field ini gak mendadak kehilangan kategori
// dari katalognya.
function groupProductsByCategory(products, cfg) {
  const configured = (cfg.catalog && Array.isArray(cfg.catalog.categories) ? cfg.catalog.categories : [])
    .map(c => String(c).trim())
    .filter(Boolean);

  if (configured.length > 0) {
    const buckets = new Map(); // nama kategori (persis tulisan admin) -> array produk
    const displayNameByLower = new Map();
    configured.forEach(cat => {
      if (displayNameByLower.has(cat.toLowerCase())) return; // duplikat di field admin, dilewati
      buckets.set(cat, []);
      displayNameByLower.set(cat.toLowerCase(), cat);
    });
    products.forEach(p => {
      const cat = p.category || 'Umum';
      const display = displayNameByLower.get(cat.toLowerCase());
      if (display) buckets.get(display).push(p); // kategori produk yg gak ada di daftar admin -> gak ditampilkan
    });
    return configured
      .map(cat => displayNameByLower.get(cat.toLowerCase()))
      .filter((cat, idx, arr) => cat && arr.indexOf(cat) === idx) // unik, jaga-jaga field admin ada duplikat
      .map(cat => ({ category: cat, items: buckets.get(cat) }))
      .filter(g => g.items.length > 0);
  }

  const order = [];
  const grouped = {};
  products.forEach(p => {
    const cat = p.category || 'Umum';
    if (!grouped[cat]) { grouped[cat] = []; order.push(cat); }
    grouped[cat].push(p);
  });
  return order.map(cat => ({ category: cat, items: grouped[cat] }));
}

// Produk yang punya variantGroup sama (mis. semua nominal "Mobile Legends") digabung jadi
// 1 kartu di katalog — biar gak numpuk satu-satu per nominal. Kartu gabungan nunjukin harga
// termurah di grup itu ("mulai dari"), diklik langsung ke halaman produk yang otomatis nampilin
// semua pilihan nominal di grup itu (lihat GET /produk/:id).
// thumbByGroup: Map hasil getGroupThumbnails() yang diambil SEKALI di pemanggil -- dulu tiap
// baris manggil getGroupThumbnail(variantGroup) sendiri-sendiri (baca file digiflazzGroups.json
// berkali-kali per request), sekarang tinggal lookup dari map yang udah ada di memori.
function collapseVariantGroups(list, thumbByGroup) {
  const groupIndex = new Map(); // variantGroup -> index di hasil[]
  const hasil = [];
  list.forEach(p => {
    if (!p.variantGroup) {
      hasil.push(p);
      return;
    }
    if (!groupIndex.has(p.variantGroup)) {
      groupIndex.set(p.variantGroup, hasil.length);
      hasil.push({
        ...p,
        name: p.variantGroup,
        isVariantGroup: true,
        variantCount: 1,
        thumbnail: thumbByGroup.get(p.variantGroup) || p.thumbnail || ''
      });
    } else {
      const rep = hasil[groupIndex.get(p.variantGroup)];
      rep.variantCount += 1;
      if (p.finalPrice < rep.finalPrice) {
        rep.finalPrice = p.finalPrice;
        rep.id = p.id; // link kartu ikut ke varian termurah biar konsisten sama harga yang ditampilkan
      }
      if (!rep.thumbnail && p.thumbnail) rep.thumbnail = p.thumbnail; // fallback kalau grup belum ada foto folder sendiri
      if ((p.totalSold || 0) > (rep.totalSold || 0)) rep.totalSold = p.totalSold; // pamer angka terjual paling ramai di grup
    }
  });
  return hasil;
}

router.get('/produk', (req, res) => {
  // Beranda bisa dibuka tanpa login (mode tamu). Kalau sudah login, tampilkan saldo & diskon member.
  const user = req.session.user ? findUserById(req.session.user.id) : null;
  const discountPercent = user ? getMembershipDiscount(user) : 0;
  const cfg = getConfig();

  // totalSold dihitung LIVE dari order asli (qty semua order yang bukan 'cancelled'), bukan dari
  // counter tersimpan di produk -- lihat getTotalSoldMap() di lib/orders.js buat alasannya (bug
  // lama: order Digiflazz "Pending" yang belakangan gagal gak pernah ke-kurangi lagi dari counter).
  const soldMap = getTotalSoldMap();
  // Rating juga dihitung LIVE per GRUP (bukan field rating/ratingCount yang dulu disimpan nempel
  // di produk) -- 1x baca reviews.json buat SELURUH request ini (lihat getAllReviewStatsMap di
  // lib/reviews.js), sama pola efisiensinya kayak soldMap di atas.
  const reviewStatsMap = getAllReviewStatsMap();
  // resolvePrice & thumbByGroup masing-masing baca file terkait SEKALI buat seluruh request ini
  // (bukan per produk) -- lihat lib/flashsale.js createPriceResolver() & catatan di
  // collapseVariantGroups() di atas. Ini yang paling kerasa mempercepat katalog kalau produknya
  // banyak/variannya banyak.
  const resolvePrice = createPriceResolver(user);
  const thumbByGroup = new Map(Object.entries(getGroupThumbnails()));
  const products = getActiveProducts()
    .filter(p => p.provider !== 'indosmm') // Jasa Sosmed punya katalog terpisah di /jasa-sosmed
    .map(p => {
      const stats = reviewStatsMap[resolveReviewGroupKey(p)];
      return {
        ...p,
        totalSold: soldMap[p.id] || 0,
        rating: stats ? stats.avg : 0,
        ratingCount: stats ? stats.count : 0,
        finalPrice: resolvePrice(p),
        icon: getGameIcon(p.gamePreset)
      };
    });

  const rows = groupProductsByCategory(products, cfg)
    .map(g => ({ category: g.category, products: collapseVariantGroups(g.items, thumbByGroup) }));
  const categoryOrder = rows.map(r => r.category);

  // 6 KATEGORI BESTSELLER: produk/grup dengan Terjual TERTINGGI, digabung dulu per Grup Varian
  // (sama kayak kartu katalog biasa, misal semua nominal "Mobile Legends" jadi 1 kartu) SEBELUM
  // di-ranking -- biar yang tampil beneran GAME/KATEGORI paling laris, bukan kebetulan 1 nominal
  // spesifik doang. Dihitung dari SELURUH produk lintas kategori (bukan per-kategori), pakai
  // totalSold yang SAMA persis dengan yang ditampilkan di kartu biasa (lihat catatan MAX di
  // collapseVariantGroups) -- biar angka yang keliatan di sini konsisten sama yang keliatan
  // kalau discroll ke kategori aslinya, gak ada hitungan tersembunyi yang beda.
  const bestsellers = collapseVariantGroups(products, thumbByGroup)
    .filter(p => (p.totalSold || 0) > 0)
    .sort((a, b) => (b.totalSold || 0) - (a.totalSold || 0))
    .slice(0, 6);

  res.render('produk', {
    products,
    rows,
    bestsellers,
    memberDiscount: discountPercent,
    user,
    config: cfg,
    banners: (cfg.banners || []).filter(b => b.image),
    marquee: cfg.marquee || {},
    flashSaleItems: isFlashSaleRunning() ? getFlashSaleDisplayItems() : [],
    flashSaleSettings: getFlashSaleSettings(),
    error: req.query.error || null,
    pageTitle: `${cfg.siteName || 'NEXORDER'} - ${cfg.siteTagline || 'Top Up Game Termurah & Terpercaya'}`,
    pageDescription: (cfg.seo && cfg.seo.metaDescription) || `Top up ${categoryOrder.join(', ') || 'game'} murah dan cepat di ${cfg.siteName || 'NEXORDER'}. Proses otomatis 24 jam, pembayaran QRIS.`
  });
});

// Halaman "Lihat Semua" dari carousel Flash Sale di beranda -- daftar penuh, gak dipotong geser.
router.get('/flash-sale', (req, res) => {
  const user = req.session.user ? findUserById(req.session.user.id) : null;
  const cfg = getConfig();
  const settings = getFlashSaleSettings();
  const items = isFlashSaleRunning() ? getFlashSaleDisplayItems() : [];

  res.render('flash-sale', {
    items,
    settings,
    user,
    config: cfg,
    pageTitle: `${settings.title || 'Flash Sale'} - ${cfg.siteName || 'NEXORDER'}`,
    pageDescription: `Semua produk ${settings.title || 'Flash Sale'} lagi diskon di ${cfg.siteName || 'NEXORDER'}, harga sama buat semua member. Buruan sebelum kehabisan!`
  });
});

// Daftar Harga Layanan: transparansi harga semua produk aktif, dikelompokkan per kategori,
// bisa dibuka tanpa login (sama kayak /produk, cuma format ringkas buat dipindai cepat).
router.get('/daftar-harga', (req, res) => {
  const user = req.session.user ? findUserById(req.session.user.id) : null;
  const cfg = getConfig();
  const discountPercent = user ? getMembershipDiscount(user) : 0;

  const resolvePrice = createPriceResolver(user);
  const products = getActiveProducts()
    .map(p => ({
      ...p,
      finalPrice: resolvePrice(p),
      // Link detail beda-beda per jenis produk -- OTP belum punya halaman detail per-produk
      // (cuma katalog di /otp), jadi diarahkan ke situ aja.
      priceListHref: p.provider === 'indosmm' ? `/jasa-sosmed/${p.id}` : (p.provider === 'otp' ? '/otp' : `/produk/${p.id}`),
      priceListUnit: p.provider === 'indosmm' ? '/1000' : '' // Jasa Sosmed dihargai per 1000, lainnya per-item/nomor biasa
    }));

  // Termurah ke termahal dalam tiap kategori biar enak dipindai matanya
  const groups = groupProductsByCategory(products, cfg)
    .map(g => ({ category: g.category, products: [...g.items].sort((a, b) => a.finalPrice - b.finalPrice) }));
  const categoryOrder = groups.map(g => g.category);

  res.render('daftar-harga', {
    groups,
    totalProducts: products.length,
    memberDiscount: discountPercent,
    user,
    config: cfg,
    pageTitle: `Daftar Harga - ${cfg.siteName || 'NEXORDER'}`,
    pageDescription: `Daftar lengkap ${products.length} harga produk di ${cfg.siteName || 'NEXORDER'}, transparan tanpa biaya tersembunyi. ${categoryOrder.join(', ')}.`
  });
});

// Dokumentasi API Reseller -- sengaja PUBLIC (gak requireLogin) biar calon reseller bisa baca-baca
// dulu sebelum daftar akun, tapi tombol "generate API key" cuma nongol kalau user sudah login.
router.get('/dokumentasi-api', (req, res) => {
  const user = req.session.user ? findUserById(req.session.user.id) : null;
  const cfg = getConfig();
  res.render('dokumentasi-api', {
    user,
    config: cfg,
    apiBaseUrl: `${req.protocol}://${req.get('host')}/api/v1`,
    maxDigiflazzQty: MAX_DIGIFLAZZ_QTY_PER_ORDER,
    pageTitle: `Dokumentasi API Reseller - ${cfg.siteName || 'NEXORDER'}`,
    pageDescription: `Dokumentasi API untuk integrasi transaksi otomatis, cek harga, cek saldo, dan deposit di ${cfg.siteName || 'NEXORDER'}.`
  });
});

// ---------- LIVE TRANSAKSI (PUBLIK, tersensor) ----------
// Beda dari /admin/live-transaksi (khusus order via API, data lengkap buat admin) -- ini
// nampilin SEMUA transaksi situs (produk apa aja, checkout web maupun API) ke SIAPA AJA yang buka
// halamannya (gak perlu login), tapi username & data tujuan SENGAJA disensor (lib/masking.js)
// biar gak bocorin identitas/data pribadi pembeli ke pengunjung lain.
function getPublicLiveFeed(limit = 50) {
  return getAllOrders()
    .filter(o => o.status !== 'cancelled')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, limit)
    .map(o => ({
      id: o.id,
      username: maskUsername(o.username),
      productName: o.productName,
      qty: o.qty,
      total: o.total,
      status: o.status,
      target: maskTarget(o.targetText),
      createdAt: o.createdAt
    }));
}

router.get('/live-transaksi', (req, res) => {
  const cfg = getConfig();
  const dailyStats = getPublicDailyStats(14);
  const monthlyStats = getPublicMonthlyStats(6);
  res.render('live-transaksi-publik', {
    orders: getPublicLiveFeed(),
    user: req.session.user ? findUserById(req.session.user.id) : null,
    config: cfg,
    chartDailyLabels: JSON.stringify(dailyStats.map(d => d.label)),
    chartDailyOrders: JSON.stringify(dailyStats.map(d => d.orders)),
    chartDailyTotal: JSON.stringify(dailyStats.map(d => d.total)),
    chartMonthlyLabels: JSON.stringify(monthlyStats.map(m => m.label)),
    chartMonthlyOrders: JSON.stringify(monthlyStats.map(m => m.orders)),
    chartMonthlyTotal: JSON.stringify(monthlyStats.map(m => m.total)),
    pageTitle: `Live Transaksi - ${cfg.siteName || 'NEXORDER'}`,
    pageDescription: `Lihat transaksi yang lagi berjalan di ${cfg.siteName || 'NEXORDER'} secara real-time.`
  });
});

router.get('/live-transaksi/data', (req, res) => {
  res.json({ success: true, data: getPublicLiveFeed() });
});

// ---------- LEADERBOARD (PUBLIK) ----------
router.get('/leaderboard', (req, res) => {
  const cfg = getConfig();
  const maskRows = rows => rows.map(r => ({ ...r, username: maskUsername(r.username) }));
  res.render('leaderboard', {
    weekly: maskRows(getWeeklyLeaderboard(10)),
    monthly: maskRows(getMonthlyLeaderboard(10)),
    user: req.session.user ? findUserById(req.session.user.id) : null,
    config: cfg,
    pageTitle: `Leaderboard - ${cfg.siteName || 'NEXORDER'}`,
    pageDescription: `Peringkat pembeli dengan total transaksi tertinggi minggu ini & bulan ini di ${cfg.siteName || 'NEXORDER'}.`
  });
});

// ---------- OTP (HeroSMS: nomor virtual terima SMS) ----------
// Alur order OTP BEDA TOTAL dari produk lain (top up/SMM/manual): bukan "bayar -> langsung dapat
// hasil", tapi "bayar -> dapat NOMOR -> tunggu SMS masuk (dipantau di halaman /otp/status/:id) ->
// bisa DIBATALKAN selama kodenya belum masuk". Makanya gak lewat fulfillAndRecordOrders() biasa
// (lib/orderEngine.js) -- order OTP dibuat manual di sini dengan status 'processing' dari awal,
// lalu diselesaikan/dibatalkan lewat endpoint terpisah di bawah.
router.get('/otp', (req, res) => {
  const cfg = getConfig();
  const user = req.session.user ? findUserById(req.session.user.id) : null;
  const products = getActiveProducts()
    .filter(p => p.provider === 'otp')
    .map(p => ({
      id: p.id,
      name: p.name,
      otpServiceName: p.otpServiceName,
      otpCountryName: p.otpCountryName,
      price: p.price
      // Catatan: OTP checkout (POST /otp/order/:id di bawah) motong saldo pakai product.price
      // APA ADANYA, BUKAN getEffectivePrice() -- jadi harga yang ditampilkan di sini disengaja
      // ikut product.price mentah juga, biar gak beda sama yang beneran dipotong pas checkout.
    })); // hanya field yang aman ditampilkan ke publik -- JANGAN sertakan otpBaseCostRub/marginType/marginValue dkk,
         // karena objek ini ditulis mentah sebagai JSON ke <script> di halaman (kelihatan siapa saja lewat "view source").

  // Dikelompokkan per NEGARA dulu (bukan per aplikasi lagi) -- biar alur pilihnya
  // "Pilih Negara" -> "Pilih Nama Aplikasi" di halaman, konsisten sama urutan
  // yang sama dipakai user buat filter di provider HeroSMS.
  const countryOrder = [];
  const grouped = {};
  products.forEach(p => {
    const key = p.otpCountryName || 'Lainnya';
    if (!grouped[key]) { grouped[key] = []; countryOrder.push(key); }
    grouped[key].push(p);
  });
  // Tiap negara diurut nama aplikasinya biar rapi di dropdown "Nama Aplikasi"
  const rows = countryOrder.sort((a, b) => a.localeCompare(b)).map(cat => ({
    category: cat,
    products: [...grouped[cat]].sort((a, b) => (a.otpServiceName || '').localeCompare(b.otpServiceName || ''))
  }));

  res.render('otp', {
    rows,
    user,
    config: cfg,
    otpEnabled: isHerosmsEnabled(),
    pageTitle: `OTP: Nomor Virtual Terima SMS - ${cfg.siteName || 'NEXORDER'}`,
    pageDescription: `Sewa nomor virtual buat terima kode OTP/SMS verifikasi WhatsApp, Telegram, dan berbagai layanan lain di ${cfg.siteName || 'NEXORDER'}.`
  });
});

router.post('/otp/order/:productId', requireLogin, async (req, res) => {
  try {
    const product = findProductById(req.params.productId);
    if (!product || product.provider !== 'otp' || product.status !== 'active') {
      return res.redirect('/otp?error=' + encodeURIComponent('Produk OTP tidak ditemukan/tidak aktif'));
    }
    if (!isHerosmsEnabled()) {
      return res.redirect('/otp?error=' + encodeURIComponent('Layanan OTP sedang tidak aktif'));
    }

    const user = findUserById(req.session.user.id);
    if (!user) {
      return res.redirect('/login?error=' + encodeURIComponent('Sesi kamu tidak valid, silakan login ulang'));
    }
    if ((user.saldo || 0) < product.price) {
      return res.redirect('/otp?error=' + encodeURIComponent('Saldo tidak cukup'));
    }

    // PENTING: minta nomor DULU ke HeroSMS, baru potong saldo kalau BERHASIL dapat nomor -- bukan
    // sebaliknya. Kalau dipotong duluan lalu getNumber() gagal (nomor habis dll), harus nambah
    // logic refund lagi; dengan urutan ini, gagal minta nomor = saldo user gak kesentuh sama sekali.
    let activationId, phoneNumber;
    try {
      ({ activationId, phoneNumber } = await getHerosmsNumber({
        serviceCode: product.otpServiceCode,
        countryId: product.otpCountryId
      }));
    } catch (err) {
      return res.redirect('/otp?error=' + encodeURIComponent(err.message));
    }

    deductSaldo(user.id, product.price, {
      reason: `Sewa nomor OTP: ${product.name}`,
      refType: 'order'
    });

    const order = createOrder({
      userId: user.id,
      username: user.username,
      productId: product.id,
      productName: product.name,
      price: product.price,
      qty: 1,
      total: product.price,
      source: 'user',
      status: 'processing',
      deliveryMode: 'auto',
      manualRequired: false,
      targetText: '',
      detail: '',
      note: 'Menunggu SMS masuk',
      provider: 'otp',
      providerRefId: activationId,
      providerCustomerNo: phoneNumber,
      costPrice: 0
    });

    res.redirect(`/otp/status/${order.id}`);
  } catch (err) {
    // Sama alasannya kayak POST /order (lihat lib/asyncHandler pattern di server.js) -- jaga-jaga
    // supaya 1 error gak nge-down-in seluruh app, bukan cuma checkout produk digital yang dilindungi.
    console.error('[otp/order] Gagal:', err);
    res.redirect('/otp?error=' + encodeURIComponent('Terjadi kesalahan: ' + err.message));
  }
});

router.get('/otp/status/:id', requireLogin, (req, res) => {
  const order = getOrdersByUser(req.session.user.id).find(o => o.id === req.params.id);
  if (!order || order.provider !== 'otp') {
    return res.redirect('/otp?error=' + encodeURIComponent('Order OTP tidak ditemukan'));
  }
  const cfg = getConfig();
  res.render('otp-status', {
    order,
    user: findUserById(req.session.user.id),
    config: cfg,
    pageTitle: `Status OTP ${order.id} - ${cfg.siteName || 'NEXORDER'}`,
    noindex: true
  });
});

// Polling JSON -- dipanggil berkala dari halaman status buat cek apakah kode SMS udah masuk.
router.get('/otp/status/:id/check', requireLogin, async (req, res) => {
  const order = getOrdersByUser(req.session.user.id).find(o => o.id === req.params.id);
  if (!order || order.provider !== 'otp') {
    return res.status(404).json({ success: false, message: 'Order tidak ditemukan' });
  }
  if (order.status !== 'processing') {
    return res.json({ success: true, status: order.status, detail: order.detail, note: order.note });
  }
  try {
    const result = await getActivationStatus(order.providerRefId);
    if (result.state === 'code' || result.state === 'waiting_retry') {
      patchOrder(order.id, { status: 'completed', detail: result.code, note: 'Kode OTP diterima' });
      finishActivation(order.providerRefId).catch(() => {});
      return res.json({ success: true, status: 'completed', detail: result.code, note: 'Kode OTP diterima' });
    }
    if (result.state === 'cancelled') {
      patchOrder(order.id, { status: 'cancelled', note: 'Aktivasi dibatalkan oleh provider' });
      return res.json({ success: true, status: 'cancelled', detail: '', note: 'Aktivasi dibatalkan oleh provider' });
    }
    return res.json({ success: true, status: 'processing', detail: '', note: 'Menunggu SMS masuk' });
  } catch (err) {
    return res.json({ success: true, status: 'processing', detail: '', note: 'Menunggu SMS masuk' });
  }
});

// Batalkan selama kode BELUM masuk -- refund penuh kalau HeroSMS konfirmasi batal.
router.post('/otp/status/:id/cancel', requireLogin, async (req, res) => {
  const order = getOrdersByUser(req.session.user.id).find(o => o.id === req.params.id);
  if (!order || order.provider !== 'otp') {
    return res.redirect('/otp?error=' + encodeURIComponent('Order tidak ditemukan'));
  }
  if (order.status !== 'processing') {
    return res.redirect(`/otp/status/${order.id}`);
  }
  try {
    await cancelActivation(order.providerRefId);
    patchOrder(order.id, { status: 'cancelled', note: 'Dibatalkan oleh user, saldo dikembalikan' });
    addSaldo(order.userId, order.total, {
      reason: `Refund pembatalan OTP: ${order.productName}`,
      refType: 'order',
      refId: order.id
    });
  } catch (err) {
    return res.redirect(`/otp/status/${order.id}?error=` + encodeURIComponent(err.message));
  }
  res.redirect(`/otp/status/${order.id}`);
});

// BUG: sama kayak /admin/order/:id/status -- handler ini async tapi sebelumnya TANPA try/catch,
// dan `user` dari findUserById() gak pernah dicek null sebelum dipakai (`user.saldo` baris di bawah)
// -- kalau sesi user mengarah ke akun yang datanya udah gak ada lagi di database (mis. restore
// backup lama sementara user itu masih login di browser), baris itu throw TypeError, jadi unhandled
// rejection, dan (sudah dicoba reproduksi manual) itu CRASH SELURUH PROSES NODE -- bukan cuma
// checkout user itu yang gagal, tapi WHOLE SITE down buat SEMUA user sampai PM2 restart. Ini route
// PALING SERING DIPANGGIL di seluruh app (tiap kali ada yang belanja), jadi paling kritis buat dikasih
// try/catch dibanding route lain manapun.
router.post('/order', requireLogin, async (req, res) => {
  try {
    const user = findUserById(req.session.user.id);
    if (!user) {
      return res.redirect('/login?error=' + encodeURIComponent('Sesi kamu tidak valid, silakan login ulang'));
    }
    const product = findProductById(req.body.productId);
    const qty = Math.max(1, parseInt(req.body.qty) || 1);

    if (!product || product.status !== 'active') {
      return res.redirect('/produk?error=Produk tidak tersedia');
    }

    const qtyError = validateQty(product, qty);
    if (qtyError) return res.redirect(`/produk/${product.id}?error=` + encodeURIComponent(qtyError));

    const { data: targetData, missing } = extractTargetData(product, req.body);
    if (missing.length > 0) {
      return res.redirect(`/produk/${product.id}?error=` + encodeURIComponent(`Lengkapi dulu: ${missing.join(', ')}`));
    }
    const targetText = formatTargetText(product, targetData);

    const unitPrice = getEffectivePrice(product, user);
    const total = computeOrderTotal(product, unitPrice, qty);
    if (user.saldo < total) {
      return res.redirect('/produk?error=Saldo tidak cukup, silakan topup');
    }

    deductSaldo(user.id, total, {
      reason: `Pembelian ${product.name}${qty > 1 ? ` (${qty}x)` : ''}`,
      refType: 'order'
    });

    const orders = await fulfillAndRecordOrders({ user, product, qty, targetData, targetText });

    if (orders.every(o => o.status === 'cancelled')) {
      return res.redirect('/produk?error=' + encodeURIComponent(orders[0].note + ', saldo sudah dikembalikan'));
    }

    if (orders.length === 1) {
      const order = orders[0];
      const msg = order.status === 'completed'
        ? 'Order berhasil, produk sudah dikirim.'
        : order.status === 'processing' && (order.provider === 'digiflazz' || order.provider === 'indosmm')
          ? 'Order berhasil, sedang diproses otomatis.'
          : 'Order berhasil, stok otomatis sedang habis. Pesanan menunggu admin kirim manual.';
      return res.redirect(`/riwayat/${order.id}?success=` + encodeURIComponent(msg));
    }

    res.redirect('/riwayat?success=' + encodeURIComponent(summarizeOrders(orders)));
  } catch (err) {
    console.error('[order] Gagal checkout:', err);
    res.redirect('/produk?error=' + encodeURIComponent('Terjadi kesalahan saat checkout: ' + err.message));
  }
});

router.get('/riwayat', requireLogin, async (req, res) => {
  const orders = getOrdersByUser(req.session.user.id);
  const sosmedOrdersRaw = orders.filter(o => o.provider === 'indosmm');
  const otherOrders = orders.filter(o => o.provider !== 'indosmm');

  // Cek flag refill/cancel per layanan (dari cache getServices(), TTL 3 menit) buat nentuin
  // tombol Batalkan/Refill ditampilin atau nggak -- bukan semua layanan IndoSMM dukung keduanya.
  // Kalau IndoSMM lagi nonaktif/error (mis. API key belum diisi), dibiarin diam-diam & tombol
  // gak ditampilin sama sekali, JANGAN bikin halaman riwayat gagal load gara-gara ini.
  let sosmedOrders = sosmedOrdersRaw;
  if (sosmedOrdersRaw.length > 0 && isIndosmmEnabled()) {
    try {
      const services = await getIndosmmServices();
      const metaByServiceId = Object.fromEntries(services.map(s => [String(s.service), s]));
      sosmedOrders = sosmedOrdersRaw.map(o => {
        // Order lama (dibuat sebelum field snapshot ini ada) belum punya o.indosmmServiceId --
        // fallback ke produk terkait cuma buat order-order lama itu. Order baru SELALU pakai
        // snapshot-nya sendiri, JANGAN ikut berubah kalau admin belakangan hapus/ubah produknya.
        const product = o.productId ? findProductById(o.productId) : null;
        const serviceId = o.indosmmServiceId || (product ? product.indosmmServiceId : '');
        const meta = serviceId ? metaByServiceId[String(serviceId)] : null;
        return {
          ...o,
          canCancel: Boolean(meta && meta.cancel) && o.status === 'processing' && !!o.providerRefId
            && !o.cancelRequestedAt,
          canRefill: Boolean(meta && meta.refill) && o.status === 'completed' && !!o.providerRefId
            && o.refillStatus !== 'processing'
        };
      });
    } catch (err) {
      console.error('[riwayat] Gagal ambil daftar layanan IndoSMM:', err.message);
      sosmedOrders = sosmedOrdersRaw.map(o => ({ ...o, canCancel: false, canRefill: false }));
    }
  } else {
    sosmedOrders = sosmedOrdersRaw.map(o => ({ ...o, canCancel: false, canRefill: false }));
  }

  res.render('riwayat', {
    sosmedOrders,
    otherOrders,
    config: getConfig(),
    user: findUserById(req.session.user.id),
    success: req.query.success || null,
    error: req.query.error || null,
    noindex: true
  });
});

// Batalkan order Jasa Sosmed (IndoSMM) yang masih "processing".
//
// PENTING (bekas bug): dulu di sini langsung addSaldo() + set status 'cancelled' begitu
// cancelIndosmmOrder() sukses TANPA error. Padahal respons action=cancel dari IndoSMM cuma
// berarti "permintaan batal DITERIMA/diantre" (mis. status "Awaiting"), BUKAN jaminan pesanan
// sudah benar-benar batal saat itu juga di server IndoSMM -- pesanan masih bisa lanjut jalan,
// kelar sebagian (partial), atau bahkan kelar penuh duluan sebelum permintaan batal sempat
// diproses provider. Akibatnya toko bisa kepotong REFUND PENUH padahal followers/likes-nya
// tetap terkirim di sisi IndoSMM (status lokal 'cancelled' tapi TIDAK SESUAI kondisi asli di
// server provider) -- inilah bug "batal di sini tapi di server provider gak beneran batal".
//
// Perbaikan: begitu permintaan cancel DITERIMA (gak error), order TETAP 'processing' + ditandai
// cancelRequestedAt, lalu dikonfirmasi belakangan oleh job checkPendingIndosmmOrders() (lihat
// lib/indosmm.js) yang sudah benar membedakan hasil akhir completed/partial/canceled lewat
// action=status -- refund/status final CUMA terjadi kalau IndoSMM beneran konfirmasi batal.
// Layanan yang emang gak dukung cancel (atau order sudah gak valid) bakal ditolak API-nya
// sendiri (lihat cancelOrder() di lib/indosmm.js), pesan errornya diteruskan apa adanya ke user.
const cancelInFlight = new Set(); // guard sederhana anti double-submit (mis. klik 2x cepat)
router.post('/riwayat/:id/batal-sosmed', requireLogin, async (req, res) => {
  const orderId = req.params.id;
  if (cancelInFlight.has(orderId)) {
    return res.redirect('/riwayat?error=' + encodeURIComponent('Permintaan pembatalan sedang diproses, mohon tunggu sebentar.'));
  }
  cancelInFlight.add(orderId);
  try {
    const order = getOrdersByUser(req.session.user.id).find(o => o.id === orderId);
    if (!order) throw new Error('Order tidak ditemukan');
    if (order.provider !== 'indosmm' || !order.providerRefId) {
      throw new Error('Order ini bukan Jasa Sosmed atau tidak bisa dibatalkan lewat sini');
    }
    if (order.status !== 'processing') throw new Error('Order ini sudah tidak dalam status diproses');
    if (order.cancelRequestedAt) throw new Error('Permintaan pembatalan sebelumnya masih menunggu konfirmasi dari sistem');

    await cancelIndosmmOrder(order.providerRefId);
    patchOrder(order.id, { cancelRequestedAt: new Date().toISOString() });
    res.redirect('/riwayat?success=' + encodeURIComponent(
      'Permintaan pembatalan sudah dikirim ke sistem. Status & saldo akan otomatis diperbarui begitu dikonfirmasi (biasanya dalam 1-2 menit) -- kalau ternyata pesanan sudah lebih dulu selesai diproses di sisi provider, pembatalan tidak akan mengubah status/saldo.'
    ));
  } catch (err) {
    res.redirect('/riwayat?error=' + encodeURIComponent(err.message));
  } finally {
    cancelInFlight.delete(orderId);
  }
});

// Minta refill order Jasa Sosmed (IndoSMM) yang sudah "completed" (mis. followers/likes berkurang).
// Refill TIDAK otomatis langsung sukses -- cuma ngirim permintaan ke IndoSMM, hasilnya (Completed/
// Rejected) baru kelihatan belakangan lewat job checkPendingIndosmmRefills() di server.js.
router.post('/riwayat/:id/refill-sosmed', requireLogin, async (req, res) => {
  try {
    const order = getOrdersByUser(req.session.user.id).find(o => o.id === req.params.id);
    if (!order) throw new Error('Order tidak ditemukan');
    if (order.provider !== 'indosmm' || !order.providerRefId) {
      throw new Error('Order ini bukan Jasa Sosmed atau tidak bisa direfill lewat sini');
    }
    if (order.status !== 'completed') throw new Error('Refill cuma bisa buat pesanan yang sudah selesai');
    if (order.refillStatus === 'processing') throw new Error('Permintaan refill sebelumnya masih diproses, mohon tunggu');

    const result = await requestIndosmmRefill(order.providerRefId);
    patchOrder(order.id, {
      refillId: result.refillId,
      refillStatus: 'processing',
      refillRequestedAt: new Date().toISOString()
    });
    res.redirect('/riwayat?success=' + encodeURIComponent('Permintaan refill berhasil dikirim, mohon tunggu diproses.'));
  } catch (err) {
    res.redirect('/riwayat?error=' + encodeURIComponent(err.message));
  }
});

// Invoice/struk 1 order, dipakai buat halaman detail setelah order berhasil maupun dilihat dari riwayat
router.get('/riwayat/:id', requireLogin, (req, res) => {
  const order = getOrdersByUser(req.session.user.id).find(o => o.id === req.params.id);
  if (!order) return res.redirect('/riwayat?error=' + encodeURIComponent('Order tidak ditemukan'));
  // Diambil dari produk (bukan snapshot di order) supaya selalu 1x tampil apa pun qty-nya, dan
  // tetap muncul walau order-nya diselesaikan admin manual (lihat catatan di lib/products.js).
  const product = order.productId ? findProductById(order.productId) : null;
  res.render('invoice', {
    order,
    usageInstructions: product ? product.usageInstructions : '',
    config: getConfig(),
    user: findUserById(req.session.user.id),
    success: req.query.success || null,
    noindex: true
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

// Riwayat mutasi saldo (masuk & keluar) -- beda dari /riwayat (riwayat ORDER) dan /topup
// (riwayat DEPOSIT doang). Di sini semua yang pernah nambah/motong saldo user ketemu dalam
// 1 daftar kronologis: topup QRIS, bayar order, refund order gagal/dibatalkan/partial,
// upgrade membership, sampai penyesuaian manual oleh admin (lihat lib/saldoLedger.js dan
// setiap pemanggil recordSaldoMutation buat daftar lengkapnya).
router.get('/riwayat-saldo', requireLogin, (req, res) => {
  const user = findUserById(req.session.user.id);
  const entries = getSaldoLedgerByUser(user.id);
  const { totalMasuk, totalKeluar } = getSaldoLedgerSummary(user.id);
  res.render('riwayat-saldo', {
    entries,
    totalMasuk,
    totalKeluar,
    user,
    config: getConfig(),
    success: req.query.success || null,
    error: req.query.error || null,
    pageTitle: `Riwayat Saldo - ${getConfig().siteName || 'NEXORDER'}`,
    noindex: true
  });
});

router.get('/topup', requireLogin, (req, res) => {
  const deposits = getDepositsByUser(req.session.user.id).slice(0, 10);
  res.render('topup', {
    deposits,
    config: getConfig(),
    user: findUserById(req.session.user.id),
    success: req.query.success || null,
    error: req.query.error || null,
    noindex: true
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

// ---------- PENARIKAN SALDO ----------
// Kebalikan dari topup: user minta saldo-nya dicairkan jadi uang asli ke GoPay/ShopeePay.
// Diproses MANUAL oleh admin (gak ada gateway payout otomatis) -- lihat catatan lengkap di
// lib/withdrawal.js. Saldo dipotong LANGSUNG saat pengajuan dibuat, dikembalikan penuh kalau
// admin menolak pengajuannya (lihat routes/admin.js).
router.get('/penarikan-saldo', requireLogin, (req, res) => {
  const user = findUserById(req.session.user.id);
  const withdrawals = getWithdrawalsByUser(user.id).slice(0, 20);
  res.render('penarikan-saldo', {
    user,
    withdrawals,
    settings: getWithdrawSettings(),
    config: getConfig(),
    success: req.query.success || null,
    error: req.query.error || null,
    pageTitle: `Tarik Saldo - ${getConfig().siteName || 'NEXORDER'}`,
    noindex: true
  });
});

router.post('/penarikan-saldo', requireLogin, (req, res) => {
  const settings = getWithdrawSettings();
  if (!settings.enabled) {
    return res.redirect('/penarikan-saldo?error=' + encodeURIComponent('Fitur penarikan saldo sedang tidak aktif'));
  }

  const amount = parseInt(req.body.amount);
  const method = req.body.method; // 'gopay' | 'shopeepay'
  const targetNumber = String(req.body.targetNumber || '').trim();
  const targetName = String(req.body.targetName || '').trim();
  const confirmed = req.body.confirmed === 'on' || req.body.confirmed === 'true';

  if (!amount || amount <= 0) {
    return res.redirect('/penarikan-saldo?error=' + encodeURIComponent('Nominal tidak valid'));
  }
  if (amount < settings.min) {
    return res.redirect('/penarikan-saldo?error=' + encodeURIComponent(`Minimal penarikan Rp ${settings.min.toLocaleString('id-ID')}`));
  }
  if (!['gopay', 'shopeepay'].includes(method)) {
    return res.redirect('/penarikan-saldo?error=' + encodeURIComponent('Metode penarikan tidak valid'));
  }
  // Validasi kasar nomor HP Indonesia (angka saja, 9-14 digit, boleh diawali 0/62/+62) -- BUKAN
  // verifikasi nomor itu beneran terdaftar GoPay/ShopeePay atau bukan (gak ada cara cek itu dari
  // sini). Makanya ada peringatan wajib centang di bawah: salah input jadi tanggung jawab user.
  const digitsOnly = targetNumber.replace(/[^0-9]/g, '');
  if (!targetNumber || digitsOnly.length < 9 || digitsOnly.length > 14) {
    return res.redirect('/penarikan-saldo?error=' + encodeURIComponent('Nomor tujuan tidak valid, cek kembali nomornya'));
  }
  if (!confirmed) {
    return res.redirect('/penarikan-saldo?error=' + encodeURIComponent('Wajib centang konfirmasi bahwa nomor tujuan sudah benar'));
  }

  const user = findUserById(req.session.user.id);
  if ((user.saldo || 0) < amount) {
    return res.redirect('/penarikan-saldo?error=' + encodeURIComponent('Saldo tidak cukup'));
  }

  deductSaldo(user.id, amount, {
    reason: `Pengajuan tarik saldo (${method === 'gopay' ? 'GoPay' : 'ShopeePay'})`,
    refType: 'withdrawal'
  });

  const record = createWithdrawalRecord({
    userId: user.id, username: user.username, amount, method, targetNumber, targetName
  });

  notifyWithdrawal({
    username: user.username, amount, method, targetNumber, targetName, withdrawalId: record.id
  }).catch(() => {});

  res.redirect('/penarikan-saldo?success=' + encodeURIComponent('Pengajuan tarik saldo berhasil dikirim, saldo sudah dipotong dan akan diproses admin secepatnya.'));
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

// Dipoll oleh halaman order-qris.ejs tiap beberapa detik buat cek status pembayaran.
// Order-nya SENDIRI dibuat otomatis di background (lihat checkPendingOrderQrisPayments di
// lib/orderQris.js) begitu QRIS-nya kebayar -- endpoint ini cuma NGELAPORIN status yang
// sudah kejadian di background itu, gak ikut motong saldo atau bikin order di sini.
router.get('/order/qris-status/:trxid', requireLogin, (req, res) => {
  const payment = getOrderQrisPayment(req.params.trxid);
  if (!payment || payment.userId !== req.session.user.id) {
    return res.status(404).json({ success: false, error: 'Transaksi tidak ditemukan' });
  }
  res.json({
    success: true,
    status: payment.status,
    orderIds: payment.orderIds || [],
    redirectUrl: (payment.status === 'paid' && payment.orderIds && payment.orderIds.length > 0)
      ? (payment.orderIds.length === 1 ? `/riwayat/${payment.orderIds[0]}` : '/riwayat')
      : null
  });
});

router.post('/order/qris-status/:trxid/cancel', requireLogin, async (req, res) => {
  try {
    await cancelOrderQrisPayment(req.params.trxid, req.session.user.id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ==================== DETAIL PRODUK ====================
router.get('/produk/:id', (req, res) => {
  const user = req.session.user ? findUserById(req.session.user.id) : null;

  // Ambil SEKALI aja daftar produk aktif, dipakai buat cari produk utama & susun daftar varian
  // sekaligus. Sebelumnya route ini baca+normalize products.json DUA KALI per request (sekali
  // implisit lewat findProductById, sekali lagi eksplisit buat varian) -- salah satu penyebab
  // halaman ini kerasa lag, apalagi buat produk yang variannya banyak (mis. semua nominal 1 game).
  const activeProducts = getActiveProducts();
  const product = activeProducts.find(p => p.id === req.params.id);
  if (!product) {
    return res.redirect('/produk?error=Produk tidak ditemukan');
  }
  if (product.provider === 'indosmm') {
    return res.redirect(`/jasa-sosmed/${product.id}`);
  }

  // resolvePrice baca config Flash Sale + daftar item Flash Sale SEKALI buat seluruh request ini,
  // lalu dipakai ulang dari memori buat produk utama & tiap varian -- bukan baca ulang 2 file yang
  // sama tiap kali getEffectivePrice() dipanggil (dulu: 1x produk utama + 1x per varian = bisa
  // 20+ kali baca file kalau variannya banyak). Ini penyebab utama "lag"-nya.
  const resolvePrice = createPriceResolver(user);
  const finalPrice = resolvePrice(product);
  // totalSold dihitung live dari order (lihat catatan di route /produk di atas), bukan counter tersimpan.
  product.totalSold = getTotalSoldMap()[product.id] || 0;

  // Ulasan sekarang GLOBAL PER GRUP (mis. semua nominal "Mobile Legends" berbagi ulasan yang
  // sama), bukan per SKU/nominal persis kayak dulu -- jadi 1x dihitung buat produk yang dibuka
  // (dan otomatis berlaku sama buat SEMUA variannya, gak perlu dihitung ulang per varian atau
  // di-swap lewat JS pas ganti pilihan nominal kayak versi sebelumnya).
  const groupKey = resolveReviewGroupKey(product);
  const reviews = getReviewsByGroup(groupKey);
  const reviewStats = getReviewStats(groupKey);
  const hasReviewed = user ? hasUserReviewedGroup(user.id, groupKey) : false;
  const canReview = user ? (hasUserPurchasedGroup(user.id, groupKey) && !hasReviewed) : false;
  const displayThumbnail = product.thumbnail || (product.variantGroup ? getGroupThumbnail(product.variantGroup) : '') || '';

  // Kalau produk ini punya variantGroup (mis. "Mobile Legends"), tampilkan juga produk lain
  // di grup yang sama sebagai pilihan nominal yang bisa diklik di halaman yang sama (tanpa reload).
  const variants = product.variantGroup
    ? activeProducts
        .filter(p => p.variantGroup === product.variantGroup)
        .map(p => ({
          id: p.id,
          name: p.name,
          price: p.price,
          finalPrice: resolvePrice(p),
          thumbnail: p.thumbnail,
          targetFields: p.targetFields || [],
          stockCount: countStock(p),
          provider: p.provider
        }))
        .sort((a, b) => a.price - b.price)
    : [];

  // SEO/OG per produk: judul & gambar ikutin nama grup varian (bukan SKU nominal tertentu),
  // sama kayak logic "displayName" di produk-detail.ejs, biar konsisten dengan yang tampil di layar.
  const cfgDetail = getConfig();
  const seoName = product.variantGroup || product.name;
  const seoDescription = product.description
    ? product.description.replace(/\s+/g, ' ').trim()
    : `Top up ${seoName} mulai Rp${finalPrice.toLocaleString('id-ID')}. Proses ${product.provider === 'digiflazz' ? 'otomatis' : 'cepat'}, aman, dan terpercaya di ${cfgDetail.siteName || 'NEXORDER'}.`;

  res.render('produk-detail', {
    product,
    finalPrice,
    displayThumbnail,
    variants,
    reviews,
    reviewStats,
    hasReviewed,
    canReview,
    user,
    config: cfgDetail,
    maxDigiflazzQty: MAX_DIGIFLAZZ_QTY_PER_ORDER,
    error: req.query.error || null,
    success: req.query.success || null,
    pageTitle: `${seoName} - ${cfgDetail.siteName || 'NEXORDER'}`,
    pageDescription: seoDescription,
    pageImage: displayThumbnail
  });
});

// ---------- JASA SOSMED (IndoSMM: followers/likes/views dkk) ----------
// Katalog & halaman detail terpisah dari /produk (game topup) karena model produknya beda total:
// qty di sini = jumlah asli (followers/likes/dst, bisa ratusan-ribuan) bukan "berapa kali beli",
// dan butuh input Link (bukan ID Game/Zone ID).
router.get('/jasa-sosmed', (req, res) => {
  const user = req.session.user ? findUserById(req.session.user.id) : null;
  const cfg = getConfig();
  const soldMap = getTotalSoldMap();
  const products = getActiveProducts()
    .filter(p => p.provider === 'indosmm')
    .map(p => ({
      ...p,
      totalSold: soldMap[p.id] || 0,
      finalPrice: getEffectivePrice(p, user)
    }));

  const categoryOrder = [];
  const grouped = {};
  products.forEach(p => {
    const cat = p.category || 'Jasa Sosmed';
    if (!grouped[cat]) { grouped[cat] = []; categoryOrder.push(cat); }
    grouped[cat].push(p);
  });
  const rows = categoryOrder.sort().map(cat => ({ category: cat, products: grouped[cat] }));

  res.render('jasa-sosmed', {
    products,
    rows,
    user,
    config: cfg,
    error: req.query.error || null,
    pageTitle: `Jasa Sosmed - ${cfg.siteName || 'NEXORDER'}`,
    pageDescription: `Layanan sosial media (followers, likes, views, dan lainnya) murah dan cepat di ${cfg.siteName || 'NEXORDER'}.`
  });
});

router.get('/jasa-sosmed/:id', (req, res) => {
  const user = req.session.user ? findUserById(req.session.user.id) : null;
  const product = findProductById(req.params.id);
  if (!product || product.status !== 'active' || product.provider !== 'indosmm') {
    return res.redirect('/jasa-sosmed?error=Layanan tidak ditemukan');
  }
  const finalPrice = getEffectivePrice(product, user);
  product.totalSold = getTotalSoldMap()[product.id] || 0;

  const cfgDetail = getConfig();
  res.render('jasa-sosmed-detail', {
    product,
    finalPrice,
    user,
    config: cfgDetail,
    error: req.query.error || null,
    success: req.query.success || null,
    pageTitle: `${product.name} - ${cfgDetail.siteName || 'NEXORDER'}`,
    pageDescription: `${product.name} mulai Rp${finalPrice.toLocaleString('id-ID')} per 1000 di ${cfgDetail.siteName || 'NEXORDER'}.`
  });
});

// Submit ulasan (rating + komentar) — 1x per user per GRUP, wajib udah pernah beli & selesai
// pesan produk di grup ini (dicek di dalam createReview -> hasUserPurchasedGroup).
router.post('/produk/:id/review', requireLogin, (req, res) => {
  const user = findUserById(req.session.user.id);
  const product = findProductById(req.params.id);
  if (!product) return res.redirect('/produk');

  try {
    createReview({
      userId: user.id,
      username: user.username,
      productId: product.id,
      productName: product.variantGroup || product.name,
      groupKey: resolveReviewGroupKey(product),
      rating: req.body.rating,
      comment: req.body.comment
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

    const qtyError = validateQty(product, qty);
    if (qtyError) return res.redirect(`/produk/${product.id}?error=` + encodeURIComponent(qtyError));

    const { data: targetData, missing } = extractTargetData(product, req.body);
    if (missing.length > 0) {
      return res.redirect(`/produk/${product.id}?error=` + encodeURIComponent(`Lengkapi dulu: ${missing.join(', ')}`));
    }
    const targetText = formatTargetText(product, targetData);

    const unitPrice = getEffectivePrice(product, user);
    const orderTotal = computeOrderTotal(product, unitPrice, qty);

    // Langsung ke pembayaran QRIS buat order ini -- TIDAK lewat sistem deposit/saldo sama
    // sekali (lihat catatan di lib/orderQris.js). Order-nya otomatis kebuat di background pas
    // QRIS-nya kebayar, gak butuh sesi/tab browser buat "konfirmasi" kayak alur lama.
    const payment = await createOrderQrisPayment({ user, product, qty, targetData, targetText, unitPrice, orderTotal });

    res.render('order-qris', {
      payment,
      product,
      qty,
      targetText,
      user,
      config: getConfig(),
      noindex: true
    });
  } catch (err) {
    res.redirect(`/produk/${req.body.productId}?error=${encodeURIComponent(err.message)}`);
  }
});

export default router;
