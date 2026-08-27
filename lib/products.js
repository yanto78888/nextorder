import { readDB, writeDB, genId } from './db.js';
import { getGamePreset } from './gamePresets.js';

// provider produk: 'manual' (stok sistem) | 'digiflazz' (auto topup game) | 'indosmm' (jasa sosmed)
function normalizeProvider(provider) {
  if (provider === 'digiflazz') return 'digiflazz';
  if (provider === 'indosmm') return 'indosmm';
  if (provider === 'otp') return 'otp';
  return 'manual';
}

// Normalisasi definisi target field (ID Game / Zone ID / UID / dll) yang perlu diisi user saat checkout.
// Kalau gamePreset bukan 'custom', field ikut preset. Kalau 'custom', pakai targetFields yang diinput admin sendiri.
function normalizeTargetFields(gamePreset, customFields) {
  const preset = getGamePreset(gamePreset);
  if (preset.key !== 'custom') return preset.fields;
  if (!Array.isArray(customFields)) return [];
  return customFields
    .filter(f => f && f.label && f.key)
    .map(f => ({
      key: String(f.key).trim(),
      label: String(f.label).trim(),
      placeholder: f.placeholder || '',
      required: f.required !== false
    }));
}

function normalizeStockItems(stockItems = []) {
  if (typeof stockItems === 'string') {
    // 1x submit boleh diisi BANYAK stok sekaligus, dipisah pakai karakter '|' (pipe) -- tiap
    // potongan di antara '|' jadi 1 item stok sendiri2 (boleh multi-baris di dalam 1 potongan,
    // mis. data akun lengkap: email\npassword\nPIN). Kalau gak ada '|' sama sekali, hasil split
    // otomatis cuma 1 potongan (isi utuh) -- ini SENGAJA biar tetap kompatibel sama cara lama
    // (1x tambah = 1 stok multi-baris) buat yang emang gak butuh bulk-add.
    return stockItems
      .split('|')
      .map(v => v.trim())
      .filter(Boolean)
      .map(value => ({ id: genId('STK'), value, createdAt: new Date().toISOString() }));
  }
  if (!Array.isArray(stockItems)) return [];
  return stockItems
    .map(item => {
      if (typeof item === 'string') return { id: genId('STK'), value: item, createdAt: new Date().toISOString() };
      return {
        id: item.id || genId('STK'),
        value: item.value || item.detail || '',
        createdAt: item.createdAt || new Date().toISOString()
      };
    })
    .filter(item => item.value);
}

export function getAllProducts() {
  return readDB('products', []).map(p => ({
    ...p,
    stockItems: normalizeStockItems(p.stockItems),
    gamePreset: p.gamePreset || 'none',
    targetFields: Array.isArray(p.targetFields) ? p.targetFields : [],
    provider: p.provider || 'manual', // manual (stok sistem) | digiflazz (auto topup game) | indosmm (jasa sosmed)
    digiflazzSku: p.digiflazzSku || '',
    digiflazzCustomerNoTemplate: p.digiflazzCustomerNoTemplate || '',
    digiflazzBasePrice: p.digiflazzBasePrice || 0, // harga modal terakhir dari Digiflazz, buat hitung ulang margin
    indosmmServiceId: p.indosmmServiceId || '', // ID service di IndoSMM
    indosmmRatePer1000: p.indosmmRatePer1000 || 0, // harga modal terakhir per 1000 dari IndoSMM
    indosmmMin: p.indosmmMin || 0, // qty minimal per order (dari IndoSMM)
    indosmmMax: p.indosmmMax || 0, // qty maksimal per order (dari IndoSMM)
    variantGroup: p.variantGroup || '', // produk dengan variantGroup sama ditampilkan sebagai pilihan nominal di 1 halaman (mis. semua nominal Mobile Legends)
    variantType: p.variantType || '', // sub-kelompok TAB nominal dalam 1 variantGroup (mis. "Reguler"/"Promo"/"Special Items") -- kosong = masuk tab "Reguler" default
    marginType: p.marginType || '', // '' = pakai margin default global, atau 'percent' | 'fixed' buat override per-produk
    marginValue: (typeof p.marginValue === 'number') ? p.marginValue : null,
    costPrice: Number(p.costPrice) || 0, // harga modal produk Stok Manual (diisi admin), dipakai buat hitung Pendapatan Bersih di dashboard
    // Panduan "cara menggunakan" produk (opsional, khusus Stok Manual) -- disimpan di PRODUK,
    // BUKAN di-tempel ke tiap order.detail, supaya: (1) tetap 1 kali tampil di invoice walau
    // qty beli banyak/beda2 -- gak ke-duplikat per unit stok, dan (2) tetap kebaca dengan benar
    // walau order-nya diselesaikan admin manual lewat /admin/order/:id/status (jalur itu nulis
    // detail order sendiri, gak lewat fulfillOrder -- jadi kalau instruksi ini ditaruh di
    // order.detail malah gak akan pernah muncul buat order yang diselesaikan manual).
    usageInstructions: p.usageInstructions || ''
  }));
}

