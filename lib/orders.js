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
  manualRequired = false,
  provider = 'manual', // manual | digiflazz
  providerRefId = '', // ref_id transaksi di Digiflazz, dipakai buat cek status ulang
  providerCustomerNo = '',
  costPrice = 0 // harga modal per unit SAAT order dibuat (snapshot) -- dipakai hitung Pendapatan Bersih,
                // disimpan di order (bukan diambil ulang dari produk) supaya laporan bulan lalu gak ikut
                // berubah kalau modal/margin produknya diubah admin belakangan.
}) {
  const orders = getAllOrders();
  const unitCost = Math.max(0, Number(costPrice) || 0);
  const total = Number(price) * qty;
  const costTotal = unitCost * qty;
  const order = {
    id: genId('ORD'),
    userId,
    username,
    productId: productId || null,
    productName,
    price: Number(price) || 0,
    qty,
    total,
    costPrice: unitCost,
    costTotal,
    profit: total - costTotal,
    note,
    source,
    status, // processing | completed | cancelled
    deliveryMode,
    manualRequired, // true jika stok otomatis habis dan admin perlu kirim manual
    detail, // isi akun / hasil produk dikirim admin atau stok otomatis
    targetText,
    provider,
    providerRefId,
    providerCustomerNo,
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

// Ambil harga modal 1 order buat rekap Pendapatan Bersih. Order baru selalu sudah punya
// costTotal (lihat createOrder), tapi order LAMA yang sudah kepakai sebelum fitur ini ada
// belum punya field itu -- fallback ke 0 (dianggap belum ada data modal, bukan dianggap rugi),
// biar getMonthlyRevenueStats tetap aman dipanggil ke order-order lama tanpa NaN/error.
function resolveOrderCost(o) {
  if (o.costTotal != null) return Number(o.costTotal) || 0;
  if (o.costPrice != null) return (Number(o.costPrice) || 0) * (Number(o.qty) || 1);
  return 0;
}

// Rekap Pendapatan Kotor (omzet, sebelum dikurangi modal) vs Pendapatan Bersih (omzet - modal)
// per bulan, buat grafik "Penjualan Bulanan" di Dashboard Admin. monthsCount = berapa bulan ke
// belakang dari bulan berjalan (termasuk bulan ini), diurutkan lama -> baru biar pas buat sumbu X grafik.
export function getMonthlyRevenueStats(monthsCount = 12) {
  const orders = getAllOrders().filter(o => o.status !== 'cancelled');
  const now = new Date();
  const buckets = [];
  for (let i = monthsCount - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    buckets.push({
      year: d.getFullYear(),
      month: d.getMonth(),
      label: d.toLocaleDateString('id-ID', { month: 'short', year: '2-digit' }),
      gross: 0,
      net: 0
    });
  }

  orders.forEach(o => {
    const d = new Date(o.createdAt);
    if (isNaN(d.getTime())) return;
    const bucket = buckets.find(b => b.year === d.getFullYear() && b.month === d.getMonth());
    if (!bucket) return; // di luar jendela monthsCount, dilewati
    const gross = Number(o.total) || 0;
    const cost = resolveOrderCost(o);
    bucket.gross += gross;
    bucket.net += (gross - cost);
  });

  return buckets.map(b => ({ label: b.label, gross: Math.round(b.gross), net: Math.round(b.net) }));
}
