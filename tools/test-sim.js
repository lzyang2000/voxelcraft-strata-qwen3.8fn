/* Node smoke test for the gravity + water simulation.
 * Run: node tools/test-sim.js */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
const ctx = { console, Math, Date, performance: { now: () => Date.now() } };
ctx.globalThis = ctx;
vm.createContext(ctx);
const files = ['src/core/constants.js', 'src/core/math.js', 'src/core/blocks.js',
  'src/world/world.js', 'src/world/simulation.js'];
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

const SAND = MC.blockIdByName('sand');
const STONE = MC.blockIdByName('stone');
const WATER = MC.WATER_ID;
const MAXQ = C.SIM_MAX_UPDATES * 4;

/* flat world: stone floor y=0..10, air above */
function mkWorld() {
  const w = new MC.World({ chunksX: 2, chunksZ: 2, seed: 5 });
  for (let z = 0; z < w.sizeZ; z++)
    for (let x = 0; x < w.sizeX; x++)
      for (let y = 0; y <= 10; y++) w.setBlock(x, y, z, STONE, 0, { silent: true });
  w.rebuildHeights();
  return w;
}
function run(sim, n, pp) { for (let i = 0; i < n; i++) sim.tick(1 / C.SIM_TICK_HZ, pp); }
function waterSet(w) {
  const s = new Set();
  for (let z = 0; z < w.sizeZ; z++)
    for (let x = 0; x < w.sizeX; x++)
      for (let y = 0; y < w.sizeY; y++)
        if (w.getBlock(x, y, z) === WATER) s.add(x + ',' + y + ',' + z);
  return s;
}
function waterCount(w) { return waterSet(w).size; }
function lvl(w, x, y, z) { const m = w.getMeta(x, y, z); return m <= 0 ? 8 : m; }
function nothingOutOfBounds(w) {
  // world only stores in-bounds cells; verify OOB reads are air and no chunk
  // array holds data past its declared volume.
  if (w.getBlock(-1, 5, -1) !== 0) return false;
  if (w.getBlock(w.sizeX, 5, 5) !== 0) return false;
  if (w.getBlock(5, w.sizeY, 5) !== 0) return false;
  let okAll = true;
  w.chunks.forEach(ch => { if (ch.blocks.length !== C.CHUNK_VOL) okAll = false; });
  return okAll;
}

/* ------------------------------- SAND FALL ------------------------------- */
console.log('SAND FALL');
{
  const w = mkWorld(); const sim = new MC.Simulation(w);
  w.setBlock(8, 40, 8, SAND); sim.schedule(8, 40, 8);
  const pp = [8.5, 40, 8.5];
  run(sim, 5, pp);
  ok('falls one cell per tick (y=35 after 5)', w.getBlock(8, 35, 8) === SAND && w.getBlock(8, 40, 8) === 0,
    [w.getBlock(8, 35, 8), w.getBlock(8, 40, 8)]);
  run(sim, 29, pp); /* 5 + 29 = 34 <= (40-11)+5 */
  ok('rests exactly on floor (y=11) within 34 ticks', w.getBlock(8, 11, 8) === SAND && w.getBlock(8, 12, 8) === 0,
    [w.getBlock(8, 11, 8), w.getBlock(8, 12, 8)]);
  run(sim, 12, pp);
  ok('does not move after resting', w.getBlock(8, 11, 8) === SAND);
  ok('pending returns to 0', sim.pending() === 0, sim.pending());
  ok('nothing out of bounds', nothingOutOfBounds(w));
}

