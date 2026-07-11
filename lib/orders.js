import { readDB, writeDB, genId } from './db.js';

export function getAllOrders() {
  return readDB('orders', []);
}

export function getOrdersByUser(userId) {
  return getAllOrders()
    .filter(o => o.userId === userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export function findOrderById(id) {
  return getAllOrders().find(o => o.id === id) || null;
}

export function createOrder({
  userId,
  username,
  productId,
  productName,
  price,
  qty = 1,
  note = '',
  source = 'user', // 'user' auto order via saldo | 'admin' manual order
  status = 'processing',
  detail = '',
  targetText = '', // isian ID Game/Zone ID/UID dll yang diisi user saat checkout (ML, FF, Genshin, dst)
  deliveryMode = 'manual', // auto | manual
  manualRequired = false
}) {
  const orders = getAllOrders();
  const order = {
    id: genId('ORD'),
    userId,
    username,
    productId: productId || null,
    productName,
    price: Number(price) || 0,
    qty,
    total: Number(price) * qty,
    note,
    source,
    status, // processing | completed | cancelled
    deliveryMode,
    manualRequired, // true jika stok otomatis habis dan admin perlu kirim manual
    detail, // isi akun / hasil produk dikirim admin atau stok otomatis
    targetText,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  orders.push(order);
  writeDB('orders', orders);
  return order;
}

export function updateOrderStatus(id, status, detail = undefined) {
  const orders = getAllOrders();
  const idx = orders.findIndex(o => o.id === id);
  if (idx === -1) throw new Error('Order tidak ditemukan');
  orders[idx].status = status;
  if (detail !== undefined) orders[idx].detail = detail;
  if (status === 'completed') {
    orders[idx].manualRequired = false;
    orders[idx].deliveryMode = orders[idx].deliveryMode || 'manual';
  }
  orders[idx].updatedAt = new Date().toISOString();
  writeDB('orders', orders);
  return orders[idx];
}

export function getStats() {
  const orders = getAllOrders();
  const totalOrders = orders.length;
  const totalRevenue = orders
    .filter(o => o.status !== 'cancelled')
    .reduce((sum, o) => sum + o.total, 0);
  const processing = orders.filter(o => o.status === 'processing').length;
  const completed = orders.filter(o => o.status === 'completed').length;
  const manualRequired = orders.filter(o => o.manualRequired && o.status === 'processing').length;
  return { totalOrders, totalRevenue, processing, completed, manualRequired };
}
