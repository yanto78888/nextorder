# Auto Deploy Nextorder ke VPS

Setup ini dibuat mengikuti pola `restapi2`: setiap `git push` ke branch `main` akan menjalankan GitHub Actions, SSH ke VPS, `git fetch`, lalu menjalankan script deploy di VPS.

Nextorder tetap dijalankan dengan **PM2** karena aplikasi ini memakai file JSON di folder `data/` sebagai database. Script deploy sudah mengamankan data runtime ke:

```bash
/opt/nextorder/shared/data
/opt/nextorder/shared/uploads/products
```

Jadi `data/` dan upload produk tidak ketimpa saat `git reset --hard`.

---

## File auto deploy yang sudah ditambahkan

- `.github/workflows/deploy.yml` — workflow GitHub Actions untuk SSH ke VPS.
- `deploy/nextorder-update.sh` — script update di VPS dengan lock deploy, backup shared data, install dependency, reload PM2, dan healthcheck.
- `deploy/install-auto-deploy.sh` — helper setup awal di VPS.
- `deploy/Caddyfile.example` — contoh reverse proxy Caddy.
- `scripts/deploy.sh` — wrapper deploy lokal/manual.
- Endpoint healthcheck baru: `/healthz`.

---

## 1. Push project ke GitHub

Extract ZIP ini, lalu commit dan push ke repo private/public kamu.

```bash
git init
git add .
git commit -m "add nextorder auto deploy vps"
git branch -M main
git remote add origin git@github.com:USERNAME/NAMA_REPO.git
git push -u origin main
```

Kalau repo sudah ada, cukup replace file dari ZIP ini lalu:

```bash
git add .
git commit -m "add nextorder auto deploy vps"
git push origin main
```

---

## 2. Siapkan SSH key agar VPS bisa pull repo GitHub

Di VPS, buat SSH key khusus untuk clone/pull repo GitHub:

```bash
ssh-keygen -t ed25519 -C "nextorder-vps" -f ~/.ssh/nextorder_github -N ""
cat ~/.ssh/nextorder_github.pub
```

Masukkan isi public key tersebut ke GitHub:

```text
Repository GitHub → Settings → Deploy keys → Add deploy key
```

Centang **Allow write access** tidak wajib. Untuk deploy cukup read-only.

Buat config SSH di VPS:

```bash
cat > ~/.ssh/config <<'EOFSSH'
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/nextorder_github
  IdentitiesOnly yes
EOFSSH
chmod 600 ~/.ssh/config
ssh -T git@github.com || true
```

---

## 3. Setup pertama di VPS

Login ke VPS sebagai `root` atau user deploy kamu, lalu pastikan sudah ada Node.js 18+ dan PM2.

```bash
apt update
apt install -y git curl ca-certificates nodejs npm
npm install -g pm2
node -v
npm -v
pm2 -v
```

Clone repo ke folder standar auto deploy:

```bash
mkdir -p /opt/nextorder
git clone -b main git@github.com:USERNAME/NAMA_REPO.git /opt/nextorder/app
cd /opt/nextorder/app
```

Jalankan installer deploy pertama:

```bash
APP_DIR=/opt/nextorder/app STACK_DIR=/opt/nextorder bash deploy/install-auto-deploy.sh git@github.com:USERNAME/NAMA_REPO.git main
```

Cek aplikasi:

```bash
curl http://127.0.0.1:3000/healthz
pm2 status
```

---

## 4. Siapkan GitHub Actions Secret

Di GitHub repo buka:

```text
Settings → Secrets and variables → Actions → New repository secret
```

Tambahkan minimal:

```text
VPS_SSH_KEY = private key untuk login dari GitHub Actions ke VPS
```

Workflow sudah memakai default seperti `restapi2`:

```text
host     = 46.247.108.54
username = root
port     = 22
```

Kalau VPS/port/user berbeda, tambahkan secret ini juga:

```text
VPS_HOST = IP/domain VPS kamu
VPS_USER = root / ubuntu / user lain
VPS_PORT = 22
```

Opsional, di tab **Variables** tambahkan:

```text
APP_DIR = /opt/nextorder/app
DEPLOY_BRANCH = main
```

---

## 5. Test auto deploy

Ubah file kecil, commit, lalu push:

```bash
git add .
git commit -m "test auto deploy nextorder"
git push origin main
```

Lihat prosesnya di:

```text
GitHub repo → Actions → Deploy VPS
```

Kalau berhasil, log akan menampilkan:

```text
[nextorder-deploy] healthcheck OK
[nextorder-deploy] deploy selesai
```

---

## 6. Reverse proxy domain

Aplikasi jalan di lokal VPS port `3000`. Untuk domain dan HTTPS, pakai Caddy/Nginx.

Contoh Caddy:

```bash
apt install -y caddy
nano /etc/caddy/Caddyfile
```

Isi contoh:

```caddy
nextorder.domainkamu.com {
  encode gzip zstd
  reverse_proxy 127.0.0.1:3000
}
```

Reload Caddy:

```bash
systemctl reload caddy
```

Contoh file juga tersedia di `deploy/Caddyfile.example`.

---

## 7. Perintah manual jika deploy gagal

Jalankan langsung dari VPS:

```bash
APP_DIR=/opt/nextorder/app STACK_DIR=/opt/nextorder BRANCH=main /usr/local/bin/nextorder-update
```

Cek log:

```bash
pm2 logs nexorder --lines 100
pm2 status
```

Data produksi ada di:

```bash
ls -lah /opt/nextorder/shared/data
ls -lah /opt/nextorder/shared/uploads/products
```

---

## Catatan penting

- PM2 app name masih `nexorder` agar kompatibel dengan config lama.
- Jangan hapus `/opt/nextorder/shared` karena folder itu menyimpan database JSON dan upload produk produksi.
- Untuk production serius, lebih aman pindah dari JSON file ke database seperti PostgreSQL/MySQL, tapi auto deploy ini sudah dibuat aman untuk struktur project saat ini.
