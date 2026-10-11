/* End-to-end integration test: boots the real index.html script graph in a
 * fake DOM + fake WebGL2 and plays the game for hundreds of frames.
 * Catches cross-module API drift that per-module tests cannot see. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { createEnv } = require('./fake-dom');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const scripts = Array.from(html.matchAll(/<script src="([^"]+)"><\/script>/g)).map(m => m[1]);
console.log('script graph from index.html');
ok('16 scripts in order', scripts.length === 16, scripts.length);
ok('game.js is last', scripts[scripts.length - 1] === 'src/game/game.js');

const env = createEnv(html);
const ctx = vm.createContext(env.win);
let loadError = null;
try {
  for (const s of scripts) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, s), 'utf8'), ctx, { filename: s });
  }
} catch (e) { loadError = e; }
ok('all scripts load without throwing', !loadError, loadError && (loadError.message + ' @ ' + loadError.stack.split('\n')[1]));
if (loadError) { console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(1); }

const MC = env.win.MC;
ok('MC namespace populated', !!MC && !!MC.Game);
ok('game auto-booted', !!MC.game);
ok('no missing DOM ids requested', env.missingIds.length === 0, env.missingIds);

/* ------------------------------- boot phase ---------------------------- */
let bootError = null;
try { env.pump(400, 16); } catch (e) { bootError = e; }
ok('boot + warm-up runs without throwing', !bootError, bootError && (bootError.message + ' | ' + (bootError.stack || '').split('\n').slice(1, 4).join(' | ')));
ok('game is running', MC.game.running === true, { running: MC.game.running, paused: MC.game.paused });
ok('loading overlay hidden', env.ids.loading.classList.contains('hidden'));
ok('hud visible', !env.ids.hud.classList.contains('hidden'));
ok('all 64 chunks meshed', MC.game.meshedChunks.size === 64, MC.game.meshedChunks.size);
ok('renderer issued draw calls', (MC.game.renderer.stats && MC.game.renderer.stats.drawCalls > 0), MC.game.renderer.stats);
ok('GL uploaded chunk buffers', env.log.bufferData > 60, env.log.bufferData);
ok('GL uploaded the atlas', env.log.texImage2D >= 1, env.log.texImage2D);
ok('shaders compiled (>=4 programs)', env.log.shaders.length >= 4, env.log.shaders.length);
const badShader = env.log.shaders.findIndex(s => (s.split('{').length - 1) !== (s.split('}').length - 1));
ok('shader sources brace-balanced', badShader === -1, badShader);
ok('player landed on the ground', MC.game.player.onGround === true, { y: MC.game.player.position[1], onGround: MC.game.player.onGround });
ok('player is inside the world', MC.game.player.position[1] > 0 && MC.game.player.position[1] < MC.game.world.sizeY, MC.game.player.position);
ok('spawn is above sea level', MC.game.player.position[1] >= MC.C.SEA_LEVEL - 2, MC.game.player.position[1]);

const game = MC.game, world = MC.game.world, player = MC.game.player, inv = MC.game.inventory;

/* ------------------------------ mining flow ---------------------------- */
const footX = Math.floor(player.position[0]), footZ = Math.floor(player.position[2]);
const footY = Math.floor(player.position[1]) - 1;
const groundId = world.getBlock(footX, footY, footZ);
ok('there is ground under the player', groundId !== 0, { footX, footY, footZ, groundId });

player.pitch = -1.45;                       /* look straight down */
env.canvas.dispatch('mousedown', { button: 0 });
let mineError = null;
try { env.pump(150, 16); } catch (e) { mineError = e; }
ok('mining loop does not throw', !mineError, mineError && (mineError.message + ' | ' + (mineError.stack || '').split('\n')[1]));
const afterId = world.getBlock(footX, footY, footZ);
ok('held left button breaks the targeted block', afterId === 0, { before: groundId, after: afterId });
ok('breaking spawns particles', game.particles.count() > 0, game.particles.count());
env.doc.dispatch('mouseup', { button: 0 });

