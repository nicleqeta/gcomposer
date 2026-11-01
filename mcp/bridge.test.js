import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from 'playwright-core';
import WebSocket from 'ws';
import worker from '../worker.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const edge = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const valid = '; TITLE: Test\n; DESCRIPTION: Test\n; VAR feed=100\n10 PRINT "Test"\n20 END';

test('real MCP client pairs with the app and reviews a draft without machine control', { skip: !existsSync(edge), timeout: 90000 }, async t => {
  const profile = {
    meta: { name: 'Test Machine', notes: 'Test notes' },
    base_controller: 'fluidnc',
    commands: [{ name: 'cut_move', description: 'Cut', gcom: '10 SEND "G1 X1 F100" REQUIRE_OK' }],
    snippets: [{ name: 'example', gcom: '10 END' }],
    presets: { default_feed: 100 }
  };
  const kv = { async get(key) { return key === 'profile:test-profile' ? JSON.stringify(profile) : null; } };
  const assets = {
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const file = resolve(root, path === '/' ? 'index.html' : `.${path}`);
      if (file !== root && !file.startsWith(root + sep)) return new Response('Forbidden', { status: 403 });
      try {
        const content = await readFile(file);
        const types = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json' };
        return new Response(content, { headers: { 'Content-Type': types[extname(file)] || 'application/octet-stream' } });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    }
  };
  const app = createServer(async (req, res) => {
    try {
      const body = [];
      for await (const chunk of req) body.push(chunk);
      const url = `http://127.0.0.1:${app.address().port}${req.url}`;
      const request = new Request(url, { method: req.method, headers: req.headers,
        ...(body.length ? { body: Buffer.concat(body) } : {}) });
      const result = await worker.fetch(request, { ASSETS: assets, GCOM_SCRIPTS: kv });
      res.writeHead(result.status, Object.fromEntries(result.headers));
      res.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      res.writeHead(500).end(String(error.stack || error));
    }
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const origin = `http://127.0.0.1:${app.address().port}`;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(root, 'mcp', 'server.js'), '--origin', origin],
    stderr: 'pipe'
  });
  const client = new Client({ name: 'gcomposer-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(async () => client.close());
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name).sort(), [
    'gcomposer_context', 'gcomposer_draft', 'gcomposer_proposal_status',
    'gcomposer_propose', 'gcomposer_status', 'gcomposer_validate'
  ]);
  const invoke = async (name, args = {}) => client.callTool({ name, arguments: args });
  const data = async (name, args = {}) => JSON.parse((await invoke(name, args)).content[0].text);
  const initial = await data('gcomposer_status');
  assert.equal(initial.connected, false);
  assert.equal((await invoke('gcomposer_draft')).isError, true);
  const pairing = await fetch(initial.pairingPage);
  assert.equal(pairing.status, 200);
  const token = (await pairing.text()).match(/<code>([0-9a-f]{64})<\/code>/)[1];
  const port = new URL(initial.pairingPage).port;
  await assert.rejects(new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { origin: 'https://attacker.invalid' });
    ws.on('open', () => { ws.terminate(); resolve(); });
    ws.on('error', reject);
  }));
  const incompatible = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { origin });
    ws.on('open', () => ws.send(JSON.stringify({ type: 'pair', version: 999, token })));
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    ws.on('error', reject);
  });
  assert.equal(incompatible.code, 1008);
  assert.match(incompatible.reason, /incompatible version/);
  const browser = await chromium.launch({ executablePath: edge, headless: true });
  t.after(async () => browser.close());
  const page = await browser.newPage();
  page.on('dialog', dialog => dialog.accept());
  await page.goto(origin, { waitUntil: 'load' });
  await page.locator('#local-agent-open').click();
  await page.locator('#local-agent-port').fill(port);
  await page.locator('#local-agent-token').fill('0'.repeat(64));
  await page.locator('#local-agent-connect').click();
  await page.getByText('Pairing failed: Pairing rejected or incompatible version').waitFor();
  assert.equal((await data('gcomposer_status')).connected, false);
  await page.locator('#local-agent-token').fill(token);
  await page.locator('#local-agent-connect').click();
  await page.getByText('Connected. The agent can read context and propose drafts.').waitFor();
  assert.equal((await data('gcomposer_status')).connected, true);
  await assert.rejects(new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { origin });
    ws.on('open', () => { ws.terminate(); resolve(); });
    ws.on('error', reject);
  }));
  const context = await data('gcomposer_context');
  assert.equal(context.controller, 'Vanilla GRBL');
  assert.ok(context.gcom_reference);
  assert.ok(context.ack_policy);
  assert.ok(context.ai_guidance.preferred_style);
  assert.ok(context.boilerplate_gcom);
  assert.equal(context.rule_set, undefined);
  assert.equal(context.operations, undefined);
  assert.equal(context.machine, undefined);
  assert.equal(JSON.stringify(context).includes(token), false);
  await page.evaluate(() => {
    setActiveControllerProfile('fluidnc', { persist: false });
    document.getElementById('machine-profile-btn').click();
    document.getElementById('mpd-load').click();
    document.getElementById('mpd-load-input').value = 'test-profile';
    document.getElementById('mpd-load-confirm').click();
  });
  await page.waitForFunction(() => activeMachineProfileId === 'test-profile');
  const machineContext = await data('gcomposer_context');
  assert.match(machineContext.controller, /FluidNC/i);
  assert.match(machineContext.machine_instructions, /Test Machine running fluidnc/);
  assert.equal(machineContext.machine.commands[0].gcom, '10 SEND "G1 X1 F100" REQUIRE_OK');
  assert.equal(machineContext.machine.presets.default_feed, 100);
  assert.ok(machineContext.ack_policy);
  assert.ok(machineContext.ai_guidance.avoid);
  assert.equal(machineContext.operations, undefined);
  assert.equal(machineContext.rule_set, undefined);
  assert.equal((await data('gcomposer_validate', { source: valid })).valid, true);
  assert.equal((await data('gcomposer_validate', { source: '; TITLE: Bad\n10 WHILE 1\n20 END' })).valid, false);
  const before = await data('gcomposer_draft');
  assert.equal((await invoke('gcomposer_propose', { source: '; TITLE: Bad\n10 WHILE 1\n20 END' })).isError, true);
  assert.deepEqual((await data('gcomposer_draft')).draft, before.draft);
  await page.evaluate(() => { basicRunning = true; });
  assert.equal((await invoke('gcomposer_propose', { source: valid })).isError, true);
  await page.evaluate(() => { basicRunning = false; });
  let releaseValidation;
  const heldValidation = new Promise(resolve => { releaseValidation = resolve; });
  await page.route('**/api/validation', async route => {
    await heldValidation;
    await route.continue();
  });
  const timedOutProposal = await invoke('gcomposer_propose', { source: valid });
  assert.equal(timedOutProposal.isError, true);
  assert.match(timedOutProposal.content[0].text, /timed out/);
  releaseValidation();
  await page.unrouteAll({ behavior: 'wait' });
  await page.waitForTimeout(100);
  assert.notEqual((await data('gcomposer_proposal_status')).status, 'pending');
  assert.deepEqual((await data('gcomposer_draft')).draft, before.draft);
  assert.equal((await data('gcomposer_propose', { source: valid })).status, 'pending');
  assert.deepEqual((await data('gcomposer_draft')).draft, before.draft);
  await page.locator('#local-agent-reject').click();
  assert.equal((await data('gcomposer_proposal_status')).status, 'rejected');
  await data('gcomposer_propose', { source: valid });
  await page.evaluate(() => { basicScriptInput.value = '10 PRINT "changed"\n20 END'; });
  await page.locator('#local-agent-approve').click();
  await page.getByText('Draft or machine context changed; reject this proposal and request a new one.').waitFor();
  await page.locator('#local-agent-reject').click();
  await data('gcomposer_propose', { source: valid });
  await page.locator('#local-agent-approve').click();
  await page.getByText('Proposal applied. Review and preview it before running.').waitFor();
  assert.equal((await data('gcomposer_draft')).draft.programText, '10 PRINT "Test"\n20 END');
  await page.locator('#local-agent-restore').click();
  await page.getByText('Previous draft restored.').waitFor();
  assert.equal((await data('gcomposer_draft')).draft.programText, '10 PRINT "changed"\n20 END');
  await page.locator('#local-agent-disconnect').click();
  assert.equal((await invoke('gcomposer_draft')).isError, true);
  const nextToken = (await (await fetch(initial.pairingPage)).text()).match(/<code>([0-9a-f]{64})<\/code>/)[1];
  assert.notEqual(nextToken, token);
});

test('connector reports browser request timeout and disconnection', { timeout: 45000 }, async t => {
  const origin = 'http://127.0.0.1:32123';
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(root, 'mcp', 'server.js'), '--origin', origin],
    stderr: 'pipe'
  });
  const client = new Client({ name: 'gcomposer-timeout-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(async () => client.close());
  const invoke = async name => client.callTool({ name, arguments: {} });
  const status = JSON.parse((await invoke('gcomposer_status')).content[0].text);
  const token = (await (await fetch(status.pairingPage)).text()).match(/<code>([0-9a-f]{64})<\/code>/)[1];
  const ws = new WebSocket(`ws://127.0.0.1:${new URL(status.pairingPage).port}/bridge`, { origin });
  t.after(() => ws.terminate());
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'pair', version: 1, token }));
  await once(ws, 'message');
  const timedOut = await invoke('gcomposer_context');
  assert.equal(timedOut.isError, true);
  assert.match(timedOut.content[0].text, /timed out/);
  const waiting = invoke('gcomposer_context');
  await once(ws, 'message');
  ws.close();
  const disconnected = await waiting;
  assert.equal(disconnected.isError, true);
  assert.match(disconnected.content[0].text, /disconnected/);
});
