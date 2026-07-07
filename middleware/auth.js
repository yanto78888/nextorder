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