export function getActiveProducts() {
  return getAllProducts().filter(p => p.status === 'active');
}

export function findProductById(id) {
  return getAllProducts().find(p => p.id === id) || null;
}

// Ubah nama grup/produk jadi slug URL yang enak dibaca (mis. "MOBILE LEGENDS" -> "mobile-legends"),
// dipakai buat link /produk/<slug> di beranda (lihat views/produk.ejs) & buat nyari balik
// produknya di GET /produk/:slug (routes/user.js) -- biar URL katalog gak lagi pakai kode acak
// (product id) yang gak ada artinya buat user/SEO. Fallback ke 'produk' kalau hasilnya kosong
// (mis. nama cuma berisi karakter simbol/emoji doang).
export function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'produk';
}

// Harga modal efektif satu produk: Digiflazz pakai harga modal yang otomatis disinkron dari
// provider (digiflazzBasePrice), sedangkan Stok Manual pakai costPrice yang diisi manual oleh
// admin di form produk (opsional, default 0 kalau belum diisi -- artinya belum ada data modal,
// jadi Pendapatan Bersih dihitung sama dengan Pendapatan Kotor buat produk itu, bukan dianggap rugi).
export function getProductCostPrice(product) {
  if (!product) return 0;
  if (product.provider === 'digiflazz') return Number(product.digiflazzBasePrice) || 0;
  // Modal IndoSMM dikutip per 1000 (mis. Rp 900/1000 follower) sedangkan qty order = jumlah unit
  // aslinya (mis. 500 follower) -- jadi modal PER UNIT qty di sini adalah rate/1000, biar tetap
  // konsisten dgn field costPrice lain yang dikali qty pas hitung Pendapatan Bersih.
  if (product.provider === 'indosmm') return (Number(product.indosmmRatePer1000) || 0) / 1000;
  return Number(product.costPrice) || 0;
}

export function countStock(product) {
  return normalizeStockItems(product?.stockItems).length;
}

export function createProduct({ name, category, description, price, stockNote, thumbnail, stockItems, gamePreset, customTargetFields, provider, digiflazzSku, digiflazzCustomerNoTemplate, variantGroup, variantType, digiflazzBasePrice, indosmmServiceId, indosmmRatePer1000, indosmmMin, indosmmMax, otpServiceCode, otpServiceName, otpCountryId, otpCountryName, otpBaseCostRub, marginType, marginValue, costPrice, usageInstructions }) {
  const products = getAllProducts();
  const preset = gamePreset || 'none';
  const prov = normalizeProvider(provider);
  const product = {
    id: genId('P'),
    name,
    category: category || 'Umum',
    description: description || '',
    price: Number(price) || 0,
    stockNote: stockNote || '',
    thumbnail: thumbnail || '',
    stockItems: normalizeStockItems(stockItems),
    gamePreset: preset,
    targetFields: normalizeTargetFields(preset, customTargetFields),
    provider: prov,
    digiflazzSku: prov === 'digiflazz' ? String(digiflazzSku || '').trim() : '',
    digiflazzCustomerNoTemplate: prov === 'digiflazz' ? String(digiflazzCustomerNoTemplate || '').trim() : '',
    digiflazzBasePrice: prov === 'digiflazz' ? (Number(digiflazzBasePrice) || 0) : 0,
    indosmmServiceId: prov === 'indosmm' ? String(indosmmServiceId || '').trim() : '',
    indosmmRatePer1000: prov === 'indosmm' ? (Number(indosmmRatePer1000) || 0) : 0,
    indosmmMin: prov === 'indosmm' ? (Number(indosmmMin) || 1) : 0,
    indosmmMax: prov === 'indosmm' ? (Number(indosmmMax) || 1) : 0,
    otpServiceCode: prov === 'otp' ? String(otpServiceCode || '').trim() : '',
    otpServiceName: prov === 'otp' ? String(otpServiceName || '').trim() : '',
    otpCountryId: prov === 'otp' ? String(otpCountryId ?? '').trim() : '',
    otpCountryName: prov === 'otp' ? String(otpCountryName || '').trim() : '',
    otpBaseCostRub: prov === 'otp' ? (Number(otpBaseCostRub) || 0) : 0,
    variantGroup: String(variantGroup || '').trim(),
    variantType: String(variantType || '').trim(),
    marginType: (prov === 'digiflazz' || prov === 'indosmm' || prov === 'otp') && (marginType === 'percent' || marginType === 'fixed') ? marginType : '',
    // PENTING: harus cek "!== null" juga, bukan cuma "!== undefined" & "!== ''". Tanpa ini,
    // marginValue: null (yang berarti "gak ada override, pakai margin default") kelolos ke
    // Number(null) yang hasilnya 0 -- lalu 0 itu KESIMPEN sebagai override asli produk ini,
    // bukan "kosong". Efeknya: computeSellPrice mikir produk ini punya override 0%/Rp0 permanen,
    // jadi margin default barapa pun diubah gak akan pernah kepakai buat produk ini.
    marginValue: (prov === 'digiflazz' || prov === 'indosmm' || prov === 'otp') && marginValue !== undefined && marginValue !== '' && marginValue !== null ? Number(marginValue) : null,
    costPrice: prov === 'manual' ? (Number(costPrice) || 0) : 0, // harga modal Stok Manual (opsional), buat hitung Pendapatan Bersih
    usageInstructions: prov === 'manual' ? String(usageInstructions || '').trim() : '',
    status: 'active',
    createdAt: new Date().toISOString()
  };
  products.push(product);
  writeDB('products', products);
  return product;
}

