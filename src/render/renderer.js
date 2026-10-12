/* WebGL2 renderer for Voxelcraft.
 *
 *   new MC.Renderer(canvas)
 *     .setAtlas(atlas) .updateChunk(key, mesh) .removeChunk(key)
 *     .resize() .render(state) .dispose()
 *
 * Owns its own GPU buffer map + culling; game.js only feeds it meshes.
 * No per-frame allocations in the draw loop, no ES modules, no deps.
 *
 * Loaded after constants.js, math.js, blocks.js, world.js, textures.js, mesher.js. */
(function (root) {
  'use strict';
  var MC = (root.MC = root.MC || {});

  /* ------------------------------- shaders ------------------------------ */
  var CHUNK_VS = [
    '#version 300 es',
    'layout(location = 0) in vec3 aPos;',
    'layout(location = 1) in vec2 aUV;',
    'layout(location = 2) in float aLight;',
    'layout(location = 3) in float aFace;',
    'uniform mat4 uViewProj;',
    'uniform vec3 uSunDir;',
    'uniform float uDayLight;',
    'out vec2 vUV;',
    'out float vLight;',
    'out vec3 vWorld;',
    'void main() {',
    '  const vec3 N[6] = vec3[6](',
    '    vec3(1.0, 0.0, 0.0), vec3(-1.0, 0.0, 0.0),',
    '    vec3(0.0, 1.0, 0.0), vec3(0.0, -1.0, 0.0),',
    '    vec3(0.0, 0.0, 1.0), vec3(0.0, 0.0, -1.0));',
    '  int fi = int(aFace + 0.5);',
    '  vec3 n = N[fi];',
    /* aLight packs two channels: sky in [0.02,1] plus the raw integer
     * block-light level (0..15) times 16. Skylight dims at night, torch /
     * glowstone light does not. Float32 is exact for this packing (max 241),
     * so mod/floor split the channels cleanly. */
    '  float diff = 0.55 + 0.45 * max(dot(n, uSunDir), 0.0);',
    '  float skyC = mod(aLight, 16.0);',
    '  float blkC = min(floor(aLight * 0.0625), 15.0) / 15.0;',
    '  float dayF = mix(0.18, 1.0, uDayLight);',
    '  vUV = aUV;',
    '  vLight = max(skyC * dayF, blkC) * diff;',
    '  vWorld = aPos;',
    '  gl_Position = uViewProj * vec4(aPos, 1.0);',
    '}'
  ].join('\n');

  var CHUNK_FS = [
    '#version 300 es',
    'precision highp float;',
    'in vec2 vUV;',
    'in float vLight;',
    'in vec3 vWorld;',
    'uniform sampler2D uAtlas;',
    'uniform vec3 uCamPos;',
    'uniform vec3 uFogColor;',
    'uniform vec3 uSunTint;',
    'uniform vec3 uTint;',
    'uniform float uTime;',
    'uniform float uDayLight;',
    'uniform float uFogStart;',
    'uniform float uFogEnd;',
    'uniform float uAlphaTest;',
    'uniform float uShimmer;',
    'out vec4 fragColor;',
    'void main() {',
    '  vec4 t = texture(uAtlas, vUV);',
    '  if (t.a < uAlphaTest) discard;',
    '  vec3 amb = vec3(0.42, 0.48, 0.62);',
    '  vec3 light = mix(amb, uSunTint, uDayLight);',
    '  float shimmer = 1.0 + uShimmer * 0.05 *',
    '    sin((vWorld.x + vWorld.z) * 1.7 + uTime * 2.1);',
    '  vec3 c = t.rgb * vLight * light * uTint * shimmer;',
    '  float d = distance(uCamPos, vWorld);',
    '  float f = clamp((d - uFogStart) / max(uFogEnd - uFogStart, 0.001), 0.0, 1.0);',
    '  fragColor = vec4(mix(c, uFogColor, f), t.a);',
    '}'
  ].join('\n');

  var SKY_VS = [
    '#version 300 es',
    'out vec2 vNdc;',
    'void main() {',
    '  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));',
    '  vNdc = p * 2.0 - 1.0;',
    '  gl_Position = vec4(vNdc, 0.0, 1.0);',
    '}'
  ].join('\n');

  var SKY_FS = [
    '#version 300 es',
    'precision highp float;',
    'in vec2 vNdc;',
    'uniform vec3 uCamF;',
    'uniform vec3 uCamR;',
    'uniform vec3 uCamU;',
    'uniform vec3 uSunDir;',
    'uniform vec3 uSunTint;',
    'uniform vec3 uSkyTop;',
    'uniform vec3 uSkyHorizon;',
    'uniform float uTanHalfFov;',
    'uniform float uAspect;',
    'uniform float uDayLight;',
    'uniform float uNight;',
    'uniform float uTime;',
    'out vec4 fragColor;',
    'float hash13(vec3 p) {',
    '  p = fract(p * 0.1031);',
    '  p += dot(p, p.yzx + 33.33);',
    '  return fract((p.x + p.y) * p.z);',
    '}',
    'void main() {',
    '  vec3 dir = normalize(uCamF + uCamR * (vNdc.x * uTanHalfFov * uAspect)',
    '                        + uCamU * (vNdc.y * uTanHalfFov));',
    '  float up = max(dir.y, 0.0);',
    '  vec3 col = mix(uSkyHorizon, uSkyTop, pow(up, 0.45));',
    '  col = mix(col, uSkyHorizon * 0.55, clamp(-dir.y * 2.5, 0.0, 1.0));',
    /* horizon haze band */
    '  float haze = pow(1.0 - up, 9.0);',
    '  col = mix(col, uSkyHorizon, haze * 0.6);',
    /* sun disc + glow */
    '  float sd = dot(dir, uSunDir);',
    '  col += uSunTint * smoothstep(0.99935, 0.99975, sd) * 1.35 * uDayLight;',
    '  col += uSunTint * pow(max(sd, 0.0), 1400.0) * 0.75 * uDayLight;',
    '  col += uSunTint * pow(max(sd, 0.0), 26.0) * 0.12 * uDayLight;',
    /* moon opposite the sun */
    '  float md = dot(dir, -uSunDir);',
    '  float moon = smoothstep(0.99958, 0.99978, md);',
    '  float limb = smoothstep(0.99958, 0.99998, md + 0.00035);',
    '  col += vec3(0.92, 0.94, 1.0) * moon * uNight * (1.0 - 0.45 * limb);',
    '  col += vec3(0.35, 0.40, 0.55) * pow(max(md, 0.0), 3000.0) * uNight;',
    /* procedural stars */
    '  if (uNight > 0.02 && dir.y > -0.02) {',
    '    vec3 sp = dir * 190.0;',
    '    vec3 ip = floor(sp), fp = fract(sp);',
    '    float h = hash13(ip);',
    '    if (h > 0.982) {',
    '      vec3 off = vec3(hash13(ip + 1.7), hash13(ip + 5.3), hash13(ip + 9.1));',
    '      float dd = length(fp - off);',
    '      float tw = 0.65 + 0.35 * sin(uTime * (1.5 + h * 6.0) + h * 90.0);',
    '      float amt = smoothstep(0.34, 0.0, dd) * ((h - 0.982) / 0.018) * tw;',
    '      col += vec3(0.90, 0.93, 1.0) * amt * uNight;',
    '    }',
    '  }',
    '  fragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  var PART_VS = [
    '#version 300 es',
    'layout(location = 0) in vec3 aPos;',
    'layout(location = 1) in vec3 aColor;',
    'layout(location = 2) in float aSize;',
    'uniform mat4 uViewProj;',
    'uniform vec3 uCamPos;',
    'uniform vec3 uFogColor;',
    'uniform float uFogStart;',
    'uniform float uFogEnd;',
    'uniform float uPixelScale;',
    'out vec3 vColor;',
    'void main() {',
    '  float d = distance(uCamPos, aPos);',
    '  gl_PointSize = clamp(aSize * uPixelScale / max(d, 0.4), 1.0, 64.0);',
    '  float f = clamp((d - uFogStart) / max(uFogEnd - uFogStart, 0.001), 0.0, 1.0);',
    '  vColor = mix(aColor, uFogColor, f);',
    '  gl_Position = uViewProj * vec4(aPos, 1.0);',
    '}'
  ].join('\n');

  var PART_FS = [
    '#version 300 es',
    'precision mediump float;',
    'in vec3 vColor;',
    'out vec4 fragColor;',
    'void main() {',
    '  vec2 q = gl_PointCoord - 0.5;',
    '  if (dot(q, q) > 0.25) discard;',
    '  fragColor = vec4(vColor, 1.0);',
    '}'
  ].join('\n');

  var LINE_VS = [
    '#version 300 es',
    'layout(location = 0) in vec3 aPos;',
    'uniform mat4 uViewProj;',
    'uniform mat4 uModel;',
    'void main() { gl_Position = uViewProj * uModel * vec4(aPos, 1.0); }'
  ].join('\n');

  var LINE_FS = [
    '#version 300 es',
    'precision mediump float;',
    'uniform vec4 uColor;',
    'out vec4 fragColor;',
    'void main() { fragColor = uColor; }'
  ].join('\n');

  /* 12 cube edges as line pairs, unit cube centred on the origin */
  var CUBE_EDGES = (function () {
    var v = [
      [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5],
      [0.5, -0.5, -0.5], [0.5, -0.5, 0.5],
      [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5],
      [-0.5, -0.5, 0.5], [-0.5, -0.5, -0.5],
      [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5],
      [0.5, 0.5, -0.5], [0.5, 0.5, 0.5],
      [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5],
      [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5],
      [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5],
      [0.5, -0.5, -0.5], [0.5, 0.5, -0.5],
      [0.5, -0.5, 0.5], [0.5, 0.5, 0.5],
      [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5]
    ];
    var out = new Float32Array(v.length * 3);
    for (var i = 0; i < v.length; i++) {
      out[i * 3] = v[i][0]; out[i * 3 + 1] = v[i][1]; out[i * 3 + 2] = v[i][2];
    }
    return out;
  })();

  /* ------------------------------ helpers ------------------------------- */
  function compile(gl, type, src, tag) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('Shader compile failed (' + tag + '): ' + log);
    }
    return sh;
  }

  function program(gl, vsSrc, fsSrc, tag) {
    var vs = compile(gl, gl.VERTEX_SHADER, vsSrc, tag + '.vs');
    var fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc, tag + '.fs');
    var p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      var log = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error('Program link failed (' + tag + '): ' + log);
    }
    return p;
  }

  function uniforms(gl, p, names) {
    var o = {};
    for (var i = 0; i < names.length; i++) o[names[i]] = gl.getUniformLocation(p, names[i]);
    return o;
  }

  /* column-major viewProj -> 6 inward planes packed as [a,b,c,d]*6.
   * Gribb-Hartmann: plane_i = row3 +/- row_k. Writes straight into the
   * caller's scratch buffer, so the draw loop allocates nothing. */
  function extractPlanes(vp, out) {
    for (var i = 0; i < 6; i++) {
      var k = i >> 1;                       /* 0:left/right 1:bottom/top 2:near/far */
      var sign = (i & 1) ? -1 : 1;
      var a = vp[3] + sign * vp[k];
      var b = vp[7] + sign * vp[4 + k];
      var c = vp[11] + sign * vp[8 + k];
      var d = vp[15] + sign * vp[12 + k];
      var len = Math.sqrt(a * a + b * b + c * c) || 1;
      out[i * 4] = a / len;
      out[i * 4 + 1] = b / len;
      out[i * 4 + 2] = c / len;
      out[i * 4 + 3] = d / len;
    }
    return out;
  }

  function boxInFrustum(planes, x0, y0, z0, x1, y1, z1) {
    for (var i = 0; i < 6; i++) {
      var a = planes[i * 4], b = planes[i * 4 + 1], c = planes[i * 4 + 2], d = planes[i * 4 + 3];
      var px = a > 0 ? x1 : x0, py = b > 0 ? y1 : y0, pz = c > 0 ? z1 : z0;
      if (a * px + b * py + c * pz + d < 0) return false;
    }
    return true;
  }

  /* ------------------------------ renderer ------------------------------ */
  MC.Renderer = function (canvas) {
    this.canvas = canvas;
    this.gl = null;
    this.contextLost = false;
    this.disposed = false;
    this.chunks = new Map();          /* key -> chunk record */
    this.chunkList = [];              /* same records, allocation-free iteration */
    this.atlas = null;
    this.atlasTex = null;
    this.progs = null;
    this._sortN = 0;
    this._sortPool = [];
    this._partCap = 0;
    this._partBuf = null;
    this._partVAO = null;
    this._itemCap = 0;
    this._itemIdxCap = 0;
    this._itemBuf = null;
    this._itemIdx = null;
    this._itemVAO = null;
    this._lineVAO = null;
    this._lineVBO = null;
    this._skyVAO = null;

    /* preallocated scratch: the draw loop must not allocate */
    this._proj = MC.M4.create();
    this._view = MC.M4.create();
    this._vp = MC.M4.create();
    this._model = MC.M4.create();
    this._planes = new Float32Array(24);
    this._basis = new Float32Array(9);
    this._partScratch = new Float32Array(0);

    var self = this;
    this._onLost = function (ev) {
      ev.preventDefault();
      self.contextLost = true;
      self.gl = null;
      self.progs = null;
      self.atlasTex = null;
      self._skyVAO = null;
      self._lineVAO = null;
      self._lineVBO = null;
      self._partVAO = null;
      self._partBuf = null;
      self._partCap = 0;
      self._itemVAO = null;
      self._itemBuf = null;
      self._itemIdx = null;
      self._itemCap = 0;
      self._itemIdxCap = 0;
      self.chunks.forEach(function (rec) { rec.gpuOpaque = null; rec.gpuTrans = null; });
    };
    this._onRestored = function () {
      try {
        self._initGL();
        self.chunks.forEach(function (rec) { self._upload(rec); });
        self.contextLost = false;
      } catch (err) {
        self.contextLost = true;
      }
    };
    canvas.addEventListener('webglcontextlost', this._onLost, false);
    canvas.addEventListener('webglcontextrestored', this._onRestored, false);

    this._initGL();
  };

  /* documented on the prototype (instances shadow it with their own copy) */
  MC.Renderer.prototype.stats = { drawCalls: 0, chunksDrawn: 0, verts: 0 };

  MC.Renderer.prototype._initGL = function () {
    var gl = this.canvas.getContext('webgl2', {
      antialias: false, alpha: false, depth: true, stencil: false,
      powerPreference: 'high-performance'
    });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    this.stats = { drawCalls: 0, chunksDrawn: 0, verts: 0 };

    var chunkP = program(gl, CHUNK_VS, CHUNK_FS, 'chunk');
    var skyP = program(gl, SKY_VS, SKY_FS, 'sky');
    var partP = program(gl, PART_VS, PART_FS, 'particle');
    var lineP = program(gl, LINE_VS, LINE_FS, 'line');

    this.progs = {
      chunk: { p: chunkP, u: uniforms(gl, chunkP, ['uViewProj', 'uCamPos', 'uAtlas', 'uTime',
        'uDayLight', 'uSunTint', 'uSunDir', 'uFogColor', 'uFogStart', 'uFogEnd',
        'uAlphaTest', 'uTint', 'uShimmer']) },
      sky: { p: skyP, u: uniforms(gl, skyP, ['uCamF', 'uCamR', 'uCamU', 'uSunDir', 'uSunTint',
        'uSkyTop', 'uSkyHorizon', 'uTanHalfFov', 'uAspect', 'uDayLight', 'uNight', 'uTime']) },
      part: { p: partP, u: uniforms(gl, partP, ['uViewProj', 'uCamPos', 'uFogColor',
        'uFogStart', 'uFogEnd', 'uPixelScale']) },
      line: { p: lineP, u: uniforms(gl, lineP, ['uViewProj', 'uModel', 'uColor']) }
    };

    this._skyVAO = gl.createVertexArray();
    this._lineVAO = gl.createVertexArray();
    this._lineVBO = gl.createBuffer();
    gl.bindVertexArray(this._lineVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._lineVBO);
    gl.bufferData(gl.ARRAY_BUFFER, CUBE_EDGES, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this._partVAO = gl.createVertexArray();
    this._partBuf = gl.createBuffer();
    gl.bindVertexArray(this._partVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._partBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 28, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 28, 24);
    gl.bindVertexArray(null);

    /* dropped item cubes: one dynamic VAO reused every frame, with the exact
     * 7-float layout the chunk program expects (aPos/aUV/aLight/aFace). */
    this._itemVAO = gl.createVertexArray();
    this._itemBuf = gl.createBuffer();
    this._itemIdx = gl.createBuffer();
    this._itemCap = 0;
    this._itemIdxCap = 0;
    gl.bindVertexArray(this._itemVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._itemBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 28, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 28, 20);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 28, 24);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._itemIdx);
    gl.bindVertexArray(null);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
    gl.disable(gl.BLEND);
    gl.clearColor(0.6, 0.75, 0.9, 1);

    if (this.atlas) this._uploadAtlas();
  };

  MC.Renderer.prototype._uploadAtlas = function () {
    var gl = this.gl, a = this.atlas;
    if (!gl || !a) return;
    if (!this.atlasTex) this.atlasTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, a.width, a.height, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, a.pixels);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
  };

  MC.Renderer.prototype.setAtlas = function (atlas) {
    this.atlas = atlas;
    this._uploadAtlas();
  };

  MC.Renderer.prototype._freeGpu = function (g) {
    if (!g || !this.gl) return;
    var gl = this.gl;
    if (g.vao) gl.deleteVertexArray(g.vao);
    if (g.vbo) gl.deleteBuffer(g.vbo);
    if (g.ibo) gl.deleteBuffer(g.ibo);
  };

  MC.Renderer.prototype._upload = function (rec) {
    var gl = this.gl;
    if (!gl) return;
    rec.gpuOpaque = this._uploadPart(rec.mesh.opaque);
    rec.gpuTrans = this._uploadPart(rec.mesh.trans);
  };

  MC.Renderer.prototype._uploadPart = function (part) {
    var gl = this.gl;
    var g = { vao: null, vbo: null, ibo: null, count: 0, verts: 0 };
    if (!gl || !part || !part.indices || part.indices.length === 0) return g;
    g.count = part.indices.length;
    g.verts = part.vertices.length / 7;
    g.vao = gl.createVertexArray();
    gl.bindVertexArray(g.vao);
    g.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, g.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, part.vertices, gl.STATIC_DRAW);
    g.ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, g.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, part.indices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 28, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 28, 20);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 28, 24);
    gl.bindVertexArray(null);
    return g;
  };

  MC.Renderer.prototype.updateChunk = function (key, mesh) {
    if (this.disposed) return;
    var rec = this.chunks.get(key);
    if (rec) { this._freeGpu(rec.gpuOpaque); this._freeGpu(rec.gpuTrans); }
    else {
      var parts = String(key).split(',');
      var cx = parseInt(parts[0], 10), cz = parseInt(parts[1], 10);
      var C = MC.C;
      if (isNaN(cx) || isNaN(cz)) { cx = 0; cz = 0; }
      rec = {
        key: key, cx: cx, cz: cz, mesh: mesh,
        x0: cx * C.CHUNK_SX, y0: 0, z0: cz * C.CHUNK_SZ,
        x1: cx * C.CHUNK_SX + C.CHUNK_SX, y1: C.CHUNK_SY,
        z1: cz * C.CHUNK_SZ + C.CHUNK_SZ,
        gpuOpaque: null, gpuTrans: null
      };
      rec.cxs = (rec.x0 + rec.x1) * 0.5;
      rec.cys = (rec.y0 + rec.y1) * 0.5;
      rec.czs = (rec.z0 + rec.z1) * 0.5;
      rec.listIndex = this.chunkList.length;
      this.chunkList.push(rec);
      this.chunks.set(key, rec);
    }
    rec.mesh = mesh;
    this._upload(rec);
  };

  /* Free every chunk's GPU resources. A new World does not necessarily reuse
   * the same chunk keys (imported saves may be a different size), so without
   * this the old records keep drawing ghost terrain and leak their buffers. */
  MC.Renderer.prototype.clearChunks = function () {
    var gl = this.gl;
    var self = this;
    this.chunks.forEach(function (rec) {
      if (gl) { self._freeGpu(rec.gpuOpaque); self._freeGpu(rec.gpuTrans); }
      rec.gpuOpaque = null; rec.gpuTrans = null; rec.mesh = null;
    });
    this.chunks.clear();
    this.chunkList.length = 0;
  };

  MC.Renderer.prototype.removeChunk = function (key) {
    var rec = this.chunks.get(key);
    if (!rec) return;
    this._freeGpu(rec.gpuOpaque);
    this._freeGpu(rec.gpuTrans);
    this.chunks.delete(key);
    var li = rec.listIndex, last = this.chunkList.length - 1;
    if (li >= 0 && li <= last) {
      var moved = this.chunkList[last];
      this.chunkList[li] = moved;
      moved.listIndex = li;
      this.chunkList.pop();
    }
    rec.listIndex = -1;
  };

  MC.Renderer.prototype.resize = function () {
    var canvas = this.canvas;
    var dpr = Math.min((root.devicePixelRatio || 1), 2);
    var w = Math.max(1, Math.floor((canvas.clientWidth || canvas.width || 1) * dpr));
    var h = Math.max(1, Math.floor((canvas.clientHeight || canvas.height || 1) * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    if (this.gl) this.gl.viewport(0, 0, w, h);
  };

  /* day/night palette -> uniforms (written into preallocated scratch) */
  function skyPalette(timeOfDay, sunDir, out) {
    /* out: [top3, horizon3, sunTint3, dayLight, night, sunToX, sunToY, sunToZ] */
    var t = timeOfDay === undefined ? 0.5 : timeOfDay;
    var ang = (t - 0.25) * Math.PI * 2;
    var elev = Math.sin(ang);
    var dayLight = 0.28 + 0.72 * Math.pow(Math.max(0, elev), 0.55);
    var night = 1 - Math.min(1, Math.max(0, elev * 2.2 + 0.35));
    var dusk = Math.max(0, 1 - Math.abs(elev) * 4.2);
    var topN = [0.030, 0.045, 0.110], topD = [0.300, 0.560, 0.930];
    var horN = [0.055, 0.075, 0.150], horD = [0.620, 0.780, 0.950];
    var duskC = [0.950, 0.480, 0.250];
    var k, i;
    for (i = 0; i < 3; i++) {
      out[i] = topN[i] + (topD[i] - topN[i]) * dayLight;
      out[3 + i] = horN[i] + (horD[i] - horN[i]) * dayLight;
      out[3 + i] = out[3 + i] + (duskC[i] - out[3 + i]) * dusk * 0.75;
    }
    /* sun tint: warm at low sun, near white at noon */
    var warm = 1 - Math.min(1, Math.max(0, elev) * 1.6);
    out[6] = 1.0 - warm * 0.10;
    out[7] = 0.96 - warm * 0.30;
    out[8] = 0.88 - warm * 0.48;
    out[9] = dayLight;
    out[10] = night;
    /* direction TOWARD the sun (state.sunDir points from sun to scene) */
    var sx = sunDir ? -sunDir[0] : Math.cos(ang);
    var sy = sunDir ? -sunDir[1] : elev;
    var sz = sunDir ? -sunDir[2] : 0.0;
    var len = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
    out[11] = sx / len; out[12] = sy / len; out[13] = sz / len;
    return out;
  }

  /* Chunk-program uniforms that every chunk pass AND the item draws share.
   * Factored out so the item pass reuses the chunk program without repeating
   * a dozen calls; alphaTest / shimmer / tint stay per-pass. */
  MC.Renderer.prototype._setChunkUniforms = function (vp, camX, camY, camZ,
    time, dayLight, pal, fogStart, fogEnd) {
    var gl = this.gl, chunk = this.progs.chunk;
    gl.useProgram(chunk.p);
    gl.uniformMatrix4fv(chunk.u.uViewProj, false, vp);
    gl.uniform3f(chunk.u.uCamPos, camX, camY, camZ);
    gl.uniform1f(chunk.u.uTime, time);
    gl.uniform1f(chunk.u.uDayLight, dayLight);
    gl.uniform3f(chunk.u.uSunTint, pal[6], pal[7], pal[8]);
    gl.uniform3f(chunk.u.uSunDir, pal[11], pal[12], pal[13]);
    gl.uniform3f(chunk.u.uFogColor, pal[3], pal[4], pal[5]);
    gl.uniform1f(chunk.u.uFogStart, fogStart);
    gl.uniform1f(chunk.u.uFogEnd, fogEnd);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    gl.uniform1i(chunk.u.uAtlas, 0);
    return chunk;
  };

  /* Upload one item mesh into the shared dynamic item buffers and draw it with
   * the chunk program (whose uniforms the chunk passes already set). Grows the
   * GPU allocation only when the mesh outgrows it, then streams the used range. */
  MC.Renderer.prototype._drawItems = function (part) {
    var gl = this.gl, st = this.stats;
    var verts = part.vertices, idx = part.indices;
    if (!this._itemVAO || !verts || !idx || !idx.length) return;
    gl.bindVertexArray(this._itemVAO);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._itemBuf);
    if (this._itemCap < verts.length) {
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
      this._itemCap = verts.length;
    } else {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, verts, 0, verts.length);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._itemIdx);
    if (this._itemIdxCap < idx.length) {
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.DYNAMIC_DRAW);
      this._itemIdxCap = idx.length;
    } else {
      gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, idx, 0, idx.length);
    }
    gl.drawElements(gl.TRIANGLES, idx.length, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    st.drawCalls++; st.verts += verts.length / 7;
  };

  MC.Renderer.prototype.render = function (state) {
    if (this.contextLost || this.disposed || !this.gl) return;
    var gl = this.gl, C = MC.C, st = this.stats;
    st.drawCalls = 0; st.chunksDrawn = 0; st.verts = 0;

    var cam = state.camera;
    var camX = cam.position[0], camY = cam.position[1], camZ = cam.position[2];
    var fovDeg = cam.fov === undefined ? C.FOV : cam.fov;
    var fov = fovDeg * Math.PI / 180;
    var w = this.canvas.width || 1, h = this.canvas.height || 1;
    var aspect = w / h;

    var proj = this._proj, view = this._view, vp = this._vp;
    MC.M4.perspective(proj, fov, aspect, C.NEAR, C.FAR);
    MC.M4.view(view, camX, camY, camZ, cam.yaw, cam.pitch);
    MC.M4.multiply(vp, proj, view);
    extractPlanes(vp, this._planes);

    /* camera basis in world space (rows of the view rotation) */
    var b = this._basis;
    b[0] = -view[2]; b[1] = -view[6]; b[2] = -view[10];   /* forward */
    b[3] = view[0]; b[4] = view[4]; b[5] = view[8];       /* right   */
    b[6] = view[1]; b[7] = view[5]; b[8] = view[9];       /* up      */

    var pal = skyPalette(state.timeOfDay, state.sunDir, this._pal || (this._pal = new Float32Array(14)));
    var dayLight = pal[9], night = pal[10];
    var sunX = pal[11], sunY = pal[12], sunZ = pal[13];

    var fogStart = state.fogStart === undefined ? C.FOG_START : state.fogStart;
    var fogEnd = state.fogEnd === undefined ? C.FOG_END : state.fogEnd;
    var fogR = pal[3], fogG = pal[4], fogB = pal[5];
    var underwater = !!state.underwater;
    /* wrapped so sin()/pow() arguments in the shaders keep float32 precision
     * over a multi-hour session (shimmer and star twinkle would quantize) */
    var time = (typeof performance !== 'undefined' && performance.now) ?
      (performance.now() * 0.001) % 3600 : 0;

    gl.viewport(0, 0, w, h);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.clearColor(fogR, fogG, fogB, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    /* ------------------------------ sky ------------------------------ */
    var sky = this.progs.sky;
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.useProgram(sky.p);
    gl.bindVertexArray(this._skyVAO);
    gl.uniform3f(sky.u.uCamF, b[0], b[1], b[2]);
    gl.uniform3f(sky.u.uCamR, b[3], b[4], b[5]);
    gl.uniform3f(sky.u.uCamU, b[6], b[7], b[8]);
    gl.uniform3f(sky.u.uSunDir, sunX, sunY, sunZ);
    gl.uniform3f(sky.u.uSunTint, pal[6], pal[7], pal[8]);
    gl.uniform3f(sky.u.uSkyTop, pal[0], pal[1], pal[2]);
    gl.uniform3f(sky.u.uSkyHorizon, fogR, fogG, fogB);
    gl.uniform1f(sky.u.uTanHalfFov, Math.tan(fov * 0.5));
    gl.uniform1f(sky.u.uAspect, aspect);
    gl.uniform1f(sky.u.uDayLight, dayLight);
    gl.uniform1f(sky.u.uNight, night);
    gl.uniform1f(sky.u.uTime, time);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    st.drawCalls++;
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);

    /* --------------------------- chunk passes ------------------------ */
    var chunk = this._setChunkUniforms(vp, camX, camY, camZ, time, dayLight,
      pal, fogStart, fogEnd);

    var maxDist = C.MAX_MESH_DISTANCE * 16;
    var maxDist2 = maxDist * maxDist;
    var planes = this._planes;
    var pool = this._sortPool;
    var n = 0;

    /* opaque + alpha-tested pass */
    gl.uniform1f(chunk.u.uAlphaTest, 0.5);
    gl.uniform1f(chunk.u.uShimmer, 0.0);
    if (underwater) gl.uniform3f(chunk.u.uTint, 0.72, 0.85, 1.05);
    else gl.uniform3f(chunk.u.uTint, 1.0, 1.0, 1.0);

    var list = this.chunkList, ln = list.length;
    for (var ci = 0; ci < ln; ci++) {
      var rec = list[ci];
      var dx = rec.cxs - camX, dy = rec.cys - camY, dz = rec.czs - camZ;
      if (dx * dx + dy * dy + dz * dz > maxDist2) continue;
      if (!boxInFrustum(planes, rec.x0, rec.y0, rec.z0, rec.x1, rec.y1, rec.z1)) continue;
      var g = rec.gpuOpaque;
      if (g && g.count) {
        gl.bindVertexArray(g.vao);
        gl.drawElements(gl.TRIANGLES, g.count, gl.UNSIGNED_INT, 0);
        st.drawCalls++; st.chunksDrawn++; st.verts += g.verts;
      }
      if (rec.gpuTrans && rec.gpuTrans.count) {
        if (n >= pool.length) pool.push({ rec: null, d: 0 });
        pool[n].rec = rec;
        pool[n].d = dx * dx + dy * dy + dz * dz;
        n++;
      }
    }
    this._sortN = n;

    /* ---- dropped item cubes ------------------------------------------ *
     * The opaque bucket draws with the chunk uniforms still in place: depth
     * write on, blend off, cull on -- so items occlude and get occluded by
     * terrain exactly like blocks do. */
    var items = state.items, itemTrans = null;
    if (items) {
      if (items.opaque && items.opaque.indices && items.opaque.indices.length) {
        this._drawItems(items.opaque);
      }
      if (items.trans && items.trans.indices && items.trans.indices.length) {
        itemTrans = items.trans;
      }
    }

    /* ------------- transparent pass: far -> near, no depth write ------ */
    if (n > 0 || itemTrans) {
      /* insertion sort on a fixed pool: no allocation, tiny n */
      for (var i2 = 1; i2 < n; i2++) {
        var cur = pool[i2], j2 = i2 - 1;
        while (j2 >= 0 && pool[j2].d < cur.d) { pool[j2 + 1] = pool[j2]; j2--; }
        pool[j2 + 1] = cur;
      }
      gl.useProgram(chunk.p);
      gl.bindVertexArray(null);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.uniform1f(chunk.u.uAlphaTest, 0.0);
      gl.uniform1f(chunk.u.uShimmer, 1.0);
      if (underwater) gl.uniform3f(chunk.u.uTint, 0.62, 0.80, 1.10);
      else gl.uniform3f(chunk.u.uTint, 1.0, 1.0, 1.0);
      for (var k2 = 0; k2 < n; k2++) {
        var gt = pool[k2].rec.gpuTrans;
        gl.bindVertexArray(gt.vao);
        gl.drawElements(gl.TRIANGLES, gt.count, gl.UNSIGNED_INT, 0);
        st.drawCalls++; st.chunksDrawn++; st.verts += gt.verts;
      }
      /* glass / water items blend last: they are tiny and sit in front of the
       * terrain they hover over, and depthMask stays off so they never punch
       * a hole in the depth buffer. */
      if (itemTrans) this._drawItems(itemTrans);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(null);
    }

    /* --------------------------- particles --------------------------- */
    var parts = state.particles;
    if (parts && parts.length) {
      var count = parts.length;
      var need = count * 7;
      if (this._partScratch.length < need) this._partScratch = new Float32Array(need * 2);
      var arr = this._partScratch;
      for (var pi = 0; pi < count; pi++) {
        var p = parts[pi], o = pi * 7;
        arr[o] = p.pos[0]; arr[o + 1] = p.pos[1]; arr[o + 2] = p.pos[2];
        arr[o + 3] = p.color[0]; arr[o + 4] = p.color[1]; arr[o + 5] = p.color[2];
        arr[o + 6] = p.size === undefined ? 0.08 : p.size;
      }
      var part = this.progs.part;
      gl.useProgram(part.p);
      gl.bindVertexArray(this._partVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, this._partBuf);
      if (this._partCap < this._partScratch.length) {
        gl.bufferData(gl.ARRAY_BUFFER, this._partScratch, gl.DYNAMIC_DRAW);
        this._partCap = this._partScratch.length;
      }
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, arr, 0, need);
      gl.uniformMatrix4fv(part.u.uViewProj, false, vp);
      gl.uniform3f(part.u.uCamPos, camX, camY, camZ);
      gl.uniform3f(part.u.uFogColor, fogR, fogG, fogB);
      gl.uniform1f(part.u.uFogStart, fogStart);
      gl.uniform1f(part.u.uFogEnd, fogEnd);
      gl.uniform1f(part.u.uPixelScale, h / (2 * Math.tan(fov * 0.5)));
      gl.depthMask(false);
      gl.drawArrays(gl.POINTS, 0, count);
      st.drawCalls++;
      gl.depthMask(true);
      gl.bindVertexArray(null);
    }

    /* ------------------------ block highlight ------------------------ */
    var hl = state.highlight;
    if (hl && hl.block) {
      var line = this.progs.line;
      gl.useProgram(line.p);
      gl.bindVertexArray(this._lineVAO);
      gl.uniformMatrix4fv(line.u.uViewProj, false, vp);
      gl.depthMask(false);
      var bx = hl.block[0], by = hl.block[1], bz = hl.block[2];
      var m = this._model;
      MC.M4.identity(m);
      var s = 1.002;
      m[0] = s; m[5] = s; m[10] = s;
      m[12] = bx + 0.5; m[13] = by + 0.5; m[14] = bz + 0.5;
      gl.uniformMatrix4fv(line.u.uModel, false, m);
      gl.uniform4f(line.u.uColor, 0.02, 0.02, 0.02, 1.0);
      gl.drawArrays(gl.LINES, 0, 24);
      st.drawCalls++;
      var prog = hl.progress || 0;
      if (prog > 0.01) {
        var s2 = 0.06 + prog * 0.9;
        m[0] = s2; m[5] = s2; m[10] = s2;
        gl.uniformMatrix4fv(line.u.uModel, false, m);
        gl.uniform4f(line.u.uColor, 0.05, 0.05, 0.05, 1.0);
        gl.drawArrays(gl.LINES, 0, 24);
        st.drawCalls++;
      }
      gl.depthMask(true);
      gl.bindVertexArray(null);
    }


  };

  MC.Renderer.prototype.dispose = function () {
    if (this.disposed) return;
    this.disposed = true;
    var self = this;
    this.canvas.removeEventListener('webglcontextlost', this._onLost, false);
    this.canvas.removeEventListener('webglcontextrestored', this._onRestored, false);
    var gl = this.gl;
    if (gl) {
      this.chunks.forEach(function (rec) { self._freeGpu(rec.gpuOpaque); self._freeGpu(rec.gpuTrans); });
      this.chunks.clear();
      this.chunkList.length = 0;
      var p = this.progs;
      if (p) {
        gl.deleteProgram(p.chunk.p); gl.deleteProgram(p.sky.p);
        gl.deleteProgram(p.part.p); gl.deleteProgram(p.line.p);
      }
      if (this.atlasTex) gl.deleteTexture(this.atlasTex);
      if (this._skyVAO) gl.deleteVertexArray(this._skyVAO);
      if (this._lineVAO) gl.deleteVertexArray(this._lineVAO);
      if (this._lineVBO) gl.deleteBuffer(this._lineVBO);
      if (this._partVAO) gl.deleteVertexArray(this._partVAO);
      if (this._partBuf) gl.deleteBuffer(this._partBuf);
      if (this._itemVAO) gl.deleteVertexArray(this._itemVAO);
      if (this._itemBuf) gl.deleteBuffer(this._itemBuf);
      if (this._itemIdx) gl.deleteBuffer(this._itemIdx);
    }
    this.progs = null;
    this.atlasTex = null;
    this.gl = null;
    this.contextLost = true;
  };
})(typeof window !== 'undefined' ? window : globalThis);
