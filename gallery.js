(function() {
  var FILES = [];
  var LIGHTBOX_INDEX = 0;
  var LIGHTBOX_SCROLL_Y = 0;
  var LIGHTBOX_HISTORY = false;

  var manifestUrl = window.MANIFEST_URL || 'manifest.json';
  var thumbDir = window.THUMB_DIR || 'thumbnails';

  // Phones get w1200; desktop/tablet gets w2048. One size per device,
  // so prefetch always matches what the browser actually requests.
  var IMG_SIZE = (window.innerWidth > 900) ? '=w2048' : '=w1200';

  // --- Justified layout config ---
  // Row-based layout (like Flickr / 500px): every photo keeps its real
  // aspect ratio, and each row's HEIGHT is adjusted so the row fills the
  // container edge-to-edge. This preserves strict left-to-right order
  // (unlike CSS masonry, which fills top-to-bottom) and uses the full
  // width of any monitor, including 4K, with no per-size breakpoints.
  var GAP = 12;                        // must match the visual gap you want
  var POSITIONS = [];                  // {left,top,width,height} per FILES index
  var LAYOUT_WIDTH = 0;                // container width the layout was built for

  function targetRowHeight() {
    var w = window.innerWidth;
    if (w <= 1024) return 300;   // hand held
    return 450;                  // desktop 1080p+: ~6 across
  }

  function aspectOf(f) {
    return (f.w && f.h) ? (f.w / f.h) : 1;   // fallback square if missing
  }

  // Compute justified geometry for EVERY file up front. This is pure math
  // (fast even for 600+ photos); we still only create <img> tiles for the
  // batches that scroll into view, so nothing heavy loads at once.
  function computeLayout(containerWidth) {
    var target = targetRowHeight();
    var positions = new Array(FILES.length);
    var i = 0, top = 0;

    while (i < FILES.length) {
      // Grow a row until it would overflow at the target height.
      var rowStart = i, count = 0, aspectSum = 0;
      while (i < FILES.length) {
        aspectSum += aspectOf(FILES[i]);
        count++;
        i++;
        var rowW = aspectSum * target + (count - 1) * GAP;
        if (rowW >= containerWidth) break;
      }

      var isLast = (i >= FILES.length);
      var available = containerWidth - (count - 1) * GAP;
      // Fitted height makes the row exactly fill the width. Don't stretch a
      // short final row past the target, or one photo would blow up huge.
      var rowH = available / aspectSum;
      if (isLast) rowH = Math.min(rowH, target);

      var left = 0;
      for (var j = rowStart; j < i; j++) {
        var w = aspectOf(FILES[j]) * rowH;
        positions[j] = {
          left:   Math.round(left),
          top:    Math.round(top),
          width:  Math.round(w),
          height: Math.round(rowH)
        };
        left += w + GAP;
      }
      top += rowH + GAP;
    }

    POSITIONS = positions;
    LAYOUT_WIDTH = containerWidth;
    return Math.max(0, Math.round(top - GAP));   // total content height
  }

  // One-time injected styles so gallery.js is self-contained and does not
  // need any change to shared.css. Switches .gallery out of grid mode into
  // an absolutely-positioned justified container.
  function injectStyles() {
    if (document.getElementById('justified-style')) return;
    var s = document.createElement('style');
    s.id = 'justified-style';
    s.textContent =
      '.gallery.justified{display:block;position:relative;margin:0 auto;' +
      'max-width:2600px;}' +
      '.gallery.justified .gallery-item{position:absolute;margin:0;' +
      'overflow:hidden;border-radius:10px;}' +
      '.gallery.justified .gallery-item img{width:100%;height:100%;' +
      'object-fit:cover;display:block;}';
    document.head.appendChild(s);
  }

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
        g.innerHTML = '<p class="empty">Photos coming soon \uD83D\uDC9A</p>';
        return;
      }

      injectStyles();
      g.classList.add('justified');
      g.innerHTML = '';

      // --- Infinite scroll config ---
      var BATCH_SIZE = 60;      // photos per batch
      var renderedCount = 0;
      var observer;

      function positionTile(el, idx) {
        var p = POSITIONS[idx];
        el.style.left   = p.left + 'px';
        el.style.top    = p.top + 'px';
        el.style.width  = p.width + 'px';
        el.style.height = p.height + 'px';
      }

      function placeSentinel() {
        var old = document.getElementById('scroll-sentinel');
        if (old) old.remove();
        if (renderedCount >= FILES.length) return;
        var s = document.createElement('div');
        s.id = 'scroll-sentinel';
        s.setAttribute('aria-hidden', 'true');
        s.style.position = 'absolute';
        s.style.left = '0';
        s.style.width = '1px';
        s.style.height = '1px';
        // Sit at the y where the next unrendered batch begins.
        s.style.top = POSITIONS[renderedCount].top + 'px';
        g.appendChild(s);
        observer.observe(s);
      }

      function renderBatch() {
        var end = Math.min(renderedCount + BATCH_SIZE, FILES.length);
        for (var idx = renderedCount; idx < end; idx++) {
          var f = FILES[idx];
          var item = document.createElement('div');
          item.className = 'gallery-item';
          item.setAttribute('data-index', idx);
          positionTile(item, idx);

          var img = document.createElement('img');
          img.loading = 'lazy';
          img.width = f.w;
          img.height = f.h;
          img.src = thumbDir + '/' + f.id + '.jpg';
          img.alt = '';
          item.appendChild(img);

          (function(i) {
            item.addEventListener('click', function() { openLightbox(i); });
          })(idx);

          g.appendChild(item);
        }
        renderedCount = end;
        placeSentinel();
      }

      // Recompute geometry on resize and reposition everything already drawn.
      var resizeTimer = null;
      function relayout() {
        var width = g.clientWidth;
        if (!width) return;
        var totalH = computeLayout(width);
        g.style.height = totalH + 'px';
        IMG_SIZE = (window.innerWidth > 900) ? '=w2048' : '=w1200';

        g.querySelectorAll('.gallery-item').forEach(function(el) {
          positionTile(el, parseInt(el.getAttribute('data-index'), 10));
        });
        placeSentinel();
      }
      window.addEventListener('resize', function() {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(relayout, 150);
      });

      // IntersectionObserver watches the sentinel; when it enters the
      // viewport (or gets within 400px of it), load the next batch.
      observer = new IntersectionObserver(function(entries) {
        entries.forEach(function(entry) {
          if (entry.isIntersecting) renderBatch();
        });
      }, { rootMargin: '400px' });

      // Initial layout + first batch.
      var totalH = computeLayout(g.clientWidth);
      g.style.height = totalH + 'px';
      renderBatch();
    })

    .catch(function() {
      clearTimeout(loadingTimer);
      document.getElementById('g').innerHTML =
        '<p class="empty">Gallery is warming up — check back soon \uD83D\uDC9A</p>';
    });

  function openLightbox(index) {
    LIGHTBOX_INDEX = index;
    showLightbox({ prefetch: true, dir: 1 });

    // Only ever push ONE entry, so history.back() can never overshoot to home.
    if (!LIGHTBOX_HISTORY) {
      history.pushState({ lightbox: true }, '');
      LIGHTBOX_HISTORY = true;
    }
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

    // If we added a history entry, step back so the X and the Back button
    // behave identically. popstate -> hideLightbox does the real closing.
    if (LIGHTBOX_HISTORY) {
      LIGHTBOX_HISTORY = false;
      history.back();
    } else {
      hideLightbox();   // fallback: nothing was pushed, just close locally
    }
  };

  // UI only: actually closes the lightbox and restores scroll.
  function hideLightbox() {
    document.getElementById('lightbox').classList.remove('visible');
    document.body.classList.remove('lightbox-open');
    document.body.style.top = '';
    window.scrollTo(0, LIGHTBOX_SCROLL_Y);
  }

  document.addEventListener('keydown', function(e) {
    var visible = document.getElementById('lightbox').classList.contains('visible');
    if (!visible) return;
    if (e.key === 'ArrowLeft')  window.navLightbox(-1);
    if (e.key === 'ArrowRight') window.navLightbox(1);
    if (e.key === 'Escape')     window.closeLightbox();
  });

  window.addEventListener('popstate', function() {
    LIGHTBOX_HISTORY = false;
    if (document.getElementById('lightbox').classList.contains('visible')) {
      hideLightbox();
    }
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
