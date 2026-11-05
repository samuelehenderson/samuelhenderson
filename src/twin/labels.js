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
.twin3d-tag{position:absolute;left:0;top:0;display:flex;align-items:center;gap:7px;white-space:nowrap;
  font-family:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:10px;line-height:1;
  letter-spacing:.14em;text-transform:uppercase;color:#dfe8f5;opacity:0;will-change:transform,opacity;
  text-shadow:0 1px 8px rgba(3,6,11,.9)}
.twin3d-tag__dot{width:5px;height:5px;border-radius:50%;background:#4ea8ff;box-shadow:0 0 8px rgba(78,168,255,.8);flex:none}
.twin3d-tag__rule{width:18px;height:1px;background:linear-gradient(90deg,rgba(78,168,255,.85),rgba(78,168,255,.15));flex:none}
.twin3d-tag__v{color:#9aa3b2;letter-spacing:.06em}
.twin3d-tag[data-st="alarm"] .twin3d-tag__dot{background:#ff4d5e;box-shadow:0 0 10px rgba(255,77,94,.9)}
.twin3d-tag[data-st="alarm"] .twin3d-tag__v{color:#ff8a9a}
.twin3d-tag[data-st="off"] .twin3d-tag__dot{background:#5b6473;box-shadow:none}
.twin3d-tag--level{font-size:10.5px;color:#7ec0ff;gap:8px}
.twin3d-tag--level .twin3d-tag__v{color:#5b6473}
.twin3d-tag--level .twin3d-tag__rule{width:28px;background:linear-gradient(90deg,rgba(78,168,255,.15),rgba(78,168,255,.7))}
`;

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
    const name = document.createElement('span');
    const val = document.createElement('span');
    name.textContent = text;
    val.className = 'twin3d-tag__v';
    root.append(el);
    return { el, dot, rule, name, val };
  };

  const eqIds = ['AHU-1', 'AHU-2', 'CT-1', 'CH-1', 'CH-2', 'B-1'];
  for (const id of eqIds) {
    const eq = layout.equipment.find((e) => e.id === id);
    if (!eq) continue;
    const t = mk('', id);
    t.dot.className = 'twin3d-tag__dot';
    t.rule.className = 'twin3d-tag__rule';
    t.el.append(t.dot, t.rule, t.name, t.val);
    tags.push({ ...t, kind: 'eq', id, eq, li: levels.byId.get(eq.level) ?? 0, vis: 0, txt: '', st: '' });
  }
  levels.list.forEach((L, li) => {
    const t = mk('twin3d-tag--level', L.id);
    t.rule.className = 'twin3d-tag__rule';
    const sub = { B1: 'Plant', RF: 'Roof plant' }[L.id] || (li <= 3 ? 'AHU-1' : 'AHU-2');
    t.val.textContent = sub;
    t.el.append(t.name, t.val, t.rule);
    tags.push({ ...t, kind: 'level', id: L.id, L, li, vis: 0 });
  });

  const v = new Vector3();
  let mode = 'live';
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
    if (id === 'B-1') {
      const b = state?.plant?.boiler;
      if (!b) return ['', ''];
      return b.on ? [`Fire ${Math.round(finite(b.fire))}%`, ''] : ['Standby', 'off'];
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
      for (const t of tags) {
        let want = 0;
        if (t.kind === 'eq') {
          want = compact ? 0 : live * (1 - mix.thermal) * (mode === 'exploded' ? 0.9 : 1);
          if (t.eq.level === 'B1' && mode !== 'exploded') want *= 0.85;
          v.set(t.eq.x, t.eq.y + t.eq.h + 0.6 + world.levelShift(t.li), t.eq.z);
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
        if (t.kind === 'eq') t.el.style.transform = `translate3d(${(x - 3).toFixed(1)}px, ${(y - 5).toFixed(1)}px, 0)`;
        else t.el.style.transform = `translate3d(calc(${x.toFixed(1)}px - 100%), ${(y - 5).toFixed(1)}px, 0)`;
        t.el.style.opacity = o.toFixed(3);
        if (writeText && t.kind === 'eq') {
          const [txt, st] = reading(t.id, state);
          if (txt !== t.txt) {
            t.txt = txt;
            t.val.textContent = txt;
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
