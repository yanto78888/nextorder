import axios from 'axios';
import { readDB, writeDB, genId } from './db.js';
import { getConfig } from './config.js';
import { addSaldo } from './users.js';
import { notifyDeposit } from './telegram.js';
import {
  generateDynamicQR,
  generateQRImageBuffer,
  hitungFee,
  getKodeUnik
} from './qris.js';

const MAX_TRIES = 40; // ~ tries * pollInterval detik sebelum expired dianggap gagal

export function getDeposits() {
  return readDB('deposits', {});
}

function saveDeposits(data) {
  return writeDB('deposits', data);
}

export function getDeposit(trxid) {
  const all = getDeposits();
  return all[trxid] || null;
}

export function getDepositsByUser(userId) {
  const all = getDeposits();
  return Object.values(all)
    .filter(d => d.userId === userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export async function cancelDeposit(trxid, userId) {
  const all = getDeposits();
  const dep = all[trxid];
  if (!dep) throw new Error('Transaksi tidak ditemukan');
  if (dep.userId !== userId) throw new Error('Akses ditolak');
  if (dep.status !== 'pending') {
    throw new Error('Transaksi tidak bisa dibatalkan (status saat ini: ' + dep.status + ')');
  }
  dep.status = 'cancelled';
  dep.cancelledAt = new Date().toISOString();
  all[trxid] = dep;
  await saveDeposits(all);
  return dep;
}

export async function createDeposit(user, amount) {
  const cfg = getConfig();
  const qCfg = cfg.qris || {};
  if (!qCfg.qrString) throw new Error('QR String belum diatur di admin dashboard');
  if (amount < (qCfg.depositMin || 1000)) {
    throw new Error(`Minimal deposit Rp ${qCfg.depositMin || 1000}`);
  }

  const fee = hitungFee(amount, qCfg.feePercent ?? 0.7);
  const kodeUnik = getKodeUnik();
  const total = amount + fee + kodeUnik;
  const trxid = genId('DEP-');

  const dynamicQR = generateDynamicQR(qCfg.qrString, total);
  const imageBuffer = await generateQRImageBuffer(dynamicQR);

  const expiredMinutes = qCfg.expiredMinutes || 10;
  const now = Date.now();

  const record = {
    trxid,
    userId: user.id,
    username: user.username,
    amount,
    fee,
    kodeUnik,
    total,
    status: 'pending', // pending | paid | expired | cancelled
    tries: 0,
    createdAt: new Date(now).toISOString(),
    expiredAt: new Date(now + expiredMinutes * 60 * 1000).toISOString()
  };

  const all = getDeposits();
  all[trxid] = record;
  await saveDeposits(all);

  return {
    ...record,
    imageBase64: `data:image/png;base64,${imageBuffer.toString('base64')}`
  };
}

// Dipanggil dari 2 jalur: (1) checkPendingDeposits() polling berkala, dan (2) webhook callback
// QIOSPAY real-time (routes/webhook.js). Disatukan di sini biar 2 jalur itu PERSIS sama
// perilakunya (tandain paid, tambah saldo, notif Telegram) -- gak ada peluang salah satu jalur
// beda logic/kelupaan salah satu langkah. Return null (bukan throw) kalau deposit-nya udah gak
// 'pending' lagi (race: keburu diproses jalur lain / expired / dibatalkan user) -- caller cukup
// anggap "gak ada yang perlu dilakukan", bukan error.
async function markDepositPaid(trxid) {
  const current = getDeposits();
  const dep = current[trxid];
  if (!dep || dep.status !== 'pending') return null;

  current[trxid].status = 'paid';
  current[trxid].paidAt = new Date().toISOString();
  await saveDeposits(current);

  addSaldo(dep.userId, dep.amount, {
    reason: 'Top up saldo via QRIS',
    refType: 'deposit',
    refId: dep.trxid
  });

  await notifyDeposit({
    username: dep.username,
    amount: dep.amount,
    total: dep.total,
    trxid: dep.trxid
  });

  return current[trxid];
}

export function getProcessedMutations() {
  return new Set(readDB('processedMutations', []));
}

export function saveProcessedMutations(set) {
  return writeDB('processedMutations', [...set]);
}

// Dipakai route webhook QIOSPAY: POST /api/callback/accept/:secretKey (lihat routes/webhook.js).
// BEDA dari checkPendingDeposits (yang NEBAK lewat polling tiap interval), di sini QIOSPAY yang
// kasih tau LANGSUNG begitu ada pembayaran masuk -- saldo bisa update saat itu juga, gak perlu
// nunggu siklus polling berikutnya. Tetap dicocokkan by NOMINAL PERSIS (termasuk kode unik),
// persis kayak jalur polling, dan refid QIOSPAY dicatat di processedMutations yang SAMA dipakai
// jalur polling -- biar gak ada transaksi yang kebetulan ke-tangkep 2 jalur sekaligus (polling
// DAN webhook) jadi diproses dobel (saldo nambah 2x buat 1x pembayaran).
export async function processQiospayCallback(payload) {
  const data = payload && payload.data;
  if (!data || typeof data !== 'object') {
    return { matched: false, reason: 'Payload tidak lengkap/tidak dikenali' };
  }
  if (payload.status !== 'success' || data.type !== 'CR') {
    // "CR" = uang MASUK (credit). Selain itu (mis. "DB"/debit, atau status bukan "success")
    // bukan pembayaran top up yang perlu diproses di sini -- bukan error, cuma dilewati.
    return { matched: false, reason: 'Bukan notifikasi transaksi masuk yang sukses (type=CR)' };
  }

  const nominal = parseInt(data.amount, 10);
  if (!nominal || nominal <= 0) {
    return { matched: false, reason: 'Nominal amount tidak valid' };
  }

  const ref = String(data.refid || `${data.time || ''}-${nominal}`);
  const processed = getProcessedMutations();
  if (processed.has(ref)) {
    // Bukan error -- QIOSPAY (atau webhook pada umumnya) lazim ngirim ulang callback yang sama
    // kalau gak dapat respons 200 tepat waktu. refid yang sama = transaksi yang sama, harus
    // idempotent (jangan nambah saldo lagi).
    return { matched: false, reason: 'refid sudah pernah diproses sebelumnya (duplikat callback)' };
  }

  const all = getDeposits();
  const dep = Object.values(all).find(d => d.status === 'pending' && d.total === nominal);
  if (!dep) {
    return { matched: false, reason: `Tidak ada deposit pending dengan nominal Rp ${nominal}` };
  }

  processed.add(ref);
  await saveProcessedMutations(processed);

  const updated = await markDepositPaid(dep.trxid);
  if (!updated) {
    return { matched: false, reason: 'Deposit keburu diproses jalur lain (polling) barengan' };
  }
  return { matched: true, trxid: dep.trxid };
}

// Dipanggil berkala oleh interval global di server.js
export async function checkPendingDeposits() {
  const cfg = getConfig();
  const qCfg = cfg.qris || {};
  if (!qCfg.merchantCode || !qCfg.apiKey) return; // belum diatur admin

  const all = getDeposits();
  const pendingList = Object.values(all).filter(d => d.status === 'pending');
  if (pendingList.length === 0) return;

  // expire yang sudah lewat waktu
  let changed = false;
  for (const dep of pendingList) {
    if (new Date(dep.expiredAt).getTime() < Date.now()) {
      all[dep.trxid].status = 'expired';
      changed = true;
    }
  }
  if (changed) await saveDeposits(all);

  const stillPending = Object.values(all).filter(d => d.status === 'pending');
  if (stillPending.length === 0) return;

  const url = `https://qiospay.id/api/mutasi/qris/${qCfg.merchantCode}/${qCfg.apiKey}`;

  let list;
  try {
    const res = await axios.get(url, { timeout: 15000 });
    list = res.data?.data;
    if (!Array.isArray(list)) return;
  } catch (err) {
    console.error('[deposit] Gagal cek mutasi:', err.message);
    return;
  }

  const processed = getProcessedMutations();
  const MAX_DELAY = 10 * 60 * 1000;
  const latestCredits = list.filter(tx => tx.type === 'CR').slice(0, 20);

  for (const dep of stillPending) {
    const match = latestCredits.find(tx => {
      const nominal = parseInt(tx.amount || 0);
      const ref = tx.reference_id || tx.id || `${tx.date}-${nominal}`;
      const txTime = new Date(tx.date).getTime();
      if (Date.now() - txTime > MAX_DELAY) return false;
      if (processed.has(ref)) return false;
      return nominal === dep.total;
    });

    if (match) {
      const ref = match.reference_id || match.id || `${match.date}-${dep.total}`;
      processed.add(ref);
      await markDepositPaid(dep.trxid);
    } else {
      const current = getDeposits();
      current[dep.trxid].tries = (current[dep.trxid].tries || 0) + 1;
      if (current[dep.trxid].tries >= MAX_TRIES) {
        current[dep.trxid].status = 'expired';
      }
      await saveDeposits(current);
    }
  }

  await saveProcessedMutations(processed);
}
