(() => {
  'use strict';

  // Google Drive save/load — the only place these settings live. From a Google Cloud project
  // with the Drive API and Google Picker API enabled:
  //   clientId: OAuth 2.0 Client ID (type "Web application") with this site's origin authorised
  //   apiKey:   an API key (restrict it to the Picker API and this site); the Picker requires one
  //   appId:    the project number, so files chosen in the Picker are opened up to this app
  // Leave clientId empty to keep Drive turned off (no Google scripts are loaded).
  const GOOGLE_CONFIG = {
    clientId: '65282310191-i4bmb3drctvklctaqh6pvn1i58onq9ug.apps.googleusercontent.com',
    apiKey: 'AIzaSyAak6ZUlV_Amh8E_xPF1i-S8JbmYWOjZSE',
    appId: '65282310191',
  };

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
  const AI_NOTICE_STORAGE = 'whiteboard.aiNoticeAccepted';
  const INK = ['pen', 'highlighter'];  // what the lasso selects
  const CAPTURE_PAD = 24;         // px of white around a captured selection
  const CAPTURE_MAX_SIDE = 1568;  // px; long edge of a capture (a good size for Claude's vision)
  // Board backgrounds. `screen` is shown on the board and `print` behind exports and captures
  // (only white differs: off-white on screen, pure white on paper); `dark` boards get light ink.
  const PAPERS = {
    white: { screen: '#f7f8fa', print: '#ffffff', grid: '#cdd2da', dark: false },
    black: { screen: '#232726', print: '#232726', grid: 'rgba(255, 255, 255, 0.2)', dark: true },
    green: { screen: '#2b4a3a', print: '#2b4a3a', grid: 'rgba(255, 255, 255, 0.2)', dark: true },
    blue: { screen: '#1d3557', print: '#1d3557', grid: 'rgba(255, 255, 255, 0.2)', dark: true },
  };
  const GRIDS = ['none', 'dots', 'squares', 'lines'];
  const DEFAULT_PAPER = { bg: 'white', grid: 'dots' };
  const DARK_INK = '#1e1e1e';   // the default ink on light boards
  const CHALK_INK = '#f8f9fa';  // ...and on dark ones

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
  let paper = { ...DEFAULT_PAPER };  // the board's background and grid; saved with the board
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
  let me = null;             // the signed-in user from /api/me, or null (see the Account section)
  let cloud = null;          // the account board on screen, or null for this device's board
  let loadingBoard = false;  // an account board is being fetched; the board is read-only meanwhile

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
    if (paper.grid === 'none') return;

    let step = 24 * view.scale;
    while (step < 14) step *= 2;
    while (step > 64) step /= 2;

    const ox = ((view.x % step) + step) % step;
    const oy = ((view.y % step) + step) % step;
    const color = PAPERS[paper.bg].grid;
    if (paper.grid === 'dots') {
      gctx.fillStyle = color;
      for (let x = ox; x < w; x += step) {
        for (let y = oy; y < h; y += step) {
          gctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
        }
      }
      return;
    }
    // Squares, or ruled lines (horizontal only); snapped to whole pixels so they don't blur.
    gctx.strokeStyle = color;
    gctx.globalAlpha = 0.6;  // lines read heavier than dots of the same colour
    gctx.lineWidth = 1;
    gctx.beginPath();
    if (paper.grid === 'squares') {
      for (let x = ox; x < w; x += step) {
        gctx.moveTo(Math.round(x) + 0.5, 0);
        gctx.lineTo(Math.round(x) + 0.5, h);
      }
    }
    for (let y = oy; y < h; y += step) {
      gctx.moveTo(0, Math.round(y) + 0.5);
      gctx.lineTo(w, Math.round(y) + 0.5);
    }
    gctx.stroke();
    gctx.globalAlpha = 1;
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
    $('#undo').disabled = !undoStack.length || viewOnly();
    $('#redo').disabled = !redoStack.length || viewOnly();
  }

  function afterChange() {
    updateHistoryButtons();
    scheduleRender();
    scheduleSave();
    cloudChanged();
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 300);
  }

  function save() {
    if (loadingBoard) return;  // the board on screen isn't the local one yet
    if (cloud) { saveCloudCache(); return; }  // the local board stays as it was
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

    const data = { v: 2, view, paper, shapes: shapes.map(ref) };
    if (withHistory) {
      data.undo = undoStack.map(entry);
      data.redo = redoStack.map(entry);
    }
    data.pool = pool;
    data.assets = assets;
    return data;
  }

  // ---------- Board validation ----------
  // Saved boards come from this browser's storage or from Drive files that anyone could have
  // edited, so they're checked strictly before use: each object may hold only the fields the
  // app itself writes, with the right types and sane ranges, and image sources must be inline
  // data: images (an outside URL would make the browser contact that server). The board is
  // rebuilt from fresh objects; anything unexpected rejects the whole file.

  const ACTIONS = ['stroke', 'erase', 'shape', 'text', 'image', 'move', 'resize', 'delete', 'clear', 'math', 'diagram'];
  const IMAGE_SRC = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
  const MAX_ITEMS = 100000;     // per list: shapes, points, pool entries, images
  const MAX_TEXT = 10000;       // characters in one text element
  const MAX_COORD = 1e7;        // board units, far beyond anything drawable

  const invalid = (what) => { throw new Error(`Invalid board data: ${what}`); };
  const isPlainObject = (o) => o !== null && typeof o === 'object' && Object.getPrototypeOf(o) === Object.prototype;

  function checkFields(o, required, optional, what) {
    if (!isPlainObject(o)) invalid(what);
    for (const k of Object.keys(o)) if (!required.includes(k) && !optional.includes(k)) invalid(`${what} has unexpected field "${k}"`);
    for (const k of required) if (!(k in o)) invalid(`${what} is missing "${k}"`);
  }

  function checkNumber(v, what, min = -MAX_COORD, max = MAX_COORD) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) invalid(what);
    return v;
  }

  function checkColor(v) {
    if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) invalid('colour');
    return v;
  }

  function checkList(v, what, min = 0) {
    if (!Array.isArray(v) || v.length < min || v.length > MAX_ITEMS) invalid(what);
    return v;
  }

  // `assets` is the v2 image table (images refer to it by index); null for v1 boards, where
  // images carry their own src.
  function validateShape(s, assets) {
    if (!isPlainObject(s)) invalid('item');
    switch (s.type) {
      case 'pen':
      case 'highlighter':
      case 'eraser':
        checkFields(s, ['type', 'color', 'size', 'points'], [], 'stroke');
        return {
          type: s.type,
          color: checkColor(s.color),
          size: checkNumber(s.size, 'stroke size', 0.1, 1000),
          points: checkList(s.points, 'stroke points', 1).map((p) => {
            checkFields(p, ['x', 'y'], [], 'point');
            return { x: checkNumber(p.x, 'point'), y: checkNumber(p.y, 'point') };
          }),
        };
      case 'line':
      case 'arrow':
      case 'rect':
      case 'ellipse': {
        checkFields(s, ['type', 'color', 'size', 'x1', 'y1', 'x2', 'y2'], ['fill'], 'shape');
        if ('fill' in s && typeof s.fill !== 'boolean') invalid('shape fill');
        return {
          type: s.type,
          color: checkColor(s.color),
          size: checkNumber(s.size, 'shape size', 0.1, 1000),
          fill: s.fill === true,
          x1: checkNumber(s.x1, 'shape'),
          y1: checkNumber(s.y1, 'shape'),
          x2: checkNumber(s.x2, 'shape'),
          y2: checkNumber(s.y2, 'shape'),
        };
      }
      case 'text':
        checkFields(s, ['type', 'x', 'y', 'text', 'color', 'fontSize'], [], 'text');
        if (typeof s.text !== 'string' || s.text.length > MAX_TEXT) invalid('text');
        return {
          type: 'text',
          x: checkNumber(s.x, 'text'),
          y: checkNumber(s.y, 'text'),
          text: s.text,
          color: checkColor(s.color),
          fontSize: checkNumber(s.fontSize, 'font size', 1, 2000),
        };
      case 'image': {
        checkFields(s, ['type', 'id', 'x', 'y', 'w', 'h', assets ? 'asset' : 'src'], [], 'image');
        if (typeof s.id !== 'string' || !/^[a-z0-9]{1,40}$/.test(s.id)) invalid('image id');
        let src = s.src;
        if (assets) {
          if (!Number.isInteger(s.asset) || s.asset < 0 || s.asset >= assets.length) invalid('image reference');
          src = assets[s.asset];
        }
        if (typeof src !== 'string' || !IMAGE_SRC.test(src)) invalid('image data');
        return {
          type: 'image',
          id: s.id,
          src,
          x: checkNumber(s.x, 'image'),
          y: checkNumber(s.y, 'image'),
          w: checkNumber(s.w, 'image size', 1e-3),
          h: checkNumber(s.h, 'image size', 1e-3),
        };
      }
      default:
        return invalid('unknown item type');
    }
  }

  function validateView(v) {
    if (v === undefined) return null;
    checkFields(v, ['x', 'y', 'scale'], [], 'view');
    return { x: checkNumber(v.x, 'view'), y: checkNumber(v.y, 'view'), scale: checkNumber(v.scale, 'zoom', MIN_SCALE, MAX_SCALE) };
  }

  function validatePaper(p) {
    if (p === undefined) return null;
    checkFields(p, ['bg', 'grid'], [], 'paper');
    if (!Object.keys(PAPERS).includes(p.bg)) invalid('background');
    if (!GRIDS.includes(p.grid)) invalid('grid');
    return { bg: p.bg, grid: p.grid };
  }

  // Returns { shapes, undo, redo, view, paper } built from fresh, checked objects; throws otherwise.
  function validateBoard(data) {
    if (!isPlainObject(data)) invalid('not a board');
    if (data.v === 2) {
      checkFields(data, ['v', 'shapes', 'pool', 'assets'], ['view', 'paper', 'undo', 'redo'], 'board');
      const assets = checkList(data.assets, 'images');
      assets.forEach((a) => { if (typeof a !== 'string' || !IMAGE_SRC.test(a)) invalid('image data'); });
      // Validating each pool entry once keeps snapshots sharing the same objects, as they did when saved.
      const pool = checkList(data.pool, 'items').map((s) => validateShape(s, assets));
      const deref = (ids) => checkList(ids, 'item list').map((i) => {
        if (!Number.isInteger(i) || i < 0 || i >= pool.length) invalid('item reference');
        return pool[i];
      });
      const history = (list) => (list === undefined ? [] : checkList(list, 'history')).map((e) => {
        checkFields(e, ['s', 'a', 't'], [], 'history entry');
        if (!ACTIONS.includes(e.a)) invalid('history action');
        return { shapes: deref(e.s), action: e.a, t: checkNumber(e.t, 'timestamp', 0, 1e14) };
      });
      return {
        shapes: deref(data.shapes), undo: history(data.undo), redo: history(data.redo),
        view: validateView(data.view), paper: validatePaper(data.paper),
      };
    }
    // v1: the board only, no history
    checkFields(data, ['shapes'], ['view'], 'board');
    return { shapes: checkList(data.shapes, 'items').map((s) => validateShape(s, null)), undo: [], redo: [], view: validateView(data.view), paper: null };
  }

  // Replace the board and its history with a board from validateBoard().
  function useBoard(board) {
    shapes = board.shapes;
    undoStack = board.undo;
    redoStack = board.redo;
    if (board.view) view = board.view;
    paper = board.paper || { ...DEFAULT_PAPER };  // boards saved before backgrounds existed
    applyPaper();
  }

  // The board saved on this device, or an empty one.
  function readLocalBoard() {
    let raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return validateBoard(JSON.parse(raw));
    } catch {
      // Keep the unreadable save aside rather than letting the next autosave overwrite it.
      try { if (raw) localStorage.setItem(`${STORAGE_KEY}.rejected`, raw); } catch { /* storage full */ }
      setTimeout(() => toast("The saved board couldn't be loaded, so you're starting with an empty one"), 0);
    }
    return emptyBoard();
  }

  const emptyBoard = () => ({ shapes: [], undo: [], redo: [], view: { x: 0, y: 0, scale: 1 }, paper: null });

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

  // Keep receiving the gesture's events even if the pointer leaves the canvas. Browsers can
  // refuse (e.g. if the pointer was already released); that mustn't abort the stroke.
  function capturePointer(pointerId) {
    try { canvas.setPointerCapture(pointerId); } catch { /* pointerup/lostpointercapture still end it */ }
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (textEditor) { textEditor.blur(); return; }
    if (activePointer !== null) {
      // Pens and touchscreens sometimes never deliver the previous stroke's pointerup. A new
      // press from the same pointer, or a new primary pointer, means that stroke is over:
      // finish it instead of swallowing this one. (A second finger isn't primary: ignore it.)
      if (e.pointerId !== activePointer && !e.isPrimary) return;
      endGesture({ type: 'lost', pointerId: activePointer });
    }

    // While replaying or viewing a board you can't edit, dragging pans the view; drawing is disabled.
    if (e.button === 1 || (e.button === 0 && (state.tool === 'hand' || spaceDown || readOnly()))) {
      e.preventDefault();
      activePointer = e.pointerId;
      capturePointer(e.pointerId);
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
      capturePointer(e.pointerId);
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
        capturePointer(e.pointerId);
      }
      scheduleRender();
      return;
    }

    activePointer = e.pointerId;
    capturePointer(e.pointerId);
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
    // No buttons pressed means the pen/finger/mouse was lifted but its pointerup never came.
    // End the stroke here rather than drawing the hover path to the next letter.
    if (e.buttons === 0) { endGesture({ type: 'lost', pointerId: e.pointerId }); return; }

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

  // iOS Safari still runs its double-tap and loupe gestures under touch-action: none, and a
  // quick second Apple Pencil stroke gets taken as a double-tap: its pointerdown never comes or
  // is cancelled at once. Cancelling the touch keeps those gestures away; pointer events still
  // fire. (Left alone for the text tool, where the touch has to focus the text box.)
  canvas.addEventListener('touchstart', (e) => {
    if (state.tool !== 'text') e.preventDefault();
  }, { passive: false });

  canvas.addEventListener('pointerup', endGesture);
  canvas.addEventListener('pointercancel', endGesture);
  // Capture is lost when the pointer is released or the browser takes it away; after a normal
  // pointerup the gesture is already over and this is ignored.
  canvas.addEventListener('lostpointercapture', (e) => endGesture({ type: 'lost', pointerId: e.pointerId }));

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

  // Render the drawn content, cropped to its bounds plus padding, onto the board's background.
  // Returns { canvas, width, height } with width/height in board units, or null if empty.
  function renderContent() {
    const box = unionBounds(shapes);
    if (!box) return null;
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
    oc.fillStyle = PAPERS[paper.bg].print;
    oc.fillRect(0, 0, out.width, out.height);
    oc.drawImage(layer, 0, 0);
    return { canvas: out, width: w, height: h };
  }

  const fileStamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

  // PDF export: an A4 page turned to match the content's shape (landscape when wider than
  // tall), with the content scaled to fit inside the margins and centred. jsPDF comes from
  // the CDN script in index.html.
  function exportPDF() {
    const jsPDF = window.jspdf && window.jspdf.jsPDF;
    if (!jsPDF) { toast("The PDF library hasn't loaded — check your connection and try again"); return; }
    const content = renderContent();
    if (!content) { toast('Nothing to export yet'); return; }

    const orientation = content.width >= content.height ? 'landscape' : 'portrait';
    const pdf = new jsPDF({ orientation, unit: 'pt', format: 'a4' });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const margin = 36;  // pt (half an inch)
    // Shrink to fit, but don't blow small drawings up past their on-screen size (1px = 0.75pt).
    const k = Math.min((pageW - 2 * margin) / content.width, (pageH - 2 * margin) / content.height, 0.75);
    const w = content.width * k;
    const h = content.height * k;
    pdf.addImage(content.canvas, 'PNG', (pageW - w) / 2, (pageH - h) / 2, w, h, undefined, 'FAST');
    pdf.save(`whiteboard-${fileStamp()}.pdf`);
    toast('Exported PDF');
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
    if (readOnly()) return;  // replaying, or a board this user can only view
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

  // Render just the selected strokes on the board's background (so chalk on a dark board stays
  // visible), with padding, as a base64 PNG for Claude.
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
    // parts stay erased. It's transparent so the erasers can't punch holes in the background.
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
    oc.fillStyle = PAPERS[paper.bg].print;
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
    updateEditing();
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
    updateEditing();
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
  // (the board's background, cropped to the drawing) whose video stream feeds a MediaRecorder.
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
    const layer = document.createElement('canvas');  // ink only, so the eraser can't cut the background
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
    vc.fillStyle = PAPERS[paper.bg].print;
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

  // Show the board's background and grid, and keep the default ink readable on it: black ink
  // vanishes on a dark board and chalk on a light one, so that pair swaps over.
  function applyPaper() {
    const p = PAPERS[paper.bg];
    board.style.background = p.screen;
    document.querySelectorAll('#paperBg [data-bg]').forEach((b) => b.classList.toggle('active', b.dataset.bg === paper.bg));
    document.querySelectorAll('#paperGrid [data-grid]').forEach((b) => b.classList.toggle('active', b.dataset.grid === paper.grid));
    const [from, to] = p.dark ? [DARK_INK, CHALK_INK] : [CHALK_INK, DARK_INK];
    if (state.color === from) setColor(to, document.querySelector(`.swatch[data-color="${to}"]`));
    scheduleRender();
  }

  function setPaper(changes) {
    if (viewOnly()) { toast('This board is view-only'); return; }
    paper = { ...paper, ...changes };
    applyPaper();
    scheduleSave();
    cloudChanged();
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

  // Swatch colours come from data-color here rather than inline style="" attributes, which the
  // Content Security Policy blocks.
  document.querySelectorAll('.swatch[data-color]').forEach((s) => s.style.setProperty('--c', s.dataset.color));

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
  $('#export').addEventListener('click', exportPDF);
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

  // One-time notice before the first AI request. Resolves true to go ahead; the choice is
  // remembered only once accepted, so Cancel shows it again next time.
  function confirmAiNotice() {
    if (readStorage(localStorage, AI_NOTICE_STORAGE)) return Promise.resolve(true);
    const modal = $('#aiNoticeModal');
    return new Promise((resolve) => {
      const finish = (ok) => {
        modal.hidden = true;
        modal.removeEventListener('click', onClick);
        modal.removeEventListener('keydown', onKey);
        if (ok) {
          try { localStorage.setItem(AI_NOTICE_STORAGE, '1'); } catch { /* ask again next time */ }
        }
        resolve(ok);
      };
      const onClick = (e) => {
        if (e.target.id === 'aiNoticeOk') finish(true);
        else if (e.target.id === 'aiNoticeCancel' || e.target === modal) finish(false);
      };
      const onKey = (e) => { if (e.key === 'Escape') finish(false); };
      modal.addEventListener('click', onClick);
      modal.addEventListener('keydown', onKey);
      modal.hidden = false;
      $('#aiNoticeOk').focus();
    });
  }

  $('#lassoMenu').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-convert]');
    if (!btn || !liveLassoSelection().length) return;
    if (!(await confirmAiNotice())) return;
    const sel = liveLassoSelection();  // re-read: the board may have changed while the notice was open
    if (!sel.length) return;
    // Step 4 sends this capture to Claude; for now it's shown as a preview.
    showCapturePreview(captureSelection(sel), btn.dataset.convert);
  });
  $('#capturePreviewClose').addEventListener('click', () => { $('#capturePreview').hidden = true; });

  // ---------- Google Drive ----------
  // Sign-in uses Google Identity Services (token model) with the drive.file scope, so the app
  // only ever sees files it created or that the user picks in the Google Picker. A save is the
  // same JSON as the autosave: the board plus its undo/replay history.

  const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const MAX_DRIVE_FILE_BYTES = 50 * 1024 * 1024;  // far above any real board; stops huge downloads
  const DRIVE_NOT_SET_UP ="Google Drive isn't set up — add your Google IDs to GOOGLE_CONFIG in app.js";
  let tokenClient = null;
  let pendingAuth = null;   // { resolve, reject } for the sign-in in progress
  let googleToken = null;   // { value, expiresAt }
  let driveFile = null;     // { id, name } of the file this board was opened from or saved to

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error(`Couldn't load ${src}`));
      document.head.appendChild(s);
    });
  }

  // Load Google's scripts at startup (only when configured), so a button click can open the
  // sign-in popup immediately; browsers block popups opened after waiting on a download.
  if (GOOGLE_CONFIG.clientId) {
    loadScript('https://accounts.google.com/gsi/client').then(() => {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CONFIG.clientId,
        scope: DRIVE_SCOPE,
        callback: (resp) => {
          const auth = pendingAuth;
          pendingAuth = null;
          if (!auth) return;
          if (resp.error) { auth.reject(new Error('Google sign-in failed')); return; }
          // Google's consent screen lets people untick individual permissions; without Drive
          // access every request would fail, so say so plainly instead.
          if (!google.accounts.oauth2.hasGrantedAllScopes(resp, DRIVE_SCOPE)) {
            auth.reject(new Error('Google Drive access wasn’t allowed — sign in again and tick the Drive permission'));
            return;
          }
          googleToken = { value: resp.access_token, expiresAt: Date.now() + (resp.expires_in - 60) * 1000 };
          toast('Signed in to Google');
          auth.resolve(googleToken.value);
        },
        error_callback: (err) => {
          const auth = pendingAuth;
          pendingAuth = null;
          if (!auth) return;
          const messages = {
            popup_closed: 'Google sign-in was cancelled',
            popup_failed_to_open: 'The Google sign-in window was blocked — allow pop-ups for this site and try again',
          };
          auth.reject(new Error(messages[err.type] || 'Google sign-in failed'));
        },
      });
    }).catch(() => { /* reported when a Drive button is used */ });
    loadScript('https://apis.google.com/js/api.js')
      .then(() => gapi.load('picker', () => {}))
      .catch(() => {});
  }

  // Resolve with an access token, signing in first if needed. Call it straight from the click
  // handler (before any await) so the sign-in popup counts as user-initiated.
  function getGoogleToken() {
    if (googleToken && Date.now() < googleToken.expiresAt) return Promise.resolve(googleToken.value);
    if (!tokenClient) return Promise.reject(new Error("Google sign-in isn't ready — check your connection and try again"));
    return new Promise((resolve, reject) => {
      pendingAuth = { resolve, reject };
      toast('Signing in to Google…');
      tokenClient.requestAccessToken({ prompt: '' });
    });
  }

  async function driveJson(res) {
    if (res.status === 401) {
      googleToken = null;
      throw new Error('Your Google sign-in expired — please try again');
    }
    if (!res.ok) throw new Error(`Google Drive returned an error (${res.status})`);
    return res.json();
  }

  async function driveCreate(token, body) {
    const form = new FormData();
    const metadata = { name: `whiteboard-${fileStamp()}.json`, mimeType: 'application/json' };
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', new Blob([body], { type: 'application/json' }));
    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    return driveJson(res);
  }

  // Overwrite a file's contents; resolves null if it's gone (deleted, trashed, or access
  // removed) so the caller saves a new file instead.
  async function driveUpdate(token, id, body) {
    const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(id)}?uploadType=media&fields=id,name,trashed`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body,
    });
    if (res.status === 404 || res.status === 403) return null;
    const file = await driveJson(res);
    return file.trashed ? null : file;  // don't keep saving into a file sitting in the bin
  }

  function driveErrorMessage(err) {
    if (err instanceof TypeError) return "Couldn't reach Google Drive — check your connection";
    if (err instanceof SyntaxError) return "That file isn't a whiteboard save";
    return err.message;
  }

  // Save: update the Drive file this board came from (or was last saved to), else create one.
  async function saveToDrive() {
    if (!GOOGLE_CONFIG.clientId) { toast(DRIVE_NOT_SET_UP); return; }
    if (textEditor) textEditor.blur();
    try {
      const token = await getGoogleToken();
      const body = JSON.stringify(serialize(true));
      const file = (driveFile && await driveUpdate(token, driveFile.id, body)) || await driveCreate(token, body);
      driveFile = { id: file.id, name: file.name };
      toast(`Saved to Google Drive as “${file.name}”`);
    } catch (err) {
      toast(driveErrorMessage(err));
    }
  }

  // Resolves with the picked { id, name }, or null if the Picker was closed.
  function pickDriveFile(token) {
    return new Promise((resolve, reject) => {
      if (!window.google || !google.picker) {
        reject(new Error("Google Picker isn't ready — check your connection and try again"));
        return;
      }
      const view = new google.picker.DocsView(google.picker.ViewId.DOCS).setMimeTypes('application/json');
      new google.picker.PickerBuilder()
        .addView(view)
        .setTitle('Open a whiteboard')
        .setOAuthToken(token)
        .setDeveloperKey(GOOGLE_CONFIG.apiKey)
        .setAppId(GOOGLE_CONFIG.appId)
        .setCallback((data) => {
          if (data.action === google.picker.Action.PICKED) {
            const doc = data.docs[0];
            resolve({ id: doc.id, name: doc.name, size: Number(doc.sizeBytes) || 0 });
          }
          else if (data.action === google.picker.Action.CANCEL) resolve(null);
        })
        .build()
        .setVisible(true);
    });
  }

  async function openFromDrive() {
    if (!GOOGLE_CONFIG.clientId || !GOOGLE_CONFIG.apiKey || !GOOGLE_CONFIG.appId) { toast(DRIVE_NOT_SET_UP); return; }
    if (viewOnly()) { toast('This board is view-only — make a copy to open a file into it'); return; }
    if (textEditor) textEditor.blur();
    try {
      const token = await getGoogleToken();
      const picked = await pickDriveFile(token);
      if (!picked) return;
      if (picked.size > MAX_DRIVE_FILE_BYTES) throw new Error('That file is too large to be a whiteboard save');
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(picked.id)}?alt=media`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await driveJson(res);
      let board;
      try {
        board = validateBoard(data);
      } catch {
        throw new SyntaxError('not a whiteboard save');
      }
      if (shapes.length && !confirm(`Replace the current board with “${picked.name}”? Its undo history will be replaced too.`)) return;
      showBoard(board);
      driveFile = { id: picked.id, name: picked.name };
      scheduleSave();
      cloudChanged();  // an account board takes the file's content
      toast(`Loaded “${picked.name}” from Google Drive`);
    } catch (err) {
      toast(driveErrorMessage(err));
    }
  }

  // The access token only ever lives in the googleToken variable (never in storage), so
  // signing out means revoking it with Google, which also withdraws the app's Drive access
  // until the next sign-in, and forgetting it here.
  function signOutOfDrive() {
    const token = googleToken && googleToken.value;
    googleToken = null;
    driveFile = null;
    if (token && window.google && google.accounts) google.accounts.oauth2.revoke(token, () => {});
    updateDriveStatus();
    toast(token ? 'Signed out of Google Drive' : "You're not signed in to Google Drive");
  }

  const driveSignedIn = () => Boolean(googleToken && Date.now() < googleToken.expiresAt);

  $('#driveSave').addEventListener('click', saveToDrive);
  $('#driveOpen').addEventListener('click', openFromDrive);

  // ---------- Settings ----------
  // The API key is kept under its own storage entry (never in the board save). With
  // "Remember key" off it goes in sessionStorage and disappears when the tab closes; with it on,
  // it goes in localStorage until forgotten. It's only ever in one of the two.

  function readStorage(store, key) {
    try {
      return store.getItem(key) || '';
    } catch {
      return '';
    }
  }

  function removeFromStorage(store, key) {
    try { store.removeItem(key); } catch { /* storage unavailable: nothing stored there */ }
  }

  const getApiKey = () => readStorage(sessionStorage, API_KEY_STORAGE) || readStorage(localStorage, API_KEY_STORAGE);
  const apiKeyRemembered = () => Boolean(readStorage(localStorage, API_KEY_STORAGE));

  function storeApiKey(key, remember) {
    try {
      const [keep, drop] = remember ? [localStorage, sessionStorage] : [sessionStorage, localStorage];
      drop.removeItem(API_KEY_STORAGE);
      keep.setItem(API_KEY_STORAGE, key);
      return true;
    } catch {
      toast("Couldn't save the key — browser storage is unavailable");
      return false;
    }
  }

  function forgetApiKey() {
    removeFromStorage(localStorage, API_KEY_STORAGE);
    removeFromStorage(sessionStorage, API_KEY_STORAGE);
  }

  const settingsModal = $('#settingsModal');
  const apiKeyInput = $('#apiKeyInput');
  const rememberKey = $('#rememberKey');

  function updateKeyStatus() {
    const key = getApiKey();
    $('#apiKeyStatus').textContent = key
      ? `A key ending in …${key.slice(-4)} is ${apiKeyRemembered() ? 'remembered in this browser' : 'kept for this tab only'}.`
      : 'No key saved.';
    $('#apiKeyForget').disabled = !key;
  }

  function updateDriveStatus() {
    const signedIn = driveSignedIn();
    $('#driveStatus').textContent = signedIn
      ? 'Signed in to Google Drive for this session.'
      : 'Not signed in to Google Drive.';
    $('#driveSignOut').disabled = !signedIn;
  }

  function openSettings() {
    apiKeyInput.value = '';
    rememberKey.checked = apiKeyRemembered();  // off by default: the key lasts only for this tab
    updateKeyStatus();
    updateDriveStatus();
    $('#displayNameInput').value = me ? me.displayName || '' : '';
    $('#deleteConfirmInput').value = '';
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

  // Save: a newly pasted key, or the existing key moved to match the Remember checkbox.
  $('#settingsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const pasted = apiKeyInput.value.trim();
    if (pasted && !pasted.startsWith('sk-ant-')) {
      toast("That doesn't look like an Anthropic API key — it should start with sk-ant-");
      return;
    }
    const key = pasted || getApiKey();
    if (!key) { toast('Paste your API key first'); return; }
    if (storeApiKey(key, rememberKey.checked)) {
      apiKeyInput.value = '';
      updateKeyStatus();
      toast(rememberKey.checked ? 'API key saved in this browser' : 'API key kept for this tab only');
    }
  });

  $('#apiKeyForget').addEventListener('click', () => {
    forgetApiKey();
    updateKeyStatus();
    toast('API key forgotten');
  });

  $('#driveSignOut').addEventListener('click', signOutOfDrive);

  // Clear local data: everything this app keeps in the browser — the board and its history,
  // the API key (both storages), the AI notice preference, and any set-aside unreadable save.
  // Files in Google Drive aren't touched.
  $('#clearLocalData').addEventListener('click', async () => {
    if (!confirm('Clear all ChalkBack data stored in this browser? This removes your board, its undo/replay history and your API key, and signs you out. Boards in your account and files in Google Drive are not affected.')) return;
    if (me) await endSession(() => api('POST', '/auth/logout'));
    clearTimeout(saveTimer);  // a pending autosave would write the board straight back
    for (const k of [STORAGE_KEY, `${STORAGE_KEY}.rejected`, API_KEY_STORAGE, AI_NOTICE_STORAGE, ...cloudCacheKeys()]) {
      removeFromStorage(localStorage, k);
      removeFromStorage(sessionStorage, k);
    }
    showBoard(emptyBoard());
    updateKeyStatus();
    closeSettings();
    toast('Local data cleared');
  });

  // Help, Board style, Boards and the account menu open in the same corner, so showing one
  // hides the others. Returns whether `el` is now showing.
  const help = $('#help');
  const paperPanel = $('#paperPanel');
  const boardsPanel = $('#boardsPanel');
  const accountMenu = $('#accountMenu');
  const popovers = [help, paperPanel, boardsPanel, accountMenu];
  function togglePopover(el) {
    const show = el.hidden;
    popovers.forEach((p) => { p.hidden = true; });
    el.hidden = !show;
    return show;
  }
  const closePopovers = () => popovers.forEach((p) => { p.hidden = true; });
  const toggleHelp = () => togglePopover(help);
  $('#helpBtn').addEventListener('click', toggleHelp);
  $('#paperBtn').addEventListener('click', () => togglePopover(paperPanel));

  document.querySelectorAll('#paperBg [data-bg]').forEach((b) => b.style.setProperty('--c', PAPERS[b.dataset.bg].screen));
  $('#paperBg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-bg]');
    if (btn) setPaper({ bg: btn.dataset.bg });
  });
  $('#paperGrid').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-grid]');
    if (btn) setPaper({ grid: btn.dataset.grid });
  });

  // ---------- Account ----------
  // Served by the ChalkBack server, people can sign in with Google (a full-page redirect the
  // server handles) to keep boards in their account and share them. Served as plain files there
  // is no /api/me, and the app works exactly as before, signed out.

  const BOARD_PATH = /^\/b\/([A-Za-z0-9_-]{8,40})\/?$/;
  const CLOUD_CACHE_PREFIX = 'whiteboard.cloud.';  // unsaved changes to account boards, by board id
  const CLOUD_SAVE_DELAY = 2000;  // ms after the last change
  const SIGNIN_MESSAGES = {
    failed: "Google sign-in didn't complete — please try again",
    unverified: "Your Google account's email address isn't verified, so it can't be used to sign in",
    disabled: 'This account has been disabled — contact the site admin',
  };
  let serverAvailable = false;
  let csrfToken = '';
  let pendingBoardId = null;  // a board link opened while signed out; signing in returns to it
  let cloudTimer = 0;

  const boardIdFromPath = () => {
    const m = location.pathname.match(BOARD_PATH);
    return m ? m[1] : null;
  };

  function viewOnly() { return loadingBoard || Boolean(cloud && cloud.permission === 'view'); }
  function readOnly() { return Boolean(replay) || viewOnly(); }

  const errorMessage = (err) => (err instanceof TypeError ? "Couldn't reach the server — check your connection" : err.message);

  // Call the server's JSON API. Errors carry the HTTP status and the server's error code.
  async function api(method, path, body) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
    const res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) {
      const err = new Error((data && data.error && data.error.message) || `The server returned an error (${res.status})`);
      err.status = res.status;
      err.code = data && data.error ? data.error.code : '';
      err.data = data || {};
      if (res.status === 401 && me) signedOutElsewhere();
      throw err;
    }
    return data;
  }

  function setMe(user, token) {
    me = user || null;
    csrfToken = (user && token) || '';
  }

  // The session ended somewhere else: signed out on another device, disabled, or expired.
  function signedOutElsewhere() {
    setMe(null);
    updateAccountUI();
    toast('You were signed out — sign in again to keep saving to your account');
  }

  async function initAccount() {
    try {
      const res = await fetch('/api/me', { credentials: 'same-origin' });
      if (!res.ok || !(res.headers.get('Content-Type') || '').includes('application/json')) throw new Error('no server');
      const data = await res.json();
      serverAvailable = true;
      setMe(data.user, data.csrfToken);
    } catch {
      serverAvailable = false;  // plain files, or the server is down: the local board still works
    }
    const params = new URLSearchParams(location.search);
    const justSignedIn = params.has('signedin');
    reportSignin(params);

    const id = boardIdFromPath();
    if (id && me) {
      await openCloudBoard(id, { push: false });
    } else {
      if (id) {
        pendingBoardId = id;
        history.replaceState(null, '', '/');
        if (serverAvailable) setTimeout(() => toast('Sign in to open that board'), 0);
      }
      if (loadingBoard) showLocalBoard();
      if (justSignedIn && me && shapes.length) $('#importModal').hidden = false;
    }
    updateAccountUI();
  }

  function reportSignin(params) {
    if (!params.has('signin') && !params.has('signedin')) return;
    const problem = params.get('signin');
    if (problem) toast(SIGNIN_MESSAGES[problem] || SIGNIN_MESSAGES.failed);
    else if (me) toast(`Signed in as ${me.name}`);
    history.replaceState(null, '', location.pathname);
  }

  function updateAccountUI() {
    $('#signInBtn').hidden = !serverAvailable || Boolean(me);
    $('#accountBtn').hidden = !me;
    $('#boardsBtn').hidden = !me;
    $('#accountSection').hidden = !me;
    if (me) {
      const pic = $('#accountPic');
      if (me.picture && pic.getAttribute('src') !== me.picture) pic.src = me.picture;
      pic.hidden = !me.picture;
      $('#accountInitial').hidden = Boolean(me.picture);
      $('#accountInitial').textContent = (me.name || me.email).trim().charAt(0).toUpperCase();
      $('#accountBtn').title = `${me.name} — account`;
      $('#accountName').textContent = me.name;
      $('#accountEmail').textContent = me.email;
      $('#adminLink').hidden = me.role !== 'admin';
      $('#accountInfo').textContent = `Signed in with Google as ${me.googleName || me.email} (${me.email}).`;
      $('#displayNameInput').placeholder = me.googleName || '';
    } else {
      boardsPanel.hidden = true;
      accountMenu.hidden = true;
    }
    updateBoardUI();
  }

  // A profile picture that won't load falls back to the initial.
  $('#accountPic').addEventListener('error', () => {
    $('#accountPic').hidden = true;
    $('#accountInitial').hidden = false;
  });

  $('#signInBtn').addEventListener('click', (e) => {
    e.preventDefault();
    clearTimeout(saveTimer);
    save();  // don't lose the last few strokes to the page change
    const next = pendingBoardId ? `/b/${pendingBoardId}` : location.pathname;
    location.href = `/auth/login?next=${encodeURIComponent(next)}`;
  });

  // Sign out on this device (`request` is the server call that ends the session), keeping any
  // unsaved work in this browser and going back to the local board.
  async function endSession(request, message) {
    const wasCloud = Boolean(cloud);
    await leaveCloudBoard();
    let ok = true;
    try {
      await request();
    } catch (err) {
      ok = err.status === 401;  // already signed out
      if (!ok) toast(errorMessage(err));
    }
    if (wasCloud) {
      showLocalBoard();
      history.pushState(null, '', '/');
    }
    if (ok) {
      setMe(null);
      updateAccountUI();
      if (message) toast(message);
    }
    return ok;
  }

  $('#accountBtn').addEventListener('click', () => togglePopover(accountMenu));
  $('#accountSettingsBtn').addEventListener('click', () => { closePopovers(); openSettings(); });
  $('#signOutBtn').addEventListener('click', () => {
    closePopovers();
    endSession(() => api('POST', '/auth/logout'), 'Signed out');
  });

  // ---------- Account boards ----------
  // An account board saves itself about two seconds after each change. Every save names the
  // version it was based on; if someone else saved in between, the server refuses (409) and the
  // conflict dialog decides. Unsaved changes are also kept in this browser, so a closed tab or a
  // lost connection doesn't lose them.

  const cloudState = (meta) => ({
    id: meta.id,
    title: meta.title,
    owner: meta.owner,
    permission: meta.permission,
    version: meta.version,
    dirty: false,      // changed since the last save started
    saving: null,      // the save in progress (a promise)
    conflict: false,   // someone else saved first; waiting for the conflict dialog
    error: '',         // 'signed-out', or 'rejected' for a save the server won't take as it is
    retries: 0,
    retryTimer: 0,
  });

  // Replace what's on screen with a board from validateBoard(), dropping gestures and selections.
  function showBoard(b) {
    closeReplay();
    if (textEditor) textEditor.blur();
    useBoard(b);
    current = null;
    drag = null;
    lasso = null;
    lassoSelection = [];
    selectedId = null;
    activePointer = null;
    panning = null;
    board.classList.remove('grabbing');
    driveFile = null;
    updateHistoryButtons();
    scheduleRender();
  }

  // Put this device's board back on screen.
  function showLocalBoard() {
    cloud = null;
    loadingBoard = false;
    showBoard(readLocalBoard());
    updateEditing();
    updateBoardUI();
  }

  async function openLocalBoard({ push = true } = {}) {
    if (!cloud) return;
    await leaveCloudBoard();
    showLocalBoard();
    if (push) history.pushState(null, '', '/');
  }

  async function openCloudBoard(id, { push = true } = {}) {
    if (cloud && cloud.id === id) return true;
    await leaveCloudBoard();
    loadingBoard = true;
    updateEditing();
    updateBoardUI();
    try {
      const res = await api('GET', `/api/boards/${encodeURIComponent(id)}`);
      const b = validateBoard(JSON.parse(res.data));  // other people can write shared boards
      loadingBoard = false;
      cloud = cloudState(res.board);
      showBoard(b);
      offerCachedChanges();
      if (push) history.pushState(null, '', `/b/${id}`);
      return true;
    } catch (err) {
      toast(err.status === 404 ? "That board doesn't exist or isn't shared with you"
        : err.status ? errorMessage(err)
        : err instanceof TypeError ? errorMessage(err)
        : "That board's data is damaged, so it can't be opened");
      showLocalBoard();
      if (boardIdFromPath()) history.replaceState(null, '', '/');
      return false;
    } finally {
      updateEditing();
      updateBoardUI();
    }
  }

  // Before another board replaces this one: commit any text being typed and save what's unsaved
  // (a copy stays in this browser if that fails).
  async function leaveCloudBoard() {
    if (textEditor) textEditor.blur();
    if (!cloud) return;
    const leaving = cloud;
    clearTimeout(cloudTimer);
    await pushCloud();
    clearTimeout(leaving.retryTimer);
    clearTimeout(saveTimer);
    if (cloud === leaving) saveCloudCache();
    cloud = null;
  }

  function cloudChanged() {
    if (!cloud || cloud.permission === 'view') return;
    cloud.dirty = true;
    if (!cloud.conflict && !cloud.retryTimer) {
      clearTimeout(cloudTimer);
      cloudTimer = setTimeout(pushCloud, CLOUD_SAVE_DELAY);
    }
    updateBoardUI();
  }

  function pushCloud() {
    const target = cloud;
    if (!target || !target.dirty || target.conflict || target.permission === 'view') return Promise.resolve();
    if (target.saving) return target.saving.then(() => pushCloud());
    clearTimeout(cloudTimer);
    clearTimeout(target.retryTimer);
    target.retryTimer = 0;
    target.dirty = false;
    target.error = '';
    const body = { data: serialize(true), version: target.version };
    target.saving = api('PUT', `/api/boards/${encodeURIComponent(target.id)}`, body)
      .then((res) => {
        target.version = res.version;
        target.retries = 0;
      }, (err) => {
        target.dirty = true;
        saveFailed(target, err);
      })
      .finally(() => {
        target.saving = null;
        if (cloud !== target) return;
        scheduleSave();  // refresh, or drop, this board's copy of unsaved changes
        if (target.dirty && !target.conflict && !target.retryTimer && !target.error) {
          clearTimeout(cloudTimer);
          cloudTimer = setTimeout(pushCloud, CLOUD_SAVE_DELAY);
        }
        updateBoardUI();
      });
    updateBoardUI();
    return target.saving;
  }

  function saveFailed(target, err) {
    const here = cloud === target;
    if (err.status === 409) {
      target.conflict = true;
      if (here) $('#conflictModal').hidden = false;
    } else if (err.status === 404 || (err.status === 403 && err.code === 'forbidden')) {
      // The board was deleted or unshared, or this user can only view it now.
      target.permission = 'view';
      if (here) {
        updateEditing();
        toast("You can't edit this board any more — make a copy to keep your changes");
      }
    } else if (err.status === 401) {
      target.error = 'signed-out';
    } else if (err.status && err.status !== 429 && err.status < 500) {
      target.error = 'rejected';  // too large, storage full…: retried after the next change
      if (here) toast(err.message);
    } else {
      // Offline, server trouble or rate limited: try again, waiting longer each time (up to a minute).
      const delay = Math.min(60000, 2000 * 2 ** target.retries);
      target.retries += 1;
      target.retryTimer = setTimeout(() => {
        target.retryTimer = 0;
        pushCloud();
      }, delay);
    }
  }

  function saveCloudCache() {
    const key = CLOUD_CACHE_PREFIX + cloud.id;
    if (!cloud.dirty && !cloud.saving && !cloud.conflict) {
      removeFromStorage(localStorage, key);
      return;
    }
    try {
      localStorage.setItem(key, JSON.stringify({ base: cloud.version, data: serialize(true) }));
    } catch { /* storage full: the server save is what counts */ }
  }

  function readCloudCache(id) {
    try {
      const cached = JSON.parse(localStorage.getItem(CLOUD_CACHE_PREFIX + id));
      return cached && Number.isInteger(cached.base) ? { base: cached.base, board: validateBoard(cached.data) } : null;
    } catch {
      return null;
    }
  }

  function cloudCacheKeys() {
    try {
      return Object.keys(localStorage).filter((k) => k.startsWith(CLOUD_CACHE_PREFIX));
    } catch {
      return [];
    }
  }

  // Changes from an earlier visit that never reached the server (tab closed, connection lost).
  function offerCachedChanges() {
    const cached = readCloudCache(cloud.id);
    if (!cached) return;
    if (cloud.permission === 'view'
      || !confirm('This board has changes from your last visit that were never saved. Restore them?')) {
      removeFromStorage(localStorage, CLOUD_CACHE_PREFIX + cloud.id);
      return;
    }
    showBoard(cached.board);
    cloud.version = cached.base;  // if someone saved since, saving brings up the conflict choices
    cloudChanged();
  }

  // Save the board on screen as a new account board and switch to it (the local board, or an
  // account board's content as a copy, including changes that couldn't be saved to it).
  async function saveAsNewBoard(title) {
    if (textEditor) textEditor.blur();
    try {
      const res = await api('POST', '/api/boards', { title: title.slice(0, 120), data: serialize(true) });
      if (cloud) {
        clearTimeout(cloudTimer);
        clearTimeout(cloud.retryTimer);
        removeFromStorage(localStorage, CLOUD_CACHE_PREFIX + cloud.id);
      } else {
        clearTimeout(saveTimer);
        save();  // the local board stays on this device as it is
      }
      cloud = cloudState(res.board);
      history.pushState(null, '', `/b/${cloud.id}`);
      updateEditing();
      updateBoardUI();
      toast(`Saved to your account as “${cloud.title}”`);
      return true;
    } catch (err) {
      toast(errorMessage(err));
      return false;
    }
  }

  function cloudStatus() {
    if (loadingBoard) return ['Loading…', false];
    if (!cloud) return ['', false];
    if (cloud.permission === 'view') return [cloud.dirty ? 'View only — changes not saved' : 'View only', cloud.dirty];
    if (cloud.conflict) return ['Not saved — someone else changed it', true];
    if (cloud.error === 'signed-out') return ['Not saved — sign in again', true];
    if (cloud.error) return ['Not saved', true];
    if (cloud.retryTimer) return [navigator.onLine ? 'Not saved — retrying' : 'Offline', true];
    if (cloud.saving || cloud.dirty) return ['Saving…', false];
    return ['Saved', false];
  }

  function updateBoardUI() {
    const showLabel = loadingBoard || Boolean(cloud);
    $('#boardLabel').hidden = !showLabel;
    $('#boardDivider').hidden = !showLabel && !me;
    $('#boardTitle').textContent = cloud ? cloud.title : 'Board';
    const [text, warn] = cloudStatus();
    $('#boardStatus').textContent = text;
    $('#boardStatus').classList.toggle('warn', warn);
    $('#copyBoardBtn').hidden = !(cloud && cloud.permission === 'view' && me);
    document.title = cloud ? `${cloud.title} — Whiteboard` : 'Whiteboard';
  }

  // Replay locks every editing control. A view-only board locks drawing and the edit buttons but
  // keeps export, Drive save and replay.
  function updateEditing() {
    const locked = viewOnly();
    document.querySelectorAll('.toolbar .group:not(.replay-group)').forEach((g) => {
      g.inert = Boolean(replay) || (locked && ['tools', 'colors', 'sizeGroup'].includes(g.id));
    });
    document.body.classList.toggle('view-only', locked);
    $('#clear').disabled = locked;
    $('#driveOpen').disabled = locked;
    if (locked) {
      lassoSelection = [];
      selectedId = null;
    }
    updateHistoryButtons();
    scheduleRender();
  }

  $('#copyBoardBtn').addEventListener('click', () => saveAsNewBoard(`Copy of ${cloud.title}`));

  $('#importCancel').addEventListener('click', () => { $('#importModal').hidden = true; });
  $('#importOk').addEventListener('click', () => {
    $('#importModal').hidden = true;
    saveAsNewBoard(`Board from ${new Date().toLocaleDateString()}`);
  });

  // Conflict: someone else saved this board after it was opened here.
  $('#conflictTheirs').addEventListener('click', () => {
    const id = cloud.id;
    removeFromStorage(localStorage, CLOUD_CACHE_PREFIX + id);
    $('#conflictModal').hidden = true;
    cloud = null;  // drop this version without saving it
    openCloudBoard(id, { push: false });
  });
  $('#conflictCopy').addEventListener('click', async () => {
    if (await saveAsNewBoard(`${cloud.title} (my copy)`)) $('#conflictModal').hidden = true;
  });
  $('#conflictOverwrite').addEventListener('click', async () => {
    if (!confirm('Replace their changes with yours? Their version will be lost.')) return;
    try {
      const res = await api('GET', `/api/boards/${encodeURIComponent(cloud.id)}`);
      cloud.version = res.board.version;
      cloud.conflict = false;
      cloud.dirty = true;
      $('#conflictModal').hidden = true;
      await pushCloud();
    } catch (err) {
      toast(errorMessage(err));
    }
  });

  window.addEventListener('popstate', () => {
    const id = boardIdFromPath();
    if (id && me) openCloudBoard(id, { push: false });
    else if (!id && cloud) openLocalBoard({ push: false });
  });

  window.addEventListener('online', () => {
    if (cloud && cloud.retryTimer) {
      clearTimeout(cloud.retryTimer);
      cloud.retryTimer = 0;
      pushCloud();
    }
  });
  window.addEventListener('offline', updateBoardUI);

  // Leaving the page: write this browser's copy straight away, and try to finish the save.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    clearTimeout(saveTimer);
    save();
    if (cloud && cloud.dirty) pushCloud();
  });
  window.addEventListener('beforeunload', (e) => {
    clearTimeout(saveTimer);
    save();
    if (cloud && (cloud.dirty || cloud.saving)) e.preventDefault();
  });

  // ---------- Boards list ----------

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function actionButton(label, onClick, danger) {
    const b = el('button', danger ? 'text-btn danger' : 'text-btn', label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  const formatSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

  function formatWhen(iso) {
    const d = new Date(iso);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
  }

  function boardMetaText(b) {
    const parts = [];
    if (b.permission !== 'owner') parts.push(`${b.owner.name} · ${b.permission === 'edit' ? 'can edit' : 'can view'}`);
    parts.push(`updated ${formatWhen(b.updatedAt)}`);
    if (b.permission === 'owner') parts.push(formatSize(b.size));
    return parts.join(' · ');
  }

  function boardRow(b) {
    const row = el('div', cloud && cloud.id === b.id ? 'board-row current' : 'board-row');
    const open = el('button', 'board-open');
    open.append(el('span', 'board-title', b.title), el('span', 'board-meta', boardMetaText(b)));
    open.addEventListener('click', () => { closePopovers(); openCloudBoard(b.id); });
    const actions = el('div', 'board-actions');
    if (b.permission !== 'view') actions.append(actionButton('Rename', () => renameBoard(b)));
    if (b.permission === 'owner') actions.append(actionButton('Share', () => openShareDialog(b)));
    actions.append(actionButton('Make a copy', () => copyBoard(b)));
    actions.append(b.permission === 'owner'
      ? actionButton('Delete', () => deleteBoard(b), true)
      : actionButton('Leave', () => leaveBoard(b), true));
    row.append(open, actions);
    return row;
  }

  function localRow() {
    const row = el('div', cloud || loadingBoard ? 'board-row' : 'board-row current');
    const open = el('button', 'board-open');
    open.append(el('span', 'board-title', 'Board on this device'), el('span', 'board-meta', 'Saved in this browser only'));
    open.addEventListener('click', () => { closePopovers(); openLocalBoard(); });
    row.append(open);
    if (!cloud) {
      const actions = el('div', 'board-actions');
      actions.append(actionButton('Save to account', () => {
        closePopovers();
        saveAsNewBoard(`Board from ${new Date().toLocaleDateString()}`);
      }));
      row.append(actions);
    }
    return row;
  }

  async function refreshBoardsList() {
    const list = $('#boardsList');
    if (!list.children.length) list.append(el('p', 'empty', 'Loading…'));
    let data;
    try {
      data = await api('GET', '/api/boards');
    } catch (err) {
      list.replaceChildren(el('p', 'empty', errorMessage(err)));
      return;
    }
    list.replaceChildren(
      el('h3', '', 'On this device'), localRow(),
      el('h3', '', 'My boards'),
      ...(data.owned.length ? data.owned.map(boardRow) : [el('p', 'empty', 'No boards yet — start a new one, or save the board on this device.')]),
      el('h3', '', 'Shared with me'),
      ...(data.shared.length ? data.shared.map(boardRow) : [el('p', 'empty', 'Nothing has been shared with you yet.')]),
    );
  }

  async function renameBoard(b) {
    const title = prompt('Rename board', b.title);
    if (title === null || !title.trim() || title.trim() === b.title) return;
    try {
      const res = await api('PATCH', `/api/boards/${encodeURIComponent(b.id)}`, { title });
      if (cloud && cloud.id === b.id) {
        cloud.title = res.board.title;
        updateBoardUI();
      }
      refreshBoardsList();
    } catch (err) {
      toast(errorMessage(err));
    }
  }

  async function copyBoard(b) {
    try {
      const res = await api('POST', `/api/boards/${encodeURIComponent(b.id)}/copy`);
      toast(`Copied as “${res.board.title}”`);
      refreshBoardsList();
    } catch (err) {
      toast(errorMessage(err));
    }
  }

  // After the board on screen is deleted or left: back to the local board, nothing to save.
  function dropCurrentBoard(id) {
    removeFromStorage(localStorage, CLOUD_CACHE_PREFIX + id);
    if (cloud && cloud.id === id) {
      clearTimeout(cloudTimer);
      clearTimeout(cloud.retryTimer);
      showLocalBoard();
      history.pushState(null, '', '/');
    }
  }

  async function deleteBoard(b) {
    if (!confirm(`Delete “${b.title}”? Anyone it's shared with loses it too. This can't be undone.`)) return;
    try {
      await api('DELETE', `/api/boards/${encodeURIComponent(b.id)}`);
      dropCurrentBoard(b.id);
      toast(`Deleted “${b.title}”`);
      refreshBoardsList();
    } catch (err) {
      toast(errorMessage(err));
    }
  }

  async function leaveBoard(b) {
    if (!confirm(`Remove “${b.title}” from your boards? ${b.owner.name} can share it with you again.`)) return;
    try {
      await api('DELETE', `/api/boards/${encodeURIComponent(b.id)}/shares/me`);
      dropCurrentBoard(b.id);
      refreshBoardsList();
    } catch (err) {
      toast(errorMessage(err));
    }
  }

  $('#boardsBtn').addEventListener('click', () => { if (togglePopover(boardsPanel)) refreshBoardsList(); });
  $('#boardLabel').addEventListener('click', () => {
    if (cloud && cloud.conflict) { $('#conflictModal').hidden = false; return; }
    if (me && togglePopover(boardsPanel)) refreshBoardsList();
  });

  $('#newBoardBtn').addEventListener('click', async () => {
    try {
      const res = await api('POST', '/api/boards', { title: 'Untitled board' });
      closePopovers();
      await openCloudBoard(res.board.id);
    } catch (err) {
      toast(errorMessage(err));
    }
  });

  // ---------- Sharing ----------

  const shareModal = $('#shareModal');
  let sharing = null;  // the board whose sharing dialog is open
  let sharesRequest = 0;  // so a slow, older reply can't overwrite a newer list

  function openShareDialog(b) {
    closePopovers();
    sharing = b;
    $('#shareTitle').textContent = `Share “${b.title}”`;
    $('#shareEmail').value = '';
    $('#shareList').replaceChildren();
    shareModal.hidden = false;
    $('#shareEmail').focus();
    refreshShares();
  }

  async function refreshShares() {
    const request = ++sharesRequest;
    try {
      const res = await api('GET', `/api/boards/${encodeURIComponent(sharing.id)}/shares`);
      if (request !== sharesRequest || !sharing) return;
      $('#shareList').replaceChildren(...res.shares.map(shareItem));
    } catch (err) {
      toast(errorMessage(err));
    }
  }

  function shareItem(s) {
    const li = el('li');
    const who = el('div', 'share-who', s.name || s.email);
    who.append(el('span', '', s.name ? s.email : "hasn't signed in yet"));
    const select = el('select');
    select.setAttribute('aria-label', `Permission for ${s.email}`);
    for (const [value, label] of [['view', 'Can view'], ['edit', 'Can edit']]) {
      const option = el('option', '', label);
      option.value = value;
      select.append(option);
    }
    select.value = s.permission;
    const url = `/api/boards/${encodeURIComponent(sharing.id)}/shares/${encodeURIComponent(s.id)}`;
    select.addEventListener('change', async () => {
      try {
        await api('PATCH', url, { permission: select.value });
        toast(`${s.name || s.email} ${select.value === 'edit' ? 'can now edit' : 'can now only view'}`);
      } catch (err) {
        toast(errorMessage(err));
        refreshShares();
      }
    });
    const remove = actionButton('Remove', async () => {
      try {
        await api('DELETE', url);
        refreshShares();
      } catch (err) {
        toast(errorMessage(err));
      }
    }, true);
    li.append(who, select, remove);
    return li;
  }

  $('#shareForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#shareEmail').value.trim();
    if (!email) return;
    try {
      await api('POST', `/api/boards/${encodeURIComponent(sharing.id)}/shares`, { email, permission: $('#sharePermission').value });
      if ($('#shareEmail').value.trim() === email) $('#shareEmail').value = '';  // not the next one being typed
      toast(`Shared with ${email}`);
      refreshShares();
    } catch (err) {
      toast(errorMessage(err));
    }
  });

  $('#shareCopyLink').addEventListener('click', () => {
    const url = `${location.origin}/b/${sharing.id}`;
    const fallback = () => prompt('Copy this link', url);
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => toast('Link copied'), fallback);
    else fallback();
  });

  const closeShare = () => { shareModal.hidden = true; sharing = null; };
  $('#shareClose').addEventListener('click', closeShare);
  shareModal.addEventListener('click', (e) => { if (e.target === shareModal) closeShare(); });
  shareModal.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeShare(); });

  // ---------- Account settings ----------

  async function saveDisplayName() {
    try {
      const res = await api('PATCH', '/api/me', { displayName: $('#displayNameInput').value });
      me = res.user;
      updateAccountUI();
      toast('Name saved');
    } catch (err) {
      toast(errorMessage(err));
    }
  }

  $('#displayNameSave').addEventListener('click', saveDisplayName);
  // Enter would submit the settings form (which saves the API key), so handle it here.
  $('#displayNameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveDisplayName(); }
  });
  $('#deleteConfirmInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });

  $('#signOutAllBtn').addEventListener('click', async () => {
    if (await endSession(() => api('POST', '/api/me/signout-all'), 'Signed out on all your devices')) closeSettings();
  });

  $('#deleteAccountBtn').addEventListener('click', async () => {
    const email = $('#deleteConfirmInput').value.trim();
    if (!email) { toast('Type your email address to confirm'); return; }
    if (!confirm("Delete your account and every board you own? This can't be undone.")) return;
    try {
      await api('DELETE', '/api/me', { confirmEmail: email });
    } catch (err) {
      toast(errorMessage(err));
      return;
    }
    // The account is gone, and with it every account board: nothing left to save.
    for (const k of cloudCacheKeys()) removeFromStorage(localStorage, k);
    if (cloud) {
      clearTimeout(cloudTimer);
      clearTimeout(cloud.retryTimer);
      showLocalBoard();
      history.pushState(null, '', '/');
    }
    setMe(null);
    updateAccountUI();
    closeSettings();
    toast('Your account was deleted');
  });

  // ---------- Keyboard ----------

  const VIEW_KEYS = [' ', 'Escape', '+', '=', '-', '_', '0', '?'];
  const TOOL_KEYS = { v: 'select', k: 'lasso', h: 'hand', p: 'pen', m: 'highlighter', e: 'eraser', l: 'line', a: 'arrow', r: 'rect', o: 'ellipse', t: 'text' };

  window.addEventListener('keydown', (e) => {
    if (document.querySelector('.modal-backdrop:not([hidden])')) return;  // open dialogs handle their own keys
    if (e.target instanceof Element && e.target.matches('input, textarea')) return;
    const key = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;

    // Editing shortcuts are off while replaying; Esc closes the replay.
    if (replay) {
      if (e.key === 'Escape') closeReplay();
      return;
    }

    if (mod && key === 's') { e.preventDefault(); exportPDF(); return; }
    // On a view-only board only panning, zooming, help and Esc work.
    if (viewOnly() && (mod || !VIEW_KEYS.includes(e.key))) return;
    if (mod && key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && key === 'y') { e.preventDefault(); redo(); return; }
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
      closePopovers();
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
    if (e.key === '?') toggleHelp();
  });

  window.addEventListener('keyup', (e) => {
    if (e.key === ' ') { spaceDown = false; board.classList.remove('space'); }
  });

  window.addEventListener('blur', () => { spaceDown = false; board.classList.remove('space'); });
  window.addEventListener('resize', resize);

  // ---------- Init ----------

  // A /b/<id> address opens an account board once the server says who's signed in. Until then
  // the board stays empty and read-only, rather than showing (and saving over) the local board.
  loadingBoard = Boolean(boardIdFromPath());
  if (!loadingBoard) useBoard(readLocalBoard());
  applyPaper();
  updateEditing();
  setTool(state.tool);
  setSize(state.size);
  resize();
  initAccount();

  // Read-only hook for the replay feature (and for inspecting history from the console).
  window.whiteboard = { timeline };
})();
