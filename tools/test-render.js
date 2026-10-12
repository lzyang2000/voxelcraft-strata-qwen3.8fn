/* Node smoke test for the render layer (no browser, no WebGL needed).
 * Run: node tools/test-render.js */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');
const ctx = { console, Math, Date, performance: { now: () => Date.now() } };
ctx.globalThis = ctx;
vm.createContext(ctx);
const files = [
  'src/core/constants.js', 'src/core/math.js', 'src/core/blocks.js', 'src/world/world.js',
  'src/world/generator.js', 'src/render/textures.js', 'src/render/mesher.js',
  'src/render/renderer.js'
];
for (const f of files) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const MC = ctx.MC;
/* vm-context typed arrays are not reachable as ctx.* properties, so compare
 * by constructor name instead of using instanceof against the host realm. */
function isType(v, name) {
  return !!v && typeof v === 'object' && typeof v.length === 'number' &&
    v.constructor && v.constructor.name === name;
}
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}

/* ------------------------------- syntax ------------------------------- */
console.log('node --check');
for (const f of ['src/render/textures.js', 'src/render/mesher.js', 'src/render/renderer.js']) {
  let good = true, err = '';
  try { cp.execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' }); }
  catch (e) { good = false; err = String(e.stderr || e.message).slice(0, 300); }
  ok('syntax ' + f, good, err);
}

/* ------------------------------ textures ------------------------------ */
console.log('textures');
const atlas = MC.Textures.generate();
const ATLAS_PX = MC.C.ATLAS_COLS * MC.C.ATLAS_TILE_PX;
ok('atlas width', atlas.width === ATLAS_PX, atlas.width);
ok('atlas height', atlas.height === ATLAS_PX, atlas.height);
ok('pixels length', atlas.pixels.length === ATLAS_PX * ATLAS_PX * 4, atlas.pixels.length);
ok('pixels typed', isType(atlas.pixels, 'Uint8Array'));

const T = MC.C.ATLAS_TILE_PX, COLS = MC.C.ATLAS_COLS;
function tileHasInk(ti) {
  const ox = (ti % COLS) * T, oy = ((ti / COLS) | 0) * T;
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      if (atlas.pixels[((oy + y) * ATLAS_PX + (ox + x)) * 4 + 3] > 0) return true;
    }
  }
  return false;
}
const emptyTiles = [];
for (let ti = 0; ti < MC.TILES.length; ti++) if (!tileHasInk(ti)) emptyTiles.push(MC.TILES[ti]);
ok('every tile has ink (' + MC.TILES.length + ')', MC.TILES.length === 32 && emptyTiles.length === 0, emptyTiles);

const atlas2 = MC.Textures.generate();
let same = atlas2.pixels.length === atlas.pixels.length;
if (same) for (let i = 0; i < atlas.pixels.length; i++) { if (atlas.pixels[i] !== atlas2.pixels[i]) { same = false; break; } }
ok('deterministic bytes', same);

/* only glass/leaves/water may carry partial/zero alpha */
const badAlpha = [];
for (let ti = 0; ti < MC.TILES.length; ti++) {
  const name = MC.TILES[ti];
  const allowPartial = name === 'glass' || name === 'leaves' || name === 'water';
  const ox = (ti % COLS) * T, oy = ((ti / COLS) | 0) * T;
  for (let y = 0; y < T && !badAlpha.includes(name); y++) {
    for (let x = 0; x < T; x++) {
      const a = atlas.pixels[((oy + y) * ATLAS_PX + (ox + x)) * 4 + 3];
      if (!allowPartial && a !== 255) { badAlpha.push(name + ' a=' + a); break; }
    }
  }
}
ok('opaque tiles stay fully opaque', badAlpha.length === 0, badAlpha);

/* leaves really do have holes, water really is translucent */
function alphaStats(name) {
  const ti = MC.TILE_INDEX[name];
  const ox = (ti % COLS) * T, oy = ((ti / COLS) | 0) * T;
  let holes = 0, sum = 0;
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
    const a = atlas.pixels[((oy + y) * ATLAS_PX + (ox + x)) * 4 + 3];
    if (a === 0) holes++;
    sum += a;
  }
  return { holes: holes / (T * T), mean: sum / (T * T) };
}
const leafS = alphaStats('leaves'), waterS = alphaStats('water'), glassS = alphaStats('glass');
ok('leaves have transparent pixels', leafS.holes > 0.05, leafS);
ok('water translucent', waterS.mean > 120 && waterS.mean < 230, waterS);
ok('glass mostly clear', glassS.mean < 140, glassS);

/* ------------------------------- mesher ------------------------------- */
console.log('mesher');
const id = (n) => MC.blockIdByName(n);
const w = new MC.World({ chunksX: 2, chunksZ: 2, seed: 11 });
for (let z = 0; z < w.sizeZ; z++) {
  for (let x = 0; x < w.sizeX; x++) {
    for (let y = 0; y < 8; y++) w.setBlock(x, y, z, id('stone'), 0, { silent: true });
  }
}
/* water column with air above, plus glass / leaves / sand caps */
w.setBlock(5, 8, 5, id('water'), 0, { silent: true });
w.setBlock(5, 9, 5, id('water'), 0, { silent: true });
w.setBlock(5, 10, 5, id('water'), 0, { silent: true });
w.setBlock(7, 8, 7, id('glass'), 0, { silent: true });
w.setBlock(9, 8, 9, id('leaves'), 0, { silent: true });
w.setBlock(11, 8, 11, id('sand'), 0, { silent: true });
w.rebuildHeights();
w.relightAll();

const mesh = MC.Mesher.build(w, 0, 0);
ok('mesh shape', !!(mesh.opaque && mesh.trans && mesh.opaque.vertices && mesh.opaque.indices),
  Object.keys(mesh));
ok('opaque mesh non-empty', mesh.opaque.vertices.length > 0 && mesh.opaque.indices.length > 0,
  [mesh.opaque.vertices.length, mesh.opaque.indices.length]);
ok('trans mesh non-empty', mesh.trans.vertices.length > 0 && mesh.trans.indices.length > 0,
  [mesh.trans.vertices.length, mesh.trans.indices.length]);
ok('opaque verts Float32Array', isType(mesh.opaque.vertices, 'Float32Array'));
ok('opaque idx Uint32Array', isType(mesh.opaque.indices, 'Uint32Array'));

