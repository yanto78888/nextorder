import { readDB, writeDB, genId } from './db.js';
import { getConfig } from './config.js';

// =====================================================================
// PENARIKAN SALDO (withdrawal) -- kebalikan dari deposit: user MINTA saldo-nya dicairkan jadi
// uang asli ke e-wallet (GoPay/ShopeePay). BEDA dari deposit, di sini TIDAK ADA gateway otomatis
// yang bisa langsung transfer keluar -- admin yang transfer manual dari HP-nya sendiri, lalu
// tandai selesai di dashboard admin. Saldo dipotong LANGSUNG saat pengajuan dibuat (bukan pas
// admin approve) supaya user gak bisa ajukan 2x dari saldo yang sama sambil nunggu diproses;
// kalau admin TOLAK pengajuannya, saldo dikembalikan penuh (lihat updateWithdrawalStatus).
// =====================================================================

const TABLE = 'withdrawals';

export function getAllWithdrawals() {
  return readDB(TABLE, []);
}

export function getWithdrawalsByUser(userId) {
  return getAllWithdrawals()
    .filter(w => w.userId === userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export function findWithdrawalById(id) {
  return getAllWithdrawals().find(w => w.id === id) || null;
}

export function createWithdrawalRecord({ userId, username, amount, method, targetNumber, targetName = '' }) {
  const list = getAllWithdrawals();
  const record = {
    id: genId('WD'),
    userId,
    username,
    amount: Number(amount) || 0,
    method, // 'gopay' | 'shopeepay'
    targetNumber: String(targetNumber || '').trim(),
    targetName: String(targetName || '').trim(),
    status: 'pending', // pending -> completed | rejected
    adminNote: '',
    createdAt: new Date().toISOString(),
    processedAt: null
  };
  list.push(record);
  writeDB(TABLE, list);
  return record;
}

// status: 'completed' (admin sudah transfer manual) atau 'rejected' (ditolak, saldo di-refund
// oleh CALLER -- fungsi ini cuma update record-nya, refund saldo dilakukan di routes/admin.js
// pakai addSaldo supaya tercatat juga di saldoLedger dengan reason yang jelas).
export function updateWithdrawalStatus(id, status, adminNote = '') {
  const list = getAllWithdrawals();
  const idx = list.findIndex(w => w.id === id);
  if (idx === -1) return null;
  list[idx] = { ...list[idx], status, adminNote, processedAt: new Date().toISOString() };
  writeDB(TABLE, list);
  return list[idx];
}

// Pengaturan penarikan (diisi admin lewat halaman Admin > Penarikan Saldo). Disimpan di
// config.withdraw supaya konsisten sama pola config.qris/config.telegram/dst di lib/config.js.
export function getWithdrawSettings() {
  const w = getConfig().withdraw || {};
  return {
    enabled: w.enabled !== false, // default nyala kalau belum pernah diatur
    min: Number(w.min) || 20000
  };
}
