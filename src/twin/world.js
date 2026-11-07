/**
 * Digital Twin — the building: level stack (slabs, curtain wall, core,
 * zones, desks, VAVs, occupants), basement plant room and roof deck.
 *
 * Everything derives from sim.layout. Per-zone live values (thermal colour,
 * lights, alarm, hover, reheat …) are packed into one small float texture
 * that every zone-aware shader samples, so a frame costs one tiny upload.
 *
 * Each level is a Group, so the scroll intro (drop + dissolve) and the
 * Exploded mode simply move groups; meshes built in world space (service
 * runs, particles) apply the same per-level shift in their vertex shader.
 *
 * The plant (AHUs, tower, chillers, pumps, the heating plant) and the VAV
 * terminal are ClarityView's own models, built later by the lazy units chunk
 * (units/index.js) and handed in: addUnit(host), setVavGeometry(), setPlantXray().
 * Until then (or if that chunk cannot load) the VAVs are plain boxes and
 * addProxyEquipment() draws the layout's equipment as neutral boxes.
 */
import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  DoubleSide,
  FrontSide,
  Group,
  InstancedBufferAttribute,
  GreaterDepth,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  PointLight,
  ShaderMaterial,
  SphereGeometry,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import {
  GLSL_DISSOLVE,
  GLSL_NOISE,
  GLSL_THERMAL,
  PALETTE,
  clamp,
  concreteTexture,
  damp,
  finite,
  makeDataTexture,
  patchReveal,
  rng,
  roofTexture,
  thermalColor,
} from './shared.js';

const ZONE_TEX_W = 64;
const ZONE_TEX_H = 4;
const PEOPLE_PER_ZONE = 5;

/* ── shader chunks shared by the interior materials ─────────────── */

const ZONE_VERT = /* glsl */ `
  uniform sampler2D uZoneTex;
  vec4 zoneRow(float z, float row) { return texture2D(uZoneTex, vec2((z + 0.5) / ${ZONE_TEX_W}.0, (row + 0.5) / ${ZONE_TEX_H}.0)); }
`;
const FRAG_HEAD = /* glsl */ `
  uniform float uReveal, uThermal, uAir, uDay, uNight, uTime;
  uniform vec3 uAccent, uAlarm;
  varying vec3 vBuildP;
  ${GLSL_NOISE}
  ${GLSL_THERMAL}
`;
// section cut (basement focus): a screen-door fade, then gone
const GLSL_CUT = /* glsl */ `
  if (uCut > 0.001 && fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) < uCut) discard;
`;
const EDGE_GLOW = 'vec3(0.32, 0.68, 1.0) * 2.2 * bEdge';

