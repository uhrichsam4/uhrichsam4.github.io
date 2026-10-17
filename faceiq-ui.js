/* FaceIQ panel: deterministic measurement-based score, no AI.
   Intercepts the read response (or recomputes it from saved scan rows for
   older scans) and injects a hero card + per-ratio measurements table into
   the score screen, above the existing overall score card. */
(function () {
  if (window.__faceiqUI) return;
  window.__faceiqUI = true;

  var STYLE = [
    '.fq-card{background:rgba(0,0,0,.035);border:1px solid rgba(0,0,0,.14);border-radius:16px;padding:16px 18px;margin:0 0 14px;color:inherit;font-family:inherit;box-sizing:border-box}',
    '.fq-head{display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap}',
    '.fq-badge{font-weight:700;letter-spacing:.14em;font-size:11px;text-transform:uppercase;border:1px solid rgba(0,0,0,.4);border-radius:999px;padding:3px 10px}',
    '.fq-sub{font-size:11px;opacity:.55}',
    '.fq-scoreline{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin:2px 0 6px}',
    '.fq-score{font-size:40px;font-weight:800;line-height:1}',
    '.fq-max{font-size:16px;opacity:.5}',
    '.fq-chips{display:flex;gap:8px;flex-wrap:wrap;margin-left:auto}',
    '.fq-chip{font-size:12px;border:1px solid rgba(0,0,0,.18);border-radius:999px;padding:4px 10px;opacity:.85}',
    '.fq-details{margin-top:8px;border-top:1px solid rgba(0,0,0,.1);padding-top:8px}',
    '.fq-details summary{cursor:pointer;font-size:12px;opacity:.7;user-select:none;list-style:none}',
    '.fq-details summary::-webkit-details-marker{display:none}',
    '.fq-details summary:before{content:"+" ;display:inline-block;width:14px;font-weight:700}',
    '.fq-details[open] summary:before{content:"–"}',
    '.fq-sec{font-size:11px;letter-spacing:.12em;text-transform:uppercase;opacity:.45;margin:12px 0 6px}',
    '.fq-row{display:grid;grid-template-columns:minmax(110px,1.3fr) 72px minmax(90px,1fr) 84px 34px;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid rgba(0,0,0,.06);font-size:12px;color:inherit}',
    '.fq-row:last-child{border-bottom:0}',
    '.fq-label{opacity:.85;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.fq-val{font-variant-numeric:tabular-nums;opacity:.95}',
    '.fq-ideal{font-size:11px;opacity:.5;font-variant-numeric:tabular-nums}',
    '.fq-bar{height:5px;border-radius:3px;background:rgba(0,0,0,.12);overflow:hidden}',
    '.fq-bar i{display:block;height:100%;border-radius:3px}',
    '.fq-num{text-align:right;font-variant-numeric:tabular-nums;opacity:.95}',
    '@media(max-width:640px){.fq-row{grid-template-columns:minmax(90px,1.2fr) 60px 34px}.fq-ideal,.fq-bar{display:none}.fq-score{font-size:36px}}'
  ].join('\n');

  var state = { read: null, readId: null, mountedId: null, tried: {} };

  function injectStyle() {
    if (document.getElementById('fq-style')) return;
    var s = document.createElement('style');
    s.id = 'fq-style';
    s.textContent = STYLE;
    document.head.appendChild(s);
  }

  function hue(score) {
    var s = Math.max(0, Math.min(10, score));
    return Math.round(s * 12);
  }

  function fmtNum(x) {
    if (x == null) return '—';
    var r = Math.round(x * 100) / 100;
    return String(r);
  }

  function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function rowHTML(r) {
    var score = typeof r.score === 'number' ? r.score : 0;
    var ideal = (r.idealMin != null && r.idealMax != null)
      ? 'ideal ' + fmtNum(r.idealMin) + '–' + fmtNum(r.idealMax) + (r.unit || '')
      : '';
    return '<div class="fq-row">' +
      '<span class="fq-label">' + esc(r.label) + '</span>' +
      '<span class="fq-val">' + esc(r.display != null ? r.display : fmtNum(r.value)) + (r.display && r.unit && String(r.display).indexOf(r.unit) === -1 ? esc(r.unit) : '') + '</span>' +
      '<span class="fq-ideal">' + esc(ideal) + '</span>' +
      '<span class="fq-bar"><i style="width:' + Math.round(score * 10) + '%;background:hsl(' + hue(score) + ',62%,55%)"></i></span>' +
      '<span class="fq-num">' + fmtNum(score) + '</span>' +
      '</div>';
  }

  function cardHTML(read) {
    var front = (read.rows || []).filter(function (r) { return r.profile === 'front'; });
    var side = (read.rows || []).filter(function (r) { return r.profile === 'side'; });
    var chips = '<span class="fq-chip">Front ' + fmtNum(read.front) + '</span>';
    if (read.side != null) chips += '<span class="fq-chip">Side ' + fmtNum(read.side) + '</span>';
    var body = '';
    if (front.length) body += '<div class="fq-sec">Front</div>' + front.map(rowHTML).join('');
    if (side.length) body += '<div class="fq-sec">Side</div>' + side.map(rowHTML).join('');
    return '<div class="fq-card">' +
      '<div class="fq-head"><span class="fq-badge">FaceIQ</span><span class="fq-sub">measurement-based score · deterministic, no AI</span></div>' +
      '<div class="fq-scoreline"><span class="fq-score" style="color:hsl(' + hue(read.overall) + ',60%,60%)">' + fmtNum(read.overall) + '</span><span class="fq-max">/10</span><div class="fq-chips">' + chips + '</div></div>' +
      '<details class="fq-details"><summary>Measurements (' + (read.rows || []).length + ')</summary>' + body + '</details>' +
      '</div>';
  }

  function currentScanId() {
    var m = location.pathname.match(/\/dashboard\/scan\/([^\/?#]+)/);
    return m ? m[1] : null;
  }

  function desiredParent() {
    var ro = document.querySelector('.score-reveal .ro') || document.querySelector('.ro.report-inter');
    if (ro && ro.parentElement && !(ro.parentElement instanceof HTMLBodyElement)) {
      return { parent: ro.parentElement, before: ro };
    }
    var sheet = document.querySelector('.print-sheet');
    if (sheet) return { parent: sheet, before: sheet.firstChild };
    return null;
  }

  function mount() {
    var id = currentScanId();
    if (!state.read || state.mounting) return;
    var spot = desiredParent();
    if (!spot) return;
    var existing = document.querySelector('.fq-card');
    if (existing && existing.nextElementSibling === spot.before && existing.parentNode === spot.parent) {
      state.mountedId = id + '|' + state.read.overall;
      return;
    }
    if (state.mountedId === id + '|' + state.read.overall && existing && existing.parentNode === spot.parent) return;
    injectStyle();
    state.mounting = true;
    try {
      if (existing) existing.parentNode.removeChild(existing);
      var wrap = document.createElement('div');
      wrap.innerHTML = cardHTML(state.read);
      spot.parent.insertBefore(wrap.firstChild, spot.before);
      state.mountedId = id + '|' + state.read.overall;
    } finally {
      state.mounting = false;
    }
  }

  function setRead(read, id) {
    state.read = read;
    state.readId = id || null;
    setTimeout(mount, 50);
    setTimeout(mount, 600);
  }

  function requestRead(rows, sex, key) {
    if (!rows || (!rows.front && !rows.side)) return;
    if (state.tried[key]) return;
    state.tried[key] = true;
    fetch('/api/ai-preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sex: sex === 'F' || sex === 'female' ? 'F' : 'M', ratios: { front: rows.front || [], side: rows.side || [] } })
    }).catch(function () {});
  }

  var origFetch = window.fetch;
  window.__fqOrigFetch = origFetch;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var method = (init && init.method) || (input && input.method) || 'GET';
    var p = origFetch.apply(this, arguments);
    try {
      if (/\/api\/ai-preview/.test(url)) {
        p.then(function (res) {
          res.clone().json().then(function (j) {
            if (j && j.ai && j.ai.faceiq) setRead(j.ai.faceiq, currentScanId());
          }).catch(function () {});
        }).catch(function () {});
      } else if (/\/api\/scans(\?|$)/.test(url) && String(method).toUpperCase() === 'GET') {
        p.then(function (res) {
          res.clone().json().then(function (j) {
            var list = j && (j.scans || (Array.isArray(j) ? j : null));
            if (!list) return;
            window.__fqScans = window.__fqScans || {};
            for (var i = 0; i < list.length; i++) {
              var s = list[i];
              if (!s || !s.id) continue;
              window.__fqScans[s.id] = s;
            }
            syncFromScans();
          }).catch(function () {});
        }).catch(function () {});
      }
    } catch (e) {}
    return p;
  };

  function syncFromScans() {
    var id = currentScanId();
    if (!id || !window.__fqScans || !window.__fqScans[id]) return;
    var scan = window.__fqScans[id];
    var ai = scan.scores && scan.scores.ai;
    if (ai && ai.faceiq) {
      setRead(ai.faceiq, id);
      return;
    }
    if (window.__fqSeenRows === id) return;
    window.__fqSeenRows = id;
    var rows = scan.scores && { front: scan.scores.front, side: scan.scores.side };
    requestRead(rows, scan.sex, id);
  }

  setInterval(function () {
    mount();
    syncFromScans();
  }, 700);
  document.addEventListener('DOMContentLoaded', injectStyle);
})();
