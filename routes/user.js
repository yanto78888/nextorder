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
import { getActiveProducts, findProductById, takeProductStock, countStock, updateProduct, getProductCostPrice } from '../lib/products.js';
import { getOrdersByUser, createOrder, getStats, getTotalSoldMap, updateOrderStatus, patchOrder } from '../lib/orders.js';
import { createDeposit, getDeposit, getDepositsByUser, cancelDeposit } from '../lib/deposit.js';
import { getSaldoLedgerByUser, getSaldoLedgerSummary } from '../lib/saldoLedger.js';
import { notifyOrder } from '../lib/telegram.js';
import { getConfig } from '../lib/config.js';
import { getMembershipList, getMembershipTier } from '../lib/membership.js';
import { getGameIcon } from '../lib/gamePresets.js';
import { createReview, getReviewsByProduct } from '../lib/reviews.js';
import { isDigiflazzEnabled, buildCustomerNo, createTransaction } from '../lib/digiflazz.js';
import { getGroupThumbnail, getGroupThumbnails } from '../lib/digiflazzGroups.js';
import {
  isIndosmmEnabled, placeOrder as placeIndosmmOrder, computeTotalForQty as computeIndosmmTotal,
  getServices as getIndosmmServices, cancelOrder as cancelIndosmmOrder, requestRefill as requestIndosmmRefill
} from '../lib/indosmm.js';
import { genId } from '../lib/db.js';
import { getFlashSaleDisplayItems, getFlashSaleSettings, isFlashSaleRunning, getEffectivePrice, getActiveFlashPriceForProduct, recordFlashSaleSale, createPriceResolver } from '../lib/flashsale.js';

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

// Digiflazz gak punya konsep "quantity" per transaksi -- tiap unit butuh 1 panggilan
// createTransaction() SENDIRI ke Digiflazz secara berurutan (lihat fulfillAndRecordOrders di
// bawah). Kalau qty dibiarkan sampai puluhan, 1 request checkout bisa jadi puluhan panggilan API
// berurutan yang lama & rawan timeout di browser/proxy. Makanya dibatasi wajar di sini (dicek di
// /order, /order/qris-init, DAN /order/qris-confirm -- bukan cuma di 1 tempat, khususnya jangan
// sampai baru ketahuan kelebihan qty SETELAH customer bayar QRIS beneran).
const MAX_DIGIFLAZZ_QTY_PER_ORDER = 10;
function validateQty(product, qty) {
  if (product.provider === 'digiflazz' && qty > MAX_DIGIFLAZZ_QTY_PER_ORDER) {
    return `Maksimal ${MAX_DIGIFLAZZ_QTY_PER_ORDER}x per transaksi untuk produk auto top up ini. Silakan checkout terpisah untuk jumlah lebih banyak.`;
  }
  if (product.provider === 'indosmm') {
    const min = Number(product.indosmmMin) || 1;
    const max = Number(product.indosmmMax) || min;
    if (qty < min || qty > max) {
      return `Jumlah harus antara ${min.toLocaleString('id-ID')} - ${max.toLocaleString('id-ID')} untuk layanan ini.`;
    }
  }
  return null;
}

