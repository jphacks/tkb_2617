import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// エラーを左パネルの状態表示に出す（コンソールを開かなくても分かる）
addEventListener('error', (e) => {
  const s = document.getElementById('status');
  if (s) s.textContent = 'エラー: ' + e.message;
});
addEventListener('unhandledrejection', (e) => {
  const s = document.getElementById('status');
  if (s) s.textContent = 'エラー: ' + (e.reason && e.reason.message ? e.reason.message : e.reason);
});

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const num = (v, d = 0) => (Number.isFinite(+v) ? +v : d);
const clampInt = (v, lo, hi) => Math.min(Math.max(Math.round(num(v, lo)), lo), hi);
// ①〜⑩ を 1〜10 にそろえて、部品IDの表記ゆれを吸収する
const normId = (s) =>
  String(s ?? '')
    .trim()
    .replace(/[①-⑩]/g, (c) => String(c.charCodeAt(0) - 0x2460 + 1))
    .replace(/[()（）\s]/g, '');

const MAX_PAGES = 40;     // 読み込む最大ページ数
const CHUNK = 3;          // 1回の解析で読むページ数
const CONCURRENCY = 2;    // 同時に解析する数
const PARTS_PAGES = 3;    // 部品一覧を読むために使う最初のページ数
const PALETTE = ['#c8a27a', '#b58a5a', '#d9b98e', '#a67c52', '#e0c9a6', '#8d6a47'];
const FASTENER_COLOR = '#ff7a00';
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const SCREW_RE = /ネジ|ねじ|ビス|ボルト|ダボ|カム|金具|screw|bolt|dowel/i;
const TOP_RE = /天板|甲板|天面|tabletop|table top|\btop\b/i;
const LEG_RE = /脚|レッグ|\bleg/i;

$('stepText').style.whiteSpace = 'pre-line';
$('stepText').style.fontSize = '15px';

// ---------- 3Dシーン ----------
const view = $('view');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf2f2f2);
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
camera.position.set(120, 110, 170);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.autoClear = false;
view.appendChild(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 30, 0);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xffffff, 0x888888, 1.3));
const dl = new THREE.DirectionalLight(0xffffff, 1.5);
dl.position.set(100, 200, 100);
scene.add(dl);
scene.add(new THREE.GridHelper(500, 50));

// ---------- 字幕 ----------
const hudScene = new THREE.Scene();
const hudCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
const hudCanvas = document.createElement('canvas');
hudCanvas.width = 1280;
hudCanvas.height = 200;
const hudTex = new THREE.CanvasTexture(hudCanvas);
hudTex.colorSpace = THREE.SRGBColorSpace;
const hudMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.MeshBasicMaterial({ map: hudTex, transparent: true, depthTest: false })
);
hudScene.add(hudMesh);
let hudText = '';

function drawHud() {
  const g = hudCanvas.getContext('2d');
  g.clearRect(0, 0, 1280, 200);
  if (hudText) {
    g.fillStyle = 'rgba(0,0,0,0.65)';
    g.fillRect(0, 0, 1280, 200);
    g.fillStyle = '#fff';
    g.font = '34px sans-serif';
    g.textBaseline = 'top';
    let line = '', y = 18, rows = 0;
    for (const ch of hudText) {
      if (g.measureText(line + ch).width > 1280 - 48) {
        g.fillText(line, 24, y);
        y += 44;
        line = ch;
        rows++;
        if (rows >= 3) break;
      } else line += ch;
    }
    g.fillText(line, 24, y);
  }
  hudTex.needsUpdate = true;
}

function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  hudCam.left = -w / 2; hudCam.right = w / 2; hudCam.top = h / 2; hudCam.bottom = -h / 2;
  hudCam.updateProjectionMatrix();
  const ph = (w * 200) / 1280;
  hudMesh.scale.set(w, ph, 1);
  hudMesh.position.set(0, -h / 2 + ph / 2, 0);
}
new ResizeObserver(resize).observe(view);
resize();

// ---------- 状態 ----------
let data = null;           // {title, parts, steps:[{text,page,active,materials}]}
let items = [];            // 3D上の部品1個ごと（ネジも1本ずつ）
let markers = [];          // ネジ位置のリング
let current = -1;
let pdfUrl = null;
let K = 1;                 // 入力の長さ → シーンの長さ(cm)
let MM = 10;               // 入力の長さ → mm
let modelCenter = new THREE.Vector3(0, 40, 0);
let modelSize = 100;
let anims = [];
let animEnd = 0;
let playToken = 0;
let lastSpeech = Promise.resolve();
let ghostGroup = null;
let focusTarget = new THREE.Vector3(0, 40, 0);
let focusDist = 200;
let focusUntil = 0;

const vec = (a) => {
  a = a || [];
  return new THREE.Vector3(num(a[0]) * K, num(a[1]) * K, num(a[2]) * K);
};
const quat = (a) => {
  a = a || [];
  const r = (k) => THREE.MathUtils.degToRad(num(a[k]));
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(r(0), r(1), r(2)));
};
const sizeOf = (p) =>
  [0, 1, 2].map((k) => {
    const raw = num((p.size || [])[k]);
    return (raw > 0 ? raw : 20 / MM) * K;
  });

function normKind(p) {
  if (['board', 'rod', 'screw'].includes(p.kind)) return p.kind;
  if (p.shape === 'screw' || SCREW_RE.test(p.name || '')) return 'screw';
  if (p.shape === 'cylinder') return 'rod';
  return 'board';
}

function detectScale(parts) {
  let max = 0;
  parts.forEach((p) => {
    if (normKind(p) !== 'screw') (p.dims || p.size || []).forEach((v) => { max = Math.max(max, num(v)); });
  });
  return max >= 150 ? { K: 0.1, MM: 1 } : { K: 1, MM: 10 }; // 150以上ならmm入力とみなす
}