/* The drop spawns at the player's feet, so it may already be magnetised in. */
const expectedDrop = MC.block(groundId).drop;
const asDrop = game.drops.length > 0;
const inBag = inv.countOf(expectedDrop) > 0;
ok('mining yields an item (dropped entity or already picked up)', asDrop || inBag,
  { drops: game.drops.length, count: inv.countOf(expectedDrop), expectedDrop });
const yielded = game.drops.some(function (d) { return d.name === expectedDrop; }) || inBag;
ok('the yielded item is the block that was mined', yielded,
  { drops: game.drops.map(function (d) { return d.name; }), expected: expectedDrop, inBag: inBag });

let pickError = null;
try { env.pump(90, 16); } catch (e) { pickError = e; }
ok('pickup loop does not throw', !pickError, pickError && pickError.message);
ok('player ends up carrying the mined block', inv.countOf(expectedDrop) > 0,
  { expectedDrop, count: inv.countOf(expectedDrop), drops: game.drops.length });

/* ------------------------------ placing flow --------------------------- */
game.mode = 'creative'; inv.creative = true;
inv.setSlot('hotbar', 0, { name: 'stone', count: 64 });
inv.select(0);

/* Use a deterministic dry column so every placement test is unambiguous. */
function surfaceY(x, z) { return world.heightAt(x, z); }
const tx = Math.floor(player.position[0]) + 4, tz = Math.floor(player.position[2]) + 4;
const th = surfaceY(tx, tz);
ok('test column is dry land', th > MC.C.SEA_LEVEL + 1 && world.getBlock(tx, th - 1, tz) !== 0, { th, below: world.getBlock(tx, th - 1, tz) });

/* (a) connection rule: a cell with no neighbour at all must be refused */
const airCell = [tx, th + 6, tz];
const placedLone = game.placeBlock(airCell[0], airCell[1], airCell[2], 'stone');
ok('placement REJECTED when the block touches nothing',
  placedLone === false && world.getBlock(airCell[0], airCell[1], airCell[2]) === 0,
  { placedLone, block: world.getBlock(airCell[0], airCell[1], airCell[2]) });

/* (b) a block placed on the ground touches the ground and is accepted */
const placedGround = game.placeBlock(tx, th, tz, 'stone');
ok('placement ACCEPTED when it touches a neighbour',
  placedGround === true && world.getBlock(tx, th, tz) === MC.blockIdByName('stone'),
  { placedGround, block: world.getBlock(tx, th, tz) });

/* (c) chains upward, then the tower is dug out from underneath */
let chained = true;
for (let k = 1; k <= 5; k++) chained = chained && game.placeBlock(tx, th + k, tz, 'stone');
ok('placement chains off the block just placed', chained, chained);
world.setBlock(tx, th, tz, 0);                       /* remove the base */
game.sim.tick(1 / MC.C.SIM_TICK_HZ, player.position);
game.sim.tick(1 / MC.C.SIM_TICK_HZ, player.position);
let stillFloating = 0;
for (let k = 1; k <= 5; k++) if (world.getBlock(tx, th + k, tz) === MC.blockIdByName('stone')) stillFloating++;
ok('disconnected blocks stay put (no gravity on normal blocks)', stillFloating === 5, stillFloating);
for (let k = 1; k <= 5; k++) world.setBlock(tx, th + k, tz, 0);

/* Build a sealed flat basin (stone floor + stone ring wall) so terrain, caves
 * and runaway water cannot skew the gravity / flow assertions that follow. */
const STONE = MC.blockIdByName('stone');
const R = 6;                                   /* wall-ring radius */
for (let dx = -R; dx <= R; dx++) {
  for (let dz = -R; dz <= R; dz++) {
    world.setBlock(tx + dx, th - 1, tz + dz, STONE);            /* sealed floor */
    const wall = Math.max(Math.abs(dx), Math.abs(dz)) === R;
    for (let y = th; y <= th + 8; y++) world.setBlock(tx + dx, y, tz + dz, wall ? STONE : 0);
  }
}
world.markRegionDirty(tx - R, th - 2, tz - R, tx + R, th + 8, tz + R);

