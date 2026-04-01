// ============================================================
// ShaderClaw — WebXR Manager (Vision Pro 360 Immersive)
// ============================================================

// Map WebXR 25 joints → MediaPipe 21 landmarks
const XR_TO_MP = [
  0,            // 0: wrist
  1, 2, 3, 4,   // 1-4: thumb (metacarpal, proximal, distal, tip)
  6, 7, 8, 9,   // 5-8: index (proximal, intermediate, distal, tip)
  11, 12, 13, 14, // 9-12: middle
  16, 17, 18, 19, // 13-16: ring
  21, 22, 23, 24, // 17-20: pinky
];

class XRManager {
  constructor(renderer, mediaPipeMgr, bus) {
    this.renderer = renderer;
    this.mp = mediaPipeMgr;
    this.bus = bus;
    this.gl = renderer.gl;
    this.active = false;
    this.session = null;
    this.refSpace = null;
    this.xrLayer = null;
    this.compFBO = null;
    this._frameCount = 0;

    // Sphere rendering resources
    this._sphereProg = null;
    this._sphereVBO = null;
    this._sphereIBO = null;
    this._sphereIndexCount = 0;
    this._sphereUVPLoc = null;
    this._sphereTexLoc = null;
  }

  async checkSupport() {
    if (!navigator.xr) return false;
    try {
      return await navigator.xr.isSessionSupported('immersive-vr');
    } catch {
      return false;
    }
  }

