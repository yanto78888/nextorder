import bcrypt from 'bcryptjs';
import { readDB, writeDB, genId } from './db.js';

export function getAllUsers() {
  return readDB('users', []);
}

export function findUserById(id) {
  return getAllUsers().find(u => u.id === id) || null;
}

export function findUserByUsername(username) {
  return getAllUsers().find(
    u => u.username.toLowerCase() === String(username).toLowerCase()
  ) || null;
}

export function createUser({ username, email, password, role = 'user' }) {
  const users = getAllUsers();
  if (findUserByUsername(username)) {
    throw new Error('Username sudah digunakan');
  }
  const hash = bcrypt.hashSync(password, 10);
  const user = {
    id: genId('U'),
    username,
    email: email || '',
    password: hash,
    role,
    saldo: 0,
    status: 'active',
    createdAt: new Date().toISOString()
  };
  users.push(user);
  writeDB('users', users);
  return user;
}

export function verifyPassword(user, password) {
  return bcrypt.compareSync(password, user.password);
}

export function updateUser(id, partial) {
  const users = getAllUsers();
  const idx = users.findIndex(u => u.id === id);
  if (idx === -1) throw new Error('User tidak ditemukan');
  users[idx] = { ...users[idx], ...partial };
  writeDB('users', users);
  return users[idx];
}

export function setPassword(id, newPassword) {
  const hash = bcrypt.hashSync(newPassword, 10);
  return updateUser(id, { password: hash });
}

export function getSaldo(id) {
  const u = findUserById(id);
  return u ? u.saldo : 0;
}

export function addSaldo(id, amount) {
  const u = findUserById(id);
  if (!u) throw new Error('User tidak ditemukan');
  const newSaldo = (u.saldo || 0) + amount;
  updateUser(id, { saldo: newSaldo });
  return newSaldo;
}

export function deductSaldo(id, amount) {
  const u = findUserById(id);
  if (!u) throw new Error('User tidak ditemukan');
  if ((u.saldo || 0) < amount) throw new Error('Saldo tidak cukup');
  const newSaldo = u.saldo - amount;
  updateUser(id, { saldo: newSaldo });
  return newSaldo;
}
