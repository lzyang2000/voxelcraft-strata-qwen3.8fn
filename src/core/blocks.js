/* Block registry + texture-atlas tile list.
 * HARD CONTRACT: MC.TILES order defines atlas tile indices. The texture
 * generator MUST emit one tile per name, in this exact order, into a
 * 16x16-tile atlas of 16px tiles.
 *
 * Loaded after constants.js and math.js. */
(function (root) {
  'use strict';
  var MC = (root.MC = root.MC || {});

  /* ---- atlas tiles, in order (index === tile id) ---- */
  MC.TILES = [
    'grass_top', 'grass_side', 'dirt', 'stone', 'cobblestone',
    'sand', 'sandstone_side', 'sandstone_top', 'water', 'log_side',
    'log_top', 'leaves', 'planks', 'glass', 'bedrock',
    'gravel', 'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore',
    'snow_top', 'brick', 'glowstone', 'obsidian', 'cactus_side',
    'cactus_top', 'clay', 'stone_bricks', 'iron_block', 'gold_block',
    'bedrock_smooth', 'wheat'
  ];
  MC.TILE_INDEX = {};
  for (var t = 0; t < MC.TILES.length; t++) MC.TILE_INDEX[MC.TILES[t]] = t;

  var defs = [];
  var byName = {};

  function def(o) {
    var b = {
      id: defs.length,
      name: o.name,
      label: o.label || o.name,
      tiles: o.tiles || { top: o.name, side: o.name, bottom: o.name },
      hardness: o.hardness === undefined ? 1 : o.hardness,
      tool: o.tool || 'none',            /* none | pickaxe | shovel | axe */
      requiresTool: !!o.requiresTool,    /* no drop unless right tool used */
      solid: o.solid !== false,
      opaque: o.opaque !== false,
      pass: o.pass || 'opaque',          /* opaque | trans */
      render: o.render || 'cube',        /* cube | liquid */
      gravity: !!o.gravity,
      liquid: !!o.liquid,
      flow: !!o.flow,
      light: o.light || 0,
      drop: o.drop === undefined ? o.name : o.drop,
      color: o.color || [0.5, 0.5, 0.5],
      sound: o.sound || 'stone',
      placeable: o.placeable !== false,
      replaceable: !!o.replaceable       /* can be overwritten by placement */
    };
    defs.push(b);
    byName[b.name] = b;
    return b;
  }

  def({ name: 'air', label: 'Air', solid: false, opaque: false, hardness: 0,
    liquid: false, placeable: false, replaceable: true, sound: 'none',
    color: [0, 0, 0] });

  def({ name: 'grass', label: 'Grass Block', hardness: 0.6, tool: 'shovel',
    tiles: { top: 'grass_top', side: 'grass_side', bottom: 'dirt' },
    drop: 'dirt', sound: 'grass', color: [0.36, 0.62, 0.24] });

  def({ name: 'dirt', label: 'Dirt', hardness: 0.5, tool: 'shovel',
    tiles: { top: 'dirt', side: 'dirt', bottom: 'dirt' },
    sound: 'dirt', color: [0.5, 0.35, 0.22] });

  def({ name: 'stone', label: 'Stone', hardness: 6, tool: 'pickaxe',
    requiresTool: true, tiles: { top: 'stone', side: 'stone', bottom: 'stone' },
    drop: 'cobblestone', color: [0.5, 0.5, 0.52] });

  def({ name: 'cobblestone', label: 'Cobblestone', hardness: 7, tool: 'pickaxe',
    requiresTool: true, tiles: { top: 'cobblestone', side: 'cobblestone', bottom: 'cobblestone' },
    color: [0.42, 0.42, 0.44] });

  def({ name: 'sand', label: 'Sand', hardness: 0.5, tool: 'shovel',
    tiles: { top: 'sand', side: 'sand', bottom: 'sand' },
    gravity: true, sound: 'sand', color: [0.85, 0.79, 0.55] });

  def({ name: 'sandstone', label: 'Sandstone', hardness: 4, tool: 'pickaxe',
    requiresTool: true,
    tiles: { top: 'sandstone_top', side: 'sandstone_side', bottom: 'sandstone_top' },
    color: [0.82, 0.76, 0.52] });

  def({ name: 'water', label: 'Water', hardness: -1, solid: false, opaque: false,
    pass: 'trans', render: 'liquid', liquid: true, flow: true, placeable: false,
    replaceable: true, tiles: { top: 'water', side: 'water', bottom: 'water' },
    sound: 'liquid', color: [0.2, 0.45, 0.85] });

  def({ name: 'gravel', label: 'Gravel', hardness: 0.6, tool: 'shovel',
    tiles: { top: 'gravel', side: 'gravel', bottom: 'gravel' },
    gravity: true, sound: 'sand', color: [0.52, 0.5, 0.48] });

  def({ name: 'log', label: 'Oak Log', hardness: 2, tool: 'axe',
    tiles: { top: 'log_top', side: 'log_side', bottom: 'log_top' },
    sound: 'wood', color: [0.42, 0.3, 0.17] });

  def({ name: 'leaves', label: 'Leaves', hardness: 0.3,
    opaque: false, tiles: { top: 'leaves', side: 'leaves', bottom: 'leaves' },
    sound: 'grass', color: [0.2, 0.45, 0.18] });

  def({ name: 'planks', label: 'Oak Planks', hardness: 2, tool: 'axe',
    tiles: { top: 'planks', side: 'planks', bottom: 'planks' },
    sound: 'wood', color: [0.68, 0.5, 0.28] });

  def({ name: 'glass', label: 'Glass', hardness: 0.4, opaque: false, pass: 'trans',
    tiles: { top: 'glass', side: 'glass', bottom: 'glass' },
    sound: 'glass', color: [0.75, 0.85, 0.92] });

  def({ name: 'bedrock', label: 'Bedrock', hardness: -1,
    tiles: { top: 'bedrock', side: 'bedrock', bottom: 'bedrock' },
    color: [0.25, 0.25, 0.27] });

  def({ name: 'coal_ore', label: 'Coal Ore', hardness: 8, tool: 'pickaxe',
    requiresTool: true, tiles: { top: 'coal_ore', side: 'coal_ore', bottom: 'coal_ore' },
    color: [0.34, 0.34, 0.36] });

  def({ name: 'iron_ore', label: 'Iron Ore', hardness: 9, tool: 'pickaxe',
    requiresTool: true, tiles: { top: 'iron_ore', side: 'iron_ore', bottom: 'iron_ore' },
    color: [0.62, 0.5, 0.4] });

  def({ name: 'gold_ore', label: 'Gold Ore', hardness: 10, tool: 'pickaxe',
    requiresTool: true, tiles: { top: 'gold_ore', side: 'gold_ore', bottom: 'gold_ore' },
    color: [0.75, 0.65, 0.3] });

  def({ name: 'diamond_ore', label: 'Diamond Ore', hardness: 12, tool: 'pickaxe',
    requiresTool: true, tiles: { top: 'diamond_ore', side: 'diamond_ore', bottom: 'diamond_ore' },
    color: [0.4, 0.75, 0.8] });

  def({ name: 'snow', label: 'Snow Block', hardness: 0.4, tool: 'shovel',
    tiles: { top: 'snow_top', side: 'snow_top', bottom: 'snow_top' },
    sound: 'grass', color: [0.92, 0.95, 0.98] });

  def({ name: 'brick', label: 'Bricks', hardness: 5, tool: 'pickaxe',
    requiresTool: true, tiles: { top: 'brick', side: 'brick', bottom: 'brick' },
    color: [0.6, 0.32, 0.26] });

  def({ name: 'glowstone', label: 'Glowstone', hardness: 1,
    tiles: { top: 'glowstone', side: 'glowstone', bottom: 'glowstone' },
    light: 15, sound: 'glass', color: [0.95, 0.8, 0.4] });

  def({ name: 'obsidian', label: 'Obsidian', hardness: 25, tool: 'pickaxe',
    requiresTool: true, tiles: { top: 'obsidian', side: 'obsidian', bottom: 'obsidian' },
    color: [0.15, 0.1, 0.22] });

  def({ name: 'cactus', label: 'Cactus', hardness: 0.6, opaque: false,
    tiles: { top: 'cactus_top', side: 'cactus_side', bottom: 'cactus_top' },
    sound: 'grass', color: [0.15, 0.45, 0.2] });

  def({ name: 'clay', label: 'Clay', hardness: 0.7, tool: 'shovel',
    tiles: { top: 'clay', side: 'clay', bottom: 'clay' },
    sound: 'dirt', color: [0.6, 0.62, 0.68] });

  def({ name: 'stone_bricks', label: 'Stone Bricks', hardness: 6, tool: 'pickaxe',
    requiresTool: true,
    tiles: { top: 'stone_bricks', side: 'stone_bricks', bottom: 'stone_bricks' },
    color: [0.48, 0.48, 0.5] });

  def({ name: 'iron_block', label: 'Block of Iron', hardness: 10, tool: 'pickaxe',
    requiresTool: true, tiles: { top: 'iron_block', side: 'iron_block', bottom: 'iron_block' },
    color: [0.75, 0.75, 0.78] });

  def({ name: 'gold_block', label: 'Block of Gold', hardness: 12, tool: 'pickaxe',
    requiresTool: true, tiles: { top: 'gold_block', side: 'gold_block', bottom: 'gold_block' },
    color: [0.9, 0.78, 0.35] });

  MC.BLOCKS = defs;
  MC.BLOCK_BY_NAME = byName;
  MC.AIR = 0;
  MC.WATER_ID = byName.water.id;
  MC.BEDROCK_ID = byName.bedrock.id;

  MC.block = function (id) { return defs[id] || defs[0]; };
  MC.blockByName = function (n) { return byName[n] || defs[0]; };
  MC.blockIdByName = function (n) { return byName[n] ? byName[n].id : 0; };

  MC.isAir = function (id) { return id === 0; };
  MC.isOpaqueBlock = function (id) { return defs[id] ? defs[id].opaque : false; };
  MC.isSolidBlock = function (id) { return defs[id] ? defs[id].solid : false; };
  MC.isLiquidBlock = function (id) { return defs[id] ? defs[id].liquid : false; };
  MC.isGravityBlock = function (id) { return defs[id] ? defs[id].gravity : false; };
  MC.isReplaceable = function (id) { return id === 0 || (defs[id] && defs[id].replaceable); };

  /* face index -> tile index (see MC.FACE_ORDER in constants.js) */
  MC.tileFor = function (id, face) {
    var b = defs[id];
    if (!b) return 0;
    var n = face === 2 ? b.tiles.top : face === 3 ? b.tiles.bottom : b.tiles.side;
    var idx = MC.TILE_INDEX[n];
    return idx === undefined ? 0 : idx;
  };

  /* ---------------------------- items (non-block) ------------------------ */
  /* kind: 'block' (wraps a block) | 'tool' | 'material' */
  var items = {};
  function mkItem(o) {
    var it = {
      name: o.name,
      label: o.label || o.name,
      kind: o.kind || 'material',
      block: o.block || null,        /* block name when placeable */
      tool: o.tool || null,          /* pickaxe | axe | shovel */
      tier: o.tier || null,          /* wood | stone | iron */
      speed: o.speed || 1,
      color: o.color || [0.8, 0.8, 0.8]
    };
    items[it.name] = it;
    return it;
  }
  /* every block is also an item */
  for (var bi = 0; bi < defs.length; bi++) {
    if (defs[bi].id === 0) continue;
    mkItem({ name: defs[bi].name, label: defs[bi].label, kind: 'block',
      block: defs[bi].name, color: defs[bi].color });
  }
  var TIERS = { hand: 1, wood: 3, stone: 5, iron: 8, diamond: 12 };
  MC.TOOL_SPEED = TIERS;
  ['pickaxe', 'axe', 'shovel'].forEach(function (kind) {
    [['wood', 'Wooden'], ['stone', 'Stone'], ['iron', 'Iron']].forEach(function (t) {
      mkItem({
        name: t[0] + '_' + kind, label: t[1] + ' ' + kind.charAt(0).toUpperCase() + kind.slice(1),
        kind: 'tool', tool: kind, tier: t[0], speed: TIERS[t[0]],
        color: t[0] === 'wood' ? [0.68, 0.5, 0.28] : t[0] === 'stone' ? [0.5, 0.5, 0.52] : [0.8, 0.8, 0.85]
      });
    });
  });
  MC.ITEMS = items;
  MC.item = function (name) { return items[name] || null; };
  MC.isItemPlaceable = function (name) { var i = items[name]; return !!(i && i.block); };

  /* Break time in seconds for block id using item name (or null = hand). */
  MC.breakTime = function (id, itemName) {
    var b = defs[id];
    if (!b || b.hardness < 0) return Infinity;
    var it = items[itemName];
    var speed = 1, correct = false;
    if (it && it.kind === 'tool' && it.tool === b.tool) { speed = it.speed; correct = true; }
    else if (it && it.kind === 'tool') { speed = 1.4; }
    var t = b.hardness / speed;
    if (b.requiresTool && !correct) t = b.hardness * 3.2;
    return Math.max(0.02, t);
  };
  /* Does breaking block id with itemName yield a drop? */
  MC.breakYields = function (id, itemName) {
    var b = defs[id];
    if (!b || b.hardness < 0) return null;
    var it = items[itemName];
    var correct = !!(it && it.kind === 'tool' && it.tool === b.tool);
    if (b.requiresTool && !correct) return null;
    return b.drop;
  };

  /* Crafting recipes: inputs are [itemName, count] pairs. */
  MC.RECIPES = [
    { out: ['planks', 4], in: [['log', 1]], label: '1 Log -> 4 Planks' },
    { out: ['wood_pickaxe', 1], in: [['planks', 3]], label: '3 Planks -> Wooden Pickaxe' },
    { out: ['wood_axe', 1], in: [['planks', 3]], label: '3 Planks -> Wooden Axe' },
    { out: ['wood_shovel', 1], in: [['planks', 2]], label: '2 Planks -> Wooden Shovel' },
    { out: ['stone_pickaxe', 1], in: [['cobblestone', 4], ['planks', 2]], label: '4 Cobble + 2 Planks -> Stone Pickaxe' },
    { out: ['stone_axe', 1], in: [['cobblestone', 4], ['planks', 2]], label: '4 Cobble + 2 Planks -> Stone Axe' },
    { out: ['stone_shovel', 1], in: [['cobblestone', 2], ['planks', 2]], label: '2 Cobble + 2 Planks -> Stone Shovel' },
    { out: ['iron_pickaxe', 1], in: [['iron_ore', 4], ['planks', 2]], label: '4 Iron Ore + 2 Planks -> Iron Pickaxe' },
    { out: ['iron_axe', 1], in: [['iron_ore', 4], ['planks', 2]], label: '4 Iron Ore + 2 Planks -> Iron Axe' },
    { out: ['iron_shovel', 1], in: [['iron_ore', 2], ['planks', 2]], label: '2 Iron Ore + 2 Planks -> Iron Shovel' },
    { out: ['glass', 2], in: [['sand', 3], ['coal_ore', 1]], label: '3 Sand + 1 Coal -> 2 Glass' },
    { out: ['stone_bricks', 4], in: [['stone', 4]], label: '4 Stone -> 4 Stone Bricks' },
    { out: ['brick', 4], in: [['clay', 4], ['coal_ore', 1]], label: '4 Clay + 1 Coal -> 4 Bricks' },
    { out: ['sandstone', 2], in: [['sand', 4]], label: '4 Sand -> 2 Sandstone' },
    { out: ['glowstone', 1], in: [['gold_ore', 2], ['glass', 2]], label: '2 Gold Ore + 2 Glass -> Glowstone' },
    { out: ['iron_block', 1], in: [['iron_ore', 9]], label: '9 Iron Ore -> Block of Iron' },
    { out: ['gold_block', 1], in: [['gold_ore', 9]], label: '9 Gold Ore -> Block of Gold' }
  ];

  /* Blocks offered in creative palette / starting survival inventory. */
  MC.SURVIVAL_START = [
    ['wood_pickaxe', 1], ['wood_axe', 1], ['wood_shovel', 1],
    ['planks', 16], ['stone', 16], ['glass', 8]
  ];
  MC.CREATIVE_PALETTE = [
    'grass', 'dirt', 'stone', 'cobblestone', 'sand', 'sandstone', 'gravel',
    'log', 'planks', 'leaves', 'glass', 'brick', 'stone_bricks', 'snow',
    'clay', 'glowstone', 'iron_block', 'gold_block', 'obsidian', 'cactus',
    'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'water', 'bedrock'
  ];
})(typeof window !== 'undefined' ? window : globalThis);
