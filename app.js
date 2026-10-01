(() => {
  'use strict';

  const FONT = 'system-ui, "Segoe UI", Roboto, sans-serif';
  const LINE_HEIGHT = 1.25;
  const STORAGE_KEY = 'whiteboard.v1';
  const MAX_HISTORY = 100;
  const MIN_SCALE = 0.1;
  const MAX_SCALE = 8;
  const FREEHAND = ['pen', 'highlighter', 'eraser'];
  const SHAPES = ['line', 'arrow', 'rect', 'ellipse'];

  const $ = (sel) => document.querySelector(sel);
  const board = $('#board');
  const gridCanvas = $('#grid');
  const canvas = $('#canvas');
  const gctx = gridCanvas.getContext('2d');
  const ctx = canvas.getContext('2d');

  const state = { tool: 'pen', color: '#1e1e1e', size: 4, fill: false };
  let shapes = [];
  let undoStack = [];
  let redoStack = [];
  let view = { x: 0, y: 0, scale: 1 };
  let dpr = window.devicePixelRatio || 1;

  let current = null;        // shape being drawn
  let activePointer = null;  // pointer id driving the current gesture
  let panning = null;
  let spaceDown = false;
  let textEditor = null;
  let rafId = 0;
  let saveTimer = 0;

  // ---------- Coordinates ----------

  function toWorld(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    return {
      x: (clientX - r.left - view.x) / view.scale,
      y: (clientY - r.top - view.y) / view.scale,
    };
  }

  const round = (n) => Math.round(n * 10) / 10;

  // ---------- Rendering ----------

  function resize() {
    dpr = window.devicePixelRatio || 1;
    const w = board.clientWidth;
    const h = board.clientHeight;
    for (const c of [gridCanvas, canvas]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      c.style.width = w + 'px';
      c.style.height = h + 'px';
    }
    render();
  }

  function scheduleRender() {
    if (!rafId) rafId = requestAnimationFrame(() => { rafId = 0; render(); });
  }

  function render() {
    drawGrid();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.x, dpr * view.y);
    for (const s of shapes) drawShape(ctx, s);
    if (current) drawShape(ctx, current);
    $('#zoomPct').textContent = Math.round(view.scale * 100) + '%';
  }

  function drawGrid() {
    const w = gridCanvas.width / dpr;
    const h = gridCanvas.height / dpr;
    gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    gctx.clearRect(0, 0, w, h);

    let step = 24 * view.scale;
    while (step < 14) step *= 2;
    while (step > 64) step /= 2;

    const ox = ((view.x % step) + step) % step;
    const oy = ((view.y % step) + step) % step;
    gctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--dot').trim() || '#cdd2da';
    for (let x = ox; x < w; x += step) {
      for (let y = oy; y < h; y += step) {
        gctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
      }
    }
  }

  function drawShape(c, s) {
    c.save();
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.strokeStyle = s.color;
    c.fillStyle = s.color;
    c.lineWidth = s.size;

    switch (s.type) {
      case 'pen':
        drawStroke(c, s.points);
        break;
      case 'highlighter':
        c.globalAlpha = 0.35;
        drawStroke(c, s.points);
        break;
      case 'eraser':
        c.globalCompositeOperation = 'destination-out';
        drawStroke(c, s.points);
        break;
      case 'line':
        c.beginPath();
        c.moveTo(s.x1, s.y1);
        c.lineTo(s.x2, s.y2);
        c.stroke();
        break;
      case 'arrow': {
        const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
        const head = Math.max(10, s.size * 3);
        c.beginPath();
        c.moveTo(s.x1, s.y1);
        c.lineTo(s.x2, s.y2);
        c.moveTo(s.x2 - head * Math.cos(angle - Math.PI / 6), s.y2 - head * Math.sin(angle - Math.PI / 6));
        c.lineTo(s.x2, s.y2);
        c.lineTo(s.x2 - head * Math.cos(angle + Math.PI / 6), s.y2 - head * Math.sin(angle + Math.PI / 6));
        c.stroke();
        break;
      }
      case 'rect':
        c.beginPath();
        c.rect(Math.min(s.x1, s.x2), Math.min(s.y1, s.y2), Math.abs(s.x2 - s.x1), Math.abs(s.y2 - s.y1));
        fillAndStroke(c, s);
        break;
      case 'ellipse':
        c.beginPath();
        c.ellipse((s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2, Math.abs(s.x2 - s.x1) / 2, Math.abs(s.y2 - s.y1) / 2, 0, 0, Math.PI * 2);
        fillAndStroke(c, s);
        break;
      case 'text': {
        const lh = s.fontSize * LINE_HEIGHT;
        c.font = `${s.fontSize}px ${FONT}`;
        c.textBaseline = 'middle';
        s.text.split('\n').forEach((line, i) => c.fillText(line, s.x, s.y + i * lh + lh / 2));
        break;
      }
    }
    c.restore();
  }

  function fillAndStroke(c, s) {
    if (s.fill) {
      c.globalAlpha = 0.2;
      c.fill();
      c.globalAlpha = 1;
    }
    c.stroke();
  }

  // Smooth freehand path using quadratic curves through midpoints.
  function drawStroke(c, pts) {
    if (pts.length === 1) {
      c.beginPath();
      c.arc(pts[0].x, pts[0].y, c.lineWidth / 2, 0, Math.PI * 2);
      c.fill();
      return;
    }
    c.beginPath();
    c.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      c.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    const last = pts[pts.length - 1];
    c.lineTo(last.x, last.y);
    c.stroke();
  }

  // ---------- History & persistence ----------

  function commit(next) {
    undoStack.push(shapes);
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack = [];
    shapes = next;
    afterChange();
  }

  function undo() {
    if (!undoStack.length) return;
    redoStack.push(shapes);
    shapes = undoStack.pop();
    afterChange();
  }

  function redo() {
    if (!redoStack.length) return;
    undoStack.push(shapes);
    shapes = redoStack.pop();
    afterChange();
  }

  function afterChange() {
    $('#undo').disabled = !undoStack.length;
    $('#redo').disabled = !redoStack.length;
    scheduleRender();
    scheduleSave();
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ shapes, view }));
      } catch {
        toast('Could not save — browser storage is full or unavailable');
      }
    }, 300);
  }

  function load() {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (data && Array.isArray(data.shapes)) shapes = data.shapes;
      if (data && data.view && data.view.scale) view = data.view;
    } catch { /* start with an empty board */ }
  }

  // ---------- Pointer input ----------

  canvas.addEventListener('pointerdown', (e) => {
    if (textEditor) { textEditor.blur(); return; }
    if (activePointer !== null) return;

    if (e.button === 1 || (e.button === 0 && (state.tool === 'hand' || spaceDown))) {
      e.preventDefault();
      activePointer = e.pointerId;
      canvas.setPointerCapture(e.pointerId);
      panning = { sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
      board.classList.add('grabbing');
      return;
    }
    if (e.button !== 0) return;

    const p = toWorld(e.clientX, e.clientY);

    if (state.tool === 'text') {
      e.preventDefault();
      openTextEditor(p);
      return;
    }

    activePointer = e.pointerId;
    canvas.setPointerCapture(e.pointerId);
    const pt = { x: round(p.x), y: round(p.y) };

    if (FREEHAND.includes(state.tool)) {
      const size = state.tool === 'highlighter' ? state.size * 3
        : state.tool === 'eraser' ? state.size * 4
        : state.size;
      current = { type: state.tool, color: state.color, size, points: [pt] };
    } else if (SHAPES.includes(state.tool)) {
      current = {
        type: state.tool, color: state.color, size: state.size, fill: state.fill,
        x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y,
      };
    }
    scheduleRender();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== activePointer) return;

    if (panning) {
      view.x = panning.vx + e.clientX - panning.sx;
      view.y = panning.vy + e.clientY - panning.sy;
      scheduleRender();
      return;
    }
    if (!current) return;

    if (current.points) {
      const events = (e.getCoalescedEvents && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
      const minDist = 0.75 / view.scale;
      for (const ev of events) {
        const p = toWorld(ev.clientX, ev.clientY);
        const last = current.points[current.points.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) >= minDist) {
          current.points.push({ x: round(p.x), y: round(p.y) });
        }
      }
    } else {
      updateShapeEnd(current, toWorld(e.clientX, e.clientY), e.shiftKey);
    }
    scheduleRender();
  });

  function updateShapeEnd(s, p, shift) {
    let x2 = p.x;
    let y2 = p.y;
    if (shift) {
      const dx = p.x - s.x1;
      const dy = p.y - s.y1;
      if (s.type === 'rect' || s.type === 'ellipse') {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        x2 = s.x1 + Math.sign(dx || 1) * d;
        y2 = s.y1 + Math.sign(dy || 1) * d;
      } else {
        const step = Math.PI / 4;
        const angle = Math.round(Math.atan2(dy, dx) / step) * step;
        const len = Math.hypot(dx, dy);
        x2 = s.x1 + len * Math.cos(angle);
        y2 = s.y1 + len * Math.sin(angle);
      }
    }
    s.x2 = round(x2);
    s.y2 = round(y2);
  }

  function endGesture(e) {
    if (e.pointerId !== activePointer) return;
    activePointer = null;

    if (panning) {
      panning = null;
      board.classList.remove('grabbing');
      scheduleSave();
      return;
    }
    if (!current) return;

    const s = current;
    current = null;
    const degenerate = !s.points && s.x1 === s.x2 && s.y1 === s.y2;
    if (degenerate || e.type === 'pointercancel') scheduleRender();
    else commit([...shapes, s]);
  }

  canvas.addEventListener('pointerup', endGesture);
  canvas.addEventListener('pointercancel', endGesture);

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (textEditor) textEditor.blur();
    const r = canvas.getBoundingClientRect();
    // Normalise line/page deltas so mice and trackpads feel similar.
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    zoomAt(Math.exp(-delta * 0.0015), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  function zoomAt(factor, cx, cy) {
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
    const k = scale / view.scale;
    view.x = cx - (cx - view.x) * k;
    view.y = cy - (cy - view.y) * k;
    view.scale = scale;
    scheduleRender();
    scheduleSave();
  }

  function zoomCenter(factor) {
    zoomAt(factor, board.clientWidth / 2, board.clientHeight / 2);
  }

  function resetView() {
    view = { x: 0, y: 0, scale: 1 };
    scheduleRender();
    scheduleSave();
  }

  // ---------- Text tool ----------

  function openTextEditor(p) {
    const fontSize = Math.max(12, state.size * 4);
    const color = state.color;
    const ta = document.createElement('textarea');
    ta.className = 'text-editor';
    ta.spellcheck = false;
    ta.rows = 1;
    ta.style.left = p.x * view.scale + view.x + 'px';
    ta.style.top = p.y * view.scale + view.y + 'px';
    ta.style.fontSize = fontSize * view.scale + 'px';
    ta.style.color = color;
    board.appendChild(ta);
    textEditor = ta;

    const autosize = () => {
      ta.style.width = '0';
      ta.style.height = '0';
      ta.style.width = ta.scrollWidth + fontSize * view.scale + 'px';
      ta.style.height = ta.scrollHeight + 'px';
    };
    autosize();
    ta.addEventListener('input', autosize);

    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) ta.blur();
    });

    ta.addEventListener('blur', () => {
      const text = ta.value.replace(/\s+$/, '');
      ta.remove();
      textEditor = null;
      if (text.trim()) commit([...shapes, { type: 'text', x: round(p.x), y: round(p.y), text, color, fontSize }]);
    });

    setTimeout(() => ta.focus(), 0);
  }

  // ---------- Export ----------

  const measureCtx = document.createElement('canvas').getContext('2d');

  function bounds(s) {
    if (s.points) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of s.points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      const pad = s.size / 2;
      return [minX - pad, minY - pad, maxX + pad, maxY + pad];
    }
    if (s.type === 'text') {
      measureCtx.font = `${s.fontSize}px ${FONT}`;
      const lines = s.text.split('\n');
      const w = Math.max(...lines.map((l) => measureCtx.measureText(l).width));
      return [s.x, s.y, s.x + w, s.y + lines.length * s.fontSize * LINE_HEIGHT];
    }
    const pad = s.size + (s.type === 'arrow' ? Math.max(10, s.size * 3) : 0);
    return [
      Math.min(s.x1, s.x2) - pad, Math.min(s.y1, s.y2) - pad,
      Math.max(s.x1, s.x2) + pad, Math.max(s.y1, s.y2) + pad,
    ];
  }

  function exportPNG() {
    const visible = shapes.filter((s) => s.type !== 'eraser');
    if (!visible.length) { toast('Nothing to export yet'); return; }

    let [minX, minY, maxX, maxY] = bounds(visible[0]);
    for (const s of visible.slice(1)) {
      const b = bounds(s);
      minX = Math.min(minX, b[0]);
      minY = Math.min(minY, b[1]);
      maxX = Math.max(maxX, b[2]);
      maxY = Math.max(maxY, b[3]);
    }

    const pad = 32;
    const w = maxX - minX + pad * 2;
    const h = maxY - minY + pad * 2;
    const scale = Math.min(2, Math.sqrt(16e6 / (w * h)));  // stay under browser canvas limits

    // Draw ink on a transparent layer so eraser strokes don't punch through the background.
    const layer = document.createElement('canvas');
    layer.width = Math.ceil(w * scale);
    layer.height = Math.ceil(h * scale);
    const lc = layer.getContext('2d');
    lc.setTransform(scale, 0, 0, scale, (pad - minX) * scale, (pad - minY) * scale);
    for (const s of shapes) drawShape(lc, s);

    const out = document.createElement('canvas');
    out.width = layer.width;
    out.height = layer.height;
    const oc = out.getContext('2d');
    oc.fillStyle = '#ffffff';
    oc.fillRect(0, 0, out.width, out.height);
    oc.drawImage(layer, 0, 0);

    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const a = document.createElement('a');
    a.download = `whiteboard-${stamp}.png`;
    a.href = out.toDataURL('image/png');
    a.click();
    toast('Exported PNG');
  }

  // ---------- UI ----------

  function setTool(tool) {
    state.tool = tool;
    board.dataset.tool = tool;
    document.querySelectorAll('[data-tool]').forEach((b) => {
      if (b !== board) b.classList.toggle('active', b.dataset.tool === tool);
    });
  }

  function setColor(color, swatch) {
    state.color = color;
    document.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('active', s === swatch));
  }

  function setSize(size) {
    state.size = Math.min(40, Math.max(1, size));
    $('#size').value = state.size;
    $('#sizeValue').textContent = state.size;
  }

  function toggleFill() {
    state.fill = !state.fill;
    const btn = $('#fillToggle');
    btn.classList.toggle('active', state.fill);
    btn.setAttribute('aria-pressed', String(state.fill));
  }

  function clearBoard() {
    if (!shapes.length) return;
    commit([]);
    toast('Board cleared — Ctrl+Z to undo');
  }

  let toastTimer = 0;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  $('#tools').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tool]');
    if (btn) setTool(btn.dataset.tool);
  });

  $('#colors').addEventListener('click', (e) => {
    const sw = e.target.closest('.swatch[data-color]');
    if (sw) setColor(sw.dataset.color, sw);
  });

  $('#customColor').addEventListener('input', (e) => {
    const label = e.target.parentElement;
    label.style.setProperty('--c', e.target.value);
    setColor(e.target.value, label);
  });

  $('#size').addEventListener('input', (e) => setSize(Number(e.target.value)));
  $('#fillToggle').addEventListener('click', toggleFill);
  $('#undo').addEventListener('click', undo);
  $('#redo').addEventListener('click', redo);
  $('#clear').addEventListener('click', clearBoard);
  $('#export').addEventListener('click', exportPNG);
  $('#zoomIn').addEventListener('click', () => zoomCenter(1.2));
  $('#zoomOut').addEventListener('click', () => zoomCenter(1 / 1.2));
  $('#zoomPct').addEventListener('click', resetView);

  const help = $('#help');
  $('#helpBtn').addEventListener('click', () => { help.hidden = !help.hidden; });

  // ---------- Keyboard ----------

  const TOOL_KEYS = { h: 'hand', p: 'pen', m: 'highlighter', e: 'eraser', l: 'line', a: 'arrow', r: 'rect', o: 'ellipse', t: 'text' };

  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    const key = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;

    if (mod && key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && key === 'y') { e.preventDefault(); redo(); return; }
    if (mod && key === 's') { e.preventDefault(); exportPNG(); return; }
    if (mod || e.altKey) return;

    if (e.key === ' ') {
      e.preventDefault();
      if (!spaceDown) { spaceDown = true; board.classList.add('space'); }
      return;
    }
    if (e.key === 'Escape') {
      if (current) { current = null; activePointer = null; scheduleRender(); }
      help.hidden = true;
      return;
    }
    if (TOOL_KEYS[key]) { setTool(TOOL_KEYS[key]); return; }
    if (key === 'f') { toggleFill(); return; }
    if (e.key === '[') { setSize(state.size - 1); return; }
    if (e.key === ']') { setSize(state.size + 1); return; }
    if (e.key === '+' || e.key === '=') { zoomCenter(1.2); return; }
    if (e.key === '-' || e.key === '_') { zoomCenter(1 / 1.2); return; }
    if (e.key === '0') { resetView(); return; }
    if (e.key === '?') { help.hidden = !help.hidden; }
  });

  window.addEventListener('keyup', (e) => {
    if (e.key === ' ') { spaceDown = false; board.classList.remove('space'); }
  });

  window.addEventListener('blur', () => { spaceDown = false; board.classList.remove('space'); });
  window.addEventListener('resize', resize);

  // ---------- Init ----------

  load();
  setTool(state.tool);
  setSize(state.size);
  resize();
})();