export function createWorld({ layout, levels, quality, modeU, ctxU }) {
  const disposables = new Set();
  const own = (x) => (x && disposables.add(x), x);
  const root = new Group();
  root.name = 'building';

  const hx = layout.footprint.w / 2;
  const hz = layout.footprint.d / 2;
  const core = layout.core;
  const zones = layout.zones;
  const zoneIndex = new Map(zones.map((z, i) => [z.id, i]));
  const vavIndex = new Map(zones.map((z, i) => [z.vav, i]));
  const zoneTex = own(makeDataTexture(ZONE_TEX_W, ZONE_TEX_H));
  const zoneData = zoneTex.image.data;

  // live per-zone smoothing state
  const zs = zones.map(() => ({ lights: 0, alarm: 0, hover: 0, thermal: new Color(1, 1, 1), occ: 0, reheat: 0, damper: 0 }));
  const hl = { hover: null, selected: null };

  // shared uniforms for all interior materials
  const baseU = {
    uZoneTex: { value: zoneTex },
    uThermal: modeU.thermal,
    uAir: modeU.air,
    uDay: ctxU.day,
    uNight: ctxU.night,
    uTime: ctxU.time,
    uAccent: { value: PALETTE.accent.clone() },
    uAlarm: { value: PALETTE.alarm.clone() },
    uSunDir: ctxU.sunDir,
    uSunCol: ctxU.sunCol,
    uSkyTop: ctxU.skyTop,
    uSkyHor: ctxU.skyHor,
  };
  const withReveal = (reveal, extra = {}) => ({ ...baseU, uReveal: reveal, ...extra });

  /* ── textures & shared geometry ─────────────────────────────── */
  const texConcrete = own(concreteTexture());
  texConcrete.repeat.set(2, 2);
  const texRoof = own(roofTexture());
  texRoof.repeat.set(10, 6);

  const unitBox = own(new BoxGeometry(1, 1, 1));
  const unitPlaneY = own(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
  const unitPlane = own(new PlaneGeometry(1, 1));
  const deskGeo = own(makeDeskGeometry());
  const personGeo = own(makePersonGeometry(quality));
  const vavGeo = own(makeVavGeometry());
  vavGeo.computeBoundingBox();
  const vavPickGeo = own(boxOf(vavGeo.boundingBox));

  /* ── per-level materials (clones share programs; differ by uReveal) ─ */
  function levelMaterials(reveal, cut) {
    const m = {};
    m.concrete = patchReveal(new MeshStandardMaterial({ color: '#7d828a', map: texConcrete, roughness: 0.93, metalness: 0 }), reveal);
    m.coreConcrete = patchReveal(new MeshStandardMaterial({ color: '#8b9098', map: texConcrete, roughness: 0.9, metalness: 0 }), reveal);
    m.band = patchReveal(new MeshStandardMaterial({ color: '#2a3340', roughness: 0.4, metalness: 0.55 }), reveal);
    m.mullion = patchReveal(new MeshStandardMaterial({ color: '#3a4350', roughness: 0.3, metalness: 0.85 }), reveal);
    m.roof = patchReveal(new MeshStandardMaterial({ color: '#8a9099', map: texRoof, roughness: 0.95, metalness: 0 }), reveal);
    m.plantFloor = patchReveal(new MeshStandardMaterial({ color: '#2f3944', roughness: 0.55, metalness: 0.1 }), reveal);
    m.pad = patchReveal(new MeshStandardMaterial({ color: '#5d636c', map: texConcrete, roughness: 0.9 }), reveal);
    m.floor = makeFloorMaterial(withReveal(reveal));
    m.glass = makeGlassMaterial(withReveal(reveal, { uOpacity: { value: 1 }, uCut: cut }));
    m.shaft = makeShaftMaterial(withReveal(reveal, { uOpacity: { value: 1 } }));
    m.desk = makeDeskMaterial(withReveal(reveal, { uCut: cut }));
    m.vav = makeVavMaterial(withReveal(reveal));
    m.person = makePersonMaterial(withReveal(reveal, { uCut: cut }));
    m.volume = makeVolumeMaterial(withReveal(reveal));
    m.ghost = makeGhostWallMaterial(withReveal(reveal, { uOpacity: { value: 1 } }));
    m.pick = new MeshBasicMaterial({ visible: false });
    for (const k in m) own(m[k]);
    return m;
  }

  /* ── build every level ──────────────────────────────────────── */
  const levelGroups = [];
  const levelState = [];
  const pickZoneMeshes = [];
  const pickVavMeshes = [];
  const vavMeshes = [];
  const equipment = new Map(); // id → { id, host?, proxy?, eq?, level }
  let units = null; // the units chunk, once attached (bboxFor / picking ask it first)
  const casters = [];
  const allLineMats = [];
  const rand = rng(1234);

  for (let li = 0; li < levels.count; li++) {
    const L = levels.list[li];
    const g = new Group();
    g.name = `level-${L.id}`;
    g.position.y = L.y;
    g.userData.levelIndex = li;
    root.add(g);
    levelGroups.push(g);

    const reveal = { value: 1 };
    const cut = { value: 0 };
    const mats = levelMaterials(reveal, cut);
    const lineMat = own(
      new LineMaterial({
        color: PALETTE.accent.clone().multiplyScalar(1.25),
        linewidth: 1.25,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        worldUnits: false,
      }),
    );
    allLineMats.push(lineMat);
    const ls = {
      id: L.id,
      kind: L.kind,
      y: L.y,
      reveal,
      // the level group's current world y (intro drop + Exploded): the units' dissolve is level-local
      levelY: { value: L.y },
      cut,
      lineMat,
      lineScale: 1,
      mats,
      drop: 0,
      explode: 0,
      casters: [],
      people: null,
      flash: 0,
    };
    levelState.push(ls);
    const addMesh = (geo, mat, { cast = true, receive = false, order = 0, name } = {}) => {
      const mesh = new Mesh(geo, mat);
      mesh.castShadow = cast;
      mesh.receiveShadow = receive;
      mesh.renderOrder = order;
      if (name) mesh.name = name;
      if (cast) ls.casters.push(mesh);
      g.add(mesh);
      return mesh;
    };
    const boxAt = (w, h, d, x, y, z, mat, opts) => {
      const geo = own(new BoxGeometry(w, h, d));
      geo.translate(x, y, z);
      return addMesh(geo, mat, opts);
    };
    const segs = [];
    const rect = (y, ox, oz) => {
      const c = [
        [-ox, oz],
        [ox, oz],
        [ox, -oz],
        [-ox, -oz],
      ];
      for (let i = 0; i < 4; i++) {
        const a = c[i];
        const b = c[(i + 1) % 4];
        segs.push(a[0], y, a[1], b[0], y, b[1]);
      }
    };
    const vline = (x, z, y0, y1) => segs.push(x, y0, z, x, y1, z);

    const coreW = core.x1 - core.x0;
    const coreD = core.z1 - core.z0;
    const innerW = coreW * 0.7;
    const innerD = coreD * 0.65;
    const ocx = (core.x0 + core.x1) / 2;
    const ocz = (core.z0 + core.z1) / 2;

    if (L.kind === 'office') {
      const H = levels.list[li + 1] ? levels.list[li + 1].y - L.y : 4;
      const glassTop = H - 0.4;
      const glassBot = 0.22;
      // slab
      boxAt(hx * 2 + 0.3, 0.4, hz * 2 + 0.3, 0, -0.2, 0, mats.concrete, { receive: true });
      // spandrel band (slab edge)
      buildBand(g, mats.band, hx, hz, -0.4, glassBot, 0.22, own, ls);
      // inner concrete core + glazed service shaft around it
      boxAt(innerW, H - 0.4, innerD, ocx, (H - 0.4) / 2, ocz, mats.coreConcrete, {});
      const shaft = boxAt(coreW, H - 0.42, coreD, ocx, (H - 0.42) / 2, ocz, mats.shaft, { cast: false, order: 2 });
      shaft.castShadow = false;
      // curtain wall
      const glass = buildCurtainWall(g, mats, hx, hz, glassBot, glassTop, zones, L, own, ls);
      ls.glass = glass;
      // zones: floor plates, thermal volumes, pick boxes, desks, VAVs, occupants
      const lz = zones.filter((z) => z.level === L.id);
      ls.zones = lz;
      const n = lz.length;
      const plates = new InstancedMesh(unitPlaneY, mats.floor, n);
      const vols = new InstancedMesh(unitBox, mats.volume, n);
      const picks = new InstancedMesh(unitBox, mats.pick, n);
      const zAttr = new Float32Array(n);
      const sAttr = new Float32Array(n * 2);
      const o = new Object3D();
      lz.forEach((z, i) => {
        const w = z.x1 - z.x0;
        const d = z.z1 - z.z0;
        const cx = (z.x0 + z.x1) / 2;
        const cz = (z.z0 + z.z1) / 2;
        zAttr[i] = zoneIndex.get(z.id);
        sAttr[i * 2] = w;
        sAttr[i * 2 + 1] = d;
        o.position.set(cx, 0.02, cz);
        o.scale.set(w - 0.1, 1, d - 0.1);
        o.updateMatrix();
        plates.setMatrixAt(i, o.matrix);
        o.position.set(cx, (H - 0.45) / 2 + 0.05, cz);
        o.scale.set(w - 0.5, H - 0.6, d - 0.5);
        o.updateMatrix();
        vols.setMatrixAt(i, o.matrix);
        o.position.set(cx, H / 2, cz);
        o.scale.set(w, H, d);
        o.updateMatrix();
        picks.setMatrixAt(i, o.matrix);
      });
      plates.geometry = unitPlaneY.clone();
      own(plates.geometry);
      plates.geometry.setAttribute('aZone', new InstancedBufferAttribute(zAttr, 1));
      plates.geometry.setAttribute('aSize', new InstancedBufferAttribute(sAttr, 2));
      plates.receiveShadow = false;
      vols.geometry = unitBox.clone();
      own(vols.geometry);
      vols.geometry.setAttribute('aZone', new InstancedBufferAttribute(zAttr.slice(), 1));
      vols.geometry.setAttribute('aSize', new InstancedBufferAttribute(sAttr.slice(), 2));
      vols.renderOrder = 3;
      vols.visible = false;
      vols.frustumCulled = false;
      picks.userData.pickZones = lz.map((z) => z.id);
      g.add(plates, vols, picks);
      ls.plates = plates;
      ls.volumes = vols;
      pickZoneMeshes.push(picks);

      // desks + seats
      const seats = [];
      const deskMatrices = [];
      const deskZones = [];
      lz.forEach((z) => {
        const lobby = /lobby/i.test(z.name || '');
        const w = z.x1 - z.x0;
        const d = z.z1 - z.z0;
        const cx = (z.x0 + z.x1) / 2;
        const cz = (z.z0 + z.z1) / 2;
        const zi = zoneIndex.get(z.id);
        const zSeats = [];
        if (lobby) {
          // a reception desk facing the entrance
          const outward = Math.sign(cz) || 1;
          o.position.set(cx, 0, cz - outward * 1.2);
          o.rotation.set(0, outward > 0 ? 0 : Math.PI, 0);
          o.scale.set(2.2, 1, 1);
          o.updateMatrix();
          deskMatrices.push(o.matrix.clone());
          deskZones.push(zi);
          zSeats.push([cx - 0.8, cz - outward * 1.9], [cx + 0.8, cz - outward * 1.9]);
        } else {
          const cols = Math.max(1, Math.floor((w - 2.6) / 1.6));
          const pairRows = Math.max(1, Math.floor((d - 2.4) / 3.0));
          const spanX = cols * 1.6;
          const spanZ = pairRows * 3.0;
          for (let r = 0; r < pairRows; r++) {
            for (let c = 0; c < cols; c++) {
              const x = cx - spanX / 2 + 0.8 + c * 1.6;
              const zc = cz - spanZ / 2 + 1.5 + r * 3.0;
              for (const side of [-1, 1]) {
                o.position.set(x, 0, zc + side * 0.4);
                o.rotation.set(0, side > 0 ? 0 : Math.PI, 0);
                o.scale.set(1, 1, 1);
                o.updateMatrix();
                deskMatrices.push(o.matrix.clone());
                deskZones.push(zi);
                zSeats.push([x, zc + side * 1.05]);
              }
            }
          }
        }
        seats.push(zSeats);
      });
      const desks = new InstancedMesh(deskGeo.clone(), mats.desk, deskMatrices.length);
      own(desks.geometry);
      deskMatrices.forEach((mm, i) => desks.setMatrixAt(i, mm));
      desks.geometry.setAttribute('aZone', new InstancedBufferAttribute(new Float32Array(deskZones), 1));
      const dSeed = new Float32Array(deskMatrices.length).map(() => rand());
      desks.geometry.setAttribute('aSeed', new InstancedBufferAttribute(dSeed, 1));
      desks.castShadow = false;
      g.add(desks);

      // VAV terminals at the end of their branch, the inlet facing the duct's last leg
      // (a plain box until the units chunk hands over the baked ClarityView terminal)
      const vavs = new InstancedMesh(shareGeometry(vavGeo), mats.vav, n);
      own(vavs.geometry);
      const vZ = new Float32Array(n);
      lz.forEach((z, i) => {
        const p = z.vavPos || [(z.x0 + z.x1) / 2, L.y + 3.4, (z.z0 + z.z1) / 2];
        const run = layout.runs.find((r) => r.id === `sa-${z.id}`);
        let rot = 0;
        if (run && run.points.length >= 2) {
          const a = run.points[run.points.length - 2];
          const b = run.points[run.points.length - 1];
          rot = Math.atan2(-(b[2] - a[2]), b[0] - a[0]);
        }
        o.position.set(p[0], p[1] - L.y, p[2]);
        o.rotation.set(0, rot, 0);
        o.scale.set(1, 1, 1);
        o.updateMatrix();
        vavs.setMatrixAt(i, o.matrix);
        vZ[i] = zoneIndex.get(z.id);
      });
      const vZAttr = new InstancedBufferAttribute(vZ, 1);
      vavs.geometry.setAttribute('aZone', vZAttr);
      g.add(vavs);
      // picking: an invisible box per VAV with the same matrices (hover never ray-tests the terminal's triangles)
      const vavPicks = new InstancedMesh(vavPickGeo, mats.pick, n);
      vavPicks.instanceMatrix.copy(vavs.instanceMatrix);
      vavPicks.userData.pickVavs = lz.map((z) => z.vav);
      vavPicks.frustumCulled = false;
      g.add(vavPicks);
      pickVavMeshes.push(vavPicks);
      vavMeshes.push({ mesh: vavs, picks: vavPicks, aZone: vZAttr });

      // occupants
      ls.people = buildPeople(g, personGeo, mats.person, lz, seats, zoneIndex, rand, own);

      // blueprint lines: band edges + glass corners
      rect(glassBot, hx + 0.12, hz + 0.12);
      rect(-0.4, hx + 0.12, hz + 0.12);
      for (const [x, z] of [
        [-hx - 0.12, -hz - 0.12],
        [hx + 0.12, -hz - 0.12],
        [hx + 0.12, hz + 0.12],
        [-hx - 0.12, hz + 0.12],
      ])
        vline(x, z, glassBot, glassTop);

      if (L.id === levels.list[1].id) buildLobbyCanopy(g, mats, hx, hz, zones, own, ls, segs);
    } else if (L.kind === 'plant') {
      const H = levels.list[li + 1] ? levels.list[li + 1].y - L.y : 4.5;
      const top = H - 0.45;
      boxAt(hx * 2 + 0.3, 0.4, hz * 2 + 0.3, 0, -0.2, 0, mats.plantFloor, { receive: true, cast: false });
      // epoxy floor plane with painted aisles is folded into the floor colour; plinths per item
      boxAt(innerW, H - 0.4, innerD, ocx, (H - 0.4) / 2, ocz, mats.coreConcrete, {});
      const shaft = boxAt(coreW, H - 0.42, coreD, ocx, (H - 0.42) / 2, ocz, mats.shaft, { cast: false, order: 2 });
      shaft.castShadow = false;
      // ghosted foundation walls
      const wallGeo = own(new BoxGeometry(hx * 2 + 0.2, top, hz * 2 + 0.2));
      wallGeo.translate(0, top / 2, 0);
      const ghost = new Mesh(wallGeo, mats.ghost);
      ghost.renderOrder = 3;
      g.add(ghost);
      ls.ghost = ghost;
      rect(0.02, hx + 0.1, hz + 0.1);
      rect(top, hx + 0.1, hz + 0.1);
      for (const [x, z] of [
        [-hx - 0.1, -hz - 0.1],
        [hx + 0.1, -hz - 0.1],
        [hx + 0.1, hz + 0.1],
        [-hx - 0.1, hz + 0.1],
      ])
        vline(x, z, 0, top);
      buildPlantExtras(g, mats, hx, hz, own, ls);
      // plant-room lighting (the sun never reaches B1)
      for (const [x, z] of [
        [-12, 2],
        [12, -4],
      ]) {
        // parented to the root (always visible): a light that appears or disappears
        // with its level would change the light count and recompile every material
        const pl = new PointLight(0xcfe3ff, 45, 24, 1.5);
        pl.position.set(x, L.y + top - 0.6, z);
        pl.userData.localY = top - 0.6;
        root.add(pl);
        (ls.lights ||= []).push(pl);
      }
    } else {
      // roof
      boxAt(hx * 2 + 0.3, 0.4, hz * 2 + 0.3, 0, -0.2, 0, mats.concrete, { receive: true });
      const deck = new Mesh(own(new PlaneGeometry(hx * 2 - 0.4, hz * 2 - 0.4).rotateX(-Math.PI / 2)), mats.roof);
      deck.position.y = 0.015;
      deck.receiveShadow = true;
      g.add(deck);
      buildBand(g, mats.band, hx, hz, -0.45, 1.1, 0.3, own, ls);
      // elevator / stair penthouse
      boxAt(innerW, 3.0, innerD, ocx, 1.5, ocz, mats.coreConcrete, {});
      boxAt(innerW + 0.3, 0.18, innerD + 0.3, ocx, 3.09, ocz, mats.band, {});
      rect(1.1, hx + 0.16, hz + 0.16);
      rect(-0.45, hx + 0.16, hz + 0.16);
    }

    // lines
    if (segs.length) {
      const lg = own(new LineSegmentsGeometry());
      lg.setPositions(segs);
      const lines = new LineSegments2(lg, lineMat);
      if (L.kind === 'plant') {
        // below grade: dashed and quieter, like the blueprint's hidden lines
        lineMat.dashed = true;
        lineMat.dashSize = 0.55;
        lineMat.gapSize = 0.4;
        lines.computeLineDistances();
        ls.lineScale = 0.5;
      }
      lines.renderOrder = 6;
      lines.frustumCulled = false;
      g.add(lines);
      ls.lines = lines;
    }
    casters.push(...ls.casters);
  }

  /* ── per-frame updates ──────────────────────────────────────── */

  const tmpC = new Color();
  function writeZones(state, dt) {
    const sz = state?.zones || {};
    for (let i = 0; i < zones.length; i++) {
      const z = zones[i];
      const s = sz[z.id] || {};
      const st = zs[i];
      const temp = finite(s.temp, 72);
      const sp = finite(s.sp, 72);
      thermalColor(temp - sp, tmpC);
      st.thermal.lerp(tmpC, 1 - Math.exp(-6 * dt));
      st.lights = damp(st.lights, s.lights ? 1 : 0, 4, dt);
      const alarmOn = !!s.alarm || s.status === 'alarm';
      st.alarm = damp(st.alarm, alarmOn ? 1 : 0, 6, dt);
      const hv = z.id === hl.selected || z.vav === hl.selected ? 1 : z.id === hl.hover || z.vav === hl.hover ? 0.55 : 0;
      st.hover = damp(st.hover, hv, 12, dt);
      st.occ = damp(st.occ, clamp(finite(s.occ, 0), 0, 1), 3, dt);
      st.reheat = damp(st.reheat, clamp(finite(s.reheat, 0) / 100, 0, 1), 3, dt);
      st.damper = damp(st.damper, clamp(finite(s.damper, 0) / 100, 0, 1), 3, dt);
      const cfmFrac = clamp(finite(s.cfm, 0) / Math.max(1, finite(s.cfmMax, 1)), 0, 1);
      const o0 = i * 4;
      const o1 = (ZONE_TEX_W + i) * 4;
      const o2 = (ZONE_TEX_W * 2 + i) * 4;
      zoneData[o0] = st.thermal.r;
      zoneData[o0 + 1] = st.thermal.g;
      zoneData[o0 + 2] = st.thermal.b;
      zoneData[o0 + 3] = st.lights;
      zoneData[o1] = st.alarm;
      zoneData[o1 + 1] = st.hover;
      zoneData[o1 + 2] = st.occ;
      zoneData[o1 + 3] = clamp((temp - sp) / 3, -1, 1);
      zoneData[o2] = st.reheat;
      zoneData[o2 + 1] = st.damper;
      zoneData[o2 + 2] = cfmFrac;
      zoneData[o2 + 3] = 0;
    }
    zoneTex.needsUpdate = true;
  }

  const world = {
    root,
    levelGroups,
    levelState,
    equipment,
    zoneIndex,
    vavIndex,
    zoneTex,
    pickZoneMeshes,
    pickVavMeshes,
    lineMats: allLineMats,
    casters,
    setHover(id) {
      hl.hover = id || null;
    },
    setSelected(id) {
      hl.selected = id || null;
    },
    /** Current vertical shift of a level (intro drop + exploded offset). */
    levelShift(li) {
      const g = levelGroups[li];
      return g ? g.position.y - levels.list[li].y : 0;
    },
    update(state, dt, t, opts) {
      writeZones(state, dt);
      const { reducedMotion, mode } = opts;
      for (const ls of levelState) {
        if (ls.people) updatePeople(ls.people, zs, dt, t, reducedMotion);
        // landing flash on the blueprint lines
        ls.flash = Math.max(0, ls.flash - dt * 1.4);
      }
    },
    /** intro: per-level progress 0..1 (drop + dissolve); lines lead the solids. */
    setLevelIntro(li, r, dropDist) {
      const ls = levelState[li];
      const solid = clamp((r - 0.18) / 0.82, 0, 1);
      ls.reveal.value = solid;
      ls.drop = (1 - easeOut(solid)) * dropDist;
      // every level's blueprint outline is drawn from the first frame (in place);
      // the solids then drop into it
      ls.lineVis = Math.max(clamp(r / 0.3, 0, 1), 0.35);
      levelGroups[li].visible = true;
      const solidVis = solid > 0.001;
      if (ls.solidVis !== solidVis) {
        ls.solidVis = solidVis;
        for (const c of levelGroups[li].children) if (c !== ls.lines) c.visible = solidVis;
        if (ls.volumes) ls.volumes.visible = false; // setModeVisuals owns it from here
      }
      if (ls.lastSolid !== undefined && ls.lastSolid < 1 && solid >= 1) ls.flash = 1;
      ls.lastSolid = solid;
      const done = solid >= 0.999;
      if (ls.castDone !== done) {
        ls.castDone = done;
        for (const m of ls.casters) m.castShadow = done;
      }
    },
    applyLevelTransforms(explodeOffsets, explodeAmt) {
      // the slab edges carry the silhouette at night
      const nightLift = 1 + 0.5 * finite(ctxU.night.value, 0);
      for (let i = 0; i < levelState.length; i++) {
        const ls = levelState[i];
        ls.explode = explodeOffsets[i] * explodeAmt;
        levelGroups[i].position.y = levels.list[i].y + ls.drop + ls.explode;
        ls.levelY.value = levelGroups[i].position.y;
        // the outline stays put while the level drops into it
        if (ls.lines) ls.lines.position.y = -ls.drop;
        if (ls.lights) for (const pl of ls.lights) pl.position.y = levelGroups[i].position.y + pl.userData.localY;
        const base = 0.9 * (ls.lineVis ?? 1) * ls.lineScale;
        ls.lineMat.opacity = base;
        const flash = 1 + ls.flash * 2.5;
        ls.lineMat.color.copy(PALETTE.accent).multiplyScalar(1.25 * flash * nightLift);
      }
    },
    /** Forget cached intro visibility (after something forced every object visible). */
    resetIntro() {
      for (const ls of levelState) ls.solidVis = undefined;
    },
    /** Section cut for basement focus: fades the L1–L2 interiors (0..1). */
    setSectionCut(v) {
      for (const ls of levelState) if (ls.id === 'L1' || ls.id === 'L2') ls.cut.value = v;
    },
    setModeVisuals({ thermal, air, explode, xray }) {
      for (const ls of levelState) {
        if (ls.volumes) ls.volumes.visible = thermal > 0.01 && ls.solidVis !== false;
        const m = ls.mats;
        m.glass.uniforms.uOpacity.value = 1 - 0.72 * air - 0.35 * thermal - 0.15 * explode;
        m.shaft.uniforms.uOpacity.value = 1 - 0.6 * air;
        m.ghost.uniforms.uOpacity.value = 0.7 + 0.3 * xray;
      }
    },
    setLineResolution(w, h) {
      for (const m of allLineMats) m.resolution.set(w, h);
    },
    setPixelRatio() {
      /* the units chunk scales the tower plume itself (units.setPixelRatio) */
    },
    /** The units chunk: bboxFor and picking ask it first. */
    attachUnits(u) {
      units = u;
    },
    /** Register a built unit (ClarityView model or its proxy) on its level. */
    addUnit(host) {
      const ls = levelState[host.li];
      const entry = { id: host.id, host, level: host.li };
      for (const id of [host.id, ...(host.unit.aliases || []), ...host.subs.map((x) => x.id)]) equipment.set(id, entry);
      host.holder.visible = ls.solidVis !== false;
      for (const m of host.casters) {
        if (ls.castDone !== undefined) m.castShadow = ls.castDone;
        ls.casters.push(m);
        casters.push(m);
      }
    },
    /** The baked VAV terminal (inlet collar at the origin, +x downstream) for every zone. */
    setVavGeometry(geo, box) {
      if (!geo) return;
      own(geo);
      const pick = own(boxOf(box || (geo.computeBoundingBox(), geo.boundingBox)));
      for (const v of vavMeshes) {
        const g2 = shareGeometry(geo);
        g2.setAttribute('aZone', v.aZone);
        own(g2);
        v.mesh.geometry = g2;
        v.picks.geometry = pick;
      }
    },
    /** B1 x-ray silhouettes, rebuilt from each plant unit's baked geometry ({ li, geometry } level-local). */
    setPlantXray(list) {
      const byLevel = new Map();
      for (const it of list || []) {
        if (!it?.geometry) continue;
        if (!byLevel.has(it.li)) byLevel.set(it.li, []);
        byLevel.get(it.li).push(it.geometry);
      }
      for (const [li, geos] of byLevel) {
        const ls = levelState[li];
        if (!ls || ls.kind !== 'plant') continue;
        if (ls.xray) {
          ls.xray.removeFromParent();
          ls.xray.geometry.dispose();
        }
        const xr = buildXrayMesh(geos, own);
        if (xr) {
          xr.visible = ls.solidVis !== false;
          levelGroups[li].add(xr);
          ls.xray = xr;
        }
      }
    },
    /** Fallback when the units chunk is unavailable: the layout's equipment as neutral boxes. */
    addProxyEquipment() {
      for (const eq of layout.equipment) {
        if (equipment.has(eq.id)) continue;
        const li = levels.byId.get(eq.level);
        if (li === undefined) continue;
        const ls = levelState[li];
        const mat = own(patchReveal(new MeshStandardMaterial({ color: eq.kind === 'ahu' ? '#6d7c8c' : '#5f7488', roughness: 0.6, metalness: 0.3 }), ls.reveal));
        const mesh = new Mesh(own(new BoxGeometry(eq.w, eq.h, eq.d).translate(0, eq.h / 2, 0)), mat);
        mesh.position.set(eq.x, eq.y - levels.list[li].y, eq.z);
        mesh.rotation.y = finite(eq.rotY, 0);
        mesh.castShadow = true;
        mesh.userData.pickId = eq.id;
        mesh.visible = ls.solidVis !== false;
        levelGroups[li].add(mesh);
        ls.casters.push(mesh);
        casters.push(mesh);
        equipment.set(eq.id, { id: eq.id, eq, proxy: mesh, level: li });
      }
    },
    /** Equipment under the ray: { id, d } (units: boxes; proxies: their box). */
    pickEquipment(raycaster) {
      let best = units ? units.pick(raycaster) : null;
      for (const it of equipment.values()) {
        if (!it.proxy || !it.proxy.parent?.visible) continue;
        const h = raycaster.intersectObject(it.proxy, false)[0];
        if (h && (!best || h.distance < best.d)) best = { id: it.id, d: h.distance };
      }
      return best;
    },
    /** World-space box for an id (zone, VAV, equipment, level, building). */
    bboxFor(id, outCenter, outSize) {
      if (!id) return false;
      if (zoneIndex.has(id)) {
        const z = zones[zoneIndex.get(id)];
        const li = levels.byId.get(z.level);
        const L = levels.list[li];
        const H = levels.list[li + 1] ? levels.list[li + 1].y - L.y : 4;
        outCenter.set((z.x0 + z.x1) / 2, L.y + H / 2 + this.levelShift(li), (z.z0 + z.z1) / 2);
        outSize.set(z.x1 - z.x0, H, z.z1 - z.z0);
        return true;
      }
      if (vavIndex.has(id)) {
        const z = zones[vavIndex.get(id)];
        const li = levels.byId.get(z.level);
        const p = z.vavPos || [(z.x0 + z.x1) / 2, levels.list[li].y + 3.4, (z.z0 + z.z1) / 2];
        outCenter.set(p[0], p[1] + this.levelShift(li), p[2]);
        outSize.set(1.6, 0.8, 1.6);
        return true;
      }
      if (units && units.bboxFor(id, outCenter, outSize)) return true;
      if (equipment.has(id) && equipment.get(id).eq) {
        const { eq, level } = equipment.get(id);
        const rotQ = Math.abs(Math.sin(finite(eq.rotY, 0))) > 0.5;
        outCenter.set(eq.x, eq.y + eq.h / 2 + this.levelShift(level), eq.z);
        outSize.set(rotQ ? eq.d : eq.w, eq.h, rotQ ? eq.w : eq.d);
        return true;
      }
      if (levels.byId.has(id)) {
        const li = levels.byId.get(id);
        const L = levels.list[li];
        const H = L.kind === 'roof' ? 4 : levels.list[li + 1] ? levels.list[li + 1].y - L.y : 4;
        outCenter.set(0, L.y + H / 2 + this.levelShift(li), 0);
        outSize.set(hx * 2, H, hz * 2);
        return true;
      }
      if (id === 'building') {
        outCenter.set(0, 12, 0);
        outSize.set(hx * 2, 30, hz * 2);
        return true;
      }
      return false;
    },
    dispose() {
      root.traverse((o) => {
        if (o.isMesh || o.isLine || o.isPoints) {
          if (o.geometry) disposables.add(o.geometry);
          const ms = Array.isArray(o.material) ? o.material : [o.material];
          ms.forEach((mm) => mm && disposables.add(mm));
        }
        if (o.isInstancedMesh) o.dispose?.();
      });
      for (const d of disposables) d?.dispose?.();
      disposables.clear();
      root.removeFromParent();
    },
  };
  return world;
}

const easeOut = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);

