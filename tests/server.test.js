import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-test-'));
process.env.SUBMISSIONS_DIR = tmp;

const { loadOpportunities, searchOpportunities, CLUSTERS } = await import('../server/opportunities.js');
const { streamChat, ChatRequestSchema, _internal } = await import('../server/ai.js');
const { createApp } = await import('../server/index.js');

const opportunities = loadOpportunities();

// ---------------------------------------------------------------------------
describe('opportunities database', () => {
  test('loads, validates, and covers every cluster', () => {
    assert.ok(opportunities.length >= 200, `expected 200+ opportunities, got ${opportunities.length}`);
    for (const key of Object.keys(CLUSTERS)) {
      assert.ok(opportunities.some((o) => o.cluster === key), `no opportunities in ${key}`);
    }
  });

  test('ids are unique and all links use https', () => {
    const ids = new Set(opportunities.map((o) => o.id));
    assert.equal(ids.size, opportunities.length);
    assert.ok(opportunities.every((o) => o.url.startsWith('https://')));
  });

  test('contains no references to the old competition branding', () => {
    const text = JSON.stringify(opportunities);
    assert.doesNotMatch(text, /\bTSA\b|Technology Student Association/);
  });

  test('search ranks keyword matches and applies filters', () => {
    const robotics = searchOpportunities(opportunities, { query: 'robotics', limit: 5 });
    assert.ok(robotics.length > 0);
    assert.match(robotics[0].title, /robot/i);

    const free11 = searchOpportunities(opportunities, { grade: 11, cost: 'Free' });
    assert.ok(free11.length > 0);
    assert.ok(free11.every((o) => o.grades.includes(11) && o.cost === 'Free'));

    assert.equal(searchOpportunities(opportunities, { query: 'zzzz-not-a-thing' }).length, 0);
  });
});

