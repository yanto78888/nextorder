import { readDB, writeDB, genId } from './db.js';

const DB = 'reviews';

export function getAllReviews() {
  return readDB(DB, []);
}

export function getReviewsByProduct(productId) {
  return getAllReviews().filter(r => r.productId === productId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export function hasUserReviewed(userId, productId) {
  return getAllReviews().some(r => r.userId === userId && r.productId === productId);
}

export function createReview({ userId, username, productId, productName, rating, comment }) {
  const reviews = getAllReviews();
  // 1 review per user per produk
  if (reviews.some(r => r.userId === userId && r.productId === productId)) {
    throw new Error('Kamu sudah memberikan ulasan untuk produk ini.');
  }
  const review = {
    id: genId('REV'),
    userId,
    username,
    productId,
    productName,
    rating: Math.min(5, Math.max(1, parseInt(rating) || 5)),
    comment: (comment || '').trim().slice(0, 500),
    createdAt: new Date().toISOString(),
    approved: true
  };
  reviews.unshift(review);
  writeDB(DB, reviews);

  // Update rating rata-rata di produk
  const productReviews = reviews.filter(r => r.productId === productId);
  return { review, avg: productReviews.reduce((s, r) => s + r.rating, 0) / productReviews.length, count: productReviews.length };
}

export function deleteReview(id) {
  const reviews = getAllReviews().filter(r => r.id !== id);
  writeDB(DB, reviews);
}

export function getRecentReviews(limit = 10) {
  return getAllReviews().slice(0, limit);
}
