/* SAM I AM LABS — static edition API layer.
 * Replaces server.js on static hosts. Mocks the local API surface in the
 * browser and proxies read-only public data (/api/people, celebrity photos)
 * to the origin, which serves it with access-control-allow-origin: *.
 */
(function () {
  'use strict';

  var ORIGIN = 'https://hardmax.net';
  // Analytics beacons have nowhere to go in a fully static build.
  try {
    if (navigator.sendBeacon) navigator.sendBeacon = function () { return true; };
  } catch (e) {}

  var SCANS_KEY = 'sia.scans.v1';
  var PHOTO_PREFIX = 'sia.photo.';
  var MAX_PHOTO_CHARS = 600000;

  var LOCAL_USER = {
    id: 'local-sam',
    email: 'sam@samiamlabs.local',
    name: 'Sam',
    plan: 'pro',
    isOwner: true,
    isMod: true,
    unlimited: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  function allowance() {
    return {
      allowed: true,
      cap: 999999,
      used: 0,
      remaining: 999999,
      unlimited: true,
      plan: 'pro',
      window: 'month',
      resetAt: new Date(Date.now() + 30 * 86400000).toISOString(),
      readAvailable: true,
      readLeft: 999999,
    };
  }

  function json(body, status) {
    return new Response(JSON.stringify(body), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  function readScans() {
    try {
      var v = JSON.parse(localStorage.getItem(SCANS_KEY) || '[]');
      return Array.isArray(v) ? v : [];
    } catch (e) {
      return [];
    }
  }

  function writeScans(scans) {
    try {
      localStorage.setItem(SCANS_KEY, JSON.stringify(scans));
    } catch (e) {}
  }

  function getPhoto(id, side) {
    try {
      return localStorage.getItem(PHOTO_PREFIX + id + '.' + side);
    } catch (e) {
      return null;
    }
  }

  function shrink(dataUrl) {
    return new Promise(function (resolve) {
      try {
        var img = new Image();
        img.onload = function () {
          try {
            var max = 768;
            var w = img.naturalWidth;
            var h = img.naturalHeight;
            var scale = Math.min(1, max / Math.max(w, h));
            var c = document.createElement('canvas');
            c.width = Math.round(w * scale);
            c.height = Math.round(h * scale);
            c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
            resolve(c.toDataURL('image/jpeg', 0.82));
          } catch (e) {
            resolve(dataUrl);
          }
        };
        img.onerror = function () {
          resolve(dataUrl);
        };
        img.src = dataUrl;
      } catch (e) {
        resolve(dataUrl);
      }
    });
  }

  async function savePhoto(id, side, dataUrl) {
    if (typeof dataUrl !== 'string' || dataUrl.indexOf('data:image/') !== 0) return false;
    var value = dataUrl;
    if (value.length > MAX_PHOTO_CHARS) value = await shrink(value);
    var key = PHOTO_PREFIX + id + '.' + side;
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (e) {
      try {
        localStorage.removeItem(key);
        localStorage.setItem(key, await shrink(value));
        return true;
      } catch (e2) {
        return false;
      }
    }
  }

  function newId() {
    return 'local-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // The read is fully deterministic: measured ratios are scored against the
  // FaceIQ-style measurement chart (faceiq-rubric.json). No AI is involved.
  var FACEIQ = null;
  var FACEIQ_P = null;
  function loadRubric() {
    if (!FACEIQ_P) {
      FACEIQ_P = fetch('/faceiq-rubric.json').then(function (r) { return r.ok ? r.json() : null; }).then(function (j) { FACEIQ = j; return j; }).catch(function () { return null; });
    }
    return FACEIQ_P;
  }
  function chartScore(chart, v) {
    if (!chart || !chart.length) return null;
    if (v <= chart[0][0]) return chart[0][1];
    var last = chart[chart.length - 1];
    if (v >= last[0]) return last[1];
    var lo = 0, hi = chart.length - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (chart[mid][0] <= v) lo = mid; else hi = mid;
    }
    var a = chart[lo], b = chart[hi];
    var t = (b[0] - a[0]) ? (v - a[0]) / (b[0] - a[0]) : 0;
    return a[1] + (b[1] - a[1]) * t;
  }
  function faceiqSide(rows, side, sex) {
    if (!FACEIQ || Object.prototype.toString.call(rows) !== '[object Array]') return null;
    var keys = FACEIQ[side === 'front' ? 'frontKeys' : 'sideKeys'] || [];
    if (!keys.length) return null;
    var present = 0, sum = 0, detail = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row || !row.key) continue;
      var slug = FACEIQ.keymap[row.key];
      if (!slug) continue;
      var v = row.bar && typeof row.bar.value === 'number' ? row.bar.value : (typeof row.value === 'number' ? row.value : null);
      if (v == null) continue;
      var chart = FACEIQ.charts[slug + '|' + sex + '|' + side];
      if (!chart) continue;
      // convention offsets aligning our landmark model with FaceIQ's
      var tv = v + ((FACEIQ.transforms && FACEIQ.transforms[row.key]) || 0);
      var s = chartScore(chart, tv);
      if (s == null) continue;
      sum += s; present += 1;
      var ideal = FACEIQ.ideals && FACEIQ.ideals[slug + '|' + sex];
      detail.push({
        key: row.key,
        label: row.label || row.key,
        slug: slug,
        profile: side,
        value: Math.round(v * 100) / 100,
        display: row.display || String(Math.round(v * 100) / 100),
        score: Math.round(s * 10) / 10,
        idealMin: ideal ? ideal[0] : null,
        idealMax: ideal ? ideal[1] : null,
        unit: (FACEIQ.units && FACEIQ.units[slug]) || ''
      });
    }
    if (present < 4) return null;
    // ratios we don't measure count as neutral 5.0, matching how the charts were fitted
    var mean = (sum + 5 * (keys.length - present)) / keys.length;
    var cal = FACEIQ.calib[side];
    return { score: Math.max(0, Math.min(10, cal.slope * mean + cal.b)), rows: detail };
  }
  function faceiqRead(ratios, sex) {
    if (!FACEIQ || !ratios) return null;
    var fr = faceiqSide(ratios.front, 'front', sex);
    var sr = faceiqSide(ratios.side, 'side', sex);
    if (!fr && !sr) return null;
    var overall;
    if (fr && sr) {
      var q = FACEIQ.overall.q, w = FACEIQ.overall.w;
      overall = Math.pow(w[0] * Math.pow(fr.score, q) + w[1] * Math.pow(sr.score, q), 1 / q);
    } else {
      overall = fr ? fr.score : sr.score;
    }
    overall = Math.max(0, Math.min(10, overall));
    var r2 = function (x) { return x == null ? null : Math.round(x * 100) / 100; };
    return {
      overall: overall,
      front: fr ? fr.score : null,
      side: sr ? sr.score : null,
      sex: sex,
      rows: (fr ? fr.rows : []).concat(sr ? sr.rows : []).map(function (r) { r.score = r2(r.score); return r; })
    };
  }

  async function handle(method, path, bodyText) {
    if (path === '/api/auth/me') return json({ user: LOCAL_USER });
    if (path === '/api/scan-allowance') return json(allowance());
    if (path === '/api/ev') return new Response(null, { status: 204 });
    if (path === '/api/closeup-credits') return json({ unlimited: true, remaining: 999, used: 0, cap: 999 });
    if (path === '/api/consult/orders') return json({ orders: [] });
    if (path === '/api/ai-preview') {
      var reqBody = null;
      try {
        reqBody = bodyText ? JSON.parse(bodyText) : null;
      } catch (e) {
        reqBody = null;
      }
      var sex = reqBody && reqBody.sex === 'F' ? 'F' : 'M';
      var read = null;
      if (reqBody && reqBody.ratios) {
        await loadRubric();
        read = faceiqRead(reqBody.ratios, sex);
      }
      if (read) {
        var r2 = function (x) { return x == null ? null : Math.round(x * 100) / 100; };
        return json({
          ai: {
            ok: true,
            rubric: FACEIQ.version || 'faceiq',
            facial_harmony: { score: r2(read.overall) },
            faceiq: {
              overall: r2(read.overall),
              front: r2(read.front),
              side: r2(read.side),
              sex: sex,
              rows: read.rows
            }
          }
        });
      }
      return json({ readSkipped: true });
    }
    if (path === '/api/affiliate/me') {
      return json({ error: 'Sign in first.' }, 401);
    }
    if (path === '/api/consult/status') {
      return json({ open: true, cryptoEnabled: true });
    }
    if (path === '/api/collections' && method === 'GET') {
      return fetch('/_api/collections.json').then(function (r) {
        return r.ok ? r : json({ collections: [] });
      });
    }
    if (path === '/api/people' && method === 'GET') {
      return fetch('/_api/people.json').then(function (r) {
        return r.ok ? r : json({ people: [] });
      });
    }
    var personMatch = path.match(/^\/api\/people\/([a-z0-9._-]+)$/i);
    if (personMatch && method === 'GET') {
      return fetch('/_api/people/' + personMatch[1] + '.json').then(function (r) {
        return r.ok ? r : json({ error: 'not found' }, 404);
      });
    }

    if (path === '/api/scans' && method === 'GET') {
      return json({ scans: readScans() });
    }

    if (path === '/api/scans' && method === 'POST') {
      var payload = null;
      try {
        payload = JSON.parse(bodyText || '{}');
      } catch (e) {}
      if (!payload) return json({ error: 'Bad payload' }, 400);
      var scans = readScans();
      var id = newId();
      var now = new Date().toISOString();
      var row = Object.assign({}, payload, {
        id: id,
        createdAt: now,
        created_at: now,
        photo_front_key: payload.photoFront ? id + '-front' : null,
        photo_side_key: payload.photoSide ? id + '-side' : null,
      });
      delete row.photoFront;
      delete row.photoSide;
      var frontSaved = await savePhoto(id, 'front', payload.photoFront);
      var sideSaved = await savePhoto(id, 'side', payload.photoSide);
      scans.unshift(row);
      writeScans(scans);
      return json({ id: id, photo: { front: frontSaved, side: sideSaved }, scan: row });
    }

    var idMatch = path.match(/^\/api\/scans\/([^/]+)$/);
    if (idMatch) {
      var list = readScans();
      var found = null;
      for (var i = 0; i < list.length; i++) if (list[i].id === idMatch[1]) found = list[i];
      if (method === 'GET') return found ? json({ scan: found }) : json({ error: 'not found' }, 404);
      if (method === 'DELETE') {
        writeScans(list.filter(function (s) { return s.id !== idMatch[1]; }));
        return json({ ok: true });
      }
      if (method === 'PATCH') {
        var body = null;
        try { body = JSON.parse(bodyText || '{}'); } catch (e) {}
        if (found && body) Object.assign(found, body);
        writeScans(list);
        return json({ ok: true, scan: found });
      }
    }

    var photoMatch = path.match(/^\/api\/scans\/([^/]+)\/photo\/(front|side)$/);
    if (photoMatch) {
      var d = getPhoto(decodeURIComponent(photoMatch[1]), photoMatch[2]);
      if (d) return fetch(d);
      return json({ error: 'no photo' }, 404);
    }

    if (/^\/api\/scans\/[^/]+\/(ai|improvements|add-side|landmarks|tune)/.test(path)) {
      return json({ ai: null, improvements: null, skipped: true });
    }

    return null;
  }

  var origFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    var url = null;
    var method = 'GET';
    try {
      if (input instanceof Request) {
        url = input.url;
        method = (init && init.method) || input.method || 'GET';
      } else {
        url = String(input);
        method = (init && init.method) || 'GET';
      }
      var abs = new URL(url, location.href);
      if (abs.origin !== location.origin || abs.pathname.indexOf('/api/') !== 0) {
        return origFetch(input, init);
      }
      var path = abs.pathname;

      var consume = function (bodyText) {
        return handle(method.toUpperCase(), path, bodyText).then(function (res) {
          if (res) return res;
          var opts = Object.assign({}, init || {}, { method: method });
          if (bodyText != null) opts.body = bodyText;
          var headers = new Headers((init && init.headers) || undefined);
          if (!headers.has('content-type') && bodyText != null) {
            headers.set('content-type', 'application/json');
          }
          opts.headers = headers;
          return origFetch(ORIGIN + path + abs.search, opts);
        });
      };

      var body = init && init.body;
      if (body == null && input instanceof Request && input.method !== 'GET' && input.method !== 'HEAD') {
        return input.clone().text().then(consume);
      }
      if (typeof body === 'string') return consume(body);
      if (body == null) return consume(null);
      if (typeof Blob !== 'undefined' && body instanceof Blob) {
        return body.text().then(consume);
      }
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        var params = new URLSearchParams();
        body.forEach(function (v, k) { params.append(k, v); });
        return consume(params.toString());
      }
      return consume(null);
    } catch (e) {
      return origFetch(input, init);
    }
  };

  function hydratePhotoImg(img) {
    var src = img.getAttribute('src') || '';
    var m = src.match(/^\/api\/scans\/([^/]+)\/photo\/(front|side)/);
    if (m) {
      var d = getPhoto(decodeURIComponent(m[1]), m[2]);
      if (d && img.src !== d) img.src = d;
      return;
    }
    // People photos live on the origin; images do not need CORS to display.
    if (src.indexOf('/api/people/') === 0) {
      img.src = ORIGIN + src;
    }
  }

  function sweep(root) {
    if (!root || !root.querySelectorAll) return;
    var imgs = root.querySelectorAll('img[src^="/api/scans/"], img[src^="/api/people/"]');
    for (var i = 0; i < imgs.length; i++) hydratePhotoImg(imgs[i]);
  }

  try {
    var mo = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var t = muts[i];
        if (t.type === 'attributes') {
          hydratePhotoImg(t.target);
        } else {
          for (var j = 0; j < t.addedNodes.length; j++) {
            var n = t.addedNodes[j];
            if (n.nodeType === 1) {
              if (n.tagName === 'IMG') hydratePhotoImg(n);
              else sweep(n);
            }
          }
        }
      }
    });
    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src'],
    });
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { sweep(document); });
    } else {
      sweep(document);
    }
  } catch (e) {}
})();