// 表示用の寸法ラベル（PDFに書かれた元の寸法）
function fmtDim(p, mm) {
  const d = (p.dims || p.size || [])
    .map((v) => Math.round(num(v) * mm))
    .filter((v) => v > 0)
    .sort((a, b) => b - a);
  if (!d.length) return '';
  return normKind(p) === 'board' ? d.join('×') + 'mm' : `φ${d[d.length - 1]}×${d[0]}mm`;
}

// 部品の寸法を mm の昇順で返す
function dimsMM(p) {
  const d = (p.dims || p.size || [])
    .map((v) => num(v) * MM)
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  return d.length ? d : [20, 20, 20];
}

// ---------- 一般的なレイアウト計算 ----------
// AIが書いた「向き」と「どの部品のどの面に付くか」から、位置を計算する
const AXIS = { x: 0, y: 1, z: 2 };
const FACE = { top: [1, 1], bottom: [1, -1], left: [0, -1], right: [0, 1], front: [2, 1], back: [2, -1] };
const OPP = { top: 'bottom', bottom: 'top', left: 'right', right: 'left', front: 'back', back: 'front' };
const MIRROR = { min: 'max', max: 'min', center: 'center' };
const axisOf = (v) => AXIS[String(v || '').trim().toLowerCase().charAt(0)];

function attachTo(n, t, pl) {
  const [ax, sg] = FACE[String(pl.at || 'top').toLowerCase()] || FACE.top;
  const al = {};
  Object.entries(pl.align || {}).forEach(([k, v]) => { al[String(k).toLowerCase()] = String(v).toLowerCase(); });
  const inset = Math.max(num(pl.inset), 0);
  const c = [0, 0, 0];
  c[ax] = t.c[ax] + sg * (t.h[ax] + n.h[ax]);
  [0, 1, 2].forEach((a) => {
    if (a === ax) return;
    const m = al['xyz'[a]] || 'center';
    if (m === 'min') c[a] = t.c[a] - t.h[a] + n.h[a] + inset;
    else if (m === 'max') c[a] = t.c[a] + t.h[a] - n.h[a] - inset;
    else c[a] = t.c[a];
  });
  return c;
}

function solveLayout(parts) {
  const solids = parts.filter((p) => p.kind !== 'screw');
  if (!solids.length) return false;
  // 位置関係がひとつも書かれていなければ使わない
  if (!solids.some((p) => Array.isArray(p.placements) && p.placements.length)) return false;

  const idMap = {};
  solids.forEach((p) => { idMap[normId(p.id)] = p; });
  const find = (id) => idMap[normId(id)] || solids.find((p) => p.name && p.name === String(id));

  // 1. 個体ごとの箱（大きさと向き）を作る
  const nodes = [];
  solids.forEach((p) => {
    const d = dimsMM(p);
    const q = clampInt(p.qty, 1, 8);
    const rod = p.kind === 'rod';
    let long = axisOf(p.long_axis);
    let thin = axisOf(p.thin_axis);
    if (long === undefined) long = rod ? 1 : 0;
    if (!rod && (thin === undefined || thin === long)) thin = [1, 0, 2].find((a) => a !== long);

    const e = [0, 0, 0];
    let size, rot;
    if (rod) {
      e[long] = d[d.length - 1];
      [0, 1, 2].forEach((a) => { if (a !== long) e[a] = d[0]; });
      size = [d[0] / MM, d[d.length - 1] / MM, d[0] / MM];
      rot = long === 1 ? [0, 0, 0] : long === 0 ? [0, 0, 90] : [90, 0, 0];
    } else {
      const mid = [0, 1, 2].find((a) => a !== long && a !== thin);
      e[thin] = d[0];
      e[long] = d[d.length - 1];
      e[mid] = d.length >= 3 ? d[1] : d[d.length - 1];
      size = e.map((v) => v / MM);
      rot = [0, 0, 0];
    }
    for (let i = 0; i < q; i++) nodes.push({ def: p, i, h: e.map((v) => v / 2), c: null, size, rot });
  });

  // 2. 基準になる部品（anchor、なければ一番大きい部品）を原点に置く
  const vol = (n) => n.h[0] * n.h[1] * n.h[2];
  let anchor = nodes.find((n) => n.def.anchor === true || n.def.anchor === 'true');
  if (!anchor) anchor = nodes.reduce((a, b) => (vol(b) > vol(a) ? b : a));
  anchor.c = [0, 0, 0];

  const plOf = (n) => {
    const list = Array.isArray(n.def.placements) ? n.def.placements.filter((x) => x && x.on != null) : [];
    if (!list.length) return null;
    if (list[n.i]) return list[n.i];
    // 足りない分は、左右・前後を反転した配置にする
    const b = list[n.i % list.length];
    const al = {};
    Object.entries(b.align || {}).forEach(([k, v]) => { al[k] = MIRROR[String(v).toLowerCase()] || 'center'; });
    return { ...b, at: OPP[String(b.at).toLowerCase()] || b.at, align: al };
  };

  // 3. 位置関係を順にたどって置く
  const pending = nodes.filter((n) => n !== anchor);
  let resolved = 0;
  for (let round = 0; round < nodes.length + 2 && pending.length; round++) {
    let moved = false;
    for (const n of [...pending]) {
      const pl = plOf(n);
      const tdef = pl && find(pl.on);
      if (!tdef) continue;
      const cands = nodes.filter((m) => m.def === tdef && m.c && m !== n);
      const t = cands[n.i] || cands[0];
      if (!t) continue;
      n.c = attachTo(n, t, pl);
      pending.splice(pending.indexOf(n), 1);
      resolved++;
      moved = true;
    }
    if (!moved) break;
  }
  if (!resolved) return false;

  // 置けなかった部品は、右側に並べる
  let maxX = Math.max(...nodes.filter((n) => n.c).map((n) => n.c[0] + n.h[0]));
  pending.forEach((n) => {
    n.c = [maxX + 100 + n.h[0], anchor.c[1] - anchor.h[1] + n.h[1], 0];
    maxX = n.c[0] + n.h[0];
  });

  // 4. 床の高さと、左右・前後の中心をそろえる
  const minY = Math.min(...nodes.map((n) => n.c[1] - n.h[1]));
  const lo = [0, 2].map((a) => Math.min(...nodes.map((n) => n.c[a] - n.h[a])));
  const hi = [0, 2].map((a) => Math.max(...nodes.map((n) => n.c[a] + n.h[a])));
  const dx = -(lo[0] + hi[0]) / 2, dz = -(lo[1] + hi[1]) / 2;
  nodes.forEach((n) => { n.c = [n.c[0] + dx, n.c[1] - minY, n.c[2] + dz]; });

  // 5. 結果を部品に書き戻す
  solids.forEach((p) => {
    const mine = nodes.filter((n) => n.def === p).sort((a, b) => a.i - b.i);
    p.qty = mine.length;
    p.size = mine[0].size;
    p.instances = mine.map((n) => ({ pos: n.c.map((v) => v / MM), rot: n.rot }));
    p.frame = false;
  });
  return true;
}