export function updateProduct(id, partial) {
  const products = getAllProducts();
  const idx = products.findIndex(p => p.id === id);
  if (idx === -1) throw new Error('Produk tidak ditemukan');

  const next = {
    ...products[idx],
    ...partial,
    price: partial.price !== undefined ? Number(partial.price) : products[idx].price
  };

  if (partial.provider !== undefined) {
    next.provider = normalizeProvider(partial.provider);
    if (next.provider !== 'digiflazz') {
      next.digiflazzSku = '';
      next.digiflazzCustomerNoTemplate = '';
    } else {
      next.digiflazzSku = String(partial.digiflazzSku !== undefined ? partial.digiflazzSku : products[idx].digiflazzSku || '').trim();
      next.digiflazzCustomerNoTemplate = String(partial.digiflazzCustomerNoTemplate !== undefined ? partial.digiflazzCustomerNoTemplate : products[idx].digiflazzCustomerNoTemplate || '').trim();
    }
    if (next.provider !== 'indosmm') {
      next.indosmmServiceId = '';
      next.indosmmMin = 0;
      next.indosmmMax = 0;
    } else {
      next.indosmmServiceId = String(partial.indosmmServiceId !== undefined ? partial.indosmmServiceId : products[idx].indosmmServiceId || '').trim();
      next.indosmmMin = Number(partial.indosmmMin !== undefined ? partial.indosmmMin : products[idx].indosmmMin) || 1;
      next.indosmmMax = Number(partial.indosmmMax !== undefined ? partial.indosmmMax : products[idx].indosmmMax) || 1;
    }
  }
  if (partial.indosmmRatePer1000 !== undefined) {
    next.indosmmRatePer1000 = Number(partial.indosmmRatePer1000) || 0;
  }

  if (partial.variantGroup !== undefined) {
    next.variantGroup = String(partial.variantGroup || '').trim();
  }
  if (partial.variantType !== undefined) {
    next.variantType = String(partial.variantType || '').trim();
  }
  if (partial.marginType !== undefined) {
    next.marginType = (partial.marginType === 'percent' || partial.marginType === 'fixed') ? partial.marginType : '';
  }
  if (partial.marginValue !== undefined) {
    next.marginValue = (partial.marginValue === '' || partial.marginValue === null) ? null : Number(partial.marginValue);
  }
  if (partial.digiflazzBasePrice !== undefined) {
    next.digiflazzBasePrice = Number(partial.digiflazzBasePrice) || 0;
  }
  if (partial.costPrice !== undefined) {
    next.costPrice = Number(partial.costPrice) || 0;
  }
  if (partial.usageInstructions !== undefined) {
    next.usageInstructions = String(partial.usageInstructions || '').trim();
  }

  if (partial.gamePreset !== undefined || partial.customTargetFields !== undefined) {
    const preset = partial.gamePreset !== undefined ? partial.gamePreset : (products[idx].gamePreset || 'none');
    next.gamePreset = preset;
    next.targetFields = normalizeTargetFields(preset, partial.customTargetFields);
  }
  delete next.customTargetFields;

  if (partial.stockItems !== undefined) {
    const newItems = normalizeStockItems(partial.stockItems);
    next.stockItems = [...normalizeStockItems(products[idx].stockItems), ...newItems];
  }

  products[idx] = next;
  writeDB('products', products);
  return products[idx];
}

