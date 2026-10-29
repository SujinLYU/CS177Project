import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createAppServer, validateAIResult } from '../server.mjs';
import { SAMPLE_TRANSCRIPT } from '../extension/lib/sample.mjs';

async function withServer(options, callback) {
  const server = createAppServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await callback(base); }
  finally { await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }); }
}

function post(base, data, headers = {}) {
  return fetch(`${base}/api/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
}

test('demo API works without credentials; AI requires explicit mode and key', async () => {
  await withServer({ apiKey: '' }, async (base) => {
    const health = await fetch(`${base}/api/health`).then((res) => res.json());
    assert.deepEqual(health, { ok: true, aiConfigured: false });
    const demo = await post(base, { transcript: SAMPLE_TRANSCRIPT, mode: 'demo' });
    assert.equal(demo.status, 200);
    assert.equal((await demo.json()).tasks.length, 4);
    assert.equal((await post(base, { transcript: SAMPLE_TRANSCRIPT })).status, 400);
    const unavailable = await post(base, { transcript: SAMPLE_TRANSCRIPT, mode: 'ai' });
    assert.equal(unavailable.status, 503);
    assert.match((await unavailable.json()).error, /OPENAI_API_KEY/);
  });
});

test('rejects unrelated website origins and allows only configured extension origin', async () => {
  const extensionId = 'a'.repeat(32);
  await withServer({ extensionId }, async (base) => {
    const data = { transcript: SAMPLE_TRANSCRIPT, mode: 'demo' };
    assert.equal((await post(base, data, { Origin: 'https://example.com' })).status, 403);
    assert.equal((await post(base, data, { Origin: `chrome-extension://${'b'.repeat(32)}` })).status, 403);
    const allowed = await post(base, data, { Origin: `chrome-extension://${extensionId}` });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), `chrome-extension://${extensionId}`);
  });
});

test('static server exposes frontend assets only', async () => {
  await withServer({}, async (base) => {
    for (const path of ['/.env', '/server.mjs', '/%2e%2e/.env', '/lib/../../../.git/config']) {
      assert.equal((await fetch(`${base}${path}`)).status, 404, path);
    }
    const asset = await fetch(`${base}/lib/analyzer.mjs`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type'), /javascript/);
  });
});

test('AI uses structured output with store:false and keeps API key on backend', async () => {
  const evidence = 'Maya: I will send a follow-up email to the design team.';
  const result = {
    title: 'Planning', summary: ['Follow up with design.'], decisions: [], actionItems: [],
    tasks: [{ type: 'email', title: 'Follow up', description: 'Draft the follow-up.', owner: 'Maya', evidence, draft: 'To: [confirm recipient]\nHi team,', estimateMinutes: 4 }],
  };
  let sent;
  await withServer({ apiKey: 'test-only-key', fetchImpl: async (url, options) => {
    sent = { url, options, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] }] }) };
  } }, async (base) => {
    const response = await post(base, { transcript: evidence, mode: 'ai' });
    assert.equal(response.status, 200);
    const output = await response.json();
    assert.equal(output.mode, 'ai');
    assert.equal(output.tasks[0].status, 'suggested');
    assert.equal(output.tasks[0].id, 'task-1');
    assert.ok(!JSON.stringify(output).includes('test-only-key'));
    assert.equal(sent.url, 'https://api.openai.com/v1/responses');
    assert.equal(sent.body.store, false);
    assert.equal(sent.body.text.format.strict, true);
    assert.equal(sent.body.text.format.type, 'json_schema');
  });
});

test('untrusted provider results with fabricated evidence are rejected', () => {
  assert.throws(() => validateAIResult({
    title: 'Meeting', summary: [], decisions: [], actionItems: [],
    tasks: [{ type: 'email', title: 'Send', description: 'Send it', owner: 'Maya', evidence: 'Made-up instruction.', draft: 'Hello', estimateMinutes: 3 }],
  }, SAMPLE_TRANSCRIPT), /evidence/);
});

test('provider failure never silently falls back to demo', async () => {
  await withServer({ apiKey: 'test', fetchImpl: async () => ({ ok: false, status: 429 }) }, async (base) => {
    const response = await post(base, { transcript: SAMPLE_TRANSCRIPT, mode: 'ai' });
    assert.equal(response.status, 429);
    const data = await response.json();
    assert.ok(data.error);
    assert.equal(data.tasks, undefined);
  });
});
