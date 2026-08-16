import { readDB, writeDB, genId } from './db.js';
import { findUserById, addSaldo, countReferredUsers } from './users.js';

// =====================================================================
// KOMISI REFERRAL
// Siapa aja yang daftar pakai kode referral orang lain (opsional, lihat routes/auth.js) akan
// "terikat" ke referrer itu SELAMANYA (referredBy disimpan sekali pas daftar, gak berubah lagi).
// Setiap kali akun itu SUKSES transaksi (saldo ATAU QRIS, lihat pemanggilan di routes/user.js &
// lib/orderQris.js), referrer-nya otomatis dapet komisi FLAT Rp 500 per transaksi sukses, masuk
// langsung ke saldo referrer -- BUKAN cuma transaksi pertama doang, tapi SETIAP transaksi sukses
// selama akun itu masih terikat ke referrer tsb. Berlaku SAMA baik buat produk digital (auto
// Digiflazz/IndoSMM) maupun produk manual, gak dibedain besarannya lagi (sebelumnya persentase
// dari total transaksi, sekarang flat per keputusan terbaru).
// =====================================================================

export const REFERRAL_COMMISSION_FLAT = 500;

export function getReferralLog() {
  return readDB('referral-log', []);
}

function saveReferralLog(items) {
  writeDB('referral-log', items);
}

// Dipanggil SETELAH order beneran sukses (bukan pas checkout DIMULAI) -- kalau buyer gak
// direferensiin siapa2 (referredBy kosong) atau referrer-nya udah gak ada lagi (mis. dihapus
// admin), diam2 di-skip, gak dianggap error (transaksi buyer tetap jalan seperti biasa).
export function creditReferralCommission({ buyer, orderTotal, orderId }) {
  if (!buyer || !buyer.referredBy) return null;
  const referrer = findUserById(buyer.referredBy);
  if (!referrer) return null;

  const commission = REFERRAL_COMMISSION_FLAT;

  addSaldo(referrer.id, commission, {
    reason: `Komisi referral Rp ${commission.toLocaleString('id-ID')} dari transaksi ${buyer.username}`,
    refType: 'referral',
    refId: orderId
  });

  const log = getReferralLog();
  log.push({
    id: genId('REF'),
    referrerId: referrer.id,
    referrerUsername: referrer.username,
    buyerId: buyer.id,
    buyerUsername: buyer.username,
    orderId: orderId || '',
    orderTotal: Number(orderTotal) || 0,
    commission,
    createdAt: new Date().toISOString()
  });
  saveReferralLog(log);
  return commission;
}

// Statistik + riwayat komisi buat ditampilkan di halaman /referral milik user sendiri.
// referredCount SENGAJA dihitung dari countReferredUsers (data user langsung, lihat lib/users.js)
// -- BUKAN dari referral-log kayak totalEarned/transactionCount/history di bawah -- biar orang
// yang kodenya sudah "kepasang" (referredBy) tapi belum pernah transaksi TETAP kehitung sebagai
// "Orang Terundang", bukan cuma yang udah pernah bikin komisi.
export function getReferralStatsForUser(userId) {
  const mine = getReferralLog().filter(l => l.referrerId === userId);
  const totalEarned = mine.reduce((sum, l) => sum + l.commission, 0);
  const referredCount = countReferredUsers(userId);
  return {
    totalEarned,
    referredCount,
    transactionCount: mine.length,
    history: mine.slice().reverse() // terbaru duluan
  };
}

// Dipakai admin (opsional) buat lihat siapa aja yang direferensiin 1 user tertentu.
export function getReferredUserIds(referrerId) {
  return Array.from(new Set(getReferralLog().filter(l => l.referrerId === referrerId).map(l => l.buyerId)));
}
