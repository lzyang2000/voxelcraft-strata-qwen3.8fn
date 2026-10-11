/* Input layer: keyboard, mouse, pointer lock (with a drag-look fallback so the
 * game stays playable when pointer lock is blocked, e.g. on file://).
 * Contract: MC.Input.  No DOM access at load time (Node/vm safe). */
(function (root) {
  'use strict';
  var MC = (root.MC = root.MC || {});

  /* KeyboardEvent.code -> one-shot action name. */
  var ACTIONS = {
    KeyF: 'fly',
    KeyE: 'inventory',
    KeyC: 'crafting',
    KeyQ: 'drop',
    KeyR: 'cycle-tool',
    F3: 'debug',
    F5: 'save',
    F9: 'load',
    Escape: 'menu',
    Digit1: 'slot0', Digit2: 'slot1', Digit3: 'slot2',
    Digit4: 'slot3', Digit5: 'slot4', Digit6: 'slot5',
    Digit7: 'slot6', Digit8: 'slot7', Digit9: 'slot8'
  };

  /* Keys whose browser default (page scroll / save dialog / devtools) must die. */
  var PREVENT = {
    Space: true, Tab: true, F3: true, F5: true, F9: true,
    ArrowUp: true, ArrowDown: true, ArrowLeft: true, ArrowRight: true
  };

  function isTextEntry(el) {
    if (!el) return false;
    var tag = (el.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return true;
    return el.isContentEditable === true;
  }

  /* True when the event came from inside a UI panel (let those scroll). */
  function insidePanel(target) {
    var node = target;
    var guard = 0;
    while (node && guard++ < 24) {
      var cls = node.className;
      if (typeof cls === 'string' && cls.indexOf('panel') >= 0) return true;
      if (node.tagName && node.tagName.toUpperCase() === 'BODY') break;
      node = node.parentNode;
    }
    return false;
  }

  function Input(opts) {
    opts = opts || {};
    this.canvas = opts.canvas || null;
    this.sensitivity = opts.sensitivity === undefined ? 1.0 : opts.sensitivity;

    this.keys = {};                 /* code -> bool (held) */
    this.pressed = {};              /* action -> pending edge count */
    this.buttons = [false, false, false];

    this.lookX = 0;                 /* accumulated mouse pixels */
    this.lookY = 0;
    this.wheel = 0;                 /* accumulated hotbar scroll */

    this.locked = false;
    this.lockFallback = false;      /* pointer lock unavailable/denied */
    this.attached = false;
    this.onAction = null;           /* fn(actionName) */

    this._intentionalExit = false;
    this._dragging = false;
    this._lastMX = 0;
    this._lastMY = 0;
    this._h = null;                 /* bound handlers, for detach() */
  }

  /* ------------------------------------------------------------------ attach */
  Input.prototype.attach = function () {
    if (this.attached) return;
    this.attached = true;
    if (typeof document === 'undefined') return;      /* headless: nothing to bind */
    var self = this;
    var h = {};

    h.keydown = function (e) {
      var doc = e.target && e.target.ownerDocument;
      var active = (doc && doc.activeElement) || document.activeElement;
      if (isTextEntry(active)) return;
      var code = e.code || e.key || '';
      if (PREVENT[code] && typeof e.preventDefault === 'function') e.preventDefault();
      self._keyDown(code);
    };
    h.keyup = function (e) {
      var doc = e.target && e.target.ownerDocument;
      var active = (doc && doc.activeElement) || document.activeElement;
      if (isTextEntry(active)) return;
      self._keyUp(e.code || e.key || '');
    };
    h.blur = function () {
      self.keys = {};
      self.buttons[0] = self.buttons[1] = self.buttons[2] = false;
      self._dragging = false;
    };

    h.mousedown = function (e) {
      var b = e.button;
      if (b === 0 || b === 1 || b === 2) self.buttons[b] = true;
      self._lastMX = e.clientX;
      self._lastMY = e.clientY;
      if (b === 0) {
        /* A canvas click is the user gesture that grants pointer lock. */
        if (!self.locked && !self.lockFallback) self.requestLock();
        self._dragging = !self.locked;
      }
    };
    h.mouseup = function (e) {
      var b = e.button;
      if (b === 0 || b === 1 || b === 2) self.buttons[b] = false;
      if (b === 0) self._dragging = false;
    };
    h.mousemove = function (e) {
      var dx = e.movementX, dy = e.movementY;
      if (self.locked) {
        self.lookX += dx || 0;
        self.lookY += dy || 0;
        return;
      }
      if (self._dragging) {
        if (dx === undefined || dy === undefined || (dx === 0 && dy === 0)) {
          dx = e.clientX - self._lastMX;
          dy = e.clientY - self._lastMY;
        }
        self.lookX += dx || 0;
        self.lookY += dy || 0;
      }
      self._lastMX = e.clientX;
      self._lastMY = e.clientY;
    };
    h.wheel = function (e) {
      if (insidePanel(e.target)) return;             /* panels keep their scroll */
      if (typeof e.preventDefault === 'function') e.preventDefault();
      var d = e.deltaY || 0;
      if (d > 0) self.wheel += 1;
      else if (d < 0) self.wheel -= 1;
    };
    h.contextmenu = function (e) {
      if (typeof e.preventDefault === 'function') e.preventDefault();
    };
    h.pointerlockchange = function () {
      var el = document.pointerLockElement || document.mozPointerLockElement ||
        document.webkitPointerLockElement || null;
      var was = self.locked;
      self.locked = !!(el && self.canvas && el === self.canvas);
      if (was && !self.locked) {
        self._dragging = false;
        if (!self._intentionalExit && typeof self.onAction === 'function') self.onAction('menu');
      }
      self._intentionalExit = false;
    };
    h.pointerlockerror = function () {
      self.lockFallback = true;
      self.locked = false;
    };

    document.addEventListener('keydown', h.keydown, false);
    document.addEventListener('keyup', h.keyup, false);
    document.addEventListener('blur', h.blur, false);
    document.addEventListener('mousemove', h.mousemove, false);
    document.addEventListener('mouseup', h.mouseup, false);
    document.addEventListener('pointerlockchange', h.pointerlockchange, false);
    document.addEventListener('pointerlockerror', h.pointerlockerror, false);
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('blur', h.blur, false);
      window.addEventListener('wheel', h.wheel, { passive: false });
    }
    if (this.canvas && typeof this.canvas.addEventListener === 'function') {
      this.canvas.addEventListener('mousedown', h.mousedown, false);
      this.canvas.addEventListener('contextmenu', h.contextmenu, false);
    }
    this._h = h;
  };

  Input.prototype.detach = function () {
    if (!this.attached) return;
    this.attached = false;
    var h = this._h;
    this._h = null;
    if (!h || typeof document === 'undefined') return;
    document.removeEventListener('keydown', h.keydown, false);
    document.removeEventListener('keyup', h.keyup, false);
    document.removeEventListener('blur', h.blur, false);
    document.removeEventListener('mousemove', h.mousemove, false);
    document.removeEventListener('mouseup', h.mouseup, false);
    document.removeEventListener('pointerlockchange', h.pointerlockchange, false);
    document.removeEventListener('pointerlockerror', h.pointerlockerror, false);
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('blur', h.blur, false);
      window.removeEventListener('wheel', h.wheel, false);
    }
    if (this.canvas && typeof this.canvas.removeEventListener === 'function') {
      this.canvas.removeEventListener('mousedown', h.mousedown, false);
      this.canvas.removeEventListener('contextmenu', h.contextmenu, false);
    }
    this.keys = {};
    this.pressed = {};
    this.buttons[0] = this.buttons[1] = this.buttons[2] = false;
    this._dragging = false;
  };

  /* ------------------------------------------------------------- key plumbing */
  Input.prototype._keyDown = function (code) {
    if (!code) return;
    var repeat = this.keys[code] === true;
    this.keys[code] = true;
    var action = ACTIONS[code];
    if (action && !repeat) {
      this.pressed[action] = (this.pressed[action] || 0) + 1;
      if (typeof this.onAction === 'function') this.onAction(action);
    }
  };
  Input.prototype._keyUp = function (code) {
    if (!code) return;
    this.keys[code] = false;
  };

  Input.prototype.isDown = function (code) { return this.keys[code] === true; };

  Input.prototype.consumePressed = function (action) {
    var n = this.pressed[action] || 0;
    if (n <= 0) return false;
    this.pressed[action] = n - 1;
    return true;
  };

  /* ------------------------------------------------------------- mouse output */
  Input.prototype.consumeLook = function () {
    var out = { dx: this.lookX, dy: this.lookY };
    this.lookX = 0;
    this.lookY = 0;
    return out;
  };

  Input.prototype.consumeWheel = function () {
    var n = this.wheel;
    this.wheel = 0;
    return n;
  };

  /* ------------------------------------------------------------ pointer lock */
  Input.prototype.isLocked = function () { return this.locked === true; };

  Input.prototype.requestLock = function () {
    var c = this.canvas;
    if (!c) return false;
    var fn = c.requestPointerLock || c.mozRequestPointerLock || c.webkitRequestPointerLock;
    if (typeof fn !== 'function') { this.lockFallback = true; return false; }
    try {
      var r = fn.call(c);
      if (r && typeof r.catch === 'function') {
        r.catch(function () { /* denied -> fallback drag-look handles it */ });
      }
      return true;
    } catch (err) {
      this.lockFallback = true;
      return false;
    }
  };

  Input.prototype.exitLock = function () {
    this._intentionalExit = true;
    if (typeof document === 'undefined') return;
    var fn = document.exitPointerLock || document.mozExitPointerLock || document.webkitExitPointerLock;
    if (typeof fn === 'function') {
      try { fn.call(document); } catch (err) { /* ignore */ }
    }
    this.locked = false;
    this._dragging = false;
  };

  MC.Input = Input;
})(typeof window !== 'undefined' ? window : globalThis);
