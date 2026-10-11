/* Voxel storage + queries + DDA raycast. HARD CONTRACT for every other
 * module (mesher, simulation, player, renderer).
 *
 * Loaded after constants.js, math.js, blocks.js. */
(function (root) {
  'use strict';
  var MC = (root.MC = root.MC || {});
  var C = MC.C;

  function idx(x, y, z) { return (y * C.CHUNK_SZ + z) * C.CHUNK_SX + x; }
  MC.chunkIndex = idx;

  function World(opts) {
    opts = opts || {};
    this.chunksX = opts.chunksX || C.WORLD_CX;
    this.chunksZ = opts.chunksZ || C.WORLD_CZ;
    this.sizeX = this.chunksX * C.CHUNK_SX;
    this.sizeY = C.CHUNK_SY;
    this.sizeZ = this.chunksZ * C.CHUNK_SZ;
    this.seed = opts.seed === undefined ? 1337 : opts.seed;
    this.chunks = new Map();          /* "cx,cz" -> chunk */
    this.height = new Int16Array(this.sizeX * this.sizeZ); /* topmost solid+1 */
    this.dirty = new Set();
    this.simDirty = new Set();
    this.lightDirty = null;          /* {x0,y0,z0,x1,y1,z1} or null */
    for (var cz = 0; cz < this.chunksZ; cz++) {
      for (var cx = 0; cx < this.chunksX; cx++) this.createChunk(cx, cz);
    }
  }

  World.prototype.createChunk = function (cx, cz) {
    var ch = {
      cx: cx, cz: cz,
      blocks: new Uint8Array(C.CHUNK_VOL),
      meta: new Uint8Array(C.CHUNK_VOL),
      sky: new Uint8Array(C.CHUNK_VOL),   /* skylight 0..15 */
      blk: new Uint8Array(C.CHUNK_VOL),   /* block light 0..15 */
      mesh: null
    };
    this.chunks.set(cx + ',' + cz, ch);
    return ch;
  };
  World.prototype.chunkAt = function (cx, cz) {
    return this.chunks.get(cx + ',' + cz) || null;
  };
  World.prototype.chunkForBlock = function (x, z) {
    return this.chunkAt(Math.floor(x / C.CHUNK_SX), Math.floor(z / C.CHUNK_SZ));
  };

  World.prototype.inBounds = function (x, y, z) {
    return x >= 0 && x < this.sizeX && y >= 0 && y < this.sizeY &&
      z >= 0 && z < this.sizeZ;
  };

  World.prototype.getBlock = function (x, y, z) {
    if (x < 0 || z < 0 || x >= this.sizeX || z >= this.sizeZ || y < 0 || y >= this.sizeY) return 0;
    var ch = this.chunks.get(((x >> 4)) + ',' + ((z >> 4)));
    if (!ch) return 0;
    return ch.blocks[idx(x & 15, y, z & 15)];
  };

  World.prototype.getMeta = function (x, y, z) {
    if (x < 0 || z < 0 || x >= this.sizeX || z >= this.sizeZ || y < 0 || y >= this.sizeY) return 0;
    var ch = this.chunks.get(((x >> 4)) + ',' + ((z >> 4)));
    if (!ch) return 0;
    return ch.meta[idx(x & 15, y, z & 15)];
  };

  World.prototype.setMeta = function (x, y, z, m) {
    if (!this.inBounds(x, y, z)) return;
    var ch = this.chunks.get(((x >> 4)) + ',' + ((z >> 4)));
    if (!ch) return;
    ch.meta[idx(x & 15, y, z & 15)] = m;
    this.markDirty(x, y, z);
  };

  /* Core mutation. opts: {silent:true} skips dirty marking (bulk gen only). */
  World.prototype.setBlock = function (x, y, z, id, meta, opts) {
    if (!this.inBounds(x, y, z)) return false;
    var cx = x >> 4, cz = z >> 4;
    var ch = this.chunks.get(cx + ',' + cz);
    if (!ch) return false;
    var i = idx(x & 15, y, z & 15);
    if (ch.blocks[i] === id && ch.meta[i] === (meta || 0)) return false;
    ch.blocks[i] = id;
    ch.meta[i] = meta || 0;
    if (!(opts && opts.silent)) {
      this.markDirty(x, y, z);
      this.recomputeColumnHeight(x, z);
      this.markLightDirty(x, y, z);
    }
    return true;
  };

  World.prototype.markDirty = function (x, y, z) {
    var cx = x >> 4, cz = z >> 4;
    this.dirty.add(cx + ',' + cz);
    var lx = x & 15, lz = z & 15;
    if (lx === 0) this.dirty.add((cx - 1) + ',' + cz);
    if (lx === 15) this.dirty.add((cx + 1) + ',' + cz);
    if (lz === 0) this.dirty.add(cx + ',' + (cz - 1));
    if (lz === 15) this.dirty.add(cx + ',' + (cz + 1));
  };

  World.prototype.markRegionDirty = function (x0, y0, z0, x1, y1, z1) {
    var c0x = x0 >> 4, c1x = x1 >> 4, c0z = z0 >> 4, c1z = z1 >> 4;
    for (var cz = c0z; cz <= c1z; cz++) {
      for (var cx = c0x; cx <= c1x; cx++) this.dirty.add(cx + ',' + cz);
    }
  };

  /* Chunk keys only (never touches the light dirty box). */
  World.prototype.markChunksDirty = function (x0, z0, x1, z1) {
    var c0x = Math.max(0, x0 >> 4), c1x = Math.min(this.chunksX - 1, x1 >> 4);
    var c0z = Math.max(0, z0 >> 4), c1z = Math.min(this.chunksZ - 1, z1 >> 4);
    for (var cz = c0z; cz <= c1z; cz++)
      for (var cx = c0x; cx <= c1x; cx++) this.dirty.add(cx + ',' + cz);
  };

  World.prototype.takeDirty = function () {
    var out = [];
    this.dirty.forEach(function (k) {
      if (this.chunks.has(k)) out.push(k);
    }, this);
    this.dirty.clear();
    return out;
  };
  World.prototype.clearDirty = function () { this.dirty.clear(); };

  /* ---- simulation interest set (water/sand scheduling) ---- */
  World.prototype.markSim = function (x, y, z) {
    if (this.inBounds(x, y, z)) this.simDirty.add(x + ',' + y + ',' + z);
  };
  World.prototype.takeSim = function () {
    var out = [];
    this.simDirty.forEach(function (k) { out.push(k); });
    this.simDirty.clear();
    return out;
  };
  World.prototype.clearSim = function () { this.simDirty.clear(); };

  /* ---- semantic queries ---- */
  World.prototype.isSolidAt = function (x, y, z) {
    if (y < 0) return true;              /* world floor: stop the player */
    if (y >= this.sizeY) return false;
    return MC.isSolidBlock(this.getBlock(x, y, z));
  };
  World.prototype.isLiquidAt = function (x, y, z) {
    return MC.isLiquidBlock(this.getBlock(x, y, z));
  };
  World.prototype.isOpaqueAt = function (x, y, z) {
    if (y < 0) return true;
    return MC.isOpaqueBlock(this.getBlock(x, y, z));
  };
  World.prototype.isAirAt = function (x, y, z) { return this.getBlock(x, y, z) === 0; };
  World.prototype.isReplaceableAt = function (x, y, z) {
    if (y < 0 || y >= this.sizeY) return false;
    if (x < 0 || z < 0 || x >= this.sizeX || z >= this.sizeZ) return false;
    return MC.isReplaceable(this.getBlock(x, y, z));
  };

  World.prototype.recomputeColumnHeight = function (x, z) {
    var cx = x >> 4, cz = z >> 4;
    var ch = this.chunks.get(cx + ',' + cz);
    if (!ch) return;
    var h = 0;
    for (var y = this.sizeY - 1; y >= 0; y--) {
      var id = ch.blocks[idx(x & 15, y, z & 15)];
      if (id !== 0) { h = y + 1; break; }
    }
    this.height[z * this.sizeX + x] = h;
  };
  World.prototype.rebuildHeights = function () {
    for (var z = 0; z < this.sizeZ; z++) {
      for (var x = 0; x < this.sizeX; x++) this.recomputeColumnHeight(x, z);
    }
  };
  World.prototype.heightAt = function (x, z) {
    if (x < 0 || z < 0 || x >= this.sizeX || z >= this.sizeZ) return 0;
    return this.height[z * this.sizeX + x];
  };

  World.prototype.forEachBlockInBox = function (x0, y0, z0, x1, y1, z1, cb) {
    for (var y = y0; y <= y1; y++)
      for (var z = z0; z <= z1; z++)
        for (var x = x0; x <= x1; x++) cb(x, y, z, this.getBlock(x, y, z));
  };
  World.prototype.forEachBlockAABB = function (box, cb) {
    var x0 = Math.floor(box.min[0]), y0 = Math.floor(box.min[1]), z0 = Math.floor(box.min[2]);
    var x1 = Math.floor(box.max[0]), y1 = Math.floor(box.max[1]), z1 = Math.floor(box.max[2]);
    for (var y = y0; y <= y1; y++)
      for (var z = z0; z <= z1; z++)
        for (var x = x0; x <= x1; x++) cb(x, y, z, this.getBlock(x, y, z));
  };

  /* ---- DDA voxel raycast (Amanatides & Woo) ----
   * Returns { hit, dist, block:[x,y,z], face, normal, adjacent, blockId }
   * face is the index into MC.FACE_ORDER of the face that was entered. */
  World.prototype.raycast = function (origin, dir, maxDist, opts) {
    var wantLiquid = !!(opts && opts.includeLiquid);
    var d = MC.V3.norm(dir);
    var x = Math.floor(origin[0]), y = Math.floor(origin[1]), z = Math.floor(origin[2]);
    var stepX = d[0] > 0 ? 1 : d[0] < 0 ? -1 : 0;
    var stepY = d[1] > 0 ? 1 : d[1] < 0 ? -1 : 0;
    var stepZ = d[2] > 0 ? 1 : d[2] < 0 ? -1 : 0;
    function boundary(o, dv, st) {
      if (dv === 0) return Infinity;
      if (st > 0) return (Math.floor(o) + 1 - o) / dv;
      if (st < 0) return (o - Math.floor(o)) / -dv;
      return Infinity;
    }
    var tMaxX = boundary(origin[0], d[0], stepX);
    var tMaxY = boundary(origin[1], d[1], stepY);
    var tMaxZ = boundary(origin[2], d[2], stepZ);
    var tDeltaX = stepX !== 0 ? Math.abs(1 / d[0]) : Infinity;
    var tDeltaY = stepY !== 0 ? Math.abs(1 / d[1]) : Infinity;
    var tDeltaZ = stepZ !== 0 ? Math.abs(1 / d[2]) : Infinity;
    var face = -1, t = 0;
    for (var guard = 0; guard < 512; guard++) {
      var id = this.getBlock(x, y, z);
      if (id !== 0 && (wantLiquid || !MC.isLiquidBlock(id))) {
        var n = face >= 0 ? MC.FACE_NORMALS[face] : [0, 0, 0];
        return {
          hit: true, dist: t, block: [x, y, z], face: face, normal: n,
          adjacent: [x + n[0], y + n[1], z + n[2]], blockId: id
        };
      }
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        if (stepX === 0) break;
        x += stepX; t = tMaxX; tMaxX += tDeltaX; face = stepX > 0 ? 1 : 0;
      } else if (tMaxY < tMaxZ) {
        if (stepY === 0) break;
        y += stepY; t = tMaxY; tMaxY += tDeltaY; face = stepY > 0 ? 3 : 2;
      } else {
        if (stepZ === 0) break;
        z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; face = stepZ > 0 ? 5 : 4;
      }
      if (t > maxDist) break;
    }
    return { hit: false, dist: maxDist, block: null, face: -1, normal: [0, 0, 0], adjacent: null, blockId: 0 };
  };

  /* ---- spawn helper: first air pocket above solid ground at (x,z) ---- */
  World.prototype.findSpawn = function (x, z) {
    for (var y = this.sizeY - 2; y >= 1; y--) {
      if (this.isSolidAt(x, y, z) && !this.isSolidAt(x, y + 1, z) && !this.isSolidAt(x, y + 2, z)) {
        return [x + 0.5, y + 1, z + 0.5];
      }
    }
    return [x + 0.5, this.sizeY - 3, z + 0.5];
  };

  /* ---- save format: run-length encode each chunk ---- */
  World.prototype.serialize = function () {
    var chunks = [];
    this.chunks.forEach(function (ch) {
      var runs = [];
      var prev = ch.blocks[0], n = 1;
      for (var i = 1; i < ch.blocks.length; i++) {
        if (ch.blocks[i] === prev && n < 65535) n++;
        else { runs.push(prev, n); prev = ch.blocks[i]; n = 1; }
      }
      runs.push(prev, n);
      /* meta is mostly zero; only store the non-zero pairs */
      var metas = [];
      for (var j = 0; j < ch.meta.length; j++) if (ch.meta[j]) metas.push(j, ch.meta[j]);
      chunks.push({ cx: ch.cx, cz: ch.cz, runs: runs, metas: metas });
    });
    return { version: MC.VERSION, seed: this.seed, chunksX: this.chunksX, chunksZ: this.chunksZ, chunks: chunks };
  };

  /* Reject anything that is not a Voxelcraft chunk dump BEFORE touching the
   * live storage, so a corrupt save fails cleanly (returns false) instead of
   * throwing halfway through a load. */
  function validChunk(d, chunksX, chunksZ) {
    if (!d || typeof d !== 'object') return false;
    if (!(d.cx >= 0 && d.cx < chunksX && d.cz >= 0 && d.cz < chunksZ)) return false;
    if (!Array.isArray(d.runs) || !Array.isArray(d.metas)) return false;
    if (d.runs.length % 2 !== 0) return false;
    for (var i = 0; i < d.runs.length; i++) if (typeof d.runs[i] !== 'number') return false;
    for (var j = 0; j < d.metas.length; j++) if (typeof d.metas[j] !== 'number') return false;
    return true;
  }

  World.prototype.deserialize = function (data) {
    if (!data || typeof data !== 'object') return false;
    if (data.version !== undefined && data.version !== MC.VERSION) return false;
    if (!Array.isArray(data.chunks)) return false;
    var nx = data.chunksX || this.chunksX;
    var nz = data.chunksZ || this.chunksZ;
    if (!(nx > 0 && nz > 0)) return false;
    for (var c = 0; c < data.chunks.length; c++) {
      if (!validChunk(data.chunks[c], nx, nz)) return false;
    }

    this.chunksX = nx;
    this.chunksZ = nz;
    this.sizeX = this.chunksX * C.CHUNK_SX;
    this.sizeZ = this.chunksZ * C.CHUNK_SZ;
    this.seed = data.seed;
    this.chunks.clear();
    this.height = new Int16Array(this.sizeX * this.sizeZ);
    this.dirty.clear();
    this.lightDirty = null;
    this.simDirty.clear();          /* stale sim keys must not survive a load */
    for (var i = 0; i < data.chunks.length; i++) {
      var d = data.chunks[i];
      var ch = this.createChunk(d.cx, d.cz);
      var p = 0;
      for (var r = 0; r + 1 < d.runs.length; r += 2) {
        var id = d.runs[r], n = d.runs[r + 1];
        for (var k = 0; k < n && p < ch.blocks.length; k++) ch.blocks[p++] = id;
      }
      for (var m = 0; m + 1 < d.metas.length; m += 2) {
        var mi = d.metas[m], mv = d.metas[m + 1];
        if (mi >= 0 && mi < ch.meta.length) ch.meta[mi] = mv;
      }
    }
    this.rebuildHeights();
    for (var cz = 0; cz < this.chunksZ; cz++)
      for (var cx = 0; cx < this.chunksX; cx++) this.dirty.add(cx + ',' + cz);
    return true;
  };


  /* ------------------------------ lighting ------------------------------
   * Two 0..15 channels per voxel, stored per chunk:
   *   sky  - sunlight: 15 straight down any transparent column, then
   *          flood-filled with -1 per step, so caves and overhangs fall off
   *          with depth instead of every face under the surface going black.
   *   blk  - light from emissive blocks (glowstone), same spread rule.
   *
   * Mutations accumulate a dirty AABB; game.js calls applyLightDirty() once
   * per frame, so a burst of water/sand/mining changes relights ONE region.
   * The region is padded by LIGHT_PAD (>= 15) so the flood fill re-enters
   * correctly from the still-correct light values just outside it. */

  var LIGHT_PAD = 16;

  World.prototype.skyAt = function (x, y, z) {
    if (y >= this.sizeY) return 15;            /* open sky above the world */
    if (x < 0 || z < 0 || x >= this.sizeX || z >= this.sizeZ || y < 0) return 0;
    var ch = this.chunks.get((x >> 4) + ',' + (z >> 4));
    return ch ? ch.sky[idx(x & 15, y, z & 15)] : 0;
  };
  World.prototype.blockLightAt = function (x, y, z) {
    if (x < 0 || z < 0 || x >= this.sizeX || z >= this.sizeZ || y < 0 || y >= this.sizeY) return 0;
    var ch = this.chunks.get((x >> 4) + ',' + (z >> 4));
    return ch ? ch.blk[idx(x & 15, y, z & 15)] : 0;
  };

  World.prototype.markLightDirty = function (x, y, z) {
    if (!this.inBounds(x, y, z)) return;
    this.markLightDirtyBox(x, y, z, x, y, z);
  };
  World.prototype.markLightDirtyBox = function (x0, y0, z0, x1, y1, z1) {
    var d = this.lightDirty;
    if (!d) { this.lightDirty = { x0: x0, y0: y0, z0: z0, x1: x1, y1: y1, z1: z1 }; return; }
    if (x0 < d.x0) d.x0 = x0;
    if (y0 < d.y0) d.y0 = y0;
    if (z0 < d.z0) d.z0 = z0;
    if (x1 > d.x1) d.x1 = x1;
    if (y1 > d.y1) d.y1 = y1;
    if (z1 > d.z1) d.z1 = z1;
  };
  World.prototype.clearLightDirty = function () { this.lightDirty = null; };

  /* Relight every pending change. Returns the relit volume (0 when idle). */
  World.prototype.applyLightDirty = function () {
    var d = this.lightDirty;
    if (!d) return 0;
    if (!(isFinite(d.x0) && isFinite(d.y0) && isFinite(d.z0) &&
          isFinite(d.x1) && isFinite(d.y1) && isFinite(d.z1))) { this.lightDirty = null; return 0; }
    this.lightDirty = null;
    var x0 = Math.max(0, d.x0 - LIGHT_PAD), y0 = Math.max(0, d.y0 - LIGHT_PAD), z0 = Math.max(0, d.z0 - LIGHT_PAD);
    var x1 = Math.min(this.sizeX - 1, d.x1 + LIGHT_PAD);
    var y1 = Math.min(this.sizeY - 1, d.y1 + LIGHT_PAD);
    var z1 = Math.min(this.sizeZ - 1, d.z1 + LIGHT_PAD);
    relightRegion(this, x0, y0, z0, x1, y1, z1);
    this.markChunksDirty(x0 - 1, z0 - 1, x1 + 1, z1 + 1);   /* re-mesh the relit area */
    return (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
  };

  World.prototype.relightAll = function () {
    this.lightDirty = null;
    relightRegion(this, 0, 0, 0, this.sizeX - 1, this.sizeY - 1, this.sizeZ - 1);
  };

  /* Scratch buffers, reused across calls (grown on demand). */
  var SC = { n: 0, B: null, S: null, K: null, Q: null };

  function relightRegion(w, x0, y0, z0, x1, y1, z1) {
    var sizeX = w.sizeX, sizeY = w.sizeY, sizeZ = w.sizeZ;
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); z0 = Math.max(0, z0);
    x1 = Math.min(sizeX - 1, x1); y1 = Math.min(sizeY - 1, y1); z1 = Math.min(sizeZ - 1, z1);
    if (x1 < x0 || y1 < y0 || z1 < z0) return;

    var sx = x1 - x0 + 1, sy = y1 - y0 + 1, sz = z1 - z0 + 1;
    var bx = sx + 2, bz = sz + 2;              /* 1-cell border all around */
    var ZSTR = bx, YSTR = bx * bz;
    var total = YSTR * (sy + 2);

    if (SC.n < total) {
      SC.n = total;
      SC.B = new Uint8Array(total);
      SC.S = new Uint8Array(total);
      SC.K = new Uint8Array(total);
      SC.Q = new Int32Array(Math.max(4096, total));
    }
    var B = SC.B, S = SC.S, K = SC.K, Q = SC.Q;
    B.fill(0, 0, total); S.fill(0, 0, total); K.fill(0, 0, total);

    var head = 0, tail = 0;
    function push(i) {
      if (tail >= Q.length) {                 /* grow: a cell can be re-lit twice */
        var nq = new Int32Array(Q.length * 2);
        nq.set(Q); Q = nq; SC.Q = nq;
      }
      Q[tail++] = i;
    }

    /* 1. copy the region's block ids out of the chunk arrays (row runs) */
    var cx0 = x0 >> 4, cx1 = x1 >> 4, cz0 = z0 >> 4, cz1 = z1 >> 4;
    for (var cz = cz0; cz <= cz1; cz++) {
      var oz = cz * C.CHUNK_SZ, lz0 = Math.max(0, z0 - oz), lz1 = Math.min(C.CHUNK_SZ - 1, z1 - oz);
      for (var cx = cx0; cx <= cx1; cx++) {
        var ch = w.chunks.get(cx + ',' + cz);
        if (!ch) continue;
        var ox = cx * C.CHUNK_SX, lx0 = Math.max(0, x0 - ox), lx1 = Math.min(C.CHUNK_SX - 1, x1 - ox);
        var run = lx1 - lx0 + 1;
        for (var y = y0; y <= y1; y++) {
          for (var z = lz0; z <= lz1; z++) {
            var src = (y * C.CHUNK_SZ + z) * C.CHUNK_SX + lx0;
            var dst = (y - y0 + 1) * YSTR + (oz + z - z0 + 1) * ZSTR + (ox + lx0 - x0 + 1);
            B.set(ch.blocks.subarray(src, src + run), dst);
          }
        }
      }
    }

    /* 2. border shell: real block ids + the still-correct light just outside,
     *    which is what lets the flood fill re-enter the region properly */
    for (var by = y0 - 1; by <= y1 + 1; by++) {
      var inY = by >= y0 && by <= y1;
      for (var bz2 = z0 - 1; bz2 <= z1 + 1; bz2++) {
        var inZ = bz2 >= z0 && bz2 <= z1;
        for (var bx2 = x0 - 1; bx2 <= x1 + 1; bx2++) {
          if (inY && inZ && bx2 >= x0 && bx2 <= x1) continue;      /* interior */
          var li = (by - y0 + 1) * YSTR + (bz2 - z0 + 1) * ZSTR + (bx2 - x0 + 1);
          if (by >= sizeY) { S[li] = 15; push(li); continue; }     /* open sky */
          if (by < 0 || bx2 < 0 || bz2 < 0 || bx2 >= sizeX || bz2 >= sizeZ) { B[li] = 1; continue; }
          var bch = w.chunks.get((bx2 >> 4) + ',' + (bz2 >> 4));
          if (!bch) { B[li] = 1; continue; }
          var bi = idx(bx2 & 15, by, bz2 & 15);
          B[li] = bch.blocks[bi];
          S[li] = bch.sky[bi];
          K[li] = bch.blk[bi];
          if (S[li] > 1 || K[li] > 1) push(li);
        }
      }
    }

    /* 3. skylight columns: light falls straight down from the region's top
     *    border (which already accounts for everything above it) */
    for (var cz3 = 0; cz3 < sz; cz3++) {
      for (var cx3 = 0; cx3 < sx; cx3++) {
        var top = (sy + 1) * YSTR + cz3 * ZSTR + cx3 + 1;   /* border row above y1 */
        var lvl = S[top];
        if (lvl <= 0) continue;
        var at = top - YSTR;                                /* cell at y1 */
        for (var y4 = sy - 1; y4 >= 0; y4--, at -= YSTR) {
          if (MC.isOpaqueBlock(B[at])) break;
          if (lvl > S[at]) { S[at] = lvl; push(at); }
        }
      }
    }

    /* 4. block-light sources inside the region */
    for (var y5 = 0; y5 < sy; y5++) {
      for (var z5 = 0; z5 < sz; z5++) {
        var row5 = y5 * YSTR + (z5 + 1) * ZSTR + 1;
        for (var x5 = 0; x5 < sx; x5++) {
          var lv = MC.block(B[row5 + x5]).light;
          if (lv > 0 && lv > K[row5 + x5]) { K[row5 + x5] = lv; push(row5 + x5); }
        }
      }
    }

    /* 5. flood fill both channels (border cells act as fixed light sources) */
    while (head < tail) {
      var i = Q[head++];
      if (i < 0 || i >= total) continue;
      var cs = S[i], cb = K[i];
      if (cs <= 1 && cb <= 1) continue;
      for (var d = 0; d < 6; d++) {
        var j = i + (d === 0 ? 1 : d === 1 ? -1 : d === 2 ? ZSTR : d === 3 ? -ZSTR : d === 4 ? YSTR : -YSTR);
        if (MC.isOpaqueBlock(B[j])) continue;
        if (cs > 1 && cs - 1 > S[j]) { S[j] = cs - 1; push(j); }
        if (cb > 1 && cb - 1 > K[j]) { K[j] = cb - 1; push(j); }
      }
    }

    /* 6. write the light back into the chunk arrays */
    for (var cz6 = cz0; cz6 <= cz1; cz6++) {
      var oz6 = cz6 * C.CHUNK_SZ, lz06 = Math.max(0, z0 - oz6), lz16 = Math.min(C.CHUNK_SZ - 1, z1 - oz6);
      for (var cx6 = cx0; cx6 <= cx1; cx6++) {
        var ch6 = w.chunks.get(cx6 + ',' + cz6);
        if (!ch6) continue;
        var ox6 = cx6 * C.CHUNK_SX, lx06 = Math.max(0, x0 - ox6), lx16 = Math.min(C.CHUNK_SX - 1, x1 - ox6);
        for (var y6 = y0; y6 <= y1; y6++) {
          for (var z6 = lz06; z6 <= lz16; z6++) {
            var dst6 = (y6 - y0 + 1) * YSTR + (oz6 + z6 - z0 + 1) * ZSTR + (ox6 + lx06 - x0 + 1);
            var src6 = (y6 * C.CHUNK_SZ + z6) * C.CHUNK_SX + lx06;
            for (var lx6 = 0; lx6 <= lx16 - lx06; lx6++) {
              ch6.sky[src6 + lx6] = S[dst6 + lx6];
              ch6.blk[src6 + lx6] = K[dst6 + lx6];
            }
          }
        }
      }
    }
  }

  MC.World = World;
})(typeof window !== 'undefined' ? window : globalThis);
