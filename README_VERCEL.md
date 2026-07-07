# Deploy NEXORDER ke Vercel

Project ini sudah direvisi agar bisa dicoba di Vercel melalui GitHub.

## Cara upload ke GitHub

```bash
git init
git add .
git commit -m "Deploy NEXORDER to Vercel"
git branch -M main
git remote add origin https://github.com/USERNAME/nexorder.git
git push -u origin main
```

## Cara deploy di Vercel

1. Login ke Vercel.
2. Klik **Add New Project**.
3. Import repository GitHub `nexorder`.
4. Framework Preset pilih **Other**.
5. Build Command kosongkan saja.
6. Output Directory kosongkan saja.
7. Tambahkan Environment Variable opsional:
   - `SESSION_SECRET` = string acak panjang untuk session.
8. Klik **Deploy**.

## Login awal

Jika data user kosong, aplikasi membuat admin default:

```text
Username: admin
Password: admin123
```

Segera ganti password setelah login.

## Catatan penting untuk Vercel

- File JSON di folder `data/` disalin ke `/tmp` saat berjalan di Vercel supaya fitur tulis data tidak langsung error.
- Data di `/tmp` bersifat sementara. Data bisa hilang saat function restart, cold start, atau redeploy.
- Background job cek mutasi QRIS otomatis dinonaktifkan di Vercel karena serverless tidak berjalan terus-menerus.
- Untuk production, lebih disarankan VPS atau migrasi data ke database seperti Supabase/Postgres/Neon/MongoDB/Upstash.

## Perubahan yang sudah dilakukan

- Menambahkan `vercel.json`.
- Mengubah `server.js` agar export app di Vercel dan hanya `app.listen()` saat local/VPS.
- Menghapus dependency native `canvas` dari `package.json`.
- Mengubah generator QR di `lib/qris.js` memakai package `qrcode` saja.
- Mengubah `lib/db.js` agar di Vercel menulis data ke `/tmp/nexorder-data`.
- Menambahkan `.gitignore`.
