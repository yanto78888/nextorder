let pollTimer = null;
let countdownTimer = null;
let currentTrxid = null;

document.getElementById('btn-create').addEventListener('click', async () => {
  const amountInput = document.getElementById('amount');
  const errorBox = document.getElementById('form-error');
  const amount = parseInt(amountInput.value);
  errorBox.style.display = 'none';

  if (!amount || amount <= 0) {
    errorBox.textContent = 'Masukkan nominal yang valid';
    errorBox.style.display = 'block';
    return;
  }

  const btn = document.getElementById('btn-create');
  btn.disabled = true;
  btn.textContent = 'Membuat QR...';

  try {
    const res = await fetch('/api/topup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount })
    });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Gagal membuat transaksi');

    showQr(data.deposit);
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate QRIS';
  }
});

function showQr(deposit) {
  currentTrxid = deposit.trxid;
  document.getElementById('form-card').style.display = 'none';
  document.getElementById('qr-card').style.display = 'block';
  document.getElementById('qr-image').src = deposit.imageBase64;
  document.getElementById('d-amount').textContent = 'Rp ' + Number(deposit.amount).toLocaleString('id-ID');
  document.getElementById('d-total').textContent = 'Rp ' + Number(deposit.total).toLocaleString('id-ID');
  document.getElementById('d-trxid').textContent = deposit.trxid;
  document.getElementById('qr-status').textContent = 'Menunggu pembayaran...';

  const cancelBtn = document.getElementById('btn-cancel');
  cancelBtn.style.display = 'inline-flex';
  cancelBtn.disabled = false;
  cancelBtn.textContent = 'Batal Transaksi';

  startCountdown(new Date(deposit.expiredAt).getTime());
  startPolling(deposit.trxid);
}

document.getElementById('btn-cancel').addEventListener('click', async () => {
  if (!currentTrxid) return;
  if (!confirm('Batalkan transaksi top up ini?')) return;

  const btn = document.getElementById('btn-cancel');
  btn.disabled = true;
  btn.textContent = 'Membatalkan...';

  try {
    const res = await fetch(`/api/topup/cancel/${currentTrxid}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal membatalkan transaksi');

    clearInterval(pollTimer);
    clearInterval(countdownTimer);
    document.getElementById('qr-status').textContent = '🚫 Transaksi dibatalkan.';
    btn.style.display = 'none';
    setTimeout(() => window.location.reload(), 1200);
  } catch (err) {
    alert(err.message);
    btn.disabled = false;
    btn.textContent = 'Batal Transaksi';
  }
});

function startCountdown(expiredAtMs) {
  clearInterval(countdownTimer);
  const timerEl = document.getElementById('qr-timer');

  countdownTimer = setInterval(() => {
    const diff = expiredAtMs - Date.now();
    if (diff <= 0) {
      timerEl.textContent = '00:00';
      clearInterval(countdownTimer);
      clearInterval(pollTimer);
      document.getElementById('qr-status').textContent = 'QR kadaluarsa. Silakan buat transaksi baru.';
      return;
    }
    const m = Math.floor(diff / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    timerEl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }, 1000);
}

function startPolling(trxid) {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`/api/topup/status/${trxid}`);
      const data = await res.json();
      if (!res.ok) return;

      if (data.status === 'paid') {
        clearInterval(pollTimer);
        clearInterval(countdownTimer);
        document.getElementById('qr-status').textContent = '✅ Pembayaran berhasil! Saldo telah ditambahkan.';
        document.getElementById('btn-cancel').style.display = 'none';
        setTimeout(() => window.location.reload(), 2000);
      } else if (data.status === 'expired') {
        clearInterval(pollTimer);
        clearInterval(countdownTimer);
        document.getElementById('qr-status').textContent = '❌ Transaksi kadaluarsa.';
        document.getElementById('btn-cancel').style.display = 'none';
      } else if (data.status === 'cancelled') {
        clearInterval(pollTimer);
        clearInterval(countdownTimer);
        document.getElementById('qr-status').textContent = '🚫 Transaksi dibatalkan.';
        document.getElementById('btn-cancel').style.display = 'none';
      }
    } catch (err) {
      // silent retry
    }
  }, 4000);
}
