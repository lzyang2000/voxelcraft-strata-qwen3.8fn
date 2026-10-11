/* Fake DOM + fake WebGL2 good enough to boot and play Voxelcraft headlessly.
 * Used by tools/test-integration.js. Not a browser: GLSL is never compiled,
 * but every JS code path (boot, loop, mining, placing, sim, save) really runs. */
'use strict';

function makeElement(id, tag) {
  var el = {
    id: id || '', tagName: (tag || 'div').toUpperCase(), children: [], parentNode: null,
    style: {}, dataset: {}, value: '', checked: false, files: [],
    _text: '', _html: '', _cls: new Set(), _listeners: {}, attrs: {},
    clientWidth: 1280, clientHeight: 720, width: 1280, height: 720
  };
  el.classList = {
    add: function () { for (var i = 0; i < arguments.length; i++) el._cls.add(arguments[i]); },
    remove: function () { for (var i = 0; i < arguments.length; i++) el._cls.delete(arguments[i]); },
    toggle: function (c, force) {
      if (force === undefined) { el._cls.has(c) ? el._cls.delete(c) : el._cls.add(c); }
      else if (force) el._cls.add(c); else el._cls.delete(c);
      return el._cls.has(c);
    },
    contains: function (c) { return el._cls.has(c); }
  };
  Object.defineProperty(el, 'textContent', {
    get: function () { return el._text; },
    set: function (v) { el._text = String(v); el.children.length = 0; }
  });
  Object.defineProperty(el, 'innerHTML', {
    get: function () { return el._html; },
    set: function (v) { el._html = String(v); el.children.length = 0; }
  });
  Object.defineProperty(el, 'className', {
    get: function () { return Array.from(el._cls).join(' '); },
    set: function (v) { el._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  });
  el.appendChild = function (c) { c.parentNode = el; el.children.push(c); return c; };
  el.removeChild = function (c) {
    var i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c;
  };
  el.remove = function () { if (el.parentNode) el.parentNode.removeChild(el); };
  el.setAttribute = function (k, v) { el.attrs[k] = String(v); };
  el.getAttribute = function (k) { return el.attrs[k] === undefined ? null : el.attrs[k]; };
  el.removeAttribute = function (k) { delete el.attrs[k]; };
  el.querySelector = function () { return null; };
  el.querySelectorAll = function () { return []; };
  el.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: el.clientWidth, bottom: el.clientHeight, width: el.clientWidth, height: el.clientHeight, x: 0, y: 0 };
  };
  el.addEventListener = function (t, fn) { (el._listeners[t] = el._listeners[t] || []).push(fn); };
  el.removeEventListener = function (t, fn) {
    var a = el._listeners[t]; if (!a) return;
    var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
  };
  el.dispatch = function (type, ev) {
    var a = el._listeners[type]; if (!a || !a.length) return 0;
    ev = ev || {};
    if (!ev.target) ev.target = el;
    if (!ev.preventDefault) ev.preventDefault = function () { ev.defaultPrevented = true; };
    if (!ev.stopPropagation) ev.stopPropagation = function () { };
    for (var i = 0; i < a.length; i++) a[i](ev);
    return a.length;
  };
  el.click = function () { return el.dispatch('click', {}); };
  el.focus = function () { el.ownerDocument.activeElement = el; };
  el.blur = function () { };
  return el;
}

