// Interactive 3D hero: an OmniEgoDB capture with the OmniEgoCap reconstruction, the device, the observed wrists and
// the Xsens ground truth. Data come from static/3d/ (see clips.json for the binary layout).
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";

const BASE = "static/3d/";
const COLORS = {
  body: 0x8ea6ea,
  gt: 0xffcf5c,
  input: 0x3ee08f, // everything the device gives the model
  device: 0x373a42, // device models in charcoal, as on every page figure (author 10/18)
  pointsLow: new THREE.Color(0x59607a),
  pointsHigh: new THREE.Color(0xdde2f7),
};
const TYPES = { int16: Int16Array, uint16: Uint16Array, uint8: Uint8Array, float32: Float32Array };
const TRAIL = 90; // head trail length in 30 fps frames

const root = document.querySelector("[data-hero3d]");
root.dataset.ready = "1"; // the module ran (an old browser without import maps never gets here)
const stage = root.querySelector(".hero3d-stage");
const canvas = root.querySelector("canvas");
const status = root.querySelector(".hero3d-status");
const playBtn = root.querySelector(".hud-play");
const scrub = root.querySelector(".hud-scrub");
const timeLabel = root.querySelector(".hud-time");
const gtToggle = root.querySelector(".hud-gt");
const clipButtons = root.querySelectorAll("[data-clip]");
const handChips = root.querySelectorAll("[data-hand]");
const copy = root.querySelector(".hero3d-copy");
const side = root.querySelector(".hero3d-side");
const videoPanel = root.querySelector(".hero3d-video");
const video = videoPanel.querySelector("video");
const videoCaption = videoPanel.querySelector("figcaption");
const sourceTag = root.querySelector(".hero3d-source span");
const TRACKS = {
  aria_stereo: { video: true, caption: "Aria SLAM stereo cameras" },
  aria_rgb: { video: true, caption: "Aria RGB camera" },
  gopro: { video: true, caption: "Head-mounted GoPro" },
  quest: { video: false, caption: "Meta Quest 3 head and hand tracking" },
};
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const coarse = window.matchMedia("(pointer: coarse)").matches;

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
} catch {
  root.classList.add("no-webgl");
  throw new Error("WebGL unavailable");
}
// device pixels per CSS pixel, capped so that very large screens (a 6K monitor at 200 %) do not render ~20 MP a frame
const PIXEL_BUDGET = 2560 * 1600;
const pixelRatio = (w, h) => Math.min(window.devicePixelRatio, 2, Math.sqrt(PIXEL_BUDGET / Math.max(1, w * h)));
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0b10);
scene.fog = new THREE.Fog(0x0b0b10, 8, 18);

const camera = new THREE.PerspectiveCamera(34, 1, 0.05, 60);
camera.position.set(3.8, 5.15, 4.95);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.enablePan = false;
controls.minDistance = 1.4;
controls.maxDistance = 10;
controls.maxPolarAngle = Math.PI * 0.47;
controls.autoRotate = !reduceMotion;
controls.autoRotateSpeed = 0.35;
controls.target.set(0, 0.9, 0);
if (coarse) canvas.style.touchAction = "pan-y"; // vertical swipes keep scrolling the page
// The hero fills the viewport, so a plain wheel must scroll the page; zoom is Ctrl/Cmd + wheel or a trackpad pinch
// (which browsers send as ctrlKey wheel). Caught on the parent in capture so OrbitControls never sees it.
canvas.parentElement.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
  },
  { capture: true, passive: true },
);
const hint = document.querySelector(".hero3d-hint");
if (hint && coarse) hint.textContent = "Drag to rotate · pinch to zoom";
else if (hint && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) hint.querySelector(".zoom-key").textContent = "⌘";

let idleTimer;
let userMoved = false; // once the viewer drags, the view is theirs: no more resets to the front
controls.addEventListener("start", () => {
  userMoved = true;
  controls.autoRotate = false;
  clearTimeout(idleTimer);
});
controls.addEventListener("end", () => {
  clearTimeout(idleTimer);
  if (!reduceMotion) idleTimer = setTimeout(() => (controls.autoRotate = true), 6000);
});

