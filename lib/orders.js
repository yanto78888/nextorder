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
  total: totalOverride = null, // opsional -- kalau diisi dipakai LANGSUNG, gak dihitung ulang price*qty.
                                // Dibutuhin produk yang price-nya BUKAN "harga per 1 qty" murni, mis.
                                // IndoSMM: price = rate per 1000 sedangkan qty = jumlah asli (mis. 500
                                // follower) -- total yang benar itu (rate/1000)*qty (dibulatkan), bukan
                                // rate*qty kalau dihitung naive price*qty di bawah.
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
  costPrice = 0, // harga modal per unit SAAT order dibuat (snapshot) -- dipakai hitung Pendapatan Bersih,
                // disimpan di order (bukan diambil ulang dari produk) supaya laporan bulan lalu gak ikut
                // berubah kalau modal/margin produknya diubah admin belakangan.
  usedFlashPrice = false // true kalau order ini kepakai harga Flash Sale -- disimpan di order (bukan cuma
                         // variabel lokal saat checkout) supaya job reconcile Digiflazz yang belakangan
                         // nemuin order ini ternyata GAGAL tahu juga harus balikin soldCount Flash Sale-nya
                         // (lihat checkPendingDigiflazzOrders di lib/digiflazz.js).
}) {
  const orders = getAllOrders();
  const unitCost = Math.max(0, Number(costPrice) || 0);
  const total = totalOverride !== null ? Number(totalOverride) || 0 : Number(price) * qty;
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
    usedFlashPrice: !!usedFlashPrice,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  orders.push(order);
  writeDB('orders', orders);
  return order;
}

export function updateOrderStatus(id, status, text = undefined) {
  const orders = getAllOrders();
  const idx = orders.findIndex(o => o.id === id);
  if (idx === -1) throw new Error('Order tidak ditemukan');
  orders[idx].status = status;
  // "text" ditaruh di field yang BENERAN ditampilin ke customer di invoice buat status ini --
  // invoice.ejs cuma nampilin order.detail pas status 'completed' (kotak "Detail Produk/Kode"),
  // dan order.note pas status 'cancelled' (baris alasan pembatalan). Diputuskan di sini (bukan
  // tanggung jawab tiap pemanggil) supaya gak ada lagi kasus alasan gagal/refund ke-simpen di
  // field yang gak pernah kebaca invoice.ejs -- customer cuma lihat pesan default yang basi.
  if (text !== undefined) {
    if (status === 'cancelled') orders[idx].note = text;
    else orders[idx].detail = text;
  }
  if (status === 'completed') {
    orders[idx].manualRequired = false;
    orders[idx].deliveryMode = orders[idx].deliveryMode || 'manual';
  }
  orders[idx].updatedAt = new Date().toISOString();
  writeDB('orders', orders);
  return orders[idx];
}

// Patch bebas field apa aja di 1 order (dipakai buat nyimpen status refill IndoSMM: refillId,
// refillStatus, refillRequestedAt -- daripada nambah fungsi update khusus tiap butuh field baru).
export function patchOrder(id, patch) {
  const orders = getAllOrders();
  const idx = orders.findIndex(o => o.id === id);
  if (idx === -1) throw new Error('Order tidak ditemukan');
  orders[idx] = { ...orders[idx], ...patch, updatedAt: new Date().toISOString() };
  writeDB('orders', orders);
  return orders[idx];
}

// Peta { productId: total qty terjual } buat nampilin "X Terjual" di katalog & halaman detail
// produk. SENGAJA dihitung langsung dari data order asli tiap dipanggil (bukan counter yang
// di-increment manual kayak dulu di product.totalSold) -- order berstatus 'cancelled' TIDAK
// dihitung, sama persis kayak pola getStats()/getMonthlyRevenueStats() di atas.
//
// Ini juga sekalian benerin bug lama: order Digiflazz yang tadinya "Pending" (langsung
// dihitung terjual saat itu juga karena belum ketahuan gagal/sukses) tapi BELAKANGAN ternyata
// "Gagal" lewat job checkPendingDigiflazzOrders() -- order itu di-update jadi status
// 'cancelled' & saldo di-refund, tapi counter lama gak pernah ikut dikurangi lagi sehingga
// angka "Terjual" numpuk padahal transaksinya gagal. Dengan dihitung ulang dari order tiap
// kali (bukan disimpan terpisah), begitu status order jadi 'cancelled' angkanya otomatis benar
// lagi di request berikutnya, gak perlu ada patch increment/decrement di banyak tempat.
export function getTotalSoldMap() {
  const orders = getAllOrders();
  const map = {};
  orders.forEach(o => {
    if (o.status === 'cancelled') return;
    if (!o.productId) return;
    map[o.productId] = (map[o.productId] || 0) + (Number(o.qty) || 0);
  });
  return map;
}

// Convenience buat 1 produk aja (mis. halaman detail produk) -- kalau butuh banyak produk
// sekaligus (mis. daftar katalog), pakai getTotalSoldMap() sekali lalu lookup per id, jangan
// panggil ini di dalam loop (masing-masing panggilan scan ulang seluruh order dari awal).
export function getTotalSoldForProduct(productId) {
  if (!productId) return 0;
  return getTotalSoldMap()[productId] || 0;
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