// 位置関係が読み取れなかったときの予備: 天板と脚がある机・テーブル
function tablePreset(parts) {
  const solids = parts.filter((p) => p.kind !== 'screw');
  const leg = solids.find((p) => LEG_RE.test(p.name || ''));
  const top = solids.find((p) => p !== leg && TOP_RE.test(p.name || ''));
  if (!top || !leg) return false;
  const R = (mm) => mm / MM;

  const td = dimsMM(top);
  let T = td[0], D = td[1] ?? td[0], L = td[td.length - 1];
  if (T > 60) T = 25;
  if (L < 300) { L = 1200; D = 600; T = 18; }

  const ld = dimsMM(leg);
  let H = ld[ld.length - 1], d = ld[0];
  if (H < 200 || H > 1200) H = 700;
  if (d < 8 || d > 100) d = 30;

  const inX = Math.min(60, L * 0.08);
  const inZ = Math.min(50, D * 0.1);
  const span = Math.max(D - 2 * inZ, 100);

  top.kind = 'board';
  top.size = [R(L), R(T), R(D)];
  top.qty = 1;
  top.instances = [{ pos: [0, R(H + T / 2), 0], rot: [0, 0, 0] }];

  leg.kind = 'rod';
  const legQty = clampInt(leg.qty, 1, 8);
  if (legQty >= 3) {
    const n = Math.min(legQty, 4);
    leg.frame = false;
    leg.size = [R(d), R(H), R(d)];
    leg.qty = n;
    leg.instances = [[-1, -1], [1, -1], [-1, 1], [1, 1]].slice(0, n).map(([sx, sz]) => ({
      pos: [R(sx * (L / 2 - inX)), R(H / 2), R(sz * span / 2)], rot: [0, 0, 0],
    }));
  } else {
    leg.frame = true; // 左右の脚フレーム（前後2本の脚＋横棒）
    leg.size = [R(d), R(H), R(span)];
    leg.qty = legQty;
    const xs = legQty === 1 ? [0] : [-(L / 2 - inX), L / 2 - inX];
    leg.instances = xs.map((x) => ({ pos: [R(x), R(H / 2), 0], rot: [0, 0, 0] }));
  }

  const innerSpan = L - 2 * inX - d;
  solids.filter((p) => p !== top && p !== leg && p.kind === 'board').forEach((p) => {
    const ad = dimsMM(p);
    const t = ad[0];
    let h = ad[1] ?? 70;
    let len = ad[ad.length - 1];
    if (len > innerSpan || len < innerSpan * 0.5) len = innerSpan;
    h = Math.min(h, 200);
    const q = clampInt(p.qty, 1, 2);
    p.size = [R(len), R(h), R(t)];
    p.qty = q;
    p.instances = [];
    for (let i = 0; i < q; i++) {
      const z = (i % 2 === 0 ? -1 : 1) * span / 2;
      p.instances.push({ pos: [0, R(H - h / 2), R(z)], rot: [0, 0, 0] });
    }
  });
  return true;
}

// ---------- 接触面の計算（ネジの位置に使う） ----------
function halfExt(it) {
  const s = sizeOf(it.def);
  const board = normKind(it.def) === 'board';
  const h = board || it.def.frame ? [s[0] / 2, s[1] / 2, s[2] / 2] : [s[0] / 2, s[1] / 2, s[0] / 2];
  const m = new THREE.Matrix4().makeRotationFromQuaternion(it.pose.quat).elements;
  return [0, 1, 2].map((i) => Math.abs(m[i]) * h[0] + Math.abs(m[4 + i]) * h[1] + Math.abs(m[8 + i]) * h[2]);
}

function contactOf(A, B, eps) {
  const ca = A.pose.pos.toArray(), cb = B.pose.pos.toArray();
  const ha = halfExt(A), hb = halfExt(B);
  const gap = [0, 1, 2].map((i) => Math.abs(ca[i] - cb[i]) - (ha[i] + hb[i]));
  const k = gap.indexOf(Math.max(...gap));
  if (gap[k] > eps || gap[k] < -modelSize * 0.05) return null; // 接していない
  const ov = [0, 1, 2].filter((i) => i !== k).map((i) => ({
    i, lo: Math.max(ca[i] - ha[i], cb[i] - hb[i]), hi: Math.min(ca[i] + ha[i], cb[i] + hb[i]),
  }));
  if (ov.some((o) => o.hi < o.lo - eps)) return null;
  return { k, sign: ca[k] >= cb[k] ? 1 : -1, ca, cb, ha, hb, ov };
}

