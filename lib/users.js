import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { readDB, writeDB, genId } from './db.js';
import { MEMBERSHIP_TIERS, getMembershipTier } from './membership.js';
import { recordSaldoMutation } from './saldoLedger.js';

export function getAllUsers() {
  return readDB('users', []);
}

export function findUserById(id) {
  return getAllUsers().find(u => u.id === id) || null;
}

export function findUserByUsername(username) {
  return getAllUsers().find(
    u => u.username.toLowerCase() === String(username).toLowerCase()
  ) || null;
}

export function findUserByGoogleId(googleId) {
  if (!googleId) return null;
  return getAllUsers().find(u => u.googleId === googleId) || null;
}

export function findUserByEmail(email) {
  if (!email) return null;
  const target = String(email).toLowerCase();
  return getAllUsers().find(u => (u.email || '').toLowerCase() === target) || null;
}

// ---------- API KEY (buat sistem transaksi via API / reseller) ----------
// Format: "nxot_"/"nxod_" + 40 karakter hex acak -- prefix beda per SCOPE (transaction/deposit)
// biar sekilas kelihatan dari nama key-nya ini buat apa, dan biar gampang dibedain dari id/token
// lain. SENGAJA DIPISAH jadi 2 key independen (bukan 1 key buat semua) supaya kalau salah satu
// bocor -- misalnya key transaksi ke-share ke pihak lain buat integrasi jualan -- pihak itu TETAP
// gak bisa bikin/cek deposit atas nama akun ini, dan sebaliknya. Tiap key WAJIB terikat 1 alamat
// IPv6 (diisi user sendiri saat generate) -- request API cuma diterima dari IP itu, jadi key yang
// bocor pun gak bisa dipakai dari IP lain.
const API_KEY_SCOPES = ['transaction', 'deposit'];

function apiKeyField(scope) { return scope === 'deposit' ? 'apiKeyDeposit' : 'apiKeyTransaction'; }
function apiKeyIpField(scope) { return scope === 'deposit' ? 'apiKeyDepositIp' : 'apiKeyTransactionIp'; }
function apiKeyCreatedField(scope) { return scope === 'deposit' ? 'apiKeyDepositCreatedAt' : 'apiKeyTransactionCreatedAt'; }

// Balikin { user, scope } kalau ketemu, null kalau gak ada key yang cocok di scope manapun.
export function findUserByApiKey(apiKey) {
  if (!apiKey) return null;
  const users = getAllUsers();
  for (const scope of API_KEY_SCOPES) {
    const field = apiKeyField(scope);
    const user = users.find(u => u[field] && u[field] === apiKey);
    if (user) return { user, scope };
  }
  return null;
}

// Bikin API key baru buat 1 scope tertentu (regenerate/rotate langsung bikin key lama scope itu
// gak berlaku lagi -- cukup ganti field-nya, key lama gak disimpan di tempat lain jadi otomatis
// invalid begitu diganti). `ipv6` WAJIB diisi -- lihat validasi format di routes/user.js.
export function generateApiKey(id, scope, ipv6) {
  if (!API_KEY_SCOPES.includes(scope)) throw new Error('Scope API key tidak valid');
  const prefix = scope === 'deposit' ? 'nxod_' : 'nxot_';
  const apiKey = prefix + crypto.randomBytes(20).toString('hex');
  updateUser(id, {
    [apiKeyField(scope)]: apiKey,
    [apiKeyIpField(scope)]: ipv6,
    [apiKeyCreatedField(scope)]: new Date().toISOString()
  });
  return apiKey;
}

export function revokeApiKey(id, scope) {
  if (!API_KEY_SCOPES.includes(scope)) throw new Error('Scope API key tidak valid');
  return updateUser(id, { [apiKeyField(scope)]: '', [apiKeyIpField(scope)]: '', [apiKeyCreatedField(scope)]: '' });
}

// Username unik dari bagian sebelum "@" email Google, dibersihin ke charset yang sama kayak
// validasi username di halaman Profil (huruf/angka/titik/underscore/strip, lihat routes/admin.js),
// terus ditambah angka di belakang kalau ternyata sudah kepakai user lain.
function generateUsernameFromEmail(email, existingUsers) {
  let base = String(email || 'user').split('@')[0].toLowerCase().replace(/[^a-z0-9_.-]/g, '');
  if (base.length < 3) base = (base + 'user').slice(0, 3) + base.slice(3);
  base = base.slice(0, 20);
  const taken = new Set(existingUsers.map(u => u.username.toLowerCase()));
  let candidate = base;
  let i = 1;
  while (taken.has(candidate.toLowerCase())) {
    candidate = `${base}${i}`;
    i++;
  }
  return candidate;
}

