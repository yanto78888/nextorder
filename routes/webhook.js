import express from 'express';
import crypto from 'crypto';
import { getConfig } from '../lib/config.js';
import { processQiospayCallback } from '../lib/deposit.js';
import { processQiospayCallbackForOrder } from '../lib/orderQris.js';
import { processDigiflazzWebhook, verifyDigiflazzSignature } from '../lib/digiflazz.js';
import { patchOrder, getAllOrders } from '../lib/orders.js';
import { finishActivation } from '../lib/herosms.js';
import { findUserById } from '../lib/users.js';
import { creditReferralCommission } from '../lib/referrals.js';

const router = express.Router();

// Bandingin 2 string SECRET pakai timingSafeEqual -- SAMA alasan & pola yang sudah dipakai
// verifyDigiflazzSignature() di lib/digiflazz.js buat HMAC (lihat di sana, sudah pakai
// crypto.timingSafeEqual dari awal). String `!==` biasa "pulang" (return) secepat nemu
// karakter PERTAMA yang beda -- secara teori itu bikin waktu respons dikit lebih cepat buat
// tebakan yang MELESET LEBIH AWAL, yang teorinya bisa dipakai nebak secret 1 karakter demi 1
// karakter lewat pola waktu respons (timing attack). Proteksi ini sudah ada buat Digiflazz;
// QIOSPAY & HeroSMS (yang proteksinya "secret di URL" doang, bukan HMAC signature) ternyata
// masih pakai `!==` polos -- disamain di sini biar konsisten.
function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

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
    if (!timingSafeStringEqual(req.params.secretKey, configuredKey)) {
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

// Webhook dari HeroSMS -- PELENGKAP dari polling GET /otp/status/:id/check yang udah ada.
// Dokumentasi resmi HeroSMS: daftarkan URL ini di "Personal Information" dashboard HeroSMS
// (bisa sampai 3 URL webhook sekaligus):
//   https://domain-kamu.com/api/webhooks/herosms/{WEBHOOK_SECRET}
// WEBHOOK_SECRET diisi di Admin > Pengaturan > HeroSMS.
//
// Format payload HeroSMS (application/json, POST):
//   activationId  string   -- ID aktivasi (= providerRefId yang kita simpan saat order OTP)
//   service       string   -- kode service (mis. "tg" untuk Telegram)
//   text          string   -- isi SMS lengkap (mis. "Your code is 12345")
//   code          string   -- kode OTP yang sudah di-ekstrak HeroSMS dari SMS
//   country       integer  -- country ID
//   receivedAt    string   -- timestamp ISO 8601
//
// HeroSMS retry webhook sampai 7x (jeda 20-30 detik) kalau server tidak balas 200 dalam 3 detik.
// Selalu balas 200 -- termasuk untuk duplikat -- biar HeroSMS berhenti retry percuma.
router.post('/webhooks/herosms/:secret', async (req, res) => {
  try {
    const cfg = getConfig();
    const configuredSecret = (cfg.herosms && cfg.herosms.webhookSecret) || '';

    if (!configuredSecret) {
      console.error('[herosms-webhook] Callback ditolak: Webhook Secret belum diisi di Admin > Pengaturan > HeroSMS');
      return res.status(403).json({ status: 'reject', message: 'Webhook secret belum dikonfigurasi' });
    }
    if (!timingSafeStringEqual(req.params.secret, configuredSecret)) {
      console.error('[herosms-webhook] Callback ditolak: secret di URL tidak cocok');
      return res.status(403).json({ status: 'reject', message: 'Invalid secret' });
    }

    const body = req.body || {};

    // Field resmi HeroSMS webhook: activationId & code (kode OTP yang sudah diekstrak).
    // `text` (isi SMS lengkap) juga tersedia tapi kita pakai `code` yang sudah bersih.
    const activationId = String(body.activationId || '');
    const code = String(body.code || '').trim();

    if (!activationId) {
      console.warn('[herosms-webhook] Payload tidak punya activationId, diabaikan');
      return res.status(200).json({ status: 'ok', note: 'no activationId, ignored' });
    }

    if (!code) {
      // Notifikasi masuk tapi belum ada kode (jarang terjadi) -- balas 200, jangan retry
      console.warn(`[herosms-webhook] activationId ${activationId} masuk tapi code kosong, diabaikan`);
      return res.status(200).json({ status: 'ok', note: 'no code in payload, ignored' });
    }

    // Cari order OTP yang masih processing & punya providerRefId yang cocok
    const order = getAllOrders().find(o =>
      o.provider === 'otp' &&
      o.status === 'processing' &&
      String(o.providerRefId) === activationId
    );

    if (!order) {
      // Duplikat callback (order sudah completed/cancelled) atau activationId asing
      console.log(`[herosms-webhook] activationId ${activationId} tidak ditemukan / sudah selesai, diabaikan`);
      return res.status(200).json({ status: 'ok', note: 'order not found or already finished' });
    }

    patchOrder(order.id, { status: 'completed', detail: code, note: 'Kode OTP diterima via webhook' });

    // Komisi referral juga berlaku buat produk OTP -- lihat catatan lengkap di routes/user.js
    // GET /otp/status/:id/check (bug yang sama, di jalur webhook real-time HeroSMS).
    const otpBuyer = findUserById(order.userId);
    if (otpBuyer) creditReferralCommission({ buyer: otpBuyer, orderTotal: order.total, orderId: order.id });

    // Beritahu HeroSMS bahwa kode sudah berhasil dipakai (setStatus 6 = "completed") supaya
    // slot nomor dilepas dan tidak terus di-charge. Fire-and-forget biar response cepat balik.
    finishActivation(activationId).catch(err =>
      console.warn('[herosms-webhook] finishActivation gagal (order tetap completed):', err.message)
    );

    console.log(`[herosms-webhook] Order ${order.id} kode OTP diterima: ${code} (activationId: ${activationId})`);
    res.status(200).json({ status: 'ok', matched: true });

  } catch (err) {
    console.error('[herosms-webhook] Error tak terduga:', err);
    // 500 biar HeroSMS bisa retry (bukan 200 yang bikin HeroSMS stop retry permanen)
    res.status(500).json({ status: 'error', message: 'Gagal diproses' });
  }
});

export default router;
