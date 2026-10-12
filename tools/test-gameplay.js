/* Node smoke test for the gameplay layer (no browser needed).
 * Run: node tools/test-gameplay.js */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');

const ctx = {
  console, Math, Date, JSON,
  performance: { now: () => Date.now() },
  setTimeout: (...a) => setTimeout(...a),
  clearTimeout: (...a) => clearTimeout(...a)
};
ctx.globalThis = ctx;
vm.createContext(ctx);

const files = [
  'src/core/constants.js', 'src/core/math.js', 'src/core/blocks.js',
  'src/world/world.js',
  'src/game/input.js', 'src/game/particles.js', 'src/game/inventory.js',
  'src/game/player.js', 'src/game/save.js'
];
for (const f of files) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const MC = ctx.MC;
const C = MC.C;
const STONE = MC.blockIdByName('stone');
const WATER = MC.WATER_ID;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}

/* ------------------------------------------------------------- test helpers */
function flatWorld(chunks, floorTop) {
  const w = new MC.World({ chunksX: chunks, chunksZ: chunks, seed: 11 });
  for (let x = 0; x < w.sizeX; x++) {
    for (let z = 0; z < w.sizeZ; z++) {
      for (let y = 0; y < floorTop; y++) w.setBlock(x, y, z, STONE, 0, { silent: true });
    }
  }
  w.rebuildHeights();
  w.clearDirty();
  return w;
}

function fakeInput(keys) {
  keys = keys || {};
  return {
    sensitivity: 1,
    isDown: (code) => keys[code] === true,
    consumeLook: () => ({ dx: 0, dy: 0 }),
    consumeWheel: () => 0,
    consumePressed: () => false,
    buttons: [false, false, false]
  };
}

function sim(player, seconds, keys) {
  const input = fakeInput(keys);
  const dt = 1 / 60;
  for (let i = 0; i < Math.round(seconds / dt); i++) player.update(dt, input, null);
}

/* ------------------------------------------------------------------- load */
console.log('gameplay load');
ok('MC.Input present', typeof MC.Input === 'function');
ok('MC.Particles present', typeof MC.Particles === 'function');
ok('MC.Inventory present', typeof MC.Inventory === 'function');
ok('MC.Player present', typeof MC.Player === 'function');
ok('MC.Save present', typeof MC.Save === 'function');
ok('ui.js not loaded (DOM-free)', MC.UI === undefined);

console.log('ui.js syntax');
const chk = cp.spawnSync(process.execPath, ['--check', path.join(ROOT, 'src/game/ui.js')], { encoding: 'utf8' });
ok('node --check src/game/ui.js', chk.status === 0, chk.stderr);

/* ----------------------------------------------------------------- player */
console.log('player: gravity + landing');
{
  const w = flatWorld(2, 10);
  const p = new MC.Player(w, { spawn: [8.5, 10, 8.5] });
  ok('spawn stored', p.spawn[0] === 8.5 && p.spawn[1] === 10);
  sim(p, 1.0, {});
  ok('landed exactly on floor', Math.abs(p.position[1] - 10) < 1e-4, p.position[1]);
  ok('onGround true', p.onGround === true);
  ok('no drift with no input', Math.abs(p.position[0] - 8.5) < 1e-6 && Math.abs(p.position[2] - 8.5) < 1e-6, p.position);
  ok('health untouched', p.health === C.MAX_HEALTH, p.health);
  ok('eye height', Math.abs(p.getEye()[1] - (p.position[1] + C.EYE_HEIGHT)) < 1e-9);
  const look = p.getLook();
  ok('look is unit length', Math.abs(Math.hypot(look[0], look[1], look[2]) - 1) < 1e-9, look);
  const box = p.getAABB();
  ok('aabb size', Math.abs((box.max[0] - box.min[0]) - C.PLAYER_WIDTH) < 1e-9 &&
    Math.abs((box.max[1] - box.min[1]) - C.PLAYER_HEIGHT) < 1e-9);
}

console.log('player: walk');
{
  const w = flatWorld(4, 10);
  const p = new MC.Player(w, { spawn: [32.5, 10, 32.5] });
  p.yaw = 0;
  sim(p, 0.25, {});
  const z0 = p.position[2], x0 = p.position[0];
  sim(p, 2.0, { KeyW: true });
  const travelled = z0 - p.position[2];
  ok('moved forward (-Z at yaw 0)', travelled > 0, travelled);
  ok('straight line (no x drift)', Math.abs(p.position[0] - x0) < 1e-6, p.position[0] - x0);
  ok('speed ~ WALK_SPEED*2 within 25%',
    Math.abs(travelled - C.WALK_SPEED * 2) <= C.WALK_SPEED * 2 * 0.25, [travelled, C.WALK_SPEED * 2]);
  ok('stayed on the ground', p.onGround === true && Math.abs(p.position[1] - 10) < 1e-4, p.position[1]);
  ok('bobPhase active while walking', p.bobPhase > 0, p.bobPhase);
}

