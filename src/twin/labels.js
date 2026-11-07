/**
 * Digital Twin — small DOM tags pinned to 3D points: key equipment
 * (with a live reading) and, in Exploded mode, level names.
 * Positions update every frame via transforms; text updates at ~4 Hz.
 */
import { Vector3 } from 'three';
import { clamp, damp, finite, smoothstep } from './shared.js';

const STYLE_ID = 'twin3d-label-style';
const CSS = `
.twin3d-labels{position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:1;contain:strict}
.twin3d-tag{position:absolute;left:0;top:0;display:flex;align-items:center;gap:6px;white-space:nowrap;
  font-family:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:10px;line-height:1;
  letter-spacing:.14em;text-transform:uppercase;color:#e6edf7;opacity:0;will-change:transform,opacity}
.twin3d-tag__pill{display:inline-flex;align-items:center;gap:7px;padding:3px 7px;border-radius:999px;
  background:rgba(8,9,13,.62);border:1px solid rgba(255,255,255,.06)}
.twin3d-tag__dot{width:5px;height:5px;border-radius:50%;background:#4ea8ff;box-shadow:0 0 8px rgba(78,168,255,.8);flex:none}
.twin3d-tag__rule{width:16px;height:1px;background:linear-gradient(90deg,rgba(78,168,255,.85),rgba(78,168,255,.15));flex:none}
.twin3d-tag__lead{width:1px;height:22px;margin:2px 2px 3px;flex:none;
  background:repeating-linear-gradient(180deg,rgba(126,192,255,.8) 0 3px,transparent 3px 6px)}
.twin3d-tag__v{color:#aab3c2;letter-spacing:.06em}
.twin3d-tag.is-flip{flex-direction:row-reverse}
.twin3d-tag.is-flip .twin3d-tag__rule{background:linear-gradient(270deg,rgba(78,168,255,.85),rgba(78,168,255,.15))}
.twin3d-tag.is-below{flex-direction:column;align-items:flex-start;gap:0}
.twin3d-tag.is-below.is-flip{align-items:flex-end}
.twin3d-tag[data-st="alarm"] .twin3d-tag__dot{background:#ff4d5e;box-shadow:0 0 10px rgba(255,77,94,.9)}
.twin3d-tag[data-st="alarm"] .twin3d-tag__v{color:#ff8a9a}
.twin3d-tag[data-st="alarm"] .twin3d-tag__pill{border-color:rgba(255,77,94,.35)}
.twin3d-tag[data-st="off"] .twin3d-tag__dot{background:#5b6473;box-shadow:none}
.twin3d-tag--level{font-size:10.5px;color:#7ec0ff;gap:8px}
.twin3d-tag--level .twin3d-tag__v{color:#9aa3b2}
.twin3d-tag--level .twin3d-tag__rule{width:28px;background:linear-gradient(90deg,rgba(78,168,255,.15),rgba(78,168,255,.7))}
.twin3d-labels.is-compact .twin3d-tag--level .twin3d-tag__v{display:none}
.twin3d-labels.is-compact .twin3d-tag--level .twin3d-tag__rule{width:14px}
`;

// Tags that sit close together on screen are split: this one reads to the left of its point.
const FLIP = new Set(['CH-2']);