/* (d) sand: anchored only from the SIDE, so it must fall straight down */
const sandY = th + 4;
world.setBlock(tx + 1, sandY, tz, MC.blockIdByName('stone'));   /* side anchor for the connection rule */
const sandPlaced = game.placeBlock(tx, sandY, tz, 'sand');
ok('sand can be placed', sandPlaced === true && world.getBlock(tx, sandY, tz) === MC.blockIdByName('sand'),
  { sandPlaced, cell: world.getBlock(tx, sandY, tz) });
let simError = null;
try { env.pump(90, 16); } catch (e) { simError = e; }
ok('simulation loop does not throw', !simError, simError && (simError.message + ' | ' + (simError.stack || '').split('\n')[1]));
ok('placed sand left its original cell', world.getBlock(tx, sandY, tz) !== MC.blockIdByName('sand'), world.getBlock(tx, sandY, tz));
let sandRestY = -1;
for (let y = sandY - 1; y >= 0; y--) if (world.getBlock(tx, y, tz) === MC.blockIdByName('sand')) { sandRestY = y; break; }
ok('the fallen sand landed on the ground below', sandRestY >= th - 1 && sandRestY < sandY, { from: sandY, to: sandRestY });
world.setBlock(tx + 1, sandY, tz, 0);
for (let y = 0; y < world.sizeY; y++) if (world.getBlock(tx, y, tz) === MC.blockIdByName('sand')) world.setBlock(tx, y, tz, 0);

/* (e) water: anchored from the side, then it must fall and spread */
const waterY = th + 5;
world.setBlock(tx + 1, waterY, tz, MC.blockIdByName('stone'));
const waterPlaced = game.placeBlock(tx, waterY, tz, 'water');
ok('water can be placed', waterPlaced === true && world.getBlock(tx, waterY, tz) === MC.WATER_ID,
  { waterPlaced, cell: world.getBlock(tx, waterY, tz) });
try { env.pump(180, 16); } catch (e) { simError = e; }
ok('water simulation does not throw', !simError, simError && simError.message);
ok('water fell to the ground', world.getBlock(tx, th, tz) === MC.WATER_ID, { at: world.getBlock(tx, th, tz), below: world.getBlock(tx, th - 1, tz) });
let spread = 0;
for (let dx = -(R - 1); dx <= R - 1; dx++) for (let dz = -(R - 1); dz <= R - 1; dz++) {
  if (world.getBlock(tx + dx, th, tz + dz) === MC.WATER_ID) spread++;
}
ok('water spread sideways into a puddle', spread >= 4, spread);
ok('water puddle is bounded (never exceeded the basin floor)', spread <= (2 * R - 1) * (2 * R - 1), spread);
let escaped = 0;
for (let dx = -R - 3; dx <= R + 3; dx++) for (let dz = -R - 3; dz <= R + 3; dz++) {
  if (Math.max(Math.abs(dx), Math.abs(dz)) <= R) continue;
  for (let y = th; y <= th + 8; y++) if (world.getBlock(tx + dx, y, tz + dz) === MC.WATER_ID) escaped++;
}
ok('water is contained by the basin walls (did not flood the world)', escaped === 0, escaped);
let leaked = 0;
for (let dx = -R - 3; dx <= R + 3; dx++) for (let dz = -R - 3; dz <= R + 3; dz++) {
  if (world.getBlock(tx + dx, th - 1, tz + dz) === MC.WATER_ID) leaked++;
}
ok('water did not fall through the sealed floor', leaked === 0, leaked);
world.setBlock(tx + 1, waterY, tz, 0);
for (let dx = -R - 3; dx <= R + 3; dx++) for (let dz = -R - 3; dz <= R + 3; dz++) {
  for (let y = th - 1; y <= th + 8; y++) if (world.getBlock(tx + dx, y, tz + dz) === MC.WATER_ID) world.setBlock(tx + dx, y, tz + dz, 0);
}
game.sim.clear();
env.pump(5, 16);

