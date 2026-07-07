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
    status: 'pending', // pending | paid | expired
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

function getProcessedMutations() {
  return new Set(readDB('processedMutations', []));
}

function saveProcessedMutations(set) {
  return writeDB('processedMutations', [...set]);
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

      const current = getDeposits();
      current[dep.trxid].status = 'paid';
      current[dep.trxid].paidAt = new Date().toISOString();
      await saveDeposits(current);

      addSaldo(dep.userId, dep.amount);

      await notifyDeposit({
        username: dep.username,
        amount: dep.amount,
        total: dep.total,
        trxid: dep.trxid
      });
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