function anchorsFromContact(ct, count) {
  const { k, sign, ca, cb, ha, hb, ov } = ct;
  const len = (o) => Math.max(o.hi - o.lo, 0);
  const [sAx, rAx] = len(ov[0]) >= len(ov[1]) ? [ov[0], ov[1]] : [ov[1], ov[0]];
  const sC = (sAx.lo + sAx.hi) / 2, rC = (rAx.lo + rAx.hi) / 2, sLen = len(sAx);

  // 外から見える側の面にネジを出す
  const sideA = { face: ca[k] + sign * ha[k], n: sign };
  const sideB = { face: cb[k] - sign * hb[k], n: -sign };
  const dist = (sd) => {
    const p = [0, 0, 0];
    p[k] = sd.face; p[sAx.i] = sC; p[rAx.i] = rC;
    return Math.hypot(p[0] - modelCenter.x, p[1] - modelCenter.y, p[2] - modelCenter.z);
  };
  const side = dist(sideA) >= dist(sideB) ? sideA : sideB;

  const out = [];
  for (let j = 0; j < count; j++) {
    const t = count > 1 ? (j + 0.5) / count - 0.5 : 0;
    const p = [0, 0, 0], n = [0, 0, 0];
    p[k] = side.face; p[sAx.i] = sC + t * sLen * 0.7; p[rAx.i] = rC;
    n[k] = side.n;
    out.push({ p: new THREE.Vector3(...p), n: new THREE.Vector3(...n) });
  }
  return out;
}

// ---------- 部品の見た目 ----------
// 脚フレーム: 前後2本の脚と、上下の横棒を1つの形にまとめる
function frameGeometry(span, H, d) {
  const rod = (z) => {
    const g = new THREE.CylinderGeometry(d / 2, d / 2, H, 20);
    g.translate(0, 0, z);
    return g;
  };
  const bar = (y) => {
    const g = new THREE.CylinderGeometry(d * 0.35, d * 0.35, span, 12);
    g.rotateX(Math.PI / 2);
    g.translate(0, y, 0);
    return g;
  };
  const list = [rod(-span / 2), rod(span / 2), bar(H / 2 - d * 0.6), bar(-H / 2 + H * 0.12)];
  return mergeGeometries(list) || list[0];
}

function buildMesh(p, i) {
  const kind = normKind(p);
  let s = sizeOf(p);
  if (kind === 'screw') {
    // 小さすぎても見えるよう、全体の大きさに合わせて最低サイズを確保
    const minD = modelSize * 0.012, minL = modelSize * 0.035;
    const dd = Math.max(s[0], minD);
    s = [dd, Math.max(s[1], minL), dd];
  }
  const round = kind !== 'board';
  const geo = p.frame
    ? frameGeometry(s[2], s[1], s[0])
    : round
      ? new THREE.CylinderGeometry(s[0] / 2, s[0] / 2, s[1], 32)
      : new THREE.BoxGeometry(s[0], s[1], s[2]);
  const color =
    kind === 'screw'
      ? FASTENER_COLOR
      : /^#[0-9a-f]{6}$/i.test(p.color || '') ? p.color : PALETTE[i % PALETTE.length];
  const mat = new THREE.MeshStandardMaterial({
    color, emissive: 0x000000,
    metalness: kind === 'screw' ? 0.4 : 0, roughness: kind === 'screw' ? 0.4 : 0.8,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0x333333 })));

  if (kind === 'screw') {
    // ネジの頭と溝（+Y側が頭）
    const headH = s[0] * 0.5;
    const hgeo = new THREE.CylinderGeometry(s[0] * 0.95, s[0] * 0.95, headH, 24);
    const head = new THREE.Mesh(hgeo, mat);
    head.position.y = s[1] / 2 + headH / 2;
    head.add(new THREE.LineSegments(new THREE.EdgesGeometry(hgeo), new THREE.LineBasicMaterial({ color: 0x333333 })));
    const slot = new THREE.Mesh(
      new THREE.BoxGeometry(s[0] * 1.5, headH * 0.25, s[0] * 0.25),
      new THREE.MeshBasicMaterial({ color: 0x222222 })
    );
    slot.position.y = headH / 2;
    head.add(slot);
    mesh.add(head);
  }
  mesh.userData.r = Math.max(...s) / 2;
  mesh.userData.size = s;
  return mesh;
}

function makeLabel(text, bg) {
  const c = document.createElement('canvas');
  c.width = 640;
  c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = bg;
  g.fillRect(0, 0, 640, 64);
  g.fillStyle = '#fff';
  g.font = 'bold 26px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(String(text).slice(0, 30), 320, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sp.scale.set(modelSize * 0.36, modelSize * 0.036, 1);
  sp.visible = false;
  return sp;
}

function makeItem(it) {
  it.uid = items.length;
  it.mesh = buildMesh(it.def, it.defIndex);
  it.mesh.visible = false;
  scene.add(it.mesh);
  const labelText = it.fast
    ? (it.def.name || 'ネジ')
    : `${it.def.id} ${it.def.name || ''} ${fmtDim(it.def, MM)}`.trim();
  it.label = makeLabel(labelText, it.fast ? 'rgba(220,100,0,0.95)' : 'rgba(34,68,204,0.92)');
  scene.add(it.label);
  it.top = it.mesh.userData.r + modelSize * 0.04;
  items.push(it);
}

function clearMarkers() {
  markers.forEach((m) => scene.remove(m.mesh));
  markers = [];
}

function clearAnims() {
  anims.forEach((a) => {
    if (a.arrow) scene.remove(a.arrow);
    if (a.ghost) scene.remove(a.ghost);
  });
  anims = [];
}