console.log('player: sprint is faster');
{
  const w = flatWorld(4, 10);
  const a = new MC.Player(w, { spawn: [32.5, 10, 40.5] });
  const b = new MC.Player(w, { spawn: [32.5, 10, 40.5] });
  sim(a, 0.25, {}); sim(b, 0.25, {});
  const dzA = a.position[2], dzB = b.position[2];
  sim(a, 1.5, { KeyW: true });
  sim(b, 1.5, { KeyW: true, ShiftLeft: true });
  ok('sprint covers more ground', (dzB - b.position[2]) > (dzA - a.position[2]) * 1.15,
    [dzA - a.position[2], dzB - b.position[2]]);
  ok('sprinting flag set', b.sprinting === true);
  ok('targetFov widens while sprinting',
    typeof b.targetFov === 'number' && b.targetFov > C.FOV + 3 && a.targetFov < b.targetFov,
    [a.targetFov, b.targetFov]);
}

console.log('player: jump');
{
  const w = flatWorld(2, 10);
  const p = new MC.Player(w, { spawn: [8.5, 10, 8.5] });
  sim(p, 0.25, {});
  const input = fakeInput({ Space: true });
  p.update(1 / 60, input, null);          /* one tick of jump */
  let peak = p.position[1];
  for (let i = 0; i < 180; i++) {
    p.update(1 / 60, fakeInput({}), null);
    if (p.position[1] > peak) peak = p.position[1];
  }
  ok('peak height in (1.0, 2.0)', peak - 10 > 1.0 && peak - 10 < 2.0, peak - 10);
  ok('lands back on the floor', Math.abs(p.position[1] - 10) < 1e-4 && p.onGround === true, p.position[1]);
}