/* --------------------------- movement + collision ---------------------- */
/* Carve a clear 1x3 corridor so the walk test cannot be blocked by terrain. */
const cx0 = tx, cz0 = tz;
for (let dz = 0; dz <= 4; dz++) for (let dy = 0; dy <= 2; dy++) world.setBlock(cx0, th + dy, cz0 - dz, 0);
player.position = [cx0 + 0.5, th + 0.05, cz0 + 0.5];
player.velocity = [0, 0, 0];
player.yaw = 0; player.pitch = 0; player.flying = false;
env.pump(10, 16);
const before = player.position.slice();
env.doc.dispatch('keydown', { code: 'KeyW' });
env.pump(60, 16);
env.doc.dispatch('keyup', { code: 'KeyW' });
const moved = Math.hypot(player.position[0] - before[0], player.position[2] - before[2]);
ok('W walks the player around', moved > 3.0, { moved, before, after: player.position, onGround: player.onGround, inWater: player.inWater });
ok('walking went in the -Z direction (yaw 0 forward)', before[2] - player.position[2] > 3.0, { dz: player.position[2] - before[2] });
for (let dz = 0; dz <= 4; dz++) for (let dy = 0; dy <= 2; dy++) world.setBlock(cx0, th + dy, cz0 - dz, 0);
ok('player never left the world', player.position[0] >= 0 && player.position[0] <= world.sizeX &&
  player.position[2] >= 0 && player.position[2] <= world.sizeZ && player.position[1] >= 0, player.position);
ok('player health is a number', typeof player.health === 'number' && player.health > 0, player.health);

/* HUD wiring: hearts, held label and starting kit must be live */
ok('starting kit is in the hotbar', inv.hotbar.filter(function (x) { return !!x; }).length >= 4,
  inv.hotbar.map(function (x) { return x && x.name; }));
ok('hotbar renders icons', env.ids.hotbar.children.length === 9 && env.ids.hotbar.children[0].children.length >= 1,
  env.ids.hotbar.children[0].children.length);
env.pump(5, 16);
ok('health hearts rendered', env.ids.health.children.length === 10, env.ids.health.children.length);
ok('held-item label populated', env.ids['held-label'].textContent.length > 0, env.ids['held-label'].textContent);
ok('water overlay hidden on dry land', env.ids['water-overlay'].classList.contains('hidden'));
/* submerge the head for real and let the player model recompute it */
const hx = Math.floor(player.position[0]), hy = Math.floor(player.position[1]), hz = Math.floor(player.position[2]);
world.setBlock(hx, hy + 1, hz, MC.WATER_ID);
world.setBlock(hx, hy + 2, hz, MC.WATER_ID);
env.pump(6, 16);
ok('headInWater is detected from the world', player.headInWater === true, { hy, above: world.getBlock(hx, hy + 1, hz) });
ok('water overlay shows when the head is submerged', !env.ids['water-overlay'].classList.contains('hidden'));
world.setBlock(hx, hy + 1, hz, 0);
world.setBlock(hx, hy + 2, hz, 0);
env.pump(6, 16);
ok('water overlay hides again on dry land', env.ids['water-overlay'].classList.contains('hidden'));

/* ------------------------------ save / load ---------------------------- */
let saveErr = null, res;
try { res = game.doSave(); } catch (e) { saveErr = e; }
ok('save does not throw', !saveErr, saveErr && saveErr.message);
ok('a save landed in storage', !!env.win.localStorage.getItem(MC.C.SAVE_KEY));
let loadErr = null;
try { game.doLoad(); env.pump(200, 16); } catch (e) { loadErr = e; }
ok('load + reload does not throw', !loadErr, loadErr && (loadErr.message + ' | ' + (loadErr.stack || '').split('\n')[1]));
ok('game still running after reload', MC.game.running === true);
ok('all chunks re-meshed after reload', MC.game.meshedChunks.size === 64, MC.game.meshedChunks.size);

/* doLoad() above rebuilt the world/player/inventory objects, so every test
 * from here on must work against the live ones. */