// Lights
scene.add(new THREE.HemisphereLight(0xdfe6ff, 0x1a1a22, 1.6));
const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(3, 6, 4);
scene.add(key);
const rim = new THREE.DirectionalLight(0x9aa6ff, 1.4);
rim.position.set(-4, 3, -5);
scene.add(rim);

// Floor: a grid under every clip (also below the point clouds) and a soft shadow under the body
const grid = new THREE.GridHelper(24, 48, 0x4a4f66, 0x30344a);
grid.material.transparent = true;
grid.material.opacity = 0.85;
scene.add(grid);

const shadowTex = (() => {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(0,0,0,0.55)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
})();
const shadow = new THREE.Mesh(
  new THREE.PlaneGeometry(1.1, 1.1),
  new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false })
);
shadow.rotation.x = -Math.PI / 2;
shadow.position.y = 0.002;
scene.add(shadow);

// Scene points, brighter near the person
const pointsMaterial = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  uniforms: {
    uSize: { value: 0.012 },
    uMax: { value: 2.0 },
    uMin: { value: 1.5 },
    uScale: { value: 1 },
    uFocus: { value: new THREE.Vector3() },
    uCam: { value: new THREE.Vector3() },
    uLow: { value: COLORS.pointsLow },
    uFloor: { value: new THREE.Color(0x2c3040) },
    uHigh: { value: COLORS.pointsHigh },
    uFog: { value: new THREE.Vector2(8, 18) },
  },
  vertexShader: /* glsl */ `
    uniform float uSize, uScale, uMax, uMin;
    uniform vec3 uFocus, uCam;
    varying float vAlpha, vH, vDepth;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mv;
      float d = distance(position.xz, uFocus.xz);
      vAlpha = mix(1.0, 0.26, smoothstep(1.2, 6.0, d));
      // cut-away: hide points between the camera and the person (a wall or counter they face)
      vec3 axis = uFocus - uCam;
      float len = length(axis);
      vec3 dir = axis / len;
      float along = dot(position - uCam, dir);
      float across = length(position - uCam - dir * along);
      float infront = 1.0 - smoothstep(len - 0.6, len - 0.25, along);
      vAlpha *= 1.0 - infront * (1.0 - smoothstep(0.7, 1.3, across));
      vH = position.y;
      vDepth = -mv.z;
      // never below ~1 CSS px: sub-pixel points pop on and off as the view moves, which reads as shimmering
      gl_PointSize = clamp(uSize * uScale / -mv.z, uMin, uMax);
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 uLow, uHigh, uFloor;
    uniform vec2 uFog;
    varying float vAlpha, vH, vDepth;
    void main() {
      float r = length(gl_PointCoord - 0.5);
      if (r > 0.5) discard;
      float edge = 1.0 - smoothstep(0.2, 0.5, r); // soft edge instead of a hard cut-out
      vec3 col = mix(uLow, uHigh, clamp(vH / 1.8, 0.0, 1.0));
      col = mix(uFloor, col, smoothstep(0.04, 0.25, vH));
      float fog = 1.0 - smoothstep(uFog.x, uFog.y, vDepth);
      gl_FragColor = vec4(col, vAlpha * fog * edge);
    }`,
});

