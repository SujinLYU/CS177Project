import test from 'node:test';
import assert from 'node:assert/strict';
import { transcribeAudio, validateAudio, MAX_TRANSCRIPTION_BYTES } from '../desktop/transcription.mjs';
import { encodeWav } from '../desktop/audio-capture.mjs';

const audio = () => encodeWav(new Float32Array(16000).fill(0.1));

test('transcription submits independent WAV multipart data and a main-process key', async () => {
  let calls = 0;
  const result = await transcribeAudio({ audio: audio(), apiKey: 'test-secret', language: 'zh', fetchImpl: async (url, request) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
    assert.equal(request.headers.Authorization, 'Bearer test-secret');
    assert.equal(request.headers['Content-Type'], undefined, 'fetch must generate the multipart boundary');
    assert.equal(request.body.get('model'), 'gpt-transcribe');
    assert.equal(request.body.get('languages[]'), 'zh');
    const file = request.body.get('file');
    assert.equal(file.name, 'meeting.wav');
    assert.equal(file.type, 'audio/wav');
    validateAudio(await file.arrayBuffer());
    assert.ok(request.signal instanceof AbortSignal);
    return new Response(JSON.stringify({ text: '  我们下周跟进。 ', languages: [{ code: 'zh' }] }), { status: 200 });
  } });
  assert.equal(calls, 1);
  assert.deepEqual(result, { text: '我们下周跟进。' });
});

test('invalid audio and missing credentials fail before an outbound call', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('must not call'); };
  await assert.rejects(transcribeAudio({ audio: new ArrayBuffer(10), apiKey: 'key', fetchImpl }), /empty or invalid/);
  await assert.rejects(transcribeAudio({ audio: audio(), mimeType: 'video/webm', apiKey: 'key', fetchImpl }), /Only recorded WAV/);
  await assert.rejects(transcribeAudio({ audio: new ArrayBuffer(MAX_TRANSCRIPTION_BYTES + 1), apiKey: 'key', fetchImpl }), /too large/);
  await assert.rejects(transcribeAudio({ audio: audio(), fetchImpl }), /not configured/);
  const malformed = audio(); new DataView(malformed).setUint32(40, 1, true);
  await assert.rejects(transcribeAudio({ audio: malformed, apiKey: 'key', fetchImpl }), /valid 16 kHz/);
  assert.equal(calls, 0);
});

test('provider errors are actionable and never expose provider bodies or pretend to transcribe', async () => {
  for (const [status, expected] of [[401, /rejected access/], [429, /quota limit/], [503, /HTTP 503/], [404, /MODEL/]]) {
    await assert.rejects(transcribeAudio({ audio: audio(), apiKey: 'secret-key', fetchImpl: async () => new Response('secret-key internal traceback', { status }) }), (error) => {
      assert.match(error.message, expected);
      assert.ok(!error.message.includes('secret-key'));
      assert.ok(!error.message.includes('traceback'));
      return true;
    });
  }
});

test('network, timeout and malformed output retain an explicit retry error', async () => {
  await assert.rejects(transcribeAudio({ audio: audio(), apiKey: 'key', fetchImpl: async () => { throw new TypeError('network'); } }), /connection/);
  await assert.rejects(transcribeAudio({ audio: audio(), apiKey: 'key', fetchImpl: async () => { throw new DOMException('aborted', 'TimeoutError'); } }), /timed out/);
  await assert.rejects(transcribeAudio({ audio: audio(), apiKey: 'key', fetchImpl: async () => new Response(JSON.stringify({ done: true })) }), /invalid transcript/);
  assert.deepEqual(await transcribeAudio({ audio: audio(), apiKey: 'key', fetchImpl: async () => new Response(JSON.stringify({ text: '' })) }), { text: '' });
});
