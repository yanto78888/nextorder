// =====================================================================
// PEMBAYARAN QRIS LANGSUNG UNTUK ORDER (bukan top up saldo)
// -----------------------------------------------------------------------
// Sebelumnya, "bayar produk pakai QRIS" numpang lewat sistem deposit saldo:
// createDeposit() nambah saldo dulu, baru /order/qris-confirm motong saldo
// lagi buat bikin order-nya. Ini rawan nyangkut (kalau tab ditutup pas
// transisi, saldo ke-nambah tapi order gak pernah kebuat) dan bikin
// Riwayat Deposit penuh transaksi yang sebetulnya bukan top up saldo.
//
// Modul ini bikin alur SENDIRI, gak numpang ke deposits.json / saldo user
// sama sekali di jalur sukses: begitu QRIS-nya kebayar, order langsung
// dibuat & diproses (fulfillAndRecordOrders) SERVER-SIDE lewat job
// checkPendingOrderQrisPayments() di bawah -- gak tergantung tab browser
// masih terbuka atau nggak. Saldo cuma ikut disentuh kalau ADA refund
// (pengiriman gagal), itu pun lewat mekanisme refund yang sudah ada di
// fulfillAndRecordOrders (konsisten sama checkout saldo biasa).
// =====================================================================
import axios from 'axios';
import { readDB, writeDB, genId } from './db.js';
import { getConfig } from './config.js';
import { getProcessedMutations, saveProcessedMutations } from './deposit.js';
import { findUserById } from './users.js';
import { findProductById } from './products.js';
import { fulfillAndRecordOrders } from './orderEngine.js';
import { redeemPromoCode } from './promocodes.js';
import {
  generateDynamicQR,
  generateQRImageBuffer,
  hitungFee,
  getKodeUnik
} from './qris.js';

const MAX_TRIES = 80; // ~ tries * pollInterval detik sebelum expired dianggap gagal

export function getOrderQrisPayments() {
  return readDB('orderQrisPayments', {});
}

function saveOrderQrisPayments(data) {
  return writeDB('orderQrisPayments', data);
}

export function getOrderQrisPayment(trxid) {
  const all = getOrderQrisPayments();
  return all[trxid] || null;
}

