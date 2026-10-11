/* Node smoke test for the core contracts (no browser needed).
 * Run: node tools/test-world.js */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
const ctx = { console, Math, Date, performance: { now: () => Date.now() } };
ctx.globalThis = ctx;
vm.createContext(ctx);
const files = ['src/core/constants.js', 'src/core/math.js', 'src/core/blocks.js', 'src/world/world.js'];
for (const f of files) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const MC = ctx.MC;
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}

console.log('core load');
ok('MC.C present', !!MC.C);
ok('blocks registered', MC.BLOCKS.length >= 25, MC.BLOCKS.length);
ok('tiles cover blocks', MC.BLOCKS.every(b =>
  [b.tiles.top, b.tiles.side, b.tiles.bottom].every(n => n === 'air' || MC.TILE_INDEX[n] !== undefined)),
  MC.BLOCKS.filter(b => ![b.tiles.top, b.tiles.side, b.tiles.bottom].every(n => MC.TILE_INDEX[n] !== undefined)).map(b => b.name));
ok('atlas fits', MC.TILES.length <= MC.C.ATLAS_COLS * MC.C.ATLAS_ROWS, MC.TILES.length);

console.log('world basics');
const w = new MC.World({ chunksX: 2, chunksZ: 2, seed: 7 });
ok('size', w.sizeX === 32 && w.sizeZ === 32 && w.sizeY === 64, [w.sizeX, w.sizeY, w.sizeZ]);
ok('air default', w.getBlock(5, 40, 5) === 0);
w.setBlock(5, 10, 5, MC.blockIdByName('stone'));
ok('set/get', w.getBlock(5, 10, 5) === MC.blockIdByName('stone'));
ok('dirty marked', w.takeDirty().length >= 1);
ok('height', w.heightAt(5, 5) === 11, w.heightAt(5, 5));
ok('solid query', w.isSolidAt(5, 10, 5) === true && w.isSolidAt(5, 11, 5) === false);
ok('floor solid below 0', w.isSolidAt(0, -1, 0) === true);
w.setBlock(5, 10, 5, 0);
ok('clear', w.getBlock(5, 10, 5) === 0 && w.heightAt(5, 5) === 0);

console.log('raycast');
w.setBlock(8, 20, 8, MC.blockIdByName('stone'));
let r = w.raycast([8.5, 22.5, 8.5], [0, -1, 0], 10);
ok('straight down hit', r.hit && r.block[0] === 8 && r.block[1] === 20, r);
ok('face is -Y entry (top face 2)', r.face === 2, r.face);
ok('adjacent above', r.adjacent[1] === 21, r.adjacent);
r = w.raycast([8.5, 20.5, 4.5], [0, 0, 1], 10);
ok('along +Z hit enters -Z face', r.hit && r.block[2] === 8 && r.face === 5 && r.normal[2] === -1, r);
r = w.raycast([8.5, 20.5, 4.5], [0, 0, -1], 10);
ok('miss away', !r.hit);
r = w.raycast([8.5, 22.5, 8.5], [0, -1, 0], 1.0);
ok('maxDist respected', !r.hit, r.dist);
r = w.raycast([8.5, 22.5, 8.5], [0.3, -1, 0.1], 20);
ok('diagonal hit', r.hit, r);
w.setBlock(9, 20, 8, MC.blockIdByName('water'));
const rr = w.raycast([8.5, 22.5, 8.5], [1, -1, 0], 20);
ok('liquid ignored by default', rr.blockId !== MC.WATER_ID, rr.blockId);

console.log('serialize round-trip');
w.setBlock(1, 2, 3, MC.blockIdByName('log'), 5);
const snap = w.serialize();
const w2 = new MC.World({ chunksX: 1, chunksZ: 1 });
ok('deserialize', w2.deserialize(JSON.parse(JSON.stringify(snap))));
ok('roundtrip block', w2.getBlock(1, 2, 3) === MC.blockIdByName('log'));
ok('roundtrip meta', w2.getMeta(1, 2, 3) === 5, w2.getMeta(1, 2, 3));
ok('roundtrip stone', w2.getBlock(8, 20, 8) === MC.blockIdByName('stone'));

