(function() {
  var FILES = [];
  var LIGHTBOX_INDEX = 0;
  var LIGHTBOX_SCROLL_Y = 0;

  var manifestUrl = window.MANIFEST_URL || 'manifest.json';
  var thumbDir = window.THUMB_DIR || 'thumbnails';

  // Phones get w1200; desktop/tablet gets w2048. One size per device,
  // so prefetch always matches what the browser actually requests.
  var IMG_SIZE = (window.innerWidth > 900) ? '=w2048' : '=w1200';

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

      function renderBatch() {
        var next = FILES.slice(renderedCount, renderedCount + BATCH_SIZE);
        if (!next.length) return;
        
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
    showLightbox({ prefetch: true, dir: 1 });
  }

  window.navLightbox = function(delta, event) {
    if (event) event.stopPropagation();
    LIGHTBOX_INDEX =
      (LIGHTBOX_INDEX + delta + FILES.length) % FILES.length;
    showLightbox({ isNav: true, prefetch: true, dir: delta });
  };

  // opts.isNav    — true when arriving via arrow/swipe (skip scroll capture)
  // opts.prefetch — true to warm the next photo in the direction of travel
  // opts.dir      — +1 forward, -1 backward (which neighbor to prefetch)
  function showLightbox(opts) {
    opts = opts || {};
    var isNav    = !!opts.isNav;
    var prefetch = !!opts.prefetch;
    var dir      = opts.dir || 1;

    var f = FILES[LIGHTBOX_INDEX];
    var lbImg = document.getElementById('lightboxImg');
    var cap = document.getElementById('lightboxCaption');

    document.getElementById('lightboxSave').href =
      'https://drive.usercontent.google.com/download?id=' + f.id + '&export=download&authuser=0';
    document.getElementById('lightboxSave').setAttribute('download', f.name);

    cap.textContent = f.caption ? '\uD83D\uDCF7 ' + f.caption : '';

    var base = 'https://lh3.googleusercontent.com/d/' + f.id;

    // Detach the handler BEFORE clearing, so wiping the old photo
    // can't fire onerror and flash the failure message.
    lbImg.onerror = null;
    lbImg.removeAttribute('srcset');
    lbImg.removeAttribute('sizes');
    lbImg.removeAttribute('src');

    lbImg.style.display = '';
    lbImg.onerror = function() {
      lbImg.style.display = 'none';
      cap.textContent = '\u26A0\uFE0F This photo couldn\u2019t load \u2014 swipe to continue';
    };

    if (prefetch && FILES.length > 1) {
      var nbIdx = (LIGHTBOX_INDEX + dir + FILES.length) % FILES.length;
      if (nbIdx !== LIGHTBOX_INDEX) {
        lbImg.onload = function() {
          lbImg.onload = null;
          var pre = new Image();
          pre.referrerPolicy = 'no-referrer';
          pre.src = 'https://lh3.googleusercontent.com/d/' + FILES[nbIdx].id + IMG_SIZE;
        };
      }
    } else {
      lbImg.onload = null;
    }

    lbImg.src = base + IMG_SIZE;

    if (prefetch && FILES.length > 1) {
      var nbIdx = (LIGHTBOX_INDEX + dir + FILES.length) % FILES.length;
      if (nbIdx !== LIGHTBOX_INDEX) {
        var pre = new Image();
        pre.referrerPolicy = 'no-referrer';
        pre.src = 'https://lh3.googleusercontent.com/d/' + FILES[nbIdx].id + IMG_SIZE;
      }
    }

    if (!isNav) {
      LIGHTBOX_SCROLL_Y = window.scrollY;
      document.body.style.top = '-' + LIGHTBOX_SCROLL_Y + 'px';
    }

    document.getElementById('lightbox').classList.add('visible');
    document.body.classList.add('lightbox-open');
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