export function createLabels({ host, layout, levels, coarsePointer }) {
  if (!document.getElementById(STYLE_ID)) {
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.append(s);
  }
  const root = document.createElement('div');
  root.className = 'twin3d-labels';
  root.setAttribute('aria-hidden', 'true');
  host.append(root);

  const tags = [];
  const mk = (cls, text) => {
    const el = document.createElement('div');
    el.className = `twin3d-tag ${cls || ''}`;
    const dot = document.createElement('span');
    const rule = document.createElement('span');
    const pill = document.createElement('span');
    const name = document.createElement('span');
    const val = document.createElement('span');
    pill.className = 'twin3d-tag__pill';
    name.textContent = text;
    val.className = 'twin3d-tag__v';
    pill.append(name, val);
    root.append(el);
    return { el, dot, rule, pill, name, val };
  };

  const eqIds = ['AHU-1', 'AHU-2', 'CT-1', 'CH-1', 'CH-2', 'HHW-1'];
  for (const id of eqIds) {
    const eq = layout.equipment.find((e) => e.id === id);
    if (!eq) continue;
    const below = eq.level === 'B1';
    const flip = FLIP.has(id);
    const t = mk(`${flip ? 'is-flip' : ''} ${below ? 'is-below' : ''}`, id);
    t.dot.className = 'twin3d-tag__dot';
    if (below) {
      // basement plant hangs its tag below on a dashed leader: it reads as below grade
      t.rule.className = 'twin3d-tag__lead';
      t.el.append(t.dot, t.rule, t.pill);
    } else {
      t.rule.className = 'twin3d-tag__rule';
      t.el.append(t.dot, t.rule, t.pill);
    }
    tags.push({ ...t, kind: 'eq', id, eq, below, flip, li: levels.byId.get(eq.level) ?? 0, vis: 0, txt: '', st: '', w: 0 });
  }
  levels.list.forEach((L, li) => {
    const t = mk('twin3d-tag--level', L.id);
    t.rule.className = 'twin3d-tag__rule';
    const sub = { B1: 'Plant', RF: 'Roof plant' }[L.id] || (li <= 3 ? 'AHU-1' : 'AHU-2');
    t.val.textContent = sub;
    t.el.append(t.pill, t.rule);
    tags.push({ ...t, kind: 'level', id: L.id, L, li, vis: 0, w: [0, 0] });
  });

  const v = new Vector3();
  let mode = 'live';
  let wasCompact = null;
  let textTimer = 0;
  let lastT = performance.now();

  function reading(id, state) {
    if (id.startsWith('AHU')) {
      const a = state?.ahus?.[id];
      if (!a) return ['', ''];
      if (a.alarm) return ['Fan fail', 'alarm'];
      if (a.on === false) return ['Off', 'off'];
      return [`${Math.round(finite(a.sfSpeed))}%`, ''];
    }
    if (id === 'CT-1') {
      const tw = state?.plant?.tower;
      if (!tw) return ['', ''];
      return tw.on ? [`Fan ${Math.round(finite(tw.fan))}%`, ''] : ['Off', 'off'];
    }
    if (id.startsWith('CH')) {
      const c = state?.plant?.chillers?.[id];
      if (!c) return ['', ''];
      if (c.status === 'tripped' || c.alarm) return ['Tripped', 'alarm'];
      if (c.status === 'starting') return ['Starting', ''];
      return c.on ? [`${Math.round(finite(c.load))}%`, ''] : ['Standby', 'off'];
    }
    if (id === 'HHW-1') {
      // the plant's key reading is its HW supply temperature (ClarityView's keyReading HHW.HWS)
      const h = state?.plant?.hhw;
      if (!h) return ['', ''];
      if (h.tempAlarm) return [`${Math.round(finite(h.hws))}°F`, 'alarm'];
      return h.enabled ? [`${Math.round(finite(h.hws))}°F`, ''] : ['Standby', 'off'];
    }
    return ['', ''];
  }

  return {
    setMode(m) {
      mode = m;
    },
    update(camera, world, { progress, W, H, mix, state }) {
      const now = performance.now();
      const dt = Math.min(0.1, (now - lastT) / 1000);
      lastT = now;
      textTimer += dt;
      const writeText = textTimer > 0.25;
      if (writeText) textTimer = 0;
      const live = smoothstep(0.5, 0.62, progress);
      const compact = W < 720 || (coarsePointer && W < 1024);
      if (compact !== wasCompact) {
        wasCompact = compact;
        root.classList.toggle('is-compact', compact);
      }
      for (const t of tags) {
        let want = 0;
        if (t.kind === 'eq') {
          want = compact ? 0 : live * (1 - mix.thermal) * (mode === 'exploded' ? 0.9 : 1);
          if (t.below && mode !== 'exploded') want *= 0.85;
          // basement tags anchor mid-height (the leader hangs below); the rest float over the top
          const ay = t.below ? t.eq.y + t.eq.h * 0.55 : t.eq.y + t.eq.h + 0.6;
          v.set(t.eq.x, ay + world.levelShift(t.li), t.eq.z);
        } else {
          want = live * mix.explode * (compact ? 0.85 : 1);
          const L = t.L;
          const h = L.kind === 'roof' ? 1.5 : L.kind === 'plant' ? 2.2 : 2;
          v.set(-layout.footprint.w / 2 - 1.2, L.y + h + world.levelShift(t.li), layout.footprint.d / 2 + 1.2);
        }
        t.vis = damp(t.vis, want, 8, dt);
        if (t.vis < 0.02) {
          if (t.el.style.opacity !== '0') t.el.style.opacity = '0';
          continue;
        }
        v.project(camera);
        if (v.z > 1 || v.z < -1) {
          t.el.style.opacity = '0';
          continue;
        }
        const x = (v.x * 0.5 + 0.5) * W;
        const y = (-v.y * 0.5 + 0.5) * H;
        const edge = smoothstep(0, 60, Math.min(x, W - x, y - 70, H - y - 90));
        const o = clamp(t.vis * edge, 0, 1);
        if (t.kind === 'eq') {
          // the dot sits on the point; flipped tags extend to its left
          if (t.flip && !t.w) t.w = t.el.offsetWidth;
          const tx = t.flip ? x - t.w + 3 : x - 3;
          const ty = t.below ? y - 3 : y - 9;
          t.el.style.transform = `translate3d(${tx.toFixed(1)}px, ${ty.toFixed(1)}px, 0)`;
        } else {
          // right-aligned to the building's corner, but never pushed off the left edge (narrow screens)
          const k = compact ? 1 : 0;
          if (!t.w[k]) t.w[k] = t.el.offsetWidth;
          const left = Math.max(8, x - t.w[k]);
          t.el.style.transform = `translate3d(${left.toFixed(1)}px, ${(y - 5).toFixed(1)}px, 0)`;
        }
        t.el.style.opacity = o.toFixed(3);
        if (writeText && t.kind === 'eq') {
          const [txt, st] = reading(t.id, state);
          if (txt !== t.txt) {
            t.txt = txt;
            t.val.textContent = txt;
            t.w = 0; // re-measure (flipped tags) next frame
          }
          if (st !== t.st) {
            t.st = st;
            if (st) t.el.dataset.st = st;
            else delete t.el.dataset.st;
          }
        }
      }
    },
    destroy() {
      root.remove();
      // keep the <style> if another instance still uses it
      if (!document.querySelector('.twin3d-labels')) document.getElementById(STYLE_ID)?.remove();
    },
  };
}