// Body (OmniEgoCap), ground truth, wrists, device, head trail
const bodyMaterial = new THREE.MeshStandardMaterial({ color: COLORS.body, roughness: 0.55, metalness: 0.05 });
const gtMaterial = new THREE.MeshBasicMaterial({ color: COLORS.gt, transparent: true, opacity: 0.9 });
const boneGeometry = new THREE.CylinderGeometry(0.011, 0.011, 1, 8).translate(0, 0.5, 0);
const jointGeometry = new THREE.SphereGeometry(0.02, 12, 8);
// Input (green): device on the head, its recent path and the observed wrists
const inputColor = new THREE.Color(COLORS.input);
const lineMaterials = [];
function inputLine(segments, options) {
  const material = new LineMaterial({ color: COLORS.input, depthTest: false, transparent: true, ...options });
  lineMaterials.push(material);
  const geometry = new LineGeometry();
  geometry.setPositions(new Float32Array((segments + 1) * 3));
  if (options.vertexColors) geometry.setColors(new Float32Array((segments + 1) * 3));
  const line = new Line2(geometry, material);
  line.frustumCulled = false;
  line.renderOrder = 9;
  scene.add(line);
  return line;
}
function ringTexture(letter) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  g.strokeStyle = "#3ee08f";
  g.lineWidth = 12;
  g.beginPath();
  g.arc(64, 64, 50, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = "#3ee08f";
  g.font = "800 58px Manrope, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(letter, 64, 68);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const wrists = ["L", "R"].map((letter) => {
  const marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTexture(letter), depthTest: false, transparent: true }));
  marker.scale.set(0.12, 0.12, 1);
  marker.renderOrder = 10;
  scene.add(marker);
  return { marker };
});
const trail = inputLine(TRAIL - 1, { linewidth: 3, vertexColors: true, color: 0xffffff, opacity: 0.95, depthTest: true });
const trailColors = new Float32Array(TRAIL * 3);
const deviceMaterial = new THREE.MeshStandardMaterial({
  color: COLORS.device,
  emissive: COLORS.device,
  emissiveIntensity: 0.35,
  roughness: 0.4,
  metalness: 0.1,
});
// stands in when a device has no mesh, so the per-frame pose update needs no special case
const noDevice = new THREE.Object3D();

const deviceMeshes = {};
// one shared promise per device, so a background prefetch and the clip switch never race
function loadDevice(name) {
  if (!name) return Promise.resolve(null);
  deviceMeshes[name] ??= fetch(`${BASE}device_${name}.bin`)
    .then((res) => (res.ok ? res.arrayBuffer() : null))
    .then((buf) => {
      if (!buf) return null;
      const [nv, nf] = new Uint32Array(buf, 0, 2);
      const v = new Float32Array(buf, 8, nv * 3);
      const yup = new Float32Array(nv * 3);
      for (let i = 0; i < nv; i++) {
        yup[i * 3] = v[i * 3];
        yup[i * 3 + 1] = v[i * 3 + 2];
        yup[i * 3 + 2] = -v[i * 3 + 1];
      }
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(yup, 3));
      geom.setIndex(new THREE.BufferAttribute(new Uint16Array(buf, 8 + nv * 12, nf * 3), 1));
      geom.computeVertexNormals();
      return new THREE.Mesh(geom, deviceMaterial);
    })
    .catch(() => null);
  return deviceMeshes[name];
}

async function fetchBinary(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes.buffer; // already decoded by the server
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

function view(buf, { offset, dtype, shape }) {
  return new TYPES[dtype](buf, offset, shape.reduce((a, b) => a * b, 1));
}

function toMetres(src) {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i] / 1000;
  return out;
}

function decodeClip(meta, buf) {
  const L = meta.layout;
  const [M, V] = L.mesh.shape;
  // frame deltas -> absolute millimetres, kept as int16 (half the memory of float32)
  const mesh = new Int16Array(view(buf, L.mesh));
  for (let i = V * 3; i < mesh.length; i++) mesh[i] += mesh[i - V * 3];
  const head = toMetres(view(buf, L.head));
  const n = meta.frames;
  // camera path: the head path with gait sway removed (centred Gaussian, sigma 0.5 s, so no lag) at a fixed
  // height, so the view neither bobs nor sways with each step
  const follow = new Float32Array(n * 3);
  const SIGMA = 15;
  const heights = Array.from({ length: n }, (_, f) => head[f * 3 + 1]).sort((p, q) => p - q);
  const height = Math.max(0.75, heights[n >> 1] - 0.65);
  for (let f = 0; f < n; f++) {
    let sx = 0, sz = 0, sw = 0;
    for (let k = Math.max(0, f - 3 * SIGMA); k <= Math.min(n - 1, f + 3 * SIGMA); k++) {
      const w = Math.exp(-((k - f) ** 2) / (2 * SIGMA * SIGMA));
      sx += w * head[k * 3];
      sz += w * head[k * 3 + 2];
      sw += w;
    }
    follow[f * 3] = sx / sw;
    follow[f * 3 + 1] = height;
    follow[f * 3 + 2] = sz / sw;
  }
  return {
    meta,
    frames: meta.frames,
    follow,
    meshFrames: M,
    verts: V,
    faces: view(buf, L.faces),
    mesh,
    head,
    devicePos: toMetres(view(buf, L.device_pos)),
    deviceRot: view(buf, L.device_rot),
    wrist: toMetres(view(buf, L.wrist)),
    visible: view(buf, L.visible),
    gt: toMetres(view(buf, L.gt)),
    gtValid: view(buf, L.gt_valid),
    points: toMetres(view(buf, L.points)),
    bones: meta.bones,
  };
}