const g2 = MC.game, world2 = g2.world, player2 = g2.player, inv2 = g2.inventory;
ok('the reload really swapped the world object', world2 !== world, world2 === world);
ok('the reloaded world is intact', world2.getBlock(Math.floor(player2.position[0]),
  Math.floor(player2.position[1]) - 1, Math.floor(player2.position[2])) !== 0, player2.position);

/* --------------------- F3 overlay: cached block census ----------------- */
{
  let calls = 0;
  const realStats = MC.Generator.stats;
  MC.Generator.stats = function (w) { calls++; return realStats.call(MC.Generator, w); };
  game.debugOn = true;
  game._debugStats = null;
  env.pump(120, 16);                       /* ~1.9 s of frames */
  ok('F3 census is cached, not recomputed every frame', calls <= 2, calls);
  ok('F3 overlay still prints the census', /blocks solid/.test(env.ids.debug.textContent),
    env.ids.debug.textContent.slice(0, 120));
  env.pump(300, 16);                       /* ~4.8 s more */
  ok('the census refreshes on a timer, not per frame', calls >= 2 && calls <= 5, calls);
  game.debugOn = false;
  game.ui.debug('');
  MC.Generator.stats = realStats;
}

/* ------------------- panels must pause mining / placing ---------------- */
{
  const px = Math.floor(player2.position[0]), pz = Math.floor(player2.position[2]);
  const py = Math.floor(player2.position[1]) - 1;
  world2.setBlock(px, py, pz, STONE);
  player2.pitch = -1.45;
  env.pump(3, 16);
  env.canvas.dispatch('mousedown', { button: 0 });
  env.doc.dispatch('keydown', { code: 'KeyE' });      /* opens inventory / palette */
  env.doc.dispatch('keyup', { code: 'KeyE' });
  ok('a panel is actually open', game.ui.isInventoryOpen() === true);
  env.pump(90, 16);
  ok('mining PAUSES while a panel is open', world2.getBlock(px, py, pz) === STONE, world2.getBlock(px, py, pz));
  ok('in-progress mining is cleared when a panel opens',
    game.mining.key === null && game.mining.progress === 0, game.mining);
  env.doc.dispatch('keydown', { code: 'KeyE' });      /* close it again */
  env.doc.dispatch('keyup', { code: 'KeyE' });
  ok('the panel closed again', game.ui.isInventoryOpen() === false);
  env.pump(120, 16);
  ok('mining RESUMES once the panel closes', world2.getBlock(px, py, pz) === 0, world2.getBlock(px, py, pz));
  env.doc.dispatch('mouseup', { button: 0 });

  /* placing is gated the same way. Build a flat, known 5x5 platform so the
   * aim and the target cell2 are deterministic instead of terrain-dependent. */
  const qx = Math.floor(player2.position[0]), qz = Math.floor(player2.position[2]);
  const qy = Math.floor(player2.position[1]);
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      world2.setBlock(qx + dx, qy - 1, qz + dz, STONE);
      for (let dy = 0; dy <= 2; dy++) world2.setBlock(qx + dx, qy + dy, qz + dz, 0);
    }
  }
  player2.position = [qx + 0.5, qy + 0.05, qz + 0.5];
  player2.velocity = [0, 0, 0];
  player2.pitch = -0.9; player2.yaw = 0;
  inv2.setSlot('hotbar', 0, { name: 'stone', count: 64 });
  inv2.select(0);
  const cell2 = [qx, qy, qz - 1];
  env.canvas.dispatch('mousedown', { button: 2 });
  env.doc.dispatch('keydown', { code: 'KeyC' });
  env.doc.dispatch('keyup', { code: 'KeyC' });
  ok('the crafting panel is open', game.ui.isCraftingOpen() === true);
  env.pump(40, 16);
  ok('the aim lands on the platform', !!game.target && game.target.hit, game.target);
  ok('placing PAUSES while the crafting panel is open',
    world2.getBlock(cell2[0], cell2[1], cell2[2]) === 0, world2.getBlock(cell2[0], cell2[1], cell2[2]));
  env.doc.dispatch('keydown', { code: 'KeyC' });
  env.doc.dispatch('keyup', { code: 'KeyC' });
  ok('the crafting panel closed', game.ui.isCraftingOpen() === false);
  env.pump(40, 16);
  ok('placing RESUMES once the panel closes',
    world2.getBlock(cell2[0], cell2[1], cell2[2]) !== 0, world2.getBlock(cell2[0], cell2[1], cell2[2]));
  env.doc.dispatch('mouseup', { button: 2 });
  for (let dx = -2; dx <= 2; dx++)
    for (let dz = -2; dz <= 2; dz++)
      for (let dy = 0; dy <= 2; dy++) world2.setBlock(qx + dx, qy + dy, qz + dz, 0);
}

