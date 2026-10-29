// The accumulator is exported so sample continuity can be checked without hardware.
export class PcmChunker {
  constructor({ sampleRate = 16000, chunkSeconds = 20, onChunk }) {
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000) throw new Error('Invalid sample rate.');
    if (!Number.isFinite(chunkSeconds) || chunkSeconds <= 0 || chunkSeconds > 60) throw new Error('Invalid chunk duration.');
    this.sampleRate = sampleRate;
    this.capacity = Math.round(sampleRate * chunkSeconds);
    this.buffer = new Float32Array(this.capacity);
    this.offset = 0;
    this.totalSamples = 0;
    this.sequence = 0;
    this.onChunk = onChunk;
  }

  push(samples) {
    let consumed = 0;
    while (consumed < samples.length) {
      const count = Math.min(this.capacity - this.offset, samples.length - consumed);
      this.buffer.set(samples.subarray(consumed, consumed + count), this.offset);
      this.offset += count;
      consumed += count;
      if (this.offset === this.capacity) this.flush();
    }
  }

  flush() {
    if (!this.offset) return;
    const samples = this.buffer.slice(0, this.offset);
    let squareSum = 0;
    let peak = 0;
    for (const value of samples) { squareSum += value * value; peak = Math.max(peak, Math.abs(value)); }
    const message = {
      samples, sequence: this.sequence++, startSeconds: this.totalSamples / this.sampleRate,
      durationSeconds: samples.length / this.sampleRate,
      // Only near-digital silence is skipped for transcription. Keep it in exports.
      silent: Math.sqrt(squareSum / samples.length) < 0.0001 && peak < 0.001,
    };
    this.totalSamples += samples.length;
    this.offset = 0;
    this.onChunk(message);
  }
}

// AudioWorkletGlobalScope supplies these globals; Node tests use only PcmChunker.
if (typeof registerProcessor === 'function') {
  class PipCaptureProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super();
      this.running = true;
      this.hasSystem = Boolean(options.processorOptions?.systemAudio);
      this.microphoneSquares = 0;
      this.systemSquares = 0;
      this.levelFrames = 0;
      this.chunker = new PcmChunker({
        sampleRate,
        chunkSeconds: 20,
        onChunk: (chunk) => this.port.postMessage({ type: 'chunk', ...chunk }, [chunk.samples.buffer]),
      });
      this.port.onmessage = ({ data }) => {
        if (data?.type !== 'flush') return;
        this.running = false;
        this.chunker.flush();
        this.port.postMessage({ type: 'flushed', id: data.id });
      };
    }

    process(inputs) {
      if (!this.running) return true;
      const mic = inputs[0] || [];
      const system = inputs[1] || [];
      const frames = mic[0]?.length || system[0]?.length || 128;
      const mixed = new Float32Array(frames);
      for (let frame = 0; frame < frames; frame++) {
        let microphoneSample = 0;
        let systemSample = 0;
        for (const channel of mic) microphoneSample += channel[frame] || 0;
        for (const channel of system) systemSample += channel[frame] || 0;
        microphoneSample /= mic.length || 1;
        systemSample /= system.length || 1;
        this.microphoneSquares += microphoneSample * microphoneSample;
        this.systemSquares += systemSample * systemSample;
        mixed[frame] = this.hasSystem ? (microphoneSample + systemSample) * 0.5 : microphoneSample;
      }
      this.chunker.push(mixed);
      this.levelFrames += frames;
      if (this.levelFrames >= sampleRate / 10) {
        this.port.postMessage({ type: 'levels',
          microphone: Math.min(1, Math.sqrt(this.microphoneSquares / this.levelFrames) * 4),
          system: Math.min(1, Math.sqrt(this.systemSquares / this.levelFrames) * 4),
        });
        this.microphoneSquares = 0;
        this.systemSquares = 0;
        this.levelFrames = 0;
      }
      // Outputs deliberately stay zero: never play the meeting back into speakers.
      return true;
    }
  }
  registerProcessor('pip-meeting-capture', PipCaptureProcessor);
}
