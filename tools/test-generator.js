/* Node smoke test for the world generator.
 * Run: node tools/test-generator.js */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
const ctx = { console, Math, Date, performance: { now: () => Date.now() } };
ctx.globalThis = ctx;
vm.createContext(ctx);
const files = ['src/core/constants.js', 'src/core/math.js', 'src/core/blocks.js',
  'src/world/world.js', 'src/world/generator.js'];
for (const f of files) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const MC = ctx.MC;
const C = MC.C;
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}

const idBedrock = MC.blockIdByName('bedrock');
const WATER = MC.WATER_ID;

/* checksum over every voxel (id + meta) */
function checksum(w) {
  let h = 2166136261 >>> 0;
  for (let z = 0; z < w.sizeZ; z++)
    for (let x = 0; x < w.sizeX; x++)
      for (let y = 0; y < w.sizeY; y++) {
        h ^= w.getBlock(x, y, z); h = Math.imul(h, 16777619);
        h ^= w.getMeta(x, y, z); h = Math.imul(h, 16777619);
      }
  return h >>> 0;
}

/* ground materials (exclude trees/water/air) for cave-fraction + height checks */
const GROUND = new Set(['bedrock', 'stone', 'dirt', 'grass', 'sand', 'sandstone',
  'gravel', 'clay', 'snow', 'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore'].map(MC.blockIdByName));
const FORBIDDEN = new Set(['planks', 'glass', 'brick', 'iron_block', 'gold_block',
  'obsidian', 'stone_bricks', 'glowstone'].map(MC.blockIdByName));

/* ---------- timing on an 8x8 world (128x64x128) ---------- */
console.log('timing (8x8 = ' + C.WORLD_SX + 'x' + C.WORLD_SY + 'x' + C.WORLD_SZ + ')');
const big = new MC.World({ chunksX: 8, chunksZ: 8, seed: 20260 });
const t0 = Date.now();
MC.Generator.generate(big);
const elapsed = Date.now() - t0;
console.log('  generate elapsed: ' + elapsed + ' ms');
ok('8x8 generation < 1500 ms', elapsed < 1500, elapsed);

/* ---------- assertions on a smaller 4x4 world ---------- */
console.log('small world (4x4)');
const w = new MC.World({ chunksX: 4, chunksZ: 4, seed: 19 });
MC.Generator.generate(w);

/* y=0 is 100% bedrock */
let bedrockOK = true;
for (let z = 0; z < w.sizeZ; z++)
  for (let x = 0; x < w.sizeX; x++)
    if (w.getBlock(x, 0, z) !== idBedrock) bedrockOK = false;
ok('y=0 all bedrock', bedrockOK);

/* presence of water, grass, log */
let hasWater = false, hasGrass = false, hasLog = false;
const seen = new Set();
for (let z = 0; z < w.sizeZ; z++)
  for (let x = 0; x < w.sizeX; x++)
    for (let y = 0; y < w.sizeY; y++) {
      const id = w.getBlock(x, y, z);
      if (id === 0) continue;
      seen.add(id);
      if (id === WATER) hasWater = true;
      else if (id === MC.blockIdByName('grass')) hasGrass = true;
      else if (id === MC.blockIdByName('log')) hasLog = true;
    }
ok('has water', hasWater);
ok('has grass', hasGrass);
ok('has log (trees exist)', hasLog);

/* no water above SEA_LEVEL */
let waterAbove = 0;
for (let z = 0; z < w.sizeZ; z++)
  for (let x = 0; x < w.sizeX; x++)
    for (let y = C.SEA_LEVEL + 1; y < w.sizeY; y++)
      if (w.getBlock(x, y, z) === WATER) waterAbove++;
ok('no water above SEA_LEVEL', waterAbove === 0, waterAbove);

/* no forbidden (crafted) blocks anywhere */
let forbidden = [];
seen.forEach(id => { if (FORBIDDEN.has(id)) forbidden.push(MC.block(id).name); });
ok('no crafted blocks in fresh world', forbidden.length === 0, forbidden);

/* cave carve fraction: carved (air|water) strictly under the ground surface */
let carved = 0, solidVol = 0;
for (let z = 0; z < w.sizeZ; z++) {
  for (let x = 0; x < w.sizeX; x++) {
    let groundTop = 0;
    for (let y = w.sizeY - 1; y >= 0; y--) {
      if (GROUND.has(w.getBlock(x, y, z))) { groundTop = y + 1; break; }
    }
    for (let y = 2; y < groundTop; y++) {
      const id = w.getBlock(x, y, z);
      if (id === 0 || id === WATER) carved++;
    }
    for (let y = 0; y < w.sizeY; y++) {
      const id = w.getBlock(x, y, z);
      if (id !== 0 && id !== WATER) solidVol++;
    }
  }
}
const frac = carved / solidVol;
console.log('  carve fraction: ' + (frac * 100).toFixed(2) + '% (carved=' + carved + ' solid=' + solidVol + ')');
ok('cave carve fraction > 0.5%', frac > 0.005, frac);
ok('cave carve fraction < 15%', frac < 0.15, frac);

/* heightAt consistent with blocks (200 random columns) */
let heightOK = true, checked = 0;
let rng = new MC.RNG(999);
for (let n = 0; n < 200; n++) {
  const x = rng.int(0, w.sizeX - 1), z = rng.int(0, w.sizeZ - 1);
  let top = 0;
  for (let y = w.sizeY - 1; y >= 0; y--) { if (w.getBlock(x, y, z) !== 0) { top = y + 1; break; } }
  if (w.heightAt(x, z) !== top) { heightOK = false; console.log('    height mismatch at ' + x + ',' + z + ': ' + w.heightAt(x, z) + ' vs ' + top); }
  checked++;
}
ok('heightAt consistent (' + checked + ' columns)', heightOK);

/* all chunks marked dirty */
let dirtyOK = true;
for (let cz = 0; cz < w.chunksZ; cz++)
  for (let cx = 0; cx < w.chunksX; cx++)
    if (!w.dirty.has(cx + ',' + cz)) dirtyOK = false;
ok('all chunks dirty', dirtyOK, w.dirty.size);

/* determinism: same seed identical, different seed differs */
const a1 = new MC.World({ chunksX: 4, chunksZ: 4, seed: 4242 });
const a2 = new MC.World({ chunksX: 4, chunksZ: 4, seed: 4242 });
const b1 = new MC.World({ chunksX: 4, chunksZ: 4, seed: 4243 });
MC.Generator.generate(a1); MC.Generator.generate(a2); MC.Generator.generate(b1);
const c1 = checksum(a1), c2 = checksum(a2), c3 = checksum(b1);
ok('same seed -> identical', c1 === c2, [c1, c2]);
ok('different seed -> differs', c1 !== c3, [c1, c3]);

/* stats() sanity */
const st = MC.Generator.stats(w);
ok('stats counts add up', st.solid + st.air + st.liquid === w.sizeX * w.sizeY * w.sizeZ,
  [st.solid, st.air, st.liquid]);
ok('stats.byName has stone', st.byName['stone'] > 0, st.byName['stone']);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
