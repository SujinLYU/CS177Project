import { MeetingCapture, concatenateWavChunks } from './audio-capture.mjs';
import { approveTask, prepareApprovedDraft, dismissTask } from '../extension/lib/workflow.mjs';
import { MAX_TRANSCRIPT_LENGTH } from '../extension/lib/analyzer.mjs';

const $ = (selector) => document.querySelector(selector);
const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const bridge = window.pipDesktop;
const STORE = 'pip-desktop-meeting-v1';
const MAX_SECONDS = 3600;
let config = { aiConfigured: false };
let runtimeReady = false;
let phase = 'idle';
let chunks = [];
let capture = null;
let queueRunning = false;
let transcriptionEnabled = false;
let analyzing = false;
let elapsed = 0;
let startedAt = 0;
let timer;
let toastTimer;
let audioSaved = true;
let startAfterReset = false;
let currentTaskId;
let taskAnalysis = null;
let savedTranscript = '';
let persistedAudioCount = 0;
let warningText = '';

function loadSavedMeeting() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE));
    if (!saved || saved.version !== 1 || typeof saved.transcript !== 'string') return;
    savedTranscript = saved.transcript;
    persistedAudioCount = Number(saved.segmentCount) || 0;
    elapsed = Math.min(MAX_SECONDS, Math.max(0, Number(saved.duration) || 0));
    const a = saved.analysis;
    if (a && typeof a.title === 'string' && Array.isArray(a.summary) && a.summary.every((s) => typeof s === 'string') && Array.isArray(a.actionItems) && a.actionItems.every((i) => typeof i?.title === 'string') && Array.isArray(a.tasks) && a.tasks.every((t) => t && ['id','title','description','evidence','draft','owner'].every((k) => typeof t[k] === 'string') && ['suggested','dismissed','completed'].includes(t.status) && (t.status !== 'completed' || typeof t.result?.text === 'string'))) taskAnalysis = a;
  } catch { /* A malformed cache must not prevent recording. */ }
}
loadSavedMeeting();
$('#transcript-editor').value = savedTranscript;

const isCapturing = () => ['preparing', 'recording', 'stopping'].includes(phase);
const pendingChunks = () => chunks.filter((chunk) => ['queued', 'processing'].includes(chunk.status));
const isBusy = () => isCapturing() || queueRunning || pendingChunks().length > 0 || analyzing;
const formatTime = (seconds) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
const cleanError = (error) => String(error?.message || 'Something went wrong. Please try again.').replace(/^Error invoking remote method '[^']+': Error: /, '');

