/* Small linear-algebra + helper library. Column-major mat4 (GL layout).
 * Contract: MC.M4, MC.V3, MC.AABB, MC.Util, MC.RNG, MC.Noise */
(function (root) {
  'use strict';
  var MC = (root.MC = root.MC || {});

  /* ---------------- mat4 (column major, Float32Array len 16) ------------- */
  var M4 = {
    create: function () {
      var m = new Float32Array(16);
      m[0] = m[5] = m[10] = m[15] = 1;
      return m;
    },
    identity: function (o) {
      o = o || M4.create();
      for (var i = 0; i < 16; i++) o[i] = 0;
      o[0] = o[5] = o[10] = o[15] = 1;
      return o;
    },
    perspective: function (o, fovyRad, aspect, near, far) {
      o = o || M4.create();
      var f = 1 / Math.tan(fovyRad / 2), nf = 1 / (near - far);
      for (var i = 0; i < 16; i++) o[i] = 0;
      o[0] = f / aspect; o[5] = f; o[10] = (far + near) * nf;
      o[11] = -1; o[14] = 2 * far * near * nf;
      return o;
    },
    ortho: function (o, l, r, b, t, n, f) {
      o = o || M4.create();
      for (var i = 0; i < 16; i++) o[i] = 0;
      o[0] = 2 / (r - l); o[5] = 2 / (t - b); o[10] = 2 / (n - f);
      o[12] = (r + l) / (l - r); o[13] = (t + b) / (b - t); o[14] = (f + n) / (n - f);
      o[15] = 1;
      return o;
    },
    /* yaw about +Y, pitch about +X (radians). Right-handed, -Z forward.
     *
     * R = Ry(yaw) * Rx(pitch) is the world->camera rotation, and the camera
     * forward it implies is exactly MC.Player.getLook():
     *     forward = R * (0,0,-1) = (-sin(yaw)cos(pitch), sin(pitch),
     *                              -cos(yaw)cos(pitch))
     * The view matrix is V = R^T * T(-p), stored COLUMN-MAJOR for WebGL, so
     * o[c*4+r] = (R^T)[r][c] = R[c][r]. Storing R instead of R^T mirrors the
     * camera in both yaw and pitch (the crosshair then aims somewhere other
     * than the pixels on screen), which is easy to miss at yaw = pitch = 0. */
    view: function (o, px, py, pz, yaw, pitch) {
      o = o || M4.create();
      var cy = Math.cos(yaw), sy = Math.sin(yaw);
      var cp = Math.cos(pitch), sp = Math.sin(pitch);
      var r00 = cy, r01 = sy * sp, r02 = sy * cp;
      var r10 = 0, r11 = cp, r12 = -sp;
      var r20 = -sy, r21 = cy * sp, r22 = cy * cp;
      o[0] = r00; o[1] = r01; o[2] = r02; o[3] = 0;
      o[4] = r10; o[5] = r11; o[6] = r12; o[7] = 0;
      o[8] = r20; o[9] = r21; o[10] = r22; o[11] = 0;
      o[12] = -(r00 * px + r10 * py + r20 * pz);
      o[13] = -(r01 * px + r11 * py + r21 * pz);
      o[14] = -(r02 * px + r12 * py + r22 * pz);
      o[15] = 1;
      return o;
    },
    multiply: function (o, a, b) {
      var t = o && o !== a && o !== b ? o : new Float32Array(16);
      for (var c = 0; c < 4; c++) {
        for (var r = 0; r < 4; r++) {
          t[c * 4 + r] =
            a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] +
            a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
        }
      }
      if (t !== o) for (var i = 0; i < 16; i++) o[i] = t[i];
      return o;
    },
    translate: function (o, x, y, z) {
      M4.identity(o);
      o[12] = x; o[13] = y; o[14] = z;
      return o;
    },
    scale: function (o, x, y, z) {
      M4.identity(o);
      o[0] = x; o[5] = y; o[10] = z;
      return o;
    },
    invert: function (o, a) {
      var a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3],
        a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7],
        a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11],
        a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
      var b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10,
        b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11,
        b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12,
        b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30,
        b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31,
        b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
      var det = b00 * b11 - b01 * b10 + b02 * b09 - b03 * b08 + b04 * b07 - b05 * b06;
      if (!det) return null;
      det = 1 / det;
      o[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
      o[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
      o[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
      o[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
      o[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
      o[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
      o[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
      o[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
      o[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
      o[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
      o[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
      o[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
      o[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
      o[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
      o[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
      o[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
      return o;
    },
    /* Extract the 3x3 rotation part (as mat4) for camera forward/right vectors. */
    forwardFromView: function (m) {
      /* camera looks down -Z in view space -> world forward = -R^T * (0,0,1) */
      return [-m[8], -m[9], -m[10]];
    }
  };
  MC.M4 = M4;

  /* ------------------------------- vec3 ---------------------------------- */
  var V3 = {
    add: function (a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; },
    sub: function (a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; },
    scale: function (a, s) { return [a[0] * s, a[1] * s, a[2] * s]; },
    dot: function (a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; },
    len: function (a) { return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]); },
    norm: function (a) {
      var l = V3.len(a);
      return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
    },
    cross: function (a, b) {
      return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    },
    dist: function (a, b) { return V3.len(V3.sub(a, b)); }
  };
  MC.V3 = V3;

  /* --------------------------- axis aligned box -------------------------- */
  /* box = {min:[x,y,z], max:[x,y,z]} */
  MC.AABB = {
    fromCenter: function (cx, cy, cz, w, h, d) {
      return {
        min: [cx - w / 2, cy, cz - d / 2],
        max: [cx + w / 2, cy + h, cz + d / 2]
      };
    },
    overlaps: function (a, b) {
      return a.min[0] < b.max[0] && a.max[0] > b.min[0] &&
        a.min[1] < b.max[1] && a.max[1] > b.min[1] &&
        a.min[2] < b.max[2] && a.max[2] > b.min[2];
    },
    intersectsVoxel: function (box, x, y, z) {
      return box.min[0] < x + 1 && box.max[0] > x &&
        box.min[1] < y + 1 && box.max[1] > y &&
        box.min[2] < z + 1 && box.max[2] > z;
    }
  };

  /* ------------------------------- utils --------------------------------- */
  MC.Util = {
    clamp: function (v, a, b) { return v < a ? a : v > b ? b : v; },
    lerp: function (a, b, t) { return a + (b - a) * t; },
    smoothstep: function (e0, e1, x) {
      var t = MC.Util.clamp((x - e0) / (e1 - e0 || 1e-6), 0, 1);
      return t * t * (3 - 2 * t);
    },
    wrap: function (v, m) { return ((v % m) + m) % m; },
    key3: function (x, y, z) { return x + ',' + y + ',' + z; },
    parseKey3: function (k) {
      var p = k.split(',');
      return [+p[0], +p[1], +p[2]];
    },
    chunkKey: function (cx, cz) { return cx + ',' + cz; }
  };

  /* ------------------------- deterministic RNG (mulberry32) -------------- */
  MC.RNG = function (seed) {
    this.s = (seed >>> 0) || 1;
  };
  MC.RNG.prototype.next = function () {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    var t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  MC.RNG.prototype.range = function (a, b) { return a + this.next() * (b - a); };
  MC.RNG.prototype.int = function (a, b) { return Math.floor(this.range(a, b + 1)); };
  MC.hashString = function (s) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  };

  /* ------------------- value noise (2D + 3D), seeded, tileable-free ------ */
  MC.Noise = function (seed) {
    this.seed = (seed >>> 0) || 1;
  };
  MC.Noise.prototype.hash2 = function (x, y) {
    var h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= this.seed;
    h = Math.imul(h ^ (h >>> 16), 2246822519);
    return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
  };
  MC.Noise.prototype.hash3 = function (x, y, z) {
    var h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 1274126177);
    h = Math.imul(h ^ (h >>> 13), 2246822519);
    h ^= this.seed;
    h = Math.imul(h ^ (h >>> 16), 3266489917);
    return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
  };
  MC.Noise.prototype.value2 = function (x, y) {
    var xi = Math.floor(x), yi = Math.floor(y);
    var xf = x - xi, yf = y - yi;
    var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    var a = this.hash2(xi, yi), b = this.hash2(xi + 1, yi),
      c = this.hash2(xi, yi + 1), d = this.hash2(xi + 1, yi + 1);
    return MC.Util.lerp(MC.Util.lerp(a, b, u), MC.Util.lerp(c, d, u), v);
  };
  MC.Noise.prototype.value3 = function (x, y, z) {
    var xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    var xf = x - xi, yf = y - yi, zf = z - zi;
    var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
    function h(dx, dy, dz) { return this.hash3(xi + dx, yi + dy, zi + dz); }
    var c000 = h.call(this, 0, 0, 0), c100 = h.call(this, 1, 0, 0),
      c010 = h.call(this, 0, 1, 0), c110 = h.call(this, 1, 1, 0),
      c001 = h.call(this, 0, 0, 1), c101 = h.call(this, 1, 0, 1),
      c011 = h.call(this, 0, 1, 1), c111 = h.call(this, 1, 1, 1);
    var x00 = MC.Util.lerp(c000, c100, u), x10 = MC.Util.lerp(c010, c110, u),
      x01 = MC.Util.lerp(c001, c101, u), x11 = MC.Util.lerp(c011, c111, u);
    return MC.Util.lerp(MC.Util.lerp(x00, x10, v), MC.Util.lerp(x01, x11, v), w);
  };
  MC.Noise.prototype.fbm2 = function (x, y, octaves, lacunarity, gain) {
    lacunarity = lacunarity || 2; gain = gain || 0.5;
    var amp = 1, freq = 1, sum = 0, norm = 0;
    for (var i = 0; i < (octaves || 4); i++) {
      sum += this.value2(x * freq, y * freq) * amp;
      norm += amp; amp *= gain; freq *= lacunarity;
    }
    return sum / norm;
  };
  MC.Noise.prototype.fbm3 = function (x, y, z, octaves, lacunarity, gain) {
    lacunarity = lacunarity || 2; gain = gain || 0.5;
    var amp = 1, freq = 1, sum = 0, norm = 0;
    for (var i = 0; i < (octaves || 4); i++) {
      sum += this.value3(x * freq, y * freq, z * freq) * amp;
      norm += amp; amp *= gain; freq *= lacunarity;
    }
    return sum / norm;
  };
})(typeof window !== 'undefined' ? window : globalThis);
