import bcrypt from 'bcryptjs';
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
  const hash = bcrypt.hashSync(password, 10);
  const user = {
    id: genId('U'),
    username,
    email: email || '',
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
