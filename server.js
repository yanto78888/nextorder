import express from 'express';
import session from 'express-session';
import path from 'path';
import { fileURLToPath } from 'url';

import { attachUser } from './middleware/auth.js';
import { getAllUsers, createUser } from './lib/users.js';
import { getConfig } from './lib/config.js';
import { checkPendingDeposits } from './lib/deposit.js';
import { checkPendingDigiflazzOrders } from './lib/digiflazz.js';
import { checkPendingIndosmmOrders, checkPendingIndosmmRefills } from './lib/indosmm.js';
import { scheduleAutoBackup } from './lib/backup.js';
import { getActiveProducts } from './lib/products.js';

import authRoutes from './routes/auth.js';
import userRoutes from './routes/user.js';
import adminRoutes from './routes/admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Nextorder biasanya jalan di belakang reverse proxy (lihat deploy/Caddyfile.example: Caddy
// terima HTTPS lalu forward polos ke 127.0.0.1:3000). Tanpa "trust proxy", req.protocol Express
// selalu kebaca "http" walau situsnya beneran https -- akibatnya URL di meta OG/canonical/sitemap
// bisa salah jadi http://. Baris ini bikin Express percaya header X-Forwarded-Proto dari Caddy.
app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (req, res) => {
  res.status(200).json({ ok: true, app: 'nextorder' });
});

app.use(session({
  secret: process.env.SESSION_SECRET || 'nexorder-secret-key-ganti-jika-perlu',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 } // 7 hari
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
function bootstrap() {
  const users = getAllUsers();
  if (users.length === 0) {
    createUser({ username: 'skirk', email: '', password: 'binigw', role: 'admin' });
    console.log('===================================================');
    console.log(' Akun admin default dibuat!');
    console.log(' Username : skirk');
    console.log(' Password : binigw');
    console.log(' >>> SEGERA LOGIN & GANTI PASSWORD DI HALAMAN PROFILE <<<');
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
    { loc: '/daftar-harga', priority: '0.8', changefreq: 'daily' }
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
  const pollMs = (cfgStart.qris?.pollIntervalSeconds || 30) * 1000;
  setInterval(() => {
    checkPendingDeposits().catch(err => console.error('[job] checkPendingDeposits error:', err.message));
  }, pollMs);

  // Cek ulang status order Digiflazz yang masih "Pending" tiap 20 detik
  setInterval(() => {
    checkPendingDigiflazzOrders().catch(err => console.error('[job] checkPendingDigiflazzOrders error:', err.message));
  }, 20000);

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