function clearScene() {
  clearAnims();
  clearMarkers();
  items.forEach((it) => { scene.remove(it.mesh); scene.remove(it.label); });
  items = [];
  if (ghostGroup) { scene.remove(ghostGroup); ghostGroup = null; }
}

// 接触面が見つからないときの予備: ネジを相手の部品の表面に並べる（頭が外側）
function placeScrew(sc, target, k, total) {
  const s = sizeOf(target.def);
  const ax = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)]
    .map((v) => v.applyQuaternion(target.pose.quat));
  const thin = s.indexOf(Math.min(...s));
  const others = [0, 1, 2].filter((i) => i !== thin);
  const long = s[others[0]] >= s[others[1]] ? others[0] : others[1];
  const n = ax[thin].clone();
  if (n.dot(target.pose.pos.clone().sub(modelCenter)) < 0) n.negate();

  const sl = sc.mesh.userData.size[1];
  const embed = Math.min(sl * 0.9, s[thin] * 0.9);
  const t = total > 1 ? (k + 0.5) / total - 0.5 : 0;
  const pos = target.pose.pos.clone()
    .addScaledVector(n, s[thin] / 2 + (sl / 2 - embed))
    .addScaledVector(ax[long], t * s[long] * 0.7);
  sc.pose = { pos, quat: new THREE.Quaternion().setFromUnitVectors(Y_AXIS, n) };
  sc.axis = n;
}

// ---------- データ読み込み ----------
function loadData(json) {
  const parts = (json.parts || [])
    .filter((p) => p && p.id != null)
    .map((p) => ({ ...p, id: String(p.id), kind: normKind(p) }));
  const rawSteps = (json.steps || []).filter((s) => s);
  if (!parts.length || !rawSteps.length) throw new Error('部品または手順が空でした');

  parts.forEach((p) => { if (!p.dims) p.dims = (p.size || []).slice(); }); // 元の寸法を残す（表示用）
  ({ K, MM } = detectScale(parts));
  solveLayout(parts) || tablePreset(parts); // 位置関係 → 机の予備 → AIの座標、の順に使う
  clearScene();

  const byId = {};
  parts.forEach((p) => { byId[normId(p.id)] = p; });
  const findDef = (id) => byId[normId(id)] || parts.find((p) => p.name && p.name === String(id));

  // 部品1個ごとの完成位置
  const inst = [];
  const byPart = {};
  parts.forEach((p, pi) => {
    if (p.kind === 'screw') return;
    const q = clampInt(p.qty, 1, 8);
    const sz = sizeOf(p);
    byPart[p.id] = [];
    for (let i = 0; i < q; i++) {
      const src = (p.instances || [])[i] || {};
      const pos = Array.isArray(src.pos) ? vec(src.pos) : new THREE.Vector3(i * sz[0] * 1.3, sz[1] / 2, 0);
      const it = { def: p, defIndex: pi, pose: { pos, quat: quat(src.rot) }, step: Infinity, fast: false, screw: false };
      byPart[p.id].push(it);
      inst.push(it);
    }
  });
  if (!inst.length) throw new Error('部品の配置を読み取れませんでした');

  // 完成形の大きさと中心
  const box = new THREE.Box3();
  inst.forEach((it) => {
    const r = Math.max(...sizeOf(it.def)) / 2;
    box.expandByPoint(it.pose.pos.clone().addScalar(r));
    box.expandByPoint(it.pose.pos.clone().addScalar(-r));
  });
  box.getCenter(modelCenter);
  const sz = box.getSize(new THREE.Vector3());
  modelSize = Math.max(sz.x, sz.y, sz.z, 20);

  const dist = modelSize * 2.2;
  controls.target.copy(modelCenter);
  camera.position.set(modelCenter.x + dist * 0.8, modelCenter.y + dist * 0.6, modelCenter.z + dist);
  camera.near = modelSize / 100;
  camera.far = modelSize * 50;
  camera.updateProjectionMatrix();
  focusTarget.copy(modelCenter);
  focusDist = dist;

  inst.forEach(makeItem);

  // 手順ごとに、使う部品・ネジを割り当てる
  const steps = [];
  const used = {};
  const before = [];
  rawSteps.forEach((st, si) => {
    const active = [];
    const wantScrews = [];
    const mats = [];

    (st.uses || []).forEach((u) => {
      const def = findDef(u.id);
      if (!def) return;
      const q = clampInt(u.qty, 1, 99);
      if (def.kind === 'screw') {
        wantScrews.push({ def, q });
        mats.push(`${def.id} ${def.name || '留め具'} ×${q}`);
        return;
      }
      const list = byPart[def.id] || [];
      let n = used[def.id] || 0;
      let got = 0;
      while (got < q && n < list.length) { list[n].step = si; active.push(list[n]); n++; got++; }
      used[def.id] = n;
      if (got) mats.push(`${def.id} ${def.name || ''} ${fmtDim(def, MM)} ×${got}`);
    });

    if (wantScrews.length) {
      const news = active.filter((x) => !x.fast);
      const intoDef = st.into != null ? findDef(st.into) : null;
      const intoItem = intoDef
        ? news.find((x) => x.def === intoDef) || [...before].reverse().find((x) => x.def === intoDef)
        : null;
      const total = wantScrews.reduce((a, w) => a + Math.min(w.q, 6), 0);

      // 接している部品の組を探し、その接触面にネジを置く
      const eps = modelSize * 0.02;
      const pool = [...news, ...before];
      const cands = news.length ? news : intoItem ? [intoItem] : before.slice(-3);
      let pairs = [];
      const seen = new Set();
      cands.forEach((A) => pool.forEach((B) => {
        if (A === B) return;
        const key = A.uid < B.uid ? `${A.uid}-${B.uid}` : `${B.uid}-${A.uid}`;
        if (seen.has(key)) return;
        const ct = contactOf(A, B, eps);
        if (ct) { seen.add(key); pairs.push({ ct, A, B }); }
      }));
      const pref = intoItem ? pairs.filter((x) => x.A === intoItem || x.B === intoItem) : [];
      if (pref.length) pairs = pref;
      pairs = pairs.slice(0, 4);

      const anchors = [];
      if (pairs.length) {
        const per = Math.ceil(total / pairs.length);
        pairs.forEach((x) => anchors.push(...anchorsFromContact(x.ct, per)));
      }
      const target = intoItem || news[news.length - 1] || before[before.length - 1];

      let k = 0;
      wantScrews.forEach((w) => {
        for (let c = 0; c < Math.min(w.q, 6); c++, k++) {
          if (!anchors.length && !target) return;
          const sc = { def: w.def, defIndex: parts.indexOf(w.def), step: si, fast: true, screw: true };
          makeItem(sc);
          if (anchors.length) {
            const a = anchors[k % anchors.length];
            const sl = sc.mesh.userData.size[1];
            sc.axis = a.n.clone();
            sc.pose = {
              pos: a.p.clone().addScaledVector(a.n, sl * 0.3),
              quat: new THREE.Quaternion().setFromUnitVectors(Y_AXIS, a.n),
            };
          } else {
            placeScrew(sc, target, k, total);
          }
          active.push(sc);
        }
      });
    }
    before.push(...active.filter((x) => !x.fast));
    steps.push({ text: String(st.text || ''), page: num(st.page, 0), active, materials: mats });
  });

  // 完成形のガイド（うすい枠線）。手順で使う部品だけ
  ghostGroup = new THREE.Group();
  items.forEach((it) => {
    if (it.fast || it.step === Infinity) return;
    const g = new THREE.LineSegments(
      new THREE.EdgesGeometry(it.mesh.geometry),
      new THREE.LineBasicMaterial({ color: 0x8899aa, transparent: true, opacity: 0.45 })
    );
    g.position.copy(it.pose.pos);
    g.quaternion.copy(it.pose.quat);
    ghostGroup.add(g);
  });
  scene.add(ghostGroup);

  data = { title: json.title, parts, steps };
}