/* ---------------------------- SAND INTO WATER ---------------------------- */
console.log('SAND INTO WATER');
{
  const w = mkWorld(); const sim = new MC.Simulation(w);
  for (let y = 11; y <= 19; y++) w.setBlock(8, y, 8, WATER, 8);
  /* walls so the water column cannot spread sideways */
  for (let y = 11; y <= 20; y++) {
    w.setBlock(7, y, 8, STONE); w.setBlock(9, y, 8, STONE);
    w.setBlock(8, y, 7, STONE); w.setBlock(8, y, 9, STONE);
  }
  w.setBlock(8, 20, 8, SAND); sim.schedule(8, 20, 8);
  const pp = [8.5, 20, 8.5];
  run(sim, 60, pp);
  ok('sand ends on the floor (y=11)', w.getBlock(8, 11, 8) === SAND, w.getBlock(8, 11, 8));
  ok('water sits above the sand (y=12)', w.getBlock(8, 12, 8) === WATER, w.getBlock(8, 12, 8));
  ok('sand is not above the water', w.getBlock(8, 20, 8) !== SAND, w.getBlock(8, 20, 8));
  ok('nothing out of bounds', nothingOutOfBounds(w));
}

/* --------------------------- SAND PILE COLLAPSE -------------------------- */
console.log('SAND PILE COLLAPSE');
{
  const w = mkWorld(); const sim = new MC.Simulation(w);
  w.setBlock(5, 11, 5, SAND); /* existing 1-high block at a footprint corner */
  for (let x = 5; x <= 7; x++) for (let z = 5; z <= 7; z++) w.setBlock(x, 14, z, SAND);
  sim.scheduleBox(5, 14, 5, 7, 14, 7); sim.schedule(5, 11, 5);
  const pp = [6, 14, 6];
  run(sim, 80, pp);
  let outside = 0;
  for (let x = 0; x < w.sizeX; x++)
    for (let z = 0; z < w.sizeZ; z++) {
      if (w.getBlock(x, 11, z) === SAND && (x < 5 || x > 7 || z < 5 || z > 7)) outside++;
    }
  ok('at least one block slid diagonally down to the side', outside >= 1, outside);
  /* everything collapsed onto the floor (no sand floating above y=12) */
  let floating = 0;
  for (let x = 0; x < w.sizeX; x++)
    for (let z = 0; z < w.sizeZ; z++)
      for (let y = 13; y < w.sizeY; y++) if (w.getBlock(x, y, z) === SAND) floating++;
  ok('no sand left floating above the pile', floating === 0, floating);
  ok('nothing out of bounds', nothingOutOfBounds(w));
}

/* ---------------------------- SUPPORT REMOVAL ---------------------------- */
console.log('SUPPORT REMOVAL');
{
  const w = mkWorld(); const sim = new MC.Simulation(w);
  /* walls so the stack cannot slide sideways */
  w.setBlock(4, 11, 5, STONE); w.setBlock(6, 11, 5, STONE);
  w.setBlock(5, 11, 4, STONE); w.setBlock(5, 11, 6, STONE);
  w.setBlock(5, 11, 5, SAND); w.setBlock(5, 12, 5, SAND);
  sim.scheduleBox(5, 11, 5, 5, 12, 5);
  const pp = [5, 12, 5];
  run(sim, 5, pp);
  ok('upper sand stays put while supported', w.getBlock(5, 12, 5) === SAND && w.getBlock(5, 11, 5) === SAND,
    [w.getBlock(5, 12, 5), w.getBlock(5, 11, 5)]);
  w.setBlock(5, 11, 5, 0, 0); sim.schedule(5, 11, 5);
  run(sim, 2, pp);
  ok('upper sand starts falling within 2 ticks', w.getBlock(5, 11, 5) === SAND, w.getBlock(5, 11, 5));
  ok('nothing out of bounds', nothingOutOfBounds(w));
}