  async enter() {
    if (this.active) return;
    const gl = this.gl;
    console.log('[XR] Entering immersive mode...');

    // Request immersive session FIRST (before makeXRCompatible which can cause context loss)
    this.session = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['hand-tracking']
    });
    console.log('[XR] Session created');

    // Make GL context XR-compatible — skip if it causes problems
    // Safari on visionOS typically doesn't need this call
    // If XRWebGLLayer constructor fails without it, we'll catch below
    try {
      await gl.makeXRCompatible();
      console.log('[XR] GL context is XR-compatible');
    } catch (e) {
      console.warn('[XR] makeXRCompatible skipped:', e);
    }

    // Wait a frame for any context restore to settle
    await new Promise(r => requestAnimationFrame(r));

    // If context was lost and restored, update our GL reference
    this.gl = this.renderer.gl;

    // Create XR layer from existing GL context
    try {
      this.xrLayer = new XRWebGLLayer(this.session, this.gl);
    } catch (e) {
      console.error('[XR] XRWebGLLayer creation failed:', e);
      this.session.end();
      this.session = null;
      return;
    }
    this.session.updateRenderState({ baseLayer: this.xrLayer });
    console.log('[XR] XRWebGLLayer created, size:',
      this.xrLayer.framebufferWidth, 'x', this.xrLayer.framebufferHeight);

    // Get reference space
    this.refSpace = await this.session.requestReferenceSpace('local');
    console.log('[XR] Reference space acquired');

    // Create FBO to capture compositor output AFTER any context restore
    const w = Math.max(this.renderer.canvas.width, 960);
    const h = Math.max(this.renderer.canvas.height, 540);
    this.compFBO = this.renderer.createFBO(w, h);
    console.log('[XR] Compositor FBO created:', w, 'x', h);

    // Build sphere geometry + shaders AFTER context is stable
    this._initSphere();

    this.active = true;
    this._frameCount = 0;

    this.session.addEventListener('end', () => {
      console.log('[XR] Session ended');
      this.active = false;
      this.session = null;
      this.xrLayer = null;
      this.bus.emit('xr:exit');
    });

    // Kick-start the XR render loop
    this.session.requestAnimationFrame((t, frame) => {
      console.log('[XR] First XR frame received');
      this.bus.emit('xr:frame', { time: t, frame: frame });
    });

    this.bus.emit('xr:enter');
    console.log('[XR] Immersive mode active');
  }

  exit() {
    if (this.session) {
      this.session.end();
    }
  }

  // Build a UV sphere (inside-out) and compile the sphere shader
  _initSphere() {
    const gl = this.gl;
    const latBands = 48;
    const lonBands = 64;
    const radius = 100.0;
    const verts = [];
    const indices = [];

    for (let lat = 0; lat <= latBands; lat++) {
      const theta = (lat * Math.PI) / latBands;
      const sinT = Math.sin(theta);
      const cosT = Math.cos(theta);
      for (let lon = 0; lon <= lonBands; lon++) {
        const phi = (lon * 2 * Math.PI) / lonBands;
        const x = sinT * Math.cos(phi) * radius;
        const y = cosT * radius;
        const z = sinT * Math.sin(phi) * radius;
        const u = lon / lonBands;
        const v = lat / latBands;
        verts.push(x, y, z, u, v);
      }
    }

    // Triangle indices — CCW winding viewed from inside
    for (let lat = 0; lat < latBands; lat++) {
      for (let lon = 0; lon < lonBands; lon++) {
        const a = lat * (lonBands + 1) + lon;
        const b = a + lonBands + 1;
        indices.push(a, b, a + 1);
        indices.push(a + 1, b, b + 1);
      }
    }

    this._sphereIndexCount = indices.length;
    console.log('[XR] Sphere: verts=' + (verts.length / 5) + ' indices=' + indices.length);

    this._sphereVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._sphereVBO);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);

    this._sphereIBO = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._sphereIBO);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);

    // Sphere shader — renders compositor texture onto inside of sphere
    const vsSource = [
      'attribute vec3 aPosition;',
      'attribute vec2 aUV;',
      'uniform mat4 uViewProjection;',
      'varying vec2 vUV;',
      'void main() {',
      '  vUV = aUV;',
      '  gl_Position = uViewProjection * vec4(aPosition, 1.0);',
      '}',
    ].join('\n');

    const fsSource = [
      'precision mediump float;',
      'uniform sampler2D uTex;',
      'varying vec2 vUV;',
      'void main() {',
      '  vec2 uv = vec2(1.0 - vUV.x, vUV.y);',
      '  gl_FragColor = texture2D(uTex, uv);',
      '}',
    ].join('\n');

    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, vsSource);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      console.error('[XR] Sphere VS error:', gl.getShaderInfoLog(vs));
      return;
    }

    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fsSource);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      console.error('[XR] Sphere FS error:', gl.getShaderInfoLog(fs));
      return;
    }

    this._sphereProg = gl.createProgram();
    gl.attachShader(this._sphereProg, vs);
    gl.attachShader(this._sphereProg, fs);
    gl.bindAttribLocation(this._sphereProg, 0, 'aPosition');
    gl.bindAttribLocation(this._sphereProg, 1, 'aUV');
    gl.linkProgram(this._sphereProg);
    if (!gl.getProgramParameter(this._sphereProg, gl.LINK_STATUS)) {
      console.error('[XR] Sphere program link error:', gl.getProgramInfoLog(this._sphereProg));
      return;
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    this._sphereUVPLoc = gl.getUniformLocation(this._sphereProg, 'uViewProjection');
    this._sphereTexLoc = gl.getUniformLocation(this._sphereProg, 'uTex');
    console.log('[XR] Sphere shader compiled OK, uVP:', this._sphereUVPLoc, 'uTex:', this._sphereTexLoc);
  }

  // Called per XR frame after compositionLoop has rendered to compFBO
  onFrame(time, frame) {
    if (!this.active || !this.session) return;
    if (!this._sphereProg || !this._sphereVBO || !this._sphereIBO || !this.compFBO) {
      if (this._frameCount < 5) console.warn('[XR] Missing GL resources, reinitializing...');
      try { this._initSphere(); } catch(e) { console.error('[XR] reinit failed:', e); }
      if (!this.compFBO) {
        const w = Math.max(this.renderer.canvas.width, 960);
        const h = Math.max(this.renderer.canvas.height, 540);
        this.compFBO = this.renderer.createFBO(w, h);
      }
      this._frameCount++;
      return;
    }
    const gl = this.gl;
    if (gl.isContextLost()) return;
    const pose = frame.getViewerPose(this.refSpace);
    if (!pose) {
      if (this._frameCount < 5) console.warn('[XR] No viewer pose on frame', this._frameCount);
      this._frameCount++;
      return;
    }

    if (this._frameCount < 5) {
      console.log('[XR] Frame', this._frameCount, 'views:', pose.views.length,
        'compFBO tex:', this.compFBO?.texture);
    }

    // Map head orientation to mousePos
    this._mapGazeToMouse(pose);

    // Process hand tracking
    this._processHands(frame);

    // Render sphere to each eye
    const glLayer = this.xrLayer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, glLayer.framebuffer);

    for (const view of pose.views) {
      const vp = glLayer.getViewport(view);
      gl.viewport(vp.x, vp.y, vp.width, vp.height);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      if (this._frameCount < 3) {
        console.log('[XR] View viewport:', vp.x, vp.y, vp.width, vp.height);
      }

      // Compute viewProjection = projection * view
      const viewMat = view.transform.inverse.matrix;
      const projMat = view.projectionMatrix;
      const vpMat = this._mat4Multiply(projMat, viewMat);

      // Draw the textured sphere
      gl.useProgram(this._sphereProg);
      gl.uniformMatrix4fv(this._sphereUVPLoc, false, vpMat);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.compFBO.texture);
      gl.uniform1i(this._sphereTexLoc, 0);

      // Bind sphere VBO (interleaved: x,y,z,u,v = 20 bytes stride)
      gl.bindBuffer(gl.ARRAY_BUFFER, this._sphereVBO);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);

      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._sphereIBO);

      // Render inside of sphere: disable culling so both faces draw
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.drawElements(gl.TRIANGLES, this._sphereIndexCount, gl.UNSIGNED_SHORT, 0);
    }

    // Restore GL state
    gl.disableVertexAttribArray(1);
    gl.enable(gl.DEPTH_TEST);
    this._frameCount++;
  }

  _mapGazeToMouse(pose) {
    const m = pose.transform.matrix;
    const fx = -m[8], fy = -m[9], fz = -m[10];
    const yaw = Math.atan2(fx, -fz);
    this.renderer.mousePos[0] = (yaw / Math.PI) * 0.5 + 0.5;
    const pitch = Math.asin(Math.max(-1, Math.min(1, fy)));
    this.renderer.mousePos[1] = (-pitch / (Math.PI / 2)) * 0.5 + 0.5;
  }

  _processHands(frame) {
    if (!this.mp) return;
    let handCount = 0;

    for (const source of this.session.inputSources) {
      if (!source.hand) continue;
      if (handCount >= 2) break;

      const joints = [];
      let ok = true;
      for (let j = 0; j < 25; j++) {
        const space = source.hand.get(j);
        if (!space) { ok = false; break; }
        const pose = frame.getJointPose(space, this.refSpace);
        if (!pose) { ok = false; break; }
        joints.push(pose.transform.position);
      }
      if (!ok || joints.length < 25) continue;

      const landmarks = [];
      for (let i = 0; i < 21; i++) {
        const pos = joints[XR_TO_MP[i]];
        landmarks.push({
          x: pos.x * 0.5 + 0.5,
          y: 1.0 - (pos.y * 0.5),
          z: pos.z
        });
      }

      const center = landmarks[9];
      if (handCount === 0) {
        this.mp.handPos = [center.x, center.y, center.z];
        this.mp._lastHandLandmarks = landmarks;
        const thumb = landmarks[4], idx = landmarks[8];
        const d = Math.hypot(thumb.x - idx.x, thumb.y - idx.y, thumb.z - idx.z);
        const was = this.mp.isPinching;
        this.mp.isPinching = d < 0.05;
        this.mp.pinchPos = [(thumb.x + idx.x) / 2, (thumb.y + idx.y) / 2];
        if (this.mp.isPinching && !was) {
          this.mp._pinchStartPos = [...this.mp.pinchPos];
          this.mp._pinchAccumX = 0;
          this.mp._pinchAccumY = 0;
        }
        if (this.mp.isPinching && this.mp._pinchStartPos) {
          const last = this.mp._lastPinchPos || this.mp.pinchPos;
          this.mp._pinchAccumX += (this.mp.pinchPos[0] - last[0]) * Math.PI * 4;
          this.mp._pinchAccumY += (this.mp.pinchPos[1] - last[1]) * Math.PI * 4;
        }
        this.mp._lastPinchPos = [...this.mp.pinchPos];
      } else {
        this.mp.handPos2 = [center.x, center.y, center.z];
        this.mp._lastHandLandmarks2 = landmarks;
        const t2 = landmarks[4], i2 = landmarks[8];
        this.mp.isPinching2 = Math.hypot(t2.x - i2.x, t2.y - i2.y, t2.z - i2.z) < 0.05;
      }
      handCount++;
    }

    this.mp.handCount = handCount;
    if (handCount > 0) {
      this.mp.active = true;
      this.mp.modes.hand = true;
      if (this.mp.handTex) {
        const data = new Uint8Array(42 * 4);
        for (let h = 0; h < Math.min(2, handCount); h++) {
          const lm = h === 0 ? this.mp._lastHandLandmarks : this.mp._lastHandLandmarks2;
          if (!lm) continue;
          for (let i = 0; i < 21; i++) {
            const off = (h * 21 + i) * 4;
            data[off] = Math.round(lm[i].x * 255);
            data[off + 1] = Math.round(lm[i].y * 255);
            data[off + 2] = Math.round((lm[i].z + 0.5) * 255);
            data[off + 3] = 255;
          }
        }
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, this.mp.handTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 42, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      }
    } else {
      this.mp.handPos = [0, 0, 0];
      this.mp.handPos2 = [0, 0, 0];
      this.mp.isPinching = false;
      this.mp.isPinching2 = false;
    }
    this.renderer.mouseDown = this.mp.isPinching ? 1 : 0;
  }

  _mat4Multiply(a, b) {
    const out = new Float32Array(16);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        out[j * 4 + i] =
          a[0 * 4 + i] * b[j * 4 + 0] +
          a[1 * 4 + i] * b[j * 4 + 1] +
          a[2 * 4 + i] * b[j * 4 + 2] +
          a[3 * 4 + i] * b[j * 4 + 3];
      }
    }
    return out;
  }
}
