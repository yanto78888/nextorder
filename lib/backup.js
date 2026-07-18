import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import axios from 'axios';
import FormData from 'form-data';
import { fileURLToPath } from 'url';
import { getConfig } from './config.js';
import { getDataDir, readDB, writeDB } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
// Folder sementara buat naruh file .zip, terpisah dari /data biar gak ke-zip diri sendiri
const BACKUP_TMP_DIR = path.join(__dirname, '..', 'tmp-backup');

function ensureTmpDir() {
  if (!fs.existsSync(BACKUP_TMP_DIR)) fs.mkdirSync(BACKUP_TMP_DIR, { recursive: true });
}

// Bikin file zip dari isi folder /data (config, products, orders, users, dll)
function createDataZip() {
  return new Promise((resolve, reject) => {
    ensureTmpDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const zipPath = path.join(BACKUP_TMP_DIR, `backup-data-${stamp}.zip`);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => resolve(zipPath));
    archive.on('error', reject);
    output.on('error', reject);

    archive.pipe(output);
    if (fs.existsSync(DATA_DIR)) {
      archive.directory(DATA_DIR, 'data');
    }
    archive.finalize();
  });
}

// Kirim file zip ke Telegram sebagai dokumen
async function sendZipToTelegram(zipPath) {
  const cfg = getConfig();
  const { botToken, chatId } = cfg.telegram || {};
  if (!botToken || !chatId) {
    console.log('[backup] Token/ChatId Telegram belum diset, backup dilewati.');
    return { skipped: true };
  }

  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('caption', `🗄 Backup data otomatis\n🕒 ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB`);
  form.append('document', fs.createReadStream(zipPath), path.basename(zipPath));

  const url = `https://api.telegram.org/bot${botToken}/sendDocument`;
  const res = await axios.post(url, form, {
    headers: form.getHeaders(),
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 60000
  });
  return res.data;
}

// Jalankan 1 siklus backup: zip -> kirim ke Telegram -> hapus zip biar ga numpuk
export async function runBackupNow() {
  let zipPath = null;
  try {
    zipPath = await createDataZip();
    const result = await sendZipToTelegram(zipPath);
    if (result?.skipped) return { ok: false, reason: 'no-telegram-config' };
    if (result?.ok === false) throw new Error(result.description || 'Telegram menolak upload');
    console.log('[backup] Backup data berhasil dikirim ke Telegram.');
    return { ok: true };
  } catch (err) {
    console.error('[backup] Gagal backup:', err.response?.data || err.message);
    return { ok: false, reason: err.message };
  } finally {
    // Hapus file zip dari server setelah dikirim (atau gagal kirim) biar tidak menumpuk
    if (zipPath && fs.existsSync(zipPath)) {
      fs.unlink(zipPath, () => {});
    }
  }
}

// Jadwalkan backup otomatis tiap N jam (default 5 jam)
export function scheduleAutoBackup(hours = 5) {
  const intervalMs = hours * 60 * 60 * 1000;
  setInterval(() => {
    runBackupNow().catch(() => {});
  }, intervalMs);
  console.log(`[backup] Auto backup dijadwalkan tiap ${hours} jam sekali.`);
}

// ===== EXPORT / IMPORT DATABASE (1 file .json, lewat browser) =====
// Beda sama backup zip->Telegram di atas: fitur ini buat admin DOWNLOAD backup LANGSUNG dari
// browser (gak perlu Telegram diisi dulu) dan buat PULIHKAN/IMPORT data lewat upload file di
// halaman Admin > Pengaturan. Sengaja pakai 1 file .json gabungan (bukan .zip banyak file) biar
// gampang di-handle dari sisi browser (1 file upload/download) & gak butuh library unzip tambahan
// di server.
//
// Nama tabel diambil OTOMATIS dari file .json yang ADA saat ini di folder data (bukan daftar
// hardcode) -- beberapa tabel (flashsale, digiflazzGroups, reviews, dst) baru muncul jadi file
// fisik SETELAH fitur itu pertama kali dipakai (readDB fallback ke [] kalau file belum ada).
// Discovery dinamis begini bikin export selalu ngikutin apa pun yang benar-benar ada, sama kayak
// createDataZip() di atas yang nge-zip seluruh folder /data apa adanya.
function listTableNames() {
  const dir = getDataDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => f.slice(0, -5));
}

export function exportAllData() {
  const tables = {};
  listTableNames().forEach(name => { tables[name] = readDB(name, null); });
  return {
    app: 'nexorder',
    exportedAt: new Date().toISOString(),
    tables
  };
}

// Simpan salinan data SAAT INI ke folder data-backups/ sebelum ditimpa proses import -- jaring
// pengaman kalau file yang diupload ternyata salah/rusak, admin masih bisa balikin manual dari sini.
function snapshotCurrentData() {
  const dir = getDataDir();
  if (!fs.existsSync(dir)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(__dirname, '..', 'data-backups', `pre-import-${stamp}`);
  fs.mkdirSync(dest, { recursive: true });
  listTableNames().forEach(name => {
    fs.copyFileSync(path.join(dir, `${name}.json`), path.join(dest, `${name}.json`));
  });
  return dest;
}

// bundle = hasil JSON.parse() dari file yang diupload admin, HARUS berbentuk kayak hasil
// exportAllData() ({ tables: { namaTabel: data, ... } }). Nama tabel divalidasi pola aman
// (huruf/angka/underscore/dash doang) sebelum dipakai jadi nama file, biar gak bisa disalahgunakan
// buat nulis file di luar folder data (path traversal dsb).
export function importAllData(bundle) {
  if (!bundle || typeof bundle !== 'object' || !bundle.tables || typeof bundle.tables !== 'object') {
    throw new Error('Format file tidak dikenali. Pakai file hasil "Download Backup (JSON)" dari halaman ini.');
  }
  const tableNames = Object.keys(bundle.tables).filter(name => /^[a-zA-Z0-9_-]+$/.test(name));
  if (tableNames.length === 0) {
    throw new Error('File backup kosong atau tidak ada tabel yang bisa dipulihkan.');
  }

  const snapshotPath = snapshotCurrentData();

  let restored = 0;
  tableNames.forEach(name => {
    const value = bundle.tables[name];
    if (value === undefined) return;
    writeDB(name, value);
    restored++;
  });

  return { restored, tableNames, snapshotPath };
}
