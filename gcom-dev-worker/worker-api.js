// Minimal API-only Worker for api.gcom.dev
// Only exposes /api/validation endpoint, no static assets, no GCOM_SCRIPTS or AI bindings

const SCRIPT_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function initializeValidationState() {
  return {
    all: [], byLine: {}, byCode: {}, bySeverity: { error: [], warning: [], info: [] },
    summary: { totalCount: 0, errorCount: 0, warningCount: 0, infoCount: 0, firstError: null, lastUpdated: null }
  };
}

function addValidationDiagnostic(state, diagnostic) {
  state.all.push(diagnostic);
  const ln = diagnostic.lineNum;
  if (ln != null) { if (!state.byLine[ln]) state.byLine[ln] = []; state.byLine[ln].push(diagnostic); }
  const code = diagnostic.code;
  if (!state.byCode[code]) state.byCode[code] = []; state.byCode[code].push(diagnostic);
  state.bySeverity[diagnostic.severity].push(diagnostic);
  state.summary.totalCount = state.all.length;
  state.summary.errorCount = state.bySeverity.error.length;
  state.summary.warningCount = state.bySeverity.warning.length;
  state.summary.infoCount = state.bySeverity.info.length;
  if (state.summary.errorCount > 0 && !state.summary.firstError) state.summary.firstError = state.bySeverity.error[0];
  state.summary.lastUpdated = new Date().toISOString();
}

function createValidationDiagnostic(lineNum, code, severity, message) {
  return {
    lineNum: Number(lineNum) || null, code: String(code), severity: String(severity).toLowerCase(),
    message: String(message), timestamp: new Date().toISOString()
  };
}