function checkMesh(label, m) {
  const v = m.vertices, ix = m.indices;
  ok(label + ' vertex count / 7', v.length % 7 === 0, v.length);
  ok(label + ' index count / 6', ix.length % 6 === 0, ix.length);
  const vertCount = v.length / 7;
  let badIdx = 0, badFace = 0, badLight = 0, maxSky = 0, maxBlk = 0;
  for (let i = 0; i < ix.length; i++) if (!(ix[i] < vertCount)) badIdx++;
  for (let p = 0; p < vertCount; p++) {
    const f = v[p * 7 + 6];
    if (!(f >= 0 && f <= 5 && f === Math.floor(f))) badFace++;
    /* aLight packs sky [0.02,1] + the raw integer block level (0..15) * 16 */
    const L = v[p * 7 + 5];
    const blkRaw = Math.floor(L / 16), skyC = L - blkRaw * 16;
    if (!(skyC >= 0.019 && skyC <= 1.001) || !(blkRaw >= 0 && blkRaw <= 15)) badLight++;
    if (skyC > maxSky) maxSky = skyC;
    if (blkRaw > maxBlk) maxBlk = blkRaw;
  }
  ok(label + ' all indices < vertexCount', badIdx === 0, badIdx);
  ok(label + ' aFace integer 0..5', badFace === 0, badFace);
  ok(label + ' aLight packs sky[0.02,1] + blk(0..15)*16', badLight === 0, badLight);
  ok(label + ' some vertex is sunlit', maxSky > 0.5, maxSky);
  return { maxSky, maxBlk };
}
const lightStats = checkMesh('opaque', mesh.opaque);
checkMesh('trans', mesh.trans);
ok('sunlit faces reach near full skylight', lightStats.maxSky > 0.9, lightStats);
checkMesh('opaque', mesh.opaque);
checkMesh('trans', mesh.trans);

/* no faces between two adjacent opaque stone voxels:
 * the shared plane between voxel (8,4,8) and (9,4,8) sits at x = 9 */
function facesAtPlane(m, axis, plane, lo, hi, faceWant) {
  const v = m.vertices;
  let n = 0;
  for (let p = 0; p < v.length / 7; p++) {
    const o = p * 7;
    if (v[o + 6] !== faceWant) continue;
    if (Math.abs(v[o + axis] - plane) > 1e-4) continue;
    const a = (axis === 0) ? 1 : 0, b = (axis === 0) ? 2 : 1;
    if (v[o + a] < lo || v[o + a] > hi) continue;
    if (v[o + b] < lo || v[o + b] > hi) continue;
    n++;
  }
  return n;
}
const interior = facesAtPlane(mesh.opaque, 0, 9, 4, 6, 0) + facesAtPlane(mesh.opaque, 0, 9, 4, 6, 1);
ok('no interior faces between stone voxels', interior === 0, interior);
/* sanity: the same probe WOULD find the exposed top face at y = 8 */
const topFaces = facesAtPlane(mesh.opaque, 1, 8, 0, 16, 2);
ok('exposed top faces exist (probe works)', topFaces > 0, topFaces);

/* water with air above -> lowered top face at y + 0.875 */
let has0875 = false, maxY = -1;
for (const m of [mesh.trans, mesh.opaque]) {
  const v = m.vertices;
  for (let p = 0; p < v.length / 7; p++) {
    const y = v[p * 7 + 1];
    if (y > maxY) maxY = y;
    const frac = y - Math.floor(y);
    if (Math.abs(frac - 0.875) < 1e-4) has0875 = true;
  }
}
ok('water top face at y+0.875', has0875, maxY);

/* lowered water side faces never reach the full voxel top */
let waterVertsAbove = 0;
for (let p = 0; p < mesh.trans.vertices.length / 7; p++) {
  const o = p * 7;
  if (Math.abs(mesh.trans.vertices[o] - 5.5) < 0.6 && Math.abs(mesh.trans.vertices[o + 2] - 5.5) < 0.6) {
    if (mesh.trans.vertices[o + 1] > 10.875 + 1e-4) waterVertsAbove++;
  }
}
ok('water sides capped at 0.875', waterVertsAbove === 0, waterVertsAbove);

/* glass faces land in the trans bucket, leaves in the alpha-tested bucket */
const glassTile = MC.TILE_INDEX['glass'], leafTile = MC.TILE_INDEX['leaves'];
function tileInMesh(m, ti) {
  const v = m.vertices, u0 = ((ti % COLS) * T + 0.25) / ATLAS_PX;
  let n = 0;
  for (let p = 0; p < v.length / 7; p++) {
    if (Math.abs(v[p * 7 + 3] - u0) < 1e-5) n++;
  }
  return n;
}
ok('glass in trans mesh', tileInMesh(mesh.trans, glassTile) > 0, tileInMesh(mesh.trans, glassTile));
ok('leaves in opaque mesh', tileInMesh(mesh.opaque, leafTile) > 0, tileInMesh(mesh.opaque, leafTile));
ok('water in trans mesh', tileInMesh(mesh.trans, MC.TILE_INDEX['water']) > 0);

/* empty chunk -> empty (never null) */
const w2 = new MC.World({ chunksX: 1, chunksZ: 1, seed: 3 });
w2.relightAll();
const m0 = MC.Mesher.build(w2, 0, 0);
ok('empty chunk opaque empty', m0.opaque.vertices.length === 0 && m0.opaque.indices.length === 0);
ok('empty chunk trans empty', m0.trans.vertices.length === 0 && m0.trans.indices.length === 0);
ok('empty chunk typed', isType(m0.opaque.vertices, 'Float32Array') &&
  isType(m0.opaque.indices, 'Uint32Array'));

/* world floor (y<0 opaque) -> no bottom faces at y = 0 */
let bottomFaces = 0;
for (let p = 0; p < mesh.opaque.vertices.length / 7; p++) {
  const o = p * 7;
  if (mesh.opaque.vertices[o + 6] === 3 && Math.abs(mesh.opaque.vertices[o + 1] - 0) < 1e-4) bottomFaces++;
}
ok('no faces on the world floor', bottomFaces === 0, bottomFaces);

/* world edge reads as a cliff: faces at x = 0 (nx) on the boundary column */
let edgeFaces = 0;
for (let p = 0; p < mesh.opaque.vertices.length / 7; p++) {
  const o = p * 7;
  if (mesh.opaque.vertices[o + 6] === 1 && Math.abs(mesh.opaque.vertices[o] - 0) < 1e-4) edgeFaces++;
}
ok('world edge emits cliff faces', edgeFaces > 0, edgeFaces);

/* UV: side textures upright -> uv.y=0 maps to the LOWER atlas row edge */
function uvUpright(m, tileName) {
  const ti = MC.TILE_INDEX[tileName];
  const col = ti % COLS, row = (ti / COLS) | 0;
  const u0 = (col * T + 0.25) / ATLAS_PX, u1 = ((col + 1) * T - 0.25) / ATLAS_PX;
  const vBottom = ((row + 1) * T - 0.25) / ATLAS_PX;   /* tile bottom in image */
  const vTop = (row * T + 0.25) / ATLAS_PX;            /* tile top in image   */
  const v = m.vertices;
  let good = 0, bad = 0;
  for (let p = 0; p < v.length / 7; p++) {
    const o = p * 7;
    if (v[o + 6] !== 0) continue;                      /* +X faces only */
    const uu = v[o + 3];
    if (uu < u0 - 1e-5 || uu > u1 + 1e-5) continue;    /* not this tile */
    const uvY = MC.FACE_UVS[p % 4][1];
    const vv = v[o + 4];
    if ((uvY === 0 && Math.abs(vv - vBottom) < 1e-5) ||
        (uvY === 1 && Math.abs(vv - vTop) < 1e-5)) good++;
    else bad++;
  }
  return { good, bad };
}
const up = uvUpright(mesh.opaque, 'sand');
ok('side UV upright (not flipped)', up.bad === 0 && up.good > 0, up);