// Dipanggil pas login via Google. Urutan pencarian:
// 1. googleId udah pernah dipakai login sebelumnya -> pakai akun itu.
// 2. Belum pernah, tapi emailnya sama kayak akun lokal yang udah ada (daftar manual username-
//    password) -> akun lokal itu yang dipakai & di-"tempel" googleId-nya (link), BUKAN bikin akun
//    baru terpisah, biar saldo/riwayat order yang udah ada gak kepecah jadi 2 akun beda cuma
//    gara-gara beda cara login.
// 3. Beneran baru -> bikin akun baru, role 'user', saldo 0, TANPA password lokal (password: '') --
//    akun ini cuma bisa login lewat Google sampai user bikin password sendiri di halaman Profil.
export function findOrCreateGoogleUser({ googleId, email, name, picture }) {
  const byGoogleId = findUserByGoogleId(googleId);
  if (byGoogleId) {
    if (picture && !byGoogleId.avatar) return updateUser(byGoogleId.id, { avatar: picture });
    return byGoogleId;
  }

  const byEmail = findUserByEmail(email);
  if (byEmail) {
    return updateUser(byEmail.id, {
      googleId,
      avatar: byEmail.avatar || picture || ''
    });
  }

  const users = getAllUsers();
  const user = {
    id: genId('U'),
    username: generateUsernameFromEmail(email, users),
    email: email || '',
    password: '',
    googleId,
    avatar: picture || '',
    role: 'user',
    saldo: 0,
    status: 'active',
    membership: 'reguler',
    createdAt: new Date().toISOString()
  };
  users.push(user);
  writeDB('users', users);
  return user;
}

export function createUser({ username, email, password, role = 'user' }) {
  const users = getAllUsers();
  if (findUserByUsername(username)) {
    throw new Error('Username sudah digunakan');
  }
  // Email sekarang WAJIB & jadi kunci login (lihat routes/auth.js POST /login) -- makanya harus
  // dicek unik juga di sini, gak cuma username. Tanpa ini, 2 akun bisa kedaftar pakai email yang
  // sama & login jadi ambigu (findUserByEmail cuma balikin salah 1, yang lain gak akan pernah bisa
  // login lewat email walau passwordnya benar).
  const emailNormalized = String(email || '').trim().toLowerCase();
  if (!emailNormalized) {
    throw new Error('Email wajib diisi');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNormalized)) {
    throw new Error('Format email tidak valid');
  }
  if (findUserByEmail(emailNormalized)) {
    throw new Error('Email sudah digunakan');
  }
  const hash = bcrypt.hashSync(password, 10);
  const user = {
    id: genId('U'),
    username,
    email: emailNormalized,
    password: hash,
    role,
    saldo: 0,
    status: 'active',
    membership: 'reguler',
    createdAt: new Date().toISOString()
  };
  users.push(user);
  writeDB('users', users);
  return user;
}

export function verifyPassword(user, password) {
  return bcrypt.compareSync(password, user.password);
}

export function updateUser(id, partial) {
  const users = getAllUsers();
  const idx = users.findIndex(u => u.id === id);
  if (idx === -1) throw new Error('User tidak ditemukan');
  users[idx] = { ...users[idx], ...partial };
  writeDB('users', users);
  return users[idx];
}

export function setPassword(id, newPassword) {
  const hash = bcrypt.hashSync(newPassword, 10);
  return updateUser(id, { password: hash });
}

// ---------- LUPA PASSWORD: OTP via email ----------
// Kode OTP 6 digit, HASH-nya (sha256) yang disimpan di data user -- BUKAN kode aslinya polos --
// jadi kalau file data/users.json ini somehow bocor, kode OTP yang lagi aktif gak langsung
// kepakai buat reset password akun orang. Kode asli cuma lewat sekali di badan email (lib/mailer.js).
const RESET_OTP_TTL_MS = 10 * 60 * 1000;   // berlaku 10 menit
const RESET_OTP_COOLDOWN_MS = 60 * 1000;    // jarak minimal sebelum boleh minta kode baru lagi
const RESET_OTP_MAX_ATTEMPTS = 5;           // salah tebak 5x, kode itu langsung dianggap invalid

function hashOtp(otp) {
  return crypto.createHash('sha256').update(String(otp)).digest('hex');
}

// Balikin { ok: false, waitSeconds } kalau masih kena cooldown (dipanggil SEBELUM generate kode
// baru, biar 1 tombol "kirim ulang" yang diklik berkali-kali gak nge-spam kotak masuk orang).
export function canRequestResetOtp(user) {
  if (!user.resetOtpRequestedAt) return { ok: true };
  const elapsed = Date.now() - new Date(user.resetOtpRequestedAt).getTime();
  if (elapsed < RESET_OTP_COOLDOWN_MS) {
    return { ok: false, waitSeconds: Math.ceil((RESET_OTP_COOLDOWN_MS - elapsed) / 1000) };
  }
  return { ok: true };
}

// Generate kode baru (6 digit, acak kriptografis), simpan HASH + waktu kedaluwarsa + reset
// counter percobaan -- kode ASLI (plaintext) dibalikin ke caller sekali doang buat dikirim
// lewat email (lib/mailer.js), gak pernah disimpan sendiri di data/users.json.
export function generateResetOtp(id) {
  const otp = String(crypto.randomInt(100000, 1000000)); // 6 digit, "0"-leading tetap aman krn string
  updateUser(id, {
    resetOtpHash: hashOtp(otp),
    resetOtpExpiresAt: new Date(Date.now() + RESET_OTP_TTL_MS).toISOString(),
    resetOtpRequestedAt: new Date().toISOString(),
    resetOtpAttempts: 0
  });
  return otp;
}