function toast(message) {
  clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5000);
}
function showError(message) { $('#capture-error').textContent = message; $('#capture-error').hidden = false; }
function showWarning(message) { warningText = message; $('#capture-warning').textContent = message; $('#capture-warning').hidden = false; }
function persist() {
  savedTranscript = $('#transcript-editor').value;
  try {
    localStorage.setItem(STORE, JSON.stringify({ version: 1, transcript: savedTranscript, analysis: taskAnalysis, segmentCount: chunks.length || persistedAudioCount, duration: elapsed }));
    $('#save-state').textContent = 'Transcript saved on this device';
  } catch { $('#save-state').textContent = 'Local save unavailable — export your transcript'; }
}
function notifyPet() {
  bridge?.setStatus({ recording: isCapturing(), transcribing: queueRunning || pendingChunks().length > 0, pendingCount: taskAnalysis?.tasks.filter((task) => task.status === 'suggested').length || 0, hasUnsavedAudio: chunks.length > 0 && !audioSaved }).catch(() => {});
}
function updateUI() {
  const recording = phase === 'recording';
  const pending = pendingChunks().length;
  const failed = chunks.filter((chunk) => chunk.status === 'error');
  $('#timer').textContent = formatTime(elapsed);
  const state = $('#recording-state');
  state.textContent = { idle: 'Ready when you are', preparing: 'Connecting audio…', recording: '● Recording', stopping: 'Finishing audio…', processing: 'Transcribing…', ready: 'Recording finished' }[phase];
  state.classList.toggle('recording', recording);
  $('#start-recording').hidden = recording || phase === 'stopping';
  $('#start-recording').disabled = !runtimeReady || isBusy();
  $('#stop-recording').hidden = !recording && phase !== 'stopping';
  $('#stop-recording').disabled = phase === 'stopping';
  $('#audio-source').disabled = isBusy();
  $('#transcribe-enabled').disabled = isBusy() || !config.aiConfigured;
  $('#transcript-editor').readOnly = isCapturing() || pending > 0 || queueRunning || failed.length > 0;
  $('#new-meeting').disabled = isBusy();
  $('#save-audio').disabled = isCapturing() || !chunks.length;
  $('#save-transcript').disabled = !$('#transcript-editor').value.trim();
  $('#find-tasks').disabled = !runtimeReady || isBusy() || !$('#transcript-editor').value.trim();
  $('#summary-mode').disabled = isBusy();
  $('#retry-transcription').hidden = !failed.length;
  $('#retry-transcription').disabled = queueRunning || !config.aiConfigured;
  $('#queue-status').hidden = !pending && !failed.length;
  $('#queue-label').textContent = [pending ? `${pending} segment${pending === 1 ? '' : 's'} processing / queued` : '', failed.length ? `${failed.length} failed — audio retained for retry` : ''].filter(Boolean).join(' · ');
  $('#segment-count').textContent = chunks.length || persistedAudioCount;
  const count = taskAnalysis?.tasks.filter((task) => task.status === 'suggested').length || 0;
  $('#task-count').textContent = count;
  $('#recording-caption').textContent = recording ? 'Recording continues when you hide this window. Stop here when the meeting ends.' : 'Microphone + computer audio, together in one place.';
  $('#transcript-status').textContent = recording ? (transcriptionEnabled ? 'Listening now. Completed audio segments will become text below.' : 'Recording locally. Transcription is off; save the audio when finished.') : pending ? 'Finishing the remaining segments. You can hide this window while Pip works.' : failed.length ? 'Some words are still missing. Retry failed segments before using the transcript.' : chunks.length && !transcriptionEnabled ? 'Local recording is ready. Save audio to keep it.' : $('#transcript-editor').value.trim() ? 'Review the words, make corrections, then find the little tasks.' : 'Start a meeting to capture the words. Your transcript will appear here.';
  if (persistedAudioCount && !chunks.length) $('#audio-note').textContent = 'This transcript was restored from local storage. Raw audio from the previous app session is not retained.';
  else $('#audio-note').textContent = 'Audio stays in memory until you save it. Save audio before quitting if you want to keep the recording. One-hour limit per recording.';
  notifyPet();
}

function updateTranscriptFromChunks() {
  $('#transcript-editor').value = chunks.map((chunk) => {
    const stamp = `[${formatTime(chunk.startSeconds)}]`;
    if (chunk.status === 'done' && chunk.text) return `${stamp} ${chunk.text}`;
    if (chunk.status === 'error') return `${stamp} [Transcription failed for this segment. Retry to recover its words.]`;
    return '';
  }).filter(Boolean).join('\n\n');
  persist();
}

async function drainQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    let next;
    while ((next = chunks.find((chunk) => chunk.status === 'queued'))) {
      next.status = 'processing'; updateUI();
      try {
        const result = await bridge.transcribe({ audio: next.audio, mimeType: 'audio/wav' });
        next.text = result.text;
        next.status = 'done';
        next.error = '';
      } catch (error) {
        next.status = 'error'; next.error = cleanError(error);
        showError(next.error);
      }
      updateTranscriptFromChunks();
    }
  } finally {
    queueRunning = false;
    if (phase === 'processing') phase = 'ready';
    updateUI();
  }
}

function acceptChunk(chunk) {
  audioSaved = false;
  chunks.push({ ...chunk, status: chunk.silent ? 'silent' : transcriptionEnabled ? 'queued' : 'local', text: '', error: '' });
  persistedAudioCount = chunks.length;
  persist(); updateUI();
  if (transcriptionEnabled && !chunk.silent) void drainQueue();
}