/* ------------------------- item entities ------------------------------ */
/* A mined block drops as a mini textured cube that floats and bobs, so the
 * mesher has to emit a centred, spun, per-block cube with the chunk vertex
 * layout. These checks pin that contract down. */
console.log('item entities');
const DZ = MC.C.DROP_ITEM_SIZE;
function oneItem(name, spin, pos, size) {
  return MC.Mesher.buildItems([{
    pos: pos || [5.5, 8.5, 5.5],
    size: size === undefined ? DZ : size,
    spin: spin || 0,
    blockId: MC.blockIdByName(name)
  }], w);
}
const iGrass = oneItem('grass', 0);
ok('item mesh shape', !!(iGrass.opaque && iGrass.trans &&
  iGrass.opaque.vertices && iGrass.opaque.indices), Object.keys(iGrass));
ok('one item = 24 verts', iGrass.opaque.vertices.length === 24 * 7, iGrass.opaque.vertices.length / 7);
ok('one item = 36 indices', iGrass.opaque.indices.length === 36, iGrass.opaque.indices.length);
ok('item verts Float32Array', isType(iGrass.opaque.vertices, 'Float32Array'));
ok('item idx Uint32Array', isType(iGrass.opaque.indices, 'Uint32Array'));
ok('opaque bucket empty for an opaque-free item',
  oneItem('water', 0).opaque.vertices.length === 0 && oneItem('water', 0).opaque.indices.length === 0);

/* several items batch into one mesh: 24/36 each, no shared vertices */
const many = MC.Mesher.buildItems([
  { pos: [1.5, 8.5, 1.5], size: DZ, spin: 0.3, blockId: id('stone') },
  { pos: [2.5, 8.5, 1.5], size: DZ, spin: 1.1, blockId: id('sand') },
  { pos: [3.5, 8.5, 1.5], size: DZ, spin: 2.4, blockId: id('grass') }
], w);
ok('3 opaque items = 72 verts / 108 indices',
  many.opaque.vertices.length === 72 * 7 && many.opaque.indices.length === 108,
  [many.opaque.vertices.length / 7, many.opaque.indices.length]);
{
  const v = many.opaque.vertices, ix = many.opaque.indices;
  let maxIdx = 0;
  for (let i = 0; i < ix.length; i++) if (ix[i] > maxIdx) maxIdx = ix[i];
  ok('item indices stay inside the mesh', maxIdx === 71, maxIdx);
  ok('every item owns its own 24 verts (maxIdx = verts-1)', maxIdx + 1 === v.length / 7);
}

/* centred on pos, never on the block corner: extents are +/- size/2 */
{
  const v = iGrass.opaque.vertices;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let p = 0; p < 24; p++) {
    for (let k = 0; k < 3; k++) {
      const q = v[p * 7 + k];
      if (q < mn[k]) mn[k] = q;
      if (q > mx[k]) mx[k] = q;
    }
  }
  const pos = [5.5, 8.5, 5.5], half = DZ / 2;
  let bad = [];
  for (let k = 0; k < 3; k++) {
    if (Math.abs(mn[k] - (pos[k] - half)) > 1e-6 || Math.abs(mx[k] - (pos[k] + half)) > 1e-6) {
      bad.push([k, mn[k], mx[k]]);
    }
  }
  ok('cube is centred on pos (extents = size/2)', bad.length === 0, bad);
}

/* UVs come from the block's own atlas tiles, per face */
/* expected atlas-tile bounds for a tile index (v is min/max because atlas
 * row 0 is the first uploaded row, so the tile's v edges arrive swapped) */
function expectTile(ti) {
  const col = ti % COLS, row = (ti / COLS) | 0;
  const va = ((row + 1) * T - 0.25) / ATLAS_PX, vb = (row * T + 0.25) / ATLAS_PX;
  return {
    u0: (col * T + 0.25) / ATLAS_PX, u1: ((col + 1) * T - 0.25) / ATLAS_PX,
    v0: Math.min(va, vb), v1: Math.max(va, vb)
  };
}
function faceTile(m, f) {
  const v = m.vertices, us = [], vs = [];
  for (let p = 0; p * 7 < v.length; p++) {
    if (v[p * 7 + 6] !== f) continue;
    us.push(v[p * 7 + 3]); vs.push(v[p * 7 + 4]);
  }
  return { n: us.length, u0: Math.min.apply(null, us), u1: Math.max.apply(null, us),
    v0: Math.min.apply(null, vs), v1: Math.max.apply(null, vs) };
}
function tileMatches(m, f, blockName) {
  const got = faceTile(m, f), want = expectTile(MC.tileFor(MC.blockIdByName(blockName), f));
  if (got.n !== 4) return 'verts';
  for (const k of ['u0', 'u1', 'v0', 'v1']) {
    if (Math.abs(got[k] - want[k]) > 1e-6) return k + ' ' + got[k] + ' != ' + want[k];
  }
  return null;
}
const gid = id('grass');
ok('grass item +Y uses the top tile', tileMatches(iGrass.opaque, 2, 'grass') === null,
  [faceTile(iGrass.opaque, 2), MC.tileFor(gid, 2)]);
ok('grass item -Y uses the bottom tile', tileMatches(iGrass.opaque, 3, 'grass') === null,
  [faceTile(iGrass.opaque, 3), MC.tileFor(gid, 3)]);
{
  const sides = [0, 1, 4, 5].map(f => tileMatches(iGrass.opaque, f, 'grass')).filter(x => x !== null);
  ok('grass item 4 sides use the side tile', sides.length === 0, sides);
  ok('grass top tile really differs from its side tile',
    MC.tileFor(gid, 2) !== MC.tileFor(gid, 0), [MC.tileFor(gid, 2), MC.tileFor(gid, 0)]);
}
ok('stone item sides use the stone tile (not grass)',
  tileMatches(oneItem('stone', 0).opaque, 0, 'stone') === null,
  [faceTile(oneItem('stone', 0).opaque, 0), MC.TILE_INDEX['stone']]);