/* ── geometry builders ─────────────────────────────────────────── */

function withPart(geo, part) {
  const n = geo.attributes.position.count;
  geo.setAttribute('aPart', new BufferAttribute(new Float32Array(n).fill(part), 1));
  return geo;
}

/** A geometry that shares another's attributes (its own instanced attributes can then be added). */
function shareGeometry(src) {
  const g = new BufferGeometry();
  for (const [k, v] of Object.entries(src.attributes)) g.setAttribute(k, v);
  if (src.index) g.setIndex(src.index);
  g.boundingBox = src.boundingBox?.clone() || null;
  g.boundingSphere = src.boundingSphere?.clone() || null;
  return g;
}
function boxOf(b) {
  const sx = Math.max(0.05, b.max.x - b.min.x);
  const sy = Math.max(0.05, b.max.y - b.min.y);
  const sz = Math.max(0.05, b.max.z - b.min.z);
  return new BoxGeometry(sx, sy, sz).translate((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
}

function makeDeskGeometry() {
  const parts = [];
  const top = new BoxGeometry(1.5, 0.05, 0.72).translate(0, 0.74, 0);
  const legL = new BoxGeometry(0.04, 0.72, 0.66).translate(-0.72, 0.36, 0);
  const legR = new BoxGeometry(0.04, 0.72, 0.66).translate(0.72, 0.36, 0);
  const screen = new BoxGeometry(0.62, 0.36, 0.03).translate(0, 0.99, -0.26);
  const stand = new BoxGeometry(0.05, 0.2, 0.05).translate(0, 0.86, -0.28);
  const chair = new BoxGeometry(0.46, 0.08, 0.46).translate(0, 0.46, 0.66);
  const back = new BoxGeometry(0.46, 0.5, 0.06).translate(0, 0.74, 0.88);
  parts.push(withPart(top, 0), withPart(legL, 0), withPart(legR, 0), withPart(stand, 2), withPart(screen, 1), withPart(chair, 2), withPart(back, 2));
  // all parts are indexed boxes: merge them indexed (fewer vertices to shade)
  const g = mergeGeometries(parts);
  parts.forEach((p) => p.dispose());
  return g;
}

function makePersonGeometry(quality) {
  const low = quality === 'low';
  const body = new CapsuleGeometry(0.16, 0.92, low ? 1 : 2, low ? 6 : 8).translate(0, 0.62, 0);
  const head = new SphereGeometry(0.13, low ? 6 : 8, low ? 4 : 6).translate(0, 1.47, 0);
  withPart(body, 0);
  withPart(head, 1);
  // both parts are indexed with the same attributes: merge them as they are
  const g = mergeGeometries([body, head]);
  body.dispose();
  head.dispose();
  return g;
}

function makeVavGeometry() {
  const box = new BoxGeometry(1.25, 0.42, 0.66);
  const coil = new BoxGeometry(0.08, 0.38, 0.62).translate(0.66, 0, 0);
  const inlet = new BoxGeometry(0.3, 0.26, 0.26).translate(-0.76, 0, 0);
  const diff = new BoxGeometry(0.62, 0.05, 0.62).translate(0.2, -0.44, 0);
  const neck = new BoxGeometry(0.22, 0.24, 0.22).translate(0.2, -0.32, 0);
  const g = mergeGeometries([withPart(box, 0), withPart(coil, 1), withPart(inlet, 0), withPart(neck, 0), withPart(diff, 2)].map((p) => p.toNonIndexed()));
  g.deleteAttribute('uv');
  // the same per-vertex colour attribute the baked ClarityView terminal carries
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([0.36, 0.4, 0.45], i * 3);
  g.setAttribute('aCol', new BufferAttribute(col, 3));
  return g;
}

/* ── shell pieces ──────────────────────────────────────────────── */

function buildBand(g, mat, hx, hz, y0, y1, t, own, ls) {
  const h = y1 - y0;
  const cy = (y0 + y1) / 2;
  const geos = [
    new BoxGeometry(hx * 2 + t * 2 + 0.06, h, t).translate(0, cy, hz + t / 2 - 0.02),
    new BoxGeometry(hx * 2 + t * 2 + 0.06, h, t).translate(0, cy, -hz - t / 2 + 0.02),
    new BoxGeometry(t, h, hz * 2 + 0.02).translate(hx + t / 2 - 0.02, cy, 0),
    new BoxGeometry(t, h, hz * 2 + 0.02).translate(-hx - t / 2 + 0.02, cy, 0),
  ];
  const merged = own(mergeGeometries(geos));
  geos.forEach((x) => x.dispose());
  const mesh = new Mesh(merged, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  ls.casters.push(mesh);
  g.add(mesh);
  return mesh;
}

/**
 * Curtain wall: 2 m bays of glass (one instanced quad per bay, each mapped
 * to the zone behind it) and aluminium mullions at every bay line.
 */
function buildCurtainWall(g, mats, hx, hz, y0, y1, zones, L, own, ls) {
  const bay = 2;
  const h = y1 - y0;
  const cy = (y0 + y1) / 2;
  const bays = [];
  const facades = [
    { axis: 'x', fixed: hz, sign: 1, len: hx * 2, rot: 0 }, // south (+z)
    { axis: 'x', fixed: -hz, sign: -1, len: hx * 2, rot: Math.PI }, // north
    { axis: 'z', fixed: hx, sign: 1, len: hz * 2, rot: Math.PI / 2 }, // east (+x)
    { axis: 'z', fixed: -hx, sign: -1, len: hz * 2, rot: -Math.PI / 2 }, // west
  ];
  const mull = [];
  for (const f of facades) {
    const n = Math.round(f.len / bay);
    for (let i = 0; i < n; i++) {
      const u = -f.len / 2 + bay * (i + 0.5);
      const x = f.axis === 'x' ? u : f.fixed;
      const z = f.axis === 'x' ? f.fixed : u;
      // the zone behind this bay
      const px = f.axis === 'x' ? u : f.fixed - f.sign * 0.6;
      const pz = f.axis === 'x' ? f.fixed - f.sign * 0.6 : u;
      const zone = zones.find((zz) => zz.level === L.id && px >= zz.x0 - 1e-3 && px <= zz.x1 + 1e-3 && pz >= zz.z0 - 1e-3 && pz <= zz.z1 + 1e-3);
      bays.push({ x, z, rot: f.rot, zone });
    }
    for (let i = 1; i < n; i++) {
      const u = -f.len / 2 + bay * i;
      mull.push(f.axis === 'x' ? [u, f.fixed, 0.07, 0.2] : [f.fixed, u, 0.2, 0.07]);
    }
  }
  for (const [x, z] of [
    [hx, hz],
    [-hx, hz],
    [hx, -hz],
    [-hx, -hz],
  ])
    mull.push([x, z, 0.26, 0.26]);

  const zoneIdx = new Map();
  zones.forEach((z, i) => zoneIdx.set(z.id, i));
  const glassGeo = own(new PlaneGeometry(1, 1));
  const glass = new InstancedMesh(glassGeo, mats.glass, bays.length);
  const o = new Object3D();
  const aZone = new Float32Array(bays.length);
  const aSeed = new Float32Array(bays.length);
  const r = rng(99 + Math.round(L.y * 7));
  bays.forEach((b, i) => {
    o.position.set(b.x, cy, b.z);
    o.rotation.set(0, b.rot, 0);
    o.scale.set(bay - 0.06, h, 1);
    o.updateMatrix();
    glass.setMatrixAt(i, o.matrix);
    aZone[i] = b.zone ? zoneIdx.get(b.zone.id) : 63;
    aSeed[i] = r();
  });
  glassGeo.setAttribute('aZone', new InstancedBufferAttribute(aZone, 1));
  glassGeo.setAttribute('aSeed', new InstancedBufferAttribute(aSeed, 1));
  glass.renderOrder = 5;
  glass.castShadow = false;
  glass.frustumCulled = false;
  g.add(glass);

  const mGeo = own(new BoxGeometry(1, 1, 1));
  const mullions = new InstancedMesh(mGeo, mats.mullion, mull.length);
  mull.forEach(([x, z, w, d], i) => {
    o.position.set(x, cy, z);
    o.rotation.set(0, 0, 0);
    o.scale.set(w, h, d);
    o.updateMatrix();
    mullions.setMatrixAt(i, o.matrix);
  });
  mullions.castShadow = false;
  mullions.receiveShadow = false;
  g.add(mullions);
  return glass;
}

function buildLobbyCanopy(g, mats, hx, hz, zones, own, ls, segs) {
  // cantilevered entrance canopy on the south (street) side
  const w = 14;
  const d = 3.2;
  const y = 3.35;
  const geo = own(new BoxGeometry(w, 0.22, d).translate(0, y, hz + d / 2 + 0.2));
  const mesh = new Mesh(geo, mats.band);
  mesh.castShadow = true;
  ls.casters.push(mesh);
  g.add(mesh);
  const lit = own(new PlaneGeometry(w - 0.6, d - 0.5).rotateX(Math.PI / 2).translate(0, y - 0.115, hz + d / 2 + 0.2));
  const litMat = own(new MeshBasicMaterial({ color: new Color('#ffd7a8').multiplyScalar(1.6), side: DoubleSide }));
  g.add(new Mesh(lit, litMat));
  segs.push(-w / 2, y + 0.11, hz + d + 0.2, w / 2, y + 0.11, hz + d + 0.2);
}

function buildPlantExtras(g, mats, hx, hz, own, ls) {
  // switchgear line-up along the north wall, a BAS field panel, expansion tank
  const gear = own(new MeshStandardMaterial({ color: '#59616d', roughness: 0.55, metalness: 0.4 }));
  const ledMat = own(new MeshBasicMaterial({ color: new Color('#2ad1a6').multiplyScalar(2.4) }));
  const panelMat = own(new MeshStandardMaterial({ color: '#c9ced6', roughness: 0.5, metalness: 0.2 }));
  const tankMat = own(new MeshStandardMaterial({ color: '#b0473a', roughness: 0.45, metalness: 0.3 }));
  for (const m of [gear, panelMat, tankMat]) patchReveal(m, ls.reveal);
  const parts = [];
  for (let i = 0; i < 6; i++) parts.push(new BoxGeometry(0.9, 2.2, 0.7).translate(-17.5 + i * 0.95, 1.1, -hz + 0.6));
  const sw = new Mesh(own(mergeGeometries(parts)), gear);
  parts.forEach((p) => p.dispose());
  sw.castShadow = true;
  ls.casters.push(sw);
  g.add(sw);
  const leds = [];
  for (let i = 0; i < 6; i++) leds.push(new BoxGeometry(0.06, 0.06, 0.02).translate(-17.5 + i * 0.95 + 0.25, 1.85, -hz + 0.96));
  g.add(new Mesh(own(mergeGeometries(leds)), ledMat));
  leds.forEach((p) => p.dispose());
  // BAS field panel (PXC) on the west wall
  const panel = new Mesh(own(new BoxGeometry(0.25, 1.2, 0.9).translate(-hx + 0.35, 1.6, -2.6)), panelMat);
  g.add(panel);
  const pl = [];
  for (let i = 0; i < 8; i++) pl.push(new BoxGeometry(0.02, 0.05, 0.05).translate(-hx + 0.49, 1.95 - i * 0.09, -2.9));
  g.add(new Mesh(own(mergeGeometries(pl)), ledMat));
  pl.forEach((p) => p.dispose());
  // expansion tank + air separator by the heating hot water plant
  const tank = new Mesh(own(new CapsuleGeometry(0.45, 0.9, 4, 14).translate(-8.6, 0.9, 9.5)), tankMat);
  tank.castShadow = true;
  ls.casters.push(tank);
  g.add(tank);
}

/** One additive rim-lit silhouette mesh from level-local geometries (position + normal). */
function buildXrayMesh(geos, own) {
  const parts = geos.filter((g) => g?.attributes?.position && g.attributes.normal);
  if (!parts.length) return null;
  const geo = own(parts.length === 1 ? parts[0] : mergeGeometries(parts));
  if (!geo) return null;
  const mat = own(
    new ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthFunc: GreaterDepth,
      blending: AdditiveBlending,
      uniforms: { uColor: { value: PALETTE.accentSoft.clone() }, uAmt: { value: 1 } },
      vertexShader: /* glsl */ `
        varying vec3 vN; varying vec3 vWP;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWP = wp.xyz;
          vN = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uAmt;
        varying vec3 vN; varying vec3 vWP;
        void main() {
          vec3 V = normalize(cameraPosition - vWP);
          float rim = pow(1.0 - abs(dot(normalize(vN), V)), 2.2);
          gl_FragColor = vec4(uColor * (0.018 + rim * 0.2) * uAmt, 1.0);
        }`,
    }),
  );
  const mesh = new Mesh(geo, mat);
  mesh.renderOrder = 9;
  mesh.frustumCulled = false;
  return mesh;
}

/* ── occupants ─────────────────────────────────────────────────── */

function buildPeople(g, geo, mat, lz, seats, zoneIndex, rand, own) {
  const count = lz.length * PEOPLE_PER_ZONE;
  const mesh = new InstancedMesh(geo.clone(), mat, count);
  own(mesh.geometry);
  const aZone = new Float32Array(count);
  const aSeed = new Float32Array(count);
  const people = [];
  lz.forEach((z, zi) => {
    const s = seats[zi] || [];
    const order = s.map((_, i) => i).sort(() => rand() - 0.5);
    for (let k = 0; k < PEOPLE_PER_ZONE; k++) {
      const idx = zi * PEOPLE_PER_ZONE + k;
      const seated = k < Math.min(3, s.length) && rand() < 0.85;
      const seat = seated ? s[order[k % s.length]] : null;
      const p = {
        zone: zoneIndex.get(z.id),
        rank: rand(),
        seated,
        x: seat ? seat[0] : z.x0 + 1.2 + rand() * (z.x1 - z.x0 - 2.4),
        z: seat ? seat[1] : z.z0 + 1.2 + rand() * (z.z1 - z.z0 - 2.4),
        tx: 0,
        tz: 0,
        speed: 0.7 + rand() * 0.5,
        wait: rand() * 3,
        vis: 0,
        bounds: [z.x0 + 1.0, z.x1 - 1.0, z.z0 + 1.0, z.z1 - 1.0],
        phase: rand() * Math.PI * 2,
      };
      p.tx = p.x;
      p.tz = p.z;
      people.push(p);
      aZone[idx] = p.zone;
      aSeed[idx] = rand();
    }
  });
  mesh.geometry.setAttribute('aZone', new InstancedBufferAttribute(aZone, 1));
  mesh.geometry.setAttribute('aSeed', new InstancedBufferAttribute(aSeed, 1));
  mesh.castShadow = false;
  mesh.frustumCulled = false;
  const arr = mesh.instanceMatrix.array;
  for (let i = 0; i < count; i++) arr.fill(0, i * 16, i * 16 + 16);
  mesh.instanceMatrix.needsUpdate = true;
  g.add(mesh);
  return { mesh, people, rand };
}

function updatePeople(P, zs, dt, t, reducedMotion) {
  const arr = P.mesh.instanceMatrix.array;
  const pace = reducedMotion ? 0.35 : 1;
  for (let i = 0; i < P.people.length; i++) {
    const p = P.people[i];
    const occ = zs[p.zone]?.occ ?? 0;
    // the first `occ` fraction of people (by rank) is present
    const want = p.rank < occ * 0.95 ? 1 : 0;
    p.vis = damp(p.vis, want, 3, dt);
    if (!p.seated && p.vis > 0.01) {
      const dx = p.tx - p.x;
      const dz = p.tz - p.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.15) {
        p.wait -= dt;
        if (p.wait <= 0) {
          const [x0, x1, z0, z1] = p.bounds;
          p.tx = x0 + P.rand() * (x1 - x0);
          p.tz = z0 + P.rand() * (z1 - z0);
          p.wait = 1.5 + P.rand() * 5;
        }
      } else {
        const step = Math.min(d, p.speed * pace * dt);
        p.x += (dx / d) * step;
        p.z += (dz / d) * step;
      }
    }
    const s = p.vis < 0.02 ? 0 : p.vis;
    const sy = p.seated ? 0.8 : 1;
    const bob = p.seated ? 0 : Math.abs(Math.sin(t * 6 * pace + p.phase)) * 0.03;
    const o = i * 16;
    arr[o] = s;
    arr[o + 1] = 0;
    arr[o + 2] = 0;
    arr[o + 3] = 0;
    arr[o + 4] = 0;
    arr[o + 5] = s * sy;
    arr[o + 6] = 0;
    arr[o + 7] = 0;
    arr[o + 8] = 0;
    arr[o + 9] = 0;
    arr[o + 10] = s;
    arr[o + 11] = 0;
    arr[o + 12] = p.x;
    arr[o + 13] = (p.seated ? 0.12 : 0) + bob;
    arr[o + 14] = p.z;
    arr[o + 15] = 1;
  }
  P.mesh.instanceMatrix.needsUpdate = true;
}