/* ------------------------------- fake WebGL2 ---------------------------- */
function makeGL(log) {
  var objects = 0;
  var overrides = {
    createProgram: function () { objects++; return { kind: 'program', id: objects }; },
    createShader: function () { objects++; return { kind: 'shader', id: objects }; },
    createBuffer: function () { objects++; return { kind: 'buffer', id: objects }; },
    createTexture: function () { objects++; return { kind: 'texture', id: objects }; },
    createVertexArray: function () { objects++; return { kind: 'vao', id: objects }; },
    createFramebuffer: function () { objects++; return { kind: 'fbo', id: objects }; },
    getUniformLocation: function (p, name) { return { kind: 'uniform', name: name }; },
    getAttribLocation: function (p, name) { return (name.length % 8); },
    getProgramParameter: function (p, what) { return what === 'linkStatusNum' || String(what) === '35715' || true; },
    getShaderParameter: function (s, what) { return true; },
    getProgramInfoLog: function () { return ''; },
    getShaderInfoLog: function () { return ''; },
    getExtension: function () { return null; },
    getParameter: function () { return 4096; },
    getContextAttributes: function () { return { alpha: false, depth: true, stencil: false, antialias: false }; },
    /* record shader sources so the harness can lint them textually */
    shaderSource: function (s, src) { s.source = src; log.shaders.push(src); },
    texImage2D: function () { log.texImage2D++; },
    bufferData: function (target, data) {
      log.bufferData++;
      if (data && data.length !== undefined) log.bufferBytes += data.length * (data.BYTES_PER_ELEMENT || 1);
    },
    drawElements: function (mode, count) { log.drawElements++; log.tris += Math.floor(count / 3); },
    drawArrays: function (mode, first, count) { log.drawArrays++; log.verts += count; }
  };
  var cache = {};
  var gl = new Proxy({
    canvas: null,
    log: log,
    shaders: log.shaders
  }, {
    get: function (t, prop) {
      if (typeof prop !== 'string') return undefined;
      if (Object.prototype.hasOwnProperty.call(t, prop)) return t[prop];
      if (overrides[prop]) { t[prop] = overrides[prop]; return overrides[prop]; }
      if (/^[A-Z0-9_]+$/.test(prop)) {          /* enum constant */
        var v = 0x1000 + (prop.length * 31 + prop.charCodeAt(0));
        t[prop] = v; return v;
      }
      var fn = function () { log.calls[prop] = (log.calls[prop] || 0) + 1; return undefined; };
      t[prop] = fn; return fn;
    },
    set: function (t, p, v) { t[p] = v; return true; }
  });
  return gl;
}

function makeLog() {
  return { calls: {}, shaders: [], drawElements: 0, drawArrays: 0, tris: 0, verts: 0, bufferData: 0, bufferBytes: 0, texImage2D: 0 };
}

