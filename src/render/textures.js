/* Procedural texture atlas for Voxelcraft.
 * Pure JS (no canvas, no DOM, no files) so it runs identically in Node and the
 * browser. MC.Textures.generate() -> { width, height, pixels:Uint8Array(RGBA8) }
 *
 * Tile index i (order of MC.TILES) sits at col = i % ATLAS_COLS,
 * row = floor(i / ATLAS_COLS). Row 0 is the FIRST row uploaded (no flip).
 * Every RNG/Noise is seeded from a fixed constant + tile index, so the output
 * is byte-identical on every run.
 *
 * Loaded after constants.js, math.js, blocks.js. */
(function (root) {
  'use strict';
  var MC = (root.MC = root.MC || {});

  function c255(v) {
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    return (v + 0.5) | 0;   /* round, not truncate: lerps must reach 255 */
  }

  /* ------------------------------ painter ------------------------------ */
  function TilePainter(buf, W, T, ox, oy, ti) {
    this.buf = buf; this.W = W; this.T = T; this.ox = ox; this.oy = oy;
    this.rng = new MC.RNG((0x9e3779b1 ^ Math.imul(ti + 1, 0x85ebca6b)) >>> 0);
    this.noise = new MC.Noise((0x51ed2701 ^ Math.imul(ti + 7, 0x27d4eb2f)) >>> 0);
  }

  TilePainter.prototype.px = function (x, y, r, g, b, a) {
    x = x | 0; y = y | 0;
    if (x < 0 || y < 0 || x >= this.T || y >= this.T) return;
    var i = ((this.oy + y) * this.W + (this.ox + x)) * 4;
    this.buf[i] = c255(r);
    this.buf[i + 1] = c255(g);
    this.buf[i + 2] = c255(b);
    this.buf[i + 3] = c255(a === undefined ? 255 : a);
  };

  TilePainter.prototype.fill = function (r, g, b, a) {
    for (var y = 0; y < this.T; y++) {
      for (var x = 0; x < this.T; x++) this.px(x, y, r, g, b, a);
    }
  };

  /* base colour + per-pixel value-noise/grain variation */
  TilePainter.prototype.mottle = function (r, g, b, amp, scale, a) {
    if (scale === undefined) scale = 0.6;
    for (var y = 0; y < this.T; y++) {
      for (var x = 0; x < this.T; x++) {
        var n = (this.noise.value2(x * scale + 11.3, y * scale + 7.7) - 0.5) * 2 * amp;
        var m = (this.rng.next() - 0.5) * amp * 0.6;
        this.px(x, y, r + n + m, g + n + m, b + n * 0.8 + m, a);
      }
    }
  };

  TilePainter.prototype.get = function (x, y) {
    x = x | 0; y = y | 0;
    if (x < 0 || y < 0 || x >= this.T || y >= this.T) return [0, 0, 0, 0];
    var i = ((this.oy + y) * this.W + (this.ox + x)) * 4;
    return [this.buf[i], this.buf[i + 1], this.buf[i + 2], this.buf[i + 3]];
  };

  /* soft filled disc: the rim blends toward whatever is already there,
   * it never fades to black. */
  TilePainter.prototype.blob = function (cx, cy, r, cr, cg, cb, a) {
    var x0 = Math.floor(cx - r - 1), x1 = Math.ceil(cx + r + 1);
    var y0 = Math.floor(cy - r - 1), y1 = Math.ceil(cy + r + 1);
    for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) {
        var dx = x - cx, dy = y - cy;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d <= r) { this.px(x, y, cr, cg, cb, a); continue; }
        if (d > r + 0.75) continue;
        var t = (d - r) / 0.75;                    /* 0 = blob, 1 = existing */
        var cur = this.get(x, y);
        var ca = a === undefined ? 255 : a;
        this.px(x, y,
          cr * (1 - t) + cur[0] * t,
          cg * (1 - t) + cur[1] * t,
          cb * (1 - t) + cur[2] * t,
          ca * (1 - t) + cur[3] * t);
      }
    }
  };

  TilePainter.prototype.rect = function (x0, y0, x1, y1, r, g, b, a) {
    for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) this.px(x, y, r, g, b, a);
    }
  };

  /* jittered cell grid -> returns {cell, edge} per pixel (used by cobble/gravel) */
  TilePainter.prototype.cells = function (n, jitter) {
    var T = this.T, step = T / n, cs = [], i, j;
    for (j = 0; j < n; j++) {
      for (i = 0; i < n; i++) {
        cs.push([
          i * step + step * 0.5 + this.rng.range(-jitter, jitter),
          j * step + step * 0.5 + this.rng.range(-jitter, jitter),
          this.rng.next()
        ]);
      }
    }
    var out = [];
    for (var y = 0; y < T; y++) {
      for (var x = 0; x < T; x++) {
        var bi = -1, bd = 1e9, b2 = 1e9;
        for (var k = 0; k < cs.length; k++) {
          var dx = x + 0.5 - cs[k][0], dy = y + 0.5 - cs[k][1];
          var d = Math.sqrt(dx * dx + dy * dy);
          if (d < bd) { b2 = bd; bd = d; bi = k; }
          else if (d < b2) b2 = d;
        }
        out.push({ cell: bi, d: bd, gap: b2 - bd, v: cs[bi][2] });
      }
    }
    return { list: out, n: n, cs: cs };
  };

  /* --------------------------- shared bases ---------------------------- */
  function stoneBase(p) {
    p.mottle(130, 130, 136, 13, 0.45);
    for (var i = 0; i < 9; i++) {
      var cx = p.rng.range(1.5, 14.5), cy = p.rng.range(1.5, 14.5);
      var r = p.rng.range(1.1, 2.5);
      p.blob(cx, cy, r, 112, 112, 118);
      p.blob(cx, cy, r * 0.5, 148, 148, 155);
    }
    for (var j = 0; j < 22; j++) {
      var x = p.rng.int(0, 15), y = p.rng.int(0, 15);
      p.px(x, y, 152, 152, 158);
    }
  }

  function ore(p, cr, cg, cb, blobs) {
    stoneBase(p);
    for (var i = 0; i < blobs; i++) {
      var cx = p.rng.range(2.5, 13.5), cy = p.rng.range(2.5, 13.5);
      var r = p.rng.range(1.4, 2.4);
      p.blob(cx, cy, r + 0.5, cr * 0.45, cg * 0.45, cb * 0.45);
      p.blob(cx, cy, r, cr, cg, cb);
      p.blob(cx - r * 0.3, cy - r * 0.3, r * 0.45,
        Math.min(255, cr * 1.35), Math.min(255, cg * 1.35), Math.min(255, cb * 1.35));
    }
  }

  function metalPanel(p, r, g, b) {
    p.mottle(r, g, b, 10, 0.35);
    /* border */
    for (var i = 0; i < 16; i++) {
      p.px(i, 0, r * 0.62, g * 0.62, b * 0.62);
      p.px(i, 15, r * 0.55, g * 0.55, b * 0.55);
      p.px(0, i, r * 0.62, g * 0.62, b * 0.62);
      p.px(15, i, r * 0.55, g * 0.55, b * 0.55);
      p.px(i, 1, r * 0.86, g * 0.86, b * 0.86);
      p.px(1, i, r * 0.88, g * 0.88, b * 0.88);
    }
    /* diagonal sheen */
    for (var k = 2; k < 15; k++) {
      p.px(k, k, r * 1.12, g * 1.12, b * 1.14);
      p.px(k + 1, k, r * 1.05, g * 1.05, b * 1.07);
    }
    /* rivets */
    p.blob(3.5, 12.5, 1.1, r * 0.7, g * 0.7, b * 0.72);
    p.blob(12.5, 3.5, 1.1, r * 0.7, g * 0.7, b * 0.72);
  }

  /* ------------------------------ painters ----------------------------- */
  var PAINTERS = {
    grass_top: function (p) {
      p.mottle(96, 152, 66, 24, 0.55);
      var i, x, y;
      for (i = 0; i < 30; i++) {
        x = p.rng.int(0, 15); y = p.rng.int(0, 15);
        var d = p.rng.range(-18, 8);
        p.px(x, y, 84 + d, 138 + d, 56 + d);
      }
      for (i = 0; i < 22; i++) {
        x = p.rng.int(0, 15); y = p.rng.int(0, 15);
        p.px(x, y, 122, 178, 84);
      }
      for (i = 0; i < 10; i++) {
        x = p.rng.int(0, 15); y = p.rng.int(0, 15);
        p.px(x, y, 70, 118, 48);
      }
    },

    grass_side: function (p) {
      p.mottle(128, 94, 62, 18, 0.7);
      for (var x = 0; x < 16; x++) {
        var d = 4 + (p.noise.value2(x * 0.9, 3.1) > 0.5 ? 1 : 0) +
          (p.rng.next() > 0.7 ? 1 : 0);
        for (var y = 0; y < d; y++) {
          var n = (p.rng.next() - 0.5) * 30;
          p.px(x, y, 92 + n, 148 + n, 62 + n);
        }
        var s = (p.rng.next() - 0.5) * 12;
        p.px(x, d, 74 + s, 116 + s, 50 + s);
      }
    },

    dirt: function (p) {
      p.mottle(128, 94, 62, 20, 0.7);
      for (var i = 0; i < 16; i++) {
        var x = p.rng.int(0, 15), y = p.rng.int(0, 15);
        p.px(x, y, 104, 74, 46);
      }
      for (var j = 0; j < 12; j++) {
        var a = p.rng.int(0, 15), b = p.rng.int(0, 15);
        p.px(a, b, 150, 112, 76);
      }
    },

    stone: function (p) { stoneBase(p); },

    cobblestone: function (p) {
      p.fill(74, 74, 78);                         /* mortar */
      var g = p.cells(4, 1.05);
      for (var i = 0; i < g.list.length; i++) {
        var c = g.list[i];
        var x = i % 16, y = (i / 16) | 0;
        if (c.d > 2.95) continue;                 /* rounded gap stays dark */
        var s = 126 + c.v * 40;
        if (c.d > 2.5) s -= 26;                   /* rim shading */
        p.px(x, y, s, s, s + 5);
        /* top-left highlight on each cobble */
        if (c.d < 1.6 && x < g.cs[c.cell][0] && y < g.cs[c.cell][1]) {
          p.px(x, y, s + 30, s + 30, s + 34);
        }
      }
    },

    sand: function (p) {
      p.mottle(222, 208, 158, 12, 0.8);
      for (var i = 0; i < 26; i++) {
        var x = p.rng.int(0, 15), y = p.rng.int(0, 15);
        p.px(x, y, 205, 188, 136);
      }
      for (var j = 0; j < 18; j++) {
        var a = p.rng.int(0, 15), b = p.rng.int(0, 15);
        p.px(a, b, 238, 226, 182);
      }
    },

    sandstone_side: function (p) {
      for (var y = 0; y < 16; y++) {
        var band = 1 + 0.09 * Math.sin(y * 1.15 + 0.6) + (y % 4 === 0 ? -0.07 : 0);
        for (var x = 0; x < 16; x++) {
          var n = (p.noise.value2(x * 0.8, y * 0.35) - 0.5) * 16;
          p.px(x, y, 214 * band + n, 200 * band + n, 148 * band + n * 0.7);
        }
      }
      for (var i = 0; i < 16; i++) { p.px(i, 0, 186, 172, 122); p.px(i, 15, 178, 164, 116); }
    },

    sandstone_top: function (p) {
      p.mottle(218, 204, 152, 12, 0.5);
      for (var y = 0; y < 16; y++) {
        for (var x = 0; x < 16; x++) {
          var dx = x - 7.5, dy = y - 7.5;
          var d = Math.sqrt(dx * dx + dy * dy);
          var ring = Math.sin(d * 1.5) * 9;
          p.px(x, y, 218 + ring, 204 + ring, 152 + ring * 0.8);
        }
      }
    },

    water: function (p) {
      for (var y = 0; y < 16; y++) {
        for (var x = 0; x < 16; x++) {
          var w = Math.sin(x * 0.85 + Math.sin(y * 0.62) * 1.4 + y * 0.25);
          var n = (p.noise.value2(x * 0.55, y * 0.55) - 0.5) * 18;
          var l = w * 16 + n;
          p.px(x, y, 44 + l * 0.6, 104 + l, 196 + l * 0.9, 190);
        }
      }
      /* bright wave streaks */
      for (var i = 0; i < 5; i++) {
        var yy = p.rng.int(1, 14), xx = p.rng.int(0, 6);
        for (var k = 0; k < 5; k++) p.px(xx + k, yy, 96, 152, 226, 200);
      }
    },

    log_side: function (p) {
      for (var x = 0; x < 16; x++) {
        var stripe = (x % 4 === 0) ? -22 : (x % 4 === 2 ? 10 : 0);
        for (var y = 0; y < 16; y++) {
          var n = (p.noise.value2(x * 0.35, y * 1.1) - 0.5) * 22;
          p.px(x, y, 108 + stripe + n, 78 + stripe * 0.8 + n * 0.8, 44 + stripe * 0.6 + n * 0.5);
        }
      }
      /* knots */
      for (var i = 0; i < 3; i++) {
        var cx = p.rng.range(2, 13), cy = p.rng.range(2, 13);
        p.blob(cx, cy, 1.5, 74, 52, 28);
        p.blob(cx, cy, 0.7, 96, 68, 38);
      }
    },

    log_top: function (p) {
      for (var y = 0; y < 16; y++) {
        for (var x = 0; x < 16; x++) {
          var dx = x - 7.5, dy = y - 7.5;
          var d = Math.sqrt(dx * dx + dy * dy);
          var n = (p.noise.value2(x * 0.7, y * 0.7) - 0.5) * 12;
          if (d > 6.9) { p.px(x, y, 92 + n, 66 + n, 38 + n); continue; }
          var ring = Math.sin(d * 2.3) * 0.5 + 0.5;
          p.px(x, y, 150 + ring * 40 + n, 116 + ring * 32 + n, 66 + ring * 20 + n * 0.6);
        }
      }
      p.blob(7.5, 7.5, 1.0, 118, 88, 50);
    },

    leaves: function (p) {
      for (var y = 0; y < 16; y++) {
        for (var x = 0; x < 16; x++) {
          var n = p.noise.value2(x * 0.9 + 3.3, y * 0.9 + 5.1);
          var hole = p.noise.value2(x * 1.7 + 21.0, y * 1.7 + 9.4) * 0.5 +
            p.rng.next() * 0.5;
          if (hole > LEAF_HOLE) { p.px(x, y, 0, 0, 0, 0); continue; }
          var v = (n - 0.5) * 60;
          p.px(x, y, 44 + v * 0.5, 108 + v, 38 + v * 0.4);
          if (n > 0.72) p.px(x, y, 78 + v * 0.4, 150 + v * 0.6, 60 + v * 0.4);
          if (n < 0.28) p.px(x, y, 26 + v * 0.3, 68 + v * 0.5, 24 + v * 0.3);
        }
      }
    },

    planks: function (p) {
      for (var y = 0; y < 16; y++) {
        var board = (y / 4) | 0;
        var gap = (y % 4 === 3);
        var seamX = (board * 6 + 4) % 16;
        for (var x = 0; x < 16; x++) {
          var seam = (x === seamX);
          /* long horizontal grain streaks */
          var n = (p.noise.value2(x * 0.35, y * 2.2 + board * 7) - 0.5) * 26;
          if (gap || seam) { p.px(x, y, 92 + n * 0.4, 66 + n * 0.4, 36 + n * 0.3); continue; }
          var tint = board % 2 === 0 ? 0 : -10;
          var top = (y % 4 === 0) ? 14 : 0;       /* lit top edge of each board */
          p.px(x, y, 178 + n + tint + top, 132 + n + tint + top, 74 + n * 0.7 + tint + top * 0.6);
        }
      }
    },

    glass: function (p) {
      p.fill(205, 226, 236, 35);
      for (var i = 0; i < 16; i++) {
        p.px(i, 0, 196, 218, 228, 215);
        p.px(i, 15, 196, 218, 228, 215);
        p.px(0, i, 196, 218, 228, 215);
        p.px(15, i, 196, 218, 228, 215);
      }
      /* diagonal highlight */
      for (var k = 2; k < 11; k++) {
        p.px(k, 15 - k, 245, 252, 255, 150);
        p.px(k + 1, 15 - k, 240, 248, 255, 90);
      }
      for (var j = 3; j < 8; j++) p.px(15 - j, j, 240, 248, 255, 110);
    },

    bedrock: function (p) {
      for (var y = 0; y < 16; y++) {
        for (var x = 0; x < 16; x++) {
          var n = p.noise.value2(x * 1.6, y * 1.6);
          var v = 34 + n * 78 + (p.rng.next() - 0.5) * 26;
          var warm = p.noise.value2(x * 0.7 + 40, y * 0.7 + 17) > 0.62 ? 10 : 0;
          p.px(x, y, v + warm, v, v + warm * 0.4);
        }
      }
    },

    gravel: function (p) {
      p.fill(74, 72, 70);
      var g = p.cells(5, 1.0);
      for (var i = 0; i < g.list.length; i++) {
        var c = g.list[i];
        if (c.gap < 0.55) continue;
        var base = 96 + c.v * 70;
        var x = i % 16, y = (i / 16) | 0;
        p.px(x, y, base, base - 4, base - 10);
        if (c.d < 0.8) p.px(x, y, base + 26, base + 24, base + 18);
      }
    },

    coal_ore: function (p) { ore(p, 40, 40, 44, 3); },
    iron_ore: function (p) { ore(p, 214, 172, 140, 3); },
    gold_ore: function (p) { ore(p, 248, 214, 96, 3); },
    diamond_ore: function (p) { ore(p, 108, 226, 232, 3); },

    snow_top: function (p) {
      p.mottle(240, 245, 250, 8, 0.7);
      for (var i = 0; i < 24; i++) {
        var x = p.rng.int(0, 15), y = p.rng.int(0, 15);
        p.px(x, y, 214, 230, 246);
      }
      for (var j = 0; j < 14; j++) {
        var a = p.rng.int(0, 15), b = p.rng.int(0, 15);
        p.px(a, b, 252, 253, 255);
      }
    },

    brick: function (p) {
      p.fill(196, 186, 176);                       /* mortar */
      for (var y = 0; y < 16; y++) {
        var row = (y / 4) | 0;
        var off = row % 2 === 0 ? 0 : 4;
        for (var x = 0; x < 16; x++) {
          if (y % 4 === 3) continue;
          if ((x + off) % 8 === 7) continue;
          var n = (p.noise.value2(x * 0.9, y * 0.9 + row * 3) - 0.5) * 26;
          p.px(x, y, 158 + n, 78 + n * 0.6, 60 + n * 0.5);
        }
      }
    },

    glowstone: function (p) {
      p.mottle(214, 172, 96, 20, 0.8);
      for (var i = 0; i < 12; i++) {
        var x = p.rng.int(0, 15), y = p.rng.int(0, 15);
        p.px(x, y, 150, 112, 62);
      }
      for (var j = 0; j < 26; j++) {
        var a = p.rng.int(0, 15), b = p.rng.int(0, 15);
        p.px(a, b, 255, 244, 196);
        if (p.rng.next() > 0.5) p.px(a + 1, b, 250, 232, 170);
      }
    },

    obsidian: function (p) {
      p.mottle(26, 22, 38, 10, 0.5);
      for (var i = 0; i < 7; i++) {
        var cx = p.rng.range(2, 13), cy = p.rng.range(2, 13);
        p.blob(cx, cy, p.rng.range(1.2, 2.4), 58, 40, 92);
      }
      for (var j = 0; j < 16; j++) {
        var x = p.rng.int(0, 15), y = p.rng.int(0, 15);
        p.px(x, y, 118, 96, 168);
      }
    },

    cactus_side: function (p) {
      p.mottle(62, 138, 62, 16, 0.6);
      for (var y = 0; y < 16; y++) {
        p.px(2, y, 40, 104, 44);
        p.px(13, y, 40, 104, 44);
        p.px(3, y, 52, 120, 52);
        p.px(12, y, 52, 120, 52);
      }
      /* small spikes */
      for (var i = 0; i < 9; i++) {
        var x = p.rng.int(4, 11), yy = p.rng.int(1, 14);
        p.px(x, yy, 214, 232, 190);
        p.px(x, yy + 1, 176, 200, 156);
      }
    },

    cactus_top: function (p) {
      p.mottle(58, 130, 58, 14, 0.7);
      for (var i = 0; i < 16; i++) {
        p.px(i, 0, 40, 96, 42); p.px(i, 15, 40, 96, 42);
        p.px(0, i, 40, 96, 42); p.px(15, i, 40, 96, 42);
      }
      p.blob(7.5, 7.5, 4.2, 86, 162, 80);
      p.blob(7.5, 7.5, 2.2, 112, 186, 100);
    },

    clay: function (p) {
      p.mottle(154, 160, 174, 9, 0.4);
      for (var i = 0; i < 10; i++) {
        var x = p.rng.int(0, 15), y = p.rng.int(0, 15);
        p.px(x, y, 136, 142, 158);
      }
    },

    stone_bricks: function (p) {
      p.fill(86, 86, 90);                          /* mortar */
      for (var y = 0; y < 16; y++) {
        var row = (y / 8) | 0;
        var off = row % 2 === 0 ? 0 : 4;
        for (var x = 0; x < 16; x++) {
          if (y % 8 === 7) continue;
          if ((x + off) % 8 === 7) continue;
          var n = (p.noise.value2(x * 0.8, y * 0.8 + row * 5) - 0.5) * 22;
          p.px(x, y, 126 + n, 126 + n, 130 + n);
        }
      }
    },

    iron_block: function (p) { metalPanel(p, 208, 208, 214); },
    gold_block: function (p) { metalPanel(p, 240, 206, 96); },

    bedrock_smooth: function (p) {
      for (var y = 0; y < 16; y++) {
        var g = 46 + y * 2.2;
        for (var x = 0; x < 16; x++) {
          var n = (p.noise.value2(x * 0.5, y * 0.5) - 0.5) * 14;
          p.px(x, y, g + n, g + n * 0.95, g + 6 + n);
        }
      }
      for (var i = 0; i < 16; i++) {
        p.px(i, 0, 40, 40, 46); p.px(i, 15, 66, 66, 72);
        p.px(0, i, 44, 44, 50); p.px(15, i, 62, 62, 68);
      }
    },

    wheat: function (p) {
      /* dark soil backdrop so the tile stays fully opaque */
      p.mottle(74, 56, 36, 14, 0.9);
      var stalks = [2, 6, 10, 14];
      for (var s = 0; s < stalks.length; s++) {
        var x = stalks[s];
        var top = 2 + (s % 2);
        for (var y = 15; y >= top; y--) {
          var n = (p.rng.next() - 0.5) * 14;
          p.px(x, y, 176 + n, 168 + n, 96 + n);
        }
        /* grain head */
        for (var k = 0; k < 4; k++) {
          var yy = top + k;
          p.px(x - 1, yy, 216, 202, 122);
          p.px(x + 1, yy, 206, 192, 112);
          p.px(x, yy, 232, 218, 140);
        }
        p.px(x, top - 1, 240, 228, 156);
      }
    }
  };

  /* hole threshold tuned so leaves land near 18% fully transparent pixels */
  var LEAF_HOLE = 0.68;

  /* Fallback so a future tile name never leaves a blank hole. */
  function fallbackTile(p) {
    p.mottle(190, 60, 190, 18, 0.7);
  }

  MC.Textures = {};
  MC.Textures.generate = function () {
    var C = MC.C;
    var cols = C.ATLAS_COLS, rows = C.ATLAS_ROWS, T = C.ATLAS_TILE_PX;
    var W = cols * T, H = rows * T;
    var px = new Uint8Array(W * H * 4);
    var names = MC.TILES;
    for (var ti = 0; ti < names.length; ti++) {
      var tr = (ti / cols) | 0;
      if (tr >= rows) break;
      var ox = (ti % cols) * T, oy = tr * T;
      var p = new TilePainter(px, W, T, ox, oy, ti);
      var fn = PAINTERS[names[ti]];
      if (fn) fn(p); else fallbackTile(p);
    }
    return { width: W, height: H, pixels: px };
  };
})(typeof window !== 'undefined' ? window : globalThis);
