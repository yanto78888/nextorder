import express from 'express';
import session from 'express-session';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

import { attachUser } from './middleware/auth.js';
import { getAllUsers, createUser } from './lib/users.js';
import { getConfig } from './lib/config.js';
import { checkPendingDeposits } from './lib/deposit.js';
import { checkPendingOrderQrisPayments } from './lib/orderQris.js';
import { checkPendingDigiflazzOrders, autoSyncDigiflazzPrices } from './lib/digiflazz.js';
import { checkPendingIndosmmOrders, checkPendingIndosmmRefills } from './lib/indosmm.js';
import { scheduleAutoBackup } from './lib/backup.js';
import { getActiveProducts } from './lib/products.js';
import { FileSessionStore } from './lib/sessionStore.js';

import authRoutes from './routes/auth.js';
import userRoutes from './routes/user.js';
import adminRoutes from './routes/admin.js';
import apiRoutes from './routes/api.js';
import webhookRoutes from './routes/webhook.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// JARING PENGAMAN TERAKHIR: kalau ada throw sinkron di dalam route handler `async (req, res) => {...}`
// yang KELEWAT gak ke-try/catch (ketemu beberapa kasus konkret pas audit: mis. POST /order & POST
// /admin/order/:id/status sebelum diperbaiki -- user.saldo dipanggil padahal user-nya bisa null),
// itu jadi "unhandled promise rejection". Express 4 GAK nangkep itu otomatis, dan sejak Node 15+ efek
// baliknya proses Node LANGSUNG MATI TOTAL -- bukan cuma 1 request gagal, tapi SELURUH SITUS down
// buat SEMUA user sampai PM2 restart (sudah dicoba reproduksi manual, konsisten crash).
//
// Listener ini jadi jaring pengaman paling akhir: request yang kena tetap gantung/gagal (gak dapat
// respons yang bagus), TAPI prosesnya sendiri gak mati, jadi user LAIN yang lagi buka situs gak ikut
// kena imbas. ITU TETAP CUMA JARING PENGAMAN, BUKAN PENGGANTI try/catch yang benar di tiap handler --
// tempat yang udah ketauan rawan (checkout, update status order) sudah dikasih try/catch masing-
// masing secara langsung juga.
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection] Ada error async yang lolos gak ke-tangkep:', err);
});

