(() => {
  const HOST_ID = "pip-work-companion-v1";
  const existing = document.getElementById(HOST_ID);
  if (existing) {
    existing.style.display = "block";
    return;
  }

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText = "all:initial;position:fixed;right:24px;bottom:24px;width:126px;height:126px;z-index:2147483647;display:block;";
  const root = host.attachShadow({ mode: "closed" });
  // This fixed, extension-owned markup contains no page data or model output.
  root.innerHTML = `
    <style>
      :host { color-scheme: light; }
      * { box-sizing: border-box; }
      .wrap { width:126px;height:126px;position:relative;font:12px/1.3 system-ui,sans-serif;color:#263d33; }
      .pet { all:unset;display:block;position:absolute;inset:22px 14px 4px;cursor:grab;touch-action:none;user-select:none;border-radius:44%; }
      .pet:active { cursor:grabbing; }
      .pet:focus-visible,.hide:focus-visible { outline:3px solid #255e4b;outline-offset:5px; }
      .body { position:absolute;left:6px;top:13px;width:86px;height:75px;background:#b9e5cc;border:2px solid #335f4a;border-radius:45% 45% 37% 38%;box-shadow:0 8px 18px #163c2920,inset -7px -5px 0 #a3d5b9;animation:breathe 4s ease-in-out infinite; }
      .leaf { position:absolute;left:46px;top:2px;width:19px;height:13px;background:#5f9a71;border:2px solid #335f4a;border-radius:0 90% 0 90%;transform:rotate(-13deg); }
      .eye { position:absolute;top:30px;width:5px;height:8px;background:#294535;border-radius:50%; }
      .eye.left { left:25px; } .eye.right { right:25px; }
      .cheek { position:absolute;top:40px;width:11px;height:6px;background:#e7b5a3;border-radius:50%;opacity:.8; }
      .cheek.left { left:15px; } .cheek.right { right:15px; }
      .smile { position:absolute;left:35px;top:39px;width:12px;height:6px;border-bottom:2px solid #294535;border-radius:0 0 50% 50%; }
      .foot { position:absolute;bottom:-4px;width:18px;height:9px;background:#b9e5cc;border:2px solid #335f4a;border-top:0;border-radius:0 0 50% 50%; }
      .foot.left { left:13px; } .foot.right { right:13px; }
      .bubble { position:absolute;top:0;left:4px;right:4px;padding:6px 8px;text-align:center;background:#fffdf7;border:1px solid #dfe5dc;border-radius:10px;box-shadow:0 3px 10px #1e302712;white-space:nowrap;pointer-events:none;font-weight:600; }
      .hide { all:unset;position:absolute;right:-2px;top:30px;width:22px;height:22px;text-align:center;border:1px solid #dce5dc;border-radius:50%;background:#fffdf7;cursor:pointer;opacity:0;transition:opacity .15s;font:16px system-ui; }
      .wrap:hover .hide,.wrap:focus-within .hide { opacity:1; }
      @keyframes breathe { 50% { transform:translateY(-3px) rotate(-2deg); } }
      @media(prefers-reduced-motion:reduce) { .body { animation:none; } .hide { transition:none; } }
    </style>
    <div class="wrap">
      <div class="bubble" aria-hidden="true">A little less busy.</div>
      <button class="pet" type="button" aria-label="Open Pip tasks. Drag or use arrow keys to move your companion." title="Click to open tasks · drag to move">
        <span class="leaf" aria-hidden="true"></span>
        <span class="body" aria-hidden="true">
          <span class="eye left"></span><span class="eye right"></span>
          <span class="cheek left"></span><span class="cheek right"></span>
          <span class="smile"></span><span class="foot left"></span><span class="foot right"></span>
        </span>
      </button>
      <button class="hide" type="button" aria-label="Hide Pip on this page" title="Hide until you click the toolbar icon">×</button>
    </div>`;

  const pet = root.querySelector(".pet");
  const bubble = root.querySelector(".bubble");
  let drag = null;
  let suppressClick = false;

  function moveTo(left, top) {
    host.style.left = `${Math.max(0, Math.min(left, window.innerWidth - 126))}px`;
    host.style.top = `${Math.max(0, Math.min(top, window.innerHeight - 126))}px`;
    host.style.right = "auto";
    host.style.bottom = "auto";
  }

  function showCount(count) {
    const safeCount = Math.max(0, Math.min(999, Math.floor(Number(count) || 0)));
    bubble.textContent = safeCount ? `${safeCount} little task${safeCount === 1 ? "" : "s"}` : "A little less busy.";
    pet.setAttribute("aria-label", `Open Pip tasks. ${safeCount} pending. Drag or use arrow keys to move your companion.`);
  }

  pet.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !event.isPrimary) return;
    const bounds = host.getBoundingClientRect();
    drag = { id:event.pointerId, x:event.clientX, y:event.clientY, left:bounds.left, top:bounds.top, moved:false };
    suppressClick = false;
    pet.setPointerCapture(event.pointerId);
  });

  pet.addEventListener("pointermove", (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (Math.hypot(dx, dy) > 5) drag.moved = true;
    if (drag.moved) moveTo(drag.left + dx, drag.top + dy);
  });

  function endDrag(event) {
    if (!drag || drag.id !== event.pointerId) return;
    suppressClick = drag.moved || event.type === "pointercancel";
    drag = null;
    if (pet.hasPointerCapture(event.pointerId)) pet.releasePointerCapture(event.pointerId);
  }
  pet.addEventListener("pointerup", endDrag);
  pet.addEventListener("pointercancel", endDrag);
  pet.addEventListener("lostpointercapture", () => { drag = null; });

  pet.addEventListener("click", (event) => {
    if (suppressClick && event.detail !== 0) {
      suppressClick = false;
      return;
    }
    try {
      chrome.runtime.sendMessage({ type:"PIP_OPEN_PANEL" }).then((result) => {
        if (!result?.ok) bubble.textContent = "Use the toolbar icon";
      }).catch(() => { bubble.textContent = "Reload to wake Pip"; });
    } catch {
      bubble.textContent = "Reload to wake Pip";
    }
  });

  pet.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 40 : 12;
    const offset = { ArrowLeft:[-step,0], ArrowRight:[step,0], ArrowUp:[0,-step], ArrowDown:[0,step] }[event.key];
    if (!offset) return;
    event.preventDefault();
    const bounds = host.getBoundingClientRect();
    moveTo(bounds.left + offset[0], bounds.top + offset[1]);
  });

  root.querySelector(".hide").addEventListener("click", () => { host.style.display = "none"; });
  window.addEventListener("resize", () => {
    if (host.style.display === "none") return;
    const bounds = host.getBoundingClientRect();
    moveTo(bounds.left, bounds.top);
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "PIP_TASK_COUNT") showCount(message.count);
  });
  document.documentElement.append(host);
  const bounds = host.getBoundingClientRect();
  moveTo(bounds.left, bounds.top);
  chrome.runtime.sendMessage({ type:"PIP_GET_COUNT" }).then((result) => showCount(result?.count)).catch(() => {});
})();
