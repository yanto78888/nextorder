import session from 'express-session';
import { readDB, writeDB } from './db.js';

const TABLE = 'sessions';

// Session store custom yang nyimpen data sesi login ke data/sessions.json (pola yang sama kayak
// tabel JSON lain di app ini -- lihat lib/db.js), BUKAN pakai MemoryStore bawaan express-session.
//
// Kenapa ini penting: express-session, kalau opsi `store` gak diisi, otomatis pakai MemoryStore
// yang nyimpen SEMUA sesi login cuma di RAM proses Node yang lagi jalan. Begitu proses itu mati
// (restart server, deploy ulang, `pm2 reload`, crash, dst), seluruh isi RAM-nya ilang -- jadi
// SEMUA user yang lagi login otomatis ke-logout, walau cookie session di browser mereka masih ada
// & belum expired. Itu penyebab bug "tiap restart server malah logout".
//
// Desain di sini: seluruh sesi dimuat SEKALI ke memori pas server nyala (constructor), jadi baca
// sesi tiap request tetap secepat MemoryStore (gak perlu buka file tiap request). Tiap ada
// perubahan (login/logout/ganti data sesi) baru ditulis ke disk lewat writeDB() -- jadi kalaupun
// prosesnya restart, sesi yang belum expired otomatis kebaca lagi & user tetap login.
export class FileSessionStore extends session.Store {
  constructor(options = {}) {
    super(options);
    this.sessions = readDB(TABLE, {});
    this._removeExpired();

    // Beres-beres berkala biar data/sessions.json gak numpuk isi sesi basi yang udah lewat masa
    // aktifnya tapi gak pernah "disentuh" lagi (mis. user nutup browser tanpa klik logout).
    const ttlCheckInterval = options.ttlCheckInterval || 1000 * 60 * 60; // 1 jam
    this._timer = setInterval(() => this._removeExpired(), ttlCheckInterval);
  }

  _persist() {
    writeDB(TABLE, this.sessions);
  }

  _isExpired(sess) {
    const expires = sess && sess.cookie && sess.cookie.expires;
    if (!expires) return false; // sesi tanpa expiry eksplisit (cookie non-persistent) dianggap gak expired sendiri di sisi store
    const exp = new Date(expires).getTime();
    return !Number.isNaN(exp) && exp <= Date.now();
  }

  _removeExpired() {
    let changed = false;
    for (const sid of Object.keys(this.sessions)) {
      if (this._isExpired(this.sessions[sid])) {
        delete this.sessions[sid];
        changed = true;
      }
    }
    if (changed) this._persist();
  }

  get(sid, cb) {
    const sess = this.sessions[sid];
    if (!sess) return cb(null, null);
    if (this._isExpired(sess)) {
      delete this.sessions[sid];
      this._persist();
      return cb(null, null);
    }
    // Balikin salinan (bukan referensi objek yang sama persis kayak yang disimpan di this.sessions)
    // -- express-session lazim mengubah objek yang di-passing-in kembali lewat req.session, jadi
    // kalau ini objek yang sama ke-mutate duluan sebelum sempat di-save() lewat set(), data lama di
    // store bisa keubah diam-diam tanpa lewat writeDB (gak konsisten sama file di disk).
    cb(null, JSON.parse(JSON.stringify(sess)));
  }

  set(sid, sess, cb) {
    this.sessions[sid] = sess;
    this._persist();
    if (cb) cb(null);
  }

  destroy(sid, cb) {
    delete this.sessions[sid];
    this._persist();
    if (cb) cb(null);
  }

  touch(sid, sess, cb) {
    // Dipanggil express-session buat "perpanjang" cookie.expires sesi yang aktif tanpa ganti isi
    // datanya -- diperlakukan sama kayak set() aja, karena penyimpanan berbasis file di sini gak
    // dapat manfaat tambahan dari dibedain (tetap sama-sama nulis JSON per panggilan).
    this.set(sid, sess, cb);
  }

  all(cb) {
    cb(null, Object.values(this.sessions));
  }

  length(cb) {
    cb(null, Object.keys(this.sessions).length);
  }

  clear(cb) {
    this.sessions = {};
    this._persist();
    if (cb) cb(null);
  }
}

export default FileSessionStore;
