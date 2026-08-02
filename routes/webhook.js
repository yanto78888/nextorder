import express from 'express';
import { getConfig } from '../lib/config.js';
import { processQiospayCallback } from '../lib/deposit.js';
import { processQiospayCallbackForOrder } from '../lib/orderQris.js';

const router = express.Router();

// Webhook callback dari QIOSPAY -- URL PERSIS ini yang harus didaftarkan di dashboard merchant
// QIOSPAY: https://domain-kamu.com/api/callback/accept/{secret_key} (lihat dokumentasi API
// QIOSPAY, "Full Implementation Script"). Beda dari checkPendingDeposits() di lib/deposit.js
// yang POLLING tiap interval, ini dipanggil LANGSUNG oleh QIOSPAY tiap ada pembayaran masuk ke
// akun merchant -- jadi saldo user bisa ke-update saat itu juga, gak perlu nunggu siklus polling
// berikutnya (bisa beberapa puluh detik lebih cepat).
//
// PENTING: route ini publik/tanpa login (QIOSPAY yang manggil, bukan browser user) -- satu-
// satunya proteksi adalah secret_key di URL, makanya WAJIB diisi & dijaga kerahasiaannya di
// Admin > Pengaturan > QRIS. Tanpa secret_key yang cocok, request ditolak (403) sebelum
// body-nya bahkan disentuh.
router.post('/accept/:secretKey', async (req, res) => {
  try {
    const cfg = getConfig();
    const configuredKey = (cfg.qris && cfg.qris.secretKey) || '';

    if (!configuredKey) {
      console.error('[qiospay-webhook] Callback ditolak: Secret Key belum diisi di Admin > Pengaturan');
      return res.status(403).json({ status: 'reject', message: 'Secret key belum dikonfigurasi di server', data: null });
    }
    if (req.params.secretKey !== configuredKey) {
      console.error('[qiospay-webhook] Callback ditolak: secret key di URL tidak cocok');
      return res.status(403).json({ status: 'reject', message: 'Invalid secret key', data: null });
    }

    // 1 callback QIOSPAY = 1 transaksi, tapi bisa aja itu buat "Isi Saldo" ATAU buat "bayar
    // produk langsung pakai QRIS" (2 fitur terpisah, lihat lib/deposit.js vs lib/orderQris.js) --
    // dicoba 2-2nya gantian (bukan bareng/Promise.all, sengaja SEKUENSIAL) supaya kalau yang
    // pertama match, processedMutations udah keisi SEBELUM yang kedua jalan, dan gak ada 2
    // pending transaksi ke-kredit sekaligus dari 1 pembayaran yang sama.
    let result = await processQiospayCallback(req.body);
    if (!result.matched) {
      result = await processQiospayCallbackForOrder(req.body);
    }

    if (result.matched) {
      console.log(`[qiospay-webhook] ${result.trxid} lunas via webhook`);
    } else {
      // Bukan berarti error di sisi kita -- bisa jadi duplikat callback (wajar, webhook lazim
      // dikirim ulang) atau transaksi yang emang bukan buat sistem ini. Tetap dibalas 200 di
      // bawah biar QIOSPAY gak retry-retry terus, tapi dicatat di log biar admin bisa cek kalau
      // curiga ada pembayaran yang harusnya kecatat tapi gak ketemu.
      console.log(`[qiospay-webhook] Callback diterima tapi tidak diproses: ${result.reason}`);
    }

    // Balikin struktur mirip $responseData di contoh script QIOSPAY (echo data yang diterima)
    // sebagai tanda callback ini sudah diterima & diproses server -- HTTP 200 di semua kondisi
    // "diterima dengan baik" (termasuk duplikat/gak ada match) supaya QIOSPAY berhenti retry;
    // 403 dipakai KHUSUS buat secret key yang salah.
    res.status(200).json({
      status: 'success',
      message: result.matched ? 'Callback diproses, saldo ditambahkan' : `Callback diterima (${result.reason})`,
      data: req.body && req.body.data ? req.body.data : null
    });
  } catch (err) {
    console.error('[qiospay-webhook] Error tak terduga:', err);
    // BEDA dari kasus "diterima tapi gak match" di atas (yang sengaja dibales 200) -- ini error
    // TAK TERDUGA (mis. disk penuh, bug, dst) yang mungkin aja cuma sementara. Dibales 500 biar
    // mekanisme retry otomatis QIOSPAY dapat kesempatan coba lagi nanti -- kalau dibales 200 di
    // sini, notifikasi pembayaran yang mungkin genuinely valid ini hilang permanen gak ke-retry
    // sama sekali, padahal errornya bisa jadi cuma sementara di sisi kita.
    res.status(500).json({ status: 'error', message: 'Gagal diproses, coba lagi', data: null });
  }
});

export default router;
