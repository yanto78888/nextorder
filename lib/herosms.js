import axios from 'axios';
import { getConfig } from './config.js';

// =====================================================================
// HEROSMS -- provider nomor virtual buat terima OTP/kode SMS (WhatsApp, Telegram, dll), dipakai
// buat fitur "OTP" (beda dari Digiflazz/top-up dan IndoSMM/jasa-sosmed). API-nya format LEGACY ala
// SMS-Activate: 1 endpoint GET (`?api_key=...&action=...`), kebanyakan balikin STRING biasa
// (bukan JSON bersih) kayak "ACCESS_NUMBER:12345:6281234567890" atau "STATUS_OK:100001" -- jadi
// SEMUA hasilnya di sini di-parse manual, bukan langsung res.data.field kayak Digiflazz/IndoSMM.
//
// Alur order OTP beda TOTAL dari top-up/SMM: bukan "bayar -> langsung dapat hasil", tapi "bayar ->
// dapat NOMOR -> tunggu SMS masuk (di-polling beberapa saat) -> kalau kode gak nongol / berubah
// pikiran, bisa DIBATALKAN (uang balik) selama belum ada SMS masuk". Makanya order OTP butuh
// halaman & status lifecycle sendiri (lihat routes/user.js bagian OTP), gak bisa numpang di
// fulfillOrder() biasa yang asumsinya "sekali panggil langsung kelar".
// =====================================================================

const BASE_URL = 'https://hero-sms.com/stubs/handler_api.php';

function getCreds() {
  const cfg = getConfig();
  const h = cfg.herosms || {};
  if (!h.apiKey) throw new Error('HeroSMS belum dikonfigurasi. Isi API Key di Admin > Pengaturan.');
  return { apiKey: h.apiKey };
}

export function isHerosmsEnabled() {
  const cfg = getConfig();
  const h = cfg.herosms || {};
  return Boolean(h.enabled && h.apiKey);
}

async function callApi(params, { json = false } = {}) {
  const { apiKey } = getCreds();
  const res = await axios.get(BASE_URL, {
    params: { api_key: apiKey, ...params },
    timeout: 20000
  });
  return res.data;
}

// Hitung harga jual (Rupiah) dari cost mentah HeroSMS (dalam RUB, konvensi default SMS-Activate)
// + kurs manual yang diatur admin + margin. Kurs manual dipakai (bukan API kurs live) karena gak
// ada endpoint kurs resmi di spek HeroSMS -- admin yang isi & update sendiri kalau kursnya berubah
// jauh (lihat config.herosms.rubToIdr di halaman Admin > Pengaturan).
export function computeSellPrice(baseCostRub, marginType, marginValue) {
  const cfg = getConfig();
  const hCfg = cfg.herosms || {};
  const type = marginType || hCfg.marginType || 'percent';
  const value = (marginValue !== null && marginValue !== undefined && marginValue !== '')
    ? Number(marginValue)
    : Number(hCfg.marginValue || 30);
  const rate = Number(hCfg.rubToIdr) || 170; // default kasar, WAJIB dicek/disesuaikan admin

  const baseIdr = (Number(baseCostRub) || 0) * rate;
  const raw = type === 'fixed' ? (baseIdr + value) : (baseIdr + (baseIdr * value / 100));
  return Math.ceil(raw / 100) * 100; // dibulatkan ke atas kelipatan Rp 100
}

export async function getBalance() {
  const data = await callApi({ action: 'getBalance' });
  const text = String(data || '');
  if (!text.startsWith('ACCESS_BALANCE:')) throw new Error(parseErrorText(text) || 'Gagal cek saldo HeroSMS');
  return { balance: Number(text.split(':')[1]) || 0, currency: 'RUB' };
}

const CACHE_TTL_MS = 5 * 60 * 1000;
let servicesCache = null;
let countriesCache = null;

export async function getServicesList() {
  if (servicesCache && servicesCache.expiresAt > Date.now()) return servicesCache.data;
  const data = await callApi({ action: 'getServicesList' });
  const list = (data && Array.isArray(data.services)) ? data.services : [];
  servicesCache = { data: list, expiresAt: Date.now() + CACHE_TTL_MS };
  return list; // [{ code, name }]
}

export async function getCountries() {
  if (countriesCache && countriesCache.expiresAt > Date.now()) return countriesCache.data;
  const data = await callApi({ action: 'getCountries' });
  const list = Array.isArray(data) ? data : Object.values(data || {});
  countriesCache = { data: list, expiresAt: Date.now() + CACHE_TTL_MS };
  return list; // [{ id, eng, rus, ... }]
}

