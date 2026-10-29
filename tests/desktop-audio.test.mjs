import test from 'node:test';
import assert from 'node:assert/strict';
import { PcmChunker } from '../desktop/audio-worklet.js';
import { encodeWav, concatenateWavChunks, MeetingCapture } from '../desktop/audio-capture.mjs';

test('audio render blocks survive boundaries and the final flush without missing or repeating samples', () => {
  const input = Float32Array.from({ length: 16000 * 2 + 137 }, (_, index) => Math.sin(index / 70) * 0.4);
  const chunks = [];
  const chunker = new PcmChunker({ sampleRate: 16000, chunkSeconds: 1, onChunk: (chunk) => chunks.push(chunk) });
  for (let offset = 0; offset < input.length; offset += 128) chunker.push(input.subarray(offset, offset + 128));
  chunker.flush(); chunker.flush();
  assert.deepEqual(chunks.map((chunk) => chunk.samples.length), [16000, 16000, 137]);
  assert.deepEqual(chunks.map((chunk) => chunk.sequence), [0, 1, 2]);
  assert.deepEqual(chunks.map((chunk) => chunk.startSeconds), [0, 1, 2]);
  const restored = new Float32Array(input.length);
  let written = 0;
  for (const chunk of chunks) { restored.set(chunk.samples, written); written += chunk.samples.length; }
  assert.deepEqual(restored, input);
});

test('WAV export retains silent and final segments in exact PCM order with one valid header', () => {
  const samples = [new Float32Array(16000), new Float32Array([1, -1, 0.25, -0.25]), new Float32Array([0.1, 0.2])];
  const chunks = samples.map((segment) => encodeWav(segment));
  const combined = concatenateWavChunks(chunks);
  const view = new DataView(combined);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint32(40, true), samples.reduce((sum, segment) => sum + segment.length * 2, 0));
  assert.equal(view.getUint32(4, true), combined.byteLength - 8);
  const expected = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, 44)));
  assert.deepEqual(Buffer.from(combined, 44), expected);
});

test('near-digital silence is tagged but retained in the chunk stream', () => {
  const chunks = [];
  const chunker = new PcmChunker({ onChunk: (chunk) => chunks.push(chunk) });
  chunker.push(new Float32Array(100)); chunker.flush();
  chunker.push(new Float32Array([0.1, 0.2, 0.3])); chunker.flush();
  assert.deepEqual(chunks.map((chunk) => chunk.silent), [true, false]);
  assert.equal(chunks[0].samples.length, 100);
});

test('WAV encoder clips out-of-range values and rejects incompatible concatenation', () => {
  const view = new DataView(encodeWav(new Float32Array([2, -2, NaN])));
  assert.equal(view.getInt16(44, true), 32767);
  assert.equal(view.getInt16(46, true), -32768);
  assert.equal(view.getInt16(48, true), 0);
  assert.throws(() => concatenateWavChunks([encodeWav(new Float32Array([1])), encodeWav(new Float32Array([1]), 48000)]), /do not match/);
  assert.throws(() => concatenateWavChunks([new ArrayBuffer(45)]), /Invalid recording/);
  assert.throws(() => encodeWav(new Float32Array()), /empty/);
});

test('constructing a recorder requests no devices or permissions', () => {
  const recorder = new MeetingCapture();
  assert.equal(recorder.running, false);
  assert.deepEqual(recorder.streams, []);
  assert.equal(recorder.context, null);
});

