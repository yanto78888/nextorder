// =====================================================================
// ORDER ENGINE -- logic inti pemrosesan order (validasi qty/target, hitung
// total, kirim produk lewat Digiflazz/IndoSMM/stok manual, catat order +
// refund kalau gagal). Awalnya semua ini nempel di routes/user.js (cuma
// dipakai checkout via web), sekarang dipisah ke sini supaya bisa dipakai
// ULANG oleh routes/api.js (API reseller) tanpa duplikat logic -- checkout
// via saldo, via QRIS, dan via API semuanya lewat fungsi yang SAMA di sini,
// cuma beda "pintu masuk" & cara hitung harganya.
// =====================================================================
import { addSaldo } from './users.js';
import { takeProductStock, countStock, getProductCostPrice } from './products.js';
import { createOrder } from './orders.js';
import { notifyOrder } from './telegram.js';
import { genId } from './db.js';
import { applyMemberDiscount } from './membership.js';
import {
  getEffectivePrice, getActiveFlashPriceForProduct, recordFlashSaleSale
} from './flashsale.js';
import { isDigiflazzEnabled, buildCustomerNo, createTransaction } from './digiflazz.js';
import {
  isIndosmmEnabled, placeOrder as placeIndosmmOrder, computeTotalForQty as computeIndosmmTotal
} from './indosmm.js';

// Digiflazz gak punya konsep "quantity" per transaksi -- tiap unit butuh 1 panggilan
// createTransaction() SENDIRI ke Digiflazz secara berurutan (lihat fulfillAndRecordOrders di
// bawah). Kalau qty dibiarkan sampai puluhan, 1 request checkout bisa jadi puluhan panggilan API
// berurutan yang lama & rawan timeout. Makanya dibatasi wajar di sini -- dicek di SEMUA pintu
// masuk order (checkout saldo, checkout QRIS, DAN API reseller), bukan cuma salah satu.
export const MAX_DIGIFLAZZ_QTY_PER_ORDER = 10;

export function validateQty(product, qty) {
  if (product.provider === 'digiflazz' && qty > MAX_DIGIFLAZZ_QTY_PER_ORDER) {
    return `Maksimal ${MAX_DIGIFLAZZ_QTY_PER_ORDER}x per transaksi untuk produk auto top up ini. Silakan checkout terpisah untuk jumlah lebih banyak.`;
  }
  if (product.provider === 'indosmm') {
    const min = Number(product.indosmmMin) || 1;
    const max = Number(product.indosmmMax) || min;
    if (qty < min || qty > max) {
      return `Jumlah harus antara ${min.toLocaleString('id-ID')} - ${max.toLocaleString('id-ID')} untuk layanan ini.`;
    }
  }
  return null;
}

// Total harga buat qty tertentu, provider-aware: IndoSMM dihitung dari RATE PER 1000 (qty = jumlah
// asli, mis. 500 follower -- BUKAN "berapa kali beli"), provider lain tetap unitPrice * qty biasa.
export function computeOrderTotal(product, unitPrice, qty) {
  if (product.provider === 'indosmm') return computeIndosmmTotal(unitPrice, qty);
  return unitPrice * qty;
}

// Format isian target (ID Game/Zone ID/UID/link, dst) jadi teks rapi buat disimpan di order &
// dikirim ke laporan Telegram. `data` = objek polos { fieldKey: value }.
export function formatTargetText(product, data) {
  const fields = product.targetFields || [];
  return fields
    .filter(f => data[f.key])
    .map(f => {
      let val = data[f.key];
      if (f.type === 'select' && Array.isArray(f.options)) {
        const opt = f.options.find(o => o.value === val);
        if (opt) val = opt.label;
      }
      return `${f.label}: ${val}`;
    })
    .join(' | ');
}

// Cek field target yang WAJIB (required) tapi belum keisi di `data` (objek polos, BUKAN
// req.body dengan prefix "target_" -- itu urusan extractTargetData di routes/user.js buat form
// web). Dipakai routes/api.js buat validasi payload JSON dari reseller.
export function getMissingTargetFields(product, data) {
  const fields = product.targetFields || [];
  return fields
    .filter(f => f.required && !String((data && data[f.key]) || '').trim())
    .map(f => f.label);
}