/* aLight uses the documented chunk packing: sky[0.02,1] + raw level * 16 */
{
  const v = iGrass.opaque.vertices;
  let bad = 0, maxSky = 0, maxBlk = 0, faces = new Set();
  for (let p = 0; p * 7 < v.length; p++) {
    const L = v[p * 7 + 5];
    const bc = Math.floor(L / 16), sc = L - bc * 16;
    if (!(bc >= 0 && bc <= 15) || !(sc >= 0.02 - 1e-6 && sc <= 1 + 1e-6)) bad++;
    if (sc > maxSky) maxSky = sc;
    if (bc > maxBlk) maxBlk = bc;
    faces.add(v[p * 7 + 6]);
  }
  ok('item aLight decodes as sky + blk*16', bad === 0, bad);
  ok('item aFace covers all 6 faces', faces.size === 6, Array.from(faces));
  /* the item floats in an open-air cell, so it must read full daylight */
  ok('sunlit item reaches near-full sky channel', maxSky > 0.9, maxSky);
  ok('no block light in an unlit cell', maxBlk === 0, maxBlk);
  /* per-face shading still applies (top brighter than bottom) */
  const lightOf = (m, f) => {
    const v2 = m.vertices;
    for (let p = 0; p * 7 < v2.length; p++) if (v2[p * 7 + 6] === f) return v2[p * 7 + 5];
    return -1;
  };
  ok('item faces keep FACE_SHADE (top > bottom)',
    lightOf(iGrass.opaque, 2) > lightOf(iGrass.opaque, 3),
    [lightOf(iGrass.opaque, 2), lightOf(iGrass.opaque, 3)]);
}
/* an item drifting past a light source picks up the block-light channel */
{
  const wlit = new MC.World({ chunksX: 2, chunksZ: 2, seed: 21 });
  wlit.setBlock(16, 7, 16, id('glowstone'), 0, { silent: true });
  wlit.relightAll();
  const lit = MC.Mesher.buildItems([{ pos: [16.5, 7.5, 16.5], size: DZ, spin: 0, blockId: id('stone') }], wlit);
  const v = lit.opaque.vertices;
  const L = v[5], bc = Math.floor(L / 16), sc = L - bc * 16;
  ok('item samples block light from its own cell', bc > 0 && bc <= 15 && sc >= 0.02 && sc <= 1,
    { L, bc, sc, want: wlit.blockLightAt(16, 7, 16) });
  ok('item block channel equals world.blockLightAt', bc === wlit.blockLightAt(16, 7, 16),
    [bc, wlit.blockLightAt(16, 7, 16)]);
}

/* translucent blocks drop into the blended bucket, everything else opaque */
{
  const all = MC.Mesher.buildItems([
    { pos: [1.5, 8.5, 1.5], size: DZ, spin: 0, blockId: id('water') },
    { pos: [2.5, 8.5, 1.5], size: DZ, spin: 0, blockId: id('glass') },
    { pos: [3.5, 8.5, 1.5], size: DZ, spin: 0, blockId: id('stone') },
    { pos: [4.5, 8.5, 1.5], size: DZ, spin: 0, blockId: id('sand') },
    { pos: [5.5, 8.5, 1.5], size: DZ, spin: 0, blockId: id('grass') }
  ], w);
  ok('water + glass items land in trans',
    all.trans.vertices.length === 48 * 7 && all.trans.indices.length === 72,
    [all.trans.vertices.length / 7, all.trans.indices.length]);
  ok('stone / sand / grass items land in opaque',
    all.opaque.vertices.length === 72 * 7 && all.opaque.indices.length === 108,
    [all.opaque.vertices.length / 7, all.opaque.indices.length]);
  ok('water item uses the water tile',
    tileMatches(oneItem('water', 0).trans, 2, 'water') === null,
    faceTile(oneItem('water', 0).trans, 2));
  ok('glass item uses the glass tile',
    tileMatches(oneItem('glass', 0).trans, 0, 'glass') === null,
    faceTile(oneItem('glass', 0).trans, 0));
}

/* bad items never reach the GPU: skipped, and no NaN in the buffer */
{
  const junk = MC.Mesher.buildItems([
    { pos: [NaN, 8.5, 1.5], size: DZ, spin: 0, blockId: id('stone') },
    { pos: [1.5, Infinity, 1.5], size: DZ, spin: 0, blockId: id('stone') },
    { pos: [1.5, 8.5, 1.5], size: NaN, spin: 0, blockId: id('stone') },
    { pos: [1.5, 8.5, 1.5], size: 0, spin: 0, blockId: id('stone') },
    { pos: [1.5, 8.5, 1.5], size: DZ, spin: 0, blockId: 0 },
    { pos: [1.5, 8.5, 1.5], size: DZ, spin: 0, blockId: 9999 },
    { pos: [1.5, 8.5], size: DZ, spin: 0, blockId: id('stone') },
    null,
    { pos: [6.5, 8.5, 6.5], size: DZ, spin: 0.4, blockId: id('stone') }
  ], w);
  ok('bad items are skipped, good one survives',
    junk.opaque.vertices.length === 24 * 7 && junk.opaque.indices.length === 36,
    [junk.opaque.vertices.length / 7, junk.opaque.indices.length]);
  let nan = 0;
  for (const m of [junk.opaque, junk.trans]) {
    for (let i = 0; i < m.vertices.length; i++) if (!(m.vertices[i] > -Infinity && m.vertices[i] < Infinity)) nan++;
  }
  ok('no NaN/Infinity in an item buffer', nan === 0, nan);
  ok('no items -> empty typed arrays',
    MC.Mesher.buildItems([], w).opaque.vertices.length === 0 &&
    isType(MC.Mesher.buildItems([], w).opaque.indices, 'Uint32Array') &&
    MC.Mesher.buildItems(null, w).trans.indices.length === 0);
}

/* THE important one: every triangle's geometric normal must point along the
 * (spun) aFace normal. A winding flip from the Y rotation reads as dot = -1
 * and would make the cube render inside-out under GL culling. */
