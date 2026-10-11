/* Voxelcraft cellular automaton: gravity blocks (sand/gravel) + water flow.
 * Bounded, stable, player-radius culled. Uses only the world.* storage API.
 * Loaded after constants.js, math.js, blocks.js, world.js. */
(function (root) {
  'use strict';
  var MC = (root.MC = root.MC || {});
  var C = MC.C;
  var key3 = MC.Util.key3;
  var parseKey3 = MC.Util.parseKey3;

  var DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  /* lastChanged only has to remember "mutated during THIS tick"; anything
   * older is dead weight, so it is pruned instead of growing forever. */
  var STALE_TICKS = 64;
  var PRUNE_EVERY = 16;

  function Simulation(world) {
    this.world = world;
    this.queue = new Set();        /* "x,y,z" cells pending for the NEXT tick */
    this.lastChanged = new Map();  /* key -> tickCount when it last mutated */
    this.settled = new Set();      /* gravity cells known to be at rest */
    this.tickCount = 0;
    this.maxQueue = C.SIM_MAX_UPDATES * 4;
  }

  Simulation.prototype._inb = function (x, y, z) {
    var w = this.world;
    return x >= 0 && x < w.sizeX && y >= 0 && y < w.sizeY && z >= 0 && z < w.sizeZ;
  };

  Simulation.prototype.schedule = function (x, y, z) {
    if (!this._inb(x, y, z)) return;
    var k = key3(x, y, z);
    if (this.queue.has(k)) return;
    this.queue.add(k);
    if (this.queue.size > this.maxQueue) {
      var it = this.queue.values();
      var over = this.queue.size - this.maxQueue;
      for (var n = 0; n < over; n++) {
        var r = it.next();
        if (r.done) break;
        this.queue.delete(r.value);
      }
    }
  };

  Simulation.prototype.scheduleBox = function (x0, y0, z0, x1, y1, z1) {
    for (var y = y0; y <= y1; y++)
      for (var z = z0; z <= z1; z++)
        for (var x = x0; x <= x1; x++) this.schedule(x, y, z);
  };

  Simulation.prototype.pending = function () { return this.queue.size; };

  /* Drop mutation stamps that can no longer affect a tick decision. */
  Simulation.prototype._pruneChanged = function (cutoff) {
    if (!this.lastChanged.size) return;
    var self = this;
    this.lastChanged.forEach(function (stamp, k) {
      if (stamp <= cutoff) self.lastChanged.delete(k);
    });
  };

  Simulation.prototype.clear = function () {
    this.queue.clear(); this.lastChanged.clear(); this.settled.clear();
  };

  /* Kick off a fall from a specific cell (used by placement code). */
  Simulation.prototype.settleColumn = function (x, y, z) {
    this.settled.delete(key3(x, y, z));
    this.schedule(x, y, z);
  };

  Simulation.prototype._markChanged = function (x, y, z) {
    this.lastChanged.set(key3(x, y, z), this.tickCount);
    this.settled.delete(key3(x, y, z));
  };

  Simulation.prototype._sched6 = function (x, y, z) {
    this.schedule(x + 1, y, z); this.schedule(x - 1, y, z);
    this.schedule(x, y + 1, z); this.schedule(x, y - 1, z);
    this.schedule(x, y, z + 1); this.schedule(x, y, z - 1);
  };

  Simulation.prototype._sched4h = function (x, y, z) {
    this.schedule(x + 1, y, z); this.schedule(x - 1, y, z);
    this.schedule(x, y, z + 1); this.schedule(x, y, z - 1);
  };

  Simulation.prototype.tick = function (dt, playerPos) {
    this.tickCount++;
    var w = this.world;

    /* merge external sim marks (world.markSim used by other systems) */
    var ext = w.takeSim();
    for (var e = 0; e < ext.length; e++) {
      var ep = parseKey3(ext[e]);
      this.schedule(ep[0], ep[1], ep[2]);
    }

    /* resolve player horizontal position (accept [x,y,z] or {x,y,z}) */
    var px = null, pz = null;
    if (playerPos) {
      if (Object.prototype.toString.call(playerPos) === '[object Array]') {
        px = playerPos[0]; pz = playerPos[2];
      } else if (typeof playerPos.x === 'number') {
        px = playerPos.x; pz = playerPos.z;
      }
    }
    var r2 = C.SIM_RADIUS * C.SIM_RADIUS;

    /* snapshot the queue for this tick, culling far cells (drop them) */
    var batch = [];
    this.queue.forEach(function (k) {
      var p = parseKey3(k);
      if (px !== null && pz !== null) {
        var ddx = p[0] - px, ddz = p[2] - pz;
        if (ddx * ddx + ddz * ddz > r2) return; /* drop: too far */
      }
      batch.push(k);
    });
    this.queue.clear();

    var processed = 0;
    for (var b = 0; b < batch.length; b++) {
      if (processed >= C.SIM_MAX_UPDATES) { this.schedule(parseKey3(batch[b])[0], parseKey3(batch[b])[1], parseKey3(batch[b])[2]); continue; }
      var k2 = batch[b];
      /* a cell mutated earlier this tick is not re-processed this tick */
      if (this.lastChanged.get(k2) === this.tickCount) continue;
      var q = parseKey3(k2);
      this._process(q[0], q[1], q[2]);
      processed++;
    }

    /* Keep lastChanged bounded: an idle queue means every stamp is stale, and
     * otherwise anything older than STALE_TICKS can never be compared again. */
    if (!this.queue.size) this.lastChanged.clear();
    else if (this.tickCount % PRUNE_EVERY === 0) this._pruneChanged(this.tickCount - STALE_TICKS);
  };

  Simulation.prototype._process = function (x, y, z) {
    var w = this.world;
    var id = w.getBlock(x, y, z);
    if (id === 0) {
      /* air: wake a gravity block resting on top of this now-empty cell */
      var up = w.getBlock(x, y + 1, z);
      if (MC.isGravityBlock(up)) this.schedule(x, y + 1, z);
      return;
    }
    if (MC.isGravityBlock(id)) { this._gravity(x, y, z, id); return; }
    if (id === MC.WATER_ID) { this._water(x, y, z); return; }
  };

  /* ------------------------------- gravity ------------------------------- */
  Simulation.prototype._gravity = function (x, y, z, id) {
    var w = this.world;
    var meta = w.getMeta(x, y, z);
    var k = key3(x, y, z);

    if (y - 1 >= 0) {
      var below = w.getBlock(x, y - 1, z);
      if (below === 0) {
        w.setBlock(x, y - 1, z, id, meta);
        w.setBlock(x, y, z, 0, 0);
        this._markChanged(x, y - 1, z); this._markChanged(x, y, z);
        this.schedule(x, y - 1, z); this.schedule(x, y, z);
        this._sched4h(x, y, z);
        return;
      }
      if (below === MC.WATER_ID) {
        var bm = w.getMeta(x, y - 1, z);
        w.setBlock(x, y - 1, z, id, meta);
        w.setBlock(x, y, z, MC.WATER_ID, bm);
        this._markChanged(x, y - 1, z); this._markChanged(x, y, z);
        this.schedule(x, y - 1, z); this.schedule(x, y, z);
        this._sched4h(x, y, z);
        return;
      }
      /* resting on solid: try to flow diagonally down-and-out */
      for (var d = 0; d < 4; d++) {
        var tx = x + DIRS[d][0], tz = z + DIRS[d][1];
        if (!this._inb(tx, y - 1, tz)) continue;
        if (w.getBlock(tx, y - 1, tz) === 0 && w.getBlock(tx, y, tz) === 0) {
          w.setBlock(tx, y - 1, tz, id, meta);
          w.setBlock(x, y, z, 0, 0);
          this._markChanged(tx, y - 1, tz); this._markChanged(x, y, z);
          this.schedule(tx, y - 1, tz); this.schedule(x, y, z);
          this._sched4h(x, y, z);
          return;
        }
      }
    }

    /* at rest: notify the 6 neighbours exactly once (no churn) */
    if (!this.settled.has(k)) {
      this.settled.add(k);
      this._sched6(x, y, z);
    }
  };

  /* -------------------------------- water -------------------------------- */
  Simulation.prototype._level = function (x, y, z) {
    var m = this.world.getMeta(x, y, z);
    return m <= 0 ? 8 : m;
  };

  Simulation.prototype._water = function (x, y, z) {
    var w = this.world;
    var level = this._level(x, y, z);
    var isSource = level >= 8;

    /* (1) flow down into replaceable (air, or water with level < 8) */
    if (y - 1 >= 0) {
      var below = w.getBlock(x, y - 1, z);
      if (below === 0 || (below === MC.WATER_ID && this._level(x, y - 1, z) < 8)) {
        var nl = isSource ? 8 : level;
        w.setBlock(x, y - 1, z, MC.WATER_ID, nl);
        this._markChanged(x, y - 1, z);
        this.schedule(x, y - 1, z);
        this._sched6(x, y - 1, z);
      }
    }

    /* (2)+(3) horizontal spread + equalise, only when resting on solid ground
     * (below is neither air nor water). This keeps falling columns clean and
     * makes puddles spread only where they have landed. */
    var belowId = (y - 1 >= 0) ? w.getBlock(x, y - 1, z) : -1;
    var onSolid = (y - 1 < 0) || (belowId !== 0 && belowId !== MC.WATER_ID);
    if (onSolid) {
      for (var d = 0; d < 4; d++) {
        var tx = x + DIRS[d][0], tz = z + DIRS[d][1];
        if (!this._inb(tx, y, tz)) continue;
        var nb = w.getBlock(tx, y, tz);
        if (nb === 0) {
          if (level > 2) {
            w.setBlock(tx, y, tz, MC.WATER_ID, level - 1);
            this._markChanged(tx, y, tz);
            this.schedule(tx, y, tz); this._sched6(tx, y, tz);
          }
        } else if (nb === MC.WATER_ID) {
          var nlev = this._level(tx, y, tz);
          if (nlev < level) {
            var target = level - 1;
            if (target > nlev) {
              w.setBlock(tx, y, tz, MC.WATER_ID, target);
              this._markChanged(tx, y, tz);
              this.schedule(tx, y, tz); this._sched6(tx, y, tz);
            }
          } else if (nlev > level) {
            var target2 = nlev - 1;
            if (target2 > level) {
              w.setBlock(x, y, z, MC.WATER_ID, target2);
              level = target2; isSource = level >= 8;
              this._markChanged(x, y, z);
              this.schedule(x, y, z);
            }
          }
        }
      }
    }

    /* support check: a non-source cell dries only when nothing above/around
     * holds a strictly higher level. Conservative -> puddles drain slowly. */
    if (!isSource) {
      var supported = false;
      var ab = w.getBlock(x, y + 1, z);
      if (ab === MC.WATER_ID && this._level(x, y + 1, z) > level) supported = true;
      if (!supported) {
        for (var d2 = 0; d2 < 4; d2++) {
          var hx = x + DIRS[d2][0], hz = z + DIRS[d2][1];
          if (w.getBlock(hx, y, hz) === MC.WATER_ID && this._level(hx, y, hz) > level) { supported = true; break; }
        }
      }
      if (!supported) {
        w.setBlock(x, y, z, 0, 0);
        this._markChanged(x, y, z);
        this.schedule(x, y, z); this._sched6(x, y, z);
      }
    }
  };

  MC.Simulation = Simulation;
})(typeof window !== 'undefined' ? window : globalThis);
