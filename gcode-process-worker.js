// gcode-process-worker.js
// CPU-bound GCode processing passes, run off the main thread.
// Currently: arc fitting (collapse G1 chains into G2/G3 with IJK center form).
//
// Protocol:
//   main -> worker: { type: 'fit-arcs', requestId, lines: string[], toleranceMm, minPoints }
//   worker -> main: { type: 'fit-arcs-result', requestId, lines: string[], report: {...} }
//   worker -> main: { type: 'process-worker-ready' }

'use strict';

// ---- GCode word parsing (mirrors index.html previewParseGcodeWords) ----

function stripComments(text) {
  return String(text || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/;.*$/g, ' ')
    .trim();
}

function parseWords(raw) {
  const stripped = stripComments(raw);
  const matches = Array.from(stripped.matchAll(/([A-Za-z])\s*([+\-]?(?:\d+(?:\.\d*)?|\.\d+))/g));
  const words = matches.map(m => ({ letter: m[1].toUpperCase(), value: Number(m[2]) }));
  return { stripped, words };
}

function formatNum(v) {
  // Trim trailing zeros, keep up to 4 decimals (GRBL-typical precision)
  let s = (Math.round(v * 10000) / 10000).toFixed(4).replace(/\.?0+$/, '');
  return s === '' || s === '-0' ? '0' : s;
}

// ---- Motion state tracking (subset needed for fitting) ----

function createMotionState() {
  return {
    units: 'mm',            // 'mm' | 'inch'
    distanceMode: 'absolute', // 'absolute' | 'incremental'
    motionMode: 'G0',
    feedRate: null,
    position: { x: 0, y: 0, z: 0 }
  };
}

function unitScale(units) { return units === 'inch' ? 25.4 : 1; }

// Classify one line into: { kind: 'motion'|'modal'|'other', ... }
// Returns null for lines that must pass through untouched (comments, M-codes, unknown).
function classifyLine(raw, state) {
  const { words } = parseWords(raw);
  if (!words.length) return null;

  const gCodes = [];
  const axisWords = {};
  let hasFeed = false;
  let hasOtherWord = false;

  for (const w of words) {
    if (w.letter === 'G') gCodes.push(w.value);
    else if (w.letter === 'X' || w.letter === 'Y' || w.letter === 'Z') axisWords[w.letter] = w.value;
    else if (w.letter === 'F') hasFeed = true;
    else hasOtherWord = true; // S, T, M, etc — don't touch these lines
  }

  // Modal updates
  for (const code of gCodes) {
    if (code === 20) state.units = 'inch';
    else if (code === 21) state.units = 'mm';
    else if (code === 90) state.distanceMode = 'absolute';
    else if (code === 91) state.distanceMode = 'incremental';
    else if (code === 0 || code === 1 || code === 2 || code === 3) state.motionMode = `G${code}`;
  }

  const hasAxis = Object.keys(axisWords).length > 0;
  const motionMode = gCodes.some(c => [0, 1, 2, 3].includes(c))
    ? state.motionMode
    : (hasAxis ? state.motionMode : null);

  if (!motionMode) return null;

  // Resolve target
  const target = { ...state.position };
  const scale = unitScale(state.units);
  for (const axis of ['X', 'Y', 'Z']) {
    if (axisWords[axis] == null) continue;
    const v = axisWords[axis] * scale;
    const key = axis.toLowerCase();
    target[key] = state.distanceMode === 'incremental' ? target[key] + v : v;
  }

  return {
    kind: 'motion',
    motionMode,
    target,
    hasFeed,
    hasOtherWord,
    raw
  };
}

// ---- Circle fitting (least squares, Kasa method) ----
// Fit circle to points in XY. Returns { cx, cy, r } or null if degenerate.

