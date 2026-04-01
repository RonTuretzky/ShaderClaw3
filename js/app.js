// ============================================================
// ShaderClaw — Main Application
// ============================================================

// ============================================================
// App Init
// ============================================================

(async function init() {
  // ==========================================
  // Event Bus — thin pub/sub for cross-scope communication
  // New code should emit/subscribe via bus instead of window.* hacks
  // ==========================================
  const bus = {
    _subs: {},
    on(event, fn) {
      (this._subs[event] ||= []).push(fn);
      return () => { this._subs[event] = this._subs[event].filter(f => f !== fn); };
    },
    emit(event, data) {
      (this._subs[event] || []).forEach(fn => fn(data));
    }
  };
  window._bus = bus; // temporary escape hatch until window.* hacks are retired

  const _dbg = document.getElementById('debug-overlay');
  const _dbgLines = [];
  function dbg(msg) {
    console.log(msg);
    _dbgLines.push(msg);
    if (_dbg) {
      _dbg.textContent = _dbgLines.slice(-20).join('\n');
      if (window.innerWidth <= 768 && location.hostname === 'localhost') _dbg.style.display = '';
    }
  }
  dbg('init: starting...');
  const glCanvas = document.getElementById('gl-canvas');
  const threeCanvas = document.getElementById('three-canvas');
  dbg('init: getting WebGL context...');
  const gl = await _getWebGLWithRetry(glCanvas, 5, dbg);
  if (!gl) {
    dbg('FAILED: no WebGL after retries');
    const bar = document.getElementById('error-bar');
    if (bar) {
      bar.innerHTML = 'WebGL unavailable — close other browser tabs, then <a href="#" onclick="location.reload();return false" style="color:var(--accent);text-decoration:underline">click here to retry</a>';
      bar.classList.add('show');
    }
    return;
  }
  dbg('init: WebGL OK, creating Renderer...');
  const isfRenderer = new Renderer(glCanvas, gl);
  dbg('init: Renderer OK');
  function _rw() { return isfRenderer.canvas.width || window.innerWidth; }
  function _rh() { return isfRenderer.canvas.height || window.innerHeight; }
  const sceneRenderer = new SceneRenderer(threeCanvas);
  sceneRenderer._isfGL = isfRenderer.gl;
  sceneRenderer._mainRenderer = isfRenderer;
  // Fluid simulation renderer (shared GL context)
  const fluidRenderer = new FluidRenderer(gl, isfRenderer);
  // Shadertoy renderer (native multi-buffer support)
  const shadertoyRenderer = new ShadertoyRenderer(gl, isfRenderer);
  const errorBar = document.getElementById('error-bar');
  errorBar.dataset.init = '1'; // suppress during init
  const _isMobileComp = window.innerWidth <= 900 || /Mobi|Android|iPhone/i.test(navigator.userAgent);
  // Composition loop state (must be declared before compositionLoop is called)
  let _compFrameCount = 0;
  let _cachedTextOpSlider = null;
  let _cachedTextOpVal = null;
  let _cachedCompactTextOp = null;
  let _lastCompTime = 0;
  const _layerMap = {};
  let _cachedWebcamEntry = null;
  let _cachedWebcamLookup = 0;
  let _cachedSignalRows = null;
  let _cachedSignalRowsFrame = 0;

  // Three.js canvas always renders offscreen — gl-canvas is the compositor output
  threeCanvas.style.display = 'none';
  glCanvas.style.display = 'block';

  // MediaPipe manager
  const mediaPipeMgr = new MediaPipeManager(isfRenderer.gl);
  const gestureProcessor = new GestureProcessor();
  let _ndiWs = null; // WS reference for NDI

  // WebXR manager (Vision Pro 360 immersive)
  const xrManager = new XRManager(isfRenderer, mediaPipeMgr, bus);
  xrManager.checkSupport().then(ok => {
    const btn = document.getElementById('xr-btn');
    if (btn && ok) {
      btn.style.display = '';
      // Wire up click for hardcoded HTML buttons (index.html)
      if (!btn._xrWired) {
        btn._xrWired = true;
        btn.addEventListener('click', () => bus.emit('xr:toggle'));
      }
    }
  });
  bus.on('xr:toggle', () => {
    const btn = document.getElementById('xr-btn');
    if (xrManager.active) {
      xrManager.exit();
      if (btn) btn.classList.remove('xr-active');
    } else {
      xrManager.enter().then(() => {
        if (btn) btn.classList.add('xr-active');
      }).catch(e => console.warn('XR enter failed:', e));
    }
  });
  // When XR session ends, resume normal rAF loop
  bus.on('xr:exit', () => {
    const btn = document.getElementById('xr-btn');
    if (btn) btn.classList.remove('xr-active');
    requestAnimationFrame(compositionLoop);
  });

  // XR frame event: the XR session's rAF fires this to drive the comp loop
  bus.on('xr:frame', ({ time, frame }) => {
    try {
      // Run composition loop (renders layers + compositor to compFBO)
      compositionLoop(time);
      // Draw the 360 sphere to the XR framebuffer
      xrManager.onFrame(time, frame);
    } catch (e) {
      console.error('[XR] Frame error:', e);
    }
    // Always schedule next XR frame — missing a frame kills the session
    if (xrManager.active && xrManager.session) {
      xrManager.session.requestAnimationFrame((t, f) => {
        bus.emit('xr:frame', { time: t, frame: f });
      });
    }
  });

  // ===== LAYER DATA STRUCTURE =====
  const layers = [
    { id: 'shader', type: 'shader', visible: false, opacity: 1.0, blendMode: 'normal',
      program: null, uniformLocs: {}, fbo: isfRenderer.createFBO(_rw(), _rh()), textures: {},
      inputs: [], inputValues: {}, transparentBg: false, manifestEntry: null, passes: null },
    { id: 'scene', type: 'scene', visible: false, opacity: 1.0, blendMode: 'normal',
      program: null, uniformLocs: {}, fbo: null, textures: {},
      inputs: [], inputValues: {}, transparentBg: false, manifestEntry: null,
      sceneFlipH: false, sceneFlipV: true },
    { id: 'text', type: 'shader', visible: true, opacity: 1.0, blendMode: 'normal',
      program: null, uniformLocs: {}, fbo: isfRenderer.createFBO(_rw(), _rh()), textures: {},
      inputs: [], inputValues: {}, transparentBg: true, manifestEntry: null, passes: null },
    { id: 'overlay', type: 'overlay', visible: false, opacity: 1.0, blendMode: 'normal',
      program: null, uniformLocs: {}, fbo: null, textures: {},
      inputs: [], inputValues: {}, transparentBg: true, manifestEntry: null },
  ];

  // Scene layer gets a plain texture (uploaded from Three.js canvas each frame)
  // Alpha=0 so an unrendered scene doesn't cover layers below it in compositor
  function createSceneTexture() {
    const gl = isfRenderer.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0,0,0,0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }
  let sceneTexture = createSceneTexture();

  // Init compositor
  dbg('init: compiling compositor...');
  const compResult = isfRenderer.initCompositor();
  dbg('compositor: ' + (compResult.ok ? 'OK' : 'FAILED — ' + (compResult.errors || 'unknown')));

  // ===== WEBGL CONTEXT LOSS RECOVERY =====
  let _contextLost = false;

  glCanvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault(); // Tell browser we want to restore
    _contextLost = true;
    _blitProg = null; _blitTexLoc = null; // Reset crossfade blit program
    layers.forEach(l => { l._transitionTex = null; l._transitionStart = null; l._pendingCompile = null; });
    // Invalidate XR GL resources (will be rebuilt on next onFrame)
    if (xrManager) {
      xrManager._sphereProg = null;
      xrManager._sphereVBO = null;
      xrManager._sphereIBO = null;
      xrManager.compFBO = null;
    }
    console.warn('WebGL context lost — waiting for restore...');
    errorBar.textContent = 'WebGL context lost — recovering...';
    errorBar.classList.add('show');
  });

  function _doContextRestore() {
    const gl = isfRenderer.gl;
    if (gl.isContextLost()) {
      console.warn('Context still lost during restore — retrying in 500ms');
      setTimeout(_doContextRestore, 500);
      return;
    }

    console.log('WebGL context restored — reinitializing...');

    // 1. Rebuild core GL resources (geometry buffer, default texture)
    isfRenderer.reinitGL();
    isfRenderer.initCompositor();

    // 2. Recreate scene texture (for Three.js → compositor upload)
    sceneTexture = createSceneTexture();

    // 3. Recreate FBOs for all layers
    layers.forEach(layer => {
      if ((layer.type === 'shader' || layer.type === 'overlay') && layer.fbo) {
        layer.fbo = isfRenderer.createFBO(_rw(), _rh());
      }
      if (layer.passes) {
        layer.passes.forEach(p => {
          if (p.ppFBO) {
            p.ppFBO = isfRenderer.createPingPongFBO(p.width || _rw(), p.height || _rh());
          }
        });
      }
      layer.program = null;
      layer.uniformLocs = {};
      layer.textures = {};
    });

    // 4. Recompile all shader layers from stored source
    let allOk = true;
    layers.forEach(layer => {
      if (layer.type === 'shader' && layer._isfSource) {
        const result = compileToLayer(layer.id, layer._isfSource);
        if (!result.ok) {
          console.warn('Context restore: failed to recompile', layer.id, result.errors);
          allOk = false;
        }
      }
    });

    // 5. Rebuild font atlas GL texture
    _fontAtlasGLTexture = null;
    _fontAtlasLastKey = '';

    // 6. Rebuild MediaPipe data textures
    if (mediaPipeMgr.active) {
      mediaPipeMgr.reinitTextures();
    }

    // 7. Rebuild media input GL textures
    mediaInputs.forEach(m => {
      if (m.element) {
        try { m.glTexture = createGLTexture(gl, m.element); } catch (e) {}
      }
    });
    autoBindTextures();

    // 8. Rebuild background texture
    if (canvasBg.mode !== 'none' && canvasBg.mode !== 'shader') {
      canvasBg.texture = createBgTexture();
      if (canvasBg.imageEl) {
        try {
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          gl.bindTexture(gl.TEXTURE_2D, canvasBg.texture);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvasBg.imageEl);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        } catch (e) {}
      }
    } else if (canvasBg.mode === 'shader' && canvasBg.shaderLayer) {
      canvasBg.shaderFBO = isfRenderer.createFBO(_rw(), _rh());
      canvasBg.texture = canvasBg.shaderFBO.texture;
      canvasBg.shaderLayer.fbo = canvasBg.shaderFBO;
      canvasBg.shaderLayer.program = null;
      canvasBg.shaderLayer.uniformLocs = {};
      if (canvasBg.shaderLayer._isfSource) {
        const { frag } = buildFragmentShader(canvasBg.shaderLayer._isfSource);
        isfRenderer.compileForLayer(canvasBg.shaderLayer, VERT_SHADER, frag);
      }
    }

    // 9. Rebuild fluid renderer if it was active
    if (fluidRenderer.active) {
      fluidRenderer.destroy();
      fluidRenderer.init();
    }

    // Only resume rendering once everything is rebuilt
    _contextLost = false;
    errorBar.textContent = '';
    errorBar.classList.remove('show');
    console.log('WebGL context recovery complete');
  }

  glCanvas.addEventListener('webglcontextrestored', () => {
    // Defer restore to next frame to let the GL context fully stabilize
    requestAnimationFrame(() => _doContextRestore());
  });

  // Three.js scene canvas context loss handling
  threeCanvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    console.warn('Three.js WebGL context lost');
  });
  threeCanvas.addEventListener('webglcontextrestored', () => {
    console.log('Three.js WebGL context restored — reloading scene');
    const sceneLayer = layers.find(l => l.type === 'scene');
    if (sceneLayer && sceneLayer._sceneDef) {
      try {
        sceneRenderer.load(sceneLayer._sceneDef);
        sceneRenderer.inputValues = sceneLayer.inputValues || {};
      } catch (e) {
        console.warn('Three.js scene restore failed:', e);
      }
    }
  });

  // ===== CANVAS PANEL STATE =====
  let projectionWindow = null;
  let projectionCanvas = null;
  let projectionCtx = null;

  const canvasBg = {
    mode: 'none',      // 'none'|'transparent'|'color'|'image'|'video'|'shader'|'webcam'
    color: [0, 0, 0],  // RGB 0-1
    texture: null,      // GL texture for image/video/webcam
    imageEl: null,      // <img> element for image bg (kept for context restore)
    videoEl: null,      // <video> element if video/webcam
    shaderFBO: null,    // FBO for shader background
    shaderLayer: null,  // pseudo-layer object for ISF rendering
    aspect: 16/9,       // native width/height ratio of video/image source
  };

  let focusedLayerId = 'shader'; // which layer the code editor targets

  function getLayer(id) { return layers.find(l => l.id === id); }
  function getFocusedLayer() { return getLayer(focusedLayerId); }

  // Move color-type control rows from layer-params into layer-colors container
  function hoistColorRows(layerId) {
    const paramsContainer = document.querySelector(`.layer-params[data-layer="${layerId}"]`);
    const colorsContainer = document.querySelector(`.layer-colors[data-layer="${layerId}"]`);
    if (!paramsContainer || !colorsContainer) return;
    colorsContainer.innerHTML = '';
    const colorRows = paramsContainer.querySelectorAll('.control-row');
    colorRows.forEach(row => {
      const picker = row.querySelector('input[type="color"]');
      if (!picker) return;
      // Build a compact color row: label + swatch with embedded picker
      const name = row.dataset.name;
      const label = row.querySelector('label');
      const compactRow = document.createElement('div');
      compactRow.className = 'layer-color-row';
      compactRow.dataset.name = name;
      const lbl = document.createElement('label');
      lbl.textContent = label ? label.textContent : name;
      compactRow.appendChild(lbl);
      const swatch = document.createElement('div');
      swatch.className = 'color-swatch';
      swatch.style.background = picker.value;
      // Move the picker into the swatch
      picker.addEventListener('input', () => { swatch.style.background = picker.value; });
      swatch.appendChild(picker);
      compactRow.appendChild(swatch);
      colorsContainer.appendChild(compactRow);
      // Remove original row from params
      row.remove();
    });
  }

  // CodeMirror editor
  const editor = CodeMirror.fromTextArea(document.getElementById('code'), {
    mode: 'x-shader/x-fragment',
    theme: 'material-darker',
    lineNumbers: true,
    matchBrackets: true,
    autoCloseBrackets: true,
    tabSize: 4,
    indentWithTabs: true
  });

  let lastErrors = null;

  // === Shader transition: crossfade utilities ===
  const TRANSITION_MS = 400;
  let _blitProg = null, _blitTexLoc = null;

  function _getBlitProg(gl) {
    if (_blitProg) return _blitProg;
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, 'attribute vec2 position;varying vec2 vUv;void main(){vUv=position*0.5+0.5;gl_Position=vec4(position,0.,1.);}');
    gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, 'precision mediump float;uniform sampler2D uTex;varying vec2 vUv;void main(){gl_FragColor=texture2D(uTex,vUv);}');
    gl.compileShader(fs);
    _blitProg = gl.createProgram();
    gl.attachShader(_blitProg, vs); gl.attachShader(_blitProg, fs);
    gl.bindAttribLocation(_blitProg, 0, 'position');
    gl.linkProgram(_blitProg);
    gl.deleteShader(vs); gl.deleteShader(fs);
    _blitTexLoc = gl.getUniformLocation(_blitProg, 'uTex');
    return _blitProg;
  }

  function _snapshotLayerFBO(gl, layer) {
    if (!layer.fbo) return;
    const w = layer.fbo.width, h = layer.fbo.height;
    if (!layer._transitionTex) {
      layer._transitionTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, layer._transitionTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      layer._transitionTexSize = [w, h];
    }
    if (layer._transitionTexSize[0] !== w || layer._transitionTexSize[1] !== h) {
      gl.bindTexture(gl.TEXTURE_2D, layer._transitionTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      layer._transitionTexSize = [w, h];
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.fbo.fbo);
    gl.bindTexture(gl.TEXTURE_2D, layer._transitionTex);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function _blendTransitionSnapshot(gl, layer, alpha) {
    if (!layer._transitionTex || !layer.fbo || alpha <= 0) return;
    const prog = _getBlitProg(gl);
    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.fbo.fbo);
    gl.viewport(0, 0, layer.fbo.width, layer.fbo.height);
    gl.enable(gl.BLEND);
    gl.blendColor(0, 0, 0, alpha);
    gl.blendFuncSeparate(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA,
                         gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA);
    gl.useProgram(prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, layer._transitionTex);
    gl.uniform1i(_blitTexLoc, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, isfRenderer.posBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // --- Compile ISF shader into a specific layer ---
  function compileToLayer(layerId, source, _precompiledProg) {
    const layer = getLayer(layerId);
    if (!layer || layer.type !== 'shader') return { ok: false, errors: 'Not a shader layer' };

    // Auto-convert Shadertoy code to ISF format
    const wasShadertoy = isShadertoyCode(source);
    const converted = convertShadertoy(source);
    if (converted !== source) {
      source = converted;
      // Update editor with converted source so user sees valid ISF
      if (focusedLayerId === layerId) editor.setValue(source);
    }
    // Warn if Shadertoy code looks like a multi-buffer shader (missing functions)
    if (wasShadertoy) {
      const hasTextureSize = /\btextureSize\b/.test(source);
      const hasCommonRef = /\b(Common|BufA|BufB|BufC|BufD)\b/i.test(source);
      if (hasTextureSize || hasCommonRef) {
        return { ok: false, errors: 'This looks like a multi-buffer Shadertoy (uses functions from Common/Buffer tabs). Only single-pass shaders can be auto-converted.' };
      }
    }

    // Store source for context-loss recovery
    layer._isfSource = source;

    const { frag, parsed, headerLineCount } = buildFragmentShader(source);
    isfRenderer._headerLines = headerLineCount;
    // Optimize: strip charData() if-chain since we always use font atlas texture
    const optimizedFrag = frag.replace(
      /vec2 charData\(int ch\)\s*\{[\s\S]*?\n\}/,
      'vec2 charData(int ch) { return vec2(0.0); }'
    );
    const result = _precompiledProg
      ? isfRenderer.compileForLayer(layer, null, null, _precompiledProg)
      : isfRenderer.compileForLayer(layer, VERT_SHADER, optimizedFrag);

    layer.inputs = parsed.inputs || [];
    layer._hasBgColor = layer.inputs.some(inp => inp.NAME === 'bgColor');
    layer._bgTexture = layer._bgTexture || null;
    layer._bgSource = layer._bgSource || null;
    layer._hasGestureInputs = layer.inputs.some(inp =>
      inp.NAME === 'rotationX' || inp.NAME === 'rotationY' || inp.NAME === 'shapeScale' ||
      inp.NAME === 'glow' || inp.NAME === 'morph' || inp.NAME === 'alive');

    if (result.ok) {
      // Set layer visible immediately — don't let post-compilation errors hide a working shader
      layer.visible = true;
      layer.opacity = 1.0;
      // Clear msg cache so new text preset picks up the current msg bar value
      layer._msgCached = null;
      layer._msgMaxLen = null;
      try {
      const paramsContainer = document.querySelector(`.layer-params[data-layer="${layerId}"]`);
      if (paramsContainer) {
        // For text layer, skip msg from params UI (prominent bar handles it)
        // and move font/fontFamily to top
        const paramsInputs = layerId === 'text'
          ? layer.inputs
              .filter(inp => !(inp.TYPE === 'text' && inp.NAME === 'msg'))
              .sort((a, b) => {
                const af = (a.NAME === 'font' || a.NAME === 'fontFamily') ? 0 : 1;
                const bf = (b.NAME === 'font' || b.NAME === 'fontFamily') ? 0 : 1;
                return af - bf;
              })
          : layer.inputs;
        // Pass GL context + callback for background source panel
        paramsContainer._bgGl = isfRenderer.gl;
        paramsContainer._bgSourceCallback = (name, source) => {
          if (source.type === 'color') {
            layer._bgTexture = null;
          } else if (source.texture) {
            layer._bgTexture = source.texture;
          }
          layer._bgSource = source;
        };
        layer.inputValues = generateControls(paramsInputs, paramsContainer, (vals) => {
          layer.inputValues = vals;
          // Keep textColor in sync from compact row for text layers
          if (layerId === 'text' && !('textColor' in vals)) {
            const row = document.querySelector('.sc3-layer-row[data-layer="text"]');
            const pk = row?.querySelector('.sc3-layer-color-picker');
            if (pk) {
              const hex = pk.value;
              const r = parseInt(hex.substr(1, 2), 16) / 255;
              const g = parseInt(hex.substr(3, 2), 16) / 255;
              const b = parseInt(hex.substr(5, 2), 16) / 255;
              vals.textColor = [r, g, b, 1.0];
            }
          }
          if ('fontFamily' in vals) setVarFontFamily(vals.fontFamily);
          if ('fontWeight' in vals) {
            _vfWeight = Math.max(100, Math.min(900, vals.fontWeight));
            setVarFontWeight(vals.fontWeight);
          }
          autoBindTextures(layerId);
        });
        // Inject textColor from compact row for text layers (initial value)
        if (layerId === 'text' && layer.inputValues && !layer.inputValues.textColor) {
          const tcRow = document.querySelector('.sc3-layer-row[data-layer="text"]');
          const tcPk = tcRow?.querySelector('.sc3-layer-color-picker');
          if (tcPk) {
            const hex = tcPk.value;
            const r = parseInt(hex.substr(1, 2), 16) / 255;
            const g = parseInt(hex.substr(3, 2), 16) / 255;
            const b = parseInt(hex.substr(5, 2), 16) / 255;
            layer.inputValues.textColor = [r, g, b, 1.0];
          }
        }
        // Hoist color controls above params into compact color section
        hoistColorRows(layerId);
        // Mark parameters with automatic reactivity badges (audio/mouse/hand)
        if (layer._isfSource) markReactiveParams(paramsContainer, layer._isfSource, paramsInputs, layerId);
        // Clean up any previously-moved direction D-pad (lives outside .layer-params after move)
        const layerCard = paramsContainer.closest('.layer-card');
        if (layerCard) {
          layerCard.querySelectorAll('.control-row[data-name="direction"]').forEach(old => {
            if (!paramsContainer.contains(old)) old.remove();
          });
        }
        // Move direction D-pad under the layer dropdown (or layer row)
        const dirRow = paramsContainer.querySelector('.control-row[data-name="direction"]');
        if (dirRow) {
          const tbInParams = paramsContainer.querySelector('.cam-toggle-row[data-name="transparentBg"]');
          const layerDropdown = layerCard?.querySelector('.sc3-layer-dropdown');
          const tbToggle = tbInParams || layerDropdown;
          if (tbToggle) {
            dirRow.style.justifyContent = 'center';
            dirRow.style.marginBottom = '10px';
            tbToggle.after(dirRow);
          }
        }
        syncMpLinkedState(paramsContainer, layerId);
        // For text layer, init msg values from prominent bar
        if (layerId === 'text') {
          const msgInp = layer.inputs.find(inp => inp.TYPE === 'text' && inp.NAME === 'msg');
          if (msgInp) {
            const maxLen = msgInp.MAX_LENGTH || 12;
            const bar = document.getElementById('text-msg-input');
            const def = (bar ? bar.value.trim() : (msgInp.DEFAULT || '').trim()).toUpperCase();
            function _c2c(ch) { if (!ch || ch === ' ') return 26; const code = ch.toUpperCase().charCodeAt(0); if (code >= 65 && code <= 90) return code - 65; if (code >= 48 && code <= 57) return code - 48 + 27; return 26; }
            for (let i = 0; i < maxLen; i++) layer.inputValues['msg_' + i] = _c2c(def[i]);
            layer.inputValues['msg_len'] = def.replace(/\s+$/, '').length;
            // Update bar maxLength to match shader
            if (bar) bar.maxLength = maxLen;
          }
        }
      }
      // Update shader dropdown selection
      const select = document.querySelector(`.layer-shader-select[data-layer="${layerId}"]`);
      if (select && layer.manifestEntry) select.value = layer.manifestEntry.file;
      autoBindTextures(layerId);

      // Multi-pass allocation from PASSES metadata
      if (layer.passes) {
        layer.passes.forEach(p => { if (p.ppFBO) isfRenderer.destroyPingPongFBO(p.ppFBO); });
        layer.passes = null;
      }
      const passes = parsed.meta && Array.isArray(parsed.meta.PASSES) ? parsed.meta.PASSES : null;
      if (passes && passes.length > 0) {
        layer.passes = passes.map(p => {
          if (!p.TARGET) {
            // Final output pass — renders to layer.fbo
            return { target: null, persistent: false, ppFBO: null, width: _rw(), height: _rh() };
          }
          // Resolve WIDTH/HEIGHT with $WIDTH/N expression support
          let w = _rw(), h = _rh();
          const resolveExpr = (expr, base) => {
            if (!expr) return base;
            if (typeof expr === 'number') return expr;
            const s = String(expr);
            const m = s.match(/^\$(?:WIDTH|HEIGHT)\s*\/\s*(\d+)$/);
            if (m) return Math.max(1, Math.round(base / parseInt(m[1])));
            return parseInt(s) || base;
          };
          w = resolveExpr(p.WIDTH, _rw());
          h = resolveExpr(p.HEIGHT, _rh());
          // Perf: auto-downscale simulation (TARGET) passes on ultra-wide canvases
          const canvasW = _rw();
          if (canvasW > 4096) {
            w = Math.max(1, Math.round(w / 2));
            h = Math.max(1, Math.round(h / 2));
          }
          const persistent = !!(p.PERSISTENT || p.persistent);
          return {
            target: p.TARGET,
            persistent,
            ppFBO: isfRenderer.createPingPongFBO(w, h),
            width: w,
            height: h,
            _widthExpr: p.WIDTH || null,
            _heightExpr: p.HEIGHT || null,
            _simDownscaled: canvasW > 4096
          };
        });
      }
      } catch (e) {
        console.error('compileToLayer post-compile error for ' + layerId + ':', e);
      }
    }
    return result;
  }

  // --- Compile from editor into focused layer ---
  function compile() {
    const source = editor.getValue();
    const result = compileToLayer(focusedLayerId, source);
    if (result.ok) {
      lastErrors = null;
      errorBar.textContent = '';
      errorBar.classList.remove('show');
    } else {
      lastErrors = result.errors;
      errorBar.textContent = result.errors;
      errorBar.classList.add('show');
    }
    return result;
  }

  // --- Load shader source into editor + compile to focused layer ---
  function loadSource(source) {
    editor.setValue(source);
    compile();
  }

  // --- Load ISF shader file into a specific layer ---
  async function loadShaderToLayer(layerId, folder, file) {
    try {
      const r = await fetch((folder || 'shaders') + '/' + file);
      const src = await r.text();

      const layer = getLayer(layerId);

      // Async path: layer already has a running program — compile in background, crossfade
      if (layer && layer.program && layer.fbo) {
        // Cancel any existing pending compilation
        if (layer._pendingCompile) {
          layer._pendingCompile.handle.dispose();
          layer._pendingCompile = null;
        }

        // Parse ISF and build fragment shader (CPU-only, fast)
        const { frag, parsed, headerLineCount } = buildFragmentShader(src);
        const optimizedFrag = frag.replace(
          /vec2 charData\(int ch\)\s*\{[\s\S]*?\n\}/,
          'vec2 charData(int ch) { return vec2(0.0); }'
        );

        // Start async GPU compilation
        const handle = isfRenderer.startAsyncCompile(VERT_SHADER, optimizedFrag);
        if (handle) {
          layer._pendingCompile = { handle, source: src, parsed, headerLineCount, file };
          // Update editor immediately so user can see new source
          if (layerId === focusedLayerId) editor.setValue(src);
          return { ok: true, errors: null }; // compilation in progress
        }
        // Fallback if startAsyncCompile failed (context lost) — sync path below
      }

      // Sync path: no existing program (first load) or fallback
      const result = compileToLayer(layerId, src);
      if (layerId === focusedLayerId) editor.setValue(src);
      if (!result.ok) {
        errorBar.textContent = result.errors;
        errorBar.classList.add('show');
      } else {
        errorBar.textContent = '';
        errorBar.classList.remove('show');
        lastErrors = null;
      }
      return result;
    } catch (e) {
      errorBar.textContent = 'Failed to load: ' + file;
      errorBar.classList.add('show');
      return { ok: false, errors: e.message };
    }
  }

  // --- Load a Three.js scene into the scene layer ---
  async function loadScene(folder, file) {
    errorBar.textContent = '';
    errorBar.classList.remove('show');
    lastErrors = null;

    try {
      const r = await fetch((folder || 'scenes') + '/' + file);
      const src = await r.text();
      const sceneDef = new Function('THREE', 'return (' + src + ')(THREE)')(THREE);
      sceneRenderer.load(sceneDef);

      const sceneLayer = getLayer('scene');
      sceneLayer._sceneDef = sceneDef; // store for context restore
      sceneLayer.inputs = sceneDef.INPUTS || [];
      const paramsContainer = document.querySelector('.layer-params[data-layer="scene"]');
      if (paramsContainer) {
        sceneLayer.inputValues = generateControls(sceneLayer.inputs, paramsContainer, (vals) => {
          sceneRenderer.inputValues = vals;
          sceneLayer.inputValues = vals;
          autoBindTextures('scene');
        });
        hoistColorRows('scene');
        syncMpLinkedState(paramsContainer, 'scene');
        // Enable reactive signal binding for scene params (⚡ buttons)
        markReactiveParams(paramsContainer, '', sceneLayer.inputs, 'scene');
      }
      sceneRenderer.inputValues = sceneLayer.inputValues;
      autoBindTextures('scene');
      // Update shader dropdown selection
      const sceneSelect = document.querySelector('.layer-shader-select[data-layer="scene"]');
      if (sceneSelect && sceneLayer.manifestEntry) sceneSelect.value = sceneLayer.manifestEntry.file;

      sceneRenderer.resize();
      // Don't start scene's own loop — composition loop drives it
    } catch (e) {
      lastErrors = e.message;
      errorBar.textContent = 'Scene error: ' + e.message;
      errorBar.classList.add('show');
    }
  }

  // Convert uniform definition object to ISF-style INPUTS array (for custom material UI)
  function uniformDefsToISFInputs(uniforms) {
    if (!uniforms) return [];
    return Object.entries(uniforms).map(([name, def]) => {
      const inp = { NAME: name, LABEL: def.label || name };
      switch (def.type) {
        case 'float': inp.TYPE='float'; inp.DEFAULT=def.default??0.5; inp.MIN=def.min??0; inp.MAX=def.max??1; break;
        case 'color': inp.TYPE='color'; inp.DEFAULT=def.default||[1,1,1,1]; break;
        case 'bool':  inp.TYPE='bool';  inp.DEFAULT=!!def.default; break;
        case 'int': case 'long': inp.TYPE='long'; inp.DEFAULT=def.default||0; inp.VALUES=def.values||[0,1,2,3]; inp.LABELS=def.labels||inp.VALUES.map(String); break;
        case 'vec2':  inp.TYPE='point2D'; inp.DEFAULT=def.default||[0,0]; break;
        case 'image': case 'sampler2D': inp.TYPE='image'; break;
        default: inp.TYPE='float'; inp.DEFAULT=0.5; inp.MIN=0; inp.MAX=1;
      }
      return inp;
    });
  }

  // Expose full API for MCP server bridge
  window.shaderClaw = {
    loadSource,
    loadScene,
    loadShaderFile: loadShaderToLayer,
    compile,
    compileToLayer,
    getSource: () => editor.getValue(),
    getFocusedLayer: () => focusedLayerId,

    getErrors: () => lastErrors,

    getInputs: () => {
      const layer = getFocusedLayer();
      return (layer.inputs || []).map(inp => {
        const o = {
          name: inp.NAME,
          type: inp.TYPE,
          value: layer.inputValues[inp.NAME],
          min: inp.MIN,
          max: inp.MAX,
          default: inp.DEFAULT,
        };
        if (inp.VALUES) o.values = inp.VALUES;
        if (inp.LABELS) o.labels = inp.LABELS;
        if (inp.MAX_LENGTH) o.maxLength = inp.MAX_LENGTH;
        return o;
      });
    },

    setParameter: (name, value) => {
      const layer = getFocusedLayer();
      if (!(name in layer.inputValues)) return { ok: false, error: `Unknown parameter: ${name}` };
      layer.inputValues[name] = value;
      if (layer.id === 'scene') sceneRenderer.inputValues = layer.inputValues;
      window.shaderClaw.updateControlUI(name, value, layer.id);
      return { ok: true };
    },

    screenshot: () => {
      return glCanvas.toDataURL('image/png');
    },

    updateControlUI: (name, value, layerId) => {
      const container = document.querySelector(`.layer-params[data-layer="${layerId || focusedLayerId}"]`);
      if (!container) return;
      const rows = container.querySelectorAll('.control-row, .cam-toggle-row[data-name]');
      for (const row of rows) {
        if (row.dataset.name !== name) continue;
        const range = row.querySelector('input[type="range"]');
        if (range && typeof value === 'number') {
          range.value = value;
          const valSpan = row.querySelector('.val');
          if (valSpan) valSpan.textContent = value.toFixed(2);
        }
        const color = row.querySelector('input[type="color"]');
        if (color && Array.isArray(value)) {
          const cr = Math.round(Math.max(0, Math.min(1, value[0])) * 255).toString(16).padStart(2, '0');
          const cg = Math.round(Math.max(0, Math.min(1, value[1])) * 255).toString(16).padStart(2, '0');
          const cb = Math.round(Math.max(0, Math.min(1, value[2])) * 255).toString(16).padStart(2, '0');
          color.value = '#' + cr + cg + cb;
        }
        const cb = row.querySelector('input[type="checkbox"]');
        if (cb && typeof value === 'boolean') cb.checked = value;
        // cam-switch toggle (transparentBg)
        const camSwitch = row.querySelector('.cam-switch');
        if (camSwitch && typeof value === 'boolean') camSwitch.classList.toggle('active', value);
        const sel = row.querySelector('select');
        if (sel && typeof value === 'number') sel.value = value;
        const arrows = row.querySelector('.direction-arrows');
        if (arrows && typeof value === 'number') {
          arrows.querySelectorAll('.direction-arrow-btn').forEach(b => {
            b.classList.toggle('active', parseFloat(b.dataset.value) === value);
          });
        }
        break;
      }
    },

    addMedia: async (name, dataUrl) => {
      const entry = await addMediaFromDataUrl(name, dataUrl);
      if (!entry) return { ok: false, error: 'Failed to load media' };
      return { ok: true, id: entry.id, name: entry.name, type: entry.type };
    },

    getMedia: () => mediaInputs.map(m => ({ id: m.id, name: m.name, type: m.type })),

    removeMedia: (id) => {
      const exists = mediaInputs.find(m => m.id === id);
      if (!exists) return { ok: false, error: `Unknown media id: ${id}` };
      removeMedia(id);
      return { ok: true };
    },

    addWebcam: addMediaFromWebcam,

    // Layer API
    setLayerVisibility: (layerId, visible) => {
      const layer = getLayer(layerId);
      if (!layer) return { ok: false, error: 'Unknown layer' };
      layer.visible = visible;
      updateLayerCardUI(layerId);
      return { ok: true };
    },

    setLayerOpacity: (layerId, opacity) => {
      const layer = getLayer(layerId);
      if (!layer) return { ok: false, error: 'Unknown layer' };
      layer.opacity = Math.max(0, Math.min(1, opacity));
      updateLayerCardUI(layerId);
      return { ok: true };
    },

    enableMediaPipe: async (modes) => {
      try {
        // Ensure webcam is available for detection
        const hasWebcam = mediaInputs.some(m => m.name === 'Webcam' && m.type === 'video');
        if (!hasWebcam) await addMediaFromWebcam();
        // Sync mode state with UI
        if (modes) {
          for (const k of ['hand', 'face', 'pose', 'segment']) {
            if (k in modes) mpModeState[k] = modes[k];
          }
          // Update mode button UI
          document.querySelectorAll('.mp-mode-btn').forEach(btn => {
            btn.classList.toggle('active', !!mpModeState[btn.dataset.mpMode]);
          });
        }
        await mediaPipeMgr.init(mpModeState);
        // Add MediaPipe media entry if not already present
        if (!mediaInputs.some(m => m._isMediaPipe)) {
          const id = ++mediaIdCounter;
          mediaInputs.push({ id, name: mediaPipeMgr.getLabel(), type: 'mediapipe', element: null, glTexture: null, threeTexture: null, threeModel: null, _isMediaPipe: true });
          renderMediaList();
        }
        // Enable gesture processing + show UI
        gestureEnabled = true;
        document.getElementById('cam-mediapipe-btn').classList.add('active');
        document.getElementById('mp-modes-row').style.display = '';
        document.getElementById('hand-as-mouse-row').style.display = '';
        return { ok: true, label: mediaPipeMgr.getLabel() };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    getAudioLevels: () => ({
      level: audioLevel, bass: audioBass, mid: audioMid, high: audioHigh,
      hasAudio: !!activeAudioEntry,
    }),

    setVarFontWeight,
    setVarFontFamily,
    layers,
    getLayer,
    getLayers: () => layers.map(l => ({ id: l.id, type: l.type, visible: l.visible, opacity: l.opacity, blendMode: l.blendMode })),
    compileToLayer,

    setSceneFlip: (flipH, flipV) => {
      const layer = getLayer('scene');
      if (!layer) return { ok: false, error: 'Scene layer not found' };
      layer.sceneFlipH = !!flipH;
      layer.sceneFlipV = !!flipV;
      const card = document.querySelector('.layer-card[data-layer="scene"]');
      if (card) {
        const fh = card.querySelector('.scene-flip-h');
        if (fh) fh.classList.toggle('active', layer.sceneFlipH);
        const fv = card.querySelector('.scene-flip-v');
        if (fv) fv.classList.toggle('active', layer.sceneFlipV);
      }
      return { ok: true };
    },

    setCustomShader: (vertexShader, fragmentShader, uniforms) => {
      if (!sceneRenderer.sceneDef || !sceneRenderer.sceneDef.setShader) {
        return { ok: false, error: 'Custom Material scene not loaded' };
      }
      sceneRenderer.sceneDef.setShader(vertexShader, fragmentShader, uniforms);
      // Rebuild UI with dynamic INPUTS from uniform definitions
      const dynamicInputs = uniformDefsToISFInputs(uniforms || sceneRenderer.sceneDef.getCustomUniforms());
      const sceneLayer = getLayer('scene');
      const staticInputs = sceneRenderer.inputs;
      sceneLayer.inputs = [...staticInputs, ...dynamicInputs];
      const paramsContainer = document.querySelector('.layer-params[data-layer="scene"]');
      if (paramsContainer) {
        sceneLayer.inputValues = generateControls(sceneLayer.inputs, paramsContainer, (vals) => {
          sceneRenderer.inputValues = vals;
          sceneLayer.inputValues = vals;
          autoBindTextures('scene');
        });
        hoistColorRows('scene');
        sceneRenderer.inputValues = sceneLayer.inputValues;
      }
      return { ok: true, inputs: dynamicInputs.map(i => i.NAME) };
    },
  };

  // --- Auto-compile on change ---
  let compileTimeout = null;
  editor.on('change', () => {
    if (!document.getElementById('auto-compile').checked) return;
    clearTimeout(compileTimeout);
    compileTimeout = setTimeout(compile, 600);
  });

  // --- Buttons ---
  document.getElementById('compile-btn').addEventListener('click', compile);

  let compositionPlaying = false; // start paused — loadDefaults enables after compile

  document.getElementById('play-btn').addEventListener('click', () => {
    compositionPlaying = !compositionPlaying;
    document.getElementById('play-btn').innerHTML = compositionPlaying
      ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>'
      : '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="5" y="3" width="4" height="18" rx="1"/><rect x="15" y="3" width="4" height="18" rx="1"/></svg>';
  });

  document.getElementById('fs-btn').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.getElementById('preview').requestFullscreen();
  });

  // Picture-in-Picture
  {
    let pipVideo = null;
    const pipBtn = document.getElementById('pip-btn');
    pipBtn.addEventListener('click', async () => {
      try {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
          return;
        }
        if (!pipVideo) {
          pipVideo = document.createElement('video');
          pipVideo.muted = true;
          pipVideo.playsInline = true;
          pipVideo.autoplay = true;
          // Position offscreen (display:none blocks PiP in some browsers)
          pipVideo.style.cssText = 'position:fixed;top:-9999px;left:-9999px;pointer-events:none;';
          document.body.appendChild(pipVideo);
        }
        // Set video dimensions to match canvas resolution (custom canvas size)
        pipVideo.width = glCanvas.width;
        pipVideo.height = glCanvas.height;
        // Adaptive PiP framerate: 24fps for large canvases (>4M pixels), 30fps otherwise
        const pipPixels = glCanvas.width * glCanvas.height;
        const pipFps = pipPixels > 4000000 ? 24 : 30;
        const stream = glCanvas.captureStream(pipFps);
        pipVideo.srcObject = stream;
        await pipVideo.play();
        await pipVideo.requestPictureInPicture();
        pipBtn.classList.add('active');
        pipVideo.addEventListener('leavepictureinpicture', () => {
          pipBtn.classList.remove('active');
        }, { once: true });
      } catch (e) {
        console.warn('[PiP] Failed:', e.message);
        pipBtn.classList.remove('active');
      }
    });
  }

  // Fullscreen change — refresh cached rects, resize Three.js, update gizmo
  let _fsCursorTimer = null;
  document.addEventListener('fullscreenchange', () => {
    _glCanvasRect = _glCanvasEl.getBoundingClientRect();
    if (sceneRenderer) sceneRenderer.resize();
    // Force gizmo canvas to re-measure on next frame
    requestAnimationFrame(() => {
      _glCanvasRect = _glCanvasEl.getBoundingClientRect();
    });
    // Clear cursor timer when exiting fullscreen
    if (!document.fullscreenElement) {
      clearTimeout(_fsCursorTimer);
      document.getElementById('preview').classList.remove('show-cursor');
    }
  });

  // Show cursor briefly on mouse move in fullscreen, then auto-hide
  document.getElementById('preview').addEventListener('mousemove', () => {
    if (!document.fullscreenElement) return;
    const preview = document.getElementById('preview');
    preview.classList.add('show-cursor');
    clearTimeout(_fsCursorTimer);
    _fsCursorTimer = setTimeout(() => preview.classList.remove('show-cursor'), 2000);
  });

  document.getElementById('new-btn').addEventListener('click', () => {
    loadSource(BLANK_SHADER);
    // Focus the chat bar to invite creation
    const chatInput = document.querySelector('.sc3-chat-input');
    if (chatInput) {
      chatInput.placeholder = 'Describe what you want to create...';
      setTimeout(() => chatInput.focus(), 200);
    }
  });

  document.getElementById('download-btn').addEventListener('click', () => {
    const blob = new Blob([editor.getValue()], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'shader.fs';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // --- Load Shader Library + Populate Layer Dropdowns ---
  let manifest = [];
  try {
    const resp = await fetch('shaders/manifest.json');
    manifest = await resp.json();
  } catch (e) {
    console.warn('Could not load shader manifest:', e);
  }

  const scenes = manifest.filter(item => item.type === 'scene' && !item.hidden);
  const isfShaders = manifest.filter(item => item.type !== 'scene' && !item.hidden);
  const textShaders = isfShaders.filter(item => (item.categories || []).includes('Text'));
  const otherShaders = isfShaders.filter(item => !(item.categories || []).includes('Text'));

  // Populate layer shader dropdowns from manifest
  function populateShaderDropdown(layerId) {
    const select = document.querySelector(`.layer-shader-select[data-layer="${layerId}"]`);
    if (!select) return;
    select.innerHTML = '';

    let items;
    if (layerId === 'scene') {
      items = scenes;
    } else if (layerId === 'text') {
      items = isfShaders.filter(item => (item.categories || []).includes('Text'));
    } else if (layerId === 'overlay') {
      return; // overlay has no shader presets
    } else {
      items = isfShaders.filter(item => !(item.categories || []).includes('Text'));
    }

    // Sort alphabetically by title
    items = items.slice().sort((a, b) => (a.title || '').localeCompare(b.title || ''));

    // Add placeholder so first real selection triggers change event
    const layer = getLayer(layerId);
    if (!layer || !layer.manifestEntry) {
      const ph = document.createElement('option');
      ph.value = '';
      ph.disabled = true;
      ph.selected = true;
      ph.textContent = '\u2014';
      select.appendChild(ph);
    }

    // Add Fluid Simulation option for shader layer
    if (layerId === 'shader') {
      const fluidOpt = document.createElement('option');
      fluidOpt.value = '__fluid__';
      fluidOpt.textContent = '\u2500 Fluid Simulation';
      select.appendChild(fluidOpt);
    }

    items.forEach(item => {
      const opt = document.createElement('option');
      opt.value = item.file;
      opt.dataset.folder = item.folder || (layerId === 'scene' ? 'scenes' : 'shaders');
      opt.textContent = item.title;
      select.appendChild(opt);
    });

    // Set current value if a shader is already loaded
    if (layer && layer.manifestEntry) {
      select.value = layer.manifestEntry.file;
    }
  }

  // Populate all layer dropdowns on init
  populateShaderDropdown('text');
  populateShaderDropdown('shader');
  populateShaderDropdown('scene');

  // Layer dropdown change handlers — loads selected shader/scene
  document.querySelectorAll('.layer-shader-select').forEach(select => {
    select.addEventListener('change', async () => {
      const layerId = select.dataset.layer;
      const file = select.value;
      if (!file) return;
      const opt = select.querySelector(`option[value="${CSS.escape(file)}"]`);
      const folder = opt ? (opt.dataset.folder || 'shaders') : 'shaders';
      const item = manifest.find(m => m.file === file);
      const layer = getLayer(layerId);
      if (layer && item) layer.manifestEntry = item;

      // Fluid simulation special case
      if (file === '__fluid__') {
        // Deactivate any ISF shader on this layer
        if (layer) layer.program = null;
        activateFluidOnLayer(layerId);
        return;
      }
      // Switching away from fluid/shadertoy — deactivate if was active
      if (layer && layer._fluidActive) deactivateFluid(layerId);
      if (layer && layer._shadertoyActive) deactivateShadertoy(layerId);

      if (layerId === 'scene') {
        await loadScene(folder, file);
        layer.visible = true;
        updateLayerCardUI(layerId);
        syncToggleSection(layerId, true);
      } else {
        await loadShaderToLayer(layerId, folder, file);
        layer.visible = true;
        updateLayerCardUI(layerId);
        syncToggleSection(layerId, true);
      }
    });
  });

  // --- Shader Browser ---
  const browserOverlay = document.getElementById('shader-browser');
  const browserBackdrop = document.getElementById('shader-browser-backdrop');
  const browserBody = browserOverlay ? browserOverlay.querySelector('.browser-body') : null;
  const browserSearch = browserOverlay ? browserOverlay.querySelector('.browser-search') : null;
  const browserClose = browserOverlay ? browserOverlay.querySelector('.browser-close') : null;
  let browserTargetLayer = null;

  function openShaderBrowser(layerId) {
    browserTargetLayer = layerId;
    if (!browserOverlay || !browserBody) return;
    browserBody.innerHTML = '';
    browserSearch.value = '';

    // Build category groups
    const categories = {};
    const list = layerId === 'scene' ? scenes : isfShaders;
    list.forEach(item => {
      const cats = item.categories || ['Uncategorized'];
      cats.forEach(cat => {
        if (!categories[cat]) categories[cat] = [];
        categories[cat].push(item);
      });
    });

    for (const [cat, items] of Object.entries(categories)) {
      const section = document.createElement('div');
      section.className = 'browser-category';
      section.innerHTML = `<div class="browser-category-title">${cat}</div>`;
      const grid = document.createElement('div');
      grid.className = 'browser-grid';
      items.forEach(item => {
        const el = document.createElement('div');
        el.className = 'browser-item';
        el.textContent = item.title;
        el.dataset.search = item.title.toLowerCase();
        el.addEventListener('click', async () => {
          closeBrowser();
          const layer = getLayer(layerId);
          // Deactivate fluid/shadertoy if switching to a regular shader
          if (layer && layer._fluidActive) deactivateFluid(layerId);
          if (layer && layer._shadertoyActive) deactivateShadertoy(layerId);
          // Store manifest entry before loading so populatePresetDropdown has title fallback
          if (layer) layer.manifestEntry = item;
          const folder = item.folder || (layerId === 'scene' ? 'scenes' : 'shaders');
          if (layerId === 'scene') {
            await loadScene(folder, item.file);
          } else {
            await loadShaderToLayer(layerId, folder, item.file);
          }
        });
        grid.appendChild(el);
      });
      section.appendChild(grid);
      browserBody.appendChild(section);
    }

    // Add Fluid Simulation + Shadertoy Import as special entries (shader layer only)
    if (layerId === 'shader') {
      const specialSection = document.createElement('div');
      specialSection.className = 'browser-category';
      specialSection.innerHTML = '<div class="browser-category-title">Simulation</div>';
      const specialGrid = document.createElement('div');
      specialGrid.className = 'browser-grid';

      // Fluid sim
      const fluidItem = document.createElement('div');
      fluidItem.className = 'browser-item';
      fluidItem.textContent = 'Fluid';
      fluidItem.dataset.search = 'fluid simulation navier stokes water smoke';
      fluidItem.addEventListener('click', () => {
        closeBrowser();
        activateFluidOnLayer('shader');
      });
      specialGrid.appendChild(fluidItem);

      // CFD Paint
      const cfdItem = document.createElement('div');
      cfdItem.className = 'browser-item';
      cfdItem.textContent = 'CFD Paint';
      cfdItem.dataset.search = 'cfd paint fluid ink water computational dynamics';
      cfdItem.addEventListener('click', () => {
        closeBrowser();
        _activateCFDPaint('shader');
      });
      specialGrid.appendChild(cfdItem);

      specialSection.appendChild(specialGrid);
      browserBody.insertBefore(specialSection, browserBody.firstChild);

      // Shadertoy import section
      const stSection = document.createElement('div');
      stSection.className = 'browser-category';
      stSection.innerHTML = '<div class="browser-category-title">Import from Shadertoy</div>';
      const stRow = document.createElement('div');
      stRow.style.cssText = 'display:flex;gap:6px;padding:4px 0';
      const stInput = document.createElement('input');
      stInput.type = 'text';
      stInput.placeholder = 'Paste Shadertoy URL or ID...';
      stInput.style.cssText = 'flex:1;background:var(--bg-2,#1a1a1a);border:1px solid var(--border,#333);color:var(--fg,#ccc);padding:6px 8px;border-radius:4px;font-size:12px';
      stInput.dataset.search = 'shadertoy import url paste buffer';
      const stBtn = document.createElement('button');
      stBtn.textContent = 'Import';
      stBtn.style.cssText = 'background:var(--accent,#E84057);color:#fff;border:none;padding:6px 14px;border-radius:4px;cursor:pointer;font-size:12px;white-space:nowrap';
      stBtn.addEventListener('click', () => _importShadertoy(stInput.value, layerId));
      stInput.addEventListener('keydown', e => { if (e.key === 'Enter') _importShadertoy(stInput.value, layerId); });
      stRow.appendChild(stInput);
      stRow.appendChild(stBtn);
      stSection.appendChild(stRow);
      browserBody.insertBefore(stSection, browserBody.firstChild);
    }

    browserOverlay.classList.add('visible');
    browserBackdrop.classList.add('visible');
    browserSearch.focus();
  }

  // ── Fluid simulation activation ──────────────────────────
  function activateFluidOnLayer(layerId) {
    const layer = getLayer(layerId);
    if (!layer) return;

    // Deactivate fluid on any other layer
    layers.forEach(l => { l._fluidActive = false; });

    // Init fluid renderer if needed
    if (!fluidRenderer.active) {
      fluidRenderer.init();
      // Fire initial random splats for visual impact
      fluidRenderer.splatRandom(Math.floor(Math.random() * 10) + 5);
    }

    layer._fluidActive = true;
    layer.visible = true;
    layer.opacity = 1.0;
    layer.manifestEntry = { title: 'Fluid', file: '__fluid__', type: 'fluid', categories: ['Simulation'] };

    // Generate fluid controls in the params panel
    const paramsContainer = document.querySelector('.layer-params[data-layer="' + layerId + '"]');
    if (paramsContainer) {
      const fluidInputs = fluidRenderer.getInputs();
      layer.inputs = fluidInputs;
      layer.inputValues = generateControls(fluidInputs, paramsContainer, (vals) => {
        layer.inputValues = vals;
        // Forward param changes to fluid renderer
        for (const key in vals) {
          fluidRenderer.setParam(key, vals[key]);
        }
      });
    }

    updateLayerCardUI(layerId);
    syncToggleSection(layerId, true);
    console.log('[ShaderClaw] Fluid simulation activated on layer:', layerId);
  }

  function deactivateFluid(layerId) {
    const layer = getLayer(layerId);
    if (layer) layer._fluidActive = false;
    if (fluidRenderer.active) {
      fluidRenderer.destroy();
    }
  }

  // ── Shadertoy import ──────────────────────────────────────
  async function _importShadertoy(urlOrId, layerId) {
    const imp = window._shadertoyImport;
    if (!imp) { console.error('Shadertoy importer not loaded'); return; }

    const shaderId = imp.parseShadertoyUrl(urlOrId);
    if (!shaderId) {
      errorBar.textContent = 'Invalid Shadertoy URL or ID';
      errorBar.classList.add('show');
      return;
    }

    errorBar.textContent = 'Importing from Shadertoy...';
    errorBar.classList.add('show');

    try {
      const shader = await imp.fetchShadertoyShader(shaderId);
      const renderPasses = shader.renderpass || [];

      // Deactivate fluid/shadertoy if active
      const layer = getLayer(layerId);
      if (layer && layer._fluidActive) deactivateFluid(layerId);
      if (layer && layer._shadertoyActive) {
        shadertoyRenderer.destroy();
        layer._shadertoyActive = false;
      }
      // Clear ISF program so it doesn't interfere
      layer.program = null;

      closeBrowser();

      // Build passes + channel bindings for ShadertoyRenderer
      const passes = {};
      const channels = {};

      // Map Shadertoy output IDs to buffer letters
      const outputToLetter = {};
      for (const rp of renderPasses) {
        if (rp.type === 'buffer' && rp.outputs?.[0]?.id != null) {
          const letter = String.fromCharCode(65 + (rp.outputs[0].id - 97));
          outputToLetter[rp.outputs[0].id] = letter;
        }
      }

      for (const rp of renderPasses) {
        let passKey;
        if (rp.type === 'image') {
          passKey = 'image';
        } else if (rp.type === 'buffer' && rp.outputs?.[0]?.id != null) {
          passKey = 'buffer' + outputToLetter[rp.outputs[0].id];
        } else if (rp.type === 'common') {
          // Prepend common code to all other passes
          for (const rp2 of renderPasses) {
            if (rp2.type !== 'common') rp2.code = rp.code + '\n' + (rp2.code || '');
          }
          continue;
        } else {
          continue; // skip sound, cubemap, etc.
        }

        passes[passKey] = rp.code;
        channels[passKey] = {};

        // Map iChannel bindings
        for (const inp of (rp.inputs || [])) {
          const ch = inp.channel;
          if (ch == null) continue;
          if (inp.ctype === 'buffer' && outputToLetter[inp.id] != null) {
            channels[passKey][ch] = outputToLetter[inp.id];
          } else {
            channels[passKey][ch] = 'noise'; // fallback to noise
          }
        }
      }

      if (!passes.image) {
        errorBar.textContent = 'No image pass found in shader';
        errorBar.classList.add('show');
        return;
      }

      // Compile with ShadertoyRenderer (bypasses ISF entirely)
      const ok = shadertoyRenderer.compile(passes, channels);
      if (ok) {
        layer._shadertoyActive = true;
        layer.visible = true;
        layer.opacity = 1.0;
        layer.manifestEntry = { title: shader.info?.name || 'Shadertoy', file: '__shadertoy_' + shaderId + '__', type: 'imported' };
        updateLayerCardUI(layerId);
        syncToggleSection(layerId, true);
        errorBar.textContent = '';
        errorBar.classList.remove('show');
        console.log('[ShaderClaw] Shadertoy import OK:', shader.info?.name, '(' + shaderId + ')');
      } else {
        const err = window._lastShadertoyError || 'Unknown compile error';
        errorBar.textContent = 'Shader compile error: ' + err.split('\n')[0];
        errorBar.classList.add('show');
      }
    } catch (e) {
      errorBar.textContent = 'Shadertoy import failed: ' + e.message;
      errorBar.classList.add('show');
      console.error('[ShaderClaw] Shadertoy import error:', e);
    }
  }

  function deactivateShadertoy(layerId) {
    const layer = getLayer(layerId);
    if (layer) layer._shadertoyActive = false;
    if (shadertoyRenderer.active) shadertoyRenderer.destroy();
  }

  // CFD Paint — hardcoded Shadertoy-style shader
  function _activateCFDPaint(layerId) {
    const layer = getLayer(layerId);
    if (!layer) return;
    if (layer._fluidActive) deactivateFluid(layerId);
    if (layer._shadertoyActive) deactivateShadertoy(layerId);
    layer.program = null;

    const bufferA = `
#define RotNum 3
#define PI2 6.28318530718

float hash21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 Res = iResolution.xy;
    vec2 pos = fragCoord;
    vec2 uv = pos / Res;

    float ang = PI2 / 3.0;
    float ca = cos(ang), sa = sin(ang);
    float cah = cos(ang * 0.5), sah = sin(ang * 0.5);

    float rnd = hash21(vec2(float(iFrame) * 0.1, 0.37));
    vec2 b = vec2(cos(ang * rnd), sin(ang * rnd));
    vec2 v = vec2(0.0);
    float maxR2 = Res.y * Res.y * 0.49;

    for (int level = 0; level < 8; level++) {
        float bb = dot(b, b);
        if (bb > maxR2) break;

        vec2 d0 = b;
        vec2 d1 = vec2(ca*b.x - sa*b.y, sa*b.x + ca*b.y);
        vec2 d2 = vec2(ca*b.x + sa*b.y, -sa*b.x + ca*b.y);

        vec2 h0 = vec2(cah*b.x - sah*b.y, sah*b.x + cah*b.y);
        vec2 h1 = vec2(ca*h0.x - sa*h0.y, sa*h0.x + ca*h0.y);
        vec2 h2 = vec2(ca*h0.x + sa*h0.y, -sa*h0.x + ca*h0.y);

        vec2 s0a = texture2D(iChannel0, fract((pos+d0+d0)/Res)).xy-0.5;
        vec2 s0b = texture2D(iChannel0, fract((pos+d0+d1)/Res)).xy-0.5;
        vec2 s0c = texture2D(iChannel0, fract((pos+d0+d2)/Res)).xy-0.5;
        v += d0.yx * (dot(s0a,h0)+dot(s0b,h1)+dot(s0c,h2)) / bb;

        vec2 s1a = texture2D(iChannel0, fract((pos+d1+d0)/Res)).xy-0.5;
        vec2 s1b = texture2D(iChannel0, fract((pos+d1+d1)/Res)).xy-0.5;
        vec2 s1c = texture2D(iChannel0, fract((pos+d1+d2)/Res)).xy-0.5;
        v += d1.yx * (dot(s1a,h0)+dot(s1b,h1)+dot(s1c,h2)) / bb;

        vec2 s2a = texture2D(iChannel0, fract((pos+d2+d0)/Res)).xy-0.5;
        vec2 s2b = texture2D(iChannel0, fract((pos+d2+d1)/Res)).xy-0.5;
        vec2 s2c = texture2D(iChannel0, fract((pos+d2+d2)/Res)).xy-0.5;
        v += d2.yx * (dot(s2a,h0)+dot(s2b,h1)+dot(s2c,h2)) / bb;

        b *= 2.0;
    }

    vec2 advUV = fract((pos + v * vec2(-1.0, 1.0) * 2.0) / Res);
    fragColor = texture2D(iChannel0, advUV);

    if (iFrame < 3) {
        float h1 = hash21(pos * 0.01 + 0.5);
        float h2 = hash21(pos * 0.007 + 17.3);
        float h3 = hash21(pos * 0.013 + 43.7);
        float a = atan(uv.y - 0.5, uv.x - 0.5);
        float dist = length(uv - 0.5);
        float pat = sin(a*3.0 + dist*12.0)*0.5+0.5;
        fragColor = vec4(
            0.91*pat + (1.0-pat)*h2,
            0.25*(1.0-pat) + pat*h3,
            0.34*pat + (1.0-pat)*h1,
            1.0
        );
    }
}`;

    const imagePass = `
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.xy;
    vec4 col = texture2D(iChannel0, uv);

    // Surface normal from luminance gradient
    float d = 1.0 / iResolution.y;
    float lL = length(texture2D(iChannel0, uv + vec2(-d, 0.0)).rgb);
    float lR = length(texture2D(iChannel0, uv + vec2( d, 0.0)).rgb);
    float lU = length(texture2D(iChannel0, uv + vec2(0.0,  d)).rgb);
    float lD = length(texture2D(iChannel0, uv + vec2(0.0, -d)).rgb);
    vec3 n = normalize(vec3((lR - lL) * 150.0, (lU - lD) * 150.0, 1.0));

    vec3 lightDir = normalize(vec3(1.0, 1.0, 2.0));
    float diff = clamp(dot(n, lightDir), 0.5, 1.0);
    float spec = pow(clamp(dot(reflect(-lightDir, n), vec3(0.0, 0.0, 1.0)), 0.0, 1.0), 36.0) * 2.5;

    fragColor = col * diff + vec4(vec3(spec), 0.0);
    fragColor.a = 1.0;
}`;

    const ok = shadertoyRenderer.compile(
      { bufferA: bufferA, image: imagePass },
      { bufferA: { 0: 'A' }, image: { 0: 'A' } }  // Buffer A reads itself, Image reads Buffer A
    );

    if (ok) {
      layer._shadertoyActive = true;
      layer.visible = true;
      layer.opacity = 1.0;
      layer.manifestEntry = { title: 'CFD Paint', file: '__cfd_paint__', type: 'simulation' };
      updateLayerCardUI(layerId);
      syncToggleSection(layerId, true);
      console.log('[ShaderClaw] CFD Paint activated');
    } else {
      errorBar.textContent = 'CFD Paint compile failed: ' + (window._lastShadertoyError || '').split('\n')[0];
      errorBar.classList.add('show');
    }
  }

  // Expose for MCP / external
  window._fluidRenderer = fluidRenderer;
  window._activateFluid = activateFluidOnLayer;
  window._importShadertoy = _importShadertoy;

  function closeBrowser() {
    if (browserOverlay) browserOverlay.classList.remove('visible');
    if (browserBackdrop) browserBackdrop.classList.remove('visible');
    browserTargetLayer = null;
  }

  if (browserClose) browserClose.addEventListener('click', closeBrowser);
  if (browserBackdrop) browserBackdrop.addEventListener('click', closeBrowser);
  if (browserSearch) {
    browserSearch.addEventListener('input', () => {
      const q = browserSearch.value.toLowerCase();
      browserBody.querySelectorAll('.browser-item').forEach(el => {
        el.style.display = el.dataset.search.includes(q) ? '' : 'none';
      });
    });
  }

  // --- Layer Card UI Handlers ---
  function updateLayerCardUI(layerId) {
    const layer = getLayer(layerId);
    if (!layer) return;
    // Find controls either in a dedicated card or by data-layer attribute anywhere
    const card = document.querySelector(`.layer-card[data-layer="${layerId}"]`);
    // Update shader title name next to the eye icon
    if (card) {
      const nameSpan = card.querySelector('.layer-name');
      if (nameSpan) nameSpan.textContent = layer.manifestEntry ? layer.manifestEntry.title : (layerId === 'shader' ? 'Shader' : layerId);
    }
    // Also update toggle section labels (text, scene)
    const toggleLabel = document.querySelector(`.layer-toggle-header[data-layer="${layerId}"] .layer-toggle-label`);
    if (toggleLabel && layer.manifestEntry) toggleLabel.textContent = layer.manifestEntry.title;
    // Vis buttons — find all with matching data-layer (supports type-content tabs)
    document.querySelectorAll(`.layer-vis[data-layer="${layerId}"]`).forEach(visBtn => {
      visBtn.classList.toggle('hidden', !layer.visible);
      const eyeOn = visBtn.querySelector('.eye-on');
      const eyeOff = visBtn.querySelector('.eye-off');
      if (eyeOn) eyeOn.style.display = layer.visible ? '' : 'none';
      if (eyeOff) eyeOff.style.display = layer.visible ? 'none' : '';
    });
    // Opacity/blend — find by data-layer attribute
    document.querySelectorAll(`.layer-opacity[data-layer="${layerId}"]`).forEach(s => { s.value = layer.opacity; });
    // Update the val span next to the opacity slider
    document.querySelectorAll(`.layer-opacity[data-layer="${layerId}"]`).forEach(s => {
      const val = s.closest('.layer-control-row')?.querySelector('.val');
      if (val) val.textContent = layer.opacity.toFixed(2);
    });
    document.querySelectorAll(`.layer-blend[data-layer="${layerId}"]`).forEach(s => { s.value = layer.blendMode; });
    // Sync compact row opacity display
    const compactOp = document.querySelector(`.sc3-layer-opacity-val[data-layer="${layerId}"]`);
    if (compactOp) compactOp.value = Math.round(layer.opacity * 100);
  }

  // Wire up all layer controls by data-layer attribute (works inside cards or type-content tabs)

  // Visibility toggles
  document.querySelectorAll('.layer-vis[data-layer]').forEach(visBtn => {
    const layerId = visBtn.dataset.layer;
    visBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const layer = getLayer(layerId);
      if (!layer) return;
      layer.visible = !layer.visible;
      updateLayerCardUI(layerId);
      syncToggleSection(layerId, layer.visible);
      if (typeof updateGalleryActiveStates === 'function') updateGalleryActiveStates();
    });
  });

  // Opacity sliders
  document.querySelectorAll('.layer-opacity[data-layer]').forEach(opSlider => {
    const layerId = opSlider.dataset.layer;
    opSlider.addEventListener('input', () => {
      const layer = getLayer(layerId);
      if (!layer) return;
      layer.opacity = parseFloat(opSlider.value);
      const opVal = opSlider.closest('.layer-control-row')?.querySelector('.val');
      if (opVal) opVal.textContent = layer.opacity.toFixed(2);
      // Sync compact row opacity display
      const compactOp = document.querySelector(`.sc3-layer-opacity-val[data-layer="${layerId}"]`);
      if (compactOp) compactOp.value = Math.round(layer.opacity * 100);
    });
  });

  // Blend mode selects
  document.querySelectorAll('.layer-blend[data-layer]').forEach(blendSel => {
    const layerId = blendSel.dataset.layer;
    blendSel.addEventListener('change', () => {
      const layer = getLayer(layerId);
      if (!layer) return;
      layer.blendMode = blendSel.value;
    });
  });

  // === Layer compact rows (swatch + hex + opacity% + dropdown toggle) ===
  document.querySelectorAll('.sc3-layer-row').forEach(row => {
    const layerId = row.dataset.layer;
    const dropdown = document.querySelector(`.sc3-layer-dropdown[data-layer="${layerId}"]`);
    const swatch = row.querySelector('.sc3-layer-swatch');
    const hexInput = row.querySelector('.sc3-layer-hex');
    const opacityInput = row.querySelector('.sc3-layer-opacity-val');
    const transpBtn = row.querySelector('.sc3-layer-transp');
    const picker = row.querySelector('.sc3-layer-color-picker');

    // Toggle dropdown on row click (skip interactive children)
    row.addEventListener('click', e => {
      if (e.target.closest('.sc3-layer-swatch') || e.target.closest('.sc3-layer-hex') ||
          e.target.closest('.sc3-layer-opacity-val') || e.target.closest('.sc3-layer-transp')) return;
      row.classList.toggle('open');
      if (dropdown) dropdown.classList.toggle('open');
    });

    // Swatch click → open native color picker
    if (swatch && picker) {
      swatch.addEventListener('click', e => {
        e.stopPropagation();
        picker.click();
      });
    }

    // Color picker change → update swatch + hex + layer bg color
    if (picker) {
      picker.addEventListener('input', () => {
        const hex = picker.value;
        if (swatch) swatch.style.background = hex;
        const toggleSwatch = document.querySelector(`.layer-toggle-swatch[data-layer="${layerId}"]`);
        if (toggleSwatch) toggleSwatch.style.background = hex;
        if (hexInput) hexInput.value = hex.replace('#', '').toUpperCase();
        // Apply to layer bg color
        const layer = getLayer(layerId);
        if (layer) {
          const r = parseInt(hex.substr(1, 2), 16) / 255;
          const g = parseInt(hex.substr(3, 2), 16) / 255;
          const b = parseInt(hex.substr(5, 2), 16) / 255;
          layer._bgColor = [r, g, b];
          // For text layers, also drive the textColor uniform
          if (layerId === 'text' && layer.inputValues) {
            layer.inputValues.textColor = [r, g, b, 1.0];
          }
        }
      });
    }

    // Hex input → update picker + swatch
    if (hexInput) {
      hexInput.addEventListener('click', e => e.stopPropagation());
      hexInput.addEventListener('input', () => {
        let v = hexInput.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 6);
        hexInput.value = v;
        if (v.length === 6) {
          if (picker) { picker.value = '#' + v; picker.dispatchEvent(new Event('input', { bubbles: true })); }
          if (swatch) swatch.style.background = '#' + v;
        }
      });
      hexInput.addEventListener('keydown', e => { if (e.key === 'Enter') { hexInput.blur(); e.preventDefault(); } });
    }

    // Opacity % input → update layer opacity + sync slider
    if (opacityInput) {
      opacityInput.addEventListener('click', e => e.stopPropagation());
      opacityInput.addEventListener('input', () => {
        let v = opacityInput.value.replace(/[^0-9]/g, '');
        let n = Math.min(100, Math.max(0, parseInt(v) || 0));
        opacityInput.value = n;
        const layer = getLayer(layerId);
        if (layer) {
          layer.opacity = n / 100;
          // Sync the range slider in the dropdown
          document.querySelectorAll(`.layer-opacity[data-layer="${layerId}"]`).forEach(s => {
            s.value = layer.opacity;
            const val = s.closest('.layer-control-row')?.querySelector('.val');
            if (val) val.textContent = layer.opacity.toFixed(2);
          });
        }
      });
      opacityInput.addEventListener('keydown', e => { if (e.key === 'Enter') { opacityInput.blur(); e.preventDefault(); } });
    }

    // Transparent BG toggle
    if (transpBtn) {
      transpBtn.addEventListener('click', e => {
        e.stopPropagation();
        const layer = getLayer(layerId);
        if (!layer) return;
        layer.transparentBg = !layer.transparentBg;
        transpBtn.classList.toggle('active', layer.transparentBg);
      });
    }
  });

  // Legacy: wire up layer-card specific interactions (header click for open/close)
  document.querySelectorAll('.layer-card').forEach(card => {
    const layerId = card.dataset.layer;

    // Scene flip toggles — use data-layer from the button, not the card
    const flipH = card.querySelector('.scene-flip-h');
    if (flipH) {
      flipH.addEventListener('click', () => {
        const layer = getLayer(flipH.dataset.layer || layerId);
        layer.sceneFlipH = !layer.sceneFlipH;
        flipH.classList.toggle('active', layer.sceneFlipH);
      });
    }
    const flipV = card.querySelector('.scene-flip-v');
    if (flipV) {
      flipV.addEventListener('click', () => {
        const layer = getLayer(flipV.dataset.layer || layerId);
        layer.sceneFlipV = !layer.sceneFlipV;
        flipV.classList.toggle('active', layer.sceneFlipV);
      });
    }
  });

  // === Camera card: Overlay image/GIF upload with transforms ===
  const overlayFileInput = document.createElement('input');
  overlayFileInput.type = 'file';
  overlayFileInput.accept = 'image/*,.gif,video/*,.mp4,.webm,.mov,.avi,.mkv';
  overlayFileInput.style.display = 'none';
  document.body.appendChild(overlayFileInput);

  // Initialize overlay transform state
  const overlayLayer = getLayer('overlay');
  overlayLayer._tx = 0;
  overlayLayer._ty = 0;
  overlayLayer._scale = 0.3; // ~sphere size by default
  overlayLayer._rotate = 0; // radians

  document.getElementById('overlay-upload-btn').addEventListener('click', () => {
    overlayFileInput.click();
  });

  function showOverlayFileInfo(name) {
    const info = document.getElementById('overlay-file-info');
    document.getElementById('overlay-file-name').textContent = name;
    info.style.display = 'flex';
  }
  function hideOverlayFileInfo() {
    document.getElementById('overlay-file-info').style.display = 'none';
    document.getElementById('overlay-file-name').textContent = '';
  }
  document.getElementById('overlay-file-remove').addEventListener('click', () => {
    clearOverlay();
  });

  overlayFileInput.addEventListener('change', () => {
    const file = overlayFileInput.files[0];
    if (!file) return;
    const isGif = file.type === 'image/gif' || file.name.toLowerCase().endsWith('.gif');
    const isVideo = file.type.startsWith('video/') || /\.(mp4|webm|mov|avi|mkv)$/i.test(file.name);
    const fileName = file.name;
    const url = URL.createObjectURL(file);

    if (isVideo) {
      // Handle video files for overlay
      const video = document.createElement('video');
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.style.cssText = 'position:fixed;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none';
      document.body.appendChild(video);
      video.addEventListener('stalled', () => { video.play().catch(() => {}); });
      video.addEventListener('loadeddata', () => {
        const gl = isfRenderer.gl;
        const oLayer = getLayer('overlay');
        if (!oLayer) return;
        if (!oLayer.fbo) oLayer.fbo = isfRenderer.createFBO(_rw(), _rh());
        // Upload first frame
        gl.bindTexture(gl.TEXTURE_2D, oLayer.fbo.texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        oLayer.visible = true;
        oLayer._hasImage = true;
        oLayer._imgAspect = video.videoWidth / video.videoHeight;
        oLayer._tx = 0;
        oLayer._ty = 0;
        oLayer._scale = Math.min(2, Math.max(0.1, Math.max(video.videoWidth / _rw(), video.videoHeight / _rh())));
        oLayer._rotate = 0;
        syncTransformSliders();
        updateLayerCardUI('overlay');
        gizmoSelected = true;
        showOverlayFileInfo(fileName);
        // Store video element for per-frame re-upload (like GIF but at full rate)
        oLayer._videoElement = video;
        oLayer._videoUrl = url;
        oLayer._gifElement = null;
        if (oLayer._gifUrl) { URL.revokeObjectURL(oLayer._gifUrl); oLayer._gifUrl = null; }
        video.play().catch(() => {
          // Retry on first user interaction if autoplay blocked
          document.addEventListener('click', () => { video.play().catch(() => {}); }, { once: true });
        });
      });
      video.src = url;
    } else {
      // Handle image/GIF files (original path)
      const img = new Image();
      img.onload = () => {
        const gl = isfRenderer.gl;
        const oLayer = getLayer('overlay');
        if (!oLayer) return;
        if (!oLayer.fbo) oLayer.fbo = isfRenderer.createFBO(_rw(), _rh());
        gl.bindTexture(gl.TEXTURE_2D, oLayer.fbo.texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        oLayer.visible = true;
        oLayer._hasImage = true;
        oLayer._imgAspect = img.naturalWidth / img.naturalHeight;
        oLayer._tx = 0;
        oLayer._ty = 0;
        oLayer._scale = Math.min(2, Math.max(0.1, Math.max(img.naturalWidth / _rw(), img.naturalHeight / _rh())));
        oLayer._rotate = 0;
        syncTransformSliders();
        updateLayerCardUI('overlay');
        gizmoSelected = true;
        showOverlayFileInfo(fileName);
        // Clean up video if switching from video to image
        oLayer._videoElement = null;
        if (oLayer._videoUrl) { URL.revokeObjectURL(oLayer._videoUrl); oLayer._videoUrl = null; }
        if (isGif) {
          oLayer._gifElement = img;
          oLayer._gifUrl = url;
        } else {
          oLayer._gifElement = null;
          if (oLayer._gifUrl) { URL.revokeObjectURL(oLayer._gifUrl); oLayer._gifUrl = null; }
          URL.revokeObjectURL(url);
        }
      };
      img.src = url;
    }
    overlayFileInput.value = '';
  });

  // Clipboard paste handler — paste images directly onto overlay
  document.addEventListener('paste', (e) => {
    // Skip if typing in a text input, textarea, or CodeMirror editor
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.target.closest('.cm-editor')) return;
    if (!e.clipboardData || !e.clipboardData.items) return;
    for (const item of e.clipboardData.items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (!blob) continue;
        const pasteName = blob.name || 'Pasted image';
        const img = new Image();
        const url = URL.createObjectURL(blob);
        img.onload = () => {
          const gl = isfRenderer.gl;
          const oLayer = getLayer('overlay');
          if (!oLayer) return;
          if (!oLayer.fbo) oLayer.fbo = isfRenderer.createFBO(_rw(), _rh());
          gl.bindTexture(gl.TEXTURE_2D, oLayer.fbo.texture);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          oLayer.visible = true;
          oLayer._hasImage = true;
          oLayer._imgAspect = img.naturalWidth / img.naturalHeight;
          oLayer._tx = 0;
          oLayer._ty = 0;
          oLayer._scale = Math.min(2, Math.max(0.1, Math.max(img.naturalWidth / _rw(), img.naturalHeight / _rh())));
          oLayer._rotate = 0;
          oLayer._gifElement = null;
          if (oLayer._gifUrl) { URL.revokeObjectURL(oLayer._gifUrl); oLayer._gifUrl = null; }
          URL.revokeObjectURL(url);
          syncTransformSliders();
          updateLayerCardUI('overlay');
          gizmoSelected = true;
          showOverlayFileInfo(pasteName);
        };
        img.src = url;
        break; // Only handle first image item
      }
    }
  });

  // Overlay clear function (no button, but kept for programmatic use)
  function clearOverlay() {
    const gl = isfRenderer.gl;
    const oLayer = getLayer('overlay');
    if (!oLayer) return;
    if (!oLayer.fbo) return; // nothing to clear
    gl.bindTexture(gl.TEXTURE_2D, oLayer.fbo.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, _rw(), _rh(), 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    oLayer.visible = false;
    oLayer._hasImage = false;
    oLayer._imgAspect = null;
    oLayer._gifElement = null;
    if (oLayer._gifUrl) { URL.revokeObjectURL(oLayer._gifUrl); oLayer._gifUrl = null; }
    if (oLayer._videoElement) { oLayer._videoElement.pause(); oLayer._videoElement.remove(); oLayer._videoElement = null; }
    if (oLayer._videoUrl) { URL.revokeObjectURL(oLayer._videoUrl); oLayer._videoUrl = null; }
    hideOverlayFileInfo();
    gizmoSelected = false;
    updateLayerCardUI('overlay');
  }

  // Overlay transform sliders
  document.getElementById('overlay-tx').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    getLayer('overlay')._tx = v;
    document.getElementById('overlay-tx-val').textContent = v.toFixed(2);
  });
  document.getElementById('overlay-ty').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    getLayer('overlay')._ty = v;
    document.getElementById('overlay-ty-val').textContent = v.toFixed(2);
  });
  document.getElementById('overlay-scale').addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    getLayer('overlay')._scale = v;
    document.getElementById('overlay-scale-val').textContent = v.toFixed(2);
  });
  document.getElementById('overlay-rotate').addEventListener('input', (e) => {
    const deg = parseFloat(e.target.value);
    getLayer('overlay')._rotate = deg * Math.PI / 180;
    document.getElementById('overlay-rotate-val').innerHTML = deg + '&#176;';
  });

  // === Overlay Gizmo — interactive transform handles ===
  const gizmoCanvas = document.getElementById('overlay-gizmo');
  const gCtx = gizmoCanvas.getContext('2d');
  let gizmoDrag = null;
  let gizmoSelected = true;

  // Cached DOM references for gizmo (avoid per-frame getElementById + getBoundingClientRect)
  const _glCanvasEl = document.getElementById('gl-canvas');
  let _glCanvasRect = _glCanvasEl.getBoundingClientRect();
  window.addEventListener('resize', () => {
    _glCanvasRect = _glCanvasEl.getBoundingClientRect();
    // Resize FBOs to match new canvas dimensions
    const w = _rw(), h = _rh();
    layers.forEach(layer => {
      if (!layer.fbo) return;
      isfRenderer.destroyFBO(layer.fbo);
      layer.fbo = isfRenderer.createFBO(w, h);
    });
    if (canvasBg.shaderFBO) {
      isfRenderer.destroyFBO(canvasBg.shaderFBO);
      canvasBg.shaderFBO = isfRenderer.createFBO(w, h);
      canvasBg.texture = canvasBg.shaderFBO.texture;
      if (canvasBg.shaderLayer) canvasBg.shaderLayer.fbo = canvasBg.shaderFBO;
    }
    sceneRenderer.resize();
  });
  // Also refresh after any style/layout change that might shift the canvas
  new ResizeObserver(() => { _glCanvasRect = _glCanvasEl.getBoundingClientRect(); }).observe(_glCanvasEl);

  function syncTransformSliders() {
    const o = getLayer('overlay');
    const txS = document.getElementById('overlay-tx');
    const tyS = document.getElementById('overlay-ty');
    const scS = document.getElementById('overlay-scale');
    const rtS = document.getElementById('overlay-rotate');
    txS.value = Math.max(-1, Math.min(1, o._tx));
    document.getElementById('overlay-tx-val').textContent = o._tx.toFixed(2);
    tyS.value = Math.max(-1, Math.min(1, o._ty));
    document.getElementById('overlay-ty-val').textContent = o._ty.toFixed(2);
    scS.value = Math.max(0.1, Math.min(5, o._scale));
    document.getElementById('overlay-scale-val').textContent = o._scale.toFixed(2);
    const deg = o._rotate * 180 / Math.PI;
    rtS.value = Math.max(-180, Math.min(180, deg));
    document.getElementById('overlay-rotate-val').innerHTML = Math.round(deg) + '&#176;';
  }

  function gizmoGeometry() {
    const o = getLayer('overlay');
    const r = _glCanvasRect;
    const cw = r.width, ch = r.height;
    const cx = (0.5 + (o._tx || 0) * 0.5) * cw;
    const cy = (0.5 - (o._ty || 0) * 0.5) * ch;
    const sc = o._scale || 1;
    const imgAsp = o._imgAspect || (cw / ch);
    const hw = 0.5 * sc * imgAsp * ch, hh = 0.5 * sc * ch;
    const ang = -(o._rotate || 0);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const corners = [
      { x: cx + ca*(-hw) - sa*(-hh), y: cy + sa*(-hw) + ca*(-hh) },
      { x: cx + ca*(hw) - sa*(-hh),  y: cy + sa*(hw) + ca*(-hh) },
      { x: cx + ca*(hw) - sa*(hh),   y: cy + sa*(hw) + ca*(hh) },
      { x: cx + ca*(-hw) - sa*(hh),  y: cy + sa*(-hw) + ca*(hh) }
    ];
    return { cx, cy, hw, hh, ang, corners, cw, ch };
  }

  function hitCorner(mx, my, corners) {
    const thresh = 18;
    for (let i = 0; i < corners.length; i++) {
      const dx = mx - corners[i].x, dy = my - corners[i].y;
      if (dx*dx + dy*dy < thresh*thresh) return i;
    }
    return -1;
  }

  function hitBox(mx, my, geo) {
    const dx = mx - geo.cx, dy = my - geo.cy;
    const ca = Math.cos(-geo.ang), sa = Math.sin(-geo.ang);
    const lx = ca * dx - sa * dy, ly = sa * dx + ca * dy;
    return Math.abs(lx) <= geo.hw && Math.abs(ly) <= geo.hh;
  }

  function drawGizmo() {
    const o = getLayer('overlay');
    const r = _glCanvasRect;
    if (gizmoCanvas.width !== r.width || gizmoCanvas.height !== r.height) {
      gizmoCanvas.width = r.width;
      gizmoCanvas.height = r.height;
    }
    gCtx.clearRect(0, 0, gizmoCanvas.width, gizmoCanvas.height);

    // Skeleton overlay (drawn before gizmo so gizmo handles stay on top)
    if (btOverlayEnabled && mediaPipeMgr.active) {
      drawLandmarkOverlay(gCtx, gizmoCanvas.width, gizmoCanvas.height);
    }

    if (o._hasImage && o.visible && gizmoSelected) {
      const { cx, cy, hw, hh, ang } = gizmoGeometry();
      gCtx.save();
      gCtx.translate(cx, cy);
      gCtx.rotate(ang);
      // Dashed bounding box
      gCtx.strokeStyle = 'rgba(255,255,255,0.6)';
      gCtx.lineWidth = 1;
      gCtx.setLineDash([6, 4]);
      gCtx.strokeRect(-hw, -hh, hw*2, hh*2);
      // Corner handles (circles)
      gCtx.setLineDash([]);
      const hr = 4;
      const pts = [[-hw,-hh],[hw,-hh],[hw,hh],[-hw,hh]];
      for (const [hx,hy] of pts) {
        gCtx.fillStyle = '#fff';
        gCtx.strokeStyle = '#fff';
        gCtx.lineWidth = 1.5;
        gCtx.beginPath();
        gCtx.arc(hx, hy, hr, 0, Math.PI * 2);
        gCtx.fill();
        gCtx.stroke();
      }
      gCtx.restore();
    }
    requestAnimationFrame(drawGizmo);
  }
  requestAnimationFrame(drawGizmo);

  // Event handling via capture on #preview
  const previewEl = document.getElementById('preview');

  previewEl.addEventListener('pointerdown', (e) => {
    const o = getLayer('overlay');
    if (!o._hasImage || !o.visible) { gizmoSelected = false; return; }
    const r = _glCanvasRect;
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const geo = gizmoGeometry();
    if (gizmoSelected) {
      const ci = hitCorner(mx, my, geo.corners);
      if (ci >= 0) {
        e.preventDefault(); e.stopPropagation();
        const dist = Math.sqrt((mx-geo.cx)**2 + (my-geo.cy)**2);
        const ang = Math.atan2(my-geo.cy, mx-geo.cx);
        gizmoDrag = { type:'scale', startDist:dist, startAngle:ang, startScale:o._scale, startRotate:o._rotate };
        previewEl.setPointerCapture(e.pointerId);
        return;
      }
    }
    if (hitBox(mx, my, geo)) {
      e.preventDefault(); e.stopPropagation();
      if (!gizmoSelected) { gizmoSelected = true; return; }
      gizmoDrag = { type:'move', startX:mx, startY:my, startTx:o._tx, startTy:o._ty, cw:geo.cw, ch:geo.ch };
      previewEl.setPointerCapture(e.pointerId);
      return;
    }
    // Clicked empty canvas — deselect
    gizmoSelected = false;
  }, true);

  previewEl.addEventListener('pointermove', (e) => {
    const o = getLayer('overlay');
    if (!o._hasImage || !o.visible) { previewEl.style.cursor = ''; return; }
    const r = _glCanvasRect;
    const mx = e.clientX - r.left, my = e.clientY - r.top;

    if (gizmoDrag) {
      e.preventDefault();
      if (gizmoDrag.type === 'move') {
        o._tx = gizmoDrag.startTx + 2 * (mx - gizmoDrag.startX) / gizmoDrag.cw;
        o._ty = gizmoDrag.startTy - 2 * (my - gizmoDrag.startY) / gizmoDrag.ch;
        syncTransformSliders();
      } else if (gizmoDrag.type === 'scale') {
        const geo = gizmoGeometry();
        const dist = Math.sqrt((mx-geo.cx)**2 + (my-geo.cy)**2);
        o._scale = Math.max(0.1, Math.min(5, gizmoDrag.startScale * (dist / gizmoDrag.startDist)));
        const ang = Math.atan2(my-geo.cy, mx-geo.cx);
        let rawRot = gizmoDrag.startRotate + (gizmoDrag.startAngle - ang);
        // Snap rotation to nearest 10 degrees
        const snapDeg = 10;
        const snapRad = snapDeg * Math.PI / 180;
        rawRot = Math.round(rawRot / snapRad) * snapRad;
        o._rotate = rawRot;
        syncTransformSliders();
      }
      return;
    }

    // Cursor hints
    const geo = gizmoGeometry();
    if (gizmoSelected && hitCorner(mx, my, geo.corners) >= 0) {
      previewEl.style.cursor = 'nwse-resize';
    } else if (hitBox(mx, my, geo)) {
      previewEl.style.cursor = gizmoSelected ? 'move' : 'pointer';
    } else {
      previewEl.style.cursor = '';
    }
  }, true);

  previewEl.addEventListener('pointerup', (e) => {
    if (gizmoDrag) {
      gizmoDrag = null;
      previewEl.releasePointerCapture(e.pointerId);
    }
  }, true);

  // Touch: two-finger pinch for scale + rotate
  let touchState = null;
  previewEl.addEventListener('touchstart', (e) => {
    const o = getLayer('overlay');
    if (!o._hasImage || !o.visible || e.touches.length < 2) return;
    const t0 = e.touches[0], t1 = e.touches[1];
    const dx = t1.clientX - t0.clientX, dy = t1.clientY - t0.clientY;
    touchState = {
      startDist: Math.sqrt(dx*dx + dy*dy),
      startAngle: Math.atan2(dy, dx),
      startScale: o._scale,
      startRotate: o._rotate
    };
    e.preventDefault();
  }, { passive: false, capture: true });

  previewEl.addEventListener('touchmove', (e) => {
    if (!touchState || e.touches.length < 2) return;
    const o = getLayer('overlay');
    const t0 = e.touches[0], t1 = e.touches[1];
    const dx = t1.clientX - t0.clientX, dy = t1.clientY - t0.clientY;
    const dist = Math.sqrt(dx*dx + dy*dy);
    const ang = Math.atan2(dy, dx);
    o._scale = Math.max(0.1, Math.min(5, touchState.startScale * (dist / touchState.startDist)));
    let rawRot = touchState.startRotate + (touchState.startAngle - ang);
    const snapRad = 10 * Math.PI / 180;
    rawRot = Math.round(rawRot / snapRad) * snapRad;
    o._rotate = rawRot;
    syncTransformSliders();
    e.preventDefault();
  }, { passive: false, capture: true });

  previewEl.addEventListener('touchend', () => { touchState = null; }, true);

  // === Camera card: Webcam toggle ===
  document.getElementById('cam-webcam-btn').addEventListener('click', async () => {
    const btn = document.getElementById('cam-webcam-btn');
    const hasWebcam = mediaInputs.some(m => m.name === 'Webcam' && m.type === 'video');
    if (hasWebcam) {
      // Stop webcam
      const wcEntry = mediaInputs.find(m => m.name === 'Webcam' && m.type === 'video');
      if (wcEntry) removeMedia(wcEntry.id);
      btn.classList.remove('active');
      const cd = document.getElementById('camera-detail');
      if (cd) cd.classList.remove('visible');
    } else {
      try {
        await addMediaFromWebcam();
        btn.classList.add('active');
        const cd = document.getElementById('camera-detail');
        if (cd) cd.classList.add('visible');
        // Auto-enable body tracking + hand-as-mouse
        const mpBtn = document.getElementById('cam-mediapipe-btn');
        if (mpBtn && !mediaPipeMgr.active) mpBtn.click();
        // Hand-as-mouse auto-enables after MediaPipe starts (async)
        setTimeout(() => {
          if (mediaPipeMgr.active && !handAsMouseEnabled) {
            const hamBtn = document.getElementById('hand-as-mouse-btn') || handAsMouseBtn;
            if (hamBtn) hamBtn.click();
          }
        }, 2000);
      } catch (e) { console.warn('Webcam access denied:', e.message); }
    }
  });

  // === BT Preset dropdown ===
  const btPresetRow = document.getElementById('bt-preset-row');
  const btPresetSelect = document.getElementById('bt-preset-select');
  // Populate with body-tracking-friendly shaders (has rotationX/rotationY/shapeScale inputs)
  {
    const btShaders = manifest.filter(m => {
      const cats = m.categories || [];
      return cats.includes('3D') || m.title === 'Dancing Cube';
    });
    // Also include the Dancing Cube if it's not already matched
    const dcEntry = manifest.find(m => m.title === 'Dancing Cube');
    if (dcEntry && !btShaders.includes(dcEntry)) btShaders.unshift(dcEntry);
    const ph = document.createElement('option');
    ph.value = ''; ph.disabled = true; ph.selected = true; ph.textContent = '\u2014';
    btPresetSelect.appendChild(ph);
    for (const item of btShaders) {
      const opt = document.createElement('option');
      opt.value = item.file;
      opt.textContent = item.title;
      btPresetSelect.appendChild(opt);
    }
  }
  btPresetSelect.addEventListener('change', async () => {
    const file = btPresetSelect.value;
    if (!file) return;
    const item = manifest.find(m => m.file === file);
    if (!item) return;
    // Load to shader layer and enable gesture inputs
    const layer = getLayer('shader');
    if (layer) {
      layer.manifestEntry = item;
      layer._hasGestureInputs = true;
      layer.visible = true;
      updateLayerCardUI('shader');
    }
    await loadShaderToLayer('shader', 'shaders', file);
    // Also update the shader layer dropdown
    const shaderSelect = document.querySelector('.layer-shader-select[data-layer="shader"]');
    if (shaderSelect) shaderSelect.value = file;
  });

  // === Body Tracking card: MediaPipe toggle ===
  const mpModesRow = document.getElementById('mp-modes-row');
  const handAsMouseRow = document.getElementById('hand-as-mouse-row');
  const handAsMouseBtn = document.getElementById('hand-as-mouse-btn');
  const handPosWidget = document.getElementById('hand-pos-widget');
  const handPosDot = document.getElementById('hand-pos-dot');
  const handPosXRange = document.getElementById('hand-pos-x');
  const handPosYRange = document.getElementById('hand-pos-y');
  const handPosXVal = document.getElementById('hand-pos-x-val');
  const handPosYVal = document.getElementById('hand-pos-y-val');
  let gestureEnabled = false;
  let handAsMouseEnabled = false;
  let btOverlayEnabled = false;
  const mpModeState = { hand: true, face: false, pose: false, segment: false };

  // === Skeleton Overlay: landmark drawing constants ===
  const HAND_CONNECTIONS = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[0,9],[9,10],[10,11],[11,12],[0,13],[13,14],[14,15],[15,16],[0,17],[17,18],[18,19],[19,20],[5,9],[9,13],[13,17]];
  const POSE_CONNECTIONS = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28]];
  const FACE_KEY_INDICES = [1,33,263,13,152,10,234,454,70,300,0,17,123,352,6];
  const FACE_JAWLINE = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109,10];

  function drawLandmarkOverlay(ctx, w, h) {
    const _sx = (lm) => lm.x * w;
    const _sy = (lm) => (1.0 - lm.y) * h;

    // Hand skeleton
    const hand = mediaPipeMgr._lastHandLandmarks;
    if (hand && hand.length > 20) {
      ctx.strokeStyle = 'rgba(78,205,196,0.5)';
      ctx.fillStyle = 'rgba(78,205,196,0.6)';
      ctx.lineWidth = 1.5;
      for (const [a, b] of HAND_CONNECTIONS) {
        if (!hand[a] || !hand[b]) continue;
        ctx.beginPath(); ctx.moveTo(_sx(hand[a]), _sy(hand[a]));
        ctx.lineTo(_sx(hand[b]), _sy(hand[b])); ctx.stroke();
      }
      for (let i = 0; i < 21; i++) {
        if (!hand[i]) continue;
        ctx.beginPath(); ctx.arc(_sx(hand[i]), _sy(hand[i]), 3, 0, Math.PI * 2); ctx.fill();
      }
      // Second hand
      const hand2 = mediaPipeMgr._lastHandLandmarks2;
      if (hand2 && hand2.length > 20) {
        for (const [a, b] of HAND_CONNECTIONS) {
          if (!hand2[a] || !hand2[b]) continue;
          ctx.beginPath(); ctx.moveTo(_sx(hand2[a]), _sy(hand2[a]));
          ctx.lineTo(_sx(hand2[b]), _sy(hand2[b])); ctx.stroke();
        }
        for (let i = 0; i < 21; i++) {
          if (!hand2[i]) continue;
          ctx.beginPath(); ctx.arc(_sx(hand2[i]), _sy(hand2[i]), 3, 0, Math.PI * 2); ctx.fill();
        }
      }
    }

    // Pose skeleton
    const pose = mediaPipeMgr._lastPoseLandmarks;
    if (pose && pose.length > 28) {
      ctx.strokeStyle = 'rgba(255,215,0,0.4)';
      ctx.fillStyle = 'rgba(255,215,0,0.5)';
      ctx.lineWidth = 2;
      for (const [a, b] of POSE_CONNECTIONS) {
        if (!pose[a] || !pose[b]) continue;
        ctx.beginPath(); ctx.moveTo(_sx(pose[a]), _sy(pose[a]));
        ctx.lineTo(_sx(pose[b]), _sy(pose[b])); ctx.stroke();
      }
      for (let i = 0; i < 33; i++) {
        if (!pose[i]) continue;
        ctx.beginPath(); ctx.arc(_sx(pose[i]), _sy(pose[i]), 4, 0, Math.PI * 2); ctx.fill();
      }
    }

    // Face mesh (sparse)
    const face = mediaPipeMgr._lastFaceLandmarks;
    if (face && face.length > 454) {
      ctx.fillStyle = 'rgba(255,127,80,0.35)';
      // Key landmark dots
      for (const idx of FACE_KEY_INDICES) {
        if (!face[idx]) continue;
        ctx.beginPath(); ctx.arc(_sx(face[idx]), _sy(face[idx]), 2.5, 0, Math.PI * 2); ctx.fill();
      }
      // Jawline contour
      ctx.strokeStyle = 'rgba(255,127,80,0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < FACE_JAWLINE.length; i++) {
        const p = face[FACE_JAWLINE[i]];
        if (!p) continue;
        if (i === 0) ctx.moveTo(_sx(p), _sy(p));
        else ctx.lineTo(_sx(p), _sy(p));
      }
      ctx.stroke();
    }
  }

  // === Skeleton Overlay toggle ===
  const btOverlayRow = document.getElementById('bt-overlay-row');
  const btOverlayBtn = document.getElementById('bt-overlay-btn');
  btOverlayBtn.addEventListener('click', () => {
    btOverlayEnabled = !btOverlayEnabled;
    btOverlayBtn.classList.toggle('active', btOverlayEnabled);
  });

  // === BT Panel: collapsible section headers ===
  document.querySelectorAll('.bt-section-header').forEach(header => {
    header.addEventListener('click', () => header.classList.toggle('open'));
  });

  // === BT Panel: new section elements ===
  const btSignalsSection = document.getElementById('bt-signals-section');
  const btSignalsBody = document.getElementById('bt-signals-body');
  const btLinksSection = document.getElementById('bt-links-section');
  const btLinksBody = document.getElementById('bt-links-body');
  const btLinksList = document.getElementById('bt-links-list');
  const btLinkCount = document.getElementById('bt-link-count');
  const btRecordingSection = document.getElementById('bt-recording-section');

  // === Live Signals Monitor ===
  let _signalBarCache = {}; // { key: { fill, val } } for hot-path updates

  function renderSignalBars() {
    btSignalsBody.innerHTML = '';
    _signalBarCache = {};
    for (const group of ['hand', 'face', 'pose']) {
      if (!mpModeState[group]) continue;
      const signals = DERIVED_SIGNALS[group] || [];
      for (const sig of signals) {
        const row = document.createElement('div');
        row.className = 'bt-signal-row';
        row.innerHTML = `
          <span class="bt-signal-label">${sig.name}</span>
          <div class="bt-signal-bar"><div class="bt-signal-fill ${group}" data-key="${sig.key}"></div></div>
          <span class="bt-signal-val" data-key="${sig.key}">0.00</span>
          <button class="bt-signal-link" data-key="${sig.key}" data-group="${group}" title="Link to parameter">&rarr;</button>
        `;
        btSignalsBody.appendChild(row);
        const fill = row.querySelector('.bt-signal-fill');
        const val = row.querySelector('.bt-signal-val');
        _signalBarCache[sig.key] = { fill, val };
        // Link button
        row.querySelector('.bt-signal-link').addEventListener('click', (e) => {
          openDerivedLinkPicker(sig.key, sig.name, e.target);
        });
      }
    }
  }

  function updateSignalBars() {
    const d = gestureProcessor.derived;
    for (const key in _signalBarCache) {
      const { fill, val } = _signalBarCache[key];
      const v = d[key] || 0;
      fill.style.width = (v * 100).toFixed(1) + '%';
      val.textContent = v.toFixed(2);
    }
  }

  // updateLiveSignalBars removed — replaced by updateSignalRows

  // === Update range indicators + signal dots on all bound sliders ===
  function updateRangeIndicators() {
    for (const layer of layers) {
      if (!layer.mpBindings || !layer.mpBindings.length) continue;
      const container = document.querySelector(`.layer-params[data-layer="${layer.id}"]`);
      if (!container) continue;
      for (const b of layer.mpBindings) {
        if (!b.param) continue;
        const row = container.querySelector(`.control-row[data-name="${b.param}"]`);
        if (!row) continue;
        updateRangeIndicator(row, b);
        updateSignalDot(row, b._lastRawSignal);
      }
    }
  }

  // === Active Bindings Dashboard ===
  function renderLinksDashboard() {
    btLinksList.innerHTML = '';
    let count = 0;
    for (const layer of layers) {
      if (!layer.mpBindings || !layer.mpBindings.length) continue;
      for (let bi = 0; bi < layer.mpBindings.length; bi++) {
        const b = layer.mpBindings[bi];
        count++;
        const row = document.createElement('div');
        row.className = 'bt-link-row';
        let srcLabel;
        if (b.source === 'audio') {
          const found = AUDIO_SIGNALS.find(s => s.key === b.signalKey);
          srcLabel = '\u266B ' + (found ? found.name : b.signalKey);
        } else if (b.source === 'mouse') {
          const found = MOUSE_SIGNALS.find(s => s.key === b.signalKey);
          srcLabel = '\u2316 ' + (found ? found.name : b.signalKey);
        } else if (b.source === 'derived') {
          // Find signal name
          let sigName = b.signalKey;
          for (const grp in DERIVED_SIGNALS) {
            const found = DERIVED_SIGNALS[grp].find(s => s.key === b.signalKey);
            if (found) { sigName = found.name; break; }
          }
          srcLabel = sigName;
        } else {
          const part = (MP_BODY_PARTS[b.group] || []).find(p => p.index === b.landmarkIndex);
          srcLabel = (part ? part.name : b.group) + '.' + (b.axis || 'x');
        }
        row.innerHTML = `
          <span class="bt-link-source">${srcLabel}</span>
          <span class="bt-link-arrow">&rarr;</span>
          <span class="bt-link-target">${layer.id}/${b.param}</span>
          <span class="bt-link-value" data-layer="${layer.id}" data-param="${b.param}">—</span>
          <button class="bt-link-remove" data-layer="${layer.id}" data-bi="${bi}" title="Remove link">&times;</button>
        `;
        btLinksList.appendChild(row);
        row.querySelector('.bt-link-remove').addEventListener('click', function() {
          const lid = this.dataset.layer;
          const idx = parseInt(this.dataset.bi);
          const l = getLayer(lid);
          if (l && l.mpBindings) {
            l.mpBindings.splice(idx, 1);
            renderLinksDashboard();
            refreshAllLinksUI();
          }
        });
      }
    }
    btLinkCount.textContent = count;
    btLinkCount.style.display = count > 0 ? '' : 'none';
  }

  function updateLinksDashboardValues() {
    const valEls = btLinksList.querySelectorAll('.bt-link-value');
    for (const el of valEls) {
      const layer = getLayer(el.dataset.layer);
      if (layer && layer.inputValues[el.dataset.param] != null) {
        el.textContent = Number(layer.inputValues[el.dataset.param]).toFixed(2);
      }
    }
  }

  // === Derived Signal Bind Picker (opens from signal bar bind button) ===
  function openDerivedLinkPicker(signalKey, signalName, anchorEl) {
    // Build a simple target picker: which layer × which param?
    const picker = document.createElement('div');
    picker.className = 'mp-picker';
    picker.style.display = 'flex';
    picker.style.width = '200px';
    let html = '<div style="padding:6px 8px;font-size:10px;color:var(--text);border-bottom:1px solid var(--border);">Link <b>' + signalName + '</b> to:</div>';
    html += '<div class="mp-picker-list" style="max-height:200px">';
    for (const layer of layers) {
      if (!layer.inputs || layer.inputs.length === 0) continue;
      for (const inp of layer.inputs) {
        if (inp.TYPE !== 'float' && inp.TYPE !== 'long') continue;
        html += `<div class="mp-picker-list-item" data-layer="${layer.id}" data-param="${inp.NAME}">${layer.id}/${inp.LABEL || inp.NAME}</div>`;
      }
    }
    html += '</div>';
    picker.innerHTML = html;
    document.body.appendChild(picker);

    // Position
    const rect = anchorEl.getBoundingClientRect();
    picker.style.position = 'fixed';
    picker.style.zIndex = '1001';
    picker.style.left = Math.min(rect.right + 4, window.innerWidth - 210) + 'px';
    picker.style.top = Math.min(rect.top, window.innerHeight - 240) + 'px';

    // Handle selection
    picker.querySelectorAll('.mp-picker-list-item').forEach(item => {
      item.addEventListener('click', () => {
        const layerId = item.dataset.layer;
        const paramName = item.dataset.param;
        const layer = getLayer(layerId);
        if (!layer) return;
        if (!layer.mpBindings) layer.mpBindings = [];
        // Remove existing binding for this param if any
        const idx = layer.mpBindings.findIndex(b => b.param === paramName);
        const old = idx >= 0 ? layer.mpBindings.splice(idx, 1)[0] : null;
        // Find ISF input for min/max
        const isfInput = (layer.inputs || []).find(inp => inp.NAME === paramName);
        const pMin = isfInput && isfInput.MIN != null ? isfInput.MIN : 0;
        const pMax = isfInput && isfInput.MAX != null ? isfInput.MAX : 1;
        layer.mpBindings.push({ source: 'derived', signalKey, param: paramName, min: old ? old.min : pMin, max: old ? old.max : pMax, smoothing: old ? (old.smoothing||0) : 0, easing: old ? (old.easing||'easeInOut') : 'easeInOut', _pMin: pMin, _pMax: pMax });
        renderLinksDashboard();
        refreshAllLinksUI();
        document.body.removeChild(picker);
        document.removeEventListener('pointerdown', closePicker, true);
      });
    });

    // Close on click outside
    const closePicker = (e) => {
      if (!picker.contains(e.target) && e.target !== anchorEl) {
        if (picker.parentNode) document.body.removeChild(picker);
        document.removeEventListener('pointerdown', closePicker, true);
      }
    };
    setTimeout(() => document.addEventListener('pointerdown', closePicker, true), 0);
  }

  // === Quick-Link (Map) mode ===
  let quickLinkActive = false;
  const btMapBtn = document.getElementById('bt-map-btn');
  btMapBtn.addEventListener('click', () => {
    quickLinkActive = !quickLinkActive;
    btMapBtn.classList.toggle('active', quickLinkActive);
    document.body.classList.toggle('quicklink-active', quickLinkActive);
  });

  // === + Link button: opens target picker then mp-picker ===
  document.getElementById('bt-add-link-btn').addEventListener('click', () => {
    // Build a target picker similar to derived link but opens full mp-picker after
    const picker = document.createElement('div');
    picker.className = 'mp-picker';
    picker.style.display = 'flex';
    picker.style.width = '200px';
    let html = '<div style="padding:6px 8px;font-size:10px;color:var(--text);border-bottom:1px solid var(--border);">Select target parameter:</div>';
    html += '<div class="mp-picker-list" style="max-height:220px">';
    for (const layer of layers) {
      if (!layer.inputs || layer.inputs.length === 0) continue;
      for (const inp of layer.inputs) {
        if (inp.TYPE !== 'float' && inp.TYPE !== 'long') continue;
        html += `<div class="mp-picker-list-item" data-layer="${layer.id}" data-param="${inp.NAME}">${layer.id}/${inp.LABEL || inp.NAME}</div>`;
      }
    }
    html += '</div>';
    picker.innerHTML = html;
    document.body.appendChild(picker);

    const btn = document.getElementById('bt-add-link-btn');
    const rect = btn.getBoundingClientRect();
    picker.style.position = 'fixed';
    picker.style.zIndex = '1001';
    picker.style.left = Math.min(rect.right + 4, window.innerWidth - 210) + 'px';
    picker.style.top = Math.min(rect.top, window.innerHeight - 240) + 'px';

    picker.querySelectorAll('.mp-picker-list-item').forEach(item => {
      item.addEventListener('click', () => {
        const layerId = item.dataset.layer;
        const paramName = item.dataset.param;
        if (picker.parentNode) document.body.removeChild(picker);
        document.removeEventListener('pointerdown', closePicker, true);
        // Now open the main mp-picker for this param
        const layerCard = document.querySelector(`.layer-params[data-layer="${layerId}"]`);
        if (!layerCard) return;
        const mpBtn = layerCard.querySelector(`.bind-add-btn[data-param-name="${paramName}"]`);
        if (mpBtn) {
          openMpPicker(mpBtn, paramName, layerCard);
        }
      });
    });

    const closePicker = (e) => {
      if (!picker.contains(e.target)) {
        if (picker.parentNode) document.body.removeChild(picker);
        document.removeEventListener('pointerdown', closePicker, true);
      }
    };
    setTimeout(() => document.addEventListener('pointerdown', closePicker, true), 0);
  });

  // === Recording System ===
  let btRecording = null; // { fps, startTime, frames, tracks }
  let btIsRecording = false;
  let btIsPlaying = false;
  let btPlaybackFrame = 0;
  let btPlaybackId = null;

  const btRecBtn = document.getElementById('bt-rec-btn');
  const btPlayBtn = document.getElementById('bt-play-btn');
  const btJsonBtn = document.getElementById('bt-json-btn');
  const btRecTimer = document.getElementById('bt-rec-timer');

  btRecBtn.addEventListener('click', () => {
    if (btIsRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  });

  btPlayBtn.addEventListener('click', () => {
    if (btIsPlaying) {
      stopPlayback();
    } else {
      startPlayback();
    }
  });

  btJsonBtn.addEventListener('click', () => {
    if (btRecording) exportRecording();
  });

  function startRecording() {
    btRecording = { fps: 15, startTime: performance.now(), frames: [], tracks: {}, duration: 0 };
    btIsRecording = true;
    btRecBtn.classList.add('recording');
    btPlayBtn.disabled = true;
    btJsonBtn.disabled = true;
  }

  function captureFrame() {
    if (!btRecording || !btIsRecording) return;
    const frame = {};
    for (const layer of layers) {
      if (!layer.mpBindings || !layer.mpBindings.length) continue;
      for (const b of layer.mpBindings) {
        const trackKey = layer.id + '/' + b.param;
        if (!btRecording.tracks[trackKey]) btRecording.tracks[trackKey] = [];
        const v = layer.inputValues[b.param];
        btRecording.tracks[trackKey].push(v != null ? v : 0);
        frame[trackKey] = v;
      }
    }
    btRecording.frames.push(frame);
    // Update timer
    const elapsed = (performance.now() - btRecording.startTime) / 1000;
    const m = Math.floor(elapsed / 60);
    const s = Math.floor(elapsed % 60);
    btRecTimer.textContent = m + ':' + String(s).padStart(2, '0');
  }

  function stopRecording() {
    btIsRecording = false;
    btRecBtn.classList.remove('recording');
    if (btRecording) {
      btRecording.duration = btRecording.frames.length / btRecording.fps;
    }
    btPlayBtn.disabled = false;
    btJsonBtn.disabled = false;
  }

  function startPlayback() {
    if (!btRecording || btRecording.frames.length === 0) return;
    btIsPlaying = true;
    btPlayBtn.classList.add('playing');
    btPlaybackFrame = 0;
  }

  function applyPlaybackFrame() {
    if (!btIsPlaying || !btRecording) return;
    const frame = btRecording.frames[btPlaybackFrame];
    if (!frame) return;
    for (const trackKey in frame) {
      const [layerId, param] = trackKey.split('/');
      const layer = getLayer(layerId);
      if (layer) layer.inputValues[param] = frame[trackKey];
    }
    btPlaybackFrame = (btPlaybackFrame + 1) % btRecording.frames.length;
    // Update timer
    const elapsed = btPlaybackFrame / btRecording.fps;
    const m = Math.floor(elapsed / 60);
    const s = Math.floor(elapsed % 60);
    btRecTimer.textContent = m + ':' + String(s).padStart(2, '0');
  }

  function stopPlayback() {
    btIsPlaying = false;
    btPlayBtn.classList.remove('playing');
  }

  function exportRecording() {
    if (!btRecording) return;
    const json = JSON.stringify(btRecording, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'bt-recording-' + Date.now() + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // Scale slider removed

  // gestureEnabled is now controlled directly by the MediaPipe toggle

  // Hand as Mouse toggle
  handAsMouseBtn.addEventListener('click', () => {
    handAsMouseEnabled = !handAsMouseEnabled;
    handAsMouseBtn.classList.toggle('active', handAsMouseEnabled);
    handPosWidget.classList.toggle('active', handAsMouseEnabled);
    for (const lid of ['text', 'shader', 'scene']) {
      const l = getLayer(lid);
      if (l) {
        l.handAsMouse = handAsMouseEnabled;
        // Reset tracked position to avoid jump on re-enable
        delete l._prevHandX;
        delete l._prevHandY;
      }
    }
  });

  // Mode toggle buttons
  mpModesRow.querySelectorAll('.mp-mode-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const mode = btn.dataset.mpMode;
      mpModeState[mode] = !mpModeState[mode];
      btn.classList.toggle('active', mpModeState[mode]);
      // If MediaPipe is active, reinit with new modes
      if (mediaPipeMgr.active) {
        const mpEntry = mediaInputs.find(m => m._isMediaPipe);
        if (mpEntry) removeMedia(mpEntry.id);
        try {
          await startMediaPipe();
        } catch (e) {
          console.warn('MediaPipe reinit failed:', e.message);
        }
      }
      // Refresh signal bars to show/hide signals for toggled mode
      renderSignalBars();
    });
  });

  async function startMediaPipe() {
    const btn = document.getElementById('cam-mediapipe-btn');
    // Auto-enable webcam
    const hasWebcam = mediaInputs.some(m => m.name === 'Webcam' && m.type === 'video');
    if (!hasWebcam) {
      try {
        await addMediaFromWebcam();
        document.getElementById('cam-webcam-btn').classList.add('active');
        const cd = document.getElementById('camera-detail');
        if (cd) cd.classList.add('visible');
      } catch (e) { console.warn('Webcam needed for MediaPipe:', e.message); return; }
    }
    try {
      await mediaPipeMgr.init(mpModeState);
      const id = ++mediaIdCounter;
      const entry = { id, name: mediaPipeMgr.getLabel(), type: 'mediapipe', element: null, glTexture: null, threeTexture: null, threeModel: null, _isMediaPipe: true };
      mediaInputs.push(entry);
      renderMediaList();
      btn.classList.add('active');
      btPresetRow.style.display = '';
      mpModesRow.style.display = '';
      handAsMouseRow.style.display = '';
      btOverlayRow.style.display = '';
      btSignalsSection.style.display = '';
      btLinksSection.style.display = '';
      btRecordingSection.style.display = '';
      gestureEnabled = true;
      renderSignalBars();
      renderLinksDashboard();
    } catch (e) {
      console.warn('MediaPipe init failed:', e.message);
    }
  }

  document.getElementById('cam-mediapipe-btn').addEventListener('click', async () => {
    const btn = document.getElementById('cam-mediapipe-btn');
    if (mediaPipeMgr.active) {
      mediaPipeMgr.dispose();
      const mpEntry = mediaInputs.find(m => m._isMediaPipe);
      if (mpEntry) removeMedia(mpEntry.id);
      btn.classList.remove('active');
      btPresetRow.style.display = 'none';
      mpModesRow.style.display = 'none';
      handAsMouseRow.style.display = 'none';
      handPosWidget.classList.remove('active');
      btOverlayRow.style.display = 'none';
      btSignalsSection.style.display = 'none';
      btLinksSection.style.display = 'none';
      btRecordingSection.style.display = 'none';
      btOverlayEnabled = false;
      btOverlayBtn.classList.remove('active');
      gestureEnabled = false;
      handAsMouseEnabled = false;
      handAsMouseBtn.classList.remove('active');
      if (btIsRecording) stopRecording();
      if (btIsPlaying) stopPlayback();
      for (const lid of ['text', 'shader', 'scene']) {
        const l = getLayer(lid);
        if (l) l.handAsMouse = false;
      }
      refreshAllLinksUI();
      return;
    }
    btPresetRow.style.display = '';
    mpModesRow.style.display = '';
    handAsMouseRow.style.display = '';
    btOverlayRow.style.display = '';
    btSignalsSection.style.display = '';
    btLinksSection.style.display = '';
    btRecordingSection.style.display = '';
    await startMediaPipe();
    refreshAllLinksUI();
  });

  // === MediaPipe Bindings UI ===
  // Builds/refreshes the bindings panel inside each layer card's .layer-controls
  function buildLinksUI(layerId) {
    const layer = getLayer(layerId);
    if (!layer) return;
    const card = document.querySelector(`.layer-card[data-layer="${layerId}"]`);
    if (!card) return;

    // Remove legacy bindings section if still present
    const section = card.querySelector('.mp-bindings-section');
    if (section) section.remove();

    // Sync per-slider MP map button highlights (buttons live in .layer-params)
    syncMpLinkedState(card, layerId);
  }

  // Rebuild bindings UI when MediaPipe toggled or layer switches
  function refreshAllLinksUI() {
    for (const lid of ['text', 'shader', 'scene']) {
      buildLinksUI(lid);
    }
  }

  // === Inline binding config panel (under bound parameters in layer panel) ===
  function getBindingSourceLabel(b) {
    if (b.source === 'audio') {
      const found = AUDIO_SIGNALS.find(s => s.key === b.signalKey);
      return '\u266B ' + (found ? found.name : b.signalKey);
    }
    if (b.source === 'mouse') {
      const found = MOUSE_SIGNALS.find(s => s.key === b.signalKey);
      return '\u2316 ' + (found ? found.name : b.signalKey);
    }
    if (b.source === 'data') {
      if (b.dataType === 'expression') return '\u0192 Custom Expr';
      if (b.dataType === 'csv') return '\u2261 CSV Data';
      const found = DATA_SIGNALS.find(s => s.key === b.signalKey);
      return '\u223F ' + (found ? found.name : b.signalKey);
    }
    if (b.source === 'derived') {
      for (const grp of ['hand', 'face', 'pose']) {
        const found = (DERIVED_SIGNALS[grp] || []).find(s => s.key === b.signalKey);
        if (found) return found.name;
      }
      return b.signalKey;
    }
    const parts = MP_BODY_PARTS[b.group] || [];
    const found = parts.find(p => p.index === b.landmarkIndex);
    return (found ? found.name : b.group) + ' ' + (b.axis || 'x').toUpperCase();
  }

  function buildSignalOptions(binding) {
    let html = '';
    // If landmark binding, add current as special option at top
    if (!binding.source) {
      html += `<option value="landmark" selected>${getBindingSourceLabel(binding)}</option><option disabled>\u2500\u2500\u2500\u2500\u2500\u2500\u2500</option>`;
    }
    // Audio (deduplicated by key)
    html += '<optgroup label="Audio">';
    const seenAudio = new Set();
    for (const sig of AUDIO_SIGNALS) {
      if (seenAudio.has(sig.key)) continue;
      seenAudio.add(sig.key);
      const sel = binding.source === 'audio' && binding.signalKey === sig.key ? ' selected' : '';
      html += `<option value="audio:${sig.key}"${sel}>${sig.name}</option>`;
    }
    html += '</optgroup>';
    // Mouse
    html += '<optgroup label="Mouse">';
    for (const sig of MOUSE_SIGNALS) {
      const sel = binding.source === 'mouse' && binding.signalKey === sig.key ? ' selected' : '';
      html += `<option value="mouse:${sig.key}"${sel}>${sig.name}</option>`;
    }
    html += '</optgroup>';
    // Derived by group
    for (const grp of ['hand', 'face', 'pose']) {
      const sigs = DERIVED_SIGNALS[grp] || [];
      if (!sigs.length) continue;
      html += `<optgroup label="${grp[0].toUpperCase()+grp.slice(1)} Signals">`;
      for (const sig of sigs) {
        const sel = binding.source === 'derived' && binding.signalKey === sig.key ? ' selected' : '';
        html += `<option value="derived:${sig.key}"${sel}>${sig.name}</option>`;
      }
      html += '</optgroup>';
    }
    // Data (built-in generators)
    html += '<optgroup label="Data">';
    for (const sig of DATA_SIGNALS) {
      const sel = binding.source === 'data' && binding.signalKey === sig.key ? ' selected' : '';
      html += `<option value="data:${sig.key}"${sel}>${sig.name}</option>`;
    }
    html += '</optgroup>';
    // Live data sources (dynamic — football, weather, JSON API, etc.)
    if (window._dataSources) {
      const liveSigs = window._dataSources.getSignals();
      if (liveSigs.length) {
        html += '<optgroup label="Live Data">';
        for (const sig of liveSigs) {
          const sel = binding.source === 'data' && binding.signalKey === sig.key ? ' selected' : '';
          html += `<option value="data:${sig.key}"${sel}>${sig.name}</option>`;
        }
        html += '</optgroup>';
      }
    }
    return html;
  }

  function removeSignalRow(row) {
    row.classList.remove('has-binding');
    const next = row.nextElementSibling;
    if (next && next.classList.contains('signal-row')) {
      const opts = next.nextElementSibling;
      if (opts && opts.classList.contains('signal-row-options')) opts.remove();
      next.remove();
    }
    const addBtn = row.querySelector('.bind-add-btn');
    if (addBtn) { addBtn.classList.remove('linked', 'auto-reactive'); addBtn.style.display = ''; }
  }

  function ensureSignalRow(row, binding, layerId) {
    removeSignalRow(row);
    // Clean up any legacy elements
    let next = row.nextElementSibling;
    if (next && next.classList.contains('bind-inline')) next.remove();
    next = row.nextElementSibling;
    if (next && next.classList.contains('live-signal-bar')) next.remove();

    row.classList.add('has-binding');
    const addBtn = row.querySelector('.bind-add-btn');
    if (addBtn) addBtn.style.display = 'none';

    // Strip unicode prefixes from source label
    const rawLabel = getBindingSourceLabel(binding);
    const srcLabel = rawLabel.replace(/^[♫⌖]\s*/, '');

    // Build signal row
    const sr = document.createElement('div');
    sr.className = 'signal-row';
    sr.dataset.bindParam = row.dataset.name;
    sr.dataset.layer = layerId;
    sr.innerHTML = `
      <span class="signal-row-label">${srcLabel}</span>
      <div class="signal-row-bar"><span class="signal-row-fill"></span></div>
      <span class="signal-row-val">0.00</span>
      <button class="signal-row-remove" title="Remove binding">\u00D7</button>
    `;

    // Build options panel (sibling, expanded via CSS adjacent selector)
    const opts = document.createElement('div');
    opts.className = 'signal-row-options';
    opts.innerHTML = `
      <canvas class="sopt-curve" width="200" height="80"></canvas>
      <div class="signal-opt-row"><label>Source</label><select class="sopt-signal">${buildSignalOptions(binding)}</select></div>
      <div class="signal-opt-row sopt-range-row"><label>Min</label><input type="range" class="sopt-min-slider" min="${binding._pMin || 0}" max="${binding._pMax || 1}" step="0.0001" value="${binding.min}"><span class="sopt-val sopt-min-val">${parseFloat(binding.min).toFixed(4)}</span></div>
      <div class="signal-opt-row sopt-range-row"><label>Max</label><input type="range" class="sopt-max-slider" min="${binding._pMin || 0}" max="${binding._pMax || 1}" step="0.0001" value="${binding.max}"><span class="sopt-val sopt-max-val">${parseFloat(binding.max).toFixed(4)}</span></div>
      <div class="signal-opt-row"><label>Smooth</label><input type="range" class="sopt-smooth" min="0" max="1" step="0.01" value="${binding.smoothing||0}"><span class="sopt-val sopt-smooth-val">${Math.round((binding.smoothing||0)*100)}%</span></div>
      <div class="signal-opt-row"><label>Easing</label><select class="sopt-easing">
        <option value="linear">Linear</option><option value="easeIn">Ease In</option><option value="easeOut">Ease Out</option><option value="easeInOut">Ease In Out</option><option value="spring">Spring</option><option value="custom">Custom</option>
      </select></div>
    `;

    // Bezier control points (normalized 0-1)
    if (!binding._bz) binding._bz = { x1: 0.25, y1: 0.1, x2: 0.75, y2: 0.9 };
    const bz = binding._bz;

    // Cubic bezier eval
    function cubicBez(t, p0, p1, p2, p3) {
      const u = 1 - t;
      return u*u*u*p0 + 3*u*u*t*p1 + 3*u*t*t*p2 + t*t*t*p3;
    }
    // Solve bezier X→T (Newton's method)
    function bezierSolve(x, x1, x2) {
      let t = x;
      for (let i = 0; i < 8; i++) {
        const cx = cubicBez(t, 0, x1, x2, 1) - x;
        const dx = 3*(1-t)*(1-t)*(x1) + 6*(1-t)*t*(x2-x1) + 3*t*t*(1-x2);
        if (Math.abs(dx) < 1e-6) break;
        t -= cx / dx;
        t = Math.max(0, Math.min(1, t));
      }
      return t;
    }

    // Draw easing curve (interactive)
    function drawCurve() {
      const canvas = opts.querySelector('.sopt-curve');
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const w = canvas.width, h = canvas.height;
      const pad = 6;
      const gw = w - pad * 2, gh = h - pad * 2;
      ctx.clearRect(0, 0, w, h);

      // Grid
      ctx.strokeStyle = 'rgba(255,255,255,0.04)';
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        ctx.beginPath(); ctx.moveTo(pad + gw * i / 4, pad); ctx.lineTo(pad + gw * i / 4, pad + gh); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(pad, pad + gh * i / 4); ctx.lineTo(pad + gw, pad + gh * i / 4); ctx.stroke();
      }

      const easing = binding.easing || 'easeInOut';
      const sm = binding.smoothing || 0;
      const isCustom = easing === 'custom';

      function ease(t) {
        if (isCustom) {
          const tt = bezierSolve(t, bz.x1, bz.x2);
          return cubicBez(tt, 0, bz.y1, bz.y2, 1);
        }
        if (easing === 'linear') return t;
        if (easing === 'easeIn') return t * t;
        if (easing === 'easeOut') return 1 - (1 - t) * (1 - t);
        if (easing === 'easeInOut') return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        if (easing === 'spring') return 1 - Math.exp(-6 * t) * Math.cos(t * (8 + sm * 12) * Math.PI);
        return t;
      }

      // Smoothing band
      if (sm > 0.01) {
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(255,130,160,0.2)';
        ctx.lineWidth = 3 + sm * 6;
        for (let px = 0; px <= gw; px++) {
          const v = Math.max(0, Math.min(1, ease(px / gw)));
          const x = pad + px, y = pad + gh - v * gh;
          if (px === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      // Main curve
      ctx.beginPath();
      ctx.strokeStyle = '#E84057';
      ctx.lineWidth = 2;
      for (let px = 0; px <= gw; px++) {
        const v = Math.max(0, Math.min(1.2, ease(px / gw)));
        const x = pad + px, y = pad + gh - v * gh;
        if (px === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Control points (only for custom)
      if (isCustom) {
        const p0x = pad, p0y = pad + gh;
        const p3x = pad + gw, p3y = pad;
        const p1x = pad + bz.x1 * gw, p1y = pad + gh - bz.y1 * gh;
        const p2x = pad + bz.x2 * gw, p2y = pad + gh - bz.y2 * gh;

        // Control lines
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(p0x, p0y); ctx.lineTo(p1x, p1y); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(p3x, p3y); ctx.lineTo(p2x, p2y); ctx.stroke();

        // Control handles
        [{ x: p1x, y: p1y }, { x: p2x, y: p2y }].forEach(pt => {
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
          ctx.fillStyle = '#E84057';
          ctx.fill();
          ctx.beginPath();
          ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
          ctx.fillStyle = '#fff';
          ctx.fill();
        });
      }
    }
    drawCurve();

    // Interactive drag on curve canvas (custom easing)
    const curveCanvas = opts.querySelector('.sopt-curve');
    let _dragPt = null;
    function canvasPos(e) {
      const r = curveCanvas.getBoundingClientRect();
      const scaleX = curveCanvas.width / r.width;
      const scaleY = curveCanvas.height / r.height;
      const cx = (e.clientX || e.touches[0].clientX);
      const cy = (e.clientY || e.touches[0].clientY);
      return { x: (cx - r.left) * scaleX, y: (cy - r.top) * scaleY };
    }
    function startDrag(e) {
      if ((binding.easing || 'easeInOut') !== 'custom') return;
      const p = canvasPos(e);
      const pad = 6, gw = curveCanvas.width - 12, gh = curveCanvas.height - 12;
      const p1x = pad + bz.x1 * gw, p1y = pad + gh - bz.y1 * gh;
      const p2x = pad + bz.x2 * gw, p2y = pad + gh - bz.y2 * gh;
      const d1 = Math.hypot(p.x - p1x, p.y - p1y);
      const d2 = Math.hypot(p.x - p2x, p.y - p2y);
      if (d1 < 15) _dragPt = 1;
      else if (d2 < 15) _dragPt = 2;
      else _dragPt = null;
      if (_dragPt) e.preventDefault();
    }
    function moveDrag(e) {
      if (!_dragPt) return;
      e.preventDefault();
      const p = canvasPos(e);
      const pad = 6, gw = curveCanvas.width - 12, gh = curveCanvas.height - 12;
      const nx = Math.max(0, Math.min(1, (p.x - pad) / gw));
      const ny = Math.max(-0.2, Math.min(1.2, 1 - (p.y - pad) / gh));
      if (_dragPt === 1) { bz.x1 = nx; bz.y1 = ny; }
      else { bz.x2 = nx; bz.y2 = ny; }
      drawCurve();
    }
    function endDrag() { _dragPt = null; }
    curveCanvas.addEventListener('pointerdown', startDrag);
    curveCanvas.addEventListener('pointermove', moveDrag);
    curveCanvas.addEventListener('pointerup', endDrag);
    curveCanvas.addEventListener('pointerleave', endDrag);

    row.after(sr);
    sr.after(opts);

    // Set easing value
    opts.querySelector('.sopt-easing').value = binding.easing || 'easeInOut';

    // Toggle expand/collapse on signal row click
    sr.addEventListener('click', (e) => {
      if (e.target.closest('.signal-row-remove')) return;
      sr.classList.toggle('expanded');
    });

    // Remove binding button
    sr.querySelector('.signal-row-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      const layer = getLayer(layerId);
      if (!layer) return;
      const paramName = row.dataset.name;
      const idx = layer.mpBindings.findIndex(b => b.param === paramName);
      if (idx >= 0) layer.mpBindings.splice(idx, 1);
      // Reset parameter to ISF default
      const isfInput = (layer.inputs || []).find(inp => inp.NAME === paramName);
      if (isfInput && isfInput.DEFAULT != null) {
        layer.inputValues[paramName] = isfInput.DEFAULT;
        // Also reset the slider UI
        const slider = row.querySelector('input[type="range"]');
        if (slider) { slider.value = isfInput.DEFAULT; const val = row.querySelector('.val'); if (val) val.textContent = parseFloat(isfInput.DEFAULT).toFixed(2); }
      }
      removeSignalRow(row);
      updateRangeIndicator(row, null);
      buildLinksUI(layerId);
      renderLinksDashboard();
    });

    // Source dropdown
    opts.querySelector('.sopt-signal').addEventListener('change', function() {
      const val = this.value;
      if (val === 'landmark') return;
      const layer = getLayer(layerId);
      if (!layer) return;
      const paramName = row.dataset.name;
      const idx = layer.mpBindings.findIndex(b => b.param === paramName);
      const old = idx >= 0 ? layer.mpBindings[idx] : binding;
      const parts = val.split(':');
      // When switching to audio source, apply audio-friendly defaults
      const isAudioSwitch = parts[0] === 'audio' && old.source !== 'audio';
      const newBinding = {
        source: parts[0],
        signalKey: parts[1],
        param: paramName,
        min: isAudioSwitch ? 0 : old.min,
        max: isAudioSwitch ? 0.05 : old.max,
        smoothing: isAudioSwitch ? 0.7 : (old.smoothing || 0),
        easing: isAudioSwitch ? 'easeOut' : (old.easing || 'easeInOut'),
        _pMin: old._pMin, _pMax: old._pMax
      };
      if (idx >= 0) layer.mpBindings[idx] = newBinding;
      else layer.mpBindings.push(newBinding);
      if (newBinding.source === 'audio' && window.ensureMicOn) window.ensureMicOn();
      sr.querySelector('.signal-row-label').textContent = getBindingSourceLabel(newBinding).replace(/^[♫⌖∿ƒ≡]\s*/, '');
      const lmOpt = this.querySelector('option[value="landmark"]');
      if (lmOpt) { lmOpt.remove(); const sep = this.querySelector('option[disabled]'); if (sep) sep.remove(); }
      buildLinksUI(layerId);
      renderLinksDashboard();
    });

    // Config inputs
    // Min slider
    const minSlider = opts.querySelector('.sopt-min-slider');
    const minVal = opts.querySelector('.sopt-min-val');
    minSlider.addEventListener('input', function() {
      const layer = getLayer(layerId);
      if (!layer) return;
      const v = parseFloat(this.value);
      if (isNaN(v)) return;
      const b = layer.mpBindings.find(b => b.param === row.dataset.name);
      if (b) { b.min = v; updateRangeIndicator(row, b); }
      minVal.textContent = v.toFixed(4);
    });
    // Click value label to type precise number
    minVal.style.cursor = 'pointer';
    minVal.addEventListener('click', function() {
      const input = document.createElement('input');
      input.type = 'number';
      input.step = '0.0001';
      input.value = minSlider.value;
      input.style.cssText = 'width:50px;background:rgba(0,0,0,0.5);border:1px solid rgba(232,64,87,0.4);border-radius:4px;color:#fff;font-size:11px;padding:2px 4px;text-align:right;';
      this.replaceWith(input);
      input.focus();
      input.select();
      const finish = () => {
        const v = parseFloat(input.value);
        if (!isNaN(v)) {
          minSlider.value = v;
          minSlider.dispatchEvent(new Event('input'));
        }
        const span = document.createElement('span');
        span.className = 'sopt-val sopt-min-val';
        span.style.cursor = 'pointer';
        span.textContent = parseFloat(minSlider.value).toFixed(4);
        input.replaceWith(span);
        // Re-bind click
        span.addEventListener('click', arguments.callee);
      };
      input.addEventListener('blur', finish);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    });

    // Max slider
    const maxSlider = opts.querySelector('.sopt-max-slider');
    const maxVal = opts.querySelector('.sopt-max-val');
    maxSlider.addEventListener('input', function() {
      const layer = getLayer(layerId);
      if (!layer) return;
      const v = parseFloat(this.value);
      if (isNaN(v)) return;
      const b = layer.mpBindings.find(b => b.param === row.dataset.name);
      if (b) { b.max = v; updateRangeIndicator(row, b); }
      maxVal.textContent = v.toFixed(4);
    });
    maxVal.style.cursor = 'pointer';
    maxVal.addEventListener('click', function() {
      const input = document.createElement('input');
      input.type = 'number';
      input.step = '0.0001';
      input.value = maxSlider.value;
      input.style.cssText = 'width:50px;background:rgba(0,0,0,0.5);border:1px solid rgba(232,64,87,0.4);border-radius:4px;color:#fff;font-size:11px;padding:2px 4px;text-align:right;';
      this.replaceWith(input);
      input.focus();
      input.select();
      const finish = () => {
        const v = parseFloat(input.value);
        if (!isNaN(v)) {
          maxSlider.value = v;
          maxSlider.dispatchEvent(new Event('input'));
        }
        const span = document.createElement('span');
        span.className = 'sopt-val sopt-max-val';
        span.style.cursor = 'pointer';
        span.textContent = parseFloat(maxSlider.value).toFixed(4);
        input.replaceWith(span);
        span.addEventListener('click', arguments.callee);
      };
      input.addEventListener('blur', finish);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    });
    opts.querySelector('.sopt-smooth').addEventListener('input', function() {
      const layer = getLayer(layerId);
      if (!layer) return;
      const b = layer.mpBindings.find(b => b.param === row.dataset.name);
      if (b) { b.smoothing = parseFloat(this.value); opts.querySelector('.sopt-smooth-val').textContent = Math.round(b.smoothing * 100) + '%'; drawCurve(); }
    });
    opts.querySelector('.sopt-easing').addEventListener('change', function() {
      const layer = getLayer(layerId);
      if (!layer) return;
      const b = layer.mpBindings.find(b => b.param === row.dataset.name);
      if (b) { b.easing = this.value; drawCurve(); }
    });
  }

  function updateSignalRows() {
    const rows = document.querySelectorAll('.signal-row');
    if (!rows.length) return;
    const audioSigs = { audioLevel, audioBass, audioMid, audioHigh };
    const derived = (typeof gestureProcessor !== 'undefined' && gestureProcessor.derived) || {};
    for (const sr of rows) {
      const paramName = sr.dataset.bindParam;
      const layerId = sr.dataset.layer;
      if (!paramName) continue;
      let v = 0;
      const layer = layerId ? getLayer(layerId) : null;
      const b = layer && layer.mpBindings ? layer.mpBindings.find(b => b.param === paramName) : null;
      if (b) {
        if (b.source === 'audio') v = audioSigs[b.signalKey] || 0;
        else if (b.source === 'mouse') {
          if (b.signalKey === 'mouseX') v = isfRenderer ? isfRenderer.mousePos[0] : 0;
          else if (b.signalKey === 'mouseY') v = isfRenderer ? isfRenderer.mousePos[1] : 0;
          else if (b.signalKey === 'mouseDown') v = isfRenderer ? (isfRenderer.mouseDown || 0) : 0;
        }
        else if (b.source === 'derived') v = derived[b.signalKey] || 0;
        else if (b.source === 'data') {
          if (b.dataType === 'expression') v = _dataManager.values['expr_' + b._bindId] || 0;
          else if (b.dataType === 'csv') v = _dataManager.values['csv_' + b._bindId] || 0;
          else v = _dataManager.values[b.signalKey] || 0;
        }
      }
      const pct = Math.max(0, Math.min(v, 1)) * 100;
      const fill = sr.querySelector('.signal-row-fill');
      if (fill) fill.style.width = pct.toFixed(1) + '%';
      const val = sr.querySelector('.signal-row-val');
      if (val) val.textContent = v.toFixed(2);
    }
  }

  // === MP Map: sync bound state on parameter buttons ===
  function syncMpLinkedState(container, layerId) {
    const layer = getLayer(layerId);
    if (!layer || !container) return;
    const bindMap = new Map();
    if (layer.mpBindings) {
      for (const b of layer.mpBindings) {
        if (b.param) bindMap.set(b.param, b);
      }
    }
    for (const btn of container.querySelectorAll('.bind-add-btn')) {
      const pName = btn.dataset.paramName;
      const bound = bindMap.has(pName);
      btn.classList.toggle('linked', bound);
      const row = btn.closest('.control-row');
      if (row) {
        const b = bindMap.get(pName);
        updateRangeIndicator(row, b || null);
        if (b) ensureSignalRow(row, b, layerId);
        else removeSignalRow(row);
      }
    }
  }

  // === MP Picker: singleton popup for mapping body parts to params ===
  let _mpPickerEl = null;
  let _mpPickerCloseHandler = null;

  function createMpPicker() {
    if (_mpPickerEl) return _mpPickerEl;
    const el = document.createElement('div');
    el.className = 'mp-picker';
    el.style.display = 'none';
    el.innerHTML = `
      <div class="mp-picker-header">
        <span class="mp-picker-title">Make Interactive</span>
        <button class="mp-picker-close">\u00D7</button>
      </div>
      <div class="mp-picker-categories">
        <button class="mp-cat-btn" data-group="hand"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 22c-1-2-4-4-4-8V7a1 1 0 012 0v5"/><path d="M10 12V5a1 1 0 012 0v7"/><path d="M14 12V6a1 1 0 012 0v6"/><path d="M18 14v-3a1 1 0 00-2 0v3"/><path d="M18 14c0 4-2 6-4 8"/><path d="M8 14V7"/></svg><span>Hand</span></button>
        <button class="mp-cat-btn" data-group="face"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5"><ellipse cx="12" cy="13" rx="7" ry="8.5"/><circle cx="9.5" cy="11" r="0.8" fill="currentColor"/><circle cx="14.5" cy="11" r="0.8" fill="currentColor"/><path d="M10 15.5q2 1.5 4 0"/></svg><span>Face</span></button>
        <button class="mp-cat-btn" data-group="pose"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="4.5" r="2"/><path d="M12 7v5m0 0l-4 6m4-6l4 6"/><path d="M7 11h10"/></svg><span>Pose</span></button>
        <button class="mp-cat-btn" data-group="signals"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 12h4l3-9 3 18 3-9h4"/></svg><span>Signals</span></button>
        <button class="mp-cat-btn" data-group="audio"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19"/><path d="M15.54 8.46a5 5 0 010 7.07"/><path d="M19.07 4.93a10 10 0 010 14.14"/></svg><span>Audio</span></button>
        <button class="mp-cat-btn" data-group="mouse"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="6" y="2" width="12" height="20" rx="6"/><line x1="12" y1="6" x2="12" y2="10"/></svg><span>Mouse</span></button>
        <button class="mp-cat-btn" data-group="touch"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="10" r="3"/><path d="M12 13v8"/><path d="M8 17l4 4 4-4"/></svg><span>Touch</span></button>
        <button class="mp-cat-btn" data-group="data"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg><span>Data</span></button>
      </div>
      <div class="mp-picker-list"></div>
      <div class="mp-picker-axis">
        <label><input type="radio" name="mp-axis" value="x" checked><span>X</span></label>
        <label><input type="radio" name="mp-axis" value="y"><span>Y</span></label>
        <label><input type="radio" name="mp-axis" value="z"><span>Z</span></label>
      </div>
      <div class="mp-picker-config" style="display:none">
        <div class="mp-picker-config-title">Range &amp; Smoothing</div>
        <div class="mp-picker-config-row"><label>Min</label><input type="number" class="cfg-min" step="any"></div>
        <div class="mp-picker-config-row"><label>Max</label><input type="number" class="cfg-max" step="any"></div>
        <div class="mp-picker-config-row"><label>Smooth</label><input type="range" class="cfg-smooth" min="0" max="1" step="0.01" value="0"><span class="cfg-val cfg-smooth-val">0%</span></div>
        <div class="mp-picker-config-row"><label>Easing</label><select class="cfg-easing"><option value="linear">Linear</option><option value="easeIn">Ease In</option><option value="easeOut">Ease Out</option><option value="easeInOut">Ease In Out</option><option value="spring">Spring</option></select></div>
      </div>
      <div class="mp-picker-btns">
        <button class="mp-picker-save">Save</button>
        <button class="mp-picker-clear">Clear Link</button>
      </div>
    `;
    document.body.appendChild(el);
    _mpPickerEl = el;

    // Close button
    el.querySelector('.mp-picker-close').addEventListener('click', () => {
      el.style.display = 'none';
      if (_mpPickerCloseHandler) { document.removeEventListener('pointerdown', _mpPickerCloseHandler, true); _mpPickerCloseHandler = null; }
    });

    return el;
  }

  window.openMpPicker = openMpPicker;
  window.ensureSignalRow = ensureSignalRow;
  window.removeSignalRow = removeSignalRow;
  window.getLayer = getLayer;
  function openMpPicker(anchorBtn, paramName, container) {
    const picker = createMpPicker();
    const layerCard = container.closest('[data-layer]');
    if (!layerCard) return;
    const layerId = layerCard.dataset.layer;
    const layer = getLayer(layerId);
    if (!layer) return;
    if (!layer.mpBindings) layer.mpBindings = [];

    // Find existing binding for this param
    let existing = layer.mpBindings.find(b => b.param === paramName);

    // Find ISF input def for min/max
    const isfInput = (layer.inputs || []).find(inp => inp.NAME === paramName);
    const pMin = isfInput && isfInput.MIN != null ? isfInput.MIN : 0;
    const pMax = isfInput && isfInput.MAX != null ? isfInput.MAX : 1;

    let activeGroup = existing
      ? (existing.source === 'audio' ? 'audio'
       : existing.source === 'mouse' ? 'mouse'
       : existing.source === 'data' ? 'data'
       : existing.source === 'derived' ? 'signals'
       : existing.group || 'hand')
      : 'hand';
    let selectedAxis = existing ? (existing.axis || 'x') : 'x';

    // Shared DOM refs (declared early to avoid TDZ)
    const listEl = picker.querySelector('.mp-picker-list');

    // Category buttons (replace old tabs)
    const catBtns = picker.querySelectorAll('.mp-cat-btn');
    const tabs = catBtns; // alias for compat
    const axisRow = picker.querySelector('.mp-picker-axis');
    const catsEl = picker.querySelector('.mp-picker-categories');
    // Initially show categories, hide list
    catsEl.style.display = '';
    listEl.style.display = 'none';
    axisRow.style.display = 'none';

    // Title
    const titleEl = picker.querySelector('.mp-picker-title');
    titleEl.textContent = 'Make Interactive';

    catBtns.forEach(t => {
      t.classList.remove('active');
      t.onclick = () => {
        activeGroup = t.dataset.group;
        catBtns.forEach(tt => tt.classList.remove('active'));
        t.classList.add('active');
        // Transition: hide categories, show list
        catsEl.style.display = 'none';
        listEl.style.display = '';
        titleEl.textContent = t.querySelector('span').textContent;
        // Show axis row only for body tracking
        const needsAxis = (activeGroup === 'hand' || activeGroup === 'face' || activeGroup === 'pose');
        axisRow.style.display = needsAxis ? '' : 'none';
        // Touch maps to mouse signals
        if (activeGroup === 'touch') activeGroup = 'mouse';
        renderList();
      };
    });

    // Back to categories
    titleEl.style.cursor = 'pointer';
    titleEl.onclick = () => {
      catsEl.style.display = '';
      listEl.style.display = 'none';
      axisRow.style.display = 'none';
      titleEl.textContent = 'Make Interactive';
      catBtns.forEach(tt => tt.classList.remove('active'));
      hideConfig();
    };

    // If existing binding, jump to its category
    if (existing) {
      const matchBtn = [...catBtns].find(b => b.dataset.group === activeGroup);
      if (matchBtn) matchBtn.click();
    }

    // Axis radios
    const axisRadios = picker.querySelectorAll('input[name="mp-axis"]');
    axisRadios.forEach(r => {
      r.checked = r.value === selectedAxis;
      r.onchange = () => {
        selectedAxis = r.value;
        if (existing && existing.axis) { existing.axis = selectedAxis; }
      };
    });

    // Config section elements
    const cfgSection = picker.querySelector('.mp-picker-config');
    const cfgMin = picker.querySelector('.cfg-min');
    const cfgMax = picker.querySelector('.cfg-max');
    const cfgSmooth = picker.querySelector('.cfg-smooth');
    const cfgSmoothVal = picker.querySelector('.cfg-smooth-val');
    const cfgEasing = picker.querySelector('.cfg-easing');

    function showConfig() {
      if (!existing) { cfgSection.style.display = 'none'; return; }
      cfgSection.style.display = '';
      cfgMin.value = existing.min;
      cfgMax.value = existing.max;
      cfgMin.min = pMin; cfgMin.max = pMax;
      cfgMax.min = pMin; cfgMax.max = pMax;
      cfgSmooth.value = existing.smoothing || 0;
      cfgSmoothVal.textContent = Math.round((existing.smoothing || 0) * 100) + '%';
      cfgEasing.value = existing.easing || 'easeInOut';
    }
    function hideConfig() { cfgSection.style.display = 'none'; }

    // Wire config inputs
    cfgMin.oninput = () => {
      if (!existing) return;
      existing.min = parseFloat(cfgMin.value);
      const row = anchorBtn.closest('.control-row');
      if (row) updateRangeIndicator(row, existing);
    };
    cfgMax.oninput = () => {
      if (!existing) return;
      existing.max = parseFloat(cfgMax.value);
      const row = anchorBtn.closest('.control-row');
      if (row) updateRangeIndicator(row, existing);
    };
    cfgSmooth.oninput = () => {
      if (!existing) return;
      existing.smoothing = parseFloat(cfgSmooth.value);
      cfgSmoothVal.textContent = Math.round(existing.smoothing * 100) + '%';
    };
    cfgEasing.onchange = () => {
      if (!existing) return;
      existing.easing = cfgEasing.value;
    };

    // Helper to finalize after selecting a signal
    function onSignalSelected() {
      anchorBtn.classList.add('linked');
      const row = anchorBtn.closest('.control-row');
      if (row) { ensureSignalRow(row, existing, layerId); updateRangeIndicator(row, existing); }
      buildLinksUI(layerId);
      renderLinksDashboard();
      renderList();
      showConfig();
    }

    // Landmark / Signals list
    function renderList() {
      listEl.innerHTML = '';
      if (activeGroup === 'signals') {
        // Derived signals from all groups
        for (const grp of ['hand', 'face', 'pose']) {
          const sigs = DERIVED_SIGNALS[grp] || [];
          for (const sig of sigs) {
            const item = document.createElement('div');
            item.className = 'mp-picker-list-item';
            item.textContent = sig.name;
            if (existing && existing.source === 'derived' && existing.signalKey === sig.key) {
              item.classList.add('selected');
            }
            item.onclick = () => {
              // Remove old binding, create derived — preserve range if editing
              const idx = layer.mpBindings.findIndex(b => b.param === paramName);
              const old = idx >= 0 ? layer.mpBindings.splice(idx, 1)[0] : null;
              existing = { source: 'derived', signalKey: sig.key, param: paramName, min: old ? old.min : pMin, max: old ? old.max : pMax, smoothing: old ? (old.smoothing||0) : 0, easing: old ? (old.easing||'easeInOut') : 'easeInOut', _pMin: pMin, _pMax: pMax };
              layer.mpBindings.push(existing);
              onSignalSelected();
            };
            listEl.appendChild(item);
          }
        }
      } else if (activeGroup === 'audio') {
        for (const sig of AUDIO_SIGNALS) {
          const item = document.createElement('div');
          item.className = 'mp-picker-list-item';
          item.textContent = sig.name;
          if (existing && existing.source === 'audio' && existing.signalKey === sig.key) {
            item.classList.add('selected');
          }
          item.onclick = () => {
            const idx = layer.mpBindings.findIndex(b => b.param === paramName);
            const old = idx >= 0 ? layer.mpBindings.splice(idx, 1)[0] : null;
            // Audio defaults: gentle range + high smoothing for natural feel
            const audioDefMin = old ? old.min : 0;
            const audioDefMax = old ? old.max : 0.05;
            const audioDefSmooth = old ? (old.smoothing||0) : 0.7;
            existing = { source: 'audio', signalKey: sig.key, param: paramName, min: audioDefMin, max: audioDefMax, smoothing: audioDefSmooth, easing: old ? (old.easing||'easeOut') : 'easeOut', _pMin: pMin, _pMax: pMax };
            layer.mpBindings.push(existing);
            if (window.ensureMicOn) window.ensureMicOn();
            onSignalSelected();
          };
          listEl.appendChild(item);
        }
      } else if (activeGroup === 'mouse') {
        for (const sig of MOUSE_SIGNALS) {
          const item = document.createElement('div');
          item.className = 'mp-picker-list-item';
          item.textContent = sig.name;
          if (existing && existing.source === 'mouse' && existing.signalKey === sig.key) {
            item.classList.add('selected');
          }
          item.onclick = () => {
            const idx = layer.mpBindings.findIndex(b => b.param === paramName);
            const old = idx >= 0 ? layer.mpBindings.splice(idx, 1)[0] : null;
            existing = { source: 'mouse', signalKey: sig.key, param: paramName, min: old ? old.min : pMin, max: old ? old.max : pMax, smoothing: old ? (old.smoothing||0) : 0, easing: old ? (old.easing||'easeInOut') : 'easeInOut', _pMin: pMin, _pMax: pMax };
            layer.mpBindings.push(existing);
            onSignalSelected();
          };
          listEl.appendChild(item);
        }
      } else if (activeGroup === 'data') {
        // Built-in data signals
        for (const sig of DATA_SIGNALS) {
          const item = document.createElement('div');
          item.className = 'mp-picker-list-item';
          item.textContent = sig.name;
          if (existing && existing.source === 'data' && existing.signalKey === sig.key) {
            item.classList.add('selected');
          }
          item.onclick = () => {
            const idx = layer.mpBindings.findIndex(b => b.param === paramName);
            const old = idx >= 0 ? layer.mpBindings.splice(idx, 1)[0] : null;
            existing = { source: 'data', signalKey: sig.key, param: paramName, min: old ? old.min : pMin, max: old ? old.max : pMax, smoothing: old ? (old.smoothing||0) : 0, easing: old ? (old.easing||'easeInOut') : 'easeInOut', _pMin: pMin, _pMax: pMax };
            layer.mpBindings.push(existing);
            onSignalSelected();
            // Show BPM config if BPM Pulse selected
            if (sig.key === 'dataBpm') showBpmConfig();
            else hideBpmConfig();
          };
          listEl.appendChild(item);
        }
        // Live data sources (from data.js module)
        if (window._dataSources) {
          const liveSignals = window._dataSources.getSignals();
          if (liveSignals.length) {
            const liveDiv = document.createElement('div');
            liveDiv.style.cssText = 'height:1px;background:var(--border);margin:6px 0';
            listEl.appendChild(liveDiv);
            const liveLabel = document.createElement('div');
            liveLabel.style.cssText = 'font-size:9px;color:var(--sc-text-dim);padding:4px 0;text-transform:uppercase;letter-spacing:1px';
            liveLabel.textContent = 'Live Sources';
            listEl.appendChild(liveLabel);
            for (const sig of liveSignals) {
              const item = document.createElement('div');
              item.className = 'mp-picker-list-item';
              item.textContent = sig.name;
              if (existing && existing.source === 'data' && existing.signalKey === sig.key) item.classList.add('selected');
              item.onclick = () => {
                const idx = layer.mpBindings.findIndex(b => b.param === paramName);
                const old = idx >= 0 ? layer.mpBindings.splice(idx, 1)[0] : null;
                existing = { source: 'data', signalKey: sig.key, param: paramName, min: old ? old.min : pMin, max: old ? old.max : pMax, smoothing: old ? (old.smoothing||0) : 0, easing: old ? (old.easing||'easeInOut') : 'easeInOut', _pMin: pMin, _pMax: pMax };
                layer.mpBindings.push(existing);
                onSignalSelected();
              };
              listEl.appendChild(item);
            }
          }
        }
        // Divider
        const div = document.createElement('div');
        div.style.cssText = 'height:1px;background:var(--border);margin:6px 0';
        listEl.appendChild(div);
        // Custom expression
        const exprItem = document.createElement('div');
        exprItem.className = 'mp-picker-list-item';
        exprItem.textContent = 'f(x) Custom Expression';
        if (existing && existing.source === 'data' && existing.dataType === 'expression') exprItem.classList.add('selected');
        exprItem.onclick = () => showExpressionInput();
        listEl.appendChild(exprItem);
        // CSV/JSON import
        const csvItem = document.createElement('div');
        csvItem.className = 'mp-picker-list-item';
        csvItem.textContent = 'Import CSV/JSON';
        if (existing && existing.source === 'data' && existing.dataType === 'csv') csvItem.classList.add('selected');
        csvItem.onclick = () => showFileImport();
        listEl.appendChild(csvItem);
      } else {
        const parts = MP_BODY_PARTS[activeGroup] || [];
        for (const part of parts) {
          const item = document.createElement('div');
          item.className = 'mp-picker-list-item';
          item.textContent = part.name;
          if (existing && existing.group === activeGroup && existing.landmarkIndex === part.index) {
            item.classList.add('selected');
          }
          item.onclick = () => {
            // Create or update landmark binding
            const idx = layer.mpBindings.findIndex(b => b.param === paramName);
            if (idx >= 0) layer.mpBindings.splice(idx, 1);
            existing = { group: activeGroup, landmarkIndex: part.index, param: paramName, axis: selectedAxis, min: pMin, max: pMax, smoothing: 0, easing: 'easeInOut', _pMin: pMin, _pMax: pMax };
            layer.mpBindings.push(existing);
            onSignalSelected();
          };
          listEl.appendChild(item);
        }
      }
    }
    renderList();

    // --- Data tab helper functions ---
    let _bpmRow = null, _exprRow = null, _fileRow = null;

    function hideBpmConfig() {
      if (_bpmRow) { _bpmRow.remove(); _bpmRow = null; }
    }
    function showBpmConfig() {
      hideBpmConfig(); hideExprInput(); hideFileImport();
      _bpmRow = document.createElement('div');
      _bpmRow.className = 'mp-picker-bpm-row';
      _bpmRow.innerHTML = '<label>BPM</label><input type="number" min="20" max="300" value="' + _dataManager._bpm + '" step="1">';
      listEl.after(_bpmRow);
      _bpmRow.querySelector('input').oninput = function() {
        const v = Math.max(20, Math.min(300, parseInt(this.value) || 120));
        _dataManager._bpm = v;
      };
    }

    function hideExprInput() {
      if (_exprRow) { _exprRow.remove(); _exprRow = null; }
    }
    function showExpressionInput() {
      hideExprInput(); hideBpmConfig(); hideFileImport();
      const bindId = paramName + '_' + layerId;
      _exprRow = document.createElement('div');
      _exprRow.className = 'mp-picker-expr-row';
      _exprRow.innerHTML = '<input type="text" placeholder="e.g. Math.sin(t*3)*0.5+0.5" spellcheck="false"><div class="mp-picker-expr-error"></div>';
      listEl.after(_exprRow);
      const inp = _exprRow.querySelector('input');
      const errEl = _exprRow.querySelector('.mp-picker-expr-error');
      // Restore existing expression
      if (existing && existing.source === 'data' && existing.dataType === 'expression' && existing._expr) {
        inp.value = existing._expr;
      }
      inp.oninput = function() {
        const expr = this.value.trim();
        if (!expr) { errEl.textContent = ''; return; }
        const err = _dataManager.setExpression(bindId, expr);
        if (err) { errEl.textContent = err; return; }
        errEl.textContent = '';
        // Create/update binding
        const idx = layer.mpBindings.findIndex(b => b.param === paramName);
        if (idx >= 0) layer.mpBindings.splice(idx, 1);
        existing = { source: 'data', dataType: 'expression', _bindId: bindId, _expr: expr, param: paramName, min: pMin, max: pMax, smoothing: 0, easing: 'easeInOut', _pMin: pMin, _pMax: pMax };
        layer.mpBindings.push(existing);
        onSignalSelected();
      };
      inp.focus();
    }

    function hideFileImport() {
      if (_fileRow) { _fileRow.remove(); _fileRow = null; }
    }
    function showFileImport() {
      hideFileImport(); hideBpmConfig(); hideExprInput();
      const bindId = paramName + '_' + layerId;
      _fileRow = document.createElement('div');
      _fileRow.className = 'mp-picker-file-row';
      _fileRow.innerHTML = '<label class="mp-picker-file-label">Choose File<input type="file" accept=".csv,.json,.txt" style="display:none"></label><span class="mp-picker-file-info"></span>';
      listEl.after(_fileRow);
      const fileInput = _fileRow.querySelector('input[type="file"]');
      const fileInfo = _fileRow.querySelector('.mp-picker-file-info');
      fileInput.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          const text = reader.result;
          if (file.name.endsWith('.json')) {
            try {
              const parsed = JSON.parse(text);
              const arr = Array.isArray(parsed) ? parsed : Object.values(parsed);
              _dataManager.loadJSON(bindId, arr);
            } catch (_) { fileInfo.textContent = 'Invalid JSON'; return; }
          } else {
            _dataManager.loadCSV(bindId, text, 0);
          }
          fileInfo.textContent = file.name + ' (' + (_dataManager.csvData[bindId]?.data?.length || 0) + ' rows)';
          // Create binding
          const idx = layer.mpBindings.findIndex(b => b.param === paramName);
          if (idx >= 0) layer.mpBindings.splice(idx, 1);
          existing = { source: 'data', dataType: 'csv', _bindId: bindId, param: paramName, min: pMin, max: pMax, smoothing: 0, easing: 'easeInOut', _pMin: pMin, _pMax: pMax };
          layer.mpBindings.push(existing);
          onSignalSelected();
        };
        reader.readAsText(file);
      };
    }

    // Show config if there's already a binding
    if (existing) {
      // Ensure _pMin/_pMax are populated on legacy bindings
      if (existing._pMin == null) existing._pMin = pMin;
      if (existing._pMax == null) existing._pMax = pMax;
      if (existing.smoothing == null) existing.smoothing = 0;
      if (existing.easing == null) existing.easing = 'easeInOut';
      showConfig();
    } else {
      hideConfig();
    }

    // Save button — confirm and close
    picker.querySelector('.mp-picker-save').onclick = () => {
      closeMpPicker();
    };

    // Clear button
    picker.querySelector('.mp-picker-clear').onclick = () => {
      const idx = layer.mpBindings.findIndex(b => b.param === paramName);
      if (idx >= 0) {
        const removed = layer.mpBindings[idx];
        // Clean up data manager state for data bindings
        if (removed.source === 'data' && removed._bindId) {
          delete _dataManager.expressions[removed._bindId];
          delete _dataManager.csvData[removed._bindId];
        }
        layer.mpBindings.splice(idx, 1);
      }
      existing = null;
      anchorBtn.classList.remove('linked');
      const row = anchorBtn.closest('.control-row');
      if (row) { removeSignalRow(row); updateRangeIndicator(row, null); }
      buildLinksUI(layerId);
      hideBpmConfig(); hideExprInput(); hideFileImport();
      hideConfig();
      closeMpPicker();
    };

    // Position near anchor
    const rect = anchorBtn.getBoundingClientRect();
    picker.style.display = 'flex';
    picker.style.left = Math.min(rect.right + 4, window.innerWidth - 270) + 'px';
    picker.style.top = Math.min(rect.top, window.innerHeight - 460) + 'px';

    // Close on click outside
    if (_mpPickerCloseHandler) document.removeEventListener('pointerdown', _mpPickerCloseHandler, true);
    _mpPickerCloseHandler = (e) => {
      if (!picker.contains(e.target) && e.target !== anchorBtn) closeMpPicker();
    };
    setTimeout(() => document.addEventListener('pointerdown', _mpPickerCloseHandler, true), 0);
  }

  function closeMpPicker() {
    if (_mpPickerEl) _mpPickerEl.style.display = 'none';
    if (_mpPickerCloseHandler) {
      document.removeEventListener('pointerdown', _mpPickerCloseHandler, true);
      _mpPickerCloseHandler = null;
    }
  }

  // === Hand position widget update ===
  function updateHandPosWidget() {
    if (!handAsMouseEnabled || !mediaPipeMgr || !mediaPipeMgr.active) return;
    const hx = 1.0 - mediaPipeMgr.handPos[0];
    const hy = mediaPipeMgr.handPos[1];
    handPosDot.style.left = (hx * 100) + '%';
    handPosDot.style.top = ((1 - hy) * 100) + '%';
    handPosXRange.value = hx;
    handPosYRange.value = hy;
    handPosXVal.textContent = hx.toFixed(2);
    handPosYVal.textContent = hy.toFixed(2);
  }

  // === Live slider feedback for bound parameters (Step 5) ===
  function updateLinkedSliders() {
    for (const layer of layers) {
      if (!layer.mpBindings || layer.mpBindings.length === 0) continue;
      const container = document.querySelector(`.layer-params[data-layer="${layer.id}"]`);
      if (!container) continue;
      for (const b of layer.mpBindings) {
        if (!b.param || layer.inputValues[b.param] == null) continue;
        const row = container.querySelector(`.control-row[data-name="${b.param}"]`) ||
                    Array.from(container.querySelectorAll('.control-row')).find(r => {
                      const btn = r.querySelector('.bind-add-btn');
                      return btn && btn.dataset.paramName === b.param;
                    });
        if (!row) continue;
        const slider = row.querySelector('input[type="range"]');
        const valSpan = row.querySelector('.val');
        const v = layer.inputValues[b.param];
        if (slider) slider.value = v;
        if (valSpan) valSpan.textContent = Number(v).toFixed(2);
      }
    }
  }

  // Hook into MediaPipe enable to refresh bindings UI
  const _origStartMP = typeof startMediaPipe === 'function' ? startMediaPipe : null;

  // === 3D layer: model upload button ===
  document.getElementById('scene-model-btn').addEventListener('click', () => {
    document.getElementById('model-file-input').click();
  });

  // Inputs section collapse toggle (assets panel keeps it always open)
  const _inputsSectionHeader = document.querySelector('#inputs-section .section-header');
  if (_inputsSectionHeader) _inputsSectionHeader.addEventListener('click', () => {
    document.getElementById('inputs-section').classList.toggle('open');
  });

  // Properties panel resize drag (left edge handle)
  const propsPanel = document.querySelector('.sc3-properties');
  const propsResizeHandle = document.getElementById('properties-resize');
  let propsResizing = false;
  if (propsResizeHandle) {
    propsResizeHandle.addEventListener('pointerdown', (e) => {
      propsResizing = true;
      propsResizeHandle.classList.add('active');
      propsResizeHandle.setPointerCapture(e.pointerId);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });
    propsResizeHandle.addEventListener('pointermove', (e) => {
      if (!propsResizing) return;
      const gap = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sc-panel-gap')) || 8;
      const w = Math.max(200, Math.min(600, window.innerWidth - e.clientX - gap));
      propsPanel.style.width = w + 'px';
    });
    propsResizeHandle.addEventListener('pointerup', () => {
      propsResizing = false;
      propsResizeHandle.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
  }

  // Sidebar resize drag (legacy)
  const resizeHandle = document.getElementById('sidebar-resize');
  const appEl = document.getElementById('app');
  let resizing = false;
  resizeHandle.addEventListener('pointerdown', (e) => {
    resizing = true;
    resizeHandle.classList.add('active');
    resizeHandle.setPointerCapture(e.pointerId);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  resizeHandle.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    const w = Math.max(200, Math.min(600, window.innerWidth - e.clientX));
    appEl.style.gridTemplateColumns = '1fr 5px ' + w + 'px';
  });
  resizeHandle.addEventListener('pointerup', () => {
    resizing = false;
    resizeHandle.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });

  // Mobile drag handle — resize canvas/sidebar split
  const mobileDragHandle = document.getElementById('mobile-drag-handle');
  const mainEl = document.getElementById('main');
  let mobileResizing = false;
  let mobileResizePointerId = null;
  mobileDragHandle.addEventListener('pointerdown', (e) => {
    mobileResizing = true;
    mobileResizePointerId = e.pointerId;
    mobileDragHandle.setPointerCapture(e.pointerId);
    document.body.style.userSelect = 'none';
  });
  mobileDragHandle.addEventListener('pointermove', (e) => {
    if (!mobileResizing) return;
    const vh = window.innerHeight;
    const pct = Math.max(8, Math.min(70, (e.clientY / vh) * 100));
    appEl.style.gridTemplateRows = pct + 'vh auto 1fr';
  });
  mobileDragHandle.addEventListener('pointerup', () => {
    mobileResizing = false;
    mobileResizePointerId = null;
    document.body.style.userSelect = '';
  });
  mobileDragHandle.addEventListener('pointercancel', () => {
    mobileResizing = false;
    mobileResizePointerId = null;
    document.body.style.userSelect = '';
  });

  // Canvas panel always open (no collapse toggle)

  // Shared mic toggle logic — unified: audio analysis + speech recognition
  async function toggleMic() {
    const headerBtn = document.getElementById('canvas-mic-btn');
    const panelToggle = document.getElementById('voice-mic-toggle');
    if (_micAudioEntry || (_micCaptionEntry && mediaInputs.includes(_micCaptionEntry))) {
      // Stop mic — remove audio entry (which also stops captions via removeMedia)
      if (_micAudioEntry) removeMedia(_micAudioEntry.id);
      else if (_micCaptionEntry) removeMedia(_micCaptionEntry.id);
      headerBtn.classList.remove('active');
      if (panelToggle) panelToggle.classList.remove('active');
      _voiceDecayEnabled = false;
      const textLayer = getLayer('text');
      if (textLayer) { textLayer.opacity = 1.0; textLayer._voiceGlitch = 0.0; }
      const vd = document.getElementById('voice-detail');
      if (vd) vd.classList.remove('visible');
    } else {
      // Start mic — audio analysis + speech recognition + indicators
      try { await addMicAudio(); } catch(e) { console.warn('Mic access denied:', e); return; }
      headerBtn.classList.add('active');
      if (panelToggle) panelToggle.classList.add('active');
      _voiceDecayEnabled = true;
      const vd = document.getElementById('voice-detail');
      if (vd) vd.classList.add('visible');
    }
  }

  // Auto-enable mic when an audio binding is created
  window.ensureMicOn = async function() {
    if (!_micAudioEntry) {
      await toggleMic();
    }
  };

  // Live Signals: each button toggles its own panel independently (all can be open)
  document.getElementById('canvas-mic-btn').addEventListener('click', () => {
    const btn = document.getElementById('canvas-mic-btn');
    const vd = document.getElementById('voice-detail');
    if (!vd) return;
    const isHidden = vd.style.display === 'none' || vd.style.display === '';
    vd.style.display = isHidden ? 'block' : 'none';
    btn.classList.toggle('active', isHidden);
    if (isHidden && !_micAudioEntry) toggleMic();
  });

  // Voice panel Mic toggle — mirrors header button
  document.getElementById('voice-mic-toggle').addEventListener('click', toggleMic);

  // Camera circle button — toggles camera panel
  document.getElementById('cam-vis-btn').addEventListener('click', () => {
    const btn = document.getElementById('cam-vis-btn');
    const cd = document.getElementById('camera-detail');
    if (!cd) return;
    const isHidden = cd.style.display === 'none' || cd.style.display === '';
    cd.style.display = isHidden ? 'block' : 'none';
    btn.classList.toggle('active', isHidden);
  });

  // Data source circle button — toggles data panel
  const _dataBtn = document.getElementById('data-source-btn');
  if (_dataBtn) {
    _dataBtn.addEventListener('click', () => {
      const dd = document.getElementById('data-detail');
      if (!dd) return;
      const isHidden = dd.style.display === 'none' || dd.style.display === '';
      dd.style.display = isHidden ? 'block' : 'none';
      _dataBtn.classList.toggle('active', isHidden);
    });
  }

  // Content source circle button — show/hide content panel
  const _contentBtn = document.getElementById('content-source-btn');
  if (_contentBtn) {
    _contentBtn.addEventListener('click', () => {
      // Switch to Assets/Code tab instead of showing duplicate content tiles
      const assetsTab = document.querySelector('.sc3-tab[data-tab="assets"]');
      if (assetsTab) assetsTab.click();
      // Hide other input detail panels
      const vd = document.getElementById('voice-detail');
      const cd = document.getElementById('camera-detail');
      const dd = document.getElementById('data-detail');
      const ctd = document.getElementById('content-detail');
      if (vd) { vd.style.display = 'none'; document.getElementById('canvas-mic-btn')?.classList.remove('active'); }
      if (cd) { cd.style.display = 'none'; document.getElementById('cam-vis-btn')?.classList.remove('active'); }
      if (dd) { dd.style.display = 'none'; document.getElementById('data-source-btn')?.classList.remove('active'); }
      if (ctd) ctd.style.display = 'none';
      _contentBtn.classList.remove('active');
    });
    // Content tile handlers
    document.getElementById('content-add-image').addEventListener('click', () => document.getElementById('image-file-input').click());
    document.getElementById('content-add-video').addEventListener('click', () => document.getElementById('video-file-input').click());
    document.getElementById('content-add-model').addEventListener('click', () => document.getElementById('model-file-input').click());
    document.getElementById('content-add-sound').addEventListener('click', () => document.getElementById('sound-file-input').click());
    document.getElementById('content-add-webcam').addEventListener('click', () => {
      // Trigger webcam add
      const camBtn = document.getElementById('cam-vis-btn');
      if (camBtn) camBtn.click();
    });
    document.getElementById('content-add-ndi').addEventListener('click', () => {
      if (!_ndiWs || _ndiWs.readyState !== WebSocket.OPEN) {
        console.warn('NDI: WebSocket not connected');
        return;
      }
      const picker = document.getElementById('ndi-source-picker');
      if (picker) {
        picker.classList.add('visible');
        refreshNdiSources(_ndiWs);
      }
    });
  }

  // Also hide content panel when other circle buttons are clicked
  // (patch existing voice/camera/data handlers to close content panel)
  const _hideContentPanel = () => {
    const ctd = document.getElementById('content-detail');
    if (ctd) ctd.style.display = 'none';
    if (_contentBtn) _contentBtn.classList.remove('active');
  };

  // Data source add dropdown
  const _dataSelect = document.getElementById('data-source-select');
  if (_dataSelect) {
    _dataSelect.addEventListener('change', () => {
      const type = _dataSelect.value;
      if (!type || !window._dataSources) return;
      _dataSelect.value = '';

      let config = {};
      if (type === 'weather') {
        const city = prompt('City name:', 'London');
        if (!city) return;
        config.city = city;
      } else if (type === 'football') {
        const mode = prompt('Enter "demo" for simulated match, or paste your football-data.org API token:', 'demo');
        if (!mode) return;
        if (mode.trim().toLowerCase() === 'demo') {
          const home = prompt('Home team name:', 'Liverpool');
          const away = prompt('Away team name:', 'Galatasaray');
          if (!home || !away) return;
          config = { demo: true, home, away, label: `${home} vs ${away}` };
        } else {
          const home = prompt('Home team name (used to find today\'s match):', 'Liverpool');
          const away = prompt('Away team name:', 'Galatasaray');
          const comp = prompt('Competition code (CL, PL, BL1, SA, FL1, PD, DED):', 'CL');
          config = {
            apiKey: mode.trim(), provider: 'football-data',
            competition: comp || 'CL', home: home || 'Home', away: away || 'Away',
            label: `${home} vs ${away}`
          };
        }
      } else if (type === 'json_api') {
        const url = prompt('JSON API URL:');
        if (!url) return;
        const field = prompt('JSON field path (e.g. data.price):', 'value');
        config = { url, field };
      } else if (type === 'websocket') {
        const url = prompt('WebSocket URL:');
        if (!url) return;
        const field = prompt('JSON field path:', 'value');
        config = { url, field };
      } else if (type === 'expression') {
        const expr = prompt('Expression (use t for time):', 'Math.sin(t * 2) * 0.5 + 0.5');
        if (!expr) return;
        config.expr = expr;
      } else if (type === 'rss') {
        const url = prompt('RSS Feed URL:');
        if (!url) return;
        config.url = url;
      } else if (type === 'image_feed') {
        const feedName = prompt('Feed folder name (e.g. sunsets, flowers):', 'default');
        if (!feedName) return;
        config.feedName = feedName.replace(/[^a-zA-Z0-9_-]/g, '');
        config.pollSeconds = 5;
      } else if (type === 'csv_timeseries') {
        const url = prompt('CSV URL or path (e.g. /data/gdp_world.csv):', '/data/gdp_world.csv');
        if (!url) return;
        config.url = url;
        const speed = prompt('Playback speed (rows/sec):', '2');
        config.speed = parseFloat(speed) || 2;
      }

      const src = window._dataSources.addSource(type, config);
      if (src) _renderDataSources();
    });
  }

  function _renderDataSources() {
    const list = document.getElementById('data-sources-list');
    if (!list || !window._dataSources) return;
    const sources = window._dataSources.getSources();
    list.innerHTML = '';
    for (const src of sources) {
      const typeDef = window._dataSources.SOURCE_TYPES[src.type];
      const row = document.createElement('div');
      row.className = 'asset-row';
      row.style.flexWrap = 'wrap';
      const signals = typeDef ? typeDef.getSignals(src) : [];
      row.innerHTML = `
        <span class="asset-icon">${typeDef?.icon || '?'}</span>
        <span class="asset-name" style="flex:1">${src.label}</span>
        <span class="asset-controls">
          <span style="font-size:9px;color:var(--sc-text-dim)">${signals.length} sig</span>
          <button class="asset-delete" data-id="${src.id}">&times;</button>
        </span>
        <div class="data-signals-preview" data-src-id="${src.id}" style="width:100%;margin-top:4px;display:flex;flex-wrap:wrap;gap:2px 6px;font-size:9px;color:var(--sc-text-dim)"></div>`;
      row.querySelector('.asset-delete').addEventListener('click', () => {
        window._dataSources.removeSource(src.id);
        _renderDataSources();
      });
      list.appendChild(row);
    }
    // Live update signal previews
    if (sources.length && !list._liveInterval) {
      list._liveInterval = setInterval(() => {
        const vals = window._dataSources.values;
        for (const src of window._dataSources.getSources()) {
          const preview = list.querySelector(`.data-signals-preview[data-src-id="${src.id}"]`);
          if (!preview) continue;
          const typeDef = window._dataSources.SOURCE_TYPES[src.type];
          const signals = typeDef ? typeDef.getSignals(src) : [];
          preview.innerHTML = signals.map(sig => {
            const v = vals[sig.key];
            const display = v != null ? (v * 100).toFixed(0) + '%' : '--';
            return `<span title="${sig.key}">${sig.name.replace(src.home || '', 'H').replace(src.away || '', 'A')}: <b style="color:var(--sc-accent)">${display}</b></span>`;
          }).join('');
        }
      }, 1000);
    }
  }

  // Helper to sync toggle section expand/collapse with layer visibility
  function syncToggleSection(layerId, visible) {
    const s = document.querySelector(`.layer-toggle-section .layer-toggle-header[data-layer="${layerId}"]`);
    if (s) s.closest('.layer-toggle-section').classList.toggle('active', visible);
  }

  // ===== LAYER TOGGLE SECTIONS (Text / 3D) =====
  (function initLayerToggleSections() {
    document.querySelectorAll('.layer-toggle-header').forEach(header => {
      header.addEventListener('click', (e) => {
        // Don't toggle if clicking the eye button itself (that toggles visibility)
        if (e.target.closest('.layer-vis')) return;
        e.stopPropagation();
        const section = header.closest('.layer-toggle-section');
        const layerId = header.dataset.layer;
        const layer = getLayer(layerId);
        const isOpen = section.classList.contains('active');

        if (isOpen) {
          // Collapse and turn off
          section.classList.remove('active');
          if (layer) { layer.visible = false; updateLayerCardUI(layerId); }
        } else {
          // Expand and turn on
          section.classList.add('active');
          if (layer) { layer.visible = true; updateLayerCardUI(layerId); }
        }
      });
    });
  })();

  // Export hub actions
  function exportAction(action) {
    if (action === 'window') {
      if (projectionWindow && !projectionWindow.closed) {
        projectionWindow.close();
        projectionWindow = null; projectionCtx = null; projectionCanvas = null;
      } else {
        projectionWindow = window.open('', 'ShaderClaw Projection',
          `width=${glCanvas.width},height=${glCanvas.height},menubar=no,toolbar=no,location=no,status=no`);
        projectionWindow.document.title = 'ShaderClaw';
        projectionWindow.document.body.style.cssText = 'margin:0;background:#000;overflow:hidden;cursor:none';
        projectionCanvas = projectionWindow.document.createElement('canvas');
        projectionCanvas.width = glCanvas.width;
        projectionCanvas.height = glCanvas.height;
        projectionCanvas.style.cssText = 'width:100vw;height:100vh;object-fit:contain;display:block';
        projectionWindow.document.body.appendChild(projectionCanvas);
        projectionCtx = projectionCanvas.getContext('2d');
        projectionWindow.addEventListener('beforeunload', () => {
          projectionWindow = null; projectionCtx = null; projectionCanvas = null;
        });
      }
    } else if (action === 'screenshot') {
      glCanvas.toBlob(blob => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'shaderclaw-' + Date.now() + '.png';
        a.click();
        URL.revokeObjectURL(a.href);
      }, 'image/png');
    } else if (action === 'gif') {
      console.log('GIF export — coming soon');
    } else if (action === 'video') {
      console.log('Video export — coming soon');
    } else if (action === 'ndi') {
      toggleNdiSend();
    } else if (action === 'copy') {
      const src = patchISFDefaults(editor.getValue(), getFocusedLayer());
      navigator.clipboard.writeText(src).then(() => {
        const btn = exportHub.querySelector('[data-action="copy"] span');
        if (btn) { btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = 'Copy .fs', 1500); }
      });
    } else if (action === 'download') {
      const src = patchISFDefaults(editor.getValue(), getFocusedLayer());
      const blob = new Blob([src], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'shader-' + Date.now() + '.fs';
      a.click();
      URL.revokeObjectURL(a.href);
    }
  }

  // Patch ISF header DEFAULTs with current parameter values
  function patchISFDefaults(source, layer) {
    if (!layer || !layer.inputValues || !layer.inputs || !layer.inputs.length) return source;
    const headerMatch = source.match(/^\/\*(\{[\s\S]*?\})\*\//);
    if (!headerMatch) return source;
    try {
      const header = JSON.parse(headerMatch[1]);
      if (!header.INPUTS) return source;
      const vals = layer.inputValues;
      for (const inp of header.INPUTS) {
        if (!(inp.NAME in vals)) continue;
        const v = vals[inp.NAME];
        if (inp.TYPE === 'float' || inp.TYPE === 'long') {
          inp.DEFAULT = typeof v === 'number' ? parseFloat(v.toFixed(4)) : v;
        } else if (inp.TYPE === 'bool') {
          inp.DEFAULT = v ? true : false;
        } else if (inp.TYPE === 'color') {
          if (Array.isArray(v)) inp.DEFAULT = v.map(c => parseFloat(c.toFixed(4)));
        } else if (inp.TYPE === 'point2D') {
          if (Array.isArray(v)) inp.DEFAULT = v.map(c => parseFloat(c.toFixed(4)));
        } else if (inp.TYPE === 'text') {
          inp.DEFAULT = v;
        }
      }
      const patched = '/*' + JSON.stringify(header, null, 2) + '*/';
      return source.replace(/^\/\*\{[\s\S]*?\}\*\//, patched);
    } catch (e) {
      return source;
    }
  }

  // Export hub popup
  const exportHub = document.getElementById('export-hub');
  document.getElementById('export-hub-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    exportHub.classList.toggle('show');
  });
  exportHub.addEventListener('click', (e) => {
    const tile = e.target.closest('[data-action]');
    if (!tile) return;
    exportAction(tile.dataset.action);
    exportHub.classList.remove('show');
  });
  // Close on outside click
  document.addEventListener('click', (e) => {
    if (exportHub.classList.contains('show') && !exportHub.contains(e.target) && e.target.id !== 'export-hub-btn') {
      exportHub.classList.remove('show');
    }
  });

  // --- Sidebar Tabs ---
  const sidebarTabs = document.querySelectorAll('.sidebar-tab');
  const canvasTabContent = document.getElementById('canvas-tab-content');
  const galleryTabContent = document.getElementById('gallery-tab-content');
  const exportTabContent = document.getElementById('export-tab-content');
  const tabContentMap = { canvas: canvasTabContent, gallery: galleryTabContent, export: exportTabContent };

  sidebarTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      sidebarTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      Object.values(tabContentMap).forEach(c => c.classList.remove('active'));
      if (tabContentMap[target]) tabContentMap[target].classList.add('active');
      if (target === 'gallery' && !galleryTabContent._populated) populateGallery();
    });
  });

  // SC3: Auto-populate gallery since tabs are removed
  setTimeout(() => { if (!galleryTabContent._populated) populateGallery(); updateGalleryActiveStates(); }, 100);

  // Populate gallery grid from manifest
  function populateGallery(filter) {
    const grid = document.getElementById('gallery-grid');
    grid.innerHTML = '';
    galleryTabContent._populated = true;
    const q = (filter || '').toLowerCase();

    // Combine all shaders + scenes into 3 categories: 3D, VFX, Text
    const allItems = [...isfShaders, ...scenes];
    const categories = { '3D': [], 'VFX': [], 'Text': [] };
    allItems.forEach(item => {
      if (q && !item.title.toLowerCase().includes(q) && !(item.description || '').toLowerCase().includes(q)) return;
      const cats = item.categories || [];
      if (cats.includes('Text')) {
        if (!categories['Text'].find(x => x.id === item.id)) categories['Text'].push(item);
      } else if (cats.includes('3D') || item.type === 'scene') {
        if (!categories['3D'].find(x => x.id === item.id)) categories['3D'].push(item);
      } else {
        if (!categories['VFX'].find(x => x.id === item.id)) categories['VFX'].push(item);
      }
    });

    // Fixed order: VFX, Text, 3D
    const sortedCats = ['VFX', 'Text', '3D'];
    for (const cat of sortedCats) {
      if (!categories[cat] || categories[cat].length === 0) continue;
      const items = categories[cat].sort((a, b) => a.title.localeCompare(b.title));
      const title = document.createElement('div');
      title.className = 'gallery-category-title';
      title.textContent = cat;
      grid.appendChild(title);
      items.forEach(item => {
        const card = document.createElement('div');
        card.className = 'gallery-card';
        card.dataset.file = item.file;
        card.dataset.layerType = item.type === 'scene' ? 'scene' : 'shader';
        const titleEl = document.createElement('div');
        titleEl.className = 'gc-title';
        titleEl.textContent = item.title;
        card.appendChild(titleEl);
        const folder = item.folder || (item.type === 'scene' ? 'scenes' : 'shaders');
        card.addEventListener('click', async () => {
          const layerId = item.type === 'scene' ? 'scene' : 'shader';
          const layer = getLayer(layerId);

          // Toggle off if this shader is already active and visible
          if (layer && layer.visible && layer.manifestEntry && layer.manifestEntry.file === item.file) {
            layer.visible = false;
            updateLayerCardUI(layerId);
            syncToggleSection(layerId, false);
            updateGalleryActiveStates();
            return;
          }

          // Toggle back on if same shader is loaded but hidden
          if (layer && !layer.visible && layer.manifestEntry && layer.manifestEntry.file === item.file) {
            layer.visible = true;
            updateLayerCardUI(layerId);
            syncToggleSection(layerId, true);
            updateGalleryActiveStates();
            return;
          }

          // Deactivate fluid if switching to a regular shader
          if (layer && layer._fluidActive) deactivateFluid(layerId);
          if (layer) layer.manifestEntry = item;
          if (item.type === 'scene') {
            await loadScene(folder, item.file);
          } else {
            await loadShaderToLayer(layerId, folder, item.file);
          }
          updateGalleryActiveStates();
          // Switch back to Canvas tab
          sidebarTabs.forEach(t => t.classList.remove('active'));
          if (sidebarTabs[0]) sidebarTabs[0].classList.add('active');
          Object.values(tabContentMap).forEach(c => { if (c) c.classList.remove('active'); });
          if (canvasTabContent) canvasTabContent.classList.add('active');

          // Auto-open the shader card and expand the right toggle section
          const shaderCard = document.querySelector('.layer-card[data-layer="shader"]');
          if (shaderCard) {
            if (!shaderCard.classList.contains('open')) shaderCard.classList.add('open');
            shaderCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            // For text/3D, expand their toggle section
            const toggleSection = shaderCard.querySelector('.layer-toggle-section[data-type="' + layerId + '"]');
            if (toggleSection && !toggleSection.classList.contains('active')) {
              toggleSection.classList.add('active');
            }
          }
        });
        grid.appendChild(card);
      });
    }
  }

  // Mark gallery cards that match currently active layers
  function updateGalleryActiveStates() {
    const activeFiles = new Set();
    for (const layer of layers) {
      if (layer.visible && layer.manifestEntry) activeFiles.add(layer.manifestEntry.file);
    }
    document.querySelectorAll('.gallery-card[data-file]').forEach(card => {
      card.classList.toggle('active', activeFiles.has(card.dataset.file));
    });
  }

  // Gallery search
  document.getElementById('gallery-search').addEventListener('input', (e) => {
    populateGallery(e.target.value);
    updateGalleryActiveStates();
  });

  // Export tab tiles — reuse existing exportAction
  document.getElementById('export-tab-content').addEventListener('click', (e) => {
    const tile = e.target.closest('[data-action]');
    if (!tile) return;
    exportAction(tile.dataset.action);
  });

  // Background source select
  const bgSelect = document.getElementById('canvas-bg-select');
  const bgColorRow = document.getElementById('bg-color-row');
  const bgShaderRow = document.getElementById('bg-shader-row');
  const bgColorPicker = document.getElementById('bg-color-picker');
  const bgShaderSelect = document.getElementById('bg-shader-select');
  const bgImageInput = document.getElementById('bg-image-input');
  const bgVideoInput = document.getElementById('bg-video-input');

  function createBgTexture() {
    const gl = isfRenderer.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0,0,0,255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  function cleanupBgMedia() {
    // Stop NDI receive if it was used as background
    if (canvasBg._isNdiBg) {
      if (_ndiWs && _ndiWs.readyState === WebSocket.OPEN) {
        ndiRequest(_ndiWs, 'ndi_receive_stop', {}).catch(() => {});
      }
      ndiReceiveEntry = null;
      ndiReceiveCanvas = null;
      ndiReceiveCtx = null;
      canvasBg._isNdiBg = false;
    }
    if (canvasBg.videoEl) {
      if (canvasBg.videoEl.pause) canvasBg.videoEl.pause();
      if (canvasBg.videoEl.srcObject) {
        canvasBg.videoEl.srcObject.getTracks().forEach(t => t.stop());
      }
      if (canvasBg.videoEl.remove) canvasBg.videoEl.remove();
      canvasBg.videoEl = null;
    }
    if (canvasBg.shaderLayer) {
      canvasBg.shaderLayer = null;
      canvasBg.shaderFBO = null;
    }
  }

  // Populate bg shader select from manifest
  isfShaders.forEach(item => {
    const opt = document.createElement('option');
    opt.value = JSON.stringify({ folder: item.folder || 'shaders', file: item.file });
    opt.textContent = item.title;
    bgShaderSelect.appendChild(opt);
  });

  bgSelect.addEventListener('change', async () => {
    const val = bgSelect.value;
    if (bgShaderSelect) bgShaderSelect.style.display = 'none';
    if (bgColorRow) bgColorRow.style.display = 'none';
    if (bgShaderRow) bgShaderRow.style.display = 'none';
    if (val !== 'image' && val !== 'video') cleanupBgMedia();

    switch (val) {
      case 'none':
        canvasBg.mode = 'none';
        break;
      case 'transparent':
        canvasBg.mode = 'transparent';
        break;
      case 'color':
        canvasBg.mode = 'color';
        // Parse current picker value
        const hex = bgColorPicker.value;
        canvasBg.color = [
          parseInt(hex.slice(1,3), 16) / 255,
          parseInt(hex.slice(3,5), 16) / 255,
          parseInt(hex.slice(5,7), 16) / 255
        ];
        break;
      case 'image':
        bgImageInput.click();
        break;
      case 'video':
        bgVideoInput.click();
        break;
      case 'shader':
        canvasBg.mode = 'shader';
        if (bgShaderSelect) bgShaderSelect.style.display = '';
        if (bgShaderRow) bgShaderRow.style.display = '';
        // Load currently selected shader if any
        if (bgShaderSelect.value) {
          await loadBgShader(bgShaderSelect.value);
        }
        break;
      case 'webcam':
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
          const video = document.createElement('video');
          video.muted = true;
          video.playsInline = true;
          video.style.cssText = 'position:fixed;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none';
          document.body.appendChild(video);
          video.srcObject = stream;
          await new Promise((res, rej) => { video.onloadeddata = res; video.onerror = rej; });
          await video.play();
          canvasBg.videoEl = video;
          canvasBg.aspect = video.videoWidth / video.videoHeight;
          if (!canvasBg.texture) canvasBg.texture = createBgTexture();
          const gl = isfRenderer.gl;
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          gl.bindTexture(gl.TEXTURE_2D, canvasBg.texture);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          canvasBg.mode = 'webcam';
        } catch (e) {
          console.warn('Webcam failed:', e);
          bgSelect.value = 'none';
          canvasBg.mode = 'none';
        }
        break;
      case 'ndi':
        // Open NDI source picker, then use selected source as background
        if (!_ndiWs || _ndiWs.readyState !== WebSocket.OPEN) {
          console.warn('NDI: WebSocket not connected');
          bgSelect.value = 'none';
          canvasBg.mode = 'none';
          break;
        }
        canvasBg._ndiBgPending = true;
        ndiPicker.classList.add('visible');
        // Override the picker click to route to background instead of media list
        const origHandler = ndiPicker._bgOverride;
        ndiPicker._bgOverride = async (sourceName) => {
          ndiPicker._bgOverride = null;
          canvasBg._ndiBgPending = false;
          try {
            // Start NDI receive
            await ndiRequest(_ndiWs, 'ndi_receive_start', { sourceName });
            // Set up canvas for frame reception
            ndiReceiveCanvas = document.createElement('canvas');
            ndiReceiveCanvas.width = 1920;
            ndiReceiveCanvas.height = 1080;
            ndiReceiveCtx = ndiReceiveCanvas.getContext('2d');
            ndiReceiveCtx.fillStyle = '#000';
            ndiReceiveCtx.fillRect(0, 0, 1920, 1080);
            // Create bg texture
            if (!canvasBg.texture) canvasBg.texture = createBgTexture();
            canvasBg.videoEl = ndiReceiveCanvas; // treat canvas as "video" source
            canvasBg._isNdiBg = true;
            canvasBg.mode = 'ndi';
            // Create a synthetic ndiReceiveEntry so handleNdiVideoFrame updates the canvas
            const id = ++mediaIdCounter;
            ndiReceiveEntry = {
              id,
              name: 'NDI BG: ' + sourceName,
              type: 'video',
              element: ndiReceiveCanvas,
              glTexture: canvasBg.texture,
              threeTexture: null,
              threeModel: null,
              _isNdi: true,
              _isBgOnly: true,
            };
          } catch (e) {
            console.warn('NDI background failed:', e);
            bgSelect.value = 'none';
            canvasBg.mode = 'none';
          }
        };
        break;
    }
  });

  bgColorPicker.addEventListener('input', () => {
    const hex = bgColorPicker.value;
    canvasBg.color = [
      parseInt(hex.slice(1,3), 16) / 255,
      parseInt(hex.slice(3,5), 16) / 255,
      parseInt(hex.slice(5,7), 16) / 255
    ];
  });

  // Voice decay controls (decay auto-enables with mic)
  const voiceDecaySlider = document.getElementById('voice-decay-slider');
  const voiceDecayVal = document.getElementById('voice-decay-val');
  voiceDecaySlider.addEventListener('input', () => {
    _voiceDecaySeconds = parseFloat(voiceDecaySlider.value);
    voiceDecayVal.textContent = _voiceDecaySeconds.toFixed(2) + 's';
  });

  // Prominent MSG input — syncs with the text layer's msg input
  const textMsgInput = document.getElementById('text-msg-input');
  textMsgInput.addEventListener('input', () => {
    const textLayer = getLayer('text');
    if (!textLayer) return;
    const textInputs = (textLayer.inputs || []).filter(inp => inp.TYPE === 'text');
    if (textInputs.length === 0) return;
    const inp = textInputs[0];
    const maxLen = inp.MAX_LENGTH || 12;
    const str = textMsgInput.value.toUpperCase();
    function charToCode(ch) {
      if (!ch || ch === ' ') return 26;
      const code = ch.toUpperCase().charCodeAt(0);
      if (code >= 65 && code <= 90) return code - 65;
      if (code >= 48 && code <= 57) return code - 48 + 27;
      return 26;
    }
    for (let i = 0; i < maxLen; i++) {
      textLayer.inputValues[inp.NAME + '_' + i] = charToCode(str[i]);
    }
    textLayer.inputValues[inp.NAME + '_len'] = str.replace(/\s+$/, '').length;
    // Sync the params panel text field too
    const paramsField = document.querySelector('.layer-params[data-layer="text"] input[type="text"]');
    if (paramsField) paramsField.value = str;
  });

  // Text layer quick media buttons (Image / Video / NDI for dispersion effects)
  const textImageInput = document.getElementById('text-image-input');
  const textVideoInput = document.getElementById('text-video-input');
  if (textImageInput) {
    document.getElementById('text-add-image').addEventListener('click', () => textImageInput.click());
    textImageInput.addEventListener('change', async (e) => {
      for (const file of e.target.files) await addMediaFromFile(file);
      textImageInput.value = '';
      autoBindTextures('text');
    });
  }
  if (textVideoInput) {
    document.getElementById('text-add-video').addEventListener('click', () => textVideoInput.click());
    textVideoInput.addEventListener('change', async (e) => {
      for (const file of e.target.files) await addMediaFromFile(file);
      textVideoInput.value = '';
      autoBindTextures('text');
    });
  }
  const textAddNdi = document.getElementById('text-add-ndi');
  if (textAddNdi) {
    textAddNdi.addEventListener('click', () => {
      if (!_ndiWs || _ndiWs.readyState !== WebSocket.OPEN) {
        console.warn('NDI: WebSocket not connected');
        return;
      }
      const picker = document.getElementById('ndi-source-picker');
      if (picker) {
        picker.classList.add('visible');
        refreshNdiSources(_ndiWs);
      }
    });
  }

  bgImageInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) { bgSelect.value = 'none'; canvasBg.mode = 'none'; return; }
    cleanupBgMedia();
    const img = new Image();
    img.onload = () => {
      canvasBg.aspect = img.naturalWidth / img.naturalHeight;
      if (!canvasBg.texture) canvasBg.texture = createBgTexture();
      const gl = isfRenderer.gl;
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.bindTexture(gl.TEXTURE_2D, canvasBg.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      canvasBg.mode = 'image';
      canvasBg.imageEl = img; // keep ref for context restore
    };
    img.src = URL.createObjectURL(file);
    bgImageInput.value = '';
  });

  bgVideoInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) { bgSelect.value = 'none'; canvasBg.mode = 'none'; return; }
    cleanupBgMedia();
    const video = document.createElement('video');
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.style.cssText = 'position:fixed;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none';
    document.body.appendChild(video);
    video.src = URL.createObjectURL(file);
    video.onloadeddata = async () => {
      await video.play();
      canvasBg.videoEl = video;
      canvasBg.aspect = video.videoWidth / video.videoHeight;
      if (!canvasBg.texture) canvasBg.texture = createBgTexture();
      const gl = isfRenderer.gl;
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.bindTexture(gl.TEXTURE_2D, canvasBg.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      canvasBg.mode = 'video';
    };
    bgVideoInput.value = '';
  });

  async function loadBgShader(jsonVal) {
    try {
      const { folder, file } = JSON.parse(jsonVal);
      const r = await fetch((folder || 'shaders') + '/' + file);
      const src = await r.text();
      const { frag, parsed } = buildFragmentShader(src);

      // Create pseudo-layer with its own FBO
      if (!canvasBg.shaderFBO) {
        canvasBg.shaderFBO = isfRenderer.createFBO(_rw(), _rh());
      }
      const pseudoLayer = {
        id: '_bg', type: 'shader', visible: true, opacity: 1.0, blendMode: 'normal',
        program: null, uniformLocs: {}, fbo: canvasBg.shaderFBO, textures: {},
        inputs: parsed.inputs || [], inputValues: {}, transparentBg: false
      };
      pseudoLayer._isfSource = src; // store for context restore
      const result = isfRenderer.compileForLayer(pseudoLayer, VERT_SHADER, frag);
      if (result.ok) {
        canvasBg.shaderLayer = pseudoLayer;
        canvasBg.texture = canvasBg.shaderFBO.texture;
        canvasBg.mode = 'shader';
      }
    } catch (e) {
      console.warn('Failed to load bg shader:', e);
    }
  }

  bgShaderSelect.addEventListener('change', async () => {
    if (bgShaderSelect.value) {
      await loadBgShader(bgShaderSelect.value);
    }
  });

  // --- INPUTS Panel (Media) ---
  const mediaListContainer = document.getElementById('media-list');

  // File inputs for each type
  const imageFileInput = document.getElementById('image-file-input');
  const videoFileInput = document.getElementById('video-file-input');
  const modelFileInput = document.getElementById('model-file-input');
  const soundFileInput = document.getElementById('sound-file-input');
  const vectorFileInput = document.getElementById('vector-file-input');

  function wireFileInput(input) {
    input.addEventListener('change', async (e) => {
      for (const file of e.target.files) {
        await addMediaFromFile(file);
      }
      input.value = '';
    });
  }
  wireFileInput(imageFileInput);
  wireFileInput(videoFileInput);
  wireFileInput(modelFileInput);
  wireFileInput(soundFileInput);
  wireFileInput(vectorFileInput);

  // Tile click handlers
  document.getElementById('tile-image').addEventListener('click', () => imageFileInput.click());
  document.getElementById('tile-video').addEventListener('click', () => videoFileInput.click());
  document.getElementById('tile-model').addEventListener('click', () => modelFileInput.click());
  document.getElementById('tile-sound').addEventListener('click', () => soundFileInput.click());

  // Input dropdown → trigger hidden tile buttons
  document.getElementById('input-add-select').addEventListener('change', function() {
    const val = this.value;
    this.selectedIndex = 0; // Reset to "+ Add..."
    const tileMap = { image: 'tile-image', video: 'tile-video', model: 'tile-model', sound: 'tile-sound', mic: 'tile-mic', webcam: 'tile-webcam', ndi: 'tile-ndi', code: 'tile-code' };
    const tile = document.getElementById(tileMap[val]);
    if (tile) tile.click();
  });

  // Asset add button + dropdown menu
  const assetAddBtn = document.getElementById('asset-add-btn');
  const assetAddMenu = document.getElementById('asset-add-menu');
  if (assetAddBtn && assetAddMenu) {
    assetAddBtn.addEventListener('click', () => {
      assetAddBtn.classList.toggle('open');
      assetAddMenu.classList.toggle('open');
    });
    assetAddMenu.querySelectorAll('.asset-add-option').forEach(opt => {
      opt.addEventListener('click', () => {
        const type = opt.dataset.type;
        assetAddBtn.classList.remove('open');
        assetAddMenu.classList.remove('open');
        const tileMap = { image: 'tile-image', video: 'tile-video', model: 'tile-model', sound: 'tile-sound', mic: 'tile-mic', webcam: 'tile-webcam', ndi: 'tile-ndi', code: 'tile-code' };
        const tile = document.getElementById(tileMap[type]);
        if (tile) tile.click();
      });
    });
    // Close menu on outside click
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.asset-add-wrap')) {
        assetAddBtn.classList.remove('open');
        assetAddMenu.classList.remove('open');
      }
    });
  }

  document.getElementById('tile-webcam').addEventListener('click', async () => {
    try { await addMediaFromWebcam(); }
    catch (e) { console.warn('Webcam access denied:', e.message); }
  });

  document.getElementById('tile-mic').addEventListener('click', async () => {
    try { await addMicAudio(); }
    catch (e) { console.warn('Mic access denied:', e.message); }
  });

  // Code import tile — load .fs/.glsl/.frag shader files
  const codeFileInput = document.getElementById('code-file-input');
  document.getElementById('tile-code').addEventListener('click', () => codeFileInput.click());
  codeFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    codeFileInput.value = '';
    try {
      const source = await file.text();
      // Detect target layer from ISF header categories
      let targetLayer = 'shader'; // default to shader layer
      const headerMatch = source.match(/\/\*\s*\{([\s\S]*?)\}\s*\*\//);
      if (headerMatch) {
        try {
          const meta = JSON.parse('{' + headerMatch[1] + '}');
          const cats = (meta.CATEGORIES || []).map(c => c.toLowerCase());
          if (cats.includes('text')) targetLayer = 'text';
        } catch (parseErr) { /* non-JSON header, use default */ }
      }
      const result = compileToLayer(targetLayer, source);
      if (focusedLayerId === targetLayer) editor.setValue(source);
      if (!result.ok) {
        errorBar.textContent = result.errors;
        errorBar.classList.add('show');
      } else {
        errorBar.textContent = '';
        errorBar.classList.remove('show');
        // Auto-show the target layer
        const layer = getLayer(targetLayer);
        if (layer && !layer.visible) {
          layer.visible = true;
          const visBtn = document.querySelector(`.layer-card[data-layer="${targetLayer}"] .layer-vis`);
          if (visBtn) visBtn.classList.add('active');
        }
        // Update preset dropdown to show filename
        const sel = document.querySelector(`.layer-shader-select[data-layer="${targetLayer}"]`);
        if (sel) {
          let customOpt = sel.querySelector('option[value="custom"]');
          if (!customOpt) {
            customOpt = document.createElement('option');
            customOpt.value = 'custom';
            sel.appendChild(customOpt);
          }
          customOpt.textContent = file.name;
          sel.value = 'custom';
        }
      }
    } catch (err) {
      errorBar.textContent = 'Failed to load: ' + file.name;
      errorBar.classList.add('show');
    }
  });

  // MediaPipe tile removed from UI — body tracking is controlled via the layer panel toggle

  // NDI Source Picker
  const ndiPicker = document.getElementById('ndi-source-picker');
  const ndiPickerBody = document.getElementById('ndi-picker-body');

  document.getElementById('ndi-picker-close').addEventListener('click', () => {
    ndiPicker.classList.remove('visible');
    if (ndiPicker._bgOverride) {
      ndiPicker._bgOverride = null;
      bgSelect.value = 'none';
      canvasBg.mode = 'none';
    }
  });

  ndiPicker.addEventListener('click', (e) => {
    if (e.target === ndiPicker) {
      ndiPicker.classList.remove('visible');
      if (ndiPicker._bgOverride) {
        ndiPicker._bgOverride = null;
        bgSelect.value = 'none';
        canvasBg.mode = 'none';
      }
    }
  });

  async function refreshNdiSources(ws) {
    ndiPickerBody.innerHTML = '<div style="padding:16px;color:var(--text-dim);font-size:11px;text-align:center">Searching...</div>';
    try {
      const resp = await ndiRequest(ws, 'ndi_find_sources');
      const sources = resp.sources || [];
      ndiPickerBody.innerHTML = '';
      if (sources.length === 0) {
        ndiPickerBody.innerHTML = '<div style="padding:16px;color:var(--text-dim);font-size:11px;text-align:center">No NDI sources found.<br>Make sure NDI sources are running on your network.</div>';
        return;
      }
      sources.forEach(src => {
        const item = document.createElement('div');
        item.className = 'ndi-source-item';
        item.innerHTML = `<span class="ndi-dot"></span><span class="ndi-src-name">${src.name}</span><span class="ndi-src-addr">${src.urlAddress || ''}</span>`;
        item.addEventListener('click', async () => {
          ndiPicker.classList.remove('visible');
          // If background select triggered the picker, route there instead
          if (ndiPicker._bgOverride) {
            try { await ndiPicker._bgOverride(src.name); } catch (e) { console.warn('NDI bg failed:', e); }
            return;
          }
          try {
            await addNdiReceiveEntry(src.name, ws);
          } catch (e) {
            console.warn('NDI receive failed:', e);
          }
        });
        ndiPickerBody.appendChild(item);
      });
    } catch (e) {
      ndiPickerBody.innerHTML = `<div style="padding:16px;color:var(--accent);font-size:11px;text-align:center">Error: ${e.message}</div>`;
    }
  }

  async function addNdiReceiveEntry(sourceName, ws) {
    if (ndiReceiveEntry) {
      removeMedia(ndiReceiveEntry.id);
      ndiReceiveEntry = null;
    }

    await ndiRequest(ws, 'ndi_receive_start', { sourceName });

    ndiReceiveCanvas = document.createElement('canvas');
    ndiReceiveCanvas.width = 1920;
    ndiReceiveCanvas.height = 1080;
    ndiReceiveCtx = ndiReceiveCanvas.getContext('2d');
    ndiReceiveCtx.fillStyle = '#000';
    ndiReceiveCtx.fillRect(0, 0, 1920, 1080);

    const id = ++mediaIdCounter;
    const entry = {
      id,
      name: 'NDI: ' + sourceName,
      type: 'video',
      element: ndiReceiveCanvas,
      glTexture: createGLTexture(isfRenderer.gl, ndiReceiveCanvas),
      threeTexture: new THREE.CanvasTexture(ndiReceiveCanvas),
      threeModel: null,
      _isNdi: true,
    };
    entry.threeTexture.needsUpdate = true;
    ndiReceiveEntry = entry;

    mediaInputs.push(entry);
    renderMediaList();
    autoBindTextures();
    window.dispatchEvent(new Event('ndi-source-added'));
    return entry;
  }

  // NDI Send (triggered from Export dropdown, NDI indicator, or sidebar Send btn)
  function updateNdiUI() {
    const sendBtn = document.getElementById('ndi-send-btn');
    const statusDot = document.getElementById('ndi-status');
    if (sendBtn) sendBtn.textContent = ndiSendingActive ? 'Stop' : 'Send';
    if (statusDot) statusDot.classList.toggle('active', ndiSendingActive);
  }

  async function toggleNdiSend() {
    if (!_ndiWs || _ndiWs.readyState !== WebSocket.OPEN) {
      console.warn('NDI: WebSocket not connected');
      return;
    }
    try {
      if (ndiSendingActive) {
        stopNdiSend();
        updateNdiUI();
        await ndiRequest(_ndiWs, 'ndi_send_stop').catch(() => {});
      } else {
        await ndiRequest(_ndiWs, 'ndi_send_start', { name: 'ShaderClaw', width: glCanvas.width, height: glCanvas.height });
        startNdiSend(_ndiWs, glCanvas);
        updateNdiUI();
      }
    } catch (e) {
      console.warn('NDI toggle error:', e.message);
      updateNdiUI();
    }
  }

  // NDI indicator click → toggle send
  document.getElementById('ndi-indicator')?.addEventListener('click', () => {
    toggleNdiSend();
  });
  // NDI on by default — set indicator to active on init
  if (ndiSendingActive) {
    document.getElementById('ndi-indicator')?.classList.add('active');
    updateNdiUI();
  }

  // NDI sidebar Send button → toggle send
  document.getElementById('ndi-send-btn')?.addEventListener('click', () => {
    toggleNdiSend();
  });

  // NDI health monitor — checks every 3s, restarts send quickly if it died
  let _ndiLastFrameCount = 0;
  let _ndiStallChecks = 0;
  setInterval(async () => {
    // Only monitor if we think NDI should be active
    if (!ndiSendingActive && !_ndiAutoStartOnConnect) return;
    try {
      const resp = await fetch('/api/ndi/status');
      const status = await resp.json();
      const wsOk = _ndiWs && _ndiWs.readyState === WebSocket.OPEN;

      // Case 1: WS connected but server not receiving frames (stalled capture)
      if (wsOk && status.browserConnected) {
        if (status.frameCount === _ndiLastFrameCount && ndiSendingActive) {
          _ndiStallChecks++;
          if (_ndiStallChecks >= 4) {
            // Frames stalled for 12s+ — restart the capture pipeline silently
            pauseNdiSend();
            ndiSendingActive = false;
            try {
              await ndiRequest(_ndiWs, 'ndi_send_start', { name: 'ShaderClaw', width: glCanvas.width, height: glCanvas.height });
              startNdiSend(_ndiWs, glCanvas);
              updateNdiUI();
              console.log('NDI health: capture restarted');
            } catch (e) {
              console.warn('NDI health: restart failed:', e.message);
            }
            _ndiStallChecks = 0;
          }
        } else {
          _ndiStallChecks = 0;
        }
        _ndiLastFrameCount = status.frameCount;
      }

      // Case 2: WS connected but sender not active on server
      if (wsOk && !status.senderActive && (ndiSendingActive || _ndiAutoStartOnConnect)) {
        console.warn('NDI health: sender not active on server, starting...');
        pauseNdiSend();
        ndiSendingActive = false;
        _ndiAutoStartOnConnect = false;
        try {
          await ndiRequest(_ndiWs, 'ndi_send_start', { name: 'ShaderClaw', width: glCanvas.width, height: glCanvas.height });
          startNdiSend(_ndiWs, glCanvas);
          updateNdiUI();
          console.log('NDI health: sender started');
        } catch (e) {
          console.warn('NDI health: start failed:', e.message);
        }
      }
    } catch (e) {
      // Server unreachable — that's fine, WS reconnect handles it
    }
  }, 3000);

  function renderAssetsList() {
    mediaListContainer.innerHTML = '';
    mediaInputs.forEach(media => {
      const row = document.createElement('div');
      row.className = 'asset-row';

      const icon = document.createElement('span');
      icon.className = 'asset-icon';
      icon.textContent = mediaTypeIcon(media.type, media.name);

      const name = document.createElement('span');
      name.className = 'asset-name';
      name.textContent = media.name;

      const controls = document.createElement('span');
      controls.className = 'asset-controls';

      row.appendChild(icon);
      row.appendChild(name);

      // Webcam: H/V flip toggles
      if (media._webcamFlip !== undefined) {
        const flipH = document.createElement('button');
        flipH.className = 'flip-toggle' + (media._webcamFlip ? ' active' : '');
        flipH.textContent = 'H';
        flipH.title = 'Mirror horizontally';
        flipH.addEventListener('click', (e) => {
          e.stopPropagation();
          media._webcamFlip = !media._webcamFlip;
          flipH.classList.toggle('active', media._webcamFlip);
          if (media.threeTexture) {
            media.threeTexture.wrapS = media._webcamFlip ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
            media.threeTexture.repeat.x = media._webcamFlip ? -1 : 1;
            media.threeTexture.offset.x = media._webcamFlip ? 1 : 0;
            media.threeTexture.needsUpdate = true;
          }
          autoBindTextures();
        });
        const flipV = document.createElement('button');
        flipV.className = 'flip-toggle' + (media._webcamFlipV ? ' active' : '');
        flipV.textContent = 'V';
        flipV.title = 'Mirror vertically';
        flipV.addEventListener('click', (e) => {
          e.stopPropagation();
          media._webcamFlipV = !media._webcamFlipV;
          flipV.classList.toggle('active', media._webcamFlipV);
          if (media.threeTexture) {
            media.threeTexture.wrapT = media._webcamFlipV ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
            media.threeTexture.repeat.y = media._webcamFlipV ? -1 : 1;
            media.threeTexture.offset.y = media._webcamFlipV ? 1 : 0;
            media.threeTexture.needsUpdate = true;
          }
          autoBindTextures();
        });
        controls.appendChild(flipH);
        controls.appendChild(flipV);
      }

      // Audio: play/pause toggle + level bar
      if (media.type === 'audio') {
        if (!media._isMicAudio) {
          const toggle = document.createElement('button');
          toggle.className = 'audio-toggle';
          toggle.textContent = (media.element && !media.element.paused) ? '\u23F8' : '\u25B6';
          toggle.title = 'Play/Pause';
          toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            if (media.element) {
              if (media.element.paused) {
                if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
                media.element.play().catch(() => {});
                toggle.textContent = '\u23F8';
              } else {
                media.element.pause();
                toggle.textContent = '\u25B6';
              }
            }
          });
          controls.appendChild(toggle);
        }

        const bar = document.createElement('div');
        bar.className = 'audio-bar';
        const fill = document.createElement('div');
        fill.className = 'audio-bar-fill';
        fill.dataset.audioId = media.id;
        bar.appendChild(fill);
        controls.appendChild(bar);
      }

      // 3D model: show type badge
      if (media.type === 'model') {
        const badge = document.createElement('span');
        badge.style.cssText = 'font-size:9px;color:var(--text-dim);letter-spacing:0.3px';
        badge.textContent = '3D';
        controls.appendChild(badge);
      }

      row.appendChild(controls);

      // Bind button (⚡)
      const bind = document.createElement('button');
      bind.className = 'asset-bind';
      bind.textContent = '\u26A1';
      bind.title = 'Bind to parameter';
      bind.addEventListener('click', (e) => {
        e.stopPropagation();
        // For now, clicking bind scrolls to / highlights the asset's texture binding in the layer params
        // Future: open a mini-picker for asset-level bindings
      });
      row.appendChild(bind);

      const del = document.createElement('button');
      del.className = 'asset-delete';
      del.textContent = '\u00D7';
      del.title = 'Remove';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        removeMedia(media.id);
      });

      row.appendChild(del);
      mediaListContainer.appendChild(row);
    });

    // Refresh all image-input dropdowns so new media (NDI, webcam, etc.) appears
    document.querySelectorAll('.image-input-select').forEach(sel => {
      if (sel._refreshOptions) sel._refreshOptions();
    });
  }
  // Keep backward compat alias
  function renderMediaList() { renderAssetsList(); }

  function autoBindTextures(targetLayerId) {
    const compatibleMedia = mediaInputs.filter(m => m.type === 'image' || m.type === 'video' || m.type === 'svg');

    // Bind textures for each ISF layer (shader + text)
    layers.forEach(layer => {
      if (layer.type === 'scene') return; // scene uses Three.js media, handled below
      if (targetLayerId && layer.id !== targetLayerId) return;
      layer.textures = {};
      const imageInputs = (layer.inputs || []).filter(inp => inp.TYPE === 'image');
      imageInputs.forEach((inp, i) => {
        let selectedId = layer.inputValues[inp.NAME];

        // Layer-to-layer texture piping: use FBO/sceneTexture directly
        if (typeof selectedId === 'string' && selectedId.startsWith('layer:')) {
          const srcId = selectedId.slice(6);
          if (srcId === 'scene' && sceneTexture) {
            layer.textures[inp.NAME] = { glTexture: sceneTexture, isVideo: false, element: null, flipH: false, flipV: false };
          } else {
            const src = layers.find(l => l.id === srcId);
            if (src && src.fbo) {
              layer.textures[inp.NAME] = { glTexture: src.fbo.texture, isVideo: false, element: null, flipH: false, flipV: false };
            }
          }
          return;
        }

        let media = null;
        if (selectedId) media = mediaInputs.find(m => String(m.id) === String(selectedId));
        if (media && media.glTexture) {
          const texEntry = {
            glTexture: media.glTexture,
            isVideo: media.type === 'video',
            element: media.element,
            flipH: !!media._webcamFlip,
            flipV: !!media._webcamFlipV,
            _isNdi: !!media._isNdi,
          };
          layer.textures[inp.NAME] = texEntry;
          // Start async video frame capture for smooth playback
          if (texEntry.isVideo && texEntry.element && !texEntry._isNdi) {
            isfRenderer.startVideoCapture(texEntry);
          }
        } else if (!layer.textures[inp.NAME]) {
          // Bind default 1x1 black texture to prevent unbound sampler errors
          layer.textures[inp.NAME] = {
            glTexture: isfRenderer._defaultTex,
            isVideo: false, element: null, flipH: false, flipV: false,
          };
        }
      });
    });

    // Update SceneRenderer media — include layer FBO outputs as synthetic entries
    // so 3D scenes can use "layer:text" / "layer:shader" texture references
    const sceneMedia = mediaInputs.map(m => ({
      id: m.id, name: m.name, type: m.type,
      threeTexture: m.threeTexture, threeModel: m.threeModel,
    }));
    // Register layer-reference DataTextures (actual pixel copy happens per-frame in compositionLoop)
    const sceneLayerRef = layers.find(l => l.id === 'scene');
    if (sceneLayerRef) {
      const sceneImageInputs = (sceneLayerRef.inputs || []).filter(inp => inp.TYPE === 'image');
      sceneImageInputs.forEach(inp => {
        const selectedId = sceneLayerRef.inputValues[inp.NAME];
        if (typeof selectedId === 'string' && selectedId.startsWith('layer:')) {
          const srcId = selectedId.slice(6);
          const src = layers.find(l => l.id === srcId);
          if (src && src.fbo) {
            const w = src.fbo.width, h = src.fbo.height;
            if (!src._threeLayerTex) {
              src._threeLayerTexData = new Uint8Array(w * h * 4);
              src._threeLayerTex = new THREE.DataTexture(src._threeLayerTexData, w, h, THREE.RGBAFormat);
              src._threeLayerTex.minFilter = THREE.LinearFilter;
              src._threeLayerTex.magFilter = THREE.LinearFilter;
            }
            sceneMedia.push({ id: selectedId, name: srcId + ' layer', type: 'image', threeTexture: src._threeLayerTex, threeModel: null });
          }
        }
      });
    }
    sceneRenderer.media = sceneMedia;
  }

  async function addMediaFromFile(file) {
    const type = detectMediaType(file);
    const id = ++mediaIdCounter;
    const entry = { id, name: file.name, type, element: null, glTexture: null, threeTexture: null, threeModel: null };

    if (type === 'image') {
      const img = new Image();
      const url = URL.createObjectURL(file);
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = url;
      });
      entry.element = img;
      entry.glTexture = createGLTexture(isfRenderer.gl, img);
      const threeTex = new THREE.Texture(img);
      threeTex.needsUpdate = true;
      entry.threeTexture = threeTex;

    } else if (type === 'video') {
      const video = document.createElement('video');
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.preload = 'auto';
      // Keep video in the DOM so Chrome doesn't GC its decode pipeline
      video.style.cssText = 'position:fixed;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none';
      document.body.appendChild(video);
      // Auto-recover from unexpected pauses and stalls
      video.addEventListener('pause', () => {
        if (video.loop && !video.ended) video.play().catch(() => {});
      });
      video.addEventListener('stalled', () => { video.play().catch(() => {}); });
      // Set up listeners before assigning src to avoid race conditions
      const loaded = new Promise((resolve, reject) => {
        video.onloadeddata = () => resolve();
        video.onerror = () => reject(new Error('Video format not supported: ' + file.name));
      });
      video.src = URL.createObjectURL(file);
      video.load();
      await loaded;
      try {
        await video.play();
      } catch (e) {
        console.warn('Video autoplay blocked for', file.name, '— will retry on interaction');
        const retryPlay = () => {
          video.play().catch(() => {});
          document.removeEventListener('click', retryPlay);
        };
        document.addEventListener('click', retryPlay, { once: true });
      }
      entry.element = video;
      entry.glTexture = createGLTexture(isfRenderer.gl, video);
      const threeTex = new THREE.VideoTexture(video);
      threeTex.needsUpdate = true;
      entry.threeTexture = threeTex;

    } else if (type === 'model') {
      await loadDeferredScripts(); // ensure model loaders are ready
      const ext = file.name.split('.').pop().toLowerCase();
      const url = URL.createObjectURL(file);

      if (ext === 'stl') {
        const loader = new THREE.STLLoader();
        const geometry = await new Promise((resolve, reject) => {
          loader.load(url, resolve, undefined, reject);
        });
        geometry.computeVertexNormals();
        const mat = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.4, metalness: 0.1 });
        const mesh = new THREE.Mesh(geometry, mat);
        const group = new THREE.Group();
        group.add(mesh);
        entry.threeModel = group;

      } else if (ext === 'obj') {
        const loader = new THREE.OBJLoader();
        const group = await new Promise((resolve, reject) => {
          loader.load(url, resolve, undefined, reject);
        });
        entry.threeModel = group;

      } else if (ext === 'fbx') {
        if (window.fflate) THREE.fflate = window.fflate;
        const loader = new THREE.FBXLoader();
        const group = await new Promise((resolve, reject) => {
          loader.load(url, resolve, undefined, reject);
        });
        entry.threeModel = group;

      } else {
        // GLTF/GLB
        if (typeof THREE.GLTFLoader === 'undefined') {
          console.warn('GLTFLoader not available');
          return null;
        }
        const loader = new THREE.GLTFLoader();
        const gltf = await new Promise((resolve, reject) => {
          loader.load(url, resolve, undefined, reject);
        });
        entry.threeModel = gltf.scene;
      }

    } else if (type === 'audio') {
      // Audio-reactive sound
      if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        audioAnalyser = audioCtx.createAnalyser();
        audioAnalyser.fftSize = 256;
        audioAnalyser.smoothingTimeConstant = 0.8;
        audioAnalyser.connect(audioCtx.destination);
        audioDataArray = new Uint8Array(audioAnalyser.frequencyBinCount); // 128 bins
      }

      // Disconnect previous audio source (file or mic)
      if (_micAudioEntry) {
        // Stop mic stream, null mic vars, remove mic entry, reconnect analyser
        if (_micAudioSourceNode) { try { _micAudioSourceNode.disconnect(); } catch(e) {} }
        if (_micAudioStream) { _micAudioStream.getTracks().forEach(t => t.stop()); }
        const micIdx = mediaInputs.findIndex(m => m.id === _micAudioEntry.id);
        if (micIdx !== -1) mediaInputs.splice(micIdx, 1);
        _micAudioStream = null;
        _micAudioSourceNode = null;
        _micAudioEntry = null;
        try { audioAnalyser.connect(audioCtx.destination); } catch(e) {}
        const micBtn = document.getElementById('tile-mic');
        if (micBtn) micBtn.classList.remove('active');
        const headerBtn = document.getElementById('canvas-mic-btn');
        if (headerBtn) headerBtn.classList.remove('active');
        document.getElementById('audio-signal')?.classList.remove('active');
        document.getElementById('audio-level-indicator')?.classList.remove('active');
        // Also stop speech recognition started with mic audio
        if (_micCaptionEntry) {
          const capIdx = mediaInputs.findIndex(m => m.id === _micCaptionEntry.id);
          if (capIdx !== -1) mediaInputs.splice(capIdx, 1);
          if (_micRecognition) { try { _micRecognition.stop(); } catch(e) {} _micRecognition = null; }
          _micCaptionEntry = null;
          _micCaptionText = '';
        }
      } else if (activeAudioEntry && activeAudioEntry._sourceNode) {
        try { activeAudioEntry._sourceNode.disconnect(); } catch(e) {}
        if (activeAudioEntry.element) activeAudioEntry.element.pause();
      }

      const audio = document.createElement('audio');
      audio.loop = true;
      audio.preload = 'auto';
      audio.crossOrigin = 'anonymous';
      audio.style.cssText = 'position:fixed;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none';
      document.body.appendChild(audio);

      const loaded = new Promise((resolve, reject) => {
        audio.oncanplaythrough = () => resolve();
        audio.onerror = () => reject(new Error('Audio format not supported: ' + file.name));
      });
      audio.src = URL.createObjectURL(file);
      audio.load();
      await loaded;

      if (audioCtx.state === 'suspended') await audioCtx.resume();
      const sourceNode = audioCtx.createMediaElementSource(audio);
      sourceNode.connect(audioAnalyser);

      entry.element = audio;
      entry._sourceNode = sourceNode;
      activeAudioEntry = entry;

      // Show signal indicators for file audio
      document.getElementById('audio-signal')?.classList.add('active');
      const sigLabel = document.getElementById('audio-signal-label');
      if (sigLabel) sigLabel.textContent = 'AUDIO';
      document.getElementById('audio-level-indicator')?.classList.add('active');

      try { await audio.play(); }
      catch (e) {
        console.warn('Audio autoplay blocked — retry on interaction');
        const retryPlay = () => { audio.play().catch(() => {}); };
        document.addEventListener('click', retryPlay, { once: true });
      }

    } else if (type === 'svg') {
      // SVG — render to canvas texture
      const text = await file.text();
      const blob = new Blob([text], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = 2048;
      canvas.height = 2048;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, 2048, 2048);
      URL.revokeObjectURL(url);

      entry.element = canvas;
      entry.glTexture = createGLTexture(isfRenderer.gl, canvas);
      const threeTex = new THREE.CanvasTexture(canvas);
      threeTex.needsUpdate = true;
      entry.threeTexture = threeTex;
    }

    mediaInputs.push(entry);
    renderMediaList();
    autoBindTextures();

    // Make 3D layer visible when a model is added; set Custom shape if scene supports it
    if (type === 'model') {
      const sceneLayer = getLayer('scene');
      if (sceneLayer.inputs && sceneLayer.inputs.some(inp => inp.NAME === 'shape')) {
        sceneLayer.inputValues['shape'] = 6;
        sceneRenderer.inputValues = sceneLayer.inputValues;
        window.shaderClaw.updateControlUI('shape', 6, 'scene');
      }
      if (!sceneLayer.visible) {
        sceneLayer.visible = true;
        updateLayerCardUI('scene');
        syncToggleSection('scene', true);
      }
    }

    return entry;
  }

  async function addMediaFromWebcam() {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    const id = ++mediaIdCounter;
    const entry = { id, name: 'Webcam', type: 'video', element: null, glTexture: null, threeTexture: null, threeModel: null, stream };

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.style.cssText = 'position:fixed;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none';
    document.body.appendChild(video);
    video.addEventListener('pause', () => { video.play().catch(() => {}); });
    video.addEventListener('stalled', () => { video.play().catch(() => {}); });

    const loaded = new Promise((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error('Webcam video failed'));
    });
    video.srcObject = stream;
    await loaded;
    await video.play();

    entry.element = video;
    entry.glTexture = createGLTexture(isfRenderer.gl, video);
    const threeTex = new THREE.VideoTexture(video);
    // Flip vertically only (GL Y-axis convention); no horizontal mirror
    threeTex.wrapS = THREE.ClampToEdgeWrapping;
    threeTex.wrapT = THREE.RepeatWrapping;
    threeTex.repeat.x = 1;
    threeTex.repeat.y = -1;
    threeTex.offset.x = 0;
    threeTex.offset.y = 1;
    threeTex.needsUpdate = true;
    entry.threeTexture = threeTex;
    entry._webcamFlip = false; // No horizontal mirror by default
    entry._webcamFlipV = true; // Vertical flip for GL coordinate system

    mediaInputs.push(entry);
    renderMediaList();
    autoBindTextures();
    return entry;
  }

  // Populate audio input device dropdown
  async function refreshAudioDevices() {
    const sel = document.getElementById('audio-device-select');
    if (!sel) return;
    const prev = sel.value;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter(d => d.kind === 'audioinput');
    sel.innerHTML = '<option value="">Default</option>';
    audioInputs.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || ('Mic ' + (sel.options.length));
      sel.appendChild(opt);
    });
    // Restore previous selection if still available
    if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
  }

  // Re-enumerate when devices change (plug/unplug)
  navigator.mediaDevices?.addEventListener('devicechange', refreshAudioDevices);

  // Switch mic to selected device while active
  document.getElementById('audio-device-select')?.addEventListener('change', async () => {
    if (_micAudioEntry) {
      // Re-open mic with new device
      removeMedia(_micAudioEntry.id);
      await addMicAudio();
    }
  });

  async function addMicAudio() {
    // Toggle off: if mic already active, remove it
    if (_micAudioEntry) {
      removeMedia(_micAudioEntry.id);
      return;
    }

    // Init audio context & analyser if needed
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      audioAnalyser = audioCtx.createAnalyser();
      audioAnalyser.fftSize = 256;
      audioAnalyser.smoothingTimeConstant = 0.8;
      audioAnalyser.connect(audioCtx.destination);
      audioDataArray = new Uint8Array(audioAnalyser.frequencyBinCount);
    }

    // Disconnect previous file audio source if any
    if (activeAudioEntry && activeAudioEntry._sourceNode) {
      try { activeAudioEntry._sourceNode.disconnect(); } catch(e) {}
      if (activeAudioEntry.element) activeAudioEntry.element.pause();
    }

    // Disconnect analyser from destination to prevent speaker feedback
    try { audioAnalyser.disconnect(audioCtx.destination); } catch(e) {}

    if (audioCtx.state === 'suspended') await audioCtx.resume();

    // Use selected device or default
    const selectedDevice = document.getElementById('audio-device-select')?.value;
    const audioConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    };
    if (selectedDevice) audioConstraints.deviceId = { exact: selectedDevice };

    // Raw audio — disable all processing for clean FFT signal (like Synesthesia)
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints
    });

    // Refresh device list (labels become available after permission grant)
    refreshAudioDevices();
    const sourceNode = audioCtx.createMediaStreamSource(stream);
    sourceNode.connect(audioAnalyser); // analysis only — NOT connected to destination

    const entry = {
      id: 'mic-audio-' + Date.now(),
      name: 'Microphone',
      type: 'audio',
      element: null,
      glTexture: null,
      threeTexture: null,
      _isMicAudio: true,
      _sourceNode: sourceNode,
      stream: stream
    };

    _micAudioStream = stream;
    _micAudioSourceNode = sourceNode;
    _micAudioEntry = entry;
    activeAudioEntry = entry;

    mediaInputs.push(entry);
    renderMediaList();
    autoBindTextures();

    // Also start speech recognition for text shader transcription
    if (!_micCaptionEntry || !mediaInputs.includes(_micCaptionEntry)) {
      startMicCaptions();
    }

    const micBtn = document.getElementById('tile-mic');
    if (micBtn) micBtn.classList.add('active');
    const headerBtn = document.getElementById('canvas-mic-btn');
    if (headerBtn) headerBtn.classList.add('active');
    const panelToggle = document.getElementById('voice-mic-toggle');
    if (panelToggle) panelToggle.classList.add('active');
    document.getElementById('audio-signal')?.classList.add('active');
    const sigLabel = document.getElementById('audio-signal-label');
    if (sigLabel) sigLabel.textContent = 'MIC';
    document.getElementById('audio-level-indicator')?.classList.add('active');
    // Auto-open Voice card so signal indicator is visible
    const voiceCard = document.querySelector('[data-layer="voice"]');
    if (voiceCard) voiceCard.classList.add('open');
  }

  async function addMediaFromDataUrl(name, dataUrl) {
    const resp = await fetch(dataUrl);
    const blob = await resp.blob();
    const file = new File([blob], name, { type: blob.type });
    return addMediaFromFile(file);
  }

  // 3D Text — generates TextGeometry mesh from user string
  async function addText3D(text) {
    await loadDeferredScripts(); // ensure FontLoader + TextGeometry are ready
    const fontLoader = new THREE.FontLoader();
    const fontUrl = 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/fonts/helvetiker_regular.typeface.json';
    const font = await new Promise((resolve, reject) => {
      fontLoader.load(fontUrl, resolve, undefined, reject);
    });
    const geometry = new THREE.TextGeometry(text, {
      font: font,
      size: 0.5,
      height: 0.15,
      curveSegments: 12,
      bevelEnabled: true,
      bevelThickness: 0.02,
      bevelSize: 0.01,
      bevelSegments: 3
    });
    geometry.computeBoundingBox();
    const center = geometry.boundingBox.getCenter(new THREE.Vector3());
    geometry.translate(-center.x, -center.y, -center.z);

    const mat = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.3, metalness: 0.15 });
    const mesh = new THREE.Mesh(geometry, mat);
    const group = new THREE.Group();
    group.add(mesh);

    const id = ++mediaIdCounter;
    const entry = { id, name: '"' + text + '"', type: 'model', element: null, glTexture: null, threeTexture: null, threeModel: group };
    mediaInputs.push(entry);
    renderMediaList();
    autoBindTextures();

    const sceneLayer2 = getLayer('scene');
    sceneLayer2.inputValues['shape'] = 6;
    sceneRenderer.inputValues = sceneLayer2.inputValues;
    window.shaderClaw.updateControlUI('shape', 6, 'scene');
    return entry;
  }

  // Variable Font Text — renders text to canvas with animatable weight
  let _varFontEntry = null;
  let _varFontCanvas = null;
  let _varFontCtx = null;
  let _varFontText = '';
  let _varFontWeight = 400;
  let _varFontFamilyIdx = 0;

  function _renderVarFontCanvas() {
    if (!_varFontCtx || !_varFontText) return;
    const c = _varFontCanvas;
    const ctx = _varFontCtx;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.save();
    ctx.translate(0, c.height);
    ctx.scale(1, -1);
    const w = Math.round(_varFontWeight);
    const stack = _fontFamilies[_varFontFamilyIdx] || _fontFamilies[0];
    ctx.font = `${w} ${Math.round(c.height * 0.35)}px ${stack}`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(_varFontText, c.width / 2, c.height / 2);
    ctx.restore();
    // Update textures
    if (_varFontEntry) {
      if (_varFontEntry.glTexture) {
        const gl = isfRenderer.gl;
        gl.bindTexture(gl.TEXTURE_2D, _varFontEntry.glTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
      }
      if (_varFontEntry.threeTexture) {
        _varFontEntry.threeTexture.needsUpdate = true;
      }
    }
  }

  function addVariableFontText(text) {
    _varFontText = text;
    _varFontCanvas = document.createElement('canvas');
    _varFontCanvas.width = 2048;
    _varFontCanvas.height = 512;
    _varFontCtx = _varFontCanvas.getContext('2d');
    _renderVarFontCanvas();

    const id = ++mediaIdCounter;
    const entry = {
      id, name: 'VarFont: ' + text, type: 'image',
      element: _varFontCanvas, glTexture: createGLTexture(isfRenderer.gl, _varFontCanvas),
      threeTexture: new THREE.CanvasTexture(_varFontCanvas), threeModel: null,
      _isVarFont: true
    };
    entry.threeTexture.needsUpdate = true;
    _varFontEntry = entry;

    mediaInputs.push(entry);
    renderMediaList();
    autoBindTextures();
    return entry;
  }

  // Update variable font weight externally (called from ISF parameter or API)
  function setVarFontWeight(w) {
    _varFontWeight = Math.max(100, Math.min(900, w));
    _vfWeight = _varFontWeight; // Also update global var font texture weight
    _renderVarFontCanvas();
  }

  function setVarFontFamily(idx) {
    _varFontFamilyIdx = Math.round(idx) || 0;
    _renderVarFontCanvas();
  }

  // Mic Captions — real-time speech-to-text → canvas texture
  let _micCaptionEntry = null;
  let _micCaptionCanvas = null;
  let _micCaptionCtx = null;
  let _micCaptionText = '';
  let _micRecognition = null;
  let _voiceLastInputTime = 0;
  let _voiceDecaySeconds = 3.0;
  let _voiceDecayEnabled = false;

  function _renderMicCaptionCanvas() {
    if (!_micCaptionCtx) return;
    const c = _micCaptionCanvas;
    const ctx = _micCaptionCtx;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.save();
    ctx.translate(0, c.height);
    ctx.scale(1, -1);
    ctx.font = `500 ${Math.round(c.height * 0.18)}px "Inter", "Segoe UI", sans-serif`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Word-wrap for longer text
    const words = _micCaptionText.split(' ');
    const maxWidth = c.width * 0.9;
    const lines = [];
    let line = '';
    for (const word of words) {
      const test = line ? line + ' ' + word : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    const lineHeight = c.height * 0.22;
    const startY = c.height / 2 - ((lines.length - 1) * lineHeight) / 2;
    lines.forEach((l, i) => {
      ctx.fillText(l, c.width / 2, startY + i * lineHeight);
    });
    ctx.restore();
    // Update textures
    if (_micCaptionEntry) {
      if (_micCaptionEntry.glTexture) {
        const gl = isfRenderer.gl;
        gl.bindTexture(gl.TEXTURE_2D, _micCaptionEntry.glTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
      }
      if (_micCaptionEntry.threeTexture) {
        _micCaptionEntry.threeTexture.needsUpdate = true;
      }
    }
  }

  // Push mic transcription text into text-type ISF inputs on text layer
  function _pushMicTextToShader(text) {
    const textLayer = getLayer('text');
    if (!textLayer) return;
    const textInputs = (textLayer.inputs || []).filter(inp => inp.TYPE === 'text');
    if (textInputs.length === 0) return;

    function charToCode(ch) {
      if (!ch || ch === ' ') return 26;
      const code = ch.toUpperCase().charCodeAt(0);
      if (code >= 65 && code <= 90) return code - 65;
      if (code >= 48 && code <= 57) return code - 48 + 27;
      return 26;
    }

    for (const inp of textInputs) {
      const maxLen = inp.MAX_LENGTH || 12;
      const str = text.toUpperCase().slice(-maxLen);
      for (let i = 0; i < maxLen; i++) {
        textLayer.inputValues[inp.NAME + '_' + i] = charToCode(str[i]);
      }
      textLayer.inputValues[inp.NAME + '_len'] = str.replace(/\s+$/, '').length;

      // Update the text input field in the UI
      const container = document.querySelector('.layer-params[data-layer="text"]');
      if (container) {
        const rows = container.querySelectorAll('.control-row');
        for (const row of rows) {
          const label = row.querySelector('label');
          if (label && label.textContent === inp.NAME) {
            const field = row.querySelector('input[type="text"]');
            if (field) field.value = str;
            break;
          }
        }
      }
    }
  }

  function startMicCaptions() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert('Speech Recognition not supported in this browser. Use Chrome.');
      return;
    }

    _micCaptionCanvas = document.createElement('canvas');
    _micCaptionCanvas.width = 2048;
    _micCaptionCanvas.height = 512;
    _micCaptionCtx = _micCaptionCanvas.getContext('2d');
    _micCaptionText = '(listening...)';
    _renderMicCaptionCanvas();

    const id = ++mediaIdCounter;
    const entry = {
      id, name: 'Mic Captions', type: 'image',
      element: _micCaptionCanvas, glTexture: createGLTexture(isfRenderer.gl, _micCaptionCanvas),
      threeTexture: new THREE.CanvasTexture(_micCaptionCanvas), threeModel: null,
      _isMicCaption: true
    };
    entry.threeTexture.needsUpdate = true;
    _micCaptionEntry = entry;

    mediaInputs.push(entry);
    renderMediaList();
    autoBindTextures();

    // Start speech recognition
    _micRecognition = new SpeechRecognition();
    _micRecognition.continuous = true;
    _micRecognition.interimResults = true;

    let _fullTranscript = ''; // accumulated full speech
    _micRecognition.onresult = (event) => {
      let interim = '';
      let finalNew = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          finalNew += event.results[i][0].transcript;
        } else {
          interim += event.results[i][0].transcript;
        }
      }
      // Accumulate final results, show interim as live preview
      if (finalNew) _fullTranscript += finalNew + ' ';
      const liveText = (_fullTranscript + interim).trim();
      _micCaptionText = liveText || '...';
      _renderMicCaptionCanvas();

      // Push last 48 chars to shader (sliding window of latest speech)
      _pushMicTextToShader(_micCaptionText);
      // Sync prominent MSG bar + voice transcript (show recent text)
      const displayText = _micCaptionText.toUpperCase();
      const msgBar = document.getElementById('text-msg-input');
      if (msgBar) msgBar.value = displayText.length > 48 ? displayText.slice(-48) : displayText;
      const voiceTranscript = document.getElementById('voice-transcript');
      if (voiceTranscript) voiceTranscript.value = displayText;
      _voiceLastInputTime = performance.now();
    };

    _micRecognition.onerror = (e) => {
      console.warn('Speech recognition error:', e.error);
      if (e.error === 'not-allowed') {
        _micCaptionText = '(mic access denied)';
        _renderMicCaptionCanvas();
      }
    };

    _micRecognition.onend = () => {
      // Auto-restart if still in media list
      if (_micCaptionEntry && mediaInputs.includes(_micCaptionEntry)) {
        try { _micRecognition.start(); } catch(e) {}
      }
    };

    _micRecognition.start();
    return entry;
  }

  // Audio-reactive per-frame update
  function removeMedia(id) {
    const idx = mediaInputs.findIndex(m => m.id === id);
    if (idx === -1) return;
    const entry = mediaInputs[idx];
    // Cleanup GL texture
    if (entry.glTexture) {
      isfRenderer.gl.deleteTexture(entry.glTexture);
    }
    // Cleanup THREE texture
    if (entry.threeTexture) {
      entry.threeTexture.dispose();
    }
    // Cleanup webcam stream
    if (entry.stream) {
      entry.stream.getTracks().forEach(t => t.stop());
    }
    // Cleanup video element (skip for NDI canvas elements)
    if (entry.type === 'video' && entry.element && !entry._isNdi) {
      entry.element.pause();
      if (entry.element.src) URL.revokeObjectURL(entry.element.src);
      entry.element.src = '';
      entry.element.load();
      if (entry.element.parentNode) entry.element.parentNode.removeChild(entry.element);
    }
    // Cleanup mic captions
    if (entry._isMicCaption && _micRecognition) {
      try { _micRecognition.stop(); } catch(e) {}
      _micRecognition = null;
      _micCaptionEntry = null;
      _micCaptionText = '';
    }
    // Cleanup variable font
    if (entry._isVarFont) {
      _varFontEntry = null;
      _varFontText = '';
    }
    // Cleanup audio element
    if (entry.type === 'audio') {
      if (entry._isMicAudio) {
        // Mic audio cleanup: stop stream tracks, null state vars
        if (entry._sourceNode) {
          try { entry._sourceNode.disconnect(); } catch(e) {}
        }
        if (entry.stream) {
          entry.stream.getTracks().forEach(t => t.stop());
        }
        _micAudioStream = null;
        _micAudioSourceNode = null;
        _micAudioEntry = null;
        // Reconnect analyser to destination for file audio playback
        if (audioAnalyser && audioCtx) {
          try { audioAnalyser.connect(audioCtx.destination); } catch(e) {}
        }
        const micBtn = document.getElementById('tile-mic');
        if (micBtn) micBtn.classList.remove('active');
        const headerBtn = document.getElementById('canvas-mic-btn');
        if (headerBtn) headerBtn.classList.remove('active');
        const sig2 = document.getElementById('audio-signal');
        document.getElementById('audio-signal')?.classList.remove('active');
        document.getElementById('audio-level-indicator')?.classList.remove('active');
        // Also stop speech recognition if it was started with mic audio
        if (_micCaptionEntry && mediaInputs.includes(_micCaptionEntry)) {
          removeMedia(_micCaptionEntry.id);
        }
      } else {
        // File audio cleanup
        if (entry._sourceNode) {
          try { entry._sourceNode.disconnect(); } catch(e) {}
        }
        if (entry.element) {
          entry.element.pause();
          if (entry.element.src) URL.revokeObjectURL(entry.element.src);
          entry.element.src = '';
          if (entry.element.parentNode) entry.element.parentNode.removeChild(entry.element);
        }
      }
      if (activeAudioEntry === entry) {
        activeAudioEntry = null;
        audioLevel = audioBass = audioMid = audioHigh = 0;
        document.getElementById('audio-signal')?.classList.remove('active');
        document.getElementById('audio-level-indicator')?.classList.remove('active');
      }
    }
    // If removing last model, revert scene shape to Cube
    const sceneLayer = getLayer('scene');
    if (entry.type === 'model' && sceneLayer.inputValues['shape'] === 6) {
      const hasOtherModel = mediaInputs.some((m, i) => i !== idx && m.type === 'model');
      if (!hasOtherModel) {
        sceneLayer.inputValues['shape'] = 0;
        sceneRenderer.inputValues = sceneLayer.inputValues;
        window.shaderClaw.updateControlUI('shape', 0, 'scene');
      }
    }
    // Cleanup MediaPipe
    if (entry._isMediaPipe && mediaPipeMgr) {
      mediaPipeMgr.dispose();
    }
    // Cleanup NDI receive
    if (entry._isNdi && ndiReceiveEntry === entry) {
      ndiReceiveEntry = null;
      if (_ndiWs && _ndiWs.readyState === WebSocket.OPEN) {
        ndiRequest(_ndiWs, 'ndi_receive_stop', {}).catch(() => {});
      }
    }
    mediaInputs.splice(idx, 1);
    renderMediaList();
    autoBindTextures();
  }

  // (file input change listeners wired above via wireFileInput)

  // Restart video/audio playback when tab regains focus (Chrome pauses muted background videos)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      mediaInputs.forEach(m => {
        if (m.type === 'video' && m.element && m.element.paused) {
          m.element.play().catch(() => {});
        }
        if (m.type === 'audio' && m === activeAudioEntry) {
          if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
          if (m.element && m.element.paused) m.element.play().catch(() => {});
        }
      });
    }
  });

  // --- Load defaults (staggered to avoid GPU context loss) ---
  const _t0 = performance.now();
  const yieldFrame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  // Build layer index map (must happen before compositionLoop is called)
  for (let li = 0; li < layers.length; li++) _layerMap[layers[li].id] = layers[li];

  (async function loadDefaults() {
    dbg('loadDefaults: fetching...');

    // Default shader: metamorphosis
    const _defaultShader = manifest.find(m => m.file === 'metamorphosis.fs') || otherShaders[0] || null;
    const _randomFile = _defaultShader ? (_defaultShader.folder || 'shaders') + '/' + _defaultShader.file : 'shaders/metamorphosis.fs';
    dbg('default shader: ' + (_defaultShader ? _defaultShader.file : 'metamorphosis.fs'));

    const [textSrc, sceneSrc, shaderSrc] = await Promise.all([
      fetch('shaders/text_typewriter.fs').then(r => r.text()),
      fetch('scenes/spinning_cube.scene.js').then(r => r.text()),
      fetch(_randomFile).then(r => r.text()).catch(() => null),
    ]);

    // Yield frames between each heavy GPU operation to prevent context loss
    await yieldFrame();

    // 1. Shader layer FIRST — default to Fluid Simulation
    try {
      activateFluidOnLayer('shader');
      const sel = document.querySelector('.layer-shader-select[data-layer="shader"]');
      if (sel) sel.value = '__fluid__';
      dbg('shader: Fluid Simulation activated');
    } catch (e) {
      console.error('fluid init exception, falling back to ISF shader:', e);
      // Fallback to metamorphosis if fluid fails
      try {
        const src = shaderSrc || DEFAULT_SHADER;
        const shaderResult = compileToLayer('shader', src);
        if (shaderResult && shaderResult.ok) {
          if (shaderSrc && _defaultShader) {
            getLayer('shader').manifestEntry = _defaultShader;
            const sel = document.querySelector('.layer-shader-select[data-layer="shader"]');
            if (sel) sel.value = _defaultShader.file;
          }
          if (focusedLayerId === 'shader') editor.setValue(src);
        }
      } catch (e2) {
        errorBar.textContent = 'Shader exception: ' + e2.message;
        errorBar.classList.add('show');
      }
    }

    await yieldFrame();

    // 2. Scene layer (Three.js — separate WebGL context)
    try {
      const sceneDef = new Function('THREE', 'return (' + sceneSrc + ')(THREE)')(THREE);
      sceneRenderer.load(sceneDef);
      const sceneLayer = getLayer('scene');
      sceneLayer._sceneDef = sceneDef;
      sceneLayer.inputs = sceneDef.INPUTS || [];
      const paramsContainer = document.querySelector('.layer-params[data-layer="scene"]');
      if (paramsContainer) {
        sceneLayer.inputValues = generateControls(sceneLayer.inputs, paramsContainer, (vals) => {
          sceneRenderer.inputValues = vals;
          sceneLayer.inputValues = vals;
          autoBindTextures('scene');
        });
        hoistColorRows('scene');
        syncMpLinkedState(paramsContainer, 'scene');
      }
      sceneRenderer.inputValues = sceneLayer.inputValues;
      autoBindTextures('scene');
      const _isMobileDevice = window.innerWidth <= 900 || /Mobi|Android|iPhone/i.test(navigator.userAgent);
      sceneLayer.visible = false; // 3D hidden by default — user enables via eye toggle
      sceneLayer.manifestEntry = manifest.find(m => m.file === 'spinning_cube.scene.js');
      const sceneSelect = document.querySelector('.layer-shader-select[data-layer="scene"]');
      if (sceneSelect) sceneSelect.value = 'spinning_cube.scene.js';
      sceneRenderer.resize();
      dbg('scene: OK');
    } catch (e) { dbg('scene EXCEPTION: ' + e.message); }

    // 3. Text layer (charData stripped at compile time — safe now)
    await yieldFrame();
    try {
      const textResult = compileToLayer('text', textSrc);
      if (textResult && textResult.ok) {
        // Show text layer — movie credits visible by default
        getLayer('text').visible = true;
        getLayer('text').manifestEntry = manifest.find(m => m.file === 'text_typewriter.fs');
        const textSel = document.querySelector('.layer-shader-select[data-layer="text"]');
        if (textSel) textSel.value = 'text_typewriter.fs';
        if (focusedLayerId === 'text') editor.setValue(textSrc);
        // Pre-generate font atlas so first render frame has the texture ready
        updateFontAtlas(isfRenderer.gl, getLayer('text').inputValues || {});
      } else {
        console.error('Text compile failed:', textResult && textResult.errors);
      }
    } catch (e) { dbg('text EXCEPTION: ' + e.message); }

    updateLayerCardUI('scene');
    updateLayerCardUI('shader');
    updateLayerCardUI('text');

    // Feed texture handler — upload images from data sources to WebGL
    if (!isfRenderer._feedTextures) isfRenderer._feedTextures = [];
    if (window._bus) {
      window._bus.on('feed:image', ({ index, element }) => {
        if (!element) return;
        let tex = isfRenderer._feedTextures[index];
        if (!tex) {
          tex = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          isfRenderer._feedTextures[index] = tex;
        }
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, element);
      });
    }

    // Load built-in assets from /assets folder
    try {
      const assetList = await fetch('/api/assets').then(r => r.json());
      for (const asset of assetList) {
        const resp = await fetch(asset.url);
        const blob = await resp.blob();
        const file = new File([blob], asset.name, { type: blob.type });
        await addMediaFromFile(file);
      }
      if (assetList.length) {
        renderAssetsList();
        autoBindTextures();
        dbg('built-in assets: loaded ' + assetList.length);
      }
    } catch (e) {
      dbg('built-in assets: ' + e.message);
    }

    // Enable error bar now that init is done
    delete errorBar.dataset.init;
    errorBar.classList.remove('show');

    // Start rendering now that all shaders are compiled
    compositionPlaying = true;
    document.getElementById('play-btn').innerHTML = '&#9654;';
    dbg('ALL DONE ' + Math.round(performance.now() - _t0) + 'ms');
    dbg('canvas: ' + glCanvas.width + 'x' + glCanvas.height);
    dbg('layers: ' + layers.map(l => l.id + '=' + (l.visible?'V':'-') + (l.program?'P':'-') + (l.fbo?'F':'-')).join(' '));
    // Ensure canvas has real dimensions (mobile layout may not be settled yet)
    isfRenderer.resize();
    layers.forEach(layer => {
      if (!layer.fbo) return;
      isfRenderer.destroyFBO(layer.fbo);
      layer.fbo = isfRenderer.createFBO(_rw(), _rh());
    });
    sceneRenderer.resize();
    // Start composition loop now that everything is ready
    compositionLoop();
    // Auto-hide debug overlay
    const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    setTimeout(() => { if (_dbg) _dbg.style.display = 'none'; }, isLocal ? 5000 : 0);
  })().catch(e => {
    dbg('FATAL: ' + e.message);
    errorBar.textContent = 'Default load failed: ' + e.message;
    errorBar.classList.add('show');
  });

  // Start loading deferred scripts (model loaders) in background after init
  requestIdleCallback ? requestIdleCallback(() => loadDeferredScripts()) : setTimeout(() => loadDeferredScripts(), 2000);

  // ===== SC3 UI PATCHES =====

  // BG compact row — click to toggle dropdown, swatch opens picker, editable hex/opacity
  (function initBgRow() {
    const row = document.getElementById('sc3-bg-row');
    const dropdown = document.getElementById('sc3-bg-dropdown');
    const swatch = document.getElementById('sc3-bg-swatch');
    const hexInput = document.getElementById('sc3-bg-hex');
    const opacityInput = document.getElementById('sc3-bg-opacity');
    const picker = document.getElementById('bg-color-picker');
    const bgSelect = document.getElementById('canvas-bg-select');
    const eyeBtn = document.getElementById('sc3-bg-eye');
    if (!row || !dropdown) return;

    // Toggle dropdown — only from the row background itself
    row.addEventListener('click', e => {
      if (e.target.closest('.sc3-bg-eye') || e.target.closest('.sc3-bg-swatch') ||
          e.target.closest('.sc3-bg-hex') || e.target.closest('.sc3-bg-opacity')) return;
      row.classList.toggle('open');
      dropdown.classList.toggle('open');
    });

    // Swatch click → open native color picker
    if (swatch && picker) {
      swatch.addEventListener('click', e => {
        e.stopPropagation();
        // Switch to color mode if not already
        if (bgSelect && bgSelect.value !== 'color') {
          bgSelect.value = 'color';
          bgSelect.dispatchEvent(new Event('change'));
        }
        picker.click();
      });
    }

    // Hex input → update picker + bg color
    if (hexInput && picker) {
      hexInput.addEventListener('click', e => e.stopPropagation());
      hexInput.addEventListener('input', () => {
        let v = hexInput.value.replace(/[^0-9a-fA-F]/g, '').slice(0, 6);
        hexInput.value = v;
        if (v.length === 6) {
          picker.value = '#' + v;
          picker.dispatchEvent(new Event('input', { bubbles: true }));
          if (bgSelect && bgSelect.value !== 'color') {
            bgSelect.value = 'color';
            bgSelect.dispatchEvent(new Event('change'));
          }
        }
      });
      hexInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') { hexInput.blur(); e.preventDefault(); }
      });
    }

    // Opacity input → editable percentage
    if (opacityInput) {
      opacityInput.addEventListener('click', e => e.stopPropagation());
      opacityInput.addEventListener('input', () => {
        let v = opacityInput.value.replace(/[^0-9]/g, '');
        let n = Math.min(100, Math.max(0, parseInt(v) || 0));
        opacityInput.value = n;
        // Apply to canvas opacity if available
        if (window._canvasBgOpacity !== undefined) window._canvasBgOpacity = n / 100;
      });
      opacityInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') { opacityInput.blur(); e.preventDefault(); }
      });
    }

    // Eye toggle — switch between current bg and transparent
    let savedBgType = 'color';
    if (eyeBtn && bgSelect) {
      eyeBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (eyeBtn.classList.contains('off')) {
          eyeBtn.classList.remove('off');
          bgSelect.value = savedBgType;
          bgSelect.dispatchEvent(new Event('change'));
        } else {
          savedBgType = bgSelect.value;
          eyeBtn.classList.add('off');
          bgSelect.value = 'transparent';
          bgSelect.dispatchEvent(new Event('change'));
        }
        syncBgDisplay();
      });
    }

    // Sync swatch + hex display whenever bg changes
    function syncBgDisplay() {
      const val = bgSelect ? bgSelect.value : 'color';
      let color = picker ? picker.value : '#000000';
      if (val === 'transparent') color = 'transparent';

      if (swatch) {
        if (color === 'transparent') {
          swatch.style.background = 'repeating-conic-gradient(rgba(255,255,255,0.08) 0% 25%, transparent 0% 50%) 0 0 / 8px 8px';
        } else if (val === 'image' || val === 'video' || val === 'shader' || val === 'webcam' || val === 'ndi') {
          swatch.style.background = 'linear-gradient(135deg, #333, #555)';
        } else {
          swatch.style.background = color;
        }
      }
      if (hexInput) {
        if (color === 'transparent') hexInput.value = 'TRANSP';
        else if (val === 'image') hexInput.value = 'IMAGE';
        else if (val === 'video') hexInput.value = 'VIDEO';
        else if (val === 'shader') hexInput.value = 'SHADER';
        else if (val === 'webcam') hexInput.value = 'WEBCAM';
        else if (val === 'ndi') hexInput.value = 'NDI';
        else hexInput.value = color.replace('#', '').toUpperCase();
      }
    }

    if (bgSelect) bgSelect.addEventListener('change', syncBgDisplay);
    if (picker) picker.addEventListener('input', syncBgDisplay);
    syncBgDisplay();
  })();

  // Editor toggle (collapse/expand)
  // Canvas & Input Triggers layer cards — click header to toggle open
  // Note: #layer-panel cards are handled by the drag-to-reorder pointerup handler
  document.querySelectorAll('#canvas-panel .layer-card .layer-header, #input-triggers-panel .layer-card .layer-header').forEach(hdr => {
    hdr.addEventListener('click', e => {
      if (e.target.closest('button')) return;
      const card = hdr.closest('.layer-card');
      if (card) card.classList.toggle('open');
    });
  });
  // Square layer buttons — click anywhere on closed card to open, click header to close
  document.querySelectorAll('.sc3-layer-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      if (e.target.closest('button')) return;
      // Overlay button: open file picker directly
      if (btn.dataset.layer === 'overlay') {
        if (!btn.classList.contains('open')) {
          const uploadBtn = document.getElementById('overlay-upload-btn');
          if (uploadBtn) uploadBtn.click();
        }
        return;
      }
      // If open, clicking the header area closes the card
      if (btn.classList.contains('open')) {
        if (e.target.closest('.layer-header')) btn.classList.remove('open');
        return;
      }
      btn.classList.add('open');
    });
  });

  // Section collapse (sc3-section-header click)
  document.querySelectorAll('.sc3-section-header').forEach(hdr => {
    hdr.addEventListener('click', (e) => {
      // Don't collapse if clicking the eye button (it has its own handler)
      if (e.target.closest('.layer-vis')) return;
      const section = hdr.closest('.sc3-section');
      if (section) section.classList.toggle('collapsed');
    });
  });

  // Claude Chat Bar — shader generation
  const chatInput = document.querySelector('.sc3-chat-input');
  const chatSend = document.querySelector('.sc3-chat-send');
  const chatHistory = document.querySelector('.sc3-chat-history');
  const chatRefBtn = document.querySelector('.sc3-chat-ref-btn');
  const chatRefInput = document.querySelector('.sc3-chat-ref-input');
  const chatAttachment = document.querySelector('.sc3-chat-attachment');
  const chatAttachThumb = document.querySelector('.sc3-chat-attachment-thumb');
  const chatAttachRemove = document.querySelector('.sc3-chat-attachment-remove');
  const chatBar = document.querySelector('.sc3-chat-bar');
  let _chatRefDataUrl = null;
  let _chatGenerating = false;

  if (chatRefBtn && chatRefInput) {
    chatRefBtn.addEventListener('click', () => chatRefInput.click());
    chatRefInput.addEventListener('change', () => {
      const file = chatRefInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = e => {
        _chatRefDataUrl = e.target.result;
        chatAttachThumb.src = _chatRefDataUrl;
        chatAttachment.style.display = 'flex';
        chatRefBtn.classList.add('has-image');
      };
      reader.readAsDataURL(file);
      chatRefInput.value = '';
    });
    if (chatAttachRemove) {
      chatAttachRemove.addEventListener('click', () => {
        _chatRefDataUrl = null;
        chatAttachment.style.display = 'none';
        chatRefBtn.classList.remove('has-image');
      });
    }
  }

  // Cooking indicator element (inserted into chat bar)
  let cookingEl = null;
  function showCooking() {
    if (!chatBar) return;
    _chatGenerating = true;
    chatBar.classList.add('generating');
    if (chatInput) { chatInput.disabled = true; chatInput.placeholder = ''; }
    if (chatSend) chatSend.disabled = true;
    // Create cooking indicator
    cookingEl = document.createElement('div');
    cookingEl.className = 'sc3-chat-cooking';
    cookingEl.innerHTML = '<span class="sc3-cooking-dots"><span></span><span></span><span></span></span><span class="sc3-cooking-text">Generating shader</span>';
    chatBar.appendChild(cookingEl);
  }
  function hideCooking() {
    _chatGenerating = false;
    if (chatBar) chatBar.classList.remove('generating');
    if (chatInput) { chatInput.disabled = false; chatInput.placeholder = 'Ask Claude to modify your shader...'; }
    if (chatSend) chatSend.disabled = false;
    if (cookingEl) { cookingEl.remove(); cookingEl = null; }
  }

  if (chatInput && chatSend) {
    async function sendChatMessage() {
      if (_chatGenerating) return;
      const msg = chatInput.value.trim();
      if (!msg && !_chatRefDataUrl) return;
      chatInput.value = '';
      const chatId = Date.now().toString();

      // Show user message in history
      if (chatHistory) {
        chatHistory.classList.add('visible');
        const userBubble = document.createElement('div');
        userBubble.className = 'sc3-chat-msg sc3-chat-user';
        if (_chatRefDataUrl) {
          const img = document.createElement('img');
          img.className = 'sc3-chat-ref-img';
          img.src = _chatRefDataUrl;
          userBubble.appendChild(img);
        }
        if (msg) {
          const txt = document.createElement('span');
          txt.textContent = msg;
          userBubble.appendChild(txt);
        }
        chatHistory.appendChild(userBubble);
        chatHistory.scrollTop = chatHistory.scrollHeight;
      }

      // Send via WebSocket
      if (_ndiWs && _ndiWs.readyState === WebSocket.OPEN) {
        const payload = { action: 'chat', message: msg, chatId };
        if (_chatRefDataUrl) payload.referenceImage = _chatRefDataUrl;
        _ndiWs.send(JSON.stringify(payload));
        showCooking();
      } else {
        // No WS — show error in history
        if (chatHistory) {
          const errBubble = document.createElement('div');
          errBubble.className = 'sc3-chat-msg sc3-chat-ai';
          errBubble.textContent = 'Not connected to server. Start the server with: node server.js';
          chatHistory.appendChild(errBubble);
          chatHistory.scrollTop = chatHistory.scrollHeight;
        }
      }

      // Clear attachment after send
      _chatRefDataUrl = null;
      if (chatAttachment) chatAttachment.style.display = 'none';
      if (chatRefBtn) chatRefBtn.classList.remove('has-image');
    }
    chatSend.addEventListener('click', sendChatMessage);
    chatInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
    });
  }

  // Listen for chat generation events from server
  window.addEventListener('sc3-chat-event', (e) => {
    const msg = e.detail;
    switch (msg.action) {
      case 'chat_start':
        // Already showing cooking from sendChatMessage
        break;

      case 'chat_chunk':
        // Update cooking text with progress
        if (cookingEl) {
          const textEl = cookingEl.querySelector('.sc3-cooking-text');
          if (textEl) {
            const lines = (msg.partial || '').split('\n').length;
            textEl.textContent = `Generating shader (${lines} lines)`;
          }
        }
        break;

      case 'chat_done': {
        hideCooking();
        let shader = msg.shader || '';
        // Strip markdown code fences if present
        shader = shader.replace(/^```(?:glsl|frag|fs)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim();
        if (shader && window.shaderClaw) {
          // Load the generated shader (same as "New" button flow)
          window.shaderClaw.loadSource(shader);
          // Show success in chat history
          if (chatHistory) {
            const aiBubble = document.createElement('div');
            aiBubble.className = 'sc3-chat-msg sc3-chat-ai';
            aiBubble.textContent = 'Shader loaded! Tweak the parameters in the Layers panel.';
            chatHistory.appendChild(aiBubble);
            chatHistory.scrollTop = chatHistory.scrollHeight;
          }
        }
        break;
      }

      case 'chat_error': {
        hideCooking();
        if (chatHistory) {
          const errBubble = document.createElement('div');
          errBubble.className = 'sc3-chat-msg sc3-chat-ai';
          errBubble.textContent = msg.error || 'Generation failed';
          errBubble.style.color = '#ff6b6b';
          chatHistory.appendChild(errBubble);
          chatHistory.scrollTop = chatHistory.scrollHeight;
        }
        break;
      }
    }
  });

  // ===== COMPOSITION LOOP =====
  function compositionLoop(timestamp) {
    const _xrActive = xrManager && xrManager.active;
    if (!compositionPlaying || _contextLost || isfRenderer.gl.isContextLost()) {
      if (_compFrameCount < 3) dbg('compLoop SKIP: playing=' + compositionPlaying + ' ctxLost=' + _contextLost + ' glLost=' + isfRenderer.gl.isContextLost());
      _compFrameCount++;
      // In XR mode, don't schedule — the xr:frame bus event drives the loop
      if (!_xrActive) requestAnimationFrame(compositionLoop);
      return;
    }
    // 30fps cap on mobile — skip in XR mode (XR needs every frame submitted)
    if (!_xrActive && _isMobileComp && timestamp - _lastCompTime < 33) {
      requestAnimationFrame(compositionLoop);
      return;
    }
    _lastCompTime = timestamp;
    // Bump video frame stamp so each video texture is uploaded at most once per frame
    isfRenderer._videoFrameStamp++;

    // Compute mouse delta BEFORE rendering so fluid/paint shaders see current-frame delta
    const mdx = isfRenderer.mousePos[0] - isfRenderer._lastMousePos[0];
    const mdy = isfRenderer.mousePos[1] - isfRenderer._lastMousePos[1];
    isfRenderer.mouseDelta[0] = mdx;
    isfRenderer.mouseDelta[1] = mdy;
    if (_compFrameCount < 3) dbg('compLoop frame ' + _compFrameCount + ' comp=' + !!isfRenderer.compositorProgram);
    _compFrameCount++;

    // Pinch hold accumulator: ramps up while pinching, decays when released
    if (mediaPipeMgr && mediaPipeMgr.active && mediaPipeMgr.isPinching) {
      isfRenderer.pinchHold = Math.min(isfRenderer.pinchHold + 0.016, 10.0);
    } else {
      isfRenderer.pinchHold = Math.max(isfRenderer.pinchHold - 0.04, 0.0);
    }
    // Second hand pinch hold accumulator
    if (mediaPipeMgr && mediaPipeMgr.active && mediaPipeMgr.isPinching2) {
      isfRenderer.pinchHold2 = Math.min(isfRenderer.pinchHold2 + 0.016, 10.0);
    } else {
      isfRenderer.pinchHold2 = Math.max(isfRenderer.pinchHold2 - 0.04, 0.0);
    }

    const gl = isfRenderer.gl;

    // Voice decay: 2s hold at full opacity, then ease-out decay
    const textLayer = getLayer('text');
    if (_voiceDecayEnabled && _voiceLastInputTime > 0 && textLayer) {
      const elapsed = (performance.now() - _voiceLastInputTime) / 1000;
      const holdTime = 2.0;
      let decayFactor;
      if (elapsed < holdTime) {
        decayFactor = 1.0;
      } else {
        const t = Math.min(1, (elapsed - holdTime) / Math.max(0.01, _voiceDecaySeconds));
        decayFactor = (1.0 - t) * (1.0 - t);
      }
      textLayer.opacity = decayFactor;
      textLayer._voiceGlitch = decayFactor < 1.0 ? (1.0 - decayFactor) : 0.0;
      // Update UI only every 4th frame to reduce DOM thrashing
      if ((_compFrameCount & 3) === 0) {
        if (!_cachedTextOpSlider) _cachedTextOpSlider = document.querySelector('.layer-opacity[data-layer="text"]');
        if (!_cachedTextOpVal) _cachedTextOpVal = _cachedTextOpSlider?.closest('.layer-control-row')?.querySelector('.val');
        if (_cachedTextOpSlider) _cachedTextOpSlider.value = decayFactor;
        if (_cachedTextOpVal) _cachedTextOpVal.textContent = decayFactor.toFixed(2);
        const compactOp = document.querySelector('.sc3-layer-opacity-val[data-layer="text"]');
        if (compactOp) compactOp.value = Math.round(decayFactor * 100);
      }
    } else if (textLayer) {
      textLayer._voiceGlitch = 0.0;
    }

    // Update data signal generators (before resolve so values are fresh)
    _dataManager.update();
    // Merge live data source values into _dataManager for binding resolution
    if (window._dataSources) {
      const dsv = window._dataSources.values;
      for (const k in dsv) _dataManager.values[k] = dsv[k];
    }

    // 4. MediaPipe detection + gesture processing (BEFORE layer render so values are fresh)
    if (mediaPipeMgr.active) {
      const webcamEntry = mediaInputs.find(m => m.name === 'Webcam' && m.type === 'video');
      if (webcamEntry && webcamEntry.element) {
        mediaPipeMgr.detect(webcamEntry.element, performance.now());
      }

      // Pinch-to-rotate: apply hand pinch gesture to 3D scene rotation
      if (mediaPipeMgr.isPinching && sceneRenderer.sceneDef) {
        const sceneLayer = getLayer('scene');
        if (sceneLayer.inputValues) {
          sceneLayer.inputValues.rotY = ((sceneLayer.inputValues.rotY || 0) - mediaPipeMgr._pinchAccumX * 0.3 + 1) % 1;
          sceneLayer.inputValues.rotX = Math.max(0, Math.min(1, (sceneLayer.inputValues.rotX || 0.5) + mediaPipeMgr._pinchAccumY * 0.3));
          sceneRenderer.inputValues = sceneLayer.inputValues;
          mediaPipeMgr._pinchAccumX = 0;
          mediaPipeMgr._pinchAccumY = 0;
        }
      }

      // Live slider feedback: update sliders for MP-bound params (~15fps)
      if ((_compFrameCount & 3) === 0) {
        updateLinkedSliders();
        updateHandPosWidget();
        updateSignalBars();
        updateSignalRows();
        updateRangeIndicators();
        updateLinksDashboardValues();
        if (btIsRecording) captureFrame();
        if (btIsPlaying) applyPlaybackFrame();
      }
    }

    // Update signal UI even without MediaPipe active (for data/audio/mouse bindings)
    if (!mediaPipeMgr.active && (_compFrameCount & 3) === 0) {
      updateSignalRows();
      updateSignalBars();
      updateRangeIndicators();
      updateLinksDashboardValues();
    }

    // GestureProcessor: always update so ease-out completes smoothly after tracking drops
    if (gestureEnabled) {
      gestureProcessor.update(mediaPipeMgr);
      if (!gestureProcessor.settled) {
        for (let li = 0; li < layers.length; li++) {
          const layer = layers[li];
          if (layer.type === 'shader' && layer.visible && layer._hasGestureInputs) {
            gestureProcessor.applyToLayer(layer);
          }
        }
      }
    }

    // Resolve pending async shader compilations
    for (let li = 0; li < layers.length; li++) {
      const layer = layers[li];
      if (!layer._pendingCompile) continue;
      if (!layer._pendingCompile.handle.isReady()) continue;
      const pending = layer._pendingCompile;
      layer._pendingCompile = null;
      const result = pending.handle.finalize();
      if (result.ok) {
        // Snapshot old FBO for crossfade
        _snapshotLayerFBO(gl, layer);
        // Swap program immediately (GPU-only, fast) to keep rendering smooth
        isfRenderer.compileForLayer(layer, null, null, result.program);
        // Start crossfade
        layer._transitionStart = performance.now();
        errorBar.textContent = '';
        errorBar.classList.remove('show');
        lastErrors = null;
        // Defer heavy DOM work (generateControls, passes, etc.) out of animation frame
        const _pendingId = layer.id, _pendingSrc = pending.source;
        setTimeout(() => { compileToLayer(_pendingId, _pendingSrc, layer.program); }, 0);
      } else {
        errorBar.textContent = result.errors;
        errorBar.classList.add('show');
      }
    }

    // Render each visible layer
    for (let li = 0; li < layers.length; li++) {
      const layer = layers[li];
      if (!layer.visible) continue;
      try {
        if (layer.type === 'scene' && sceneRenderer.sceneDef) {
          resolveBindings(layer, mediaPipeMgr, isfRenderer);
          sceneRenderer.inputValues = layer.inputValues;
          // Update layer-reference DataTextures (FBO → Three.js) before scene render
          const sceneInputs = layer.inputs || [];
          for (let si = 0; si < sceneInputs.length; si++) {
            const inp = sceneInputs[si];
            if (inp.TYPE !== 'image') continue;
            const selId = layer.inputValues[inp.NAME];
            if (typeof selId !== 'string' || !selId.startsWith('layer:')) continue;
            const srcId = selId.slice(6);
            const src = layers.find(l => l.id === srcId);
            if (src && src.fbo && src._threeLayerTex) {
              const w = src.fbo.width, h = src.fbo.height;
              // Resize DataTexture if FBO changed size
              if (src._threeLayerTex.image.width !== w || src._threeLayerTex.image.height !== h) {
                src._threeLayerTexData = new Uint8Array(w * h * 4);
                src._threeLayerTex.dispose();
                src._threeLayerTex = new THREE.DataTexture(src._threeLayerTexData, w, h, THREE.RGBAFormat);
                src._threeLayerTex.minFilter = THREE.LinearFilter;
                src._threeLayerTex.magFilter = THREE.LinearFilter;
                // Re-register in sceneRenderer.media
                const existing = sceneRenderer.media.find(m => m.id === selId);
                if (existing) existing.threeTexture = src._threeLayerTex;
              }
              gl.bindFramebuffer(gl.FRAMEBUFFER, src.fbo.fbo);
              gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, src._threeLayerTexData);
              gl.bindFramebuffer(gl.FRAMEBUFFER, null);
              src._threeLayerTex.needsUpdate = true;
            }
          }
          sceneRenderer.render();
          gl.bindTexture(gl.TEXTURE_2D, sceneTexture);
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, threeCanvas);
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        } else if (layer._fluidActive && fluidRenderer.active) {
          // Fluid simulation: update + render to layer FBO
          // Use hand-as-mouse override when enabled
          let fMx = isfRenderer.mousePos, fMdx = isfRenderer.mouseDelta, fMdown = isfRenderer.mouseDown;
          if (layer.handAsMouse && mediaPipeMgr && mediaPipeMgr.active && mediaPipeMgr.handCount > 0) {
            const hx = 1.0 - mediaPipeMgr.handPos[0];
            const hy = mediaPipeMgr.handPos[1];
            const pdx = hx - (layer._prevFluidHandX ?? hx);
            const pdy = hy - (layer._prevFluidHandY ?? hy);
            layer._prevFluidHandX = hx;
            layer._prevFluidHandY = hy;
            fMx = [hx, hy];
            fMdx = [pdx, pdy];
            fMdown = mediaPipeMgr.isPinching ? 1 : 0;
          }
          const audioState = (typeof audioLevel !== 'undefined') ? { level: audioLevel, bass: audioBass, mid: audioMid, high: audioHigh } : null;
          fluidRenderer.update(fMx, fMdx, fMdown, audioState, mediaPipeMgr);
          fluidRenderer.renderToFBO(layer.fbo);
          // Pinch-to-fade: apply fluid renderer's pinch opacity to layer
          if (fluidRenderer.pinchFading || fluidRenderer.pinchOpacity < 1) {
            layer.opacity = fluidRenderer.pinchOpacity;
          }
        } else if (layer._shadertoyActive && shadertoyRenderer.active) {
          // Shadertoy: run buffer passes + render image to layer FBO
          shadertoyRenderer.update(isfRenderer.mousePos, isfRenderer.mouseDelta, isfRenderer.mouseDown);
          shadertoyRenderer.renderToFBO(layer.fbo);
        } else if (layer.program) {
          isfRenderer.renderLayerToFBO(layer, mediaPipeMgr);
        }
        // Crossfade: blend old snapshot over new render with fading alpha
        if (layer._transitionStart) {
          const elapsed = performance.now() - layer._transitionStart;
          const t = Math.min(1, elapsed / TRANSITION_MS);
          if (t < 1) {
            // Ease-out cubic: old snapshot fades smoothly
            const alpha = (1 - t) * (1 - t) * (1 - t);
            _blendTransitionSnapshot(gl, layer, alpha);
          } else {
            layer._transitionStart = null;
          }
        }
      } catch (e) {
        if (_compFrameCount < 5) console.error('Layer render error [' + layer.id + ']:', e);
      }
    }

    // Update mouse delta for this frame (NOTE: moved after render in old code,
    // but must run BEFORE render so fluid/paint shaders see current-frame delta)
    isfRenderer._lastMousePos[0] = isfRenderer.mousePos[0];
    isfRenderer._lastMousePos[1] = isfRenderer.mousePos[1];

    // Input activity: 1.0 when mouse/hands active, holds 5s then decays to idle
    const _mouseMoving = Math.abs(mdx) > 0.0005 || Math.abs(mdy) > 0.0005;
    const _handsActive = mediaPipeMgr && mediaPipeMgr.active && mediaPipeMgr.handCount > 0;
    if (_mouseMoving || _handsActive) {
      isfRenderer.inputActivity = Math.min((isfRenderer.inputActivity || 0) + 0.05, 1.0);
      isfRenderer._lastInputTime = performance.now();
    } else {
      const elapsed = performance.now() - (isfRenderer._lastInputTime || 0);
      if (elapsed > 5000) {
        isfRenderer.inputActivity = Math.max((isfRenderer.inputActivity || 0) - 0.008, 0.0);
      }
    }

    // Re-upload overlay video/GIF each frame
    const _olay = getLayer('overlay');
    if (_olay && _olay.visible && _olay.fbo) {
      if (_olay._videoElement) {
        const vid = _olay._videoElement;
        if (vid.readyState >= 2 && !vid.paused) {
          gl.bindTexture(gl.TEXTURE_2D, _olay.fbo.texture);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, vid);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        }
        if (vid.paused && vid.loop && !vid.ended) vid.play().catch(() => {});
      } else if (_olay._gifElement) {
        _olay._gifFrameCount = (_olay._gifFrameCount || 0) + 1;
        if (_olay._gifFrameCount % 2 === 0) {
          gl.bindTexture(gl.TEXTURE_2D, _olay.fbo.texture);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, _olay._gifElement);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        }
      }
    }

    // Update background texture each frame
    if (canvasBg.mode === 'video' || canvasBg.mode === 'webcam') {
      if (canvasBg.videoEl && canvasBg.videoEl.readyState >= 2) {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.bindTexture(gl.TEXTURE_2D, canvasBg.texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvasBg.videoEl);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      }
    } else if (canvasBg.mode === 'ndi') {
      // NDI frames are pushed to ndiReceiveCanvas by handleNdiVideoFrame;
      // just upload the canvas to the bg texture each frame
      if (canvasBg.videoEl && canvasBg.texture) {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.bindTexture(gl.TEXTURE_2D, canvasBg.texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvasBg.videoEl);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      }
    } else if (canvasBg.mode === 'shader' && canvasBg.shaderLayer && canvasBg.shaderLayer.program) {
      isfRenderer.renderLayerToFBO(canvasBg.shaderLayer, mediaPipeMgr);
    }

    // 5. Compositor pass (to screen or XR capture FBO)
    if (xrManager && xrManager.active && xrManager.compFBO) {
      isfRenderer.renderCompositor(layers, sceneTexture, canvasBg, xrManager.compFBO);
    } else {
      isfRenderer.renderCompositor(layers, sceneTexture, canvasBg);
    }

    // 6. Projection window mirror
    if (projectionCtx && projectionWindow && !projectionWindow.closed) {
      projectionCtx.drawImage(glCanvas, 0, 0);
    } else if (projectionWindow) {
      projectionWindow = null; projectionCtx = null; projectionCanvas = null;
    }

    // 7. NDI send runs via its own requestAnimationFrame loop (Worker-based)

    // 8. Schedule next frame
    // When XR is active, the xr:frame bus event drives the loop — don't schedule here
    if (!(xrManager && xrManager.active)) {
      requestAnimationFrame(compositionLoop);
    }
  }

  // compositionLoop() is now started inside loadDefaults after compositionPlaying = true

  // Mouse tracking for interactive shaders (uses cached _glCanvasRect — updated by ResizeObserver)
  glCanvas.addEventListener('mousemove', (e) => {
    const nx = (e.clientX - _glCanvasRect.left) / _glCanvasRect.width;
    const ny = 1.0 - (e.clientY - _glCanvasRect.top) / _glCanvasRect.height; // GL coords: Y up
    isfRenderer.mousePos[0] += (nx - isfRenderer.mousePos[0]) * 0.3;
    isfRenderer.mousePos[1] += (ny - isfRenderer.mousePos[1]) * 0.3;
  });
  glCanvas.addEventListener('mousedown', () => { isfRenderer.mouseDown = 1; });
  glCanvas.addEventListener('mouseup', () => { isfRenderer.mouseDown = 0; });

  // Touch support for shader interaction (mobile)
  let _touchPinchDist = 0;
  let _touchCount = 0;

  glCanvas.addEventListener('touchstart', (e) => {
    e.preventDefault(); // prevent scroll/zoom on canvas
    _touchCount = e.touches.length;
    isfRenderer.mouseDown = 1;
    // Single finger — update mousePos immediately on tap
    if (e.touches.length === 1) {
      const touch = e.touches[0];
      isfRenderer.mousePos[0] = (touch.clientX - _glCanvasRect.left) / _glCanvasRect.width;
      isfRenderer.mousePos[1] = 1.0 - (touch.clientY - _glCanvasRect.top) / _glCanvasRect.height;
    }
    // Two fingers — start pinch tracking
    if (e.touches.length >= 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      _touchPinchDist = Math.sqrt(dx * dx + dy * dy);
      isfRenderer.pinchHold = Math.min(isfRenderer.pinchHold + 0.5, 10.0);
    }
  }, { passive: false });

  glCanvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    _touchCount = e.touches.length;
    if (e.touches.length === 1) {
      // Single finger drag — update mousePos directly (no smoothing)
      // so mouseDelta is accurate for fluid/paint shaders
      const touch = e.touches[0];
      const nx = (touch.clientX - _glCanvasRect.left) / _glCanvasRect.width;
      const ny = 1.0 - (touch.clientY - _glCanvasRect.top) / _glCanvasRect.height;
      isfRenderer.mousePos[0] = nx;
      isfRenderer.mousePos[1] = ny;
    } else if (e.touches.length >= 2) {
      // Two finger pinch — drive pinchHold and update mousePos to midpoint
      const t0 = e.touches[0], t1 = e.touches[1];
      const dx = t0.clientX - t1.clientX;
      const dy = t0.clientY - t1.clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const mx = ((t0.clientX + t1.clientX) / 2 - _glCanvasRect.left) / _glCanvasRect.width;
      const my = 1.0 - ((t0.clientY + t1.clientY) / 2 - _glCanvasRect.top) / _glCanvasRect.height;
      isfRenderer.mousePos[0] += (mx - isfRenderer.mousePos[0]) * 0.3;
      isfRenderer.mousePos[1] += (my - isfRenderer.mousePos[1]) * 0.3;
      // Ramp pinchHold while pinching
      isfRenderer.pinchHold = Math.min(isfRenderer.pinchHold + 0.03, 10.0);
      _touchPinchDist = dist;
    }
  }, { passive: false });

  glCanvas.addEventListener('touchend', (e) => {
    _touchCount = e.touches.length;
    if (e.touches.length === 0) {
      isfRenderer.mouseDown = 0;
    }
  });

  glCanvas.addEventListener('touchcancel', () => {
    _touchCount = 0;
    isfRenderer.mouseDown = 0;
  });

  // Handle canvas resize on panel resize (debounced to prevent GPU churn on mobile)
  let _resizeTimer = null;
  const resizeObs = new ResizeObserver(() => {
    if (_resizeTimer) clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
    isfRenderer.resize();
    sceneRenderer.resize();
    // Resize layer FBOs
    layers.forEach(layer => {
      if (layer.fbo) {
        const gl = isfRenderer.gl;
        gl.bindTexture(gl.TEXTURE_2D, layer.fbo.texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, _rw(), _rh(), 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        layer.fbo.width = _rw();
        layer.fbo.height = _rh();
      }
    });
    }, 150); // debounce 150ms
  });
  resizeObs.observe(document.getElementById('preview'));

  // ===== CANVAS SIZE SELECTOR =====
  (function initCanvasSizeSelector() {
    const sel = document.getElementById('canvas-size-select');
    const customInput = document.getElementById('canvas-size-custom');
    if (!sel) return;

    // Resolve pass dimension expression (e.g. "$WIDTH/2") against new canvas size
    function _resolvePassDim(expr, canvasW, canvasH) {
      if (!expr) return canvasW;
      if (typeof expr === 'number') return expr;
      const s = String(expr);
      const m = s.match(/^\$(?:WIDTH|HEIGHT)\s*\/\s*(\d+)$/);
      if (m) {
        const base = s.includes('HEIGHT') ? canvasH : canvasW;
        return Math.max(1, Math.round(base / parseInt(m[1])));
      }
      return parseInt(s) || canvasW;
    }

    function applyCanvasSize(w, h) {
      // Resize the main canvas
      glCanvas.width = w;
      glCanvas.height = h;
      isfRenderer.gl.viewport(0, 0, w, h);

      // Fit canvas display to viewport with correct aspect ratio (letterbox)
      const container = glCanvas.parentElement;
      const vpW = container.clientWidth || window.innerWidth;
      const vpH = container.clientHeight || window.innerHeight;
      const canvasAspect = w / h;
      const vpAspect = vpW / vpH;

      if (canvasAspect > vpAspect) {
        // Canvas is wider than viewport — fit to width, letterbox top/bottom
        glCanvas.style.width = '100%';
        glCanvas.style.height = (vpW / canvasAspect) + 'px';
      } else {
        // Canvas is taller — fit to height, pillarbox left/right
        glCanvas.style.height = '100%';
        glCanvas.style.width = (vpH * canvasAspect) + 'px';
      }
      // Keep Three.js canvas in sync
      const threeCanvas = document.getElementById('three-canvas');
      if (threeCanvas) {
        threeCanvas.style.width = glCanvas.style.width;
        threeCanvas.style.height = glCanvas.style.height;
      }
      // Recreate all layer FBOs at new resolution
      layers.forEach(layer => {
        if (layer.fbo) {
          isfRenderer.destroyFBO(layer.fbo);
          layer.fbo = isfRenderer.createFBO(w, h);
        }
        // Recreate multi-pass ping-pong FBOs if present
        if (layer.passes) {
          layer.passes.forEach(p => {
            if (p.ppFBO) {
              isfRenderer.destroyPingPongFBO(p.ppFBO);
              // Recalculate pass dimensions relative to new canvas size
              let pw = p._widthExpr ? _resolvePassDim(p._widthExpr, w, h) : w;
              let ph = p._heightExpr ? _resolvePassDim(p._heightExpr, w, h) : h;
              // Perf: auto-downscale simulation (TARGET) passes on ultra-wide canvases
              const isSimPass = !!p.target;
              if (isSimPass && w > 4096) {
                pw = Math.max(1, Math.round(pw / 2));
                ph = Math.max(1, Math.round(ph / 2));
              }
              p._simDownscaled = isSimPass && w > 4096;
              p.width = pw;
              p.height = ph;
              p.ppFBO = isfRenderer.createPingPongFBO(pw, ph);
            }
          });
        }
      });
      // Recreate background shader FBO
      if (canvasBg.shaderFBO) {
        isfRenderer.destroyFBO(canvasBg.shaderFBO);
        canvasBg.shaderFBO = isfRenderer.createFBO(w, h);
        canvasBg.texture = canvasBg.shaderFBO.texture;
        if (canvasBg.shaderLayer) canvasBg.shaderLayer.fbo = canvasBg.shaderFBO;
      }
      sceneRenderer.resize();
      // Restart NDI at new resolution if currently sending
      if (ndiSendingActive && _ndiWs && _ndiWs.readyState === WebSocket.OPEN) {
        stopNdiSend();
        ndiRequest(_ndiWs, 'ndi_send_stop').catch(() => {});
        setTimeout(() => {
          ndiRequest(_ndiWs, 'ndi_send_start', { name: 'ShaderClaw', width: w, height: h })
            .then(() => { startNdiSend(_ndiWs, glCanvas); updateNdiUI(); })
            .catch(() => {});
        }, 300);
      }
      // Update PiP video dimensions if active
      if (document.pictureInPictureElement) {
        document.exitPictureInPicture().catch(() => {});
      }
      dbg('canvas resized to ' + w + 'x' + h);
    }

    sel.addEventListener('change', () => {
      if (sel.value === 'custom') {
        customInput.style.display = '';
        customInput.focus();
        return;
      }
      customInput.style.display = 'none';
      const parts = sel.value.split('x');
      applyCanvasSize(parseInt(parts[0]), parseInt(parts[1]));
    });

    if (customInput) {
      customInput.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const val = customInput.value.trim();
        const m = val.match(/^(\d+)\s*[xX×,]\s*(\d+)$/);
        if (m) {
          const w = Math.max(320, Math.min(16384, parseInt(m[1])));
          const h = Math.max(180, Math.min(8192, parseInt(m[2])));
          applyCanvasSize(w, h);
          customInput.style.display = 'none';
        }
      });
    }
  })();

  // ===== DRAG-TO-REORDER LAYERS =====
  (function initLayerDrag() {
    const panel = document.getElementById('layer-panel');
    let dragCard = null;

    function getCardFromPoint(y) {
      const cards = [...panel.querySelectorAll('.layer-card')];
      for (const card of cards) {
        const rect = card.getBoundingClientRect();
        if (y >= rect.top && y <= rect.bottom) return card;
      }
      return null;
    }

    function clearIndicators() {
      panel.querySelectorAll('.layer-card').forEach(c => {
        c.classList.remove('drag-over-top', 'drag-over-bottom');
      });
    }

    function syncLayerOrder() {
      const cards = [...panel.querySelectorAll('.layer-card')];
      // Top card in sidebar = frontmost (rendered last). Reverse so index 0 = backmost.
      // Filter out cards without compositor layers (e.g. voice)
      const newOrder = cards.map(c => getLayer(c.dataset.layer)).filter(Boolean).reverse();
      layers.length = 0;
      layers.push(...newOrder);
    }

    let dragStartY = 0;
    let dragPending = null; // card waiting for movement threshold
    const DRAG_THRESHOLD = 5; // pixels before drag activates

    panel.addEventListener('pointerdown', (e) => {
      const header = e.target.closest('.layer-header');
      if (!header) return;
      if (e.target.closest('button, select, input')) return;
      const card = header.closest('.layer-card');
      if (!card) return;
      dragPending = card;
      dragStartY = e.clientY;
    });

    panel.addEventListener('pointermove', (e) => {
      // Start drag only after threshold
      if (dragPending && !dragCard) {
        if (Math.abs(e.clientY - dragStartY) >= DRAG_THRESHOLD) {
          dragCard = dragPending;
          dragCard.classList.add('dragging');
        } else {
          return;
        }
      }
      if (!dragCard) return;
      clearIndicators();
      const overCard = getCardFromPoint(e.clientY);
      if (overCard && overCard !== dragCard) {
        const rect = overCard.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        if (e.clientY < midY) {
          overCard.classList.add('drag-over-top');
        } else {
          overCard.classList.add('drag-over-bottom');
        }
      }
    });

    panel.addEventListener('pointerup', (e) => {
      if (dragCard) {
        clearIndicators();
        const overCard = getCardFromPoint(e.clientY);
        if (overCard && overCard !== dragCard) {
          const rect = overCard.getBoundingClientRect();
          const midY = rect.top + rect.height / 2;
          if (e.clientY < midY) {
            panel.insertBefore(dragCard, overCard);
          } else {
            panel.insertBefore(dragCard, overCard.nextSibling);
          }
          syncLayerOrder();
        }
        dragCard.classList.remove('dragging');
        dragCard = null;
      } else if (dragPending) {
        // Was a click, not a drag — toggle open/close + set focus
        const card = dragPending;
        const layerId = card.dataset.layer;
        // Skip sc3-layer-btn cards (text/3D) — they have their own click handler
        if (!card.classList.contains('sc3-layer-btn')) {
          card.classList.toggle('open');
        }
        document.querySelectorAll('.layer-card').forEach(c => c.classList.remove('focused'));
        card.classList.add('focused');
        focusedLayerId = layerId;
      }
      dragPending = null;
    });

    panel.addEventListener('pointercancel', () => {
      if (dragCard) {
        clearIndicators();
        dragCard.classList.remove('dragging');
        dragCard = null;
      }
      dragPending = null;
    });
  })();

  // ===== KEYBOARD SHORTCUTS =====
  document.addEventListener('keydown', (e) => {
    // Don't intercept when typing in inputs
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if (e.key === '1') { const l = getLayer('text'); if (l) { l.visible = !l.visible; updateLayerCardUI('text'); syncToggleSection('text', l.visible); } }
    if (e.key === '2') { const l = getLayer('shader'); if (l) { l.visible = !l.visible; updateLayerCardUI('shader'); } }
    if (e.key === '3') { const l = getLayer('scene'); if (l) { l.visible = !l.visible; updateLayerCardUI('scene'); syncToggleSection('scene', l.visible); } }
    if (e.key === '4') { const l = getLayer('overlay'); if (l) { l.visible = !l.visible; updateLayerCardUI('overlay'); } }
    if (e.key === 'Tab') {
      e.preventDefault();
      const ids = ['scene', 'shader', 'text', 'overlay'];
      const idx = ids.indexOf(focusedLayerId);
      focusedLayerId = ids[(idx + 1) % ids.length];
      document.querySelectorAll('.layer-card').forEach(c => c.classList.remove('focused'));
      const card = document.querySelector(`.layer-card[data-layer="${focusedLayerId}"]`);
      if (card) card.classList.add('focused');
    }
  });

  // ============================================================
  // WebSocket Client — connects to MCP server bridge
  // ============================================================

  // Only connect WS to localhost/LAN (NDI runs locally, Vercel is static)
  const _isLocalServer = location.hostname === 'localhost' || location.hostname === '127.0.0.1' || /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(location.hostname);
  if (_isLocalServer && location.protocol !== 'file:') {
    let ws = null;
    let reconnectTimer = null;

    function wsConnect() {
      const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
      ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';

      ws.onopen = async () => {
        if (reconnectTimer) { clearInterval(reconnectTimer); reconnectTimer = null; }
        _ndiWs = ws;
        // Auto-start NDI send on connect (or resume after disconnect)
        const shouldStart = _ndiAutoStartOnConnect || ndiSendingActive;
        if (shouldStart) {
          _ndiAutoStartOnConnect = false;
          // Reset state so startNdiSend's guard doesn't block the resume
          pauseNdiSend();
          ndiSendingActive = false;
          try {
            await ndiRequest(ws, 'ndi_send_start', { name: 'ShaderClaw', width: glCanvas.width, height: glCanvas.height });
            startNdiSend(ws, glCanvas);
            updateNdiUI();
          } catch (e) {
            console.warn('NDI auto-start failed:', e.message);
            updateNdiUI();
          }
        }
      };

      ws.onclose = () => {
        // Only act if this is still the active WS — prevents stale onclose
        // from killing a newer connection (race with bridge.attach closing old WS)
        if (_ndiWs !== ws) return;
        _ndiWs = null;
        // Pause capture loop but keep UI state — reconnect will resume
        if (ndiSendingActive) {
          pauseNdiSend();
        }
        if (!reconnectTimer) {
          reconnectTimer = setInterval(() => wsConnect(), 2000);
        }
      };

      ws.onerror = () => {};

      ws.onmessage = async (evt) => {
        // Handle binary NDI video frames from server
        if (evt.data instanceof ArrayBuffer) {
          const arr = new Uint8Array(evt.data);
          if (arr.length > 10 && arr[0] === FRAME_TYPE_NDI_VIDEO) {
            handleNdiVideoFrame(evt.data, isfRenderer.gl);
          }
          return;
        }

        let msg;
        try { msg = JSON.parse(evt.data); } catch { return; }

        // Check if this is a response to an NDI request (negative IDs)
        if (msg.id < 0) {
          const entry = ndiPending.get(msg.id);
          if (entry) {
            clearTimeout(entry.timer);
            ndiPending.delete(msg.id);
            if (msg.error) entry.reject(new Error(msg.error));
            else entry.resolve(msg.result);
          }
          return;
        }

        // Handle chat generation responses (no id — server-initiated)
        if (msg.action === 'chat_start' || msg.action === 'chat_chunk' || msg.action === 'chat_done' || msg.action === 'chat_error') {
          window.dispatchEvent(new CustomEvent('sc3-chat-event', { detail: msg }));
          return;
        }

        const { id, action, params } = msg;
        let result = null;
        let error = null;

        try {
          switch (action) {
            case 'load_shader': {
              const targetLayer = params.layerId || window.shaderClaw.getFocusedLayer();
              const compResult = window.shaderClaw.compileToLayer(targetLayer, params.code);
              result = {
                ok: compResult.ok,
                errors: compResult.errors || null,
                layer: targetLayer,
              };
              break;
            }

            case 'load_shader_file': {
              const targetLayer = params.layerId || 'shader';
              await window.shaderClaw.loadShaderFile(targetLayer, params.folder || 'shaders', params.file);
              result = {
                ok: window.shaderClaw.getErrors() === null,
                errors: window.shaderClaw.getErrors(),
                layer: targetLayer,
              };
              break;
            }

            case 'load_scene': {
              await window.shaderClaw.loadScene(params.folder, params.file);
              result = {
                ok: window.shaderClaw.getErrors() === null,
                errors: window.shaderClaw.getErrors(),
              };
              break;
            }

            case 'get_shader': {
              result = { code: window.shaderClaw.getSource() };
              break;
            }

            case 'set_parameter': {
              result = window.shaderClaw.setParameter(params.name, params.value);
              break;
            }

            case 'get_parameters': {
              result = { inputs: window.shaderClaw.getInputs() };
              break;
            }

            case 'screenshot': {
              const dataUrl = window.shaderClaw.screenshot();
              result = { dataUrl };
              break;
            }

            case 'get_errors': {
              const errs = window.shaderClaw.getErrors();
              result = { hasErrors: errs !== null, errors: errs };
              break;
            }

            case 'add_media': {
              result = await window.shaderClaw.addMedia(params.name, params.dataUrl);
              break;
            }

            case 'get_media': {
              result = { media: window.shaderClaw.getMedia() };
              break;
            }

            case 'remove_media': {
              result = window.shaderClaw.removeMedia(params.id);
              break;
            }

            case 'get_audio_levels': {
              result = window.shaderClaw.getAudioLevels();
              break;
            }

            case 'set_layer_visibility': {
              result = window.shaderClaw.setLayerVisibility(params.layerId, params.visible);
              break;
            }

            case 'set_layer_opacity': {
              result = window.shaderClaw.setLayerOpacity(params.layerId, params.opacity);
              break;
            }

            case 'enable_mediapipe': {
              result = await window.shaderClaw.enableMediaPipe(params.modes || { hand: true });
              break;
            }

            case 'set_custom_shader': {
              // Auto-load custom material scene if not already active
              if (!sceneRenderer.sceneDef || !sceneRenderer.sceneDef.setShader) {
                await window.shaderClaw.loadScene('scenes', 'custom_material.scene.js');
                getLayer('scene').visible = true;
                updateLayerCardUI('scene');
              }
              result = window.shaderClaw.setCustomShader(
                params.vertexShader,
                params.fragmentShader,
                params.uniforms
              );
              break;
            }

            default:
              error = `Unknown action: ${action}`;
          }
        } catch (e) {
          error = e.message;
        }

        ws.send(JSON.stringify({ id, result, error }));
      };
    }

    wsConnect();

    // NDI tile — open source picker
    document.getElementById('tile-ndi').addEventListener('click', () => {
      if (!_ndiWs || _ndiWs.readyState !== WebSocket.OPEN) {
        console.warn('NDI: WebSocket not connected yet');
        return;
      }
      ndiPicker.classList.add('visible');
      refreshNdiSources(_ndiWs);
    });

    document.getElementById('ndi-refresh-btn').addEventListener('click', () => {
      if (!_ndiWs || _ndiWs.readyState !== WebSocket.OPEN) return;
      refreshNdiSources(_ndiWs);
    });
  }

})().catch(e => {
  console.error('ShaderClaw init failed:', e);
  const bar = document.getElementById('error-bar');
  if (bar) {
    bar.innerHTML = 'Init failed: ' + e.message + ' — <a href="#" onclick="location.reload();return false" style="color:var(--accent);text-decoration:underline">Retry</a>';
    bar.classList.add('show');
  }
});

// Release WebGL contexts on page unload to prevent browser context exhaustion
window.addEventListener('beforeunload', () => {
  // Release ISF renderer context
  const c = document.getElementById('gl-canvas');
  if (c) {
    const gl = c.getContext('webgl');
    if (gl) { const ext = gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); }
  }
  // Release Three.js canvas context
  const tc = document.getElementById('three-canvas');
  if (tc) {
    const gl2 = tc.getContext('webgl');
    if (gl2) { const ext = gl2.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); }
  }
});
