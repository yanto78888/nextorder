import { getAllOrders } from './orders.js';

// =====================================================================
// LEADERBOARD -- ranking user berdasarkan total belanja (order yang statusnya BUKAN cancelled)
// dalam periode minggu berjalan / bulan berjalan. Dipakai halaman publik /leaderboard dan admin
// /admin/leaderboard (buat kirim reward ke yang teratas).
// =====================================================================

function startOfWeek(d) {
  // Minggu dimulai Senin (konvensi ID), bukan Minggu kayak default JS getDay()==0.
  const date = new Date(d);
  const day = date.getDay(); // 0=Minggu, 1=Senin, ...
  const diff = (day === 0 ? -6 : 1) - day;
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

function startOfMonth(d) {
  const date = new Date(d.getFullYear(), d.getMonth(), 1);
  date.setHours(0, 0, 0, 0);
  return date;
}

function buildLeaderboard(sinceDate, limit = 10) {
  const orders = getAllOrders().filter(o => o.status !== 'cancelled' && new Date(o.createdAt) >= sinceDate);
  const byUser = new Map();
  for (const o of orders) {
    const cur = byUser.get(o.userId) || { userId: o.userId, username: o.username, total: 0, orderCount: 0 };
    cur.total += o.total;
    cur.orderCount += 1;
    byUser.set(o.userId, cur);
  }
  return Array.from(byUser.values())
    .sort((a, b) => b.total - a.total)
    .slice(0, limit)
    .map((row, i) => ({ rank: i + 1, ...row }));
}

export function getWeeklyLeaderboard(limit = 10) {
  return buildLeaderboard(startOfWeek(new Date()), limit);
}

export function getMonthlyLeaderboard(limit = 10) {
  return buildLeaderboard(startOfMonth(new Date()), limit);
}