/* --------------------------- middle-mouse pick ------------------------- */
{
  /* settle the player on a known block, then aim straight down at it */
  const px = Math.floor(player2.position[0]), pz = Math.floor(player2.position[2]);
  const py = Math.floor(player2.position[1]) - 1;
  for (let dx = -1; dx <= 1; dx++)
    for (let dz = -1; dz <= 1; dz++) world2.setBlock(px + dx, py, pz + dz, STONE);
  player2.velocity = [0, 0, 0];
  player2.position = [px + 0.5, py + 1.05, pz + 0.5];
  player2.pitch = -1.45; player2.yaw = 0;
  env.pump(30, 16);
  const fy = Math.floor(player2.position[1]) - 1;
  const LOG = MC.blockIdByName('log');
  world2.setBlock(px, fy, pz, LOG);
  env.pump(4, 16);
  ok('the pick aim is on the log', !!game.target && game.target.blockId === LOG,
    { target: game.target && game.target.block, id: game.target && game.target.blockId });

  let picks = 0;
  const realPick = game.pickTargetedBlock;
  game.pickTargetedBlock = function () { picks++; return realPick.call(game); };

  inv2.setSlot('hotbar', inv2.selected, null);
  env.canvas.dispatch('mousedown', { button: 1 });
  env.pump(20, 16);
  env.doc.dispatch('mouseup', { button: 1 });
  env.pump(5, 16);
  ok('middle mouse picks the targeted block in creative',
    !!inv2.getSelected() && inv2.getSelected().name === 'log', inv2.getSelected());
  ok('one middle press = exactly one pick', picks === 1, picks);

  /* survival cannot conjure blocks: it only jumps to a slot that holds one */
  game.mode = 'survival'; inv2.creative = false;
  inv2.clear();
  inv2.setSlot('hotbar', 0, { name: 'stone', count: 5 });
  inv2.setSlot('hotbar', 3, { name: 'log', count: 7 });
  inv2.select(0);
  env.pump(2, 16);
  env.canvas.dispatch('mousedown', { button: 1 }); env.pump(3, 16); env.doc.dispatch('mouseup', { button: 1 });
  ok('survival pick selects the slot that already holds the block', inv2.selected === 3, inv2.selected);
  ok('survival pick does not duplicate the block', inv2.countOf('log') === 7, inv2.countOf('log'));
  inv2.setSlot('hotbar', 3, null);
  env.canvas.dispatch('mousedown', { button: 1 }); env.pump(3, 16); env.doc.dispatch('mouseup', { button: 1 });
  ok('survival pick is a no-op for a block you do not carry',
    inv2.selected === 3 && inv2.countOf('log') === 0, [inv2.selected, inv2.countOf('log')]);
  game.pickTargetedBlock = realPick;
  world2.setBlock(px, fy, pz, STONE);
}

/* ------------------- drop magnet must not divide by zero --------------- */
{
  for (let i = 0; i < inv2.hotbar.length; i++) inv2.setSlot('hotbar', i, { name: 'dirt', count: 64 });
  for (let j = 0; j < inv2.main.length; j++) inv2.setSlot('main', j, { name: 'dirt', count: 64 });
  const p = player2.position;
  game.drops.push({
    pos: [p[0], p[1] + 0.9, p[2]],          /* exactly on the magnet centre */
    vel: [0, 0, 0], name: 'stone', count: 1, age: 2, color: [1, 1, 1], picked: false
  });
  const n = game.drops.length;
  env.pump(40, 16);
  const bad = game.drops.filter(function (d) {
    return d.pos.some(function (v) { return typeof v !== 'number' || v !== v || v === Infinity || v === -Infinity; });
  });
  ok('a drop at zero distance keeps a finite position', bad.length === 0,
    { bad: bad.length, drops: game.drops.length, was: n });
  ok('it is still a normal, tracked drop', game.drops.length >= 1, game.drops.length);
  game.drops.length = 0;
  inv2.clear();
  game.giveStartingItems();
}

