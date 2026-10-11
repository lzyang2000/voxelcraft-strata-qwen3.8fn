/* Unit tests for the world light fields (skylight + block light flood fill).
 * Run: node tools/test-light.js */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
const ctx = { console, Math, Date, performance: { now: () => Date.now() } };
ctx.globalThis = ctx;
vm.createContext(ctx);
for (const f of ['src/core/constants.js', 'src/core/math.js', 'src/core/blocks.js', 'src/world/world.js'])
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
const MC = ctx.MC, C = MC.C, id = (n) => MC.blockIdByName(n);

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}

function flatWorld() {                       /* stone 0..9, air above */
  const w = new MC.World({ chunksX: 4, chunksZ: 4, seed: 7 });   /* 64x64x64 */
  for (let z = 0; z < w.sizeZ; z++)
    for (let x = 0; x < w.sizeX; x++)
      for (let y = 0; y <= 9; y++) w.setBlock(x, y, z, id('stone'), 0, { silent: true });
  w.rebuildHeights();
  w.relightAll();
  return w;
}

ok('probe world is 64x64', w0check().sizeX === 64 && w0check().sizeZ === 64);
function w0check() { return flatWorld(); }

console.log('baseline columns');
const w = flatWorld();
ok('air above the surface is full skylight', w.skyAt(20, 12, 20) === 15, w.skyAt(20, 12, 20));
ok('air directly above the surface is full skylight', w.skyAt(20, 10, 20) === 15, w.skyAt(20, 10, 20));
ok('opaque cells carry no skylight', w.skyAt(20, 5, 20) === 0, w.skyAt(20, 5, 20));
ok('above the world is open sky', w.skyAt(20, w.sizeY + 4, 20) === 15, w.skyAt(20, w.sizeY + 4, 20));
ok('outside the world horizontally is dark', w.skyAt(-3, 12, 20) === 0, w.skyAt(-3, 12, 20));
ok('idle applyLightDirty does nothing', w.applyLightDirty() === 0);

console.log('digging a shaft lets light down');
for (let y = 9; y >= 4; y--) w.setBlock(20, y, 20, 0);
w.applyLightDirty();
ok('shaft top is lit', w.skyAt(20, 9, 20) === 15, w.skyAt(20, 9, 20));
ok('light reaches down the shaft', w.skyAt(20, 5, 20) > 8, w.skyAt(20, 5, 20));
ok('shaft floor is lit', w.skyAt(20, 4, 20) > 5, w.skyAt(20, 4, 20));
ok('neighbouring rock stays dark', w.skyAt(22, 5, 20) === 0, w.skyAt(22, 5, 20));

console.log('filling the shaft back removes the light');
for (let y = 4; y <= 9; y++) w.setBlock(20, y, 20, id('stone'));
w.applyLightDirty();
ok('no stale light left behind', w.skyAt(20, 5, 20) === 0, w.skyAt(20, 5, 20));
ok('surface air is still lit', w.skyAt(20, 10, 20) === 15, w.skyAt(20, 10, 20));

console.log('cave light falls off with distance from the entrance');
const w2 = flatWorld();
for (let y = 9; y >= 5; y--) w2.setBlock(20, y, 20, 0);          /* shaft down to the tunnel */
for (let d = 0; d < 14; d++) w2.setBlock(20 + d, 5, 20, 0);      /* horizontal tunnel */
w2.applyLightDirty();
const tunnel = [];
for (let d = 0; d < 14; d++) tunnel.push(w2.skyAt(20 + d, 5, 20));
ok('tunnel is lit near the mouth', tunnel[0] >= 10, tunnel[0]);
ok('tunnel dims with depth', tunnel[1] > tunnel[5] && tunnel[5] > tunnel[10], tunnel);
ok('deep tunnel is nearly dark', tunnel[13] <= 3, tunnel[13]);
ok('light runs out by 15 cells', tunnel[13] > 0 && w2.skyAt(20 + 17, 5, 20) === 0, [tunnel[13], w2.skyAt(20 + 17, 5, 20)]);
ok('light never exceeds 15', tunnel.every(v => v <= 15), tunnel);