// ---------- 矢印・ネジ位置のリング ----------
function addArrow(from, to) {
  const dir = to.clone().sub(from);
  const len = dir.length();
  if (len < 1e-3) return null;
  const a = new THREE.ArrowHelper(
    dir.normalize(), from, len, 0x2244cc,
    Math.min(len * 0.25, modelSize * 0.08), Math.min(len * 0.12, modelSize * 0.05)
  );
  a.line.material.depthTest = false;
  a.cone.material.depthTest = false;
  scene.add(a);
  return a;
}

function addRing(it) {
  const s = it.mesh.userData.size;
  const radius = Math.max(s[0] * 1.6, modelSize * 0.03);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(radius, radius * 0.1, 12, 48),
    new THREE.MeshBasicMaterial({ color: 0xff7a00, transparent: true, opacity: 0.9, depthTest: false })
  );
  ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), it.axis);
  ring.position.copy(it.pose.pos).addScaledVector(it.axis, s[1] / 2);
  ring.renderOrder = 10;
  scene.add(ring);
  markers.push({ mesh: ring });
}

// ---------- 音声案内 ----------
function speak(text) {
  return new Promise((resolve) => {
    if (!$('voice').checked || !text) return resolve();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP';
    u.onend = resolve;
    u.onerror = resolve;
    speechSynthesis.speak(u);
    setTimeout(resolve, Math.max(3000, text.length * 400));
  });
}

// ---------- ステップ移動とアニメーション ----------
function goTo(i) {
  if (!data) return;
  current = Math.max(0, Math.min(data.steps.length - 1, i));
  const step = data.steps[current];
  const speed = num($('speed').value, 1);
  const DUR = 2000 / speed, DUR_SCREW = 1400 / speed, STAGGER = 600 / speed;
  const now = performance.now();

  clearAnims();
  clearMarkers();

  const fastCount = step.active.filter((x) => x.fast).length;
  let order = 0;
  items.forEach((it) => {
    const isAct = it.step === current;
    const vis = it.step <= current;
    it.mesh.visible = vis;
    it.label.visible = isAct && (!it.fast || fastCount <= 2);

    // 動く部品は光らせ、すでに付いた部品は半透明にして見分けやすくする
    const dim = vis && !isAct && !it.fast;
    const m = it.mesh.material;
    m.transparent = dim;
    m.opacity = dim ? 0.45 : 1;
    m.depthWrite = !dim;
    m.emissive.setHex(isAct ? (it.fast ? 0x663300 : 0x2244cc) : 0x000000);
    m.needsUpdate = true;

    if (!vis) return;
    const pose = it.pose;
    if (!isAct) {
      it.mesh.position.copy(pose.pos);
      it.mesh.quaternion.copy(pose.quat);
      return;
    }

    let from;
    if (it.fast) {
      from = { pos: pose.pos.clone().addScaledVector(it.axis, modelSize * 0.25), quat: pose.quat.clone() };
    } else {
      const dir = pose.pos.clone().sub(modelCenter);
      dir.y = 0;
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
      dir.normalize();
      from = {
        pos: pose.pos.clone().addScaledVector(dir, modelSize * 0.45 + it.mesh.userData.r)
          .add(new THREE.Vector3(0, modelSize * 0.3, 0)),
        quat: pose.quat.clone(),
      };
    }
    it.mesh.position.copy(from.pos);
    it.mesh.quaternion.copy(from.quat);

    let ghost = null;
    if (!it.fast) {
      // 取り付け先を青い半透明で示す
      ghost = new THREE.Mesh(
        it.mesh.geometry,
        new THREE.MeshBasicMaterial({ color: 0x2244cc, transparent: true, opacity: 0.25, depthWrite: false })
      );
      ghost.position.copy(pose.pos);
      ghost.quaternion.copy(pose.quat);
      scene.add(ghost);
    } else {
      addRing(it);
    }

    anims.push({
      it, from, to: pose,
      start: now + 300 + order * STAGGER,
      dur: it.fast ? DUR_SCREW : DUR,
      arrow: addArrow(from.pos, pose.pos),
      ghost,
      done: false,
    });
    order++;
  });
  animEnd = anims.length ? Math.max(...anims.map((a) => a.start + a.dur)) : now;

  // カメラを、今組み立てている場所に寄せる
  const fb = new THREE.Box3();
  step.active.forEach((it) => fb.expandByPoint(it.pose.pos));
  if (fb.isEmpty()) {
    focusTarget.copy(modelCenter);
    focusDist = modelSize * 2.0;
  } else {
    fb.getCenter(focusTarget);
    const fs = fb.getSize(new THREE.Vector3());
    focusDist = Math.max(modelSize * 1.3, Math.max(fs.x, fs.y, fs.z) * 3);
  }
  focusUntil = now + 2500;

  hudText = `${current + 1}/${data.steps.length}  ${step.text}`;
  drawHud();
  $('stepNo').textContent = `ステップ ${current + 1} / ${data.steps.length}`;
  $('stepText').textContent =
    step.text + (step.materials.length ? '\n\n【使う材料】\n' + step.materials.map((m) => '・' + m).join('\n') : '');
  if (pdfUrl && step.page) $('pdf').src = `${pdfUrl}#page=${step.page}`;
  lastSpeech = speak(step.text);
}