/* ------------------------------ WATER SPREAD ----------------------------- */
console.log('WATER SPREAD');
{
  const w = mkWorld(); const sim = new MC.Simulation(w);
  w.setBlock(8, 11, 8, WATER, 8); sim.schedule(8, 11, 8);
  const pp = [8, 11, 8];
  let t = 0; while (sim.pending() > 0 && t < 300) { sim.tick(1 / C.SIM_TICK_HZ, pp); t++; }
  ok('puddle settles (pending 0)', sim.pending() === 0, [sim.pending(), t]);
  const set = waterSet(w);
  let radius = 0, allGe2 = true;
  set.forEach(k => {
    const p = k.split(',').map(Number);
    const r = Math.abs(p[0] - 8) + Math.abs(p[2] - 8);
    if (r > radius) radius = r;
    if (lvl(w, p[0], p[1], p[2]) < 2) allGe2 = false;
  });
  ok('bounded puddle radius in [1,6]', radius >= 1 && radius <= 6, radius);
  ok('all puddle levels >= 2', allGe2);
  const before = waterSet(w);
  run(sim, 60, pp);
  const after = waterSet(w);
  ok('unchanged after 60 more ticks', before.size === after.size && [...before].every(k => after.has(k)),
    [before.size, after.size]);
  ok('pending still 0', sim.pending() === 0, sim.pending());
  ok('nothing out of bounds', nothingOutOfBounds(w));
}

/* ------------------------------- WATER FALL ------------------------------ */
console.log('WATER FALL');
{
  const w = mkWorld(); const sim = new MC.Simulation(w);
  w.setBlock(8, 16, 8, WATER, 8); sim.schedule(8, 16, 8);
  const pp = [8, 16, 8];
  run(sim, 120, pp);
  let col = true;
  for (let y = 11; y <= 16; y++) if (w.getBlock(8, y, 8) !== WATER) col = false;
  ok('straight column from source to floor', col);
  const puddle = w.getBlock(7, 11, 8) === WATER || w.getBlock(9, 11, 8) === WATER ||
    w.getBlock(8, 11, 7) === WATER || w.getBlock(8, 11, 9) === WATER;
  ok('puddle at the bottom', puddle);
  ok('nothing out of bounds', nothingOutOfBounds(w));
}

/* ----------------------------- WATER LEVELLING --------------------------- */
console.log('WATER LEVELLING');
{
  const w = mkWorld(); const sim = new MC.Simulation(w);
  w.setBlock(8, 11, 8, WATER, 8); sim.schedule(8, 11, 8);
  const pp = [8, 11, 8];
  let t = 0; while (sim.pending() > 0 && t < 300) { sim.tick(1 / C.SIM_TICK_HZ, pp); t++; }
  const set = waterSet(w);
  let allGe2 = set.size > 1;
  set.forEach(k => { const p = k.split(',').map(Number); if (lvl(w, p[0], p[1], p[2]) < 2) allGe2 = false; });
  ok('levelled puddle, all levels >= 2', allGe2, set.size);
  ok('nothing out of bounds', nothingOutOfBounds(w));
}

/* ------------------------------ RADIUS CULL ------------------------------ */
console.log('RADIUS CULL');
{
  const w = mkWorld(); const sim = new MC.Simulation(w);
  w.setBlock(2, 40, 2, SAND); sim.schedule(2, 40, 2);
  const pp = [30, 40, 30]; /* horizontal dist ~39.6 > SIM_RADIUS(30) */
  run(sim, 20, pp);
  ok('far-away sand never moves', w.getBlock(2, 40, 2) === SAND, w.getBlock(2, 40, 2));
  ok('nothing out of bounds', nothingOutOfBounds(w));
}

/* -------------------------------- BOUNDS --------------------------------- */
console.log('BOUNDS');
{
  const w = mkWorld(); const sim = new MC.Simulation(w);
  sim.schedule(-5, 5, -5); sim.schedule(w.sizeX + 5, 5, 5); sim.schedule(5, w.sizeY + 5, 5);
  let threw = false;
  try { run(sim, 5, [16, 5, 16]); } catch (e) { threw = true; }
  ok('out-of-bounds scheduling does not throw', !threw);
  ok('nothing written out of bounds', nothingOutOfBounds(w));
}

