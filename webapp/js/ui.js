// Small DOM helpers shared by the views.
export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const m = (d) => (d == null || !Number.isFinite(d) ? '–' : `${Math.round(d)}`);
export const signed = (n) => (n == null ? '–' : n === 0 ? 'E' : n > 0 ? `+${n}` : `${n}`);
export const pctText = (n) => (n == null ? '–' : `${n}%`);
export const one = (n) => (n == null || !Number.isFinite(n) ? '–' : n.toFixed(1));

export function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

let toastTimer = null;
export function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
}

export function vibrate(ms = 15) {
  try { navigator.vibrate?.(ms); } catch { /* iOS has no vibration API */ }
}

// Bottom sheet built on <dialog>. `render(el)` fills it; returns a close fn.
export function sheet(html, onMount) {
  const d = document.createElement('dialog');
  d.className = 'sheet';
  d.innerHTML = `<div class="sheet-grip" aria-hidden="true"></div>${html}`;
  document.body.appendChild(d);
  const close = () => { d.close(); };
  d.addEventListener('close', () => d.remove());
  d.addEventListener('click', (e) => { if (e.target === d) close(); });
  d.showModal();
  onMount?.(d, close);
  return close;
}

export function confirmSheet(message, actionLabel, danger = true) {
  return new Promise((resolve) => {
    let answered = false;
    sheet(
      `<p class="sheet-msg">${esc(message)}</p>
       <div class="sheet-row">
         <button class="btn ghost" data-a="no">Cancel</button>
         <button class="btn ${danger ? 'danger' : 'primary'}" data-a="yes">${esc(actionLabel)}</button>
       </div>`,
      (d, close) => {
        d.addEventListener('click', (e) => {
          const a = e.target.closest('[data-a]')?.dataset.a;
          if (!a) return;
          answered = true;
          resolve(a === 'yes');
          close();
        });
        d.addEventListener('close', () => { if (!answered) resolve(false); });
      },
    );
  });
}

// Share a file on iOS (Save to Files, AirDrop, Mail), or download elsewhere.
export async function saveFile(name, text, type) {
  const blob = new Blob([text], { type });
  const file = new File([blob], name, { type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function pickFile(accept) {
  return new Promise((resolve) => {
    const i = document.createElement('input');
    i.type = 'file';
    i.accept = accept;
    i.onchange = () => resolve(i.files?.[0] ?? null);
    i.click();
  });
}
