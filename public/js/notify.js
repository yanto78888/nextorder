/* =====================================================================
   notify.js — pengganti alert()/confirm() bawaan browser (kotak dialog
   sistem yang gak bisa di-custom & keliatan murahan) dengan toast &
   modal konfirmasi custom yang ngikutin tema situs (dark/light).

   Dipakai di semua halaman lewat partials/head.ejs, jadi 2 fungsi ini
   selalu tersedia global tanpa perlu didefinisikan ulang per file:

     showToast(pesan, { type, title, duration })
       -> notifikasi melayang di pojok bawah, auto-hilang sendiri.
          type: 'error' (default) | 'success' | 'info'

     showConfirm(pesan, { title, confirmText, cancelText, danger })
       -> Promise<boolean>, modal konfirmasi custom di tengah layar.
          Dipakai lewat .then()/await, bukan return langsung kayak
          window.confirm() bawaan (karena modal custom sifatnya async).

   Form yang sebelumnya pakai onsubmit="return confirm('...')" cukup
   diganti jadi class="js-confirm-submit" + data-confirm-msg="...",
   listener submit di bawah otomatis nanganin sisanya (gak perlu JS
   manual per form).
   ===================================================================== */
(function (global) {
  'use strict';

  function ensureToastStack() {
    var stack = document.getElementById('toastStack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'toastStack';
      stack.className = 'toast-stack';
      document.body.appendChild(stack);
    }
    return stack;
  }

  function showToast(msg, opts) {
    opts = opts || {};
    var type = opts.type || 'error';
    var title = opts.title || (type === 'error' ? 'Belum lengkap' : type === 'success' ? 'Berhasil' : 'Info');
    var duration = opts.duration || 3800;
    var icon = type === 'error' ? 'fa-triangle-exclamation' : type === 'success' ? 'fa-circle-check' : 'fa-circle-info';

    var stack = ensureToastStack();
    var card = document.createElement('div');
    card.className = 'toast-card ' + type;
    card.innerHTML =
      '<div class="toast-icon"><i class="fa-solid ' + icon + '"></i></div>' +
      '<div class="toast-body"><div class="toast-title"></div><div class="toast-msg"></div></div>' +
      '<button type="button" class="toast-close" aria-label="Tutup"><i class="fa-solid fa-xmark"></i></button>' +
      '<div class="toast-progress"></div>';
    // textContent (bukan innerHTML) buat title/msg -- aman walau pesannya dari data dinamis.
    card.querySelector('.toast-title').textContent = title;
    card.querySelector('.toast-msg').textContent = msg;
    card.querySelector('.toast-progress').style.animationDuration = duration + 'ms';
    stack.appendChild(card);

    var timer = setTimeout(remove, duration);
    card.querySelector('.toast-close').addEventListener('click', function () { clearTimeout(timer); remove(); });

    function remove() {
      card.classList.add('toast-out');
      card.addEventListener('animationend', function () { card.remove(); }, { once: true });
    }
  }

  // Antrian sederhana: kalau ada beberapa showConfirm() dipanggil beruntun, tampilkan satu-satu
  // (gak numpuk dua overlay modal bersamaan di layar).
  var confirmQueue = Promise.resolve();
  function showConfirm(msg, opts) {
    opts = opts || {};
    var title = opts.title || 'Konfirmasi';
    var confirmText = opts.confirmText || 'Ya, Lanjutkan';
    var cancelText = opts.cancelText || 'Batal';
    var danger = !!opts.danger;

    confirmQueue = confirmQueue.then(function () {
      return new Promise(function (resolve) {
        var overlay = document.createElement('div');
        overlay.className = 'confirm-modal-overlay';
        overlay.innerHTML =
          '<div class="confirm-modal ' + (danger ? 'danger' : '') + '">' +
            '<div class="confirm-modal-icon"><i class="fa-solid ' + (danger ? 'fa-triangle-exclamation' : 'fa-circle-question') + '"></i></div>' +
            '<div class="confirm-modal-title"></div>' +
            '<div class="confirm-modal-msg"></div>' +
            '<div class="confirm-modal-actions">' +
              '<button type="button" class="btn ghost confirm-modal-cancel"></button>' +
              '<button type="button" class="btn ' + (danger ? 'danger' : 'solid') + ' confirm-modal-ok"></button>' +
            '</div>' +
          '</div>';
        overlay.querySelector('.confirm-modal-title').textContent = title;
        overlay.querySelector('.confirm-modal-msg').textContent = msg;
        overlay.querySelector('.confirm-modal-cancel').textContent = cancelText;
        overlay.querySelector('.confirm-modal-ok').textContent = confirmText;
        document.body.appendChild(overlay);
        document.body.style.overflow = 'hidden';
        requestAnimationFrame(function () { overlay.classList.add('show'); });

        var settled = false;
        function close(result) {
          if (settled) return;
          settled = true;
          overlay.classList.remove('show');
          document.body.style.overflow = '';
          setTimeout(function () { if (overlay.parentNode) overlay.remove(); }, 220);
          resolve(result);
        }
        overlay.querySelector('.confirm-modal-cancel').addEventListener('click', function () { close(false); });
        overlay.querySelector('.confirm-modal-ok').addEventListener('click', function () { close(true); });
        overlay.addEventListener('click', function (e) { if (e.target === overlay) close(false); });
        document.addEventListener('keydown', function escHandler(e) {
          if (e.key === 'Escape') { close(false); document.removeEventListener('keydown', escHandler); }
        });
      });
    });
    return confirmQueue;
  }

  // ---- Form dengan class="js-confirm-submit" otomatis kepasang modal konfirmasi ----
  // Ganti: onsubmit="return confirm('Pesan...')"
  // Jadi:  class="js-confirm-submit" data-confirm-msg="Pesan..." (opsional data-confirm-danger="true")
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form.classList || !form.classList.contains('js-confirm-submit')) return;
    if (form.dataset.confirmed === '1') { delete form.dataset.confirmed; return; }
    e.preventDefault();
    var msg = form.getAttribute('data-confirm-msg') || 'Yakin mau lanjutkan?';
    var title = form.getAttribute('data-confirm-title') || 'Konfirmasi';
    var danger = form.getAttribute('data-confirm-danger') === 'true';
    showConfirm(msg, { title: title, danger: danger }).then(function (ok) {
      if (!ok) return;
      form.dataset.confirmed = '1';
      if (form.requestSubmit) form.requestSubmit(); else form.submit();
    });
  });

  global.showToast = showToast;
  global.showConfirm = showConfirm;
})(window);