function updateAnims() {
  const now = performance.now();
  for (const a of anims) {
    if (a.done) continue;
    const t = Math.min(Math.max((now - a.start) / a.dur, 0), 1);
    const e = ease(t);
    a.it.mesh.position.lerpVectors(a.from.pos, a.to.pos, e);
    a.it.mesh.quaternion.copy(a.from.quat).slerp(a.to.quat, e);
    if (a.it.screw) {
      a.it.mesh.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(Y_AXIS, t * Math.PI * 6)); // 3回転しながら入る
    }
    if (t >= 1) {
      a.done = true;
      if (a.arrow) { scene.remove(a.arrow); a.arrow = null; }
      if (a.ghost) { scene.remove(a.ghost); a.ghost = null; }
    }
  }
  const k = 1 + 0.25 * Math.sin(now / 180);
  markers.forEach((m) => m.mesh.scale.setScalar(k));

  // カメラの自動寄り（手で動かしたいときのために、最初の数秒だけ）
  if (now < focusUntil) {
    const prev = controls.target.clone();
    controls.target.lerp(focusTarget, 0.06);
    camera.position.add(controls.target.clone().sub(prev));
    const off = camera.position.clone().sub(controls.target);
    const len = off.length();
    camera.position.copy(controls.target).add(off.setLength(len + (focusDist - len) * 0.05));
  }
}

// ---------- 自動再生 ----------
async function waitStep(step) {
  await sleep(Math.max(0, animEnd - performance.now()) + 200);
  if ($('voice').checked) await lastSpeech;
  else await sleep(Math.min(4000, 1000 + (step.text || '').length * 70));
}

function setPlayingUI(on) {
  $('play').textContent = on ? '▶ 再生中…' : '▶ 自動再生';
}

async function playAll({ loop = true, from = 0 } = {}) {
  if (!data) return false;
  const token = ++playToken;
  setPlayingUI(true);
  let i = from;
  while (token === playToken) {
    goTo(i);
    await waitStep(data.steps[i]);
    if (token !== playToken) return false;
    await sleep(500);
    i++;
    if (i >= data.steps.length) {
      if (!loop) break;
      await sleep(1500);
      i = 0;
    }
  }
  if (token === playToken) setPlayingUI(false);
  return token === playToken;
}

function stopPlay() {
  playToken++;
  speechSynthesis.cancel();
  setPlayingUI(false);
}

// ---------- 音声操作 ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null, listening = false;
if (SR) {
  rec = new SR();
  rec.lang = 'ja-JP';
  rec.continuous = true;
  rec.onresult = (e) => {
    const t = e.results[e.results.length - 1][0].transcript;
    console.log('認識:', t);
    if (/停止|ストップ|止め|止まれ/.test(t)) stopPlay();
    else if (/再生|スタート|はじめ|始め/.test(t)) playAll({ loop: true, from: 0 });
    else if (/もう一回|もう一度|繰り返|くりかえ/.test(t)) { stopPlay(); goTo(current); }
    else if (/次|つぎ|ネクスト/.test(t)) { stopPlay(); goTo(current + 1); }
    else if (/戻|もどる|前|まえ/.test(t)) { stopPlay(); goTo(current - 1); }
  };
  rec.onend = () => { if (listening) rec.start(); };
}
$('mic').onclick = () => {
  if (!rec) return alert('このブラウザは音声認識に未対応です（Chromeを使ってください）');
  listening = !listening;
  $('mic').textContent = listening ? '🎤 音声操作 ON' : '🎤 音声操作 OFF';
  listening ? rec.start() : rec.stop();
};

// ---------- ボタン ----------
$('next').onclick = () => { stopPlay(); goTo(current + 1); };
$('prev').onclick = () => { stopPlay(); goTo(current - 1); };
$('repeat').onclick = () => { stopPlay(); goTo(current); };
$('play').onclick = () => playAll({ loop: true, from: 0 });
$('stop').onclick = () => stopPlay();

