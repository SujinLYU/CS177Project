import { analyzeTranscript, MAX_TRANSCRIPT_LENGTH } from './lib/analyzer.mjs';
import { SAMPLE_TRANSCRIPT } from './lib/sample.mjs';
import { approveTask, prepareApprovedDraft, dismissTask } from './lib/workflow.mjs';

const $ = (selector) => document.querySelector(selector);
const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STORAGE_KEY = 'pip-workspace-v1';
const iconPaths = {
  inbox: '<path d="M4 4h16v16H4z"/><path d="M4 13h5l2 3h2l2-3h5"/>',
  notes: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',
  calendar: '<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v4m8-4v4M4 10h16M8 14h2m4 0h2m-8 3h2"/>',
  check: '<path d="m6 12 4 4 8-8"/><circle cx="12" cy="12" r="10"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  sparkle: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/>',
  shield: '<path d="m12 3 8 3v6c0 4-5 8-8 9-3-1-8-5-8-9V6z"/><path d="m8 12 3 3 5-6"/>',
  update: '<path d="M4 4h16v12H9l-5 4zM8 8h8m-8 4h5"/>',
};
const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${iconPaths[name] || iconPaths.notes}</svg>`;
document.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = icon(el.dataset.icon); });
const typeNames = { email: 'Email', schedule: 'Calendar', update: 'Team update', document: 'Document' };
const typeIcons = { email: 'mail', schedule: 'calendar', update: 'update', document: 'notes' };

let state = loadState();
let view = 'inbox';
let filter = 'suggested';
let currentTaskId = null;
let toastTimer;
let analysisPending = false;
let storageFailed = false;

function initialState() {
  return { version: 1, transcript: SAMPLE_TRANSCRIPT, analysis: analyzeTranscript(SAMPLE_TRANSCRIPT), activity: [], pet: null };
}

function emptyState() {
  return { version: 1, transcript: '', analysis: { title: 'No meeting yet', summary: [], decisions: [], actionItems: [], tasks: [], mode: 'demo' }, activity: [], pet: null };
}

function loadState() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!raw || raw.version !== 1 || typeof raw.transcript !== 'string' || !raw.analysis || !Array.isArray(raw.activity)) return initialState();
    const a = raw.analysis;
    if (typeof a.title !== 'string' || !['demo', 'ai'].includes(a.mode) || !['summary', 'decisions', 'actionItems', 'tasks'].every((k) => Array.isArray(a[k]))) return initialState();
    if (![...a.summary, ...a.decisions].every((text) => typeof text === 'string')) return initialState();
    if (!a.actionItems.every((item) => item && typeof item.title === 'string' && typeof item.owner === 'string')) return initialState();
    if (!a.tasks.every((task) => task && ['email', 'schedule', 'update', 'document'].includes(task.type) && ['suggested', 'approved', 'completed', 'dismissed'].includes(task.status) && ['id', 'title', 'description', 'owner', 'evidence', 'draft'].every((k) => typeof task[k] === 'string') && Number.isFinite(task.estimateMinutes) && (task.status !== 'completed' || typeof task.result?.text === 'string'))) return initialState();
    if (!raw.activity.every((event) => event && ['title', 'detail', 'at'].every((k) => typeof event[k] === 'string'))) return initialState();
    // A browser closing during preparation must never resume execution implicitly.
    a.tasks = a.tasks.map((task) => task.status === 'approved' ? { ...task, status: 'suggested', approvedAt: undefined, approvedDraft: undefined } : task);
    return raw;
  } catch { return initialState(); }
}

function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); storageFailed = false; }
  catch {
    if (!storageFailed) toast('Local storage is unavailable or full. Changes will last for this session only.');
    storageFailed = true;
  }
}

function addActivity(title, detail) {
  state.activity.unshift({ title, detail, at: new Date().toISOString() });
  state.activity = state.activity.slice(0, 100);
}

function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500);
}

function render() {
  const { tasks } = state.analysis;
  const pending = tasks.filter((task) => task.status === 'suggested');
  const completed = tasks.filter((task) => task.status === 'completed');
  const minutes = pending.reduce((sum, task) => sum + task.estimateMinutes, 0);
  ['#nav-count', '#stat-pending', '#pending-count', '#pet-count'].forEach((id) => { $(id).textContent = pending.length; });
  $('#pocket-count').textContent = tasks.length;
  $('#stat-ready').textContent = completed.length;
  $('#ready-count').textContent = completed.length;
  $('#stat-time').textContent = `${minutes} min`;
  $('#mode-label').textContent = state.analysis.mode === 'ai' ? 'AI analysis' : 'Local demo';
  $('#analysis-label').textContent = state.analysis.mode === 'ai' ? 'AI · REVIEW SUGGESTIONS' : 'RULE-BASED DEMO';
  const isSidePanel = document.documentElement.dataset.surface === 'extension';
  $('#hero-title').innerHTML = isSidePanel
    ? (pending.length ? `${pending.length} little thing${pending.length === 1 ? '' : 's'} to review.` : 'A little more headspace.')
    : (pending.length ? `I picked up ${pending.length} little thing${pending.length === 1 ? '' : 's'}<br>so you don’t have to.` : 'A little more room<br>for the big picture.');
  $('#hero-description').textContent = pending.length
    ? (isSidePanel ? 'Check the source, edit the draft, and approve when you’re ready.' : 'A few follow-ups, all in one place. Take a look, make them yours, and let me prepare the drafts.')
    : completed.length ? 'Your approved drafts are ready. Copy or download them whenever you’re ready to take the next step.' : 'Bring me your meeting notes. We’ll find the follow-ups together.';
  $('#review-next').innerHTML = `${pending.length ? 'Let’s take a look' : completed.length ? 'See your drafts' : 'Add a meeting'} ${icon('arrow')}`;
  $('#pet-bubble').textContent = pending.length ? `${pending.length} little thing${pending.length === 1 ? '' : 's'} in my pocket.` : 'A little more headspace. 🌱';
  $('#meeting-title').textContent = state.analysis.title;
  $('#summary-list').innerHTML = state.analysis.summary.length ? state.analysis.summary.slice(0, 3).map((line) => `<li>${escapeHTML(line)}</li>`).join('') : '<li>Add meeting notes to see the context here.</li>';
  $('#focus-items').innerHTML = state.analysis.actionItems.length ? state.analysis.actionItems.map((item) => `<div class="focus-item"><strong>${escapeHTML(item.title)}</strong><span>Owner: ${escapeHTML(item.owner)}</span></div>`).join('') : '<p class="subtle">No strategic action items were identified. Check the meeting notes for anything the analysis missed.</p>';
  renderTasks();
  renderMeeting();
  renderActivity();
  if (globalThis.chrome?.runtime?.id) {
    chrome.runtime.sendMessage({ type: 'PIP_TASK_COUNT', count: pending.length }).catch(() => {});
  }
}

function renderTasks() {
  document.querySelectorAll('[data-filter]').forEach((button) => {
    button.classList.toggle('active', button.dataset.filter === filter);
    button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
  });
  const tasks = state.analysis.tasks.filter((task) => task.status === filter);
  if (!tasks.length) {
    const labels = {
      suggested: ['Nothing waiting in your pocket.', state.transcript ? 'No suggestions left to review. Check your drafts or bring in another meeting.' : 'Add a meeting to let Pip pick up your little follow-ups.'],
      completed: ['A little help starts with a review.', 'Review a task and approve its draft preparation. Your ready drafts will appear here.'],
      dismissed: ['Nothing dismissed.', 'Suggestions you set aside will appear here. You can bring them back anytime.'],
    };
    $('#task-list').innerHTML = `<div class="empty-state"><img src="assets/pip.svg" alt=""><h3>${labels[filter][0]}</h3><p>${labels[filter][1]}</p></div>`;
    return;
  }
  $('#task-list').innerHTML = tasks.map((task) => `<article class="task-card"><div class="task-top"><span class="task-type-icon ${escapeHTML(task.type)}">${icon(typeIcons[task.type])}</span><div class="task-title-wrap"><h3>${escapeHTML(task.title)}</h3><p class="task-description">${escapeHTML(task.description)}</p></div><span class="task-dot"></span></div><div class="task-footer"><div class="task-meta"><span class="type-label">${typeNames[task.type]}</span><span>${icon('clock')}~${task.estimateMinutes} min</span></div><button class="review-button" data-task-id="${escapeHTML(task.id)}">${task.status === 'completed' ? 'View draft' : task.status === 'dismissed' ? 'Review again' : 'Review task'} ${icon('arrow')}</button></div></article>`).join('');
}

function renderMeeting() {
  const analysis = state.analysis;
  $('#meeting-details').innerHTML = state.transcript ? `<article class="notes-card"><span class="tag tag-muted">${analysis.mode === 'ai' ? 'AI ANALYSIS · CHECK AGAINST SOURCE' : 'LOCAL RULE-BASED DEMO'}</span><h2>${escapeHTML(analysis.title)}</h2><h3>Summary</h3>${listOrEmpty(analysis.summary, 'No summary available.')}<h3>Decisions</h3>${listOrEmpty(analysis.decisions, 'No explicit decisions identified.')}<h3>Core action items · for your judgment</h3>${listOrEmpty(analysis.actionItems.map((item) => `${item.owner}: ${item.title}`), 'No strategic action items identified.')}<h3>Original meeting transcript</h3><pre>${escapeHTML(state.transcript)}</pre></article>` : '<div class="empty-state"><h3>A fresh page.</h3><p>Add your first meeting using the button above.</p></div>';
}

function listOrEmpty(items, empty) {
  return items.length ? `<ul>${items.map((item) => `<li>${escapeHTML(item)}</li>`).join('')}</ul>` : `<p class="subtle">${empty}</p>`;
}

function renderActivity() {
  $('#activity-list').innerHTML = state.activity.length ? state.activity.map((event) => `<article class="activity-row"><span>${icon('check')}</span><div><strong>${escapeHTML(event.title)}</strong><p>${escapeHTML(event.detail)}</p><small>${escapeHTML(new Date(event.at).toLocaleString())}</small></div></article>`).join('') : '<div class="empty-state"><img src="assets/pip.svg" alt=""><h3>Your little wins will live here.</h3><p>Approve a draft to start. Pip records each step so you can see what happened.</p></div>';
}

function switchView(next) {
  view = next;
  ['inbox', 'meetings', 'activity'].forEach((name) => { $(`#${name}-view`).hidden = name !== view; });
  document.querySelectorAll('[data-view]').forEach((button) => {
    const selected = button.dataset.view === next;
    button.classList.toggle('active', selected);
    if (selected) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  $('#breadcrumb-view').textContent = { inbox: 'My pocket', meetings: 'Meeting notes', activity: 'Activity' }[view];
}

function openMeeting() {
  if (analysisPending) return;
  $('#form-error').hidden = true;
  $('#meeting-dialog').showModal();
  $('#transcript').focus();
}

function reviewNext() {
  const task = state.analysis.tasks.find((item) => item.status === 'suggested');
  if (task) openReview(task.id);
  else if (state.analysis.tasks.some((item) => item.status === 'completed')) { filter = 'completed'; switchView('inbox'); renderTasks(); $('#task-heading').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  else openMeeting();
}

function openReview(id) {
  const task = state.analysis.tasks.find((item) => item.id === id);
  if (!task) return;
  currentTaskId = id;
  const ready = task.status === 'completed';
  const dismissed = task.status === 'dismissed';
  $('#review-content').innerHTML = `<div class="dialog-heading"><div><div class="eyebrow">${ready ? 'A LITTLE THING, READY FOR YOU' : 'YOU HAVE THE FINAL SAY'}</div><h2 id="review-dialog-title">${escapeHTML(task.title)}</h2></div><button class="icon-button close-dialog" aria-label="Close dialog">×</button></div><div class="review-meta"><span>${typeNames[task.type]}</span><span>Owner: ${escapeHTML(task.owner)}</span><span>~${task.estimateMinutes} min manual effort</span></div><p class="field-label">Picked up from your meeting</p><blockquote class="source-quote">${escapeHTML(task.evidence)}</blockquote>${ready ? `<p class="field-label">Your approved draft</p><pre class="draft-output">${escapeHTML(task.result.text)}</pre><div class="review-note">Prepared locally after your approval. Nothing has been sent or scheduled.</div><div class="dialog-footer"><button class="button button-soft" id="download-draft">Download .txt</button><button class="button button-dark" id="copy-draft">Copy draft ${icon('check')}</button></div>` : dismissed ? '<div class="review-note">You dismissed this suggestion. Restore it to edit and approve a draft.</div><button class="button button-dark" id="restore-task">Bring back to my pocket</button>' : `<label class="field-label" for="draft-editor">Make the draft yours</label><textarea id="draft-editor" rows="9" maxlength="20000">${escapeHTML(task.draft)}</textarea><div class="review-note">Your approval prepares this exact text as a local draft. Fill in any bracketed placeholders before using it. External sending and scheduling are not connected.</div><div id="review-error" class="form-error" role="alert" hidden></div><div class="dialog-footer"><button class="text-button" id="dismiss-task">Not needed · dismiss</button><button class="button button-dark" id="approve-task">Approve & prepare draft ${icon('arrow')}</button></div>`}`;
  if (!$('#review-dialog').open) $('#review-dialog').showModal();
}

$('#navigation').addEventListener('click', (event) => { const button = event.target.closest('[data-view]'); if (button) switchView(button.dataset.view); });
document.querySelector('.filters').addEventListener('click', (event) => { const button = event.target.closest('[data-filter]'); if (button) { filter = button.dataset.filter; renderTasks(); } });
$('#task-list').addEventListener('click', (event) => { const button = event.target.closest('[data-task-id]'); if (button) openReview(button.dataset.taskId); });
$('#add-meeting').addEventListener('click', openMeeting);
$('#review-next').addEventListener('click', reviewNext);
$('#view-notes').addEventListener('click', () => switchView('meetings'));
$('#mode-info').addEventListener('click', () => $('#info-dialog').showModal());
document.addEventListener('click', (event) => { if (event.target.closest('.close-dialog')) event.target.closest('dialog').close(); });

$('#transcript').maxLength = MAX_TRANSCRIPT_LENGTH;
function updateCount() { $('#character-count').textContent = `${$('#transcript').value.length.toLocaleString()} / ${MAX_TRANSCRIPT_LENGTH.toLocaleString()}`; }
updateCount();
$('#transcript').addEventListener('input', updateCount);
$('#load-sample').addEventListener('click', () => { $('#transcript').value = SAMPLE_TRANSCRIPT; updateCount(); $('#transcript').focus(); });
$('#analysis-mode').addEventListener('change', () => {
  $('#mode-description').textContent = $('#analysis-mode').value === 'ai' ? 'Your submitted transcript will be sent to OpenAI through the local backend. Start npm start with .env configured; extension users also need EXTENSION_ID. Only the active meeting is kept.' : 'Demo mode uses simple keyword rules. It is not a language model and may miss or misclassify tasks. Only the active meeting is kept in this prototype.';
});

$('#meeting-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (analysisPending) return;
  const transcript = $('#transcript').value;
  const mode = $('#analysis-mode').value;
  analysisPending = true;
  $('#form-error').hidden = true;
  $('#analyze-button').disabled = true;
  $('#analyze-button').textContent = 'Picking up the little things…';
  $('#meeting-dialog').querySelectorAll('textarea, select, .close-dialog, #load-sample').forEach((el) => { el.disabled = true; });
  try {
    let analysis;
    if (mode === 'demo') analysis = analyzeTranscript(transcript);
    else {
      // Extension pages use the explicitly permitted local development backend.
      const base = location.protocol === 'chrome-extension:' ? 'http://localhost:4173' : '';
      let response;
      try {
        response = await fetch(`${base}/api/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transcript, mode }), signal: AbortSignal.timeout(55000) });
      } catch (error) {
        throw new Error(error.name === 'TimeoutError' ? 'Analysis timed out. Your previous meeting is safe. Try again.' : 'Could not reach the local AI backend. Start npm start and check .env; extension users must set EXTENSION_ID.');
      }
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Analysis failed. Please try again.');
      analysis = payload;
    }
    state.analysis = analysis;
    state.transcript = transcript.trim();
    state.activity = [];
    addActivity('Meeting added', `${analysis.title} · ${analysis.tasks.length} busywork suggestions · ${mode === 'ai' ? 'AI analysis' : 'local rule-based demo'}`);
    filter = 'suggested';
    saveState();
    render();
    switchView('inbox');
    $('#meeting-dialog').close();
    toast(`Pip picked up ${analysis.tasks.length} little thing${analysis.tasks.length === 1 ? '' : 's'}.`);
  } catch (error) {
    $('#form-error').textContent = error.message;
    $('#form-error').hidden = false;
  } finally {
    analysisPending = false;
    $('#analyze-button').disabled = false;
    $('#analyze-button').innerHTML = `${icon('sparkle')}Find the little things`;
    $('#meeting-dialog').querySelectorAll('textarea, select, .close-dialog, #load-sample').forEach((el) => { el.disabled = false; });
  }
});
$('#meeting-dialog').addEventListener('cancel', (event) => { if (analysisPending) event.preventDefault(); });

$('#review-content').addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const index = state.analysis.tasks.findIndex((task) => task.id === currentTaskId);
  if (index < 0) return;
  const task = state.analysis.tasks[index];
  if (button.id === 'approve-task') {
    try {
      const approved = approveTask(task, $('#draft-editor').value);
      const completed = prepareApprovedDraft(approved);
      state.analysis.tasks[index] = completed;
      addActivity('Draft preparation approved', task.title);
      addActivity('Local draft ready', `${task.title} · nothing was sent or scheduled`);
      saveState(); render(); openReview(task.id); toast('One little thing is ready. Your approved draft is prepared.');
    } catch (error) { $('#review-error').textContent = error.message; $('#review-error').hidden = false; }
  } else if (button.id === 'dismiss-task') {
    state.analysis.tasks[index] = dismissTask(task);
    addActivity('Suggestion dismissed', task.title);
    saveState(); render(); $('#review-dialog').close(); toast('Set aside. You can find it under Dismissed.');
  } else if (button.id === 'restore-task') {
    state.analysis.tasks[index] = { ...task, status: 'suggested' };
    addActivity('Suggestion restored', task.title);
    saveState(); render(); openReview(task.id);
  } else if (button.id === 'copy-draft') {
    try { await navigator.clipboard.writeText(task.result.text); toast('Draft copied. Ready when you are.'); }
    catch { toast('Clipboard access is unavailable. Download the draft or select the text to copy.'); }
  } else if (button.id === 'download-draft') {
    const blob = new Blob([task.result.text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `pip-${task.type}-draft.txt`;
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Your draft download is ready.');
  }
});
// Keep edits when a review is closed without approving it.
$('#review-dialog').addEventListener('close', () => {
  const task = state.analysis.tasks.find((item) => item.id === currentTaskId);
  const editor = $('#draft-editor');
  if (task?.status === 'suggested' && editor) { task.draft = editor.value; saveState(); }
});
$('#reset-workspace').addEventListener('click', () => {
  state = emptyState(); filter = 'suggested'; currentTaskId = null;
  $('#transcript').value = ''; updateCount();
  saveState(); render(); switchView('inbox'); $('#info-dialog').close();
  resetPet(); toast('Local meeting, tasks, and activity cleared. A fresh start.');
});

// The web preview pet uses the same interaction as the content-script companion.
let drag = null;
let suppressClick = false;
const pet = $('#pet-widget');
const petButton = $('#pet-button');
function positionPet(x, y, persist = false) {
  const left = Math.max(0, Math.min(x, window.innerWidth - pet.offsetWidth));
  const top = Math.max(0, Math.min(y, window.innerHeight - pet.offsetHeight));
  pet.style.left = `${left}px`; pet.style.top = `${top}px`; pet.style.right = 'auto'; pet.style.bottom = 'auto';
  if (persist) { state.pet = { x: left, y: top }; saveState(); }
}
function resetPet() { pet.style.left = ''; pet.style.top = ''; pet.style.right = ''; pet.style.bottom = ''; }
petButton.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  const rect = pet.getBoundingClientRect();
  drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
  suppressClick = false;
  petButton.setPointerCapture(event.pointerId);
});
petButton.addEventListener('pointermove', (event) => {
  if (!drag) return;
  const dx = event.clientX - drag.x; const dy = event.clientY - drag.y;
  if (Math.hypot(dx, dy) > 5) drag.moved = true;
  if (drag.moved) positionPet(drag.left + dx, drag.top + dy);
});
petButton.addEventListener('pointerup', () => {
  if (!drag) return;
  suppressClick = drag.moved;
  if (drag.moved) { const rect = pet.getBoundingClientRect(); positionPet(rect.left, rect.top, true); }
  drag = null;
});
petButton.addEventListener('pointercancel', () => { drag = null; suppressClick = true; });
petButton.addEventListener('click', (event) => {
  if (suppressClick && event.detail !== 0) { suppressClick = false; return; }
  suppressClick = false;
  reviewNext();
});
petButton.addEventListener('keydown', (event) => {
  const offset = { ArrowLeft: [-15, 0], ArrowRight: [15, 0], ArrowUp: [0, -15], ArrowDown: [0, 15] }[event.key];
  if (!offset) return;
  event.preventDefault(); const rect = pet.getBoundingClientRect(); positionPet(rect.left + offset[0], rect.top + offset[1], true);
});
window.addEventListener('resize', () => { if (state.pet) positionPet(state.pet.x, state.pet.y); });
render();
saveState();
if (Number.isFinite(state.pet?.x) && Number.isFinite(state.pet?.y)) positionPet(state.pet.x, state.pet.y);
