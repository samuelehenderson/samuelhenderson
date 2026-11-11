/**
 * Digital Twin — the exterior: a skin the visitor can wrap round the model.
 *
 * The twin is a see-through building by design. This module adds the outside
 * of one, in three steps of detail, so the same model can read as a real
 * building and still be opened up:
 *
 *   1 shell   the frame (plinth, floor bands, piers, parapet) and tinted glass
 *   2 facade  + full-height fins, parapet coping, the entrance on the east side
 *   3 site    + plaza, kerb, trees, lamps, planters, bollards
 *
 * Each step has its own wipe (uWrapY): it rises from the ground when added and
 * sinks back when removed, with the same glowing edge as the scroll intro.
 *
 * "See inside" opens the one wall the camera faces most squarely (uFaceCut,
 * a curtain that lowers from the parapet down), so three sides keep their
 * exterior and the systems stay in view. Closed, every wall is solid — though
 * the twin's services still glow through, as they do through its slabs.
 *
 * Everything is a handful of merged meshes (about 9 draw calls, a few thousand
 * triangles) built once from the layout's footprint and levels.
 */
import {
  BoxGeometry,
  BufferAttribute,
  CylinderGeometry,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Vector4,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GLSL_NOISE, clamp, damp, rng } from './shared.js';

export const EXTERIOR_LEVELS = ['off', 'shell', 'facade', 'site'];

const WRAP_TOP = 32; // m: above everything, so a finished wipe leaves no edge
const WRAP_OFF = -2.5;
const ALWAYS = 4; // aFace: never opened by "see inside"
const SITE = 5;

/* The wipe and the opening, shared by every exterior material. */
const EXT_CUT = /* glsl */ `
  float eEdge = 0.0;
  {
    float en = bHash(vec3(floor(vExtP.x * 0.5), floor(vExtP.y * 0.8), floor(vExtP.z * 0.5)));
    float eh = vExtP.y + en * 1.5;
    if (eh > uWrapY) discard;
    eEdge = 1.0 - smoothstep(0.0, 0.5, uWrapY - eh);
    float ec = vFace < 0.5 ? uFaceCut.x : vFace < 1.5 ? uFaceCut.y : vFace < 2.5 ? uFaceCut.z : vFace < 3.5 ? uFaceCut.w : 0.0;
    if (ec > 0.001) {
      float keep = clamp((vExtP.y + 1.0) / 27.0, 0.0, 1.0) * 0.82 + en * 0.18;
      float th = 1.0 - ec * 1.1;
      if (keep > th) discard;
      eEdge = max(eEdge, 1.0 - smoothstep(0.0, 0.05, th - keep));
    }
  }
`;

