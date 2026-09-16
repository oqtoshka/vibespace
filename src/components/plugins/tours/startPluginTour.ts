type TourStep = {
  title: string;
  body: string;
  /** Stable host anchor, or omit for a centered introductory slide. */
  target?: string;
};

type Tour = {
  id: string;
  version: number;
  steps: TourStep[];
  labels?: { back?: string; next?: string; finish?: string; close?: string; missing?: string };
};

let activeCleanup: (() => void) | undefined;

/** Client plugins use this host-owned overlay; strings are always rendered as text. */
export function startPluginTour(pluginName: string, tour: Tour): () => void {
  if (!tour || typeof tour.id !== 'string' || !Number.isInteger(tour.version)
    || !Array.isArray(tour.steps) || !tour.steps.length || tour.steps.length > 100
    || tour.steps.some(step => typeof step.title !== 'string' || typeof step.body !== 'string'
      || (step.target !== undefined && !/^[a-zA-Z0-9_-]+$/.test(step.target)))) {
    throw new Error('Invalid tutorial');
  }
  activeCleanup?.();
  const storageKey = `vibespace:tour:${encodeURIComponent(pluginName)}:${encodeURIComponent(tour.id)}:${tour.version}`;
  let index = 0;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (!saved?.completed && Number.isInteger(saved?.step)) index = Math.max(0, Math.min(saved.step, tour.steps.length - 1));
  } catch { /* Storage may be unavailable. */ }
  const previousFocus = document.activeElement as HTMLElement | null;
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;pointer-events:none;font:14px/1.5 system-ui;color:#111827';
  const spotlight = document.createElement('div');
  spotlight.style.cssText = 'position:fixed;border:2px solid #60a5fa;border-radius:8px;box-shadow:0 0 0 9999px rgb(0 0 0 / .65);pointer-events:auto';
  const panel = document.createElement('section');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', 'Tutorial');
  panel.style.cssText = 'position:fixed;box-sizing:border-box;width:min(400px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto;background:white;border-radius:12px;padding:20px;box-shadow:0 10px 40px #0006;pointer-events:auto';
  const progress = document.createElement('div');
  progress.style.cssText = 'font-size:12px;color:#6b7280';
  const heading = document.createElement('h2');
  heading.style.cssText = 'font-size:20px;font-weight:600;margin:8px 0';
  const body = document.createElement('p');
  body.style.whiteSpace = 'pre-wrap';
  const hint = document.createElement('p');
  hint.style.cssText = 'font-size:12px;color:#6b7280';
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:20px;flex-wrap:wrap';
  const button = (label: string, action: () => void) => {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    element.style.cssText = 'border:1px solid #d1d5db;border-radius:6px;background:#f9fafb;padding:8px 12px;cursor:pointer;color:#111827';
    element.onclick = action;
    actions.append(element);
    return element;
  };
  let closed = false;
  let frame = 0;
  const save = (completed = false) => {
    try { localStorage.setItem(storageKey, JSON.stringify({ step: index, completed })); } catch { /* Optional persistence. */ }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    cancelAnimationFrame(frame);
    document.removeEventListener('keydown', onKeyDown, true);
    overlay.remove();
    if (previousFocus?.isConnected) previousFocus.focus();
    if (activeCleanup === close) activeCleanup = undefined;
  };
  button(tour.labels?.close || 'Close', close);
  const back = button(tour.labels?.back || 'Back', () => { index--; render(); });
  const next = button('', () => {
    if (index === tour.steps.length - 1) { save(true); close(); }
    else { index++; render(); }
  });
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); }
    if (event.key === 'Tab') {
      const buttons = Array.from(actions.querySelectorAll('button')).filter(element => !element.disabled);
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const offset = event.shiftKey ? -1 : 1;
      buttons[(current + offset + buttons.length) % buttons.length].focus();
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  function position() {
    const step = tour.steps[index];
    const target = step.target ? document.querySelector(`[data-tour="${step.target}"]`) : null;
    const rect = target?.getBoundingClientRect();
    const visible = rect && rect.width > 0 && rect.height > 0 && rect.bottom > 0
      && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
    hint.textContent = step.target && !visible
      ? (tour.labels?.missing || 'This control is not visible in the current view. You can continue or return to this step later.') : '';
    if (visible) {
      const top = Math.max(4, rect.top - 4);
      const left = Math.max(4, rect.left - 4);
      Object.assign(spotlight.style, { top: `${top}px`, left: `${left}px`, width: `${Math.min(innerWidth - left - 4, rect.width + 8)}px`, height: `${Math.min(innerHeight - top - 4, rect.height + 8)}px` });
      panel.style.left = `${Math.max(12, Math.min(left, innerWidth - panel.offsetWidth - 12))}px`;
      const below = rect.bottom + 12;
      panel.style.top = `${Math.max(12, Math.min(below + panel.offsetHeight < innerHeight ? below : rect.top - panel.offsetHeight - 12, innerHeight - panel.offsetHeight - 12))}px`;
    } else {
      Object.assign(spotlight.style, { top: '0', left: '0', width: '0', height: '0' });
      panel.style.left = `${Math.max(12, (innerWidth - panel.offsetWidth) / 2)}px`;
      panel.style.top = `${Math.max(12, (innerHeight - panel.offsetHeight) / 2)}px`;
    }
    frame = requestAnimationFrame(position);
  }
  function render() {
    const step = tour.steps[index];
    progress.textContent = `${index + 1} / ${tour.steps.length}`;
    heading.textContent = step.title;
    body.textContent = step.body;
    back.disabled = index === 0;
    next.textContent = index === tour.steps.length - 1 ? (tour.labels?.finish || 'Finish') : (tour.labels?.next || 'Next');
    save();
    next.focus();
  }
  panel.append(progress, heading, body, hint, actions);
  overlay.append(spotlight, panel);
  // Intercept pointer events outside the dialog, including the spotlight hole.
  overlay.style.pointerEvents = 'auto';
  document.body.append(overlay);
  document.addEventListener('keydown', onKeyDown, true);
  activeCleanup = close;
  render();
  position();
  return close;
}
