/**
 * Digital Twin — heads-up display (DOM only; no three.js).
 *
 *   createHud(root, { reducedMotion, coarsePointer }) → hud
 *
 *   hud.on(event, fn) → unsubscribe()
 *     'mode' (mode) · 'time' (hour) · 'play' (bool) · 'speed' (n) · 'fault' (kind)
 *     'clear' · 'zoom' (+1|-1) · 'reset' · 'explore' (bool) · 'close-card' · 'select' (id)
 *   hud.setState(state, layout)   DOM writes throttled to ~4 Hz
 *   hud.setMode(mode)             'live' | 'thermal' | 'airflow' | 'exploded'
 *   hud.showCard(desc | null, { x, y } | null)
 *                                 desc = sim.describe(id); x/y are CSS px from the
 *                                 stage's top-left. Docked at the bottom on small screens.
 *   hud.setLoading(fraction | null) · hud.setReady() · hud.setIntroProgress(p)
 *   hud.setInteractive(bool) · hud.toast(text, severity) · hud.destroy()
 *
 * Extras (not required by the contract): hud.setExploring(bool, emit?),
 * hud.setPlaying(bool), hud.setSpeed(n), hud.isExploring().
 *
 * The HUD keeps its own UI state (mode, play, speed, explore) and updates
 * immediately on input, then emits; listeners may echo back via setMode etc.
 */

const MODES = [
  { id: 'live', label: 'Live' },
  { id: 'thermal', label: 'Thermal' },
  { id: 'airflow', label: 'Airflow' },
  { id: 'exploded', label: 'Exploded' },
];

const SPEEDS = [1, 10, 60, 600];
const SPEED_HINT = { 1: 'real time', 10: '10 seconds per second', 60: '1 minute per second', 600: '10 minutes per second' };

const FAULTS = [
  { kind: 'vav-stuck', label: 'VAV stuck', hint: 'Damper fails shut · sunny zone' },
  { kind: 'chiller-trip', label: 'Chiller trip', hint: 'CH-1 trips · CH-2 takes lead' },
  { kind: 'fan-fail', label: 'Fan failure', hint: 'AHU-2 supply fan · L4–L6' },
  { kind: 'hot-day', label: 'Heat wave', hint: 'Outside air +12 °F' },
];

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const LEGENDS = {
  live: {
    title: 'Every service, occupant and alarm, as it runs.',
    items: [
      ['Supply air', 'sa'], ['Return air', 'ra'],
      ['Chilled water', 'chw'], ['Hot water', 'hw'],
      ['Condenser', 'cw', 'dash'], ['Alarm', 'alarm', 'dot'],
    ],
  },
  thermal: {
    title: 'Each zone tinted by temperature against its setpoint.',
    ramp: ['−3 °F', 'Setpoint', '+3 °F'],
    items: [['Alarm', 'alarm', 'dot']],
  },
  airflow: {
    title: 'Air paths only. Flow follows fan speed and stops when a fan does.',
    items: [['Supply air', 'sa'], ['Return air', 'ra', 'dash']],
  },
  exploded: {
    title: 'Levels pulled apart to show what serves what.',
    wide: true,
    items: [
      ['RF · AHU-1, AHU-2, CT-1', 'sa'],
      ['L4–L6 · served by AHU-2', 'sa'],
      ['L1–L3 · served by AHU-1', 'sa'],
      ['B1 · Chillers, HW plant, pumps', 'chw'],
    ],
  },
};

const ICON = {
  play: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4.8 2.6v10.8L13.2 8z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="3.6" y="2.6" width="3" height="10.8" rx="1" fill="currentColor"/><rect x="9.4" y="2.6" width="3" height="10.8" rx="1" fill="currentColor"/></svg>',
  plus: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/></svg>',
  minus: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/></svg>',
  reset: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><g stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"><circle cx="8" cy="8" r="4.2"/><path d="M8 1.2v2.6M8 12.2v2.6M1.2 8h2.6M12.2 8h2.6"/></g><circle cx="8" cy="8" r="1.2" fill="currentColor"/></svg>',
  warn: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><g stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round" fill="none"><path d="M8 2.2 14.6 13.6H1.4z"/><path d="M8 6.6v3.2M8 11.7v.1"/></g></svg>',
  caret: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4.5 10 8 6.5l3.5 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
  close: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/></svg>',
  move: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><g stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M8 1.6v12.8M1.6 8h12.8"/><path d="M6.2 3.4 8 1.6l1.8 1.8M6.2 12.6 8 14.4l1.8-1.8M3.4 6.2 1.6 8l1.8 1.8M12.6 6.2 14.4 8l-1.8 1.8"/></g></svg>',
  check: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3.4 8.4l3 3 6.2-6.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
  go: '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
};

/* ── tiny helpers ─────────────────────────────────────────────── */

let uid = 0;

function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) n.append(c);
  return n;
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smoothstep = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