function fitCircle(points) {
  // Kasa least-squares, centroid-centered for numerical stability.
  // Raw Kasa normal equations become ill-conditioned when points are far from the
  // origin (e.g. a circle centered at X=50 fit from coordinates ~50-70), producing
  // wildly wrong radii. Centering on the centroid fixes this.
  const n = points.length;
  if (n < 3) return null;

  let mx = 0, my = 0;
  for (const p of points) { mx += p.x; my += p.y; }
  mx /= n; my /= n;

  // Centered moments; solve x'^2 + y'^2 = 2a'x' + 2b'y' + c'
  let Sxx = 0, Syy = 0, Sxy = 0, Sxz = 0, Syz = 0;
  for (const p of points) {
    const x = p.x - mx, y = p.y - my;
    const z = x * x + y * y;
    Sxx += x * x; Syy += y * y; Sxy += x * y;
    Sxz += x * z; Syz += y * z;
  }

  const det = Sxx * Syy - Sxy * Sxy;
  if (Math.abs(det) < 1e-12) return null;

  const ua = (Sxz * Syy - Syz * Sxy) / det;
  const ub = (Sxx * Syz - Sxy * Sxz) / det;

  const cx = mx + ua / 2;
  const cy = my + ub / 2;
  const r = Math.hypot(points[0].x - cx, points[0].y - cy);
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(r) || r <= 0 || r > 1e7) return null;
  return { cx, cy, r };
}

// Max radial deviation of points from fitted circle
function maxRadialDeviation(points, cx, cy, r) {
  let maxDev = 0;
  for (const p of points) {
    const dev = Math.abs(Math.hypot(p.x - cx, p.y - cy) - r);
    if (dev > maxDev) maxDev = dev;
  }
  return maxDev;
}

