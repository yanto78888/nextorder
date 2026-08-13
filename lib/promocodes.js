import { readDB, writeDB, genId } from './db.js';

// =====================================================================
// KODE PROMO
// Diskon NOMINAL TETAP (mis. potong Rp 2.000, bukan persenan) dengan syarat MINIMAL BELANJA
// opsional (mis. min. Rp 50.000), dibuat & dihapus admin, dengan batas TOTAL berapa kali kode
// ini boleh kepakai (maxUses, gabungan semua user) dan tiap user CUMA BOLEH pakai kode yang sama
// SATU KALI (gak bisa dobel) -- dicek dari riwayat redemptions, bukan dibatasi per sesi/browser
// (biar gak bisa dikelabui logout-login akun baru pakai email lain, tapi TETAP kepakai
// berkali-kali kalau memang user berbeda beneran, sesuai kuota maxUses-nya).
//
// Disimpan di data/promocodes.json (array), pola persis sama kayak lib/flashsale.js.
// =====================================================================

export function getAllPromoCodes() {
  return readDB('promocodes', []);
}

function savePromoCodes(items) {
  writeDB('promocodes', items);
}

export function findPromoByCode(code) {
  const clean = String(code || '').trim().toUpperCase();
  if (!clean) return null;
  return getAllPromoCodes().find(p => p.code === clean) || null;
}

export function findPromoById(id) {
  return getAllPromoCodes().find(p => p.id === id) || null;
}

// Kode promo SENGAJA dibatasi format-nya (huruf besar/angka/-/_ , 3-20 karakter) -- bukan cuma
// kosmetik, tapi supaya gampang diketik ulang manual sama customer dari mana pun kode itu
// dibagikan (caption Instagram, grup WhatsApp, dll) tanpa typo karena huruf besar/kecil beda.
const CODE_PATTERN = /^[A-Z0-9_-]{3,20}$/;

export function createPromoCode({ code, discountAmount, minPurchase, maxUses }) {
  const cleanCode = String(code || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!cleanCode) throw new Error('Kode promo tidak boleh kosong');
  if (!CODE_PATTERN.test(cleanCode)) {
    throw new Error('Kode promo 3-20 karakter, cuma huruf/angka/-/_ (tanpa spasi)');
  }

  const amount = Math.round(Number(discountAmount));
  if (!Number.isFinite(amount) || amount < 1) {
    throw new Error('Nominal diskon harus lebih dari Rp 0');
  }

  // minPurchase 0/kosong = gak ada syarat minimal, siapa aja boleh pakai berapapun belanjanya
  const minBuy = Math.max(0, Math.round(Number(minPurchase)) || 0);

  const uses = Math.max(1, parseInt(maxUses, 10) || 1);

  const items = getAllPromoCodes();
  if (items.some(p => p.code === cleanCode)) {
    throw new Error(`Kode promo "${cleanCode}" sudah ada, pakai kode lain`);
  }

  const item = {
    id: genId('PROMO'),
    code: cleanCode,
    discountAmount: amount, // potongan NOMINAL tetap dalam Rupiah, bukan persen
    minPurchase: minBuy,    // 0 = tanpa syarat minimal belanja
    maxUses: uses, // total kuota GABUNGAN semua user, bukan per-user
    usedCount: 0,
    redemptions: [], // { userId, username, usedAt } -- riwayat siapa aja yang udah pakai
    active: true,
    createdAt: new Date().toISOString()
  };
  items.push(item);
  savePromoCodes(items);
  return item;
}

export function deletePromoCode(id) {
  savePromoCodes(getAllPromoCodes().filter(p => p.id !== id));
}

export function setPromoActive(id, active) {
  const items = getAllPromoCodes();
  const promo = items.find(p => p.id === id);
  if (!promo) return null;
  promo.active = !!active;
  savePromoCodes(items);
  return promo;
}

// total = TOTAL belanja saat ini (sebelum diskon) -- WAJIB dikirim buat ngecek syarat minPurchase.
// Dipanggil 2x per checkout yang pakai kode promo: (1) validasi cepat lewat AJAX pas user klik
// "Terapkan" di halaman produk (lihat POST /promo/validate di routes/user.js), dan (2) validasi
// ULANG di server persis sebelum order beneran dibuat (POST /order & /order/qris-init) --
// TIDAK cukup percaya hasil cek AJAX yang pertama, soalnya form checkout bisa aja disubmit
// manual/langsung tanpa lewat AJAX itu (atau kuotanya keburu habis dipakai orang lain di antara
// dua request itu, atau qty-nya diubah lagi setelah validasi awal sehingga gak capai minPurchase
// lagi). Fungsi ini SENGAJA read-only (gak nambah usedCount) -- itu tugas redeemPromoCode() yang
// dipanggil TERPISAH setelah order-nya beneran sukses.
export function validatePromoForUser(code, userId, total = 0) {
  const promo = findPromoByCode(code);
  if (!promo) return { valid: false, reason: 'Kode promo tidak ditemukan' };
  if (!promo.active) return { valid: false, reason: 'Kode promo ini sudah tidak aktif' };
  if (promo.usedCount >= promo.maxUses) {
    return { valid: false, reason: 'Kode promo ini sudah mencapai batas penggunaan' };
  }
  if (promo.redemptions.some(r => r.userId === userId)) {
    return { valid: false, reason: 'Kamu sudah pernah pakai kode promo ini' };
  }
  if (promo.minPurchase > 0 && total < promo.minPurchase) {
    return { valid: false, reason: `Minimal belanja Rp ${promo.minPurchase.toLocaleString('id-ID')} untuk pakai kode ini` };
  }
  return { valid: true, promo };
}

// amount = TOTAL belanja (bukan harga per unit) -- potongannya gak pernah lebih besar dari
// total-nya sendiri (biar gak jadi minus), dipakai sama-sama oleh preview harga (routes/user.js)
// dan checkout beneran, biar angka diskon yang ditampilkan ke user PERSIS SAMA dengan yang
// benar-benar dipotong.
export function computePromoDiscount(promo, amount) {
  if (!promo) return 0;
  return Math.min(amount, promo.discountAmount);
}

// Dipanggil SETELAH order beneran berhasil dibuat (bukan pas user baru klik "Terapkan") --
// naikin usedCount & catat userId, supaya kode yang sama gak bisa dipakai user itu lagi
// ("setiap orang hanya bisa masukin 1x, gak bisa dobel"). Guard usedCount/redemptions dicek
// ULANG di sini (bukan cuma di validatePromoForUser) buat jaga-jaga race kecil kalau 2 checkout
// pakai kode yang sama nyaris bersamaan -- daripada usedCount kebablasan lewat dari maxUses.
export function redeemPromoCode(code, userId, username = '') {
  const items = getAllPromoCodes();
  const promo = items.find(p => p.code === String(code || '').trim().toUpperCase());
  if (!promo) return null;
  if (promo.usedCount >= promo.maxUses) return promo;
  if (promo.redemptions.some(r => r.userId === userId)) return promo;
  promo.usedCount = (promo.usedCount || 0) + 1;
  promo.redemptions.push({ userId, username, usedAt: new Date().toISOString() });
  savePromoCodes(items);
  return promo;
}
