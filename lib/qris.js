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

export function getKodeUnik() {
  return Math.floor(Math.random() * 50) + 1;
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
