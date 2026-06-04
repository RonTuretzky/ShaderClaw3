// ============================================================
// ShaderClaw — WebGL Renderer (ISF + Compositor)
// ============================================================

function _tryGetWebGL(canvas) {
  const isMobile = window.innerWidth <= 900 || /Mobi|Android|iPhone/i.test(navigator.userAgent);
  const power = isMobile ? 'default' : 'high-performance';
  return canvas.getContext('webgl', { antialias: false, preserveDrawingBuffer: true, powerPreference: power, failIfMajorPerformanceCaveat: false })
      || canvas.getContext('webgl', { antialias: false, preserveDrawingBuffer: true, failIfMajorPerformanceCaveat: false })
      || canvas.getContext('experimental-webgl', { antialias: false, preserveDrawingBuffer: true });
}

async function _getWebGLWithRetry(canvas, maxRetries, dbg) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const gl = _tryGetWebGL(canvas);
    if (gl) return gl;
    if (dbg) dbg('WebGL attempt ' + (attempt + 1) + ' failed, retrying in ' + (500 * (attempt + 1)) + 'ms...');
    await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
  }
  return null;
}

// Static blend mode map (avoid per-frame allocation in renderCompositor)
const _BLEND_MODE_MAP = { normal: 0, add: 1, multiply: 2, screen: 3, overlay: 4 };

class Renderer {
  constructor(canvas, gl) {
    this.canvas = canvas;
    this.gl = gl;
    if (!this.gl) throw new Error('WebGL not supported — close other tabs and refresh');
    this.program = null;
    this.uniformLocs = {};
    this.inputValues = {};
    this.startTime = performance.now();
    this.frameIndex = 0;
    this._videoFrameStamp = 0; // incremented each frame to deduplicate video uploads
    this.playing = true;
    this.animId = null;
    this.textures = {}; // name → { glTexture, isVideo, element }
    this._bgProgram = null;
    this._bgUniformLocs = {};
    // Mouse state for interactive shaders
    this.mousePos = [0.5, 0.5];
    this.mouseDelta = [0, 0];
    this.mouseDown = 0;
    this.pinchHold = 0;
    this.pinchHold2 = 0;
    this._lastMousePos = [0.5, 0.5];
    this._initGeometry();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    // Default 1x1 black texture (avoids sampling null)
    this._defaultTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._defaultTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0,0,0,255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  // Start async video frame capture using requestVideoFrameCallback
  // Pre-renders decoded frames to an offscreen canvas so texImage2D is instant
  startVideoCapture(tex) {
    if (tex._captureStarted) return;
    const v = tex.element;
    if (!v || !v.requestVideoFrameCallback) return; // fallback: direct upload
    tex._captureStarted = true;
    if (!tex._captureCanvas) {
      tex._captureCanvas = document.createElement('canvas');
      tex._captureCtx = tex._captureCanvas.getContext('2d', { willReadFrequently: false });
    }
    const loop = () => {
      if (!tex.element) return; // disposed
      const vw = v.videoWidth || 640, vh = v.videoHeight || 480;
      const fc = tex._captureCanvas;
      if (fc.width !== vw || fc.height !== vh) { fc.width = vw; fc.height = vh; }
      const ctx = tex._captureCtx;
      if (tex.flipH || tex.flipV) {
        ctx.save();
        ctx.translate(tex.flipH ? fc.width : 0, tex.flipV ? fc.height : 0);
        ctx.scale(tex.flipH ? -1 : 1, tex.flipV ? -1 : 1);
        ctx.drawImage(v, 0, 0);
        ctx.restore();
      } else {
        ctx.drawImage(v, 0, 0);
      }
      tex._captureReady = true;
      v.requestVideoFrameCallback(loop);
    };
    v.requestVideoFrameCallback(loop);
  }

  // Upload a video texture only once per frame (avoids redundant texImage2D calls)
  _uploadVideoTex(tex) {
    if (tex._lastUploadFrame === this._videoFrameStamp) return; // already uploaded this frame
    const gl = this.gl;

    // Fast path: use pre-captured canvas from requestVideoFrameCallback
    if (tex._captureReady && tex._captureCanvas) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tex._captureCanvas);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      tex._lastUploadFrame = this._videoFrameStamp;
      return;
    }