function validateGcomSource(source, vars = {}, state = null) {
  if (!state) state = initializeValidationState();
  const lines = {}, order = [];
  const addErr = (ln, msg, code) => addValidationDiagnostic(state, createValidationDiagnostic(ln, code, 'error', msg));
  source.split('\n').forEach((rawLine, idx) => {
    const trimmed = String(rawLine || '').trim();
    if (!trimmed || trimmed.startsWith('REM')) return;
    const match = trimmed.match(/^(\d+)\s+(.*)$/);
    if (!match) { addErr(idx + 1, `expected "<line-number> <statement>"`, 'E003'); return; }
    const lineNum = parseInt(match[1], 10);
    if (lines[lineNum]) { addErr(lineNum, `duplicate line number`, 'E004'); return; }
    lines[lineNum] = match[2]; order.push(lineNum);
  });
  if (order.length && !/^END$/i.test(lines[order[order.length - 1]])) {
    addErr(order[order.length - 1], `program must end with END`, 'E010');
  }
  return { diagnostics: state, lines, order };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    // List all presets
    if (url.pathname === '/presets') {
      if (request.method !== 'GET') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json', ...SCRIPT_CORS_HEADERS }
        });
      }
      // List all preset files
      // NOTE: In a real Worker, use a manifest or KV; here, hardcode for demo
      return new Response(JSON.stringify([
        'ortur-laser-marking'
      ]), { headers: { 'Content-Type': 'application/json', ...SCRIPT_CORS_HEADERS } });
    }
    // List all controllers
    if (url.pathname === '/controllers') {
      if (request.method !== 'GET') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json', ...SCRIPT_CORS_HEADERS }
        });
      }
      return new Response(JSON.stringify([
        'grbl-base'
      ]), { headers: { 'Content-Type': 'application/json', ...SCRIPT_CORS_HEADERS } });
    }
    // List all machines
    if (url.pathname === '/machines') {
      if (request.method !== 'GET') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json', ...SCRIPT_CORS_HEADERS }
        });
      }
      return new Response(JSON.stringify([
        'ortur-lm2pro-s2'
      ]), { headers: { 'Content-Type': 'application/json', ...SCRIPT_CORS_HEADERS } });
    }
    // List all policies
    if (url.pathname === '/policies') {
      if (request.method !== 'GET') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json', ...SCRIPT_CORS_HEADERS }
        });
      }
      return new Response(JSON.stringify([
        'laser_marking'
      ]), { headers: { 'Content-Type': 'application/json', ...SCRIPT_CORS_HEADERS } });
    }
    // Fetch a preset manifest
    if (url.pathname.startsWith('/presets/')) {
      if (request.method !== 'GET') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json', ...SCRIPT_CORS_HEADERS }
        });
      }
      const presetId = url.pathname.split('/')[2];
      async function fetchRuleFile(path) {
        const res = await fetch(new URL(path, request.url).origin + '/rules/' + path);
        if (!res.ok) throw new Error('Failed to load rule file: ' + path);
        return await res.json();
      }
      try {
        const preset = await fetchRuleFile('presets/' + presetId + '.json');
        const controller = await fetchRuleFile('controllers/' + preset.controller + '.json');
        const machine = await fetchRuleFile('machines/' + preset.machine + '.json');
        const policy = await fetchRuleFile('policies/' + preset.policy + '.json');
        const language = await fetchRuleFile('language/gcom-core.json');
        const allRules = [
          ...language.rules,
          ...(controller.rules || []),
          ...(machine.rules || []),
          ...(policy.rules || [])
        ];
        return new Response(JSON.stringify({
          presetId,
          preset,
          controller,
          machine,
          policy,
          language,
          activeRules: allRules
        }), { headers: { 'Content-Type': 'application/json', ...SCRIPT_CORS_HEADERS } });
      } catch (error) {
        return new Response(JSON.stringify({ error: 'Failed to load preset', details: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...SCRIPT_CORS_HEADERS }
        });
      }
    }
      if (request.method === 'OPTIONS') {
        return new Response(null, { headers: SCRIPT_CORS_HEADERS });
      }
      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json', ...SCRIPT_CORS_HEADERS }
        });
      }
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Invalid JSON', details: e.message }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...SCRIPT_CORS_HEADERS }
        });
      }
      const source = String(body.source || '').trim();
      const vars = body.vars && typeof body.vars === 'object' ? body.vars : {};
      const profile = String(body.profile || body.preset || 'ortur-laser-marking').trim();
      if (!source) {
        return new Response(JSON.stringify({ error: 'Missing source code' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...SCRIPT_CORS_HEADERS }
        });
      }
      // Helper to fetch a rule file by path
      async function fetchRuleFile(path) {
        const res = await fetch(new URL(path, request.url).origin + '/rules/' + path);
        if (!res.ok) throw new Error('Failed to load rule file: ' + path);
        return await res.json();
      }
      // Load and merge rules for the selected profile
      async function loadActiveRules(profileId) {
        // Load preset
        const preset = await fetchRuleFile('presets/' + profileId + '.json');
        // Load controller, machine, policy
        const controller = await fetchRuleFile('controllers/' + preset.controller + '.json');
        const machine = await fetchRuleFile('machines/' + preset.machine + '.json');
        const policy = await fetchRuleFile('policies/' + preset.policy + '.json');
        // Load language core
        const language = await fetchRuleFile('language/gcom-core.json');
        // Merge rules (simple concat for now)
        const allRules = [
          ...language.rules,
          ...(controller.rules || []),
          ...(machine.rules || []),
          ...(policy.rules || [])
        ];
        return { allRules, preset, controller, machine, policy, language };
      }
      try {
        const { allRules, preset, controller, machine, policy, language } = await loadActiveRules(profile);
        // For now, just pass rules to validation (expand logic later)
        const result = validateGcomSource(source, vars);
        result.activeRules = allRules;
        result.profile = profile;
        result.preset = preset;
        return new Response(JSON.stringify({
          success: true,
          diagnostics: result.diagnostics.all,
          summary: result.diagnostics.summary,
          byLine: result.diagnostics.byLine,
          bySeverity: result.diagnostics.bySeverity,
          activeRules,
          profile,
          preset,
          timestamp: new Date().toISOString()
        }), {
          headers: { 'Content-Type': 'application/json', ...SCRIPT_CORS_HEADERS }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: 'Validation failed', details: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...SCRIPT_CORS_HEADERS }
        });
      }
    }
    // All other routes: 404
    return new Response('Not found', { status: 404 });
  }
};
