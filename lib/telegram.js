import axios from 'axios';
import { getConfig } from './config.js';

export async function sendTelegramMessage(text) {
  const cfg = getConfig();
  const { botToken, chatId } = cfg.telegram || {};

  if (!botToken || !chatId) {
    console.log('[telegram] Token/ChatId belum diset di admin dashboard, skip notif.');
    return { skipped: true };
  }

  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const res = await axios.post(url, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML'
    });
    return res.data;
  } catch (err) {
    console.error('[telegram] Gagal kirim notifikasi:', err.response?.data || err.message);
    return { error: true };
  }
}

export async function notifyDeposit({ username, amount, total, trxid }) {
  const cfg = getConfig();
  if (!cfg.telegram?.notifyOnDeposit) return;
  await sendTelegramMessage(
    `💰 <b>DEPOSIT BERHASIL</b>\n\n` +
    `User: <b>${escapeHtml(username)}</b>\n` +
    `Topup: Rp ${formatRupiah(amount)}\n` +
    `Total Bayar: Rp ${formatRupiah(total)}\n` +
    `ID: ${trxid}`
  );
}

export async function notifyOrder({
  username, productName, total, orderId, source, needsManual = false, targetText = '',
  qty = 1, unitPrice = null, apiRefId = ''
}) {
  const cfg = getConfig();
  if (!cfg.telegram?.notifyOnOrder) return;
  const tag = source === 'admin'
    ? '🛠 ORDER MANUAL (ADMIN)'
    : source === 'auto'
      ? '⚡ ORDER AUTO TERKIRIM'
      : source === 'api'
        ? '📡 ORDER VIA API RESELLER'
        : '🛒 ORDER BARU';
  await sendTelegramMessage(
    `${tag}\n\n` +
    `User: <b>${escapeHtml(username)}</b>\n` +
    `Produk: ${escapeHtml(productName)}\n` +
    (qty > 1 ? `Qty: ${qty}${unitPrice != null ? ` x Rp ${formatRupiah(unitPrice)}` : ''}\n` : '') +
    (targetText ? `Tujuan: <b>${escapeHtml(targetText)}</b>\n` : '') +
    `Total: Rp ${formatRupiah(total)}\n` +
    `ID: ${orderId}` +
    (apiRefId ? `\nRef ID Reseller: <code>${escapeHtml(apiRefId)}</code>` : '') +
    (needsManual ? `\n\n⚠️ Stok otomatis habis. Admin harus kirim manual dari halaman order.` : '')
  );
}

export async function notifyWithdrawal({ username, amount, method, targetNumber, targetName = '', withdrawalId }) {
  const cfg = getConfig();
  if (!cfg.telegram?.notifyOnWithdrawal) return;
  const methodLabel = method === 'gopay' ? 'GoPay' : method === 'shopeepay' ? 'ShopeePay' : method;
  await sendTelegramMessage(
    `💸 <b>PENGAJUAN TARIK SALDO BARU</b>\n\n` +
    `User: <b>${escapeHtml(username)}</b>\n` +
    `Nominal: Rp ${formatRupiah(amount)}\n` +
    `Metode: <b>${escapeHtml(methodLabel)}</b>\n` +
    `Nomor Tujuan: <code>${escapeHtml(targetNumber)}</code>\n` +
    (targetName ? `Nama Pemilik: ${escapeHtml(targetName)}\n` : '') +
    `ID Pengajuan: ${withdrawalId}\n\n` +
    `Segera proses lewat halaman Admin &gt; Penarikan Saldo.`
  );
}

export async function notifyRegister({ username }) {
  const cfg = getConfig();
  if (!cfg.telegram?.notifyOnRegister) return;
  await sendTelegramMessage(`🆕 <b>USER BARU DAFTAR</b>\n\nUsername: ${escapeHtml(username)}`);
}

function formatRupiah(n) {
  return Number(n || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