console.log('player: look is one code path with MC.C constants');
{
  ok('MC.C.LOOK_SENS is the single sensitivity constant', MC.C.LOOK_SENS === 0.0022, MC.C.LOOK_SENS);
  ok('MC.C.PITCH_CLAMP is the single pitch clamp', MC.C.PITCH_CLAMP === 1.5533, MC.C.PITCH_CLAMP);
  const w = flatWorld(2, 10);
  const p = new MC.Player(w, { spawn: [8.5, 10, 8.5] });
  p.applyLook(100, 0, 1);
  const wrapped = ((-100 * MC.C.LOOK_SENS) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
  ok('applyLook turns yaw by LOOK_SENS per pixel', Math.abs(p.yaw - wrapped) < 1e-12, [p.yaw, wrapped]);
  p.applyLook(0, 1000, 1);
  ok('applyLook clamps pitch to PITCH_CLAMP', p.pitch === -MC.C.PITCH_CLAMP, p.pitch);
  p.applyLook(0, -1e6, 1);
  ok('applyLook clamps the other way too', p.pitch === MC.C.PITCH_CLAMP, p.pitch);
  p.applyLook(0, 0, 2);
  ok('sensitivity scales the delta', p.pitch === MC.C.PITCH_CLAMP);
  p.applyLook(1e6, 0, 1);
  ok('yaw stays wrapped', p.yaw >= 0 && p.yaw < Math.PI * 2, p.yaw);
  /* update() must NOT drain the look queue a second time (double-turn bug). */
  let drained = 0;
  const counting = fakeInput({});
  counting.consumeLook = () => { drained++; return { dx: 50, dy: 50 }; };
  const q = new MC.Player(w, { spawn: [8.5, 10, 8.5] });
  const y0 = q.yaw, pi0 = q.pitch;
  q.update(1 / 60, counting, null);
  ok('player.update does not consume look', drained === 0, drained);
  ok('player.update leaves the view alone', q.yaw === y0 && q.pitch === pi0, [q.yaw - y0, q.pitch - pi0]);
}

console.log('player: wall collision');
{
  const w = flatWorld(4, 10);
  for (let y = 10; y <= 12; y++) {
    for (let z = 28; z <= 36; z++) w.setBlock(12, y, z, STONE);
  }
  const p = new MC.Player(w, { spawn: [10.5, 10, 32.5] });
  p.yaw = -Math.PI / 2;                    /* forward = +X */
  sim(p, 3.0, { KeyW: true });
  const half = C.PLAYER_WIDTH / 2;
  ok('stopped by the wall', p.position[0] + half <= 12 + 1e-6, p.position[0] + half);
  ok('pressed against the wall', p.position[0] + half > 11.9, p.position[0] + half);
  ok('did not climb the wall', Math.abs(p.position[1] - 10) < 1e-4, p.position[1]);
}

console.log('player: step up');
{
  const w = flatWorld(4, 10);
  for (let x = 12; x <= 40; x++) {          /* a raised ledge to climb onto */
    for (let z = 28; z <= 36; z++) w.setBlock(x, 10, z, STONE);
  }
  const p = new MC.Player(w, { spawn: [10.5, 10, 32.5] });
  p.yaw = -Math.PI / 2;
  sim(p, 3.0, { KeyW: true });
  ok('climbed the step', Math.abs(p.position[1] - 11) < 1e-4, p.position[1]);
  ok('walked past the step edge', p.position[0] > 12.3, p.position[0]);
  ok('on top of the step', p.onGround === true);

  const q = new MC.Player(w, { spawn: [10.5, 10, 32.5] });
  q.yaw = -Math.PI / 2;
  sim(q, 3.0, { KeyW: true, ControlLeft: true });   /* sneaking must not auto-step */
  ok('sneaking does not climb the ledge', Math.abs(q.position[1] - 10) < 1e-4, q.position[1]);
}

console.log('player: fall damage');
{
  const w = flatWorld(2, 10);
  let landed = 0;
  const p = new MC.Player(w, { spawn: [8.5, 40, 8.5] });
  p.events.onLand = () => { landed++; };
  sim(p, 6.0, {});
  ok('big drop deals damage', p.health < C.MAX_HEALTH, p.health);
  ok('onLand fired', landed >= 1, landed);

  const q = new MC.Player(w, { spawn: [8.5, 11, 8.5] });
  sim(q, 2.0, {});
  ok('1-block drop is safe', q.health === C.MAX_HEALTH, q.health);
  ok('short drop still lands', q.onGround === true && Math.abs(q.position[1] - 10) < 1e-4);

  const r = new MC.Player(w, { spawn: [8.5, 40, 8.5] });
  r.toggleFly();
  sim(r, 6.0, {});
  ok('fall damage suppressed while flying', r.health === C.MAX_HEALTH, r.health);
}

console.log('player: drowning');
{
  const w = flatWorld(2, 10);
  for (let x = 8; x <= 10; x++) {
    for (let z = 8; z <= 10; z++) for (let y = 10; y <= 24; y++) w.setBlock(x, y, z, WATER);
  }
  const p = new MC.Player(w, { spawn: [9.5, 14, 9.5] });
  p.air = 4;                                /* already partly out of breath */
  sim(p, 12.0, {});
  ok('headInWater detected', p.headInWater === true);
  ok('inWater detected', p.inWater === true);
  ok('air exhausted', p.air === 0, p.air);
  ok('health decreases while drowning', p.health < C.MAX_HEALTH, p.health);

  const q = new MC.Player(w, { spawn: [9.5, 14, 9.5] });
  q.air = 5;
  sim(q, 5.0, {});
  ok('air refills at the surface', q.air > 5 || q.headInWater, q.air);
}

console.log('player: flying');
{
  const w = flatWorld(2, 10);
  const p = new MC.Player(w, { spawn: [8.5, 10, 8.5] });
  sim(p, 0.5, {});
  p.toggleFly();
  ok('flying flag', p.flying === true);
  const y0 = p.position[1];
  sim(p, 1.0, {});
  ok('gravity does not pull a flyer down', Math.abs(p.position[1] - y0) < 1e-3, p.position[1] - y0);
  sim(p, 1.0, { Space: true });
  ok('Space raises the flyer', p.position[1] > y0 + 4, p.position[1] - y0);
  sim(p, 1.0, { ControlLeft: true });
  ok('Ctrl lowers the flyer', p.position[1] < y0 + 4, p.position[1]);
  p.toggleFly();
  ok('fly off restores gravity', p.flying === false);
  sim(p, 2.0, {});
  ok('falls back to the floor', Math.abs(p.position[1] - 10) < 1e-4, p.position[1]);
}

console.log('player: damage / death / respawn');
{
  const w = flatWorld(2, 10);
  let deaths = 0, damage = 0;
  const p = new MC.Player(w, { spawn: [8.5, 10, 8.5] });
  p.events.onDeath = () => { deaths++; };
  p.events.onDamage = (n) => { damage += n; };
  p.applyDamage(5, 'test');
  ok('damage applied', p.health === 15 && damage === 5, p.health);
  p.heal(3);
  ok('heal applied', p.health === 18);
  p.heal(99);
  ok('heal clamps', p.health === C.MAX_HEALTH);
  p.applyDamage(50, 'test');
  ok('death fires once', deaths === 1 && p.alive === false, [deaths, p.alive]);
  ok('velocity zeroed on death', p.velocity[0] === 0 && p.velocity[1] === 0 && p.velocity[2] === 0);
  p.respawn();
  ok('respawn restores', p.alive === true && p.health === C.MAX_HEALTH && p.air === C.MAX_AIR &&
    p.position[0] === 8.5 && p.position[1] === 10);
}

console.log('player: sneak edge guard');
{
  const w = new MC.World({ chunksX: 1, chunksZ: 1, seed: 3 });
  for (let x = 0; x < 16; x++) for (let z = 0; z < 8; z++) w.setBlock(x, 9, z, STONE, 0, { silent: true });
  w.rebuildHeights(); w.clearDirty();
  const p = new MC.Player(w, { spawn: [8.5, 10, 4.5] });
  p.yaw = Math.PI / 2;                     /* forward = +X, toward the void at x>=16 */
  sim(p, 4.0, { KeyW: true, ControlLeft: true });
  ok('sneaking flag', p.sneaking === true);
  ok('did not walk off the edge', p.position[0] < 16.0 && p.position[1] === 10, p.position);
}

/* --------------------------------------------------------------- inventory */
console.log('inventory');
{
  const inv = new MC.Inventory({ creative: false });
  ok('hotbar length', inv.hotbar.length === C.HOTBAR_SLOTS);
  ok('main length', inv.main.length === 27);
  ok('addItem fits one stack', inv.addItem('cobblestone', 64) === 0 && inv.hotbar[0].count === 64);
  ok('spills into a second slot', inv.addItem('cobblestone', 10) === 0 && inv.hotbar[1].count === 10);
  ok('countOf totals', inv.countOf('cobblestone') === 74, inv.countOf('cobblestone'));
  ok('stack cap respected', inv.hotbar.every(s => !s || s.count <= C.STACK_SIZE));
  ok('tools do not stack',
    inv.addItem('wood_pickaxe', 1) === 0 && inv.addItem('wood_pickaxe', 1) === 0 &&
    inv.countOf('wood_pickaxe') === 2 &&
    inv.hotbar.filter(s => s && s.name === 'wood_pickaxe').length === 2);
  inv.removeItem('cobblestone', 74);
  ok('removeItem clears', inv.countOf('cobblestone') === 0);
  ok('removeItem reports the real count', inv.removeItem('cobblestone', 5) === 0);

  const recipe = MC.RECIPES.find(r => r.out[0] === 'planks');
  ok('planks recipe exists', !!recipe && recipe.out[1] === 4);
  inv.addItem('log', 2);
  ok('canCraft true', inv.canCraft(recipe) === true);
  ok('craft ok', inv.craft(recipe) === true);
  ok('craft consumed exactly 1 log', inv.countOf('log') === 1, inv.countOf('log'));
  ok('craft yielded 4 planks', inv.countOf('planks') === 4, inv.countOf('planks'));
  ok('canCraft false without inputs', inv.canCraft(MC.RECIPES.find(r => r.out[0] === 'iron_block')) === false);
  ok('craft refuses', inv.craft(MC.RECIPES.find(r => r.out[0] === 'iron_block')) === false);

  inv.select(3);
  ok('select', inv.selected === 3);
  inv.scroll(7);
  ok('scroll wraps', inv.selected === (3 + 7) % C.HOTBAR_SLOTS, inv.selected);
  inv.setSlot('hotbar', 0, { name: 'dirt', count: 5 });
  inv.select(0);
  ok('takeSelected', inv.takeSelected(2) === 2 && inv.getSelected().count === 3);
  ok('takeSelected empties the slot', inv.takeSelected(99) === 3 && inv.getSelected() === null);
  ok('takeSelected on an empty slot', inv.takeSelected(1) === 0);
  inv.setSlot('main', 5, { name: 'sand', count: 12 });
  ok('setSlot', inv.main[5].name === 'sand' && inv.main[5].count === 12);

  const v0 = inv.changed();
  inv.addItem('dirt', 1);
  ok('changed() bumps', inv.changed() !== v0);

  const snap = JSON.parse(JSON.stringify(inv.serialize()));
  const inv2 = new MC.Inventory({});
  ok('deserialize', inv2.deserialize(snap));
  ok('round-trip hotbar', JSON.stringify(inv2.hotbar) === JSON.stringify(inv.hotbar));
  ok('round-trip main', JSON.stringify(inv2.main) === JSON.stringify(inv.main));
  ok('round-trip selection', inv2.selected === inv.selected);

  /* game.js calls craft() and then addItem(output) again; the model must not
   * hand out double items because of that second add. */
  const g1 = new MC.Inventory({});
  g1.addItem('log', 3);
  g1.craft(recipe);
  ok('craft() adds the output exactly once', g1.countOf('planks') === 4, g1.countOf('planks'));
  g1.addItem('planks', 4);
  ok('a later real pickup still lands', g1.countOf('planks') === 8, g1.countOf('planks'));
  ok('no duplicate-add absorption shim remains', !('_credit' in g1), Object.keys(g1));

  /* P1-2 regression: craft() used to consume the inputs and then silently
   * discard an output that had nowhere to go. */
  const bricks = MC.RECIPES.find(r => r.out[0] === 'stone_bricks');
  ok('stone_bricks recipe exists', !!bricks, bricks);
  const packed = new MC.Inventory({});
  for (let i = 0; i < packed.hotbar.length; i++) packed.setSlot('hotbar', i, { name: 'stone', count: 64 });
  for (let j = 0; j < packed.main.length; j++) packed.setSlot('main', j, { name: 'stone', count: 64 });
  ok('a full bag can still pay for the recipe', packed.canCraft(bricks) === true);
  ok('canCraftTo sees there is no room for the output', packed.canCraftTo(bricks) === false);
  const stoneBefore = packed.countOf('stone');
  ok('craft REFUSES when the output cannot be stored', packed.craft(bricks) === false);
  ok('a refused craft consumes nothing', packed.countOf('stone') === stoneBefore,
    [stoneBefore, packed.countOf('stone')]);
  ok('a refused craft invents no output', packed.countOf('stone_bricks') === 0, packed.countOf('stone_bricks'));

  /* ...but a craft whose inputs free a slot must still go through. */
  const tight = new MC.Inventory({});
  for (let i = 0; i < tight.hotbar.length; i++) tight.setSlot('hotbar', i, { name: 'dirt', count: 64 });
  for (let j = 0; j < tight.main.length - 1; j++) tight.setSlot('main', j, { name: 'dirt', count: 64 });
  tight.setSlot('main', tight.main.length - 1, { name: 'stone', count: 4 });
  ok('the last slot pays for the recipe exactly', tight.canCraft(bricks) === true);
  ok('canCraftTo accounts for the slot the inputs free', tight.canCraftTo(bricks) === true);
  ok('craft succeeds when consuming frees room', tight.craft(bricks) === true);
  ok('the output landed in the freed slot', tight.countOf('stone_bricks') === 4, tight.countOf('stone_bricks'));
  ok('the inputs were consumed', tight.countOf('stone') === 0, tight.countOf('stone'));

  /* tool outputs cap at 1 per slot, so the same rule applies there */
  const fullTools = new MC.Inventory({});
  for (let i = 0; i < fullTools.hotbar.length; i++) fullTools.setSlot('hotbar', i, { name: 'planks', count: 64 });
  for (let j = 0; j < fullTools.main.length; j++) fullTools.setSlot('main', j, { name: 'planks', count: 64 });
  const pick = MC.RECIPES.find(r => r.out[0] === 'wood_pickaxe');
  ok('a packed bag cannot hold a crafted tool', fullTools.canCraftTo(pick) === false);
  ok('crafting a tool is refused, not destroyed', fullTools.craft(pick) === false);
  ok('the planks survived', fullTools.countOf('planks') === 36 * 64, fullTools.countOf('planks'));

  const cre = new MC.Inventory({ creative: true });
  cre.setSlot('hotbar', 0, { name: 'stone', count: 64 });
  ok('creative addItem is a no-op', cre.addItem('dirt', 10) === 0 && cre.countOf('dirt') === 0);
  ok('creative takeSelected keeps the stack',
    cre.takeSelected(10) === 10 && cre.hotbar[0].count === 64);
}

/* ---------------------------------------------------------------- particles */
console.log('particles');
{
  const w = flatWorld(2, 10);
  const pt = new MC.Particles(60);
  ok('starts empty', pt.count() === 0 && pt.list().length === 0);
  pt.spawnBlockBreak(8, 10, 8, STONE, 20);
  ok('spawned', pt.count() === 20, pt.count());
  const first = pt.list();
  ok('list reuses one array', pt.list() === first);
  let nan = 0;
  for (let i = 0; i < 60; i++) {
    pt.update(1 / 30, w);
    for (const q of pt.list()) {
      if (!isFinite(q.pos[0]) || !isFinite(q.pos[1]) || !isFinite(q.pos[2])) nan++;
      if (!(q.color[0] >= 0 && q.color[0] <= 1)) nan++;
    }
  }
  ok('no NaN positions', nan === 0, nan);
  ok('particles expire', pt.count() < 20, pt.count());
  ok('all gone after 2 s', pt.count() === 0, pt.count());
  pt.spawnBlockBreak(8, 10, 8, STONE, 200);
  ok('respects the pool cap', pt.count() <= 60 && pt.list().length <= 60, pt.count());
  pt.spawnHit(8, 10, 8, STONE);
  pt.spawnSplash(8, 10, 8);
  ok('hit/splash do not overflow', pt.count() <= 60);
  pt.clear();
  ok('clear', pt.count() === 0);
  pt.update(1 / 60, w);
  ok('update on an empty pool is safe', pt.count() === 0);
}

/* ------------------------------------------------- dropped item entities */
/* A mined block drops as a mini textured cube that floats and bobs; a tool or
 * material has no block tile, so it keeps the old point sprite. Both mappings
 * live in game.js and must never touch the drop's physics position. */
console.log('drop item entities');
{
  /* game.js boots itself off the document, so it gets its own context with a
   * 'loading' stub document: the module under test is reachable as MC.Game,
   * and the main context above stays DOM-free (input.js asserts that). */
  const gctx = { console, Math, Date, JSON, performance: { now: () => Date.now() },
    document: { readyState: 'loading', addEventListener: () => {}, getElementById: () => null } };
  gctx.globalThis = gctx;
  vm.createContext(gctx);
  let gameErr = null;
  try {
    for (const f of ['src/core/constants.js', 'src/core/math.js', 'src/core/blocks.js',
      'src/game/particles.js', 'src/game/game.js']) {
      vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), gctx, { filename: f });
    }
  } catch (e) { gameErr = e; }
  ok('game.js loads without booting a game', !gameErr, gameErr && gameErr.message);
  const G = gctx.MC;
  ok('MC.Game loaded', typeof G.Game === 'function');
  ok('no game was started', G.game === undefined, G.game);
  ok('DROP_* constants', C.DROP_ITEM_SIZE === 0.3 && C.DROP_ITEM_FLOAT === 0.16 &&
    C.DROP_BOB_AMP === 0.05 && C.DROP_BOB_SPEED === 2.6 &&
    C.DROP_SPIN_SPEED === 1.7 && C.DROP_POP_RATE === 5,
    [C.DROP_ITEM_SIZE, C.DROP_ITEM_FLOAT, C.DROP_BOB_AMP, C.DROP_BOB_SPEED,
     C.DROP_SPIN_SPEED, C.DROP_POP_RATE]);

  const g = new G.Game();
  g.particles = new G.Particles(60);
  const mkDrop = (name, age) => ({
    pos: [10.5, 20.45, 30.5], vel: [0, 0, 0], name: name, count: 1,
    age: age === undefined ? 0 : age, color: [0.5, 0.5, 0.5], picked: false
  });

  g.drops.length = 0;
  g.drops.push(mkDrop('stone', 1));
  const items = g.renderItems();
  ok('one item entry per block drop', items.length === 1, items.length);
  ok('item blockId is the dropped block', items[0].blockId === STONE, items[0].blockId);
  ok('item x/z follow the drop exactly', items[0].pos[0] === 10.5 && items[0].pos[2] === 30.5, items[0].pos);
  ok('renderItems never moves the drop', g.drops[0].pos[1] === 20.45, g.drops[0].pos);

  /* bob: oscillates around pos.y + DROP_ITEM_FLOAT with amplitude DROP_BOB_AMP */
  const period = (2 * Math.PI) / C.DROP_BOB_SPEED;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i <= 240; i++) {
    g.drops[0].age = (i / 240) * period;
    const y = g.renderItems()[0].pos[1];
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  const mid = g.drops[0].pos[1] + C.DROP_ITEM_FLOAT;
  ok('item floats clear of the ground', lo > g.drops[0].pos[1] + 0.05, lo);
  ok('bob oscillates (max > min)', hi - lo > 1e-6, [lo, hi]);
  ok('bob is centred on pos.y + DROP_ITEM_FLOAT', Math.abs((lo + hi) / 2 - mid) < 1e-9, [(lo + hi) / 2, mid]);
  ok('bob amplitude is DROP_BOB_AMP', Math.abs((hi - lo) / 2 - C.DROP_BOB_AMP) < 1e-9, (hi - lo) / 2);

  /* pop-in ramp: 0 -> DROP_ITEM_SIZE over 1/DROP_POP_RATE seconds */
  g.drops[0].age = 0;
  ok('size starts at 0', g.renderItems()[0].size === 0, g.renderItems()[0].size);
  g.drops[0].age = 0.5 / C.DROP_POP_RATE;
  ok('half size at half the pop time',
    Math.abs(g.renderItems()[0].size - C.DROP_ITEM_SIZE * 0.5) < 1e-12, g.renderItems()[0].size);
  g.drops[0].age = 1 / C.DROP_POP_RATE;
  ok('full size at 1/DROP_POP_RATE',
    Math.abs(g.renderItems()[0].size - C.DROP_ITEM_SIZE) < 1e-12, g.renderItems()[0].size);
  g.drops[0].age = 30;
  ok('size clamps at DROP_ITEM_SIZE', g.renderItems()[0].size === C.DROP_ITEM_SIZE, g.renderItems()[0].size);

  /* spin grows with age (slow yaw) */
  g.drops[0].age = 0.2;
  const spinA = g.renderItems()[0].spin;
  g.drops[0].age = 1.2;
  const spinB = g.renderItems()[0].spin;
  ok('spin grows with age', spinB > spinA, [spinA, spinB]);
  ok('spin equals age * DROP_SPIN_SPEED',
    Math.abs(spinB - 1.2 * C.DROP_SPIN_SPEED) < 1e-12, [spinB, 1.2 * C.DROP_SPIN_SPEED]);

  /* pooled scratch: no per-frame allocation churn */
  const poolA = g.renderItems();
  const poolB = g.renderItems();
  ok('renderItems reuses one array and its entries', poolA === poolB && poolA[0] === poolB[0]);

  /* particles: a block drop is no longer a point sprite */
  g.drops.length = 0;
  g.particles.clear();
  g.particles.spawnBlockBreak(8, 10, 8, STONE, 12);
  const pc = g.particles.count();
  ok('some particles exist to count', pc > 0, pc);
  g.drops.push(mkDrop('stone', 1));
  const pl = g.renderParticles();
  ok('a block drop adds no point sprite', pl.length === pc, [pl.length, pc]);
  ok('particle count unchanged while a block drop exists', g.particles.count() === pc, g.particles.count());
  {
    const real = g.particles.list();
    ok('every particle entry is a real particle', pl.every((q) => real.indexOf(q) >= 0), pl.length);
  }

  /* tools / materials have no block tile: they must stay visible as sprites */
  g.drops.length = 0;
  g.particles.clear();
  g.drops.push(mkDrop('wooden_pickaxe', 1));
  ok('a tool drop emits no item cube', g.renderItems().length === 0, g.renderItems().length);
  ok('a tool drop still gets a visible sprite', g.renderParticles().length === 1, g.renderParticles().length);
  {
    const sp = g.renderParticles()[0];
    const wantY = 20.45 + C.DROP_ITEM_FLOAT + Math.sin(1 * C.DROP_BOB_SPEED) * C.DROP_BOB_AMP;
    ok('the fallback sprite floats and bobs like a cube', Math.abs(sp.pos[1] - wantY) < 1e-12, [sp.pos[1], wantY]);
    ok('the fallback sprite keeps the drop colour', sp.color[0] === 0.5 && sp.color[2] === 0.5, sp.color);
    ok('the fallback sprite keeps the old size behaviour',
      sp.size > 0.3 && sp.size < 0.4, sp.size);
    ok('the fallback sprite does not move the drop', g.drops[0].pos[1] === 20.45, g.drops[0].pos);
  }

  /* both kinds at once: the two counts stay separated */
  g.drops.length = 0;
  g.particles.clear();
  g.particles.spawnBlockBreak(8, 10, 8, STONE, 12);
  const pc2 = g.particles.count();
  g.drops.push(mkDrop('stone', 1), mkDrop('log', 2),
    mkDrop('wooden_pickaxe', 1), mkDrop('iron_axe', 0.5));
  ok('2 block drops -> 2 item cubes', g.renderItems().length === 2, g.renderItems().length);
  ok('2 block drops + 2 tools -> particles + 2 sprites',
    g.renderParticles().length === pc2 + 2, [g.renderParticles().length, pc2]);
  {
    const mixed = g.renderItems();
    ok('the item list holds only the block drops',
      mixed.every((e) => e.blockId !== 0) &&
      mixed[0].blockId === MC.blockIdByName('stone') &&
      mixed[1].blockId === MC.blockIdByName('log'),
      mixed.map((e) => e.blockId));
  }
  g.drops.length = 0;
  g.particles.clear();
  ok('clearing drops empties both lists',
    g.renderItems().length === 0 && g.renderParticles().length === 0,
    [g.renderItems().length, g.renderParticles().length]);
}