// Harga & stok nomor tersedia buat 1 service (opsional filter country). Bentuk respons resminya
// nested { [countryId]: { [serviceCode]: { cost, count } } } -- tapi beberapa varian/versi cuma
// balikin flat { [serviceCode]: {cost,count} } (lihat contoh di spek), jadi di-parse defensif
// buat nampung dua-duanya, bukan asumsi 1 bentuk doang.
export async function getPrices(serviceCode, countryId) {
  const params = { action: 'getPrices' };
  if (serviceCode) params.service = serviceCode;
  if (countryId !== undefined && countryId !== '') params.country = countryId;
  const data = await callApi(params);
  const out = []; // [{ countryId, serviceCode, cost, count }]
  if (!data || typeof data !== 'object') return out;

  for (const [key1, val1] of Object.entries(data)) {
    if (val1 && typeof val1 === 'object' && ('cost' in val1 || 'count' in val1)) {
      // bentuk flat: key1 = serviceCode
      out.push({ countryId: countryId ?? null, serviceCode: key1, cost: val1.cost, count: val1.count });
    } else if (val1 && typeof val1 === 'object') {
      // bentuk nested: key1 = countryId, val1 = { serviceCode: {cost,count} }
      for (const [svc, info] of Object.entries(val1)) {
        if (info && typeof info === 'object') {
          out.push({ countryId: key1, serviceCode: svc, cost: info.cost, count: info.count });
        }
      }
    }
  }
  return out;
}

function parseErrorText(text) {
  const known = {
    NO_NUMBERS: 'Nomor untuk layanan/negara ini sedang habis, coba lagi nanti atau pilih negara lain.',
    NO_BALANCE: 'Saldo HeroSMS tidak cukup, hubungi admin.',
    BAD_SERVICE: 'Layanan tidak valid/tidak dikenali.',
    BAD_KEY: 'API Key HeroSMS tidak valid.',
    ERROR_SQL: 'Terjadi gangguan sistem di HeroSMS, coba lagi sesaat lagi.',
    BAD_ACTION: 'Aksi tidak valid.',
    WRONG_ACTIVATION_ID: 'ID aktivasi tidak ditemukan/sudah tidak berlaku.',
    BAD_STATUS: 'Status aktivasi tidak valid.'
  };
  return known[text] || null;
}

// Sewa 1 nomor buat service+country tertentu. Balikin { activationId, phoneNumber }.
export async function getNumber({ serviceCode, countryId, maxPrice }) {
  const params = { action: 'getNumber', service: serviceCode, country: countryId };
  if (maxPrice) params.maxPrice = maxPrice;
  const data = await callApi(params);
  const text = String(data || '');
  if (!text.startsWith('ACCESS_NUMBER:')) {
    throw new Error(parseErrorText(text) || `Gagal mendapatkan nomor (${text || 'respons kosong'})`);
  }
  const [, activationId, phoneNumber] = text.split(':');
  return { activationId, phoneNumber };
}

// Cek status aktivasi terkini. Balikin salah satu:
// { state: 'waiting' }                 -- masih nunggu SMS masuk
// { state: 'waiting_retry', code }     -- ada kode tapi provider minta konfirmasi ulang
// { state: 'code', code }              -- KODE OTP SUDAH DITERIMA
// { state: 'cancelled' }               -- aktivasi sudah dibatalkan (provider/timeout)
export async function getActivationStatus(activationId) {
  const data = await callApi({ action: 'getStatus', id: activationId });
  const text = String(data || '');
  if (text.startsWith('STATUS_OK:')) return { state: 'code', code: text.split(':')[1] };
  if (text.startsWith('STATUS_WAIT_RETRY:')) return { state: 'waiting_retry', code: text.split(':')[1] };
  if (text === 'STATUS_WAIT_CODE') return { state: 'waiting' };
  if (text === 'STATUS_WAIT_RESEND') return { state: 'waiting' };
  if (text === 'STATUS_CANCEL') return { state: 'cancelled' };
  throw new Error(parseErrorText(text) || `Status tidak dikenali (${text || 'respons kosong'})`);
}

// status: 3=minta SMS baru/konfirmasi ulang, 6=selesaikan (kode dipakai, tutup aktivasi), 8=batalkan
async function setActivationStatus(activationId, status) {
  const data = await callApi({ action: 'setStatus', id: activationId, status });
  return String(data || '');
}

export async function finishActivation(activationId) {
  const text = await setActivationStatus(activationId, 6);
  if (text !== 'ACCESS_ACTIVATION') throw new Error(parseErrorText(text) || 'Gagal menyelesaikan aktivasi');
  return { ok: true };
}

// Batalkan aktivasi (uang balik di sisi HeroSMS) -- HANYA BISA selama belum ada SMS/kode masuk
// (provider akan menolak dengan error kalau dipaksa batalkan padahal kode sudah diterima).
export async function cancelActivation(activationId) {
  const text = await setActivationStatus(activationId, 8);
  if (text !== 'ACCESS_CANCEL') throw new Error(parseErrorText(text) || 'Aktivasi tidak bisa dibatalkan (mungkin kode sudah masuk)');
  return { ok: true };
}
