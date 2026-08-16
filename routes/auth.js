import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import { createUser, findUserByUsername, findUserByEmail, findUserByReferralCode, verifyPassword, findUserById, updateUser, findUserByGoogleId, findOrCreateGoogleUser, setPassword, canRequestResetOtp, generateResetOtp, verifyResetOtp, clearResetOtp } from '../lib/users.js';
import { getConfig } from '../lib/config.js';
import { notifyRegister } from '../lib/telegram.js';
import { sendResetOtpEmail, isSmtpConfigured } from '../lib/mailer.js';

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
  // Kode referral dari link ajakan (mis. /register?ref=AB23CD -> tombol "Daftar dengan Google" di
  // halaman itu ikut bawa ?ref= yang sama). Disimpan di sesi biar kebawa lewat round-trip ke
  // Google & balik lagi ke /auth/google/callback, lalu dipasang ke akun BARU yang kebentuk di sana
  // -- gak ngaruh ke akun yang connect/login Google-nya doang (bukan daftar baru), lihat parameter
  // referredBy di findOrCreateGoogleUser.
  req.session.googleOAuthRefCode = req.session.user ? '' : String(req.query.ref || '').trim().toUpperCase();

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
  const pendingRefCode = req.session.googleOAuthRefCode || '';
  delete req.session.googleOAuthState;
  delete req.session.googleOAuthLinkUserId;
  delete req.session.googleOAuthRefCode;

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

    // Mode login biasa dari halaman /login (atau daftar baru lewat tombol "Daftar dengan Google")
    // -- kalau ada kode referral yang kebawa dari link ajakan (pendingRefCode), coba pasangkan ke
    // akun BARU yang kebentuk di findOrCreateGoogleUser. Aman dipanggil terus tanpa dicek dulu
    // "akun ini baru atau lama": findOrCreateGoogleUser cuma makein referredBy ini pas BENERAN
    // bikin user baru, akun Google yang udah ada gak kesentuh/gak keganti referredBy-nya.
    const referrer = pendingRefCode ? findUserByReferralCode(pendingRefCode) : null;
    const user = findOrCreateGoogleUser({
      googleId: profile.sub,
      email: profile.email,
      name: profile.name,
      picture: profile.picture,
      referredBy: referrer ? referrer.id : ''
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
  res.render('login', { error: req.query.error || null, success: req.query.success || null, config: getConfig(), pageTitle: `Login - ${getConfig().siteName || 'NEXORDER'}`, noindex: true });
});

router.post('/login', (req, res) => {
  // Login sekarang pakai EMAIL (field di form namanya "email"), TAPI username tetap ada &
  // masih dipakai di tempat lain (ditampilkan di sidebar, dipakai buat cari akun via API key,
  // dll). Supaya user LAMA yang akunnya dibuat SEBELUM email jadi wajib (emailnya kosong di
  // data/users.json) gak langsung ke-lockout gara-gara update ini, di sini dicoba dulu cari
  // via email -- kalau gak ketemu (mis. yang diketik ternyata username lama), fallback coba
  // cari via username juga. User baru yang daftar sekarang emailnya udah pasti keisi & unik,
  // jadi fallback ini gak bikin ambigu buat akun baru.
  const { email, password } = req.body;
  const user = findUserByEmail(email) || findUserByUsername(email);
  const cfg = getConfig();
  const pageTitle = `Login - ${cfg.siteName || 'NEXORDER'}`;
  // Akun yang daftar/login pertama kali lewat Google gak punya password lokal (password: '') --
  // dikasih pesan yang jelas di sini, BUKAN "Email atau password salah" yang bikin bingung
  // karena emailnya sendiri sebenarnya benar.
  if (user && !user.password) {
    return res.render('login', { error: 'Akun ini terdaftar lewat Google. Silakan masuk pakai tombol "Masuk dengan Google" di bawah, atau buat password login dulu di halaman Profil.', config: cfg, pageTitle, noindex: true });
  }
  if (!user || !verifyPassword(user, password)) {
    return res.render('login', { error: 'Email atau password salah', config: cfg, pageTitle, noindex: true });
  }
  if (user.status === 'banned') {
    return res.render('login', { error: 'Akun anda diblokir. Hubungi admin.', config: cfg, pageTitle, noindex: true });
  }
  req.session.user = { id: user.id, username: user.username, role: user.role };
  res.redirect(user.role === 'admin' ? '/admin' : '/produk');
});

