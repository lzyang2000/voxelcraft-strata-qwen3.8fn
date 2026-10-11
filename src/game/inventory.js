/* Item model: 9 hotbar + 27 main slots, stacking, crafting consumption.
 * Contract: MC.Inventory.  Pure data - no DOM, no world access. */
(function (root) {
  'use strict';
  var MC = (root.MC = root.MC || {});
  var C = MC.C;

  var HOTBAR = C ? C.HOTBAR_SLOTS : 9;
  var MAIN = 27;
  var STACK = C ? C.STACK_SIZE : 64;

  function maxStack(name) {
    var it = MC.item(name);
    if (it && it.kind === 'tool') return 1;
    return STACK;
  }

  function Inventory(opts) {
    opts = opts || {};
    this.hotbar = new Array(HOTBAR);
    this.main = new Array(MAIN);
    for (var i = 0; i < HOTBAR; i++) this.hotbar[i] = null;
    for (var j = 0; j < MAIN; j++) this.main[j] = null;
    this.selected = 0;
    this.creative = !!opts.creative;
    this.version = 0;
  }

  /* Poll this; every mutation bumps it so the UI can skip DOM work. */
  Inventory.prototype.changed = function () { return this.version; };
  Inventory.prototype._bump = function () { this.version++; };

  Inventory.prototype._area = function (name) {
    return name === 'main' ? this.main : this.hotbar;
  };

  Inventory.prototype.addItem = function (name, count) {
    if (!name || !(count > 0)) return 0;
    if (!MC.item(name)) return count;          /* unknown item -> nowhere to go */
    if (this.creative) return 0;               /* creative never picks anything up */
    var cap = maxStack(name);
    var left = count;
    var areas = [this.hotbar, this.main];
    /* 1) top up existing stacks */
    for (var a = 0; a < areas.length && left > 0; a++) {
      var arr = areas[a];
      for (var i = 0; i < arr.length && left > 0; i++) {
        var s = arr[i];
        if (s && s.name === name && s.count < cap) {
          var room = cap - s.count;
          var put = room < left ? room : left;
          s.count += put;
          left -= put;
        }
      }
    }
    /* 2) fill empty slots */
    for (var b = 0; b < areas.length && left > 0; b++) {
      var arr2 = areas[b];
      for (var k = 0; k < arr2.length && left > 0; k++) {
        if (!arr2[k]) {
          var take = cap < left ? cap : left;
          arr2[k] = { name: name, count: take };
          left -= take;
        }
      }
    }
    if (left !== count) this._bump();
    return left;
  };

  Inventory.prototype.getSelected = function () {
    return this.hotbar[this.selected] || null;
  };

  Inventory.prototype.getSelectedName = function () {
    var s = this.hotbar[this.selected];
    return s ? s.name : null;
  };

  Inventory.prototype.takeSelected = function (n) {
    var s = this.hotbar[this.selected];
    if (!s) return 0;
    var want = n > 0 ? n : 1;
    if (this.creative) return want;            /* creative stacks never deplete */
    var got = want < s.count ? want : s.count;
    s.count -= got;
    if (s.count <= 0) this.hotbar[this.selected] = null;
    this._bump();
    return got;
  };

  Inventory.prototype.select = function (i) {
    i = i | 0;
    if (i < 0) i = 0;
    if (i > HOTBAR - 1) i = HOTBAR - 1;
    if (this.selected !== i) { this.selected = i; this._bump(); }
  };

  Inventory.prototype.scroll = function (delta) {
    if (!delta) return;
    var i = this.selected + (delta | 0);
    i = ((i % HOTBAR) + HOTBAR) % HOTBAR;
    this.select(i);
  };

  Inventory.prototype.countOf = function (name) {
    var n = 0;
    for (var i = 0; i < this.hotbar.length; i++) {
      var h = this.hotbar[i];
      if (h && h.name === name) n += h.count;
    }
    for (var j = 0; j < this.main.length; j++) {
      var m = this.main[j];
      if (m && m.name === name) n += m.count;
    }
    return n;
  };

  Inventory.prototype.removeItem = function (name, n) {
    var left = n > 0 ? n : 0;
    var removed = 0;
    var areas = [this.main, this.hotbar];
    for (var a = 0; a < areas.length && left > 0; a++) {
      var arr = areas[a];
      for (var i = 0; i < arr.length && left > 0; i++) {
        var s = arr[i];
        if (s && s.name === name) {
          var take = s.count < left ? s.count : left;
          s.count -= take;
          left -= take;
          removed += take;
          if (s.count <= 0) arr[i] = null;
        }
      }
    }
    if (removed) this._bump();
    return removed;
  };

  Inventory.prototype.canCraft = function (recipe) {
    if (!recipe || !recipe.in) return false;
    for (var i = 0; i < recipe.in.length; i++) {
      var need = recipe.in[i];
      if (this.countOf(need[0]) < need[1]) return false;
    }
    return true;
  };

  /* Shallow copy of the slot contents (used to trial a craft before
   * committing it, so a failed craft never destroys the inputs). */
  Inventory.prototype._clone = function () {
    var copy = new Inventory({ creative: this.creative });
    copy.selected = this.selected;
    function dup(src, dst) {
      for (var i = 0; i < src.length; i++) {
        var s = src[i];
        dst[i] = s ? { name: s.name, count: s.count } : null;
      }
    }
    dup(this.hotbar, copy.hotbar);
    dup(this.main, copy.main);
    return copy;
  };

  /* Free room for `name` (respecting its stack cap) across hotbar + main. */
  Inventory.prototype.freeSpace = function (name) {
    var cap = maxStack(name);
    var free = 0;
    var areas = [this.hotbar, this.main];
    for (var a = 0; a < areas.length; a++) {
      var arr = areas[a];
      for (var i = 0; i < arr.length; i++) {
        var s = arr[i];
        if (!s) free += cap;
        else if (s.name === name && s.count < cap) free += cap - s.count;
      }
    }
    return free;
  };

  /* Would `count` of `name` fit once the recipe inputs are consumed?
   * The trial runs on a copy: crafting must never eat the materials and
   * then throw the output away because there was nowhere to put it. */
  Inventory.prototype.canCraftTo = function (recipe) {
    if (!this.canCraft(recipe)) return false;
    if (this.creative) return true;          /* creative never stores anything */
    var trial = this._clone();
    for (var i = 0; i < recipe.in.length; i++) {
      trial.removeItem(recipe.in[i][0], recipe.in[i][1]);
    }
    return trial.freeSpace(recipe.out[0]) >= recipe.out[1];
  };

  Inventory.prototype.craft = function (recipe) {
    if (!this.canCraftTo(recipe)) return false;
    for (var i = 0; i < recipe.in.length; i++) {
      this.removeItem(recipe.in[i][0], recipe.in[i][1]);
    }
    var out = recipe.out;
    this.addItem(out[0], out[1]);
    this._bump();
    return true;
  };

  Inventory.prototype.setSlot = function (area, i, stack) {
    var arr = this._area(area);
    i = i | 0;
    if (i < 0 || i >= arr.length) return false;
    if (stack && stack.name && MC.item(stack.name)) {
      var cap = maxStack(stack.name);
      var count = stack.count > 0 ? stack.count : 1;
      arr[i] = { name: stack.name, count: count > cap ? cap : count };
    } else {
      arr[i] = null;
    }
    this._bump();
    return true;
  };

  Inventory.prototype.clear = function () {
    for (var i = 0; i < this.hotbar.length; i++) this.hotbar[i] = null;
    for (var j = 0; j < this.main.length; j++) this.main[j] = null;
    this.selected = 0;
    this._bump();
  };

  /* Give a fresh survival loadout (used by game.js on world start). */
  Inventory.prototype.giveStart = function (list) {
    var items = list || MC.SURVIVAL_START;
    if (!items) return;
    for (var i = 0; i < items.length; i++) this.addItem(items[i][0], items[i][1]);
  };

  Inventory.prototype.serialize = function () {
    function pack(arr) {
      var out = [];
      for (var i = 0; i < arr.length; i++) {
        var s = arr[i];
        out.push(s ? [s.name, s.count] : 0);
      }
      return out;
    }
    return { selected: this.selected, creative: this.creative, hotbar: pack(this.hotbar), main: pack(this.main) };
  };

  Inventory.prototype.deserialize = function (data) {
    if (!data) return false;
    function unpack(src, arr) {
      for (var i = 0; i < arr.length; i++) {
        var s = src && src[i];
        if (s && s.length === 2 && MC.item(s[0]) && s[1] > 0) {
          var cap = maxStack(s[0]);
          arr[i] = { name: s[0], count: s[1] > cap ? cap : s[1] };
        } else {
          arr[i] = null;
        }
      }
    }
    unpack(data.hotbar, this.hotbar);
    unpack(data.main, this.main);
    var sel = data.selected | 0;
    this.selected = sel >= 0 && sel < HOTBAR ? sel : 0;
    if (data.creative !== undefined) this.creative = !!data.creative;
    this._bump();
    return true;
  };

  MC.Inventory = Inventory;
})(typeof window !== 'undefined' ? window : globalThis);