/* --------------------------------- window ------------------------------- */
function createEnv(html) {
  var log = makeLog();
  var ids = {};
  var missingIds = [];
  var fromHtml = /id="([^"]+)"/g, m;
  while ((m = fromHtml.exec(html || ''))) {
    var tag = /<(canvas)[^>]*id="([^"]+)"/.test(html) && m[1] === 'game' ? 'canvas' : 'div';
    ids[m[1]] = makeElement(m[1], m[1] === 'game' ? 'canvas' : 'div');
  }
  var body = makeElement('__body', 'body');
  var doc = {
    readyState: 'complete',
    body: body,
    documentElement: makeElement('__html', 'html'),
    activeElement: body,
    pointerLockElement: null,
    getElementById: function (id) {
      if (ids[id]) return ids[id];
      if (missingIds.indexOf(id) < 0) missingIds.push(id);
      return null;
    },
    createElement: function (tag) { var e = makeElement('', tag); e.ownerDocument = doc; return e; },
    createTextNode: function (t) { return { nodeType: 3, textContent: t }; },
    _listeners: {},
    addEventListener: function (t, fn) { (doc._listeners[t] = doc._listeners[t] || []).push(fn); },
    removeEventListener: function (t, fn) {
      var a = doc._listeners[t]; if (!a) return;
      var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
    },
    dispatchEvent: function (e) { return true; },
    dispatch: function (type, ev) {
      var a = doc._listeners[type]; if (!a || !a.length) return 0;
      ev = ev || {};
      if (!ev.target) ev.target = doc.body;
      if (!ev.preventDefault) ev.preventDefault = function () { ev.defaultPrevented = true; };
      if (!ev.stopPropagation) ev.stopPropagation = function () { };
      if (!ev.composedPath) ev.composedPath = function () { return [ev.target]; };
      for (var i = 0; i < a.length; i++) a[i](ev);
      return a.length;
    },
    querySelector: function () { return null; }, querySelectorAll: function () { return []; },
    exitPointerLock: function () { doc.pointerLockElement = null; },
    mozExitPointerLock: function () { doc.pointerLockElement = null; },
    webkitExitPointerLock: function () { doc.pointerLockElement = null; }
  };
  ids.__body = body;

  var raf = [];
  var timers = [];
  var clock = { t: 0 };
  var store = {};
  var win = {
    document: doc,
    performance: { now: function () { return clock.t; } },
    requestAnimationFrame: function (fn) { raf.push(fn); return raf.length; },
    cancelAnimationFrame: function () { },
    setTimeout: function (fn, ms) { timers.push({ fn: fn, at: clock.t + (ms || 0) }); return timers.length; },
    clearTimeout: function () { },
    setInterval: function () { return 0; }, clearInterval: function () { },
    addEventListener: function (t, fn) { (win._l[t] = win._l[t] || []).push(fn); },
    removeEventListener: function () { },
    _l: {},
    devicePixelRatio: 1,
    innerWidth: 1280, innerHeight: 720,
    console: console,
    Math: Math, Date: Date, JSON: JSON, Set: Set, Map: Map,
    Uint8Array: Uint8Array, Uint16Array: Uint16Array, Uint32Array: Uint32Array,
    Int16Array: Int16Array, Int32Array: Int32Array, Float32Array: Float32Array,
    Array: Array, Object: Object, String: String, Number: Number, Boolean: Boolean,
    Error: Error, TypeError: TypeError, RegExp: RegExp, isNaN: isNaN, parseInt: parseInt,
    parseFloat: parseFloat, Infinity: Infinity, NaN: NaN, undefined: undefined,
    localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem: function (k, v) { store[k] = String(v); },
      removeItem: function (k) { delete store[k]; },
      clear: function () { store = {}; }
    },
    Blob: function (parts, opts) { this.parts = parts; this.type = (opts && opts.type) || ''; },
    URL: { createObjectURL: function () { return 'blob:fake'; }, revokeObjectURL: function () { } },
    FileReader: function () { },
    alert: function () { },
    matchMedia: function () { return { matches: false, addListener: function () { }, addEventListener: function () { } }; }
  };
  win.window = win;
  win.globalThis = win;
  win.self = win;

  /* canvas element wiring */
  var canvas = ids.game;
  if (canvas) {
    canvas.clientWidth = 1280; canvas.clientHeight = 720;
    canvas.width = 1280; canvas.height = 720;
    canvas.requestPointerLock = function () { doc.pointerLockElement = canvas; };
    canvas.mozRequestPointerLock = canvas.requestPointerLock;
    canvas.webkitRequestPointerLock = canvas.requestPointerLock;
    canvas.getContext = function (kind) {
      if (kind !== 'webgl2') return null;
      var gl = makeGL(log); gl.canvas = canvas; return gl;
    };
  }

  var env = {
    win: win, doc: doc, ids: ids, log: log, missingIds: missingIds,
    raf: raf, timers: timers, clock: clock, canvas: canvas,
    /* advance the fake clock and pump one animation frame */
    frame: function (dtMs) {
      clock.t += (dtMs === undefined ? 16 : dtMs);
      /* fire due timers first */
      var due = [];
      for (var i = 0; i < timers.length; i++) if (timers[i].at <= clock.t) due.push(timers.splice(i--, 1)[0]);
      for (var j = 0; j < due.length; j++) due[j].fn();
      var q = raf.splice(0, raf.length);
      for (var k = 0; k < q.length; k++) q[k](clock.t);
      return q.length;
    },
    pump: function (frames, dtMs) {
      for (var i = 0; i < frames; i++) env.frame(dtMs);
    }
  };
  return env;
}

module.exports = { createEnv: createEnv, makeElement: makeElement, makeLog: makeLog };