// Harga "role Platinum" buat produk tertentu, TERLEPAS dari membership asli user yang order --
// dipakai routes/api.js supaya SEMUA transaksi lewat API reseller otomatis kepakai harga
// Platinum (diskon 2%, lihat lib/membership.js), gak perlu user beneran upgrade membership dulu.
// Flash sale TETAP menang di atas harga Platinum kalau sedang aktif -- sama kayak aturan
// getEffectivePrice() buat checkout web biasa (lihat lib/flashsale.js), supaya harga API gak
// pernah lebih mahal dari harga yang lagi tampil di web buat produk yang sama.
export function getPlatinumPrice(product) {
  const flashPrice = getActiveFlashPriceForProduct(product.id);
  if (flashPrice != null) return flashPrice;
  return applyMemberDiscount(product.price, 'platinum');
}

// Kirim produk ke user: stok manual dari sistem, atau auto top up game/SMM lewat Digiflazz/IndoSMM.
// Dipanggil setelah saldo user dipotong, jadi kalau provider gagal, saldo yang sudah dipotong
// di-refund oleh fulfillAndRecordOrders() di bawah (bukan di sini).
export async function fulfillOrder(product, qty, targetData, targetText) {
  if (product.provider === 'digiflazz' && isDigiflazzEnabled()) {
    // Kalau admin belum isi SKU Digiflazz produk ini (kosong), request ke Digiflazz pasti ditolak
    // (buyer_sku_code kosong -> RC 40 "Invalid Payload", HTTP 400) -- dicek di sini dulu biar
    // customer dapat pesan yang jelas & admin ketauan produk mana yang belum di-setting, bukan
    // nembak API dulu terus baru dapat error samar dari Digiflazz.
    if (!product.digiflazzSku) {
      return {
        status: 'cancelled', deliveryMode: 'auto', manualRequired: false,
        detail: '', note: 'Gagal top up: SKU produk belum diatur, hubungi admin',
        provider: 'digiflazz', providerRefId: '', providerCustomerNo: '', refund: true
      };
    }
    const customerNo = buildCustomerNo(product, targetData);
    if (!customerNo) {
      return {
        status: 'cancelled', deliveryMode: 'auto', manualRequired: false,
        detail: '', note: 'Gagal top up: ID tujuan tidak lengkap',
        provider: 'digiflazz', providerRefId: '', providerCustomerNo: '', refund: true
      };
    }

    const refId = genId('DGFLZ');
    try {
      const result = await createTransaction({
        buyerSkuCode: product.digiflazzSku,
        customerNo,
        refId
      });
      const status = String(result.status || '').toLowerCase();

      if (status === 'sukses') {
        return {
          status: 'completed', deliveryMode: 'auto', manualRequired: false,
          detail: result.sn || result.message || 'Top up berhasil',
          note: 'Top up otomatis berhasil',
          provider: 'digiflazz', providerRefId: refId, providerCustomerNo: customerNo, refund: false
        };
      }
      if (status === 'gagal') {
        return {
          status: 'cancelled', deliveryMode: 'auto', manualRequired: false,
          detail: '', note: 'Top up gagal: ' + (result.message || 'ditolak sistem'),
          provider: 'digiflazz', providerRefId: refId, providerCustomerNo: customerNo, refund: true
        };
      }
      // Pending: masih diproses Digiflazz di baliknya, dicek ulang otomatis oleh background job
      // (catatan sengaja gak nyebut nama provider ke customer, lihat validateQty & invoice.ejs juga)
      return {
        status: 'processing', deliveryMode: 'auto', manualRequired: false,
        detail: '', note: 'Sedang diproses sistem, tunggu beberapa saat',
        provider: 'digiflazz', providerRefId: refId, providerCustomerNo: customerNo, refund: false
      };
    } catch (err) {
      return {
        status: 'cancelled', deliveryMode: 'auto', manualRequired: false,
        detail: '', note: 'Gagal menghubungi sistem top up: ' + err.message,
        provider: 'digiflazz', providerRefId: refId, providerCustomerNo: customerNo, refund: true
      };
    }
  }

  if (product.provider === 'indosmm' && isIndosmmEnabled()) {
    const link = (targetData.link || '').trim();
    if (!link) {
      return {
        status: 'cancelled', deliveryMode: 'auto', manualRequired: false,
        detail: '', note: 'Gagal memproses: link tujuan tidak diisi',
        provider: 'indosmm', providerRefId: '', providerCustomerNo: '', refund: true
      };
    }
    try {
      // qty di sini = jumlah asli (mis. 500 followers) -- BEDA dari Digiflazz, IndoSMM emang
      // native dukung "quantity" per 1 kali panggilan API, jadi TIDAK di-loop/split per unit
      // (lihat perUnit di fulfillAndRecordOrders, cuma true buat provider 'digiflazz').
      const result = await placeIndosmmOrder({ serviceId: product.indosmmServiceId, link, quantity: qty });
      // Order SMM SELALU mulai dari "diproses" (gak ada status sukses/gagal instan kayak
      // Digiflazz) -- baru dituntasin belakangan oleh job checkPendingIndosmmOrders().
      return {
        status: 'processing', deliveryMode: 'auto', manualRequired: false,
        detail: '', note: 'Sedang diproses sistem, tunggu beberapa saat',
        provider: 'indosmm', providerRefId: result.orderId, providerCustomerNo: link, refund: false
      };
    } catch (err) {
      return {
        status: 'cancelled', deliveryMode: 'auto', manualRequired: false,
        detail: '', note: 'Gagal menghubungi sistem: ' + err.message,
        provider: 'indosmm', providerRefId: '', providerCustomerNo: link, refund: true
      };
    }
  }

  // Fallback: stok manual dari sistem (perilaku lama)
  const stockAvailable = countStock(product);
  const takenStock = stockAvailable >= qty ? takeProductStock(product.id, qty) : null;
  const isAutoDelivered = Array.isArray(takenStock) && takenStock.length === qty;
  return {
    status: isAutoDelivered ? 'completed' : 'processing',
    deliveryMode: isAutoDelivered ? 'auto' : 'manual',
    manualRequired: !isAutoDelivered,
    detail: isAutoDelivered ? takenStock.map((item, i) => qty > 1 ? `${i + 1}. ${item.value}` : item.value).join('\n') : '',
    note: isAutoDelivered ? 'Dikirim otomatis dari stok sistem' : 'Stok otomatis habis, menunggu admin kirim manual',
    provider: 'manual', providerRefId: '', providerCustomerNo: '', refund: false
  };
}