// Nextorder biasanya jalan di belakang reverse proxy (lihat deploy/Caddyfile.example: Caddy
// terima HTTPS lalu forward polos ke 127.0.0.1:3000). Tanpa "trust proxy", req.protocol Express
// selalu kebaca "http" walau situsnya beneran https -- akibatnya URL di meta OG/canonical/sitemap
// bisa salah jadi http://. Baris ini bikin Express percaya header X-Forwarded-Proto dari Caddy.
app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true, limit: '2mb' }));
// { verify: ... } nyimpen raw body (Buffer, SEBELUM di-parse jadi objek JS) ke req.rawBody -- WAJIB
// buat validasi HMAC signature webhook Digiflazz (X-Hub-Signature dihitung dari raw body, bukan dari
// JSON.stringify ulang hasil parse, yang urutan key/whitespace-nya bisa beda dan bikin HMAC gak
// pernah cocok). Gak ngubah perilaku body-parsing yang sudah ada sama sekali -- cuma nambah 1
// referensi buffer yang emang udah kebaca.
// limit dinaikin dari default 100kb -> 2mb: jaring pengaman TAMBAHAN, bukan solusi utama --
// solusi utamanya operasi massal (import/sinkron/hapus banyak produk sekaligus di admin) sekarang
// dikirim BERTAHAP per-batch kecil dari sisi client (lihat public/js/admin-batch.js), jadi body
// tiap request seharusnya emang udah kecil dari sananya. 2mb cuma buat jaga-jaga kasus lain yang
// belum kepikiran, bukan izin buat ngirim payload segede itu tiap saat.
app.use(express.json({
  limit: '2mb',
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (req, res) => {
  res.status(200).json({ ok: true, app: 'nextorder' });
});

// SESSION_SECRET dipakai buat nanda-tangani cookie sesi -- siapa pun yang PUNYA secret ini bisa
// PALSUIN cookie sesi user mana pun (termasuk admin) tanpa perlu password sama sekali. Dulu ada
// fallback hardcoded ('nexorder-secret-key-ganti-jika-perlu') kalau env var-nya lupa diisi --
// persis kelas masalah yang sama kayak kredensial admin default yang dulu fixed 'skirk'/'binigw'
// (lihat komentar generateRandomPassword di bawah): karena ini TEMPLATE yang dipakai ulang di
// banyak deployment, siapa pun yang pernah baca source code ini otomatis tahu secret itu, dan
// bisa forge cookie admin di SITUS SIAPA PUN yang lupa set SESSION_SECRET di .env-nya -- padahal
// README_VERCEL.md sendiri sudah bilang wajib diisi acak.
//
// Sekarang: kalau env var-nya kosong, fallback ke secret ACAK (beda tiap kali proses restart)
// bukan hardcoded. Konsekuensinya semua orang ke-logout tiap restart/deploy selama env var belum
// diisi -- itu jauh lebih baik daripada diam-diam tetap "aman" padahal secret-nya predictable &
// sama persis di semua situs yang pakai template ini.
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('[session] PERINGATAN: SESSION_SECRET belum diisi di .env. Sesi login SEMUA user (termasuk admin) akan ke-reset tiap kali server ini restart/deploy ulang. Isi SESSION_SECRET di .env dengan string acak yang panjang (lihat README_VERCEL.md) supaya sesi gak keputus & supaya situs ini gak numpang secret yang sama dengan deployment template ini yang lain.');
}

app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  // `store` WAJIB diisi -- tanpa ini express-session diam-diam pakai MemoryStore bawaan yang
  // nyimpen sesi cuma di RAM, jadi semua orang ke-logout tiap proses Node-nya restart (deploy
  // ulang, `pm2 reload`, crash, dst). Lihat catatan lengkap di lib/sessionStore.js.
  store: new FileSessionStore(),
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 hari
    // secure: 'auto' -- otomatis nandain cookie "Secure" (cuma dikirim lewat HTTPS) kalau
    // koneksinya beneran HTTPS ATAU lewat reverse proxy yang lapor HTTPS via X-Forwarded-Proto
    // (lihat `app.set('trust proxy', 1)` di atas -- Caddy di depan Node persis skenario ini).
    // Tetap jalan normal di localhost/HTTP polos pas development (gak dipaksa 'true' yang bakal
    // bikin cookie gak pernah kekirim & login gagal terus kalau diakses tanpa HTTPS).
    secure: 'auto',
    // sameSite: 'lax' -- cookie sesi gak ikut kekirim kalau ada situs LAIN yang bikin browser
    // korban ngirim POST ke sini (klasik CSRF: <form> tersembunyi auto-submit dari situs jahat).
    // Tetap kekirim buat navigasi top-level biasa (klik link, redirect balik dari Google OAuth),
    // jadi gak ganggu alur login Google yang sudah ada.
    sameSite: 'lax'
  }
}));

app.use(attachUser);

// ---------- SEO: origin & path halaman saat ini, dipakai partials/head.ejs buat canonical/OG url ----------
// Prioritas: config.seo.siteUrl (diisi admin di Admin > Setting) kalau ada, biar stabil walau
// diakses lewat domain lain/IP -- fallback ke protocol+host dari request kalau belum diisi.
app.use((req, res, next) => {
  const cfg = getConfig();
  const configuredUrl = cfg.seo && cfg.seo.siteUrl ? String(cfg.seo.siteUrl).trim().replace(/\/+$/, '') : '';
  res.locals.siteOrigin = configuredUrl || `${req.protocol}://${req.get('host')}`;
  res.locals.currentPath = req.originalUrl.split('?')[0];
  next();
});

