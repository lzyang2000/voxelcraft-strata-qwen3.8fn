/* Screenshot harness (inlined into tools/shot.html by tools/make-shot.js).
 *
 * Headless Chrome's --virtual-time-budget does not reliably advance rAF, and
 * the game's own warmUpMeshes() meshes 8 chunks per frame behind a loading
 * overlay. A screenshot taken mid-warm-up therefore captures the loading bar
 * instead of the world. So this harness replaces warmUpMeshes with a
 * synchronous version BEFORE the game reaches it, waits for the game to be
 * fully playing, then drives frameTick() by hand.
 *   ?view=fp        first person at spawn (default)
 *   ?view=overhead  raised flying camera looking down
 *   ?view=far       raised camera at a shallow angle
 *   ?view=water     teleport to the nearest generated water column
 *   ?quiet=1        hide the JSON <pre> so the PNG is just the canvas
 */
(function () {
  'use strict';
  var q = {};
  location.search.replace(/[?&]([^=&]+)=([^&]*)/g, function (_, k, v) { q[k] = decodeURIComponent(v); });
  var view = q.view || 'fp';
  var tries = 0;
  function finish(msg) { document.title = 'SHOT_DONE ' + msg; }

  /* ?seed=123&mode=creative makes the shot reproducible run to run */
  if (q.seed && window.MC && MC.game) {
    var el = document.getElementById('seed');
    if (el) el.value = q.seed;
    MC.game.startWorld(q.seed, q.mode || 'survival');
  }

  /* Deterministic, synchronous warm-up: no overlay, no rAF dependency. */
  MC.Game.prototype.warmUpMeshes = function () {
    var keys = this.world.takeDirty();
    for (var i = 0; i < keys.length; i++) this.buildChunk(keys[i]);
    this._shotWarm = keys.length;
    this.beginPlay();
  };

  var iv = setInterval(function () {
    tries++;
    var g = window.MC && window.MC.game;
    if (!g || !g.world || !g.player) {
      if (tries > 900) finish('timeout-waiting-for-world');
      return;
    }
    if (!g.running) { if (tries > 900) finish('timeout-not-running'); return; }
    clearInterval(iv);
    var out = document.getElementById('out');
    if (q.quiet) out.style.display = 'none';
    var auditGlow = null;
    var demoAudit = null;
    try {
      var p = g.player, w = g.world;
      var bx = Math.floor(p.position[0]), by = Math.floor(p.position[1]), bz = Math.floor(p.position[2]);
      var col = [];
      for (var y = 0; y < w.sizeY; y++) {
        var id = w.getBlock(bx, y, bz);
        col.push(id === 0 ? '.' : (id < 10 ? String(id) : String(id).slice(-2)));
      }

      /* camera presets (flying so physics cannot move the shot) */
      var ground = w.heightAt(bx, bz);
      if (view === 'fp') { p.pitch = -0.28; p.yaw = 0.7; }
      if (view === 'overhead') { p.flying = true; p.position[1] = Math.min(w.sizeY - 2, ground + 26); p.pitch = -1.15; p.yaw = 0.7; }
      if (view === 'far') {
        /* frame the whole world: pull back to a corner and look at the middle */
        var cx = w.sizeX * 0.5, cz = w.sizeZ * 0.5;
        p.flying = true;
        p.position = [w.sizeX - 6, ground + 34, w.sizeZ - 6];
        var dx = cx - p.position[0], dz = cz - p.position[2];
        p.yaw = Math.atan2(-dx, -dz);
        p.pitch = -Math.atan2(p.position[1] - (ground + 4), Math.sqrt(dx * dx + dz * dz));
      }
      var shotTime = 0.34;
      if (view === 'night') {
        /* midnight + two glowstones: checks the sun disc is day-gated and that
         * block light lights the terrain without blowing it out to white.
         * timeOfDay: 0.25 sunrise, 0.5 noon, 0.75 sunset, 0.0 midnight. */
        shotTime = 0.02;
        p.pitch = -0.16; p.yaw = 0.7;
        /* three glowstones a few blocks ahead, so the light pool is in frame */
        var gy = ground + 1;
        var fx = Math.round(bx - Math.sin(p.yaw) * 5);
        var fz = Math.round(bz - Math.cos(p.yaw) * 5);
        for (var gi = -2; gi <= 2; gi += 2) {
          w.setBlock(fx + gi, gy, fz, MC.blockIdByName('glowstone'));
        }
        auditGlow = [fx, gy, fz];
      }
      /* aim helper: yaw/pitch that point the eye at (tx,ty,tz) */
      function aimAt(tx, ty, tz) {
        var adx = tx - p.position[0], ady = ty - p.position[1] - MC.C.EYE_HEIGHT,
          adz = tz - p.position[2];
        p.yaw = Math.atan2(-adx, -adz);
        p.pitch = -Math.atan2(-ady, Math.sqrt(adx * adx + adz * adz));
      }
      if (view === 'water') {
        /* A built demo of the two falling-block rules. The game schedules the
         * automaton from placeBlock(); a direct setBlock only marks chunks and
         * light dirty, so the demo has to schedule the same work by hand.
         *   - a water source one block above a stone deck: it lands, spreads
         *     sideways into a puddle and cascades off the deck edge
         *   - a sand stack over a trench cut in the deck: it falls and slides
         *     diagonally off the ledge
         * The automaton runs at 12 ticks/s, so the shot pre-rolls 60 frames
         * (5 s => ~60 ticks) before the camera is framed on the result. */
        var g0 = w.heightAt(bx, bz), x0 = bx - 5, z0 = bz - 5, i, j, k;
        for (i = 0; i <= 10; i++) for (j = 0; j <= 10; j++) {
          if (i >= 4 && i <= 6 && j >= 8) continue;      /* trench in the deck */
          w.setBlock(x0 + i, g0 + 1, z0 + j, MC.blockIdByName('stone'));
        }
        w.setBlock(x0 + 2, g0 + 2, z0 + 2, MC.blockIdByName('water'), 8);
        for (k = 2; k <= 4; k++) {
          w.setBlock(x0 + 5, g0 + k, z0 + 8, MC.blockIdByName('sand'));
          w.setBlock(x0 + 6, g0 + k, z0 + 8, MC.blockIdByName('sand'));
        }
        var box = [x0 - 1, g0 - 1, z0 - 1, x0 + 11, g0 + 8, z0 + 11];
        g.sim.scheduleBox(box[0], box[1], box[2], box[3], box[4], box[5]);
        for (k = 2; k <= 4; k++) {
          g.sim.settleColumn(x0 + 5, g0 + k, z0 + 8);
          g.sim.settleColumn(x0 + 6, g0 + k, z0 + 8);
        }
        var before = boxCensus(w, box);
        p.flying = true;
        p.position = [bx + 0.5, g0 + 14, bz + 14.5];   /* keep the demo in SIM_RADIUS */
        var t0 = g.last;
        for (var pf = 1; pf <= 60; pf++) g.frameTick(t0 + pf * 16.7);
        demoAudit = {
          box: box, before: before, after: boxCensus(w, box),
          simPending: g.sim.pending(), simTicks: g.sim.tickCount
        };
        /* frame the camera on the whole demo: the puddle AND the sand that
         * fell into the trench have to be in the same shot */
        var spot = topFluidInBox(w, box);
        p.position = [x0 + 13.5, g0 + 10, z0 + 13.5];
        aimAt(x0 + 5.5, g0 + 1.5, z0 + 5.5);
        view = 'water@' + (spot ? spot.join(',') : 'none');
      }

      g.time = shotTime;
      var t = g.last;
      for (var f = 1; f <= 90; f++) g.frameTick(t + f * 16.7);

      var gl = g.renderer.gl, errs = [], guard = 0, e;
      while (guard++ < 25) { e = gl.getError(); if (!e) break; errs.push(e); }

      var eye = p.getEye(), look = p.getLook();
      var ray = [];
      for (var d = 0; d <= 6; d++) {
        var rx = Math.floor(eye[0] + look[0] * d), ry = Math.floor(eye[1] + look[1] * d), rz = Math.floor(eye[2] + look[2] * d);
        var rid = w.getBlock(rx, ry, rz);
        ray.push(d + ':' + rid + (MC.block(rid) ? '(' + MC.block(rid).name + ')' : ''));
      }

      var px = new Uint8Array(4), W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
      function sample(fx, fy) {
        gl.readPixels(Math.floor(fx * W), Math.floor(fy * H), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return px[0] + ',' + px[1] + ',' + px[2];
      }
      var grid = {}, nonSky = 0;
      for (var iy = 0; iy < 8; iy++) {
        for (var ix = 0; ix < 8; ix++) {
          var s = sample((ix + 0.5) / 8, (iy + 0.5) / 8);
          grid[(ix) + ',' + iy] = s;
          var c = s.split(',');
          if (+c[2] - +c[0] < 40) nonSky++;   /* bluish = sky, else geometry */
        }
      }

      /* light audit across EVERY chunk mesh, not just the player's */
      var audit = { chunks: 0, opaqueVerts: 0, badLightValues: 0, badWhere: [], sMin: 9, sMax: -9, bMin: 9, bMax: -9 };
      for (var cz = 0; cz < MC.C.WORLD_CZ; cz++) {
        for (var cx = 0; cx < MC.C.WORLD_CX; cx++) {
          var mm = MC.Mesher.build(w, cx, cz);
          var vv = mm.opaque.vertices;
          audit.chunks++;
          for (var q2 = 0; q2 < vv.length / 7; q2++) {
            /* aLight = sky[0.02,1] + raw block level (0..15) * 16 */
            var L = vv[q2 * 7 + 5], bc = Math.floor(L / 16), sc = L - bc * 16;
            audit.opaqueVerts++;
            if (!(bc >= 0 && bc <= 15) || !(sc >= 0 && sc <= 1.001)) {
              audit.badLightValues++;
              if (audit.badWhere.length < 4) audit.badWhere.push([cx, cz, q2, L, vv[q2 * 7 + 6]]);
              continue;
            }
            if (sc < audit.sMin) audit.sMin = sc; if (sc > audit.sMax) audit.sMax = sc;
            if (bc < audit.bMin) audit.bMin = bc; if (bc > audit.bMax) audit.bMax = bc;
          }
        }
      }
      audit.skyChannel = [+(audit.sMin.toFixed(3)), +(audit.sMax.toFixed(3))];
      audit.blkChannel = [+(audit.bMin.toFixed(3)), +(audit.bMax.toFixed(3))];
      audit.skyAtEye = w.skyAt(Math.floor(eye[0]), Math.floor(eye[1]), Math.floor(eye[2]));
      audit.heightAtPlayer = w.heightAt(bx, bz);

      var camCol = [];
      {
        var cbx = Math.floor(p.position[0]), cbz = Math.floor(p.position[2]);
        for (var yy = 0; yy < w.sizeY; yy++) {
          var cid = w.getBlock(cbx, yy, cbz);
          camCol.push(cid === 0 ? '.' : (cid < 10 ? String(cid) : String(cid).slice(-2)));
        }
      }
      var base = {
        view: view,
        glowStones: auditGlow,
        fluidDemo: demoAudit,
        timeOfDay: +g.time.toFixed(3),
        warmChunks: g._shotWarm,
        lightAudit: audit,
        meshedChunks: g.meshedChunks.size,
        rendererStats: g.renderer.stats,
        glErrors: errs,
        contextLost: gl.isContextLost(),
        drawingBuffer: [W, H],
        geometryCells: nonSky + '/64',
        player: p.position.map(function (v) { return +v.toFixed(2); }),
        eye: eye.map(function (v) { return +v.toFixed(2); }),
        look: look.map(function (v) { return +v.toFixed(2); }),
        onGround: p.onGround,
        heightAtPlayer: w.heightAt(bx, bz),
        columnAtPlayer: col.join(''),
        columnUnderCamera: camCol.join(''),
        heightUnderCamera: w.heightAt(Math.floor(p.position[0]), Math.floor(p.position[2])),
        rayAhead: ray,
        framebufferGrid: grid
      };
      function dump() {
        /* refresh the live bits so a late re-dump shows the state the game's
         * own rAF loop ended up in, not just the harness's manual frames */
        var e2 = p.getEye(), l2 = p.getLook();
        base.livePlayer = p.position.map(function (v) { return +v.toFixed(2); });
        base.liveEye = e2.map(function (v) { return +v.toFixed(2); });
        base.liveLook = l2.map(function (v) { return +v.toFixed(2); });
        base.liveFlying = !!p.flying;
        base.liveOnGround = !!p.onGround;
        base.liveTime = +g.time.toFixed(3);
        base.liveStats = g.renderer.stats;
        out.textContent = JSON.stringify(base, null, 1);
      }
      dump();
      setInterval(dump, 250);
      finish('ok ' + view);
    } catch (err) {
      out.textContent = 'SHOT_ERROR ' + (err && err.stack ? err.stack : err);
      finish('error');
    }
  }, 20);

  /* census of the fluid/gravity demo region: proves the automaton ran */
  function boxCensus(w, b) {
    var water = 0, sand = 0, sandTop = -1, sandBottom = -1, waterTop = -1, levels = {};
    for (var y = b[1]; y <= b[4]; y++) {
      for (var z = b[2]; z <= b[5]; z++) {
        for (var x = b[0]; x <= b[3]; x++) {
          var id = w.getBlock(x, y, z);
          if (id === MC.WATER_ID) {
            water++;
            if (waterTop < 0) waterTop = y;
            var m = w.getMeta(x, y, z);
            levels[m] = (levels[m] || 0) + 1;
          } else if (MC.isGravityBlock(id)) {
            sand++;
            if (sandTop < 0) sandTop = y;
            sandBottom = y;
          }
        }
      }
    }
    return { water: water, waterTopY: waterTop, waterLevels: levels,
      sand: sand, sandTopY: sandTop, sandBottomY: sandBottom };
  }
  /* topmost fluid cell inside a box, scanning high to low */
  function topFluidInBox(w, b) {
    for (var y = b[4]; y >= b[1]; y--)
      for (var z = b[2]; z <= b[5]; z++)
        for (var x = b[0]; x <= b[3]; x++) {
          var id = w.getBlock(x, y, z);
          if (id && MC.isLiquidBlock(id)) return [x, y, z];
        }
    return null;
  }

})();
