/* Voxelcraft integration layer: boot, main loop, mining/placing rules,
 * drops, day/night, chunk mesh scheduling, HUD wiring.
 * Written by the lead agent; depends on every other module's public API. */
(function (root) {
  'use strict';
  var MC = (root.MC = root.MC || {});
  var C = MC.C;
  var doc = root.document;

  function Game() {
    this.canvas = doc.getElementById('game');
    this.world = null;
    this.renderer = null;
    this.input = null;
    this.player = null;
    this.inventory = null;
    this.particles = null;
    this.sim = null;
    this.ui = null;
    this.save = null;

    this.running = false;
    this.paused = true;
    this.mode = 'survival';
    this.seed = null;
    this.time = 0.32;              /* 0 = midnight, 0.5 = noon */
    this.frame = 0;
    this.last = 0;
    this.fps = 0;
    this.fpsAcc = 0;
    this.fpsFrames = 0;
    this.debugOn = false;

    this.meshQueue = new Set();
    this.meshedChunks = new Set();
    this.meshBudget = C.CHUNKS_MERGED_PER_FRAME;

    this.mining = { key: null, progress: 0, total: 0, block: null, held: null };
    this.placeCooldown = 0;
    this.drops = [];
    this.simAcc = 0;
    this.target = null;
    this.glError = null;
    this._scratchParticles = [];
    this._scratchItems = [];
    this._scratchDropSprites = [];
    this._sunDir = [0.3, -0.8, 0.4];

    /* MC.Generator.stats() walks every voxel (~1M blocks, ~46 ms), so the
     * debug overlay reuses one cached snapshot instead of recomputing it. */
    this._debugStats = null;
    this._debugStatsAt = -Infinity;
    this._pickLatch = false;         /* middle-mouse edge detector */
  }

  /* Cached block census for the F3 overlay: at most one full scan every
   * DEBUG_STATS_MS, and never while the world is being (re)generated. */
  Game.prototype.debugStats = function (now) {
    if (!this._debugStats || now - this._debugStatsAt > C.DEBUG_STATS_MS) {
      this._debugStats = MC.Generator.stats ? MC.Generator.stats(this.world) : null;
      this._debugStatsAt = now;
    }
    return this._debugStats;
  };

  /* ------------------------------------------------------------------ boot */
  Game.prototype.boot = function () {
    var self = this;
    this.ui = new MC.UI({
      inventory: null,
      onNewWorld: function () { self.newWorld(); },
      onModeChange: function (m) { self.mode = m; if (self.inventory) self.inventory.creative = (m === 'creative'); },
      onSeedChange: function (s) { self.seedInput = s; },
      onRenderDist: function (n) { C.MAX_MESH_DISTANCE = n; },
      onSensitivity: function (v) { if (self.input) self.input.sensitivity = v; },
      onSave: function () { self.doSave(); },
      onLoad: function () { self.doLoad(); },
      onExport: function () { self.doExport(); },
      onImport: function (data) { self.doImport(data); },
      onCraft: function (recipe) { self.doCraft(recipe); },
      onPickSlot: function (i) { if (self.inventory) { self.inventory.select(i); self.ui.refreshHotbar(); } },
      onPlay: function () { self.togglePause(); },
      onResume: function () { self.togglePause(); },
      onTogglePause: function () { self.togglePause(); },
      onPickPaletteItem: function (name) {
        if (!self.inventory) return;
        self.inventory.setSlot('hotbar', self.inventory.selected, { name: name, count: C.STACK_SIZE });
        self.ui.refreshHotbar();
      }
    });

    try {
      this.renderer = new MC.Renderer(this.canvas);
    } catch (e) {
      this.glError = e && e.message ? e.message : String(e);
      this.ui.showMenu();
      this.ui.setMenuNote('This game needs WebGL2. Your browser reported: ' + this.glError);
      return;
    }
    var atlas = MC.Textures.generate();
    this.renderer.setAtlas(atlas);

    this.input = new MC.Input({ canvas: this.canvas, sensitivity: 1 });
    this.input.attach();
    this.wireInput();

    this.save = new MC.Save();
    this.inventory = new MC.Inventory({ creative: false });
    this.ui.inventory = this.inventory;

    root.addEventListener('resize', function () { self.renderer.resize(); });
    this.canvas.addEventListener('click', function () {
      if (self.running && !self.paused) self.input.requestLock();
    });

    /* boot straight into a fresh world; the menu is the pause screen */
    var seed = (Math.floor(Math.random() * 1e9) | 0);
    this.startWorld(seed, this.mode, null);
  };

  Game.prototype.wireInput = function () {
    var self = this;
    this.input.onAction = function (action) {
      if (!action) return;
      if (action === 'menu') { self.togglePause(); return; }
      if (self.paused) return;
      if (action.indexOf('slot') === 0) {
        var i = parseInt(action.slice(4), 10);
        if (!isNaN(i)) { self.inventory.select(i); self.ui.refreshHotbar(); }
        return;
      }
      switch (action) {
        case 'inventory':
          if (self.mode === 'creative') self.ui.togglePalette ? self.ui.togglePalette() : self.ui.showPalette();
          else self.ui.toggleInventory ? self.ui.toggleInventory() : self.ui.showInventory();
          break;
        case 'crafting': self.ui.toggleCrafting(); break;
        case 'fly':
          self.player.toggleFly();
          self.ui.toast(self.player.flying ? 'Flying enabled' : 'Flying disabled', 1200);
          break;
        case 'drop': self.dropOne(); break;
        case 'cycle-tool': self.cycleTool(); break;
        case 'debug':
          self.debugOn = !self.debugOn;
          self._debugStats = null;          /* a fresh toggle shows a fresh census */
          if (!self.debugOn) self.ui.debug('');
          break;
        case 'save': self.doSave(); break;
        case 'load': self.doLoad(); break;
      }
    };
  };

  /* ------------------------------------------------------------- world setup */
  Game.prototype.newWorld = function () {
    var seed = this.seedInput && String(this.seedInput).trim() !== ''
      ? MC.hashString(String(this.seedInput))
      : (Math.floor(Math.random() * 1e9) | 0);
    this.startWorld(seed, this.mode, null);
  };

  Game.prototype.startWorld = function (seed, mode, loadedData) {
    var self = this;
    this.mode = mode || 'survival';
    this.seed = seed;
    this.running = false;
    this.paused = true;
    this.ui.hideMenu();
    this.ui.showHud();
    this.ui.loading(0, 'Generating world...');

    /* Drop every chunk mesh the previous world owned. A new world re-meshes
     * the same keys when it has the same size, but an imported save may carry
     * a different chunk grid - old records would draw ghost terrain from the
     * previous world and their GPU buffers would never be freed. */
    if (this.renderer) this.renderer.clearChunks();

    this.world = new MC.World({ seed: seed });
    this.inventory = new MC.Inventory({ creative: this.mode === 'creative' });
    this.ui.inventory = this.inventory;
    this.particles = new MC.Particles(700);
    this.sim = new MC.Simulation(this.world);
    this.drops.length = 0;
    this.meshQueue.clear();
    this.meshedChunks.clear();
    this.mining = { key: null, progress: 0, total: 0, block: null, held: null };
    this._pickLatch = false;
    this._debugStats = null;
    this._debugStatsAt = -Infinity;

    root.setTimeout(function () {
      /* A malformed save must never leave the player stuck behind the loading
       * overlay: anything thrown here falls back to a freshly generated world. */
      try {
        if (loadedData) self.loadWorldData(loadedData);
        else self.generateFreshWorld();
      } catch (err) {
        self.ui.toast('Corrupt save (' + (err && err.message ? err.message : err) +
          ') - generated a fresh world instead', 3200);
        self.recoverFreshWorld();
      }
      if (!self.player) self.player = new MC.Player(self.world, { spawn: self.world.findSpawn(64, 64) });
      self.player.events = {
        onDeath: function () { self.onDeath(); },
        onDamage: function () { self.ui.syncHud(self.player, {}); }
      };
      self.world.markRegionDirty(0, 0, 0, self.world.sizeX - 1, self.world.sizeY - 1, self.world.sizeZ - 1);
      self.warmUpMeshes();
    }, 30);
  };

  /* ---- world loading (kept separate so startWorld can recover from a bad
   * payload without duplicating the generation path) ---- */
  Game.prototype.loadWorldData = function (loadedData) {
    if (!loadedData || !loadedData.world) throw new Error('missing world payload');
    if (!this.world.deserialize(loadedData.world)) throw new Error('unreadable world data');
    if (loadedData.player) this.applyPlayerSave(loadedData.player);
    if (loadedData.inventory) this.inventory.deserialize(loadedData.inventory);
    if (loadedData.meta && loadedData.meta.timeOfDay !== undefined) this.time = loadedData.meta.timeOfDay;
    if (loadedData.meta && loadedData.meta.mode) {
      this.mode = loadedData.meta.mode;
      this.inventory.creative = (this.mode === 'creative');
    }
    this.world.relightAll();
  };

  Game.prototype.generateFreshWorld = function () {
    MC.Generator.generate(this.world);
    this.world.relightAll();
    var spawn = this.world.findSpawn((this.world.sizeX / 2) | 0, (this.world.sizeZ / 2) | 0);
    this.player = new MC.Player(this.world, { spawn: spawn });
    this.player.position = [spawn[0], spawn[1] + 0.2, spawn[2]];
    this.giveStartingItems();
  };

  /* Last resort after a load throws: throw the half-loaded world away and
   * rebuild everything the main loop needs from scratch. */
  Game.prototype.recoverFreshWorld = function () {
    this.world = new MC.World({ seed: this.seed });
    this.sim = new MC.Simulation(this.world);
    this.player = null;
    this.drops.length = 0;
    this.meshQueue.clear();
    this.meshedChunks.clear();
    this.generateFreshWorld();
  };

  Game.prototype.giveStartingItems = function () {
    if (this.mode === 'creative') {
      var pal = MC.CREATIVE_PALETTE.slice(0, C.HOTBAR_SLOTS);
      for (var i = 0; i < pal.length; i++) this.inventory.setSlot('hotbar', i, { name: pal[i], count: C.STACK_SIZE });
    } else {
      for (var j = 0; j < MC.SURVIVAL_START.length; j++) {
        this.inventory.addItem(MC.SURVIVAL_START[j][0], MC.SURVIVAL_START[j][1]);
      }
    }
    this.ui.refreshHotbar();
  };

  /* Progressive chunk meshing so the first frame is not a multi-second hitch.
   * Note: world.takeDirty() drains the whole dirty set, so the keys are
   * collected once into an array and consumed in order (nearest first). */
  Game.prototype.warmUpMeshes = function () {
    var self = this;
    var keys = this.world.takeDirty();
    var px = this.player ? this.player.position[0] : this.world.sizeX / 2;
    var pz = this.player ? this.player.position[2] : this.world.sizeZ / 2;
    keys.sort(function (a, b) {
      var pa = a.split(','), pb = b.split(',');
      var da = Math.pow((+pa[0]) * 16 + 8 - px, 2) + Math.pow((+pa[1]) * 16 + 8 - pz, 2);
      var db = Math.pow((+pb[0]) * 16 + 8 - px, 2) + Math.pow((+pb[1]) * 16 + 8 - pz, 2);
      return da - db;
    });
    var total = keys.length;
    var done = 0;
    this.ui.loading(1, 'Generating world...');
    function step() {
      var n = 0;
      while (done < total && n < 8) { self.buildChunk(keys[done++]); n++; }
      var pct = total ? Math.round((done / total) * 100) : 100;
      self.ui.loading(pct, 'Building terrain meshes... ' + done + '/' + total);
      if (done < total) root.requestAnimationFrame(step);
      else self.beginPlay();
    }
    root.requestAnimationFrame(step);
  };

  Game.prototype.beginPlay = function () {
    this.ui.hideLoading();
    this.ui.showHud();
    this.running = true;
    this.paused = false;
    this.last = root.performance.now();
    this.renderer.resize();
    this.ui.refreshHotbar();
    this.ui.syncHud(this.player, {});
    this.ui.toast('Click to capture the mouse', 1800);
    if (!this._loopStarted) {
      this._loopStarted = true;
      var self = this;
      var loop = function (now) { self.frameTick(now); root.requestAnimationFrame(loop); };
      root.requestAnimationFrame(loop);
    }
  };

  /* ------------------------------------------------------------ main loop */
  Game.prototype.frameTick = function (now) {
    var dt = (now - this.last) / 1000;
    this.last = now;
    if (!(dt > 0)) dt = 0.016;
    if (dt > 0.1) dt = 0.1;

    this.fpsAcc += dt; this.fpsFrames++;
    if (this.fpsAcc >= 0.5) { this.fps = this.fpsFrames / this.fpsAcc; this.fpsAcc = 0; this.fpsFrames = 0; }

    if (!this.running) return;
    this.frame++;

    if (!this.paused) {
      this.time = (this.time + dt / C.DAY_LENGTH) % 1;
      this.updateSun();

      var look = this.input.consumeLook();
      if (look && (look.dx || look.dy)) {
        this.player.applyLook(look.dx, look.dy, this.input.sensitivity);
      }
      var wheel = this.input.consumeWheel();
      if (wheel) { this.inventory.scroll(wheel); this.ui.refreshHotbar(); }

      this.player.update(dt, this.input, this.inventory);
      if (!this.player.alive) this.onDeath();

      this.updateTarget();
      this.updatePick();
      this.updateMining(dt);
      this.updatePlacing(dt);

      this.simAcc += dt;
      var step = 1 / C.SIM_TICK_HZ, guard = 0;
      while (this.simAcc >= step && guard < 4) { this.sim.tick(step, this.player.position); this.simAcc -= step; guard++; }
      if (this.simAcc > step * 4) this.simAcc = 0;

      this.updateDrops(dt);
      this.particles.update(dt, this.world);
    }

    /* Relight whatever the player and the cellular automaton changed this
     * frame (one merged region), then re-mesh so the new light shows. */
    this.world.applyLightDirty();
    this.processMeshQueue();
    this.draw();
    this.ui.syncHud(this.player, {});
    this.ui.tick();
    if (this.debugOn) this.updateDebug();
  };

  Game.prototype.updateSun = function () {
    var a = (this.time - 0.25) * Math.PI * 2;
    var sx = Math.cos(a), sy = Math.sin(a);
    var lx = sx, ly = sy;
    if (ly < 0) { lx = -sx; ly = -sy; }
    var L = MC.V3.norm([lx, Math.max(0.22, ly), 0.35]);
    this._sunDir = [-L[0], -L[1], -L[2]];
  };

  /* ------------------------------------------------------ targeting / mining */
  Game.prototype.updateTarget = function () {
    var eye = this.player.getEye();
    var dir = this.player.getLook();
    this.target = this.world.raycast(eye, dir, C.REACH, { includeLiquid: false });
  };

  /* ------------------------------------------------------- middle-mouse pick
   * README promises "Middle mouse - Pick the targeted block".  The button is
   * already tracked by MC.Input (buttons[1]); this turns the press EDGE into
   * one pick instead of one pick per frame. */
  Game.prototype.updatePick = function () {
    var down = !!this.input.buttons[1];
    var edge = down && !this._pickLatch;
    this._pickLatch = down;
    if (!edge || this.uiBlockingWorld()) return;
    this.pickTargetedBlock();
  };

  Game.prototype.pickTargetedBlock = function () {
    if (!this.target || !this.target.hit || !this.target.blockId) return false;
    var def = MC.block(this.target.blockId);
    var name = def && def.name;
    if (!name || !MC.item(name)) return false;
    var label = MC.item(name).label || name;

    if (this.mode === 'creative') {
      this.inventory.setSlot('hotbar', this.inventory.selected, { name: name, count: C.STACK_SIZE });
      this.ui.refreshHotbar();
      this.ui.toast('Picked ' + label, 900);
      return true;
    }
    /* Survival cannot conjure blocks out of the terrain: only jump to a slot
     * that already holds this item, otherwise the pick does nothing. */
    for (var i = 0; i < C.HOTBAR_SLOTS; i++) {
      var s = this.inventory.hotbar[i];
      if (s && s.name === name) {
        this.inventory.select(i);
        this.ui.refreshHotbar();
        this.ui.toast('Held: ' + label, 900);
        return true;
      }
    }
    return false;
  };

  /* A panel (inventory / creative palette / crafting) owns the mouse, so the
   * mining and placing loops must not run underneath it. */
  Game.prototype.uiBlockingWorld = function () {
    return !!(this.ui && (this.ui.isInventoryOpen() || this.ui.isCraftingOpen()));
  };

  Game.prototype.updateMining = function (dt) {
    var held = this.inventory.getSelectedName();
    if (!this.input.buttons[0] || this.paused || this.uiBlockingWorld() ||
        !this.target || !this.target.hit) {
      this.mining.key = null; this.mining.progress = 0;
      return;
    }
    var b = this.target.block;
    var key = b[0] + ',' + b[1] + ',' + b[2];
    var id = this.target.blockId;
    var block = MC.block(id);
    if (block.hardness < 0) {           /* unbreakable */
      this.mining.key = null; this.mining.progress = 0;
      return;
    }
    if (this.mining.key !== key) {
      this.mining.key = key;
      this.mining.progress = 0;
      this.mining.block = b.slice();
      this.mining.held = held;
      this.mining.total = this.mode === 'creative' ? 0.05 : MC.breakTime(id, held);
    } else if (held !== this.mining.held) {
      /* Swapping tools mid-break changes how long the rest takes; keeping the
       * old total would let a bare hand keep breaking at pickaxe speed. */
      this.mining.held = held;
      this.mining.total = this.mode === 'creative' ? 0.05 : MC.breakTime(id, held);
      if (this.mining.progress > this.mining.total) this.mining.progress = this.mining.total;
    }
    this.mining.progress += dt;
    if (this.frame % 6 === 0) this.particles.spawnHit(b[0], b[1], b[2], id);

    if (this.mining.progress >= this.mining.total) {
      this.breakBlock(b[0], b[1], b[2], id, held);
      this.mining.key = null;
      this.mining.progress = 0;
    }
  };

  Game.prototype.breakBlock = function (x, y, z, id, held) {
    var block = MC.block(id);
    this.particles.spawnBlockBreak(x, y, z, id, 14);
    this.world.setBlock(x, y, z, 0, 0);
    this.sim.scheduleBox(x - 1, y - 1, z - 1, x + 1, y + 1, z + 1);

    if (this.mode !== 'creative') {
      var drop = MC.breakYields(id, held);
      if (drop) this.spawnDrop(x, y, z, drop, 1);
    }
    /* water above or sand above may now fall */
    this.sim.schedule(x, y + 1, z);
    this.sim.schedule(x, y - 1, z);
    this.ui.syncHud(this.player, {});
  };

  /* --------------------------------------------------------------- placing */
  Game.prototype.updatePlacing = function (dt) {
    this.placeCooldown -= dt;
    if (!this.input.buttons[2] || this.paused || this.uiBlockingWorld()) return;
    if (this.placeCooldown > 0) return;
    if (!this.target || !this.target.hit) return;

    var held = this.inventory.getSelected();
    if (!held || !MC.isItemPlaceable(held.name)) return;

    var cell = this.target.adjacent;
    if (this.placeBlock(cell[0], cell[1], cell[2], held.name)) {
      this.placeCooldown = 0.18;
      if (this.mode !== 'creative') {
        this.inventory.takeSelected(1);
        this.ui.refreshHotbar();
      }
    } else {
      this.placeCooldown = 0.12;
    }
  };

  /* Placement rules:
   *  - target cell must be in bounds and replaceable (air or water)
   *  - the new block must CONNECT to something: at least one of its 6
   *    neighbours must already be a non-air block (initial-connection rule;
   *    blocks may be left floating / disconnected afterwards)
   *  - solid blocks may not overlap the player */
  Game.prototype.placeBlock = function (x, y, z, name) {
    if (!this.world.inBounds(x, y, z)) return false;
    if (!this.world.isReplaceableAt(x, y, z)) return false;
    var item = MC.item(name);
    var blockName = item && item.block ? item.block : name;
    var id = MC.blockIdByName(blockName);
    if (!id) return false;
    var def = MC.block(id);

    var connected = false;
    var dirs = MC.FACE_NORMALS;
    for (var i = 0; i < 6; i++) {
      if (this.world.getBlock(x + dirs[i][0], y + dirs[i][1], z + dirs[i][2]) !== 0) { connected = true; break; }
    }
    if (!connected) {
      this.ui.toast('Blocks must touch an existing block', 900);
      return false;
    }
    if (def.solid && MC.AABB.intersectsVoxel(this.player.getAABB(), x, y, z)) return false;

    this.world.setBlock(x, y, z, id, id === MC.WATER_ID ? 8 : 0);
    this.sim.scheduleBox(x - 1, y - 1, z - 1, x + 1, y + 1, z + 1);
    if (def.gravity) this.sim.settleColumn(x, y, z);
    this.particles.spawnHit(x, y, z, id);
    return true;
  };

  /* ------------------------------------------------------------- drops */
  Game.prototype.spawnDrop = function (x, y, z, name, count) {
    var id = MC.blockIdByName(name);
    var color = id ? MC.block(id).color : [0.9, 0.9, 0.9];
    this.drops.push({
      pos: [x + 0.5 + (Math.random() - 0.5) * 0.3, y + 0.45, z + 0.5 + (Math.random() - 0.5) * 0.3],
      vel: [(Math.random() - 0.5) * 1.6, 2.6 + Math.random() * 1.2, (Math.random() - 0.5) * 1.6],
      name: name, count: count, age: 0, color: color, picked: false
    });
    if (this.drops.length > 400) this.drops.shift();
  };

  Game.prototype.updateDrops = function (dt) {
    var p = this.player.position;
    for (var i = this.drops.length - 1; i >= 0; i--) {
      var d = this.drops[i];
      d.age += dt;
      var dx = p[0] - d.pos[0], dy = (p[1] + 0.9) - d.pos[1], dz = p[2] - d.pos[2];
      var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      if (dist < 2.4 && d.age > 0.45) {           /* magnet toward the player */
        var pull = 26 * dt;
        /* dist can be 0 when the drop sits exactly on the player: dividing by
         * it would poison the position with NaN and make it un-pickable. */
        if (dist > 1e-4) {
          d.vel[0] += (dx / dist) * pull;
          d.vel[1] += (dy / dist) * pull;
          d.vel[2] += (dz / dist) * pull;
        }
      }
      if (dist < 0.95 && d.age > 0.5) {
        var left = this.inventory.addItem(d.name, d.count);
        if (left === 0) { this.drops.splice(i, 1); this.ui.refreshHotbar(); this.ui.syncHud(this.player, {}); continue; }
        d.count = left;
      }

      d.vel[1] -= 17 * dt;
      if (d.vel[1] < -22) d.vel[1] = -22;
      var drag = Math.pow(0.06, dt);
      d.vel[0] *= drag; d.vel[2] *= drag;

      /* cheap voxel collision: axis by axis */
      for (var a = 0; a < 3; a++) {
        var nx = d.pos[0] + d.vel[0] * dt * (a === 0 ? 1 : 0);
        var ny = d.pos[1] + d.vel[1] * dt * (a === 1 ? 1 : 0);
        var nz = d.pos[2] + d.vel[2] * dt * (a === 2 ? 1 : 0);
        var bx = Math.floor(nx), by = Math.floor(ny), bz = Math.floor(nz);
        if (this.world.isSolidAt(bx, by, bz)) {
          if (a === 1) { d.vel[1] = d.vel[1] < 0 ? -d.vel[1] * 0.22 : 0; if (d.vel[1] < 0.4) d.vel[1] = 0; }
          else { d.vel[a] = -d.vel[a] * 0.3; }
        } else {
          d.pos[a] = d.pos[a] + d.vel[a] * dt;
        }
      }
      if (d.age > 90) this.drops.splice(i, 1);
    }
  };

  Game.prototype.dropOne = function () {
    var sel = this.inventory.getSelected();
    if (!sel) return;
    var eye = this.player.getEye(), dir = this.player.getLook();
    this.spawnDrop(Math.floor(eye[0] + dir[0]), Math.floor(eye[1]), Math.floor(eye[2] + dir[2]), sel.name, 1);
    if (this.mode !== 'creative') { this.inventory.takeSelected(1); this.ui.refreshHotbar(); }
  };

  Game.prototype.cycleTool = function () {
    for (var i = 0; i < C.HOTBAR_SLOTS; i++) {
      var s = this.inventory.hotbar[i];
      if (s && MC.item(s.name) && MC.item(s.name).kind === 'tool') {
        this.inventory.select(i); this.ui.refreshHotbar();
        this.ui.toast('Held: ' + MC.item(s.name).label, 900);
        return;
      }
    }
    this.ui.toast('No tools in the hotbar', 900);
  };

  /* ------------------------------------------------------------- meshes */
  Game.prototype.buildChunk = function (key) {
    var parts = key.split(',');
    var cx = +parts[0], cz = +parts[1];
    if (!this.world.chunkAt(cx, cz)) return;
    var mesh = MC.Mesher.build(this.world, cx, cz);
    this.renderer.updateChunk(key, mesh);
    this.meshedChunks.add(key);
  };

  Game.prototype.processMeshQueue = function () {
    var keys = this.world.takeDirty();
    for (var i = 0; i < keys.length; i++) this.meshQueue.add(keys[i]);
    if (!this.meshQueue.size) return;

    var px = this.player.position[0], pz = this.player.position[2];
    var best = null, bestD = Infinity;
    var budget = Math.max(1, Math.min(this.meshBudget, 12));
    var done = 0;
    while (done < budget && this.meshQueue.size) {
      best = null; bestD = Infinity;
      this.meshQueue.forEach(function (k) {
        var pp = k.split(',');
        var dx = (+pp[0]) * 16 + 8 - px, dz = (+pp[1]) * 16 + 8 - pz;
        var d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = k; }
      });
      if (best === null) break;
      this.meshQueue.delete(best);
      this.buildChunk(best);
      done++;
    }
  };

  /* --------------------------------------------------------------- draw */
  Game.prototype.draw = function () {
    var eye = this.player.getEye();
    var bob = this.player.bobPhase || 0;
    /* Item entities are rebuilt every frame (they spin and bob), so this uses
     * snapshot=false: the renderer uploads the mesh synchronously inside
     * render(), so a live view into the mesher's scratch is safe and keeps the
     * hot path free of per-frame typed-array allocation. */
    var itemList = this.drops.length ? this.renderItems() : null;
    var itemMesh = (itemList && itemList.length)
      ? MC.Mesher.buildItems(itemList, this.world, false) : null;
    var state = {
      camera: {
        position: [eye[0], eye[1] + Math.sin(bob) * 0.045, eye[2]],
        yaw: this.player.yaw,
        pitch: this.player.pitch,
        fov: this.player.targetFov || C.FOV
      },
      world: this.world,
      timeOfDay: this.time,
      sunDir: this._sunDir,
      highlight: (this.target && this.target.hit && !this.paused)
        ? { block: this.target.block, progress: this.mining.total ? MC.Util.clamp(this.mining.progress / this.mining.total, 0, 1) : 0 }
        : null,
      particles: this.renderParticles(),
      items: itemMesh,
      underwater: !!this.player.headInWater,
      fogStart: this.player.headInWater ? 0.5 : C.FOG_START,
      fogEnd: this.player.headInWater ? 22 : C.FOG_END
    };
    this.renderer.render(state);
  };

  Game.prototype.renderParticles = function () {
    var out = this._scratchParticles;
    out.length = 0;
    var list = this.particles.list();
    for (var i = 0; i < list.length; i++) out.push(list[i]);
    /* Block drops draw as textured cubes (renderItems). A tool or material has
     * no block tile to texture a cube with, so it keeps the point sprite --
     * otherwise pressing Q on a pickaxe would drop something invisible. */
    var sprites = this._scratchDropSprites;
    for (var j = 0; j < this.drops.length; j++) {
      var d = this.drops[j];
      if (MC.blockIdByName(d.name)) continue;
      var sp = sprites[j];
      if (!sp) sp = sprites[j] = { pos: [0, 0, 0], color: [0.9, 0.9, 0.9], size: 0.34 };
      sp.pos[0] = d.pos[0];
      sp.pos[1] = this.dropDrawY(d);
      sp.pos[2] = d.pos[2];
      sp.color[0] = d.color[0]; sp.color[1] = d.color[1]; sp.color[2] = d.color[2];
      sp.size = 0.34 + Math.sin(d.age * 4) * 0.03;
      out.push(sp);
    }
    return out;
  };

  /* Shared hover + bob, so a cube and a fallback sprite float identically.
   * Only the DRAWN y moves: physics and pickup keep reading d.pos. */
  Game.prototype.dropDrawY = function (d) {
    return d.pos[1] + C.DROP_ITEM_FLOAT +
      Math.sin(d.age * C.DROP_BOB_SPEED) * C.DROP_BOB_AMP;
  };

  /* A mined block drops as a mini textured cube that hovers above the ground
   * and bobs (MC item-entity style). Entries are pooled and reused. */
  Game.prototype.renderItems = function () {
    var out = this._scratchItems;
    var n = 0;
    for (var i = 0; i < this.drops.length; i++) {
      var d = this.drops[i];
      var bid = MC.blockIdByName(d.name);
      if (!bid) continue;            /* no block tile: renderParticles covers it */
      var e = out[n];
      if (!e) e = out[n] = { pos: [0, 0, 0], size: 0, spin: 0, blockId: 0 };
      e.pos[0] = d.pos[0];
      e.pos[1] = this.dropDrawY(d);
      e.pos[2] = d.pos[2];
      /* pop-in: grows to full size 1/DROP_POP_RATE seconds after the break */
      e.size = C.DROP_ITEM_SIZE * Math.min(1, d.age * C.DROP_POP_RATE);
      e.spin = d.age * C.DROP_SPIN_SPEED;
      e.blockId = bid;
      n++;
    }
    out.length = n;
    return out;
  };

  /* ------------------------------------------------------------- pause */
  Game.prototype.togglePause = function () {
    if (!this.running) return;
    this.paused = !this.paused;
    if (this.paused) {
      this.input.exitLock();
      this.ui.showMenu();
      this.ui.setMenuNote(this.save.available() ? '' : 'Browser storage is blocked here - use Export / Import to keep your world.');
    } else {
      this.ui.hideMenu();
      this.last = root.performance.now();
      this.input.requestLock();
    }
  };

  Game.prototype.onDeath = function () {
    if (this._dying) return;
    this._dying = true;
    var self = this;
    this.ui.toast('You died. Respawning...', 1600);
    root.setTimeout(function () {
      self.player.respawn();
      self._dying = false;
    }, 1200);
  };

  /* -------------------------------------------------------------- save */
  Game.prototype.doSave = function () {
    var res = this.save.save(this.world, this.player, this.inventory, {
      seed: this.seed, mode: this.mode, timeOfDay: this.time
    });
    if (res && res.ok) this.ui.toast('World saved (' + Math.round(res.bytes / 1024) + ' KB)', 1500);
    else this.ui.toast('Browser save failed: ' + ((res && res.error) || 'unknown') + ' - use Export', 2600);
  };

  Game.prototype.doLoad = function () {
    var res = this.save.load();
    if (!res || !res.ok) { this.ui.toast('No saved world found', 1500); return; }
    this.loadPayload(res.data);
  };

  Game.prototype.loadPayload = function (data) {
    if (!data || !data.world) { this.ui.toast('Save file is not a Voxelcraft world', 2000); return; }
    this.startWorld(data.meta && data.meta.seed !== undefined ? data.meta.seed : this.seed,
      (data.meta && data.meta.mode) || this.mode, data);
    this.ui.toast('World loaded', 1500);
  };

  /* Only finite numbers may reach the player: a hand-edited or truncated save
   * would otherwise put NaN in the camera and freeze the frame. */
  function num(v, d) {
    if (typeof v !== 'number') return d;
    return v > -Infinity && v < Infinity ? v : d;
  }

  Game.prototype.applyPlayerSave = function (p) {
    p = p || {};
    var pos = p.position;
    var ok = Array.isArray(pos) && pos.length >= 3 &&
      num(pos[0], null) !== null && num(pos[1], null) !== null && num(pos[2], null) !== null;
    var spawn = ok ? [num(pos[0], 0), num(pos[1], 0), num(pos[2], 0)]
                   : this.world.findSpawn((this.world.sizeX / 2) | 0, (this.world.sizeZ / 2) | 0);
    this.player = new MC.Player(this.world, { spawn: spawn });
    this.player.position = spawn.slice();
    this.player.yaw = num(p.yaw, 0);
    this.player.pitch = MC.Util.clamp(num(p.pitch, 0), -C.PITCH_CLAMP, C.PITCH_CLAMP);
    this.player.health = MC.Util.clamp(num(p.health, C.MAX_HEALTH), 1, C.MAX_HEALTH);
    this.player.air = MC.Util.clamp(num(p.air, C.MAX_AIR), 0, C.MAX_AIR);
    this.player.flying = !!p.flying;
  };

  Game.prototype.doExport = function () {
    var self = this;
    this.save.exportFile(this.world, this.player, this.inventory, {
      seed: this.seed, mode: this.mode, timeOfDay: this.time
    }, function (ok, err) {
      if (ok) self.ui.toast('Exported voxelcraft-save.json', 1600);
      else self.ui.toast('Export failed: ' + err, 2200);
    });
  };

  Game.prototype.doImport = function (data) { this.loadPayload(data); };

  Game.prototype.doCraft = function (recipe) {
    /* inventory.craft() consumes the inputs AND adds the output. */
    if (!this.inventory.craft(recipe)) {
      this.ui.toast(this.inventory.canCraft(recipe)
        ? 'No room in the inventory for the output'
        : 'Not enough materials', 1400);
      return;
    }
    this.ui.refreshInventory();
    this.ui.refreshHotbar();
    this.ui.toast('Crafted ' + recipe.out[1] + 'x ' + (MC.item(recipe.out[0]) ? MC.item(recipe.out[0]).label : recipe.out[0]), 1200);
  };

  /* -------------------------------------------------------------- debug */
  Game.prototype.updateDebug = function () {
    var p = this.player;
    var stats = this.renderer.stats || {};
    var g = this.debugStats(root.performance.now());
    var lines = [
      'Voxelcraft ' + MC.VERSION + '  ' + this.mode,
      'fps ' + this.fps.toFixed(0) + '   draw ' + (stats.drawCalls || 0) + '   chunks ' + (stats.chunksDrawn || 0),
      'xyz ' + p.position[0].toFixed(2) + ' ' + p.position[1].toFixed(2) + ' ' + p.position[2].toFixed(2),
      'chunk ' + (Math.floor(p.position[0] / 16)) + ',' + (Math.floor(p.position[2] / 16)) +
        '   ground ' + p.onGround + '   fly ' + p.flying,
      'time ' + (this.time * 24).toFixed(1) + 'h   health ' + p.health + '   air ' + p.air,
      'mesh queue ' + this.meshQueue.size + '   sim pending ' + (this.sim.pending ? this.sim.pending() : 0) +
        '   drops ' + this.drops.length + '   particles ' + this.particles.count(),
      'target ' + (this.target && this.target.hit ? this.target.block.join(',') + ' ' + MC.block(this.target.blockId).name : 'none'),
      'seed ' + this.seed
    ];
    if (g) lines.push('blocks solid ' + g.solid + '  air ' + g.air + '  water ' + g.liquid);
    this.ui.debug(lines);
  };

  MC.Game = Game;

  function start() {
    var g = new MC.Game();
    MC.game = g;
    try { g.boot(); }
    catch (e) {
      var el = doc.getElementById('menu-note');
      if (el) el.textContent = 'Startup error: ' + (e && e.message ? e.message : e);
      var m = doc.getElementById('menu');
      if (m) m.classList.remove('hidden');
      var l = doc.getElementById('loading');
      if (l) l.classList.add('hidden');
      throw e;
    }
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
  else start();
})(typeof window !== 'undefined' ? window : globalThis);