function itemWinding(m, spin) {
  const v = m.vertices, ix = m.indices;
  const c = Math.cos(spin), s = Math.sin(spin);
  let bad = 0, worst = 2;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 7, b = ix[t + 1] * 7, d = ix[t + 2] * 7;
    const e1 = [v[b] - v[a], v[b + 1] - v[a + 1], v[b + 2] - v[a + 2]];
    const e2 = [v[d] - v[a], v[d + 1] - v[a + 1], v[d + 2] - v[a + 2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    const fn = MC.FACE_NORMALS[v[a + 6]];
    /* the geometry is spun about Y, so the outward normal spins with it */
    const wx = fn[0] * c + fn[2] * s, wz = -fn[0] * s + fn[2] * c;
    const dot = (n[0] * wx + n[1] * fn[1] + n[2] * wz) / len;
    if (dot < 0.999) { bad++; if (dot < worst) worst = dot; }
  }
  return { tris: ix.length / 3, bad, worst };
}
for (const spin of [0, 0.3, 0.7854, 1.5708, 2.2, 3.1416, 3.9, -0.9, 6.283]) {
  const st = itemWinding(oneItem('stone', spin).opaque, spin);
  ok('winding CCW from outside at spin ' + spin, st.bad === 0 && st.tris === 12, st);
}
{
  const tr = itemWinding(oneItem('water', 2.2).trans, 2.2);
  ok('winding CCW from outside on a trans item', tr.bad === 0 && tr.tris === 12, tr);
  const mm = itemWinding(many.opaque, 0);
  ok('multi-item mesh has 36 triangles (3 x 12)', mm.tris === 36, mm);
}
/* the spin must actually rotate the cube (a no-op rotation would pass above) */
{
  const a = oneItem('stone', 0).opaque.vertices, b = oneItem('stone', 0.7).opaque.vertices;
  let moved = 0;
  for (let i = 0; i < 24; i++) if (Math.abs(a[i * 7] - b[i * 7]) > 1e-3 || Math.abs(a[i * 7 + 2] - b[i * 7 + 2]) > 1e-3) moved++;
  let ySame = 0;
  for (let i = 0; i < 24; i++) if (Math.abs(a[i * 7 + 1] - b[i * 7 + 1]) < 1e-9) ySame++;
  ok('spin rotates x/z only (yaw, not tumble)', moved >= 16 && ySame === 24, { moved, ySame });
}

/* an item outside the voxel grid (thrown hard, or a drop at the world edge)
 * must still mesh: the light accessors clamp to a number, never undefined. */
{
  const oobPos = [-3, w.sizeY + 5, w.sizeZ + 7];
  const oob = MC.Mesher.buildItems([{ pos: oobPos, size: DZ, spin: 0.6, blockId: id('stone') }], w);
  ok('out-of-bounds item still meshes (24 verts / 36 idx)',
    oob.opaque.vertices.length === 24 * 7 && oob.opaque.indices.length === 36,
    [oob.opaque.vertices.length / 7, oob.opaque.indices.length]);
  {
    const v = oob.opaque.vertices;
    let nan = 0, bad = 0, sample = null;
    for (let p = 0; p * 7 < v.length; p++) {
      for (let k = 0; k < 5; k++) {
        if (!(v[p * 7 + k] > -Infinity && v[p * 7 + k] < Infinity)) nan++;
      }
      const L = v[p * 7 + 5];
      const bc = Math.floor(L / 16), sc = L - bc * 16;
      if (!(bc >= 0 && bc <= 15) || !(sc >= 0.02 - 1e-6 && sc <= 1 + 1e-6)) bad++;
      if (!sample) sample = { L, bc, sc };
    }
    ok('out-of-bounds item has no NaN vertex', nan === 0, nan);
    ok('out-of-bounds item light still decodes', bad === 0, sample);
  }
  ok('skyAt/blockLightAt return numbers outside the grid',
    typeof w.skyAt(oobPos[0], oobPos[1], oobPos[2]) === 'number' &&
    typeof w.blockLightAt(oobPos[0], oobPos[1], oobPos[2]) === 'number' &&
    typeof w.skyAt(-3, -9, -9) === 'number' &&
    typeof w.blockLightAt(-3, -9, -9) === 'number',
    [w.skyAt(oobPos[0], oobPos[1], oobPos[2]), w.blockLightAt(oobPos[0], oobPos[1], oobPos[2])]);
  const ow = itemWinding(oob.opaque, 0.6);
  ok('out-of-bounds item winding stays CCW', ow.bad === 0 && ow.tris === 12, ow);
}

/* ---- live view: the per-frame path must not allocate every frame --------
 * game.js calls buildItems(list, world, false) once per frame. Snapshot mode
 * (the default) keeps its private-copy contract so tests and tools can hold a
 * mesh across later builds; live mode hands back views of the mesher's own
 * scratch, which the renderer uploads synchronously before the next frame. */
{
  const spec = [
    { pos: [4.5, 9.5, 4.5], size: DZ, spin: 0.4, blockId: id('stone') },
    { pos: [5.5, 9.5, 4.5], size: DZ, spin: 1.9, blockId: id('grass') },
    { pos: [6.5, 9.5, 4.5], size: DZ * 0.5, spin: 2.6, blockId: id('glass') }
  ];
  const snap = MC.Mesher.buildItems(spec, w);
  const live = MC.Mesher.buildItems(spec, w, false);
  function samePart(a, b) {
    if (a.vertices.length !== b.vertices.length || a.indices.length !== b.indices.length) return false;
    for (let i = 0; i < a.vertices.length; i++) if (a.vertices[i] !== b.vertices[i]) return false;
    for (let i = 0; i < a.indices.length; i++) if (a.indices[i] !== b.indices[i]) return false;
    return true;
  }
  ok('live view has the same shape as a snapshot',
    live.opaque.vertices.length === snap.opaque.vertices.length &&
    live.opaque.indices.length === snap.opaque.indices.length &&
    live.trans.vertices.length === snap.trans.vertices.length &&
    live.trans.indices.length === snap.trans.indices.length,
    [live.opaque.vertices.length / 7, live.trans.vertices.length / 7]);
  ok('live view content is identical to the snapshot',
    samePart(live.opaque, snap.opaque) && samePart(live.trans, snap.trans));
  ok('live view is still a typed array of the right kind',
    isType(live.opaque.vertices, 'Float32Array') && isType(live.opaque.indices, 'Uint32Array') &&
    isType(live.trans.vertices, 'Float32Array') && isType(live.trans.indices, 'Uint32Array'));
  /* A subarray view sits inside a larger scratch allocation, so its backing
   * ArrayBuffer is bigger than the view itself. slice() would have produced a
   * standalone buffer exactly as large as the content. */
  ok('live view is a view, not a private copy (backing buffer is larger)',
    live.opaque.vertices.buffer.byteLength > live.opaque.vertices.byteLength &&
    live.trans.vertices.buffer.byteLength > live.trans.vertices.byteLength,
    [live.opaque.vertices.buffer.byteLength, live.opaque.vertices.byteLength]);

  /* Repeated live builds must reuse the same backing store: a fresh
     Float32Array per frame is exactly the regression this guards. */
  const backs = [];
  for (let f = 0; f < 40; f++) {
    const m = MC.Mesher.buildItems(spec, w, false);
    backs.push([m.opaque.vertices.buffer, m.opaque.indices.buffer,
                m.trans.vertices.buffer, m.trans.indices.buffer]);
  }
  let reused = true;
  for (let i = 1; i < backs.length; i++) {
    for (let k = 0; k < 4; k++) if (backs[i][k] !== backs[0][k]) reused = false;
  }
  ok('40 live builds reuse the same 4 backing buffers (no per-frame allocation)', reused);

  /* ... and a live result is only valid until the next build, by contract. */
  const first = MC.Mesher.buildItems([{ pos: [4.5, 9.5, 4.5], size: DZ, spin: 0, blockId: id('stone') }], w, false);
  const firstLen = first.opaque.vertices.length;
  MC.Mesher.buildItems([{ pos: [4.5, 9.5, 4.5], size: DZ, spin: 0, blockId: id('stone') },
                        { pos: [5.5, 9.5, 4.5], size: DZ, spin: 0, blockId: id('stone') }], w, false);
  ok('a live view is overwritten by the next build (documented contract)',
    first.opaque.vertices.length !== firstLen ||
    first.opaque.vertices[0] !== 4.5, first.opaque.vertices.length / 7);
  ok('an empty live build still yields empty typed arrays',
    MC.Mesher.buildItems([], w, false).opaque.indices.length === 0);
}

/* --------------------- renderer: item draw pass ----------------------- */
/* The item meshes draw with the chunk program through dedicated dynamic
 * buffers, so the fake GL log must show exactly one extra drawElements per
 * non-empty bucket and stats.verts must count the item vertices. */
console.log('renderer item pass');
{
  const { createEnv } = require('./fake-dom');
  const env = createEnv('<canvas id="game"></canvas>');
  const r = new MC.Renderer(env.canvas);
  r.setAtlas(atlas);
  r.resize();
  const state = {
    camera: { position: [8.5, 12.5, 8.5], yaw: 0.6, pitch: -0.3, fov: MC.C.FOV },
    timeOfDay: 0.5, sunDir: [0.2, -0.9, 0.1], particles: null, items: null
  };
  r.render(state);
  const draws0 = env.log.drawElements, verts0 = r.stats.verts;
  ok('no chunks, no items: no drawElements', draws0 === 0 && verts0 === 0, { draws0, verts0 });
  ok('sky still draws', env.log.drawArrays >= 1, env.log.drawArrays);

  const one = oneItem('stone', 0.4);
  state.items = one;
  r.render(state);
  ok('opaque items add exactly one drawElements',
    env.log.drawElements === draws0 + 1, [draws0, env.log.drawElements]);
  /* stats is reset every frame, so it reports that frame's draw total */
  ok('stats.verts counts the item vertices',
    r.stats.verts === verts0 + one.opaque.vertices.length / 7,
    [verts0, r.stats.verts, one.opaque.vertices.length / 7]);
  ok('stats.drawCalls counts the item draw', r.stats.drawCalls >= 2, r.stats);

  const d1 = env.log.drawElements;
  state.items = null;
  r.render(state);
  ok('state.items = null draws nothing extra',
    env.log.drawElements === d1 && r.stats.verts === 0,
    [d1, env.log.drawElements, r.stats.verts]);
  state.items = MC.Mesher.buildItems([], w);
  r.render(state);
  ok('empty item meshes draw nothing',
    env.log.drawElements === d1 && r.stats.verts === 0,
    [d1, env.log.drawElements, r.stats.verts]);

  /* the renderer must accept the live (non-snapshot) mesh the game builds each
   * frame: it only reads .length and streams the used range, so a view into
   * the mesher scratch uploads exactly like a private copy. */
  {
    const liveBoth = MC.Mesher.buildItems([
      { pos: [8.5, 12.5, 6.5], size: DZ, spin: 0.2, blockId: id('stone') },
      { pos: [8.5, 12.5, 6.5], size: DZ, spin: 0.2, blockId: id('water') }
    ], w, false);
    const dLive = env.log.drawElements;
    state.items = liveBoth;
    r.render(state);
    ok('a live (scratch-backed) item mesh still draws both buckets',
      env.log.drawElements === dLive + 2, [dLive, env.log.drawElements]);
    ok('a live item mesh uploads the same vertex count as a snapshot',
      r.stats.verts === (liveBoth.opaque.vertices.length + liveBoth.trans.vertices.length) / 7,
      r.stats.verts);
  }

  /* re-baseline: the live-view block above added draws of its own */
  const dSnap = env.log.drawElements;
  const both = MC.Mesher.buildItems([
    { pos: [8.5, 12.5, 6.5], size: DZ, spin: 0.2, blockId: id('stone') },
    { pos: [8.5, 12.5, 6.5], size: DZ, spin: 0.2, blockId: id('water') }
  ], w);
  state.items = both;
  r.render(state);
  ok('opaque + trans items draw twice',
    env.log.drawElements === dSnap + 2, [dSnap, env.log.drawElements]);
  ok('both buckets counted in stats.verts',
    r.stats.verts === (both.opaque.vertices.length + both.trans.vertices.length) / 7,
    [r.stats.verts]);

  /* chunksDrawn counts CHUNKS only, and an item draw never depends on a
   * chunk surviving frustum culling. */
  r.updateChunk('0,0', MC.Mesher.build(w, 0, 0));
  const dNear = env.log.drawElements;
  r.render(state);
  ok('a visible chunk counts in chunksDrawn', r.stats.chunksDrawn >= 1, r.stats);
  ok('item draws never inflate chunksDrawn',
    env.log.drawElements - dNear === r.stats.chunksDrawn + 2,
    { draws: env.log.drawElements - dNear, chunks: r.stats.chunksDrawn });

  /* park the camera far away and looking the other way: every chunk is culled
   * (distance + frustum), yet the item cubes must still draw. */
  state.camera.position = [400.5, 12.5, 400.5];
  state.camera.yaw = Math.PI;
  state.camera.pitch = 0;
  const dFar = env.log.drawElements;
  r.render(state);
  ok('every chunk culled: chunksDrawn is 0', r.stats.chunksDrawn === 0, r.stats);
  ok('items still draw with every chunk culled',
    env.log.drawElements === dFar + 2, [dFar, env.log.drawElements]);
  ok('culled frame still counts the item verts',
    r.stats.verts === (both.opaque.vertices.length + both.trans.vertices.length) / 7, r.stats.verts);
  state.camera.position = [8.5, 12.5, 8.5];
  state.camera.yaw = 0.6;
  state.camera.pitch = -0.3;

  /* the dynamic buffers grow once, then stream the used range */
  const bd0 = env.log.bufferData;
  r.render(state);
  r.render(state);
  ok('steady-state item frames reuse the buffers (no bufferData churn)',
    env.log.bufferData === bd0, [bd0, env.log.bufferData]);
  ok('item buffers exist', !!r._itemVAO && !!r._itemBuf && !!r._itemIdx && r._itemCap > 0,
    { cap: r._itemCap, idxCap: r._itemIdxCap });

  r.dispose();
  ok('dispose clears the item GPU refs',
    r._itemVAO === null || r.gl === null, r.gl);
}

/* --------------------- camera / view-matrix contract -------------------- */
/* Regression: MC.M4.view used to store R instead of R^T, which mirrored the
 * camera in yaw AND pitch -- the crosshair (MC.Player.getLook + the raycast)
 * aimed one way while the pixels showed another, and a camera pitched
 * straight down rendered only sky. The view matrix must agree with getLook. */
console.log('camera contract');
function viewAt(px, py, pz, yaw, pitch) {
  const o = new MC.M4.create();
  MC.M4.view(o, px, py, pz, yaw, pitch);
  return o;
}
function mulPoint(m, p) {
  const x = p[0], y = p[1], z = p[2];
  return [m[0] * x + m[4] * y + m[8] * z + m[12],
          m[1] * x + m[5] * y + m[9] * z + m[13],
          m[2] * x + m[6] * y + m[10] * z + m[14],
          m[3] * x + m[7] * y + m[11] * z + m[15]];
}
/* the exact expression MC.Player.getLook() returns */
function lookOf(yaw, pitch) {
  return [-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch),
          -Math.cos(yaw) * Math.cos(pitch)];
}
const cams = [[0, 0], [0.7, -0.28], [2.4, 1.1], [-1.9, 0], [0.7, -1.4364],
              [Math.PI / 2, 0], [-Math.PI / 2, 0.6], [0.3, 1.55]];
