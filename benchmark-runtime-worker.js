const BASIC_CONTROL_POLL_MS = 20;
const BASIC_WAIT_POLL_MS = 50;

function runtimeDelay(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

const DEFAULT_BENCHMARK_META = {
  chartHint: 'line',
  xField: 'sampleIndex',
  yField: 'elapsedMs',
  seriesField: '',
  xLabel: 'Sample',
  yLabel: 'Elapsed (ms)',
  title: '',
  subtitle: '',
  description: '',
  colorBy: '',
  styles: {}
};

function applyBenchmarkMeta(capture, fields) {
  if (!capture || !fields) return;
  const map = {
    chart: 'chartHint',
    charthint: 'chartHint',
    x: 'xField',
    xfield: 'xField',
    y: 'yField',
    yfield: 'yField',
    series: 'seriesField',
    seriesfield: 'seriesField',
    xlabel: 'xLabel',
    ylabel: 'yLabel',
    title: 'title',
    subtitle: 'subtitle',
    description: 'description',
    colorby: 'colorBy',
    colorfield: 'colorBy'
  };
  Object.entries(fields).forEach(([key, value]) => {
    const mapped = map[String(key || '').toLowerCase()];
    if (!mapped) return;
    capture.meta[mapped] = value;
    if (mapped === 'title' && String(value || '').trim()) {
      capture.title = String(value).trim();
    }
  });
}

function parseBenchmarkMetaProperty(text) {
  const match = String(text || '').match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([\s\S]*?)\s*$/);
  if (!match) return {};
  return { [match[1].toLowerCase()]: match[2] };
}

function applyBenchmarkStyle(capture, text) {
  if (!capture) return false;
  const match = String(text || '').match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([\s\S]*?)\s*$/);
  if (!match) return false;
  const yField = match[1].toLowerCase();
  const property = match[2].toLowerCase();
  const value = match[3];
  if (!['marker', 'line'].includes(property)) return false;
  if (!capture.meta.styles || typeof capture.meta.styles !== 'object') capture.meta.styles = {};
  capture.meta.styles[yField] = { ...(capture.meta.styles[yField] || {}), [property]: value };
  return true;
}

function createBenchmarkCapture(title = 'BASIC Benchmark') {
  return {
    version: 1,
    title,
    startedAtIso: new Date().toISOString(),
    updatedAtIso: new Date().toISOString(),
    latestSample: null,
    samples: [],
    activeMarkers: new Map(),
    meta: { ...DEFAULT_BENCHMARK_META, styles: { ...DEFAULT_BENCHMARK_META.styles } }
  };
}

function parseBenchmarkFields(text) {
  const fields = {};
  const source = String(text || '');
  const nextKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*\s*=/;
  let index = 0;
  while (index < source.length) {
    while (index < source.length && /\s/.test(source[index])) index++;
    if (index >= source.length) break;

    const keyStart = index;
    while (index < source.length && /[A-Za-z0-9_]/.test(source[index])) index++;
    const rawKey = source.slice(keyStart, index).trim().toLowerCase();
    if (!rawKey || index >= source.length || source[index] !== '=') {
      index++;
      continue;
    }
    index++; // skip '='

    let rawValue = '';
    if (source[index] === '"') {
      index++; // skip opening quote
      const valueStart = index;
      while (index < source.length) {
        if (source[index] === '"' && source[index - 1] !== '\\') break;
        index++;
      }
      rawValue = source.slice(valueStart, index);
      if (index < source.length && source[index] === '"') index++;
    } else {
      const valueStart = index;
      while (index < source.length) {
        if (/\s/.test(source[index])) {
          let lookahead = index;
          while (lookahead < source.length && /\s/.test(source[lookahead])) lookahead++;
          if (nextKeyPattern.test(source.slice(lookahead))) break;
        }
        index++;
      }
      rawValue = source.slice(valueStart, index).trim();
    }

    const numericValue = Number(rawValue);
    fields[rawKey] = Number.isFinite(numericValue) ? numericValue : rawValue;
  }
  return fields;
}

