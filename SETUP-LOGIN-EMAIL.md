# Update: Login pakai Email + Lupa Password (OTP via Email SMTP)

## Yang berubah
1. **Login sekarang pakai Email**, bukan Username lagi. Username TETAP ADA & tersimpan (masih
   kelihatan di halaman Profil, masih dipakai di API key dll) -- cuma gak dipakai buat login lagi.
   - Buat jaga-jaga akun LAMA yang emailnya masih kosong (dibuat sebelum update ini), sistem
     login tetap fallback coba cocokkan ke Username kalau dicari via Email gak ketemu. Jadi akun
     lama gak langsung kekunci, tapi TETAP DISARANKAN tiap user (terutama akun Admin default)
     segera isi email asli di halaman Profil, karena fitur Lupa Password WAJIB butuh email valid.
2. **Daftar akun baru sekarang WAJIB isi email** (sebelumnya opsional), harus unik (gak boleh
   sama kayak akun lain).
3. **Fitur baru: Lupa Password.** Alurnya:
   - User klik "Lupa password?" di halaman Login -> `/lupa-password` -> isi email
   - Sistem kirim kode OTP 6 digit ke email itu (kalau emailnya terdaftar)
   - User masuk ke `/reset-password`, isi kode OTP + password baru
   - Kode berlaku 10 menit, salah 5x kode otomatis invalid, ada cooldown 60 detik antar
     permintaan kirim ulang kode (biar gak dipakai buat nge-spam kotak masuk orang)

## LANGKAH WAJIB SETELAH UPLOAD FILE INI

### 1. Install dependency baru
```bash
npm install
```
(package.json sudah ditambahkan `nodemailer`, tinggal `npm install` biar ke-download)

### 2. Setup SMTP di Admin Panel
Buka **Admin > Pengaturan > Email / SMTP**, isi:
- **SMTP Host** -- misal `smtp.gmail.com` (kalau pakai Gmail)
- **SMTP Port** -- `587` (STARTTLS, paling umum) atau `465` (SSL)
- **SMTP Username** -- alamat email kamu, misal `tokokamu@gmail.com`
- **SMTP Password** -- **BUKAN password Gmail biasa!** Kalau pakai Gmail, wajib bikin
  **App Password** dulu di https://myaccount.google.com/apppasswords (butuh 2FA aktif dulu di
  akun Google itu), lalu paste 16 karakter App Password-nya di sini
- **Nama Pengirim** & **Email Pengirim** -- opsional, kalau kosong otomatis pakai SMTP Username

Klik **"Kirim Email Percobaan"**, isi email tujuan tes, pastikan kamu beneran nerima emailnya
sebelum dianggap selesai.

### 3. Update akun Admin yang sudah ada
Karena akun admin default kemungkinan emailnya masih kosong (dibuat sebelum update ini), setelah
login pakai username seperti biasa (masih bisa lewat fallback), buka **halaman Profil**, isi
email asli kamu di situ, simpan. Setelah itu baru bisa login pakai email + pakai fitur Lupa
Password.

## Berkas yang diubah/baru
Baru:
- `lib/mailer.js`
- `views/lupa-password.ejs`
- `views/reset-password.ejs`

Diubah:
- `lib/users.js` -- validasi email wajib/unik + fungsi OTP
- `routes/auth.js` -- login via email + 4 route baru lupa password
- `routes/user.js` -- validasi email di halaman Profil
- `routes/admin.js` -- simpan pengaturan SMTP + route tes kirim email
- `server.js`, `scripts/reset-admin.js` -- bootstrap admin default dikasih email placeholder
- `views/login.ejs`, `views/register.ejs`, `views/profile.ejs` -- form email
- `views/admin/settings.ejs` -- section Email/SMTP baru
- `package.json` -- tambah dependency `nodemailer`

Timpa semua file ini ke project kamu (path sama persis), jalankan `npm install`, lalu restart
server.
