/* Chunk mesher: world of blocks -> GPU-ready vertex/index buffers.
 *
 * MC.Mesher.build(world, cx, cz) ->
 *   { opaque: { vertices: Float32Array, indices: Uint32Array },
 *     trans:  { vertices: Float32Array, indices: Uint32Array } }
 *
 * Vertex layout (stride 7 floats): aPos(3) aUV(2) aLight(1) aFace(1).
 * Indices are per-chunk local, Uint32Array, 6 per quad (MC.FACE_INDICES).
 *
 * `opaque` holds solid cubes plus alpha-tested cutout geometry (leaves, cactus);
 * `trans` holds water and glass, which the renderer blends far-to-near.
 *
 * Loaded after constants.js, math.js, blocks.js, world.js. */
(function (root) {
  'use strict';
  var MC = (root.MC = root.MC || {});

  var STRIDE = 7;
  var WATER_TOP = 0.875;

  /* ---- growable scratch, reused across builds (no per-build churn) ---- */
  var oV = new Float32Array(1 << 14), oVn = 0;
  var oI = new Uint32Array(1 << 12), oIn = 0;
  var tV = new Float32Array(1 << 12), tVn = 0;
  var tI = new Uint32Array(1 << 10), tIn = 0;

  function growF(a, need) {
    if (a.length >= need) return a;
    var n = a.length;
    while (n < need) n *= 2;
    var b = new Float32Array(n);
    b.set(a);
    return b;
  }
  function growU(a, need) {
    if (a.length >= need) return a;
    var n = a.length;
    while (n < need) n *= 2;
    var b = new Uint32Array(n);
    b.set(a);
    return b;
  }

  /* ---- per-face AO offset tables (built once, normal-space aware) ------ */
  /* MC.AO_NEIGHBOURS gives one {side1,side2,corner} triple per face, pushed
   * along the face normal. For real per-corner AO we mirror the two in-face
   * axes depending on which side of the face the corner sits on. */
  var AO_TABLE = null;
  function buildAoTable() {
    var out = [];
    for (var f = 0; f < 6; f++) {
      var n = MC.FACE_NORMALS[f];
      var src = MC.AO_NEIGHBOURS[f];
      var axes = [];
      for (var a = 0; a < 3; a++) if (n[a] === 0) axes.push(a);
      var a0 = axes[0], a1 = axes[1];
      /* positive variant comes from the table; negative mirrors the axis */
      var s1p = [src.side1[0], src.side1[1], src.side1[2]];
      var s2p = [src.side2[0], src.side2[1], src.side2[2]];
      var s1n = [s1p[0], s1p[1], s1p[2]]; s1n[a0] = 2 * n[a0] - s1n[a0];
      var s2n = [s2p[0], s2p[1], s2p[2]]; s2n[a1] = 2 * n[a1] - s2n[a1];
      out.push({ n: n, a0: a0, a1: a1, s1p: s1p, s1n: s1n, s2p: s2p, s2n: s2n });
    }
    return out;
  }

  function emptyMesh() {
    return {
      opaque: { vertices: new Float32Array(0), indices: new Uint32Array(0) },
      trans: { vertices: new Float32Array(0), indices: new Uint32Array(0) }
    };
  }

  MC.Mesher = {};

  MC.Mesher.build = function (world, cx, cz) {
    var C = MC.C;
    var ch = world.chunkAt(cx, cz);
    if (!ch) return emptyMesh();
    if (!AO_TABLE) AO_TABLE = buildAoTable();

    var blocks = ch.blocks;
    var SX = C.CHUNK_SX, SY = C.CHUNK_SY, SZ = C.CHUNK_SZ;
    var ox = cx * SX, oz = cz * SZ;
    var sizeX = world.sizeX, sizeY = world.sizeY, sizeZ = world.sizeZ;
    var COLS = C.ATLAS_COLS, TILE = C.ATLAS_TILE_PX;
    var AW = COLS * TILE;                       /* atlas width in px */
    var INSET = 0.25;                           /* half-texel inset  */

    oVn = oIn = tVn = tIn = 0;

    /* ---- neighbour sampling (local array fast path, world fallback) ---- */
    function idAt(wx, wy, wz) {
      if (wy < 0 || wy >= sizeY || wx < 0 || wz < 0 || wx >= sizeX || wz >= sizeZ) return 0;
      var lx = wx - ox, lz = wz - oz;
      if (lx >= 0 && lx < SX && lz >= 0 && lz < SZ) {
        return blocks[(wy * SZ + lz) * SX + lx];
      }
      return world.getBlock(wx, wy, wz);
    }
    function skyAt(wx, wy, wz) {
      if (wy >= sizeY) return 15;                     /* open sky */
      if (wy < 0 || wx < 0 || wz < 0 || wx >= sizeX || wz >= sizeZ) return 0;
      var lx = wx - ox, lz = wz - oz;
      if (lx >= 0 && lx < SX && lz >= 0 && lz < SZ) {
        return ch.sky[(wy * SZ + lz) * SX + lx];
      }
      return world.skyAt(wx, wy, wz);
    }
    function blkAt(wx, wy, wz) {
      if (wy < 0 || wy >= sizeY || wx < 0 || wz < 0 || wx >= sizeX || wz >= sizeZ) return 0;
      var lx = wx - ox, lz = wz - oz;
      if (lx >= 0 && lx < SX && lz >= 0 && lz < SZ) {
        return ch.blk[(wy * SZ + lz) * SX + lx];
      }
      return world.blockLightAt(wx, wy, wz);
    }
    function opaqueAt(wx, wy, wz) {
      if (wy < 0) return true;                  /* world floor blocks faces */
      if (wy >= sizeY || wx < 0 || wz < 0 || wx >= sizeX || wz >= sizeZ) return false;
      var lx = wx - ox, lz = wz - oz;
      if (lx >= 0 && lx < SX && lz >= 0 && lz < SZ) {
        return MC.isOpaqueBlock(blocks[(wy * SZ + lz) * SX + lx]);
      }
      return world.isOpaqueAt(wx, wy, wz);
    }

    /* ---- quad emission ------------------------------------------------- */
    function emit(isTrans, vx, vy, vz, f, u0, u1, v0, v1, light, topY) {
      var face = MC.FACES[f];
      var corners = face.corners;
      var uvs = MC.FACE_UVS;
      var V = isTrans ? tV : oV, I = isTrans ? tI : oI;
      var vn = isTrans ? tVn : oVn;
      var inr = isTrans ? tIn : oIn;
      /* NOTE: vn counts VERTICES while V.length counts FLOATS — the capacity
       * check has to scale by STRIDE or writes past the end of the typed
       * array are silently dropped (truncated meshes, missing faces). */
      if (V.length < (vn + 4) * STRIDE) {
        V = growF(V, (vn + 4) * STRIDE);
        if (isTrans) tV = V; else oV = V;
      }
      if (I.length < inr + 6) {
        I = growU(I, inr + 6);
        if (isTrans) tI = I; else oI = I;
      }
      var ao = AO_TABLE[f];
      var base = vn;
      for (var k = 0; k < 4; k++) {
        var c = corners[k], uv = uvs[k];
        var cy = c[1] === 1 ? topY : 0;
        var p = vn * STRIDE;
        V[p] = vx + c[0];
        V[p + 1] = vy + cy;
        V[p + 2] = vz + c[2];
        V[p + 3] = uv[0] === 0 ? u0 : u1;
        /* Atlas row 0 is the FIRST row uploaded, so v=0 is the top of the
         * image while face uv.y=0 is the bottom of the block: sample the
         * tile's lower image edge there so side textures read upright. */
        V[p + 4] = uv[1] === 0 ? v0 : v1;
        V[p + 5] = light;
        V[p + 6] = f;
        vn++;
      }
      var idx = MC.FACE_INDICES;
      var q = inr;
      for (var m = 0; m < 6; m++) I[q + m] = base + idx[m];
      if (isTrans) { tVn = vn; tIn = q + 6; } else { oVn = vn; oIn = q + 6; }
    }

    /* ---- main voxel sweep --------------------------------------------- */
    for (var y = 0; y < SY; y++) {
      var wy = y;
      var rowBase = y * SZ;
      for (var z = 0; z < SZ; z++) {
        var wz = oz + z;
        var planeBase = (rowBase + z) * SX;
        for (var x = 0; x < SX; x++) {
          var id = blocks[planeBase + x];
          if (id === 0) continue;
          var b = MC.block(id);
          var vx = ox + x;

          var isLiquid = b.liquid;
          var isTransPass = !isLiquid && (b.pass === 'trans');
          var toTrans = isLiquid || isTransPass;

          /* lowered water surface when the voxel above is not water */
          var topY = 1;
          if (isLiquid && idAt(vx, wy + 1, wz) !== id) topY = WATER_TOP;

          for (var f = 0; f < 6; f++) {
            var nrm = MC.FACE_NORMALS[f];
            var nx = vx + nrm[0], ny = wy + nrm[1], nz = wz + nrm[2];
            var nid = idAt(nx, ny, nz);

            var emitFace;
            if (isLiquid) {
              /* Water only faces air and cutout blocks. Against an opaque or
               * blended neighbour that neighbour already emits its own face on
               * the very same plane, so emitting ours too stacked two blended
               * quads (submerged sides and bottoms read ~2x too dark). */
              emitFace = !MC.isLiquidBlock(nid) && !MC.isOpaqueBlock(nid) &&
                !(MC.block(nid) && MC.block(nid).pass === 'trans');
            } else if (b.opaque) {
              emitFace = !MC.isOpaqueBlock(nid) && !(ny < 0);
            } else {
              /* glass / leaves / cactus: no interior faces between same type */
              emitFace = nid !== id && !MC.isOpaqueBlock(nid) && !(ny < 0);
            }
            if (!emitFace) continue;

            /* ---- UV from atlas tile ---- */
            var ti = MC.tileFor(id, f);
            var col = ti % COLS, row = (ti / COLS) | 0;
            var u0 = (col * TILE + INSET) / AW;
            var u1 = ((col + 1) * TILE - INSET) / AW;
            var v0 = ((row + 1) * TILE - INSET) / AW;    /* tile bottom edge */
            var v1 = (row * TILE + INSET) / AW;          /* tile top edge    */

            /* ---- ambient occlusion, per corner ---- */
            var aoF = AO_TABLE[f];
            var lightSum = 0;
            var corners = MC.FACES[f].corners;
            /* AO is per-corner, but aLight is one value per vertex; we bake
             * the corner AO into each vertex so creases read correctly. */
            var shade = MC.FACE_SHADE[f];
            /* real light fields (see world.js): skylight flood-filled down and
             * sideways, plus block light from emissive blocks. aLight packs
             * both channels: sky in [0,1] plus block * 16. */
            var skyT = skyAt(nx, ny, nz) / 15;
            var blkRaw = blkAt(nx, ny, nz);   /* integer 0..15, packed as-is */

            var isT = toTrans;
            var startV = isT ? tVn : oVn;   /* patched per-corner below */

            emit(isT, vx, wy, wz, f, u0, u1, v0, v1, 0, topY);

            var VV = isT ? tV : oV;
            for (var k2 = 0; k2 < 4; k2++) {
              var cc = corners[k2];
              var o1 = cc[aoF.a0] === 1 ? aoF.s1p : aoF.s1n;
              var o2 = cc[aoF.a1] === 1 ? aoF.s2p : aoF.s2n;
              var s1 = opaqueAt(vx + o1[0], wy + o1[1], wz + o1[2]) ? 1 : 0;
              var s2 = opaqueAt(vx + o2[0], wy + o2[1], wz + o2[2]) ? 1 : 0;
              var cxo = o1[0] + o2[0] - nrm[0];
              var cyo = o1[1] + o2[1] - nrm[1];
              var czo = o1[2] + o2[2] - nrm[2];
              var cor = opaqueAt(vx + cxo, wy + cyo, wz + czo) ? 1 : 0;
              var aoV;
              if (s1 && s2) aoV = 0.45;
              else if (s1 || s2) aoV = 0.62;
              else if (cor) aoV = 0.72;
              else aoV = 1.0;
              var Ls = skyT * aoV * shade;
              if (Ls < 0.02) Ls = 0.02; else if (Ls > 1) Ls = 1;
              /* Pack the RAW integer block-light level (0..15) * 16. Packing a
               * fraction instead made floor() a 0/1 flag and mod() leak the
               * whole block channel into the sky channel (blown-out faces). */
              VV[(startV + k2) * STRIDE + 5] = Ls + blkRaw * 16;
            }
          }
        }
      }
    }

    return {
      opaque: {
        vertices: oVn ? oV.slice(0, oVn * STRIDE) : new Float32Array(0),
        indices: oIn ? oI.slice(0, oIn) : new Uint32Array(0)
      },
      trans: {
        vertices: tVn ? tV.slice(0, tVn * STRIDE) : new Float32Array(0),
        indices: tIn ? tI.slice(0, tIn) : new Uint32Array(0)
      }
    };
  };
})(typeof window !== 'undefined' ? window : globalThis);
