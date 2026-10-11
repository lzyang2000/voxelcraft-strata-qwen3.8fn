/* Fixed-pool voxel particles (block break chunks, hit puffs, water splash).
 * Contract: MC.Particles.  Ring buffer, zero per-frame allocation. */
(function (root) {
  'use strict';
  var MC = (root.MC = root.MC || {});
  var C = MC.C;

  var GRAVITY = 24;          /* particles fall a touch slower than the player */
  var LIFE = 1.2;            /* seconds until a particle expires */
  var REST = 0.06;           /* speed below which a resting particle sleeps */

  function Particles(max) {
    this.max = max > 0 ? max : 600;
    this.pool = new Array(this.max);
    for (var i = 0; i < this.max; i++) {
      this.pool[i] = {
        pos: [0, 0, 0], vel: [0, 0, 0], color: [0, 0, 0],
        size: 0.08, life: 0, maxLife: LIFE, resting: false
      };
    }
    this.head = 0;
    this.live = 0;
    this._list = [];
    this.rng = new MC.RNG(0x9e3779b9);
  }

  /* Grab the next slot, overwriting the oldest particle when full. */
  Particles.prototype._alloc = function () {
    var p = this.pool[this.head];
    this.head = (this.head + 1) % this.max;
    if (p.life > 0) this.live--;      /* evicted early */
    p.life = LIFE * (0.75 + this.rng.next() * 0.5);
    p.maxLife = p.life;
    p.resting = false;
    this.live++;
    return p;
  };

  function tint(p, col, rng) {
    var j = 0.85 + rng.next() * 0.3;
    p.color[0] = Math.min(1, col[0] * j);
    p.color[1] = Math.min(1, col[1] * j);
    p.color[2] = Math.min(1, col[2] * j);
  }

  Particles.prototype.spawnBlockBreak = function (x, y, z, blockId, count) {
    var col = MC.block(blockId).color;
    var n = count > 0 ? count : 14;
    for (var i = 0; i < n; i++) {
      var p = this._alloc();
      p.pos[0] = x + 0.08 + this.rng.next() * 0.84;
      p.pos[1] = y + 0.08 + this.rng.next() * 0.84;
      p.pos[2] = z + 0.08 + this.rng.next() * 0.84;
      p.vel[0] = (this.rng.next() - 0.5) * 4.2;
      p.vel[1] = 1.6 + this.rng.next() * 3.4;
      p.vel[2] = (this.rng.next() - 0.5) * 4.2;
      p.size = 0.055 + this.rng.next() * 0.075;
      tint(p, col, this.rng);
    }
    return n;
  };

  /* Small puff right on the face that was clicked. */
  Particles.prototype.spawnHit = function (x, y, z, blockId) {
    var col = MC.block(blockId).color;
    for (var i = 0; i < 4; i++) {
      var p = this._alloc();
      p.pos[0] = x + 0.15 + this.rng.next() * 0.7;
      p.pos[1] = y + 0.15 + this.rng.next() * 0.7;
      p.pos[2] = z + 0.15 + this.rng.next() * 0.7;
      p.vel[0] = (this.rng.next() - 0.5) * 2.2;
      p.vel[1] = 0.8 + this.rng.next() * 1.8;
      p.vel[2] = (this.rng.next() - 0.5) * 2.2;
      p.size = 0.04 + this.rng.next() * 0.04;
      p.life = p.maxLife = 0.35 + this.rng.next() * 0.25;
      tint(p, col, this.rng);
    }
    return 4;
  };

  Particles.prototype.spawnSplash = function (x, y, z) {
    var col = MC.block(MC.WATER_ID).color;
    for (var i = 0; i < 10; i++) {
      var p = this._alloc();
      p.pos[0] = x + this.rng.next();
      p.pos[1] = y + 0.55 + this.rng.next() * 0.35;
      p.pos[2] = z + this.rng.next();
      var a = this.rng.next() * Math.PI * 2;
      var r = 1.2 + this.rng.next() * 1.8;
      p.vel[0] = Math.cos(a) * r;
      p.vel[1] = 2.6 + this.rng.next() * 2.6;
      p.vel[2] = Math.sin(a) * r;
      p.size = 0.04 + this.rng.next() * 0.05;
      p.life = p.maxLife = 0.6 + this.rng.next() * 0.5;
      tint(p, col, this.rng);
    }
    return 10;
  };

  /* One axis-resolved step; returns true when the particle hit something. */
  function blocked(world, x, y, z) {
    return world && world.isSolidAt(Math.floor(x), Math.floor(y), Math.floor(z));
  }

  Particles.prototype.update = function (dt, world) {
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;
    var pool = this.pool;
    for (var i = 0; i < this.max; i++) {
      var p = pool[i];
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) { this.live--; continue; }
      if (p.resting) {
        p.vel[0] = 0; p.vel[1] = 0; p.vel[2] = 0;
        continue;
      }
      p.vel[1] -= GRAVITY * dt;
      if (p.vel[1] < -(C ? C.TERMINAL_FALL : 55)) p.vel[1] = -(C ? C.TERMINAL_FALL : 55);

      var nx = p.pos[0] + p.vel[0] * dt;
      var ny = p.pos[1] + p.vel[1] * dt;
      var nz = p.pos[2] + p.vel[2] * dt;

      /* axis-separated so chunks slide along walls instead of sticking */
      if (blocked(world, nx, p.pos[1], p.pos[2])) { p.vel[0] *= -0.25; nx = p.pos[0]; }
      if (blocked(world, p.pos[0], p.pos[1], nz)) { p.vel[2] *= -0.25; nz = p.pos[2]; }
      if (blocked(world, p.pos[0], ny, p.pos[2])) {
        if (p.vel[1] < 0) {
          p.vel[1] = 0;
          p.vel[0] *= 0.6; p.vel[2] *= 0.6;
          if (Math.abs(p.vel[0]) < REST && Math.abs(p.vel[2]) < REST) p.resting = true;
        } else {
          p.vel[1] *= -0.3;
        }
        ny = p.pos[1];
      }
      p.pos[0] = nx; p.pos[1] = ny; p.pos[2] = nz;

      /* fell out of the world -> retire */
      if (p.pos[1] < -8) { p.life = 0; this.live--; }
    }
    if (this.live < 0) this.live = 0;
  };

  /* Reuses one array; the objects are the pool's own (renderer reads them). */
  Particles.prototype.list = function () {
    var out = this._list;
    out.length = 0;
    var pool = this.pool;
    for (var i = 0; i < this.max; i++) {
      if (pool[i].life > 0) out.push(pool[i]);
    }
    return out;
  };

  Particles.prototype.clear = function () {
    for (var i = 0; i < this.max; i++) this.pool[i].life = 0;
    this.live = 0;
    this.head = 0;
    this._list.length = 0;
  };

  Particles.prototype.count = function () {
    var n = 0, pool = this.pool;
    for (var i = 0; i < this.max; i++) if (pool[i].life > 0) n++;
    return n;
  };

  MC.Particles = Particles;
})(typeof window !== 'undefined' ? window : globalThis);
