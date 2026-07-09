// Reset password admin ke default (admin / admin123)
// Cara pakai: jalankan di root project -> node scripts/reset-admin.js
//
// - Kalau sudah ada user dengan role 'admin', usernamenya di-set ke "admin"
//   dan passwordnya direset ke "admin123".
// - Kalau belum ada admin sama sekali, akan dibuatkan baru.
//
// Setelah berhasil login, SEGERA ganti password di halaman Profile.

import { getAllUsers, createUser, updateUser, setPassword } from '../lib/users.js';

const DEFAULT_USERNAME = 'skirk';
const DEFAULT_PASSWORD = 'binigw';

function run() {
  const users = getAllUsers();
  const existingAdmin = users.find(u => u.role === 'admin');

  if (existingAdmin) {
    updateUser(existingAdmin.id, { username: DEFAULT_USERNAME, status: 'active' });
    setPassword(existingAdmin.id, DEFAULT_PASSWORD);
    console.log('===================================================');
    console.log(' Password admin berhasil direset!');
    console.log(' Username :', DEFAULT_USERNAME);
    console.log(' Password :', DEFAULT_PASSWORD);
    console.log(' >>> SEGERA LOGIN & GANTI PASSWORD DI HALAMAN PROFILE <<<');
    console.log('===================================================');
  } else {
    createUser({ username: DEFAULT_USERNAME, email: '', password: DEFAULT_PASSWORD, role: 'admin' });
    console.log('===================================================');
    console.log(' Belum ada akun admin, jadi dibuatkan baru!');
    console.log(' Username :', DEFAULT_USERNAME);
    console.log(' Password :', DEFAULT_PASSWORD);
    console.log('===================================================');
  }
}

run();