let aimErr = 0, basisErr = 0;
for (const [yaw, pitch] of cams) {
  const eye = [64.5, 40.62, 64.5], v = viewAt(eye[0], eye[1], eye[2], yaw, pitch);
  const f = lookOf(yaw, pitch);
  for (const d of [1, 3, 7.5]) {
    const q = mulPoint(v, [eye[0] + f[0] * d, eye[1] + f[1] * d, eye[2] + f[2] * d]);
    const e = Math.max(Math.abs(q[0]), Math.abs(q[1]), Math.abs(q[2] + d));
    if (e > aimErr) aimErr = e;   /* float32 storage: compare with a real eps */
  }
  /* the renderer derives the sky basis from the rows of the stored matrix */
  const bf = [-v[2], -v[6], -v[10]], br = [v[0], v[4], v[8]], bu = [v[1], v[5], v[9]];
  const wantR = [Math.cos(yaw), 0, -Math.sin(yaw)];
  /* world up = R * (0,1,0) = column 1 of R, so it leans with yaw too */
  const wantU = [Math.sin(yaw) * Math.sin(pitch), Math.cos(pitch),
                 Math.cos(yaw) * Math.sin(pitch)];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  basisErr = Math.max(basisErr, Math.abs(dot(bf, f) - 1), Math.abs(dot(br, wantR) - 1),
    Math.abs(dot(bu, wantU) - 1), Math.abs(dot(bf, br)), Math.abs(dot(bf, bu)));
}
ok('view matrix aims where getLook aims (max error)', aimErr < 1e-4, aimErr);
ok('renderer sky basis matches forward/right/up', basisErr < 1e-6, basisErr);

