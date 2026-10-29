export const MAX_TRANSCRIPTION_BYTES = 24 * 1024 * 1024;

/** Only accept the PCM WAV format produced by the capture worklet. */
export function validateAudio(audio, mimeType = 'audio/wav') {
  if (!(audio instanceof ArrayBuffer) || audio.byteLength < 46) throw new Error('The recording segment is empty or invalid.');
  if (audio.byteLength > MAX_TRANSCRIPTION_BYTES) throw new Error('The recording segment is too large. Keep each segment below 24 MB.');
  if (mimeType !== 'audio/wav') throw new Error('Only recorded WAV audio is accepted.');
  const view = new DataView(audio);
  const chars = (offset, length) => String.fromCharCode(...new Uint8Array(audio, offset, length));
  if (chars(0, 4) !== 'RIFF' || chars(8, 4) !== 'WAVE' || chars(12, 4) !== 'fmt ' || chars(36, 4) !== 'data' ||
      view.getUint32(4, true) !== audio.byteLength - 8 || view.getUint32(16, true) !== 16 ||
      view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 ||
      view.getUint32(24, true) !== 16000 || view.getUint32(28, true) !== 32000 ||
      view.getUint16(32, true) !== 2 || view.getUint16(34, true) !== 16 ||
      view.getUint32(40, true) !== audio.byteLength - 44 || (audio.byteLength - 44) % 2) {
    throw new Error('The recording segment must be valid 16 kHz mono PCM16 WAV.');
  }
  return audio;
}

/** Runs in Electron's main process. Never expose the key to the renderer. */
export async function transcribeAudio({ audio, mimeType = 'audio/wav', language, apiKey, model = 'gpt-transcribe', fetchImpl = fetch } = {}) {
  validateAudio(audio, mimeType);
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('Transcription is not configured. Add OPENAI_API_KEY to your .env file and restart Pip. Your recording can still be saved.');
  if (typeof model !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(model)) throw new Error('OPENAI_TRANSCRIBE_MODEL is invalid. Check the configured transcription model.');
  if (language && (typeof language !== 'string' || !/^[a-z]{2,3}$/.test(language))) throw new Error('Choose a two-letter language code or automatic language detection.');
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mimeType }), 'meeting.wav');
  form.append('model', model);
  // Current gpt-transcribe accepts multilingual hints; older compatible models use language.
  if (language) form.append(model.startsWith('gpt-transcribe') ? 'languages[]' : 'language', language);
  let response;
  try {
    response = await fetchImpl('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form,
      signal: AbortSignal.timeout(60000),
    });
  } catch (error) {
    if (['TimeoutError', 'AbortError'].includes(error?.name)) throw new Error('Transcription timed out. Retry this segment when the connection is ready; your recording has not been discarded.');
    throw new Error('Could not reach the transcription service. Check your connection, then retry the pending segments.');
  }
  if (!response.ok) {
    if ([401, 403].includes(response.status)) throw new Error('The transcription service rejected access. Check OPENAI_API_KEY and model access, then restart Pip.');
    if (response.status === 429) throw new Error('The transcription rate or quota limit was reached. Check your API account, then retry the pending segments.');
    if (response.status === 413) throw new Error('The transcription service rejected a large audio segment. Save the recording and retry a shorter segment.');
    if ([400, 404, 422].includes(response.status)) throw new Error('The transcription request was rejected. Check OPENAI_TRANSCRIBE_MODEL and whether your account can use it.');
    throw new Error(`The transcription service returned HTTP ${response.status}. Your recording is retained for retry.`);
  }
  try {
    const payload = await response.json();
    if (!payload || typeof payload.text !== 'string' || payload.text.length > 100000) throw new Error('Invalid transcript');
    return { text: payload.text.trim() };
  } catch (error) {
    if (['TimeoutError', 'AbortError'].includes(error?.name)) throw new Error('Transcription timed out while receiving the result. Retry the pending segment.');
    throw new Error('The transcription service returned an invalid transcript. Retry this segment; the audio is still available.');
  }
}