// ---------- PDF解析 ----------
async function renderPages(pdf, from, to, maxSide) {
  const images = [];
  for (let i = from; i <= to; i++) {
    const page = await pdf.getPage(i);
    const v1 = page.getViewport({ scale: 1 });
    const scale = Math.min(2.5, maxSide / Math.max(v1.width, v1.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    images.push(canvas.toDataURL('image/jpeg', 0.7));
  }
  return images;
}

async function callApi(body) {
  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error);
  return json;
}

async function runPool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (true) {
      const k = next++;
      if (k >= tasks.length) return;
      results[k] = await tasks[k]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

$('analyze').onclick = async () => {
  const file = $('file').files[0];
  if (!file) return alert('PDFを選んでください');
  stopPlay();
  $('analyze').disabled = true;
  const t0 = performance.now();

  if (pdfUrl) URL.revokeObjectURL(pdfUrl);
  pdfUrl = URL.createObjectURL(file);
  $('pdf').src = pdfUrl;

  try {
    const pdfjs = await import('/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';
    const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    const n = Math.min(pdf.numPages, MAX_PAGES);

    // 1. 部品（名前・寸法・個数・位置関係）と、手順の開始ページ
    $('status').textContent = '部品と寸法を読み取り中…';
    const head = await renderPages(pdf, 1, Math.min(PARTS_PAGES, n), 1280);
    const base = await callApi({ mode: 'layout', images: head });
    const parts = (base.parts || []).filter((p) => p && p.id != null);
    if (!parts.length) throw new Error('部品を読み取れませんでした');

    const sc = detectScale(parts);
    const partsInfo = parts.map((p) => ({
      id: String(p.id), name: p.name, kind: normKind(p), qty: p.qty,
      dim: normKind(p) === 'screw' ? '' : fmtDim(p, sc.MM),
    }));

    // 2. 組み立て開始のページから、手順を並列に解析
    let start = n >= 2 ? Math.min(Math.max(Math.round(num(base.assemblyStartPage, 3)) - 1, 2), n) : 1;
    const tasks = [];
    let done = 0, got = 0, failed = 0;
    for (let s = start; s <= n; s += CHUNK) {
      const a = s, b = Math.min(s + CHUNK - 1, n);
      tasks.push(async () => {
        try {
          const imgs = await renderPages(pdf, a, b, 900);
          const r = await callApi({ mode: 'steps', images: imgs, pageStart: a, pageEnd: b, parts: partsInfo });
          const list = (r.steps || [])
            .filter((st) => st && (st.text || (st.uses || []).length))
            .map((st) => ({ ...st, page: clampInt(st.page, a, b) }));
          got += list.length;
          return list;
        } catch (e) {
          failed++;
          console.error(`${a}-${b}ページの解析に失敗`, e);
          return [];
        } finally {
          done++;
          $('status').textContent = `手順を解析中… ${done}/${tasks.length} 完了（取得済み${got}ステップ）`;
        }
      });
    }
    $('status').textContent = `手順を解析中… 0/${tasks.length} 完了`;
    const steps = (await runPool(tasks, CONCURRENCY)).flat();
    if (!steps.length) throw new Error('手順を読み取れませんでした');

    loadData({ title: base.title, parts, steps });
    const sec = Math.round((performance.now() - t0) / 1000);
    $('status').textContent =
      `${data.title || '家具'}：部品${data.parts.length}種類、${data.steps.length}ステップ（解析${sec}秒）` +
      (failed ? ` ※${failed}か所は解析に失敗` : '');
    goTo(0);
  } catch (e) {
    $('status').textContent = 'エラー: ' + e.message;
  } finally {
    $('analyze').disabled = false;
  }
};

// サンプル: 本棚（寸法と位置関係だけで組み上がる例）
$('sample').onclick = () => {
  stopPlay();
  loadData({
    title: 'テスト本棚',
    parts: [
      { id: 'B', name: '底板', kind: 'board', qty: 1, dims: [18, 300, 382], long_axis: 'x', thin_axis: 'y', anchor: true },
      { id: 'A', name: '側板', kind: 'board', qty: 2, dims: [18, 300, 800], long_axis: 'y', thin_axis: 'x', placements: [
        { on: 'B', at: 'left', align: { y: 'min', z: 'center' } },
        { on: 'B', at: 'right', align: { y: 'min', z: 'center' } } ] },
      { id: 'C', name: '天板', kind: 'board', qty: 1, dims: [18, 300, 418], long_axis: 'x', thin_axis: 'y', placements: [
        { on: 'A', at: 'top', align: { x: 'min', z: 'center' } } ] },
      { id: 'E', name: 'ネジ M4x30', kind: 'screw', qty: 8, dims: [4, 4, 30] },
    ],
    steps: [
      { page: 1, text: '底板B(382×300×18mm)の左右に、側板A(800×300×18mm)を2枚立てます。', uses: [{ id: 'B', qty: 1 }, { id: 'A', qty: 2 }] },
      { page: 1, text: '側板Aの外側から、ネジEを4本で底板Bに固定します。', uses: [{ id: 'E', qty: 4 }], into: 'B' },
      { page: 1, text: '天板C(418×300×18mm)を側板Aの上に乗せます。', uses: [{ id: 'C', qty: 1 }] },
      { page: 1, text: '天板Cをネジ4本で側板Aに固定して完成です。', uses: [{ id: 'E', qty: 4 }], into: 'C' },
    ],
  });
  $('status').textContent = 'サンプルを表示中';
  goTo(0);
};

// ---------- 描画ループ ----------
function loop() {
  requestAnimationFrame(loop);
  try {
    updateAnims();
    items.forEach((it) => {
      if (it.label.visible) {
        it.label.position.set(it.mesh.position.x, it.mesh.position.y + it.top, it.mesh.position.z);
      }
    });
  } catch (e) {
    console.error(e);
  }
  controls.update();
  renderer.clear();
  renderer.render(scene, camera);
  hudMesh.visible = !!hudText;
  renderer.clearDepth();
  renderer.render(hudScene, hudCam);
}
loop();