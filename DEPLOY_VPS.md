# Auto Deploy VPS dari Private GitHub

Setup ini membuat setiap `git push` ke branch `main` otomatis terpasang di VPS dan aplikasi direload memakai PM2.

## 1. Persiapan pertama di VPS

```bash
sudo apt update
sudo apt install -y git nodejs npm
sudo npm i -g pm2
sudo mkdir -p /var/www
sudo chown -R $USER:$USER /var/www
cd /var/www
git clone git@github.com:USERNAME/REPO_PRIVATE.git nexorder
cd nexorder
npm ci --omit=dev
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Ganti `USERNAME/REPO_PRIVATE` dengan repo private kamu. Pastikan SSH key VPS sudah diberi akses ke repo private GitHub.

## 2. Secret GitHub Actions

Di GitHub repo buka **Settings → Secrets and variables → Actions → New repository secret**, lalu isi:

- `VPS_HOST` = IP/domain VPS
- `VPS_USER` = user SSH VPS, contoh `root` atau `ubuntu`
- `VPS_PORT` = port SSH, biasanya `22`
- `VPS_SSH_KEY` = private key SSH untuk login ke VPS
- `APP_DIR` = `/var/www/nexorder`

## 3. Cara kerja deploy

Setiap ada perubahan di GitHub branch `main`, workflow akan SSH ke VPS, menjalankan:

```bash
git fetch origin main
git reset --hard origin/main
npm ci --omit=dev
pm2 reload ecosystem.config.cjs --update-env
pm2 save
```

Catatan: project ini masih memakai file JSON sebagai database. Karena itu PM2 diset `instances: 1` agar data JSON tidak rawan bentrok. Reload PM2 tetap jauh lebih aman dibanding mematikan proses manual. Untuk benar-benar zero-downtime multi-instance, sebaiknya pindahkan data ke database seperti PostgreSQL/MySQL/Redis.
