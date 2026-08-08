import { readDB, writeDB, genId } from './db.js';
import { getAllOrders } from './orders.js';
import { getAllProducts } from './products.js';

const DB = 'reviews';

export function getAllReviews() {
  return readDB(DB, []);
}

// BEDA UTAMA dari versi lama: ulasan sekarang dikumpulin per GRUP (mis. semua nominal "Mobile
// Legends" jadi 1 kumpulan ulasan), bukan per SKU/nominal persis. Alasannya: yang direview
// customer itu KUALITAS LAYANANNYA (cepat/lambat, legit/nggak) -- bukan hal yang beda antara beli
// 86 diamond vs 172 diamond. Dengan cara lama, ulasan kepencar tipis ke puluhan SKU & kebanyakan
// produk keliatan "belum ada ulasan" padahal gamenya udah laku ratusan kali.
// Versi "sekali hitung buat semua grup" dari getReviewStats -- dipakai pas render KATALOG (banyak
// kartu produk sekaligus), biar baca reviews.json cuma 1x TOTAL (bukan 1x per kartu). Sama pola
// efisiensinya kayak getTotalSoldMap() di lib/orders.js.
export function getAllReviewStatsMap() {
  const reviews = getAllReviews();
  const map = {};
  reviews.forEach(r => {
    if (!map[r.groupKey]) map[r.groupKey] = { count: 0, total: 0, breakdown: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 } };
    const entry = map[r.groupKey];
    entry.count += 1;
    entry.total += r.rating;
    const star = Math.min(5, Math.max(1, Math.round(r.rating)));
    entry.breakdown[star] += 1;
  });
  Object.keys(map).forEach(key => {
    map[key].avg = map[key].total / map[key].count;
  });
  return map;
}

export function getReviewsByGroup(groupKey) {
  return getAllReviews().filter(r => r.groupKey === groupKey)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export function hasUserReviewedGroup(userId, groupKey) {
  return getAllReviews().some(r => r.userId === userId && r.groupKey === groupKey);
}

// Breakdown "X ulasan bintang 5, Y bintang 4, dst" + rata-rata -- dipakai buat progress bar
// breakdown rating di halaman detail produk.
export function getReviewStats(groupKey) {
  const reviews = getAllReviews().filter(r => r.groupKey === groupKey);
  const breakdown = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  let total = 0;
  reviews.forEach(r => {
    const star = Math.min(5, Math.max(1, Math.round(r.rating)));
    breakdown[star] += 1;
    total += r.rating;
  });
  const count = reviews.length;
  return {
    count,
    avg: count > 0 ? total / count : 0,
    breakdown
  };
}

// Resolusi groupKey yang KONSISTEN dipakai di semua tempat (bikin ulasan, cek udah-beli-belum,
// nampilin daftar/statistik) -- produk yang punya variantGroup (mis. semua nominal 1 game)
// dikumpulin jadi 1 kunci; produk berdiri sendiri (mis. pulsa nominal tunggal, gak ada variantGroup)
// pakai ID produknya sendiri sebagai kunci (grupnya = dirinya sendiri).
export function resolveReviewGroupKey(product) {
  return product.variantGroup || product.id;
}

// WAJIB PERNAH BELI buat bisa kasih ulasan -- dicek dari histori order yang statusnya 'completed'
// (produk beneran udah diterima, bukan cuma checkout/masih processing/dibatalkan+refund), untuk
// PRODUK MANAPUN yang satu grup sama groupKey ini (beli nominal 86 diamond ML, boleh ngulas
// "Mobile Legends" -- gak harus beli nominal yang PERSIS sama). Dihitung dari data order asli,
// bukan localStorage/session -- gak bisa dimanipulasi dari sisi browser.
export function hasUserPurchasedGroup(userId, groupKey) {
  const products = getAllProducts();
  const productIdsInGroup = new Set(
    products.filter(p => resolveReviewGroupKey(p) === groupKey).map(p => p.id)
  );
  if (productIdsInGroup.size === 0) return false;
  return getAllOrders().some(o =>
    o.userId === userId && o.status === 'completed' && productIdsInGroup.has(o.productId)
  );
}

export function createReview({ userId, username, productId, productName, groupKey, rating, comment }) {
  if (!hasUserPurchasedGroup(userId, groupKey)) {
    throw new Error('Kamu harus beli & selesaikan pesanan produk ini dulu sebelum bisa kasih ulasan.');
  }
  const reviews = getAllReviews();
  // 1 ulasan per user per GRUP (bukan per SKU) -- beli 2 nominal beda di game yang sama tetap cuma
  // boleh 1 ulasan buat game itu, biar gak numpuk beberapa ulasan dari orang yang sama.
  if (reviews.some(r => r.userId === userId && r.groupKey === groupKey)) {
    throw new Error('Kamu sudah memberikan ulasan untuk produk ini.');
  }
  const review = {
    id: genId('REV'),
    userId,
    username,
    productId,
    productName,
    groupKey,
    rating: Math.min(5, Math.max(1, parseInt(rating) || 5)),
    comment: (comment || '').trim().slice(0, 500),
    createdAt: new Date().toISOString(),
    approved: true
  };
  reviews.unshift(review);
  writeDB(DB, reviews);

  const stats = getReviewStats(groupKey);
  return { review, avg: stats.avg, count: stats.count };
}

export function deleteReview(id) {
  const reviews = getAllReviews().filter(r => r.id !== id);
  writeDB(DB, reviews);
}

export function getRecentReviews(limit = 10) {
  return getAllReviews().slice(0, limit);
}
