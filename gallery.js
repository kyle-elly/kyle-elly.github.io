(function() {
  var FILES = [];
  var LIGHTBOX_INDEX = 0;
  var LIGHTBOX_SCROLL_Y = 0;

  var manifestUrl = window.MANIFEST_URL || 'manifest.json';

  fetch(manifestUrl + '?t=' + Date.now())
    .then(function(r) { return r.json(); })
    .then(function(files) {
      FILES = files;
      var g = document.getElementById('g');
      if (!files.length) {
        g.innerHTML = '<p class="empty">Photos coming soon 💚</p>';
        return;
      }
      g.innerHTML = files.map(function(f, i) {
        return '<div class="gallery-item" data-index="' + i + '">' +
                 '<img loading="lazy" src="thumbs/' + f.name + '" alt="">' +
               '</div>';
      }).join('');
      var items = g.querySelectorAll('.gallery-item');
      items.forEach(function(item) {
        item.addEventListener('click', function() {
          openLightbox(parseInt(item.getAttribute('data-index'), 10));
        });
      });
    })
    .catch(function() {
      document.getElementById('g').innerHTML =
        '<p class="empty">Gallery is warming up — check back soon 💚</p>';
    });

  function openLightbox(index) {
    LIGHTBOX_INDEX = index;
    showLightbox();
  }

  function showLightbox() {
    var f = FILES[LIGHTBOX_INDEX];
    var lbImg = document.getElementById('lightboxImg');
    var cap = document.getElementById('lightboxCaption');

    document.getElementById('lightboxSave').href =
      'https://drive.google.com/uc?export=download&id=' + f.id;
    document.getElementById('lightboxSave').setAttribute('download', f.name);

    cap.textContent = f.caption ? '📷 ' + f.caption : '';

    lbImg.style.display = '';
    lbImg.onerror = function() {
      lbImg.style.display = 'none';
      cap.textContent = '⚠️ This photo couldn\u2019t load — swipe to continue';
    };
    lbImg.src = 'thumbs/' + f.name;

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

  window.navLightbox = function(delta, event) {
    if (event) event.stopPropagation();
    LIGHTBOX_INDEX =
      (LIGHTBOX_INDEX + delta + FILES.length) % FILES.length;
    showLightbox();
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