console.log('skylight passes through water and glass');
const w3 = flatWorld();
w3.setBlock(30, 10, 30, id('water'), 8);
w3.setBlock(30, 11, 30, id('water'), 8);
w3.setBlock(31, 10, 30, id('glass'));
w3.applyLightDirty();
ok('water column carries skylight', w3.skyAt(30, 11, 30) === 15, w3.skyAt(30, 11, 30));
ok('glass carries skylight', w3.skyAt(31, 10, 30) === 15, w3.skyAt(31, 10, 30));

console.log('block light (glowstone) spreads and does not need the sky');
const w4 = flatWorld();
for (let d = 0; d <= 19; d++) w4.setBlock(40 + d, 5, 40, 0);     /* sealed horizontal tunnel */
w4.applyLightDirty();
ok('sealed tunnel is dark (no sky path)', w4.skyAt(40, 5, 40) === 0 && w4.blockLightAt(40, 5, 40) === 0,
  { sky: w4.skyAt(40, 5, 40), blk: w4.blockLightAt(40, 5, 40) });
w4.setBlock(40, 4, 40, id('glowstone'));                          /* light in the tunnel floor */
w4.applyLightDirty();
ok('glowstone holds its own light', w4.blockLightAt(40, 4, 40) === 15, w4.blockLightAt(40, 4, 40));
ok('air next to it is bright', w4.blockLightAt(40, 5, 40) === 14, w4.blockLightAt(40, 5, 40));
ok('block light attenuates one per cell', w4.blockLightAt(41, 5, 40) === 13, w4.blockLightAt(41, 5, 40));
let litRun = 0;
for (let d = 0; d < 20; d++) if (w4.blockLightAt(40 + d, 5, 40) > 0) litRun++;
ok('block light reaches ~14 cells', litRun >= 13 && litRun <= 15, litRun);
ok('block light does not leak through solid rock', w4.blockLightAt(40, 2, 40) === 0, w4.blockLightAt(40, 2, 40));
w4.setBlock(40, 4, 40, 0);
w4.applyLightDirty();
ok('removing the source clears its light', w4.blockLightAt(40, 5, 40) === 0, w4.blockLightAt(40, 5, 40));

console.log('relighting is incremental and bounded');
const w5 = flatWorld();
let t0 = Date.now(), worst = 0;
for (let i = 0; i < 40; i++) {
  const x = 8 + (i % 20);
  w5.setBlock(x, 10, 8, id('stone'));
  w5.setBlock(x, 11, 8, 0);
  const t = Date.now();
  w5.applyLightDirty();
  worst = Math.max(worst, Date.now() - t);
}
ok('40 single-block relights finish quickly', Date.now() - t0 < 1200, Date.now() - t0);
ok('one relight stays under 25 ms', worst < 25, worst);
ok('light dirty set is drained', w5.lightDirty === null);
ok('relit chunks are queued for re-mesh', w5.dirty.size > 0, w5.dirty.size);

console.log('relightAll matches an incremental session');
const a = flatWorld(), b = flatWorld();
for (const world of [a, b]) for (let y = 9; y >= 3; y--) world.setBlock(60, y, 60, 0);
for (const world of [a, b]) for (let d = 0; d < 12; d++) world.setBlock(60 + d, 3, 60, 0);
a.applyLightDirty();
b.relightAll();
let diff = 0;
for (let y = 0; y < a.sizeY; y++) for (let z = 50; z < 64; z++) for (let x = 50; x < 64; x++)
  if (a.skyAt(x, y, z) !== b.skyAt(x, y, z)) diff++;
ok('incremental relight agrees with a full relight', diff === 0, diff);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
