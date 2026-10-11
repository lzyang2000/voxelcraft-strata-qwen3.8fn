/* Persistence: localStorage + export/import .json.
 * Contract: MC.Save.  Never throws; every storage touch is guarded. */
(function (root) {
  'use strict';
  var MC = (root.MC = root.MC || {});
  var C = MC.C;
  var KEY = (C && C.SAVE_KEY) ? C.SAVE_KEY : 'mc_clone_save_v1';

  function msgOf(err) {
    if (!err) return 'unknown error';
    if (typeof err === 'string') return err;
    return err.name === 'QuotaExceededError' ? 'storage-quota-exceeded'
      : (err.message || String(err));
  }

  function store() {
    try {
      var ls = root.localStorage;
      if (!ls || typeof ls.getItem !== 'function' || typeof ls.setItem !== 'function') return null;
      return ls;
    } catch (e) {
      return null;   /* Safari/Chrome on file:// throw just for touching it */
    }
  }

  function Save() {
    this._mem = null;      /* in-session fallback when storage is blocked */
    this._ok = null;
  }

  Save.prototype.available = function () {
    if (this._ok !== null) return this._ok;
    var ls = store();
    if (!ls) { this._ok = false; return false; }
    try {
      ls.setItem(KEY + '__probe', '1');
      ls.removeItem(KEY + '__probe');
      this._ok = true;
    } catch (e) {
      /* A quota error means storage is reachable but full, so save() should
       * still attempt the real write and report the quota. Anything else
       * (SecurityError on file://, disabled cookies, ...) means no storage. */
      this._ok = !!(e && e.name === 'QuotaExceededError');
    }
    return this._ok;
  };

  Save.prototype._build = function (world, player, inv, meta) {
    meta = meta || {};
    return {
      version: MC.VERSION,
      savedAt: Date.now(),
      meta: {
        seed: meta.seed !== undefined ? meta.seed : (world ? world.seed : 0),
        mode: meta.mode || (inv && inv.creative ? 'creative' : 'survival'),
        timeOfDay: meta.timeOfDay !== undefined ? meta.timeOfDay : 0
      },
      world: world.serialize(),
      player: {
        position: [player.position[0], player.position[1], player.position[2]],
        yaw: player.yaw,
        pitch: player.pitch,
        health: player.health,
        air: player.air,
        flying: !!player.flying
      },
      inventory: inv.serialize()
    };
  };

  Save.prototype.save = function (world, player, inv, meta) {
    if (!world || !player || !inv) return { ok: false, error: 'missing-state' };
    var json;
    try {
      json = JSON.stringify(this._build(world, player, inv, meta));
    } catch (e) {
      return { ok: false, error: msgOf(e) };
    }
    this._mem = json;                       /* always keep an in-session copy */
    var ls = this.available() ? store() : null;
    if (!ls) return { ok: false, error: 'storage-unavailable', bytes: json.length, memory: true };
    try {
      ls.setItem(KEY, json);
      return { ok: true, bytes: json.length };
    } catch (e) {
      return { ok: false, error: msgOf(e), bytes: json.length, memory: true };
    }
  };

  Save.prototype.load = function () {
    var json = null;
    var ls = this.available() ? store() : null;
    if (ls) {
      try { json = ls.getItem(KEY); } catch (e) { json = null; }
    }
    if (!json) json = this._mem;
    if (!json) return { ok: false, error: 'no-save-found' };
    var data;
    try { data = JSON.parse(json); } catch (e) { return { ok: false, error: 'corrupt-save' }; }
    if (!data || !data.world || !data.player) return { ok: false, error: 'corrupt-save' };
    return { ok: true, data: data };
  };

  Save.prototype.has = function () {
    var ls = this.available() ? store() : null;
    if (ls) {
      try { if (ls.getItem(KEY)) return true; } catch (e) { /* fall through */ }
    }
    return !!this._mem;
  };

  Save.prototype.clear = function () {
    this._mem = null;
    var ls = this.available() ? store() : null;
    if (!ls) return false;
    try { ls.removeItem(KEY); return true; } catch (e) { return false; }
  };

  /* Returns {ok, error, bytes} AND, when a callback is supplied (game.js uses
   * the callback form), calls cb(ok, err) so both call styles work. */
  Save.prototype.exportFile = function (world, player, inv, meta, cb) {
    var done = function (res) {
      if (typeof cb === 'function') {
        try { cb(!!res.ok, res.ok ? null : (res.error || 'export-failed')); } catch (e3) { /* ignore */ }
      }
      return res;
    };
    if (typeof document === 'undefined' || typeof Blob === 'undefined' ||
      typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      return done({ ok: false, error: 'no-dom' });
    }
    var json;
    try {
      json = JSON.stringify(this._build(world, player, inv, meta));
    } catch (e) {
      return done({ ok: false, error: msgOf(e) });
    }
    var url = null;
    try {
      var blob = new Blob([json], { type: 'application/json' });
      url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'voxelcraft-save.json';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      if (a.parentNode) a.parentNode.removeChild(a);
      return done({ ok: true, bytes: json.length });
    } catch (e) {
      return done({ ok: false, error: msgOf(e) });
    } finally {
      if (url && typeof URL.revokeObjectURL === 'function') {
        /* keep the blob alive long enough for the download to start */
        setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e2) { /* ignore */ } }, 4000);
      }
    }
  };

  Save.prototype.importFile = function (file, cb) {
    if (typeof cb !== 'function') return;
    if (!file) { cb(new Error('no-file'), null); return; }
    if (typeof FileReader === 'undefined') { cb(new Error('no-filereader'), null); return; }
    var fr = new FileReader();
    fr.onload = function () {
      var text = fr.result;
      if (typeof text !== 'string') { cb(new Error('unreadable-file'), null); return; }
      try { cb(null, JSON.parse(text)); } catch (e) { cb(e, null); }
    };
    fr.onerror = function () { cb(new Error('unreadable-file'), null); };
    try { fr.readAsText(file); } catch (e) { cb(e, null); }
  };

  MC.Save = Save;
})(typeof window !== 'undefined' ? window : globalThis);
