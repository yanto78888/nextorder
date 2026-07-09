import express from 'express';
import session from 'express-session';
import path from 'path';
import { fileURLToPath } from 'url';

import { attachUser } from './middleware/auth.js';
import { getAllUsers, createUser } from './lib/users.js';
import { getConfig } from './lib/config.js';
import { checkPendingDeposits } from './lib/deposit.js';

import authRoutes from './routes/auth.js';
import userRoutes from './routes/user.js';
import adminRoutes from './routes/admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

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

// ---------- bootstrap admin default jika belum ada user ----------
function bootstrap() {
  const users = getAllUsers();
  if (users.length === 0) {
    createUser({ username: 'skirk', email: '', password: 'binigw', role: 'admin' });
    console.log('===================================================');
    console.log(' Akun admin default dibuat!');
    console.log(' Username : admin');
    console.log(' Password : admin123');
    console.log(' >>> SEGERA LOGIN & GANTI PASSWORD DI HALAMAN PROFILE <<<');
    console.log('===================================================');
  }
}
bootstrap();

// ---------- routes ----------
app.get('/', (req, res) => {
  if (req.session.user) {
    return res.redirect(req.session.user.role === 'admin' ? '/admin' : '/produk');
  }
  res.redirect('/login');
});

app.use('/', authRoutes);
app.use('/', userRoutes);
app.use('/admin', adminRoutes);

// 404
app.use((req, res) => {
  res.status(404).render('404', { config: getConfig() });
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

  app.listen(PORT, () => {
    console.log(`🚀 NEXORDER running at http://localhost:${PORT}`);
  });
}

export default app;