async function startRecording() {
  if (isBusy()) return;
  if (chunks.length || $('#transcript-editor').value.trim() || taskAnalysis) {
    startAfterReset = true; $('#new-meeting-dialog').showModal(); return;
  }
  $('#capture-error').hidden = true; $('#capture-warning').hidden = true; warningText = '';
  transcriptionEnabled = $('#transcribe-enabled').checked && config.aiConfigured;
  const systemAudio = $('#audio-source').value === 'both';
  phase = 'preparing'; updateUI();
  capture = new MeetingCapture({
    onChunk: acceptChunk,
    onLevels: (levels) => {
      $('#microphone-meter').value = levels.microphone;
      $('#system-meter').value = levels.system;
      $('#mic-level-label').textContent = levels.microphone > 0.006 ? 'Signal' : isCapturing() ? 'Quiet' : 'Stopped';
      $('#system-level-label').textContent = !systemAudio ? 'Off' : levels.system > 0.006 ? 'Signal' : isCapturing() ? 'Quiet' : 'Stopped';
      if (levels.system > 0.006 && warningText.startsWith('No computer sound')) { warningText = ''; $('#capture-warning').hidden = true; }
    },
    onWarning: showWarning,
    onEnded: (reason) => { showError(reason); void stopRecording(); },
  });
  try {
    await capture.start({ systemAudio });
    phase = 'recording'; startedAt = performance.now(); elapsed = 0;
    timer = setInterval(() => {
      elapsed = Math.min(MAX_SECONDS, Math.floor((performance.now() - startedAt) / 1000));
      $('#timer').textContent = formatTime(elapsed);
      if (elapsed >= MAX_SECONDS) { showWarning('This recording reached the one-hour limit and has been stopped. Save it before starting another meeting.'); void stopRecording(); }
    }, 500);
    updateUI();
  } catch (error) {
    phase = 'idle'; capture = null; showError(cleanError(error)); updateUI();
  }
}

async function stopRecording() {
  if (phase !== 'recording') return;
  phase = 'stopping'; clearInterval(timer); updateUI();
  try { await capture.stop(); }
  catch (error) { showError(cleanError(error)); }
  finally {
    capture = null;
    elapsed = chunks.reduce((seconds, chunk) => seconds + chunk.durationSeconds, 0);
    phase = pendingChunks().length || queueRunning ? 'processing' : 'ready';
    persist(); updateUI();
  }
}

function switchTab(name) {
  document.querySelectorAll('[data-tab]').forEach((button) => { button.classList.toggle('active', button.dataset.tab === name); button.setAttribute('aria-pressed', String(button.dataset.tab === name)); });
  $('#transcript-panel').hidden = name !== 'transcript'; $('#tasks-panel').hidden = name !== 'tasks';
}

function renderTasks() {
  if (!taskAnalysis) {
    $('#meeting-summary').innerHTML = '';
    $('#task-list').innerHTML = '<div class="empty"><img src="../extension/assets/pip.svg" alt="">A little clarity starts with a conversation.<br>Record a meeting, review the transcript, then find the little things.</div>';
    return;
  }
  $('#meeting-summary-title').textContent = taskAnalysis.title;
  $('#meeting-summary').innerHTML = `<section class="summary-card"><h3>Meeting summary ${taskAnalysis.mode === 'demo' ? '· rules demo' : '· AI'}</h3><ul>${taskAnalysis.summary.map((line) => `<li>${escapeHTML(line)}</li>`).join('')}</ul></section><section class="summary-card focus"><h3>The big picture is yours</h3><ul>${taskAnalysis.actionItems.length ? taskAnalysis.actionItems.map((item) => `<li>${escapeHTML(item.title)}</li>`).join('') : '<li>No strategic action items identified. Review the transcript for anything missed.</li>'}</ul></section>`;
  $('#task-list').innerHTML = taskAnalysis.tasks.length ? taskAnalysis.tasks.map((task) => `<article class="task-card"><div><h3>${escapeHTML(task.title)}</h3><p>${escapeHTML(task.description)}</p><small>${escapeHTML(task.owner)} · ${task.status === 'completed' ? 'Local draft ready' : task.status === 'dismissed' ? 'Dismissed' : 'Needs your review'}</small></div><button class="button secondary" data-task-id="${escapeHTML(task.id)}">${task.status === 'completed' ? 'View draft' : task.status === 'dismissed' ? 'Restore' : 'Review'} →</button></article>`).join('') : '<div class="empty">No administrative tasks were identified. Check the transcript for anything Pip missed.</div>';
}

