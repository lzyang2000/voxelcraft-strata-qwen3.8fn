/* MC core constants + shared geometry tables.
 * Loaded FIRST. Everything hangs off the global MC namespace (no ES modules,
 * so the game runs straight from file:// with zero installs). */
(function (root) {
  'use strict';
  var MC = (root.MC = root.MC || {});

  var C = {
    /* ---- world shape ---- */
    CHUNK_SX: 16,
    CHUNK_SY: 64,
    CHUNK_SZ: 16,
    WORLD_CX: 8,
    WORLD_CZ: 8,
    SEA_LEVEL: 22,

    /* ---- gameplay ---- */
    REACH: 5.5,
    LOOK_SENS: 0.0022,          /* radians per pixel of mouse movement */
    PITCH_CLAMP: 1.5533,       /* never look quite straight up/down */
    GRAVITY: 30,
    TERMINAL_FALL: 55,
    JUMP_SPEED: 8.7,
    WALK_SPEED: 4.4,
    SPRINT_SPEED: 6.8,
    FLY_SPEED: 12,
    PLAYER_WIDTH: 0.6,
    PLAYER_HEIGHT: 1.8,
    EYE_HEIGHT: 1.62,
    STEP_HEIGHT: 0.55,
    MAX_HEALTH: 20,
    MAX_AIR: 20,

    /* ---- simulation ---- */
    SIM_TICK_HZ: 12,
    SIM_RADIUS: 30,
    SIM_MAX_UPDATES: 4000,

    /* ---- rendering ---- */
    FOV: 72,
    NEAR: 0.06,
    FAR: 260,
    FOG_START: 90,
    FOG_END: 210,
    DAY_LENGTH: 480,
    MAX_MESH_DISTANCE: 6,
    CHUNKS_MERGED_PER_FRAME: 4,
    ATLAS_TILE_PX: 16,
    ATLAS_COLS: 16,
    ATLAS_ROWS: 16,

    /* ---- misc ---- */
    HOTBAR_SLOTS: 9,
    DEBUG_STATS_MS: 2000,      /* F3 block census refresh interval */
    STACK_SIZE: 64,
    SAVE_KEY: 'mc_clone_save_v1'
  };
  C.WORLD_SX = C.CHUNK_SX * C.WORLD_CX;
  C.WORLD_SY = C.CHUNK_SY;
  C.WORLD_SZ = C.CHUNK_SZ * C.WORLD_CZ;
  C.CHUNK_VOL = C.CHUNK_SX * C.CHUNK_SY * C.CHUNK_SZ;
  MC.C = C;

  /* Face order is a hard contract between mesher, renderer and raycaster.
   * 0:+X 1:-X 2:+Y 3:-Y 4:+Z 5:-Z */
  MC.FACE_ORDER = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
  MC.FACE_NORMALS = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]
  ];
  /* Unit-cube corners per face, CCW seen from outside, uv in [0,1]. */
  MC.FACES = [
    { dir: [1, 0, 0], corners: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]] },
    { dir: [-1, 0, 0], corners: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },
    { dir: [0, 1, 0], corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
    { dir: [0, -1, 0], corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
    { dir: [0, 0, 1], corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
    { dir: [0, 0, -1], corners: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] }
  ];
  MC.FACE_UVS = [[0, 0], [1, 0], [1, 1], [0, 1]];
  MC.FACE_INDICES = [0, 1, 2, 0, 2, 3];

  /* Per-face shading multiplier so flat faces read differently (MC-like). */
  MC.FACE_SHADE = [0.72, 0.62, 1.0, 0.5, 0.86, 0.78];

  /* Neighbour offsets used by ambient occlusion, per face:
   * [side1, side2, corner] as normal-space offsets. */
  MC.AO_NEIGHBOURS = (function () {
    var out = [];
    for (var f = 0; f < 6; f++) {
      var n = MC.FACE_NORMALS[f];
      var axes = [];
      for (var a = 0; a < 3; a++) if (n[a] === 0) axes.push(a);
      var s1 = [0, 0, 0], s2 = [0, 0, 0];
      s1[axes[0]] = 1; s2[axes[1]] = 1;
      var c = [0, 0, 0];
      c[0] = s1[0] + s2[0]; c[1] = s1[1] + s2[1]; c[2] = s1[2] + s2[2];
      /* corner/sides must be pushed along the face normal too */
      var push = function (v) { return [v[0] + n[0], v[1] + n[1], v[2] + n[2]]; };
      out.push({ side1: push(s1), side2: push(s2), corner: push(c) });
    }
    return out;
  })();

  MC.VERSION = '1.0.0';
})(typeof window !== 'undefined' ? window : globalThis);
