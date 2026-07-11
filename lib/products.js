import { readDB, writeDB, genId } from './db.js';
import { getGamePreset } from './gamePresets.js';

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
    // Satu kali submit/add stock = 1 item stok, walau isinya banyak baris (mis. data akun lengkap)
    const value = stockItems.trim();
    if (!value) return [];
    return [{ id: genId('STK'), value, createdAt: new Date().toISOString() }];
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
    provider: p.provider || 'manual', // manual (stok sistem) | digiflazz (auto topup game)
    digiflazzSku: p.digiflazzSku || '',
    digiflazzCustomerNoTemplate: p.digiflazzCustomerNoTemplate || ''
  }));
}

export function getActiveProducts() {
  return getAllProducts().filter(p => p.status === 'active');
}

export function findProductById(id) {
  return getAllProducts().find(p => p.id === id) || null;
}

export function countStock(product) {
  return normalizeStockItems(product?.stockItems).length;
}

export function createProduct({ name, category, description, price, stockNote, thumbnail, stockItems, gamePreset, customTargetFields, provider, digiflazzSku, digiflazzCustomerNoTemplate }) {
  const products = getAllProducts();
  const preset = gamePreset || 'none';
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
    provider: provider === 'digiflazz' ? 'digiflazz' : 'manual',
    digiflazzSku: provider === 'digiflazz' ? String(digiflazzSku || '').trim() : '',
    digiflazzCustomerNoTemplate: provider === 'digiflazz' ? String(digiflazzCustomerNoTemplate || '').trim() : '',
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
    next.provider = partial.provider === 'digiflazz' ? 'digiflazz' : 'manual';
    if (next.provider !== 'digiflazz') {
      next.digiflazzSku = '';
      next.digiflazzCustomerNoTemplate = '';
    } else {
      next.digiflazzSku = String(partial.digiflazzSku !== undefined ? partial.digiflazzSku : products[idx].digiflazzSku || '').trim();
      next.digiflazzCustomerNoTemplate = String(partial.digiflazzCustomerNoTemplate !== undefined ? partial.digiflazzCustomerNoTemplate : products[idx].digiflazzCustomerNoTemplate || '').trim();
    }
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
