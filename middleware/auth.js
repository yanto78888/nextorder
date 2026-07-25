import { findUserByApiKey } from '../lib/users.js';

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
export function requireApiKey(req, res, next) {
  const key = req.get('X-API-Key') || req.query.apikey || '';
  const user = key ? findUserByApiKey(key) : null;
  if (!user) {
    return res.status(401).json({ success: false, message: 'API key tidak valid atau belum diisi. Kirim lewat header X-API-Key.' });
  }
  if (user.status !== 'active') {
    return res.status(403).json({ success: false, message: 'Akun kamu sedang tidak aktif, hubungi admin.' });
  }
  req.apiUser = user;
  next();
}