/* a camera looking straight down must see the ground in front of it */
{
  const eye = [71.5, 42.1, 68], yaw = 0, pitch = -Math.PI / 2 + 0.01;
  const proj = new MC.M4.create(), view = new MC.M4.create(), vp = new MC.M4.create();
  MC.M4.perspective(proj, MC.C.FOV * Math.PI / 180, 1280 / 633, MC.C.NEAR, MC.C.FAR);
  MC.M4.view(view, eye[0], eye[1], eye[2], yaw, pitch);
  MC.M4.multiply(vp, proj, view);
  const q = mulPoint(vp, [71.5, 39, 68]);           /* ground 3 blocks below */
  const inFront = q[3] > 0;
  const onScreen = Math.abs(q[0] / q[3]) <= 1 && Math.abs(q[1] / q[3]) <= 1 &&
    Math.abs(q[2] / q[3]) <= 1;
  ok('ground below a downward camera is in front of it', inFront, q[3]);
  ok('ground below a downward camera is on screen', onScreen,
    [q[0] / q[3], q[1] / q[3], q[2] / q[3]]);
}

/* ------------------------- block light -------------------------------- */
/* Regression: the mesher used to pack a FRACTIONAL block-light channel, which
 * the shader decoded as a 0/1 flag while mod() leaked the whole fraction into
 * the SKY channel (values up to ~16 => pure-white faces around any light). */
console.log('block light');
const wl = new MC.World({ chunksX: 2, chunksZ: 2, seed: 21 });
for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) {
  for (let y = 0; y < 6; y++) wl.setBlock(x, y, z, id('stone'), 0, { silent: true });
}
wl.setBlock(16, 6, 16, id('glowstone'), 0, { silent: true });
wl.relightAll();
const ml = MC.Mesher.build(wl, 1, 1);
let litVerts = 0, leaked = 0, maxRaw = 0;
{
  const v = ml.opaque.vertices;
  for (let p = 0; p * 7 < v.length; p++) {
    const L = v[p * 7 + 5];
    const raw = Math.floor(L / 16), skyC = L - raw * 16;
    if (raw > maxRaw) maxRaw = raw;
    if (raw > 0) litVerts++;
    if (skyC > 1.001 || skyC < 0) leaked++;
  }
}
ok('glowstone lights neighbouring faces', litVerts > 20, litVerts);
/* a face samples the light of the cell it faces, so the brightest face next to
 * a level-15 source reads 14 (the source cell itself is never a face vertex) */
ok('block light reaches near-full level next to the source', maxRaw === 14, maxRaw);
ok('block channel never leaks into the sky channel', leaked === 0, leaked);
ok('block light falls off by one per cell and dies at distance 15',
  wl.blockLightAt(16, 6, 16) === 15 && wl.blockLightAt(16, 6, 20) === 11 &&
  wl.blockLightAt(16, 6, 24) === 7 && wl.blockLightAt(16, 6, 31) === 0,
  [wl.blockLightAt(16, 6, 16), wl.blockLightAt(16, 6, 20),
   wl.blockLightAt(16, 6, 24), wl.blockLightAt(16, 6, 31)]);
checkMesh('lit opaque', ml.opaque);

/* ---------------- water faces vs. its container ----------------------- */
/* Regression: water emitted faces on the exact same plane as the opaque /
 * glass blocks it was touching, so two blended quads stacked there and
 * submerged sides read about twice as dark. */
console.log('water vs container');
function basin(glassWall) {
  const w = new MC.World({ chunksX: 1, chunksZ: 1, seed: 22 });
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
    w.setBlock(x, 3, z, id('stone'), 0, { silent: true });          /* floor */
    for (let y = 4; y <= 6; y++) {
      if (x === 0 || x === 15 || z === 0 || z === 15) {
        const glass = glassWall && x === 0 && z >= 3 && z <= 6;
        w.setBlock(x, y, z, glass ? id('glass') : id('stone'), 0, { silent: true });
      } else {
        w.setBlock(x, y, z, id('water'), 8, { silent: true });
      }
    }
  }
  w.relightAll();
  return w;
}

const mStone = MC.Mesher.build(basin(false), 0, 0);
const wallFaces = facesAtPlane(mStone.trans, 0, 1, 3, 7, 0) + facesAtPlane(mStone.trans, 0, 1, 3, 7, 1);
const floorFaces = facesAtPlane(mStone.trans, 1, 4, 1, 14, 3);
ok('water emits no face against an opaque wall', wallFaces === 0, wallFaces);
ok('water emits no face against an opaque floor', floorFaces === 0, floorFaces);
/* the container still draws its own faces, so there is no hole at the seam */
ok('opaque wall draws the shared plane',
  facesAtPlane(mStone.opaque, 0, 1, 3, 7, 0) > 0, facesAtPlane(mStone.opaque, 0, 1, 3, 7, 0));
ok('opaque floor draws the shared plane',
  facesAtPlane(mStone.opaque, 1, 4, 1, 14, 2) > 0, facesAtPlane(mStone.opaque, 1, 4, 1, 14, 2));