function buildBenchmarkMarkerKey(fields) {
  const distance = Number(fields.distance ?? fields.dist ?? fields.d);
  const accel = Number(fields.accel ?? fields.a);
  const batch = Number(fields.batch ?? fields.passes ?? fields.p ?? 0);
  const repeat = Number(fields.repeat ?? fields.r ?? 1);
  if (Number.isFinite(distance) && Number.isFinite(accel)) {
    return `${distance}|${accel}|${batch}|${repeat}`;
  }

  // Generic BENCH markers (e.g. method=buffered round=1 cmds=500)
  const method = String(fields.method ?? fields.m ?? '').trim().toLowerCase();
  const round = Number(fields.round ?? fields.iter ?? fields.run ?? 0);
  const cmds = Number(fields.cmds ?? fields.commands ?? fields.n ?? 0);
  if (method) {
    return `method:${method}|round:${Number.isFinite(round) ? round : 0}|cmds:${Number.isFinite(cmds) ? cmds : 0}|batch:${batch}|repeat:${repeat}`;
  }

  // Last-resort stable key: all non-timing fields sorted by key.
  const ignoredKeys = new Set(['ms', 'elapsed', 'elapsedms', 'time', 'timestamp', 't']);
  const entries = Object.entries(fields)
    .filter(([key]) => !ignoredKeys.has(String(key).toLowerCase()))
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  if (!entries.length) return '';
  return entries.map(([key, value]) => `${key}=${String(value)}`).join('|');
}

function getBenchmarkYFields(meta) {
  const raw = String(meta?.yField || 'elapsedMs');
  const fields = raw.split(',').map(field => field.trim().toLowerCase()).filter(Boolean);
  return fields.length ? fields : ['elapsedms'];
}

function formatBenchmarkSeriesName(seriesName, yField, hasMultipleYFields) {
  if (!hasMultipleYFields) return seriesName;
  const label = yField === 'elapsedms' ? 'elapsedMs' : yField;
  return seriesName === 'default' ? label : `${seriesName} ${label}`;
}

function buildBenchmarkSeries(samples, meta) {
  const groups = new Map();
  const xField = String(meta?.xField || 'sampleIndex').toLowerCase();
  const yFields = getBenchmarkYFields(meta);
  const hasMultipleYFields = yFields.length > 1;
  const seriesField = String(meta?.seriesField || '').toLowerCase();

  samples.forEach((sample, sampleIndex) => {
    const fields = sample.fields || {};
    const xRaw = xField === 'sampleindex' ? (sampleIndex + 1) : fields[xField];
    const x = Number(xRaw);
    if (!Number.isFinite(x)) return;

    const baseSeriesName = seriesField ? String(fields[seriesField] ?? 'default') : 'default';
    yFields.forEach(yField => {
      const yRaw = yField === 'elapsedms' ? sample.elapsedMs : fields[yField];
      const y = Number(yRaw);
      if (!Number.isFinite(y)) return;

      const seriesName = formatBenchmarkSeriesName(baseSeriesName, yField, hasMultipleYFields);
      if (!groups.has(seriesName)) groups.set(seriesName, []);
      groups.get(seriesName).push({ x, y, yField, sampleIndex, elapsedMs: sample.elapsedMs, fields });
    });
  });

  return Array.from(groups.entries()).map(([name, points]) => ({
    name,
    points: points.sort((a, b) => (a.x - b.x) || (a.sampleIndex - b.sampleIndex))
  }));
}

function buildBenchmarkSummary(series) {
  return series.map(item => {
    const ys = item.points.map(point => Number(point.y)).filter(Number.isFinite);
    if (!ys.length) {
      return { series: item.name, sampleCount: 0, minY: 0, maxY: 0, avgY: 0, latestY: 0 };
    }
    const sum = ys.reduce((acc, value) => acc + value, 0);
    return {
      series: item.name,
      sampleCount: ys.length,
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
      avgY: sum / ys.length,
      latestY: ys[ys.length - 1]
    };
  });
}

function buildCaptureSnapshot(capture) {
  if (!capture) return null;
  const meta = {
    ...DEFAULT_BENCHMARK_META,
    ...(capture.meta || {}),
    styles: { ...DEFAULT_BENCHMARK_META.styles, ...((capture.meta || {}).styles || {}) }
  };
  const series = buildBenchmarkSeries(capture.samples, meta);
  const summary = buildBenchmarkSummary(series);
  const activeMarkers = capture.activeMarkers instanceof Map
    ? Array.from(capture.activeMarkers.entries()).map(([key, marker]) => ({
        key,
        fields: { ...(marker?.fields || {}) },
        startedAtIso: marker?.startedAtIso || null,
        startedPerfMs: Number(marker?.startedPerfMs || 0)
      }))
    : [];
  return {
    version: capture.version,
    title: capture.title,
    startedAtIso: capture.startedAtIso,
    updatedAtIso: capture.updatedAtIso,
    latestSample: capture.latestSample ? { ...capture.latestSample } : null,
    samples: capture.samples.map(sample => ({ ...sample })),
    records: capture.samples.map(sample => ({ ...sample })),
    meta,
    series,
    summary,
    activeMarkers,
    sampleCount: capture.samples.length,
    seriesCount: series.length
  };
}