// Upsert BANYAK produk IndoSMM sekaligus dalam SATU baca+tulis file (dipakai tombol "Tambah
// Layanan Terpilih" di Kelola Jasa Sosmed -> POST /admin/indosmm/import-batch). Pola PERSIS sama
// kayak deleteProductsByIds() di bawah ("Hapus Terpilih" produk) -- SATU kali getAllProducts(),
// diubah di MEMORI, SATU kali writeDB() di akhir.
//
// Sebelumnya batch import ini manggil createProduct()/updateProduct() SATU-SATU di dalam loop
// (lihat riwayat routes/admin.js) -- masing-masing baca+tulis ULANG SELURUH file products.json
// per item. Buat N layanan yang dicentang, itu N baca + N tulis file yang isinya makin gede
// tiap iterasi -- persis masalah "operasi massal dikirim sekali gede" yang sudah lebih dulu
// diperbaiki buat Hapus Terpilih & Import Digiflazz (lihat catatan limit body di server.js).
// Perbaikan di sini nutup kekurangan yang sama buat jalur IndoSMM, yang ternyata masih kelewat.
//
// specs: array of { serviceId, productName, category, price, indosmmRatePer1000, indosmmMin,
// indosmmMax, description, marginType, marginValue } -- "price" WAJIB SUDAH dihitung di
// pemanggil (routes/admin.js, lewat computeIndosmmSellPrice/computeSellPrice), fungsi ini murni
// urusan baca-ubah-tulis array produk di memori, sengaja gak nyampur logic hitung harga di sini.
export function bulkUpsertIndosmmProducts(specs) {
  const products = getAllProducts();
  let created = 0;
  let updated = 0;
  const errors = [];

  (specs || []).forEach(spec => {
    try {
      const serviceId = String(spec.serviceId || '').trim();
      const productName = String(spec.productName || '').trim();
      if (!serviceId || !productName) {
        throw new Error('Service ID dan nama produk wajib diisi');
      }
      const desc = String(spec.description || '').trim();
      const marginValue = spec.marginValue !== '' && spec.marginValue != null ? Number(spec.marginValue) : null;
      const idx = products.findIndex(p => p.provider === 'indosmm' && p.indosmmServiceId === serviceId);

      if (idx !== -1) {
        // Produk sudah pernah diimport -- update harga/rate/min-max aja. SENGAJA gak nyentuh
        // targetFields di sini (sama seperti updateProduct() dipanggil manual di form Edit
        // Produk) -- field "link" yang dikunci checkout produk IndoSMM jangan sampai lenyap.
        products[idx] = {
          ...products[idx],
          name: productName,
          price: Number(spec.price) || 0,
          indosmmRatePer1000: Number(spec.indosmmRatePer1000) || 0,
          indosmmMin: Number(spec.indosmmMin) || 1,
          indosmmMax: Number(spec.indosmmMax) || 1,
          ...(desc ? { description: desc } : {}),
          marginType: spec.marginType || '',
          marginValue
        };
        updated++;
      } else {
        // Produk baru -- targetFields WAJIB persis sama kayak jalur single-import
        // (importOrUpdateIndosmmProduct di routes/admin.js): gamePreset 'custom' + 1 field
        // "link" yang WAJIB diisi. Checkout produk IndoSMM hard-code baca targetData.link,
        // jadi kalau field ini kelewat, checkout produk hasil import batch ini bakal selalu
        // gagal "link belum diisi".
        products.push({
          id: genId('P'),
          name: productName,
          category: spec.category || 'Jasa Sosmed',
          description: desc,
          price: Number(spec.price) || 0,
          stockNote: '',
          thumbnail: '',
          stockItems: [],
          gamePreset: 'custom',
          targetFields: normalizeTargetFields('custom', [
            { key: 'link', label: 'Link Target (postingan/profil/video)', placeholder: 'https://...', required: true }
          ]),
          provider: 'indosmm',
          digiflazzSku: '',
          digiflazzCustomerNoTemplate: '',
          digiflazzBasePrice: 0,
          indosmmServiceId: serviceId,
          indosmmRatePer1000: Number(spec.indosmmRatePer1000) || 0,
          indosmmMin: Number(spec.indosmmMin) || 1,
          indosmmMax: Number(spec.indosmmMax) || 1,
          otpServiceCode: '', otpServiceName: '', otpCountryId: '', otpCountryName: '', otpBaseCostRub: 0,
          variantGroup: '', variantType: '',
          marginType: spec.marginType || '',
          marginValue,
          costPrice: 0,
          usageInstructions: '',
          status: 'active',
          createdAt: new Date().toISOString()
        });
        created++;
      }
    } catch (err) {
      errors.push(`${spec.serviceId || '?'}: ${err.message}`);
    }
  });

  writeDB('products', products);
  return { created, updated, errors };
}