    // Fallback: direct upload (browsers without requestVideoFrameCallback)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    if (tex.flipH || tex.flipV) {
      if (!tex._flipCanvas) { tex._flipCanvas = document.createElement('canvas'); tex._flipCtx = tex._flipCanvas.getContext('2d'); }
      const v = tex.element, fc = tex._flipCanvas;
      const vw = v.videoWidth || v.width || 640;
      const vh = v.videoHeight || v.height || 480;
      if (fc.width !== vw || fc.height !== vh) { fc.width = vw; fc.height = vh; }
      const ctx = tex._flipCtx;
      ctx.save();
      ctx.translate(tex.flipH ? fc.width : 0, tex.flipV ? fc.height : 0);
      ctx.scale(tex.flipH ? -1 : 1, tex.flipV ? -1 : 1);
      ctx.drawImage(v, 0, 0);
      ctx.restore();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, fc);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, tex.element);
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    tex._lastUploadFrame = this._videoFrameStamp;
  }

  _initGeometry() {
    const gl = this.gl;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
    this.posBuf = buf;
  }

  resize() {
    // Cap DPR at 2 on mobile to prevent oversized canvases that kill GPU
    const isMobile = window.innerWidth <= 900 || /Mobi|Android|iPhone/i.test(navigator.userAgent);
    const dpr = Math.min(window.devicePixelRatio || 1, isMobile ? 2 : 3);
    const parent = this.canvas.parentElement;
    const pw = parent ? parent.clientWidth : 0;
    const ph = parent ? parent.clientHeight : 0;
    // Fallback to window size if parent has no dimensions yet (mobile layout race)
    const w = Math.round((pw || window.innerWidth) * dpr);
    const h = Math.round((ph || window.innerHeight) * dpr);
    if (w < 1 || h < 1) return; // skip if still no dimensions
    this.canvas.width = w;
    this.canvas.height = h;
    this.gl.viewport(0, 0, w, h);
  }

  // Reinitialize GL resources after context restore
  reinitGL() {
    const gl = this.gl;
    this._initGeometry();
    // Recreate default 1x1 black texture
    this._defaultTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._defaultTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0,0,0,255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.program = null;
    this.uniformLocs = {};
    this._ppFloatChecked = undefined; // re-check half-float support
    this.resize();
  }

  compile(vertSrc, fragSrc) {
    const gl = this.gl;
    const vs = this._compileShader(gl.VERTEX_SHADER, vertSrc);
    if (!vs.shader) return { ok: false, errors: 'Vertex: ' + vs.log };

    const fs = this._compileShader(gl.FRAGMENT_SHADER, fragSrc);
    if (!fs.shader) {
      gl.deleteShader(vs.shader);
      return { ok: false, errors: this._prettyErrors(fs.log) };
    }

    const prog = gl.createProgram();
    gl.attachShader(prog, vs.shader);
    gl.attachShader(prog, fs.shader);
    gl.bindAttribLocation(prog, 0, 'position');
    gl.linkProgram(prog);

    gl.deleteShader(vs.shader);
    gl.deleteShader(fs.shader);

    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      gl.deleteProgram(prog);
      return { ok: false, errors: 'Link: ' + log };
    }

    if (this.program) gl.deleteProgram(this.program);
    this.program = prog;
    this.uniformLocs = {};
    return { ok: true, errors: null };
  }

  _compileShader(type, src) {
    const gl = this.gl;
    if (gl.isContextLost()) return { shader: null, log: 'WebGL context lost' };
    const s = gl.createShader(type);
    if (!s) return { shader: null, log: 'WebGL context lost (createShader returned null)' };
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      return { shader: null, log };
    }
    return { shader: s, log: null };
  }

  _prettyErrors(log) {
    if (!log) return '';
    const headerLines = this._headerLines || 14;
    return log.replace(/ERROR:\s*\d+:(\d+)/g, (m, line) => {
      const adjusted = Math.max(1, parseInt(line) - headerLines);
      return `Line ${adjusted}`;
    });
  }

  _getLoc(name) {
    if (!(name in this.uniformLocs)) {
      this.uniformLocs[name] = this.gl.getUniformLocation(this.program, name);
    }
    return this.uniformLocs[name];
  }

  _getBgLoc(name) {
    if (!(name in this._bgUniformLocs)) {
      this._bgUniformLocs[name] = this.gl.getUniformLocation(this._bgProgram, name);
    }
    return this._bgUniformLocs[name];
  }

  compileBg(vertSrc, fragSrc) {
    const gl = this.gl;
    if (this._bgProgram) { gl.deleteProgram(this._bgProgram); this._bgProgram = null; }
    this._bgUniformLocs = {};
    if (!fragSrc) return { ok: true }; // clearing bg

    const vs = this._compileShader(gl.VERTEX_SHADER, vertSrc);
    if (!vs.shader) return { ok: false, errors: 'BG Vertex: ' + vs.log };
    const fs = this._compileShader(gl.FRAGMENT_SHADER, fragSrc);
    if (!fs.shader) { gl.deleteShader(vs.shader); return { ok: false, errors: 'BG: ' + fs.log }; }
    const prog = gl.createProgram();
    gl.attachShader(prog, vs.shader);
    gl.attachShader(prog, fs.shader);
    gl.bindAttribLocation(prog, 0, 'position');
    gl.linkProgram(prog);
    gl.deleteShader(vs.shader);
    gl.deleteShader(fs.shader);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      gl.deleteProgram(prog);
      return { ok: false, errors: 'BG Link failed' };
    }
    this._bgProgram = prog;
    return { ok: true };
  }

  _renderBg() {
    const gl = this.gl;
    if (!this._bgProgram) return;

    gl.useProgram(this._bgProgram);
    const elapsed = (performance.now() - this.startTime) / 1000;
    const tLoc = this._getBgLoc('TIME');
    if (tLoc) gl.uniform1f(tLoc, elapsed);
    const rLoc = this._getBgLoc('RENDERSIZE');
    if (rLoc) gl.uniform2f(rLoc, this.canvas.width, this.canvas.height);
    const pLoc = this._getBgLoc('PASSINDEX');
    if (pLoc) gl.uniform1i(pLoc, 0);
    const fLoc = this._getBgLoc('FRAMEINDEX');
    if (fLoc) gl.uniform1i(fLoc, this.frameIndex);

    // Set bg shader's own input defaults (stored on renderer)
    if (this._bgInputValues) {
      const bgKeys = Object.keys(this._bgInputValues);
      for (let bk = 0; bk < bgKeys.length; bk++) {
        const name = bgKeys[bk];
        const val = this._bgInputValues[name];
        const loc = this._getBgLoc(name);
        if (!loc) continue;
        if (typeof val === 'number') gl.uniform1f(loc, val);
        else if (typeof val === 'boolean') gl.uniform1i(loc, val ? 1 : 0);
        else if (Array.isArray(val)) {
          if (val.length === 2) gl.uniform2f(loc, val[0], val[1]);
          else if (val.length === 4) gl.uniform4f(loc, val[0], val[1], val[2], val[3]);
        }
      }
    }

    // Audio uniforms for bg shader
    if (audioFFTGLTexture) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, audioFFTGLTexture);
      const aLoc = this._getBgLoc('audioFFT');
      if (aLoc) gl.uniform1i(aLoc, 0);
    }
    const bgAl = this._getBgLoc('audioLevel');
    if (bgAl) gl.uniform1f(bgAl, audioLevel);
    const bgAb = this._getBgLoc('audioBass');
    if (bgAb) gl.uniform1f(bgAb, audioBass);
    const bgAm = this._getBgLoc('audioMid');
    if (bgAm) gl.uniform1f(bgAm, audioMid);
    const bgAh = this._getBgLoc('audioHigh');
    if (bgAh) gl.uniform1f(bgAh, audioHigh);
    // Advanced audio uniforms
    const bgBh = this._getBgLoc('audioBassHit'); if (bgBh) gl.uniform1f(bgBh, typeof audioBassHit !== 'undefined' ? audioBassHit : 0);
    const bgMh = this._getBgLoc('audioMidHit');  if (bgMh) gl.uniform1f(bgMh, typeof audioMidHit !== 'undefined' ? audioMidHit : 0);
    const bgHh = this._getBgLoc('audioHighHit'); if (bgHh) gl.uniform1f(bgHh, typeof audioHighHit !== 'undefined' ? audioHighHit : 0);
    const bgBt = this._getBgLoc('audioBassTime'); if (bgBt) gl.uniform1f(bgBt, typeof audioBassTime !== 'undefined' ? audioBassTime : 0);
    const bgMt = this._getBgLoc('audioMidTime');  if (bgMt) gl.uniform1f(bgMt, typeof audioMidTime !== 'undefined' ? audioMidTime : 0);
    const bgHt = this._getBgLoc('audioHighTime'); if (bgHt) gl.uniform1f(bgHt, typeof audioHighTime !== 'undefined' ? audioHighTime : 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  render() {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    if (!this.program) return;

    // Render background shader first (if set)
    if (this._bgProgram) {
      gl.disable(gl.BLEND);
      this._renderBg();
      // Now enable blending so foreground composites on top
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    } else {
      gl.disable(gl.BLEND);
    }

    gl.useProgram(this.program);

    const elapsed = (performance.now() - this.startTime) / 1000;
    const timeLoc = this._getLoc('TIME');
    if (timeLoc) gl.uniform1f(timeLoc, elapsed);

    const resLoc = this._getLoc('RENDERSIZE');
    if (resLoc) gl.uniform2f(resLoc, this.canvas.width, this.canvas.height);

    const piLoc = this._getLoc('PASSINDEX');
    if (piLoc) gl.uniform1i(piLoc, 0);

    const fiLoc = this._getLoc('FRAMEINDEX');
    if (fiLoc) gl.uniform1i(fiLoc, this.frameIndex);

    const inputKeys = Object.keys(this.inputValues);
    for (let ik = 0; ik < inputKeys.length; ik++) {
      const name = inputKeys[ik];
      const val = this.inputValues[name];
      const loc = this._getLoc(name);
      if (!loc) continue;
      if (typeof val === 'number') gl.uniform1f(loc, val);
      else if (typeof val === 'boolean') gl.uniform1i(loc, val ? 1 : 0);
      else if (Array.isArray(val)) {
        if (val.length === 2) gl.uniform2f(loc, val[0], val[1]);
        else if (val.length === 4) gl.uniform4f(loc, val[0], val[1], val[2], val[3]);
      }
    }

    // Bind textures
    let texUnit = 0;
    const texKeys = Object.keys(this.textures);
    for (let tk = 0; tk < texKeys.length; tk++) {
      const name = texKeys[tk];
      const tex = this.textures[name];
      gl.activeTexture(gl.TEXTURE0 + texUnit);
      gl.bindTexture(gl.TEXTURE_2D, tex.glTexture);
      // Auto-resume paused videos
      if (tex.isVideo && tex.element && tex.element.paused && tex.element.loop && !tex.element.ended) {
        tex.element.play().catch(() => {});
      }
      if (tex.isVideo && tex.element && !tex._isNdi && (tex.element.readyState >= 2 || tex.element instanceof HTMLCanvasElement)) {
        this._uploadVideoTex(tex);
      }
      gl.uniform1i(this._getLoc(name), texUnit);
      // Set IMG_SIZE_<name> for ISF image inputs
      const sizeLoc = this._getLoc('IMG_SIZE_' + name);
      if (sizeLoc) {
        const el = tex.element;
        const w = el ? (el.videoWidth || el.naturalWidth || el.width || 1) : 1;
        const h = el ? (el.videoHeight || el.naturalHeight || el.height || 1) : 1;
        gl.uniform2f(sizeLoc, w, h);
      }
      texUnit++;
    }

    // Audio-reactive uniforms
    updateAudioUniforms(gl);
    const fftLocComp = this._getLoc('audioFFT');
    if (audioFFTGLTexture && fftLocComp) {
      gl.activeTexture(gl.TEXTURE0 + texUnit);
      gl.bindTexture(gl.TEXTURE_2D, audioFFTGLTexture);
      gl.uniform1i(fftLocComp, texUnit);
      texUnit++;
    }
    const alLoc = this._getLoc('audioLevel');
    if (alLoc) gl.uniform1f(alLoc, audioLevel);
    const abLoc = this._getLoc('audioBass');
    if (abLoc) gl.uniform1f(abLoc, audioBass);
    const amLoc = this._getLoc('audioMid');
    if (amLoc) gl.uniform1f(amLoc, audioMid);
    const ahLoc = this._getLoc('audioHigh');
    if (ahLoc) gl.uniform1f(ahLoc, audioHigh);
    // Advanced audio uniforms
    const bh2 = this._getLoc('audioBassHit'); if (bh2) gl.uniform1f(bh2, typeof audioBassHit !== 'undefined' ? audioBassHit : 0);
    const mh2 = this._getLoc('audioMidHit');  if (mh2) gl.uniform1f(mh2, typeof audioMidHit !== 'undefined' ? audioMidHit : 0);
    const hh2 = this._getLoc('audioHighHit'); if (hh2) gl.uniform1f(hh2, typeof audioHighHit !== 'undefined' ? audioHighHit : 0);
    const bt2 = this._getLoc('audioBassTime'); if (bt2) gl.uniform1f(bt2, typeof audioBassTime !== 'undefined' ? audioBassTime : 0);
    const mt2 = this._getLoc('audioMidTime');  if (mt2) gl.uniform1f(mt2, typeof audioMidTime !== 'undefined' ? audioMidTime : 0);
    const ht2 = this._getLoc('audioHighTime'); if (ht2) gl.uniform1f(ht2, typeof audioHighTime !== 'undefined' ? audioHighTime : 0);

    // Variable font texture (for Text shader effects 20 + 22)
    const vfLoc = this._getLoc('varFontTex');
    if (vfLoc) {
      const _effectIdx = Math.round(this.inputValues['effect'] || 0);
      if (_effectIdx === 22) {
        updateBreathingTexture(gl, this.inputValues);
      } else {
        updateVarFontTexture(gl, this.inputValues);
      }
      if (_vfGLTexture) {
        gl.activeTexture(gl.TEXTURE0 + texUnit);
        gl.bindTexture(gl.TEXTURE_2D, _vfGLTexture);
        gl.uniform1i(vfLoc, texUnit);
        texUnit++;
      }
    }

    // Font atlas texture — always enabled to avoid 26-branch charData() in shader
    const _useFontAtlasLoc = this._getLoc('useFontAtlas');
    if (_useFontAtlasLoc) gl.uniform1f(_useFontAtlasLoc, 1.0);
    updateFontAtlas(gl, this.inputValues);
    if (_fontAtlasGLTexture) {
      const faLoc = this._getLoc('fontAtlasTex');
      if (faLoc) {
        gl.activeTexture(gl.TEXTURE0 + texUnit);
        gl.bindTexture(gl.TEXTURE_2D, _fontAtlasGLTexture);
        gl.uniform1i(faLoc, texUnit);
        texUnit++;
      }
    }

    // Global mask texture
    const _maskModeLoc = this._getLoc('_maskMode');
    if (_maskModeLoc) gl.uniform1f(_maskModeLoc, _maskMode);
    const _maskFlipLoc = this._getLoc('_maskFlip');
    const _maskFlipVLoc = this._getLoc('_maskFlipV');
    if (_maskFlipLoc) gl.uniform1f(_maskFlipLoc, 0.0);
    if (_maskFlipVLoc) gl.uniform1f(_maskFlipVLoc, 0.0);
    if (_maskMediaId && _maskMode > 0) {
      const maskMedia = mediaInputs.find(m => String(m.id) === String(_maskMediaId));
      if (maskMedia && maskMedia.glTexture) {
        gl.activeTexture(gl.TEXTURE0 + texUnit);
        gl.bindTexture(gl.TEXTURE_2D, maskMedia.glTexture);
        if (maskMedia.type === 'video' && maskMedia.element && maskMedia.element.readyState >= 2) {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, maskMedia.element);
        }
        if (_maskFlipLoc && maskMedia._webcamFlip) gl.uniform1f(_maskFlipLoc, 1.0);
        if (_maskFlipVLoc && maskMedia._webcamFlipV) gl.uniform1f(_maskFlipVLoc, 1.0);
        gl.uniform1i(this._getLoc('_maskTex'), texUnit);
        texUnit++;
      }
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    this.frameIndex++;
  }

  start() {
    if (this.playing && this.animId) return;
    this.playing = true;
    const loop = () => {
      if (!this.playing) return;
      this.render();
      this.animId = requestAnimationFrame(loop);
    };
    loop();
  }

  stop() {
    this.playing = false;
    if (this.animId) cancelAnimationFrame(this.animId);
    this.animId = null;
  }

  togglePlay() {
    if (this.playing) this.stop();
    else this.start();
    return this.playing;
  }

  resetTime() {
    this.startTime = performance.now();
    this.frameIndex = 0;
  }

  // ===== LAYER COMPOSITION EXTENSIONS =====

  createFBO(w, h) {
    const gl = this.gl;
    // Clamp to GPU max texture size (mobile GPUs may be 2048 or 4096)
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
    if (w > maxTex) w = maxTex;
    if (h > maxTex) h = maxTex;
    const fbo = gl.createFramebuffer();
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, texture: tex, width: w, height: h };
  }

  createPingPongFBO(w, h) {
    // Check half-float FBO support once (needed for simulations with negative values)
    if (this._ppFloatChecked === undefined) {
      this._ppFloatChecked = true;
      this._halfFloatExt = this.gl.getExtension('OES_texture_half_float');
      this._halfFloatLinear = this.gl.getExtension('OES_texture_half_float_linear');
      this.gl.getExtension('EXT_color_buffer_half_float');
      this._useHalfFloat = false;
      if (this._halfFloatExt) {
        const test = this._createHalfFloatFBO(4, 4);
        if (test) {
          this._useHalfFloat = true;
          this.gl.deleteTexture(test.texture);
          this.gl.deleteFramebuffer(test.fbo);
          console.log('[ShaderClaw] Half-float FBOs: OK' + (this._halfFloatLinear ? ' (LINEAR filtering)' : ' (NEAREST only)'));
        } else {
          console.warn('[ShaderClaw] Half-float FBOs: not renderable — falling back to UNSIGNED_BYTE');
        }
      } else {
        console.warn('[ShaderClaw] OES_texture_half_float not available — using UNSIGNED_BYTE FBOs');
      }
    }
    if (this._useHalfFloat) {
      return { a: this._createHalfFloatFBO(w, h), b: this._createHalfFloatFBO(w, h), current: 0 };
    }
    return { a: this.createFBO(w, h), b: this.createFBO(w, h), current: 0 };
  }

  _createHalfFloatFBO(w, h) {
    const gl = this.gl;
    // Clamp to GPU max texture size
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
    if (w > maxTex) w = maxTex;
    if (h > maxTex) h = maxTex;
    const fbo = gl.createFramebuffer();
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, this._halfFloatExt.HALF_FLOAT_OES, null);
    const filter = this._halfFloatLinear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteTexture(tex);
      gl.deleteFramebuffer(fbo);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return null;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, texture: tex, width: w, height: h };
  }

  destroyFBO(fboObj) {
    if (!fboObj) return;
    const gl = this.gl;
    if (fboObj.texture) gl.deleteTexture(fboObj.texture);
    if (fboObj.fbo) gl.deleteFramebuffer(fboObj.fbo);
  }

  destroyPingPongFBO(pp) {
    if (!pp) return;
    this.destroyFBO(pp.a);
    this.destroyFBO(pp.b);
  }

  compileForLayer(layer, vertSrc, fragSrc, precompiledProg) {
    const gl = this.gl;
    if (gl.isContextLost()) return { ok: false, errors: 'WebGL context lost' };
    let prog;
    if (precompiledProg) {
      prog = precompiledProg;
    } else {
      const vs = this._compileShader(gl.VERTEX_SHADER, vertSrc);
      if (!vs.shader) return { ok: false, errors: 'Vertex: ' + vs.log };
      const fs = this._compileShader(gl.FRAGMENT_SHADER, fragSrc);
      if (!fs.shader) { gl.deleteShader(vs.shader); return { ok: false, errors: this._prettyErrors(fs.log) }; }
      prog = gl.createProgram();
      gl.attachShader(prog, vs.shader);
      gl.attachShader(prog, fs.shader);
      gl.bindAttribLocation(prog, 0, 'position');
      gl.linkProgram(prog);
      gl.deleteShader(vs.shader);
      gl.deleteShader(fs.shader);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(prog);
        gl.deleteProgram(prog);
        return { ok: false, errors: 'Link: ' + log };
      }
    }
    if (layer.program && layer.program !== prog) gl.deleteProgram(layer.program);
    layer.program = prog;
    layer.uniformLocs = {};
    return { ok: true, errors: null };
  }

  // Async shader compilation using KHR_parallel_shader_compile
  startAsyncCompile(vertSrc, fragSrc) {
    const gl = this.gl;
    if (gl.isContextLost()) return null;
    if (this._parallelExt === undefined) this._parallelExt = gl.getExtension('KHR_parallel_shader_compile') || null;

    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, vertSrc);
    gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fragSrc);
    gl.compileShader(fs);

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'position');
    gl.linkProgram(prog);

    const ext = this._parallelExt;
    let _resolved = false;
    const self = this;

    return {
      program: prog,
      isReady() {
        if (_resolved) return true;
        if (ext && !gl.getProgramParameter(prog, ext.COMPLETION_STATUS_KHR)) return false;
        _resolved = true;
        return true;
      },
      finalize() {
        const errors = [];
        if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS))
          errors.push('Vertex: ' + gl.getShaderInfoLog(vs));
        if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS))
          errors.push('Fragment: ' + self._prettyErrors(gl.getShaderInfoLog(fs)));
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        if (errors.length) { gl.deleteProgram(prog); return { ok: false, errors: errors.join('\n') }; }
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
          const log = gl.getProgramInfoLog(prog);
          gl.deleteProgram(prog); return { ok: false, errors: 'Link: ' + log };
        }
        return { ok: true, program: prog };
      },
      dispose() { gl.deleteShader(vs); gl.deleteShader(fs); gl.deleteProgram(prog); }
    };
  }

  _getLayerLoc(layer, name) {
    if (!(name in layer.uniformLocs)) {
      layer.uniformLocs[name] = this.gl.getUniformLocation(layer.program, name);
    }
    return layer.uniformLocs[name];
  }

  renderLayerToFBO(layer, mediaPipeMgr) {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    if (!layer.program || !layer.fbo) return;
    if (!layer.visible) return;

    // Multi-pass branch
    if (layer.passes && layer.passes.length > 0) {
      this._renderMultiPass(layer, mediaPipeMgr);
      return;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.fbo.fbo);
    gl.viewport(0, 0, layer.fbo.width, layer.fbo.height);
    const bgC = layer._bgColor;
    gl.clearColor(bgC ? bgC[0] : 0, bgC ? bgC[1] : 0, bgC ? bgC[2] : 0, bgC ? 1 : 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.BLEND);

    gl.useProgram(layer.program);

    const elapsed = (performance.now() - this.startTime) / 1000;
    const tLoc = this._getLayerLoc(layer, 'TIME');
    if (tLoc) gl.uniform1f(tLoc, elapsed);
    const rLoc = this._getLayerLoc(layer, 'RENDERSIZE');
    if (rLoc) gl.uniform2f(rLoc, layer.fbo.width, layer.fbo.height);
    const piLoc = this._getLayerLoc(layer, 'PASSINDEX');
    if (piLoc) gl.uniform1i(piLoc, 0);
    const fiLoc = this._getLayerLoc(layer, 'FRAMEINDEX');
    if (fiLoc) gl.uniform1i(fiLoc, this.frameIndex);

    // Transparent background flag
    const tbLoc = this._getLayerLoc(layer, '_transparentBg');
    if (tbLoc) gl.uniform1f(tbLoc, layer.transparentBg ? 1.0 : 0.0);

    // Voice decay glitch amount
    const vgLoc = this._getLayerLoc(layer, '_voiceGlitch');
    if (vgLoc) gl.uniform1f(vgLoc, layer._voiceGlitch || 0.0);

    // Resolve MediaPipe bindings before setting input values
    if (layer.mpBindings && layer.mpBindings.length > 0) {
      resolveBindings(layer, mediaPipeMgr, this);
    }

    // Set layer input values
    const layerInputKeys = Object.keys(layer.inputValues || {});
    for (let ik = 0; ik < layerInputKeys.length; ik++) {
      const name = layerInputKeys[ik];
      const val = layer.inputValues[name];
      // bgColor uses #define trick — set _bgColorSolid instead
      if (name === 'bgColor') {
        const solidLoc = this._getLayerLoc(layer, '_bgColorSolid');
        if (solidLoc && Array.isArray(val)) gl.uniform4f(solidLoc, val[0], val[1], val[2], val[3]);
        continue;
      }
      const loc = this._getLayerLoc(layer, name);
      if (!loc) continue;
      if (typeof val === 'number') gl.uniform1f(loc, val);
      else if (typeof val === 'boolean') gl.uniform1i(loc, val ? 1 : 0);
      else if (Array.isArray(val)) {
        if (val.length === 2) gl.uniform2f(loc, val[0], val[1]);
        else if (val.length === 4) gl.uniform4f(loc, val[0], val[1], val[2], val[3]);
      }
    }

    // Direct msg uniform override for text layer — reads prominent bar value
    // and sets msg_0..msg_N every frame, bypassing inputValues
    if (layer.id === 'text') {
      if (!layer._msgBar) layer._msgBar = document.getElementById('text-msg-input');
      if (layer._msgBar) {
        if (!layer._msgInpCached) layer._msgInpCached = (layer.inputs || []).find(inp => inp.TYPE === 'text' && inp.NAME === 'msg');
        const msgInp = layer._msgInpCached;
        const maxLen = msgInp ? (msgInp.MAX_LENGTH || 24) : 24;
        const raw = layer._msgBar.value;
        if (raw !== layer._msgCached || maxLen !== layer._msgMaxLen) {
          layer._msgCached = raw;
          layer._msgMaxLen = maxLen;
          const str = raw.trim().toUpperCase();
          layer._msgCodes = new Float32Array(maxLen);
          for (let j = 0; j < maxLen; j++) {
            const ch = str[j];
            if (!ch) { layer._msgCodes[j] = 26; continue; }
            const code = ch.charCodeAt(0);
            if (code >= 65 && code <= 90) layer._msgCodes[j] = code - 65;       // A-Z → 0-25
            else if (code >= 48 && code <= 57) layer._msgCodes[j] = code - 48 + 27; // 0-9 → 27-36
            else layer._msgCodes[j] = 26; // space/other
          }
        }
        if (layer._msgCodes) {
          for (let j = 0; j < layer._msgCodes.length; j++) {
            const loc = this._getLayerLoc(layer, 'msg_' + j);
            if (loc) gl.uniform1f(loc, layer._msgCodes[j]);
          }
          const lenLoc = this._getLayerLoc(layer, 'msg_len');
          if (lenLoc) gl.uniform1f(lenLoc, raw.trim().replace(/\s+$/, '').length);
        }
      }
    }

    // Bind layer textures
    let texUnit = 0;
    const layerTexKeys = Object.keys(layer.textures || {});
    for (let tk = 0; tk < layerTexKeys.length; tk++) {
      const name = layerTexKeys[tk];
      const tex = layer.textures[name];
      gl.activeTexture(gl.TEXTURE0 + texUnit);
      gl.bindTexture(gl.TEXTURE_2D, tex.glTexture);
      // Auto-resume paused videos (Chrome can pause offscreen/background videos)
      if (tex.isVideo && tex.element && tex.element.paused && tex.element.loop && !tex.element.ended) {
        tex.element.play().catch(() => {});
      }
      if (tex.isVideo && tex.element && !tex._isNdi && (tex.element.readyState >= 2 || tex.element instanceof HTMLCanvasElement)) {
        this._uploadVideoTex(tex);
      }
      gl.uniform1i(this._getLayerLoc(layer, name), texUnit);
      // Set IMG_SIZE_<name> for ISF image inputs
      const imgSzLoc2 = this._getLayerLoc(layer, 'IMG_SIZE_' + name);
      if (imgSzLoc2) {
        const el = tex.element;
        const w = el ? (el.videoWidth || el.naturalWidth || el.width || 1) : 1;
        const h = el ? (el.videoHeight || el.naturalHeight || el.height || 1) : 1;
        gl.uniform2f(imgSzLoc2, w, h);
      }
      texUnit++;
    }

    // bgColor texture uniforms (_bgTexActive, _bgTex)
    if (layer._hasBgColor) {
      // Update video/webcam bg texture each frame
      const bgSrc = layer._bgSource;
      if (bgSrc && bgSrc.isVideo && bgSrc.element && layer._bgTexture) {
        gl.bindTexture(gl.TEXTURE_2D, layer._bgTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bgSrc.element);
      }
      const bgActiveLoc = this._getLayerLoc(layer, '_bgTexActive');
      if (bgActiveLoc) gl.uniform1f(bgActiveLoc, layer._bgTexture ? 1.0 : 0.0);
      const bgTexLoc = this._getLayerLoc(layer, '_bgTex');
      if (bgTexLoc) {
        gl.activeTexture(gl.TEXTURE0 + texUnit);
        gl.bindTexture(gl.TEXTURE_2D, layer._bgTexture || this._defaultTex);
        gl.uniform1i(bgTexLoc, texUnit);
        texUnit++;
      }
    }

    // Bind extras (audio, font, mediapipe) and draw
    texUnit = this._bindLayerExtras(layer, mediaPipeMgr, texUnit);

    // Mouse uniforms — hand-as-mouse override when enabled
    let mx = this.mousePos[0], my = this.mousePos[1];
    let mdx = this.mouseDelta[0], mdy = this.mouseDelta[1];
    let mdown = this.mouseDown;
    if (layer.handAsMouse && mediaPipeMgr && mediaPipeMgr.active && mediaPipeMgr.handCount > 0) {
      const hx = 1.0 - mediaPipeMgr.handPos[0]; // mirror X to match flipped webcam
      const hy = mediaPipeMgr.handPos[1];
      mdx = hx - (layer._prevHandX ?? hx);
      mdy = hy - (layer._prevHandY ?? hy);
      layer._prevHandX = hx;
      layer._prevHandY = hy;
      mx = hx;
      my = hy;
      mdown = mediaPipeMgr.isPinching ? 1.0 : 0.0;
    }
    const mousePLoc = this._getLayerLoc(layer, 'mousePos');
    if (mousePLoc) gl.uniform2f(mousePLoc, mx, my);
    const mouseDLoc = this._getLayerLoc(layer, 'mouseDelta');
    if (mouseDLoc) gl.uniform2f(mouseDLoc, mdx, mdy);
    const mouseDownLoc = this._getLayerLoc(layer, 'mouseDown');
    if (mouseDownLoc) gl.uniform1f(mouseDownLoc, mdown);
    const pinchHoldLoc = this._getLayerLoc(layer, 'pinchHold');
    if (pinchHoldLoc) gl.uniform1f(pinchHoldLoc, this.pinchHold);
    const pinchHold2Loc = this._getLayerLoc(layer, 'pinchHold2');
    if (pinchHold2Loc) gl.uniform1f(pinchHold2Loc, this.pinchHold2);
    const iaLoc = this._getLayerLoc(layer, 'inputActivity');
    if (iaLoc) gl.uniform1f(iaLoc, this.inputActivity || 0.0);

    // Bind feed textures (feedImage0..15, feedCount, feedProgress)
    if (this._feedTextures && this._feedTextures.length > 0) {
      for (let fi = 0; fi < Math.min(this._feedTextures.length, 16); fi++) {
        const ft = this._feedTextures[fi];
        if (!ft) continue;
        const loc = this._getLayerLoc(layer, 'feedImage' + fi);
        if (loc) {
          gl.activeTexture(gl.TEXTURE0 + texUnit);
          gl.bindTexture(gl.TEXTURE_2D, ft);
          gl.uniform1i(loc, texUnit);
          texUnit++;
        }
      }
      const fcLoc = this._getLayerLoc(layer, 'feedCount');
      if (fcLoc) gl.uniform1f(fcLoc, this._feedTextures.filter(Boolean).length);
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  // Shared helper: bind audio, font, mediapipe textures/uniforms. Returns next texUnit.
  _bindLayerExtras(layer, mediaPipeMgr, texUnit) {
    const gl = this.gl;
    // Audio uniforms
    updateAudioUniforms(gl);
    const fftLoc = this._getLayerLoc(layer, 'audioFFT');
    if (audioFFTGLTexture && fftLoc) {
      gl.activeTexture(gl.TEXTURE0 + texUnit);
      gl.bindTexture(gl.TEXTURE_2D, audioFFTGLTexture);
      gl.uniform1i(fftLoc, texUnit);
      texUnit++;
    }
    const alLoc = this._getLayerLoc(layer, 'audioLevel');
    if (alLoc) gl.uniform1f(alLoc, audioLevel);
    const abLoc = this._getLayerLoc(layer, 'audioBass');
    if (abLoc) gl.uniform1f(abLoc, audioBass);
    const amLoc = this._getLayerLoc(layer, 'audioMid');
    if (amLoc) gl.uniform1f(amLoc, audioMid);
    const ahLoc = this._getLayerLoc(layer, 'audioHigh');
    if (ahLoc) gl.uniform1f(ahLoc, audioHigh);
    // Advanced audio uniforms
    const bh3 = this._getLayerLoc(layer, 'audioBassHit'); if (bh3) gl.uniform1f(bh3, typeof audioBassHit !== 'undefined' ? audioBassHit : 0);
    const mh3 = this._getLayerLoc(layer, 'audioMidHit');  if (mh3) gl.uniform1f(mh3, typeof audioMidHit !== 'undefined' ? audioMidHit : 0);
    const hh3 = this._getLayerLoc(layer, 'audioHighHit'); if (hh3) gl.uniform1f(hh3, typeof audioHighHit !== 'undefined' ? audioHighHit : 0);
    const bt3 = this._getLayerLoc(layer, 'audioBassTime'); if (bt3) gl.uniform1f(bt3, typeof audioBassTime !== 'undefined' ? audioBassTime : 0);
    const mt3 = this._getLayerLoc(layer, 'audioMidTime');  if (mt3) gl.uniform1f(mt3, typeof audioMidTime !== 'undefined' ? audioMidTime : 0);
    const ht3 = this._getLayerLoc(layer, 'audioHighTime'); if (ht3) gl.uniform1f(ht3, typeof audioHighTime !== 'undefined' ? audioHighTime : 0);

    // Variable font texture (effects 20 + 22)
    const vfLoc = this._getLayerLoc(layer, 'varFontTex');
    if (vfLoc) {
      const _layerEffectIdx = Math.round((layer.inputValues || {})['effect'] || 0);
      if (_layerEffectIdx === 22) {
        updateBreathingTexture(gl, layer.inputValues || {});
      } else {
        updateVarFontTexture(gl, layer.inputValues || {});
      }
      if (_vfGLTexture) {
        gl.activeTexture(gl.TEXTURE0 + texUnit);
        gl.bindTexture(gl.TEXTURE_2D, _vfGLTexture);
        gl.uniform1i(vfLoc, texUnit);
        texUnit++;
      }
    }

    // Font atlas — always enabled to avoid 26-branch charData() in shader
    const _useFontAtlasLoc = this._getLayerLoc(layer, 'useFontAtlas');
    if (_useFontAtlasLoc) gl.uniform1f(_useFontAtlasLoc, 1.0);
    updateFontAtlas(gl, layer.inputValues || {});
    if (_fontAtlasGLTexture) {
      const faLoc = this._getLayerLoc(layer, 'fontAtlasTex');
      if (faLoc) {
        gl.activeTexture(gl.TEXTURE0 + texUnit);
        gl.bindTexture(gl.TEXTURE_2D, _fontAtlasGLTexture);
        gl.uniform1i(faLoc, texUnit);
        texUnit++;
      }
    }

    // MediaPipe uniforms
    if (mediaPipeMgr && mediaPipeMgr.active) {
      if (mediaPipeMgr.handTex) {
        gl.activeTexture(gl.TEXTURE0 + texUnit);
        gl.bindTexture(gl.TEXTURE_2D, mediaPipeMgr.handTex);
        gl.uniform1i(this._getLayerLoc(layer, 'mpHandLandmarks'), texUnit++);
      }
      if (mediaPipeMgr.faceTex) {
        gl.activeTexture(gl.TEXTURE0 + texUnit);
        gl.bindTexture(gl.TEXTURE_2D, mediaPipeMgr.faceTex);
        gl.uniform1i(this._getLayerLoc(layer, 'mpFaceLandmarks'), texUnit++);
      }
      if (mediaPipeMgr.poseTex) {
        gl.activeTexture(gl.TEXTURE0 + texUnit);
        gl.bindTexture(gl.TEXTURE_2D, mediaPipeMgr.poseTex);
        gl.uniform1i(this._getLayerLoc(layer, 'mpPoseLandmarks'), texUnit++);
      }
      if (mediaPipeMgr.segTex) {
        gl.activeTexture(gl.TEXTURE0 + texUnit);
        gl.bindTexture(gl.TEXTURE_2D, mediaPipeMgr.segTex);
        gl.uniform1i(this._getLayerLoc(layer, 'mpSegMask'), texUnit++);
      }
      const hcLoc = this._getLayerLoc(layer, 'mpHandCount');
      if (hcLoc) gl.uniform1f(hcLoc, mediaPipeMgr.handCount);
      const hpLoc = this._getLayerLoc(layer, 'mpHandPos');
      if (hpLoc) gl.uniform3f(hpLoc, mediaPipeMgr.handPos[0], mediaPipeMgr.handPos[1], mediaPipeMgr.handPos[2]);
      const hp2Loc = this._getLayerLoc(layer, 'mpHandPos2');
      if (hp2Loc) gl.uniform3f(hp2Loc, mediaPipeMgr.handPos2[0], mediaPipeMgr.handPos2[1], mediaPipeMgr.handPos2[2]);
    }

    return texUnit;
  }

  // Multi-pass rendering with persistent ping-pong buffers
  _renderMultiPass(layer, mediaPipeMgr) {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    gl.useProgram(layer.program);
    gl.disable(gl.BLEND);

    const elapsed = (performance.now() - this.startTime) / 1000;
    const tLoc = this._getLayerLoc(layer, 'TIME');
    if (tLoc) gl.uniform1f(tLoc, elapsed);
    const fiLoc = this._getLayerLoc(layer, 'FRAMEINDEX');
    if (fiLoc) gl.uniform1i(fiLoc, this.frameIndex);
    const tbLoc = this._getLayerLoc(layer, '_transparentBg');
    if (tbLoc) gl.uniform1f(tbLoc, layer.transparentBg ? 1.0 : 0.0);
    const vgLoc2 = this._getLayerLoc(layer, '_voiceGlitch');
    if (vgLoc2) gl.uniform1f(vgLoc2, layer._voiceGlitch || 0.0);

    // Mouse uniforms — hand-as-mouse override
    let mpMx = this.mousePos[0], mpMy = this.mousePos[1];
    let mpDx = this.mouseDelta[0], mpDy = this.mouseDelta[1];
    let mpDown = this.mouseDown;
    if (layer.handAsMouse && mediaPipeMgr && mediaPipeMgr.active && mediaPipeMgr.handCount > 0) {
      const hx = 1.0 - mediaPipeMgr.handPos[0]; // mirror X to match flipped webcam
      const hy = mediaPipeMgr.handPos[1];
      mpDx = hx - (layer._prevHandX ?? hx);
      mpDy = hy - (layer._prevHandY ?? hy);
      layer._prevHandX = hx;
      layer._prevHandY = hy;
      mpMx = hx;
      mpMy = hy;
      mpDown = mediaPipeMgr.isPinching ? 1.0 : 0.0;
    }
    const mousePLoc = this._getLayerLoc(layer, 'mousePos');
    if (mousePLoc) gl.uniform2f(mousePLoc, mpMx, mpMy);
    const mouseDLoc = this._getLayerLoc(layer, 'mouseDelta');
    if (mouseDLoc) gl.uniform2f(mouseDLoc, mpDx, mpDy);
    const mouseDownLoc = this._getLayerLoc(layer, 'mouseDown');
    if (mouseDownLoc) gl.uniform1f(mouseDownLoc, mpDown);
    const pinchHoldLoc2 = this._getLayerLoc(layer, 'pinchHold');
    if (pinchHoldLoc2) gl.uniform1f(pinchHoldLoc2, this.pinchHold);
    const pinchHold2Loc2 = this._getLayerLoc(layer, 'pinchHold2');
    if (pinchHold2Loc2) gl.uniform1f(pinchHold2Loc2, this.pinchHold2);
    const iaLoc2 = this._getLayerLoc(layer, 'inputActivity');
    if (iaLoc2) gl.uniform1f(iaLoc2, this.inputActivity || 0.0);

    // Audio uniforms for multi-pass shaders
    const mpAlLoc = this._getLayerLoc(layer, 'audioLevel'); if (mpAlLoc) gl.uniform1f(mpAlLoc, audioLevel);
    const mpAbLoc = this._getLayerLoc(layer, 'audioBass');  if (mpAbLoc) gl.uniform1f(mpAbLoc, audioBass);
    const mpAmLoc = this._getLayerLoc(layer, 'audioMid');   if (mpAmLoc) gl.uniform1f(mpAmLoc, audioMid);
    const mpAhLoc = this._getLayerLoc(layer, 'audioHigh');  if (mpAhLoc) gl.uniform1f(mpAhLoc, audioHigh);
    const mpBhLoc = this._getLayerLoc(layer, 'audioBassHit');  if (mpBhLoc) gl.uniform1f(mpBhLoc, typeof audioBassHit !== 'undefined' ? audioBassHit : 0);
    const mpMhLoc = this._getLayerLoc(layer, 'audioMidHit');   if (mpMhLoc) gl.uniform1f(mpMhLoc, typeof audioMidHit !== 'undefined' ? audioMidHit : 0);
    const mpHhLoc = this._getLayerLoc(layer, 'audioHighHit');  if (mpHhLoc) gl.uniform1f(mpHhLoc, typeof audioHighHit !== 'undefined' ? audioHighHit : 0);
    const mpBtLoc = this._getLayerLoc(layer, 'audioBassTime'); if (mpBtLoc) gl.uniform1f(mpBtLoc, typeof audioBassTime !== 'undefined' ? audioBassTime : 0);
    const mpMtLoc = this._getLayerLoc(layer, 'audioMidTime');  if (mpMtLoc) gl.uniform1f(mpMtLoc, typeof audioMidTime !== 'undefined' ? audioMidTime : 0);
    const mpHtLoc = this._getLayerLoc(layer, 'audioHighTime'); if (mpHtLoc) gl.uniform1f(mpHtLoc, typeof audioHighTime !== 'undefined' ? audioHighTime : 0);
    // FFT texture
    const mpFftLoc = this._getLayerLoc(layer, 'audioFFT');
    if (mpFftLoc && audioFFTGLTexture) {
      gl.activeTexture(gl.TEXTURE15);
      gl.bindTexture(gl.TEXTURE_2D, audioFFTGLTexture);
      gl.uniform1i(mpFftLoc, 15);
    }

    // Resolve MediaPipe bindings
    if (layer.mpBindings && layer.mpBindings.length > 0) {
      resolveBindings(layer, mediaPipeMgr, this);
    }

    // Set input values
    const mpInputKeys = Object.keys(layer.inputValues || {});
    for (let ik = 0; ik < mpInputKeys.length; ik++) {
      const name = mpInputKeys[ik];
      const val = layer.inputValues[name];
      if (name === 'bgColor') {
        const solidLoc = this._getLayerLoc(layer, '_bgColorSolid');
        if (solidLoc && Array.isArray(val)) gl.uniform4f(solidLoc, val[0], val[1], val[2], val[3]);
        continue;
      }
      const loc = this._getLayerLoc(layer, name);
      if (!loc) continue;
      if (typeof val === 'number') gl.uniform1f(loc, val);
      else if (typeof val === 'boolean') gl.uniform1i(loc, val ? 1 : 0);
      else if (Array.isArray(val)) {
        if (val.length === 2) gl.uniform2f(loc, val[0], val[1]);
        else if (val.length === 4) gl.uniform4f(loc, val[0], val[1], val[2], val[3]);
      }
    }

    // Bind layer textures (media inputs)
    let texUnit = 0;
    const mpTexKeys = Object.keys(layer.textures || {});
    for (let tk = 0; tk < mpTexKeys.length; tk++) {
      const name = mpTexKeys[tk];
      const tex = layer.textures[name];
      gl.activeTexture(gl.TEXTURE0 + texUnit);
      gl.bindTexture(gl.TEXTURE_2D, tex.glTexture);
      // Auto-resume paused videos
      if (tex.isVideo && tex.element && tex.element.paused && tex.element.loop && !tex.element.ended) {
        tex.element.play().catch(() => {});
      }
      if (tex.isVideo && tex.element && !tex._isNdi && (tex.element.readyState >= 2 || tex.element instanceof HTMLCanvasElement)) {
        this._uploadVideoTex(tex);
      }
      gl.uniform1i(this._getLayerLoc(layer, name), texUnit);
      // Set IMG_SIZE_<name> for ISF image inputs
      const imgSzLoc = this._getLayerLoc(layer, 'IMG_SIZE_' + name);
      if (imgSzLoc) {
        const el = tex.element;
        const w = el ? (el.videoWidth || el.naturalWidth || el.width || 1) : 1;
        const h = el ? (el.videoHeight || el.naturalHeight || el.height || 1) : 1;
        gl.uniform2f(imgSzLoc, w, h);
      }
      texUnit++;
    }

    // bgColor texture uniforms
    if (layer._hasBgColor) {
      const bgSrc = layer._bgSource;
      if (bgSrc && bgSrc.isVideo && bgSrc.element && layer._bgTexture) {
        gl.bindTexture(gl.TEXTURE_2D, layer._bgTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bgSrc.element);
      }
      const bgActiveLoc = this._getLayerLoc(layer, '_bgTexActive');
      if (bgActiveLoc) gl.uniform1f(bgActiveLoc, layer._bgTexture ? 1.0 : 0.0);
      const bgTexLoc = this._getLayerLoc(layer, '_bgTex');
      if (bgTexLoc) {
        gl.activeTexture(gl.TEXTURE0 + texUnit);
        gl.bindTexture(gl.TEXTURE_2D, layer._bgTexture || this._defaultTex);
        gl.uniform1i(bgTexLoc, texUnit);
        texUnit++;
      }
    }

    // Bind extras (audio, font, mediapipe)
    texUnit = this._bindLayerExtras(layer, mediaPipeMgr, texUnit);

    // Reserve texture units for TARGET buffers
    const targetBaseUnit = texUnit;
    const targetUnits = {};
    const targetPassMap = {}; // target name → pass object (avoid inner-loop .find())
    for (let pi = 0; pi < layer.passes.length; pi++) {
      const p = layer.passes[pi];
      if (p.target) {
        targetUnits[p.target] = targetBaseUnit + pi;
        targetPassMap[p.target] = p;
        texUnit++;
      }
    }

    // Prepare geometry
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // Execute passes
    for (let i = 0; i < layer.passes.length; i++) {
      const pass = layer.passes[i];
      const isFinal = !pass.target;

      let outFBO;
      if (isFinal) {
        outFBO = layer.fbo;
      } else {
        const pp = pass.ppFBO;
        outFBO = pp.current === 0 ? pp.b : pp.a;
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, outFBO.fbo);
      gl.viewport(0, 0, outFBO.width, outFBO.height);

      if (!pass.persistent || isFinal) {
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }

      const piLoc = this._getLayerLoc(layer, 'PASSINDEX');
      if (piLoc) gl.uniform1i(piLoc, i);
      const rLoc = this._getLayerLoc(layer, 'RENDERSIZE');
      if (rLoc) gl.uniform2f(rLoc, outFBO.width, outFBO.height);

      // Bind all TARGET textures (read sides)
      const targetNames = Object.keys(targetUnits);
      for (let ti = 0; ti < targetNames.length; ti++) {
        const tName = targetNames[ti];
        const tUnit = targetUnits[tName];
        const tPass = targetPassMap[tName];
        if (!tPass || !tPass.ppFBO) continue;
        const readFBO = tPass.ppFBO.current === 0 ? tPass.ppFBO.a : tPass.ppFBO.b;
        gl.activeTexture(gl.TEXTURE0 + tUnit);
        gl.bindTexture(gl.TEXTURE_2D, readFBO.texture);
        gl.uniform1i(this._getLayerLoc(layer, tName), tUnit);
      }

      gl.drawArrays(gl.TRIANGLES, 0, 3);

      if (pass.persistent && pass.ppFBO) {
        pass.ppFBO.current ^= 1;
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  initCompositor() {
    const compFrag = `
precision mediump float;
uniform sampler2D layer0;
uniform sampler2D layer1;
uniform sampler2D layer2;
uniform sampler2D layer3;
uniform float opacity0, opacity1, opacity2, opacity3;
uniform float visible0, visible1, visible2, visible3;
uniform float blendMode0, blendMode1, blendMode2, blendMode3;
uniform float flipH0, flipV0, flipH1, flipV1, flipH2, flipV2, flipH3, flipV3;
uniform vec2 RENDERSIZE;
uniform sampler2D bgTexture;
uniform float bgMode;
uniform vec3 bgColor;
uniform float bgAspect; // video/image native width/height ratio
uniform vec2 overlayTR;    // translate (x, y) in -1..1
uniform float overlayScale; // scale
uniform float overlayRot;   // rotation in radians
uniform float overlayImgAspect; // image width/height ratio
varying vec2 isf_FragNormCoord;
vec2 uvForLayer(vec2 uv, float fh, float fv) {
  if (fh > 0.5) uv.x = 1.0 - uv.x;
  if (fv > 0.5) uv.y = 1.0 - uv.y;
  return uv;
}

vec2 uvForOverlay(vec2 uv) {
  float asp = RENDERSIZE.x / RENDERSIZE.y;
  float imgAsp = max(overlayImgAspect, 0.01);
  vec2 c = uv - 0.5 - vec2(overlayTR.x * 0.5, overlayTR.y * 0.5);
  c.x *= asp; // square space
  float cs = cos(-overlayRot);
  float sn = sin(-overlayRot);
  c = vec2(c.x * cs - c.y * sn, c.x * sn + c.y * cs);
  c /= max(overlayScale, 0.01);
  c.x /= imgAsp; // image aspect (preserves native proportions)
  return c + 0.5;
}

// Cover-fit UV: scales UVs so the bg image/video covers the canvas without distortion
vec2 bgCoverUV(vec2 uv) {
  float canvasAsp = RENDERSIZE.x / RENDERSIZE.y;
  float srcAsp = max(bgAspect, 0.001);
  vec2 st = uv - 0.5;
  if (canvasAsp > srcAsp) {
    // canvas is wider — fit width, crop top/bottom
    st.y *= srcAsp / canvasAsp;
  } else {
    // canvas is taller — fit height, crop sides
    st.x *= canvasAsp / srcAsp;
  }
  return st + 0.5;
}

vec3 blendNormal(vec3 base, vec3 top, float a) { return mix(base, top, a); }
vec3 blendAdd(vec3 base, vec3 top, float a) { return base + top * a; }
vec3 blendMultiply(vec3 base, vec3 top, float a) { return mix(base, base * top, a); }
vec3 blendScreen(vec3 base, vec3 top, float a) { vec3 s = 1.0 - (1.0 - base) * (1.0 - top); return mix(base, s, a); }
vec3 blendOverlay(vec3 base, vec3 top, float a) {
  vec3 o = vec3(
    base.r < 0.5 ? 2.0*base.r*top.r : 1.0-2.0*(1.0-base.r)*(1.0-top.r),
    base.g < 0.5 ? 2.0*base.g*top.g : 1.0-2.0*(1.0-base.g)*(1.0-top.g),
    base.b < 0.5 ? 2.0*base.b*top.b : 1.0-2.0*(1.0-base.b)*(1.0-top.b)
  );
  return mix(base, o, a);
}

vec3 applyBlend(vec3 base, vec3 top, float a, float mode) {
  if (mode < 0.5) return blendNormal(base, top, a);
  if (mode < 1.5) return blendAdd(base, top, a);
  if (mode < 2.5) return blendMultiply(base, top, a);
  if (mode < 3.5) return blendScreen(base, top, a);
  return blendOverlay(base, top, a);
}

void main() {
  vec2 uv = isf_FragNormCoord;

  // Background
  vec4 result = vec4(0.0, 0.0, 0.0, 1.0);
  if (bgMode > 0.5 && bgMode < 1.5) result = vec4(0.0, 0.0, 0.0, 0.0);
  else if (bgMode > 1.5 && bgMode < 2.5) result = vec4(bgColor, 1.0);
  else if (bgMode > 2.5) result = texture2D(bgTexture, bgCoverUV(uv));

  // Layer 0 (base)
  if (visible0 > 0.5) {
    vec4 c = texture2D(layer0, uvForLayer(uv, flipH0, flipV0));
    float a = c.a * opacity0;
    result.rgb = applyBlend(result.rgb, c.rgb, a, blendMode0);
    result.a = max(result.a, a);
  }

  // Layer 1
  if (visible1 > 0.5) {
    vec4 c = texture2D(layer1, uvForLayer(uv, flipH1, flipV1));
    float a = c.a * opacity1;
    result.rgb = applyBlend(result.rgb, c.rgb, a, blendMode1);
    result.a = max(result.a, a);
  }

  // Layer 2
  if (visible2 > 0.5) {
    vec4 c = texture2D(layer2, uvForLayer(uv, flipH2, flipV2));
    float a = c.a * opacity2;
    result.rgb = applyBlend(result.rgb, c.rgb, a, blendMode2);
    result.a = max(result.a, a);
  }

  // Layer 3 (overlay — topmost, with transform)
  if (visible3 > 0.5) {
    vec2 ouv = uvForOverlay(uvForLayer(uv, flipH3, flipV3));
    vec4 c = vec4(0.0);
    if (ouv.x >= 0.0 && ouv.x <= 1.0 && ouv.y >= 0.0 && ouv.y <= 1.0)
      c = texture2D(layer3, ouv);
    float a = c.a * opacity3;
    result.rgb = applyBlend(result.rgb, c.rgb, a, blendMode3);
    result.a = max(result.a, a);
  }

  gl_FragColor = result;
}
`;
    const result = this.compile(VERT_SHADER, compFrag);
    if (result.ok) {
      this.compositorProgram = this.program;
      this.compositorLocs = {};
      this.program = null; // compositor stored separately
    } else {
      console.error('Compositor shader failed:', result.errors);
    }
    return result;
  }

  _getCompLoc(name) {
    if (!(name in this.compositorLocs)) {
      this.compositorLocs[name] = this.gl.getUniformLocation(this.compositorProgram, name);
    }
    return this.compositorLocs[name];
  }

  async makeXRCompatible() {
    return this.gl.makeXRCompatible();
  }

  renderCompositor(layers, sceneTexture, bgState, targetFBO) {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    if (!this.compositorProgram) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFBO ? targetFBO.fbo : null);
    const rw = targetFBO ? targetFBO.width : this.canvas.width;
    const rh = targetFBO ? targetFBO.height : this.canvas.height;
    gl.viewport(0, 0, rw, rh);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.compositorProgram);

    const rLoc = this._getCompLoc('RENDERSIZE');
    if (rLoc) gl.uniform2f(rLoc, rw, rh);

    // Bind layer textures (type-aware: scene layer uses sceneTexture, overlay/shader use FBO)
    // Perf: skip expensive texture bind + uniform calls for invisible layers
    const layerCount = Math.min(layers.length, 4);
    for (let i = 0; i < 4; i++) {
      const layer = (i < layerCount) ? layers[i] : null;
      const lVis = (layer && layer.visible && (layer.type !== 'overlay' || layer._hasImage)) ? 1.0 : 0.0;
      gl.uniform1f(this._getCompLoc('visible' + i), lVis);

      if (lVis < 0.5) {
        // Layer invisible: bind default tex (required for sampler) but skip other uniforms
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, this._defaultTex);
        gl.uniform1i(this._getCompLoc('layer' + i), i);
        gl.uniform1f(this._getCompLoc('opacity' + i), 0);
        gl.uniform1f(this._getCompLoc('blendMode' + i), 0);
        gl.uniform1f(this._getCompLoc('flipH' + i), 0);
        gl.uniform1f(this._getCompLoc('flipV' + i), 0);
        continue;
      }

      gl.activeTexture(gl.TEXTURE0 + i);
      if (layer.type === 'scene' && sceneTexture) {
        gl.bindTexture(gl.TEXTURE_2D, sceneTexture);
      } else if (layer.fbo) {
        gl.bindTexture(gl.TEXTURE_2D, layer.fbo.texture);
      } else {
        gl.bindTexture(gl.TEXTURE_2D, this._defaultTex);
      }
      gl.uniform1i(this._getCompLoc('layer' + i), i);
      gl.uniform1f(this._getCompLoc('opacity' + i), layer.opacity);
      gl.uniform1f(this._getCompLoc('blendMode' + i), _BLEND_MODE_MAP[layer.blendMode] || 0);

      // Per-layer flip uniforms
      const isScene = layer.type === 'scene';
      gl.uniform1f(this._getCompLoc('flipH' + i), isScene && layer.sceneFlipH ? 1.0 : 0.0);
      gl.uniform1f(this._getCompLoc('flipV' + i), isScene && layer.sceneFlipV ? 1.0 : 0.0);
    }

    // Overlay transform uniforms (layer 3)
    const olay = (layerCount > 3 && layers[3]) ? layers[3] : null;
    gl.uniform2f(this._getCompLoc('overlayTR'), olay ? (olay._tx || 0) : 0, olay ? (olay._ty || 0) : 0);
    gl.uniform1f(this._getCompLoc('overlayScale'), olay ? (olay._scale || 1) : 1);
    gl.uniform1f(this._getCompLoc('overlayRot'), olay ? (olay._rotate || 0) : 0);
    gl.uniform1f(this._getCompLoc('overlayImgAspect'), olay ? (olay._imgAspect || 1.778) : 1.778);

    // Morph uniforms

    // Background uniforms (use texture unit 4 now that we have 4 layers)
    const bgModeMap = { none: 0, transparent: 1, color: 2, image: 3, video: 3, shader: 3, webcam: 3, ndi: 3 };
    const bgM = bgState ? (bgModeMap[bgState.mode] || 0) : 0;
    gl.uniform1f(this._getCompLoc('bgMode'), bgM);
    if (bgState && bgState.color) {
      gl.uniform3f(this._getCompLoc('bgColor'), bgState.color[0], bgState.color[1], bgState.color[2]);
    }
    // Background aspect ratio for cover-fit
    const bgAsp = (bgState && bgState.aspect) ? bgState.aspect : (this.canvas.width / this.canvas.height);
    gl.uniform1f(this._getCompLoc('bgAspect'), bgAsp);

    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, (bgState && bgState.texture) ? bgState.texture : this._defaultTex);
    gl.uniform1i(this._getCompLoc('bgTexture'), 4);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    this.frameIndex++;
  }
}
