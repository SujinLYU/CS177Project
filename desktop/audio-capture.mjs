export const CAPTURE_SAMPLE_RATE = 16000;
export const CAPTURE_CHUNK_SECONDS = 20;

function writeAscii(view, offset, value) {
  for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index));
}

function wavHeader(view, sampleRate, pcmBytes) {
  writeAscii(view, 0, 'RIFF'); view.setUint32(4, pcmBytes + 36, true); writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); writeAscii(view, 36, 'data');
  view.setUint32(40, pcmBytes, true);
}

/** A complete, independently playable PCM16 mono WAV, not a media-container fragment. */
export function encodeWav(samples, sampleRate = CAPTURE_SAMPLE_RATE) {
  if (!(samples instanceof Float32Array) || !samples.length) throw new Error('Audio samples are empty.');
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000) throw new Error('Invalid sample rate.');
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  wavHeader(view, sampleRate, samples.length * 2);
  for (let index = 0; index < samples.length; index++) {
    const value = Number.isFinite(samples[index]) ? Math.max(-1, Math.min(1, samples[index])) : 0;
    view.setInt16(44 + index * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return buffer;
}

function readWav(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 46) throw new Error('Invalid recording chunk.');
  const view = new DataView(buffer);
  const ascii = (offset, count) => String.fromCharCode(...new Uint8Array(buffer, offset, count));
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE' || ascii(12, 4) !== 'fmt ' || ascii(36, 4) !== 'data' ||
      view.getUint32(16, true) !== 16 || view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 ||
      view.getUint16(34, true) !== 16 || view.getUint16(32, true) !== 2 ||
      view.getUint32(40, true) !== buffer.byteLength - 44 || (buffer.byteLength - 44) % 2 ||
      view.getUint32(4, true) !== buffer.byteLength - 8) throw new Error('Recording chunks must be valid PCM16 mono WAV.');
  const sampleRate = view.getUint32(24, true);
  if (sampleRate < 8000 || sampleRate > 96000 || view.getUint32(28, true) !== sampleRate * 2) throw new Error('Invalid recording sample rate.');
  return { sampleRate, pcmBytes: new Uint8Array(buffer, 44) };
}

/** Preserve every chunk, including silence and the final short chunk, for export. */
export function concatenateWavChunks(chunks) {
  if (!Array.isArray(chunks) || !chunks.length) throw new Error('There is no recorded audio to save.');
  const parsed = chunks.map(readWav);
  const sampleRate = parsed[0].sampleRate;
  if (parsed.some((chunk) => chunk.sampleRate !== sampleRate)) throw new Error('Recording sample rates do not match.');
  const pcmLength = parsed.reduce((sum, chunk) => sum + chunk.pcmBytes.length, 0);
  if (pcmLength > 256 * 1024 * 1024) throw new Error('This recording is too large to export in one file.');
  const output = new ArrayBuffer(44 + pcmLength);
  wavHeader(new DataView(output), sampleRate, pcmLength);
  const bytes = new Uint8Array(output);
  let offset = 44;
  for (const chunk of parsed) { bytes.set(chunk.pcmBytes, offset); offset += chunk.pcmBytes.length; }
  return output;
}

function captureError(error, source) {
  if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') {
    return new Error(`${source} access was denied. Enable ${source === 'Microphone' ? 'Microphone' : 'Screen & System Audio Recording'} for Pip in macOS System Settings → Privacy & Security, then restart Pip.`);
  }
  if (error?.name === 'NotFoundError') return new Error(`${source} is unavailable. Connect an input device and try again.`);
  return new Error(`${source} could not start. ${error?.message || 'Check device access and try again.'}`);
}