// Upsert BANYAK produk OTP sekaligus dalam SATU baca+tulis file (dipakai "Import Bulk" di Kelola
// OTP -> POST /admin/otp/import-bulk, yang bikin produk buat SEMUA kombinasi service x negara
// yang dipilih admin). Pola PERSIS sama kayak bulkUpsertIndosmmProducts() di atas & 
// deleteProductsByIds() di bawah -- SATU kali getAllProducts(), diubah di MEMORI, SATU kali
// writeDB() di akhir.
//
// Sebelumnya loop service x negara di routes/admin.js manggil createProduct()/updateProduct()
// PER KOMBINASI -- masing-masing baca+tulis ULANG SELURUH file products.json. Kombinasi service x
// negara itu perkalian (mis. 20 service x 30 negara = 600 kombinasi), jadi ini growth-nya lebih
// cepat numpuk daripada import IndoSMM yang cuma linear per layanan -- makin gampang bikin request
// ini lambat/timeout kalau admin pilih "Semua" service & "Semua" negara sekaligus.
//
// specs: array of { serviceCode, otpServiceName, countryId, otpCountryName, productName,
// category, otpBaseCostRub, price, marginType, marginValue } -- "price" WAJIB SUDAH dihitung di
// pemanggil (routes/admin.js, lewat computeHerosmsSellPrice), fungsi ini murni urusan baca-ubah-
// tulis array produk di memori, sengaja gak nyampur logic hitung harga di sini. Kombinasi yang
// gak punya harga/stok 0 sengaja DIFILTER di pemanggil SEBELUM specs dibikin -- fungsi ini gak
// perlu tau soal itu.
export function bulkUpsertOtpProducts(specs) {
  const products = getAllProducts();
  let created = 0;
  let updated = 0;
  const errors = [];

  (specs || []).forEach(spec => {
    try {
      const serviceCode = String(spec.serviceCode || '').trim();
      const countryId = String(spec.countryId ?? '').trim();
      const productName = String(spec.productName || '').trim();
      if (!serviceCode || !countryId || !productName) {
        throw new Error('Service, negara, dan nama produk wajib diisi');
      }
      const marginType = spec.marginType === 'percent' || spec.marginType === 'fixed' ? spec.marginType : '';
      const marginValue = spec.marginValue !== undefined && spec.marginValue !== '' && spec.marginValue !== null ? Number(spec.marginValue) : null;
      const idx = products.findIndex(p => p.provider === 'otp' && p.otpServiceCode === serviceCode && p.otpCountryId === countryId);

      if (idx !== -1) {
        products[idx] = {
          ...products[idx],
          name: productName,
          price: Number(spec.price) || 0,
          otpBaseCostRub: Number(spec.otpBaseCostRub) || 0,
          marginType,
          marginValue
        };
        updated++;
      } else {
        products.push({
          id: genId('P'),
          name: productName,
          category: spec.category || 'OTP',
          description: '',
          price: Number(spec.price) || 0,
          stockNote: '',
          thumbnail: '',
          stockItems: [],
          gamePreset: 'none',
          targetFields: normalizeTargetFields('none', null),
          provider: 'otp',
          digiflazzSku: '', digiflazzCustomerNoTemplate: '', digiflazzBasePrice: 0,
          indosmmServiceId: '', indosmmRatePer1000: 0, indosmmMin: 0, indosmmMax: 0,
          otpServiceCode: serviceCode,
          otpServiceName: spec.otpServiceName || serviceCode,
          otpCountryId: countryId,
          otpCountryName: spec.otpCountryName || '',
          otpBaseCostRub: Number(spec.otpBaseCostRub) || 0,
          variantGroup: '', variantType: '',
          marginType,
          marginValue,
          costPrice: 0,
          usageInstructions: '',
          status: 'active',
          createdAt: new Date().toISOString()
        });
        created++;
      }
    } catch (err) {
      errors.push(`${spec.serviceCode || '?'}×${spec.countryId || '?'}: ${err.message}`);
    }
  });

  writeDB('products', products);
  return { created, updated, errors };
}

