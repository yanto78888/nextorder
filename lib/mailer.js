import nodemailer from 'nodemailer';
import { getConfig } from './config.js';

// ---------- SMTP (akun email pribadi admin, mis. Gmail/Outlook/Zoho) ----------
// Dipakai buat 1 keperluan: kirim kode OTP "Lupa Password". Konfigurasi diisi admin di
// Admin > Pengaturan > "Email / SMTP" (host, port, secure, user, app-password, from name/email),
// disimpan di config.json kayak integrasi lain (Digiflazz/IndoSMM/Telegram) -- bukan .env.
//
// CATATAN buat admin: kalau SMTP-nya Gmail, WAJIB pakai "App Password" (16 karakter dari
// myaccount.google.com/apppasswords), BUKAN password akun Gmail biasa -- Gmail nolak login SMTP
// pakai password biasa demi keamanan (apalagi kalau 2FA aktif, malah wajib App Password).
function getSmtpConfig() {
  const cfg = getConfig();
  return cfg.smtp || {};
}

export function isSmtpConfigured() {
  const s = getSmtpConfig();
  return !!(s.host && s.port && s.user && s.pass);
}

// Transporter dibikin BARU tiap kali kirim (bukan disimpan/di-cache sekali di top-level module) --
// sengaja begitu supaya kalau admin ganti kredensial SMTP di tengah jalan (tanpa restart server),
// pengiriman berikutnya otomatis pakai kredensial yang baru, bukan yang lama ke-cache di memori.
function createTransporter() {
  const s = getSmtpConfig();
  if (!isSmtpConfigured()) {
    throw new Error('SMTP belum dikonfigurasi. Isi dulu di Admin > Pengaturan > Email/SMTP.');
  }
  return nodemailer.createTransport({
    host: s.host,
    port: Number(s.port) || 587,
    secure: !!s.secure, // true = SSL implisit (biasanya port 465), false = STARTTLS (biasanya port 587)
    auth: { user: s.user, pass: s.pass },
    connectionTimeout: 15000
  });
}

function fromHeader() {
  const s = getSmtpConfig();
  const name = s.fromName || 'NEXORDER';
  const email = s.fromEmail || s.user;
  return `"${name}" <${email}>`;
}

// Dipanggil dari route "Kirim Email Percobaan" di halaman Pengaturan admin -- buat mastiin
// kredensial SMTP-nya beneran valid SEBELUM dipakai beneran di alur Lupa Password (biar gak
// ketauan salah kredensial pas user beneran lagi butuh reset password).
export async function sendTestEmail(toEmail) {
  const transporter = createTransporter();
  await transporter.sendMail({
    from: fromHeader(),
    to: toEmail,
    subject: 'Email Percobaan SMTP',
    text: 'Kalau kamu menerima email ini, pengaturan SMTP di Admin > Pengaturan sudah benar dan siap dipakai buat fitur Lupa Password.',
    html: `<p>Kalau kamu menerima email ini, pengaturan SMTP di <b>Admin &gt; Pengaturan</b> sudah benar dan siap dipakai buat fitur <b>Lupa Password</b>.</p>`
  });
}

// Kode OTP (6 digit) dikirim polos di body email -- yang disimpan di data user cuma HASH-nya
// (lihat lib/users.js generateResetOtp), jadi ini satu-satunya tempat kode aslinya "lewat".
// cfg (object config lengkap) dikirimkan opsional -- dipakai buat ngambil URL logo (seo.ogImage
// + seo.siteUrl) supaya foto logo muncul di email, sama kayak di OG preview situs.
export async function sendResetOtpEmail(toEmail, otpCode, siteName, cfg = {}) {
  const transporter = createTransporter();
  const brand = siteName || 'NEXORDER';
  const seo = cfg.seo || {};
  const siteUrl = (seo.siteUrl || '').replace(/\/+$/, '');

  // Logo di email: pakai ogImage dari config (gambar yang sama dengan OG preview situs),
  // di-resolve jadi URL absolut kalau nilainya relatif (mis. "/uploads/og.png" -> "https://...").
  // Kalau siteUrl belum diisi di Pengaturan > SEO, atau ogImage belum diset, blok logo
  // otomatis disembunyikan (display:none) biar layout email tetap bersih, gak nampil
  // broken image icon.
  let logoHtml = '';
  if (seo.ogImage) {
    const logoUrl = seo.ogImage.startsWith('http') ? seo.ogImage : (siteUrl + seo.ogImage);
    logoHtml = `<img src="${logoUrl}" alt="${brand}" style="max-height:52px; max-width:180px; object-fit:contain; display:block; margin:0 auto 16px;">`;
  } else {
    // Fallback: teks brand besar bergaya (tetap terlihat branded walau belum ada gambar logo)
    logoHtml = `<div style="font-size:22px; font-weight:800; letter-spacing:1px; color:#1565c0; text-align:center; margin-bottom:16px;">${brand}</div>`;
  }

  await transporter.sendMail({
    from: fromHeader(),
    to: toEmail,
    subject: `${otpCode} adalah kode reset password ${brand} kamu`,
    text: `Kode OTP reset password kamu: ${otpCode}\n\nKode berlaku 10 menit. Jangan bagikan kode ini ke siapa pun, termasuk pihak yang mengaku dari ${brand}.\n\nKalau kamu tidak meminta reset password, abaikan email ini -- password kamu tetap aman.`,
    html: `
      <div style="font-family:Arial,sans-serif; max-width:480px; margin:0 auto; padding:24px; background:#fff; border-radius:12px;">
        ${logoHtml}
        <h2 style="color:#1565c0; text-align:center; margin:0 0 12px; font-size:20px;">${brand}</h2>
        <p style="color:#333; margin:0 0 16px;">Kami menerima permintaan reset password untuk akun kamu. Gunakan kode berikut:</p>
        <div style="font-size:36px; font-weight:800; letter-spacing:10px; background:#f2f5f9; color:#1565c0; padding:20px; border-radius:10px; text-align:center; margin:0 0 20px;">${otpCode}</div>
        <p style="color:#555; font-size:13px; margin:0 0 8px;">Kode berlaku <b>10 menit</b>. Jangan bagikan kode ini ke siapa pun, termasuk pihak yang mengaku dari ${brand}.</p>
        <p style="color:#999; font-size:12px; margin:0;">Kalau kamu tidak meminta reset password, abaikan email ini &mdash; password kamu tetap aman.</p>
      </div>
    `
  });
}
