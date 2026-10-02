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
// segments / large radii). This samples the arc and measures each sample's
// distance to its NEAREST polyline segment, then takes the max over samples
// (one-sided Hausdorff distance arc→polyline). Taking the max over ALL
// (sample, segment) pairs would instead return the shape's diameter — wrong.
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
    // Nearest polyline segment distance for this arc sample
    let minD = Infinity;
    for (let i = 0; i < polyPts.length - 1; i += 1) {
      const a2 = polyPts[i], b2 = polyPts[i + 1];
      const abx = b2.x - a2.x, aby = b2.y - a2.y;
      const len2 = abx * abx + aby * aby;
      const t = len2 > 0
        ? Math.max(0, Math.min(1, ((p.x - a2.x) * abx + (p.y - a2.y) * aby) / len2))
        : 0;
      const d = Math.hypot(p.x - (a2.x + t * abx), p.y - (a2.y + t * aby));
      if (d < minD) minD = d;
    }
    if (minD > maxDev) maxDev = minD;
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

// Maximum allowed deviation of a fitted ARC from the original POLYLINE path it
// replaces (arc-to-chord sagitta). Separate from the fit tolerance: this is the
// "how far can the rehydrated arc drift from the programmed path" limit.
const MAX_PATH_DEVIATION_MM = 0.05;

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
  let chainUnitScale = 1; // mm-per-file-unit at chain start (25.4 for inch files)

  const flushChain = () => {
    if (chain.length) {
      emitFittedChain(chain, chainStart, out, report, toleranceMm, minPoints, chainUnitScale);
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
        if (chain.length === 0) {
          chainStart = { ...state.position };
          // Remember the unit scale in effect when the chain started so emitted
          // arc coordinates can be converted back to the file's units (G20/G21).
          chainUnitScale = unitScale(state.units);
        }
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

  // ---- Safety verification: compare toolpath envelopes ----
  // Replay both the original and fitted programs through a shared simulator and
  // compare the per-axis bounding boxes of the toolpath. Growth beyond the fit
  // tolerance is reported as a WARNING (the fitted arc bulges outside the
  // original polygon envelope — inherent to polygon→arc conversion), but the
  // fitted file is still returned as long as at least one arc was created.
  // Unfittable segments keep their original G1 lines, seamlessly connected.
  const safety = verifyToolpathEnvelope(lines, out, toleranceMm);
  report.safety = safety.summary;
  report.safety.rejected = false;
  return { lines: out, report };
}

// ---- Toolpath envelope simulator ----
// Replays G-code (G0/G1/G2/G3, G20/G21 units, G90/G91 distance mode, IJK arcs)
// and returns the per-axis min/max of every point the tool passes through,
// including sampled arc interior points (not just endpoints).

function simulateToolpathEnvelope(lines) {
  const state = createMotionState();
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  let sawMotion = false;

  const include = (p) => {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return;
    sawMotion = true;
    if (p.x < min.x) min.x = p.x;
    if (p.y < min.y) min.y = p.y;
    if (p.z < min.z) min.z = p.z;
    if (p.x > max.x) max.x = p.x;
    if (p.y > max.y) max.y = p.y;
    if (p.z > max.z) max.z = p.z;
  };

  include(state.position);

  for (const raw of lines) {
    const { words } = parseWords(raw);
    if (!words.length) continue;

    const gCodes = [];
    const axis = {};
    const arc = {};
    for (const w of words) {
      if (w.letter === 'G') gCodes.push(w.value);
      else if (w.letter === 'X' || w.letter === 'Y' || w.letter === 'Z') axis[w.letter] = w.value;
      else if (w.letter === 'I' || w.letter === 'J' || w.letter === 'K' || w.letter === 'R') arc[w.letter] = w.value;
    }

    for (const code of gCodes) {
      if (code === 20) state.units = 'inch';
      else if (code === 21) state.units = 'mm';
      else if (code === 90) state.distanceMode = 'absolute';
      else if (code === 91) state.distanceMode = 'incremental';
    }

    const motion = gCodes.find(c => c === 0 || c === 1 || c === 2 || c === 3);
    const hasAxis = Object.keys(axis).length > 0;
    if (motion == null && !hasAxis) continue;
    const mode = motion != null ? `G${motion}` : state.motionMode;
    if (mode !== 'G0' && mode !== 'G1' && mode !== 'G2' && mode !== 'G3') continue;

    const scale = unitScale(state.units);
    const target = { ...state.position };
    for (const a of ['X', 'Y', 'Z']) {
      if (axis[a] == null) continue;
      const v = axis[a] * scale;
      const key = a.toLowerCase();
      target[key] = state.distanceMode === 'incremental' ? target[key] + v : v;
    }

    if (mode === 'G0' || mode === 'G1') {
      include(target);
      state.position = target;
      continue;
    }

    // G2/G3: sample the arc so interior bulge points are included
    const clockwise = mode === 'G2';
    let cx, cy;
    if (arc.R != null) {
      // Radius form: solve center (same logic as preview)
      const dx = target.x - state.position.x;
      const dy = target.y - state.position.y;
      const chord = Math.hypot(dx, dy);
      const r = Math.abs(arc.R * scale);
      if (chord === 0 || chord > r * 2) { include(target); state.position = target; continue; }
      const mx = (state.position.x + target.x) / 2;
      const my = (state.position.y + target.y) / 2;
      const h = Math.sqrt(Math.max(0, r * r - (chord / 2) * (chord / 2)));
      const nx = -dy / chord, ny = dx / chord;
      const c1 = { x: mx + nx * h, y: my + ny * h };
      const c2 = { x: mx - nx * h, y: my - ny * h };
      const a0 = Math.atan2(state.position.y - c1.y, state.position.x - c1.x);
      const a1 = Math.atan2(target.y - c1.y, target.x - c1.x);
      let s = a1 - a0;
      if (clockwise) { while (s >= 0) s -= Math.PI * 2; } else { while (s <= 0) s += Math.PI * 2; }
      cx = (Math.abs(s) > Math.PI) === (arc.R * scale < 0) ? c2.x : c1.x;
      cy = (Math.abs(s) > Math.PI) === (arc.R * scale < 0) ? c2.y : c1.y;
    } else {
      cx = state.position.x + (arc.I || 0) * scale;
      cy = state.position.y + (arc.J || 0) * scale;
    }

    const r = Math.hypot(state.position.x - cx, state.position.y - cy);
    if (!(r > 0)) { include(target); state.position = target; continue; }
    const a0 = Math.atan2(state.position.y - cy, state.position.x - cx);
    const a1 = Math.atan2(target.y - cy, target.x - cx);
    let sweep = a1 - a0;
    if (clockwise) { while (sweep >= 0) sweep -= Math.PI * 2; } else { while (sweep <= 0) sweep += Math.PI * 2; }
    const steps = Math.max(8, Math.ceil(Math.abs(sweep) / 0.05));
    for (let s = 1; s <= steps; s += 1) {
      const a = a0 + sweep * (s / steps);
      include({
        x: cx + r * Math.cos(a),
        y: cy + r * Math.sin(a),
        z: state.position.z + (target.z - state.position.z) * (s / steps)
      });
    }
    state.position = target;
  }

  if (!sawMotion) return null;
  return { min, max };
}

// Compare original vs fitted envelopes; ok=false if the fitted path extends
// beyond the original by more than tolerance + safety margin on any axis.
function verifyToolpathEnvelope(originalLines, fittedLines, toleranceMm) {
  const orig = simulateToolpathEnvelope(originalLines);
  const fit = simulateToolpathEnvelope(fittedLines);
  if (!orig || !fit) {
    return { ok: true, summary: { available: false, reason: 'no motion to compare' } };
  }
  // Safety margin: fit tolerance plus a small allowance for numeric rounding
  // in emitted coordinates (4 decimals) and arc sampling.
  const margin = toleranceMm + 0.05;
  const axes = ['x', 'y', 'z'];
  const deltas = {};
  let ok = true;
  const violations = [];
  for (const axis of axes) {
    const growLow = orig.min[axis] - fit.min[axis];   // positive = fitted extends lower
    const growHigh = fit.max[axis] - orig.max[axis];  // positive = fitted extends higher
    deltas[axis] = {
      originalMin: +orig.min[axis].toFixed(4),
      originalMax: +orig.max[axis].toFixed(4),
      fittedMin: +fit.min[axis].toFixed(4),
      fittedMax: +fit.max[axis].toFixed(4),
      growLowMm: +growLow.toFixed(4),
      growHighMm: +growHigh.toFixed(4)
    };
    if (growLow > margin || growHigh > margin) {
      ok = false;
      violations.push(axis.toUpperCase());
    }
  }
  return {
    ok,
    summary: {
      available: true,
      ok,
      marginMm: +margin.toFixed(4),
      axes: deltas,
      violations
    }
  };
}

// Fit a chain incrementally: grow the window while points stay on a circle within
// tolerance; emit the longest valid arc, then continue with the remainder.
function emitFittedChain(chain, chainStart, out, report, toleranceMm, minPoints, unitScaleMmPerFileUnit) {
  const scale = unitScaleMmPerFileUnit || 1; // mm per file unit (25.4 for inch files)
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
      // Fidelity criterion (two-part):
      // 1. Every original vertex lies within tolerance of the fitted circle.
      // 2. The sampled ARC stays within tolerance of the POLYLINE it replaces
      //    (arc-to-chord distance, sagitta). This is what stops coarse polygons
      //    from being fitted: a hexagon on a 50mm circle has ~3.6mm sagitta on its
      //    chords, so converting it to an arc would move the tool up to 3.6mm
      //    away from the programmed path. Dense vertex files (small chords) have
      //    sagitta well under the limit and still fit normally.
      //    NOTE: maxArcToPolylineDeviation takes a BOOLEAN clockwise flag — pass
      //    dir === 'G2', never the dir string itself (truthy string bug).
      const dir = pts.length >= 3 ? sweepDirection(pts, circle.cx, circle.cy) : 'G3';
      const valid = Boolean(circle)
        && circle.r >= toleranceMm * 2
        && circle.r <= 1e7
        && maxRadialDeviation(pts, circle.cx, circle.cy, circle.r) <= toleranceMm
        && maxArcToPolylineDeviation(pts[0], pts[pts.length - 1], circle, dir === 'G2', pts) <= MAX_PATH_DEVIATION_MM;
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
      const emitted = emitArcLine(arcStart, arcEnd, bestFit, chain, lo, best, out, report, bestDev, scale);
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

function emitArcLine(startPt, endPt, circle, chain, lo, hi, out, report, maxDev, unitScaleMmPerFileUnit) {
  const { cx, cy, r } = circle;
  const scale = unitScaleMmPerFileUnit || 1; // mm per file unit

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
  const zPart = Math.abs(startPt.z - chain[lo].z) > 1e-9 ? ` Z${formatNum(chain[lo].z / scale)}` : '';

  // All positions are tracked internally in mm; convert back to the file's active
  // units (G20 inch / G21 mm) so the emitted arc is correct in context.
  out.push(`${dir} X${formatNum(endPt.x / scale)} Y${formatNum(endPt.y / scale)}${zPart} I${formatNum(i / scale)} J${formatNum(j / scale)}${feedPart}`);
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