export function addProductStock(id, stockText) {
  const newItems = normalizeStockItems(stockText);
  if (newItems.length === 0) return findProductById(id);
  return updateProduct(id, { stockItems: newItems });
}

export function deleteProductStock(id, stockId) {
  const products = getAllProducts();
  const idx = products.findIndex(p => p.id === id);
  if (idx === -1) throw new Error('Produk tidak ditemukan');
  products[idx].stockItems = normalizeStockItems(products[idx].stockItems).filter(item => item.id !== stockId);
  writeDB('products', products);
  return products[idx];
}

export function takeProductStock(id, qty = 1) {
  const products = getAllProducts();
  const idx = products.findIndex(p => p.id === id);
  if (idx === -1) throw new Error('Produk tidak ditemukan');

  const amount = Math.max(1, Number(qty) || 1);
  const currentStock = normalizeStockItems(products[idx].stockItems);
  if (currentStock.length < amount) return null;

  const taken = currentStock.slice(0, amount);
  products[idx].stockItems = currentStock.slice(amount);
  writeDB('products', products);
  return taken;
}

export function deleteProduct(id) {
  const products = getAllProducts();
  const filtered = products.filter(p => p.id !== id);
  writeDB('products', filtered);
  return filtered;
}

// Hapus BEBERAPA produk sekaligus berdasarkan daftar ID (dipakai tombol "Hapus Terpilih" di
// Kelola Produk, biar admin gak perlu klik Hapus satu-satu). 1x baca+tulis file kayak
// deleteProductsByGroup. Return produk yang beneran kehapus (bukan cuma jumlahnya) supaya
// caller bisa bersihin referensi lain per produk (mis. item Flash Sale).
export function deleteProductsByIds(ids) {
  const idSet = new Set((Array.isArray(ids) ? ids : [ids]).filter(Boolean));
  if (idSet.size === 0) return [];
  const products = getAllProducts();
  const toDelete = products.filter(p => idSet.has(p.id));
  if (toDelete.length === 0) return [];
  writeDB('products', products.filter(p => !idSet.has(p.id)));
  return toDelete;
}

// Update field yang SAMA di BEBERAPA produk sekaligus berdasarkan daftar ID -- 1x baca+tulis
// file, SAMA POLA kayak deleteProductsByIds di atas. Dipakai buat operasi "lepas semua/terpilih
// dari Digiflazz/IndoSMM" (patch { provider: 'manual' }) & "masukkan produk grup ke tab tertentu"
// (patch { variantType }) di routes/admin.js.
//
// Sebelumnya tempat-tempat itu semua manggil `products.forEach(p => updateProduct(p.id, patch))`
// -- persis pola yang sama yang bikin import IndoSMM/OTP lambat (lihat bulkUpsertIndosmmProducts
// & bulkUpsertOtpProducts di atas): N produk = N baca + N tulis ULANG seluruh file. Sekarang
// habis fitur IMPORT-nya dibikin cepat/bisa banyak sekaligus, "lepas semua" yang jadi kebalikannya
// (undo import) masih pakai cara lama yang lambat -- jadi ditutup juga di sini biar konsisten.
export function updateProductsByIds(ids, patch) {
  const idSet = new Set((Array.isArray(ids) ? ids : [ids]).filter(Boolean));
  if (idSet.size === 0) return [];
  const products = getAllProducts();
  const updated = [];
  for (let i = 0; i < products.length; i++) {
    if (idSet.has(products[i].id)) {
      products[i] = { ...products[i], ...patch };
      updated.push(products[i]);
    }
  }
  if (updated.length === 0) return [];
  writeDB('products', products);
  return updated;
}

// Hapus SEMUA produk Stok Manual sekaligus (tombol "Hapus Semua" di Kelola Produk). Produk
// Digiflazz & IndoSMM SENGAJA gak ikut kehapus di sini -- keduanya dikelola & dihapus dari
// halamannya sendiri (/admin/digiflazz, /admin/indosmm) karena beda alur (auto top up, ada
// SKU/Service ID yang perlu dilepas-tautkan dulu), bukan stok manual biasa.
export function deleteAllManualProducts() {
  const products = getAllProducts();
  const toDelete = products.filter(p => p.provider !== 'digiflazz' && p.provider !== 'indosmm');
  if (toDelete.length === 0) return [];
  const idSet = new Set(toDelete.map(p => p.id));
  writeDB('products', products.filter(p => !idSet.has(p.id)));
  return toDelete;
}

