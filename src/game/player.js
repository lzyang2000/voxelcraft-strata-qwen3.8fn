/* Player: look, AABB voxel physics, swimming, flying, fall/drown damage.
 * Contract: MC.Player.  Reads the world, never writes it. */
(function (root) {
  'use strict';
  var MC = (root.MC = root.MC || {});
  var C = MC.C;

  var MAX_SUBSTEP = 0.4;      /* never move further than this per axis per step */
  var WATER_RISE = 4.0;       /* max swim-up speed */
  var WATER_SINK = 3.2;       /* max passive sink speed */
  var AIR_GRACE = 3.0;        /* seconds before the air bar starts draining */
  var AIR_DRAIN = 1;          /* air units per second once the grace is over */
  var DROWN_TICK = 1.0;
  var DROWN_DAMAGE = 2;
  var AIR_REFILL = 1.5;       /* seconds to refill the whole air bar */

  function Player(world, opts) {
    opts = opts || {};
    this.world = world;
    var sp = opts.spawn || [8.5, 32, 8.5];
    this.spawn = [sp[0], sp[1], sp[2]];
    this.position = [sp[0], sp[1], sp[2]];   /* feet centre */
    this.velocity = [0, 0, 0];
    this.yaw = opts.yaw || 0;
    this.pitch = opts.pitch || 0;

    this.maxHealth = opts.maxHealth || C.MAX_HEALTH;
    this.health = this.maxHealth;
    this.maxAir = C.MAX_AIR;
    this.air = this.maxAir;
    this.alive = true;

    this.onGround = false;
    this.flying = false;
    this.sneaking = false;
    this.sprinting = false;
    this.inWater = false;
    this.headInWater = false;
    this.fallDistance = 0;
    this.bobPhase = 0;

    this.events = { onDamage: null, onDeath: null, onLand: null };

    this._hw = C.PLAYER_WIDTH / 2;
    this._h = C.PLAYER_HEIGHT;
    this._eye = C.EYE_HEIGHT;
    /* A voxel is 1.0 tall, so a literal STEP_HEIGHT (0.55) can never clear a
     * one-block ledge. The auto-step cap is therefore at least one block. */
    this.maxStep = Math.max(C.STEP_HEIGHT, 1.0);
    this._airGrace = 0;
    this._drown = 0;
    this._hurtFlash = 0;
  }

  /* ------------------------------------------------------------- geometry */
  Player.prototype.getAABB = function () {
    var p = this.position;
    return {
      min: [p[0] - this._hw, p[1], p[2] - this._hw],
      max: [p[0] + this._hw, p[1] + this._h, p[2] + this._hw]
    };
  };

  Player.prototype._boxAt = function (axis, coord, feet) {
    var p = this.position;
    var x = axis === 0 ? coord : p[0];
    var z = axis === 2 ? coord : p[2];
    return {
      min: [x - this._hw, feet, z - this._hw],
      max: [x + this._hw, feet + this._h, z + this._hw]
    };
  };

  Player.prototype.getEye = function () {
    var p = this.position;
    return [p[0], p[1] + this._eye, p[2]];
  };

  Player.prototype.getLook = function () {
    /* matches MC.M4.view: forward = -(sy*cp, -sp, cy*cp) */
    var cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    var cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    return [-sy * cp, sp, -cy * cp];
  };

  /* ------------------------------------------------------- world queries */
  Player.prototype._boxSolid = function (box) {
    var w = this.world;
    var x0 = Math.floor(box.min[0]), y0 = Math.floor(box.min[1]), z0 = Math.floor(box.min[2]);
    var x1 = Math.floor(box.max[0]), y1 = Math.floor(box.max[1]), z1 = Math.floor(box.max[2]);
    for (var y = y0; y <= y1; y++) {
      for (var z = z0; z <= z1; z++) {
        for (var x = x0; x <= x1; x++) {
          if (w.isSolidAt(x, y, z) && MC.AABB.intersectsVoxel(box, x, y, z)) return true;
        }
      }
    }
    return false;
  };

  Player.prototype._sampleWater = function () {
    var w = this.world, p = this.position;
    var ix = Math.floor(p[0]), iz = Math.floor(p[2]);
    this.headInWater = w.isLiquidAt(ix, Math.floor(p[1] + this._eye), iz);
    this.inWater = w.isLiquidAt(ix, Math.floor(p[1] + 0.05), iz) ||
      w.isLiquidAt(ix, Math.floor(p[1] + 0.4), iz) ||
      w.isLiquidAt(ix, Math.floor(p[1] + this._h * 0.5), iz);
  };

  /* Solid ground anywhere under the footprint (used for ground + sneak edges). */
  Player.prototype._hasSupport = function (box) {
    var w = this.world;
    var y = Math.floor(box.min[1] - 0.05);
    var x0 = Math.floor(box.min[0] + 1e-6), x1 = Math.floor(box.max[0] - 1e-6);
    var z0 = Math.floor(box.min[2] + 1e-6), z1 = Math.floor(box.max[2] - 1e-6);
    for (var z = z0; z <= z1; z++) {
      for (var x = x0; x <= x1; x++) {
        if (w.isSolidAt(x, y, z)) return true;
      }
    }
    return false;
  };

  /* ------------------------------------------------------ axis resolution */
  /* Move one axis, then push out of every solid voxel that now overlaps. */
  Player.prototype._moveAxis = function (axis, delta) {
    if (delta === 0) return false;
    var p = this.position, w = this.world;
    p[axis] += delta;
    var box = this.getAABB();
    var x0 = Math.floor(box.min[0]), y0 = Math.floor(box.min[1]), z0 = Math.floor(box.min[2]);
    var x1 = Math.floor(box.max[0]), y1 = Math.floor(box.max[1]), z1 = Math.floor(box.max[2]);
    var hit = false, bound = null;
    for (var y = y0; y <= y1; y++) {
      for (var z = z0; z <= z1; z++) {
        for (var x = x0; x <= x1; x++) {
          if (!w.isSolidAt(x, y, z)) continue;
          if (!MC.AABB.intersectsVoxel(box, x, y, z)) continue;
          hit = true;
          var b;
          if (axis === 0) b = delta > 0 ? x - this._hw : x + 1 + this._hw;
          else if (axis === 1) b = delta > 0 ? y - this._h : y + 1;
          else b = delta > 0 ? z - this._hw : z + 1 + this._hw;
          if (bound === null || (delta > 0 ? b < bound : b > bound)) bound = b;
        }
      }
    }
    if (hit) {
      p[axis] = bound;
      this.velocity[axis] = 0;
      if (axis === 1 && delta < 0) this.onGround = true;
    }
    return hit;
  };

  /* Auto-step: a blocked horizontal move becomes a climb when the ledge is
   * short enough and the space above it is clear at foot *and* head height. */
  Player.prototype._tryStepUp = function (axis, start, delta) {
    if (!this.onGround || this.flying || this.sneaking) return false;
    var feet = this.position[1];
    var target = start + delta;
    var probe = this._boxAt(axis, target, feet);
    var w = this.world;
    var x0 = Math.floor(probe.min[0]), x1 = Math.floor(probe.max[0]);
    var y0 = Math.floor(probe.min[1]), y1 = Math.floor(probe.max[1]);
    var z0 = Math.floor(probe.min[2]), z1 = Math.floor(probe.max[2]);
    var top = null;
    for (var y = y0; y <= y1; y++) {
      for (var z = z0; z <= z1; z++) {
        for (var x = x0; x <= x1; x++) {
          if (!w.isSolidAt(x, y, z)) continue;
          if (!MC.AABB.intersectsVoxel(probe, x, y, z)) continue;
          var t = y + 1;
          if (t > feet + 1e-6 && t - feet <= this.maxStep + 1e-6) {
            if (top === null || t > top) top = t;
          }
        }
      }
    }
    if (top === null) return false;
    if (this._boxSolid(this._boxAt(axis, target, top))) return false;
    this.position[1] = top;
    this.position[axis] = target;
    return true;
  };

  Player.prototype._moveHorizontal = function (axis, delta) {
    if (delta === 0) return false;
    if (this.sneaking && this.onGround && !this.flying) {
      var nb = this._boxAt(axis, this.position[axis] + delta, this.position[1]);
      if (!this._hasSupport(nb)) { this.velocity[axis] = 0; return false; }
    }
    var start = this.position[axis];
    var blocked = this._moveAxis(axis, delta);
    if (blocked) this._tryStepUp(axis, start, delta);
    return blocked;
  };

  /* Optional helper: hop up onto a ledge directly under the player. */
  Player.prototype.stepUp = function () {
    var feet = this.position[1];
    var top = Math.floor(feet + 1e-6) + 1;
    if (top - feet > this.maxStep + 1e-6) return false;
    if (this._boxSolid(this._boxAt(-1, this.position[0], top))) return false;
    this.position[1] = top;
    return true;
  };

  /* ------------------------------------------------------------- damage */
  Player.prototype.applyDamage = function (n, cause) {
    if (!this.alive || !(n > 0)) return 0;
    this.health -= n;
    this._hurtFlash = 0.4;
    if (typeof this.events.onDamage === 'function') this.events.onDamage(n, cause || '', this);
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      this.velocity[0] = this.velocity[1] = this.velocity[2] = 0;
      this.flying = false;
      if (typeof this.events.onDeath === 'function') this.events.onDeath(cause || '', this);
    }
    return n;
  };

  Player.prototype.heal = function (n) {
    if (!this.alive || !(n > 0)) return 0;
    var before = this.health;
    this.health = Math.min(this.maxHealth, this.health + n);
    return this.health - before;
  };

  Player.prototype.respawn = function () {
    var sp = this.spawn;
    if (this.world && typeof this.world.findSpawn === 'function') {
      var found = this.world.findSpawn(Math.floor(sp[0]), Math.floor(sp[2]));
      if (found) sp = found;
    }
    this.position[0] = sp[0]; this.position[1] = sp[1]; this.position[2] = sp[2];
    this.velocity[0] = this.velocity[1] = this.velocity[2] = 0;
    this.health = this.maxHealth;
    this.air = this.maxAir;
    this.alive = true;
    this.onGround = false;
    this.flying = false;
    this.fallDistance = 0;
    this.bobPhase = 0;
    this._airGrace = 0;
    this._drown = 0;
  };

  Player.prototype.toggleFly = function () {
    this.flying = !this.flying;
    if (this.flying) {
      this.velocity[1] = 0;
      this.fallDistance = 0;
      this.sneaking = false;
    }
    return this.flying;
  };

  /* ---------------------------------------------------------- simulation */
  Player.prototype._breath = function (dt) {
    if (this.headInWater) {
      this._airGrace += dt;
      if (this._airGrace >= AIR_GRACE) {
        this.air -= AIR_DRAIN * dt;
        if (this.air <= 0) {
          this.air = 0;
          this._drown += dt;
          while (this._drown >= DROWN_TICK && this.alive) {
            this._drown -= DROWN_TICK;
            this.applyDamage(DROWN_DAMAGE, 'drown');
          }
        }
      }
    } else {
      this._airGrace = 0;
      this._drown = 0;
      if (this.air < this.maxAir) {
        this.air += (this.maxAir / AIR_REFILL) * dt;
        if (this.air > this.maxAir) this.air = this.maxAir;
      }
    }
  };

  Player.prototype._land = function () {
    var d = this.fallDistance;
    this.fallDistance = 0;
    if (d <= 0) return;
    if (typeof this.events.onLand === 'function') this.events.onLand(d, this);
    if (this.flying || this.inWater) return;
    if (d > 3.5) this.applyDamage(Math.floor(d - 3), 'fall');
  };

  /* The ONE authoritative look path: game.js drains MC.Input.consumeLook()
   * once per frame and hands the pixel deltas here.  Sensitivity and the
   * pitch clamp live in MC.C (LOOK_SENS / PITCH_CLAMP) so there is only one
   * set of numbers in the codebase. */
  Player.prototype.applyLook = function (dx, dy, sensitivity) {
    var s = C.LOOK_SENS * (sensitivity || 1);
    this.yaw -= (dx || 0) * s;
    this.pitch -= (dy || 0) * s;
    this.pitch = MC.Util.clamp(this.pitch, -C.PITCH_CLAMP, C.PITCH_CLAMP);
    this.yaw = MC.Util.wrap(this.yaw, Math.PI * 2);
    return this;
  };

  Player.prototype.update = function (dt, input, inv) {
    if (!(dt > 0)) return;
    if (dt > 0.25) dt = 0.25;
    if (this._hurtFlash > 0) this._hurtFlash -= dt;

    if (!this.alive) {
      this.velocity[0] = this.velocity[1] = this.velocity[2] = 0;
      this._sampleWater();
      return;
    }

    var down = function (code) { return !!input && input.isDown(code); };
    var space = down('Space');
    var ctrl = down('ControlLeft');
    var shift = down('ShiftLeft');

    /* ---- look ----
     * Not applied here: game.js owns the mouse->yaw/pitch path and calls
     * player.applyLook() (see above), so consuming the look deltas twice
     * would double every turn. */
    this._sampleWater();

    /* ---- stance ---- */
    this.sneaking = !!ctrl && !this.flying && !this.inWater;
    var fwd = (down('KeyW') ? 1 : 0) - (down('KeyS') ? 1 : 0);
    var strafe = (down('KeyD') ? 1 : 0) - (down('KeyA') ? 1 : 0);
    this.sprinting = !!shift && fwd > 0 && !this.sneaking && !this.flying && !this.inWater;

    /* ---- horizontal wish direction (matches MC.M4.view) ---- */
    var cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    var fx = -sy, fz = -cy;          /* forward */
    var rx = -cy, rz = cy;           /* right   */
    var wx = fx * fwd + rx * strafe;
    var wz = fz * fwd + rz * strafe;
    var wl = Math.sqrt(wx * wx + wz * wz);
    if (wl > 0) { wx /= wl; wz /= wl; }

    var speed = C.WALK_SPEED;
    if (this.flying) speed = C.FLY_SPEED;
    else if (this.sneaking) speed = C.WALK_SPEED * 0.3;
    else if (this.sprinting) speed = C.SPRINT_SPEED;
    if (this.inWater && !this.flying) speed *= 0.55;

    var accel = this.onGround ? 18 : (this.inWater ? 4 : 8);
    var k = 1 - Math.exp(-accel * dt);
    this.velocity[0] += (wx * speed - this.velocity[0]) * k;
    this.velocity[2] += (wz * speed - this.velocity[2]) * k;

    /* ---- vertical ---- */
    if (this.flying) {
      var vy = 0;
      if (space) vy += C.FLY_SPEED * 0.75;
      if (ctrl) vy -= C.FLY_SPEED * 0.75;
      this.velocity[1] += (vy - this.velocity[1]) * (1 - Math.exp(-14 * dt));
      this.fallDistance = 0;
    } else if (this.inWater) {
      if (space) {
        var up = C.JUMP_SPEED * 0.45;
        this.velocity[1] = up > WATER_RISE ? WATER_RISE : up;
      } else {
        this.velocity[1] -= C.GRAVITY * 0.3 * dt;      /* buoyant, reduced gravity */
        if (this.velocity[1] < -WATER_SINK) this.velocity[1] = -WATER_SINK;
      }
      this.fallDistance = 0;
    } else {
      if (space && this.onGround) {
        this.velocity[1] = C.JUMP_SPEED;
        this.onGround = false;
      }
      this.velocity[1] -= C.GRAVITY * dt;
      if (this.velocity[1] < -C.TERMINAL_FALL) this.velocity[1] = -C.TERMINAL_FALL;
    }

    /* ---- integrate with sub-steps, one axis at a time ---- */
    var v = this.velocity;
    var maxMove = Math.max(Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2])) * dt;
    var steps = Math.ceil(maxMove / MAX_SUBSTEP) || 1;
    if (steps > 32) steps = 32;
    var h = dt / steps;
    var wasGround = this.onGround;
    for (var i = 0; i < steps; i++) {
      /* onGround is kept live across sub-steps so auto-step can fire */
      this._moveHorizontal(0, v[0] * h);
      this._moveHorizontal(2, v[2] * h);
      this._moveAxis(1, v[1] * h);
      this.onGround = this._hasSupport(this.getAABB());
      if (!this.onGround && v[1] < 0 && !this.flying && !this.inWater) {
        this.fallDistance += -v[1] * h;
      }
    }
    if (this.onGround && !wasGround) this._land();

    /* ---- sprint FOV hint for the renderer (game.js reads targetFov) ---- */
    var baseFov = C.FOV || 72;
    var wantFov = this.sprinting ? baseFov + 7 : (this.flying ? baseFov + 3 : baseFov);
    if (typeof this.targetFov !== 'number') this.targetFov = baseFov;
    this.targetFov += (wantFov - this.targetFov) * (1 - Math.exp(-6 * dt));

    /* ---- view bob ---- */
    var hs = Math.sqrt(v[0] * v[0] + v[2] * v[2]);
    if (this.onGround && !this.flying && !this.inWater && hs > 0.5) this.bobPhase += hs * dt * 1.5;
    else this.bobPhase = 0;

    this._breath(dt);
  };

  MC.Player = Player;
})(typeof window !== 'undefined' ? window : globalThis);
