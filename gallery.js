(function() {
  var FILES = [];
  var LIGHTBOX_INDEX = 0;
  var LIGHTBOX_SCROLL_Y = 0;

  var manifestUrl = window.MANIFEST_URL || 'manifest.json';
  var thumbDir = window.THUMB_DIR || 'thumbnails';

  // Show "Loading photos…" only if the fetch takes longer than 300ms.
  // Prevents a flash on fast connections.
  var loadingTimer = setTimeout(function() {
    var g = document.getElementById('g');
    if (!g.hasChildNodes()) {
      g.innerHTML = '<p class="empty">Loading photos…</p>';
    }
  }, 300);

  fetch(manifestUrl + '?t=' + Date.now())
    .then(function(r) { return r.json(); })
    .then(function(files) {
      clearTimeout(loadingTimer);
      FILES = files;
      var g = document.getElementById('g');
      if (!files.length) {
        g.innerHTML = '<p class="empty">Photos coming soon 💚</p>';
        return;
      }

      g.innerHTML = '';

      // --- Infinite scroll config ---
      var BATCH_SIZE = 60;      // photos per batch
      var renderedCount = 0;

      function () {
        var html = next.map(function(f, i) {
          var globalIdx = renderedCount + i;
          return '<div class="gallery-item" data-index="' + globalIdx + '">' +
                   '<img loading="lazy" ' +
                        'width="' + f.w + '" height="' + f.h + '" ' +
                        'src="' + thumbDir + '/' + f.id + '.jpg" alt="">' +
                 '</div>';
        }).join('');

        // Append (don't replace) so previous batches stay
        var sentinel = document.getElementById('scroll-sentinel');
        if (sentinel) sentinel.remove();
        g.insertAdjacentHTML('beforeend', html);
        renderedCount += next.length;

        // Wire up click handlers on the newly added items only
        g.querySelectorAll('.gallery-item:not([data-wired])').forEach(function(item) {
          item.setAttribute('data-wired', '1');
          item.addEventListener('click', function() {
            openLightbox(parseInt(item.getAttribute('data-index'), 10));
          });
        });

        // Add a fresh sentinel at the end if there are more to load
        if (renderedCount < FILES.length) {
          g.insertAdjacentHTML('beforeend',
            '<div id="scroll-sentinel" aria-hidden="true"></div>');
          observer.observe(document.getElementById('scroll-sentinel'));
        }
      }

      // IntersectionObserver watches the sentinel; when it enters
      // the viewport (or gets within 400px of it), load the next batch.
      var observer = new IntersectionObserver(function(entries) {
        entries.forEach(function(entry) {
          if (entry.isIntersecting) renderBatch();
        });
      }, { rootMargin: '400px' });

      renderBatch();
    })
    
    .catch(function() {
      clearTimeout(loadingTimer);
      document.getElementById('g').innerHTML =
        '<p class="empty">Gallery is warming up — check back soon 💚</p>';
    });

  function openLightbox(index) {
    LIGHTBOX_INDEX = index;
    showLightbox();
  }

  window.navLightbox = function(delta, event) {
    if (event) event.stopPropagation();
    LIGHTBOX_INDEX =
      (LIGHTBOX_INDEX + delta + FILES.length) % FILES.length;
    showLightbox(true);   // ← pass a flag when navigating
  };

  function showLightbox(fromNav) {
    var f = FILES[LIGHTBOX_INDEX];
    var lbImg = document.getElementById('lightboxImg');
    var cap = document.getElementById('lightboxCaption');
  
    document.getElementById('lightboxSave').href =
      'https://drive.usercontent.google.com/download?id=' + f.id + '&export=download&authuser=0';
    document.getElementById('lightboxSave').setAttribute('download', f.name);
  
    cap.textContent = f.caption ? '📷 ' + f.caption : '';
  
    lbImg.style.display = '';
    lbImg.onerror = function() {
      lbImg.style.display = 'none';
      cap.textContent = '⚠️ This photo couldn\u2019t load — swipe to continue';
    };
  
    // --- NEW: serve from Drive CDN instead of repo /large ---
    var base = 'https://lh3.googleusercontent.com/d/' + f.id;
  
    // Clear old srcset/src FIRST so the browser doesn't briefly show
    // the previous photo while the new one loads
    lbImg.removeAttribute('srcset');
    lbImg.removeAttribute('sizes');
    lbImg.src = '';
  
    lbImg.sizes  = '100vw';
    lbImg.srcset = base + '=w1200 1200w, ' + base + '=w2048 2048w';
    lbImg.src    = base + '=w1600';   // fallback for browsers ignoring srcset
  
    if (fromNav) {
      // Prefetch neighbors — match the sizes the browser will actually pick
      [1, -1].forEach(function(d) {
        var nb = FILES[(LIGHTBOX_INDEX + d + FILES.length) % FILES.length];
        var nbBase = 'https://lh3.googleusercontent.com/d/' + nb.id;
        // Prefetch the phone size (most common) — desktop will grab =w2048 on demand
        new Image().src = nbBase + '=w1200';
      });
    }
  
    LIGHTBOX_SCROLL_Y = window.scrollY;
    document.getElementById('lightbox').classList.add('visible');
    document.body.classList.add('lightbox-open');
    document.body.style.top = '-' + LIGHTBOX_SCROLL_Y + 'px';
  }

  window.closeLightbox = function(event) {
    if (event && event.target.tagName === 'IMG') return;
    if (event && event.target.closest && event.target.closest('.lightbox-controls')) return;
    if (event && event.target.closest && event.target.closest('.lightbox-nav')) return;

    document.getElementById('lightbox').classList.remove('visible');
    document.body.classList.remove('lightbox-open');
    document.body.style.top = '';
    window.scrollTo(0, LIGHTBOX_SCROLL_Y);
  };

  document.addEventListener('keydown', function(e) {
    var visible = document.getElementById('lightbox').classList.contains('visible');
    if (!visible) return;
    if (e.key === 'ArrowLeft')  window.navLightbox(-1);
    if (e.key === 'ArrowRight') window.navLightbox(1);
    if (e.key === 'Escape')     window.closeLightbox();
  });

  (function() {
    var box = document.getElementById('lightbox');
    if (!box) return;
    var startX = null;
    var startY = null;

    box.addEventListener('touchstart', function(e) {
      if (window.visualViewport && window.visualViewport.scale > 1.05) {
        startX = null; return;
      }
      if (e.touches.length !== 1) { startX = null; return; }
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    });

    box.addEventListener('touchmove', function(e) {
      if (e.touches.length > 1) startX = null;
    });

    box.addEventListener('touchend', function(e) {
      if (startX === null) return;
      if (window.visualViewport && window.visualViewport.scale > 1.05) {
        startX = null; startY = null; return;
      }
      var dx = e.changedTouches[0].clientX - startX;
      var dy = e.changedTouches[0].clientY - startY;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        window.navLightbox(dx < 0 ? 1 : -1);
      }
      startX = null;
      startY = null;
    });
  })();
})();
