import * as THREE from 'three';
import { Q, CAPTURE, clamp, lerp, sm, TAU, rad, rng, M4, G } from './util.js';
import { GLSL_NOISE, patch } from './glsl.js';
import { Tex } from './tex.js';
import { Rock } from './rock.js';

const Film = new Proxy({}, {
    get(target, prop) {
        const f = (typeof window !== 'undefined' && window.Film) || (typeof globalThis !== 'undefined' && globalThis.Film);
        if (f && f[prop] !== undefined) return f[prop];
        if (prop === 'DUR') return 90;
        if (prop === 'T') return { BOLT: 49.5, CLASH2: 51.0, SPLASH: 57.0, BLAST: 67.5, OUT: 86.6 };
        if (prop === 'A') return { boltHit: new THREE.Vector3(10, 48, -66), clash2: new THREE.Vector3(0, 30, -30), splash: new THREE.Vector3(0, 0, 0) };
        if (prop === 'beamMidAt') return () => new THREE.Vector3(0, 40, -40);
        if (prop === 'gust') return () => 0;
        if (prop === 'windPhase') return () => 0;
        return undefined;
    }
});

const Dragon = new Proxy({}, {
    get(target, prop) {
        const d = (typeof window !== 'undefined' && window.Dragon) || (typeof globalThis !== 'undefined' && globalThis.Dragon);
        return d ? d[prop] : undefined;
    }
});

