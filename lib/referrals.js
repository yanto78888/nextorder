import { readDB, writeDB, genId } from './db.js';
import { findUserById, addSaldo, countReferredUsers } from './users.js';
import { getConfig } from './config.js';

// =====================================================================
// KOMISI REFERRAL
// Siapa aja yang daftar pakai kode referral orang lain (opsional, lihat routes/auth.js) akan
// "terikat" ke referrer itu SELAMANYA (referredBy disimpan sekali pas daftar, gak berubah lagi).
// Setiap kali akun itu SUKSES transaksi -- produk digital ATAU manual, bayar pakai Saldo ATAU
// QRIS ATAU API reseller, APAPUN jenis transaksinya -- referrer-nya otomatis dapet komisi, masuk
// langsung ke saldo referrer. BUKAN cuma transaksi pertama doang, tapi SETIAP transaksi sukses
// selama akun itu masih terikat ke referrer tsb.
//
// DUA SKEMA KOMISI (dibedain per PROVIDER produk yang dibeli, bukan per metode bayar):
//  - Produk stok manual (order.provider === 'manual'): KOMISI FLAT, nominal Rp TETAP per
//    transaksi berapa pun harga produknya (config.referral.manualFlatAmount, default Rp 500).
//  - Semua provider lain (digiflazz/indosmm/otp/dst): KOMISI PERSEN dari total transaksi
//    (config.referral.percent, default 1%) -- perilaku lama, gak berubah.
// Keduanya diatur admin lewat halaman Pengaturan > "Komisi Referral".
// =====================================================================

export const REFERRAL_COMMISSION_PERCENT_DEFAULT = 1;
export const REFERRAL_MANUAL_FLAT_AMOUNT_DEFAULT = 500;

export function getReferralCommissionSettings() {
  const cfg = getConfig();
  const r = cfg.referral || {};
  return {
    percent: (typeof r.percent === 'number') ? r.percent : REFERRAL_COMMISSION_PERCENT_DEFAULT,
    manualFlatAmount: (typeof r.manualFlatAmount === 'number') ? r.manualFlatAmount : REFERRAL_MANUAL_FLAT_AMOUNT_DEFAULT
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
// isManualStock: true kalau order.provider === 'manual' -- pakai skema FLAT, bukan persentase
// (lihat catatan skema di atas). SEMUA pemanggil WAJIB isi ini per-order (bukan digabung/
// dijumlah dulu dari beberapa order sekaligus) justru KARENA skemanya bisa beda-beda tiap order.
export function creditReferralCommission({ buyer, orderTotal, orderId, isManualStock }) {
  if (!buyer || !buyer.referredBy) return null;
  const referrer = findUserById(buyer.referredBy);
  if (!referrer) return null;

  const total = Number(orderTotal) || 0;
  if (total <= 0) return null; // order kosong/gratis -- gak ada transaksi beneran, gak ada komisi

  const { percent, manualFlatAmount } = getReferralCommissionSettings();
  let commission, reason;

  if (isManualStock) {
    commission = Math.round(Number(manualFlatAmount) || 0);
    reason = `Komisi referral Rp${commission.toLocaleString('id-ID')} (flat, stok manual) dari transaksi ${buyer.username}`;
  } else {
    // Math.round bisa jatuh ke 0 buat item yang murah banget / persentase yang di-set kecil (mis.
    // 1% dari Rp 50 = Math.round(0.5) bisa jadi 0 tergantung pembulatan). Kalau dibiarkan match
    // `commission <= 0` di bawah, referrer diam-diam SAMA SEKALI GAK dapet komisi padahal
    // transaksinya beneran sukses & total-nya > 0 -- BUG yang bikin "komisi kadang gak masuk"
    // buat transaksi kecil. Fix: floor minimal Rp 1 kalau transaksinya valid, gak pernah biarkan
    // hasil pembulatan bikin komisi 0 begitu aja.
    const rawCommission = Math.round(total * percent / 100);
    commission = (rawCommission <= 0 && percent > 0) ? 1 : rawCommission;
    reason = `Komisi referral ${percent}% dari transaksi ${buyer.username}`;
  }
  if (commission <= 0) return null; // mis. manualFlatAmount di-set 0 admin = fitur komisi manual sengaja dimatikan

  addSaldo(referrer.id, commission, {
    reason,
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
    scheme: isManualStock ? 'flat' : 'percent',
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
