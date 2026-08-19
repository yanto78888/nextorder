import { readDB, writeDB, genId } from './db.js';
import { findUserById, addSaldo, countReferredUsers } from './users.js';
import { getConfig } from './config.js';

// =====================================================================
// KOMISI REFERRAL
// Siapa aja yang daftar pakai kode referral orang lain (opsional, lihat routes/auth.js) akan
// "terikat" ke referrer itu SELAMANYA (referredBy disimpan sekali pas daftar, gak berubah lagi).
// Setiap kali akun itu SUKSES transaksi (saldo ATAU QRIS, lihat pemanggilan di routes/user.js &
// lib/orderQris.js), referrer-nya otomatis dapet komisi -- masuk langsung ke saldo referrer --
// BUKAN cuma transaksi pertama doang, tapi SETIAP transaksi sukses selama akun itu masih terikat
// ke referrer tsb. Besarannya BEDA per jenis produk & bisa diatur admin lewat halaman Pengaturan
// (config.referral, lihat views/admin/settings.ejs bagian "Komisi Referral"):
//   - Produk digital (auto Digiflazz/IndoSMM, isDigital=true) -> PERSEN dari total transaksi
//   - Produk manual (isDigital=false)                          -> nominal FLAT per transaksi
// Default kalau belum pernah diatur admin: 1% (digital) / Rp 500 (manual).
// =====================================================================

export const REFERRAL_COMMISSION_PERCENT_DEFAULT = 1;
export const REFERRAL_COMMISSION_FLAT_DEFAULT = 500;

export function getReferralCommissionSettings() {
  const cfg = getConfig();
  const r = cfg.referral || {};
  return {
    digitalPercent: (typeof r.digitalPercent === 'number') ? r.digitalPercent : REFERRAL_COMMISSION_PERCENT_DEFAULT,
    manualFlat: (typeof r.manualFlat === 'number') ? r.manualFlat : REFERRAL_COMMISSION_FLAT_DEFAULT
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
// isDigital: true buat produk auto (Digiflazz/IndoSMM, provider !== 'manual') -> komisi PERSEN
// dari orderTotal; false buat produk manual -> komisi FLAT, orderTotal cuma kepakai buat catatan
// riwayat (gak ngaruh ke besaran komisinya).
export function creditReferralCommission({ buyer, orderTotal, orderId, isDigital = false }) {
  if (!buyer || !buyer.referredBy) return null;
  const referrer = findUserById(buyer.referredBy);
  if (!referrer) return null;

  const { digitalPercent, manualFlat } = getReferralCommissionSettings();
  // Math.round bisa jatuh ke 0 buat item yang murah banget / persentase yang di-set kecil (mis.
  // 1% dari Rp 1.100 keliatan aman = Rp 11, tapi 1% dari Rp 50 = Math.round(0.5) bisa jadi 0 atau
  // 1 tergantung pembulatan, dan makin murah/makin kecil persennya makin gampang kena 0). Kalau
  // dibiarkan match `commission <= 0` di bawah, referrer diam-diam SAMA SEKALI GAK dapet komisi
  // padahal transaksinya beneran sukses & orderTotal-nya > 0 -- BUG yang bikin "komisi kadang gak
  // masuk" buat transaksi kecil. Fix: floor minimal Rp 1 kalau ini transaksi digital yang valid
  // (orderTotal > 0), gak pernah biarkan hasil pembulatan bikin komisi 0 begitu aja.
  const rawCommission = isDigital
    ? Math.round((Number(orderTotal) || 0) * digitalPercent / 100)
    : manualFlat;
  const commission = (isDigital && rawCommission <= 0 && Number(orderTotal) > 0 && digitalPercent > 0)
    ? 1
    : rawCommission;
  if (commission <= 0) return null;

  addSaldo(referrer.id, commission, {
    reason: isDigital
      ? `Komisi referral ${digitalPercent}% dari transaksi ${buyer.username}`
      : `Komisi referral Rp ${commission.toLocaleString('id-ID')} dari transaksi ${buyer.username}`,
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
