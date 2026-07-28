// =====================================================================
// RATE LIMITER -- in-memory, per API key, fixed window 1 menit. SENGAJA in-memory (bukan
// disimpan ke file JSON) karena counter kayak gini berubah SANGAT sering (bisa puluhan kali per
// menit per key) -- nulis ke disk sesering itu bakal jadi bottleneck sendiri. Konsekuensinya:
// counter reset kalau server di-restart, yang acceptable karena cuma soal rate limiting sesaat,
// bukan data yang perlu bertahan.
// =====================================================================

const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS = 60;
const buckets = new Map(); // apiKey -> { count, windowStart }

export function checkRateLimit(key, max = MAX_REQUESTS) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    bucket = { count: 0, windowStart: now };
    buckets.set(key, bucket);
  }
  bucket.count += 1;
  return {
    allowed: bucket.count <= max,
    remaining: Math.max(0, max - bucket.count),
    resetInMs: WINDOW_MS - (now - bucket.windowStart)
  };
}

// Bersihkan bucket yang sudah lama gak dipakai biar Map-nya gak numpuk terus tanpa batas kalau
// banyak API key beda-beda dipakai (dipanggil berkala dari server.js).
export function cleanupRateLimitBuckets() {
  const now = Date.now();
  for (const [key, bucket] of buckets.entries()) {
    if (now - bucket.windowStart >= WINDOW_MS * 5) buckets.delete(key);
  }
}