function openReview(id) {
  const task = taskAnalysis?.tasks.find((item) => item.id === id);
  if (!task) return;
  if (task.status === 'dismissed') { task.status = 'suggested'; persist(); renderTasks(); updateUI(); return; }
  currentTaskId = id;
  const ready = task.status === 'completed';
  $('#review-content').innerHTML = `<div class="dialog-header"><h2>${escapeHTML(task.title)}</h2><button class="icon-button close-dialog" aria-label="Close">×</button></div><p class="field-label">From your transcript</p><blockquote class="source-quote">${escapeHTML(task.evidence)}</blockquote>${ready ? `<p class="field-label">Your approved draft</p><pre class="draft-output">${escapeHTML(task.result.text)}</pre><p class="small-note">Prepared locally after your approval. Nothing was sent or scheduled.</p><div class="dialog-actions"><button class="button secondary" id="export-draft">Save .txt</button><button class="button primary" id="copy-draft">Copy draft</button></div>` : `<label class="field-label" for="draft-editor">Make this draft yours</label><textarea id="draft-editor" rows="8" maxlength="20000">${escapeHTML(task.draft)}</textarea><p class="small-note">Approval prepares this exact text as a local draft. Fill in bracketed placeholders before using it.</p><div class="notice error" id="review-error" hidden></div><div class="dialog-actions"><button class="text-button" id="dismiss-task">Not needed</button><button class="button primary" id="approve-task">Approve & prepare draft</button></div>`}`;
  if (!$('#review-dialog').open) $('#review-dialog').showModal();
}

