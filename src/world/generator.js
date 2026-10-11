/* Voxelcraft world generator. Deterministic from world.seed.
 * Fills the world in place using the world.* storage API (bulk column writes
 * go straight into each chunk's typed arrays for speed; heights + dirty are
 * finalised once at the end).
 * Loaded after constants.js, math.js, blocks.js, world.js. */
(function (root) {
  'use strict';
  var MC = (root.MC = root.MC || {});
  var C = MC.C;
  var SILENT = { silent: true };

  /* biome codes */
  var B_OCEAN = 0, B_BEACH = 1, B_DESERT = 2, B_PLAINS = 3, B_FOREST = 4, B_SNOW = 5;

  /* Fast 3D value-noise fbm for cave carving. Kept at module scope (a single
   * monomorphic closure set) because the nested version was ~40x slower. */
  var _cseed = 1;
  function _ch3(a, b, c) {
    var h = Math.imul(a, 374761393) ^ Math.imul(b, 668265263) ^ Math.imul(c, 1274126177) ^ _cseed;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function _cv3(a, b, c) {
    var xi = Math.floor(a), yi = Math.floor(b), zi = Math.floor(c);
    var xf = a - xi, yf = b - yi, zf = c - zi;
    var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
    var c000 = _ch3(xi, yi, zi), c100 = _ch3(xi + 1, yi, zi),
      c010 = _ch3(xi, yi + 1, zi), c110 = _ch3(xi + 1, yi + 1, zi),
      c001 = _ch3(xi, yi, zi + 1), c101 = _ch3(xi + 1, yi, zi + 1),
      c011 = _ch3(xi, yi + 1, zi + 1), c111 = _ch3(xi + 1, yi + 1, zi + 1);
    var x00 = c000 + (c100 - c000) * u, x10 = c010 + (c110 - c010) * u,
      x01 = c001 + (c101 - c001) * u, x11 = c011 + (c111 - c011) * u;
    var y0 = x00 + (x10 - x00) * v, y1 = x01 + (x11 - x01) * v;
    return y0 + (y1 - y0) * w;
  }
  function _caveFbm(a, b, c) {
    var amp = 1, freq = 1, sum = 0, norm = 0;
    for (var o = 0; o < 3; o++) { sum += _cv3(a * freq, b * freq, c * freq) * amp; norm += amp; amp *= 0.5; freq *= 2; }
    return sum / norm;
  }

  function generate(world) {
    var seed = (world.seed >>> 0) || 1;
    _cseed = (seed + 503) >>> 0;
    var sizeX = world.sizeX, sizeY = world.sizeY, sizeZ = world.sizeZ;
    var SEA = C.SEA_LEVEL;
    var WATER = MC.WATER_ID;
    var CSX = C.CHUNK_SX, CSZ = C.CHUNK_SZ, STRIDE = CSZ * CSX; /* 256 */

    var idBedrock = MC.blockIdByName('bedrock');
    var idStone = MC.blockIdByName('stone');
    var idDirt = MC.blockIdByName('dirt');
    var idGrass = MC.blockIdByName('grass');
    var idSand = MC.blockIdByName('sand');
    var idSandstone = MC.blockIdByName('sandstone');
    var idGravel = MC.blockIdByName('gravel');
    var idClay = MC.blockIdByName('clay');
    var idSnow = MC.blockIdByName('snow');
    var idLog = MC.blockIdByName('log');
    var idLeaves = MC.blockIdByName('leaves');
    var idCactus = MC.blockIdByName('cactus');
    var idCoal = MC.blockIdByName('coal_ore');
    var idIron = MC.blockIdByName('iron_ore');
    var idGold = MC.blockIdByName('gold_ore');
    var idDiamond = MC.blockIdByName('diamond_ore');

    var nHeight = new MC.Noise(seed);
    var nMount = new MC.Noise((seed + 101) >>> 0);
    var nValley = new MC.Noise((seed + 211) >>> 0);
    var nTemp = new MC.Noise((seed + 307) >>> 0);
    var nMoist = new MC.Noise((seed + 409) >>> 0);
    var nCave = new MC.Noise((seed + 503) >>> 0);
    var nBedrock = new MC.Noise((seed + 601) >>> 0);
    var nSub = new MC.Noise((seed + 701) >>> 0);
    var nVeg = new MC.Noise((seed + 809) >>> 0);
    var nOcean = new MC.Noise((seed + 907) >>> 0);

    var N = sizeX * sizeZ;
    var hArr = new Int16Array(N);
    var bArr = new Uint8Array(N);
    var x, z, i, y;

    /* ---- heightmap ---- */
    for (z = 0; z < sizeZ; z++) {
      for (x = 0; x < sizeX; x++) {
        var base = 26 + nHeight.fbm2(x * 0.012, z * 0.012, 5) * 18;
        var mm = nMount.fbm2(x * 0.004, z * 0.004, 3);
        var add = mm > 0.6 ? ((mm - 0.6) / 0.4) * 16 : 0;
        var mv = nValley.fbm2(x * 0.005 + 30, z * 0.005 + 30, 3);
        var sub = mv < 0.45 ? ((0.45 - mv) / 0.45) * 10 : 0;
        var h = Math.round(base + add - sub);
        if (h < 4) h = 4;
        if (h > sizeY - 12) h = sizeY - 12;
        hArr[z * sizeX + x] = h;
      }
    }
    /* smooth: two 3x3 box passes to kill 1-block spikes */
    var tmp = new Int16Array(N);
    for (var pass = 0; pass < 2; pass++) {
      for (z = 0; z < sizeZ; z++) {
        for (x = 0; x < sizeX; x++) {
          var sum = 0, cnt = 0;
          for (var dz = -1; dz <= 1; dz++) {
            var zz = z + dz; if (zz < 0 || zz >= sizeZ) continue;
            for (var dx = -1; dx <= 1; dx++) {
              var xx = x + dx; if (xx < 0 || xx >= sizeX) continue;
              sum += hArr[zz * sizeX + xx]; cnt++;
            }
          }
          tmp[z * sizeX + x] = Math.round(sum / cnt);
        }
      }
      for (i = 0; i < N; i++) hArr[i] = tmp[i];
    }

    /* ---- biomes (temp + moisture; moisture also splits plains/forest) ---- */
    for (z = 0; z < sizeZ; z++) {
      for (x = 0; x < sizeX; x++) {
        i = z * sizeX + x;
        var hh = hArr[i], b;
        if (hh <= SEA) b = B_OCEAN;
        else if (hh <= SEA + 3) b = B_BEACH;
        else {
          var t = nTemp.fbm2(x * 0.006, z * 0.006, 3);
          var mo = nMoist.fbm2(x * 0.009 + 50, z * 0.009 + 50, 3);
          if (t < 0.36 && mo > 0.45) b = B_SNOW;
          else if (t > 0.64 && mo < 0.42) b = B_DESERT;
          else if (mo > 0.56) b = B_FOREST;
          else b = B_PLAINS;
        }
        bArr[i] = b;
      }
    }

    var chunks = world.chunks;

    /* ---- column fill (direct typed-array writes; contiguous in y) ---- */
    for (z = 0; z < sizeZ; z++) {
      for (x = 0; x < sizeX; x++) {
        i = z * sizeX + x;
        var h2 = hArr[i], bi = bArr[i];
        var ch = chunks.get((x >> 4) + ',' + (z >> 4));
        var blocks = ch.blocks, metas = ch.meta;
        var bcol = (z & 15) * CSX + (x & 15);
        blocks[bcol] = idBedrock; metas[bcol] = 0;          /* y = 0 */
        var stoneStart = 1;
        if (nBedrock.value2(x * 1.1, z * 1.1) < 0.4) {
          blocks[STRIDE + bcol] = idBedrock; metas[STRIDE + bcol] = 0; /* y = 1 */
          stoneStart = 2;
        }
        if (h2 >= 44) { /* pure rock peak: stone all the way up */
          for (y = stoneStart; y <= h2 - 1; y++) { var p = y * STRIDE + bcol; blocks[p] = idStone; metas[p] = 0; }
          continue;
        }
        var subDepth = 3 + (nSub.value2(x * 0.7, z * 0.7) < 0.5 ? 0 : 1);
        var subBottom = h2 - 1 - subDepth;
        var stoneTop = subBottom - 1;
        for (y = stoneStart; y <= stoneTop; y++) { var p2 = y * STRIDE + bcol; blocks[p2] = idStone; metas[p2] = 0; }
        var surf, subm;
        if (bi === B_OCEAN) {
          var oc = nOcean.value2(x * 0.9, z * 0.9);
          surf = oc < 0.55 ? idSand : oc < 0.8 ? idGravel : idClay;
          subm = surf;
        } else if (bi === B_BEACH) { surf = idSand; subm = idSand; }
        else if (bi === B_DESERT) { surf = idSand; subm = idSandstone; }
        else if (bi === B_SNOW) { surf = idSnow; subm = idDirt; }
        else { surf = idGrass; subm = idDirt; }
        for (y = subBottom; y <= h2 - 2; y++) { var p3 = y * STRIDE + bcol; blocks[p3] = subm; metas[p3] = 0; }
        if (bi === B_SNOW && h2 - 2 >= stoneStart) { var pg = (h2 - 2) * STRIDE + bcol; blocks[pg] = idGrass; metas[pg] = 0; }
        var ps = (h2 - 1) * STRIDE + bcol; blocks[ps] = surf; metas[ps] = 0;
      }
    }

    /* ---- ores: clumpy veins via seeded RNG random walk (cross columns) ---- */
    var oreRng = new MC.RNG((seed ^ 0x9e3779b9) >>> 0);
    var attempts = Math.floor(sizeX * sizeZ * 0.4);
    for (var a = 0; a < attempts; a++) {
      var ox = oreRng.int(0, sizeX - 1), oz = oreRng.int(0, sizeZ - 1);
      var roll = oreRng.next(), ore, oy;
      if (roll < 0.55) { ore = idCoal; oy = oreRng.int(8, 48); }
      else if (roll < 0.85) { ore = idIron; oy = oreRng.int(5, 38); }
      else if (roll < 0.97) { ore = idGold; oy = oreRng.int(3, 20); }
      else { ore = idDiamond; oy = oreRng.int(2, 14); }
      var vs = oreRng.int(3, 9);
      var cx = ox, cy = oy, cz = oz;
      for (var s = 0; s < vs; s++) {
        if (world.getBlock(cx, cy, cz) === idStone) world.setBlock(cx, cy, cz, ore, 0, SILENT);
        cx += oreRng.int(-1, 1); cy += oreRng.int(-1, 1); cz += oreRng.int(-1, 1);
        if (cy < 1) cy = 1; if (cy > sizeY - 2) cy = sizeY - 2;
      }
    }

    /* ---- caves: coarse 3D noise carve (2-block lattice) for speed in vm.
     * Each accepted lattice point removes a 2x2x2 stone block; never opens the
     * surface (top = min column height - 5) and never touches y < 2. ---- */
    for (z = 0; z < sizeZ; z += 2) {
      for (x = 0; x < sizeX; x += 2) {
        var z1 = z + 1 < sizeZ ? z + 1 : z;
        var x1 = x + 1 < sizeX ? x + 1 : x;
        var hmin = hArr[z * sizeX + x];
        if (hArr[z * sizeX + x1] < hmin) hmin = hArr[z * sizeX + x1];
        if (hArr[z1 * sizeX + x] < hmin) hmin = hArr[z1 * sizeX + x];
        if (hArr[z1 * sizeX + x1] < hmin) hmin = hArr[z1 * sizeX + x1];
        var top = hmin - 5;
        for (y = 2; y <= top; y += 2) {
          if (_caveFbm(x * 0.06, y * 0.09, z * 0.06) > 0.70) {
            for (var dy = 0; dy < 2; dy++) {
              var yy = y + dy; if (yy < 2 || yy > top) continue;
              for (var dz = 0; dz < 2; dz++) {
                var zz = z + dz; if (zz >= sizeZ) continue;
                for (var dx = 0; dx < 2; dx++) {
                  var xx = x + dx; if (xx >= sizeX) continue;
                  var chc = chunks.get((xx >> 4) + ',' + (zz >> 4));
                  var ci = (yy * CSZ + (zz & 15)) * CSX + (xx & 15);
                  if (chc.blocks[ci] !== 0 && chc.blocks[ci] !== idBedrock) chc.blocks[ci] = 0;
                }
              }
            }
          }
        }
      }
    }

    /* ---- worm tunnels: seeded random walks carving spheres (cross columns) ---- */
    var wormRng = new MC.RNG((seed + 0x51ed2701) >>> 0);
    var numWorms = Math.floor(sizeX * sizeZ / 500);
    for (var w = 0; w < numWorms; w++) {
      var wx = wormRng.range(2, sizeX - 3), wz = wormRng.range(2, sizeZ - 3);
      var hs = hArr[Math.floor(wz) * sizeX + Math.floor(wx)];
      var wy = wormRng.range(3, Math.max(5, hs - 6));
      var ang = wormRng.range(0, Math.PI * 2);
      var ddx = Math.cos(ang), ddz = Math.sin(ang), ddy = wormRng.range(-0.2, 0.2);
      var len = wormRng.int(25, 60);
      var rad = wormRng.range(1.5, 2.5);
      var r2 = rad * rad;
      for (var st = 0; st < len; st++) {
        var bx = Math.round(wx), by = Math.round(wy), bz = Math.round(wz);
        for (var yy = by - 3; yy <= by + 3; yy++) {
          if (yy < 2) continue;
          var colh = (bx >= 0 && bx < sizeX && bz >= 0 && bz < sizeZ) ? hArr[bz * sizeX + bx] : 0;
          if (yy > colh - 5) continue;
          for (var zz2 = bz - 3; zz2 <= bz + 3; zz2++) {
            for (var xx2 = bx - 3; xx2 <= bx + 3; xx2++) {
              var ex = xx2 - bx, ey = yy - by, ez = zz2 - bz;
              if (ex * ex + ey * ey + ez * ez > r2) continue;
              var idw = world.getBlock(xx2, yy, zz2);
              if (idw !== 0 && idw !== idBedrock) world.setBlock(xx2, yy, zz2, 0, 0, SILENT);
            }
          }
        }
        wx += ddx; wy += ddy; wz += ddz;
        ddx += wormRng.range(-0.3, 0.3); ddy += wormRng.range(-0.15, 0.15); ddz += wormRng.range(-0.3, 0.3);
        if (wx < 1) wx = 1; if (wx > sizeX - 2) wx = sizeX - 2;
        if (wz < 1) wz = 1; if (wz > sizeZ - 2) wz = sizeZ - 2;
        if (wy < 2) wy = 2; if (wy > sizeY - 6) wy = sizeY - 6;
      }
    }

    /* ---- water: fill every air voxel at or below sea level (source meta 8) ---- */
    for (z = 0; z < sizeZ; z++) {
      for (x = 0; x < sizeX; x++) {
        var ch3 = chunks.get((x >> 4) + ',' + (z >> 4));
        var bl3 = ch3.blocks, mt3 = ch3.meta;
        var bcol3 = (z & 15) * CSX + (x & 15);
        for (y = 1; y <= SEA; y++) {
          var pw = y * STRIDE + bcol3;
          if (bl3[pw] === 0) { bl3[pw] = WATER; mt3[pw] = 8; }
        }
      }
    }

    /* ---- vegetation: deterministic per column via noise (no global RNG order) ---- */
    function placeTree(tx, th, tz) {
      var trunkH = 4 + Math.floor(nVeg.value2(tx * 0.9 + 2.1, tz * 0.9 + 8.8) * 3);
      var topY = th + trunkH - 1;
      for (var ty = th; ty <= topY; ty++) {
        if (world.getBlock(tx, ty, tz) === 0) world.setBlock(tx, ty, tz, idLog, 0, SILENT);
      }
      for (var ly = topY - 1; ly <= topY + 1; ly++) {
        var r = (ly === topY + 1) ? 1 : 2;
        for (var ldx = -r; ldx <= r; ldx++) {
          for (var ldz = -r; ldz <= r; ldz++) {
            if (ldx * ldx + ldz * ldz > r * r + 1) continue;
            if (ldx === 0 && ldz === 0 && ly <= topY) continue; /* trunk cell */
            var lx = tx + ldx, lz = tz + ldz;
            if (!world.inBounds(lx, ly, lz)) continue;
            if (world.getBlock(lx, ly, lz) === 0) world.setBlock(lx, ly, lz, idLeaves, 0, SILENT);
          }
        }
      }
    }

    for (z = 0; z < sizeZ; z++) {
      for (x = 0; x < sizeX; x++) {
        i = z * sizeX + x;
        var hv = hArr[i], bv = bArr[i];
        var surfId = world.getBlock(x, hv - 1, z);
        var slopeOK = true;
        var nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (var nbi = 0; nbi < 4; nbi++) {
          var nx = x + nb[nbi][0], nz = z + nb[nbi][1];
          if (nx < 0 || nx >= sizeX || nz < 0 || nz >= sizeZ) { slopeOK = false; break; }
          if (Math.abs(hArr[nz * sizeX + nx] - hv) > 1) { slopeOK = false; break; }
        }
        if (bv === B_PLAINS || bv === B_FOREST) {
          if (surfId === idGrass && slopeOK) {
            var rt = nVeg.value2(x * 1.7 + 11.3, z * 1.7 + 5.9);
            var prob = bv === B_FOREST ? 0.022 : 0.005;
            if (rt < prob) placeTree(x, hv, z);
          } else if (surfId === idGrass) {
            var g = nVeg.value2(x * 0.4 + 9, z * 0.4 + 4);
            if (g >= 0.5 && g < 0.52) world.setBlock(x, hv - 1, z, idGravel, 0, SILENT);
          }
        } else if (bv === B_DESERT) {
          if (surfId === idSand && slopeOK) {
            var rc = nVeg.value2(x * 2.3 + 3.7, z * 2.3 + 1.1);
            if (rc < 0.006) {
              var ch = 1 + Math.floor(nVeg.value2(x * 1.3 + 0.5, z * 1.3 + 7.7) * 3);
              for (var ty2 = hv; ty2 < hv + ch; ty2++) {
                if (world.getBlock(x, ty2, z) === 0) world.setBlock(x, ty2, z, idCactus, 0, SILENT);
              }
            }
          }
        }
      }
    }

    world.rebuildHeights();
    world.markRegionDirty(0, 0, 0, sizeX - 1, sizeY - 1, sizeZ - 1);
  }

  function stats(world) {
    var byName = {};
    var solid = 0, air = 0, liquid = 0;
    var sizeX = world.sizeX, sizeY = world.sizeY, sizeZ = world.sizeZ;
    for (var z = 0; z < sizeZ; z++) {
      for (var x = 0; x < sizeX; x++) {
        for (var y = 0; y < sizeY; y++) {
          var id = world.getBlock(x, y, z);
          if (id === 0) { air++; continue; }
          if (MC.isLiquidBlock(id)) liquid++; else solid++;
          var nm = MC.block(id).name;
          byName[nm] = (byName[nm] || 0) + 1;
        }
      }
    }
    return { solid: solid, air: air, liquid: liquid, byName: byName };
  }

  MC.Generator = { generate: generate, stats: stats };
})(typeof window !== 'undefined' ? window : globalThis);
