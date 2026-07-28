import { findUserByApiKey } from '../lib/users.js';
import { checkRateLimit } from '../lib/rateLimiter.js';

export function requireLogin(req, res, next) {
  if (!req.session.user) {
    return req.originalUrl.startsWith('/api')
      ? res.status(401).json({ error: 'Silakan login terlebih dahulu' })
      : res.redirect('/login');
  }
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return req.originalUrl.startsWith('/api')
      ? res.status(403).json({ error: 'Akses ditolak' })
      : res.redirect('/login');
  }
  next();
}

export function attachUser(req, res, next) {
  res.locals.currentUser = req.session.user || null;
  next();
}

// Auth buat API reseller (routes/api.js) -- BEDA dari requireLogin (session cookie browser).
// API key dikirim lewat header "X-API-Key", atau query string ?apikey= buat kemudahan testing
// cepat (mis. langsung dicoba di browser/Postman) -- header tetap cara yang disarankan buat
// pemakaian produksi (gak ke-log di access log server/proxy kayak query string biasanya).
//
// requireApiKey(scope) -- scope WAJIB diisi ('transaction' atau 'deposit'). Key transaksi TIDAK
// BISA dipakai buat endpoint deposit, dan sebaliknya -- keduanya sengaja dipisah total (lihat
// catatan lengkap di lib/users.js) supaya kebocoran 1 key gak otomatis buka akses ke yang lain.
// Selain itu tiap key WAJIB sudah terdaftar ke 1 alamat IPv6 spesifik saat di-generate -- request
// dari IP lain ditolak walau key-nya valid. Terakhir, tiap key dibatasi 60 request/menit.
export function requireApiKey(scope) {
  if (scope !== 'transaction' && scope !== 'deposit') {
    throw new Error('requireApiKey(scope) wajib diisi "transaction" atau "deposit"');
  }
  return function (req, res, next) {
    const key = req.get('X-API-Key') || req.query.apikey || '';
    if (!key) {
      return res.status(401).json({ success: false, message: 'API key belum diisi. Kirim lewat header X-API-Key.' });
    }
    const match = findUserByApiKey(key);
    if (!match) {
      return res.status(401).json({ success: false, message: 'API key tidak valid.' });
    }
    if (match.scope !== scope) {
      const scopeLabel = scope === 'deposit' ? 'deposit' : 'transaksi';
      return res.status(403).json({
        success: false,
        message: `API key ini bukan untuk endpoint ${scopeLabel}. API key transaksi & deposit sengaja dipisah -- generate key khusus "${scopeLabel}" di halaman Profil.`
      });
    }
    const { user } = match;
    if (user.status !== 'active') {
      return res.status(403).json({ success: false, message: 'Akun kamu sedang tidak aktif, hubungi admin.' });
    }

    const registeredIp = scope === 'deposit' ? user.apiKeyDepositIp : user.apiKeyTransactionIp;
    const requestIp = getRequestIp(req);
    if (registeredIp && requestIp !== registeredIp) {
      return res.status(403).json({
        success: false,
        message: `Akses ditolak: request dari IP ${requestIp}, sedangkan key ini terdaftar untuk IP ${registeredIp}. Update IP terdaftar di halaman Profil kalau IP kamu berubah.`
      });
    }

    const rl = checkRateLimit(key);
    res.set('X-RateLimit-Limit', '60');
    res.set('X-RateLimit-Remaining', String(rl.remaining));
    if (!rl.allowed) {
      return res.status(429).json({ success: false, message: 'Terlalu banyak request. Maksimal 60 request per menit untuk 1 API key.' });
    }

    req.apiUser = user;
    req.apiScope = scope;
    next();
  };
}

function getRequestIp(req) {
  let ip = req.ip || (req.connection && req.connection.remoteAddress) || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7); // notasi IPv4-mapped-IPv6, disederhanakan
  return ip;
}