// Hapus SEMUA produk dalam satu Grup Varian sekaligus (mis. semua nominal "Mobile Legends"),
// dipakai tombol "Hapus Grup" di halaman admin Digiflazz -- biar admin gak perlu hapus satu-satu
// manual buat grup yang isinya puluhan nominal. 1x baca+tulis file (bukan loop deleteProduct per
// produk) biar gak bolak-balik I/O. Return produk yang kehapus (bukan cuma jumlahnya) supaya
// caller bisa bersihin referensi lain per produk (mis. item Flash Sale) satu-satu.
export function deleteProductsByGroup(variantGroup, provider) {
  const name = String(variantGroup || '').trim();
  if (!name) throw new Error('Nama grup kosong');
  const products = getAllProducts();
  const matches = p => p.variantGroup === name && (!provider || p.provider === provider);
  const toDelete = products.filter(matches);
  if (toDelete.length === 0) throw new Error('Grup tidak ditemukan atau sudah kosong');
  writeDB('products', products.filter(p => !matches(p)));
  return toDelete;
}

// Ganti nama SATU Grup Varian sekaligus buat semua produk di dalamnya (mis. brand mentah dari
// Digiflazz "ML" -> nama tampilan custom "Mobile Legends: Bang Bang") -- dipakai tombol "Ganti
// Nama" di halaman admin Digiflazz. 1x baca+tulis file (bukan loop updateProduct per produk),
// sama pola efisiensinya kayak deleteProductsByGroup di atas. Return jumlah produk yang kena
// update, biar caller (route) bisa kasih pesan konfirmasi yang jelas.
export function renameProductGroup(oldName, newName, provider) {
  const from = String(oldName || '').trim();
  const to = String(newName || '').trim();
  if (!from) throw new Error('Nama grup lama kosong');
  if (!to) throw new Error('Nama grup baru gak boleh kosong');
  if (from === to) return 0; // gak ada yang perlu diubah, bukan error
  const products = getAllProducts();
  const matches = p => p.variantGroup === from && (!provider || p.provider === provider);
  const affected = products.filter(matches);
  if (affected.length === 0) throw new Error('Grup tidak ditemukan atau sudah kosong');
  // Nama baru gak boleh nabrak grup lain yang KEBETULAN udah ada & beda dari yang lagi di-rename
  // -- kalau dibiarkan, produk dari 2 grup asli bisa ketuker gabung tanpa admin sadar/maksud gitu.
  const clash = products.some(p => p.variantGroup === to && p.provider === (provider || p.provider) && !matches(p));
  if (clash) throw new Error(`Nama "${to}" sudah dipakai grup lain`);
  writeDB('products', products.map(p => matches(p) ? { ...p, variantGroup: to } : p));
  return affected.length;
}

// =====================================================================
// DAFTAR NAMA GRUP & TIPE NOMINAL (TERSIMPAN)
// Sebelumnya "Grup Varian"/"Tipe Nominal" cuma STRING BEBAS yang diketik ulang manual tiap kali
// (atau buat Grup, otomatis kepakai nama brand mentah dari Digiflazz) -- gampang ketik beda2
// dikit (mis. "Mobile Legends" vs "mobile legends ") jadi kesannya "pecah" jadi grup yang beda
// padahal maksudnya sama. Daftar di bawah ini adalah SUMBER PILIHAN (dropdown) yang independen
// dari produk yang ada sekarang -- admin bisa buat grup/tipe KOSONGAN dulu (belum ada produknya
// sama sekali), baru nambahin produk ke situ belakangan lewat halaman Admin > Produk Digiflazz.
// Disimpan terpisah di data/product-groups.json & data/product-types.json (bukan di dalam
// products.json), pola sama kayak lib/promocodes.js.
// =====================================================================

export function getAllGroupNames() {
  return readDB('product-groups', []);
}
function saveGroupNames(items) { writeDB('product-groups', items); }

export function createGroupName(name) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Nama grup tidak boleh kosong');
  const items = getAllGroupNames();
  if (items.some(g => g.name.toLowerCase() === clean.toLowerCase())) {
    throw new Error(`Grup "${clean}" sudah ada`);
  }
  const item = { id: genId('GRP'), name: clean, createdAt: new Date().toISOString() };
  items.push(item);
  saveGroupNames(items);
  return item;
}

