import express from 'express';
import { getConfig } from '../lib/config.js';
import { processQiospayCallback } from '../lib/deposit.js';
import { processQiospayCallbackForOrder } from '../lib/orderQris.js';
import { processDigiflazzWebhook, verifyDigiflazzSignature } from '../lib/digiflazz.js';

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
router.post('/callback/accept/:secretKey', async (req, res) => {
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

// Webhook callback dari Digiflazz -- URL-nya BEBAS kita pilih (beda dari QIOSPAY yang fixed),
// daftarkan PERSIS url ini di dashboard Digiflazz (member.digiflazz.com -> Atur Koneksi > API >
// Webhook): https://domain-kamu.com/api/webhooks/digiflazz. Dipanggil Digiflazz tiap ada transaksi
// baru (event "create") ATAU transaksi Pending yang berubah status (event "update") -- pelengkap
// checkPendingDigiflazzOrders() yang polling tiap interval di lib/digiflazz.js, jadi order yang
// tadinya "Pending" bisa langsung ke-update begitu Digiflazz tau hasilnya, gak perlu nunggu siklus
// polling berikutnya.
//
// PENTING soal keamanan: BEDA dari QIOSPAY (proteksi via secret di URL), Digiflazz pakai HMAC
// signature (header X-Hub-Signature) yang WAJIB divalidasi -- tanpa ini, siapa pun bisa kirim
// payload palsu "status: Gagal" buat order yang SEBENARNYA sukses, minta di-refund padahal
// produknya udah kepakai/terkirim (modus dobel untung). Makanya kalau Webhook Secret belum diisi
// di Admin > Pengaturan, SEMUA callback ditolak (403) -- bukan diterima tanpa validasi.
router.post('/webhooks/digiflazz', async (req, res) => {
  try {
    const cfg = getConfig();
    const secret = (cfg.digiflazz && cfg.digiflazz.webhookSecret) || '';

    if (!secret) {
      console.error('[digiflazz-webhook] Callback ditolak: Webhook Secret belum diisi di Admin > Pengaturan');
      return res.status(403).json({ status: 'reject', message: 'Webhook secret belum dikonfigurasi di server' });
    }

    const signature = req.get('X-Hub-Signature');
    if (!verifyDigiflazzSignature(req.rawBody, signature, secret)) {
      console.error('[digiflazz-webhook] Callback ditolak: X-Hub-Signature tidak valid/tidak ada');
      return res.status(403).json({ status: 'reject', message: 'Invalid signature' });
    }

    const result = await processDigiflazzWebhook(req.body);
    if (result.matched) {
      console.log(`[digiflazz-webhook] Order ${result.orderId} -> ${result.outcome} via webhook`);
    } else {
      // Sama alasannya kayak QIOSPAY -- bukan berarti error, bisa jadi event duplikat (create+update
      // buat transaksi yang sama) atau ref_id yang gak dikenal (mis. testing dari dashboard
      // Digiflazz). Tetap 200 biar Digiflazz gak nganggep ini gagal & retry percuma.
      console.log(`[digiflazz-webhook] Callback diterima tapi tidak diproses: ${result.reason}`);
    }

    res.status(200).json({ status: 'ok', matched: result.matched });
  } catch (err) {
    console.error('[digiflazz-webhook] Error tak terduga:', err);
    // 500 (bukan 200) buat error TAK TERDUGA -- sama alasannya kayak QIOSPAY, kasih kesempatan
    // Digiflazz retry kalau errornya cuma sementara, daripada notifikasi status ini hilang gitu aja.
    res.status(500).json({ status: 'error', message: 'Gagal diproses, coba lagi' });
  }
});

export default router;
