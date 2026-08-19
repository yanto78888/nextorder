import QRCode from 'qrcode';

export function qrisCRC16(str) {
  let crc = 0xFFFF;
  for (let c = 0; c < str.length; c++) {
    crc ^= str.charCodeAt(c) << 8;
    for (let i = 0; i < 8; i++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
      } else {
        crc = (crc << 1) & 0xFFFF;
      }
    }
  }
  return (crc & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
}

export function generateDynamicQR(baseQR, amount) {
  const base = baseQR.substring(0, baseQR.length - 8); // hapus tag 6304xxxx (CRC lama)
  const amtStr = String(amount);
  const lenStr = amtStr.length.toString().padStart(2, '0');
  const amountField = `54${lenStr}${amtStr}`;

  const payloadForCrc = base + amountField + '6304';
  const crc = qrisCRC16(payloadForCrc);

  return base + amountField + '6304' + crc;
}

export function formatRupiah(n) {
  return Number(n || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

export function hitungFee(amount, feePercent = 0.7) {
  return Math.ceil(amount * (feePercent / 100));
}

// PENTING: kodeUnik nentuin NOMINAL AKHIR (base + fee + kodeUnik) yang dipakai buat COCOKKIN
// pembayaran QRIS yang masuk ke SALAH SATU pending record -- deposit (lib/deposit.js) ATAU
// beli-produk-QRIS (lib/orderQris.js), dua-duanya cocokkin pembayaran PERSIS by nominal akhir ini
// (lihat processQiospayCallback & processQiospayCallbackForOrder). Kalau 2 pending record --
// gak peduli sama-sama deposit, sama-sama order, ATAU CAMPURAN keduanya -- kebetulan dapet total
// akhir yang SAMA PERSIS, pembayaran yang beneran masuk bakal ke-match ke SALAH SATU doang
// (deposit dicek LEBIH DULUAN di webhook, lihat routes/webhook.js): niatnya bayar produk malah
// ke-kredit jadi saldo, order-nya nyangkut 'pending' SELAMANYA, dan komisi referral gak pernah
// kepicu (root cause laporan "komisi kadang gak masuk" -- bukan di logic komisinya sendiri).
// Makanya baseTotal+excludeTotals WAJIB diisi (lihat createDeposit & createOrderQrisPayment) --
// excludeTotals harus gabungan total SEMUA pending record yang lagi aktif (deposit + order) biar
// kodeUnik yang dihasilkan DIJAMIN gak bikin nominal akhir bentrok sama yang lain.
export function getKodeUnik(baseTotal = 0, excludeTotals = new Set()) {
  for (let i = 0; i < 60; i++) {
    const candidate = Math.floor(Math.random() * 50) + 1;
    if (!excludeTotals.has(baseTotal + candidate)) return candidate;
  }
  // Fallback super-jarang kepakai (butuh puluhan pending amount yang PERSIS bentrok bareng di
  // range 1-50) -- perluas range dikit daripada infinite loop / gagal generate QR sama sekali.
  for (let i = 0; i < 200; i++) {
    const candidate = Math.floor(Math.random() * 500) + 1;
    if (!excludeTotals.has(baseTotal + candidate)) return candidate;
  }
  return Math.floor(Math.random() * 500) + 1;
}

export async function generateQRImageBuffer(dynamicQR) {
  // Vercel-friendly: no native canvas dependency.
  return QRCode.toBuffer(dynamicQR, {
    type: 'png',
    errorCorrectionLevel: 'H',
    margin: 2,
    width: 420,
    color: {
      dark: '#000000',
      light: '#FFFFFF'
    }
  });
}
