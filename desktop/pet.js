const bridge = window.pipDesktop;
const pet = document.querySelector('#pet');
let drag;
let suppressClick = false;
let moveQueue = Promise.resolve();

pet.addEventListener('pointerdown', async (event) => {
  if (event.button !== 0) return;
  const gesture = { pointerId: event.pointerId, screenX: event.screenX, screenY: event.screenY, latestX: event.screenX, latestY: event.screenY, moved: false };
  drag = gesture;
  suppressClick = false;
  pet.setPointerCapture(event.pointerId);
  try { const position = await bridge.getPetPosition(); if (drag === gesture) gesture.position = position; }
  catch { drag = null; }
});
pet.addEventListener('pointermove', (event) => {
  if (!drag || drag.pointerId !== event.pointerId) return;
  const dx = event.screenX - drag.screenX;
  const dy = event.screenY - drag.screenY;
  if (Math.hypot(dx, dy) > 4) drag.moved = true;
  if (drag.moved && drag.position) {
    const target = { x: drag.position.x + dx, y: drag.position.y + dy };
    moveQueue = moveQueue.then(() => bridge.movePet(target)).catch(() => {});
  }
});
pet.addEventListener('pointerup', () => { suppressClick = Boolean(drag?.moved); drag = null; });
pet.addEventListener('pointercancel', () => { suppressClick = true; drag = null; });
pet.addEventListener('click', (event) => {
  if (suppressClick && event.detail !== 0) { suppressClick = false; return; }
  suppressClick = false;
  bridge.openPanel();
});
pet.addEventListener('keydown', async (event) => {
  const step = event.shiftKey ? 40 : 12;
  const offset = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
  if (!offset) return;
  event.preventDefault();
  const current = await bridge.getPetPosition();
  await bridge.movePet({ x: current.x + offset[0], y: current.y + offset[1] });
});
document.querySelector('#open').addEventListener('click', () => bridge.openPanel());
document.querySelector('#quit').addEventListener('click', () => bridge.quit());
bridge.onStatus((status) => {
  const bubble = document.querySelector('#pet-status');
  bubble.textContent = status.recording ? 'Listening. Click to see notes.' : status.transcribing ? 'Putting your words together…' : status.pendingCount ? `${status.pendingCount} little things to review.` : 'A little more headspace.';
  bubble.classList.toggle('recording', status.recording);
  document.querySelector('#recording-light').hidden = !status.recording;
  const badge = document.querySelector('#badge');
  badge.textContent = status.pendingCount || '';
  badge.hidden = !status.pendingCount || status.recording;
});
