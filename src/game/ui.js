/* HUD + panels, driven by the index.html DOM and the styles.css class contract.
 * Contract: MC.UI.  All DOM access happens in the constructor / methods. */
(function (root) {
  'use strict';
  var MC = (root.MC = root.MC || {});
  var C = MC.C;

  var HOTBAR = C ? C.HOTBAR_SLOTS : 9;
  var HEARTS = 10;
  var BUBBLES = 10;
  var HINT_FADE_MS = 8000;

  function chan(c) { return Math.round(Math.max(0, Math.min(1, c)) * 255); }

  /* rgb() + a light/dark ramp so a flat colour still reads as a cube. */
  function ramp(color) {
    var r = color[0], g = color[1], b = color[2];
    var up = function (v, k) { return v + (1 - v) * k; };
    var dn = function (v, k) { return v * (1 - k); };
    return {
      light: 'rgb(' + chan(up(r, 0.35)) + ',' + chan(up(g, 0.35)) + ',' + chan(up(b, 0.35)) + ')',
      mid: 'rgb(' + chan(r) + ',' + chan(g) + ',' + chan(b) + ')',
      dark: 'rgb(' + chan(dn(r, 0.42)) + ',' + chan(dn(g, 0.42)) + ',' + chan(dn(b, 0.42)) + ')'
    };
  }

  var GLYPHS = { pickaxe: 'P', axe: 'A', shovel: 'S' };

  function glyphFor(item) {
    if (!item) return '';
    if (item.kind === 'tool') return GLYPHS[item.tool] || 'T';
    if (item.kind === 'material') return item.name.charAt(0).toUpperCase();
    return '';
  }

  function iconCss(item) {
    var col = ramp(item && item.color ? item.color : [0.6, 0.6, 0.6]);
    if (item && item.kind === 'block') {
      /* three stops: lit top face, mid side, shaded bottom */
      return 'linear-gradient(168deg,' + col.light + ' 0%,' + col.light + ' 26%,' +
        col.mid + ' 27%,' + col.mid + ' 68%,' + col.dark + ' 69%,' + col.dark + ' 100%)';
    }
    return 'linear-gradient(135deg,' + col.light + ' 0%,' + col.mid + ' 50%,' + col.dark + ' 100%)';
  }

  function UI(opts) {
    opts = opts || {};
    this.opts = opts;
    this.inventory = opts.inventory || null;
    this._cache = {};
    this._version = -1;
    this._hearts = null;
    this._bubbles = null;
    this._lastHealth = -1;
    this._lastAir = -1;
    this._lastHeld = null;
    this._lastWater = null;
    this._lastAirVisible = null;
    this._toastTimer = 0;
    this._firstLockAt = 0;
    this._hintFaded = false;
    this._invOpen = false;
    this._paletteOpen = false;
    this._craftOpen = false;
    this._build();
  }

  /* ------------------------------------------------------------- element get */
  UI.prototype.el = function (id) {
    if (Object.prototype.hasOwnProperty.call(this._cache, id)) return this._cache[id];
    var node = null;
    try {
      if (typeof document !== 'undefined' && document.getElementById) {
        node = document.getElementById(id);
      }
    } catch (e) { node = null; }
    this._cache[id] = node;
    return node;
  };

  function hide(node, yes) {
    if (!node) return;
    if (yes) node.classList.add('hidden');
    else node.classList.remove('hidden');
  }

  function on(node, ev, fn) {
    if (node && typeof node.addEventListener === 'function') node.addEventListener(ev, fn, false);
  }

  function call(fn, a, b) {
    if (typeof fn === 'function') return fn(a, b);
    return undefined;
  }

  /* --------------------------------------------------------------- wiring */
  UI.prototype._build = function () {
    var self = this;
    var o = this.opts;

    on(this.el('btn-play'), 'click', function () {
      var fn = o.onPlay || o.onResume || o.onTogglePause;
      if (typeof fn === 'function') { fn(); return; }
      /* No resume callback was wired: synthesise Esc so the input layer's
       * 'menu' action (which game.js maps to pause/resume) fires instead. */
      try {
        if (typeof document !== 'undefined' && typeof root.KeyboardEvent === 'function') {
          var ev = { code: 'Escape', bubbles: true, cancelable: true };
          document.dispatchEvent(new root.KeyboardEvent('keydown', ev));
          /* ...and release it again, or MC.Input.keys['Escape'] would stay
           * latched true for the rest of the session. */
          document.dispatchEvent(new root.KeyboardEvent('keyup', ev));
        }
      } catch (e) { /* ignore */ }
    });
    on(this.el('btn-new'), 'click', function () { call(o.onNewWorld); });
    on(this.el('btn-save'), 'click', function () { call(o.onSave); });
    on(this.el('btn-load'), 'click', function () { call(o.onLoad); });
    on(this.el('btn-export'), 'click', function () { call(o.onExport); });
    on(this.el('btn-import'), 'click', function () {
      var f = self.el('import-file');
      if (f && typeof f.click === 'function') f.click();
    });
    on(this.el('import-file'), 'change', function (e) {
      var input = e.target || self.el('import-file');
      var file = input && input.files && input.files.length ? input.files[0] : null;
      if (!file) return;
      if (typeof FileReader === 'undefined') { call(o.onImport, null); return; }
      var fr = new FileReader();
      fr.onload = function () {
        var data = null;
        try { data = JSON.parse(String(fr.result)); } catch (err) { data = null; }
        call(o.onImport, data);
        try { input.value = ''; } catch (e2) { /* ignore */ }
      };
      fr.onerror = function () { call(o.onImport, null); };
      try { fr.readAsText(file); } catch (e3) { call(o.onImport, null); }
    });

    on(this.el('mode'), 'change', function (e) {
      call(o.onModeChange, (e.target && e.target.value) || 'survival');
    });
    on(this.el('seed'), 'change', function (e) {
      call(o.onSeedChange, (e.target && e.target.value) || '');
    });
    on(this.el('render-dist'), 'change', function (e) {
      call(o.onRenderDist, parseInt((e.target && e.target.value) || '4', 10) || 4);
    });
    on(this.el('sens'), 'input', function (e) {
      var v = parseInt((e.target && e.target.value) || '100', 10);
      call(o.onSensitivity, (v || 100) / 100);
    });

    on(this.el('btn-close-inv'), 'click', function () { self.hideInventory(); });
    on(this.el('btn-close-palette'), 'click', function () { self.hidePalette(); });
    on(this.el('btn-close-craft'), 'click', function () { self.hideCrafting(); });

    /* hint fades out shortly after the mouse is first captured */
    try {
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('pointerlockchange', function () {
          if (document.pointerLockElement && !self._firstLockAt) self._firstLockAt = Date.now();
        }, false);
      }
    } catch (e) { /* ignore */ }
  };

  /* ------------------------------------------------------------- slot paint */
  UI.prototype._makeSlot = function (name, count, selected, onClick) {
    var slot = document.createElement('div');
    slot.className = 'slot' + (selected ? ' selected' : '');
    if (name) {
      var item = MC.item(name);
      var icon = document.createElement('div');
      icon.className = 'icon';
      icon.style.background = iconCss(item);
      slot.appendChild(icon);
      var glyph = glyphFor(item);
      if (glyph) {
        var g = document.createElement('div');
        g.className = 'glyph';
        g.textContent = glyph;
        slot.appendChild(g);
      }
      if (count > 1) {
        var c = document.createElement('div');
        c.className = 'count';
        c.textContent = String(count);
        slot.appendChild(c);
      }
      slot.title = (item && item.label) || name;
    }
    if (typeof onClick === 'function') on(slot, 'click', onClick);
    return slot;
  };

  /* --------------------------------------------------------------- hotbar */
  UI.prototype.refreshHotbar = function () {
    var bar = this.el('hotbar');
    if (!bar) return;
    var inv = this.inventory;
    bar.textContent = '';
    if (!inv) return;
    var self = this;
    for (var i = 0; i < HOTBAR; i++) {
      var stack = inv.hotbar[i];
      (function (index) {
        bar.appendChild(self._makeSlot(
          stack ? stack.name : null,
          stack ? stack.count : 0,
          inv.selected === index,
          function () { call(self.opts.onPickSlot, index); }
        ));
      })(i);
    }
  };

  /* -------------------------------------------------- inventory / palette */
  UI.prototype.refreshInventory = function () {
    var self = this;
    var inv = this.inventory;

    var main = this.el('inv-main');
    if (main && inv) {
      main.textContent = '';
      for (var i = 0; i < inv.main.length; i++) {
        var s = inv.main[i];
        main.appendChild(this._makeSlot(s ? s.name : null, s ? s.count : 0, false, null));
      }
    }
    var hb = this.el('inv-hotbar');
    if (hb && inv) {
      hb.textContent = '';
      for (var j = 0; j < inv.hotbar.length; j++) {
        var st = inv.hotbar[j];
        (function (index) {
          hb.appendChild(self._makeSlot(
            st ? st.name : null, st ? st.count : 0,
            inv.selected === index,
            function () { call(self.opts.onPickSlot, index); }
          ));
        })(j);
      }
    }

    var pal = this.el('palette-grid');
    if (pal) {
      pal.textContent = '';
      var names = MC.CREATIVE_PALETTE || [];
      for (var k = 0; k < names.length; k++) {
        (function (name) {
          pal.appendChild(self._makeSlot(name, 0, false, function () {
            call(self.opts.onPickPaletteItem, name);
          }));
        })(names[k]);
      }
    }

    var list = this.el('craft-list');
    if (list) {
      list.textContent = '';
      var recipes = MC.RECIPES || [];
      for (var r = 0; r < recipes.length; r++) {
        (function (recipe) {
          var row = document.createElement('div');
          var can = !!(inv && inv.canCraft(recipe));
          row.className = 'recipe' + (can ? '' : ' disabled');
          var icon = document.createElement('div');
          icon.className = 'icon';
          icon.style.background = iconCss(MC.item(recipe.out[0]));
          row.appendChild(icon);
          var txt = document.createElement('div');
          txt.className = 'txt';
          txt.textContent = recipe.label;
          row.appendChild(txt);
          var tag = document.createElement('div');
          tag.className = 'tag';
          tag.textContent = 'x' + recipe.out[1];
          row.appendChild(tag);
          if (can) on(row, 'click', function () { call(self.opts.onCraft, recipe); });
          list.appendChild(row);
        })(recipes[r]);
      }
    }
    this._version = inv ? inv.changed() : -1;
  };

  /* ------------------------------------------------------------- hud sync */
  UI.prototype._buildHearts = function (host, n, cls) {
    var arr = [];
    for (var i = 0; i < n; i++) {
      var d = document.createElement('div');
      d.className = cls;
      host.appendChild(d);
      arr.push(d);
    }
    return arr;
  };

  UI.prototype.syncHud = function (player, info) {
    if (!player) return;
    var i;

    /* hearts */
    var hp = Math.max(0, Math.min(player.maxHealth, player.health));
    if (hp !== this._lastHealth) {
      var hbar = this.el('health');
      if (hbar) {
        if (!this._hearts) {
          hbar.textContent = '';
          this._hearts = this._buildHearts(hbar, HEARTS, 'heart');
        }
        for (i = 0; i < HEARTS; i++) {
          var v = hp - i * 2;
          var node = this._hearts[i];
          node.className = 'heart' + (v >= 2 ? '' : v >= 1 ? ' half' : ' empty');
        }
      }
      this._lastHealth = hp;
    }

    /* air bubbles */
    var air = Math.max(0, Math.min(player.maxAir, player.air));
    var showAir = !!player.headInWater || air < player.maxAir;
    if (showAir !== this._lastAirVisible) {
      hide(this.el('air'), !showAir);
      this._lastAirVisible = showAir;
    }
    if (showAir && air !== this._lastAir) {
      var abar = this.el('air');
      if (abar) {
        if (!this._bubbles) {
          abar.textContent = '';
          this._bubbles = this._buildHearts(abar, BUBBLES, 'bubble');
        }
        for (i = 0; i < BUBBLES; i++) {
          var a = air - i * 2;
          this._bubbles[i].className = 'bubble' + (a >= 2 ? '' : a >= 1 ? ' half' : ' empty');
        }
      }
      this._lastAir = air;
    }

    /* water tint over the viewport */
    var wet = !!player.headInWater;
    if (wet !== this._lastWater) {
      hide(this.el('water-overlay'), !wet);
      this._lastWater = wet;
    }

    /* held item label */
    var inv = this.inventory;
    var held = inv ? inv.getSelectedName() : null;
    if (held !== this._lastHeld) {
      var lbl = this.el('held-label');
      if (lbl) {
        var item = held ? MC.item(held) : null;
        lbl.textContent = item ? item.label : '';
      }
      this._lastHeld = held;
    }

    /* hint fade */
    if (!this._hintFaded && this._firstLockAt) {
      if (Date.now() - this._firstLockAt > HINT_FADE_MS) {
        var hint = this.el('hint');
        if (hint) { hint.style.opacity = '0'; hint.style.transition = 'opacity 1.2s'; }
        this._hintFaded = true;
      }
    }

    if (info && info.hint !== undefined) {
      var h = this.el('hint');
      if (h && !this._hintFaded) h.style.opacity = info.hint ? '0.55' : '0';
    }
  };

  /* --------------------------------------------------------------- overlays */
  UI.prototype.debug = function (lines) {
    var d = this.el('debug');
    if (!d) return;
    d.textContent = Array.isArray(lines) ? lines.join('\n') : (lines || '');
  };

  UI.prototype.toast = function (msg, ms) {
    var t = this.el('toast');
    if (!t) return;
    t.textContent = msg || '';
    t.classList.add('show');
    if (this._toastTimer) {
      if (typeof clearTimeout === 'function') clearTimeout(this._toastTimer);
    }
    var life = ms > 0 ? ms : 2200;
    if (typeof setTimeout === 'function') {
      this._toastTimer = setTimeout(function () { t.classList.remove('show'); }, life);
    }
  };

  UI.prototype.loading = function (pct, text) {
    var box = this.el('loading');
    if (!box) return;
    hide(box, false);
    var fill = this.el('loading-fill');
    if (fill) fill.style.width = Math.max(0, Math.min(100, pct || 0)) + '%';
    var label = this.el('loading-text');
    if (label && text !== undefined) label.textContent = text || '';
  };

  UI.prototype.hideLoading = function () {
    hide(this.el('loading'), true);
  };

  UI.prototype.setMenuNote = function (msg) {
    var n = this.el('menu-note');
    if (n) n.textContent = msg || '';
  };

  /* ---------------------------------------------------------------- panels */
  UI.prototype.showMenu = function () { hide(this.el('menu'), false); };
  UI.prototype.hideMenu = function () { hide(this.el('menu'), true); };
  UI.prototype.showHud = function () { hide(this.el('hud'), false); };
  UI.prototype.hideHud = function () { hide(this.el('hud'), true); };

  UI.prototype.showInventory = function () {
    this.refreshInventory();
    this._invOpen = true;
    hide(this.el('inventory'), false);
  };
  UI.prototype.hideInventory = function () {
    this._invOpen = false;
    hide(this.el('inventory'), true);
  };
  UI.prototype.isInventoryOpen = function () { return this._invOpen || this._paletteOpen; };

  UI.prototype.toggleInventory = function () {
    if (this._invOpen) this.hideInventory(); else this.showInventory();
    return this._invOpen;
  };
  UI.prototype.togglePalette = function () {
    if (this._paletteOpen) this.hidePalette(); else this.showPalette();
    return this._paletteOpen;
  };

  UI.prototype.showPalette = function () {
    this.refreshInventory();
    this._paletteOpen = true;
    hide(this.el('palette'), false);
  };
  UI.prototype.hidePalette = function () {
    this._paletteOpen = false;
    hide(this.el('palette'), true);
  };

  UI.prototype.showCrafting = function () {
    this.refreshInventory();
    this._craftOpen = true;
    hide(this.el('crafting'), false);
  };
  UI.prototype.hideCrafting = function () {
    this._craftOpen = false;
    hide(this.el('crafting'), true);
  };
  UI.prototype.toggleCrafting = function () {
    if (this._craftOpen) this.hideCrafting(); else this.showCrafting();
  };
  UI.prototype.isCraftingOpen = function () { return this._craftOpen; };

  /* cheap per-frame poll: only touch the DOM when the model actually changed */
  UI.prototype.tick = function () {
    var inv = this.inventory;
    if (!inv) return;
    if (inv.changed() !== this._version) {
      this._version = inv.changed();
      this.refreshHotbar();
      if (this._invOpen || this._paletteOpen || this._craftOpen) this.refreshInventory();
    }
  };

  MC.UI = UI;
})(typeof window !== 'undefined' ? window : globalThis);