// Proses 1 aksi checkout (saldo, QRIS, ATAU API reseller) jadi 1 ATAU LEBIH order record + kirim
// produknya.
//
// KENAPA BISA LEBIH DARI 1 ORDER: Digiflazz gak punya konsep "quantity" per transaksi -- 1
// panggilan createTransaction() = 1 unit dikirim ke 1 customer_no. Dulu qty diabaikan sama
// sekali buat produk Digiflazz (cuma manggil createTransaction() 1x walau qty=3 misalnya),
// akibatnya customer BAYAR 3x lipat harga tapi Digiflazz cuma memproses ("ke-hit") 1x. Sekarang,
// khusus produk Digiflazz, benar-benar di-loop sebanyak qty (masing-masing createTransaction()
// dengan ref_id BEDA -- Digiflazz menganggap ref_id yang SAMA sebagai retry transaksi yang sama,
// BUKAN transaksi baru), dan masing-masing unit dicatat sebagai order TERPISAH (qty:1). Dengan
// gitu status/refund/reconcile per unit otomatis akurat lewat logic single-unit yang sudah ada
// (gak perlu bikin konsep "refund sebagian" yang baru). Produk provider manual/stok TETAP 1
// order (qty:N) kayak sebelumnya -- itu memang sudah benar (lihat takeProductStock yang emang
// ngambil N item stok sekaligus).
//
// unitPriceOverride (opsional): kalau diisi, dipakai LANGSUNG sebagai harga per unit, TIDAK
// dihitung ulang dari getEffectivePrice(product, user) -- dipakai routes/api.js buat maksa
// harga Platinum (lihat getPlatinumPrice di atas) terlepas dari membership asli user.
// sourceOverride (opsional): nilai order.source, default 'user' (checkout web) kalau kosong --
// routes/api.js ngirim 'api' di sini biar order tercatat asalnya dari API reseller.
export async function fulfillAndRecordOrders({
  user, product, qty, targetData, targetText, notifySource, paidNote, unitPriceOverride, sourceOverride, apiRefId,
  paymentMethod = ''
}) {
  const unitPrice = unitPriceOverride != null ? unitPriceOverride : getEffectivePrice(product, user);
  const usedFlashPrice = getActiveFlashPriceForProduct(product.id) != null;
  const perUnit = product.provider === 'digiflazz' && isDigiflazzEnabled();
  const iterations = perUnit ? qty : 1;
  const orderQty = perUnit ? 1 : qty;
  const orderTotal = computeOrderTotal(product, unitPrice, orderQty);

  const orders = [];
  for (let i = 0; i < iterations; i++) {
    const delivery = await fulfillOrder(product, orderQty, targetData, targetText);

    const order = createOrder({
      userId: user.id,
      username: user.username,
      productId: product.id,
      productName: product.name,
      price: unitPrice,
      qty: orderQty,
      total: orderTotal,
      source: sourceOverride || 'user',
      status: delivery.status,
      deliveryMode: delivery.deliveryMode,
      manualRequired: delivery.manualRequired,
      targetText,
      detail: delivery.detail,
      note: delivery.refund ? delivery.note : (paidNote || delivery.note),
      provider: delivery.provider,
      providerRefId: delivery.providerRefId,
      providerCustomerNo: delivery.providerCustomerNo,
      indosmmServiceId: product.indosmmServiceId || '',
      costPrice: getProductCostPrice(product),
      usedFlashPrice,
      apiRefId
    });
    orders.push(order);

    // Refund per-unit kalau gagal -- dipanggil SETELAH createOrder (bukan sebelum) supaya
    // order.id sudah ada dan bisa dilampirkan ke catatan ledger-nya, biar dari halaman Riwayat
    // Saldo jelas refund ini berasal dari order yang mana.
    if (delivery.refund) {
      addSaldo(user.id, orderTotal, {
        reason: `Refund pesanan gagal: ${product.name}`,
        refType: 'order',
        refId: order.id
      });
    }

    // Catatan: total terjual TIDAK di-increment manual di sini -- dihitung live dari order (lihat
    // getTotalSoldMap di lib/orders.js), jadi otomatis akurat termasuk kalau order Digiflazz yang
    // sempat "Pending" ini belakangan ternyata gagal (lihat checkPendingDigiflazzOrders).
    if (!delivery.refund && usedFlashPrice) recordFlashSaleSale(product.id, orderQty);

    notifyOrder({
      username: user.username,
      productName: product.name,
      total: order.total,
      orderId: order.id,
      source: notifySource || (delivery.status === 'completed' ? 'auto' : 'user'),
      needsManual: delivery.manualRequired,
      targetText,
      qty: orderQty,
      unitPrice,
      apiRefId,
      paymentMethod,
      orderStatus: delivery.status
    }).catch(() => {});
  }
  return orders;
}

// Ringkas hasil banyak order (qty>1 produk Digiflazz) jadi 1 pesan. Return null kalau cuma 1
// order -- biar caller pakai pesan single-order yang lebih spesifik.
export function summarizeOrders(orders) {
  if (orders.length <= 1) return null;
  const completed = orders.filter(o => o.status === 'completed').length;
  const processing = orders.filter(o => o.status === 'processing').length;
  const cancelled = orders.filter(o => o.status === 'cancelled').length;
  const parts = [];
  if (completed) parts.push(`${completed} berhasil dikirim`);
  if (processing) parts.push(`${processing} masih diproses otomatis`);
  if (cancelled) parts.push(`${cancelled} gagal & saldo bagian itu sudah dikembalikan`);
  return `${orders.length} order diproses: ${parts.join(', ')}.`;
}