// ---------------------------------------------------------------------------
describe('Zeus AI', () => {
  test('tools only expose real database records', () => {
    const search = _internal.runTool('search_opportunities', { query: 'scholarship', limit: 3 }, opportunities);
    const parsed = JSON.parse(search.content);
    assert.ok(parsed.results.length <= 3);
    assert.ok(parsed.results.every((r) => opportunities.some((o) => o.id === r.id)));

    const missing = _internal.runTool('get_opportunity', { id: 'does-not-exist' }, opportunities);
    assert.equal(missing.isError, true);

    const invalid = _internal.runTool('search_opportunities', { cluster: 'Nope' }, opportunities);
    assert.equal(invalid.isError, true);
  });

  test('drops model-internal blocks before a refusal fallback boundary', () => {
    const content = [
      { type: 'thinking', thinking: '' },
      { type: 'text', text: 'partial' },
      { type: 'tool_use', id: 'a', name: 'x', input: {} },
      { type: 'fallback', from: { model: 'a' }, to: { model: 'b' } },
      { type: 'tool_use', id: 'b', name: 'x', input: {} },
    ];
    assert.deepEqual(_internal.echoableContent(content).map((b) => b.type), ['text', 'tool_use']);
    const plain = [{ type: 'text', text: 'hi' }];
    assert.equal(_internal.echoableContent(plain), plain);
  });

  test('request schema rejects malformed conversations', () => {
    assert.equal(ChatRequestSchema.safeParse({ messages: [{ role: 'user', content: 'hi' }] }).success, true);
    assert.equal(ChatRequestSchema.safeParse({ messages: [{ role: 'assistant', content: 'hi' }] }).success, false);
    assert.equal(ChatRequestSchema.safeParse({ messages: [{ role: 'system', content: 'hi' }] }).success, false);
    assert.equal(ChatRequestSchema.safeParse({ messages: [{ role: 'user', content: 'x'.repeat(5000) }] }).success, false);
    assert.equal(ChatRequestSchema.safeParse({ messages: [{ role: 'user', content: 'hi' }], extra: 1 }).success, false);
  });

  test('runs the tool loop and streams text', async () => {
    const calls = [];
    const fakeStream = (message) => {
      const handlers = [];
      return {
        on(evt, fn) { if (evt === 'text') handlers.push(fn); return this; },
        async finalMessage() {
          for (const b of message.content) if (b.type === 'text') handlers.forEach((h) => h(b.text));
          return message;
        },
      };
    };
    const client = { beta: { messages: { stream(params) {
      calls.push(structuredClone(params));
      if (calls.length === 1) {
        return fakeStream({ stop_reason: 'tool_use', content: [
          { type: 'text', text: 'Searching.' },
          { type: 'tool_use', id: 'tu_1', name: 'search_opportunities', input: { query: 'coding', limit: 2 } },
        ] });
      }
      return fakeStream({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] });
    } } } };

    const events = [];
    await streamChat({
      messages: [{ role: 'user', content: 'coding programs?' }],
      profile: { grade: 10, interests: ['STEM'] },
      opportunities,
      send: (e) => events.push(e),
      client,
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].model, _internal.MODEL);
    assert.deepEqual(calls[0].output_config, { effort: process.env.ZEUS_EFFORT || 'medium' });
    assert.match(calls[0].system[1].text, /<student_profile>/);
    const toolResultMsg = calls[1].messages.at(-1);
    assert.equal(toolResultMsg.role, 'user');
    assert.equal(toolResultMsg.content[0].type, 'tool_result');
    assert.equal(toolResultMsg.content[0].tool_use_id, 'tu_1');

    const text = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
    assert.equal(text, 'Searching.\n\nDone.');
    assert.equal(events.at(-1).type, 'done');
  });

  test('handles refusals without running tools', async () => {
    const client = { beta: { messages: { stream: () => ({
      on() { return this; },
      finalMessage: async () => ({ stop_reason: 'refusal', content: [{ type: 'tool_use', id: 'x', name: 'search_opportunities', input: {} }] }),
    }) } } };
    const events = [];
    await streamChat({ messages: [{ role: 'user', content: 'hi' }], opportunities, send: (e) => events.push(e), client });
    assert.ok(events.some((e) => e.type === 'text' && /can't help/.test(e.text)));
    assert.ok(!events.some((e) => e.type === 'status' && e.text));
  });
});

// ---------------------------------------------------------------------------
describe('HTTP API', () => {
  let server;
  let base;
  let offlineServer;
  let offlineBase;

  before(async () => {
    const chatHandler = async ({ send }) => {
      send({ type: 'text', text: 'Hello from a test.' });
      send({ type: 'done' });
    };
    server = createApp({ opportunities, chatHandler, aiConfigured: true }).listen(0);
    offlineServer = createApp({ opportunities, aiConfigured: false }).listen(0);
    await Promise.all([server, offlineServer].map((s) => new Promise((r) => s.once('listening', r))));
    base = `http://127.0.0.1:${server.address().port}`;
    offlineBase = `http://127.0.0.1:${offlineServer.address().port}`;
  });

  after(() => {
    server.close();
    offlineServer.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('sends security headers', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-powered-by'), null);
  });

  test('serves pages, vendor assets, and a 404 page', async () => {
    for (const p of ['/dashboard', '/profile', '/submission', '/references', '/vendor/lucide/lucide.min.js']) {
      assert.equal((await fetch(base + p)).status, 200, p);
    }
    assert.equal((await fetch(`${base}/missing-page`)).status, 404);
    assert.equal((await fetch(`${base}/api/missing`)).status, 404);
  });

  test('does not expose server source or data files', async () => {
    for (const p of ['/server/index.js', '/package.json', '/.env', '/data/opportunities/stem.json', '/../server/ai.js']) {
      assert.equal((await fetch(base + p)).status, 404, p);
    }
  });

  test('returns opportunities with cluster metadata', async () => {
    const json = await (await fetch(`${base}/api/opportunities`)).json();
    assert.equal(json.count, opportunities.length);
    assert.ok(json.clusters.STEM);
    assert.ok(Array.isArray(json.types));
  });

  test('streams chat responses as server-sent events', async () => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const body = await res.text();
    assert.match(body, /data: {"type":"text","text":"Hello from a test."}/);
    assert.match(body, /"type":"done"/);
  });

  test('validates chat requests and reports when AI is offline', async () => {
    const bad = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"messages":[]}' });
    assert.equal(bad.status, 400);
    const offline = await fetch(`${offlineBase}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(offline.status, 503);
  });

  test('rejects cross-origin POSTs', async () => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 403);
  });

  test('accepts same-host POSTs even when TLS is terminated by a proxy', async () => {
    const host = new URL(base).host;
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `https://${host}` },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    await res.text();
  });

  test('ignores a malformed profile instead of rejecting the chat', async () => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], profile: { grade: 42, interests: ['Nope'] } }),
    });
    assert.equal(res.status, 200);
    await res.text();
  });

  test('rejects oversized bodies', async () => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(100_000) }] }),
    });
    assert.equal(res.status, 413);
  });

  test('accepts valid submissions and queues them for review', async () => {
    const good = {
      title: 'Example Program', organization: 'Example Org', url: 'https://example.org',
      cluster: 'STEM', type: 'Summer Program', grades: [10, 11],
      description: 'A free summer program where students learn engineering by building projects.',
      submitterRole: 'Student', consent: true,
    };
    const res = await fetch(`${base}/api/submissions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(good) });
    assert.equal(res.status, 201);
    const queue = fs.readFileSync(path.join(tmp, 'queue.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(queue.at(-1).title, 'Example Program');
    assert.equal(queue.at(-1).status, 'pending-review');

    const bad = await fetch(`${base}/api/submissions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...good, url: 'javascript:alert(1)' }) });
    assert.equal(bad.status, 400);

    const before = fs.readFileSync(path.join(tmp, 'queue.jsonl'), 'utf8');
    const bot = await fetch(`${base}/api/submissions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...good, website2: 'spam' }) });
    assert.equal(bot.status, 202);
    assert.equal(fs.readFileSync(path.join(tmp, 'queue.jsonl'), 'utf8'), before, 'honeypot submissions must not be stored');
  });
});
