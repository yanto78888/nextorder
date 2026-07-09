import express from 'express';
import { createUser, findUserByUsername, verifyPassword } from '../lib/users.js';
import { getConfig } from '../lib/config.js';
import { notifyRegister } from '../lib/telegram.js';

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect(req.session.user.role === 'admin' ? '/admin' : '/produk');
  res.render('login', { error: null, config: getConfig() });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = findUserByUsername(username);
  if (!user || !verifyPassword(user, password)) {
    return res.render('login', { error: 'Username atau password salah', config: getConfig() });
  }
  if (user.status === 'banned') {
    return res.render('login', { error: 'Akun anda diblokir. Hubungi admin.', config: getConfig() });
  }
  req.session.user = { id: user.id, username: user.username, role: user.role };
  res.redirect(user.role === 'admin' ? '/admin' : '/produk');
});

router.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/produk');
  res.render('register', { error: null, config: getConfig() });
});

router.post('/register', async (req, res) => {
  const { username, email, password, password2 } = req.body;
  const cfg = getConfig();

  if (!username || !password) {
    return res.render('register', { error: 'Username dan password wajib diisi', config: cfg });
  }
  if (password !== password2) {
    return res.render('register', { error: 'Konfirmasi password tidak cocok', config: cfg });
  }
  if (password.length < 6) {
    return res.render('register', { error: 'Password minimal 6 karakter', config: cfg });
  }

  try {
    const user = createUser({ username, email, password });
    req.session.user = { id: user.id, username: user.username, role: user.role };
    notifyRegister({ username: user.username }).catch(() => {});
    res.redirect('/produk');
  } catch (err) {
    res.render('register', { error: err.message, config: cfg });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

export default router;
