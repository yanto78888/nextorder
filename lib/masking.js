// =====================================================================
// MASKING -- sensor username & data tujuan buat ditampilkan ke PUBLIK (siapa aja, gak perlu
// login) di dashboard Live Transaksi. BEDA dari dashboard admin (routes/admin.js
// getLiveApiTransactions) yang nampilin data APA ADANYA buat admin -- versi publik ini sengaja
// disensor supaya gak bocorin identitas/data pribadi pembeli ke pengunjung lain.
// =====================================================================

// "budi_reseller" -> "bu***ler" ; nama pendek (<=4 huruf) -> "b***"
export function maskUsername(username) {
  const s = String(username || '');
  if (s.length <= 4) return s.charAt(0) + '***';
  return s.slice(0, 2) + '***' + s.slice(-2);
}

// Sensor teks tujuan (User ID/Zone ID/link/dll) per KATA, biar formatnya ("User ID: 12345 | Zone
// ID: 6789") tetap kebaca strukturnya tapi angka/datanya disamarkan -- bukan cuma "***" polos.
export function maskTarget(targetText) {
  const s = String(targetText || '');
  if (!s) return '';
  return s.replace(/[A-Za-z0-9._-]{3,}/g, (word) => {
    if (word.length <= 4) return word.charAt(0) + '***';
    return word.slice(0, 2) + '***' + word.slice(-2);
  });
}