// Rename entri grup TERSIMPAN + cascade ke semua produk yang lagi makai nama lamanya (kalau ada)
// -- reuse renameProductGroup, tapi gak dianggap error kalau grup ini emang belum ada produknya
// sama sekali (baru dibuat kosongan, belum "ditambahin produk" -- itu wajar, bukan bug).
export function renameGroupName(id, newName, provider) {
  const items = getAllGroupNames();
  const grp = items.find(g => g.id === id);
  if (!grp) throw new Error('Grup tidak ditemukan');
  const to = String(newName || '').trim();
  if (!to) throw new Error('Nama baru gak boleh kosong');
  if (grp.name === to) return { oldName: grp.name, newName: to, affectedCount: 0 };
  if (items.some(g => g.id !== id && g.name.toLowerCase() === to.toLowerCase())) {
    throw new Error(`Nama "${to}" sudah dipakai grup lain`);
  }
  let affectedCount = 0;
  try {
    affectedCount = renameProductGroup(grp.name, to, provider);
  } catch (e) {
    // "Grup tidak ditemukan atau sudah kosong" -- wajar buat grup yang belum ada produknya,
    // bukan kegagalan yang perlu digagalin juga proses rename entri tersimpannya.
  }
  saveGroupNames(items.map(g => (g.id === id ? { ...g, name: to } : g)));
  return { oldName: grp.name, newName: to, affectedCount };
}

// Hapus entri grup TERSIMPAN -- SEKALIAN hapus semua produk yang masih makai nama itu (konsisten
// sama tombol "Hapus Grup" yang udah ada di kartu folder /admin/digiflazz, BUKAN restriksi baru
// "grup harus kosong dulu" yang malah beda perilaku di 1 halaman yang sama).
export function deleteGroupName(id, provider) {
  const items = getAllGroupNames();
  const grp = items.find(g => g.id === id);
  if (!grp) throw new Error('Grup tidak ditemukan');
  let deletedProducts = [];
  try {
    deletedProducts = deleteProductsByGroup(grp.name, provider);
  } catch (e) {
    // "Grup tidak ditemukan atau sudah kosong" -- wajar buat grup kosongan, lanjut aja hapus entrinya.
  }
  saveGroupNames(items.filter(g => g.id !== id));
  return { group: grp, deletedProducts };
}

export function getAllTypeNames() {
  return readDB('product-types', []);
}
function saveTypeNames(items) { writeDB('product-types', items); }

export function createTypeName(name) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Nama tipe tidak boleh kosong');
  const items = getAllTypeNames();
  if (items.some(t => t.name.toLowerCase() === clean.toLowerCase())) {
    throw new Error(`Tipe "${clean}" sudah ada`);
  }
  const item = { id: genId('TYP'), name: clean, createdAt: new Date().toISOString() };
  items.push(item);
  saveTypeNames(items);
  return item;
}

// Beda sama Grup: rename tipe cascade update variantType semua produk terkait, TAPI hapus tipe
// TIDAK ikut hapus produk (lihat deleteTypeName) -- tipe cuma label pengelompokan tab, bukan
// wadah/folder produk kayak Grup.
export function renameTypeName(id, newName, provider) {
  const items = getAllTypeNames();
  const typ = items.find(t => t.id === id);
  if (!typ) throw new Error('Tipe tidak ditemukan');
  const to = String(newName || '').trim();
  if (!to) throw new Error('Nama baru gak boleh kosong');
  if (typ.name === to) return { oldName: typ.name, newName: to, affectedCount: 0 };
  if (items.some(t => t.id !== id && t.name.toLowerCase() === to.toLowerCase())) {
    throw new Error(`Nama "${to}" sudah dipakai tipe lain`);
  }
  const products = getAllProducts();
  const matches = p => p.variantType === typ.name && (!provider || p.provider === provider);
  const affected = products.filter(matches);
  if (affected.length > 0) {
    writeDB('products', products.map(p => (matches(p) ? { ...p, variantType: to } : p)));
  }
  saveTypeNames(items.map(t => (t.id === id ? { ...t, name: to } : t)));
  return { oldName: typ.name, newName: to, affectedCount: affected.length };
}

// Hapus entri tipe TERSIMPAN doang -- produk yang masih makai nama tipe ini TETAP ADA & tetap
// jalan seperti biasa (variantType-nya cuma jadi gak muncul lagi di dropdown pilihan buat produk
// BARU). Kalau mau bersihin/ganti tipe produk lama, edit produknya satu-satu atau pakai rename.
export function deleteTypeName(id) {
  const items = getAllTypeNames();
  const typ = items.find(t => t.id === id);
  if (!typ) throw new Error('Tipe tidak ditemukan');
  saveTypeNames(items.filter(t => t.id !== id));
  return typ;
}


