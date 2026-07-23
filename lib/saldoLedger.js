import { readDB, writeDB, genId } from './db.js';

// Buku besar mutasi saldo -- SETIAP kali saldo user berubah (topup, bayar order, refund,
// penyesuaian admin, upgrade membership, dst) dicatat 1 baris di sini. Terpisah dari field
// user.saldo (yang cuma nyimpen ANGKA TERKINI) -- ledger ini nyimpen RIWAYATNYA, dipakai
// buat halaman "Riwayat Saldo" (mutasi saldo masuk/keluar) di sisi user.
//
// SENGAJA modul terpisah (bukan ditaruh di lib/users.js) biar lib/users.js tetap fokus ke
// data akun, dan modul lain (deposit.js, orders.js via routes, dst) yang butuh baca riwayat
// ledger nanti gak perlu import lib/users.js segala.

export function getAllSaldoLedger() {
  return readDB('saldoLedger', []);
}

export function getSaldoLedgerByUser(userId, limit = null) {
  const list = getAllSaldoLedger()
    .filter(e => e.userId === userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return limit ? list.slice(0, limit) : list;
}

// Dipanggil dari lib/users.js (addSaldo/deductSaldo) dan beberapa tempat yang mengubah saldo
// LANGSUNG tanpa lewat 2 fungsi itu (mis. upgradeMembership). type HARUS 'masuk' atau 'keluar'
// -- amount selalu disimpan POSITIF (arah mutasi ditentukan dari `type`, bukan dari tanda +/-),
// biar gampang dijumlah di halaman ringkasan (Total Masuk / Total Keluar) tanpa perlu Math.abs lagi.
export function recordSaldoMutation({ userId, type, amount, balanceAfter, reason, refType = '', refId = '' }) {
  const list = getAllSaldoLedger();
  const entry = {
    id: genId('SLD'),
    userId,
    type, // 'masuk' | 'keluar'
    amount: Math.abs(Number(amount) || 0),
    balanceAfter: Number(balanceAfter) || 0,
    reason: reason || (type === 'masuk' ? 'Saldo masuk' : 'Saldo keluar'),
    refType, // 'deposit' | 'order' | 'membership' | 'admin' | ''
    refId: refId ? String(refId) : '',
    createdAt: new Date().toISOString()
  };
  list.push(entry);
  writeDB('saldoLedger', list);
  return entry;
}

// Total saldo masuk & keluar sepanjang waktu buat 1 user -- dipakai 2 kartu ringkasan di
// halaman Riwayat Saldo.
export function getSaldoLedgerSummary(userId) {
  const list = getAllSaldoLedger().filter(e => e.userId === userId);
  const totalMasuk = list.reduce((s, e) => s + (e.type === 'masuk' ? e.amount : 0), 0);
  const totalKeluar = list.reduce((s, e) => s + (e.type === 'keluar' ? e.amount : 0), 0);
  return { totalMasuk, totalKeluar };
}
