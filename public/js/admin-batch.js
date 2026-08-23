/* =====================================================================
   admin-batch.js -- runner buat proses BANYAK item (produk) secara BERTAHAP
   (per-batch kecil + jeda), bukan dikirim semua sekaligus dalam 1 request.

   Kenapa: kalau jumlah produknya ratusan/ribuan dan dikirim dalam 1x fetch/
   form-submit raksasa, ukuran body request bisa nabrak limit Express ->
   error "Payload Too Large" (413). Dengan dipecah jadi batch-batch kecil +
   jeda (delay) di antaranya, tiap request selalu kecil, dan progress bar-nya
   kasih tahu proses masih jalan (bukan cuma freeze diam nungguin 1 request
   gede yang gak jelas nasibnya).

   Dipakai di halaman Kelola Produk & Digiflazz (admin) buat: Hapus Terpilih,
   Import Produk, Sinkron Harga, Hapus Produk Digiflazz. Include file ini
   SEBELUM script yang manggil runBatchJob().
   ===================================================================== */
(function (global) {
  'use strict';

  function ensureModal() {
    var overlay = document.getElementById('batchProgressOverlay');
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'batchProgressOverlay';
    overlay.className = 'progress-modal-overlay';
    overlay.innerHTML =
      '<div class="progress-modal">' +
        '<div class="progress-modal-title" id="batchProgressTitle">Memproses...</div>' +
        '<div class="progress-bar-track"><div class="progress-bar-fill" id="batchProgressFill"></div></div>' +
        '<div class="progress-modal-detail" id="batchProgressDetail">0%</div>' +
      '</div>';
    document.body.appendChild(overlay);
    return overlay;
  }

  function chunkArray(arr, size) {
    var out = [];
    for (var i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /**
   * opts:
   *   title      - judul yang tampil di modal, mis. "Menghapus produk terpilih..."
   *   items      - array item mentah yang mau diproses (ID, atau objek produk, dll)
   *   chunkSize  - berapa item per batch/request (default 50)
   *   delayMs    - jeda antar batch, ms (default 200) -- ini yang bikin ada "delay"-nya
   *   sendChunk  - function(chunkItems) -> Promise(response), 1 request per batch
   *   onComplete - function(arrayOfResponses) dipanggil pas semua batch selesai
   */
  function runBatchJob(opts) {
    var items = opts.items || [];
    var chunkSize = opts.chunkSize || 50;
    var delayMs = opts.delayMs != null ? opts.delayMs : 200;
    var chunks = chunkArray(items, chunkSize);
    var total = items.length;
    var done = 0;
    var results = [];

    var overlay = ensureModal();
    var titleEl = document.getElementById('batchProgressTitle');
    var fillEl = document.getElementById('batchProgressFill');
    var detailEl = document.getElementById('batchProgressDetail');
    titleEl.textContent = opts.title || 'Memproses...';
    fillEl.style.width = '0%';
    detailEl.textContent = '0% (0/' + total + ')';
    overlay.classList.add('show');
    document.body.style.overflow = 'hidden';

    function step(i) {
      if (i >= chunks.length) {
        overlay.classList.remove('show');
        document.body.style.overflow = '';
        if (opts.onComplete) opts.onComplete(results);
        return;
      }
      return Promise.resolve(opts.sendChunk(chunks[i]))
        .catch(function (err) { return { ok: false, error: err && err.message }; })
        .then(function (res) {
          results.push(res);
          done += chunks[i].length;
          var pct = total > 0 ? Math.round((done / total) * 100) : 100;
          fillEl.style.width = pct + '%';
          detailEl.textContent = pct + '% (' + Math.min(done, total) + '/' + total + ')';
          var isLast = (i === chunks.length - 1);
          return (isLast || delayMs <= 0) ? step(i + 1) : sleep(delayMs).then(function () { return step(i + 1); });
        });
    }

    if (chunks.length === 0) {
      overlay.classList.remove('show');
      document.body.style.overflow = '';
      if (opts.onComplete) opts.onComplete([]);
      return;
    }
    step(0);
  }

  global.runBatchJob = runBatchJob;
})(window);
