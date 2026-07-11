import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import axios from 'axios';
import FormData from 'form-data';
import { fileURLToPath } from 'url';
import { getConfig } from './config.js';

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
