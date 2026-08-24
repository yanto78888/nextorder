import { readDB, writeDB, genId } from './db.js';
import { findUserById, addSaldo, countReferredUsers } from './users.js';
import { getConfig } from './config.js';

// =====================================================================
// KOMISI REFERRAL
// Siapa aja yang daftar pakai kode referral orang lain (opsional, lihat routes/auth.js) akan
// "terikat" ke referrer itu SELAMANYA (referredBy disimpan sekali pas daftar, gak berubah lagi).
// Setiap kali akun itu SUKSES transaksi -- produk digital ATAU manual, bayar pakai Saldo ATAU
// QRIS ATAU API reseller, APAPUN jenis transaksinya -- referrer-nya otomatis dapet komisi PERSEN
// dari total transaksi itu, masuk langsung ke saldo referrer. BUKAN cuma transaksi pertama
// doang, tapi SETIAP transaksi sukses selama akun itu masih terikat ke referrer tsb. Satu angka
// persentase SAMA RATA berlaku ke SEMUA jenis produk (termasuk stok manual -- sempat ada skema
// komisi flat Rp terpisah khusus stok manual, tapi diminta dibalikin lagi ke persentase biar
// semua produk konsisten satu aturan), bisa diatur admin lewat halaman Pengaturan
// (config.referral.percent, lihat views/admin/settings.ejs bagian "Komisi Referral"). Default
// kalau belum pernah diatur: 1%.
// =====================================================================

export const REFERRAL_COMMISSION_PERCENT_DEFAULT = 1;

export function getReferralCommissionSettings() {
  const cfg = getConfig();
  const r = cfg.referral || {};
  return {
    percent: (typeof r.percent === 'number') ? r.percent : REFERRAL_COMMISSION_PERCENT_DEFAULT
  };
}

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

  const { percent } = getReferralCommissionSettings();
  const total = Number(orderTotal) || 0;
  if (total <= 0) return null;

  // Math.round bisa jatuh ke 0 buat item yang murah banget / persentase yang di-set kecil (mis.
  // 1% dari Rp 50 = Math.round(0.5) bisa jadi 0 tergantung pembulatan). Kalau dibiarkan match
  // `commission <= 0` di bawah, referrer diam-diam SAMA SEKALI GAK dapet komisi padahal
  // transaksinya beneran sukses & total-nya > 0 -- BUG yang bikin "komisi kadang gak masuk" buat
  // transaksi kecil. Fix: floor minimal Rp 1 kalau transaksinya valid, gak pernah biarkan hasil
  // pembulatan bikin komisi 0 begitu aja.
  const rawCommission = Math.round(total * percent / 100);
  const commission = (rawCommission <= 0 && percent > 0) ? 1 : rawCommission;
  if (commission <= 0) return null;

  addSaldo(referrer.id, commission, {
    reason: `Komisi referral ${percent}% dari transaksi ${buyer.username}`,
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
    orderTotal: total,
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