$('#start-recording').addEventListener('click', () => void startRecording());
$('#stop-recording').addEventListener('click', () => void stopRecording());
$('#hide-window').addEventListener('click', () => bridge.hidePanel());
document.querySelector('.tabs').addEventListener('click', (event) => { const button = event.target.closest('[data-tab]'); if (button) switchTab(button.dataset.tab); });
document.addEventListener('click', (event) => { if (event.target.closest('.close-dialog')) event.target.closest('dialog').close(); });
$('#settings-button').addEventListener('click', () => $('#settings-dialog').showModal());
$('#config-banner').addEventListener('click', (event) => { if (event.target.closest('button')) $('#settings-dialog').showModal(); });
$('#transcript-editor').addEventListener('input', () => { persist(); updateUI(); });
$('#new-meeting').addEventListener('click', () => { startAfterReset = false; $('#new-meeting-dialog').showModal(); });
$('#confirm-new-meeting').addEventListener('click', () => {
  if (isBusy()) return;
  chunks = []; taskAnalysis = null; savedTranscript = ''; persistedAudioCount = 0; elapsed = 0; phase = 'idle'; audioSaved = true;
  $('#transcript-editor').value = ''; $('#capture-error').hidden = true; $('#capture-warning').hidden = true; warningText = '';
  $('#microphone-meter').value = 0; $('#system-meter').value = 0;
  $('#mic-level-label').textContent = 'Waiting'; $('#system-level-label').textContent = 'Waiting';
  persist(); renderTasks(); updateUI(); $('#new-meeting-dialog').close(); switchTab('transcript');
  if (startAfterReset) { startAfterReset = false; void startRecording(); }
});
$('#retry-transcription').addEventListener('click', () => {
  if (queueRunning || !config.aiConfigured) return;
  for (const chunk of chunks) if (chunk.status === 'error') chunk.status = 'queued';
  $('#capture-error').hidden = true;
  if (!isCapturing()) phase = 'processing';
  void drainQueue();
});
$('#save-transcript').addEventListener('click', async () => {
  try { const result = await bridge.saveText({ text: $('#transcript-editor').value, suggestedName: 'pip-meeting-transcript.txt' }); if (result.saved) toast('Transcript saved.'); }
  catch (error) { showError(cleanError(error)); }
});
$('#save-audio').addEventListener('click', async () => {
  if (isCapturing() || !chunks.length) return;
  $('#save-audio').disabled = true;
  try {
    const audio = concatenateWavChunks(chunks.map((chunk) => chunk.audio));
    const result = await bridge.saveAudio({ audio, suggestedName: 'pip-meeting.wav' });
    if (result.saved) { audioSaved = true; toast('Your full recording was saved.'); }
  } catch (error) { showError(cleanError(error)); }
  finally { updateUI(); }
});
$('#find-tasks').addEventListener('click', async () => {
  if (isBusy()) return;
  const transcript = $('#transcript-editor').value.trim();
  if (chunks.some((chunk) => chunk.status === 'error')) { showError('Some audio segments failed to transcribe. Retry those segments before generating the meeting summary.'); return; }
  if (transcript.length > MAX_TRANSCRIPT_LENGTH) { showError(`The current summary step accepts ${MAX_TRANSCRIPT_LENGTH.toLocaleString()} characters. Save the full transcript, then shorten the text for analysis.`); return; }
  if ($('#summary-mode').value === 'ai' && !config.aiConfigured) { showError('AI summary needs OPENAI_API_KEY. Configure it in .env, or choose the local rules demo.'); return; }
  analyzing = true; updateUI(); $('#find-tasks').textContent = 'Picking up the little things…';
  try {
    taskAnalysis = await bridge.analyze({ transcript, mode: $('#summary-mode').value });
    persist(); renderTasks(); switchTab('tasks'); toast('Your meeting is a little clearer. Review each suggestion.');
  } catch (error) { showError(cleanError(error)); }
  finally { analyzing = false; $('#find-tasks').textContent = 'Find the little things →'; updateUI(); }
});
$('#task-list').addEventListener('click', (event) => { const button = event.target.closest('[data-task-id]'); if (button) openReview(button.dataset.taskId); });
$('#review-content').addEventListener('click', async (event) => {
  const button = event.target.closest('button'); if (!button) return;
  const index = taskAnalysis?.tasks.findIndex((task) => task.id === currentTaskId); if (index == null || index < 0) return;
  const task = taskAnalysis.tasks[index];
  if (button.id === 'approve-task') {
    try {
      taskAnalysis.tasks[index] = prepareApprovedDraft(approveTask(task, $('#draft-editor').value));
      persist(); renderTasks(); updateUI(); openReview(task.id);
    } catch (error) { $('#review-error').textContent = cleanError(error); $('#review-error').hidden = false; }
  } else if (button.id === 'dismiss-task') {
    taskAnalysis.tasks[index] = dismissTask(task); persist(); renderTasks(); updateUI(); $('#review-dialog').close();
  } else if (button.id === 'export-draft') {
    try { if ((await bridge.saveText({ text: task.result.text, suggestedName: `pip-${task.type}-draft.txt` })).saved) toast('Draft saved.'); }
    catch (error) { toast(cleanError(error)); }
  } else if (button.id === 'copy-draft') {
    try { await navigator.clipboard.writeText(task.result.text); toast('Draft copied.'); }
    catch { toast('Clipboard unavailable. Save the draft as a text file instead.'); }
  }
});
$('#review-dialog').addEventListener('close', () => {
  const task = taskAnalysis?.tasks.find((item) => item.id === currentTaskId);
  if (task?.status === 'suggested' && $('#draft-editor')) { task.draft = $('#draft-editor').value; persist(); }
});
bridge?.onSuspend(() => {
  if (phase === 'recording') { showWarning('The computer is going to sleep. Pip stopped this recording; review and save it when you return.'); void stopRecording(); }
});
window.addEventListener('beforeunload', () => { persist(); if (capture) void capture.stop(); });

try {
  if (!bridge) throw new Error('Open the desktop app with npm run desktop. This recording window needs the native Pip runtime.');
  config = await bridge.getConfig();
  runtimeReady = true;
  $('#config-path').textContent = `Configuration file: ${config.envPath}`;
  $('#config-status').textContent = `Microphone: ${config.permissions?.microphone || 'unknown'} · Screen: ${config.permissions?.screen || 'unknown'} · Transcription: ${config.aiConfigured ? config.transcriptionModel : 'not configured'}`;
  if (!config.aiConfigured) {
    $('#transcribe-enabled').checked = false;
    $('#summary-mode').value = 'demo';
    $('#config-banner').innerHTML = 'Pip can record now. Add your API key to enable real transcription. <button>Setup & permissions →</button>';
    $('#config-banner').hidden = false;
  }
} catch (error) { showError(cleanError(error)); $('#start-recording').disabled = true; }
renderTasks(); updateUI();
