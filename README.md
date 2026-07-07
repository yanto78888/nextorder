# NEXORDER — Web Auto Order Produk Digital

Web app auto order untuk produk digital / akun premium, dengan:
- Login & register user (session-based, password di-hash bcrypt)
- Saldo, profil, riwayat order, total order
- Order otomatis: saldo terpotong & status langsung "diproses" setelah checkout, pengiriman produk (detail akun) diinput manual oleh admin
- Top up saldo via **QRIS dinamis** (QR statis + nominal + fee + kode unik), auto-cek mutasi pembayaran (default provider: qiospay.id, bisa diganti)
- Admin dashboard bertema **cyberpunk**: kelola produk (CRUD), kelola order (update status & kirim pesanan manual), kelola user (adjust saldo, blokir, ubah role), pengaturan sistem
- Notifikasi ke **Telegram** (token & chat ID diatur dari admin dashboard, bukan .env)
- Database: **file JSON biasa** di folder `data/` (tanpa .env, tanpa database server). Di Vercel, data disalin ke `/tmp` untuk demo dan bersifat sementara.

## 1. Install

Butuh Node.js versi 18+.

```bash
cd autoorder
npm install
```

> Catatan: versi ini sudah dibuat lebih ramah Vercel dengan generator QR berbasis `qrcode` tanpa dependency native `canvas`.

## 2. Jalankan

```bash
npm start
```

Buka `http://localhost:3000`.

Saat pertama kali dijalankan (database masih kosong), sistem otomatis membuat akun admin default:

```
Username: admin
Password: admin123
```

**Segera login dan ganti password** di menu Profil (untuk admin, tetap ada di path yang sama, tapi menu admin hanya berisi Overview/Produk/Order/User/Settings — untuk ganti password gunakan endpoint `/profile` langsung atau tambahkan link sendiri).

## 3. Konfigurasi Payment Gateway & Telegram (Admin Dashboard)

Masuk sebagai admin → menu **Pengaturan**:

- **Payment Gateway QRIS**
  - `String QRIS Statis`: string QRIS dari akun QRIS kamu (didapat dari provider, contohnya seperti pada kode yang sudah kamu punya sebelumnya)
  - `Merchant Code` & `API Key`: kredensial dari provider pengecekan mutasi (default kode ini pakai endpoint gaya `qiospay.id`). Kalau providermu beda, sesuaikan endpoint di `lib/deposit.js` fungsi `checkPendingDeposits()`
  - `Fee (%)`, `Minimal Deposit`, `Waktu Expired QR` bisa diatur bebas

- **Notifikasi Telegram**
  - Buat bot lewat [@BotFather](https://t.me/BotFather) di Telegram → dapat **Bot Token**
  - Dapatkan **Chat ID** tujuan notifikasi (bisa chat ID pribadi atau grup)
  - Masukkan keduanya di form, centang notifikasi yang diinginkan (deposit / order / user baru)

Semua pengaturan ini disimpan ke `data/config.json` — **bukan** file `.env` — dan bisa diubah kapan saja tanpa restart server.

## 4. Struktur Data (JSON Database)

```
data/
  config.json            # pengaturan situs, QRIS, Telegram
  users.json             # akun user & admin
  products.json          # katalog produk digital
  orders.json            # semua order (user & manual admin)
  deposits.json          # transaksi top up saldo
  processedMutations.json# anti duplikat mutasi QRIS
  feeReport.json         # laporan fee (opsional, bisa dikembangkan)
```

Tidak butuh MySQL/Postgres/Mongo — cukup file JSON ini. Backup = copy folder `data/`.

## 5. Alur Fitur Utama

**User:**
1. Register/Login
2. Top Up saldo lewat QRIS dinamis (halaman `/topup`) → tunggu scan → saldo otomatis bertambah
3. Beli produk di `/produk` → saldo otomatis terpotong, order berstatus "processing"
4. Cek `/riwayat` untuk lihat status & detail produk yang dikirim admin

**Admin:**
1. `/admin/produk` → tambah/edit/hapus produk
2. `/admin/order` → lihat semua order, update status + isi "Detail" (misal email/password akun) untuk dikirim ke user, atau gunakan form **Kirim Pesanan Manual** untuk membuat order langsung ke user tertentu (tanpa lewat saldo, misal pembayaran manual/bonus)
3. `/admin/users` → atur saldo user manual, blokir/aktifkan, ubah role
4. `/admin/settings` → atur semua kredensial payment gateway & Telegram

## 6. Keamanan Sebelum Production

- Ganti `secret` session di `server.js` (`express-session`) dengan string acak yang kuat
- Jalankan di belakang HTTPS (reverse proxy Nginx/Caddy + SSL)
- Ganti password admin default segera
- Pertimbangkan rate limiting untuk endpoint login/register & topup