/* -------------------------------------------------------------------- save */
console.log('save');
{
  const mem = {};
  ctx.localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: (k) => { delete mem[k]; }
  };
  const w = flatWorld(1, 10);
  w.setBlock(3, 10, 3, MC.blockIdByName('log'), 4);
  const p = new MC.Player(w, { spawn: [8.5, 10, 8.5] });
  p.position = [9.25, 10, 7.75]; p.yaw = 0.5; p.pitch = -0.25; p.health = 13; p.air = 9;
  const inv = new MC.Inventory({});
  inv.addItem('cobblestone', 12);
  const save = new MC.Save();
  ok('storage available', save.available() === true);
  const res = save.save(w, p, inv, { seed: 11, mode: 'survival', timeOfDay: 0.25 });
  ok('save ok', res.ok === true && res.bytes > 0, res);
  ok('has()', save.has() === true);
  const out = save.load();
  ok('load ok', out.ok === true && !!out.data, out && out.error);
  ok('payload version', out.data.version === MC.VERSION);
  ok('payload meta', out.data.meta.seed === 11 && out.data.meta.mode === 'survival' && out.data.meta.timeOfDay === 0.25);
  ok('player round-trip', out.data.player.position[0] === 9.25 && out.data.player.yaw === 0.5 &&
    out.data.player.health === 13 && out.data.player.air === 9);
  ok('world round-trip', (() => {
    const w2 = new MC.World({ chunksX: 1, chunksZ: 1 });
    return w2.deserialize(out.data.world) && w2.getBlock(3, 10, 3) === MC.blockIdByName('log') &&
      w2.getMeta(3, 10, 3) === 4 && w2.isSolidAt(0, 5, 0);
  })());
  ok('inventory round-trip', (() => {
    const i2 = new MC.Inventory({});
    return i2.deserialize(out.data.inventory) && i2.countOf('cobblestone') === 12;
  })());
  save.clear();
  ok('clear removes the save', save.has() === false && save.load().ok === false);

  ctx.localStorage = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); }
  };
  const blocked = new MC.Save();
  ok('blocked storage reports unavailable', blocked.available() === false);
  let threw = null;
  try { blocked.save(w, p, inv, {}); } catch (e) { threw = e; }
  ok('save does not throw on blocked storage', threw === null, threw && threw.message);
  const bres = blocked.save(w, p, inv, {});
  ok('save returns ok:false', bres.ok === false, bres);
  ok('in-session fallback still loads', blocked.load().ok === true);

  ctx.localStorage = { getItem: () => '{not json', setItem: () => {}, removeItem: () => {} };
  const corrupt = new MC.Save();
  ok('corrupt save handled', corrupt.load().ok === false && !!corrupt.load().error);

  ctx.localStorage = {
    getItem: () => null,
    setItem() { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; },
    removeItem: () => {}
  };
  const quota = new MC.Save();
  const qres = quota.save(w, p, inv, {});
  ok('quota error handled', qres.ok === false && /quota/i.test(qres.error), qres);

  ok('exportFile degrades without a DOM', (() => {
    const r = new MC.Save().exportFile(w, p, inv, {});
    return r.ok === false;
  })());
  ok('exportFile callback form (game.js style)', (() => {
    let cbOk = 'not-called', cbErr = null;
    const r = new MC.Save().exportFile(w, p, inv, {}, (ok2, err) => { cbOk = ok2; cbErr = err; });
    return cbOk === false && typeof cbErr === 'string' && r.ok === false;
  })());
  ok('importFile degrades without a FileReader', (() => {
    let err = 'not-called';
    new MC.Save().importFile({ name: 'x.json' }, (e) => { err = e; });
    return !!err && typeof err.message === 'string';   /* vm realm: not instanceof */
  })());
  delete ctx.localStorage;
  ok('no localStorage -> unavailable', new MC.Save().available() === false);
}

