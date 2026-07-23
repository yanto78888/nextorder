import { readDB, writeDB, genId } from './db.js';
import { getGamePreset } from './gamePresets.js';

// provider produk: 'manual' (stok sistem) | 'digiflazz' (auto topup game) | 'indosmm' (jasa sosmed)
function normalizeProvider(provider) {
  if (provider === 'digiflazz') return 'digiflazz';
  if (provider === 'indosmm') return 'indosmm';
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

export function createProduct({ name, category, description, price, stockNote, thumbnail, stockItems, gamePreset, customTargetFields, provider, digiflazzSku, digiflazzCustomerNoTemplate, variantGroup, digiflazzBasePrice, indosmmServiceId, indosmmRatePer1000, indosmmMin, indosmmMax, marginType, marginValue, costPrice, usageInstructions }) {
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
    variantGroup: String(variantGroup || '').trim(),
    marginType: (prov === 'digiflazz' || prov === 'indosmm') && (marginType === 'percent' || marginType === 'fixed') ? marginType : '',
    // PENTING: harus cek "!== null" juga, bukan cuma "!== undefined" & "!== ''". Tanpa ini,
    // marginValue: null (yang berarti "gak ada override, pakai margin default") kelolos ke
    // Number(null) yang hasilnya 0 -- lalu 0 itu KESIMPEN sebagai override asli produk ini,
    // bukan "kosong". Efeknya: computeSellPrice mikir produk ini punya override 0%/Rp0 permanen,
    // jadi margin default barapa pun diubah gak akan pernah kepakai buat produk ini.
    marginValue: (prov === 'digiflazz' || prov === 'indosmm') && marginValue !== undefined && marginValue !== '' && marginValue !== null ? Number(marginValue) : null,
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
