import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import { createUser, findUserByUsername, verifyPassword, findUserById, updateUser, findUserByGoogleId, findOrCreateGoogleUser } from '../lib/users.js';
import { getConfig } from '../lib/config.js';
import { notifyRegister } from '../lib/telegram.js';

const router = express.Router();

// ---------- LOGIN VIA GOOGLE ----------
// Kredensial (Client ID & Client Secret) diatur admin di Admin > Pengaturan > "Login dengan
// Google", disimpan di config.json seperti integrasi lain (Digiflazz/IndoSMM/Telegram) -- bukan
// lewat file .env, biar gampang diubah tanpa akses server.
function getGoogleAuthConfig() {
  const cfg = getConfig();
  const g = cfg.google || {};
  return {
    enabled: !!(g.enabled && g.clientId && g.clientSecret),
    clientId: g.clientId || '',
    clientSecret: g.clientSecret || '',
    cfg
  };
}

// redirect_uri WAJIB persis sama karakter-per-karakter dengan yang didaftarkan di Google Cloud
// Console ("Authorized redirect URIs"), makanya diprioritaskan dari config.seo.siteUrl (URL resmi
// situs yang diisi admin di Pengaturan) kalau ada -- biar stabil walau diakses lewat domain/IP
// lain -- fallback ke protocol+host dari request kalau siteUrl belum diisi.
function getGoogleRedirectUri(req, cfg) {
  const configuredUrl = cfg.seo && cfg.seo.siteUrl ? String(cfg.seo.siteUrl).trim().replace(/\/+$/, '') : '';
  const origin = configuredUrl || `${req.protocol}://${req.get('host')}`;
  return `${origin}/auth/google/callback`;
}

router.get('/auth/google', (req, res) => {
  const { enabled, clientId, cfg } = getGoogleAuthConfig();
  const backTo = req.session.user ? '/profile' : '/login';
  if (!enabled) {
    return res.redirect(backTo + '?error=' + encodeURIComponent('Login Google belum diaktifkan oleh admin'));
  }

  const state = crypto.randomBytes(24).toString('hex');
  req.session.googleOAuthState = state; // dicocokkan lagi pas callback, cegah CSRF
  // Kalau user udah login & buka ini dari halaman Profil (mau menghubungkan akun Google ke akun
  // yang sudah ada), simpan juga id user-nya -- callback nanti tinggal nempelin googleId ke akun
  // ini, BUKAN nyari/bikin akun baru kayak alur login biasa dari halaman /login.
  req.session.googleOAuthLinkUserId = req.session.user ? req.session.user.id : null;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: getGoogleRedirectUri(req, cfg),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account'
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

router.get('/auth/google/callback', async (req, res) => {
  const { enabled, clientId, clientSecret, cfg } = getGoogleAuthConfig();

  const expectedState = req.session.googleOAuthState;
  const linkUserId = req.session.googleOAuthLinkUserId;
  delete req.session.googleOAuthState;
  delete req.session.googleOAuthLinkUserId;

  const backTo = linkUserId ? '/profile' : '/login';

  if (!enabled) {
    return res.redirect(backTo + '?error=' + encodeURIComponent('Login Google belum diaktifkan oleh admin'));
  }

  const { code, state, error: googleError } = req.query;
  if (googleError) {
    return res.redirect(backTo + '?error=' + encodeURIComponent('Login Google dibatalkan'));
  }
  if (!state || !expectedState || state !== expectedState) {
    return res.redirect(backTo + '?error=' + encodeURIComponent('Sesi login Google sudah tidak valid, silakan coba lagi'));
  }
  if (!code) {
    return res.redirect(backTo + '?error=' + encodeURIComponent('Login Google gagal, silakan coba lagi'));
  }

  try {
    const redirectUri = getGoogleRedirectUri(req, cfg);
    const tokenRes = await axios.post(
      'https://oauth2.googleapis.com/token',
      new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
    );

    const accessToken = tokenRes.data && tokenRes.data.access_token;
    if (!accessToken) throw new Error('Token Google tidak diterima');

    const profileRes = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 15000
    });
    const profile = profileRes.data || {};
    if (!profile.sub || !profile.email) throw new Error('Data akun Google tidak lengkap');
    if (profile.email_verified === false) {
      return res.redirect(backTo + '?error=' + encodeURIComponent('Email Google belum terverifikasi'));
    }

    if (linkUserId) {
      // Mode hubungkan akun Google dari halaman Profil (user sudah login duluan)
      const already = findUserByGoogleId(profile.sub);
      if (already && already.id !== linkUserId) {
        return res.redirect('/profile?error=' + encodeURIComponent('Akun Google ini sudah terhubung ke akun lain'));
      }
      const me = findUserById(linkUserId);
      if (!me) return res.redirect('/login?error=' + encodeURIComponent('Sesi berakhir, silakan login ulang'));
      updateUser(linkUserId, { googleId: profile.sub, avatar: me.avatar || profile.picture || '' });
      return res.redirect('/profile?success=' + encodeURIComponent('Akun Google berhasil dihubungkan'));
    }

    // Mode login biasa dari halaman /login
    const user = findOrCreateGoogleUser({
      googleId: profile.sub,
      email: profile.email,
      name: profile.name,
      picture: profile.picture
    });
    if (user.status === 'banned') {
      return res.redirect('/login?error=' + encodeURIComponent('Akun anda diblokir. Hubungi admin.'));
    }
    req.session.user = { id: user.id, username: user.username, role: user.role };
    res.redirect(user.role === 'admin' ? '/admin' : '/produk');
  } catch (err) {
    console.error('[auth] Login Google gagal:', (err.response && err.response.data) || err.message);
    res.redirect(backTo + '?error=' + encodeURIComponent('Login Google gagal, silakan coba lagi'));
  }
});