/* the open top surface is still there: one lowered quad per water column */
const topWater = facesAtPlane(mStone.trans, 1, 6.875, 0, 16, 2);
ok('water top surface still meshed', topWater === 4 * 196, topWater);
/* whole-basin invariant: 14x14 columns x 3 levels, every face but the top is
 * against a solid wall or floor, so exactly 196 blended quads may exist */
ok('sealed basin has exactly 196 blended quads (no duplicate seams)',
  mStone.trans.indices.length / 6 === 196, mStone.trans.indices.length / 6);
checkMesh('stone-basin opaque', mStone.opaque);
checkMesh('stone-basin trans', mStone.trans);

/* glass wall: 12 glass blocks (x=0, y=4..6, z=3..6) each draw exactly one
 * blended quad on the shared plane x = 1 -- water must not add a second */
const mGlass = MC.Mesher.build(basin(true), 0, 0);
const atGlassPlane = facesAtPlane(mGlass.trans, 0, 1, 3, 7, 0) + facesAtPlane(mGlass.trans, 0, 1, 3, 7, 1);
ok('water/glass seam draws exactly one blended quad per block (12)',
  atGlassPlane === 4 * 12, atGlassPlane);
/* 196 water tops + the 12 glass blocks' own exposed faces (12 toward the
 * water, 12 to the outside air, 4 on top; the rest touch stone or other glass) */
ok('glass basin = 196 water + 28 glass blended quads',
  mGlass.trans.indices.length / 6 === 224, mGlass.trans.indices.length / 6);
checkMesh('glass-basin opaque', mGlass.opaque);
checkMesh('glass-basin trans', mGlass.trans);

/* ------------------- tall worlds / scratch growth ---------------------- */
/* Regression: the mesher reuses growable scratch buffers. A capacity check
 * that compared a FLOAT length against a VERTEX index silently dropped every
 * write past the first buffer, so generated chunks lost all faces above
 * y ~= 22 (the mesh truncated mid-sweep). These probes fail loudly if that
 * ever comes back. */
console.log('tall worlds / scratch growth');

function maxVertY(m) {
  const v = m.opaque.vertices;
  let hi = -Infinity, lo = Infinity;
  for (let p = 0; p * 7 < v.length; p++) {
    const y = v[p * 7 + 1];
    if (y > hi) hi = y;
    if (y < lo) lo = y;
  }
  return { hi, lo, verts: v.length / 7 };
}

/* (a) one block at the very top of the world must produce its cap face */
const wTop = new MC.World({ chunksX: 1, chunksZ: 1, seed: 11 });
wTop.setBlock(5, MC.C.WORLD_SY - 1, 5, id('grass'));
const mTop = MC.Mesher.build(wTop, 0, 0);
ok('top-of-world block meshes at y = WORLD_SY',
  maxVertY(mTop).hi === MC.C.WORLD_SY, maxVertY(mTop));

/* (b) a full-height solid column must be capped, not clipped */
const wCol = new MC.World({ chunksX: 1, chunksZ: 1, seed: 12 });
for (let y = 0; y < MC.C.WORLD_SY; y++) wCol.setBlock(3, y, 3, id('stone'), 0, { silent: true });
wCol.relightAll();
const mCol = MC.Mesher.build(wCol, 0, 0);
ok('full-height column capped at y = WORLD_SY',
  maxVertY(mCol).hi === MC.C.WORLD_SY, maxVertY(mCol));
/* facesAtPlane counts VERTICES on the plane, so each +X quad contributes 4 */
ok('full-height column has one +X face per voxel',
  facesAtPlane(mCol.opaque, 0, 4, 0, MC.C.WORLD_SY, 0) === 4 * MC.C.WORLD_SY,
  facesAtPlane(mCol.opaque, 0, 4, 0, MC.C.WORLD_SY, 0));

/* (c) a whole solid chunk blows straight through the initial scratch size
 * (1 << 14 floats) and must still be self-consistent */
const wBig = new MC.World({ chunksX: 1, chunksZ: 1, seed: 13 });
for (let y = 0; y < MC.C.WORLD_SY; y++)
  for (let z = 0; z < 16; z++)
    for (let x = 0; x < 16; x++) wBig.setBlock(x, y, z, id('stone'), 0, { silent: true });
wBig.relightAll();
const mBig = MC.Mesher.build(wBig, 0, 0);
const bigStats = maxVertY(mBig);
/* shell = top cap + 4 walls; the y = -1 floor plane is deliberately skipped */
const shellFaces = 16 * 16 + 16 * MC.C.WORLD_SY * 4;
ok('solid chunk exceeds initial scratch capacity',
  bigStats.verts * 7 > (1 << 14), bigStats.verts * 7);
ok('solid chunk vertex count is a whole number of quads', bigStats.verts % 4 === 0, bigStats.verts);
ok('solid chunk face count == shell faces (' + shellFaces + ')',
  mBig.opaque.indices.length / 6 === shellFaces, mBig.opaque.indices.length / 6);
ok('solid chunk reaches the top of the world', bigStats.hi === MC.C.WORLD_SY, bigStats);
checkMesh('solid-chunk opaque', mBig.opaque);

/* (d) a real generated world must mesh its terrain surface, not just the
 * sliver below sea level */
const wGen = new MC.World({ seed: 1337 });
MC.Generator.generate(wGen);
wGen.relightAll();
let surfOk = 0, surfTotal = 0, worst = null;
for (let cz = 0; cz < MC.C.WORLD_CZ; cz++) {
  for (let cx = 0; cx < MC.C.WORLD_CX; cx++) {
    const gm = MC.Mesher.build(wGen, cx, cz);
    const st = maxVertY(gm);
    if (st.verts === 0) continue;
    surfTotal++;
    /* the highest solid voxel anywhere in this chunk */
    let topSolid = -1;
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
      for (let y = MC.C.WORLD_SY - 1; y >= 0; y--) {
        if (wGen.getBlock(cx * 16 + x, y, cz * 16 + z)) { if (y > topSolid) topSolid = y; break; }
      }
    }
    if (st.hi >= topSolid + 1) surfOk++;
    else if (!worst) worst = { cx, cz, meshHi: st.hi, topSolid, verts: st.verts };
  }
}
ok('every generated chunk meshes up to its own surface (' + surfOk + '/' + surfTotal + ')',
  surfOk === surfTotal && surfTotal >= 40, { surfOk, surfTotal, worst });

/* ------------------------------ perf ---------------------------------- */
console.log('perf');
const wp = new MC.World({ chunksX: 1, chunksZ: 1, seed: 5 });
wp.relightAll();
for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
  const h = 20 + ((x * 7 + z * 13) % 18);
  for (let y = 0; y < h; y++) wp.setBlock(x, y, z, y > h - 3 ? id('grass') : id('stone'), 0, { silent: true });
}
wp.rebuildHeights();
MC.Mesher.build(wp, 0, 0);                        /* warm up */
const t0 = Date.now();
for (let i = 0; i < 20; i++) MC.Mesher.build(wp, 0, 0);
const perBuild = (Date.now() - t0) / 20;
ok('chunk build < 20ms', perBuild < 20, perBuild + 'ms');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