/* ------------------------------ long soak ------------------------------ */
let soakErr = null;
try {
  env.canvas.dispatch('mousedown', { button: 2 });
  for (let i = 0; i < 600; i++) {
    if (i % 40 === 0) { player.yaw += 0.7; player.pitch = -0.4 - 0.6 * Math.sin(i * 0.11); }
    if (i % 25 === 0) env.doc.dispatch('keydown', { code: 'KeyD' });
    if (i % 25 === 12) env.doc.dispatch('keyup', { code: 'KeyD' });
    if (i % 33 === 0) env.doc.dispatch('keydown', { code: 'Space' });
    if (i % 33 === 16) env.doc.dispatch('keyup', { code: 'Space' });
    env.frame(16);
  }
  env.doc.dispatch('mouseup', { button: 2 });
} catch (e) { soakErr = e; }
ok('600-frame soak with mining+placing+running does not throw', !soakErr, soakErr && (soakErr.message + ' | ' + (soakErr.stack || '').split('\n')[1].trim()));
ok('no NaN in the player transform', [player.position[0], player.position[1], player.position[2], player.yaw, player.pitch].every(v => v === v && v !== Infinity && v !== -Infinity), player.position);
ok('sim queue drains under the cap', game.sim.pending() <= MC.C.SIM_MAX_UPDATES * 4, game.sim.pending());
ok('mesh queue is bounded', game.meshQueue.size < 200, game.meshQueue.size);
ok('drops are bounded', game.drops.length <= 400, game.drops.length);
ok('renderer still drawing after soak', MC.game.renderer.stats.drawCalls > 0, MC.game.renderer.stats);
ok('no new missing DOM ids', env.missingIds.length === 0, env.missingIds);

/* ---------------- corrupt save: never hang behind the loading overlay ---- */
{
  const finite = function (a) {
    return Array.isArray(a) && a.length === 3 && a.every(function (v) {
      return typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity;
    });
  };
  /* beginPlay() toasts again afterwards, so watch the calls instead of the
   * element text. */
  const toasts = [];
  const realToast = game.ui.toast;
  game.ui.toast = function (m) { toasts.push(String(m)); return realToast.apply(game.ui, arguments); };
  let corruptErr = null;
  try {
    game.loadPayload({
      meta: { seed: 5, mode: 'survival' },
      world: { version: MC.VERSION, chunks: [{ cx: 0, cz: 0, runs: 'not-an-array', metas: [] }] }
    });
    env.pump(300, 16);
  } catch (e) { corruptErr = e; }
  ok('a corrupt chunk payload never throws out of the load', !corruptErr,
    corruptErr && (corruptErr.message + ' | ' + (corruptErr.stack || '').split('\n')[1].trim()));
  ok('the game recovers and keeps running after a corrupt save', MC.game.running === true,
    { running: MC.game.running, paused: MC.game.paused });
  ok('the loading overlay is hidden after recovery', env.ids.loading.classList.contains('hidden'));
  ok('the recovered world is fully meshed', MC.game.meshedChunks.size === 64, MC.game.meshedChunks.size);
  ok('the recovered player has a finite position', finite(MC.game.player.position), MC.game.player.position);
  ok('the corrupt-save toast explains the fallback', toasts.some(function (m) { return /corrupt save/i.test(m); }),
    toasts.filter(function (m) { return /corrupt|room|materials/i.test(m); }));
  game.ui.toast = realToast;

  /* -------------------------------------- malformed player save ---------- */
  MC.game.applyPlayerSave({
    position: [NaN, 'x', undefined], yaw: 'nope', pitch: 99, health: -5, air: NaN
  });
  const p3 = MC.game.player;
  ok('a malformed player save still lands on a finite position', finite(p3.position), p3.position);
  ok('yaw falls back to a real number', typeof p3.yaw === 'number' && p3.yaw === p3.yaw, p3.yaw);
  ok('pitch is clamped to MC.C.PITCH_CLAMP', Math.abs(p3.pitch) <= MC.C.PITCH_CLAMP, p3.pitch);
  ok('health stays inside 1..MC.C.MAX_HEALTH',
    p3.health >= 1 && p3.health <= MC.C.MAX_HEALTH, p3.health);
  ok('air stays inside 0..MC.C.MAX_AIR', p3.air >= 0 && p3.air <= MC.C.MAX_AIR, p3.air);
  MC.game.applyPlayerSave({ position: [12.5, 40, 30.5], yaw: 1.25, pitch: 0.4, health: 7, air: 3 });
  const p4 = MC.game.player;
  ok('a well-formed player save still applies exactly',
    p4.position[0] === 12.5 && p4.position[1] === 40 && p4.position[2] === 30.5 &&
    p4.yaw === 1.25 && p4.pitch === 0.4 && p4.health === 7 && p4.air === 3,
    { pos: p4.position, yaw: p4.yaw, pitch: p4.pitch, health: p4.health, air: p4.air });
  env.pump(30, 16);
  ok('the frame loop survives a bad player payload', MC.game.running === true);
}