/* ── custom materials ─────────────────────────────────────────── */

function makeFloorMaterial(uniforms) {
  return new ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      attribute float aZone; attribute vec2 aSize;
      ${ZONE_VERT}
      varying vec2 vUv; varying vec2 vSize; varying vec4 vZ0; varying vec4 vZ1; varying vec3 vBuildP;
      void main() {
        vUv = uv; vSize = aSize;
        vZ0 = zoneRow(aZone, 0.0);
        vZ1 = zoneRow(aZone, 1.0);
        vec4 lp = instanceMatrix * vec4(position, 1.0);
        vBuildP = lp.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * lp;
      }`,
    fragmentShader: /* glsl */ `
      ${FRAG_HEAD}
      varying vec2 vUv; varying vec2 vSize; varying vec4 vZ0; varying vec4 vZ1;
      void main() {
        ${GLSL_DISSOLVE}
        vec2 m = vec2(min(vUv.x, 1.0 - vUv.x) * vSize.x, min(vUv.y, 1.0 - vUv.y) * vSize.y);
        float e = min(m.x, m.y);
        float lights = vZ0.a;
        vec2 lp = vUv * vSize;
        vec2 c = abs(fract(lp / 2.5) - 0.5) * 2.0;
        float pool = 1.0 - smoothstep(0.15, 1.0, length(c));
        vec3 col = vec3(0.04, 0.045, 0.054) * (0.8 + 1.5 * uDay);
        // lit floors glow warm as daylight goes (dusk counts, not just full night)
        col += vec3(1.0, 0.8, 0.58) * lights * (0.035 + 0.05 * pool) * (0.6 + 0.9 * (1.0 - uDay));
        vec3 th = vZ0.rgb;
        float dev = thermalDev(vZ1.a);
        float border = 1.0 - smoothstep(0.0, 0.14, e);
        // thermal: each zone becomes one solid heat-map cell
        col = mix(col, th * (0.15 + 0.46 * dev), uThermal * 0.95);
        col += th * border * (0.4 + 1.2 * dev) * uThermal;
        col *= 1.0 - 0.5 * uAir;
        col += uAccent * vZ1.g * (0.05 + border * 1.2);
        float pulse = vZ1.r * (0.55 + 0.45 * sin(uTime * 5.0));
        col += uAlarm * pulse * (0.16 + border * 1.6);
        col += ${EDGE_GLOW};
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
}

function makeGlassMaterial(uniforms) {
  return new ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    vertexShader: /* glsl */ `
      attribute float aZone; attribute float aSeed;
      ${ZONE_VERT}
      varying vec3 vWP; varying vec3 vN; varying vec2 vUv; varying float vSeed; varying vec4 vZ0; varying vec4 vZ1; varying vec3 vBuildP;
      void main() {
        vUv = uv; vSeed = aSeed;
        vZ0 = zoneRow(aZone, 0.0);
        vZ1 = zoneRow(aZone, 1.0);
        vec4 lp = instanceMatrix * vec4(position, 1.0);
        vBuildP = lp.xyz;
        vec4 wp = modelMatrix * lp;
        vWP = wp.xyz;
        vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      ${FRAG_HEAD}
      uniform vec3 uSunDir, uSunCol, uSkyTop, uSkyHor;
      uniform float uOpacity, uCut;
      varying vec3 vWP; varying vec3 vN; varying vec2 vUv; varying float vSeed; varying vec4 vZ0; varying vec4 vZ1;
      void main() {
        ${GLSL_DISSOLVE}
        vec3 V = normalize(cameraPosition - vWP);
        vec3 N = normalize(vN);
        bool inside = dot(N, V) < 0.0;
        if (inside) N = -N;
        float ndv = clamp(dot(N, V), 0.0, 1.0);
        float fres = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);
        vec3 R = reflect(-V, N);
        vec3 sky = R.y > 0.0 ? mix(uSkyHor, uSkyTop, pow(clamp(R.y, 0.0, 1.0), 0.5)) : mix(uSkyHor * 0.6, vec3(0.012, 0.016, 0.024), clamp(-R.y * 3.0, 0.0, 1.0));
        sky *= 1.6;
        float glint = pow(max(dot(R, uSunDir), 0.0), 380.0);
        sky += uSunCol * glint * 5.0 * uDay;
        // soft horizon streak reflected across the facade
        sky += uSkyHor * 0.8 * exp(-abs(R.y) * 10.0);
        float lights = vZ0.a;
        // ceiling light band + slight per-bay variation, some blinds half down
        float band = smoothstep(0.55, 0.97, vUv.y);
        float blind = step(0.72, vSeed) * step(1.0 - (0.25 + 0.4 * fract(vSeed * 7.0)), vUv.y);
        vec3 warm = vec3(1.0, 0.76, 0.5);
        // interior light shows as soon as daylight fades (dusk), strongest at night
        float dusk = 1.0 - uDay;
        vec3 interior = warm * lights * (0.10 + 0.55 * band) * (0.65 + 0.55 * vSeed) * (0.35 + 0.95 * dusk);
        interior *= 1.0 - 0.6 * blind;
        vec3 tint = vec3(0.05, 0.085, 0.12);
        vec3 col = tint * (0.25 + 0.6 * uDay) + sky * fres + interior;
        col += vec3(0.25, 0.3, 0.36) * blind * (0.05 + 0.15 * uDay);
        float alpha = mix(0.2, 0.86, fres) + lights * 0.22 * (0.4 + dusk) + blind * 0.25;
        // thermal: the facade becomes the heat map of the zones behind it
        vec3 th = vZ0.rgb;
        float dev = thermalDev(vZ1.a);
        col = mix(col, th * (0.14 + 0.6 * dev), uThermal * (0.4 + 0.45 * dev));
        alpha = mix(alpha, 0.14 + 0.15 * fres + 0.25 * dev, uThermal * 0.7);
        // hover / alarm
        col += uAccent * vZ1.g * 0.35;
        alpha += vZ1.g * 0.12;
        float pulse = vZ1.r * (0.55 + 0.45 * sin(uTime * 5.0));
        col += uAlarm * pulse * 1.1;
        alpha += pulse * 0.25;
        if (inside) alpha *= 0.5;
        alpha *= 1.0 - 0.75 * uCut;
        col += ${EDGE_GLOW};
        gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0) * uOpacity + bEdge);
      }`,
  });
}