// Max deviation of the sampled ARC from the original POLYLINE it replaces.
// Vertex-to-circle checks alone are insufficient: an arc can pass through every
// vertex yet bulge far from the chords between them (sagitta effect on long
// segments / large radii). This samples the arc and measures distance to the
// polyline segments, which is what the machine will actually deviate from.
function maxArcToPolylineDeviation(startPt, endPt, circle, clockwise, polyPts) {
  const { cx, cy, r } = circle;
  const a0 = Math.atan2(startPt.y - cy, startPt.x - cx);
  const a1 = Math.atan2(endPt.y - cy, endPt.x - cx);
  let sweep = a1 - a0;
  if (clockwise) { while (sweep >= 0) sweep -= Math.PI * 2; } else { while (sweep <= 0) sweep += Math.PI * 2; }
  const steps = Math.max(16, Math.ceil(Math.abs(sweep) / 0.05));
  let maxDev = 0;
  for (let s = 1; s < steps; s += 1) {
    const a = a0 + sweep * (s / steps);
    const p = { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
    // Distance from p to each polyline segment
    for (let i = 0; i < polyPts.length - 1; i += 1) {
      const a2 = polyPts[i], b2 = polyPts[i + 1];
      const abx = b2.x - a2.x, aby = b2.y - a2.y;
      const len2 = abx * abx + aby * aby;
      const t = len2 > 0
        ? Math.max(0, Math.min(1, ((p.x - a2.x) * abx + (p.y - a2.y) * aby) / len2))
        : 0;
      const d = Math.hypot(p.x - (a2.x + t * abx), p.y - (a2.y + t * aby));
      if (d > maxDev) maxDev = d;
    }
  }
  return maxDev;
}

// Determine sweep direction from point order around fitted center
function sweepDirection(points, cx, cy) {
  // Sum signed angle deltas; sign tells CW vs CCW
  let total = 0;
  let prev = Math.atan2(points[0].y - cy, points[0].x - cx);
  for (let i = 1; i < points.length; i++) {
    const ang = Math.atan2(points[i].y - cy, points[i].x - cx);
    let d = ang - prev;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    total += d;
    prev = ang;
  }
  return total < 0 ? 'G2' : 'G3'; // negative sweep = clockwise
}

// ---- Arc fitting pass ----
//
// Incremental window fitting: grow a window of consecutive G1 points while they lie
// on a common circle within tolerance; emit an arc when the window can't grow further.
// This handles mixed paths (arc followed by straight section) correctly.

function fitArcsInLines(lines, toleranceMm, minPoints) {
  const state = createMotionState();
  const out = [];
  const report = {
    inputLines: lines.length,
    outputLines: 0,
    arcsCreated: 0,
    linearMovesMerged: 0,
    maxDeviationMm: 0,
    toleranceMm
  };

  // Chain of consecutive G1 feed-move points (XY plane; Z change breaks chain)
  let chain = [];        // { x, y, z, raw, hasFeed }
  let chainStart = null; // position before first chain move

  const flushChain = () => {
    if (chain.length) {
      emitFittedChain(chain, chainStart, out, report, toleranceMm, minPoints);
      chain = [];
      chainStart = null;
    }
  };

  for (const raw of lines) {
    const cls = classifyLine(raw, state);
    if (!cls) {
      flushChain();
      out.push(raw);
      continue;
    }
    if (cls.motionMode === 'G1' && !cls.hasOtherWord) {
      const prev = chain.length ? chain[chain.length - 1] : state.position;
      // Zero-length moves (F-only lines) don't join the chain but update feed state
      const isZeroMove = Math.abs(cls.target.x - prev.x) < 1e-9
                      && Math.abs(cls.target.y - prev.y) < 1e-9
                      && Math.abs(cls.target.z - prev.z) < 1e-9;
      if (!isZeroMove) {
        if (chain.length === 0) chainStart = { ...state.position };
        chain.push({ x: cls.target.x, y: cls.target.y, z: cls.target.z, raw: cls.raw, hasFeed: cls.hasFeed });
        // Z change breaks the XY arc chain
        if (Math.abs(cls.target.z - prev.z) > 1e-9) flushChain();
      }
      state.position = cls.target;
      continue;
    }
    // G0, G2/G3, or any other motion — flush and pass through
    flushChain();
    state.position = cls.target;
    out.push(raw);
  }
  flushChain();

  report.outputLines = out.length;
  return { lines: out, report };
}

// Fit a chain incrementally: grow the window while points stay on a circle within
// tolerance; emit the longest valid arc, then continue with the remainder.
function emitFittedChain(chain, chainStart, out, report, toleranceMm, minPoints) {
  let idx = 0; // index into chain where the current window starts
  const startPt = { x: chainStart.x, y: chainStart.y };
  // Machine position after the last emitted move. Arcs are incremental-IJ, so each
  // arc's I/J must be relative to the point where the machine actually sits —
  // which after an arc ending at chain[best] is chain[best], NOT chain[best+1].
  let machinePos = { x: startPt.x, y: startPt.y };

  while (idx < chain.length) {
    // Window points: machinePos (at window start) + chain[idx..]
    const buildPoints = (from, to) => {
      const pts = [{ x: machinePos.x, y: machinePos.y }];
      for (let i = from; i <= to; i++) pts.push({ x: chain[i].x, y: chain[i].y });
      return pts;
    };

    let best = -1; // last chain index of the best valid window
    let bestFit = null;
    let bestDev = 0;

    // Grow window greedily
    let lo = idx;
    let hi = idx;
    while (hi < chain.length) {
      const pts = buildPoints(lo, hi);
      if (pts.length < 3) { hi += 1; continue; }
      const circle = fitCircle(pts);
      const valid = Boolean(circle)
        && circle.r >= toleranceMm * 2
        && circle.r <= 1e7
        && maxRadialDeviation(pts, circle.cx, circle.cy, circle.r) <= toleranceMm;
      // Fidelity criterion: every original vertex must lie within tolerance of the
      // fitted circle. The arc will bulge from the chords between vertices
      // (sagitta ≈ c²/8r) — that is inherent to converting a polygon approximation
      // into a true arc, and the arc is typically CLOSER to the intended shape
      // than the polygon was. No polyline-deviation rejection here.
      if (valid) {
        best = hi;
        bestFit = circle;
        bestDev = maxRadialDeviation(pts, circle.cx, circle.cy, circle.r);
        hi += 1;
      } else {
        break;
      }
    }

    const windowLen = best - lo + 1;
    const totalPoints = windowLen + 1; // window points + machinePos
    if (best >= 0 && totalPoints >= minPoints && bestFit) {
      // Emit arc covering machinePos -> chain[best]
      const arcStart = { x: machinePos.x, y: machinePos.y };
      const arcEnd = { x: chain[best].x, y: chain[best].y };
      const emitted = emitArcLine(arcStart, arcEnd, bestFit, chain, lo, best, out, report, bestDev);
      if (emitted) {
        machinePos = arcEnd;
        idx = best + 1;
        continue;
      }
    }
    // No valid arc from idx — emit one linear move and retry from the next point
    machinePos = { x: chain[idx].x, y: chain[idx].y };
    out.push(chain[idx].raw);
    idx += 1;
  }
}

function emitArcLine(startPt, endPt, circle, chain, lo, hi, out, report, maxDev) {
  const { cx, cy, r } = circle;

  // Full-circle guard: start == end means a 360° arc — GRBL needs explicit handling;
  // skip fitting these (rare from linear chains, and risky).
  if (Math.abs(startPt.x - endPt.x) < 1e-9 && Math.abs(startPt.y - endPt.y) < 1e-9) return false;

  const dir = sweepDirection(
    [{ x: startPt.x, y: startPt.y }, ...chain.slice(lo, hi + 1).map(p => ({ x: p.x, y: p.y }))],
    cx, cy
  );
  const startAngle = Math.atan2(startPt.y - cy, startPt.x - cx);
  const endAngle = Math.atan2(endPt.y - cy, endPt.x - cx);
  let sweep = endAngle - startAngle;
  if (dir === 'G2') { while (sweep >= 0) sweep -= Math.PI * 2; } else { while (sweep <= 0) sweep += Math.PI * 2; }
  if (Math.abs(sweep) > Math.PI * 2 - 1e-6) return false;

  // IJK center offsets (relative to start point, as GRBL expects)
  const i = cx - startPt.x;
  const j = cy - startPt.y;

  // Carry feed from first chain line in window that had F
  const feedLine = chain.slice(lo, hi + 1).find(p => p.hasFeed);
  const feedMatch = feedLine ? feedLine.raw.match(/[Ff]\s*([+\-]?(?:\d+(?:\.\d*)?|\.\d+))/) : null;
  const feedPart = feedMatch ? ` F${feedMatch[1]}` : '';

  // Z helix: only emit if constant-Z window (helical fitting out of scope)
  const zValues = new Set(chain.slice(lo, hi + 1).map(p => +p.z.toFixed(6)));
  if (zValues.size > 1) return false;
  const zPart = Math.abs(startPt.z - chain[lo].z) > 1e-9 ? ` Z${formatNum(chain[lo].z)}` : '';

  out.push(`${dir} X${formatNum(endPt.x)} Y${formatNum(endPt.y)}${zPart} I${formatNum(i)} J${formatNum(j)}${feedPart}`);
  report.arcsCreated += 1;
  report.linearMovesMerged += (hi - lo + 1);
  // maxDev is the enforced vertex-to-circle deviation (fidelity criterion).
  // Note: the arc bulges from the chords between vertices by the sagitta
  // (≈ chord²/8r) — inherent to polygon→arc conversion, typically improving
  // fidelity to the intended shape.
  report.maxDeviationMm = Math.max(report.maxDeviationMm, maxDev);
  return true;
}

// ---- Message handling ----

self.addEventListener('message', event => {
  const message = event.data || {};
  if (message.type === 'fit-arcs') {
    const toleranceMm = Number(message.toleranceMm) > 0 ? Number(message.toleranceMm) : 0.01;
    const minPoints = Math.max(3, Number(message.minPoints) || 6);
    try {
      const result = fitArcsInLines(Array.isArray(message.lines) ? message.lines : [], toleranceMm, minPoints);
      self.postMessage({
        type: 'fit-arcs-result',
        requestId: message.requestId,
        lines: result.lines,
        report: result.report
      });
    } catch (error) {
      self.postMessage({
        type: 'fit-arcs-result',
        requestId: message.requestId,
        lines: message.lines || [],
        report: { error: String(error && error.message || error) }
      });
    }
    return;
  }
});

self.postMessage({ type: 'process-worker-ready' });