function fixed(v, d = 1) {
  return finite(v) ? v.toFixed(d) : '—';
}
function int(v) {
  return finite(v) ? Math.round(v).toLocaleString('en-US') : '—';
}
function hhmm(h) {
  if (!finite(h)) return '--:--';
  const mins = Math.floor((((h % 24) + 24) % 24) * 60 + 1e-6) % 1440;
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

function setText(node, text) {
  const t = String(text);
  if (node.textContent !== t) node.textContent = t;
}

/* ── factory ──────────────────────────────────────────────────── */

export function createHud(root, { reducedMotion = false, coarsePointer = false } = {}) {
  const id = `thud${++uid}`;
  const listeners = new Map();
  const timers = new Set();
  // docked layout (KPI strip + bottom sheet) up to 1100 px: the desktop KPI row needs ~1100 px
  const docked = window.matchMedia('(max-width: 1099.98px)');

  const ui = {
    mode: 'live',
    playing: true,
    speed: 60,
    exploring: false,
    expanded: false,
    ready: false,
    interactive: true,
    introVisible: false,
    menuOpen: false,
    dragging: false,
    lastUserTime: 0,
    cardOpen: false,
    cardKey: '',
    destroyed: false,
  };

  const emit = (event, value) => {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(value);
      } catch (err) {
        console.error(`[twin hud] '${event}' listener failed`, err);
      }
    }
  };

  const later = (fn, ms) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
    return t;
  };

  /* ── DOM ─────────────────────────────────────────────────── */

  root.replaceChildren();
  root.classList.add('thud-root');
  root.classList.toggle('is-coarse', !!coarsePointer);
  root.dataset.mode = ui.mode;

  // Loading pill
  const loadPct = el('span', { class: 'thud-load__pct', 'aria-hidden': 'true', text: '0%' });
  const loadBar = el('i');
  const load = el(
    'div',
    { class: 'thud-panel thud-load', role: 'status' },
    el('div', { class: 'thud-load__row' }, el('span', { text: 'Loading live model' }), loadPct),
    el('div', { class: 'thud-load__bar', 'aria-hidden': 'true' }, loadBar),
  );

  // Status: clock + KPIs
  const clockDay = el('span', { class: 'thud-clock__day', text: '—' });
  const clockTime = el('span', { text: '--:--' });
  const occChip = el('span', { class: 'thud-occ', text: '—' });

  const kpis = {};
  const kpi = (key, label, unit) => {
    const v = el('span', { text: '—' });
    const u = el('span', { class: 'thud-kpi__u', text: unit });
    const row = el('dd', { class: 'thud-kpi__v' }, v, u);
    const s = el('dd', { class: 'thud-kpi__s', text: '\u00a0' });
    const wrap = el('div', { class: 'thud-kpi', 'data-kpi': key }, el('dt', { text: label }), row, s);
    kpis[key] = { wrap, row, v, u, s };
    return wrap;
  };

  const sparkLine = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  const sparkArea = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  sparkArea.setAttribute('class', 'thud-spark__area');
  const sparkSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  sparkSvg.setAttribute('class', 'thud-spark');
  sparkSvg.setAttribute('viewBox', '0 0 64 14');
  sparkSvg.setAttribute('preserveAspectRatio', 'none');
  sparkSvg.setAttribute('aria-hidden', 'true');
  sparkSvg.append(sparkArea, sparkLine);

  const kpiList = el(
    'dl',
    { class: 'thud-kpis' },
    kpi('oat', 'Outside air', '°F'),
    kpi('kw', 'Demand', 'kW'),
    kpi('chws', 'CHW supply', '°F'),
    kpi('occ', 'Occupancy', '%'),
    kpi('comfort', 'Comfort', ''),
    kpi('alarms', 'Alarms', ''),
  );
  kpis.kw.row.append(sparkSvg);

  const status = el(
    'section',
    { class: 'thud-panel thud-status', 'aria-label': 'Building status' },
    el(
      'div',
      { class: 'thud-status__head' },
      el('span', { class: 'thud-live' }, el('span', { class: 'thud-live__dot', 'aria-hidden': 'true' }), 'Live sim'),
      el('span', { class: 'thud-clock thud-num' }, clockDay, ' ', clockTime),
      occChip,
    ),
    kpiList,
  );

  // Alarms
  const alarmCount = el('span', { class: 'thud-alarms__count thud-num', text: '0' });
  const alarmList = el('ul');
  const alarms = el(
    'section',
    { class: 'thud-panel thud-alarms', 'aria-label': 'Active alarms', hidden: true },
    el('div', { class: 'thud-alarms__head' }, el('span', { text: 'Active alarms' }), alarmCount),
    alarmList,
  );

  // Modes + legend + hint
  const modeBtns = MODES.map((m) =>
    el('button', { type: 'button', 'data-mode': m.id, 'aria-pressed': String(m.id === ui.mode), text: m.label }),
  );
  const modes = el('div', { class: 'thud-panel thud-modes' }, el('div', { class: 'thud-seg', role: 'group', 'aria-label': 'View mode' }, modeBtns));
  const legend = el('section', { class: 'thud-panel thud-legend', 'aria-label': 'Legend' });
  const hint = el('p', {
    class: 'thud-hint',
    text: coarsePointer ? 'Tap any zone · Explore 3D to orbit' : 'Drag to orbit · Click any zone',
  });
  // Keyboard / screen-reader route to every card (the canvas itself isn't focusable)
  const inspectSel = el('select', { class: 'thud-inspect__sel', id: `${id}-inspect`, 'aria-label': 'Inspect a machine or a floor on the model' });
  const inspect = el(
    'div',
    { class: 'thud-panel thud-inspect' },
    el('label', { class: 'thud-inspect__lbl', for: `${id}-inspect`, 'aria-hidden': 'true', text: 'Inspect' }),
    inspectSel,
  );

  // Dock: play · time · speed · faults · clear
  const playBtn = el('button', { type: 'button', class: 'thud-play', 'aria-label': 'Pause simulation', html: ICON.pause });
  const range = el('input', {
    type: 'range',
    class: 'thud-range',
    min: '0',
    max: '24',
    step: '0.25',
    value: '9.5',
    'aria-label': 'Time of day',
    'aria-valuetext': '09:30',
  });
  const timeClock = el('span', { class: 'thud-time__clock', text: '--:--' });
  const timeSub = el('span', { class: 'thud-time__sub', text: 'Sim time' });
  const time = el(
    'div',
    { class: 'thud-time' },
    el('div', { class: 'thud-time__readout', 'aria-hidden': 'true' }, timeClock, timeSub),
    el(
      'div',
      { class: 'thud-time__track' },
      el('span', { class: 'thud-time__occ', title: 'Occupied 06:00–19:00', 'aria-hidden': 'true' }),
      range,
      el('div', { class: 'thud-time__ticks', 'aria-hidden': 'true' }, ['00', '06', '12', '18', '24'].map((t) => el('span', { text: t }))),
    ),
  );
  const speedBtns = SPEEDS.map((n) =>
    el('button', {
      type: 'button',
      'data-speed': n,
      'aria-pressed': String(n === ui.speed),
      'aria-label': `${n}× speed, ${SPEED_HINT[n]}`,
      text: `${n}×`,
    }),
  );
  const speed = el('div', { class: 'thud-seg thud-seg--speed', role: 'group', 'aria-label': 'Simulation speed' }, speedBtns);

  const menuId = `${id}-faults`;
  const faultBtn = el('button', {
    type: 'button',
    class: 'thud-btn thud-fault__btn',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    'aria-controls': menuId,
    html: `${ICON.warn}<span><span class="thud-wide">Inject </span>fault</span>${ICON.caret}`,
  });
  const faultItems = FAULTS.map((f) =>
    el(
      'button',
      { type: 'button', role: 'menuitem', tabindex: '-1', 'data-fault': f.kind },
      el('span', { class: 'thud-menu__dot', 'aria-hidden': 'true' }),
      el('span', { class: 'thud-menu__label', text: f.label }),
      el('span', { class: 'thud-menu__hint', text: f.hint }),
    ),
  );
  const menu = el(
    'div',
    { class: 'thud-panel thud-menu', id: menuId, role: 'menu', 'aria-label': 'Inject a fault', hidden: true },
    el('p', { class: 'thud-menu__title', 'aria-hidden': 'true', text: 'Inject a fault' }),
    faultItems,
  );
  const clearBtn = el('button', { type: 'button', class: 'thud-btn thud-clear', 'aria-label': 'Clear all faults', title: 'Clear all faults', html: `${ICON.check}<span>Clear</span>` });
  const dock = el(
    'div',
    { class: 'thud-panel thud-dock', role: 'group', 'aria-label': 'Simulation controls' },
    playBtn,
    time,
    el('span', { class: 'thud-sep', 'aria-hidden': 'true' }),
    speed,
    el('span', { class: 'thud-sep', 'aria-hidden': 'true' }),
    el('div', { class: 'thud-fault' }, faultBtn),
    clearBtn,
  );

  // Camera cluster (+ explore on touch, + "more" toggle on small screens)
  const iconBtn = (icon, label, extra = {}) => el('button', { type: 'button', class: 'thud-icon-btn', 'aria-label': label, title: label, html: ICON[icon], ...extra });
  const exploreBtn = el('button', { type: 'button', class: 'thud-btn thud-explore', 'aria-label': 'Explore 3D: drag to orbit the model', html: `${ICON.move}<span>Explore 3D</span>` });
  const zoomInBtn = iconBtn('plus', 'Zoom in', { class: 'thud-icon-btn thud-zoom' });
  const zoomOutBtn = iconBtn('minus', 'Zoom out', { class: 'thud-icon-btn thud-zoom' });
  // On phones the fault menu gets a labelled button of its own (zoom is a pinch there)
  const faultQuick = el('button', {
    type: 'button',
    class: 'thud-btn thud-faultq',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    'aria-controls': menuId,
    html: `${ICON.warn}<span>Faults</span>`,
  });
  const resetBtn = iconBtn('reset', 'Reset view');
  const moreBtn = el('button', {
    type: 'button',
    class: 'thud-icon-btn thud-more',
    'aria-expanded': 'false',
    'aria-label': 'More controls',
    html: ICON.caret,
  });
  const view = el(
    'div',
    { class: 'thud-panel thud-view', role: 'group', 'aria-label': 'Camera' },
    exploreBtn,
    faultQuick,
    zoomInBtn,
    zoomOutBtn,
    el('span', { class: 'thud-view__sep', 'aria-hidden': 'true' }),
    resetBtn,
    moreBtn,
  );

  // Info card
  const cardTitleId = `${id}-card-title`;
  const cardKindText = el('span');
  const cardStatus = el('span', { class: 'thud-card__status' });
  const cardKind = el('p', { class: 'thud-card__kind' }, cardKindText, cardStatus);
  const cardTitle = el('h3', { class: 'thud-card__title', id: cardTitleId });
  const cardSub = el('p', { class: 'thud-card__sub' });
  const cardClose = el('button', { type: 'button', class: 'thud-icon-btn thud-card__close', 'aria-label': 'Close details', html: ICON.close });
  const cardRows = el('dl', { class: 'thud-card__rows' });
  const card = el(
    'section',
    { class: 'thud-panel thud-card', role: 'region', 'aria-labelledby': cardTitleId, 'aria-hidden': 'true' },
    el('div', { class: 'thud-card__head' }, cardKind, cardTitle, cardSub, cardClose),
    cardRows,
  );

  // Toasts (announced politely)
  const toasts = el('div', { class: 'thud-toasts', role: 'status', 'aria-live': 'polite' });

  const layer = el(
    'div',
    { class: 'thud-layer' },
    el('div', { class: 'thud-left' }, status, alarms),
    el('div', { class: 'thud-sheet' }, el('div', { class: 'thud-right' }, modes, legend, inspect, hint), el('div', { class: 'thud-bottom' }, dock), view),
  );

  const leftCol = layer.querySelector('.thud-left');
  const rightCol = layer.querySelector('.thud-right');
  const sheet = layer.querySelector('.thud-sheet');
  root.append(load, layer, card, menu, toasts);

  /* ── UI state setters ───────────────────────────────────── */

  function renderLegend(mode) {
    const spec = LEGENDS[mode] || LEGENDS.live;
    const children = [el('p', { class: 'thud-legend__title', text: spec.title })];
    if (spec.ramp) {
      children.push(el('div', { class: 'thud-ramp', 'aria-hidden': 'true' }));
      children.push(el('div', { class: 'thud-ramp-labels' }, spec.ramp.map((t) => el('span', { text: t }))));
    }
    if (spec.items?.length) {
      children.push(
        el(
          'ul',
          { class: `thud-legend__list${spec.wide ? ' thud-legend__list--wide' : ''}` },
          spec.items.map(([label, key, shape]) =>
            el(
              'li',
              {},
              el('span', {
                class: `thud-sw${shape ? ` thud-sw--${shape}` : ''}`,
                style: `--c: var(--twin-${key})`,
                'aria-hidden': 'true',
              }),
              label,
            ),
          ),
        ),
      );
    }
    legend.replaceChildren(...children);
  }

  function setMode(mode) {
    if (!MODES.some((m) => m.id === mode)) return;
    if (mode === ui.mode && legend.childElementCount) return; // cheap when echoed back
    ui.mode = mode;
    root.dataset.mode = mode;
    for (const b of modeBtns) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    renderLegend(mode);
    // a card docked under the legend follows the legend's new height
    if (ui.cardOpen && ui.cardDocked) placeCard(null);
  }

  function setPlaying(on) {
    if (!!on === ui.playing && playBtn.firstElementChild) return;
    ui.playing = !!on;
    playBtn.innerHTML = ui.playing ? ICON.pause : ICON.play;
    playBtn.setAttribute('aria-label', ui.playing ? 'Pause simulation' : 'Play simulation');
    root.classList.toggle('is-paused', !ui.playing);
  }

  function setSpeed(n) {
    if (!SPEEDS.includes(n)) return;
    ui.speed = n;
    for (const b of speedBtns) b.setAttribute('aria-pressed', String(+b.dataset.speed === n));
  }

  function setExploring(on, emitIt = false) {
    on = !!on;
    if (ui.exploring === on) return;
    ui.exploring = on;
    root.classList.toggle('is-exploring', on);
    // the name carries the state ("Done exploring…"): no aria-pressed, so no double negative
    exploreBtn.classList.toggle('thud-btn--accent', on);
    exploreBtn.innerHTML = on ? `${ICON.check}<span>Done</span>` : `${ICON.move}<span>Explore 3D</span>`;
    exploreBtn.setAttribute('aria-label', on ? 'Done exploring, return to scrolling' : 'Explore 3D: drag to orbit the model');
    if (emitIt) emit('explore', on);
  }

  function setExpanded(on) {
    ui.expanded = !!on;
    root.classList.toggle('is-expanded', ui.expanded);
    moreBtn.setAttribute('aria-expanded', String(ui.expanded));
    moreBtn.setAttribute('aria-label', ui.expanded ? 'Fewer controls' : 'More controls');
    syncSheetWheel();
  }

  // Lenis takes every wheel event for the page; panels that can scroll opt out
  // so a wheel over them scrolls the panel first (then the page, natively).
  function syncSheetWheel() {
    if (!sheet || ui.destroyed) return;
    sheet.toggleAttribute('data-lenis-prevent-wheel', docked.matches && sheet.scrollHeight > sheet.clientHeight + 1);
  }
  function syncCardWheel() {
    card.toggleAttribute('data-lenis-prevent-wheel', ui.cardOpen && card.scrollHeight > card.clientHeight + 1);
  }

  /* ── fault menu ─────────────────────────────────────────── */

  let menuOpener = faultBtn;
  function openMenu(opener = faultBtn) {
    ui.menuOpen = true;
    menuOpener = opener;
    if (!docked.matches) {
      const rr = root.getBoundingClientRect();
      const br = faultBtn.getBoundingClientRect();
      menu.style.setProperty('--mx', `${Math.round(rr.right - br.right)}px`);
      menu.style.setProperty('--my', `${Math.round(rr.bottom - br.top + 12)}px`);
    }
    menu.hidden = false;
    opener.setAttribute('aria-expanded', 'true');
    faultItems[0]?.focus({ preventScroll: true });
  }
  function closeMenu(returnFocus = false) {
    if (!ui.menuOpen) return;
    ui.menuOpen = false;
    menu.hidden = true;
    faultBtn.setAttribute('aria-expanded', 'false');
    faultQuick.setAttribute('aria-expanded', 'false');
    if (returnFocus) menuOpener.focus({ preventScroll: true });
  }

  /* ── events ─────────────────────────────────────────────── */

  const on = (node, type, fn, opts) => node.addEventListener(type, fn, opts);

  for (const b of modeBtns) {
    on(b, 'click', () => {
      setMode(b.dataset.mode);
      emit('mode', b.dataset.mode);
    });
  }
  for (const b of speedBtns) {
    on(b, 'click', () => {
      const n = +b.dataset.speed;
      setSpeed(n);
      emit('speed', n);
    });
  }
  on(playBtn, 'click', () => {
    setPlaying(!ui.playing);
    emit('play', ui.playing);
  });

  // Time scrubber: emit at most once per frame while dragging
  let timeRaf = 0;
  const flushTime = () => {
    timeRaf = 0;
    emit('time', +range.value);
  };
  const userTime = () => {
    ui.lastUserTime = performance.now();
    const h = +range.value;
    range.setAttribute('aria-valuetext', hhmm(h));
    setText(timeClock, hhmm(h));
  };
  on(range, 'input', () => {
    userTime();
    if (!timeRaf) timeRaf = requestAnimationFrame(flushTime);
  });
  on(range, 'change', () => {
    userTime();
    if (timeRaf) cancelAnimationFrame(timeRaf);
    flushTime();
  });
  on(range, 'pointerdown', () => {
    ui.dragging = true;
  });
  const endDrag = () => {
    ui.dragging = false;
    ui.lastUserTime = performance.now();
  };
  on(range, 'pointerup', endDrag);
  on(range, 'pointercancel', endDrag);
  on(range, 'blur', endDrag);

  for (const opener of [faultBtn, faultQuick]) {
    on(opener, 'click', () => (ui.menuOpen ? closeMenu(true) : openMenu(opener)));
    on(opener, 'keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        openMenu(opener);
        if (e.key === 'ArrowUp') faultItems[faultItems.length - 1]?.focus({ preventScroll: true });
      }
    });
  }
  on(menu, 'keydown', (e) => {
    const i = faultItems.indexOf(document.activeElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = (i + 1) % faultItems.length;
    else if (e.key === 'ArrowUp') next = (i - 1 + faultItems.length) % faultItems.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = faultItems.length - 1;
    else if (e.key === 'Tab') {
      // menu-button pattern: focus carries on from the button that opened the menu
      e.preventDefault();
      const opener = menuOpener;
      closeMenu(false);
      (e.shiftKey ? opener : opener === faultBtn ? clearBtn : resetBtn).focus({ preventScroll: true });
      return;
    }
    if (next >= 0) {
      e.preventDefault();
      faultItems[next].focus({ preventScroll: true });
    }
  });
  for (const b of faultItems) {
    on(b, 'click', () => {
      closeMenu(true);
      emit('fault', b.dataset.fault);
    });
  }
  on(clearBtn, 'click', () => emit('clear'));

  on(zoomInBtn, 'click', () => emit('zoom', 1));
  on(zoomOutBtn, 'click', () => emit('zoom', -1));
  on(resetBtn, 'click', () => emit('reset'));
  on(exploreBtn, 'click', () => {
    const next = !ui.exploring;
    setExploring(next, true);
    if (next && !ui.exploreHinted) {
      ui.exploreHinted = true;
      toast('Drag to orbit · pinch to zoom · tap Done to scroll again', 'info');
    }
  });
  on(moreBtn, 'click', () => setExpanded(!ui.expanded));

  on(cardClose, 'click', () => {
    hideCard(true);
    emit('close-card');
  });
  on(inspectSel, 'change', () => {
    if (inspectSel.value) emit('select', inspectSel.value);
  });

  on(alarmList, 'click', (e) => {
    const b = e.target.closest('[data-alarm-target]');
    if (b) emit('select', b.dataset.alarmTarget);
  });

  const onStage = () => {
    const r = root.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight;
  };
  const onDocKey = (e) => {
    if (e.key !== 'Escape' || !onStage()) return;
    if (ui.menuOpen) {
      e.preventDefault();
      closeMenu(true);
    } else if (ui.cardOpen) {
      hideCard(true);
      emit('close-card');
    } else if (ui.exploring) {
      setExploring(false, true);
    }
  };
  const onDocPointer = (e) => {
    if (ui.menuOpen && !menu.contains(e.target) && !faultBtn.contains(e.target) && !faultQuick.contains(e.target)) closeMenu(false);
  };
  document.addEventListener('keydown', onDocKey);
  document.addEventListener('pointerdown', onDocPointer, true);

  /* ── state → DOM (throttled) ────────────────────────────── */

  let latest = null;
  let layoutRef = null;
  let names = new Map();
  let lastWrite = 0;
  let writeTimer = 0;
  let alarmSig = '';
  let faultSig = '';
  const knownAlarms = new Set();
  let alarmsSeeded = false;
  let hadAlarms = false;
  const spark = { pts: [], lastT: null };

  function indexLayout(layout) {
    if (!layout || layout === layoutRef) return;
    layoutRef = layout;
    names = new Map();
    for (const z of layout.zones || []) {
      if (z?.id) names.set(z.id, z.name || z.id);
      if (z?.vav) names.set(z.vav, `${z.vav} · ${z.name || z.id}`);
    }
    // "Air Handler AHU-2" → "Air handler" (the id is already shown next to it)
    const short = (q) => {
      let n = String(q.name || '').trim();
      if (n.endsWith(q.id)) n = n.slice(0, -q.id.length).trim();
      return n.split(/\s+/).filter(Boolean).map((w, i) => (i === 0 || /^[A-Z0-9]{2,}$/.test(w) ? w : w.toLowerCase())).join(' ');
    };
    const eqOpts = [];
    for (const q of layout.equipment || []) {
      if (!q?.id) continue;
      const nm = short(q);
      names.set(q.id, nm || q.id);
      eqOpts.push(el('option', { value: q.id, text: nm ? `${q.id} · ${nm}` : q.id }));
    }
    const lvOpts = [...(layout.levels || [])].reverse().filter((l) => l?.id).map((l) => el('option', { value: l.id, text: l.name || l.id }));
    inspectSel.replaceChildren(
      el('option', { value: '', text: 'Choose…' }),
      el('option', { value: 'building', text: 'Whole building' }),
      el('optgroup', { label: 'Equipment' }, eqOpts),
      el('optgroup', { label: 'Floors' }, lvOpts),
    );
  }

  function setState(state, layout) {
    if (ui.destroyed || !state) return;
    latest = state;
    if (layout) indexLayout(layout);
    const now = performance.now();
    const wait = 250 - (now - lastWrite);
    if (wait <= 0) {
      if (writeTimer) {
        clearTimeout(writeTimer);
        timers.delete(writeTimer);
        writeTimer = 0;
      }
      write();
    } else if (!writeTimer) {
      writeTimer = later(() => {
        writeTimer = 0;
        write();
      }, wait);
    }
  }

  function write() {
    lastWrite = performance.now();
    const s = latest;
    if (!s) return;
    try {
      writeClock(s);
      writeKpis(s);
      writeAlarms(s);
      writeFaults(s);
    } catch (err) {
      // A malformed field must never break the page; skip this frame.
      if (import.meta.env?.DEV) console.warn('[twin hud] state write skipped', err);
    }
  }

  function writeClock(s) {
    const hour = finite(s.hour) ? s.hour : 0;
    const day = finite(s.day) ? Math.max(0, Math.floor(s.day)) : 0;
    const dayName = DAYS[day % 7];
    setText(clockDay, dayName);
    setText(clockTime, hhmm(hour));
    setText(occChip, s.occupiedMode ? 'Occupied' : 'Unoccupied');
    occChip.classList.toggle('is-on', !!s.occupiedMode);

    const userBusy = ui.dragging || performance.now() - ui.lastUserTime < 700;
    if (!userBusy) {
      const v = String(Math.round(clamp(hour, 0, 24) * 4) / 4);
      if (range.value !== v) range.value = v;
      range.setAttribute('aria-valuetext', hhmm(hour));
      setText(timeClock, hhmm(hour));
    }
    setText(timeSub, `${dayName} · ${s.occupiedMode ? 'Occ' : 'Unocc'}`);
  }

  function writeKpis(s) {
    // Outside air
    setText(kpis.oat.v, fixed(s.oat, 1));
    setText(kpis.oat.s, finite(s.oah) ? `${Math.round(s.oah)}% RH` : '\u00a0');
    kpis.oat.wrap.classList.toggle('is-warn', (s.faults || []).includes('hot-day'));

    // Demand + sparkline
    setText(kpis.kw.v, int(s.kw));
    setText(kpis.kw.s, finite(s.kwh) ? `${int(s.kwh)} kWh today` : '\u00a0');
    sampleSpark(s);

    // Chilled water supply: the plant's common supply header; failing that,
    // the mean of running chillers (a chiller that is still starting reads
    // its warm idle evaporator, so it must not stand in for the header)
    const plant = s.plant || {};
    const chillers = Object.entries(plant.chillers || {});
    const running = chillers.filter(([, c]) => c && c.on);
    const src = running.length ? running : chillers;
    const vals = src.map(([, c]) => c?.chws).filter(finite);
    const chws = finite(plant.chws) ? plant.chws : vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN;
    setText(kpis.chws.v, fixed(chws, 1));
    const sp = finite(plant.chwsSp) ? `SP ${plant.chwsSp.toFixed(1)}` : '';
    const lead = running.length ? running.map(([cid]) => cid).join('+') : 'plant off';
    setText(kpis.chws.s, [sp, lead].filter(Boolean).join(' · ') || '\u00a0');
    // Only a running plant can miss its setpoint; with the plant off overnight the header just drifts
    kpis.chws.wrap.classList.toggle('is-warn', running.length > 0 && finite(chws) && finite(plant.chwsSp) && chws > plant.chwsSp + 3);

    // Occupancy
    setText(kpis.occ.v, finite(s.occupancy) ? String(Math.round(clamp(s.occupancy, 0, 1) * 100)) : '—');
    setText(kpis.occ.s, s.occupiedMode ? 'Occupied hours' : 'Setback');

    // Comfort: zones in band
    const zones = Object.values(s.zones || {});
    if (zones.length) {
      const ok = zones.filter((z) => z && z.status === 'ok').length;
      setText(kpis.comfort.v, String(ok));
      setText(kpis.comfort.u, `/ ${zones.length}`);
      setText(kpis.comfort.s, 'zones in band');
      kpis.comfort.wrap.classList.toggle('is-warn', ok < zones.length * 0.85);
    }

    // Alarms
    const list = Array.isArray(s.alarms) ? s.alarms : [];
    const high = list.filter((a) => a?.severity === 'high').length;
    setText(kpis.alarms.v, String(list.length));
    setText(kpis.alarms.s, list.length ? (high ? `${high} high` : 'Attention') : 'All clear');
    kpis.alarms.wrap.classList.toggle('is-alarm', high > 0);
    kpis.alarms.wrap.classList.toggle('is-warn', list.length > 0 && high === 0);
  }

  function sampleSpark(s) {
    if (!finite(s.kw)) return;
    const t = (finite(s.day) ? s.day : 0) * 24 + (finite(s.hour) ? s.hour : 0);
    const last = spark.lastT;
    if (last == null || t < last - 1e-6 || t - last > 3) {
      spark.pts = [s.kw];
      spark.lastT = t;
    } else if (t - last >= 0.1) {
      spark.pts.push(s.kw);
      if (spark.pts.length > 40) spark.pts.shift();
      spark.lastT = t;
    } else {
      return;
    }
    const pts = spark.pts;
    sparkSvg.classList.toggle('is-on', pts.length >= 4);
    if (pts.length < 2) {
      sparkLine.setAttribute('d', '');
      sparkArea.setAttribute('d', '');
      return;
    }
    let lo = Math.min(...pts);
    let hi = Math.max(...pts);
    if (hi - lo < 1) {
      hi += 0.5;
      lo -= 0.5;
    }
    const step = 64 / 39;
    const x0 = 64 - (pts.length - 1) * step;
    const coords = pts.map((v, i) => `${(x0 + i * step).toFixed(1)},${(13 - ((v - lo) / (hi - lo)) * 12).toFixed(1)}`);
    sparkLine.setAttribute('d', `M${coords.join('L')}`);
    sparkArea.setAttribute('d', `M${x0.toFixed(1)},14L${coords.join('L')}L64,14Z`);
  }

  // sim alarms carry `sinceLabel` ("Tue 14:32"); `since` itself is sim-seconds
  function fmtSince(a) {
    const label = typeof a.sinceLabel === 'string' ? a.sinceLabel : typeof a.since === 'string' ? a.since : '';
    if (!label) return '';
    const time = label.match(/\d{1,2}:\d{2}/)?.[0];
    return `since ${time || label}`;
  }

  function writeAlarms(s) {
    const list = Array.isArray(s.alarms) ? s.alarms.filter(Boolean) : [];
    const order = { high: 0, medium: 1, low: 2 };
    const sorted = [...list].sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
    const top = sorted.slice(0, 3);
    const sig = `${list.length}#${top.map((a) => `${a.id}:${a.severity}:${a.text}`).join('|')}`;

    // Announce new alarms (only once the HUD is on screen)
    const ids = new Set(list.map((a) => a.id ?? a.text));
    const visible = ui.ready && ui.introVisible;
    for (const a of sorted) {
      const key = a.id ?? a.text;
      if (knownAlarms.has(key)) continue;
      knownAlarms.add(key);
      if (alarmsSeeded && visible) toast(a.text || 'New alarm', a.severity === 'high' ? 'high' : 'medium');
    }
    for (const key of [...knownAlarms]) if (!ids.has(key)) knownAlarms.delete(key);
    if (hadAlarms && !list.length && visible) toast('All alarms cleared', 'ok');
    hadAlarms = list.length > 0;
    alarmsSeeded = true;

    if (sig === alarmSig) return;
    alarmSig = sig;
    alarms.hidden = list.length === 0;
    root.classList.toggle('has-alarms', list.length > 0);
    setText(alarmCount, String(list.length));
    const focusedTarget = document.activeElement?.closest?.('[data-alarm-target]')?.dataset.alarmTarget;
    alarmList.replaceChildren(
      ...top.map((a) => {
        const target = a.target || a.id || '';
        const name = names.get(target);
        const where = !name || name === target ? target : name.startsWith(target) ? name : `${target} · ${name}`;
        const meta = [where, fmtSince(a)].filter(Boolean).join(' · ');
        return el(
          'li',
          {},
          el(
            'button',
            {
              type: 'button',
              class: 'thud-alarm',
              'data-sev': a.severity || 'high',
              'data-alarm-target': target,
              'aria-label': `${a.severity || 'high'} alarm: ${a.text || ''}. ${meta}. Show on the model.`,
            },
            el('span', { class: 'thud-alarm__dot', 'aria-hidden': 'true' }),
            el('span', {}, el('span', { class: 'thud-alarm__text', text: a.text || 'Alarm' }), el('span', { class: 'thud-alarm__meta', text: meta })),
            el('span', { class: 'thud-alarm__go', 'aria-hidden': 'true', html: ICON.go }),
          ),
        );
      }),
    );
    if (focusedTarget) alarmList.querySelector(`[data-alarm-target="${CSS.escape(focusedTarget)}"]`)?.focus({ preventScroll: true });
  }

  function writeFaults(s) {
    const faults = Array.isArray(s.faults) ? s.faults : [];
    const sig = faults.join(',');
    if (sig === faultSig) return;
    faultSig = sig;
    for (const b of faultItems) {
      const active = faults.includes(b.dataset.fault);
      b.classList.toggle('is-active', active);
      const f = FAULTS.find((x) => x.kind === b.dataset.fault);
      b.setAttribute('aria-label', `${f.label}${active ? ' (active)' : ''}: ${f.hint}`);
    }
  }

  /* ── info card ──────────────────────────────────────────── */

  function renderCard(desc) {
    setText(cardKindText, desc.kind || '');
    const st = typeof desc.status === 'string' ? desc.status : '';
    setText(cardStatus, st);
    cardStatus.hidden = !st;
    cardStatus.dataset.status = st;
    setText(cardTitle, desc.title || '');
    setText(cardSub, desc.subtitle || '');
    cardSub.hidden = !desc.subtitle;
    const rows = Array.isArray(desc.rows) ? desc.rows : [];
    const key = `${desc.title}|${rows.map((r) => r?.[0]).join('|')}`;
    if (key !== ui.cardKey || cardRows.children.length !== rows.length * 2) {
      ui.cardKey = key;
      cardRows.replaceChildren(
        ...rows.flatMap((r) => {
          const dt = el('dt');
          const dd = el('dd', {}, el('span', { class: 'thud-num' }), el('span', { class: 'thud-u' }), el('span', { class: 'thud-st', 'aria-hidden': 'true' }));
          return [dt, dd];
        }),
      );
    }
    rows.forEach((r, i) => {
      const [label, value, unit, st] = Array.isArray(r) ? r : [];
      const dt = cardRows.children[i * 2];
      const dd = cardRows.children[i * 2 + 1];
      setText(dt, label ?? '');
      // Long prose values (an alarm sentence, "Served by …") get their own full-width line
      const wide = typeof value === 'string' && value.length > 20;
      dt.classList.toggle('is-wide', wide);
      dd.classList.toggle('is-wide', wide);
      setText(dd.children[0], value ?? '—');
      setText(dd.children[1], unit ?? '');
      dd.children[1].hidden = !unit;
      if (st) dd.dataset.status = st;
      else delete dd.dataset.status;
      dd.children[2].hidden = !st;
    });
  }

  function placeCard(pos) {
    if (docked.matches) {
      card.style.removeProperty('--x');
      card.style.removeProperty('--y');
      card.style.maxHeight = '';
      return;
    }
    const W = root.clientWidth;
    const H = root.clientHeight;
    const topLimit = 76; // under the site header
    const bottomLimit = H - 92; // above the dock
    // docked under the mode/legend column: cap the height to the room there (it scrolls)
    const rr0 = root.getBoundingClientRect();
    const colBottom = rightCol ? rightCol.getBoundingClientRect().bottom - rr0.top + 12 : topLimit;
    const room = bottomLimit - colBottom;
    // not enough room under the column (short windows): drop just under the mode
    // switcher instead, over the legend, so modes, KPIs and alarms stay usable
    const modesBottom = modes.getBoundingClientRect().bottom - rr0.top + 12;
    const tight = !pos && room < 300;
    card.style.maxHeight = !pos ? `${Math.round(tight ? bottomLimit - modesBottom : room)}px` : '';
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    let x;
    let y;
    let top = topLimit;
    if (pos && finite(pos.x) && finite(pos.y)) {
      x = pos.x + 20;
      if (x + cw > W - 72) x = pos.x - 20 - cw;
      y = pos.y - ch * 0.3;
      // never over the status column (top-left): go below it, or to the other side of the click
      if (leftCol) {
        const rr = root.getBoundingClientRect();
        const lr = leftCol.getBoundingClientRect();
        const lRight = lr.right - rr.left + 8;
        const lBottom = lr.bottom - rr.top + 12;
        if (x < lRight && y < lBottom) {
          const alt = pos.x + 20;
          if (alt >= lRight && alt + cw <= W - 12) x = alt;
          else top = Math.max(topLimit, lBottom);
        }
      }
    } else {
      // Docked right, under the mode/legend column and left of the camera cluster
      x = W - cw - 92;
      y = tight ? modesBottom : Math.max(colBottom, (H - ch) / 2);
    }
    x = clamp(x, 12, Math.max(12, W - cw - 12));
    y = clamp(y, top, Math.max(top, bottomLimit - ch));
    card.style.setProperty('--x', `${Math.round(x)}px`);
    card.style.setProperty('--y', `${Math.round(y)}px`);
  }

  function showCard(desc, pos) {
    if (ui.destroyed) return;
    if (!desc) {
      hideCard();
      return;
    }
    renderCard(desc);
    const wasOpen = ui.cardOpen;
    if (pos || !wasOpen) {
      placeCard(pos);
      ui.cardDocked = !pos;
    }
    if (!wasOpen) {
      // remember where focus came from, to hand it back when the visitor closes the card
      const a = document.activeElement;
      cardOpener = a && a !== document.body && root.contains(a) && !card.contains(a) ? a : null;
      cardOpenerAlarm = cardOpener?.dataset?.alarmTarget || '';
      ui.cardOpen = true;
      card.classList.add('is-open');
      card.setAttribute('aria-hidden', 'false');
      root.classList.add('has-card');
      closeMenu(false);
    }
    syncCardWheel();
  }

  let cardOpener = null;
  let cardOpenerAlarm = '';
  const shown = (n) => !!n && n.isConnected && n.offsetParent !== null;
  /** restoreFocus: the visitor closed it (button / Escape), so focus goes back where it came from. */
  function hideCard(restoreFocus = false) {
    if (!ui.cardOpen) return;
    ui.cardOpen = false;
    ui.cardKey = '';
    card.classList.remove('is-open');
    card.setAttribute('aria-hidden', 'true');
    root.classList.remove('has-card');
    syncCardWheel();
    if (card.contains(document.activeElement)) {
      let back = null;
      if (restoreFocus) {
        const alarmBtn = cardOpenerAlarm ? alarmList.querySelector(`[data-alarm-target="${CSS.escape(cardOpenerAlarm)}"]`) : null;
        back = [cardOpener, alarmBtn, faultBtn, faultQuick, modeBtns[0]].find(shown) || null;
      }
      if (back) back.focus({ preventScroll: true });
      else document.activeElement.blur();
    }
    cardOpener = null;
    cardOpenerAlarm = '';
  }

  /* ── toasts ─────────────────────────────────────────────── */

  // On small screens toasts sit just under the KPI strip (and alarm pill).
  function placeToasts() {
    if (ui.destroyed) return;
    if (docked.matches && leftCol) toasts.style.top = `${Math.round(leftCol.offsetTop + leftCol.offsetHeight + 8)}px`;
    else toasts.style.removeProperty('top');
  }

  const recentToasts = new Map();
  function toast(text, severity = 'info') {
    if (ui.destroyed || !text) return;
    const now = performance.now();
    const seen = recentToasts.get(text);
    if (seen && now - seen < 2500) return;
    recentToasts.set(text, now);
    if (recentToasts.size > 24) recentToasts.clear();
    placeToasts();
    requestAnimationFrame(placeToasts); // after this frame's alarm list renders
    // ids like "VAV-3-10" never break at their hyphens
    const shownText = String(text).replace(/(\w)-(?=\w)/g, '$1\u2011');
    const t = el('div', { class: 'thud-panel thud-toast', 'data-sev': severity }, el('span', { class: 'thud-toast__dot', 'aria-hidden': 'true' }), el('span', { text: shownText }));
    toasts.append(t);
    while (toasts.children.length > 3) toasts.firstElementChild.remove();
    later(() => {
      t.classList.add('is-leaving');
      later(() => t.remove(), reducedMotion ? 0 : 340);
    }, 4200);
  }

  /* ── lifecycle ──────────────────────────────────────────── */

  function setLoading(fraction) {
    if (fraction == null) {
      root.classList.remove('is-loading');
      return;
    }
    const f = clamp(+fraction || 0, 0, 1);
    root.classList.add('is-loading');
    load.style.setProperty('--p', f.toFixed(3));
    setText(loadPct, `${Math.round(f * 100)}%`);
  }

  // Touch visitors never see the desktop hint line: tell them once, when the HUD first shows
  function maybeTapHint() {
    if (!coarsePointer || ui.tapHinted || !ui.ready || !ui.introVisible) return;
    ui.tapHinted = true;
    later(() => toast('Tap any zone or machine for live readings', 'info'), 600);
  }

  function setReady() {
    if (ui.ready) return;
    ui.ready = true;
    setLoading(null);
    root.classList.add('is-ready');
    if (latest) write();
    syncSheetWheel();
    maybeTapHint();
  }

  function setIntroProgress(p) {
    const o = smoothstep(0.44, 0.62, finite(p) ? p : 0);
    root.style.setProperty('--thud-intro', o.toFixed(3));
    const visible = o >= 0.5;
    if (visible !== ui.introVisible) {
      ui.introVisible = visible;
      root.classList.toggle('is-hidden', !visible);
      if (!visible) closeMenu(false);
      else maybeTapHint();
    }
  }

  function setInteractive(onOff) {
    ui.interactive = !!onOff;
    root.classList.toggle('is-disabled', !ui.interactive);
    layer.inert = !ui.interactive;
  }

  function destroy() {
    if (ui.destroyed) return;
    ui.destroyed = true;
    sheetRO?.disconnect();
    docked.removeEventListener?.('change', syncSheetWheel);
    document.removeEventListener('keydown', onDocKey);
    document.removeEventListener('pointerdown', onDocPointer, true);
    if (timeRaf) cancelAnimationFrame(timeRaf);
    for (const t of timers) clearTimeout(t);
    timers.clear();
    listeners.clear();
    root.replaceChildren();
    root.classList.remove('thud-root', 'is-coarse', 'is-ready', 'is-loading', 'is-hidden', 'is-exploring', 'is-expanded', 'has-card', 'has-alarms', 'is-paused', 'is-disabled');
    root.style.removeProperty('--thud-intro');
    delete root.dataset.mode;
  }

  const sheetRO = typeof ResizeObserver === 'function' ? new ResizeObserver(() => syncSheetWheel()) : null;
  sheetRO?.observe(sheet);
  docked.addEventListener?.('change', syncSheetWheel);

  // Initial UI
  renderLegend(ui.mode);
  setIntroProgress(0);
  root.classList.add('is-hidden');

  return {
    on(event, fn) {
      if (typeof fn !== 'function') return () => {};
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event)?.delete(fn);
    },
    setState,
    setMode,
    showCard,
    setLoading,
    setReady,
    setIntroProgress,
    setInteractive,
    toast,
    destroy,
    // extras
    setExploring,
    setPlaying,
    setSpeed,
    isExploring: () => ui.exploring,
  };
}