let benchmarkCapture = null;
let runtimeTransportState = 'disconnected';
let runtimeMachineState = 'unknown';
let runtimeBasicPaused = false;
let runtimeBasicStopRequested = false;
let runtimeMainRequestSeq = 0;
const pendingMainRequests = new Map();

function postBenchmarkState(action, requestId = null, handled = true) {
  self.postMessage({
    type: 'benchmark-state',
    action,
    requestId,
    handled,
    capture: buildCaptureSnapshot(benchmarkCapture)
  });
}

function postRuntimeState() {
  self.postMessage({
    type: 'runtime-state',
    transportState: runtimeTransportState,
    machineState: runtimeMachineState
  });
}

function setRuntimeStates(nextTransportState = runtimeTransportState, nextMachineState = runtimeMachineState) {
  const changed = nextTransportState !== runtimeTransportState || nextMachineState !== runtimeMachineState;
  runtimeTransportState = nextTransportState;
  runtimeMachineState = nextMachineState;
  if (changed) postRuntimeState();
}

function parseRuntimeStatusLine(text) {
  const line = String(text || '');
  if (/^grbl\s/i.test(line)) {
    setRuntimeStates('connected', 'reset');
    return;
  }
  if (line.includes('<Idle')) {
    setRuntimeStates('connected', 'idle');
    return;
  }
  if (line.includes('ALARM') || line.includes('Alarm') || line.includes('<Alarm')) {
    setRuntimeStates('connected', 'alarm');
    return;
  }
  if (line.includes('<Run') || line.includes('<Hold') || line.includes('<Jog') || line.includes('<Home')) {
    setRuntimeStates('connected', 'busy');
  }
}

function recordBenchmarkMessage(message, perfMs, iso) {
  if (!benchmarkCapture) return false;
  const text = String(message || '').trim().replace(/^PRINT:\s*/i, '').trim();
  const metaMatch = text.match(/^BENCH\s+META\b\s*(.*)$/i);
  if (metaMatch) {
    applyBenchmarkMeta(benchmarkCapture, parseBenchmarkMetaProperty(metaMatch[1]));
    benchmarkCapture.updatedAtIso = iso || new Date().toISOString();
    return true;
  }
  const styleMatch = text.match(/^BENCH\s+STYLE\b\s*(.*)$/i);
  if (styleMatch) {
    if (!applyBenchmarkStyle(benchmarkCapture, styleMatch[1])) return false;
    benchmarkCapture.updatedAtIso = iso || new Date().toISOString();
    return true;
  }
  const markerMatch = text.match(/^BENCH\s+(START|END)\b\s*(.*)$/i);
  if (!markerMatch) return false;

  const kind = markerMatch[1].toUpperCase();
  const fields = parseBenchmarkFields(markerMatch[2]);
  const markerKey = buildBenchmarkMarkerKey(fields);
  if (!markerKey) return false;

  const nowIso = iso || new Date().toISOString();
  const nowPerfMs = Number.isFinite(Number(perfMs)) ? Number(perfMs) : performance.now();
  benchmarkCapture.updatedAtIso = nowIso;

  if (kind === 'START') {
    benchmarkCapture.activeMarkers.set(markerKey, {
      fields,
      startedAtIso: nowIso,
      startedPerfMs: nowPerfMs
    });
    return true;
  }

  const activeMarker = benchmarkCapture.activeMarkers.get(markerKey);
  if (!activeMarker) return false;
  benchmarkCapture.activeMarkers.delete(markerKey);

  const sample = {
    markerKey,
    fields: { ...activeMarker.fields, ...fields },
    elapsedMs: Math.max(0, nowPerfMs - activeMarker.startedPerfMs),
    startedAtIso: activeMarker.startedAtIso,
    endedAtIso: nowIso
  };
  benchmarkCapture.samples.push(sample);
  benchmarkCapture.latestSample = sample;
  return true;
}

function requestMainSendCommand(command, displayOverride = null) {
  return new Promise(resolve => {
    const requestId = `runtime-send-${++runtimeMainRequestSeq}`;
    pendingMainRequests.set(requestId, resolve);
    self.postMessage({
      type: 'runtime-send-command',
      requestId,
      command,
      displayOverride
    });
  });
}

async function runtimeWaitForResumeOrStop() {
  while (runtimeBasicPaused && !runtimeBasicStopRequested) {
    await runtimeDelay(BASIC_CONTROL_POLL_MS);
  }
  return !runtimeBasicStopRequested;
}