function patchExterior(material, U) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWrapY = U.wrapY;
    shader.uniforms.uFaceCut = U.faceCut;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aFace;\nvarying vec3 vExtP;\nvarying float vFace;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvExtP = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvFace = aFace;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vExtP;\nvarying float vFace;\nuniform float uWrapY;\nuniform vec4 uFaceCut;\n${GLSL_NOISE}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${EXT_CUT}`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += vec3(0.32, 0.68, 1.0) * 2.0 * eEdge;');
  };
  material.customProgramCacheKey = () => 'twin-exterior';
  return material;
}

/* ── geometry helpers: everything is collected, tagged with its face, merged ── */
function tag(geo, face) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  g.setAttribute('aFace', new BufferAttribute(new Float32Array(g.attributes.position.count).fill(face), 1));
  return g;
}

export function createExterior({ layout, quality = 'high' }) {
  const hx = layout.footprint.w / 2;
  const hz = layout.footprint.d / 2;
  const offices = layout.levels.filter((l) => l.kind === 'office');
  const floorH = offices[0]?.height ?? 4;
  const roofY = offices.length * floorH;
  const PARAPET = roofY + 1.2;

  // the four walls: 0 south (+z), 1 north, 2 east (+x), 3 west — the order world.js uses
  const WALLS = [
    { id: 0, axis: 'x', sign: 1, half: hx, fixed: hz, piers: [-10, 0, 10] },
    { id: 1, axis: 'x', sign: -1, half: hx, fixed: hz, piers: [-10, 0, 10] },
    { id: 2, axis: 'z', sign: 1, half: hz, fixed: hx, piers: [-4, 4] },
    { id: 3, axis: 'z', sign: -1, half: hz, fixed: hx, piers: [-4, 4] },
  ];
  const NORMALS = [
    [0, 1],
    [0, -1],
    [1, 0],
    [-1, 0],
  ];

  /** A box on a wall: along u0..u1, up y0..y1, out o0..o1 from the structural line. */
  const wallBox = (list, w, u0, u1, y0, y1, o0, o1, face = w.id) => {
    const along = u1 - u0, h = y1 - y0, deep = o1 - o0;
    const out = w.sign * (w.fixed + (o0 + o1) / 2), mid = (u0 + u1) / 2;
    const g = w.axis === 'x' ? new BoxGeometry(along, h, deep) : new BoxGeometry(deep, h, along);
    g.translate(w.axis === 'x' ? mid : out, (y0 + y1) / 2, w.axis === 'x' ? out : mid);
    list.push(tag(g, face));
  };
  const box = (list, w, h, d, x, y, z, face = SITE) => {
    const g = new BoxGeometry(w, h, d);
    g.translate(x, y, z);
    list.push(tag(g, face));
  };
  const cyl = (list, r0, r1, h, x, y, z, face = SITE, seg = 6) => {
    const g = new CylinderGeometry(r0, r1, h, seg, 1);
    g.translate(x, y, z);
    list.push(tag(g, face));
  };

  /* ── 1 · shell: frame and glass ─────────────────────────────── */
  const frame = [];
  const glass = [];
  const CORNER = 2; // m of solid pier at each end of a wall
  for (const w of WALLS) {
    wallBox(frame, w, -w.half - 0.45, w.half + 0.45, 0, 0.5, 0.05, 0.45, ALWAYS); // plinth
    wallBox(frame, w, -w.half - 0.45, w.half + 0.45, roofY - 0.75, PARAPET, 0.1, 0.4, ALWAYS); // roof band + parapet
    wallBox(frame, w, -w.half - 0.45, -w.half + CORNER, 0.5, roofY - 0.75, 0.1, 0.45, ALWAYS); // corner piers
    wallBox(frame, w, w.half - CORNER, w.half + 0.45, 0.5, roofY - 0.75, 0.1, 0.45, ALWAYS);
    for (let n = 1; n < offices.length; n++) wallBox(frame, w, -w.half + CORNER, w.half - CORNER, n * floorH - 0.75, n * floorH + 0.35, 0.1, 0.4); // floor bands
    for (const u of w.piers) wallBox(frame, w, u - 0.45, u + 0.45, 0.5, roofY - 0.75, 0.1, 0.45);
    // one pane per floor, behind the piers
    for (let n = 0; n < offices.length; n++) {
      const y0 = n === 0 ? 0.5 : n * floorH + 0.35, y1 = (n + 1) * floorH - 0.75;
      const g = new PlaneGeometry((w.half - CORNER) * 2, y1 - y0);
      g.rotateY(w.axis === 'x' ? (w.sign > 0 ? 0 : Math.PI) : (w.sign > 0 ? Math.PI / 2 : -Math.PI / 2));
      const out = w.sign * (w.fixed + 0.2);
      g.translate(w.axis === 'x' ? 0 : out, (y0 + y1) / 2, w.axis === 'x' ? out : 0);
      glass.push(tag(g, w.id));
    }
  }

  /* ── 2 · facade: fins, coping, entrance ─────────────────────── */
  const bronze = [];
  const glow = [];
  for (const w of WALLS) {
    for (let u = -w.half + CORNER + 2; u < w.half - CORNER - 0.01; u += 2) {
      if (w.piers.some((p) => Math.abs(p - u) < 0.5)) continue;
      wallBox(bronze, w, u - 0.05, u + 0.05, 0.5, roofY - 0.75, 0.2, 0.64); // fins, full height
    }
    wallBox(bronze, w, -w.half - 0.52, w.half + 0.52, PARAPET, PARAPET + 0.09, 0.04, 0.5, ALWAYS); // coping
  }
  {
    // the entrance, on the short east side (the one the opening shot leaves closed)
    const e = WALLS[2];
    wallBox(bronze, e, -3.3, 3.3, 3.32, 3.5, 0.2, 3.1); // canopy
    wallBox(glow, e, -3.0, 3.0, 3.29, 3.32, 0.6, 2.9); // its lit soffit
    for (const u of [-3.1, 3.1]) wallBox(bronze, e, u - 0.07, u + 0.07, 0, 3.32, 2.86, 3.0); // canopy posts
    for (const u of [-2.25, 2.25]) wallBox(bronze, e, u - 0.09, u + 0.09, 0, 3.25, 0.1, 0.5); // portal jambs
    wallBox(bronze, e, -2.25, 2.25, 3.08, 3.25, 0.1, 0.5); // portal head
    for (const u of [-1.12, 0, 1.12]) wallBox(bronze, e, u - 0.03, u + 0.03, 0, 3.08, 0.2, 0.3); // door mullions
    wallBox(bronze, e, -2.2, 2.2, 2.3, 2.36, 0.2, 0.3); // transom
  }

  /* ── 3 · site ───────────────────────────────────────────────── */
  const stone2 = [];
  const metal2 = [];
  const glow2 = [];
  const leaf = [];
  const plaza = [];
  const R = 9.2; // m from the walls to the kerb
  {
    // plaza: four dark slabs round the building (thin, translucent: the basement still shows), and a kerb
    const X = hx + R, Z = hz + R;
    for (const [w, d, x, z] of [
      [X * 2, R - 0.45, 0, hz + 0.45 + (R - 0.45) / 2],
      [X * 2, R - 0.45, 0, -(hz + 0.45 + (R - 0.45) / 2)],
      [R - 0.45, (hz + 0.45) * 2, hx + 0.45 + (R - 0.45) / 2, 0],
      [R - 0.45, (hz + 0.45) * 2, -(hx + 0.45 + (R - 0.45) / 2), 0],
    ]) {
      const g = new PlaneGeometry(w, d);
      g.rotateX(-Math.PI / 2);
      g.translate(x, 0.03, z);
      plaza.push(tag(g, SITE));
    }
    box(stone2, X * 2 + 0.7, 0.16, 0.35, 0, 0.08, Z + 0.17);
    box(stone2, X * 2 + 0.7, 0.16, 0.35, 0, 0.08, -Z - 0.17);
    box(stone2, 0.35, 0.16, Z * 2, X + 0.17, 0.08, 0);
    box(stone2, 0.35, 0.16, Z * 2, -X - 0.17, 0.08, 0);

    // trees: a square pit, a trunk, a faceted crown of three lobes
    const r = rng(4107);
    const tree = (x, z) => {
      const s = 0.85 + r() * 0.4;
      box(stone2, 1.5, 0.12, 0.12, x, 0.06, z - 0.69); box(stone2, 1.5, 0.12, 0.12, x, 0.06, z + 0.69);
      box(stone2, 0.12, 0.12, 1.26, x - 0.69, 0.06, z); box(stone2, 0.12, 0.12, 1.26, x + 0.69, 0.06, z);
      cyl(metal2, 0.13 * s, 0.2 * s, 2.6 * s, x, 1.3 * s, z);
      for (let k = 0; k < 3; k++) {
        const a = r() * 6.283, rad = (1.5 + r() * 0.5) * s;
        const g = new IcosahedronGeometry(rad, 1);
        g.scale(1, 0.86, 1);
        g.translate(x + Math.cos(a) * 0.55 * s * (k ? 1 : 0), (3.5 + k * 0.85) * s, z + Math.sin(a) * 0.55 * s * (k ? 1 : 0));
        leaf.push(tag(g, SITE));
      }
    };
    const TZ = hz + 6.0, TX = hx + 6.0;
    for (const x of [-16, -8, 0, 8, 16]) { tree(x, TZ); tree(x, -TZ); }
    for (const z of [-8.2, 8.2]) { tree(TX, z); tree(-TX, z); }

    // lamps: a post, an arm, a head that glows after dark
    const lamp = (x, z, dx, dz) => {
      cyl(metal2, 0.055, 0.075, 4.6, x, 2.3, z);
      box(metal2, dx ? 0.9 : 0.1, 0.07, dz ? 0.9 : 0.1, x + dx * 0.4, 4.6, z + dz * 0.4);
      box(glow2, dx ? 0.5 : 0.16, 0.04, dz ? 0.5 : 0.16, x + dx * 0.55, 4.55, z + dz * 0.55);
    };
    for (const x of [-12, 12]) { lamp(x, hz + 8.2, 0, -1); lamp(x, -(hz + 8.2), 0, 1); }
    for (const z of [-5.2, 5.2]) lamp(hx + 8.2, z, -1, 0);
    lamp(-(hx + 8.2), 0, 1, 0);

    // by the entrance: two planters with a clipped hedge, a row of bollards
    for (const z of [-4.9, 4.9]) {
      box(stone2, 3.2, 0.55, 0.9, hx + 3.6, 0.275, z);
      box(leaf, 3.0, 0.5, 0.7, hx + 3.6, 0.8, z);
    }
    for (const z of [-3, -1.5, 0, 1.5, 3]) cyl(metal2, 0.1, 0.1, 0.85, hx + 7.4, 0.425, z, SITE, 8);
    // two benches on the long south side
    for (const x of [-4, 4]) {
      box(metal2, 2.2, 0.07, 0.55, x, 0.46, hz + 3.6);
      box(metal2, 0.08, 0.46, 0.5, x - 0.9, 0.23, hz + 3.6); box(metal2, 0.08, 0.46, 0.5, x + 0.9, 0.23, hz + 3.6);
    }
  }

  /* ── materials: one set per step, so each has its own wipe ───── */
  const faceCut = { value: new Vector4(0, 0, 0, 0) };
  const steps = [1, 2, 3].map(() => ({ wrapY: { value: WRAP_OFF }, faceCut, group: new Group(), mats: [] }));
  const mat = (step, params) => {
    const m = patchExterior(new MeshStandardMaterial(params), steps[step - 1]);
    steps[step - 1].mats.push(m);
    return m;
  };
  const STONE = { color: '#9c9a94', roughness: 0.86, metalness: 0.0 };
  const METAL = { color: '#2b2824', roughness: 0.42, metalness: 0.78 };
  const GLOW = { color: '#1a1410', roughness: 0.6, metalness: 0, emissive: '#ffcf8f', emissiveIntensity: 0.2 };
  const glowMats = [];

  const group = new Group();
  group.name = 'exterior';
  const owned = [];
  const add = (step, parts, material, { order = 0 } = {}) => {
    if (!parts.length) return null;
    const geo = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    owned.push(geo);
    const mesh = new Mesh(geo, material);
    mesh.renderOrder = order;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    steps[step - 1].group.add(mesh);
    return mesh;
  };

  add(1, frame, mat(1, STONE));
  // drawn before the interior's own see-through layers, so those glow through it
  add(1, glass, mat(1, { color: '#0c1822', roughness: 0.1, metalness: 0.9, transparent: true, opacity: 0.56, depthWrite: false, side: DoubleSide, envMapIntensity: 1.15 }), { order: 1 });
  add(2, bronze, mat(2, METAL));
  glowMats.push(mat(2, GLOW));
  add(2, glow, glowMats[0]);
  add(3, plaza, mat(3, { color: '#0d141d', roughness: 0.95, metalness: 0, transparent: true, opacity: 0.5, depthWrite: false }), { order: -1 });
  add(3, stone2, mat(3, STONE));
  add(3, metal2, mat(3, METAL));
  add(3, leaf, mat(3, { color: '#3a5a45', roughness: 1, metalness: 0, flatShading: true }));
  glowMats.push(mat(3, GLOW));
  add(3, glow2, glowMats[1]);
  for (const s of steps) {
    s.group.visible = false;
    group.add(s.group);
  }

  /* ── state ──────────────────────────────────────────────────── */
  let level = 0; // 0 off … 3 site
  let inside = true;
  let openFace = -1;
  const cut = [0, 0, 0, 0];
  const facing = [0, 0, 0, 0];

  return {
    group,
    get level() {
      return level;
    },
    get inside() {
      return inside;
    },
    setLevel(n) {
      level = clamp(Math.round(+n || 0), 0, 3);
    },
    setInside(b) {
      inside = !!b;
    },
    /**
     * @param shown      false while the twin is assembling or exploded: the skin steps aside
     * @param forceOpen  true in Thermal / Airflow, where the point is to see in
     */
    update(dt, camera, { reducedMotion = false, shown = true, forceOpen = false, night = 0 } = {}) {
      // each step's wipe
      const speed = reducedMotion ? 1e6 : 24; // m/s
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        const want = shown && level >= i + 1 ? WRAP_TOP : WRAP_OFF;
        const v = s.wrapY.value;
        if (v !== want) s.wrapY.value = v < want ? Math.min(want, v + speed * dt) : Math.max(want, v - speed * dt * 1.35);
        s.group.visible = s.wrapY.value > WRAP_OFF + 0.01;
      }

      // the wall the camera faces most squarely opens (with a little stickiness, so it does not flicker on a diagonal)
      const px = camera.position.x, pz = camera.position.z, len = Math.hypot(px, pz) || 1;
      let best = 0;
      for (let i = 0; i < 4; i++) {
        facing[i] = (NORMALS[i][0] * px + NORMALS[i][1] * pz) / len;
        if (facing[i] > facing[best]) best = i;
      }
      if (openFace < 0 || facing[best] > facing[openFace] + 0.09) openFace = best;
      const open = (inside || forceOpen) && level > 0 && shown;
      for (let i = 0; i < 4; i++) {
        const want = open && i === openFace ? 1 : 0;
        cut[i] = reducedMotion ? want : damp(cut[i], want, 3.4, dt);
        if (Math.abs(cut[i] - want) < 0.004) cut[i] = want;
      }
      faceCut.value.set(cut[0], cut[1], cut[2], cut[3]);

      // lamps and the entrance light come up after dark
      const g = 0.25 + 2.6 * clamp(night, 0, 1);
      for (const m of glowMats) m.emissiveIntensity = g;
    },
    dispose() {
      for (const g of owned) g.dispose();
      for (const s of steps) for (const m of s.mats) m.dispose();
      group.removeFromParent();
    },
    // for checks
    _debug: () => ({ level, inside, openFace, cut: [...cut], wrap: steps.map((s) => s.wrapY.value), quality }),
  };
}