/* ---------- world restart drops the previous world's chunk records ------ */
{
  const r = MC.game.renderer;
  /* An imported save may declare a different chunk grid, so a record whose key
   * the next world will never re-mesh must not survive a restart: it would
   * draw ghost terrain and leak its GPU buffers. */
  const stale = { key: '99,99', cx: 99, cz: 99, gpuOpaque: null, gpuTrans: null, mesh: null };
  r.chunks.set(stale.key, stale);
  r.chunkList.push(stale);
  ok('stale chunk record seeded', r.chunks.has('99,99') && r.chunkList.indexOf(stale) >= 0);
  let restartErr = null;
  try {
    MC.game.startWorld(4242, 'survival', null);
    env.pump(400, 16);
  } catch (e) { restartErr = e; }
  ok('a world restart never throws', !restartErr,
    restartErr && (restartErr.message + ' | ' + (restartErr.stack || '').split('\n')[1].trim()));
  ok('the stale chunk record is gone', !r.chunks.has('99,99') && r.chunkList.indexOf(stale) === -1,
    { chunks: r.chunks.size, list: r.chunkList.length });
  ok('the renderer owns exactly the new world\'s 64 chunks',
    r.chunks.size === 64 && r.chunkList.length === 64, { chunks: r.chunks.size, list: r.chunkList.length });
  ok('every renderer record is inside the new chunk grid',
    Array.from(r.chunks.keys()).every(function (k) {
      const parts = k.split(','), cx = +parts[0], cz = +parts[1];
      return cx >= 0 && cx < MC.C.WORLD_CX && cz >= 0 && cz < MC.C.WORLD_CZ;
    }), Array.from(r.chunks.keys()).filter(function (k) {
      const parts = k.split(','), cx = +parts[0], cz = +parts[1];
      return !(cx >= 0 && cx < MC.C.WORLD_CX && cz >= 0 && cz < MC.C.WORLD_CZ);
    }));
  ok('the restarted world is fully meshed', MC.game.meshedChunks.size === 64, MC.game.meshedChunks.size);
  ok('the restarted world has its own seed', MC.game.seed === 4242, MC.game.seed);
  ok('the restarted player belongs to the restarted world',
    MC.game.player.world === MC.game.world, MC.game.player.world === MC.game.world);
  ok('the game is running again after the restart', MC.game.running === true,
    { running: MC.game.running, paused: MC.game.paused });
  ok('the restarted world still draws', r.stats.drawCalls > 0, r.stats);
  ok('still no missing DOM ids', env.missingIds.length === 0, env.missingIds);
}

console.log('\nrenderer stats:', JSON.stringify(MC.game.renderer.stats));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