router.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/produk');
  // Dukung link referral: /register?ref=KODE -- kode-nya cuma buat NGE-PREFILL form, user tetap
  // bisa hapus/ganti manual (validasi beneran tetap kejadian pas submit POST /register di bawah).
  const refCode = String(req.query.ref || '').trim().toUpperCase();
  res.render('register', { error: null, refCode, config: getConfig(), pageTitle: `Daftar Akun - ${getConfig().siteName || 'NEXORDER'}`, noindex: true });
});

router.post('/register', async (req, res) => {
  const { username, email, password, password2, referralCode } = req.body;
  const cfg = getConfig();
  const pageTitle = `Daftar Akun - ${cfg.siteName || 'NEXORDER'}`;
  const refCode = String(referralCode || '').trim().toUpperCase();

  // Email sekarang WAJIB diisi di sini (bukan opsional lagi) -- dipakai buat login (lihat
  // POST /login) & buat kirim kode OTP di fitur Lupa Password. Validasi format/keunikan yang
  // lebih detail ada di createUser() (lib/users.js), di sini cuma cek kosong-atau-nggak dulu
  // biar pesan error paling umum ("wajib diisi") muncul duluan sebelum validasi yang lebih rinci.
  if (!username || !email || !password) {
    return res.render('register', { error: 'Username, email, dan password wajib diisi', refCode, config: cfg, pageTitle, noindex: true });
  }
  if (password !== password2) {
    return res.render('register', { error: 'Konfirmasi password tidak cocok', refCode, config: cfg, pageTitle, noindex: true });
  }
  if (password.length < 6) {
    return res.render('register', { error: 'Password minimal 6 karakter', refCode, config: cfg, pageTitle, noindex: true });
  }

  // Kode referral SIFATNYA OPSIONAL ("berlaku opsional") -- kalau field-nya dikosongin, langsung
  // lewat aja tanpa nyambungin ke siapa2. TAPI kalau user SEMPAT isi sesuatu, kodenya harus valid
  // (nemu pemiliknya) -- gak didiemin gitu aja kalau salah ketik, biar orang yang ngundang gak
  // kehilangan komisinya cuma gara2 typo yang gak ketahuan.
  let referrer = null;
  if (refCode) {
    referrer = findUserByReferralCode(refCode);
    if (!referrer) {
      return res.render('register', { error: 'Kode referral tidak ditemukan. Kosongkan kalau tidak punya kode.', refCode, config: cfg, pageTitle, noindex: true });
    }
  }

  try {
    const user = createUser({ username, email, password, referredBy: referrer ? referrer.id : '' });
    req.session.user = { id: user.id, username: user.username, role: user.role };
    notifyRegister({ username: user.username }).catch(() => {});
    res.redirect('/produk');
  } catch (err) {
    res.render('register', { error: err.message, refCode, config: cfg, pageTitle, noindex: true });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ---------- LUPA PASSWORD (OTP via email) ----------
// Alur: /lupa-password (isi email) -> kode OTP 6 digit dikirim ke email -> /reset-password
// (isi kode + password baru). Kode di-hash (sha256) & disimpan di data user sendiri (lihat
// lib/users.js generateResetOtp/verifyResetOtp), bukan di tabel/file terpisah.
//
// KEAMANAN: pesan sukses di POST /lupa-password SENGAJA SAMA baik email-nya kedaftar atau
// nggak ("kalau email terdaftar, kode sudah dikirim") -- ini standar buat cegah "user
// enumeration" (orang iseng nebak-nebak email mana aja yang punya akun di situs ini cuma
// dari beda/samanya pesan error). Yang beneran nentuin sukses/gagal reset password itu proses
// verifikasi KODE OTP-nya di /reset-password, bukan pesan di step ini.
router.get('/lupa-password', (req, res) => {
  if (req.session.user) return res.redirect('/produk');
  const cfg = getConfig();
  res.render('lupa-password', { error: null, info: null, config: cfg, pageTitle: `Lupa Password - ${cfg.siteName || 'NEXORDER'}`, noindex: true });
});

router.post('/lupa-password', async (req, res) => {
  const cfg = getConfig();
  const pageTitle = `Lupa Password - ${cfg.siteName || 'NEXORDER'}`;
  const email = String(req.body.email || '').trim().toLowerCase();

  if (!email) {
    return res.render('lupa-password', { error: 'Email wajib diisi', info: null, config: cfg, pageTitle, noindex: true });
  }
  if (!isSmtpConfigured()) {
    // Ini error KONFIGURASI (admin belum isi SMTP di Pengaturan), bukan salah user -- boleh
    // ditampilkan apa adanya (beda dari kasus "email gak ketemu" yang sengaja disamarkan di atas).
    return res.render('lupa-password', { error: 'Fitur reset password lewat email belum aktif. Hubungi admin.', info: null, config: cfg, pageTitle, noindex: true });
  }

  try {
    const user = findUserByEmail(email);
    // Sekarang LANGSUNG tampilkan pesan error kalau email gak terdaftar -- owner toko ini
    // lebih prefer UX yang jelas ("email gak ketemu") daripada perlindungan user-enumeration
    // (yang lebih relevan buat platform skala besar). Ini juga sekalian mastiin kode OTP
    // CUMA dikirim kalau emailnya beneran ada di DB, bukan buang resource kirim email ke
    // alamat yang gak terdaftar sama sekali.
    if (!user) {
      return res.render('lupa-password', {
        error: 'Email tidak ditemukan. Pastikan kamu memasukkan email yang dipakai saat daftar.',
        info: null, config: cfg, pageTitle, noindex: true
      });
    }
    const cooldown = canRequestResetOtp(user);
    if (!cooldown.ok) {
      return res.render('lupa-password', { error: `Tunggu ${cooldown.waitSeconds} detik lagi sebelum minta kode baru.`, info: null, config: cfg, pageTitle, noindex: true });
    }
    const otp = generateResetOtp(user.id);
    await sendResetOtpEmail(user.email, otp, cfg.siteName, cfg);
    res.redirect('/reset-password?email=' + encodeURIComponent(email) + '&sent=1');
  } catch (err) {
    console.error('[auth] Gagal kirim OTP reset password:', err.message);
    res.render('lupa-password', { error: 'Gagal mengirim email. Coba lagi beberapa saat, atau hubungi admin kalau terus gagal.', info: null, config: cfg, pageTitle, noindex: true });
  }
});

router.get('/reset-password', (req, res) => {
  if (req.session.user) return res.redirect('/produk');
  const cfg = getConfig();
  res.render('reset-password', {
    error: null,
    sent: req.query.sent === '1',
    prefillEmail: req.query.email || '',
    config: cfg,
    pageTitle: `Reset Password - ${cfg.siteName || 'NEXORDER'}`,
    noindex: true
  });
});

router.post('/reset-password', (req, res) => {
  const cfg = getConfig();
  const pageTitle = `Reset Password - ${cfg.siteName || 'NEXORDER'}`;
  const email = String(req.body.email || '').trim().toLowerCase();
  const { otp, password, password2 } = req.body;
  const renderError = (msg) => res.render('reset-password', { error: msg, sent: true, prefillEmail: email, config: cfg, pageTitle, noindex: true });

  if (!email || !otp || !password) {
    return renderError('Semua field wajib diisi');
  }
  if (password !== password2) {
    return renderError('Konfirmasi password tidak cocok');
  }
  if (password.length < 6) {
    return renderError('Password minimal 6 karakter');
  }

  // Pesan error DI SINI boleh spesifik ("kode salah"/"kedaluwarsa") -- beda dari step 1, karena
  // di titik ini penyerang udah harus nebak KODE OTP 6 digit yang bener dulu (bukan cuma nebak
  // email terdaftar atau nggak), jadi gak nambah risiko user-enumeration yang berarti.
  const user = findUserByEmail(email);
  if (!user) {
    return renderError('Kode OTP salah atau sudah kedaluwarsa');
  }
  const result = verifyResetOtp(user, otp);
  if (!result.ok) {
    return renderError(result.reason);
  }

  setPassword(user.id, password);
  clearResetOtp(user.id);
  res.redirect('/login?success=' + encodeURIComponent('Password berhasil diganti. Silakan login pakai password baru.'));
});

export default router;