// ---------- bootstrap admin default jika belum ada user ----------
// Password digenerate ACAK tiap kali bootstrap ini beneran jalan (bukan hardcoded tetap) --
// dulu passwordnya fixed 'binigw' buat username 'skirk' persis kayak yang ketulis di source
// code template ini, jadi siapa pun yang pernah lihat kode ini (template yang dipakai ulang)
// otomatis tahu kredensial default itu buat dicoba di situs mana pun yang lupa gantinya.
function generateRandomPassword(length = 10) {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'; // tanpa 0/O/1/l/I biar gak ketuker pas diketik manual
  let out = '';
  for (let i = 0; i < length; i++) out += chars[crypto.randomInt(chars.length)];
  return out;
}

function bootstrap() {
  const users = getAllUsers();
  if (users.length === 0) {
    const password = generateRandomPassword();
    // Email sekarang WAJIB (jadi kunci login, lihat routes/auth.js) -- akun default ini dikasih
    // email placeholder biar tetap bisa login pertama kali, WAJIB diganti admin sendiri lewat
    // halaman Profile ke email asli yang beneran bisa diakses (Lupa Password butuh email nyata).
    const placeholderEmail = 'admin@localhost';
    createUser({ username: 'skirk', email: placeholderEmail, password, role: 'admin' });
    console.log('===================================================');
    console.log(' Akun admin default dibuat!');
    console.log(' Email    : ' + placeholderEmail + ' (login sekarang pakai EMAIL, bukan username)');
    console.log(` Password : ${password}`);
    console.log(' (password ini cuma tampil sekali di log ini, gak disimpan di tempat lain)');
    console.log(' >>> SEGERA LOGIN, GANTI PASSWORD & GANTI EMAIL KE EMAIL ASLI DI HALAMAN PROFILE <<<');
    console.log('===================================================');
  }
}
bootstrap();

// ---------- routes ----------
app.get('/', (req, res) => {
  if (req.session.user && req.session.user.role === 'admin') {
    return res.redirect('/admin');
  }
  // Tamu (belum login) langsung diarahkan ke beranda/katalog, tidak dipaksa login dulu
  res.redirect('/produk');
});

app.use('/', authRoutes);
app.use('/', userRoutes);
app.use('/admin', adminRoutes);
app.use('/api/v1', apiRoutes);
// Router ini nge-handle callback dari provider eksternal (QIOSPAY, Digiflazz). Path lengkapnya
// didefinisikan DI DALAM routes/webhook.js sendiri (beda provider, beda aturan path -- QIOSPAY
// fixed harus /api/callback/accept/{key}, Digiflazz bebas kita pilih), makanya di-mount di /api aja
// (prefix umum), bukan /api/callback kayak sebelumnya.
app.use('/api', webhookRoutes);

// ---------- SEO: robots.txt & sitemap.xml ----------
// Halaman privat (butuh login) & panel admin sengaja di-disallow -- gak ada nilai SEO buat
// diindeks, dan lumayan biar crawler gak buang-buang crawl budget ke situ.
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
`User-agent: *
Allow: /
Disallow: /admin
Disallow: /dashboard
Disallow: /profile
Disallow: /riwayat
Disallow: /topup
Disallow: /order
Disallow: /api
Disallow: /login
Disallow: /register

Sitemap: ${res.locals.siteOrigin}/sitemap.xml`
  );
});