/* ------------------------------- STABILITY ------------------------------- */
console.log('STABILITY');
{
  const w = mkWorld(); const sim = new MC.Simulation(w);
  w.setBlock(8, 11, 8, WATER, 8); sim.schedule(8, 11, 8);
  const pp = [8, 11, 8];
  let prev = waterCount(w), nonDecreasing = true, maxPending = 0, threw = false;
  let count100 = 0;
  try {
    for (let i = 0; i < 400; i++) {
      sim.tick(1 / C.SIM_TICK_HZ, pp);
      if (i === 99) count100 = waterCount(w);
      const wc = waterCount(w);
      if (wc < prev) nonDecreasing = false;
      prev = wc;
      if (sim.pending() > maxPending) maxPending = sim.pending();
    }
  } catch (e) { threw = true; console.log('    exception: ' + e.message); }
  ok('400 ticks, no exception', !threw);
  ok('water count non-decreasing', nonDecreasing);
  ok('water count stable after 100 ticks', waterCount(w) === count100, [count100, waterCount(w)]);
  ok('water bounded (<= 200)', waterCount(w) <= 200, waterCount(w));
  ok('pending never exceeded cap', maxPending <= MAXQ, maxPending);
  ok('nothing out of bounds', nothingOutOfBounds(w));
}

console.log('lastChanged bookkeeping stays bounded');
{
  const w = mkWorld(); const sim = new MC.Simulation(w);
  /* a long column of sand so many cells mutate over many ticks */
  for (let y = 11; y <= 40; y++) { w.setBlock(8, y, 8, SAND, 0, { silent: true }); sim.schedule(8, y, 8); }
  const pp = [8, 20, 8];
  let peak = 0;
  for (let i = 0; i < 600; i++) {
    sim.tick(1 / C.SIM_TICK_HZ, pp);
    if (sim.lastChanged.size > peak) peak = sim.lastChanged.size;
  }
  ok('sand settled', sim.pending() === 0, sim.pending());
  ok('lastChanged never grew unbounded', peak <= 4000, peak);
  ok('an idle queue clears lastChanged', sim.lastChanged.size === 0, sim.lastChanged.size);

  /* stale stamps must not linger while work is still queued */
  const w2 = mkWorld(); const sim2 = new MC.Simulation(w2);
  w2.setBlock(10, 30, 10, SAND, 0, { silent: true }); sim2.schedule(10, 30, 10);
  sim2.tick(1 / C.SIM_TICK_HZ, [10, 30, 10]);
  ok('a falling block is stamped', sim2.lastChanged.size > 0, sim2.lastChanged.size);
  ok('the queue is still live', sim2.pending() > 0, sim2.pending());
  const real = Array.from(sim2.lastChanged.keys());
  sim2.lastChanged.set('1,2,3', sim2.tickCount - 500);  /* an ancient stamp */
  sim2._pruneChanged(sim2.tickCount - 64);
  ok('stale stamps are pruned', !sim2.lastChanged.has('1,2,3'), sim2.lastChanged.size);
  ok('recent stamps survive the prune',
    real.length > 0 && real.every((k) => sim2.lastChanged.has(k)), [real, Array.from(sim2.lastChanged.keys())]);
  for (let i = 0; i < 400; i++) sim2.tick(1 / C.SIM_TICK_HZ, [10, 20, 10]);
  ok('lastChanged ends empty once everything settles', sim2.lastChanged.size === 0, sim2.lastChanged.size);

  /* pruning must not change behaviour: the same run still settles */
  const w3 = mkWorld(); const sim3 = new MC.Simulation(w3);
  w3.setBlock(10, 20, 10, SAND, 0, { silent: true }); sim3.schedule(10, 20, 10);
  run(sim3, 40, [10, 20, 10]);
  ok('sand still falls to the floor', w3.getBlock(10, 11, 10) === SAND, w3.getBlock(10, 11, 10));
  ok('and leaves its original cell', w3.getBlock(10, 20, 10) === 0, w3.getBlock(10, 20, 10));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