function makeShaftMaterial(uniforms) {
  return new ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec3 vWP; varying vec3 vN; varying vec3 vBuildP;
      void main() {
        vBuildP = position;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWP = wp.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      ${FRAG_HEAD}
      uniform float uOpacity;
      varying vec3 vWP; varying vec3 vN;
      void main() {
        ${GLSL_DISSOLVE}
        vec3 V = normalize(cameraPosition - vWP);
        float f = pow(1.0 - abs(dot(normalize(vN), V)), 2.0);
        vec3 col = vec3(0.10, 0.16, 0.24) * (0.4 + 0.6 * uDay) + uAccent * f * 0.12;
        // lit stair / lift cores keep the tower's spine readable after dark
        float landing = smoothstep(0.82, 0.97, fract(vBuildP.y / 1.9 + 0.08));
        col += vec3(0.62, 0.78, 1.0) * (0.07 + 0.16 * landing) * (1.0 - uDay);
        float a = (0.16 + 0.3 * f + 0.14 * (1.0 - uDay)) * uOpacity;
        col += ${EDGE_GLOW};
        gl_FragColor = vec4(col, a + bEdge);
      }`,
  });
}

function makeGhostWallMaterial(uniforms) {
  return new ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    side: FrontSide,
    extensions: { derivatives: true },
    vertexShader: /* glsl */ `
      varying vec3 vWP; varying vec3 vN; varying vec3 vBuildP;
      void main() {
        vBuildP = position;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWP = wp.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      ${FRAG_HEAD}
      uniform float uOpacity;
      varying vec3 vWP; varying vec3 vN;
      void main() {
        ${GLSL_DISSOLVE}
        vec3 N = normalize(vN);
        if (N.y > 0.5) discard; // open top: the L1 slab is the ceiling
        vec3 V = normalize(cameraPosition - vWP);
        float f = pow(1.0 - abs(dot(N, V)), 2.0);
        vec2 p = abs(N.x) > 0.5 ? vWP.zy : vWP.xy;
        vec2 g = abs(fract(p / 1.5 - 0.5) - 0.5) * 1.5;
        vec2 fw = fwidth(p);
        float line = 1.0 - min(smoothstep(0.0, fw.x * 1.2, g.x), smoothstep(0.0, fw.y * 1.2, g.y));
        vec3 col = vec3(0.03, 0.06, 0.1) + uAccent * (line * 0.3 + f * 0.12);
        float a = (0.06 + line * 0.14 + f * 0.12) * uOpacity;
        if (N.y < -0.5) { col = vec3(0.02, 0.03, 0.05); a = 0.0; }
        col += ${EDGE_GLOW};
        gl_FragColor = vec4(col, a + bEdge);
      }`,
  });
}

function makeDeskMaterial(uniforms) {
  return new ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      attribute float aZone; attribute float aSeed; attribute float aPart;
      ${ZONE_VERT}
      varying vec3 vN; varying vec3 vLN; varying float vPart; varying vec4 vZ0; varying vec4 vZ1; varying float vSeed; varying vec3 vBuildP;
      void main() {
        vPart = aPart; vSeed = aSeed; vLN = normal;
        vZ0 = zoneRow(aZone, 0.0);
        vZ1 = zoneRow(aZone, 1.0);
        vec4 lp = instanceMatrix * vec4(position, 1.0);
        vBuildP = lp.xyz;
        vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * lp;
      }`,
    fragmentShader: /* glsl */ `
      ${FRAG_HEAD}
      uniform float uCut;
      varying vec3 vN; varying vec3 vLN; varying float vPart; varying vec4 vZ0; varying vec4 vZ1; varying float vSeed;
      void main() {
        ${GLSL_DISSOLVE}
        ${GLSL_CUT}
        vec3 N = normalize(vN);
        float lights = vZ0.a;
        float lit = 0.22 + 0.55 * uDay + lights * 0.5;
        float shade = 0.55 + 0.45 * max(N.y, 0.0) + 0.15 * N.x;
        vec3 base = vPart < 0.5 ? vec3(0.2, 0.215, 0.24) : vPart < 1.5 ? vec3(0.02, 0.025, 0.03) : vec3(0.04, 0.045, 0.055);
        vec3 col = base * lit * shade * vec3(1.0, 0.96, 0.9);
        if (vPart > 0.5 && vPart < 1.5 && vLN.z > 0.5) {
          float on = lights * step(1.0 - vZ1.b, vSeed * 0.9 + 0.05);
          col += vec3(0.45, 0.68, 1.0) * on * 0.9;
        }
        // Thermal / Airflow: furniture recedes so the zone colour or the air reads
        float recede = max(uAir, uThermal);
        col *= 1.0 - 0.8 * recede;
        col += vZ0.rgb * 0.04 * uThermal;
        col += ${EDGE_GLOW};
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
}

function makeVavMaterial(uniforms) {
  return new ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      attribute float aZone; attribute float aPart; attribute vec3 aCol;
      ${ZONE_VERT}
      varying vec3 vN; varying float vPart; varying vec4 vZ1; varying vec4 vZ2; varying vec3 vBuildP; varying vec3 vCol;
      void main() {
        vPart = aPart; vCol = aCol;
        vZ1 = zoneRow(aZone, 1.0);
        vZ2 = zoneRow(aZone, 2.0);
        vec4 lp = instanceMatrix * vec4(position, 1.0);
        vBuildP = lp.xyz;
        vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * lp;
      }`,
    fragmentShader: /* glsl */ `
      ${FRAG_HEAD}
      varying vec3 vN; varying float vPart; varying vec4 vZ1; varying vec4 vZ2; varying vec3 vCol;
      void main() {
        ${GLSL_DISSOLVE}
        vec3 N = normalize(vN);
        float shade = 0.45 + 0.55 * max(N.y, 0.0) + 0.2 * abs(N.x);
        vec3 col = vCol * shade * (0.45 + 0.6 * uDay);
        // the reheat coil section: its own sheet metal, glowing with the zone's reheat %
        if (vPart > 0.5 && vPart < 1.5) col = mix(col * 0.8, vec3(1.0, 0.45, 0.16) * 2.6, vZ2.r);
        if (vPart > 1.5) col = vec3(0.5, 0.55, 0.62) * (0.5 + 0.5 * uDay) + vec3(0.3, 0.6, 1.0) * vZ2.b * uAir * 1.5;
        col += uAccent * vZ1.g * 0.9;
        float pulse = vZ1.r * (0.55 + 0.45 * sin(uTime * 5.0));
        col += uAlarm * pulse * 0.8;
        col += ${EDGE_GLOW};
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
}

function makePersonMaterial(uniforms) {
  return new ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      attribute float aZone; attribute float aSeed; attribute float aPart;
      ${ZONE_VERT}
      varying vec3 vN; varying vec3 vWP; varying float vSeed; varying float vPart; varying vec3 vBuildP; varying vec3 vTh;
      void main() {
        vSeed = aSeed; vPart = aPart;
        vTh = zoneRow(aZone, 0.0).rgb;
        vec4 lp = instanceMatrix * vec4(position, 1.0);
        vBuildP = lp.xyz;
        vec4 wp = modelMatrix * lp;
        vWP = wp.xyz;
        vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      ${FRAG_HEAD}
      uniform float uCut;
      varying vec3 vN; varying vec3 vWP; varying float vSeed; varying float vPart; varying vec3 vTh;
      void main() {
        ${GLSL_DISSOLVE}
        ${GLSL_CUT}
        vec3 N = normalize(vN);
        vec3 V = normalize(cameraPosition - vWP);
        float rim = pow(1.0 - max(dot(N, V), 0.0), 2.0);
        // quiet slate figures with an accent-tinted head: present, never the subject
        vec3 body = mix(vec3(0.36, 0.42, 0.5), vec3(0.47, 0.45, 0.43), step(0.6, vSeed));
        vec3 tone = vPart > 0.5 ? mix(body, uAccent * 0.85, 0.5) : body;
        vec3 col = tone * (0.35 + 0.35 * max(N.y, 0.0)) + tone * rim * 0.45;
        float recede = max(uAir, uThermal);
        col *= 1.0 - 0.78 * recede;
        col += vTh * 0.04 * uThermal;
        col += ${EDGE_GLOW};
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
}

function makeVolumeMaterial(uniforms) {
  return new ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    vertexShader: /* glsl */ `
      attribute float aZone; attribute vec2 aSize;
      ${ZONE_VERT}
      varying vec3 vL; varying vec4 vZ0; varying vec4 vZ1; varying vec3 vSize; varying vec3 vBuildP;
      void main() {
        vL = position;
        vZ0 = zoneRow(aZone, 0.0);
        vZ1 = zoneRow(aZone, 1.0);
        vSize = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        vec4 lp = instanceMatrix * vec4(position, 1.0);
        vBuildP = lp.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * lp;
      }`,
    fragmentShader: /* glsl */ `
      ${FRAG_HEAD}
      varying vec3 vL; varying vec4 vZ0; varying vec4 vZ1; varying vec3 vSize;
      void main() {
        ${GLSL_DISSOLVE}
        vec3 d = (0.5 - abs(vL)) * vSize;
        // on a face one component is ~0; the distance to that face's nearest edge is the middle one
        float mid = d.x + d.y + d.z - min(d.x, min(d.y, d.z)) - max(d.x, max(d.y, d.z));
        float edge = 1.0 - smoothstep(0.0, 0.16, mid);
        float h = vL.y + 0.5;
        float dev = thermalDev(vZ1.a);
        vec3 th = vZ0.rgb;
        float body = (0.04 + 0.2 * dev) * (1.0 - h * 0.5);
        float alarm = vZ1.r * (0.55 + 0.45 * sin(uTime * 5.0));
        vec3 col = th * (body + edge * (0.16 + 0.5 * dev)) + uAlarm * alarm * 0.25;
        col *= uThermal;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
}