// Total harga buat qty tertentu, provider-aware: IndoSMM dihitung dari RATE PER 1000 (qty = jumlah
// asli, mis. 500 follower -- BUKAN "berapa kali beli"), provider lain tetap unitPrice * qty biasa.
function computeOrderTotal(product, unitPrice, qty) {
  if (product.provider === 'indosmm') return computeIndosmmTotal(unitPrice, qty);
  return unitPrice * qty;
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
          note: 'Top up otomatis berhasil',
          provider: 'digiflazz', providerRefId: refId, providerCustomerNo: customerNo, refund: false
        };
      }
      if (status === 'gagal') {
        return {
          status: 'cancelled', deliveryMode: 'auto', manualRequired: false,
          detail: '', note: 'Top up gagal: ' + (result.message || 'ditolak sistem'),
          provider: 'digiflazz', providerRefId: refId, providerCustomerNo: customerNo, refund: true
        };
      }
      // Pending: masih diproses Digiflazz di baliknya, dicek ulang otomatis oleh background job
      // (catatan sengaja gak nyebut nama provider ke customer, lihat validateQty & invoice.ejs juga)
      return {
        status: 'processing', deliveryMode: 'auto', manualRequired: false,
        detail: '', note: 'Sedang diproses sistem, tunggu beberapa saat',
        provider: 'digiflazz', providerRefId: refId, providerCustomerNo: customerNo, refund: false
      };
    } catch (err) {
      return {
        status: 'cancelled', deliveryMode: 'auto', manualRequired: false,
        detail: '', note: 'Gagal menghubungi sistem top up: ' + err.message,
        provider: 'digiflazz', providerRefId: refId, providerCustomerNo: customerNo, refund: true
      };
    }
  }

  if (product.provider === 'indosmm' && isIndosmmEnabled()) {
    const link = (targetData.link || '').trim();
    if (!link) {
      return {
        status: 'cancelled', deliveryMode: 'auto', manualRequired: false,
        detail: '', note: 'Gagal memproses: link tujuan tidak diisi',
        provider: 'indosmm', providerRefId: '', providerCustomerNo: '', refund: true
      };
    }
    try {
      // qty di sini = jumlah asli (mis. 500 followers) -- BEDA dari Digiflazz, IndoSMM emang
      // native dukung "quantity" per 1 kali panggilan API, jadi TIDAK di-loop/split per unit
      // (lihat perUnit di fulfillAndRecordOrders, cuma true buat provider 'digiflazz').
      const result = await placeIndosmmOrder({ serviceId: product.indosmmServiceId, link, quantity: qty });
      // Order SMM SELALU mulai dari "diproses" (gak ada status sukses/gagal instan kayak
      // Digiflazz) -- baru dituntasin belakangan oleh job checkPendingIndosmmOrders().
      return {
        status: 'processing', deliveryMode: 'auto', manualRequired: false,
        detail: '', note: 'Sedang diproses sistem, tunggu beberapa saat',
        provider: 'indosmm', providerRefId: result.orderId, providerCustomerNo: link, refund: false
      };
    } catch (err) {
      return {
        status: 'cancelled', deliveryMode: 'auto', manualRequired: false,
        detail: '', note: 'Gagal menghubungi sistem: ' + err.message,
        provider: 'indosmm', providerRefId: '', providerCustomerNo: link, refund: true
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

// Proses 1 aksi checkout (bayar Saldo atau QRIS) jadi 1 ATAU LEBIH order record + kirim produknya.
//
// KENAPA BISA LEBIH DARI 1 ORDER: Digiflazz gak punya konsep "quantity" per transaksi -- 1
// panggilan createTransaction() = 1 unit dikirim ke 1 customer_no. Dulu qty diabaikan sama
// sekali buat produk Digiflazz (cuma manggil createTransaction() 1x walau qty=3 misalnya),
// akibatnya customer BAYAR 3x lipat harga tapi Digiflazz cuma memproses ("ke-hit") 1x. Sekarang,
// khusus produk Digiflazz, benar-benar di-loop sebanyak qty (masing-masing createTransaction()
// dengan ref_id BEDA -- Digiflazz menganggap ref_id yang SAMA sebagai retry transaksi yang sama,
// BUKAN transaksi baru), dan masing-masing unit dicatat sebagai order TERPISAH (qty:1). Dengan
// gitu status/refund/reconcile per unit otomatis akurat lewat logic single-unit yang sudah ada
// (gak perlu bikin konsep "refund sebagian" yang baru). Produk provider manual/stok TETAP 1
// order (qty:N) kayak sebelumnya -- itu memang sudah benar (lihat takeProductStock yang emang
// ngambil N item stok sekaligus).
async function fulfillAndRecordOrders({ user, product, qty, targetData, targetText, notifySource, paidNote }) {
  const unitPrice = getEffectivePrice(product, user);
  const usedFlashPrice = getActiveFlashPriceForProduct(product.id) != null;
  const perUnit = product.provider === 'digiflazz' && isDigiflazzEnabled();
  const iterations = perUnit ? qty : 1;
  const orderQty = perUnit ? 1 : qty;
  const orderTotal = computeOrderTotal(product, unitPrice, orderQty);

  const orders = [];
  for (let i = 0; i < iterations; i++) {
    const delivery = await fulfillOrder(product, orderQty, targetData, targetText);

    const order = createOrder({
      userId: user.id,
      username: user.username,
      productId: product.id,
      productName: product.name,
      price: unitPrice,
      qty: orderQty,
      total: orderTotal,
      source: 'user',
      status: delivery.status,
      deliveryMode: delivery.deliveryMode,
      manualRequired: delivery.manualRequired,
      targetText,
      detail: delivery.detail,
      note: delivery.refund ? delivery.note : (paidNote || delivery.note),
      provider: delivery.provider,
      providerRefId: delivery.providerRefId,
      providerCustomerNo: delivery.providerCustomerNo,
      indosmmServiceId: product.indosmmServiceId || '',
      costPrice: getProductCostPrice(product),
      usedFlashPrice
    });
    orders.push(order);

    // Refund per-unit kalau gagal -- dipanggil SETELAH createOrder (bukan sebelum, kayak
    // sebelumnya) supaya order.id sudah ada dan bisa dilampirkan ke catatan ledger-nya,
    // biar dari halaman Riwayat Saldo jelas refund ini berasal dari order yang mana.
    if (delivery.refund) {
      addSaldo(user.id, orderTotal, {
        reason: `Refund pesanan gagal: ${product.name}`,
        refType: 'order',
        refId: order.id
      });
    }

    // Catatan: total terjual TIDAK di-increment manual di sini -- dihitung live dari order (lihat
    // getTotalSoldMap di lib/orders.js), jadi otomatis akurat termasuk kalau order Digiflazz yang
    // sempat "Pending" ini belakangan ternyata gagal (lihat checkPendingDigiflazzOrders).
    if (!delivery.refund && usedFlashPrice) recordFlashSaleSale(product.id, orderQty);

    notifyOrder({
      username: user.username,
      productName: product.name,
      total: order.total,
      orderId: order.id,
      source: notifySource || (delivery.status === 'completed' ? 'auto' : 'user'),
      needsManual: delivery.manualRequired,
      targetText
    }).catch(() => {});
  }
  return orders;
}

// Ringkas hasil banyak order (qty>1 produk Digiflazz) jadi 1 pesan buat redirect ke /riwayat.
// Return null kalau cuma 1 order -- biar caller pakai pesan single-order yang lebih spesifik.
function summarizeOrders(orders) {
  if (orders.length <= 1) return null;
  const completed = orders.filter(o => o.status === 'completed').length;
  const processing = orders.filter(o => o.status === 'processing').length;
  const cancelled = orders.filter(o => o.status === 'cancelled').length;
  const parts = [];
  if (completed) parts.push(`${completed} berhasil dikirim`);
  if (processing) parts.push(`${processing} masih diproses otomatis`);
  if (cancelled) parts.push(`${cancelled} gagal & saldo bagian itu sudah dikembalikan`);
  return `${orders.length} order diproses: ${parts.join(', ')}.`;
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
  // resolvePrice & thumbByGroup masing-masing baca file terkait SEKALI buat seluruh request ini
  // (bukan per produk) -- lihat lib/flashsale.js createPriceResolver() & catatan di
  // collapseVariantGroups() di atas. Ini yang paling kerasa mempercepat katalog kalau produknya
  // banyak/variannya banyak.
  const resolvePrice = createPriceResolver(user);
  const thumbByGroup = new Map(Object.entries(getGroupThumbnails()));
  const products = getActiveProducts()
    .filter(p => p.provider !== 'indosmm') // Jasa Sosmed punya katalog terpisah di /jasa-sosmed
    .map(p => ({
      ...p,
      totalSold: soldMap[p.id] || 0,
      finalPrice: resolvePrice(p),
      icon: getGameIcon(p.gamePreset)
    }));

  const rows = groupProductsByCategory(products, cfg)
    .map(g => ({ category: g.category, products: collapseVariantGroups(g.items, thumbByGroup) }));
  const categoryOrder = rows.map(r => r.category);

  res.render('produk', {
    products,
    rows,
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
    .filter(p => p.provider !== 'indosmm') // Jasa Sosmed harganya per 1000, beda format -- ada di /jasa-sosmed sendiri
    .map(p => ({
      ...p,
      finalPrice: resolvePrice(p)
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

router.post('/order', requireLogin, async (req, res) => {
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

    const unitPrice = getEffectivePrice(product, user);
    const total = computeOrderTotal(product, unitPrice, qty);

    if (user.saldo < total) {
      return res.redirect('/produk?error=' + encodeURIComponent('Saldo tidak cukup setelah deposit'));
    }

    deductSaldo(user.id, total, {
      reason: `Pembelian ${product.name}${qty > 1 ? ` (${qty}x)` : ''} (QRIS)`,
      refType: 'order'
    });

    const orders = await fulfillAndRecordOrders({
      user, product, qty, targetData: pending.targetData || {}, targetText: pending.targetText || '',
      notifySource: 'qris', paidNote: 'Dibayar via QRIS'
    });

    delete req.session.pendingQrisOrder;

    if (orders.every(o => o.status === 'cancelled')) {
      return res.redirect('/produk?error=' + encodeURIComponent(orders[0].note + ', saldo sudah dikembalikan'));
    }

    if (orders.length === 1) {
      const order = orders[0];
      const msg = order.status === 'completed'
        ? 'Pembayaran QRIS berhasil! Produk sudah dikirim.'
        : order.status === 'processing' && (order.provider === 'digiflazz' || order.provider === 'indosmm')
          ? 'Pembayaran QRIS berhasil! Sedang diproses otomatis.'
          : 'Pembayaran QRIS berhasil! Pesanan menunggu admin kirim manual.';
      return res.redirect(`/riwayat/${order.id}?success=` + encodeURIComponent(msg));
    }

    res.redirect('/riwayat?success=' + encodeURIComponent('Pembayaran QRIS berhasil! ' + summarizeOrders(orders)));
  } catch (err) {
    res.redirect('/produk?error=' + encodeURIComponent(err.message));
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
  const reviews = getReviewsByProduct(product.id);
  // hasReviewed dulu dicek lewat hasUserReviewed(user.id, product.id) terpisah, yang scan ULANG
  // semua review dari disk -- padahal review produk ini baru aja diambil barusan di atas (`reviews`),
  // jadi cukup dicek langsung dari situ (in-memory), gak perlu baca file yang sama dua kali.
  const hasReviewed = user ? reviews.some(r => r.userId === user.id) : false;
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
    hasReviewed,
    user,
    config: cfgDetail,
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

    const qtyError = validateQty(product, qty);
    if (qtyError) return res.redirect(`/produk/${product.id}?error=` + encodeURIComponent(qtyError));

    const { data: targetData, missing } = extractTargetData(product, req.body);
    if (missing.length > 0) {
      return res.redirect(`/produk/${product.id}?error=` + encodeURIComponent(`Lengkapi dulu: ${missing.join(', ')}`));
    }
    const targetText = formatTargetText(product, targetData);

    const unitPrice = getEffectivePrice(product, user);
    const total = computeOrderTotal(product, unitPrice, qty);

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
      config: getConfig(),
      noindex: true
    });
  } catch (err) {
    res.redirect(`/produk/${req.body.productId}?error=${encodeURIComponent(err.message)}`);
  }
});

export default router;