/** Captures only after start(); neither construction nor loading requests permissions. */
export class MeetingCapture {
  constructor({ onChunk = () => {}, onLevels = () => {}, onWarning = () => {}, onEnded = () => {} } = {}) {
    this.onChunk = onChunk;
    this.onLevels = onLevels;
    this.onWarning = onWarning;
    this.onEnded = onEnded;
    this.streams = [];
    this.sources = [];
    this.pendingCallbacks = new Set();
    this.context = null;
    this.node = null;
    this.running = false;
    this.starting = false;
    this.stopping = null;
    this.endedNotified = false;
  }

  async start({ systemAudio = true, microphoneDeviceId } = {}) {
    if (this.running || this.starting || this.stopping) throw new Error('A recording is already active.');
    if (!globalThis.navigator?.mediaDevices?.getUserMedia) throw new Error('Audio recording requires the Pip desktop app.');
    this.starting = true;
    this.endedNotified = false;
    this.inputEndedDuringSetup = false;
    this.processorFailed = false;
    this.silenceTimer = null;
    try {
      if (globalThis.pipDesktop?.requestMicrophone && !await globalThis.pipDesktop.requestMicrophone()) {
        throw new Error('Microphone permission is off. Enable it in macOS System Settings → Privacy & Security → Microphone, then restart Pip.');
      }
      let microphone;
      try {
        microphone = await navigator.mediaDevices.getUserMedia({ video: false, audio: {
          ...(microphoneDeviceId ? { deviceId: { exact: microphoneDeviceId } } : {}),
          echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        } });
      } catch (error) { throw captureError(error, 'Microphone'); }
      this.streams.push(microphone);
      this.watchTracks(microphone, 'Microphone');
      if (!microphone.getAudioTracks().some((track) => track.readyState === 'live')) throw new Error('The microphone did not provide an active audio track.');

      let system;
      if (systemAudio) {
        try {
          await globalThis.pipDesktop?.beginSystemCapture?.();
          system = await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: { ideal: 1, max: 1 }, width: { ideal: 16 }, height: { ideal: 16 } },
            audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          });
        } catch (error) { throw captureError(error, 'System audio'); }
        this.streams.push(system);
        this.watchTracks(system, 'System audio');
        if (!system.getAudioTracks().some((track) => track.readyState === 'live')) {
          throw new Error('No system-audio track was granted. Enable System Audio Recording for Pip, restart it, and choose microphone + system audio again.');
        }
        // The capture API requires a video track. It is never encoded or sent.
        // Disabling (rather than stopping) it avoids ending the associated audio.
        for (const track of system.getVideoTracks()) track.enabled = false;
      }

      this.context = new AudioContext({ sampleRate: CAPTURE_SAMPLE_RATE, latencyHint: 'interactive' });
      if (this.context.sampleRate !== CAPTURE_SAMPLE_RATE) throw new Error('The audio device could not start at 16 kHz. Try another input device.');
      await this.context.audioWorklet.addModule(new URL('./audio-worklet.js', import.meta.url));
      this.node = new AudioWorkletNode(this.context, 'pip-meeting-capture', {
        numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1],
        channelCount: 1, channelCountMode: 'explicit', processorOptions: { systemAudio },
      });
      this.node.port.onmessage = ({ data }) => this.handleMessage(data);
      this.node.onprocessorerror = () => {
        this.processorFailed = true;
        this.notifyEnded('Audio processing stopped unexpectedly. Pip is stopping this recording; earlier segments remain available to save.');
      };
      this.context.onstatechange = () => {
        if (this.context && this.context.state !== 'running') {
          this.notifyEnded('The audio device was interrupted. Pip is stopping this recording; check your inputs before starting again.');
        }
      };
      this.attachInput(microphone, 0);
      if (system) this.attachInput(new MediaStream(system.getAudioTracks()), 1);
      // A zero-gain sink keeps the worklet scheduled while avoiding feedback.
      this.sink = this.context.createGain();
      this.sink.gain.value = 0;
      this.node.connect(this.sink); this.sink.connect(this.context.destination);
      this.running = true;
      await this.context.resume();
      // CoreAudio can grant a track and end it immediately if its permission is missing.
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (this.processorFailed) throw new Error('The audio processor could not start. Restart Pip and try again.');
      if (this.context.state !== 'running' || this.inputEndedDuringSetup || this.streams.some((stream) => !stream.getAudioTracks().some((track) => track.readyState === 'live'))) {
        throw new Error('An audio input stopped during setup. Check Pip’s microphone and system-audio permissions, then restart the app.');
      }
      if (systemAudio) this.silenceTimer = setTimeout(() => {
        if (this.running && !this.systemSignalSeen) this.onWarning('No computer sound detected yet. Play meeting audio and watch the System meter. A silent meter can mean the system-audio permission is missing.');
      }, 12000);
    } catch (error) {
      this.running = false;
      await this.cleanup();
      throw error;
    } finally { this.starting = false; }
  }

  attachInput(stream, inputIndex) {
    const source = this.context.createMediaStreamSource(stream);
    source.connect(this.node, 0, inputIndex);
    this.sources.push(source);
  }

  watchTracks(stream, label) {
    for (const track of stream.getAudioTracks()) track.addEventListener('ended', () => {
      if ((!this.running && !this.starting) || this.stopping || this.endedNotified) return;
      if (this.starting) { this.inputEndedDuringSetup = true; return; }
      this.notifyEnded(`${label} stopped. The recording is being stopped so no missing input goes unnoticed.`);
    }, { once: true });
  }

  notifyEnded(reason) {
    // Setup checks report early errors through start() instead of racing the UI's stop flow.
    if (!this.running || this.starting || this.stopping || this.endedNotified) return;
    this.endedNotified = true;
    this.onEnded(reason);
  }

  handleMessage(data) {
    if (data?.type === 'levels') {
      if (data.system > 0.001) this.systemSignalSeen = true;
      this.onLevels({ microphone: data.microphone, system: data.system });
    } else if (data?.type === 'chunk') {
      const chunk = {
        audio: encodeWav(data.samples), sequence: data.sequence, startSeconds: data.startSeconds,
        durationSeconds: data.durationSeconds, silent: data.silent,
      };
      const callback = Promise.resolve().then(() => this.onChunk(chunk));
      this.pendingCallbacks.add(callback);
      callback.catch(() => this.onWarning('A recorded audio segment could not be handed to the transcript queue. Stop and save the recording before continuing.'))
        .finally(() => this.pendingCallbacks.delete(callback));
    } else if (data?.type === 'flushed' && this.flushResolve) {
      this.flushResolve(); this.flushResolve = null;
    }
  }

  async stop() {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      try {
        if (this.node && this.context?.state !== 'closed') {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.flushResolve = null; reject(new Error('Audio finalization timed out. Earlier recording segments are still available.')); }, 3000);
            this.flushResolve = () => { clearTimeout(timer); resolve(); };
            this.context.resume().then(() => {
              if (this.flushResolve) this.node.port.postMessage({ type: 'flush' });
            }, (error) => { clearTimeout(timer); this.flushResolve = null; reject(error); });
          });
          await Promise.allSettled([...this.pendingCallbacks]);
        }
      } finally {
        this.running = false;
        await this.cleanup();
      }
    })();
    try { await this.stopping; }
    finally { this.stopping = null; }
  }

  async cleanup() {
    clearTimeout(this.silenceTimer);
    for (const stream of this.streams) for (const track of stream.getTracks()) track.stop();
    this.streams = [];
    for (const source of this.sources) source.disconnect();
    this.sources = [];
    this.node?.disconnect(); this.sink?.disconnect();
    if (this.context) this.context.onstatechange = null;
    if (this.context && this.context.state !== 'closed') await this.context.close();
    if (this.node) { this.node.port.onmessage = null; this.node.onprocessorerror = null; }
    this.node = null; this.context = null; this.sink = null;
    this.systemSignalSeen = false;
    this.onLevels({ microphone: 0, system: 0 });
  }
}