export function getOrderQrisPaymentsByUser(userId) {
  const all = getOrderQrisPayments();
  return Object.values(all)
    .filter(p => p.userId === userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export async function cancelOrderQrisPayment(trxid, userId) {
  const all = getOrderQrisPayments();
  const p = all[trxid];
  if (!p) throw new Error('Transaksi tidak ditemukan');
  if (p.userId !== userId) throw new Error('Akses ditolak');
  if (p.status !== 'pending') {
    throw new Error('Transaksi tidak bisa dibatalkan (status saat ini: ' + p.status + ')');
  }
  p.status = 'cancelled';
  p.cancelledAt = new Date().toISOString();
  all[trxid] = p;
  await saveOrderQrisPayments(all);
  return p;
}

// unitPrice & orderTotal DIHITUNG DI ROUTE (pakai getEffectivePrice/computeOrderTotal yang
// sudah ada) dan dikirim ke sini APA ADANYA -- modul ini cuma tanggung jawab bikin QR + nyimpen
// record + (nanti) motong ke order asli, BUKAN nge-hitung harga dari nol. Konsisten sama pola
// createDeposit(user, amount) yang juga cuma nerima angka jadi, gak nge-hitung sendiri.
export async function createOrderQrisPayment({ user, product, qty, targetData, targetText, unitPrice, orderTotal, promoCode = '' }) {
  const cfg = getConfig();
  const qCfg = cfg.qris || {};
  if (!qCfg.qrString) throw new Error('QR String belum diatur di admin dashboard');

  const fee = hitungFee(orderTotal, qCfg.feePercent ?? 0.7);
  const kodeUnik = getKodeUnik();
  const total = orderTotal + fee + kodeUnik;
  const trxid = genId('OQ-');

  const dynamicQR = generateDynamicQR(qCfg.qrString, total);
  const imageBuffer = await generateQRImageBuffer(dynamicQR);

  const expiredMinutes = qCfg.expiredMinutes || 10;
  const now = Date.now();

  const record = {
    trxid,
    userId: user.id,
    username: user.username,
    productId: product.id,
    productName: product.name,
    qty,
    targetData: targetData || {},
    targetText: targetText || '',
    unitPrice,
    orderTotal,
    fee,
    kodeUnik,
    total,
    // Cuma "dititipkan" di sini -- BELUM dianggap terpakai (usedCount promo belum naik) sampai
    // markOrderQrisPaid() di bawah beneran motong statusnya jadi 'paid'. Kalau QRIS ini keburu
    // expired/dibatalkan sebelum dibayar, kode promonya otomatis gak pernah ke-redeem sama sekali.
    promoCode: promoCode || '',
    status: 'pending', // pending | paid | expired | cancelled
    tries: 0,
    orderIds: [],
    createdAt: new Date(now).toISOString(),
    expiredAt: new Date(now + expiredMinutes * 60 * 1000).toISOString()
  };

  const all = getOrderQrisPayments();
  all[trxid] = record;
  await saveOrderQrisPayments(all);

  return {
    ...record,
    imageBase64: `data:image/png;base64,${imageBuffer.toString('base64')}`
  };
}

// Dipanggil dari 2 jalur: (1) checkPendingOrderQrisPayments() polling di bawah, dan (2) webhook
// callback QIOSPAY real-time (routes/webhook.js). Disatukan di sini SAMA ALASANNYA kayak
// markDepositPaid di lib/deposit.js -- biar jalur polling & webhook PERSIS sama perilakunya
// (tandain paid, buat+proses order), gak ada peluang salah satu jalur beda logic. Return null
// (bukan throw) kalau record-nya udah gak 'pending' lagi (race: keburu diproses jalur lain).
async function markOrderQrisPaid(trxid) {
  const current = getOrderQrisPayments();
  const p = current[trxid];
  if (!p || p.status !== 'pending') return null;

  current[trxid].status = 'paid';
  current[trxid].paidAt = new Date().toISOString();
  await saveOrderQrisPayments(current);

  // Langsung bikin & proses order-nya DI SINI (server-side, gak butuh browser terbuka) -- ini
  // inti bedanya dari alur lama. Kalau gagal, catat errornya tapi status QRIS TETAP "paid"
  // (uangnya sudah masuk) -- admin bisa lihat & follow up manual lewat orderIds yang kosong
  // sebagai sinyal "sudah bayar tapi order belum kebuat".
  try {
    const user = findUserById(p.userId);
    const product = findProductById(p.productId);
    if (user && product) {
      const orders = await fulfillAndRecordOrders({
        user,
        product,
        qty: p.qty,
        targetData: p.targetData || {},
        targetText: p.targetText || '',
        notifySource: 'qris',
        paidNote: 'Dibayar via QRIS',
        unitPriceOverride: p.unitPrice
      });
      const afterFulfill = getOrderQrisPayments();
      afterFulfill[trxid].orderIds = orders.map(o => o.id);
      await saveOrderQrisPayments(afterFulfill);

      // Redeem kode promo DI SINI (bukan pas /order/qris-init tadi) -- QRIS-nya baru beneran
      // lunas & order baru beneran jadi di titik ini. Sama seperti checkout saldo, kalau SEMUA
      // order hasil pembayaran ini malah cancelled/refund total, kode promo gak ikut "terbakar".
      if (p.promoCode && orders.some(o => o.status !== 'cancelled')) {
        redeemPromoCode(p.promoCode, user.id, user.username);
      }

      return afterFulfill[trxid];
    }
    console.error(`[orderQris] User/produk tidak ditemukan buat trxid ${trxid} setelah bayar -- perlu ditindak manual.`);
  } catch (fulfillErr) {
    console.error(`[orderQris] Gagal proses order setelah bayar (trxid ${trxid}):`, fulfillErr.message);
  }
  return getOrderQrisPayments()[trxid];
}

// Dipakai route webhook QIOSPAY (routes/webhook.js), DICOBA SETELAH processQiospayCallback
// (lib/deposit.js) gak nemu match -- 1 callback QIOSPAY cuma buat SATU transaksi, yang bisa aja
// itu buat top up saldo ATAU buat bayar produk langsung, makanya dicoba 2-2nya tapi gantian
// (bukan bareng), gak pernah dobel diproses karena keduanya cek & tulis ke processedMutations
// yang SAMA (lihat getProcessedMutations di lib/deposit.js) -- refid yang sama gak akan pernah
// lolos dicek dua kali walau lewat 2 fungsi yang beda.
export async function processQiospayCallbackForOrder(payload) {
  const data = payload && payload.data;
  if (!data || typeof data !== 'object') {
    return { matched: false, reason: 'Payload tidak lengkap/tidak dikenali' };
  }
  if (payload.status !== 'success' || data.type !== 'CR') {
    return { matched: false, reason: 'Bukan notifikasi transaksi masuk yang sukses (type=CR)' };
  }

  const nominal = parseInt(data.amount, 10);
  if (!nominal || nominal <= 0) {
    return { matched: false, reason: 'Nominal amount tidak valid' };
  }

  const ref = String(data.refid || `${data.time || ''}-${nominal}`);
  const processed = getProcessedMutations();
  if (processed.has(ref)) {
    return { matched: false, reason: 'refid sudah pernah diproses sebelumnya (duplikat callback)' };
  }

  const all = getOrderQrisPayments();
  const p = Object.values(all).find(x => x.status === 'pending' && x.total === nominal);
  if (!p) {
    return { matched: false, reason: `Tidak ada order-QRIS pending dengan nominal Rp ${nominal}` };
  }

  processed.add(ref);
  await saveProcessedMutations(processed);

  const updated = await markOrderQrisPaid(p.trxid);
  if (!updated) {
    return { matched: false, reason: 'Transaksi keburu diproses jalur lain (polling) barengan' };
  }
  return { matched: true, trxid: p.trxid };
}

// Dipanggil berkala oleh interval global di server.js -- SAMA PERSIS caranya kayak
// checkPendingDeposits (poll mutasi QRIS ke provider), bedanya kalau ketemu match di sini
// LANGSUNG bikin+proses order-nya (fulfillAndRecordOrders), gak nyentuh saldo user sama sekali.
export async function checkPendingOrderQrisPayments() {
  const cfg = getConfig();
  const qCfg = cfg.qris || {};
  if (!qCfg.merchantCode || !qCfg.apiKey) return; // belum diatur admin

  const all = getOrderQrisPayments();
  const pendingList = Object.values(all).filter(p => p.status === 'pending');
  if (pendingList.length === 0) return;

  // expire yang sudah lewat waktu
  let changed = false;
  for (const p of pendingList) {
    if (new Date(p.expiredAt).getTime() < Date.now()) {
      all[p.trxid].status = 'expired';
      changed = true;
    }
  }
  if (changed) await saveOrderQrisPayments(all);

  const stillPending = Object.values(all).filter(p => p.status === 'pending');
  if (stillPending.length === 0) return;

  const url = `https://qiospay.id/api/mutasi/qris/${qCfg.merchantCode}/${qCfg.apiKey}`;

  let list;
  try {
    const res = await axios.get(url, { timeout: 15000 });
    list = res.data?.data;
    if (!Array.isArray(list)) return;
  } catch (err) {
    console.error('[orderQris] Gagal cek mutasi:', err.message);
    return;
  }

  // Pakai SET YANG SAMA dengan checkPendingDeposits (lib/deposit.js) -- 1 mutasi bank/e-wallet
  // yang sama gak boleh dianggap "bayar" 2 kali cuma karena kebetulan ada deposit DAN order-qris
  // yang nominal totalnya sama persis.
  const processed = getProcessedMutations();
  const MAX_DELAY = 10 * 60 * 1000;
  const latestCredits = list.filter(tx => tx.type === 'CR').slice(0, 20);

  for (const p of stillPending) {
    const match = latestCredits.find(tx => {
      const nominal = parseInt(tx.amount || 0);
      const ref = tx.reference_id || tx.id || `${tx.date}-${nominal}`;
      const txTime = new Date(tx.date).getTime();
      if (Date.now() - txTime > MAX_DELAY) return false;
      if (processed.has(ref)) return false;
      return nominal === p.total;
    });

    if (!match) {
      const current = getOrderQrisPayments();
      current[p.trxid].tries = (current[p.trxid].tries || 0) + 1;
      if (current[p.trxid].tries >= MAX_TRIES) {
        current[p.trxid].status = 'expired';
      }
      await saveOrderQrisPayments(current);
      continue;
    }

    const ref = match.reference_id || match.id || `${match.date}-${p.total}`;
    processed.add(ref);
    await markOrderQrisPaid(p.trxid);
  }

  await saveProcessedMutations(processed);
}
