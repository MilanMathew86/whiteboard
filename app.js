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
  const MAX_IMAGE_DIM = 1600;  // px; larger uploads are downscaled to keep autosave small
  const HANDLE_SIZE = 10;      // screen px
  const STABILIZE = 0.45;      // 0..1 — how far each freehand sample moves toward the raw pointer
  const REPLAY_IDLE_CAP = 2000;   // ms; longer pauses between actions are squashed to this
  const REPLAY_LEAD_IN = 400;     // ms of empty board before the first action
  const REPLAY_TAIL = 800;        // ms the finished board stays up at the end
  const REPLAY_SHAPE_MS = 300;    // ms a line/arrow/rect/ellipse takes to grow
  const API_KEY_STORAGE = 'whiteboard.anthropicKey';  // kept apart from the board save
  const INK = ['pen', 'highlighter'];  // what the lasso selects
  const CAPTURE_PAD = 24;         // px of white around a captured selection
  const CAPTURE_MAX_SIDE = 1568;  // px; long edge of a capture (a good size for Claude's vision)

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
  let smoothed = { x: 0, y: 0 };  // stabilised pointer position for the current freehand stroke
  let selectedId = null;    // id of the selected image (select tool)
  let drag = null;           // { mode: 'move' | 'resize', orig, start, shape }
  const imageCache = new Map();
  let lasso = null;          // loop being drawn with the lasso tool: { points }
  let lassoSelection = [];   // ink strokes selected by the last lasso
  let replay = null;         // open replay session, see the Replay section
  let replaySpeed = 1;
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
    if (replay) {
      // During a replay the board shows the replayed frame instead of the live shapes.
      for (const s of frameAt(replay.time)) drawShape(ctx, s);
    } else {
      for (const s of shapes) drawShape(ctx, drag && s.id === drag.orig.id ? drag.shape : s);
      if (current) drawShape(ctx, current);
      drawSelection();
      drawLasso();
    }
    positionLassoMenu();
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
      case 'image': {
        const img = getImage(s.src);
        if (img.complete && img.naturalWidth) {
          c.drawImage(img, s.x, s.y, s.w, s.h);
        } else {
          c.fillStyle = '#e9ecef';
          c.fillRect(s.x, s.y, s.w, s.h);
        }
        break;
      }
    }
    c.restore();
  }

  function getImage(src) {
    let img = imageCache.get(src);
    if (!img) {
      img = new Image();
      img.onload = scheduleRender;
      img.src = src;
      imageCache.set(src, img);
    }
    return img;
  }

  function selectedShape() {
    if (!selectedId) return null;
    if (drag && drag.orig.id === selectedId) return drag.shape;
    return shapes.find((s) => s.id === selectedId) || null;
  }

  function drawSelection() {
    const s = selectedShape();
    if (!s) return;
    const px = 1 / view.scale;  // one screen pixel in world units
    const hs = HANDLE_SIZE * px;
    ctx.save();
    ctx.strokeStyle = '#4f46e5';
    ctx.lineWidth = 1.5 * px;
    ctx.strokeRect(s.x, s.y, s.w, s.h);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(s.x + s.w - hs / 2, s.y + s.h - hs / 2, hs, hs);
    ctx.strokeRect(s.x + s.w - hs / 2, s.y + s.h - hs / 2, hs, hs);
    ctx.restore();
  }

  function hitResizeHandle(s, p) {
    const r = HANDLE_SIZE / view.scale;
    return Math.abs(p.x - (s.x + s.w)) <= r && Math.abs(p.y - (s.y + s.h)) <= r;
  }

  function imageAt(p) {
    for (let i = shapes.length - 1; i >= 0; i--) {
      const s = shapes[i];
      if (s.type === 'image' && p.x >= s.x && p.x <= s.x + s.w && p.y >= s.y && p.y <= s.y + s.h) return s;
    }
    return null;
  }

  function fillAndStroke(c, s) {
    if (s.fill) {
      c.globalAlpha = 0.2;
      c.fill();
      c.globalAlpha = 1;
    }
    c.stroke();
  }

  // Smooth freehand path: the sampled points are the control polygon of a uniform cubic
  // B-spline (C2-continuous, so no kinks from mouse jitter), drawn as one cubic Bézier per span.
  // The first and last points are tripled so the curve is clamped to the stroke's endpoints.
  function drawStroke(c, pts) {
    if (pts.length === 1) {
      c.beginPath();
      c.arc(pts[0].x, pts[0].y, c.lineWidth / 2, 0, Math.PI * 2);
      c.fill();
      return;
    }
    const first = pts[0];
    const last = pts[pts.length - 1];
    const p = [first, first, ...pts, last, last];

    c.beginPath();
    c.moveTo(first.x, first.y);
    for (let i = 1; i < p.length - 2; i++) {
      const p1 = p[i];
      const p2 = p[i + 1];
      const p3 = p[i + 2];
      // B-spline span P(i-1)..P(i+2) → Bézier control points; its start point equals the
      // previous span's end point, so only the two handles and the end point are emitted.
      c.bezierCurveTo(
        (2 * p1.x + p2.x) / 3, (2 * p1.y + p2.y) / 3,
        (p1.x + 2 * p2.x) / 3, (p1.y + 2 * p2.y) / 3,
        (p1.x + 4 * p2.x + p3.x) / 6, (p1.y + 4 * p2.y + p3.y) / 6,
      );
    }
    c.stroke();
  }

  // ---------- History & persistence ----------

  // History entries are { shapes, action, t }: the board snapshot on the other side of one
  // action, plus what that action was and when it happened (ms since epoch). An undo entry
  // holds the state *before* its action and a redo entry the state *after*, so moving an entry
  // between the stacks keeps its action and timestamp. Reading the undo stack in order, then
  // the current board, gives the timestamped timeline used for replay.
  function commit(next, action) {
    undoStack.push({ shapes, action, t: Date.now() });
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack = [];
    shapes = next;
    afterChange();
  }

  function undo() {
    if (!undoStack.length) return;
    const entry = undoStack.pop();
    redoStack.push({ shapes, action: entry.action, t: entry.t });
    shapes = entry.shapes;
    afterChange();
  }

  function redo() {
    if (!redoStack.length) return;
    const entry = redoStack.pop();
    undoStack.push({ shapes, action: entry.action, t: entry.t });
    shapes = entry.shapes;
    afterChange();
  }

  function strokeAction(s) {
    if (s.type === 'eraser') return 'erase';
    if (s.type === 'pen' || s.type === 'highlighter') return 'stroke';
    return 'shape';
  }

  function updateHistoryButtons() {
    $('#undo').disabled = !undoStack.length;
    $('#redo').disabled = !redoStack.length;
  }

  function afterChange() {
    updateHistoryButtons();
    scheduleRender();
    scheduleSave();
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 300);
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(serialize(true)));
    } catch {
      // History holds many snapshots; if it won't fit, keep at least the current board.
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(serialize(false)));
        toast('Storage is full — saved the board without its undo/replay history');
      } catch {
        toast('Could not save — browser storage is full or unavailable');
      }
    }
  }

  // Snapshots share unchanged shape objects, so each distinct shape (and each image's data
  // URL) is stored once in a pool and snapshots are saved as lists of pool indexes.
  function serialize(withHistory) {
    const pool = [];
    const poolIndex = new Map();
    const assets = [];
    const assetIndex = new Map();

    const ref = (s) => {
      if (!poolIndex.has(s)) {
        let stored = s;
        if (s.type === 'image') {
          if (!assetIndex.has(s.src)) assetIndex.set(s.src, assets.push(s.src) - 1);
          const { src, ...rest } = s;
          stored = { ...rest, asset: assetIndex.get(src) };
        }
        poolIndex.set(s, pool.push(stored) - 1);
      }
      return poolIndex.get(s);
    };
    const entry = (e) => ({ s: e.shapes.map(ref), a: e.action, t: e.t });

    const data = { v: 2, view, shapes: shapes.map(ref) };
    if (withHistory) {
      data.undo = undoStack.map(entry);
      data.redo = redoStack.map(entry);
    }
    data.pool = pool;
    data.assets = assets;
    return data;
  }

  function deserialize(data) {
    const pool = data.pool.map((s) => {
      if (s.type !== 'image') return s;
      const { asset, ...rest } = s;
      return { ...rest, src: data.assets[asset] };
    });
    const deref = (ids) => ids.map((i) => pool[i]);
    const entry = (e) => ({ shapes: deref(e.s), action: e.a, t: e.t });
    shapes = deref(data.shapes);
    undoStack = (data.undo || []).map(entry);
    redoStack = (data.redo || []).map(entry);
  }

  function load() {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!data) return;
      if (data.v === 2) deserialize(data);
      else if (Array.isArray(data.shapes)) shapes = data.shapes;  // v1: board only, no history
      if (data.view && data.view.scale) view = data.view;
    } catch {
      shapes = [];
      undoStack = [];
      redoStack = [];
    }
  }

  // The board's history as a timestamped list of states, oldest first. The first entry is
  // the board before the oldest remembered action; redone-away states are not included.
  function timeline() {
    const states = undoStack.map((e, i) => ({
      shapes: e.shapes,
      action: i ? undoStack[i - 1].action : null,
      t: i ? undoStack[i - 1].t : null,
    }));
    const latest = undoStack[undoStack.length - 1];
    states.push({ shapes, action: latest ? latest.action : null, t: latest ? latest.t : null });
    return states;
  }

  // ---------- Pointer input ----------

  canvas.addEventListener('pointerdown', (e) => {
    if (textEditor) { textEditor.blur(); return; }
    if (activePointer !== null) return;

    // While replaying, dragging pans the view; drawing is disabled.
    if (e.button === 1 || (e.button === 0 && (state.tool === 'hand' || spaceDown || replay))) {
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

    if (state.tool === 'lasso') {
      lasso = { points: [p] };
      lassoSelection = [];
      activePointer = e.pointerId;
      canvas.setPointerCapture(e.pointerId);
      scheduleRender();
      return;
    }

    if (state.tool === 'select') {
      const sel = selectedShape();
      if (sel && hitResizeHandle(sel, p)) {
        drag = { mode: 'resize', orig: sel, start: p, shape: sel };
      } else {
        const hit = imageAt(p);
        selectedId = hit ? hit.id : null;
        if (hit) drag = { mode: 'move', orig: hit, start: p, shape: hit };
      }
      if (drag) {
        activePointer = e.pointerId;
        canvas.setPointerCapture(e.pointerId);
      }
      scheduleRender();
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
      smoothed = { x: p.x, y: p.y };
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

    if (lasso) {
      lasso.points.push(toWorld(e.clientX, e.clientY));
      scheduleRender();
      return;
    }

    if (drag) {
      const p = toWorld(e.clientX, e.clientY);
      const dx = p.x - drag.start.x;
      const dy = p.y - drag.start.y;
      const o = drag.orig;
      if (drag.mode === 'move') {
        drag.shape = { ...o, x: round(o.x + dx), y: round(o.y + dy) };
      } else {
        // Keep aspect ratio unless Shift is held.
        const w = Math.max(10, o.w + dx);
        const h = e.shiftKey ? Math.max(10, o.h + dy) : w * (o.h / o.w);
        drag.shape = { ...o, w: round(w), h: round(h) };
      }
      scheduleRender();
      return;
    }
    if (!current) return;

    if (current.points) {
      const events = (e.getCoalescedEvents && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
      // Stabilise input with an exponential moving average, and space samples a few screen
      // pixels apart so the B-spline can average out the remaining jitter.
      const minDist = 2.5 / view.scale;
      for (const ev of events) {
        const raw = toWorld(ev.clientX, ev.clientY);
        smoothed.x += (raw.x - smoothed.x) * STABILIZE;
        smoothed.y += (raw.y - smoothed.y) * STABILIZE;
        const last = current.points[current.points.length - 1];
        if (Math.hypot(smoothed.x - last.x, smoothed.y - last.y) >= minDist) {
          current.points.push({ x: round(smoothed.x), y: round(smoothed.y) });
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

    if (lasso) {
      const loop = lasso.points;
      lasso = null;
      lassoSelection = e.type === 'pointercancel' ? [] : strokesInLoop(loop);
      scheduleRender();
      return;
    }

    if (drag) {
      const { orig, shape, mode } = drag;
      drag = null;
      if (shape !== orig && e.type !== 'pointercancel') {
        commit(shapes.map((s) => (s.id === orig.id ? shape : s)), mode);
      } else {
        scheduleRender();
      }
      return;
    }
    if (!current) return;

    const s = current;
    current = null;
    if (s.points && e.type === 'pointerup') {
      // The last move may have been under the sampling distance; end exactly at the pen-up point.
      const p = toWorld(e.clientX, e.clientY);
      const end = { x: round(p.x), y: round(p.y) };
      const last = s.points[s.points.length - 1];
      if (end.x !== last.x || end.y !== last.y) s.points.push(end);
    }
    const degenerate = !s.points && s.x1 === s.x2 && s.y1 === s.y2;
    if (degenerate || e.type === 'pointercancel') scheduleRender();
    else commit([...shapes, s], strokeAction(s));
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
      if (text.trim()) commit([...shapes, { type: 'text', x: round(p.x), y: round(p.y), text, color, fontSize }], 'text');
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
    if (s.type === 'image') return [s.x, s.y, s.x + s.w, s.y + s.h];
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

  // [minX, minY, maxX, maxY] around the visible (non-eraser) shapes, or null if there are none.
  function unionBounds(list) {
    let box = null;
    for (const s of list) {
      if (s.type === 'eraser') continue;
      const b = bounds(s);
      box = box
        ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])]
        : b;
    }
    return box;
  }

  function exportPNG() {
    const box = unionBounds(shapes);
    if (!box) { toast('Nothing to export yet'); return; }
    const [minX, minY, maxX, maxY] = box;

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

  // ---------- Images ----------

  // Decode a file and re-encode it (downscaled if large) as a data URL so it can be autosaved.
  function readImageFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const w0 = img.naturalWidth || 300;
        const h0 = img.naturalHeight || 150;
        const k = Math.min(1, MAX_IMAGE_DIM / Math.max(w0, h0));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w0 * k));
        c.height = Math.max(1, Math.round(h0 * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/webp';
        resolve({ src: c.toDataURL(type, 0.85), width: c.width, height: c.height });
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('decode failed'));
      };
      img.src = url;
    });
  }

  // `at` is a world point to center the first image on; defaults to the middle of the screen.
  async function addImages(files, at) {
    if (replay) return;  // the board is read-only while replaying
    const images = [...files].filter((f) => f.type.startsWith('image/'));
    if (!images.length) { toast('Only image files can be added'); return; }

    const center = at || toWorld(
      canvas.getBoundingClientRect().left + board.clientWidth / 2,
      canvas.getBoundingClientRect().top + board.clientHeight / 2,
    );
    const maxW = (board.clientWidth * 0.6) / view.scale;
    const maxH = (board.clientHeight * 0.6) / view.scale;
    const added = [];

    for (const [i, file] of images.entries()) {
      try {
        const { src, width, height } = await readImageFile(file);
        const k = Math.min(1, maxW / width, maxH / height);
        const w = width * k;
        const h = height * k;
        const offset = (i * 24) / view.scale;
        added.push({
          type: 'image',
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
          src,
          x: round(center.x - w / 2 + offset),
          y: round(center.y - h / 2 + offset),
          w: round(w),
          h: round(h),
        });
      } catch {
        toast(`Could not read ${file.name}`);
      }
    }
    if (!added.length) return;

    commit([...shapes, ...added], 'image');
    setTool('select');
    selectedId = added[added.length - 1].id;
    scheduleRender();
  }

  function deleteSelected() {
    const id = selectedId;
    if (!id || !shapes.some((s) => s.id === id)) return;
    selectedId = null;
    commit(shapes.filter((s) => s.id !== id), 'delete');
  }

  // ---------- Lasso ----------

  function pointInPolygon(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i];
      const b = poly[j];
      if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }

  // Ink strokes with at least half of their points inside the loop (forgiving of loose loops).
  function strokesInLoop(loop) {
    if (loop.length < 3) return [];
    return shapes.filter((s) => INK.includes(s.type)
      && s.points.filter((p) => pointInPolygon(p, loop)).length >= s.points.length / 2);
  }

  // The selection minus any strokes no longer on the board (e.g. after an undo).
  function liveLassoSelection() {
    if (lassoSelection.length) {
      const onBoard = new Set(shapes);
      lassoSelection = lassoSelection.filter((s) => onBoard.has(s));
    }
    return lassoSelection;
  }

  // Board-space box around the selected strokes, with a little breathing room.
  function lassoBox() {
    const sel = liveLassoSelection();
    if (!sel.length) return null;
    const b = unionBounds(sel);
    const pad = 8 / view.scale;
    return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
  }

  function drawLasso() {
    const px = 1 / view.scale;  // one screen pixel in world units
    ctx.save();
    ctx.strokeStyle = '#4f46e5';
    ctx.lineWidth = 1.5 * px;
    ctx.setLineDash([6 * px, 4 * px]);
    if (lasso && lasso.points.length > 1) {
      ctx.beginPath();
      lasso.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fillStyle = 'rgba(79, 70, 229, 0.06)';
      ctx.fill();
      ctx.stroke();
    }
    const box = lassoBox();
    if (box) ctx.strokeRect(box[0], box[1], box[2] - box[0], box[3] - box[1]);
    ctx.restore();
  }

  // Keep the Solve Math / Clean Diagram menu next to the selection as the view pans and zooms.
  function positionLassoMenu() {
    const menu = $('#lassoMenu');
    const box = !replay && !lasso && lassoBox();
    menu.hidden = !box;
    if (!box) return;
    const cx = ((box[0] + box[2]) / 2) * view.scale + view.x;
    const top = box[1] * view.scale + view.y;
    const bottom = box[3] * view.scale + view.y;
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    const toolbarBottom = $('.toolbar').getBoundingClientRect().bottom;
    // Prefer just above the selection; drop below it if that would tuck under the toolbar.
    let y = top - h - 8;
    if (y < toolbarBottom + 8) y = bottom + 8;
    y = Math.min(y, window.innerHeight - h - 8);
    const x = Math.min(Math.max(8, cx - w / 2), window.innerWidth - w - 8);
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
  }

  // ---------- Capture ----------

  const boxesOverlap = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

  // Render just the selected strokes on white, with padding, as a base64 PNG for Claude.
  // Also returns the mapping back to the board for placing results:
  //   board = origin + imagePixel / scale
  function captureSelection(sel) {
    const box = unionBounds(sel);
    const w = Math.max(box[2] - box[0], 1);
    const h = Math.max(box[3] - box[1], 1);
    const scale = Math.min(2, (CAPTURE_MAX_SIDE - 2 * CAPTURE_PAD) / Math.max(w, h));
    const width = Math.ceil(w * scale + 2 * CAPTURE_PAD);
    const height = Math.ceil(h * scale + 2 * CAPTURE_PAD);
    const origin = { x: box[0] - CAPTURE_PAD / scale, y: box[1] - CAPTURE_PAD / scale };

    // Ink layer: the selected strokes in board order, plus eraser strokes over them so erased
    // parts stay erased. It's transparent so the erasers can't punch holes in the white.
    const chosen = new Set(sel);
    const layer = document.createElement('canvas');
    layer.width = width;
    layer.height = height;
    const lc = layer.getContext('2d');
    lc.setTransform(scale, 0, 0, scale, -origin.x * scale, -origin.y * scale);
    for (const s of shapes) {
      if (chosen.has(s) || (s.type === 'eraser' && boxesOverlap(bounds(s), box))) drawShape(lc, s);
    }

    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    const oc = out.getContext('2d');
    oc.fillStyle = '#ffffff';
    oc.fillRect(0, 0, width, height);
    oc.drawImage(layer, 0, 0);

    const base64 = out.toDataURL('image/png').split(',')[1];
    return { base64, mediaType: 'image/png', width, height, scale, origin };
  }

  // Temporary for steps 1–3: show what would be sent, so the capture can be checked.
  // Step 4 replaces this with the Claude API call.
  function showCapturePreview(cap, kind) {
    $('#captureImg').src = `data:${cap.mediaType};base64,${cap.base64}`;
    const kb = Math.round((cap.base64.length * 3) / 4 / 1024);
    $('#captureInfo').textContent = `${kind === 'math' ? 'Solve Math' : 'Clean Diagram'} · ${cap.width}×${cap.height}px · ${kb} KB`;
    $('#capturePreview').hidden = false;
  }

  // ---------- Replay ----------
  //
  // A replay turns timeline() into steps on a replay clock (ms). Each step goes from one board
  // state to the next. When a step only added one stroke or shape on top of the previous
  // state, that shape is animated growing in; anything else (text, image, move, delete, clear)
  // just appears. Real pauses between actions are kept, but capped at REPLAY_IDLE_CAP.

  // The shape a step added on top of `from`, or null if the step did something else.
  // Snapshots share unchanged shape objects, so identity tells us what stayed the same.
  function addedShape(from, to) {
    if (to.length !== from.length + 1) return null;
    for (let i = 0; i < from.length; i++) if (from[i] !== to[i]) return null;
    return to[to.length - 1];
  }

  // Only finish times are recorded, so a stroke's drawing time is estimated from its length
  // (about 1 px per ms, a relaxed hand-drawing speed).
  function animDuration(s) {
    if (s.points) {
      let len = 0;
      for (let i = 1; i < s.points.length; i++) {
        len += Math.hypot(s.points[i].x - s.points[i - 1].x, s.points[i].y - s.points[i - 1].y);
      }
      return Math.min(1500, Math.max(150, len));
    }
    return SHAPES.includes(s.type) ? REPLAY_SHAPE_MS : 0;
  }

  // The shape `progress` (0..1) of the way through being drawn.
  function partialShape(s, progress) {
    if (s.points) {
      // Point by point, so strokes look like they're being drawn live.
      return { ...s, points: s.points.slice(0, Math.max(1, Math.ceil(progress * s.points.length))) };
    }
    return { ...s, x2: s.x1 + (s.x2 - s.x1) * progress, y2: s.y1 + (s.y2 - s.y1) * progress };
  }

  function buildReplay() {
    const states = timeline();
    const steps = [];
    let clock = REPLAY_LEAD_IN;
    for (let i = 1; i < states.length; i++) {
      const from = states[i - 1].shapes;
      const to = states[i].shapes;
      const shape = addedShape(from, to);
      const anim = shape ? animDuration(shape) : 0;
      const realGap = i === 1 ? 0 : states[i].t - states[i - 1].t;
      const gap = Number.isFinite(realGap) ? Math.min(Math.max(realGap, 0), REPLAY_IDLE_CAP) : 500;
      // A timestamp marks when an action finished, so its animation plays out inside the gap
      // before it; later steps are pushed back only if that gap is too short.
      const start = clock + Math.max(0, gap - anim);
      clock = start + anim;
      steps.push({ from, to, shape: anim ? shape : null, start, end: clock });
    }
    // The oldest remembered state is the starting frame (empty unless history was trimmed).
    return { initial: states[0].shapes, steps, total: clock + REPLAY_TAIL };
  }

  // The list of shapes to draw at replay time `time`.
  function frameAt(time) {
    const { steps } = replay;
    let i = steps.length - 1;
    while (i >= 0 && steps[i].start > time) i--;
    if (i < 0) return replay.initial;
    const step = steps[i];
    if (!step.shape || time >= step.end) return step.to;
    return [...step.from, partialShape(step.shape, (time - step.start) / (step.end - step.start))];
  }

  function openReplay() {
    if (replay) { closeReplay(); return; }
    if (textEditor) textEditor.blur();  // commit any text being typed first
    if (!undoStack.length) { toast('Nothing to replay yet — draw something first'); return; }

    current = null;
    drag = null;
    lasso = null;
    lassoSelection = [];
    activePointer = null;
    selectedId = null;
    replay = { ...buildReplay(), time: 0, playing: false, last: 0, raf: 0, recording: null };

    // Editing tools are disabled (inert) for the duration; panning and zooming still work.
    document.body.classList.add('replaying');
    document.querySelectorAll('.toolbar .group:not(.replay-group)').forEach((g) => { g.inert = true; });
    $('#replayBtn').classList.add('active');
    $('#replayBar').hidden = false;
    setReplayPlaying(true);
  }

  function closeReplay() {
    if (!replay) return;
    if (replay.recording) cancelExport();
    cancelAnimationFrame(replay.raf);
    replay = null;
    document.body.classList.remove('replaying');
    document.querySelectorAll('.toolbar .group').forEach((g) => { g.inert = false; });
    $('#replayBtn').classList.remove('active');
    $('#replayBar').hidden = true;
    scheduleRender();
  }

  function setReplayPlaying(playing) {
    if (playing && replay.time >= replay.total) replay.time = 0;  // play again from the start
    replay.playing = playing;
    $('#replayPlay').classList.toggle('playing', playing);
    cancelAnimationFrame(replay.raf);
    if (playing) {
      replay.last = performance.now();
      replay.raf = requestAnimationFrame(replayTick);
    }
    updateReplayUI();
  }

  function replayTick(now) {
    if (!replay || !replay.playing) return;
    // Cap the step so a tab that was in the background doesn't jump ahead when it wakes up.
    // (Clamp at 0 too: a frame's timestamp can be a little earlier than the performance.now()
    // taken when playback started.)
    const dt = Math.max(0, Math.min(now - replay.last, 100));
    replay.last = now;
    replay.time = Math.min(replay.total, replay.time + dt * replaySpeed);
    if (replay.recording) drawRecordingFrame();
    if (replay.time >= replay.total) {
      if (replay.recording) replay.recording.recorder.stop();  // onstop downloads the video
      setReplayPlaying(false);
    } else {
      updateReplayUI();
      replay.raf = requestAnimationFrame(replayTick);
    }
  }

  function updateReplayUI() {
    const slider = $('#replaySlider');
    slider.max = Math.round(replay.total);
    slider.value = Math.round(replay.time);
    // Times are shown in real seconds at the current speed.
    const fmt = (ms) => {
      const s = Math.floor(ms / 1000);
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    $('#replayTime').textContent = replay.recording
      ? `Recording ${Math.round((replay.time / replay.total) * 100)}%`
      : `${fmt(replay.time / replaySpeed)} / ${fmt(replay.total / replaySpeed)}`;
    render();
  }

  // Export replay: play from the start while drawing every frame onto an offscreen canvas
  // (white background, cropped to the drawing) whose video stream feeds a MediaRecorder.
  // The on-screen canvas can't be recorded directly: it's transparent, which encodes as black.
  function exportReplay() {
    if (!replay || replay.recording) return;
    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      .find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
    if (!mimeType || !HTMLCanvasElement.prototype.captureStream) {
      toast('Video export is not supported in this browser');
      return;
    }

    // Crop to everything that appears at any point during the replay.
    const box = unionBounds(new Set([replay.initial, ...replay.steps.map((s) => s.to)].flat()));
    if (!box) { toast('Nothing to export yet'); return; }
    const pad = 32;
    const w = box[2] - box[0] + pad * 2;
    const h = box[3] - box[1] + pad * 2;
    const scale = Math.min(2, 1920 / w, 1920 / h);
    const even = (n) => Math.max(2, Math.round(n / 2) * 2);  // video encoders want even sizes

    const video = document.createElement('canvas');
    const layer = document.createElement('canvas');  // ink only, so the eraser can't cut the white
    video.width = layer.width = even(w * scale);
    video.height = layer.height = even(h * scale);

    const recorder = new MediaRecorder(video.captureStream(30), { mimeType, videoBitsPerSecond: 5e6 });
    const rec = {
      recorder, video, layer, cancelled: false,
      transform: [scale, (pad - box[0]) * scale, (pad - box[1]) * scale],
    };
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      $('#replayBar').classList.remove('exporting');
      if (replay && replay.recording === rec) replay.recording = null;
      if (replay) updateReplayUI();
      if (rec.cancelled) return;
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
      a.download = `whiteboard-replay-${stamp}.webm`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      toast('Exported replay video');
    };

    replay.recording = rec;
    $('#replayBar').classList.add('exporting');
    replay.time = 0;
    drawRecordingFrame();
    recorder.start();
    setReplayPlaying(true);
  }

  function drawRecordingFrame() {
    const { video, layer, transform: [k, tx, ty] } = replay.recording;
    const lc = layer.getContext('2d');
    lc.setTransform(1, 0, 0, 1, 0, 0);
    lc.clearRect(0, 0, layer.width, layer.height);
    lc.setTransform(k, 0, 0, k, tx, ty);
    for (const s of frameAt(replay.time)) drawShape(lc, s);

    const vc = video.getContext('2d');
    vc.fillStyle = '#ffffff';
    vc.fillRect(0, 0, video.width, video.height);
    vc.drawImage(layer, 0, 0);
  }

  // Stop recording and throw the video away (used when the replay is closed mid-export).
  function cancelExport() {
    replay.recording.cancelled = true;
    replay.recording.recorder.stop();
    replay.recording = null;
    $('#replayBar').classList.remove('exporting');
  }

  // ---------- UI ----------

  function setTool(tool) {
    if (tool !== 'select' && selectedId) {
      selectedId = null;
      scheduleRender();
    }
    if (tool !== 'lasso' && lassoSelection.length) {
      lassoSelection = [];
      scheduleRender();
    }
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
    commit([], 'clear');
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

  const fileInput = $('#imageInput');
  $('#imageBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) addImages(fileInput.files);
    fileInput.value = '';  // allow picking the same file again
  });

  window.addEventListener('paste', (e) => {
    if (e.target instanceof Element && e.target.matches('input, textarea')) return;
    const files = [...(e.clipboardData ? e.clipboardData.files : [])];
    if (files.some((f) => f.type.startsWith('image/'))) {
      e.preventDefault();
      addImages(files);
    }
  });

  // Prevent the browser from navigating to dropped files anywhere on the page.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = e.dataTransfer ? e.dataTransfer.files : [];
    if (files.length) addImages(files, toWorld(e.clientX, e.clientY));
  });

  $('#replayBtn').addEventListener('click', openReplay);
  $('#replayClose').addEventListener('click', closeReplay);
  $('#replayExport').addEventListener('click', exportReplay);
  $('#replayPlay').addEventListener('click', () => setReplayPlaying(!replay.playing));
  $('#replaySlider').addEventListener('input', (e) => {
    replay.time = Number(e.target.value);
    updateReplayUI();
  });
  $('#replaySpeed').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-speed]');
    if (!btn) return;
    replaySpeed = Number(btn.dataset.speed);
    document.querySelectorAll('#replaySpeed [data-speed]').forEach((b) => b.classList.toggle('active', b === btn));
    if (replay) updateReplayUI();
  });

  $('#lassoMenu').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-convert]');
    const sel = liveLassoSelection();
    if (!btn || !sel.length) return;
    showCapturePreview(captureSelection(sel), btn.dataset.convert);
  });
  $('#capturePreviewClose').addEventListener('click', () => { $('#capturePreview').hidden = true; });

  // ---------- Settings (Anthropic API key) ----------
  // The key is stored only in this browser's localStorage, under its own entry (never in the
  // board save), and is read only when a conversion is requested.

  function getApiKey() {
    try {
      return localStorage.getItem(API_KEY_STORAGE) || '';
    } catch {
      return '';
    }
  }

  function setApiKey(key) {
    try {
      if (key) localStorage.setItem(API_KEY_STORAGE, key);
      else localStorage.removeItem(API_KEY_STORAGE);
      return true;
    } catch {
      toast("Couldn't save the key — browser storage is unavailable");
      return false;
    }
  }

  const settingsModal = $('#settingsModal');
  const apiKeyInput = $('#apiKeyInput');

  function openSettings() {
    const key = getApiKey();
    apiKeyInput.value = '';
    $('#apiKeyStatus').textContent = key
      ? `A key is saved (ending in …${key.slice(-4)}). Paste a new one to replace it.`
      : 'No key saved yet.';
    $('#apiKeyRemove').hidden = !key;
    settingsModal.hidden = false;
    apiKeyInput.focus();
  }

  function closeSettings() {
    settingsModal.hidden = true;
  }

  $('#settingsBtn').addEventListener('click', openSettings);
  $('#settingsCancel').addEventListener('click', closeSettings);
  settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) closeSettings(); });
  settingsModal.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSettings(); });

  $('#settingsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const key = apiKeyInput.value.trim();
    if (!key) {
      if (getApiKey()) closeSettings();  // nothing new pasted: keep the saved key
      else toast('Paste your API key first');
      return;
    }
    if (!key.startsWith('sk-ant-')) {
      toast("That doesn't look like an Anthropic API key — it should start with sk-ant-");
      return;
    }
    if (setApiKey(key)) {
      closeSettings();
      toast('API key saved in this browser');
    }
  });

  $('#apiKeyRemove').addEventListener('click', () => {
    if (setApiKey('')) {
      closeSettings();
      toast('API key removed from this browser');
    }
  });

  const help = $('#help');
  $('#helpBtn').addEventListener('click', () => { help.hidden = !help.hidden; });

  // ---------- Keyboard ----------

  const TOOL_KEYS = { v: 'select', k: 'lasso', h: 'hand', p: 'pen', m: 'highlighter', e: 'eraser', l: 'line', a: 'arrow', r: 'rect', o: 'ellipse', t: 'text' };

  window.addEventListener('keydown', (e) => {
    if (!settingsModal.hidden) return;  // the dialog handles its own keys (Esc closes it)
    if (e.target instanceof Element && e.target.matches('input, textarea')) return;
    const key = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;

    // Editing shortcuts are off while replaying; Esc closes the replay.
    if (replay) {
      if (e.key === 'Escape') closeReplay();
      return;
    }

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
      if (current || drag || lasso) { current = null; drag = null; lasso = null; activePointer = null; }
      selectedId = null;
      lassoSelection = [];
      scheduleRender();
      help.hidden = true;
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
      e.preventDefault();
      deleteSelected();
      return;
    }
    if (key === 'i') { fileInput.click(); return; }
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
  updateHistoryButtons();
  setTool(state.tool);
  setSize(state.size);
  resize();

  // Read-only hook for the replay feature (and for inspecting history from the console).
  window.whiteboard = { timeline };
})();