const Wake = new Proxy({}, {
    get(target, prop) {
        const w = (typeof window !== 'undefined' && window.Wake) || (typeof globalThis !== 'undefined' && globalThis.Wake);
        return w ? w[prop] : undefined;
    }
});

        // ===== 35_arch.js =====

        // ---- the red halls: timber-frame temple buildings that have stood three hundred years in mountain weather ----
        // Every part is written straight into ONE indexed buffer per material, in world space (tim = timber, paint and metal;
        // stone; roof = tiles and ridges; paper = lit windows; cord = lantern strings). Per vertex: aC = paint (gamma 2) + baked
        // occlusion, aX = height above the foot / kind / half-width of the member (edge wear, gilt edge lines) / seed or wetness.
        // Interface kept: Arch.build(scene, prog, tick), Arch.lanterns, G.lanterns, G.keepOut, G.info.lanterns, and one
        // InstancedMesh whose material has the program key 'lantern' and a .color that FX dims after the blast.
        const Arch = (() => {
            const lanterns = [], burners = [], B = {}, BOX = {};
            function Buf() {
                let cap = 1 << 15;
                const b = { n: 0, ni: 0, P: new Float32Array(cap * 3), N: new Int8Array(cap * 3), C: new Uint8Array(cap * 4), U: new Float32Array(cap * 2), X: new Uint8Array(cap * 4), I: new Uint32Array(cap * 3) };
                b.need = (nv, nidx) => {
                    if (b.n + nv > cap) { while (b.n + nv > cap) cap *= 2; for (const [k, s, T] of [['P', 3, Float32Array], ['N', 3, Int8Array], ['C', 4, Uint8Array], ['U', 2, Float32Array], ['X', 4, Uint8Array]]) { const a = new T(cap * s); a.set(b[k]); b[k] = a; } }
                    if (b.ni + nidx > b.I.length) { let c = b.I.length; while (b.ni + nidx > c) c *= 2; const a = new Uint32Array(c); a.set(b.I); b.I = a; }
                };
                return b;
            }
            for (const k of ['tim', 'stone', 'roof', 'paper', 'cord']) B[k] = Buf();

            // ---------- state: building transform, part transform, paint ----------
            const I4 = new THREE.Matrix4();
            const S = { M: new THREE.Matrix4(), m: new THREE.Matrix4(), mI: true, c0: 255, c1: 255, c2: 255, kind: 0, tri: false, aoMul: 1, wet: -1, seed: 7, gy: 0, ao: null, tag: 'x' };
            const nextSeed = () => { S.seed = (S.seed * 97 + 59) & 255; };
            const paint = (col, kind = 0, o) => { S.c0 = Math.sqrt(col[0]) * 255; S.c1 = Math.sqrt(col[1]) * 255; S.c2 = Math.sqrt(col[2]) * 255; S.kind = kind; S.tri = !!(o && o.tri); S.aoMul = o && o.ao !== undefined ? o.ao : 1; S.wet = o && o.wet !== undefined ? o.wet : -1; };
            // run fn with the part transform multiplied by m (frames nest)
            const _stack = [];
            function withM(m, fn) { _stack.push(S.m, S.mI); S.m = new THREE.Matrix4().multiplyMatrices(S.m, m); S.mI = false; fn(); S.mI = _stack.pop(); S.m = _stack.pop(); }
            const _p = new THREE.Vector3(), _n = new THREE.Vector3();
            function vtx(b, x, y, z, nx, ny, nz, u, v, hw = 1.27, aoK = 1) {
                if (!S.mI) { _p.set(x, y, z).applyMatrix4(S.m); _n.set(nx, ny, nz).transformDirection(S.m); x = _p.x; y = _p.y; z = _p.z; nx = _n.x; ny = _n.y; nz = _n.z; }
                const bx = BOX[S.tag] || (BOX[S.tag] = { l: new THREE.Box3(), w: new THREE.Box3() });
                _p.set(x, y, z); bx.l.expandByPoint(_p);
                const ao = (S.ao ? S.ao(x, y, z, nx, ny, nz) : 1) * S.aoMul * aoK;
                if (S.tri) { if (Math.abs(ny) > 0.7) { u = x; v = z; } else if (Math.abs(nx) > Math.abs(nz)) { u = z; v = y; } else { u = x; v = y; } }
                const hg = (y - S.gy) / 8;
                _p.applyMatrix4(S.M); _n.set(nx, ny, nz).transformDirection(S.M); bx.w.expandByPoint(_p);
                const k = b.n++, k3 = k * 3, k4 = k * 4;
                b.P[k3] = _p.x; b.P[k3 + 1] = _p.y; b.P[k3 + 2] = _p.z;
                b.N[k3] = Math.round(_n.x * 127); b.N[k3 + 1] = Math.round(_n.y * 127); b.N[k3 + 2] = Math.round(_n.z * 127);
                b.C[k4] = S.c0; b.C[k4 + 1] = S.c1; b.C[k4 + 2] = S.c2; b.C[k4 + 3] = clamp(ao) * 255;
                b.U[k * 2] = u; b.U[k * 2 + 1] = v;
                b.X[k4] = clamp(hg) * 255; b.X[k4 + 1] = S.kind; b.X[k4 + 2] = clamp(hw / 1.275) * 255; b.X[k4 + 3] = S.wet >= 0 ? S.wet * 255 : S.seed;
                return k;
            }
            function quadI(b, i0, i1, i2, i3) { const I = b.I, k = b.ni; I[k] = i0; I[k + 1] = i1; I[k + 2] = i2; I[k + 3] = i0; I[k + 4] = i2; I[k + 5] = i3; b.ni = k + 6; }
            function triI(b, i0, i1, i2) { const I = b.I, k = b.ni; I[k] = i0; I[k + 1] = i1; I[k + 2] = i2; b.ni = k + 3; }

            // ---------- primitives ----------
            const BF = [[5, 1, 3, 7], [0, 4, 6, 2], [6, 7, 3, 2], [0, 1, 5, 4], [4, 5, 7, 6], [1, 0, 2, 3]], _c = new Float32Array(24);
            // box centred at (x, y, z). o: skip = face bits (+x 1, -x 2, +y 4, -y 8, +z 16, -z 32); tx, tz / bx, bz = scale of the top / bottom face
            function box(b, w, h, d, x = 0, y = 0, z = 0, o) {
                b.need(24, 36); nextSeed();
                const skip = o && o.skip || 0, tx = o && o.tx !== undefined ? o.tx : 1, tz = o && o.tz !== undefined ? o.tz : 1, bx = o && o.bx !== undefined ? o.bx : 1, bz = o && o.bz !== undefined ? o.bz : 1, c = _c;
                for (let i = 0; i < 8; i++) { const top = i & 2; c[i * 3] = x + (i & 1 ? 0.5 : -0.5) * w * (top ? tx : bx); c[i * 3 + 1] = y + (top ? 0.5 : -0.5) * h; c[i * 3 + 2] = z + (i & 4 ? 0.5 : -0.5) * d * (top ? tz : bz); }
                for (let f = 0; f < 6; f++) {
                    if (skip >> f & 1) continue;
                    const q = BF[f], a = q[0] * 3, b1 = q[1] * 3, c2 = q[2] * 3, d3 = q[3] * 3;
                    const ex = c[b1] - c[a], ey = c[b1 + 1] - c[a + 1], ez = c[b1 + 2] - c[a + 2], fx = c[d3] - c[a], fy = c[d3 + 1] - c[a + 1], fz = c[d3 + 2] - c[a + 2];
                    let nx = ey * fz - ez * fy, ny = ez * fx - ex * fz, nz = ex * fy - ey * fx; const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
                    const la = Math.hypot(ex, ey, ez), lb = Math.hypot(fx, fy, fz); let i0;
                    if (la >= lb) { const hw = lb / 2; i0 = vtx(b, c[a], c[a + 1], c[a + 2], nx, ny, nz, 0, -hw, hw); vtx(b, c[b1], c[b1 + 1], c[b1 + 2], nx, ny, nz, la, -hw, hw); vtx(b, c[c2], c[c2 + 1], c[c2 + 2], nx, ny, nz, la, hw, hw); vtx(b, c[d3], c[d3 + 1], c[d3 + 2], nx, ny, nz, 0, hw, hw); }
                    else { const hw = la / 2; i0 = vtx(b, c[a], c[a + 1], c[a + 2], nx, ny, nz, 0, -hw, hw); vtx(b, c[b1], c[b1 + 1], c[b1 + 2], nx, ny, nz, 0, hw, hw); vtx(b, c[c2], c[c2 + 1], c[c2 + 2], nx, ny, nz, lb, hw, hw); vtx(b, c[d3], c[d3 + 1], c[d3 + 2], nx, ny, nz, lb, -hw, hw); }
                    quadI(b, i0, i0 + 1, i0 + 2, i0 + 3);
                }
            }
            // surface of revolution about y. prof = [[r, y], ...] bottom to top. o: seg, flat (faceted), a0, capT, capB, sx, sz
            function lathe(b, prof, x = 0, y = 0, z = 0, o = {}) {
                const seg = o.seg || 12, a0 = o.a0 || 0, sx = o.sx || 1, sz = o.sz || 1, n = prof.length; nextSeed();
                if (!o.flat) {
                    b.need(n * (seg + 1) + 2 * (seg + 2), (n - 1) * seg * 6 + seg * 6); const base = b.n; let len = 0;
                    for (let i = 0; i < n; i++) {
                        const p0 = prof[Math.max(0, i - 1)], p1 = prof[Math.min(n - 1, i + 1)], dr = p1[0] - p0[0], dy = p1[1] - p0[1], l = Math.hypot(dr, dy) || 1, nr = dy / l, ny = -dr / l;
                        if (i) len += Math.hypot(prof[i][0] - prof[i - 1][0], prof[i][1] - prof[i - 1][1]);
                        for (let j = 0; j <= seg; j++) { const th = a0 + j / seg * TAU, c = Math.cos(th), s = Math.sin(th); vtx(b, x + c * prof[i][0] * sx, y + prof[i][1], z + s * prof[i][0] * sz, c * nr, ny, s * nr, len, th * 0.3); }
                    }
                    for (let i = 0; i < n - 1; i++) for (let j = 0; j < seg; j++) { const p = base + i * (seg + 1) + j; quadI(b, p, p + seg + 1, p + seg + 2, p + 1); }
                } else {
                    b.need((n - 1) * seg * 4 + 2 * (seg + 2), (n - 1) * seg * 6 + seg * 6); let len = 0;
                    for (let i = 0; i < n - 1; i++) {
                        const r0 = prof[i][0], y0 = prof[i][1], r1 = prof[i + 1][0], y1 = prof[i + 1][1], dr = r1 - r0, dy = y1 - y0, l = Math.hypot(dr, dy); if (l < 1e-5) continue;
                        const nr = dy / l, ny = -dr / l, hw = Math.max(r0, r1) * Math.sin(Math.PI / seg);
                        for (let j = 0; j < seg; j++) {
                            const t0 = a0 + j / seg * TAU, t1 = a0 + (j + 1) / seg * TAU, tm = (t0 + t1) / 2, cm = Math.cos(tm) * nr, sm2 = Math.sin(tm) * nr, c0 = Math.cos(t0), s0 = Math.sin(t0), c1 = Math.cos(t1), s1 = Math.sin(t1);
                            const k = vtx(b, x + c0 * r0 * sx, y + y0, z + s0 * r0 * sz, cm, ny, sm2, len, -hw, hw); vtx(b, x + c0 * r1 * sx, y + y1, z + s0 * r1 * sz, cm, ny, sm2, len + l, -hw, hw);
                            vtx(b, x + c1 * r1 * sx, y + y1, z + s1 * r1 * sz, cm, ny, sm2, len + l, hw, hw); vtx(b, x + c1 * r0 * sx, y + y0, z + s1 * r0 * sz, cm, ny, sm2, len, hw, hw); quadI(b, k, k + 1, k + 2, k + 3);
                        }
                        len += l;
                    }
                }
                for (const top of [1, 0]) {
                    if (!(top ? o.capT : o.capB)) continue; const pr = prof[top ? n - 1 : 0], c0 = vtx(b, x, y + pr[1], z, 0, top ? 1 : -1, 0, 0, 0);
                    for (let j = 0; j <= seg; j++) { const th = a0 + j / seg * TAU; vtx(b, x + Math.cos(th) * pr[0] * sx, y + pr[1], z + Math.sin(th) * pr[0] * sz, 0, top ? 1 : -1, 0, Math.cos(th) * pr[0], Math.sin(th) * pr[0]); }
                    for (let j = 0; j < seg; j++) top ? triI(b, c0, c0 + j + 2, c0 + j + 1) : triI(b, c0, c0 + j + 1, c0 + j + 2);
                }
            }
            // polygon [[x, y], ...] (counter-clockwise seen from +z) extruded from z0 to z1, flat sides, both caps
            function extrude(b, pts, z0, z1, o) {
                const n = pts.length, D = z1 - z0; nextSeed(); b.need(n * 6, n * 6 + (n - 2) * 6);
                for (let i = 0; i < n; i++) {
                    const p = pts[i], q = pts[(i + 1) % n], ex = q[0] - p[0], ey = q[1] - p[1], l = Math.hypot(ex, ey); if (l < 1e-6) continue; const nx = ey / l, ny = -ex / l; let k;
                    if (l >= D) { const hw = D / 2; k = vtx(b, p[0], p[1], z1, nx, ny, 0, 0, hw, hw); vtx(b, p[0], p[1], z0, nx, ny, 0, 0, -hw, hw); vtx(b, q[0], q[1], z0, nx, ny, 0, l, -hw, hw); vtx(b, q[0], q[1], z1, nx, ny, 0, l, hw, hw); }
                    else { const hw = l / 2; k = vtx(b, p[0], p[1], z1, nx, ny, 0, D, -hw, hw); vtx(b, p[0], p[1], z0, nx, ny, 0, 0, -hw, hw); vtx(b, q[0], q[1], z0, nx, ny, 0, 0, hw, hw); vtx(b, q[0], q[1], z1, nx, ny, 0, D, hw, hw); }
                    quadI(b, k, k + 1, k + 2, k + 3);
                }
                if (o && o.noCaps) return;
                const tris = THREE.ShapeUtils.triangulateShape(pts.map(p => new THREE.Vector2(p[0], p[1])), []);
                for (const front of [1, 0]) {
                    const k0 = b.n; for (const p of pts) vtx(b, p[0], p[1], front ? z1 : z0, 0, 0, front ? 1 : -1, p[0], p[1]);
                    for (const t of tris) { const a = pts[t[0]], c = pts[t[1]], d = pts[t[2]], ccw = (c[0] - a[0]) * (d[1] - a[1]) - (c[1] - a[1]) * (d[0] - a[0]) > 0; (ccw === !!front) ? triI(b, k0 + t[0], k0 + t[1], k0 + t[2]) : triI(b, k0 + t[0], k0 + t[2], k0 + t[1]); }
                }
            }
            // closed profile [[a (sideways), b (up)], ...], counter-clockwise, swept along pts (Vector3, part space). o: sc(t) scale, round (smooth
            // normals), cap. Sideways is horizontal and to the LEFT of the direction of travel seen from above... (side = T x up)
            const _T = new THREE.Vector3(), _sd = new THREE.Vector3(), _up = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
            function sweep(b, pts, prof, o = {}) {
                const n = pts.length, m = prof.length; nextSeed(); b.need(n * m * 2 + 2 * m, (n - 1) * m * 6 + 2 * (m - 2) * 3);
                const base = b.n; let len = 0;
                for (let i = 0; i < n; i++) {
                    _T.subVectors(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]).normalize(); _sd.crossVectors(_T, o.up || UP); if (_sd.lengthSq() < 1e-6) _sd.set(0, 0, 1); _sd.normalize(); _up.crossVectors(_sd, _T);
                    if (i) len += pts[i].distanceTo(pts[i - 1]); const sc = o.sc ? o.sc(i / (n - 1)) : 1, P = pts[i];
                    for (let j = 0; j < m; j++) {
                        const p = prof[j], q = prof[(j + 1) % m], ea = q[0] - p[0], eb = q[1] - p[1], l = Math.hypot(ea, eb) || 1, hw = l * sc / 2;
                        for (const e of [0, 1]) {
                            const r = e ? q : p; let na = eb / l, nb = -ea / l; if (o.round) { const rl = Math.hypot(r[0], r[1]) || 1; na = r[0] / rl; nb = r[1] / rl; }
                            vtx(b, P.x + (_sd.x * r[0] + _up.x * r[1]) * sc, P.y + (_sd.y * r[0] + _up.y * r[1]) * sc, P.z + (_sd.z * r[0] + _up.z * r[1]) * sc, _sd.x * na + _up.x * nb, _sd.y * na + _up.y * nb, _sd.z * na + _up.z * nb, len, e ? hw : -hw, o.round ? 1.27 : hw);
                        }
                    }
                }
                for (let i = 0; i < n - 1; i++) for (let j = 0; j < m; j++) { const p = base + (i * m + j) * 2; quadI(b, p, p + m * 2, p + m * 2 + 1, p + 1); }
                if (o.cap) for (const end of o.cap === 2 ? [1] : [0, 1]) {
                    const i = end ? n - 1 : 0, P = pts[i], sc = o.sc ? o.sc(end) : 1; _T.subVectors(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]).normalize(); _sd.crossVectors(_T, o.up || UP).normalize(); _up.crossVectors(_sd, _T); const s = end ? 1 : -1, k0 = b.n;
                    for (const r of prof) vtx(b, P.x + (_sd.x * r[0] + _up.x * r[1]) * sc, P.y + (_sd.y * r[0] + _up.y * r[1]) * sc, P.z + (_sd.z * r[0] + _up.z * r[1]) * sc, _T.x * s, _T.y * s, _T.z * s, r[0], r[1]);
                    for (let j = 1; j < m - 1; j++) end ? triI(b, k0, k0 + j + 1, k0 + j) : triI(b, k0, k0 + j, k0 + j + 1);
                }
            }
            const ngon = (r, n, a0 = 0) => { const p = []; for (let i = 0; i < n; i++) { const a = a0 + i / n * TAU; p.push([Math.cos(a) * r, Math.sin(a) * r]); } return p; };
            const rect = (w, h, y0 = 0) => [[-w / 2, y0], [w / 2, y0], [w / 2, y0 + h], [-w / 2, y0 + h]];

            // ---------- paint and materials (Ruined Mughal-Sultani & Jamindar Fortress-Palace: Red Sandstone, Chuna-Surkhi Stucco, Lakhori Brick & Mossy Basalt) ----------
            const RED = [0.46, 0.22, 0.14], RED2 = [0.34, 0.125, 0.075], GRN = [0.38, 0.31, 0.23], BLU = [0.28, 0.23, 0.19], GOLD = [0.58, 0.44, 0.22], DKW = [0.08, 0.052, 0.036], BARE = [0.22, 0.155, 0.11],
                STN = [0.41, 0.35, 0.29], STN2 = [0.29, 0.25, 0.215], STN3 = [0.49, 0.41, 0.335], PLA = [0.60, 0.51, 0.40], BRZ = [0.13, 0.105, 0.072],
                TILE = [1, 1, 1], RDG = [0.34, 0.27, 0.21], YEL = [0.48, 0.39, 0.28], BOARD = [0.18, 0.12, 0.08];
            const K = { LAC: 0, GILT: 1, POLY: 2, BARE: 3, BRZ: 4, PLA: 5, CAI: 6, ASH: 0, PAVE: 1, MONO: 2, SPILL: 3, TILE: 0, RIDGE: 1, YEL: 2 };
            const HEAD_V = 'attribute vec4 aC; attribute vec4 aX; varying vec4 vC; varying vec4 vX; varying vec3 vWP; varying vec3 vWN;';
            const HEAD_F = /* glsl */`varying vec4 vC; varying vec4 vX; varying vec3 vWP; varying vec3 vWN; uniform float uTime;\n${GLSL_NOISE}
    vec3 clBump(vec3 N, vec3 p, float h){ vec3 dpx = dFdx(p), dpy = dFdy(p); float hx = dFdx(h), hy = dFdy(h); vec3 r1 = cross(dpy, N), r2 = cross(N, dpx); float det = dot(dpx, r1);
      vec3 g = sign(det) * (hx * r1 + hy * r2); return normalize(abs(det) * N - g); }`;
            const VARY = '#include <begin_vertex>\n vC = aC; vX = aX; vWP = position; vWN = normal;';
            function wire(mat, key, body, uni, head = '') {
                mat.defines = { USE_UV: '' };
                return patch(mat, s => {
                    if (uni) Object.assign(s.sh.uniforms, uni);
                    s.vHead(HEAD_V); s.v('#include <begin_vertex>', VARY); s.fHead(HEAD_F + head);
                    s.f('#include <map_fragment>', /* glsl */`
        vec3 base = vC.rgb * vC.rgb; float ao = vC.a, hgt = vX.x * 8.0, kind = floor(vX.y * 255.0 + 0.5), hw = vX.z * 1.275, sd = vX.w;
        float clR = 0.6, clM = 0.0, clH = 0.0; vec3 clE = vec3(0.0);
        ${body}
        diffuseColor.rgb = base * mix(0.55, 1.0, ao);`);
                    s.f('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(clR, 0.05, 1.0);');
                    s.f('#include <metalnessmap_fragment>', 'float metalnessFactor = clM;');
                    s.f('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n if (length(fwidth(vWP)) < 0.06) normal = clBump(normal, -vViewPosition, clH);');
                    s.f('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += clE' + (uni && uni.uPool ? ' + diffuseColor.rgb * (0.31831 * ao) * clPool(vWP, normalize(vWN));' : ';'));
                    s.f('#include <aomap_fragment>', '#include <aomap_fragment>\n reflectedLight.indirectDiffuse *= ao; reflectedLight.indirectSpecular *= ao * ao;');
                }, key);
            }
            const GL_TIM = /* glsl */`
    float px = length(fwidth(vWP));
    float n1 = vnoise3(vWP * 3.3 + 7.0), n0 = vnoise3(vWP * 0.8 + sd * 9.0) * 0.64 + n1 * 0.36, n2 = 0.5, n3 = 0.5, gr = 0.5;
    if (px < 0.11) n2 = mix(vnoise(vUv * 15.0 + sd * 3.0), 0.5, smoothstep(0.025, 0.11, px));
    if (px < 0.035) { n3 = mix(vnoise(vUv * 47.0 + sd), 0.5, smoothstep(0.007, 0.035, px)); gr = mix(vnoise(vec2(vUv.x * 1.7 + sd * 37.0, vUv.y * 60.0)) * 0.6 + vnoise(vec2(vUv.x * 5.0, vUv.y * 190.0 + sd * 11.0)) * 0.4, 0.5, smoothstep(0.006, 0.03, px)); }
    float e = hw - abs(vUv.y), sawn = step(hw, 1.2), edge = (1.0 - smoothstep(0.0, 0.045, e)) * sawn;
    float sunE = clamp(dot(vWN, SUN_DIR) * 0.8 + vWN.y * 0.4, 0.0, 1.0) * ao;
    float foot = 1.0 - smoothstep(0.0, 1.95, hgt + (n1 - 0.5) * 0.85);
    float streak = smoothstep(0.40, 0.74, vnoise(vec2(dot(vWP.xz, vec2(0.6, 0.8)) * 6.5, vWP.y * 0.48))) * (1.0 - abs(vWN.y));
    // Courses of thin Mughal/Bengal Lakhori bricks exposed where Chuna-Surkhi stucco has spalled off
    float brRow = floor(vWP.y * 20.0), brCol = floor(dot(vWP.xz, vec2(0.7, 0.7)) * 4.8 + 0.5 * mod(brRow, 2.0));
    float brMort = step(0.83, fract(vWP.y * 20.0)) + step(0.87, fract(dot(vWP.xz, vec2(0.7, 0.7)) * 4.8 + 0.5 * mod(brRow, 2.0)));
    vec3 brick = mix(vec3(0.34, 0.105, 0.055) * (0.72 + 0.48 * hash21(vec2(brCol, brRow))), vec3(0.42, 0.36, 0.28), clamp(brMort, 0.0, 1.0) * 0.65);
    vec3 wood = mix(brick, vec3(0.22, 0.14, 0.095), 0.25 * gr);
    if (kind == 1.0) {                                                                         // tarnished Mughal brass/sandstone inlay worn back to brick
      float worn = smoothstep(0.44, 0.64, n2 * 0.45 + n3 * 0.35 + n0 * 0.35 + edge * 0.22 + foot * 0.28);
      base *= 0.68 + 0.4 * n0; base = mix(base, brick * 0.75, worn * 0.88); clM = mix(0.58, 0.0, worn * 0.9); clR = mix(0.54, 0.90, worn) + 0.10 * n1; clE = vec3(0.0);
    } else if (kind == 3.0) {                                                                  // weathered aged Sal/Teak timber & carved sandstone slabs
      base *= 0.68 + 0.5 * gr; base *= 0.78 + 0.4 * n0; base = mix(base, vec3(0.18, 0.15, 0.12) * (0.7 + 0.6 * gr), sunE * 0.65); base *= 1.0 - 0.42 * streak; clR = 0.88; clH = 0.0015 * gr;
    } else if (kind == 4.0) {                                                                  // antique oxidized bronze & iron with verdigris
      float pat = smoothstep(0.46, 0.74, n2 * 0.45 + n3 * 0.25 + n0 * 0.35 + (1.0 - ao) * 0.4 + max(-vWN.y, 0.0) * 0.15);
      base *= 0.68 + 0.5 * n1; base = mix(base, vec3(0.065, 0.145, 0.11), pat * 0.68); clM = mix(0.70, 0.12, pat); clR = mix(0.48, 0.88, pat);
    } else if (kind == 5.0) {                                                                  // crumbling Chuna-Surkhi lime plaster spalling into Lakhori brick
      base *= 0.72 + 0.38 * n0; base *= 1.0 - 0.54 * streak; base = mix(base, vec3(0.050, 0.080, 0.028), foot * 0.76);
      float spall = smoothstep(0.54, 0.62, n0 * 0.55 + n2 * 0.35 + foot * 0.30 + streak * 0.24);
      base = mix(base, brick, spall * 0.88);
      float cr = 1.0 - smoothstep(0.0, 0.015, abs(vnoise3(vWP * 2.3 + 5.0) - 0.5)); base *= 1.0 - 0.58 * cr * step(0.40, n0); clR = 0.94; clH = -0.004 * spall - 0.002 * cr + 0.001 * n3;
    } else {                                                                                   // Mughal sandstone & stucco masonry (0, 2, 6)
      if (kind == 2.0) { float gl = smoothstep(0.010, 0.016, e) * (1.0 - smoothstep(0.030, 0.036, e)) * sawn; base = mix(base, vec3(0.54, 0.44, 0.33), gl * 0.70); }
      if (kind == 6.0) {                                                                       // Carved Mughal-Sultani Guldasta & Arabesque relief cartouches in red/buff sandstone
        float cw = clamp(hw * 2.0, 0.08, 0.40), u = vUv.x / cw, ci = floor(u), alt = mod(ci, 2.0); vec2 f = vec2(fract(u) - 0.5, vUv.y / cw); float r = length(f), ang = atan(f.y, f.x), pet = 0.042 * cos(ang * 8.0), aa = fwidth(u) + 1e-4;
        vec3 g1 = vec3(0.38, 0.29, 0.22), b1 = vec3(0.32, 0.13, 0.075), gd = vec3(0.54, 0.44, 0.32);
        vec3 c = mix(g1, b1, alt); c = mix(c, mix(b1, g1, alt), 1.0 - smoothstep(0.37 - aa, 0.37 + aa, r + pet));
        c = mix(c, gd, (1.0 - smoothstep(0.015, 0.015 + aa, abs(r + pet * 0.6 - 0.27))) * 0.78); c = mix(c, vec3(0.24, 0.09, 0.05), 1.0 - smoothstep(0.13 - aa, 0.13 + aa, r));
        float gl = (1.0 - smoothstep(0.016, 0.016 + aa, abs(r - 0.40))) + smoothstep(0.012, 0.018, e) * (1.0 - smoothstep(0.034, 0.040, e));
        c = mix(c, gd, clamp(gl, 0.0, 1.0)); base = mix(vec3(0.34, 0.25, 0.19), c, 1.0 - smoothstep(0.30, 0.80, aa));
      }
      float fade = sunE * smoothstep(0.20, 0.64, n0 * 0.7 + n1 * 0.3);
      vec3 faded = mix(base, vec3(dot(base, vec3(0.30, 0.50, 0.20))) * vec3(1.16, 0.96, 0.80) + vec3(0.055, 0.045, 0.035), 0.76);
      base = mix(base, faded, fade * 0.88); base *= 1.0 - 0.50 * streak; base *= (0.72 + 0.50 * n0) * (0.86 + 0.26 * n2);
      if (px < 0.012) { float ck = (1.0 - smoothstep(0.0, 0.03, abs(vnoise(vUv * 41.0 + sd * 5.0) - 0.5))) * (1.0 - smoothstep(0.004, 0.012, px)); base *= 1.0 - 0.24 * ck; clH -= 0.0009 * ck; }
      base = mix(base, vec3(0.060, 0.088, 0.030), clamp(vWN.y, 0.0, 1.0) * 0.65 * (0.4 + n1) + streak * 0.32);       // thick monsoon moss & black-green damp
      base = mix(base, base * (0.26 + 0.25 * n2) + vec3(0.016, 0.030, 0.009), foot * 0.92);
      float chip = smoothstep(0.55, 0.63, n2 * 0.55 + n3 * 0.25 + edge * 0.46 + foot * 0.34 + streak * 0.25 + (n0 - 0.5) * 0.58);
      base = mix(base, wood, chip); clR = mix(0.72 + 0.20 * fade + 0.14 * foot - 0.08 * n1, 0.95, chip); clH += -0.0045 * chip + 0.0009 * gr;
    }`;
            const GL_STONE = /* glsl */`
    float wet = sd, up = max(vWN.y, 0.0);
    float px = length(fwidth(vWP));
    float n1 = vnoise3(vWP * 2.7 + 3.0), n0 = vnoise3(vWP * 0.6) * 0.64 + n1 * 0.36, n2 = 0.5, n3 = 0.5;
    if (px < 0.14) n2 = mix(kind == 2.0 ? vnoise3(vWP * 11.0 + 3.0) : vnoise(vUv * 11.0 + 3.0), 0.5, smoothstep(0.03, 0.14, px));
    if (px < 0.04) n3 = mix(kind == 2.0 ? vnoise3(vWP * 39.0) : vnoise(vUv * 39.0), 0.5, smoothstep(0.008, 0.04, px));
    float joint = 0.0, id = 0.5, spill = step(2.5, kind);
    if (spill > 0.5) wet = max(wet, 1.0 - smoothstep(1.9, 5.7, abs(vWP.x) + (n1 - 0.5) * 2.4));
    if (kind != 2.0) { vec2 bs = kind == 1.0 ? vec2(0.92, 0.61) : vec2(1.15, 0.40); float row = floor(vUv.y / bs.y), xo = vUv.x / bs.x + hash11(row * 3.7 + 1.0) * 0.6 + 0.5 * mod(row, 2.0), bi = floor(xo);
      vec2 f = vec2(fract(xo) * bs.x, fract(vUv.y / bs.y) * bs.y); float jd = min(min(f.x, bs.x - f.x), min(f.y, bs.y - f.y)), fw = max(fwidth(vUv.x), fwidth(vUv.y)) + 1e-4;
      joint = clamp((0.010 - jd) / fw + 0.5, 0.0, 1.0) * min(1.0, 0.035 / fw); id = hash21(vec2(bi, row) + 0.37); }
    base *= 0.76 + 0.44 * id; base = mix(base, base * vec3(1.10, 0.97, 0.84), hash11(id * 91.0)); base *= 0.80 + 0.40 * (n1 * 0.6 + n0 * 0.4);
    float streak = smoothstep(0.46, 0.76, vnoise(vec2(dot(vWP.xz, vec2(0.6, 0.8)) * 5.0, vWP.y * 0.4))) * (1.0 - up);
    base *= 1.0 - 0.40 * streak;
    float damp = max((1.0 - smoothstep(0.0, 0.9, hgt + (n1 - 0.5) * 0.7)) * 0.8, wet);
    float moss = smoothstep(0.58, 0.78, n0 * 0.50 + n1 * 0.20 + (1.0 - smoothstep(0.0, 1.6, hgt)) * 0.38 + (1.0 - ao) * 0.24 + wet * 0.24 + joint * 0.14);
    float lichen = smoothstep(0.72, 0.80, vnoise(vUv * 1.9 + 20.0) * 0.6 + n2 * 0.4) * (1.0 - moss) * (1.0 - wet);
    base *= mix(1.0, 0.48, damp);
    base = mix(base, vec3(0.068, 0.092, 0.030) * (0.6 + 0.8 * n3), moss * 0.88);
    base = mix(base, vec3(0.48, 0.46, 0.38), lichen * 0.52);
    if (spill > 0.5) {
      float run = smoothstep(0.40, 0.74, vnoise(vec2(vWP.x * 2.6, vWP.y * 0.16 + 7.0)));
      base *= 1.0 - 0.55 * run * (0.35 + 0.65 * wet);
      base = mix(base, vec3(0.036, 0.058, 0.028) * (0.7 + 0.6 * n3), smoothstep(0.52, 0.95, wet + 0.25 * n0 - 0.12) * 0.74);
      float lime = smoothstep(0.26, 0.40, wet) * (1.0 - smoothstep(0.50, 0.66, wet)) * smoothstep(0.50, 0.78, vnoise(vec2(vWP.x * 5.0, vWP.y * 0.3)));
      base = mix(base, vec3(0.60, 0.58, 0.50), lime * 0.5);
    }
    base = mix(base, base * 0.28, joint); base *= 0.90 + 0.20 * n3;
    clR = mix(0.93, 0.30, wet * (0.55 + 0.45 * n1)); clH = -0.010 * joint + 0.0045 * n3 + 0.005 * n2 + 0.006 * moss * n3;`;

            const GL_ROOF = /* glsl */`
    float tt = vX.x, fur = sd, n2 = vnoise(vec2(vUv.x * 0.37, vUv.y) * 9.0 + vWP.y), n0 = vnoise3(vWP * 0.65) * 0.7 + n2 * 0.3;
    float brRow = floor(vWP.y * 19.0), brCol = floor(dot(vWP.xz, vec2(0.7, 0.7)) * 4.6 + 0.5 * mod(brRow, 2.0));
    vec3 brick = vec3(0.33, 0.105, 0.055) * (0.75 + 0.45 * hash21(vec2(brCol, brRow)));
    if (kind == 0.0) {                                                                         // Mughal Chhajja sloping red/buff sandstone slabs with chiselled joints & moss
      float row = floor(vUv.x + 0.01), lap = vUv.y / 0.55 + hash11(row * 1.7) * 0.20, lf = fract(lap), id = hash21(vec2(row, floor(lap)));
      vec3 glz = mix(vec3(0.34, 0.16, 0.10), vec3(0.46, 0.32, 0.23), id);
      glz = mix(glz, vec3(0.24, 0.11, 0.07), step(0.82, id));
      float lod = 1.0 - smoothstep(0.06, 0.28, fwidth(vUv.y));
      base = glz * (1.0 - 0.25 * smoothstep(0.84, 1.0, lf) * lod);
      float dirt = smoothstep(0.25, 0.90, fur), moss = smoothstep(0.42, 0.66, n0 * 0.7 + n2 * 0.25 + fur * 0.35 - tt * 0.08);
      float run = smoothstep(0.45, 0.78, vnoise(vec2(vUv.x * 0.45, 3.0))) * smoothstep(0.40, 1.0, tt);
      base *= 1.0 - 0.45 * dirt; base *= 1.0 - 0.40 * run;
      base = mix(base, vec3(0.062, 0.090, 0.028), moss * (0.45 + 0.55 * fur));
      clR = mix(0.78 + 0.14 * id, 0.96, max(moss * 0.85, dirt * 0.75)); clH = 0.007 * (1.0 - lf) * smoothstep(0.0, 0.07, lf) * lod;
    } else {                                                                                   // Kangura battlements (1) & Fluted Mughal Domes (2) with spalled stucco, brick & moss
      float flute = kind == 2.0 ? 0.5 + 0.5 * cos(vUv.y * 80.0) : 0.5;
      float moss = smoothstep(0.46, 0.68, n0 * 0.65 + n2 * 0.35 + max(vWN.y, 0.0) * 0.22);
      float spall = smoothstep(0.58, 0.66, n0 * 0.6 + n2 * 0.4 - max(vWN.y, 0.0) * 0.15);
      base *= (0.72 + 0.45 * n2) * (0.90 + 0.16 * flute);
      base = mix(base, brick, spall * 0.82);
      base = mix(base, vec3(0.060, 0.088, 0.028), moss * 0.68);
      base *= 1.0 - 0.38 * smoothstep(0.46, 0.78, vnoise(vec2(dot(vWP.xz, vec2(0.6, 0.8)) * 8.0, vWP.y * 0.8)));
      clR = mix(0.76, 0.96, max(moss, spall)); clH = 0.003 * flute - 0.004 * spall;
    }`;
            const mkAO = (ev, pl) => (x, y, z, nx, ny, nz) => {
                let a = 1;
                for (const e of ev) {
                    if (y > e.y + 0.25 || y < e.y0) continue; const din = Math.min(e.a - Math.abs(x - e.cx), e.b - Math.abs(z)); if (din <= 0) continue;
                    const vis = Math.atan2(Math.max(0.04, e.y - y), din * 0.9) / 1.5708; a *= lerp(0.30, 1, clamp(vis * 1.15 - (ny < -0.5 ? 0.12 : 0)));
                }
                for (const p of pl) { const h = y - p.y; if (h < 0.03 || h > 0.5 || Math.abs(x - (p.cx || 0)) > p.a || Math.abs(z - (p.cz || 0)) > p.b) continue; a *= lerp(0.5, 1, sm(0, 0.45, h)); }
                return a;
            };
            const sb = B.stone, tb = B.tim, rb = B.roof;

            // ---------- stone & podiums ----------
            function podium(w, d, top, cx = 0, cz = 0, y0 = 0) {
                paint(STN2, K.ASH, { tri: 1 }); box(sb, w + 0.40, 0.28, d + 0.40, cx, y0 + 0.14, cz, { skip: 8 });
                paint(STN, K.ASH, { tri: 1 }); box(sb, w, top - 0.22 - 0.28 - y0, d, cx, (y0 + 0.28 + top - 0.22) / 2, cz, { skip: 12 });
                paint(STN3, K.MONO, { tri: 1 }); box(sb, w + 0.24, 0.08, d + 0.24, cx, top - 0.25, cz, { tx: 1, tz: 1, bx: w / (w + 0.24), bz: d / (d + 0.24) });
                box(sb, w + 0.44, 0.21, d + 0.44, cx, top - 0.105, cz, { skip: 4 });
                paint(STN3, K.PAVE, { tri: 1 }); box(sb, w + 0.44, 0.02, d + 0.44, cx, top - 0.01, cz, { skip: 59 });
            }
            function stairs(n, rise, tread, width, cheeks = 3) {
                const H = n * rise, R = (n - 1) * tread;
                paint(STN3, K.PAVE, { tri: 1 });
                for (let i = 0; i < n - 1; i++) { const yt = -(i + 1) * rise; box(sb, width, H + 0.4 + yt, tread + 0.03, 0, (yt - H - 0.4) / 2, (i + 0.5) * tread + 0.015, { skip: 8 }); }
                paint(STN, K.MONO, { tri: 1 });
                const poly = [[-0.05, -H - 0.4], [R + 0.34, -H - 0.4], [R + 0.34, -H + 0.20], [R + 0.05, -H + 0.30], [-0.05, 0.13]];
                for (const s of [-1, 1]) if (cheeks & (s < 0 ? 1 : 2)) withM(M4(s * (width / 2 + 0.15), 0, 0, 0, -Math.PI / 2, 0), () => extrude(sb, poly, -0.18, 0.18));
            }
            // Mughal & Jamindar carved sandstone balustrade with Kumbha-Kalasha posts & recessed Jali panels
            const POST = [[0.150, 0], [0.150, 0.18], [0.095, 0.24], [0.155, 0.44], [0.145, 0.62], [0.088, 0.76], [0.145, 0.86], [0.145, 0.98], [0.095, 1.06], [0.125, 1.15], [0, 1.22]];
            function balus(pts, y) {
                for (let i = 0; i < pts.length - 1; i++) {
                    const A = pts[i], C = pts[i + 1], dx = C[0] - A[0], dz = C[1] - A[1], len = Math.hypot(dx, dz), n = Math.max(1, Math.round(len / 1.45)), ang = Math.atan2(-dz, dx), sl = len / n;
                    paint(STN3, K.MONO, { tri: 1 });
                    for (let k = i ? 1 : 0; k <= n; k++) withM(M4(A[0] + dx * k / n, y, A[1] + dz * k / n, 0, ang, 0), () => lathe(sb, POST, 0, 0, 0, { seg: 8, flat: 1 }));
                    for (let k = 0; k < n; k++) withM(M4(A[0] + dx * (k + 0.5) / n, y, A[1] + dz * (k + 0.5) / n, 0, ang, 0), () => {
                        paint(STN3, K.MONO, { tri: 1 }); box(sb, sl - 0.18, 0.11, 0.15, 0, 0.745, 0, { skip: 3 }); box(sb, sl - 0.18, 0.13, 0.16, 0, 0.065, 0, { skip: 11 });
                        paint(STN, K.MONO, { tri: 1 }); box(sb, sl - 0.18, 0.56, 0.08, 0, 0.41, 0, { skip: 15 });
                        paint(STN3, K.MONO, { tri: 1 }); box(sb, sl - 0.46, 0.34, 0.11, 0, 0.41, 0, { skip: 3, tx: 0.94, bx: 0.94 });
                    });
                }
            }
            // Mughal octagonal stone garden Mashal / Fanoos lamp pillar
            function stoneLantern(x, y, z, s = 1) {
                withM(M4(x, y, z, 0, 0.3, 0, s), () => {
                    paint(STN, K.MONO, { tri: 1 }); const o = { seg: 8, flat: 1 };
                    lathe(sb, [[0.38, -0.5], [0.38, 0.14], [0.28, 0.22], [0.16, 0.32], [0.12, 0.98], [0.19, 1.06], [0.29, 1.13], [0.29, 1.16]], 0, 0, 0, o);
                    paint(BRZ, K.BRZ);
                    for (let k = 0; k < 6; k++) { const a = (k + 0.5) / 6 * TAU; box(tb, 0.038, 0.42, 0.038, Math.cos(a) * 0.22, 1.36, Math.sin(a) * 0.22); }
                    paint(STN3, K.MONO, { tri: 1 }); lathe(sb, [[0.28, 1.56], [0.36, 1.60], [0.40, 1.72], [0.32, 1.86], [0.15, 1.98], [0.06, 2.06], [0.09, 2.12], [0, 2.22]], 0, 0, 0, o);
                    lathe(sb, [[0.28, 1.15], [0.28, 1.16]], 0, 0, 0, { seg: 8, flat: 1, capT: 1 }); lathe(sb, [[0.28, 1.56], [0.28, 1.57]], 0, 0, 0, { seg: 8, flat: 1, capB: 1 });
                    glowBox(0.18, 1.17, 1.55, 6);
                });
            }
            // Mughal courtyard octagonal stone & antique bronze ritual brazier / Hauz urn
            function burner(x, y, z, s = 1) {
                withM(M4(x, y, z, 0, 0.5, 0, s), () => {
                    paint(STN, K.MONO, { tri: 1 }); box(sb, 1.08, 0.30, 1.08, 0, 0.15, 0, { skip: 8, tx: 0.9, tz: 0.9 }); box(sb, 0.84, 0.12, 0.84, 0, 0.36, 0, { skip: 8 });
                    paint(BRZ, K.BRZ);
                    for (let k = 0; k < 3; k++) { const a = k / 3 * TAU + 0.5; withM(M4(Math.cos(a) * 0.27, 0.40, Math.sin(a) * 0.27, 0, -a, 0), () => box(tb, 0.12, 0.40, 0.12, 0.03, 0.2, 0, { bx: 0.6, bz: 0.6, tx: 1.2 })); }
                    lathe(tb, [[0.14, 0.74], [0.32, 0.79], [0.45, 0.94], [0.48, 1.08], [0.38, 1.22], [0.35, 1.26], [0.45, 1.31], [0.48, 1.35], [0.44, 1.37], [0.40, 1.33]], 0, 0, 0, { seg: 12, capB: 1 });
                    for (const sx of [-1, 1]) { box(tb, 0.05, 0.24, 0.18, sx * 0.45, 1.45, 0); box(tb, 0.05, 0.05, 0.26, sx * 0.45, 1.58, 0); }
                    paint([0.30, 0.28, 0.26], K.PLA); lathe(tb, [[0.40, 1.325], [0.40, 1.33]], 0, 0, 0, { seg: 12, capT: 1 });
                    paint([0.25, 0.10, 0.06], K.BARE); const r = rng(77); for (let k = 0; k < 7; k++) box(tb, 0.008, 0.26 + r() * 0.12, 0.008, (r() - 0.5) * 0.3, 1.47, (r() - 0.5) * 0.3);
                    burners.push(new THREE.Vector3(0, 1.62, 0).applyMatrix4(S.m).applyMatrix4(S.M));
                });
            }

            // ---------- Solid Mughal & Jamindar Masonry Elements ----------
            // Shahjahani / Mughal 12-sided & square-pilaster column with Kumbha lotus base, banded shaft, and Muqarnas/Lotus capital
            function column(x, z, y0, h, r, seg = 16) {
                const s12 = 12;
                paint(STN3, K.MONO, { tri: 1 });
                box(sb, r * 3.5, 0.22, r * 3.5, x, y0 + 0.11, z, { skip: 8 });
                box(sb, r * 2.8, 0.24, r * 2.8, x, y0 + 0.34, z, { skip: 8 });
                lathe(sb, [[r * 1.48, 0.46], [r * 1.62, 0.54], [r * 1.30, 0.64], [r * 1.42, 0.72], [r * 1.12, 0.78]], x, y0, z, { seg: s12, flat: 1, capT: 1 });
                paint(PLA, K.PLA);
                lathe(tb, [[r * 1.10, 0.76], [r * 1.14, h * 0.26], [r * 1.06, h * 0.52], [r * 0.98, h * 0.74], [r * 0.95, h - 0.62]], x, y0, z, { seg: s12, flat: 1 });
                // Square masonry pilaster backing so columns merge into solid Mughal arcade piers
                paint(RED, K.LAC); box(tb, r * 1.95, h - 0.46, r * 1.95, x, y0 + (h + 0.46) / 2, z, { skip: 12 });
                paint(STN3, K.MONO, { tri: 1 });
                lathe(tb, [[r * 0.96, h - 0.62], [r * 1.18, h - 0.48], [r * 1.08, h - 0.36], [r * 1.36, h - 0.18], [r * 1.48, h - 0.05], [r * 1.52, h]], x, y0, z, { seg: s12, flat: 1 });
                paint(RED2, K.POLY);
                for (const yy of [0.78, h * 0.42, h - 0.62, h - 0.36]) lathe(tb, [[r * 1.16 + 0.015, yy], [r * 1.16 + 0.015, yy + 0.05]], x, y0, z, { seg: s12, flat: 1 });
            }
            // Solid Mughal masonry entablature frieze & Pishtaq architrave band
            function beam(L, h, t, field = PLA, plain) {
                paint(RED, K.LAC); box(tb, L, h, t * 1.35, 0, 0, 0, { skip: 3 });
                paint(STN3, K.MONO, { tri: 1 }); box(tb, L + 0.08, 0.10, t * 1.52, 0, h / 2 - 0.04, 0); box(tb, L + 0.08, 0.09, t * 1.48, 0, -h / 2 + 0.04, 0);
                if (!plain && L >= 1.5) {
                    paint(field, K.CAI); box(tb, L - 0.24, h * 0.58, t * 1.42, 0, 0, 0, { skip: 3 });
                }
            }
            // Solid Mughal Multi-Cusped Pointed Arch Spandrel (Shahjahani 9-cusp Khilan arcade wall): fills the entire upper bay between piers!
            function brace(len, dp, t, sx) {
                const L = len * 2.15, D = dp * 3.1, th = Math.max(t * 4.8, 0.38);
                // Extrude the solid masonry spandrel wall from column pier (x=0) to the crown of the pointed arch (x=L)
                const pts = [[0, 0], [0, -D]];
                const nC = 5;
                for (let i = 0; i < nC; i++) {
                    const u0 = i / nC, u1 = (i + 0.5) / nC, u2 = (i + 1) / nC;
                    const curve = u => -D * Math.pow(1 - u, 1.55) - 0.04 * D * (1 - u);
                    pts.push([L * u0, curve(u0)], [L * u1, curve(u1) + D * 0.095 * (1 - 0.35 * u1)], [L * u2, curve(u2)]);
                }
                pts.push([L, 0]);
                const poly = sx > 0 ? pts : pts.map(q => [-q[0], q[1]]).reverse();
                paint(PLA, K.PLA); extrude(tb, poly, -th / 2, th / 2);
                // Projecting red sandstone cusped archivolt hood-mould & recessed spandrel rosette (Guldasta boss)
                paint(RED2, K.LAC); box(tb, L * 0.98, 0.11, th + 0.07, sx * L * 0.49, -0.04, 0);
                if (L > 0.75) {
                    paint(STN3, K.MONO, { tri: 1 });
                    withM(M4(sx * L * 0.34, -D * 0.28, th / 2 + 0.02, Math.PI / 2, 0, 0), () => lathe(tb, [[0, 0.04], [0.16, 0.03], [0.19, 0], [0.01, -0.02]], 0, 0, 0, { seg: 8, flat: 1 }));
                    withM(M4(sx * L * 0.34, -D * 0.28, -th / 2 - 0.02, -Math.PI / 2, 0, 0), () => lathe(tb, [[0, 0.04], [0.16, 0.03], [0.19, 0], [0.01, -0.02]], 0, 0, 0, { seg: 8, flat: 1 }));
                }
            }

            // Carved Mughal Sandstone Corbel Console (Toda / Madala S-scroll bracket with hanging lotus pendant)
            const TODA_PROF = [[0, 0], [0, 0.52], [0.68, 0.52], [0.68, 0.38], [0.56, 0.34], [0.52, 0.22], [0.36, 0.20], [0.30, 0.08], [0.16, 0.06], [0.12, 0]];
            function dou(tiers, alt) {
                const sc = tiers > 1 ? 1.05 : 0.82;
                paint(alt ? STN3 : RED, K.MONO, { tri: 1 });
                withM(M4(0, 0, 0, 0, -Math.PI / 2, 0, sc), () => extrude(sb, TODA_PROF, -0.075, 0.075));
                // Carved lotus-bud pendant (Jhumka) hanging from the corbel tip
                paint(RED2, K.POLY);
                lathe(tb, [[0.055 * sc, 0.22 * sc], [0.075 * sc, 0.28 * sc], [0.04 * sc, 0.36 * sc], [0, 0.14 * sc]], 0, 0, 0.50 * sc, { seg: 6, flat: 1 });
            }
            // Mughal frieze & row of carved stone Toda corbel brackets under the Chhajja eave
            function brackets(L, tiers, s, sp = 0.85) {
                paint(RED2, K.LAC); box(tb, L + 0.56, 0.22, 0.52, 0, 0.11, 0);
                paint(STN3, K.MONO, { tri: 1 }); box(sb, L + 0.64, 0.10, 0.62, 0, 0.26, 0.04);
                const n = Math.max(2, Math.round(L / (sp * 0.78)));
                for (let i = 0; i <= n; i++) withM(M4(-L / 2 + L * i / n, 0.22, 0.10, 0, 0, 0, s), () => dou(tiers, i & 1));
                const hy = 0.22 + (tiers > 1 ? 0.52 : 0.42) * s, hz = (tiers > 1 ? 0.56 : 0.44) * s;
                paint(STN3, K.MONO, { tri: 1 }); box(sb, L + 2 * hz + 0.40, 0.14, 0.36, 0, hy, hz);
            }

            // Octagonal Mughal Corner Bastion / Guldasta Turret with optional Chhatri cupola
            function octTower(x, z, y0, h, r, hasCupola = true, ruin = 0) {
                const seg = 8, a0 = Math.PI / 8;
                paint(STN2, K.MONO, { tri: 1 });
                lathe(sb, [[r * 1.32, 0], [r * 1.32, 0.32], [r * 1.15, 0.44], [r * 1.22, 0.56], [r * 1.02, 0.68]], x, y0, z, { seg, flat: 1, a0, capT: 1 });
                paint(PLA, K.PLA);
                lathe(tb, [[r, 0.66], [r * 0.98, h * 0.45], [r * 0.95, h - 0.35]], x, y0, z, { seg, flat: 1, a0 });
                // Horizontal red-sandstone string courses (Bandhana) & flared lotus cornice
                paint(RED2, K.LAC);
                for (const yf of [0.28, 0.56, 0.82]) if (h * yf > 0.9) lathe(tb, [[r * 1.06, h * yf], [r * 1.06, h * yf + 0.12]], x, y0, z, { seg, flat: 1, a0, capT: 1, capB: 1 });
                paint(STN3, K.MONO, { tri: 1 });
                lathe(sb, [[r * 0.95, h - 0.36], [r * 1.18, h - 0.18], [r * 1.24, h]], x, y0, z, { seg, flat: 1, a0, capT: 1 });
                if (!hasCupola) return;
                // Octagonal Chhatri / Guldasta cupola on top of the bastion
                const cy = y0 + h, cr = r * 0.92, ch = r * 1.45;
                if (ruin < 0.7) {
                    for (let k = 0; k < 8; k++) {
                        if (ruin > 0.3 && ((k * 3) % 7 === 0)) continue;
                        const ang = a0 + k / 8 * TAU;
                        paint(STN3, K.MONO, { tri: 1 });
                        box(sb, r * 0.22, ch, r * 0.22, x + Math.cos(ang) * cr * 0.82, cy + ch / 2, z + Math.sin(ang) * cr * 0.82);
                    }
                    paint(RDG, K.RIDGE);
                    lathe(rb, [[cr * 1.32, ch - 0.08], [cr * 0.95, ch + 0.14], [cr * 0.98, ch + 0.32]], x, cy, z, { seg: 8, flat: 1, a0, capB: 1 });
                    paint(YEL, K.YEL);
                    lathe(rb, [[cr * 0.92, ch + 0.28], [cr * 1.08, ch + 0.58], [cr * 0.96, ch + 0.95], [cr * 0.55, ch + 1.32], [cr * 0.16, ch + 1.56], [0, ch + 1.78]], x, cy, z, { seg: 12 });
                    paint(GOLD, K.GILT);
                    lathe(tb, [[0.06, ch + 1.65], [0.11, ch + 1.78], [0.04, ch + 1.95], [0, ch + 2.15]], x, cy, z, { seg: 8 });
                } else {
                    // Ruined stump of a collapsed turret
                    paint(RED, K.PLA);
                    lathe(tb, [[cr * 0.95, 0], [cr * 0.88, ch * 0.45], [cr * 0.62, ch * 0.62]], x, cy, z, { seg: 8, flat: 1, a0, capT: 1 });
                }
            }

            // Monumental Mughal Bulbous Onion Dome (Gumbad) on an Octagonal Drum (Griva) with Kangura collar & Padma-kosha finial
            function mughalDome(cx, cz, y0, rad, h, ruin = 0) {
                const drumH = rad * 0.58, a0 = Math.PI / 8;
                // 1. Octagonal fenestrated masonry drum (Griva)
                paint(STN3, K.MONO, { tri: 1 });
                lathe(sb, [[rad * 1.16, -0.15], [rad * 1.16, 0.16], [rad * 1.04, 0.24]], cx, y0, cz, { seg: 8, flat: 1, a0, capT: 1 });
                paint(PLA, K.PLA);
                lathe(tb, [[rad * 1.04, 0.22], [rad * 1.02, drumH - 0.16]], cx, y0, cz, { seg: 8, flat: 1, a0 });
                // Recessed blind arches & pilasters on the 8 faces of the drum
                paint(RED2, K.LAC);
                for (let k = 0; k < 8; k++) {
                    const ang = k / 8 * TAU;
                    withM(M4(cx + Math.cos(ang) * rad * 0.96, y0 + drumH * 0.52, cz + Math.sin(ang) * rad * 0.96, 0, -ang + Math.PI / 2, 0), () => {
                        box(tb, rad * 0.48, drumH * 0.56, 0.12, 0, 0, 0);
                    });
                }
                // Moulded sandstone drum cornice & Kangura collar
                paint(RDG, K.RIDGE);
                lathe(rb, [[rad * 1.02, drumH - 0.16], [rad * 1.12, drumH - 0.04], [rad * 1.08, drumH + 0.14], [rad * 0.96, drumH + 0.20]], cx, y0, cz, { seg: 16 });
                // 2. Bulbous Fluted Mughal Onion Dome (Gumbad)
                const dy = y0 + drumH + 0.12, dh = h;
                paint(YEL, K.YEL);
                lathe(rb, [
                    [rad * 0.94, 0],
                    [rad * 1.10, dh * 0.18],
                    [rad * 1.14, dh * 0.36],
                    [rad * 1.02, dh * 0.58],
                    [rad * 0.74, dh * 0.78],
                    [rad * 0.36, dh * 0.93],
                    [rad * 0.10, dh * 0.99],
                    [0, dh * 1.02]
                ], cx, dy, cz, { seg: 20 });
                // Inverted Lotus Cap (Padma-kosha) & Tarnished Alam Finial
                paint(STN3, K.MONO, { tri: 1 });
                lathe(sb, [[rad * 0.28, dh * 0.94], [rad * 0.34, dh * 0.98], [rad * 0.16, dh * 1.04], [0.06, dh * 1.08]], cx, dy, cz, { seg: 12, flat: 1 });
                if (ruin < 0.5) {
                    paint(GOLD, K.GILT);
                    lathe(tb, [[0.07, dh * 1.06], [0.16, dh * 1.16], [0.06, dh * 1.26], [0.13, dh * 1.36], [0.04, dh * 1.48], [0.09, dh * 1.56], [0, dh * 1.76]], cx, dy, cz, { seg: 10 });
                }
            }

            // Carved 3D Mughal Kangura (Pointed Trefoil Battlement Merlon) with procedural ruin weathering
            const KANGURA_PTS = [[-0.21, 0], [0.21, 0], [0.21, 0.28], [0.15, 0.34], [0.17, 0.44], [0.08, 0.52], [0, 0.62], [-0.08, 0.52], [-0.17, 0.44], [-0.15, 0.34], [-0.21, 0.28]];
            const KANGURA_BROKEN = [[-0.21, 0], [0.21, 0], [0.21, 0.18], [0.08, 0.26], [-0.06, 0.22], [-0.21, 0.30]];

            // ---------- Mughal Roof System: Sloping Stone Chhajja Eave + Flat Masonry Roof Terrace + Kangura Parapet + Corner Guldastas + Gumbad Domes ----------
            function roof(w, d, h, y, o = {}) {
                const ov = o.ov || 1.6, cx0 = o.cx || 0, fl = o.flat || [0, 0], cut = o.cut, clip = o.clip;
                const w0 = Math.max(2.4, w - 2 * ov * 0.68), d0 = Math.max(2.4, d - 2 * ov * 0.68), a0 = w0 / 2, b0 = d0 / 2;
                const chDrop = 0.62, chOut = ov * 0.68;
                const sv = S.ao;

                // 1. Sloping Projecting Red-Sandstone Chhajja Eave around the perimeter
                S.ao = null;
                const faces = [
                    { nx: 0, nz: 1, L: w0, D: b0, side: -1 },
                    { nx: 1, nz: 0, L: d0, D: a0, side: 1 },
                    { nx: 0, nz: -1, L: w0, D: b0, side: -1 },
                    { nx: -1, nz: 0, L: d0, D: a0, side: 0 }
                ];
                for (const f of faces) {
                    if (f.side >= 0 && fl[f.side]) continue;
                    const tx = -f.nz, tz = f.nx, nSlabs = Math.max(4, Math.round(f.L / 0.55)), sw = f.L / nSlabs;
                    for (let i = 0; i < nSlabs; i++) {
                        const s0 = -f.L / 2 + i * sw, s1 = s0 + sw, smid = (s0 + s1) / 2;
                        const wx = cx0 + tx * smid;
                        if (clip && f.nx === 0 && (wx - cx0 < clip[0] || wx - cx0 > clip[1])) continue;
                        const row = (i + 1) & 1023;
                        paint(TILE, K.TILE);
                        rb.need(8, 12);
                        const k = rb.n;
                        const ix0 = cx0 + tx * s0 + f.nx * (f.D - 0.05), iz0 = tz * s0 + f.nz * (f.D - 0.05);
                        const ix1 = cx0 + tx * s1 + f.nx * (f.D - 0.05), iz1 = tz * s1 + f.nz * (f.D - 0.05);
                        const ox0 = cx0 + tx * (s0 * 1.06) + f.nx * (f.D + chOut), oz0 = tz * (s0 * 1.06) + f.nz * (f.D + chOut);
                        const ox1 = cx0 + tx * (s1 * 1.06) + f.nx * (f.D + chOut), oz1 = tz * (s1 * 1.06) + f.nz * (f.D + chOut);
                        const iy = y + 0.18, oy = y - chDrop;
                        vtx(rb, ix0, iy, iz0, f.nx * 0.45, 0.89, f.nz * 0.45, row, 0, 1.27, 0.9);
                        vtx(rb, ix1, iy, iz1, f.nx * 0.45, 0.89, f.nz * 0.45, row + 0.9, 0, 1.27, 0.9);
                        vtx(rb, ox1, oy, oz1, f.nx * 0.45, 0.89, f.nz * 0.45, row + 0.9, 1.2, 1.27, 0.95);
                        vtx(rb, ox0, oy, oz0, f.nx * 0.45, 0.89, f.nz * 0.45, row, 1.2, 1.27, 0.95);
                        quadI(rb, k, k + 2, k + 1, k + 3);
                        for (let vi = k; vi < rb.n; vi++) { rb.X[vi * 4] = (vi - k >= 2 ? 20 : 220); rb.X[vi * 4 + 3] = ((i * 37) & 255); }
                        paint(STN3, K.MONO, { tri: 1 });
                        sweep(sb, [new THREE.Vector3(ix0, iy + 0.02, iz0), new THREE.Vector3(ox0, oy + 0.02, oz0)], rect(0.06, 0.08, -0.04), { cap: 1 });
                    }
                }
                S.ao = sv;

                // 2. Solid Mughal Flat Roof Entablature, Frieze & Paved Terrace Deck (Pukka Chhad)
                const parH = 1.12;
                paint(PLA, K.PLA); box(tb, w0, parH, d0, cx0, y + parH / 2 - 0.05, 0, { skip: 12 });
                paint(RED2, K.LAC); box(tb, w0 + 0.24, 0.16, d0 + 0.24, cx0, y + 0.12, 0);
                paint(STN3, K.MONO, { tri: 1 }); box(sb, w0 + 0.36, 0.14, d0 + 0.36, cx0, y + parH - 0.04, 0);
                paint(STN2, K.PAVE, { tri: 1 }); box(sb, w0 - 0.40, 0.08, d0 - 0.40, cx0, y + parH - 0.12, 0, { skip: 12 });

                // Recessed rectangular Band-i-Rumi panels & blind niches along all 4 parapet faces
                for (const f of faces) {
                    if (f.side >= 0 && fl[f.side]) continue;
                    const tx = -f.nz, tz = f.nx, nPan = Math.max(2, Math.round(f.L / 1.8)), pw = (f.L - 0.6) / nPan;
                    for (let i = 0; i < nPan; i++) {
                        const s = -f.L / 2 + 0.3 + (i + 0.5) * pw;
                        const px = cx0 + tx * s + f.nx * (f.D + 0.03), pz = tz * s + f.nz * (f.D + 0.03);
                        paint(RED, K.CAI);
                        withM(M4(px, y + parH * 0.52, pz, 0, Math.atan2(f.nx, f.nz), 0), () => box(tb, pw * 0.78, parH * 0.50, 0.08));
                    }
                }

                // 3. Crenellated Mughal Kangura (Trefoil Merlon) Parapet with realistic ruin breaches
                const merY = y + parH + 0.03;
                for (const f of faces) {
                    if (f.side >= 0 && fl[f.side]) continue;
                    const tx = -f.nz, tz = f.nx, nM = Math.max(3, Math.round((f.L - 0.8) / 0.50)), spM = (f.L - 0.8) / nM;
                    const ang = Math.atan2(f.nx, f.nz);
                    for (let i = 0; i <= nM; i++) {
                        const s = -f.L / 2 + 0.4 + i * spM;
                        const mx = cx0 + tx * s + f.nx * (f.D - 0.12), mz = tz * s + f.nz * (f.D - 0.12);
                        const hsh = Math.abs(Math.sin(mx * 12.7 + mz * 7.3 + y * 3.1));
                        if (hsh > 0.91) continue; // Ruined breach: missing merlon
                        const broken = hsh > 0.78;
                        S.ao = null; paint(RDG, K.RIDGE);
                        withM(M4(mx, merY, mz, 0, ang, 0), () => extrude(rb, broken ? KANGURA_BROKEN : KANGURA_PTS, -0.10, 0.10));
                    }
                }
                S.ao = sv;

                // 4. Corner Octagonal Guldasta / Burj Turrets at the 4 corners of the roof block
                const gR = clamp(Math.min(w0, d0) * 0.085, 0.34, 0.68), gH = parH + 0.55;
                for (const sx of [-1, 1]) {
                    if (fl[sx < 0 ? 0 : 1]) continue;
                    for (const sz of [-1, 1]) {
                        const ruinK = Math.abs(Math.sin((cx0 + sx * a0) * 5.1 + sz * 9.3));
                        octTower(cx0 + sx * (a0 - 0.08), sz * (b0 - 0.08), y - 0.15, gH, gR, !cut, ruinK);
                    }
                }

                // 5. Monumental Mughal Domes (Gumbad) & Flanking Chhatris standing directly on the flat roof deck
                if (!cut) {
                    S.ao = null;
                    const deckY = y + parH - 0.05;
                    if (w0 > d0 * 1.30 && !fl[0] && !fl[1]) {
                        const mainR = clamp(d0 * 0.36, 1.45, 2.55), mainH = mainR * 1.38;
                        mughalDome(cx0, 0, deckY, mainR, mainH, 0.1);
                        const sideR = mainR * 0.66, sideH = sideR * 1.35, sxOff = clamp(w0 * 0.30, mainR + sideR + 0.4, w0 * 0.36);
                        for (const sx of [-1, 1]) mughalDome(cx0 + sx * sxOff, 0, deckY, sideR, sideH, sx < 0 ? 0.2 : 0.6);
                    } else if (fl[0] || fl[1]) {
                        const wingR = clamp(Math.min(w0, d0) * 0.32, 1.10, 1.65);
                        mughalDome(cx0, 0, deckY, wingR, wingR * 1.35, 0.3);
                    } else {
                        const pavR = clamp(Math.min(w0, d0) * 0.38, 1.25, 2.20);
                        mughalDome(cx0, 0, deckY, pavR, pavR * 1.42, 0.1);
                    }
                    S.ao = sv;
                }
            }

            // ---------- Walls, Pierced Stone Jali Screens, and Arched Portal Doors ----------
            const pb = B.paper, wr = rng(4117);
            function paperQ(x0, x1, y0, y1, z, kind, g, lx, ly, u0 = x0, v0 = y0) {
                pb.need(4, 6); S.kind = kind; S.c0 = S.c1 = S.c2 = 255; S.tri = false; S.aoMul = 1; S.wet = -1;
                const k = vtx(pb, x0, y0, z, 0, 0, 1, x0 - u0, y0 - v0); vtx(pb, x1, y0, z, 0, 0, 1, x1 - u0, y0 - v0); vtx(pb, x1, y1, z, 0, 0, 1, x1 - u0, y1 - v0); vtx(pb, x0, y1, z, 0, 0, 1, x0 - u0, y1 - v0); quadI(pb, k, k + 1, k + 2, k + 3);
                for (let i = k; i < k + 4; i++) { pb.X[i * 4] = clamp(g) * 255; pb.X[i * 4 + 2] = clamp((lx - u0) / 8) * 255; pb.X[i * 4 + 3] = clamp((ly - v0) / 8) * 255; }
            }
            function glowBox(r, y0, y1, n) { for (let k = 0; k < n; k++) withM(M4(0, 0, 0, 0, (k + 0.5) / n * TAU, 0), () => paperQ(-r * 0.56, r * 0.56, y0, y1, r * 0.86, 2, 0.75, 0, 0)); }
            function leaf(x0, x1, y0, y1, z, skirt, g, lx, ly, u0, v0) {
                const st = 0.075, dp = 0.11, yl = skirt ? y0 + skirt : y0, w = x1 - x0;
                paint(STN3, K.MONO, { tri: 1 }); for (const x of [x0 + st / 2, x1 - st / 2]) box(sb, st, y1 - y0, dp, x, (y0 + y1) / 2, z, { skip: 12 });
                for (const y of skirt ? [y0 + st / 2, yl - 0.14, yl, y1 - st / 2] : [y0 + st / 2, y1 - st / 2]) box(sb, w - 2 * st, st, dp, (x0 + x1) / 2, y, z, { skip: 3 });
                if (skirt) {
                    paint(PLA, K.PLA); box(tb, w - 2 * st, yl - 0.14 - y0 - st * 1.5, 0.06, (x0 + x1) / 2, (y0 + st + yl - 0.14 - st / 2) / 2, z - 0.01, { skip: 15 });
                    paint(RED2, K.POLY); box(tb, w * 0.58, (yl - y0) * 0.52, 0.04, (x0 + x1) / 2, (y0 + yl - 0.14) / 2, z + 0.015, { skip: 32 });
                }
                const a0 = yl + st / 2, a1 = y1 - st, xm = (x0 + x1) / 2;
                paint(RED, K.LAC);
                withM(M4(xm - (w - 2 * st) / 2, a1, z + 0.01), () => brace((w - 2 * st) * 0.24, Math.min(0.32, (a1 - a0) * 0.25), 0.025, 1));
                withM(M4(xm + (w - 2 * st) / 2, a1, z + 0.01), () => brace((w - 2 * st) * 0.24, Math.min(0.32, (a1 - a0) * 0.25), 0.025, -1));
                paperQ(x0 + st, x1 - st, a0, a1, z - 0.022, 0, g, lx, ly, u0, v0);
            }
            function walls(w, d, xs, zs, y0, y1, inset, door) {
                const H = y1 - y0;
                for (let k = 0; k < 4; k++) withM(sideM(k), () => {
                    const full = k & 1 ? d : w, L = full - 2 * inset, half = (k & 1 ? w : d) / 2 - inset, cs = (k & 1 ? zs : xs).map(c => c * L / full), ym = H > 2.4 ? y1 - 0.58 : y1;
                    paint(PLA, K.PLA); for (const c of cs) box(tb, 0.28, H, 0.28, c, y0 + H / 2, half, { skip: 12 });
                    paint(RED2, K.LAC); box(tb, L, 0.18, 0.26, 0, y1 - 0.09, half, { skip: 3 });
                    for (let i = 0; i < cs.length - 1; i++) {
                        const c0 = cs[i] + 0.12, c1 = cs[i + 1] - 0.12, bw = c1 - c0, g = wr() < 0.16 ? 0.10 : 0.38 + 0.62 * wr(), lx = c0 + bw * (0.25 + 0.5 * wr()), ly = y0 + H * (0.30 + 0.25 * wr());
                        const open = door && k === 0 && i === ((cs.length - 2) >> 1) && (cs.length & 1) === 0;
                        if (ym < y1) {
                            paint(STN3, K.MONO, { tri: 1 }); box(sb, bw, 0.12, 0.22, (c0 + c1) / 2, ym, half, { skip: 3 }); const n = Math.max(2, Math.round(bw / 0.9));
                            for (let j = 1; j < n; j++) box(sb, 0.08, y1 - 0.15 - ym, 0.14, c0 + bw * j / n, (ym + y1 - 0.15) / 2, half, { skip: 12 });
                            paperQ(c0, c1, ym + 0.05, y1 - 0.15, half - 0.02, 3, open ? 0.9 : g * 0.9, lx, ly, c0, y0);
                        }
                        if (open) {
                            paint(STN3, K.MONO, { tri: 1 }); box(sb, bw, 0.22, 0.26, (c0 + c1) / 2, y0 + 0.11, half, { skip: 3 });
                            const lw = bw / 2 - 0.04, hd = ym - y0 - 0.26;
                            for (const s of [-1, 1]) withM(M4(s < 0 ? c0 + 0.05 : c1 - 0.05, y0 + 0.22, half - 0.06, 0, -s * 1.28, 0), () => {
                                paint(DKW, K.BARE); box(tb, lw, hd, 0.08, -s * lw / 2, hd / 2, 0); paint(BRZ, K.BRZ); for (const yy of [0.12, 0.5, 0.88]) box(tb, lw, 0.10, 0.025, -s * lw / 2, hd * yy, -0.045);
                                paint(GOLD, K.GILT); for (let r = 0; r < 5; r++) for (let c = 0; c < 4; c++) box(tb, 0.055, 0.055, 0.035, -s * lw * (0.14 + 0.24 * c), hd * (0.16 + 0.17 * r), 0.05, { tx: 0.4, bx: 1, skip: 32 });
                                box(tb, 0.12, 0.12, 0.03, -s * lw * 0.86, hd * 0.5, 0.05, { skip: 32 });
                            });
                            { let row; const n = 3, sw = (bw - 0.16) / n; for (let j = 0; j < n; j++) row = banner(c0 + 0.08 + j * sw + 0.015, ym - 0.05, half - 0.10, c0 + 0.08 + (j + 1) * sw - 0.015, ym - 0.05, half - 0.10, 0.74, { col: CCOL.maroon, bd: 1, pat: 2, kd: 0.20, cl: 0.7, amp: 0.7, thru: 0.08, row, nu: 3, ns: 4, tail: 'v' }); }
                            paperQ(c0 - 0.6, c1 + 0.6, y0, ym, half - 2.4, 1, 0.95, (c0 + c1) / 2, y0 + 1.2, c0 - 0.6, y0);
                            for (const s of [-1, 1]) withM(M4(s < 0 ? c0 - 0.6 : c1 + 0.6, 0, half - 1.2, 0, -s * Math.PI / 2, 0), () => paperQ(-1.2, 1.2, y0, ym, 0, 1, 0, 0, 0));
                            withM(M4((c0 + c1) / 2, ym, half - 1.2, Math.PI / 2, 0, 0), () => paperQ(-bw / 2 - 0.6, bw / 2 + 0.6, -1.2, 1.2, 0, 1, 0, 0, 0));
                        } else if (k === 0 && door) {
                            paint(STN3, K.MONO, { tri: 1 }); box(sb, bw, 0.16, 0.22, (c0 + c1) / 2, y0 + 0.08, half, { skip: 3 });
                            const n = Math.max(2, Math.round(bw / 0.85)); for (let j = 0; j < n; j++) leaf(c0 + bw * j / n + 0.008, c0 + bw * (j + 1) / n - 0.008, y0 + 0.16, ym - 0.05, half, 0.98, g, lx, ly, c0, y0);
                        } else {
                            const dh = door ? 1.05 : 0.45;
                            paint(PLA, K.PLA); box(tb, bw, dh, 0.30, (c0 + c1) / 2, y0 + dh / 2, half, { skip: 15 });
                            paint(STN3, K.MONO, { tri: 1 }); box(sb, bw, 0.09, 0.36, (c0 + c1) / 2, y0 + dh + 0.045, half, { skip: 3 });
                            const yb = y0 + dh + 0.09, n = Math.max(2, Math.round(bw / 0.85)); for (let j = 0; j < n; j++) leaf(c0 + bw * j / n + 0.008, c0 + bw * (j + 1) / n - 0.008, yb, ym - 0.05, half, 0, g, lx, ly, c0, y0);
                        }
                    }
                });
            }
            const sideM = k => M4(0, 0, 0, 0, k * Math.PI / 2, 0);

            // ---------- Mughal Diwan-i-Khas / Jamindar Palace Hall & Baradari Pleasure Pavilion ----------
            function hall(o) {
                const { w, d, ch = 4.2, ph = 1.1, rh = 3.0, ov = 1.9, bays = 3, open = false } = o;
                S.M = M4(o.x, o.y, o.z, 0, o.yaw || 0, 0); S.tag = o.tag; S.m = new THREE.Matrix4(); S.mI = true;
                (G.keepOut = G.keepOut || []).push({ x: o.x, z: o.z, r: Math.max(w, d) * 0.5 + ov + 2.2, y0: o.y - 6, y1: o.y + 30 });
                const top = ph + 0.04, by = ph + ch, ry = by + 0.55, gnd = o.water !== undefined ? o.water - o.y : 0;
                const k2 = 0.66, w2 = w * k2, d2 = d * k2, ch2 = ch * 0.68, h1 = o.double ? 1.15 : rh, y2 = ry + 1.05, by2 = y2 + ch2, ry2 = by2 + 0.55, a2 = w2 / 2 + ov * 0.90, b2 = d2 / 2 + ov * 0.90;
                const ev = [{ cx: 0, a: w / 2 + ov - 0.05, b: d / 2 + ov - 0.05, y: ry + 0.02, y0: -0.5 }]; if (o.double) ev.push({ cx: 0, a: a2 - 0.05, b: b2 - 0.05, y: ry2 + 0.02, y0: y2 - 0.3 });
                S.ao = mkAO(ev, [{ a: w / 2 + 1.5, b: d / 2 + 1.5, y: top }]);

                // ---- Stone Podium, Steps, and Courtyard Terrace ----
                S.gy = gnd;
                paint(STN2, K.ASH, { tri: 1 }); box(sb, w + 4.4, 3.0, d + 4.4, 0, -1.5, 0, { skip: 8 });
                podium(w + 2.6, d + 2.6, top);
                const pe = [w / 2 + 1.32, d / 2 + 1.32];
                if (!open) {
                    const mw = clamp(w * 0.28, 2.3, 3.4), zf = d / 2 + 3.1, zc = (d / 2 + 1.3 + zf) / 2, n = 5, rise = top / n, tread = 0.30;
                    paint(STN2, K.ASH, { tri: 1 }); box(sb, 2 * mw + 0.5, 3.0, zf - d / 2 - 1.3 + 0.3, 0, -1.5, zc + 0.1, { skip: 8 });
                    podium(2 * mw, zf - d / 2 - 1.1, top, 0, zc - 0.1);
                    for (const s of [-1, 1]) withM(M4(s * (mw + 0.18), top, d / 2 + 2.25, 0, s * Math.PI / 2, 0), () => stairs(n, rise, tread, 1.5, s > 0 ? 1 : 2));
                    balus([[-mw + 0.04, zf - 0.14], [mw - 0.04, zf - 0.14]], top);
                    balus([[mw + 0.2, pe[1]], [pe[0], pe[1]], [pe[0], -pe[1]], [-pe[0], -pe[1]], [-pe[0], pe[1]], [-mw - 0.2, pe[1]]], top);
                    burner(0, top, d / 2 + 2.2, clamp(w / 11, 0.85, 1.15));
                    for (const s of [-1, 1]) stoneLantern(s * (mw + 2.5), 0.35, d / 2 + 2.45, 1.0);
                } else {
                    const hgt = top - gnd, n = Math.max(3, Math.ceil(hgt / 0.215)), tread = Math.min(0.32, 1.70 / (n - 1));
                    withM(M4(0, top, d / 2 + 1.5, 0, 0, 0), () => stairs(n, hgt / n, tread, Math.min(3.0, w * 0.5)));
                    const sx = Math.min(3.0, w * 0.5) / 2 + 0.36;
                    balus([[sx, pe[1]], [pe[0], pe[1]], [pe[0], -pe[1]], [-pe[0], -pe[1]], [-pe[0], pe[1]], [-sx, pe[1]]], top);
                }

                // ---- Solid Mughal Arched Colonnade (Diwan Arcade) & Corner Bastions ----
                S.gy = top;
                const xs = []; for (let i = 0; i <= bays; i++) xs.push(lerp(-w / 2, w / 2, i / bays)); const zs = d > 6 ? [-d / 2, 0, d / 2] : [-d / 2, d / 2], cr = open ? 0.24 : 0.29;
                for (const x of xs) for (const z of zs) { if (Math.abs(x) < w / 2 - 0.01 && Math.abs(z) < d / 2 - 0.01) continue; column(x, z, top, ch, cr); }
                if (!open) {
                    for (const sx of [-1, 1]) for (const sz of [-1, 1]) octTower(sx * (w / 2 + 0.18), sz * (d / 2 + 0.18), top, ch + 0.55, cr * 1.45, false, 0.2);
                }
                for (let k = 0; k < 4; k++) withM(sideM(k), () => {
                    const cs = k & 1 ? zs : xs, half = k & 1 ? w / 2 : d / 2, L = k & 1 ? d : w;
                    for (let i = 0; i < cs.length - 1; i++) {
                        const c0 = cs[i], c1 = cs[i + 1], len = c1 - c0 - cr * 1.3;
                        withM(M4((c0 + c1) / 2, by - 0.24, half), () => beam(len + cr * 0.8, 0.52, 0.34));
                        withM(M4(c0 + cr * 0.65, by - 0.48, half), () => brace(len * 0.235, 0.48, 0.09, 1));
                        withM(M4(c1 - cr * 0.65, by - 0.48, half), () => brace(len * 0.235, 0.48, 0.09, -1));
                    }
                    withM(M4(0, by, half), () => brackets(L, 2, 1));
                    if (open && k !== 0) {
                        const len = L - cr * 2.2; paint(STN3, K.MONO, { tri: 1 }); box(sb, len, 0.08, 0.40, 0, top + 0.46, half, { skip: 3 }); box(sb, len, 0.09, 0.10, 0, top + 0.88, half + 0.13, { skip: 3 });
                        paint(RED, K.LAC); box(tb, len - 0.12, 0.34, 0.06, 0, top + 0.67, half + 0.13, { skip: 12 });
                        for (let i = 0, n = Math.max(2, Math.round(len / 1.1)); i <= n; i++) box(sb, 0.09, 0.44, 0.09, -len / 2 + len * i / n, top + 0.23, half, { skip: 12 });
                    }
                });
                if (!open) walls(w, d, xs, zs, top, by - 0.48, 0.78, true);

                // ---- Mughal Chhajja Eave, Kangura Parapet & Domes ----
                roof(w + ov * 2, d + ov * 2, h1, ry, { lift: o.lift ?? 1.0, ov, cut: o.double ? { cx: w2 / 2 - 0.12, cz: d2 / 2 - 0.12 } : null, rl: open ? 0 : undefined });
                for (const x of xs) { lantern(x, by - 0.75, d / 2 + ov * 0.55, 1.15, 1.42, ov * 0.55 - cr - 0.30); if (o.backLanterns) lantern(x, by - 0.75, -d / 2 - ov * 0.55, 1.15, 1.42, ov * 0.55 - cr - 0.30); }
                for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) lantern(sx * (w / 2 + ov * 0.86), ry - 0.78, sz * (d / 2 + ov * 0.86), 0.9, 0.82);
                if (!open) {
                    const mw = clamp(w * 0.28, 2.3, 3.4), zf = d / 2 + 3.1, zb = d / 2 + ov * 0.55, mid = (bays - 1) >> 1;
                    for (let i = 0; i < bays; i++) {
                        if (i === mid && (bays & 1)) continue; const xm = (xs[i] + xs[i + 1]) / 2, alt = (i + (i > mid ? 1 : 0)) & 1;
                        banner(xm - 0.36, by + 0.62, zb, xm + 0.36, by + 0.62, zb, 2.7, { col: alt ? CCOL.cream : CCOL.yel, bd: 0, pat: 1, kd: 0.24, cl: 0.4, amp: 1.0, lag: 0.10, tail: 'p' }); paint(DKW, K.BRZ); box(tb, 0.82, 0.05, 0.05, xm, by + 0.63, zb); box(tb, 0.03, 0.34, 0.03, xm, by + 0.80, zb);
                    }
                    for (const sx of [-1, 1]) pole(sx * (mw - 0.3), zf - 0.42, top, 10.4, 4.8, 0.95, { col: CCOL.yel, bd: 0 });
                } else {
                    for (let k = 0; k < 4; k++) withM(sideM(k), () => {
                        const L2 = (k & 1 ? d : w), half = (k & 1 ? w : d) / 2, x1 = L2 / 2 - cr - 0.12, wd = Math.min(1.05, L2 * 0.24), yh = by - 0.95, len = ch - 1.42; let row;
                        for (const sx of [-1, 1]) row = banner(sx * x1 - (sx > 0 ? wd : 0), yh, half + 0.24, sx * x1 + (sx > 0 ? 0 : wd), yh, half + 0.24, len, { col: CCOL.gauze, bd: 2, pat: 0, kd: 0.30, cl: 0.7, amp: 1.3, lag: 0.15, thru: 0.5, row, nu: 12, ns: 12 });
                    });
                    pennant(0.06, ry + h1 + 1.02, 0, 2.7, 0.6, { col: CCOL.yel, bd: 0 });
                }

                // ---- Upper Storey (Jalsaghar / Royal Domed Pavilion standing on the flat lower terrace) ----
                if (o.double) {
                    S.gy = y2 - 0.4;
                    const xs2 = [-w2 / 2, 0, w2 / 2], zs2 = [-d2 / 2, d2 / 2], cr2 = 0.24;
                    paint(STN3, K.MONO, { tri: 1 }); box(sb, w2 + 0.9, 0.32, d2 + 0.9, 0, y2 + 0.16, 0, { skip: 8 });
                    for (const x of xs2) for (const z of zs2) column(x, z, y2 + 0.28, ch2 - 0.28, cr2);
                    for (let k = 0; k < 4; k++) withM(sideM(k), () => {
                        const cs2 = k & 1 ? zs2 : xs2, half = k & 1 ? w2 / 2 : d2 / 2, L = k & 1 ? d2 : w2;
                        for (let i = 0; i < cs2.length - 1; i++) {
                            const c0 = cs2[i], c1 = cs2[i + 1], len = c1 - c0 - cr2 * 1.2;
                            withM(M4((c0 + c1) / 2, by2 - 0.20, half), () => beam(len + cr2 * 0.6, 0.42, 0.28));
                            withM(M4(c0 + cr2 * 0.6, by2 - 0.40, half), () => brace(len * 0.235, 0.38, 0.08, 1));
                            withM(M4(c1 - cr2 * 0.6, by2 - 0.40, half), () => brace(len * 0.235, 0.38, 0.08, -1));
                        }
                        withM(M4(0, by2, half), () => brackets(L, 1, 0.9, 0.85));
                    });
                    walls(w2, d2, xs2, zs2, y2 + 0.28, by2 - 0.40, 0.35, false);
                    roof(w2 + ov * 1.7, d2 + ov * 1.7, rh, ry2, { lift: 1.0, ov: ov * 0.85 });
                    for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) lantern(sx * (w2 / 2 + ov * 0.8), by2 + 0.32, sz * (d2 / 2 + ov * 0.8), 0.9, 0.82);
                }
            }

            // ---------- Monumental Ruined Mughal Fortress Gateway (Shahi Darwaza / Buland Darwaza) over the Sluice ----------
            function gate(o) {
                S.M = M4(o.x, o.y, o.z, 0, o.yaw || 0, 0); S.tag = 'gate'; S.m = new THREE.Matrix4(); S.mI = true; S.gy = 0;
                (G.keepOut = G.keepOut || []).push({ x: o.x, z: o.z, r: 17, y0: o.y - 6, y1: o.y + 30 });
                const top = 1.05;
                S.ao = mkAO([{ cx: 0, a: 7.7, b: 4.25, y: 13.78, y0: -0.5 }, { cx: -8.9, a: 5.55, b: 3.65, y: 10.38, y0: -0.5 }, { cx: 8.9, a: 5.55, b: 3.65, y: 10.38, y0: -0.5 }], [{ a: 15.7, b: 4.95, y: top }]);

                // ---- Stone Waterfall Bastion, Culvert Arch, Podium, Steps & Balustrades ----
                paint(STN2, K.ASH, { tri: 1 }); for (const s of [-1, 1]) box(sb, 14.5, 4, 12, s * 9.75, -2, 0);
                paint([0.05, 0.05, 0.05], K.MONO, { tri: 1, wet: 1 }); box(sb, 5.0, 4, 8, 0, -2, -2, { skip: 3 });
                paint(STN2, K.MONO, { tri: 1, wet: 0.9 }); box(sb, 5.0, 1.3, 4.0, 0, -3.35, 4.0, { skip: 3 }); box(sb, 5.0, 0.2, 1.9, 0, -2.8, 6.95, { skip: 3 });
                {
                    const zw = 7.56, wz = o.z + zw, m = new Map(), key = (x, y) => Math.round(x / 1.3) * 100 + Math.round(y / 1.5);
                    if (typeof Rock !== 'undefined' && Rock.sites) for (const st of Rock.sites) { const q = st.p; if (Math.abs(q.x) > 5.9 || q.y > o.y - 3 || q.y < o.y - 19 || q.z < o.z || q.z > o.z + 13) continue; const k = key(q.x, q.y - o.y); if (!(m.get(k) > q.z)) m.set(k, q.z); }
                    let yb = -13.5, met = []; for (let y = -6; y >= -16.5; y -= 1.5) { let n = 0; for (let x = -5.2; x <= 5.21; x += 1.3) if (m.get(key(x, y)) >= wz - 0.15) n++; met.push(n); if (n >= 7) { yb = y - 1.6; break; } }
                    G.info.sluiceWall = { foot: +(o.y + yb).toFixed(1), met };
                    const gy0 = S.gy; S.gy = yb - 0.5;
                    paint(STN3, K.SPILL, { tri: 1, wet: 0.35 }); box(sb, 10.6, 0.34, 1.66, 0, -3.07, 6.83);
                    const CONS = [[7.60, -3.24], [6.7, -3.24], [6.7, -4.30], [7.56, -4.30], [7.60, -4.22], [7.66, -4.02], [7.86, -3.80], [8.02, -3.62], [8.06, -3.44], [7.60, -3.44]];
                    paint(STN3, K.SPILL, { tri: 1, wet: 0.3 }); for (let i = -3; i <= 3; i++) withM(M4(i * 1.22, 0, 0, 0, -Math.PI / 2, 0), () => extrude(sb, CONS.map(q => [q[0] - 0.42, q[1]]), -0.29, 0.29));
                    paint(STN, K.SPILL, { tri: 1, wet: 0.22 }); box(sb, 10.4, -3.24 - yb, zw - 5.2, 0, (-3.24 + yb) / 2, (zw + 5.2) / 2, { skip: 4 | 32 });
                    paint(STN3, K.SPILL, { tri: 1, wet: 0.3 }); for (const sx of [-1, 1]) { box(sb, 0.95, -3.24 - yb, 0.36, sx * 4.62, (-3.24 + yb) / 2, zw + 0.16, { skip: 4 | 32 }); box(sb, 1.15, 0.5, 0.5, sx * 4.62, -3.7, zw + 0.20, { skip: 4 | 32, bz: 0.72 }); }
                    for (let y = -6.6; y > yb + 1.5; y -= 3.3) { paint(STN3, K.SPILL, { tri: 1, wet: 0.55 }); box(sb, 8.3, 0.24, 0.14, 0, y, zw + 0.05, { skip: 3 | 32, tz: 0.4 }); }
                    S.gy = gy0 - 7;
                }
                paint(STN, K.ASH, { tri: 1, wet: 0.66 }); for (const s of [-1, 1]) box(sb, 2.7, 2.9, 1.9, s * 3.85, -1.45, 6.95);
                const arc = []; for (let i = 0; i <= 14; i++) { const an = Math.PI * (1 - i / 14); arc.push([2.5 * Math.cos(an), -1.75 + 1.13 * Math.sin(an)]); }
                paint(STN, K.ASH, { tri: 1, wet: 0.60 }); extrude(sb, [[-2.5, 0], ...arc, [2.5, 0]], 2, 7.9); S.gy = 0;
                paint(STN3, K.MONO, { tri: 1 }); sweep(sb, [[-2.5, -2.7], ...arc, [2.5, -2.7]].map(p => new THREE.Vector3(p[0], p[1], 7.9)), [[-0.05, 0], [0.07, 0], [0.07, 0.36], [-0.05, 0.36]], { cap: 1 });
                box(sb, 0.52, 0.60, 0.22, 0, -0.36, 7.93, { bx: 0.72 });
                paint(STN3, K.MONO, { tri: 1, wet: 0.7 }); box(sb, 4.6, 0.22, 0.28, 0, -2.81, 7.98);
                podium(31, 9.5, top);
                withM(M4(0, top, 4.95), () => stairs(5, top / 5, 0.30, 7.0));
                balus([[3.86, 4.77], [15.52, 4.77], [15.52, -4.77], [3.5, -4.77]], top); balus([[-3.86, 4.77], [-15.52, 4.77], [-15.52, -4.77], [-3.5, -4.77]], top);
                balus([[-5.05, 6.25], [-5.05, 7.72], [5.05, 7.72], [5.05, 6.25]], 0);
                for (const s of [-1, 1]) stoneLantern(s * 4.35, top, 3.9, 1.1);

                // ---- Solid Monumental Mughal Fortress Gateway (Shahi Darwaza / Lalbagh & Bara Katra Style) ----
                S.gy = top;
                for (const sx of [-1, 1]) {
                    for (const sz of [-1, 1]) {
                        octTower(sx * 5.05, sz * 2.15, top, 12.70, 0.86, true, sx < 0 ? 0.1 : 0.25);
                        octTower(sx * 12.15, sz * 1.85, top, 9.30, 0.76, true, sx > 0 ? 0.45 : 0.15);
                    }
                }

                // Central High Pishtaq Portal Frame (x = -5.05..5.05, y = top..13.4, z = -2.1..2.1) with soaring Pointed Mughal Iwan Archway
                for (const sx of [-1, 1]) {
                    paint(PLA, K.PLA); box(tb, 1.85, 12.2, 4.1, sx * 4.10, top + 6.1, 0, { skip: 12 });
                    paint(RED, K.LAC); box(tb, 1.96, 0.40, 4.25, sx * 4.10, top + 0.20, 0);
                    for (const yy of [top + 2.4, top + 5.6, top + 8.8]) {
                        paint(RED2, K.LAC); box(tb, 1.15, 2.2, 4.22, sx * 4.10, yy, 0);
                        paint(STN3, K.MONO, { tri: 1 }); box(sb, 0.82, 1.75, 4.28, sx * 4.10, yy - 0.08, 0);
                    }
                }
                for (const z of [-1.62, 0, 1.62]) {
                    for (const sx of [-1, 1]) {
                        withM(M4(sx * 3.18, 9.95, z), () => brace(3.18 / 2.15, 3.75 / 3.1, 0.24, -sx));
                    }
                }
                paint(PLA, K.PLA); box(tb, 9.8, 3.45, 4.1, 0, 11.65, 0, { skip: 8 });
                paint(STN3, K.MONO, { tri: 1 }); box(sb, 10.2, 0.24, 4.35, 0, 10.02, 0); box(sb, 10.2, 0.28, 4.35, 0, 12.68, 0);

                // Flanking Two-Storey Mughal Arcade Wings
                for (const sx of [-1, 1]) {
                    const wx0 = sx * 5.05, wx1 = sx * 12.10, wxc = (wx0 + wx1) / 2, wLen = Math.abs(wx1 - wx0);
                    for (const px of [sx * 8.58, sx * 11.75]) {
                        paint(PLA, K.PLA); box(tb, 1.05, 9.0, 3.5, px, top + 4.5, 0, { skip: 12 });
                        column(px, 1.75, top, 8.9, 0.36, 12); column(px, -1.75, top, 8.9, 0.36, 12);
                    }
                    for (const [b0, b1] of [[5.35, 8.25], [8.90, 11.55]]) {
                        const bw = b1 - b0, bc = sx * (b0 + b1) / 2;
                        paint(STN3, K.MONO, { tri: 1 }); box(sb, bw + 0.6, 0.32, 3.75, bc, 5.65, 0);
                        paint(PLA, K.PLA); box(tb, bw + 0.4, 1.15, 3.55, bc, 6.25, 0);
                        for (const z of [-1.42, 1.42]) {
                            withM(M4(sx * b0, 5.50, z), () => brace((bw * 0.5) / 2.15, 1.95 / 3.1, 0.16, sx));
                            withM(M4(sx * b1, 5.50, z), () => brace((bw * 0.5) / 2.15, 1.95 / 3.1, 0.16, -sx));
                            withM(M4(sx * b0, 9.35, z), () => brace((bw * 0.5) / 2.15, 1.75 / 3.1, 0.16, sx));
                            withM(M4(sx * b1, 9.35, z), () => brace((bw * 0.5) / 2.15, 1.75 / 3.1, 0.16, -sx));
                        }
                        for (const sSide of [-1, 1]) withM(M4(0, 0, 0, 0, sSide > 0 ? 0 : Math.PI, 0), () => {
                            leaf(sx * b0 * sSide, sx * b1 * sSide, 6.65, 9.15, 1.15, 0, 0.72, bc * sSide, 7.8, sx * b0 * sSide, 6.65);
                        });
                    }
                    paint(PLA, K.PLA); box(tb, wLen, 0.95, 3.55, wxc, 9.65, 0);
                }

                // Recessed carved sandstone & stucco cartouche friezes (boards) & Vertical Stone Inscription Tablet (PLQ)
                const board = (xc, yc, wd, hh, nf) => {
                    paint(PLA, K.PLA); box(tb, wd, hh, 0.16, xc, yc, 0, { skip: 15 });
                    paint(STN3, K.MONO, { tri: 1 }); for (const s of [-1, 1]) box(sb, wd, 0.14, 0.24, xc, yc + s * (hh / 2 - 0.07), 0, { skip: 3 });
                    for (let i = 0; i <= nf; i++) box(sb, 0.14, hh - 0.28, 0.24, xc - wd / 2 + 0.07 + (wd - 0.14) * i / nf, yc, 0, { skip: 12 });
                    for (let i = 0; i < nf; i++) {
                        const fw = (wd - 0.14) / nf, px = xc - wd / 2 + 0.07 + fw * (i + 0.5);
                        paint(RED2, K.POLY); box(tb, fw * 0.76, (hh - 0.28) * 0.66, 0.18, px, yc, 0, { skip: 15 });
                        paint(GRN, K.CAI); box(tb, fw * 0.68, (hh - 0.28) * 0.56, 0.20, px, yc, 0, { skip: 15 });
                    }
                };
                for (const s of [-1, 1]) board(s * 8.55, 8.2, 5.8, 1.35, 3);
                board(0, 11.25, 8.2, 1.85, 3);
                withM(M4(0, 11.25, 2.14, 0, 0, 0), () => {
                    paint(STN2, K.MONO, { tri: 1 }); box(sb, 4.7, 2.36, 0.14, 0, 0, -0.06, { skip: 16 });
                    paint(STN3, K.MONO, { tri: 1 }); for (const s of [-1, 1]) { box(sb, 4.95, 0.18, 0.22, 0, s * 1.14, 0); box(sb, 0.18, 2.46, 0.22, s * 2.38, 0, 0); }
                });
                PLQ.copy(S.M).multiply(M4(0, 11.25, 2.16, 0, 0, 0));

                // ---- Carved Toda Corbel Brackets, Sloping Stone Chhajja Eaves, Kangura Battlements & Royal Mughal Domes ----
                for (const k of [0, 2]) withM(sideM(k), () => {
                    withM(M4(0, 12.75, 1.95), () => brackets(9.6, 2, 0.9, 0.94));
                    for (const s of [-1, 1]) withM(M4(s * 8.55, 9.55, 1.75), () => brackets(6.8, 1, 1.0, 0.99));
                });
                for (const s of [-1, 1]) {
                    withM(M4(s * 4.9, 12.75, 0, 0, s * Math.PI / 2, 0), () => brackets(3.8, 2, 0.9, 1.1));
                    withM(M4(s * 12.0, 9.55, 0, 0, s * Math.PI / 2, 0), () => brackets(3.4, 1, 1.0, 1.1));
                }
                roof(14.8, 8.2, 3.5, 13.55, { lift: 0, ov: 2.1 });
                roof(10.8, 7.0, 2.6, 10.15, { cx: -8.9, lift: 0, ov: 1.6, flat: [0, 1], clip: [-99, 3.85] });
                roof(10.8, 7.0, 2.6, 10.15, { cx: 8.9, lift: 0, ov: 1.6, flat: [1, 0], clip: [-3.85, 99] });

                for (const x of [-9.6, -6.7, -2.4, 0, 2.4, 6.7, 9.6]) lantern(x, Math.abs(x) < 4 ? 9.0 : 6.3, 2.3, 1.5, Math.abs(x) < 4 ? 0.55 : 0.5);
                for (const sx of [-1, 1]) {
                    banner(sx * 8.55 - 0.72, 7.10, 0, sx * 8.55 + 0.72, 7.10, 0, 3.9, { col: CCOL.yel, bd: 0, pat: 1, kd: 0.17, cl: 0.35, amp: 1.0, lag: 0.10, tail: 'v', nu: 6 });
                    paint(DKW, K.BRZ); box(tb, 1.6, 0.06, 0.06, sx * 8.55, 7.11, 0); pole(sx * 13.7, 4.35, top, 14.4, 6.4, 1.15, { col: CCOL.yel, bd: 0 });
                }
                for (const x of [-11.6, -4.7, 4.7, 11.6]) { lantern(x, 5.2, 2.5, 1.2, 0.78, 0.03); paint(DKW, K.BRZ); box(tb, 0.05, 0.05, 0.72, x, 5.2 + 0.78 * 1.2 + 0.03, 2.2 + 0.28); box(tb, 0.04, 0.34, 0.04, x, 5.2 + 0.78 * 1.2 - 0.15, 2.24, { tz: 1 }); }
            }
            const PLQ = new THREE.Matrix4();
            // a hanging lantern: body centre (x, y, z) in the building frame; it hangs from a hook hk above the centre
            // free: how far (m) the body can swing back toward the building before it meets a column or a beam (it bumps and comes off it)
            function lantern(x, y, z, s = 1, hk = 0.78, free) {
                const p = new THREE.Vector3(x, y, z).applyMatrix4(S.M), l = { p, s, hk: hk * s, w: 0, tag: S.tag };
                if (free !== undefined) { const n = new THREE.Vector3(0, 0, z > 0 ? -1 : 1).transformDirection(S.M); l.wall = [n.x, n.z, free]; } lanterns.push(l);
            }
            const GL_PAPER = /* glsl */`
    float g = vX.x; vec2 lp = vX.zw * 8.0, dl = vUv - lp; float lamp = exp(-dot(dl, dl) / 3.4), hs = hash11(lp.x * 3.1 + lp.y);
    float ft = uTime * (4.0 + 5.0 * hs) + lp.y * 17.0, fl = 0.90 + 0.07 * sin(ft) * sin(uTime * 1.7 + lp.x * 5.0) + 0.05 * sin(ft * 2.63 + 1.0);      // an oil lamp: it breathes and gutters
    fl *= 1.0 - 0.16 * smoothstep(0.90, 1.0, sin(uTime * (0.7 + hs) + hs * 60.0));
    if (kind == 1.0) {                                                                         // ruined Mughal Diwan / Jamindar Jalsaghar hall: vaulted Mihrab niche & flickering Jharbati chandelier
      vec2 a = (vUv - vec2(lp.x, 1.65)) * vec2(0.65, 0.95); float alt = exp(-dot(a, a) / 0.95), cand = 0.0, cl = 0.0;
      for (int i = -3; i <= 3; i++) { float fi = float(i), cf = 0.80 + 0.20 * sin(uTime * (6.2 + fi) + fi * 2.3) * sin(uTime * 2.9 + fi); vec2 c = vUv - vec2(lp.x + fi * 0.22, 1.85 - 0.045 * abs(fi * fi)); cand += cf * exp(-dot(c, c) / 0.0014); cl += cf / 7.0; }
      vec2 q = vUv - vec2(lp.x, 0.0);
      float archNiche = (1.0 - smoothstep(0.52, 0.56, abs(q.x))) * (1.0 - smoothstep(2.45, 2.50, q.y + abs(q.x) * 0.55));
      base = vec3(0.010, 0.008, 0.007);
      clE = (vec3(0.68, 0.34, 0.11) * alt * (0.45 + 0.35 * archNiche)) * g * cl * uLit + vec3(2.5, 1.45, 0.48) * cand * g; clR = 0.92;
    } else if (kind == 2.0) { base = vec3(0.4, 0.25, 0.12); clE = vec3(2.6, 1.05, 0.30) * g * fl * (0.6 + 0.4 * vnoise(vUv * 30.0)) * uLit; clR = 0.8;
    } else {                                                                                   // lattice with thickness standing in front of lit paper
      vec2 q = vUv; if (kind == 3.0) q = vec2(q.x + q.y, q.x - q.y) * 0.7071;
      vec3 dpx = dFdx(vWP), dpy = dFdy(vWP); vec2 dux = dFdx(q), duy = dFdy(q); float det = dux.x * duy.y - dux.y * duy.x; det = abs(det) < 1e-12 ? 1e-12 : det;
      vec3 Tu = (dpx * duy.y - dpy * dux.y) / det, Tv = (dpy * dux.x - dpx * duy.x) / det, Vw = normalize(cameraPosition - vWP);
      vec2 sh = vec2(dot(Vw, normalize(Tu)), dot(Vw, normalize(Tv))) / max(abs(dot(Vw, vWN)), 0.2) * 0.028;         // shift of the sight line across the depth of a bar
      vec2 qd = vec2(q.x + q.y, q.x - q.y) * 0.7071; float p = 0.105, wb = 0.0155; vec2 f = min(abs(mod(q + p * 0.5, p) - p * 0.5), abs(mod(qd + p * 0.5, p) - p * 0.5)), lo = min(f, f - abs(sh) * 0.5), hi = max(f, f + abs(sh) * 0.5), aa = vec2(fwidth(q.x), fwidth(q.y)) * 0.75 + 1e-5;
      vec2 fr = 1.0 - smoothstep(vec2(wb) - aa, vec2(wb) + aa, abs(f)), an = 1.0 - smoothstep(-aa, aa, max(lo - wb, -wb - hi));
      float lod = 1.0 - smoothstep(p * 0.22, p * 0.60, max(aa.x, aa.y) / 0.75), front = mix(0.19, max(fr.x, fr.y), lod), any = mix(0.26, max(an.x, an.y), lod);
      float fib = vnoise(vUv * vec2(70.0, 11.0)) * 0.5 + vnoise(vUv * 5.0 + lp) * 0.5, sheet = 0.90 + 0.10 * step(0.5, hash21(floor(vUv / vec2(0.354, 0.472)) + lp));
      vec3 glow = mix(vec3(1.34, 0.50, 0.105), vec3(2.10, 1.22, 0.47), lamp) * mix(0.42, 1.0, lamp) * g * fl * (0.72 + 0.45 * fib) * sheet;
      glow *= 0.55 + 0.45 * smoothstep(0.0, 0.35, vUv.y);                                                      // grime along the bottom of the paper
      // someone inside walks past the lamp now and then: a soft shadow crosses the paper
      float pt = uTime * 0.105 + hs * 9.0, pc = fract(pt), on = step(hash11(floor(pt) * 3.3 + lp.x * 1.7), 0.5), wx = mix(-1.2, 5.0, pc / 0.5) * step(pc, 0.5) + 99.0 * step(0.5, pc);
      float wk = (1.0 - smoothstep(0.16, 0.48, abs(vUv.x - wx + 0.05 * sin(uTime * 6.0)))) * (1.0 - smoothstep(1.55, 1.95, vUv.y)) * on;
      glow *= (1.0 - 0.62 * wk) * uLit;
      vec3 bar = vec3(0.17, 0.028, 0.022) * mix(0.42, 1.0, front / max(any, 1e-3));
      base = mix(vec3(0.44, 0.33, 0.21) * (0.75 + 0.35 * fib), bar, any); clE = glow * (1.0 - any); clR = mix(0.9, 0.55, any);
    }`;
            // ---------- lanterns: ribbed paper on a round frame, caps, a hanging cord and a tassel of threads; each is a weight on its cord ----------
            // uv = (way round 0..1, height). aX.x = part: 0 paper, 1 cord, 2 caps and knot, 3 tassel threads
            function lanternGeo() {
                const lb = Buf(), svM = S.M, svA = S.ao, svT = S.tag; S.M = new THREE.Matrix4(); S.ao = null; S.tag = '_lan'; S.gy = 0;
                const ring = (prof, seg, part, rag) => {
                    const n = prof.length; lb.need(n * (seg + 1), (n - 1) * seg * 6); const base = lb.n;
                    for (let i = 0; i < n; i++) {
                        const p0 = prof[Math.max(0, i - 1)], p1 = prof[Math.min(n - 1, i + 1)], dr = p1[0] - p0[0], dy = p1[1] - p0[1], l = Math.hypot(dr, dy) || 1, nr = dy / l, ny = -dr / l;
                        for (let j = 0; j <= seg; j++) { const th = j / seg * TAU, yy = prof[i][1] + (rag && i === n - 1 ? rag * ((j * 7) % 5 - 2) : 0), k = vtx(lb, Math.cos(th) * prof[i][0], yy, Math.sin(th) * prof[i][0], Math.cos(th) * nr, ny, Math.sin(th) * nr, j / seg, prof[i][1]); lb.X[k * 4] = part * 64; }
                    }
                    for (let i = 0; i < n - 1; i++) for (let j = 0; j < seg; j++) { const p = base + i * (seg + 1) + j; quadI(lb, p, p + seg + 1, p + seg + 2, p + 1); }
                };
                paint([1, 1, 1], 0);
                ring([[0.055, -0.28], [0.115, -0.22], [0.180, -0.13], [0.235, 0.04], [0.245, 0.14], [0.190, 0.21], [0.125, 0.25], [0.075, 0.275], [0.045, 0.29]], 8, 0);
                const tag = (k0, part) => { for (let k = k0; k < lb.n; k++) lb.X[k * 4] = part * 64; };
                let k0 = lb.n; lathe(lb, [[0.05, 0.27], [0.14, 0.29], [0.11, 0.34], [0.04, 0.38]], 0, 0, 0, { seg: 8, capT: 1 }); lathe(lb, [[0.035, -0.35], [0.10, -0.31], [0.11, -0.275], [0.055, -0.27]], 0, 0, 0, { seg: 8, capB: 1 });
                lathe(lb, [[0.006, -0.395], [0.027, -0.385], [0.034, -0.36], [0.026, -0.335], [0.008, -0.325]], 0, 0, 0, { seg: 6 }); tag(k0, 2);      // caps, and the knot the threads are bound into
                k0 = lb.n; lathe(lb, [[0.006, 0.32], [0.006, 1.32]], 0, 0, 0, { seg: 4 }); tag(k0, 1);
                ring([[0.004, -0.90], [0.022, -0.86], [0.037, -0.74], [0.038, -0.60], [0.031, -0.47], [0.017, -0.385]], 7, 3, 0);
                { const nb = 7 + 1; for (let j = 0; j <= 7; j++) { const k = lb.n - 6 * nb + j, r = ((j * 5) % 7) / 7; lb.P[k * 3 + 1] += 0.07 * r; lb.P[(k + nb) * 3 + 1] += 0.05 * r; } }       // a ragged hem: the threads are not all one length
                S.M = svM; S.ao = svA; S.tag = svT; delete BOX._lan;
                const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(lb.P.slice(0, lb.n * 3), 3)); g.setAttribute('normal', new THREE.BufferAttribute(lb.N.slice(0, lb.n * 3), 3, true));
                g.setAttribute('uv', new THREE.BufferAttribute(lb.U.slice(0, lb.n * 2), 2)); g.setAttribute('aX', new THREE.BufferAttribute(lb.X.slice(0, lb.n * 4), 4, true)); g.setIndex(new THREE.BufferAttribute(lb.I.slice(0, lb.ni), 1));
                return g;
            }
            // festive strings: catenaries between world points with small lanterns hung along them. The cord swings about the line through
            // its two ends and its lanterns ride it. Per cord vertex: uv = (row of the swing table, how far below that line), aC.xy = the
            // level direction it swings in
            const strings = [];
            function string(a, b, sag, n) {
                S.M = new THREE.Matrix4(); S.ao = null; S.tag = 'strings'; S.gy = 0; const cb = B.cord, pts = [], at = t => { const p = new THREE.Vector3().lerpVectors(a, b, t); p.y -= sag * 4 * t * (1 - t); return p; };
                for (let i = 0; i <= 28; i++) pts.push(at(i / 28));
                const hl = Math.hypot(b.x - a.x, b.z - a.z) || 1, nx = (b.z - a.z) / hl, nz = -(b.x - a.x) / hl, si = strings.length, i0 = lanterns.length;
                paint([0.03, 0.02, 0.015], 0); const k0 = cb.n; sweep(cb, pts, ngon(0.022, 4), { round: 1 });
                for (let k = k0; k < cb.n; k++) { const t = Math.floor((k - k0) / 8) / 28; cb.U[k * 2] = i0 + clamp(t * n - 1, 0, n - 2); cb.U[k * 2 + 1] = sag * 4 * t * (1 - t); cb.C[k * 4] = (nx * 0.5 + 0.5) * 255; cb.C[k * 4 + 1] = (nz * 0.5 + 0.5) * 255; cb.X[k * 4] = 4 * t * (1 - t) * 255; }
                for (let i = 1; i < n; i++) { const t = i / n, p = at(t); p.y -= 0.34; lanterns.push({ p, s: 0.8, hk: 0.34, w: 4 * t * (1 - t), bare: true, tag: 'str' + si, si, t, depth: sag * 4 * t * (1 - t), nx, nz }); }
                strings.push({ a, b, sag, n, i0, m: n - 1, nx, nz, at });
            }
            // ================= cloth: banners, pennants, curtains and bunting =================
            // One mesh. Per vertex: aH = (its hoist point, row of the swing table), aS = (metres from the hoist, metres across, length, seed),
            // aK = (the level direction of the hoist edge | - | the swing direction and depth of its cord, kind), aQ = (flutter, lag of the wave
            // that runs down the cloth in seconds a metre, how much sun comes through, pattern + 8 * border colour), aU = (u, v, length / width).
            //   kind 0  hung from a level edge: it swings as its row says and a wave runs down it      (banners, curtains)
            //   kind 1  flown from the top of a pole: it droops in still air and streams in a gust     (pennants)
            //   kind 2  a small flag on a festive cord: it rides the cord and leans with the wind there (bunting)
            const CB = { P: [], H: [], S: [], K: [], Q: [], C: [], U: [], I: [], n: 0 }, clr = rng(5151);
            const CCOL = { yel: [0.52, 0.36, 0.13], cream: [0.60, 0.53, 0.42], red: [0.36, 0.060, 0.045], jade: [0.06, 0.20, 0.18], gauze: [0.50, 0.45, 0.37], maroon: [0.14, 0.026, 0.030] };
            function clV(px, py, pz, hx, hy, hz, row, s, w, L, seed, kx, ky, kz, kind, amp, lag, thru, pat, col, u, v, asp) {
                CB.P.push(px, py, pz); CB.H.push(hx, hy, hz, row); CB.S.push(s, w, L, seed); CB.K.push(kx, ky, kz, kind); CB.Q.push(amp, lag, thru, pat); CB.C.push(col[0], col[1], col[2]); CB.U.push(u, v, asp); return CB.n++;
            }
            const toW = (x, y, z) => new THREE.Vector3(x, y, z).applyMatrix4(S.m).applyMatrix4(S.M);
            const clGrid = (base, nu, ns) => { for (let j = 0; j < ns; j++) for (let i = 0; i < nu; i++) { const a = base + j * (nu + 1) + i, b = a + 1, c = b + nu + 1, d = a + nu + 1; CB.I.push(a, b, c, a, c, d); } };
            // a cloth hung from a level edge between (ax, ay, az) and (bx, by, bz) in the current frame, L long.
            // o: col, bd (border: 0 red, 1 gold, 2 cream, 3 dark), pat, kd (drag over mass), cl, amp, lag, thru, tail ('v' swallow tail, 'p' point), row (share another cloth's row)
            function banner(ax, ay, az, bx, by, bz, L, o = {}) {
                const A = toW(ax, ay, az), E = toW(bx, by, bz), ew = E.clone().sub(A), wd = ew.length(); ew.normalize();
                let row = o.row; if (row === undefined) { row = cloths.length; cloths.push({ p: A.clone().lerp(E, 0.5).add(new THREE.Vector3(0, -0.55 * L, 0)), len: 0.55 * L, kd: o.kd ?? 0.2, cl: o.cl ?? 0.5, tag: S.tag }); }
                const nu = o.nu || 4, ns = o.ns || Math.max(6, Math.round(L / 0.3)), seed = clr(), col = o.col || CCOL.yel, pat = (o.pat ?? 1) + 8 * (o.bd ?? 0), base = CB.n;
                for (let j = 0; j <= ns; j++) for (let i = 0; i <= nu; i++) {
                    const u = i / nu, c = Math.abs(2 * u - 1), Li = L * (o.tail === 'v' ? 1 - 0.13 * (1 - c) : o.tail === 'p' ? 1 - 0.16 * c : 1), sd = Li * j / ns, hx = lerp(A.x, E.x, u), hy = lerp(A.y, E.y, u), hz = lerp(A.z, E.z, u);
                    clV(hx, hy - sd, hz, hx, hy, hz, row, sd, (u - 0.5) * wd, L, seed, ew.x, ew.y, ew.z, 0, o.amp ?? 1, o.lag ?? 0.06, o.thru ?? 0.35, pat, col, u, sd / L, L / wd);
                }
                clGrid(base, nu, ns); return row;
            }
            // a long tapering pennant flown from (x, y, z) in the current frame
            function pennant(x, y, z, L, W0, o = {}) {
                const T = toW(x, y, z), row = cloths.length; cloths.push({ p: T.clone().add(new THREE.Vector3(0, -0.5 * L, 0)), len: 0.5 * L, kd: o.kd ?? 0.42, cl: o.cl ?? 0.6, tag: S.tag, pen: L });
                const nu = 3, ns = Math.max(8, Math.round(L / 0.3)), seed = clr(), col = o.col || CCOL.yel, pat = 2 + 8 * (o.bd ?? 0), base = CB.n;
                for (let j = 0; j <= ns; j++) for (let i = 0; i <= nu; i++) {
                    const q = j / ns, sd = L * q, w = -W0 / 2 + W0 * (1 - 0.86 * q) * (i / nu - 0.5);
                    clV(T.x, T.y - sd, T.z, T.x, T.y, T.z, row, sd, w, L, seed, 0, 0, 0, 1, o.amp ?? 1, o.lag ?? 0.05, o.thru ?? 0.45, pat, col, i / nu, q, L / W0);
                }
                clGrid(base, nu, ns); return row;
            }
            // small pointed flags along a festive cord, two between each pair of lanterns
            function bunting(st, k0) {
                const cols = [CCOL.yel, CCOL.cream, CCOL.red, CCOL.jade], n = st.n, tx = -st.nz, tz = st.nx, wf = 0.46, lf = 0.70; let c = k0;
                for (let i = 0; i < n; i++) for (const f of [0.34, 0.67]) {
                    const t = (i + f) / n, p = st.at(t), row = st.i0 + clamp(t * n - 1, 0, n - 2), dep = st.sag * 4 * t * (1 - t), seed = clr(), col = cols[c++ % 4], base = CB.n;
                    for (const [sd, hw] of [[0, 0.5], [0.5, 0.32], [1, 0]]) for (const sg of hw ? [-1, 1] : [0]) { const w = sg * hw * wf; clV(p.x + tx * w, p.y - sd * lf, p.z + tz * w, p.x, p.y, p.z, row, sd * lf, w, lf, seed, st.nx, dep, st.nz, 2, 1, 0, 0.5, 3, col, sg * hw + 0.5, sd, lf / wf); }
                    CB.I.push(base, base + 1, base + 3, base, base + 3, base + 2, base + 2, base + 3, base + 4);
                }
            }
            // a flag pole: stone socket, lacquered mast, gilt ball; a pennant flies from under the ball
            function pole(x, z, y0, h, L, W0, o) {
                const r = 0.10;
                paint(STN3, K.MONO, { tri: 1 }); lathe(sb, [[r * 3.4, 0], [r * 3.4, 0.14], [r * 2.6, 0.22], [r * 2.1, 0.62], [r * 1.5, 0.66]], x, y0, z, { seg: 8, flat: 1, capT: 1, a0: Math.PI / 8 });
                paint(RED, K.LAC); lathe(tb, [[r, 0.6], [r * 0.92, h * 0.5], [r * 0.6, h - 0.3]], x, y0, z, { seg: 8 });
                paint(GOLD, K.GILT); lathe(tb, [[r * 0.6, h - 0.3], [r * 1.25, h - 0.26], [r * 1.25, h - 0.2], [r * 0.5, h - 0.16], [r * 1.5, h - 0.06], [r * 1.1, h + 0.06], [0, h + 0.12]], x, y0, z, { seg: 8 });
                pennant(x, y0 + h - 0.34, z, L, W0, o);
            }
            const GL_CLOTH_V = (NS, NLS) => /* glsl */`
    float sd = aS.x, wv = aS.y, cq = sd / aS.z, kind = aK.w, sp, ph, dsp, dds, ddw; vec3 nrm, da, db;
    if (kind > 1.5) {                                                          // bunting: it rides its cord and leans with the wind at its hook
      vec4 b = swRow(aH.w + ${NS.toFixed(1)}, 0.0); vec3 tg = vec3(-aK.z, 0.0, aK.x); sp = length(b.yz); ph = uSw.w * uTime + b.w;
      float lean = min(sp * sp * 0.055, 5.0); db = normalize(vec3(b.y / max(sp, 1e-3) * lean, -1.0, b.z / max(sp, 1e-3) * lean)); da = tg; nrm = normalize(cross(tg, db));
      float A = (0.025 + 0.02 * sp) * cq * aQ.x, a1 = ph * 2.3 - sd * 7.0 + aS.w * 6.283 + wv * 3.0; dsp = A * sin(a1); dds = -7.0 * A * cos(a1); ddw = 3.0 * A * cos(a1);
      clP = aH.xyz + swCord(b.x, aK.y, aK.xz) + tg * wv + db * sd + nrm * dsp;
    } else {
      float row = aH.w + ${NLS.toFixed(1)}, lg = sd * aQ.y; vec4 q0 = swRow(row, 0.0), q1 = swRow(row, lg * 0.5), q2 = swRow(row, lg);
      vec3 d1 = swDir(q1.xy), dm = (swDir(q0.xy) + 2.0 * d1 + swDir(q2.xy)) * 0.25; db = swDir(q2.xy); sp = q2.w; ph = uSw.w * uTime + q2.z;
      if (kind < 0.5) {                                                        // hung from a level edge
        da = aK.xyz; nrm = normalize(cross(da, db)); float wid = aS.z / aU.z, uu = 2.0 * wv / wid, gz = step(mod(aQ.w, 8.0), 0.5);
        float A = (0.03 + 0.026 * sp) * aQ.x * cq, a1 = ph * 1.7 - sd * 3.6 + aS.w * 6.283 + wv * 1.6, a2 = ph * 2.9 - sd * 7.0 + aS.w * 11.0 - wv * 2.9;
        dsp = A * (sin(a1) + 0.45 * sin(a2)); dds = -A * (3.6 * cos(a1) + 3.15 * cos(a2)); ddw = A * (1.6 * cos(a1) - 1.3 * cos(a2));
        float bel = (1.0 - uu * uu) * cq * min(sp * 0.035, 0.32) * aQ.x * clamp(dot(cross(da, vec3(0.0, -1.0, 0.0)), db) * 5.0, -1.0, 1.0);      // the middle fills with the wind
        dsp += bel; ddw += -4.0 * uu / wid * bel / max(1.0 - uu * uu, 0.05); dds += bel / max(sd, 0.05);
        float pk = 24.0, pa = gz * 0.05 * (0.45 + 0.55 * cq) / (1.0 + 0.10 * sp), a3 = wv * pk + aS.w * 40.0 + 1.3 * sin(sd * 1.7 + aS.w * 9.0);        // gauze hangs in folds; a gust pulls them flatter
        dsp += pa * sin(a3); ddw += pa * pk * cos(a3);
        clP = aH.xyz + dm * sd * (1.0 + gz * 0.022 * sin(a3 * 0.5 + 0.7)) + nrm * dsp - da * (gz * 0.16 * uu * (1.0 - cq) * wid * 0.5);      // (gathered a little where it is tied; the folds leave the hem uneven)
      } else {                                                                 // flown from a pole top: across the fly is up when it streams, level when it hangs
        vec2 hd = d1.xz + db.xz; float hl = length(hd); hd = hl > 0.02 ? hd / hl : vec2(-0.928, 0.371);
        nrm = vec3(-hd.y, 0.0, hd.x); da = normalize(cross(nrm, db));
        float A = (0.05 + 0.05 * sp) * aQ.x * pow(cq, 0.8), a1 = ph * 1.9 - sd * 2.7 + aS.w * 6.283, a2 = ph * 3.3 - sd * 5.6 + aS.w * 9.0 + wv * 2.0;
        dsp = A * (sin(a1) + 0.4 * sin(a2)); dds = -A * (2.7 * cos(a1) + 2.24 * cos(a2)); ddw = A * 0.8 * cos(a2);
        float sag = 0.16 * cq * cq * sd * (1.0 - 0.6 * min(sp / 9.0, 1.0)), up = 0.45 * A * sin(a1 * 0.5 + 1.0);              // the tail hangs a little below the line of the fly, and whips
        clP = aH.xyz + dm * sd + da * wv + nrm * dsp + vec3(0.0, up - sag, 0.0); nrm = -nrm; dds = -dds; ddw = -ddw;
      }
    }
    clN = normalize(nrm - db * dds - da * ddw);
    vCu = aU; vCq = vec3(aQ.z, aQ.w, sp);`;
            const GL_CLOTH_F = /* glsl */`
    { float pat = mod(vCq.y, 8.0), bi = floor(vCq.y / 8.0 + 0.01), aa = fwidth(vCu.x) * 1.2 + 1e-4; vec2 uc = vCu.xy;
      vec3 bc = bi < 0.5 ? vec3(0.50, 0.032, 0.026) : bi < 1.5 ? vec3(0.80, 0.50, 0.07) : bi < 2.5 ? vec3(0.72, 0.66, 0.52) : vec3(0.05, 0.045, 0.05);
      if (pat > 0.5 && pat < 2.5) { float ex = min(uc.x, 1.0 - uc.x), bw = pat < 1.5 ? 0.10 : 0.15, e = 1.0 - smoothstep(bw - aa, bw + aa, ex);
        if (pat < 1.5) { e = max(e, 1.0 - smoothstep(0.03, 0.035, uc.y)); vec2 c = vec2(uc.x - 0.5, (fract(uc.y * 4.0 - 0.1) - 0.5) * vCu.z / 4.0); float dm = abs(c.x) + abs(c.y);
          e = max(e, (1.0 - smoothstep(0.17 - aa, 0.17 + aa, dm)) * smoothstep(0.085 - aa, 0.085 + aa, dm) * step(uc.y, 0.97)); }         // a row of open lozenges down the field
        diffuseColor.rgb = mix(diffuseColor.rgb, bc, e); }
      if (pat < 0.5) { diffuseColor.rgb *= 0.80 + 0.22 * sin(uc.x * 25.2 + 1.3 * sin(uc.y * vCu.z * 1.8)); diffuseColor.rgb = mix(diffuseColor.rgb, bc, 0.5 * (1.0 - smoothstep(0.03, 0.05, min(uc.y, 1.0 - uc.y)))); diffuseColor.a = 0.62 + 0.3 * (1.0 - smoothstep(0.03, 0.06, min(min(uc.x, 1.0 - uc.x), min(uc.y, 1.0 - uc.y)))); }      // gauze: the valley shows through it, its hems are double
    }`;
            // ================= weights on strings: the swing table =================
            // A lantern is a bob on a cord of its own length with air drag on its paper; a festive cord is a chain of coupled swings about the
            // line through its two ends; a banner is a cloth pendulum. Each of them is INTEGRATED ONCE, at load, through the whole 90 s of
            // wind the film blows at it, and written to one half-float texture: one row per weight, SWHZ samples a second. The wind is
            //   the valley's own (Film.gust and Film.windPhase, as a front that leaves the main spire and rolls down the valley at 30 m/s,
            //   with eddies carried along it), plus
            //   the pressure fronts of the two roars, the clashes, the bolt, the splash and the blast, each a shell travelling outward from
            //   where it happened at its own finite speed (Wake.fronts, or the same list built here from Film.T, Film.A and headAt), plus
            //   the air a loong shoves aside, drags along and sucks in behind it as it passes (Wake.windAt).
            // A frame only reads its row at film time t, so any frame can be drawn in any order.
            //   rows 0 .. NL-1                 lantern i:  xy = where its body points (level part of the unit vector from hook to body), zw = its tassel
            //   rows NL .. NL+NS-1             string lantern:  x = swing angle of the cord at its hook, yz = wind there (m/s, level), w = flutter phase
            //   rows NL+NS ..                  cloth:  xy = where it streams, z = flutter phase, w = wind speed (m/s)
            const SWHZ = 30, SWG = 9.81, SW_CAP0 = rad(44), SW_CAP1 = rad(56);
            const swU = { tSw: { value: null }, uSw: { value: new THREE.Vector4(0, 0, 1, 0) }, uLit: { value: 1 } }, cloths = [], swI = {};
            // kd: drag of a lantern over its mass (1/m): at 6 m/s it leans 17 degrees, at 11 m/s 48. cl: friction of the hook and the cord (1/s). vm: the hardest gust a hung thing feels (m/s).
            // u0, u1: the valley's steady wind and its slow swell (m/s), uf: metres a second per unit of a valley gust front, ug: per unit of Film.gust, tu: turbulence (m/s), reach: how near a body must be for its wake to count (m)
            const swP = { kd: 0.088, cl: 0.30, clS: 0.55, vm: 11.5, u0: 2.3, u1: 2.9, uf: 5.5, ug: 8.5, tu: 0.7, reach: 30, kdc: 0.075 };
            let swW = 0, swH = 0, swF = null, swN0 = 0, swBaked = false, swFloat = false;
            const SW_GLSL = /* glsl */`
    uniform sampler2D tSw; uniform vec4 uSw;       // x: film time as a texture coordinate, y: seconds to coordinate, z: 1 / rows, w: mean flutter rate (rad/s)
    vec4 swRow(float row, float lag){ return texture2D(tSw, vec2(uSw.x - lag * uSw.y, (row + 0.5) * uSw.z)); }
    vec3 swDir(vec2 h){ return vec3(h.x, -sqrt(max(1.0 - dot(h, h), 0.0)), h.y); }
    vec3 swTurn(vec3 r, vec3 d){ vec3 v = vec3(-d.z, 0.0, d.x); return r + cross(v, r) + cross(v, cross(v, r)) / (1.0 - d.y); }      // the turn that takes straight down to d
    vec3 swCord(float ph, float depth, vec2 n){ return depth * (sin(ph) * vec3(n.x, 0.0, n.y) + (1.0 - cos(ph)) * vec3(0.0, 1.0, 0.0)); }`;
            function swAlloc() {
                swN0 = lanterns.findIndex(l => l.bare); if (swN0 < 0) swN0 = lanterns.length;
                swW = Math.round(Film.DUR * SWHZ) + 1; swH = lanterns.length + (lanterns.length - swN0) + cloths.length;
                swFloat = !!(G.R && G.R.extensions && G.R.extensions.has('OES_texture_float_linear')) && !Q.has('swhalf');        // a float table where the GPU can filter one (no conversion at load), a half-float one anywhere else
                const tx = swFloat ? new THREE.DataTexture(new Float32Array(swW * swH * 4), swW, swH, THREE.RGBAFormat, THREE.FloatType) : new THREE.DataTexture(new Uint16Array(swW * swH * 4), swW, swH, THREE.RGBAFormat, THREE.HalfFloatType);
                tx.minFilter = tx.magFilter = THREE.LinearFilter; tx.wrapS = tx.wrapT = THREE.ClampToEdgeWrapping; tx.generateMipmaps = false; tx.needsUpdate = true;
                swU.tSw.value = tx; swU.uSw.value.set(0.5 / swW, SWHZ / swW, 1 / swH, 6);
            }
            function swBake(over) {
                if (over) Object.assign(swP, over);
                swBaked = true; const P = swP, QA = CAPTURE && !Q.has('swfast'), t0 = performance.now(), DUR = Film.DUR, NL = lanterns.length, N0 = swN0, NS = NL - N0, NC = cloths.length, NP = NL + NC, NT = swW, W4 = swW * 4;
                const WK = (typeof Wake !== 'undefined' && Wake && Wake.windAt) ? Wake : null; if (WK && WK.build) WK.build(G.scene, G.fx);
                const drs = (typeof Dragon !== 'undefined' && Dragon.list && Dragon.list.every(d => d.ready)) ? Dragon.list : [];
                // ---- the fronts ----
                let fr = WK && WK.fronts && WK.fronts.length ? WK.fronts : null;
                if (!fr) {
                    const FT = Film.T, A = Film.A, h = (d, t) => d && d.ready ? d.headAt(t, new THREE.Vector3()) : new THREE.Vector3(10, 100, -66), D = typeof Dragon !== 'undefined' ? Dragon : {};
                    fr = [{ t: FT.ROAR + 0.1, o: h(D.red, FT.ROAR + 0.1), c: 55, S: 1.15, dur: 2.5, ref: 45 }, { t: FT.WROAR + 0.1, o: h(D.white, FT.WROAR + 0.1), c: 55, S: 0.95, dur: 1.8, ref: 45 }, { t: FT.CLASH1, o: A.clash1.clone(), c: 85, S: 0.9, dur: 0.3, ref: 40 },
                    { t: FT.BOLT + 0.12, o: A.boltHit.clone(), c: 85, S: 0.7, dur: 0.2, ref: 18 }, { t: FT.CLASH2, o: A.clash2.clone(), c: 85, S: 1.0, dur: 0.3, ref: 40 }, { t: FT.SPLASH, o: A.splash.clone(), c: 60, S: 0.9, dur: 0.45, ref: 26 }, { t: FT.BLAST, o: Film.beamMidAt(FT.BLAST, new THREE.Vector3()), c: 85, S: 2.3, dur: 0.9, ref: 45 }];
                }
                const NF = fr.length, fT = new Float32Array(NF), fO = new Float32Array(NF * 3), fC = new Float32Array(NF), fS = new Float32Array(NF), fD = new Float32Array(NF), fR = new Float32Array(NF);
                fr.forEach((f, k) => { fT[k] = f.t; fO[k * 3] = f.o.x; fO[k * 3 + 1] = f.o.y; fO[k * 3 + 2] = f.o.z; fC[k] = f.c; fS[k] = f.S; fD[k] = f.dur; fR[k] = f.ref; });
                // ---- the valley's wind: gust strength and wind phase, 60 samples a second ----
                const NG = Math.round(DUR * 60) + 1, gT = new Float32Array(NG), pT = new Float32Array(NG); for (let i = 0; i < NG; i++) { gT[i] = Film.gust(i / 60); pT[i] = Film.windPhase(i / 60); }
                // the valley's steady wind and its gust fronts. When the wake module carries the film's ONE wind (Wake.WIND { d, S0, rise, fall } and Wake.gusts:
                // rows [when the front enters at the upwind corner, heading x, heading z, speed, strength]) the lanterns and the cloth ride those same fronts,
                // so they heave with the trees and the mist; without it they get a slow swell and veer of their own
                let GU = null, GW = null; try { GU = WK && WK.gusts; GW = WK && WK.WIND; } catch (e) { GU = null; }
                if (!(Array.isArray(GU) && GU.length && GW && GW.d && GU.every(g => g && g.length >= 5 && g[3] > 1))) GU = null;
                const wl0 = GU ? Math.hypot(GW.d[0], GW.d[1]) || 1 : 1, WDX = GU ? GW.d[0] / wl0 : -0.928, WDZ = GU ? GW.d[1] / wl0 : 0.371, gS0 = GU && Number.isFinite(GW.S0) ? GW.S0 : -125, gRise = GU && GW.rise > 0 ? GW.rise : 0.55, gFall = GU && GW.fall > 0 ? GW.fall : 2.6, act = [];
                const SP = (typeof Rock !== 'undefined' && Rock.L && Rock.L.main) || { x: 10, z: -66 };
                // ---- the weights ----
                const px = new Float32Array(NP), py = new Float32Array(NP), pz = new Float32Array(NP), len = new Float32Array(NP), kd = new Float32Array(NP), cl = new Float32Array(NP), cap = new Uint8Array(NP), grp = new Int16Array(NP), tags = [], r = rng(9091);
                for (let i = 0; i < NP; i++) {
                    const o = i < NL ? lanterns[i] : cloths[i - NL];
                    px[i] = o.p.x; py[i] = o.p.y; pz[i] = o.p.z; len[i] = i < NL ? o.hk : o.len; kd[i] = (i < NL ? P.kd : o.kd) * (0.88 + 0.24 * r()); cl[i] = i < NL ? (o.bare ? P.clS : P.cl) : o.cl; cap[i] = i < NL ? 1 : 0;
                    let g = tags.indexOf(o.tag); if (g < 0) { g = tags.length; tags.push(o.tag); } grp[i] = g;
                }
                const NGp = tags.length, gc = new Float32Array(NGp * 4), gn = new Uint8Array(NGp);
                for (let g = 0; g < NGp; g++) { let n = 0, x = 0, y = 0, z = 0; for (let i = 0; i < NP; i++) if (grp[i] === g) { x += px[i]; y += py[i]; z += pz[i]; n++; } x /= n; y /= n; z /= n; let R = 0; for (let i = 0; i < NP; i++) if (grp[i] === g) R = Math.max(R, Math.hypot(px[i] - x, py[i] - y, pz[i] - z)); gc.set([x, y, z, R + P.reach], g * 4); }
                const X = new Float32Array(NP * 3), V = new Float32Array(NP * 3), HK = new Float32Array(NP * 3), Wd = new Float32Array(NP * 3), fl = new Float32Array(NP * 4), ws = new Float32Array(NP * 3), psi = new Float32Array(NP), ph = new Float32Array(NL), om = new Float32Array(NL), ac = new Float32Array(NL);
                for (let i = 0; i < NP; i++) X[i * 3 + 1] = -len[i];
                const wl = new Float32Array(NP * 3); for (let i = 0; i < NL; i++) if (lanterns[i].wall) wl.set(lanterns[i].wall, i * 3);
                const dep = new Float32Array(NL), snP = new Float32Array(NL), csP = new Float32Array(NL).fill(1); for (let i = N0; i < NL; i++) dep[i] = lanterns[i].depth;
                // a gust is born round the main spire, where the loongs are, and rolls outward and down the valley at 45 m/s: when it reaches a weight, and which way it pushes there
                const gDel = new Float32Array(NP), gDx = new Float32Array(NP), gDz = new Float32Array(NP);
                for (let i = 0; i < NP; i++) { const rx = px[i] - SP.x, rz = pz[i] - SP.z, rl = Math.hypot(rx, rz) || 1; let dx = 0.45 * WDX + 0.55 * rx / rl, dz = 0.45 * WDZ + 0.55 * rz / rl; const dl = Math.hypot(dx, dz) || 1; gDx[i] = dx / dl; gDz[i] = dz / dl; gDel[i] = Math.min(rl / 45, 3); }
                const F = swFloat ? swU.tSw.value.image.data : new Float32Array(swW * swH * 4), wkv = new Float32Array(NP * 3), was = new Uint8Array(NP), R2P = (P.reach + 4) * (P.reach + 4), tmp = new THREE.Vector3(), pp = new THREE.Vector3(), bp = new Float32Array(2 * 32 * 3); const penGap = new Float32Array(NC).fill(1e9), penT = new Float32Array(NC); let nb = 0, nearN = 0, pkA = 0, pkW = 0, msW = 0, nWk = 0;
                const SUB = 2, dt = 1 / (SWHZ * SUB), ka = 1 - Math.exp(-1 / SWHZ / 0.085), kw = 1 - Math.exp(-1 / SWHZ / 0.14), SC0 = Math.sin(SW_CAP0), WARM = 6 * SWHZ, VM = P.vm, rt = new Float32Array(8192), tn = (x, o) => { const i = Math.floor(x), f = x - i, w = f * f * (3 - 2 * f), a = rt[(i + o) & 8191], b = rt[(i + 1 + o) & 8191]; return a + (b - a) * w; }, pkDeg = new Float32Array(NP), pkDps = new Float32Array(NP), prev = new Float32Array(NP * 2);
                for (let i = 0; i < 8192; i++) rt[i] = r() * 2 - 1;
                for (let k = -WARM; k < NT; k++) {
                    const t = k / SWHZ, tc = clamp(t, 0, DUR);
                    // where the two bodies are: a group of weights asks the wake only while a body is within reach of it
                    nb = 0; for (const d of drs) { const s = d.sOf(tc); for (let a = 0; a <= d.LEN && nb < 64; a += 8) { d.pathAt(Math.max(s - a, 0.7), tmp); bp[nb * 3] = tmp.x; bp[nb * 3 + 1] = tmp.y; bp[nb * 3 + 2] = tmp.z; nb++; } }
                    if (QA) for (let c = 0; c < NC; c++) { const o = cloths[c]; if (!o.pen) continue; const x = o.p.x, y = o.p.y + o.len, z = o.p.z; for (let j = 0; j < nb; j++) { const d = Math.hypot(bp[j * 3] - x, bp[j * 3 + 1] - y, bp[j * 3 + 2] - z); if (!(d >= penGap[c])) { penGap[c] = d; penT[c] = tc; } } }
                    for (let g = 0; g < NGp; g++) { let near = 0; const x = gc[g * 4], y = gc[g * 4 + 1], z = gc[g * 4 + 2], R2 = gc[g * 4 + 3] * gc[g * 4 + 3]; for (let j = 0; j < nb && !near; j++) { const dx = bp[j * 3] - x, dy = bp[j * 3 + 1] - y, dz = bp[j * 3 + 2] - z; if (dx * dx + dy * dy + dz * dz < R2) near = 1; } near = WK ? near : 0; gn[g] = near ? (gn[g] ? 2 : 1) : 0; nearN += near; }
                    // ---- the wind at every weight ----
                    const tA = performance.now(); act.length = 0; if (GU) for (let q = 0; q < GU.length; q++) { const dq = tc - GU[q][0]; if (dq > 0 && dq < 20) act.push(GU[q]); }
                    const t60 = tc * 60, tk = Math.min(NG - 2, t60 | 0), wk = 0.75 + 0.25 * Math.min(gT[tk] + (gT[tk + 1] - gT[tk]) * (t60 - tk), 1.5);
                    for (let i = 0; i < NP; i++) {
                        const x = px[i], y = py[i], z = pz[i], al = x * WDX + z * WDZ, cr = -x * WDZ + z * WDX, td = clamp(tc - gDel[i], 0, DUR) * 60, ti = Math.min(NG - 2, td | 0), tf = td - ti, t6 = tc * 60, tj = Math.min(NG - 2, t6 | 0);
                        const g = gT[ti] + (gT[ti + 1] - gT[ti]) * tf, p = pT[tj] + (pT[tj + 1] - pT[tj]) * (t6 - tj);
                        // a slow swell carried down the wind, a slower veer across it, and turbulence that is different at every hook
                        const e1 = Math.sin(p * 1.25 - al * 0.09 + y * 0.05), e2 = Math.sin(p * 0.71 + cr * 0.13 + y * 0.11 + 0.8 * e1), n1 = tn(p * 2.3 + i * 0.31, i * 37), n2 = tn(p * 2.3 + i * 0.17, i * 91 + 4001);
                        let u = P.u0 + P.tu * n1, v = P.tu * n2, fx = 0, fz = 0; const ug = P.ug * Math.max(0, g - 0.16) * (0.9 + 0.1 * n2);
                        if (GU) { for (let q = 0; q < act.length; q++) { const gq = act[q], tau = tc - gq[0] - (x * gq[1] + z * gq[2] - gS0) / gq[3]; if (tau > 0 && tau < 9) { const e = gq[4] * sm(0, gRise, tau) * Math.exp(-tau / gFall) * P.uf * wk; fx += gq[1] * e; fz += gq[2] * e; } } u *= wk; }
                        else { u += P.u1 * e1; v += 1.5 * e2; }
                        let wx = WDX * u - WDZ * v + fx + gDx[i] * ug, wy = 0.3 * n1 + 0.04 * (u + ug) + 0.03 * Math.hypot(fx, fz), wz = WDZ * u + WDX * v + fz + gDz[i] * ug;
                        let nr = 0; if (gn[grp[i]]) for (let j = 0; j < nb; j++) { const dx = bp[j * 3] - x, dy = bp[j * 3 + 1] - y, dz = bp[j * 3 + 2] - z; if (dx * dx + dy * dy + dz * dz < R2P) { nr = 1; break; } }
                        if (nr) { if (!(k & 1) || !was[i]) { pp.set(x, y, z); WK.windAt(pp, tc, tmp); wkv[i * 3] = tmp.x; wkv[i * 3 + 1] = tmp.y; wkv[i * 3 + 2] = tmp.z; nWk++; } wx += wkv[i * 3]; wy += wkv[i * 3 + 1]; wz += wkv[i * 3 + 2]; was[i] = 1; }      // (asked every other sample while a body stays near)
                        else {
                            was[i] = 0; for (let f = 0; f < NF; f++) {
                                const age = tc - fT[f]; if (age <= 0 || age > 10) continue; const dx = x - fO[f * 3], dy = y - fO[f * 3 + 1], dz = z - fO[f * 3 + 2], dist = Math.sqrt(dx * dx + dy * dy + dz * dz), q = (dist - age * fC[f]) / 7;
                                const sh = Math.exp(-q * q) + (q < 0 ? 0.4 * (1 - sm(fD[f], fD[f] + 0.6, age - dist / fC[f])) : 0), a = 30 * fS[f] * fR[f] / (fR[f] + dist) * sh / Math.max(dist, 0.01); wx += dx * a; wy += dy * a; wz += dz * a;
                            }
                        }
                        const wm = Math.sqrt(wx * wx + wy * wy + wz * wz), sat = wm > 1e-3 ? VM * Math.tanh(wm / VM) / wm : 1;      // under an eave the hardest gust is broken
                        Wd[i * 3] = wx * sat; Wd[i * 3 + 1] = wy * sat * 0.6; Wd[i * 3 + 2] = wz * sat; if (wm * sat > pkW) pkW = wm * sat;
                    }
                    msW += performance.now() - tA;
                    for (let sub = 0; sub < SUB; sub++) {
                        // ---- the cords: every hook is one link of a chain of swings about the line through the cord's ends ----
                        for (const st of strings) {
                            const m = st.m, i0 = st.i0, wc2 = 1.25 * SWG / st.sag, Le = 0.8 * st.sag, kap = Math.pow(m / 0.9, 2), kdm = 2.2, nx = st.nx, nz = st.nz;
                            for (let j = 0; j < m; j++) {
                                const i = i0 + j, c = csP[i], sn = snP[i], ex = c * nx, ez = c * nz, sp = dep[i] * om[i];
                                const rx = Wd[i * 3] - sp * ex, ry = Wd[i * 3 + 1] - sp * sn, rz = Wd[i * 3 + 2] - sp * ez, rm = Math.sqrt(rx * rx + ry * ry + rz * rz), a = Math.max(j - 1, 0) + i0, b = Math.min(j + 1, m - 1) + i0;
                                ac[i] = -wc2 * sn + P.kdc * rm * (rx * ex + ry * sn + rz * ez) / Le + kap * (ph[a] - 2 * ph[i] + ph[b]) + kdm * (om[a] - 2 * om[i] + om[b]) - 0.16 * om[i];
                            }
                            for (let j = 0; j < m; j++) { const i = i0 + j; om[i] += ac[i] * dt; ph[i] += om[i] * dt; const sn = Math.sin(ph[i]), c = Math.cos(ph[i]), d = dep[i]; snP[i] = sn; csP[i] = c; HK[i * 3] = d * sn * nx; HK[i * 3 + 1] = d * (1 - c); HK[i * 3 + 2] = d * sn * nz; }
                        }
                        // ---- every weight: a bob on a cord (the cord is a constraint, the hook may move) ----
                        for (let i = 0; i < NP; i++) {
                            const a = i * 3, L = len[i];
                            let vx = V[a], vy = V[a + 1], vz = V[a + 2]; const rx = Wd[a] - vx, ry = Wd[a + 1] - vy, rz = Wd[a + 2] - vz, kk = kd[i] * Math.sqrt(rx * rx + ry * ry + rz * rz), c = cl[i];
                            vx += (kk * rx - c * vx) * dt; vy += (kk * ry - c * vy - SWG) * dt; vz += (kk * rz - c * vz) * dt;
                            const dx = X[a] + vx * dt - HK[a], dy0 = X[a + 1] + vy * dt - HK[a + 1], dz = X[a + 2] + vz * dt - HK[a + 2], s = L / Math.sqrt(dx * dx + dy0 * dy0 + dz * dz); let nx = HK[a] + dx * s, ny = HK[a + 1] + dy0 * s, nz = HK[a + 2] + dz * s, hit = 0;
                            if (wl[i * 3 + 2] > 0) { const ex = nx * wl[i * 3] + nz * wl[i * 3 + 1] - wl[i * 3 + 2]; if (ex > 0) { nx -= wl[i * 3] * ex; nz -= wl[i * 3 + 1] * ex; ny = -Math.sqrt(Math.max(L * L - nx * nx - nz * nz, 0)); hit = 1; } }      // it has met the column behind it
                            V[a] = (nx - X[a]) / dt; V[a + 1] = (ny - X[a + 1]) / dt; V[a + 2] = (nz - X[a + 2]) / dt; X[a] = nx; X[a + 1] = ny; X[a + 2] = nz;
                            if (hit) { const vn = V[a] * wl[i * 3] + V[a + 2] * wl[i * 3 + 1]; if (vn > -0.3) { V[a] -= wl[i * 3] * (vn + 0.3 * Math.max(vn, 0) + 0.05); V[a + 2] -= wl[i * 3 + 1] * (vn + 0.3 * Math.max(vn, 0) + 0.05); } }
                            if (sub < SUB - 1) continue;
                            // where it points, held under the cap; the tassel follows the body through two soft lags, so it trails and never swings wider
                            let hx = (nx - HK[a]) / L, hz = (nz - HK[a + 2]) / L; const dy = ny - HK[a + 1], hm = Math.sqrt(hx * hx + hz * hz), up = dy > 0;
                            if (cap[i]) { if (hm > SC0 || up) { let th = up ? Math.PI - Math.asin(Math.min(1, hm)) : Math.asin(Math.min(1, hm)); th = SW_CAP0 + (SW_CAP1 - SW_CAP0) * (1 - Math.exp(-(th - SW_CAP0) / (SW_CAP1 - SW_CAP0))); const q = Math.sin(th) / hm; hx *= q; hz *= q; } }
                            else if (hm > 0.996 || up) { const q = 0.996 / Math.max(hm, 1e-6); hx *= q; hz *= q; }
                            const b = i * 4; fl[b] = hx; fl[b + 1] = hz; fl[b + 2] += (hx - fl[b + 2]) * ka; fl[b + 3] += (hz - fl[b + 3]) * ka;
                            prev[i * 2] += (fl[b + 2] - prev[i * 2]) * ka; prev[i * 2 + 1] += (fl[b + 3] - prev[i * 2 + 1]) * ka;
                            ws[a] += (Wd[a] - ws[a]) * kw; ws[a + 1] += (Wd[a + 2] - ws[a + 1]) * kw;      // the wind a flag feels: the gust, less its sharpest edge
                            psi[i] += (1.6 + 1.0 * Math.sqrt(ws[a] * ws[a] + ws[a + 1] * ws[a + 1])) / SWHZ;
                        }
                    }
                    if (k < 0) continue;
                    for (let i = 0; i < NP; i++) {
                        const b = i * 4, a = i * 3;
                        if (i < NL) {
                            const o = i * W4 + k * 4; F[o] = fl[b]; F[o + 1] = fl[b + 1]; F[o + 2] = prev[i * 2]; F[o + 3] = prev[i * 2 + 1];
                            if (i >= N0) { const o2 = (NL + i - N0) * W4 + k * 4; F[o2] = ph[i]; F[o2 + 1] = ws[a]; F[o2 + 2] = ws[a + 1]; F[o2 + 3] = psi[i]; }
                        }
                        else { const o = (NL + NS + i - NL) * W4 + k * 4; F[o] = fl[b]; F[o + 1] = fl[b + 1]; F[o + 2] = psi[i]; F[o + 3] = Math.hypot(ws[a], ws[a + 1]); }
                    }
                }
                // flutter phase: stored as its departure from the mean rate, so a half float keeps it fine all the way to the end of the film
                let mr = 0; for (let i = 0; i < NP; i++) mr += psi[i]; mr = NP ? mr / NP / (DUR + WARM / SWHZ) : 6; const psi0 = mr * WARM / SWHZ;
                for (let i = N0; i < NP; i++) { const row = i < NL ? NL + i - N0 : NL + NS + i - NL, ch = i < NL ? 3 : 2; for (let k = 0; k < NT; k++) F[row * W4 + k * 4 + ch] -= psi0 + mr * k / SWHZ; }
                // ---- measurements for the report: peak angle and peak angular speed of every lantern ----
                if (QA) for (let i = 0; i < NL; i++) { let pa = 0, pv = 0, ox = 0, oy = -1, oz = 0; for (let k = 0; k < NT; k++) { const o = i * W4 + k * 4, hx = F[o], hz = F[o + 1], hm = Math.min(1, Math.hypot(hx, hz)), hy = -Math.sqrt(1 - hm * hm), th = Math.asin(hm); if (th > pa) pa = th; if (k) { const dv = Math.hypot(hx - ox, hy - oy, hz - oz) * SWHZ; if (dv > pv) pv = dv; } ox = hx; oy = hy; oz = hz; } pkDeg[i] = pa * 180 / Math.PI; pkDps[i] = pv * 180 / Math.PI; if (pkDeg[i] > pkA) pkA = pkDeg[i]; }
                if (!swFloat) { const h16 = swU.tSw.value.image.data, toH = THREE.DataUtils.toHalfFloat; for (let i = 0; i < F.length; i++) h16[i] = toH(F[i]); }
                swU.tSw.value.needsUpdate = true; swU.uSw.value.w = mr; swF = CAPTURE || swFloat ? F : null;
                Object.assign(swI, { ms: Math.round(performance.now() - t0), float: swFloat, valleyFronts: GU ? GU.length : 0, msWind: Math.round(msW), wakeCalls: nWk, size: [swW, swH], lanterns: NL, onStrings: NS, cloth: NC, fronts: NF, wake: !!WK, nearShare: +(nearN / ((NT + WARM) * NGp)).toFixed(3), peakDeg: +pkA.toFixed(1), peakDps: +Math.max(...pkDps).toFixed(0), peakWind: +pkW.toFixed(1), flutter: +mr.toFixed(2) });
                if (QA) swI.pennants = cloths.map((o, c) => o.pen ? [o.tag, +o.pen.toFixed(1), +penGap[c].toFixed(1), +penT[c].toFixed(1)] : null).filter(Boolean);      // [building, length, nearest a body's centre line comes to its pole top (m), when (s)]
                G.info.swing = swI;
            }
            // QA: the table read back at film time t. Lantern i -> { deg: angle of its body from the vertical, az: which way (degrees), tassel: its tassel's angle, cord: swing of its cord }
            function swing(i, t) {
                if (!swF) return null; const x = clamp(t, 0, Film.DUR) * SWHZ, k = Math.min(swW - 2, Math.floor(x)), f = x - k, W4 = swW * 4, rd = (row, c) => lerp(swF[row * W4 + k * 4 + c], swF[row * W4 + k * 4 + 4 + c], f);
                const hx = rd(i, 0), hz = rd(i, 1), tx = rd(i, 2), tz = rd(i, 3), D = 180 / Math.PI, o = { deg: Math.asin(Math.min(1, Math.hypot(hx, hz))) * D, az: Math.atan2(hz, hx) * D, hx, hz, tassel: Math.asin(Math.min(1, Math.hypot(tx, tz))) * D, len: lanterns[i].hk };
                if (i >= swN0) { const row = lanterns.length + i - swN0; o.cord = rd(row, 0) * D; o.wind = Math.hypot(rd(row, 1), rd(row, 2)); } return o;
            }
            function mesh(scene, b, mat, cast, recv) {
                if (!b.n) return null;
                const g = new THREE.BufferGeometry();
                g.setAttribute('position', new THREE.BufferAttribute(b.P.slice(0, b.n * 3), 3)); g.setAttribute('normal', new THREE.BufferAttribute(b.N.slice(0, b.n * 3), 3, true));
                g.setAttribute('uv', new THREE.BufferAttribute(b.U.slice(0, b.n * 2), 2)); g.setAttribute('aC', new THREE.BufferAttribute(b.C.slice(0, b.n * 4), 4, true)); g.setAttribute('aX', new THREE.BufferAttribute(b.X.slice(0, b.n * 4), 4, true));
                g.setIndex(new THREE.BufferAttribute(b.I.slice(0, b.ni), 1)); g.computeBoundingSphere(); g.computeBoundingBox();
                const me = new THREE.Mesh(g, mat); me.castShadow = cast; me.receiveShadow = recv; me.name = mat.customProgramCacheKey ? mat.customProgramCacheKey() : 'arch'; scene.add(me); return me;
            }
            async function build(scene, prog, tick) {
                const L = Rock.L, t0 = performance.now();
                // Warm pools of lantern light at the gate and the two halls. A point light is paid for by every lit pixel of the film (the rock, the
                // loongs: about 0.2 ms each at 3.7 megapixels), so only the gate's is a real light; the halls' pools are worked out here, in the
                // buildings' own shaders (same colour, same falloff, no highlight), where almost all of their light used to land.
                const POOL = [[0, L.gateY + 7.5, L.gateZ + 1.5, 95, 60], [L.leftLedge.x + 2, L.leftLedge.y + 4.5, L.leftLedge.z + 4, 55, 42], [L.rightTer.x - 3, L.rightTer.y + 5, L.rightTer.z + 4, 60, 46]], NREAL = Q.has('pools') ? +Q.get('pools') : 1;
                const poolU = { uPool: { value: new THREE.Vector3() } }, f2 = v => v.toFixed(2);
                const POOL_GL = '\n uniform vec3 uPool; vec3 clPool(vec3 p, vec3 n){ float s = 0.0, l, c; vec3 d;' + POOL.map((q, k) => ` d = vec3(${f2(q[0])}, ${f2(q[1])}, ${f2(q[2])}) - p; l = length(d); c = clamp(1.0 - pow(l / ${f2(q[4])}, 4.0), 0.0, 1.0); s += uPool.${'xyz'[k]} * c * c / max(pow(l, 1.6), 0.01) * max(dot(n, d) / l, 0.0);`).join('') + ' return vec3(1.0, 0.36, 0.12) * s; }';
                const mats = {
                    stone: wire(new THREE.MeshStandardMaterial({ roughness: 0.9 }), 'archStone', GL_STONE, poolU, POOL_GL),
                    roof: wire(new THREE.MeshStandardMaterial({ roughness: 0.3 }), 'archRoof', GL_ROOF, poolU, POOL_GL),
                    tim: wire(new THREE.MeshStandardMaterial({ roughness: 0.5 }), 'archTim', GL_TIM, poolU, POOL_GL),
                    paper: wire(new THREE.MeshStandardMaterial({ roughness: 0.8 }), 'archPaper', GL_PAPER, { uLit: swU.uLit, uPool: poolU.uPool }, '\n uniform float uLit;' + POOL_GL),
                };
                gate({ x: 0, y: L.gateY - 0.4, z: L.gateZ - 3 });
                G.keepOut.push({ x: 0, z: L.gateZ + 8, r: 9, y0: -9, y1: L.gateY + 2 });      // nothing grows in front of the waterfall
                hall({ tag: 'hallL', x: L.leftLedge.x + 0.5, y: L.leftLedge.y - 0.3, z: L.leftLedge.z, w: 9.5, d: 7.5, ch: 4.2, rh: 3.3, bays: 3, double: true, yaw: 0.42 });
                hall({ tag: 'hallR', x: L.rightTer.x - 1, y: L.rightTer.y - 0.3, z: L.rightTer.z - 2, w: 15, d: 8.5, ch: 4.6, rh: 3.6, bays: 5, double: true, yaw: -0.45 });
                hall({ tag: 'pavL', x: -15.5, y: 5.1, z: 29, w: 4.4, d: 4.4, ch: 3.6, rh: 3.0, ov: 1.5, bays: 1, open: true, yaw: 0.5, lift: 1.2 });
                hall({ tag: 'pavR', x: 9.5, y: -1.5, z: 39, w: 5.6, d: 5.6, ch: 4.0, rh: 3.6, ov: 1.8, bays: 1, open: true, yaw: 0.3, ph: 3.2, lift: 1.3, backLanterns: true, water: 0.05 });
                prog(0.5); await tick();
                const A = (x, y, z) => new THREE.Vector3(x, y, z), gy = L.gateY + 12.5;
                string(A(-11.6, gy - 3.4, L.gateZ - 1), A(L.leftLedge.x + 3, L.leftLedge.y + 8, L.leftLedge.z + 2), 2.4, 16);
                string(A(11.6, gy - 3.4, L.gateZ - 1), A(L.rightTer.x - 6, L.rightTer.y + 8.5, L.rightTer.z + 1), 2.8, 18);
                string(A(-15.5, 11.0, 29), A(-25.5, 16, 8), 1.8, 10); string(A(9.5, 6.4, 39), A(24, 22, 18), 2.6, 14);
                const meshes = {};
                meshes.tim = mesh(scene, B.tim, mats.tim, true, true); meshes.stone = mesh(scene, B.stone, mats.stone, true, true); meshes.roof = mesh(scene, B.roof, mats.roof, false, true); meshes.paper = mesh(scene, B.paper, mats.paper, false, true);
                strings.forEach((st, k) => bunting(st, k));
                // the swing table (filled on the first frame, when the dragons and their wake exist), and the materials that read it
                swAlloc();
                if (CB.n) {
                    const cg = new THREE.BufferGeometry(), NS = lanterns.length - swN0, f32 = (a, n) => new THREE.BufferAttribute(new Float32Array(a), n);
                    cg.setAttribute('position', f32(CB.P, 3)); cg.setAttribute('aH', f32(CB.H, 4)); cg.setAttribute('aS', f32(CB.S, 4)); cg.setAttribute('aK', f32(CB.K, 4)); cg.setAttribute('aQ', f32(CB.Q, 4)); cg.setAttribute('color', f32(CB.C, 3)); cg.setAttribute('aU', f32(CB.U, 3));
                    cg.setIndex(CB.I); cg.computeBoundingSphere();
                    const cm = patch(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, alphaToCoverage: true }), sh => {
                        Object.assign(sh.sh.uniforms, swU);
                        Object.assign(sh.sh.uniforms, poolU);
                        sh.vHead('attribute vec4 aH, aS, aK, aQ; attribute vec3 aU; varying vec3 vCu, vCq, vCp; uniform float uTime; vec3 clP, clN;\n' + SW_GLSL + POOL_GL);
                        sh.v('#include <beginnormal_vertex>', GL_CLOTH_V(NS, lanterns.length + NS) + '\n vec3 objectNormal = clN; vCp = 0.5 * (clPool(clP, clN) + clPool(clP, -clN)) + 0.25 * clPool(clP, vec3(0.0, -1.0, 0.0));');
                        sh.v('#include <begin_vertex>', 'vec3 transformed = clP;');
                        sh.fHead('varying vec3 vCu, vCq, vCp;');
                        sh.f('#include <map_fragment>', GL_CLOTH_F);
                        sh.f('#include <emissivemap_fragment>', 'totalEmissiveRadiance += diffuseColor.rgb * (vec3(1.0, 0.60, 0.38) * (0.55 * vCq.x) + 0.31831 * vCp);');      // cloth is lit through from behind as much as from in front
                    }, 'archCloth');
                    const cme = new THREE.Mesh(cg, cm); cme.frustumCulled = false; cme.receiveShadow = true; cme.name = 'archCloth'; scene.add(cme); meshes.cloth = cme; G.info.arch_cloth = CB.I.length / 3;
                }
                const cordMat = patch(new THREE.MeshBasicMaterial({ color: new THREE.Color(0.030, 0.020, 0.016) }), sh => {
                    Object.assign(sh.sh.uniforms, swU); sh.vHead('attribute vec4 aC;\n' + SW_GLSL);
                    sh.v('#include <begin_vertex>', `#include <begin_vertex>\n transformed += swCord(swRow(uv.x + ${(lanterns.length - swN0).toFixed(1)}, 0.0).x, uv.y, aC.xy * 2.0 - 1.0);`);
                }, 'archCord');
                meshes.cord = mesh(scene, B.cord, cordMat, false, false);
                // plaque: Weathered carved sandstone & marble Shahi Darwaza / Jamindar Palace foundation slab
                const plq = Tex.canvas(512, 232, (x, w, h) => {
                    x.fillStyle = '#261d16'; x.fillRect(0, 0, w, h);
                    x.strokeStyle = '#75624c'; x.lineWidth = 6; x.strokeRect(14, 14, w - 28, h - 28);
                    x.strokeStyle = '#48392a'; x.lineWidth = 2; x.strokeRect(24, 24, w - 48, h - 48);
                    x.fillStyle = '#c4ab84'; x.font = '700 78px "Noto Serif Bengali","Hind Siliguri","Kohinoor Bangla",Georgia,serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
                    x.fillText('শাহী মহল', w * 0.50, h * 0.42);
                    x.font = '500 27px "Noto Serif Bengali",Georgia,serif'; x.fillStyle = '#968060';
                    x.fillText('পুরানো জমিদার বাড়ি · সন ১১০৪ হিজরি', w * 0.50, h * 0.77);
                    for (let i = 0; i < 1300; i++) { x.fillStyle = `rgba(${wr() < 0.55 ? '26,32,18' : '92,76,58'},${0.12 + 0.32 * wr()})`; x.fillRect(wr() * w, wr() * h, 1 + wr() * 7, 1 + wr() * 3); }
                });
                const pm = new THREE.Mesh(new THREE.PlaneGeometry(4.5, 2.16), new THREE.MeshStandardMaterial({ map: plq, emissiveMap: plq, emissive: new THREE.Color(0.55, 0.42, 0.24), roughness: 0.45 })); pm.matrixAutoUpdate = false; pm.matrix.copy(PLQ); pm.matrixWorldNeedsUpdate = true; pm.receiveShadow = true; pm.name = 'archPlaque'; scene.add(pm);
                // lantern bodies: one instanced mesh; .color is the paper's glow (FX dims it after the blast)
                // aI = (hook height above the body centre, -, seed, -), aJ = (row of the swing table, depth of its cord below the line through the cord's ends, the level direction the cord swings in)
                const lg = lanternGeo(), lm = new THREE.MeshBasicMaterial({ color: new THREE.Color(3.4, 0.40, 0.085) });
                patch(lm, sh => {
                    Object.assign(sh.sh.uniforms, swU);
                    sh.vHead('attribute vec4 aX; attribute vec4 aI; attribute vec4 aJ; varying vec4 vLq; varying vec3 vLn; varying vec3 vLv;\n' + SW_GLSL);
                    sh.v('#include <begin_vertex>', /* glsl */`float lk = floor(aX.x * 255.0 / 64.0 + 0.5), hk = aI.x, isc = length(instanceMatrix[0].xyz);
        vec3 lp = position; if (lk == 1.0) lp.y = 0.32 + (position.y - 0.32) * (hk - 0.32);
        vec4 sA = swRow(aJ.x, 0.0); vec3 dB = swDir(sA.xy), hook = vec3(0.0, hk, 0.0);
        if (aJ.y > 0.0) hook += swCord(swRow(aJ.x + ${(lanterns.length - swN0).toFixed(1)}, 0.0).x, aJ.y, aJ.zw) / isc;          // the hook rides its cord
        vec3 ln = normal, transformed;
        if (lk == 3.0) {                                           // the tassel: bound to the foot of the body, its threads trail toward where the body was
          vec3 dT = swDir(sA.zw); float dn = max(-0.385 - lp.y, 0.0), q = dn / 0.52;
          vec3 dm = normalize(mix(dB, dT, 0.5 * q)), dl = normalize(mix(dB, dT, q));
          transformed = hook + swTurn(vec3(0.0, -0.385 - hk, 0.0), dB) + swTurn(vec3(lp.x, 0.0, lp.z), dl) * (1.0 + 0.9 * q * length(sA.xy - sA.zw)) + dm * dn; ln = swTurn(normal, dl);
        } else { transformed = hook + swTurn(lp - vec3(0.0, hk, 0.0), dB); ln = swTurn(normal, dB); }
        vLq = vec4(lk, uv.x, position.y, aI.z); vLn = normalize(normalMatrix * ln); vLv = ln;`);
                    sh.fHead('varying vec4 vLq; varying vec3 vLn; varying vec3 vLv; uniform float uTime;');
                    sh.f('#include <map_fragment>', /* glsl */`
        if (vLq.x < 0.5) { float rim = clamp(normalize(vLn).z, 0.0, 1.0), core = pow(rim, 1.5), vert = 1.0 - 0.55 * smoothstep(0.03, 0.26, abs(vLq.z + 0.04));
          float ru = vLq.y * 12.0, rib = 1.0 - 0.40 * smoothstep(0.72, 1.0, abs(fract(ru) - 0.5) * 2.0) * (1.0 - smoothstep(0.25, 0.9, fwidth(ru)));
          float ft = uTime * (5.0 + vLq.w * 4.0) + vLq.w * 40.0, fl = 0.84 + 0.10 * sin(ft) * sin(ft * 0.37 + 1.3) + 0.06 * sin(ft * 2.9 + vLq.w * 7.0);       // a candle behind paper: it never burns evenly
          fl *= 1.0 - 0.22 * smoothstep(0.92, 1.0, sin(uTime * (0.9 + vLq.w) + vLq.w * 90.0));
          diffuseColor.rgb *= (0.16 + 1.25 * core * vert) * rib * fl; diffuseColor.rgb += vec3(0.9, 0.5, 0.12) * pow(core * vert, 6.0) * fl * 0.5 * diffuse.r / 3.4; }
        else { vec3 c = vLq.x < 1.5 ? vec3(0.025, 0.018, 0.014) : vLq.x < 2.5 ? vec3(0.50, 0.30, 0.07) : vec3(0.46, 0.035, 0.022) * (0.62 + 0.38 * sin(vLq.y * 6.2832 * 7.0)) * (0.55 + 0.45 * smoothstep(-0.90, -0.42, vLq.z));
          diffuseColor.rgb = c * (vec3(0.30, 0.20, 0.22) + vec3(3.2, 1.8, 0.95) * max(dot(normalize(vLv), SUN_DIR), 0.0)); }`);
                }, 'lantern');
                const im = new THREE.InstancedMesh(lg, lm, lanterns.length), dm = new THREE.Object3D(), ai = new Float32Array(lanterns.length * 4), aj = new Float32Array(lanterns.length * 4);
                lanterns.forEach((l, i) => { dm.position.copy(l.p); dm.scale.setScalar(l.s); dm.updateMatrix(); im.setMatrixAt(i, dm.matrix); ai[i * 4] = l.hk / l.s; ai[i * 4 + 1] = l.w; ai[i * 4 + 2] = wr(); aj[i * 4] = i; if (l.bare) { aj[i * 4 + 1] = l.depth; aj[i * 4 + 2] = l.nx; aj[i * 4 + 3] = l.nz; } });
                lg.setAttribute('aI', new THREE.InstancedBufferAttribute(ai, 4)); lg.setAttribute('aJ', new THREE.InstancedBufferAttribute(aj, 4)); im.frustumCulled = false; im.name = 'archLanterns'; scene.add(im);
                G.lanterns = lanterns; G.info.lanterns = lanterns.length;
                // warm pools of light where lanterns cluster (the same three lights as before: none added)
                const pools = POOL.map(([x, y, z, I, D], k) => { if (k >= NREAL) return null; const pl = new THREE.PointLight(new THREE.Color(1.0, 0.36, 0.12), I, D, 1.6); pl.position.set(x, y, z); scene.add(pl); return pl; });
                // every frame (pure in t): where the film is in the swing table; the lamps come up as the daylight goes (the same rise the effects give the
                // lanterns from Film.T.OUT); the three pools of lantern light flicker, each on its own, and gutter when the blast front passes
                const FT = Film.T;
                G.tick.push(t => {
                    if (!swBaked) swBake(); swU.uSw.value.x = (clamp(t, 0, Film.DUR) * SWHZ + 0.5) / swW;
                    const up = t > FT.OUT ? 1 + 1.6 * sm(FT.OUT, FT.OUT + 1.4, t) * (1 - sm(Film.DUR - 0.3, Film.DUR - 0.02, t)) : 1, db = t - FT.BLAST, gut = db > 0 && db < 4 ? 1 - 0.55 * Math.exp(-db / 1.1) * sm(0, 0.1, db) : 1;
                    swU.uLit.value = up * (0.5 + 0.5 * gut);
                    for (let i = 0; i < 3; i++) { const k = i * 3.4, I = POOL[i][3] * up * gut * (0.92 + 0.07 * Math.sin(t * 6.3 + k) * Math.sin(t * 2.3 + k * 2) + 0.05 * Math.sin(t * 11.7 + k * 3) + 0.04 * Math.sin(t * 17.9 + k)); if (pools[i]) pools[i].intensity = I; poolU.uPool.value.setComponent(i, pools[i] ? 0 : I * 1.25); }
                });      // (a worked-out pool has no highlight: a quarter more of its soft light stands in for it)
                const r2 = v => [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)], bo = {}; for (const k in BOX) bo[k] = { lmin: r2(BOX[k].l.min), lmax: r2(BOX[k].l.max), wmin: r2(BOX[k].w.min), wmax: r2(BOX[k].w.max) };
                let tris = 0; for (const k in B) { tris += B[k].ni / 3; G.info['arch_' + k] = Math.round(B[k].ni / 3); }
                G.info.archBoxes = bo; G.info.archTris = Math.round(tris); G.info.archMs = Math.round(performance.now() - t0);
                prog(1);
            }
            // the lip the waterfall leaves (world): front edge x0..x1, top y, z; back = z of the tunnel's back wall
            const sluice = { x0: -2.3, x1: 2.3, y: 18.40, z: -8.88, back: -15.0 };
            return { build, lanterns, burners, sluice, swing, strings, swU, swP, swBake };
        })();


if (typeof window !== 'undefined') {
    window.Arch = Arch;
}

export const createPalaceArch = () => Arch;
export { Arch };
export default Arch;