// Balikin { ok: true } kalau kode cocok & belum kedaluwarsa/kehabisan percobaan, atau
// { ok: false, reason } buat pesan error yang sesuai. TIDAK menghapus OTP dari sini -- caller
// (route POST /reset-password) yang panggil clearResetOtp() setelah password beneran diganti,
// biar 1 kode OTP yang sama gak bisa "dicoba lagi" walau requestnya gagal di tengah jalan.
export function verifyResetOtp(user, inputOtp) {
  if (!user.resetOtpHash || !user.resetOtpExpiresAt) {
    return { ok: false, reason: 'Kode OTP tidak ditemukan. Minta kode baru dulu.' };
  }
  if (Date.now() > new Date(user.resetOtpExpiresAt).getTime()) {
    return { ok: false, reason: 'Kode OTP sudah kedaluwarsa. Minta kode baru.' };
  }
  if ((user.resetOtpAttempts || 0) >= RESET_OTP_MAX_ATTEMPTS) {
    return { ok: false, reason: 'Terlalu banyak percobaan salah. Minta kode baru.' };
  }
  if (hashOtp(inputOtp) !== user.resetOtpHash) {
    updateUser(user.id, { resetOtpAttempts: (user.resetOtpAttempts || 0) + 1 });
    return { ok: false, reason: 'Kode OTP salah.' };
  }
  return { ok: true };
}

export function clearResetOtp(id) {
  return updateUser(id, { resetOtpHash: '', resetOtpExpiresAt: '', resetOtpRequestedAt: '', resetOtpAttempts: 0 });
}

export function getSaldo(id) {
  const u = findUserById(id);
  return u ? u.saldo : 0;
}

// opts (semua opsional): { reason, refType, refId } -- diteruskan ke ledger (lib/saldoLedger.js)
// buat halaman Riwayat Saldo. amount BOLEH negatif di sini (dipakai admin buat koreksi saldo
// turun lewat form yang sama, lihat POST /admin/users/:id/saldo) -- arah "masuk"/"keluar" di
// ledger ditentukan otomatis dari tanda amount, amount 0 gak dicatat (gak ada mutasi beneran).
export function addSaldo(id, amount, opts = {}) {
  const u = findUserById(id);
  if (!u) throw new Error('User tidak ditemukan');
  const delta = Number(amount) || 0;
  const newSaldo = (u.saldo || 0) + delta;
  updateUser(id, { saldo: newSaldo });
  if (delta !== 0) {
    recordSaldoMutation({
      userId: id,
      type: delta > 0 ? 'masuk' : 'keluar',
      amount: delta,
      balanceAfter: newSaldo,
      reason: opts.reason,
      refType: opts.refType,
      refId: opts.refId
    });
  }
  return newSaldo;
}

export function deductSaldo(id, amount, opts = {}) {
  const u = findUserById(id);
  if (!u) throw new Error('User tidak ditemukan');
  const delta = Number(amount) || 0;
  if ((u.saldo || 0) < delta) throw new Error('Saldo tidak cukup');
  const newSaldo = u.saldo - delta;
  updateUser(id, { saldo: newSaldo });
  if (delta > 0) {
    recordSaldoMutation({
      userId: id,
      type: 'keluar',
      amount: delta,
      balanceAfter: newSaldo,
      reason: opts.reason,
      refType: opts.refType,
      refId: opts.refId
    });
  }
  return newSaldo;
}

// Ambil persentase diskon (%) yang berlaku untuk user berdasarkan tier membership-nya
export function getMembershipDiscount(user) {
  return getMembershipTier(user?.membership).discountPercent;
}

// Upgrade membership user (Gold / Platinum), harga dipotong dari saldo user
export function upgradeMembership(id, tierKey) {
  const u = findUserById(id);
  if (!u) throw new Error('User tidak ditemukan');

  const tier = MEMBERSHIP_TIERS[tierKey];
  if (!tier || tierKey === 'reguler') throw new Error('Paket membership tidak valid');

  const currentTier = getMembershipTier(u.membership);
  if (currentTier.order >= tier.order) {
    throw new Error(`Kamu sudah member ${currentTier.label} atau lebih tinggi`);
  }

  if ((u.saldo || 0) < tier.price) {
    throw new Error('Saldo tidak cukup untuk upgrade membership, silakan topup dulu');
  }

  const newSaldo = u.saldo - tier.price;
  updateUser(id, { saldo: newSaldo, membership: tierKey });
  if (tier.price > 0) {
    recordSaldoMutation({
      userId: id,
      type: 'keluar',
      amount: tier.price,
      balanceAfter: newSaldo,
      reason: `Upgrade membership ke ${tier.label}`,
      refType: 'membership',
      refId: tierKey
    });
  }
  return findUserById(id);
}