async function runtimeWaitForIdle(timeoutMs = null) {
  const startedAt = Date.now();
  const normalizedTimeout = timeoutMs == null ? null : Math.max(0, Math.round(Number(timeoutMs) || 0));
  let observedFreshStatus = false;

  while (true) {
    if (!(await runtimeWaitForResumeOrStop())) {
      return { status: 'cancelled', line: 'WAIT_IDLE cancelled' };
    }
    if (observedFreshStatus && runtimeMachineState === 'idle') return { status: 'ok' };
    if (runtimeMachineState === 'alarm') return { status: 'error', line: 'Machine entered ALARM while waiting for idle' };
    if (runtimeTransportState === 'fault' || runtimeTransportState === 'disconnected') {
      return { status: 'error', line: 'Connection fault while waiting for machine to become idle' };
    }
    if (normalizedTimeout !== null && (Date.now() - startedAt) > normalizedTimeout) {
      return { status: 'error', line: `WAIT_IDLE timed out after ${normalizedTimeout} ms` };
    }

    const sent = await requestMainSendCommand('?', '?');
    if (!sent) return { status: 'error', line: 'Failed to send realtime status poll while waiting for idle' };
    observedFreshStatus = true;
    await runtimeDelay(BASIC_WAIT_POLL_MS);
  }
}

async function runtimeWaitForMachineState(targetState, timeoutMs = null) {
  const startedAt = Date.now();
  const normalizedTimeout = timeoutMs == null ? null : Math.max(0, Math.round(Number(timeoutMs) || 0));

  while (true) {
    if (!(await runtimeWaitForResumeOrStop())) {
      return { status: 'cancelled', line: 'WAIT_STATE cancelled' };
    }
    if (runtimeMachineState === targetState) return { status: 'ok' };
    if (runtimeTransportState === 'fault' || runtimeTransportState === 'disconnected') {
      return { status: 'error', line: 'Connection fault while waiting for machine state' };
    }
    if (normalizedTimeout !== null && (Date.now() - startedAt) > normalizedTimeout) {
      return { status: 'error', line: `WAIT_STATE timed out after ${normalizedTimeout} ms` };
    }

    const sent = await requestMainSendCommand('?', '?');
    if (!sent) return { status: 'error', line: 'Failed to send realtime status poll while waiting for machine state' };
    await runtimeDelay(BASIC_WAIT_POLL_MS);
  }
}

self.addEventListener('message', event => {
  const message = event.data || {};
  switch (message.type) {
    case 'runtime-send-command-result': {
      const resolver = pendingMainRequests.get(message.requestId);
      if (!resolver) break;
      pendingMainRequests.delete(message.requestId);
      resolver(Boolean(message.success));
      break;
    }
    case 'runtime-set-connection-state':
      setRuntimeStates(
        String(message.transportState || runtimeTransportState),
        String(message.machineState || runtimeMachineState)
      );
      break;
    case 'runtime-control-state':
      runtimeBasicPaused = Boolean(message.basicPaused);
      runtimeBasicStopRequested = Boolean(message.basicStopRequested);
      break;
    case 'runtime-line':
      if (message.lineType === 'rx') parseRuntimeStatusLine(message.text);
      break;
    case 'runtime-wait-idle':
      void runtimeWaitForIdle(message.timeoutMs).then(result => {
        self.postMessage({ type: 'runtime-wait-result', requestId: message.requestId, ...result });
      });
      break;
    case 'runtime-wait-state':
      void runtimeWaitForMachineState(String(message.targetState || 'unknown'), message.timeoutMs).then(result => {
        self.postMessage({ type: 'runtime-wait-result', requestId: message.requestId, ...result });
      });
      break;
    case 'benchmark-reset':
      benchmarkCapture = createBenchmarkCapture(String(message.title || 'BASIC Benchmark'));
      postBenchmarkState('reset', message.requestId);
      break;
    case 'benchmark-record': {
      const handled = recordBenchmarkMessage(message.message, message.perfMs, message.iso);
      postBenchmarkState('record', message.requestId, handled);
      break;
    }
    case 'benchmark-clear':
      benchmarkCapture = null;
      postBenchmarkState('clear', message.requestId);
      break;
    case 'benchmark-get-state':
      postBenchmarkState('get-state', message.requestId);
      break;
    default:
      break;
  }
});

self.postMessage({
  type: 'benchmark-worker-ready',
  capabilities: {
    dedicatedWorker: true,
    workerSerial: Boolean(self.navigator && 'serial' in self.navigator)
  }
});
