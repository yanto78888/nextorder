// Perbaiki produk Digiflazz yang KETIMPA bug lama: waktu diimport, marginValue yang harusnya
// "null" (artinya "gak ada override, pakai margin default") malah kesimpen jadi angka 0 asli --
// gara-gara Number(null) di JS hasilnya 0, dan kode lama gak ngecek null (lihat lib/products.js,
// fungsi createProduct). Akibatnya SEMUA produk yang diimport lewat "Import" / "Import Semua Hasil"
// punya override permanen 0% / Rp0, jadi berapa pun Margin Default diubah di halaman
// /admin/digiflazz, harga jual produk ini gak akan pernah ikut naik/turun.
//
// Script ini SEKALI JALAN: cari produk Digiflazz yang tipe marginnya kosong ("Default" di UI) tapi
// nilainya kebaca 0 (bukan kosong) -- itu ciri khas bug ini, bukan override yang sengaja dibuat
// (override yang sengaja SELALU punya tipe % atau Rp, gak mungkin "Default" + ada angka). Lalu
// benerin nilainya jadi null & hitung ulang harga jual pakai margin default yang berlaku sekarang.
//
// Cara pakai: jalankan sekali di root project -> node scripts/fix-digiflazz-margin-null.js
// Aman dijalankan berkali-kali (kalau udah bersih, tinggal bilang "gak ada yang perlu diubah").

import { getAllProducts, updateProduct } from '../lib/products.js';
import { computeSellPrice } from '../lib/digiflazz.js';

function run() {
  const products = getAllProducts().filter(p => p.provider === 'digiflazz');

  if (products.length === 0) {
    console.log('Gak ada produk Digiflazz ditemukan. Gak ada yang perlu diubah.');
    return;
  }

  const affected = products.filter(p => !p.marginType && p.marginValue === 0);

  if (affected.length === 0) {
    console.log('Gak ada produk yang kena bug ini. Semua aman, gak ada yang perlu diubah.');
    return;
  }

  console.log('Ditemukan', affected.length, 'dari', products.length, 'produk Digiflazz yang kena bug marginValue 0:');
  affected.forEach(p => {
    const newPrice = computeSellPrice(p.digiflazzBasePrice, null, null);
    console.log(' -', p.name, ': harga jual Rp' + p.price.toLocaleString('id-ID'), '->', 'Rp' + newPrice.toLocaleString('id-ID'));
    updateProduct(p.id, { marginValue: null, price: newPrice });
  });

  console.log('===================================================');
  console.log(' Selesai. Total produk diperbaiki:', affected.length);
  console.log(' Harga jual mereka sekarang ngikutin Margin Default yang aktif sekarang.');
  console.log(' Kalau mau ubah margin default lagi nanti, harga produk ini bakal otomatis');
  console.log(' ikut update juga (perbaikan lain yang udah dipasang bareng patch ini).');
  console.log('===================================================');
}

run();