/* -------------------------------------------------------------------- input */
console.log('input');
{
  const inp = new MC.Input({ canvas: null, sensitivity: 1.5 });
  ok('sensitivity honoured', inp.sensitivity === 1.5);
  ok('buttons live state', inp.buttons.length === 3 && inp.buttons[0] === false);
  inp.attach();                       /* headless: must not throw */
  inp._keyDown('KeyW');
  ok('held key', inp.isDown('KeyW') === true);
  inp._keyUp('KeyW');
  ok('released key', inp.isDown('KeyW') === false);
  inp._keyDown('KeyE');
  inp._keyDown('KeyE');               /* auto-repeat must not double-fire */
  ok('edge action fires once', inp.consumePressed('inventory') === true);
  ok('edge action consumed', inp.consumePressed('inventory') === false);
  inp._keyDown('Digit4');
  ok('digit slot action', inp.consumePressed('slot3') === true);
  inp._keyDown('Escape');
  ok('escape -> menu', inp.consumePressed('menu') === true);
  inp._keyDown('F3'); inp._keyDown('F5'); inp._keyDown('F9'); inp._keyDown('KeyF');
  ok('debug/save/load/fly actions',
    inp.consumePressed('debug') && inp.consumePressed('save') &&
    inp.consumePressed('load') && inp.consumePressed('fly'));
  inp.lookX = 12; inp.lookY = -5;
  const look = inp.consumeLook();
  ok('consumeLook drains', look.dx === 12 && look.dy === -5);
  ok('consumeLook resets', inp.consumeLook().dx === 0);
  inp.wheel = 3;
  ok('consumeWheel drains', inp.consumeWheel() === 3 && inp.consumeWheel() === 0);
  ok('not locked', inp.isLocked() === false);
  ok('requestLock without a canvas is safe', inp.requestLock() === false);
  inp.exitLock();
  inp.detach();
  ok('detach is safe', true);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
