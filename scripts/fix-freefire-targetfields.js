// Bersihin field "Zone ID" dari produk Free Fire yang SUDAH ada di database kamu.
// Free Fire cuma butuh User ID -- gak ada konsep Zone/Server kayak Mobile Legends.
//
// Kenapa perlu script ini? Preset Free Fire di lib/gamePresets.js sudah diperbaiki supaya
// produk BARU otomatis cuma minta User ID. Tapi produk yang SUDAH dibuat sebelumnya (misal
// hasil import Digiflazz) sudah kepalang kesimpen dengan field Zone ID di data mereka masing-
// masing, dan itu gak otomatis ikut berubah cuma karena file preset-nya diedit. Jalankan
// script ini SEKALI biar semua produk Free Fire yang sudah ada ikut disamakan.
//
// Cara pakai: jalankan sekali di root project -> node scripts/fix-freefire-targetfields.js
// Aman dijalankan berkali-kali (kalau udah bersih, tinggal bilang "gak ada yang perlu diubah").

import { getAllProducts, updateProduct } from '../lib/products.js';

function run() {
  const products = getAllProducts();
  const freeFireProducts = products.filter(p => p.gamePreset === 'free_fire');

  if (freeFireProducts.length === 0) {
    console.log('Gak ada produk dengan gamePreset "free_fire" ditemukan. Gak ada yang perlu diubah.');
    return;
  }

  let updated = 0;
  freeFireProducts.forEach(p => {
    const hadZoneId = (p.targetFields || []).some(f => f.key === 'zoneId');
    // Update ulang pakai gamePreset yang sama supaya targetFields di-generate ulang dari
    // preset yang sudah diperbaiki (lihat normalizeTargetFields di lib/products.js).
    updateProduct(p.id, { gamePreset: 'free_fire' });
    if (hadZoneId) {
      console.log(' -', p.name, '(field Zone ID dihapus)');
      updated++;
    }
  });

  console.log('===================================================');
  console.log(' Selesai.');
  console.log(' Total produk Free Fire dicek :', freeFireProducts.length);
  console.log(' Yang field Zone ID-nya dihapus:', updated);
  console.log('===================================================');
}

run();