console.log('deserialize rejects malformed payloads');
{
  const w3 = new MC.World({ chunksX: 1, chunksZ: 1, seed: 4 });
  const LOG = MC.blockIdByName('log');
  w3.setBlock(1, 2, 3, LOG, 5);
  const good = JSON.parse(JSON.stringify(w3.serialize()));
  const before = w3.getBlock(1, 2, 3);

  ok('null payload', w3.deserialize(null) === false);
  ok('non-object payload', w3.deserialize('nope') === false);
  ok('chunks must be an array', w3.deserialize({ chunks: 'oops' }) === false);
  ok('chunk without runs', w3.deserialize({ chunks: [{ cx: 0, cz: 0, metas: [] }] }) === false);
  ok('chunk without metas', w3.deserialize({ chunks: [{ cx: 0, cz: 0, runs: [0, 4096] }] }) === false);
  ok('runs with non-numbers', w3.deserialize({ chunks: [{ cx: 0, cz: 0, runs: ['x', 4], metas: [] }] }) === false);
  ok('odd-length runs', w3.deserialize({ chunks: [{ cx: 0, cz: 0, runs: [1, 2, 3], metas: [] }] }) === false);
  ok('chunk outside the grid', w3.deserialize({ chunks: [{ cx: 99, cz: 0, runs: [], metas: [] }] }) === false);
  ok('foreign version', w3.deserialize({ version: '0.0.1', chunks: [] }) === false);
  ok('a rejected load changes nothing', w3.getBlock(1, 2, 3) === before, w3.getBlock(1, 2, 3));
  ok('a rejected load keeps the heights', w3.heightAt(1, 3) === 3, w3.heightAt(1, 3));
  ok('a good payload still loads', w3.deserialize(good) === true);

  /* stale simulation keys must not survive a load */
  w3.markSim(4, 5, 6);
  ok('sim mark queued before the load', w3.simDirty.size === 1, w3.simDirty.size);
  ok('reload', w3.deserialize(good) === true);
  ok('simDirty cleared by deserialize', w3.simDirty.size === 0, w3.simDirty.size);
  ok('still readable after the reload', w3.getBlock(1, 2, 3) === LOG);
}

console.log('math');
const m = MC.M4.perspective(new Float32Array(16), Math.PI / 3, 1.5, 0.1, 100);
ok('perspective[11]=-1', m[11] === -1);
const v = MC.M4.view(new Float32Array(16), 1, 2, 3, 0, 0);
const f = MC.M4.forwardFromView(v);
ok('forward is -Z at yaw0', Math.abs(f[2] + 1) < 1e-6 && Math.abs(f[0]) < 1e-6, f);
const v2 = MC.M4.view(new Float32Array(16), 0, 0, 0, Math.PI / 2, 0);
const f2 = MC.M4.forwardFromView(v2);
ok('yaw 90deg -> +X? (expect x sign)', Math.abs(f2[0]) > 0.99, f2);
const inv = MC.M4.invert(new Float32Array(16), m);
const prod = new Float32Array(16);
MC.M4.multiply(prod, m, inv);
let ident = true;
for (let i = 0; i < 16; i++) { const e = (i % 5 === 0) ? 1 : 0; if (Math.abs(prod[i] - e) > 1e-4) ident = false; }
ok('M * M^-1 ~ I', ident);
ok('AABB overlap', MC.AABB.overlaps({ min: [0, 0, 0], max: [1, 1, 1] }, { min: [0.5, 0.5, 0.5], max: [2, 2, 2] }));
ok('AABB no overlap', !MC.AABB.overlaps({ min: [0, 0, 0], max: [1, 1, 1] }, { min: [1, 1, 1], max: [2, 2, 2] }));

console.log('noise determinism');
const n1 = new MC.Noise(42), n2 = new MC.Noise(42), n3 = new MC.Noise(43);
ok('noise deterministic', n1.fbm2(3.5, -2.25, 4) === n2.fbm2(3.5, -2.25, 4));
ok('noise seed differs', n1.fbm2(3.5, -2.25, 4) !== n3.fbm2(3.5, -2.25, 4));
let inRange = true;
for (let i = 0; i < 500; i++) { const v = n1.fbm2(i * 0.37, i * -0.11, 5); if (!(v >= 0 && v <= 1)) inRange = false; }
ok('fbm2 in [0,1]', inRange);

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