app.get('/sitemap.xml', (req, res) => {
  const origin = res.locals.siteOrigin;
  const staticUrls = [
    { loc: '/produk', priority: '1.0', changefreq: 'daily' },
    { loc: '/daftar-harga', priority: '0.8', changefreq: 'daily' },
    { loc: '/kebijakan-privasi', priority: '0.3', changefreq: 'monthly' },
    { loc: '/syarat-ketentuan', priority: '0.3', changefreq: 'monthly' }
  ];
  const productUrls = getActiveProducts().map(p => ({
    loc: `/produk/${p.id}`,
    priority: '0.7',
    changefreq: 'weekly'
  }));

  const urlTags = [...staticUrls, ...productUrls].map(u =>
    `  <url>\n    <loc>${origin}${u.loc}</loc>\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`
  ).join('\n');

  res.type('application/xml').send(
`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urlTags}
</urlset>`
  );
});

// 404
app.use((req, res) => {
  res.status(404).render('404', { config: getConfig(), noindex: true });
});

// ---------- background job: cek pembayaran QRIS masuk ----------
// Disabled on Vercel because serverless functions do not run continuously.
// For VPS/local usage, the interval still runs normally.
if (process.env.VERCEL !== '1') {
  const cfgStart = getConfig();
  // Default diturunin dari 30s -> 10s biar pembayaran QRIS (baik top up saldo maupun order
  // langsung) kedeteksi lebih cepat. Kalau qris.pollIntervalSeconds sudah pernah diisi manual
  // di data/config.json, nilai itu yang dipakai -- ganti juga jadi 10 di sana kalau mau ikut.
  const pollMs = (cfgStart.qris?.pollIntervalSeconds || 10) * 1000;
  setInterval(() => {
    checkPendingDeposits().catch(err => console.error('[job] checkPendingDeposits error:', err.message));
  }, pollMs);

  // Order yang dibayar QRIS langsung (bukan lewat deposit saldo) -- dicek di interval YANG SAMA
  // biar konsisten & satu-satunya sumber kebenaran soal "kapan mutasi terakhir dicek" gampang
  // dipantau dari satu angka ini.
  setInterval(() => {
    checkPendingOrderQrisPayments().catch(err => console.error('[job] checkPendingOrderQrisPayments error:', err.message));
  }, pollMs);

  // Cek ulang status order Digiflazz yang masih "Pending" tiap 20 detik
  setInterval(() => {
    checkPendingDigiflazzOrders().catch(err => console.error('[job] checkPendingDigiflazzOrders error:', err.message));
  }, 20000);

  // Auto-sinkron ulang HARGA semua produk Digiflazz dari price list terbaru tiap 30 menit -- beda
  // dari checkPendingDigiflazzOrders di atas (itu ngecek STATUS order yang masih pending, bukan
  // harga produk). autoSyncDigiflazzPrices() sendiri yang skip kalau Digiflazz belum aktif/lengkap
  // dikonfigurasi (lihat isDigiflazzEnabled() di dalamnya), jadi gak perlu dicek lagi di sini.
  setInterval(() => {
    autoSyncDigiflazzPrices().catch(err => console.error('[job] autoSyncDigiflazzPrices error:', err.message));
  }, 30 * 60 * 1000);

  // Cek ulang status order IndoSMM yang masih "processing" tiap 60 detik -- lebih jarang dari
  // Digiflazz karena order SMM (followers/likes/dst) wajarnya butuh waktu lebih lama buat selesai
  // (bisa menitan-jaman), gak perlu se-sering itu dicek ulang.
  setInterval(() => {
    checkPendingIndosmmOrders().catch(err => console.error('[job] checkPendingIndosmmOrders error:', err.message));
  }, 60000);

  // Cek ulang status permintaan refill IndoSMM yang masih "processing" tiap 60 detik juga
  setInterval(() => {
    checkPendingIndosmmRefills().catch(err => console.error('[job] checkPendingIndosmmRefills error:', err.message));
  }, 60000);

  // Backup data (config/produk/order/user, dll) tiap 5 jam, dikirim ke Telegram lalu file zip-nya dihapus
  scheduleAutoBackup(5);

  app.listen(PORT, () => {
    console.log(`🚀 NEXORDER running at http://localhost:${PORT}`);
  });
}

export default app;