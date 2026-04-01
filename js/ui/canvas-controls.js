// Canvas Controls — viewport overlay buttons

import { state, emit } from '../state.js';

export function initCanvasControls(viewportEl) {
  const controls = document.createElement('div');
  controls.className = 'canvas-controls';

  // Play/Pause
  const playBtn = document.createElement('button');
  playBtn.className = 'canvas-btn';
  playBtn.id = 'play-btn';
  playBtn.textContent = '\u23F8';
  playBtn.title = 'Play/Pause (Space)';
  playBtn.addEventListener('click', () => {
    state.playing = !state.playing;
    playBtn.textContent = state.playing ? '\u23F8' : '\u25B6';
    emit('play:toggle', { playing: state.playing });
  });
  controls.appendChild(playBtn);

  // Fullscreen
  const fsBtn = document.createElement('button');
  fsBtn.className = 'canvas-btn';
  fsBtn.textContent = '\u26F6';
  fsBtn.title = 'Fullscreen (F)';
  fsBtn.addEventListener('click', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      viewportEl.requestFullscreen();
    }
  });
  controls.appendChild(fsBtn);

  // XR Immersive (shown only when WebXR available)
  const xrBtn = document.createElement('button');
  xrBtn.className = 'canvas-btn';
  xrBtn.id = 'xr-btn';
  xrBtn.textContent = 'VR';
  xrBtn.title = 'Enter 360 Immersive Mode';
  xrBtn.style.display = 'none';
  xrBtn.addEventListener('click', () => emit('xr:toggle'));
  controls.appendChild(xrBtn);

  // Screenshot
  const shotBtn = document.createElement('button');
  shotBtn.className = 'canvas-btn';
  shotBtn.textContent = '\u{1F4F7}';
  shotBtn.title = 'Screenshot (Ctrl+Shift+S)';
  shotBtn.addEventListener('click', () => {
    const canvas = viewportEl.querySelector('#gl-canvas');
    if (canvas) {
      const link = document.createElement('a');
      link.download = 'shaderclaw.png';
      link.href = canvas.toDataURL('image/png');
      link.click();
    }
  });
  controls.appendChild(shotBtn);

  viewportEl.appendChild(controls);

  // Error bar
  const errorBar = document.createElement('div');
  errorBar.id = 'error-bar';
  errorBar.className = 'error-bar';
  viewportEl.appendChild(errorBar);

  return { playBtn, errorBar };
}

export function showError(errorBar, msg) {
  if (!errorBar) return;
  if (msg) {
    errorBar.textContent = msg;
    errorBar.style.display = 'block';
  } else {
    errorBar.style.display = 'none';
    errorBar.textContent = '';
  }
}