function mediaFixture(t, { noSystemAudio = false, denySystem = false } = {}) {
  const saved = new Map(['navigator', 'pipDesktop', 'AudioContext', 'AudioWorkletNode', 'MediaStream'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => { for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  const events = [];
  class Track extends EventTarget {
    constructor(kind) { super(); this.kind = kind; this.readyState = 'live'; this.enabled = true; }
    stop() { events.push(`stop:${this.kind}`); this.readyState = 'ended'; }
  }
  class Stream {
    constructor(tracks) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter((track) => track.kind === 'audio'); }
    getVideoTracks() { return this.tracks.filter((track) => track.kind === 'video'); }
  }
  const micTrack = new Track('audio');
  const systemTrack = new Track('audio');
  const videoTrack = new Track('video');
  const microphone = new Stream([micTrack]);
  const system = new Stream(noSystemAudio ? [videoTrack] : [systemTrack, videoTrack]);
  class Context {
    constructor() { this.sampleRate = 16000; this.state = 'suspended'; this.destination = {}; this.audioWorklet = { addModule: async () => {} }; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    async resume() { this.state = 'running'; }
    async close() { events.push('context:close'); this.state = 'closed'; }
  }
  class Worklet {
    constructor() {
      this.port = { onmessage: null, postMessage: () => {
        events.push('flush');
        queueMicrotask(() => {
          this.port.onmessage?.({ data: { type: 'chunk', samples: new Float32Array([0.1, 0.2]), sequence: 0, startSeconds: 0, durationSeconds: 2 / 16000, silent: false } });
          this.port.onmessage?.({ data: { type: 'flushed' } });
        });
      } };
    }
    connect() {} disconnect() {}
  }
  const globals = {
    navigator: { mediaDevices: {
      getUserMedia: async () => microphone,
      getDisplayMedia: async () => { if (denySystem) throw new DOMException('denied', 'NotAllowedError'); return system; },
    } },
    pipDesktop: { requestMicrophone: async () => true, beginSystemCapture: async () => { events.push('system:armed'); } },
    AudioContext: Context, AudioWorkletNode: Worklet, MediaStream: Stream,
  };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  return { events, micTrack, systemTrack, videoTrack };
}

test('denied system audio stops the already opened microphone instead of silently recording one side', async (t) => {
  const fixture = mediaFixture(t, { denySystem: true });
  const recorder = new MeetingCapture();
  await assert.rejects(recorder.start({ systemAudio: true }), /System audio access was denied/);
  assert.equal(fixture.micTrack.readyState, 'ended');
  assert.equal(recorder.running, false);
});

test('a display stream without audio is rejected and every granted track is stopped', async (t) => {
  const fixture = mediaFixture(t, { noSystemAudio: true });
  const recorder = new MeetingCapture();
  await assert.rejects(recorder.start({ systemAudio: true }), /No system-audio track/);
  assert.equal(fixture.micTrack.readyState, 'ended');
  assert.equal(fixture.videoTrack.readyState, 'ended');
});

test('stop flushes the last samples before cleanup and does not play or encode the video track', async (t) => {
  const fixture = mediaFixture(t);
  const chunks = [];
  const recorder = new MeetingCapture({ onChunk: async (chunk) => { fixture.events.push('chunk'); chunks.push(chunk); } });
  await recorder.start({ systemAudio: true });
  assert.equal(fixture.videoTrack.enabled, false);
  assert.equal(fixture.videoTrack.readyState, 'live', 'video remains acquired but disabled until capture cleanup');
  assert.equal(recorder.sink.gain.value, 0, 'no feedback to the speakers');
  await recorder.stop();
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].audio.byteLength, 48);
  assert.ok(fixture.events.indexOf('flush') < fixture.events.indexOf('stop:audio'));
  assert.ok(fixture.events.indexOf('chunk') < fixture.events.indexOf('context:close'));
  assert.equal(fixture.micTrack.readyState, 'ended');
  assert.equal(fixture.systemTrack.readyState, 'ended');
  assert.equal(fixture.videoTrack.readyState, 'ended');
  assert.equal(recorder.running, false);
});

test('processor failures notify the UI once instead of silently continuing', async (t) => {
  mediaFixture(t);
  const ended = [];
  const recorder = new MeetingCapture({ onEnded: (reason) => ended.push(reason) });
  await recorder.start({ systemAudio: true });
  recorder.node.onprocessorerror();
  recorder.node.onprocessorerror();
  assert.equal(ended.length, 1);
  assert.match(ended[0], /Audio processing stopped/);
  await recorder.stop();
});

test('interrupted audio contexts notify the UI instead of silently continuing', async (t) => {
  mediaFixture(t);
  const ended = [];
  const interrupted = new MeetingCapture({ onEnded: (reason) => ended.push(reason) });
  await interrupted.start({ systemAudio: true });
  interrupted.context.state = 'suspended';
  interrupted.context.onstatechange();
  assert.equal(ended.length, 1);
  assert.match(ended[0], /audio device was interrupted/);
  await interrupted.stop();
});
