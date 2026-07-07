import { readDB, writeDB, genId } from './db.js';

function normalizeStockItems(stockItems = []) {
  if (typeof stockItems === 'string') {
    return stockItems
      .split(/\r?\n/)
      .map(s => s.trim())
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
  return readDB('products', []).map(p => ({ ...p, stockItems: normalizeStockItems(p.stockItems) }));
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

export function createProduct({ name, category, description, price, stockNote, thumbnail, stockItems }) {
  const products = getAllProducts();
  const product = {
    id: genId('P'),
    name,
    category: category || 'Umum',
    description: description || '',
    price: Number(price) || 0,
    stockNote: stockNote || '',
    thumbnail: thumbnail || '',
    stockItems: normalizeStockItems(stockItems),
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