// Current clip and its scene objects
let clip = null;
let objects = [];
let body, gtBones, gtJoints, device, points;
let t = 0;
let follow = true;
let hasVideo = false;
let onScreen = true;
let lastSeek = 0;
let playing = !reduceMotion;
let manifest;
let switching = false;
const cache = {};
const ORDER = [...clipButtons].map((b) => b.dataset.clip);
let current = null;
const nextOf = (name) => ORDER[(ORDER.indexOf(name) + 1) % ORDER.length];

// when a clip ends, go on to the next device
function advance() {
  if (switching || !current) return;
  switching = true;
  showClip(nextOf(current)).finally(() => (switching = false));
}

async function loadClip(name) {
  if (!manifest) manifest = await (await fetch(`${BASE}clips.json`)).json();
  if (!cache[name]) cache[name] = fetchBinary(`${BASE}${name}.bin.gz`).then((buf) => decodeClip(manifest[name], buf));
  return cache[name];
}

function clearClip() {
  objects.forEach((o) => {
    scene.remove(o);
    if (o.userData.owned) o.geometry.dispose();
  });
  objects = [];
}

function add(obj, owned = true) {
  obj.userData.owned = owned;
  scene.add(obj);
  objects.push(obj);
  return obj;
}

async function showClip(name) {
  root.classList.add("is-loading");
  status.textContent = "Loading 3D scene…";
  clipButtons.forEach((b) => {
    b.classList.toggle("is-active", b.dataset.clip === name);
    b.setAttribute("aria-pressed", b.dataset.clip === name);
  });
  let next;
  try {
    next = await loadClip(name);
  } catch (err) {
    // e.g. no DecompressionStream (Safari before 16.4): fall back to the still image
    root.classList.add("no-webgl");
    console.error(err);
    return;
  }
  const deviceName = next.meta.device;
  const deviceMesh = await loadDevice(deviceName);

  clearClip();
  clip = next;
  current = name;
  const upcoming = nextOf(name);
  for (const k of Object.keys(cache)) if (k !== name && k !== upcoming) delete cache[k]; // shown + next only
  // fetch the next device in the background so the hand-over has no loading gap — but only 4 s before this clip
  // ends and only while the hero is on screen (author 10/19: a visitor who reads one clip and scrolls on should not
  // download the next one; first screen 7.1 -> ~4.7 MB). If it was skipped, showClip loads it when it is needed.
  const prefetchAt = Math.max(1500, (next.frames / 30 - 4) * 1000);
  setTimeout(() => {
    if (current !== name || !onScreen || document.visibilityState === "hidden") return;
    loadClip(upcoming).catch(() => {});
    loadDevice(manifest[upcoming]?.device);
    if (TRACKS[upcoming]?.video) fetch(`${BASE}${upcoming}.mp4`, { priority: "low" }).catch(() => {});
  }, prefetchAt);

  const info = TRACKS[name] || { video: false, caption: "" };
  hasVideo = info.video;
  videoCaption.textContent = info.caption;
  // every hero clip is an OmniEgoDB recording; name it (capture and time in the recording)
  if (sourceTag) {
    const m = clip.meta, s = (m.start ?? 0) / 30;
    const mmss = (x) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, "0")}`;
    sourceTag.textContent = m.capture ? `${m.capture} · ${mmss(s)}–${mmss(s + m.frames / 30)}` : "recording";
  }
  videoPanel.classList.toggle("no-video", !hasVideo);
  if (hasVideo) {
    video.poster = `${BASE}${name}.jpg`;
    video.src = `${BASE}${name}.mp4`;
    video.currentTime = 0;
    if (playing && onScreen) video.play().catch(() => {});
  } else {
    video.pause();
    video.removeAttribute("src");
    video.removeAttribute("poster");
    video.load();
  }

  const bodyGeometry = new THREE.BufferGeometry();
  bodyGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(clip.verts * 3), 3));
  bodyGeometry.setIndex(new THREE.BufferAttribute(clip.faces, 1));
  body = add(new THREE.Mesh(bodyGeometry, bodyMaterial));
  body.frustumCulled = false; // vertices move every frame

  gtBones = add(new THREE.InstancedMesh(boneGeometry, gtMaterial, clip.bones.length), false);
  gtJoints = add(new THREE.InstancedMesh(jointGeometry, gtMaterial, clip.gt.length / clip.frames / 3), false);
  gtBones.frustumCulled = gtJoints.frustumCulled = false;
  gtBones.visible = gtJoints.visible = gtToggle.checked;

  if (clip.points.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(clip.points, 3));
    points = add(new THREE.Points(g, pointsMaterial));
  } else {
    points = null;
  }

  device = add(deviceMesh || noDevice, false);

  t = 0;
  scrub.max = (clip.frames - 1) / 30;
  const h = frameHead(0);
  clip.front = frontYaw(clip);
  userMoved = false;
  controls.target.set(clip.follow[0], clip.follow[1], clip.follow[2]);
  frontView();
  root.classList.remove("is-loading");
  status.textContent = "";
  update(0);
}

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const tmpM = new THREE.Matrix4();
const tmpS = new THREE.Vector3(1, 1, 1);
const up = new THREE.Vector3(0, 1, 0);

function frameHead(f) {
  return tmpA.set(clip.head[f * 3], clip.head[f * 3 + 1], clip.head[f * 3 + 2]);
}

// Which way the person faces while working: nose minus the ears' midpoint on the SMPL-H mesh (vertex 332 is the
// nose tip, 583 and 4071 the ears), averaged over the clip with standing-still frames counting most
function frontYaw(c) {
  const V = c.verts * 3;
  const n = Math.min(c.meshFrames, c.frames);
  // the packer's indices for these three vertices (the mesh may be decimated); full SMPL-H ids otherwise
  const { nose = 332, ear_l: earL = 583, ear_r: earR = 4071 } = c.meta.landmarks || {};
  let sx = 0, sz = 0;
  for (let f = 0; f < n; f++) {
    const o = f * c.meta.mesh_step;
    const m = f * V;
    const fx = c.mesh[m + nose * 3] - (c.mesh[m + earL * 3] + c.mesh[m + earR * 3]) / 2;
    const fz = c.mesh[m + nose * 3 + 2] - (c.mesh[m + earL * 3 + 2] + c.mesh[m + earR * 3 + 2]) / 2;
    const len = Math.hypot(fx, fz) || 1;
    const g = Math.min(o + 1, c.frames - 1);
    const speed = Math.hypot(c.head[g * 3] - c.head[o * 3], c.head[g * 3 + 2] - c.head[o * 3 + 2]) * 30;
    const w = 1 / (0.15 + speed);
    sx += (w * fx) / len;
    sz += (w * fz) / len;
  }
  return Math.atan2(sz, sx);
}

// Start view: in front of the person, a little to the side, looking slightly down
const VIEW = { dist: 6.4, elevation: THREE.MathUtils.degToRad(24), side: THREE.MathUtils.degToRad(28) };
function frontView() {
  const a = clip.front + VIEW.side;
  const r = VIEW.dist * Math.cos(VIEW.elevation);
  camera.position.set(
    controls.target.x + r * Math.cos(a),
    controls.target.y + VIEW.dist * Math.sin(VIEW.elevation),
    controls.target.z + r * Math.sin(a)
  );
  controls.update();
}

function frameVec(arr, stride, i, f, out) {
  const p = f * stride + i * 3;
  return out.set(arr[p], arr[p + 1], arr[p + 2]);
}

const tmpTrail = Array.from({ length: TRAIL }, () => new THREE.Vector3());

// write a polyline into a Line2 in place (its geometry stores segments as start/end pairs)
function setSegments(line, pts, colors) {
  const seg = line.geometry.attributes.instanceStart.data;
  const a = seg.array;
  for (let k = 0, o = 0; k < pts.length - 1; k++, o += 6) {
    a[o] = pts[k].x; a[o + 1] = pts[k].y; a[o + 2] = pts[k].z;
    a[o + 3] = pts[k + 1].x; a[o + 4] = pts[k + 1].y; a[o + 5] = pts[k + 1].z;
  }
  seg.needsUpdate = true;
  if (colors) {
    const col = line.geometry.attributes.instanceColorStart.data;
    for (let k = 0; k < pts.length - 1; k++) col.array.set(colors.subarray(k * 3, k * 3 + 6), k * 6);
    col.needsUpdate = true;
  }
}

function update(dt) {
  if (!clip) return;
  const last = clip.frames - 1;
  // every layer shows exactly one data frame, the one the input video is on (no interpolation)
  const fi = Math.min(Math.round(t * 30), last);

  // body mesh: stored every mesh_step frames (2 -> 15 fps, author 10/18: half the download); the frames in
  // between are linear blends of the two stored neighbours, so the body still moves at 30 fps
  const n = clip.verts * 3;
  const pos = body.geometry.attributes.position.array;
  const step = clip.meta.mesh_step;
  const ka = Math.min(Math.floor(fi / step), clip.meshFrames - 1);
  const kb = Math.min(ka + 1, clip.meshFrames - 1);
  const w = kb === ka ? 0 : (fi - ka * step) / step;
  // the mesh changes 30 times a second; skip the copy and the normals on display refreshes in between
  if (body.userData.fi !== fi || body.userData.clip !== clip) {
    const a = ka * n, b = kb * n;
    if (w === 0) for (let i = 0; i < n; i++) pos[i] = clip.mesh[a + i] * 0.001;
    else for (let i = 0; i < n; i++) pos[i] = (clip.mesh[a + i] + w * (clip.mesh[b + i] - clip.mesh[a + i])) * 0.001;
    body.geometry.attributes.position.needsUpdate = true;
    body.geometry.computeVertexNormals();
    body.userData.fi = fi;
    body.userData.clip = clip;
  }

  // ground truth skeleton
  const segs = clip.gt.length / clip.frames / 3;
  const valid = clip.gtValid[fi] === 1;
  if (gtToggle.checked) {
    gtBones.visible = gtJoints.visible = valid;
    if (valid) {
      clip.bones.forEach(([i, j], k) => {
        frameVec(clip.gt, segs * 3, i, fi, tmpA);
        frameVec(clip.gt, segs * 3, j, fi, tmpB);
        const len = tmpB.sub(tmpA).length();
        tmpQ.setFromUnitVectors(up, tmpB.divideScalar(len || 1));
        tmpM.compose(tmpA, tmpQ, tmpS.set(1, len, 1));
        gtBones.setMatrixAt(k, tmpM);
      });
      for (let s = 0; s < segs; s++) {
        frameVec(clip.gt, segs * 3, s, fi, tmpA);
        tmpM.makeTranslation(tmpA.x, tmpA.y, tmpA.z);
        gtJoints.setMatrixAt(s, tmpM);
      }
      gtBones.instanceMatrix.needsUpdate = true;
      gtJoints.instanceMatrix.needsUpdate = true;
    }
  }

  // device on the head (input)
  frameVec(clip.devicePos, 3, 0, fi, device.position);
  device.quaternion.fromArray(clip.deviceRot, fi * 4);

  // observed wrists (input): drawn only on frames where the device sees the hand, at that frame's value
  wrists.forEach(({ marker }, h) => {
    const seen = clip.visible[fi * 2 + h] === 1;
    marker.visible = seen;
    if (seen) frameVec(clip.wrist, 6, h, fi, marker.position);
    handChips[h]?.classList.toggle("is-on", seen);
  });

  // head path over the last 3 s (input), fading out
  const path = [];
  for (let k = 0; k < TRAIL; k++) {
    const f = Math.max(0, fi - (TRAIL - 1 - k));
    path.push(tmpTrail[k].set(clip.head[f * 3], clip.head[f * 3 + 1], clip.head[f * 3 + 2]));
    const s = (k / (TRAIL - 1)) ** 1.5;
    trailColors[k * 3] = THREE.MathUtils.lerp(0.043, inputColor.r, s);
    trailColors[k * 3 + 1] = THREE.MathUtils.lerp(0.043, inputColor.g, s);
    trailColors[k * 3 + 2] = THREE.MathUtils.lerp(0.063, inputColor.b, s);
  }
  setSegments(trail, path, trailColors);

  // camera rides on the smoothed path at the same data frame as the body, so the person never shakes against it
  const head = frameHead(fi);
  shadow.position.set(head.x, 0.002, head.z);
  frameVec(clip.follow, 3, 0, fi, tmpB);
  pointsMaterial.uniforms.uFocus.value.copy(tmpB);
  if (follow) {
    const move = tmpB.sub(controls.target);
    controls.target.add(move);
    camera.position.add(move);
  }

  scrub.value = t.toFixed(2);
  timeLabel.textContent = `${fmt(t)} / ${fmt(clip.frames / 30)}`; // length = frames / 30 (300 -> 0:10), not the last frame time
}

function fmt(s) {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

// Layout: on wide screens the person sits right of the copy
function resize() {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  renderer.setPixelRatio(pixelRatio(w, h));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // wide screens: stand the person in the middle of the free space between the copy and the video panel
  if (w > 860) {
    const box = stage.getBoundingClientRect();
    const left = Math.max(...[...copy.children].map((el) => el.getBoundingClientRect().right)) - box.left;
    const right = side.getBoundingClientRect().left - box.left;
    camera.setViewOffset(w, h, w / 2 - (left + right) / 2, 0, w, h);
  } else {
    // phones: the input video + legend sit at the top of the canvas and the device buttons / player at the bottom;
    // stand the person in the middle of the free band between them
    const box = stage.getBoundingClientRect();
    const top = side.getBoundingClientRect().bottom - box.top;
    const hudEl = root.querySelector(".hero3d-hud");
    const bottom = (hudEl ? hudEl.getBoundingClientRect().top : box.bottom) - box.top;
    if (bottom - top > 120) camera.setViewOffset(w, h, 0, h / 2 - (top + bottom) / 2, w, h);
    else camera.clearViewOffset();
  }
  camera.updateProjectionMatrix();
  lineMaterials.forEach((m) => m.resolution.set(w, h));
  pointsMaterial.uniforms.uMax.value = 2.6 * renderer.getPixelRatio();
  pointsMaterial.uniforms.uMin.value = 1.5 * renderer.getPixelRatio();
  pointsMaterial.uniforms.uScale.value = (h * renderer.getPixelRatio() * 0.5) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
}
new ResizeObserver(resize).observe(stage);
document.fonts?.ready.then(resize); // the copy's width depends on the web font
resize();

// Controls
playBtn.addEventListener("click", () => setPlaying(!playing));
function setPlaying(p) {
  playing = p;
  if (hasVideo) {
    if (p && onScreen) video.play().catch(() => {});
    else video.pause();
  }
  playBtn.setAttribute("aria-label", p ? "Pause" : "Play");
  playBtn.classList.toggle("is-paused", !p);
}
setPlaying(playing);
scrub.addEventListener("input", () => {
  t = Number(scrub.value);
  if (hasVideo) video.currentTime = t;
  update(0);
});
gtToggle.addEventListener("change", () => {
  if (gtBones) gtBones.visible = gtJoints.visible = gtToggle.checked;
});
clipButtons.forEach((b) => b.addEventListener("click", () => showClip(b.dataset.clip)));

// Render only while the hero is on screen
new IntersectionObserver(([e]) => {
  onScreen = e.isIntersecting;
  if (!hasVideo) return;
  if (onScreen && playing) video.play().catch(() => {});
  else video.pause();
}).observe(root);
video.addEventListener("ended", () => {
  if (playing) advance();
});

// the video frame on screen (requestVideoFrameCallback), so the 3D shows the same frame as the video
let videoT = null;
if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
  const onFrame = (_, meta) => {
    videoT = meta.mediaTime;
    video.requestVideoFrameCallback(onFrame);
  };
  video.requestVideoFrameCallback(onFrame);
  video.addEventListener("emptied", () => (videoT = null));
}
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (!onScreen || document.hidden) return;
  if (clip) {
    const end = (clip.frames - 1) / 30;
    if (hasVideo && !video.paused && video.readyState >= 2) {
      // the input video is the clock, so the 3D stays with its frame. The presented-frame time (requestVideoFrameCallback)
      // is used only while it agrees with currentTime to within a frame: Firefox sometimes reports a frame ~0.3 s ahead
      // and then falls back (the body jumped 10 frames forward and 8 back). The 3D clock then advances by the display
      // time and is pulled towards the video time, so uneven video frame delivery (Firefox) does not show as skipped or
      // held body frames; it stays within about a frame of the video. A loop or seek (> 0.25 s off) snaps to it.
      const ct = video.currentTime;
      const vt = videoT !== null && Math.abs(videoT - ct) < 0.05 ? videoT : ct;
      const pred = t + dt;
      const err = vt - pred;
      t = Math.min(Math.max(Math.abs(err) > 0.25 ? vt : pred + 0.15 * err, 0), end);
    } else if (playing) {
      t += dt;
      if (t > end) {
        t = end;
        advance();
      }
      // video could not autoplay (e.g. low-power mode): keep its frame close by seeking
      const now = performance.now();
      if (hasVideo && video.paused && now - lastSeek > 250) {
        video.currentTime = t;
        lastSeek = now;
      }
    }
  }
  update(dt);
  controls.update();
  pointsMaterial.uniforms.uCam.value.copy(camera.position);
  renderer.render(scene, camera);
});

function personBox() {
  const p = body.geometry.attributes.position.array;
  const v = new THREE.Vector3();
  const r = canvas.getBoundingClientRect();
  camera.updateMatrixWorld();
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < p.length; i += 9) {
    v.set(p[i], p[i + 1], p[i + 2]).project(camera);
    const x = r.left + ((v.x + 1) / 2) * r.width;
    const y = r.top + ((1 - v.y) / 2) * r.height;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  return { x0, x1, y0, y1 };
}

if (location.hash === "#debug") window.__h3d = { camera, controls, scene, setT: (v) => (t = v), setPlaying, setFollow: (v) => (follow = v), showClip, controls, getClip: () => clip, getT: () => t, personBox, wrists, step: (v) => { t = v; update(0); },
  // fitting aid: shift the device mesh in its own frame (cm: x left, y up, z forward) and look at it from a
  // direction given in the device frame
  shiftDevice: (x, y, z) => device.geometry?.translate(x / 100, z / 100, -y / 100),
  lookAtDevice: (dx, dy, dz, dist, ty = -0.05) => {
    follow = false;
    const dir = new THREE.Vector3(dx, dz, -dy).normalize().applyQuaternion(device.quaternion);
    const target = device.position.clone().add(new THREE.Vector3(0, ty, 0));
    controls.target.copy(target);
    camera.position.copy(target).addScaledVector(dir, dist);
    camera.up.set(0, 1, 0);
    controls.update();
  } };

showClip(root.querySelector("[data-clip].is-active")?.dataset.clip || clipButtons[0].dataset.clip);