// Halaman login/register di-noindex -- gak ada nilai SEO buat diindeks & biar gak numpuk
// di hasil pencarian bareng halaman produk yang justru mau di-highlight.
router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect(req.session.user.role === 'admin' ? '/admin' : '/produk');
  res.render('login', { error: null, config: getConfig(), pageTitle: `Login - ${getConfig().siteName || 'NEXORDER'}`, noindex: true });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = findUserByUsername(username);
  const cfg = getConfig();
  const pageTitle = `Login - ${cfg.siteName || 'NEXORDER'}`;
  // Akun yang daftar/login pertama kali lewat Google gak punya password lokal (password: '') --
  // dikasih pesan yang jelas di sini, BUKAN "Username atau password salah" yang bikin bingung
  // karena usernamenya sendiri sebenarnya benar.
  if (user && !user.password) {
    return res.render('login', { error: 'Akun ini terdaftar lewat Google. Silakan masuk pakai tombol "Masuk dengan Google" di bawah, atau buat password login dulu di halaman Profil.', config: cfg, pageTitle, noindex: true });
  }
  if (!user || !verifyPassword(user, password)) {
    return res.render('login', { error: 'Username atau password salah', config: cfg, pageTitle, noindex: true });
  }
  if (user.status === 'banned') {
    return res.render('login', { error: 'Akun anda diblokir. Hubungi admin.', config: cfg, pageTitle, noindex: true });
  }
  req.session.user = { id: user.id, username: user.username, role: user.role };
  res.redirect(user.role === 'admin' ? '/admin' : '/produk');
});

router.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/produk');
  res.render('register', { error: null, config: getConfig(), pageTitle: `Daftar Akun - ${getConfig().siteName || 'NEXORDER'}`, noindex: true });
});

router.post('/register', async (req, res) => {
  const { username, email, password, password2 } = req.body;
  const cfg = getConfig();
  const pageTitle = `Daftar Akun - ${cfg.siteName || 'NEXORDER'}`;

  if (!username || !password) {
    return res.render('register', { error: 'Username dan password wajib diisi', config: cfg, pageTitle, noindex: true });
  }
  if (password !== password2) {
    return res.render('register', { error: 'Konfirmasi password tidak cocok', config: cfg, pageTitle, noindex: true });
  }
  if (password.length < 6) {
    return res.render('register', { error: 'Password minimal 6 karakter', config: cfg, pageTitle, noindex: true });
  }

  try {
    const user = createUser({ username, email, password });
    req.session.user = { id: user.id, username: user.username, role: user.role };
    notifyRegister({ username: user.username }).catch(() => {});
    res.redirect('/produk');
  } catch (err) {
    res.render('register', { error: err.message, config: cfg, pageTitle, noindex: true });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

export default router;
