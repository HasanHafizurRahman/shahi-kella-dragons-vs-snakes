import * as THREE from 'three';
import { clamp, lerp, sm, TAU, rad, rng, keyed, keyedLin, pulse, G } from './util.js';
import { DragonLook } from './dlook.js';
import { Rock } from './rock.js';
import { Film } from './film.js';

// ===== 60_dragon.js =====
        // ===== 60_dragon.js =====

        // ---- how the loongs MOVE: a long body gliding along a rail, with acting layered on top ---------------
        // Looks (palettes, shaders, head, mane, whiskers, legs) live in 58_dlook.js. This file is a factory plus the choreography.
        //   Dragon.make(cfg) -> instance { name, st, plan(), spine(t), update(t), build(), headAt(t, pos), railAt(t, pos), spineAt(a, pos, tan),
        //                                  frameAt(a, pos, tan, nor, bin), pathAt(s, pos), sOf(t), look, meshes, LEN, RMAX }
        //   Dragon.red, Dragon.white, Dragon.list = [red, white], Dragon.st === Dragon.red.st, Dragon.build(scene, fx, prog, tick), Dragon.plan()
        //   st = { head, fwd, up, mouth, neck (Vector3, world), roar, charge, jaw, breath, glow (0..1), speed (m/s), s (m), vis (0..1) }
        //   instance.seatAt(s) -> 0..1: how firmly the rail lies on rock at arclength s (red's coil on the spire; 0 everywhere for white)
        // A loong's motion is four layers, every one a pure function of film time t (so any frame can be drawn in any order):
        //   1 rail      timed waypoints -> one smooth curve; the head runs along it, the body is the last LEN metres of the head's path
        //   2 swim      a travelling wave tied to the distance flown (it slips backward past the air), and a bank into every turn
        //   3 impulses  scripted shoves (rear, lunge, recoil, duck, blast): a direction, a time curve, a reach down the body and a
        //               whip speed, so a blow to the head travels down the neck. headAt(t) = rail + impulses: what the opponent sees
        //   4 aim       the neck bends and the head turns toward its gaze target (st.neck of the opponent is the bite target)
        // and, where the rail's script marks a stretch of rail (zones FIXED ON THE RAIL, so every ring that slides through obeys them):
        //   seat   the body lies on rock: each ring is pressed onto the stone until its own belly touches, the swim wave is still, the legs
        //          are spread on the rock, the head and neck are lifted off it by cfg.lift / cfg.liftUp, a breath swells it (cfg.swell)
        //   quiet  no swim wave (the dive through the channel, the furrow in the lake);  tuck  legs flat back along the belly;
        //   up     the body's "up" is cfg.upZone instead of the usual reference (the S out of the lake leans back past vertical)
        // An opponent is only ever read through its headAt / railAt (pure), never through its st.
        const Dragon = (() => {
            const NR = 30, RC = new Float64Array(NR + 1), RS = new Float64Array(NR + 1), RW = new Float64Array(NR + 1);       // ring: cos, sin, radial squash
            for (let j = 0; j <= NR; j++) { const phi = j / NR * TAU, s = Math.sin(phi); RC[j] = Math.cos(phi); RS[j] = s; RW[j] = s > 0 ? 0.97 + 0.10 * Math.pow(s, 6) : 0.84; }
            // monotone cubic through keys (no stop-and-go between beats)
            function mono(xs, ys) {
                const n = xs.length, d = [], m = new Array(n);
                for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
                m[0] = d[0]; m[n - 1] = d[n - 2];
                for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : 2 * d[i - 1] * d[i] / (d[i - 1] + d[i]);
                return x => {
                    if (x <= xs[0]) return ys[0]; if (x >= xs[n - 1]) return ys[n - 1]; let i = 0; while (x > xs[i + 1]) i++;
                    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
                    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
                };
            }
            // the body's "up": belly toward the main spire while wrapped round it, world up elsewhere. In a steep climb or dive (tan = the
            // spine tangent) it leans toward the lens (+Z), so the frame never flips where the body passes through vertical.
            function upRef(p, out, tan) {
                const A = Rock.L.main, dx = p.x - A.x, dz = p.z - A.z, d = Math.hypot(dx, dz) || 1, w = (1 - sm(21, 31, d)) * (1 - sm(90, 101, p.y)) * sm(26, 38, p.y); out.set(dx / d * w, 1 - w * 0.72, dz / d * w);
                const k = sm(0.80, 0.97, Math.abs(tan.y)); if (k > 0) { out.multiplyScalar(1 - k); out.z += k; } return out.normalize();
            }
            // Frames down the body: each ring's normal is the "up" reference made square to the spine, but it may roll at most MAXROLL away
            // from the ring in front of it. Where the reference is steady this changes nothing; where it flips (a spine passing through
            // vertical) the body barrel-rolls over about 20 m instead of twisting 180 degrees between two rings.
            const MAXROLL = rad(5), rX = new THREE.Vector3();
            function rollLimit(i, T, N, prev, max = MAXROLL) {  // N: reference normal in (square to T), limited normal out; prev: this chain's memory
                if (i > 0) {
                    prev.addScaledVector(T, -prev.dot(T)).normalize();                              // carry the previous normal onto this ring
                    rX.crossVectors(prev, N); const ang = Math.atan2(rX.dot(T), prev.dot(N));
                    if (Math.abs(ang) > max) { const a = ang > 0 ? max : -max; rX.crossVectors(T, prev); N.copy(prev).multiplyScalar(Math.cos(a)).addScaledVector(rX, Math.sin(a)).normalize(); }
                }
                prev.copy(N);
            }
            // scratch (never held across calls)
            const v0 = new THREE.Vector3(), v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3(), v4 = new THREE.Vector3(), vT = new THREE.Vector3(), vN = new THREE.Vector3(), vB = new THREE.Vector3(), vU = new THREE.Vector3(), vK = new THREE.Vector3();
            const pN1 = new THREE.Vector3(), pN2 = new THREE.Vector3(), gT = new THREE.Vector3(), gD = new THREE.Vector3(), gS = new THREE.Vector3();
            const mm = new THREE.Matrix4(), mq = new THREE.Quaternion(), ms = new THREE.Vector3(), mp = new THREE.Vector3(), X = new THREE.Vector3(), Yv = new THREE.Vector3(), Zv = new THREE.Vector3(), qe = new THREE.Quaternion(), eu = new THREE.Euler();
            const AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0), AZ = new THREE.Vector3(0, 0, 1);
            const vL0 = new THREE.Vector3(), pN3 = new THREE.Vector3(), MAXTW = rad(6), GT = 9;      // GT: metres over which a body thins to nothing at the rift mouth
            const rProf0 = keyedLin([[0, 0.64], [5, 0.68], [15, 1.0], [38, 1.0], [100, 0.88], [138, 0.56], [160, 0.24], [169, 0.07], [172, 0.02]]);   // radius profile of a 172 m body
            const WAVE = 39, SLIP = 0.16, IDLE = 5.5;            // swim: wavelength (m); the wave slips back past the air at SLIP x speed + IDLE m/s
            const MOUTH0 = new THREE.Vector3(0, -0.42 * 2.75, 1.9 * 2.75);

            // ---- the rock under the red loong ---------------------------------------------------------------------------------------
            // Rock.build has run before Dragon.build (90_main.js), so the real rock mesh is in the scene when the rails are planned. The
            // vertices of the main spire go into a hash. drop() moves a ball along a line until it touches rock (the coil is laid on the
            // spire with it), near() finds the nearest rock vertex (the direction a seated ring presses in). Whatever the rock builder
            // carves, the coil lies on it; without a rock mesh the coil falls back to the spire's nominal cone.
            const Seat = (() => {
                const CS = 2, cells = new Map(), key = (i, j, k) => ((i + 256) * 512 + (j + 64)) * 512 + (k + 256), fl = Math.floor, hit = new THREE.Vector3();
                let P = null, ok = false;
                function init(scene) {
                    if (ok) return true; if (!scene || typeof Rock === 'undefined' || !Rock.mat) return false;
                    let rock = null; scene.traverse(o => { if (o.isMesh && o.material === Rock.mat) rock = o; }); if (!rock) return false;
                    const A = rock.geometry.attributes.position.array, S = Rock.L.main, pts = [];
                    for (let i = 0; i < A.length; i += 3) { const y = A[i + 1]; if (y < 38 || y > 120) continue; const dx = A[i] - S.x, dz = A[i + 2] - S.z; if (dx * dx + dz * dz < 256) pts.push(A[i], y, A[i + 2]); }
                    P = new Float32Array(pts);
                    for (let i = 0; i < P.length; i += 3) { const k = key(fl(P[i] / CS), fl(P[i + 1] / CS), fl(P[i + 2] / CS)), l = cells.get(k); if (l) l.push(i); else cells.set(k, [i]); }
                    return ok = P.length > 9000;
                }
                // distance from (x, y, z) to the nearest rock vertex within rmax (1e9: none); the vertex is left in Seat.hit
                function near(x, y, z, rmax) {
                    if (!ok) return 1e9; let best = rmax * rmax, bi = -1;
                    for (let i = fl((x - rmax) / CS), i1 = fl((x + rmax) / CS); i <= i1; i++) for (let j = fl((y - rmax) / CS), j1 = fl((y + rmax) / CS); j <= j1; j++) for (let k = fl((z - rmax) / CS), k1 = fl((z + rmax) / CS); k <= k1; k++) {
                        const l = cells.get(key(i, j, k)); if (!l) continue;
                        for (let q = 0; q < l.length; q++) { const o = l[q], dx = P[o] - x, dy = P[o + 1] - y, dz = P[o + 2] - z, dd = dx * dx + dy * dy + dz * dz; if (dd < best) { best = dd; bi = o; } }
                    }
                    if (bi < 0) return 1e9; hit.set(P[bi], P[bi + 1], P[bi + 2]); return Math.sqrt(best);
                }
                // a ball of radius rb leaves c0 along the unit vector u: how far it gets (at most lmax) before it touches rock
                function drop(c0, u, lmax, rb) {
                    if (!ok) return lmax; let best = lmax; const r2 = rb * rb, ex = c0.x + u.x * lmax, ey = c0.y + u.y * lmax, ez = c0.z + u.z * lmax;
                    for (let i = fl((Math.min(c0.x, ex) - rb) / CS), i1 = fl((Math.max(c0.x, ex) + rb) / CS); i <= i1; i++) for (let j = fl((Math.min(c0.y, ey) - rb) / CS), j1 = fl((Math.max(c0.y, ey) + rb) / CS); j <= j1; j++) for (let k = fl((Math.min(c0.z, ez) - rb) / CS), k1 = fl((Math.max(c0.z, ez) + rb) / CS); k <= k1; k++) {
                        const l = cells.get(key(i, j, k)); if (!l) continue;
                        for (let q = 0; q < l.length; q++) {
                            const o = l[q], dx = P[o] - c0.x, dy = P[o + 1] - c0.y, dz = P[o + 2] - c0.z, al = dx * u.x + dy * u.y + dz * u.z; if (al < 0 || al > best + rb) continue;
                            const pp = dx * dx + dy * dy + dz * dz - al * al; if (pp >= r2) continue; const lam = al - Math.sqrt(r2 - pp); if (lam < best) best = lam;
                        }
                    }
                    return Math.max(best, 0);
                }
                return { init, near, drop, hit, get ok() { return ok; } };
            })();
            let sceneRef = null;                                 // the scene Dragon.build was given (the rock mesh is found in it)

            function make(cfg) {
                const LEN = cfg.LEN, RMAX = cfg.RMAX, NS = cfg.NS || 300, kA = 172 / LEN, K = RMAX / 3.6, PH = cfg.phase || 0;      // kA: body arclength -> profile; K: size relative to red
                const st = {
                    head: new THREE.Vector3(), fwd: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0), mouth: new THREE.Vector3(), neck: new THREE.Vector3(),
                    roar: 0, charge: 0, jaw: 0, breath: 0, glow: 0, speed: 0, s: 0, vis: 1, aim: 0, lid: 0, reach: 0, hood: 0.85
                };     // lid: 0..1 eyes shut (asleep); reach: 0..1 claws thrown forward     // aim: 0..1, the head tipped back so the open mouth (not the brow) faces the gaze target
                const rProf = a => rProf0(a * kA);
                let pts = null, railN = null, railK = null, railW = null, railQ = null, railS = null, railT = null, railU = null, sPhase = 0, ds = 0, sTot = 0, sOfK = null, look = null, HS = 2.75 * K, headG, body, bodyGeo, mane, shown = true;
                const maneList = [], legs = [], meshes = [], imps = [], live = [], branchNecks = [];
                st.extraMouths = [];
                const hQ = new THREE.Quaternion(), hP = new THREE.Vector3();
                // the rift swallows whatever part of the body is on the rail before sIn or beyond sOut (arclengths, set by Dragon.plan): 0 there, 1 a few metres inside
                const gateOf = a => { const s = st.s - a; return sm(inst.sIn, inst.sIn + GT, s) * (1 - sm(inst.sOut - GT, inst.sOut, s)); };
                const C = new Float32Array((NS + 1) * 3), Tt = new Float32Array((NS + 1) * 3), Nn = new Float32Array((NS + 1) * 3), Bb = new Float32Array((NS + 1) * 3);
                const aOf = i => LEN * i / NS;

                // ---------- rail: control points -> points every 0.25 m; time keys -> arclength of the head ----------
                function plan() {
                    if (pts) return;
                    const cps = [], mark = {}, keys = [], zones = [];
                    const add = (x, y, z, name) => { cps.push(new THREE.Vector3(x, y, z)); if (name) mark[name] = cps.length - 1; };
                    const key = (t, name, frac = 0) => keys.push([t, name, frac]);                 // the head is at control point `name` (+ frac of a step) at time t
                    const at = (t, x, y, z) => { const n = 'w' + cps.length; add(x, y, z, n); key(t, n); };   // a timed waypoint
                    const P = (x, y, z, t) => { if (t == null) add(x, y, z); else at(t, x, y, z); };          // a waypoint, timed only when t is given: the speed between timed points settles itself
                    // waypoints on a helix about a vertical axis (degrees: 0 = +X, 90 = +Z toward the lens; the start point is NOT emitted)
                    // tw > 1 spends less time on the early (wide) part of a tightening spiral, so the speed stays even. every: time only every n-th point
                    const helix = (t0, t1, cx, cz, a0, a1, r0, r1, y0, y1, step = 40, tw = 1, every = 1) => {
                        const n = Math.max(1, Math.round(Math.abs(a1 - a0) / step)); for (let i = 1; i <= n; i++) {
                            const u = i / n, a = rad(lerp(a0, a1, u)), r = lerp(r0, r1, u);
                            P(cx + r * Math.cos(a), lerp(y0, y1, u), cz + r * Math.sin(a), (i % every === 0 || i === n) ? lerp(t0, t1, 1 - Math.pow(1 - u, tw)) : null);
                        }
                    };
                    const zone = (kind, from, to, edge) => zones.push([kind, from, to, edge]);            // a stretch of rail between two marks ([name, + steps]): 'seat' or 'quiet'
                    cfg.rail({ add, key, at, P, helix, zone });
                    keys.sort((p, q) => p[0] - q[0]);
                    const curve = new THREE.CatmullRomCurve3(cps, false, 'centripetal'), DIV = 12000; curve.arcLengthDivisions = DIV;
                    const lens = curve.getLengths(DIV); sTot = lens[DIV];
                    const n = Math.ceil(sTot / 0.25); pts = curve.getSpacedPoints(n); ds = sTot / n;
                    const cpS = k => { const f = k / (cps.length - 1) * DIV, i = Math.min(DIV - 1, Math.floor(f)); return lerp(lens[i], lens[i + 1], f - i); };
                    const Kk = keys.map(k => { if (!(k[1] in mark)) throw new Error('dragon ' + cfg.name + ': no rail mark ' + k[1]); return [k[0], cpS(mark[k[1]] + (k[2] || 0))]; });
                    // The body's roll is a field FIXED ON THE RAIL: the "up" reference made square to the rail, carried forward from the rail's
                    // start and allowed to roll at most MAXROLL per ring-length. A ring's roll then depends only on where it is on the rail, so it
                    // can never flip from one frame to the next; where the reference turns over (a rail passing through vertical) the body
                    // barrel-rolls over about 20 m as it slides through.
                    // Zones FIXED ON THE RAIL, set by the rail's own script. 'seat': the body lies on rock here (railW 0..1, railS = the unit
                    // direction from the rail to the nearest rock, smoothed over three metres so it never flicks from block to block; the seat
                    // lets go by itself wherever the rail is more than a body's radius and a half from rock). 'quiet': the body does not swim.
                    if (zones.length) {
                        railW = new Float32Array(n + 2); railQ = new Float32Array(n + 2); railS = new Float32Array((n + 2) * 3); railT = new Float32Array(n + 2); railU = new Float32Array(n + 2);
                        for (const [kind, from, to, edge] of zones) {
                            const sA = cpS(mark[from[0]] + (from[1] || 0)), sB = cpS(mark[to[0]] + (to[1] || 0)), e = edge || 8, a = kind === 'quiet' ? railQ : kind === 'tuck' ? railT : kind === 'up' ? railU : railW;
                            for (let j = Math.max(0, Math.floor((sA - e) / ds)); j <= Math.min(n, Math.ceil((sB + e) / ds)); j++) a[j] = Math.max(a[j], sm(sA - e, sA, j * ds) * (1 - sm(sB, sB + e, j * ds)));
                        }
                        let px = 0, py = -1, pz = 0, nSeat = 0, gSum = 0;
                        for (let j = 0; j <= n; j++) {
                            if (railW[j] <= 0) continue; const p = pts[j], d = Seat.near(p.x, p.y, p.z, 7.5);
                            if (d < 7.5) { px = (Seat.hit.x - p.x) / d; py = (Seat.hit.y - p.y) / d; pz = (Seat.hit.z - p.z) / d; }
                            railW[j] *= 1 - sm(cfg.seatD + 0.9, cfg.seatD + 3.2, d); railS[j * 3] = px; railS[j * 3 + 1] = py; railS[j * 3 + 2] = pz; if (railW[j] > 0.5) { nSeat++; gSum += d; }
                        }
                        {
                            const W = Math.round(1.5 / ds), tmp = new Float32Array(railS.length);
                            for (let j = 0; j <= n; j++) { if (railW[j] <= 0) continue; let x = 0, y = 0, z = 0; for (let k = Math.max(0, j - W); k <= Math.min(n, j + W); k++) { x += railS[k * 3]; y += railS[k * 3 + 1]; z += railS[k * 3 + 2]; } const l = Math.hypot(x, y, z) || 1; tmp[j * 3] = x / l; tmp[j * 3 + 1] = y / l; tmp[j * 3 + 2] = z / l; }
                            railS.set(tmp);
                        }
                        for (let j = 0; j <= n; j++) railQ[j] = Math.max(railQ[j], railW[j]);
                        G.info[cfg.name + 'Seat'] = { rock: Seat.ok, m: Math.round(nSeat * ds), dist: nSeat ? +(gSum / nSeat).toFixed(2) : 0 };
                    }
                    railN = new Float32Array((n + 1) * 3); {
                        const step = MAXROLL * ds / (LEN / NS);
                        for (let j = 0; j <= n; j++) {
                            vT.subVectors(pts[Math.max(0, j - 2)], pts[Math.min(n, j + 2)]).normalize(); upRef(pts[j], vU, vT);
                            if (railU && railU[j] > 0) vU.lerp(cfg.upZone, railU[j]).normalize();                 // a stretch with its own up (the S out of the lake)
                            if (railW && railW[j] > 0) { const w = railW[j]; vU.multiplyScalar(1 - w); vU.x -= railS[j * 3] * w; vU.y += (0.3 - railS[j * 3 + 1]) * w; vU.z -= railS[j * 3 + 2] * w; vU.normalize(); }      // seated: belly to the rock, the back a little up
                            vN.copy(vU).addScaledVector(vT, -vU.dot(vT));
                            if (vN.lengthSq() < 1e-6) vN.copy(pN1); vN.normalize(); rollLimit(j, vT, vN, pN1, step); railN[j * 3] = vN.x; railN[j * 3 + 1] = vN.y; railN[j * 3 + 2] = vN.z;
                        }
                    }
                    // The bank into a turn is a field on the rail too: the curvature vector over 24 m of rail (toward the inside of the turn),
                    // let go in a curl tighter than about 15 m (the knot, the recoil curls, the coils: there it would fight the rail's own up),
                    // and smoothed over 16 m, so a ring sliding along the rail never meets an edge and never spins
                    railK = new Float32Array((n + 1) * 3); {
                        const m12 = Math.round(12 / ds), W = Math.round(8 / ds), acc = new Float64Array((n + 2) * 3);
                        for (let j = 0; j <= n; j++) {
                            const a = pts[Math.min(n, j + m12)], b = pts[Math.max(0, j - m12)], c = pts[j], kx = (a.x + b.x - 2 * c.x) / 144, ky = (a.y + b.y - 2 * c.y) / 144, kz = (a.z + b.z - 2 * c.z) / 144, w = 1 - sm(0.045, 0.075, Math.hypot(kx, ky, kz));
                            acc[j * 3 + 3] = acc[j * 3] + kx * w; acc[j * 3 + 4] = acc[j * 3 + 1] + ky * w; acc[j * 3 + 5] = acc[j * 3 + 2] + kz * w;
                        }
                        for (let j = 0; j <= n; j++) { const j0 = Math.max(0, j - W), j1 = Math.min(n, j + W) + 1, q = 1 / (j1 - j0); for (let c = 0; c < 3; c++) railK[j * 3 + c] = (acc[j1 * 3 + c] - acc[j0 * 3 + c]) * q; }
                    }
                    inst.keys = Kk; sOfK = mono(Kk.map(k => k[0]), Kk.map(k => k[1]));
                    if (cfg.sRef) sPhase = cfg.sRef[1] - sOfK(cfg.sRef[0]);                          // the swim wave is tied to the distance flown: a rail re-laid before this moment leaves every later stroke where it was
                    G.info[cfg.name + 'Path'] = Math.round(sTot); G.info[cfg.name + 'S0'] = Math.round(Kk[0][1]);
                }
                // scripted impulses (called once, after BOTH rails exist): the head and neck are shoved along dir by fn(t) metres; the shove
                // reaches `reach` metres down the body and travels tail-ward at `whip` m/s (0 = the whole reach moves at once)
                const imp = (t0, t1, dir, fn0, reach = 26, whip = 0) => { const fn = t => fn0(t) * (1 - sm(t1 - 0.3, t1, t)), m = { t0, t1, d: dir.clone(), fn, reach, whip, tEnd: t1 + (whip > 0 ? Math.min(LEN, reach * 2.2) / whip : 0) }; imps.push(m); return m; };
                function script() { imps.length = 0; if (cfg.acts) cfg.acts(imp, inst); inst.ready = true; }
                const sOf = t => sOfK(t);
                function pathAt(s, out) { const f = clamp(s, 0, sTot - 0.001) / ds, i = Math.floor(f); return out.lerpVectors(pts[i], pts[i + 1], f - i); }
                function railAt(t, out) { return pathAt(sOfK(t), out); }
                // where the head is at film time t (pure): the rail plus the scripted impulses
                // A seated ring is pressed onto the rock so that ITS OWN belly touches (the rail is laid for the thickest ring; a breath swells
                // it outward, never into the rock), and lifted off it where the head and neck are raised (cfg.lift metres at the head, fading
                // over 24 m of neck; cfg.liftUp metres of plain height on top). j, u: the ring's place on the rail; w: the seat's weight there.
                function seatOff(a, j, u, w, t, out) {
                    const k = j * 3, q = a / 24, e = q < 3 ? Math.exp(-q * q) : 0, r = RMAX * rProf(a) * (cfg.swell ? cfg.swell(t, a) : 1);
                    const d = (cfg.seatD - r * cfg.seatK - (e > 0 ? cfg.lift(t) * e : 0)) * w;
                    out.x += lerp(railS[k], railS[k + 3], u) * d; out.y += lerp(railS[k + 1], railS[k + 4], u) * d + (e > 0 ? cfg.liftUp(t) * e * w : 0); out.z += lerp(railS[k + 2], railS[k + 5], u) * d;
                }
                function headAt(t, out) {
                    const s0 = sOfK(t); pathAt(s0, out);
                    if (railW) { const f = clamp(s0, 0, sTot - 0.001) / ds, j = Math.floor(f), w = lerp(railW[j], railW[j + 1], f - j); if (w > 0.001) seatOff(0, j, f - j, w, t, out); }
                    for (let k = 0; k < imps.length; k++) { const m = imps[k]; if (t > m.t0 && t < m.t1) out.addScaledVector(m.d, m.fn(t)); } return out;
                }
                function frameAt(a, c, T, N, Bv) {
                    const f = clamp(a / LEN, 0, 1) * NS, i = Math.min(NS - 1, Math.floor(f)), u = f - i, k = i * 3, k2 = k + 3;
                    c.set(lerp(C[k], C[k2], u), lerp(C[k + 1], C[k2 + 1], u), lerp(C[k + 2], C[k2 + 2], u)); T.set(lerp(Tt[k], Tt[k2], u), lerp(Tt[k + 1], Tt[k2 + 1], u), lerp(Tt[k + 2], Tt[k2 + 2], u)).normalize();
                    N.set(lerp(Nn[k], Nn[k2], u), lerp(Nn[k + 1], Nn[k2 + 1], u), lerp(Nn[k + 2], Nn[k2 + 2], u)).normalize(); Bv.crossVectors(T, N).normalize();
                }
                // world position and tail-ward tangent of the spine a metres behind the head, THIS frame
                const sN = new THREE.Vector3(), sB = new THREE.Vector3(), sP = new THREE.Vector3(), sT = new THREE.Vector3();
                function spineAt(a, outPos, outTan) { frameAt(a, outPos || sP, outTan || sT, sN, sB); return outPos; }

                // ---------- the spine and the head pose at film time t (no meshes touched: also runs headless) ----------
                function spine(t) {
                    cfg.pose(t, st);                                                               // beat pulses: roar, charge, breath, jaw, glow, vis
                    const sh = sOfK(t), spd = (sOfK(t + 0.03) - sOfK(t - 0.03)) / 0.06, v2g = Math.min(spd * spd, 3600) / 9.8; st.s = sh; st.speed = spd;
                    live.length = 0; for (let k = 0; k < imps.length; k++) { const m = imps[k]; if (t > m.t0 && t < m.tEnd) live.push(m); }
                    const isCobra = !!cfg.isCobra;
                    const calm = cfg.calm ? cfg.calm(t) : 1, wLen = isCobra ? 21 : (cfg.noLegs ? 25 : WAVE), wAmp = lerp(1.25, 0.85, sm(14, 60, spd)) * calm * (isCobra ? 1.80 : cfg.noLegs ? 1.55 : 1.0), wK = TAU / wLen, wPh = -(1 + SLIP) * (sh + sPhase) * wK - (isCobra ? 9.2 : cfg.noLegs ? 8.5 : IDLE) * t * wK + PH;
                    const tailOn = cfg.tailOn ? cfg.tailOn(t) : 0;
                    const stir = cfg.stir ? cfg.stir(t) : 0, sK = TAU / 23, sPh = -15 * t * sK + PH * 1.7;                // tense: a shorter wave runs down the body
                    // King Cobra signature behavior: upright S-neck arch (standing anterior 1/3 of body) + hypnotic lateral hood-weaving sway (ফণা তুলে দুলতে থাকা)
                    const cobraStance = isCobra ? calm * (0.45 + 0.55 * Math.max(st.hood || 0.8, st.roar, st.charge)) * (1 - sm(38, 65, spd)) : 0;
                    // spine centres: rail, bank into the turn, travelling wave (none at the head), impulses
                    for (let i = 0; i <= NS; i++) {
                        const a = aOf(i), s = sh - a; pathAt(s, v0); pathAt(s + 0.6, v1); pathAt(s - 0.6, v2); vT.subVectors(v2, v1).normalize();    // tail-ward tangent
                        // the swim wave runs on world-level axes, not on the roll frame: side to side (level, square to the spine) and a smaller
                        // heave square to both. It fades out where the spine is near vertical, where "side" has no meaning.
                        let wS = 0, qz = 0, sj = 0, su = 0; if (railW) { const f = clamp(s, 0, sTot - 0.001) / ds; sj = Math.floor(f); su = f - sj; wS = lerp(railW[sj], railW[sj + 1], su); qz = lerp(railQ[sj], railQ[sj + 1], su); }
                        const hl = Math.hypot(vT.x, vT.z), lv = sm(0.24, 0.52, hl) * (1 - qz), env = sm(isCobra ? 15 : 7, 34, a) * (0.85 + 0.9 * sm(60, LEN, a)) * lv, ph = a * wK + wPh;
                        if (lv > 0) {
                            const sx = vT.z / hl, sz = -vT.x / hl, hx = -vT.y * vT.x / hl, hz = -vT.y * vT.z / hl;           // side = (sx, 0, sz); heave = (hx, hl, hz)
                            let ws = env * wAmp * Math.sin(ph), wh = env * (isCobra ? 0.04 : cfg.noLegs ? 0.14 : 0.55) * calm * Math.sin(ph * 0.63 + 1.3);
                            if (stir > 0.01) { const e2 = stir * lv * sm(5, 22, a) * (1 - 0.5 * sm(LEN * 0.5, LEN, a)); ws += e2 * 0.95 * Math.sin(a * sK + sPh); wh += e2 * (isCobra ? 0.10 : 0.5) * Math.cos(a * sK * 0.8 + sPh * 0.9); }
                            v0.x += sx * ws + hx * wh; v0.y += hl * wh; v0.z += sz * ws + hz * wh;
                        }
                        if (cobraStance > 0.01 && a < 34) {
                            // King Cobra upright S-neck arch + hypnotic lateral cobra weave on the raised anterior neck (a = 0..34m)
                            const uN = a / 34, archEnv = Math.sin(Math.PI * Math.pow(uN, 0.72)) * (1 - 0.3 * uN);
                            const swayEnv = (1 - sm(8, 32, a));
                            const sx = hl > 0.1 ? vT.z / hl : 0, sz = hl > 0.1 ? -vT.x / hl : 1;
                            const weave = (1.45 + 0.65 * st.roar) * K * Math.sin(t * 2.75 + PH - a * 0.07) * swayEnv * cobraStance;
                            const sCurveBack = 2.4 * K * Math.sin(uN * Math.PI * 1.30) * cobraStance;
                            const rearLift = (3.5 + 2.0 * Math.max(st.roar, st.charge)) * K * archEnv * cobraStance;
                            v0.x += sx * weave + vT.x * sCurveBack;
                            v0.y += rearLift;
                            v0.z += sz * weave + vT.z * sCurveBack;
                        }
                        if (wS > 0.001) seatOff(a, sj, su, wS, t, v0);
                        if (tailOn > 0 && a > LEN - 34) cfg.tail(t, a, tailOn, v0);
                        for (let k = 0; k < live.length; k++) { const m = live[k], tt = m.whip > 0 ? t - a / m.whip : t; if (tt > m.t0 && tt < m.t1) { const q = a / m.reach; v0.addScaledVector(m.d, m.fn(tt) * Math.exp(-q * q)); } }
                        C[i * 3] = v0.x; C[i * 3 + 1] = v0.y; C[i * 3 + 2] = v0.z;
                    }
                    // aim: the neck swings out and the front of the spine turns toward the gaze target (the head point itself stays put)
                    // the gaze target is averaged over a quarter of a second (no twitch when the opponent whips past), let go when it is within a
                    // few metres (a direction to something that close swings wildly) and when it is behind the head
                    let lookW = 0; gT.set(0, 0, 0); for (let k = -2; k <= 2; k++) { const w = (3 - Math.abs(k)) / 9 * cfg.gaze(t + k * 0.07, st, gS); lookW += w; gT.addScaledVector(gS, w); }
                    v0.set(C[0], C[1], C[2]); if (lookW > 1e-5) { gT.multiplyScalar(1 / lookW); lookW *= sm(3.5, 10, gT.distanceTo(v0)); }
                    if (lookW > 0.001) {
                        Zv.set(C[0] - C[9], C[1] - C[10], C[2] - C[11]).normalize(); gD.subVectors(gT, v0).normalize();
                        const dt = Zv.dot(gD); v1.copy(gD).addScaledVector(Zv, -dt); const pl = v1.length();
                        if (pl > 0.02) {
                            const ang = Math.atan2(pl, dt), amp = lookW * 3.5 * K * Math.min(ang, 1.5) / 1.2 * (1 - sm(2.6, 3.05, ang)), A0 = 8.5 * K; v1.multiplyScalar(-amp / pl);
                            for (let i = 1; i <= NS; i++) { const q = aOf(i) / A0; if (q > 7) break; const w = q * Math.exp(1 - q); C[i * 3] += v1.x * w; C[i * 3 + 1] += v1.y * w; C[i * 3 + 2] += v1.z * w; }
                        }
                    }
                    const lw = cfg.lensRoll ? cfg.lensRoll(t) : 0; if (lw > 0) Film.camAt(t, vL0);
                    for (let i = 0; i <= NS; i++) {
                        const i0 = Math.max(0, i - 1), i1 = Math.min(NS, i + 1); vT.set(C[i1 * 3] - C[i0 * 3], C[i1 * 3 + 1] - C[i0 * 3 + 1], C[i1 * 3 + 2] - C[i0 * 3 + 2]).normalize();
                        // roll: the rail's own field at this ring's place on the rail, banked into the turn (more with speed and curvature, levelling
                        // off near 40 degrees), made square to the spine as it is now
                        const s = sh - aOf(i), f = clamp(s, 0, sTot - 0.001) / ds, j = Math.floor(f), u = f - j, k3 = j * 3;
                        vU.set(lerp(railN[k3], railN[k3 + 3], u), lerp(railN[k3 + 1], railN[k3 + 4], u), lerp(railN[k3 + 2], railN[k3 + 5], u));
                        vK.set(lerp(railK[k3], railK[k3 + 3], u), lerp(railK[k3 + 1], railK[k3 + 4], u), lerp(railK[k3 + 2], railK[k3 + 5], u));       // the bank field (1/m), toward the inside of the turn
                        vU.addScaledVector(vK, v2g * 0.42 / (1 + v2g * vK.length() * 0.5));
                        vN.copy(vU).addScaledVector(vT, -vU.dot(vT)); if (vN.lengthSq() < 1e-8) vN.set(vT.z, 0, -vT.x); vN.normalize();
                        // clinging to rock, the body is belly to the stone, but the head and the first metres of neck are carried upright
                        if (railW && i < NS * 0.2) { const q = aOf(i) / 12, w = lerp(railW[j], railW[j + 1], u) * Math.exp(-q * q); if (w > 0.01) { v4.set(0, 1, 0).addScaledVector(vT, -vT.y); if (v4.lengthSq() > 0.02) { vN.lerp(v4.normalize(), w).normalize(); vN.addScaledVector(vT, -vN.dot(vT)).normalize(); } } }
                        vB.crossVectors(vT, vN);
                        // lens-side roll: where the lens would see the belly, the body rolls about its own spine toward the lens until the lens sees
                        // flank and dorsal crest (back . lens = 0.3). Nothing happens where the lens is square below the spine or looks along it (no side
                        // to roll to); the head and neck roll less; the twist is limited to MAXTW per ring. Pure: the lens is Film.camAt(t).
                        if (lw > 0) {
                            const k3 = i * 3, lx = vL0.x - C[k3], ly = vL0.y - C[k3 + 1], lz = vL0.z - C[k3 + 2], il = 1 / (Math.hypot(lx, ly, lz) || 1);
                            const a = (lx * vN.x + ly * vN.y + lz * vN.z) * il, b = (lx * vB.x + ly * vB.y + lz * vB.z) * il, R = Math.hypot(a, b), ab = Math.abs(b);
                            if (R > 0.12 && ab > 0.06) {
                                let ph = Math.asin(Math.min(0.30, 0.9 * R) / R) - Math.atan2(a, ab);
                                if (ph > 0) { ph = Math.min(ph, 1.5) * lw * sm(0.06, 0.30, ab) * sm(0.12, 0.35, R) * (0.3 + 0.7 * sm(3, 24, aOf(i))); vN.multiplyScalar(Math.cos(ph)).addScaledVector(vB, Math.sin(ph) * (b > 0 ? 1 : -1)).normalize(); }
                            }
                            rollLimit(i, vT, vN, pN3, MAXTW); vB.crossVectors(vT, vN);
                        }
                        Tt[i * 3] = vT.x; Tt[i * 3 + 1] = vT.y; Tt[i * 3 + 2] = vT.z; Nn[i * 3] = vN.x; Nn[i * 3 + 1] = vN.y; Nn[i * 3 + 2] = vN.z; Bb[i * 3] = vB.x; Bb[i * 3 + 1] = vB.y; Bb[i * 3 + 2] = vB.z;
                    }
                    // head: rides the front of the spine. For King Cobras (isCobra), keep the skull tightly aligned with the front of the cervical hood
                    // (at most 20 degrees extra turn at the occiput) and keep the occiput welded to C[0] so the single head & neck hood form one seamless anatomy!
                    frameAt(0, v0, vT, vN, vB); Zv.copy(vT).negate();
                    if (lookW > 0.001) {
                        gD.subVectors(gT, v0).normalize(); const d0 = Zv.dot(gD); v1.copy(gD).addScaledVector(Zv, -d0); const pl = v1.length();
                        const maxTurn = isCobra ? 0.34 : 1.08;
                        if (pl > 1e-4) { const ang = Math.atan2(pl, d0), turn = Math.min(maxTurn, ang * lookW) * (1 - sm(2.6, 3.05, ang)); Zv.multiplyScalar(Math.cos(turn)).addScaledVector(v1, Math.sin(turn) / pl).normalize(); }
                    }
                    Yv.copy(vN).addScaledVector(Zv, -vN.dot(Zv)).normalize(); X.crossVectors(Yv, Zv);
                    mm.makeBasis(X, Yv, Zv); hQ.setFromRotationMatrix(mm);
                    const shake = st.roar * (Math.sin(t * 47) * 0.012 + Math.sin(t * 31 + 1) * 0.010);
                    const pitchOff = isCobra ? (-0.08 * st.charge + 0.02 * Math.sin(t * 0.8 + PH) + shake * 0.5) : (-0.26 * st.charge * (1 - st.roar) * (1 - st.aim) - 0.50 * st.aim + 0.02 * Math.sin(t * 0.8 + PH) + shake);
                    hQ.multiply(qe.setFromAxisAngle(AX, pitchOff));
                    hQ.multiply(qe.setFromAxisAngle(AZ, 0.05 * Math.sin(t * 0.55 + PH) + shake * 2.0)); hQ.multiply(qe.setFromAxisAngle(AY, 0.04 * Math.sin(t * 0.41 + 1 + PH)));
                    hP.copy(v0).addScaledVector(Zv, isCobra ? (0.85 * HS) : (1.0 * HS + 1.2 * K * st.roar - 1.0 * K * st.charge * (1 - st.roar)));
                    st.head.copy(hP); st.fwd.set(0, 0, 1).applyQuaternion(hQ); st.up.set(0, 1, 0).applyQuaternion(hQ);
                    st.mouth.copy(MOUTH0).multiplyScalar(HS / 2.75).applyQuaternion(hQ).add(hP);
                    frameAt(14 * K, st.neck, vT, vN, vB);
                }

                // helper to skin each branching neck tube from the spine bifurcation point to an individual serpent head
                const bC = new THREE.Vector3(), bM = new THREE.Vector3(), bP = new THREE.Vector3(), bT = new THREE.Vector3(), bN = new THREE.Vector3(), bB = new THREE.Vector3();
                function skinBranch(bn, forkP, forkT, forkN, forkB, headPos, side, t, hg) {
                    bn.mesh.visible = st.vis > 0.001 && hg > 0.02;
                    if (!bn.mesh.visible) return;
                    const NB = bn.NB, NRB = bn.NRB, P = bn.geo.attributes.position.array, Nr = bn.geo.attributes.normal.array, AT = bn.geo.attributes.aT.array;
                    // Middle control point arches outward and upward like a muscular cobra/hydra neck
                    bM.lerpVectors(forkP, headPos, 0.52).addScaledVector(forkB, side * 3.4 * K + 0.5 * Math.sin(t * 3.9 + side)).addScaledVector(forkN, 1.8 * K + 0.4 * Math.cos(t * 3.2 + side));
                    let o = 0;
                    for (let i = 0; i <= NB; i++) {
                        const u = i / NB, u1 = 1 - u;
                        bP.set(
                            u1 * u1 * forkP.x + 2 * u1 * u * bM.x + u * u * headPos.x,
                            u1 * u1 * forkP.y + 2 * u1 * u * bM.y + u * u * headPos.y,
                            u1 * u1 * forkP.z + 2 * u1 * u * bM.z + u * u * headPos.z
                        );
                        bT.set(
                            2 * u1 * (forkP.x - bM.x) + 2 * u * (bM.x - headPos.x),
                            2 * u1 * (forkP.y - bM.y) + 2 * u * (bM.y - headPos.y),
                            2 * u1 * (forkP.z - bM.z) + 2 * u * (bM.z - headPos.z)
                        ).normalize();
                        bN.copy(forkN).addScaledVector(bT, -forkN.dot(bT));
                        if (bN.lengthSq() < 1e-6) bN.set(0, 1, 0); bN.normalize();
                        bB.crossVectors(bT, bN).normalize();
                        // Sleek muscular cylindrical serpent neck tapering smoothly to the head base
                        const hood = 1 + 0.14 * sm(0.65, 0.92, u) * (1 - sm(0.94, 1.0, u));
                        const r = RMAX * lerp(0.76, 0.58, u) * hg;
                        for (let j = 0; j <= NRB; j++) {
                            const phi = j / NRB * TAU, cs = Math.cos(phi), sn = Math.sin(phi), wy = sn > 0 ? 0.95 : 0.82;
                            const nx = cs * bB.x * hood + sn * bN.x * wy, ny = cs * bB.y * hood + sn * bN.y * wy, nz = cs * bB.z * hood + sn * bN.z * wy;
                            P[o] = bP.x + nx * r; P[o + 1] = bP.y + ny * r; P[o + 2] = bP.z + nz * r;
                            const l = 1 / (Math.hypot(nx, ny, nz) || 1);
                            Nr[o] = nx * l; Nr[o + 1] = ny * l; Nr[o + 2] = nz * l;
                            AT[o] = bT.x; AT[o + 1] = bT.y; AT[o + 2] = bT.z; o += 3;
                        }
                    }
                    bn.geo.attributes.position.needsUpdate = true; bn.geo.attributes.normal.needsUpdate = true; bn.geo.attributes.aT.needsUpdate = true;
                }

                // ---------- per-frame: pose, then skin the meshes ----------
                function update(t) {
                    spine(t);
                    const show = st.vis > 0.001;
                    if (show !== shown) { shown = show; for (const m of meshes) m.visible = show; }
                    if (!show) return;
                    const P = bodyGeo.attributes.position.array, Nr = bodyGeo.attributes.normal.array, AT = bodyGeo.attributes.aT.array; let o = 0;
                    const breath = 1 + 0.018 * Math.sin(t * 1.3 + PH) + 0.05 * st.charge;
                    const gated = st.s - LEN < inst.sIn + GT || st.s + 12 > inst.sOut - GT;          // part of the body is still (or already) inside the rift
                    const swl = cfg.swell && cfg.swellOn(t) > 0, isCobra = !!cfg.isCobra;
                    const hoodOpen = isCobra ? clamp((st.hood ?? 0.85) + 0.22 * Math.max(st.roar, st.charge) + 0.04 * Math.sin(t * 4.2 + PH), 0.48, 1.12) : 0;
                    for (let i = 0; i <= NS; i++) {
                        const a = aOf(i), an = a * kA, r = RMAX * rProf(a) * (an > 8 && an < 60 ? breath : 1) * (swl ? cfg.swell(t, a) : 1) * (gated ? gateOf(a) : 1), k = i * 3;
                        const bx = Bb[k], by = Bb[k + 1], bz = Bb[k + 2], ux = Nn[k], uy = Nn[k + 1], uz = Nn[k + 2], tx = Tt[k], ty = Tt[k + 1], tz = Tt[k + 2];
                        // For King Cobras (isCobra): anatomically accurate oblong-oval Ophiophagus hannah cervical hood (ফণা) from a = 0.0m to 24.5m behind the skull!
                        // At a = 0 (occiput), hLat = 1.0 and hVert = 0.88 so the neck tube welds 100% seamlessly into the back of the single King Cobra head;
                        // then elongated cervical ribs flare laterally up to 2.55x neck width around a = 6m..12m while flattening dorsoventrally.
                        let hLat = 1.0, hVert = 1.0, hEnv = 0;
                        if (isCobra && a < 25.0) {
                            const uH = clamp(a / 24.5, 0, 1);
                            hEnv = Math.sin(Math.PI * Math.pow(uH, 0.62)) * (1 - 0.20 * uH) * sm(0.2, 2.6, a) * (1 - sm(18.5, 24.5, a));
                            const ribFlute = 1 + 0.032 * hEnv * Math.sin(a * 3.1);
                            hLat = (1 + 1.58 * hoodOpen * hEnv) * ribFlute;
                            hVert = lerp(0.86, 1.0, sm(0, 2.5, a)) * (1 - 0.56 * Math.min(1, hoodOpen) * hEnv);
                        }
                        for (let j = 0; j <= NR; j++) {
                            const c = RC[j], s = RS[j];
                            let wx = hLat, wy = RW[j] * hVert, yOff = 0;
                            if (hEnv > 0.001) {
                                // Central cylindrical vertebral column ridge along the dorsal back (s > 0) and flat/slightly concave ventral throat scutes (s < 0)
                                const spineRidge = s > 0 ? 0.32 * hEnv * Math.exp(-c * c * 7.0) * s : 0;
                                const throatDish = s < 0 ? 0.14 * hEnv * (1 - c * c) * (-s) : 0;
                                wy += spineRidge;
                                yOff = throatDish;
                            }
                            const cx = c * wx, sy = s * wy + yOff;
                            const nx = cx * bx + sy * ux, ny = cx * by + sy * uy, nz = cx * bz + sy * uz;
                            P[o] = C[k] + nx * r; P[o + 1] = C[k + 1] + ny * r; P[o + 2] = C[k + 2] + nz * r;
                            const mx = (c / wx) * bx + (s / Math.max(0.24, wy)) * ux, my = (c / wx) * by + (s / Math.max(0.24, wy)) * uy, mz = (c / wx) * bz + (s / Math.max(0.24, wy)) * uz, l = 1 / Math.sqrt(mx * mx + my * my + mz * mz);
                            Nr[o] = mx * l; Nr[o + 1] = my * l; Nr[o + 2] = mz * l;
                            AT[o] = tx; AT[o + 1] = ty; AT[o + 2] = tz; o += 3;
                        }
                    }
                    bodyGeo.attributes.position.needsUpdate = true; bodyGeo.attributes.normal.needsUpdate = true; bodyGeo.attributes.aT.needsUpdate = true;
                    const hg = gated ? sm(inst.sIn - 3, inst.sIn + 5, st.s) * (1 - sm(inst.sOut - 7, inst.sOut + 1, st.s)) : 1, hs = hg > 0.02;
                    {
                        headG.visible = hs; for (const w of look.head.world) w.visible = hs;
                        const kh0 = (look.HS / DragonLook.HS0) * (cfg.heads === 2 ? 0.94 : cfg.heads === 3 ? 0.92 : 1.0);
                        headG.scale.setScalar(Math.max(hg * kh0, 0.02));
                    }
                    if (cfg.heads === 2) {
                        // 2-headed serpent: primary head forks to the left (-B), secondary head forks to the right (+B)
                        frameAt(0, v0, vT, vN, vB);
                        const sw0 = 0.65 * Math.sin(t * 3.8 + PH), lift0 = 0.45 * Math.cos(t * 3.1 + PH);
                        mp.copy(hP).addScaledVector(vB, -3.2 * K + sw0).addScaledVector(vN, 0.8 * K + lift0);
                        mq.copy(hQ).multiply(qe.setFromEuler(eu.set(0.08 * Math.sin(t * 4.2), -0.24 + 0.10 * Math.sin(t * 3.5), 0.12)));
                        headG.quaternion.copy(mq); headG.position.copy(mp); headG.updateMatrixWorld(true);
                    } else {
                        headG.quaternion.copy(hQ); headG.position.copy(hP); headG.updateMatrixWorld(true);
                    }
                    st.mouth.copy(look.head.mouthLocal).applyMatrix4(headG.matrixWorld);
                    // Update extra heads and branching necks for multi-headed serpents (2-headed and 3-headed)
                    if (look.head.extraHeads && look.head.extraHeads.length) {
                        frameAt(18 * K, v1, vT, vN, vB); // bifurcation base on the spine
                        const bFork = v1.clone(), nFork = vN.clone(), biFork = vB.clone(), tFork = vT.clone();
                        // If 2-headed, also skin neck branch 0 for the primary left head
                        if (cfg.heads === 2 && branchNecks[0]) {
                            skinBranch(branchNecks[0], bFork, tFork, nFork, biFork, headG.position, -1, t, hg);
                        }
                        for (let k = 0; k < look.head.extraHeads.length; k++) {
                            const eh = look.head.extraHeads[k], eg = eh.group, side = cfg.heads === 2 ? 1 : (k === 0 ? -1 : 1);
                            const ph = (k + 1) * 2.3 + PH, sw = (0.85 + 0.3 * st.roar) * Math.sin(t * 4.1 + ph), heave = (0.75 + 0.3 * st.roar) * Math.cos(t * 3.4 + ph);
                            const strike = 2.6 * K * Math.max(0, Math.sin(t * 5.2 + ph * 1.4)) * (0.4 + 0.6 * Math.max(st.roar, st.charge, st.breath));
                            eg.visible = hs;
                            const kh = (look.HS / DragonLook.HS0) * (cfg.heads === 3 ? 0.88 : 0.94);
                            eg.scale.setScalar(Math.max(hg * kh, 0.02));
                            frameAt(0, v0, vT, vN, vB);
                            const spread = cfg.heads === 3 ? 4.8 * K : 3.2 * K;
                            mp.copy(hP).addScaledVector(vB, side * spread + sw).addScaledVector(vN, (cfg.heads === 3 ? -0.4 * K : 0.8 * K) + heave).addScaledVector(st.fwd, strike - (cfg.heads === 3 ? 1.2 * K : 0));
                            mq.copy(hQ).multiply(qe.setFromEuler(eu.set(0.14 * Math.sin(t * 4.6 + ph) - 0.18 * st.roar, side * (cfg.heads === 3 ? 0.34 : 0.24) + 0.12 * Math.cos(t * 3.7 + ph), -side * 0.18)));
                            eg.position.copy(mp); eg.quaternion.copy(mq); eg.updateMatrixWorld(true);
                            if (!st.extraMouths[k]) st.extraMouths[k] = new THREE.Vector3();
                            st.extraMouths[k].copy(look.head.mouthLocal).applyMatrix4(eg.matrixWorld);
                            const bnIdx = cfg.heads === 2 ? k + 1 : k;
                            if (branchNecks[bnIdx]) skinBranch(branchNecks[bnIdx], bFork, tFork, nFork, biFork, mp, side, t, hg);
                        }
                    }
                    look.head.update(st, t);                                                       // jaw, eyes, throat, whiskers
                    // dorsal mane instances (hidden on legless real snakes)
                    if (cfg.noLegs) { mane.visible = false; } else for (let i = 0; i < maneList.length; i++) {
                        const m = maneList[i]; frameAt(m.a, v0, vT, vN, vB); const r = RMAX * rProf(m.a) * (swl ? cfg.swell(t, m.a) : 1), c = Math.cos(m.phi), s = Math.sin(m.phi);
                        v1.set(0, 0, 0).addScaledVector(vB, c).addScaledVector(vN, s);                    // outward at this angle
                        mp.copy(v0).addScaledVector(v1, r * 0.93);
                        Yv.copy(v1).addScaledVector(vT, m.lean).normalize(); Zv.copy(vT).addScaledVector(Yv, -vT.dot(Yv)).normalize(); X.crossVectors(Yv, Zv);
                        mm.makeBasis(X, Yv, Zv); mq.setFromRotationMatrix(mm); ms.set(m.w * (0.5 + r * 0.22), m.len * (0.35 + 0.65 * Math.min(1, r / 1.2)), m.w * (0.5 + r * 0.22));
                        if (gated) ms.multiplyScalar(gateOf(m.a));
                        mm.compose(mp, mq, ms); mane.setMatrixAt(i, mm);
                    }
                    mane.instanceMatrix.needsUpdate = true;
                    // legs
                    const tuck = sm(13, 30, Math.abs(st.speed));
                    for (const L of legs) {
                        frameAt(L.a, v0, vT, vN, vB); const r = RMAX * rProf(L.a), phi = L.side > 0 ? -0.62 : Math.PI + 0.62;
                        mp.copy(v0).addScaledVector(vB, Math.cos(phi) * r * 0.80).addScaledVector(vN, Math.sin(phi) * r * 0.70);
                        X.copy(vB); Yv.copy(vN); Zv.copy(vT).negate(); mm.makeBasis(X, Yv, Zv); mq.setFromRotationMatrix(mm);
                        // legs: they paddle in a hover, sweep back along the belly in fast flight (tuck), and are thrown forward with the claws spread
                        // in a rear-up, a roar or a bite (reach: the forelegs far forward, the hind legs braced)
                        let lj = 0, lu = 0; if (railW) { const f = clamp(st.s - L.a, 0, sTot - 0.001) / ds; lj = Math.floor(f); lu = f - lj; }
                        const zt = railT ? lerp(railT[lj], railT[lj + 1], lu) : 0;                       // in a stretch marked 'tuck' the legs are folded right back against the belly, claws up, whatever the speed: through water, over roofs and crowns
                        const pad = 0.30 * Math.sin(t * 1.25 + L.ph), fore = L.a < LEN * 0.3, rc = st.reach, tk = Math.max(tuck * (1 - 0.8 * rc), zt);
                        let sw = lerp(pad + 0.25, 1.26 + 0.10 * pad, tk) - rc * (fore ? 1.15 : 0.35) * (1 - tk), spl = lerp(0.25 + 0.12 * Math.sin(t * 0.9 + L.ph), 0.07, tk) + 0.32 * rc;
                        if (zt > 0) { sw = lerp(sw, 1.85, zt); spl = lerp(spl, 0.35, zt); }                 // (drawn in under the belly: the channel between the lake pavilions is no wider than the body)
                        if (railW) {
                            const g = lerp(railW[lj], railW[lj + 1], lu);      // on rock the legs are spread flat against it, claws on the stone
                            if (g > 0.01) { sw = lerp(sw, (fore ? -0.5 : 0.35) + 0.06 * Math.sin(t * 0.7 + L.ph), g); spl = lerp(spl, cfg.grip || 1.15, g); }
                        }
                        mq.multiply(qe.setFromEuler(eu.set(sw, 0, -L.side * spl)));
                        const lg = K * (gated ? gateOf(L.a) : 1); ms.set(lg, lg, lg); L.me.matrix.compose(mp, mq, ms); L.me.matrixWorldNeedsUpdate = true;
                    }
                }

                // ---------- build: look, body tube, head, legs, mane (the rail is planned before, by Dragon.plan) ----------
                async function build(scene, prog, tick) {
                    plan(); prog(0.05); await tick();
                    look = DragonLook.make(typeof cfg.pal === 'string' ? DragonLook.PAL[cfg.pal] : cfg.pal); HS = look.HS; inst.look = look;
                    // body tube: uv = (metres behind the head, j / NR)
                    const nv = (NS + 1) * (NR + 1), uv = new Float32Array(nv * 2), col = new Float32Array(nv * 3), aK = new Float32Array(nv), idx = [], c = [0, 0, 0]; let o = 0;
                    for (let i = 0; i <= NS; i++) for (let j = 0; j <= NR; j++, o++) {
                        const phi = j / NR * TAU, a = aOf(i);
                        uv[o * 2] = a; uv[o * 2 + 1] = j / NR; aK[o] = look.bodyColor(a, phi, LEN, c);
                        col[o * 3] = c[0]; col[o * 3 + 1] = c[1]; col[o * 3 + 2] = c[2];
                        if (i < NS && j < NR) { const p0 = i * (NR + 1) + j, p1 = p0 + NR + 1; idx.push(p0, p1, p0 + 1, p0 + 1, p1, p1 + 1); }
                    }
                    bodyGeo = new THREE.BufferGeometry();
                    for (const [n, sz] of [['position', 3], ['normal', 3], ['aT', 3]]) { const at = new THREE.BufferAttribute(new Float32Array(nv * sz), sz); at.setUsage(THREE.DynamicDrawUsage); bodyGeo.setAttribute(n, at); }
                    bodyGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); bodyGeo.setAttribute('color', new THREE.BufferAttribute(col, 3)); bodyGeo.setAttribute('aK', new THREE.BufferAttribute(aK, 1)); bodyGeo.setIndex(idx);
                    body = new THREE.Mesh(bodyGeo, look.bodyMat); body.frustumCulled = false; body.castShadow = true; body.receiveShadow = true; scene.add(body); meshes.push(body);
                    prog(0.15); await tick();
                    headG = look.head.group; scene.add(headG); meshes.push(headG);
                    if (look.head.extraHeads && look.head.extraHeads.length) {
                        for (const eh of look.head.extraHeads) { scene.add(eh.group); meshes.push(eh.group); }
                        const nBranches = cfg.heads === 2 ? 2 : look.head.extraHeads.length;
                        for (let b = 0; b < nBranches; b++) {
                            const NB = 24, NRB = 18, bnv = (NB + 1) * (NRB + 1), buv = new Float32Array(bnv * 2), bcol = new Float32Array(bnv * 3), baK = new Float32Array(bnv), bidx = [], bc = [0, 0, 0];
                            let bo = 0;
                            for (let i = 0; i <= NB; i++) for (let j = 0; j <= NRB; j++, bo++) {
                                const phi = j / NRB * TAU, a = (1 - i / NB) * 18 * K;
                                buv[bo * 2] = a; buv[bo * 2 + 1] = j / NRB; baK[bo] = look.bodyColor(a, phi, LEN, bc);
                                bcol[bo * 3] = bc[0]; bcol[bo * 3 + 1] = bc[1]; bcol[bo * 3 + 2] = bc[2];
                                if (i < NB && j < NRB) { const p0 = i * (NRB + 1) + j, p1 = p0 + NRB + 1; bidx.push(p0, p1, p0 + 1, p0 + 1, p1, p1 + 1); }
                            }
                            const bGeo = new THREE.BufferGeometry();
                            for (const [n, sz] of [['position', 3], ['normal', 3], ['aT', 3]]) { const at = new THREE.BufferAttribute(new Float32Array(bnv * sz), sz); at.setUsage(THREE.DynamicDrawUsage); bGeo.setAttribute(n, at); }
                            bGeo.setAttribute('uv', new THREE.BufferAttribute(buv, 2)); bGeo.setAttribute('color', new THREE.BufferAttribute(bcol, 3)); bGeo.setAttribute('aK', new THREE.BufferAttribute(baK, 1)); bGeo.setIndex(bidx);
                            const bMesh = new THREE.Mesh(bGeo, look.bodyMat); bMesh.frustumCulled = false; bMesh.castShadow = true; bMesh.receiveShadow = true;
                            scene.add(bMesh); meshes.push(bMesh); branchNecks.push({ geo: bGeo, mesh: bMesh, NB, NRB });
                        }
                    }
                    prog(0.7); await tick();
                    if (!cfg.noLegs) {
                        for (const [a, side] of [[23 / kA, 1], [23 / kA, -1], [86 / kA, 1], [86 / kA, -1]]) { const me = new THREE.Mesh(side > 0 ? look.leg.right : look.leg.left, look.leg.mat); me.castShadow = true; me.frustumCulled = false; me.matrixAutoUpdate = false; legs.push({ a, side, me, ph: a * 0.3 + side }); scene.add(me); meshes.push(me); }
                    }
                    prog(0.85); await tick();
                    // dorsal crest + tail plume (follow the spine each frame), belly-line wisps near the legs (none for real snakes)
                    const r = rng(cfg.seed);
                    if (cfg.noLegs) {
                        maneList.push({ a: 5, phi: Math.PI / 2, len: 0.001, w: 0.001, lean: 0.5, ph: 0 });
                    } else {
                        for (let a = 3.5; a < LEN - 1.5; a += 0.52) { const tail = sm(LEN - 26, LEN - 3, a); const n = tail > 0.3 ? 3 : 2; for (let k = 0; k < n; k++) maneList.push({ a: a + r() * 0.4, phi: Math.PI / 2 + (r() - 0.5) * (0.42 + tail * 2.6), len: (lerp(4.6, 2.5, sm(3, 40, a)) + tail * 4.5) * (0.7 + r() * 0.6), w: 1.0 + r() * 0.8, lean: 0.55 + r() * 0.5 + tail * 0.6, ph: r() }); }
                        for (const a0 of [23 / kA, 86 / kA]) for (let k = 0; k < 16; k++) maneList.push({ a: a0 + (r() - 0.3) * 5, phi: (r() < 0.5 ? -0.5 : Math.PI + 0.5) + (r() - 0.5) * 0.5, len: 1.6 + r() * 1.6, w: 0.8, lean: 1.2, ph: r() });
                        for (const m of maneList) { m.len *= K; m.w *= K; }
                    }
                    const g = look.mane.geo, ph = new Float32Array(maneList.length); maneList.forEach((m, i) => ph[i] = m.ph);
                    g.setAttribute('aPh', new THREE.InstancedBufferAttribute(ph, 1));
                    mane = new THREE.InstancedMesh(g, look.mane.mat, maneList.length); mane.frustumCulled = false; mane.castShadow = !cfg.noLegs; mane.visible = !cfg.noLegs; scene.add(mane); if (!cfg.noLegs) meshes.push(mane);
                    for (const w of look.head.world) { scene.add(w); meshes.push(w); }
                    prog(1);
                }
                const seatAt = s => { if (!railW) return 0; const f = clamp(s, 0, sTot - 0.001) / ds, j = Math.floor(f); return lerp(railW[j], railW[j + 1], f - j); };      // 0..1: how firmly the rail lies on rock at arclength s
                const inst = { name: cfg.name, cfg, st, seatAt, look: null, ready: false, LEN, RMAX, K, NS, C, N: Nn, meshes, plan, script, spine, build, update, spineAt, frameAt, headAt, railAt, pathAt, sOf, rProf, gateOf, sIn: -1e9, sOut: 1e9, tGone: 1e9, get sTot() { return sTot; }, get ds() { return ds; } };
                return inst;
            }

            // =====================================================================================================================
            // THE CHOREOGRAPHY. +X is screen right, +Z is toward the lens, the valley runs away along -Z. Helix angles are degrees
            // about a vertical axis: 0 = +X, 90 = +Z. Every beat time is Film.T; every meeting point is Film.A.
            //   0-17    red lies coiled ON the main spire (the coil is laid on the real rock at load: belly on the stone, claws spread on
            //           it, the head against the lens side of the shaft, the tail hanging free to the right). It breathes, creeps, lifts its
            //           head and looks about; EMERGE: it slides on round and up; DRUMS: it rears on the flat summit
            //   17-19.5 it leaps off the summit's west edge, 2 to 3.5 m over the maple that crowns the left spire, dives down the left side
            //           of the valley, skims the left hall and its two maples, and drops off the terrace into the lake
            //   19.5-22 THROUGH THE WATER: down the channel between the lake pavilions straight at the lens, belly a metre and a half under
            //           the surface, the whole body following down the same furrow; it rears out of the lake in an S and holds, face to
            //           the lens (the close-up), its body still pouring up out of the water behind and below it
            //   22-23   it whips left round the lens side, 2 m over the great maple on the left bank, onto the coil over the lake pavilion
            //   23-30   CHARGE and ROAR at the open sky on the right; OMEN: the head snaps round to the rift
            //   30-36   DESCENT: white pours out of the rift SIDE-ON (it turns square to the sight line at once), then spirals down round
            //           the middle of the valley, a turn and a third: down the right side, low over the lens, down the left side, across
            //           the far side above the gate and in front of the main spire, round to the right end of the face-off line. Red rears
            //           up out of its coil to meet it, climbs away over the gate, hairpins and dives back down the left side to its end
            //   36-42   FACEOFF: both stalk toward the lens down the two sides of a ring, heads turned in; WROAR (red is driven back and
            //           down under the frost breath, then snarls back); they turn in, draw back and lunge: CLASH1 is a head-on collision
            //           in profile, red from the left, white from the right
            //   42-46.5 they recoil and split round the main spire, red round the west side, white round the east, crossing
            //           behind the summit (white above red)
            //   46.5-51 FIRE2: red, out first on the right, slows and pours fire across the valley, across white's path; white rolls up
            //           and away, dives at the lens and loops over the right bank; red slips west UNDER white's line and comes back at it
            //           level and low. BOLT: white spits back over its shoulder at red; red ducks; the bolt crosses the open sky over its
            //           antlers and bursts on a bare face of the left cliff (Film.A.boltHit)
            //   51-57   CLASH2: they turn into each other above the gate and lock, each mouth on the other's neck; the knot is a
            //           double helix that winds tight, then falls faster and faster, out over the lake pavilions and down into the open
            //           pool in front of the lens
            //   57-63   SPLASH: both go under and burst out apart in the open channel; red sweeps up the left side over the left hall,
            //           white up the right, each winds a rising coil behind its place and leaves it straight at the other
            //   63-69   BEAM across the valley (heads in profile, coils behind them, tails out of the lake), BLAST throws both back
            //   69-86   FINALE: opposite each other across the pearl, they wind round its line as it drifts up in front of the spire,
            //           then round the main spire and into the cloud at the rift
            // =====================================================================================================================
            const env = (t, a, b, up = 0.3, dn = 0.4) => sm(a, a + up, t) * (1 - sm(b - dn, b, t));       // 0..1 between a and b
            // weighted gaze target: gz(out) starts, pull(out, w, p) pulls the head toward p with weight w, gzEnd(out) returns the total weight (0..1)
            let gzW = 0;
            const gz = out => { gzW = 0; out.set(0, 0, 0); }, pull = (out, w, p) => { if (w > 0) { out.addScaledVector(p, w); gzW += w; } }, gzEnd = out => { if (gzW > 0) out.multiplyScalar(1 / gzW); return Math.min(1, gzW); };
            const foe = new THREE.Vector3(), prl = new THREE.Vector3(), tA = new THREE.Vector3(), tB = new THREE.Vector3(), tC = new THREE.Vector3(), tD = new THREE.Vector3();
            const V = (x, y, z) => new THREE.Vector3(x, y, z);
            // unit heading of a loong's rail at time t
            const heading = (d, t, out) => { d.railAt(t + 0.04, out).sub(d.railAt(t - 0.04, tD)); return out.lengthSq() > 1e-10 ? out.normalize() : out.set(0, 0, 1); };
            const kick = (t0, att, rel, amp) => t => amp * pulse(t, t0, att, rel);
            const RING = { x: 5, z: -6, r: 25.5 };                // the face-off ring
            const KNOT0 = 50.75;                                 // the two heads pass each other at the top of the knot here; a quarter turn later, on CLASH2, red comes down on white's neck from above, its face to the lens

            const red = make({ name: 'red', pal: 'red', LEN: 172, RMAX: 3.6, seed: 808, seatD: 2.72, seatK: 0.767, grip: 1.15, upZone: new THREE.Vector3(0, 0.6, -1).normalize(), sRef: [23.75, 646.141494488118], swell: (t, a) => Choreo.swell(t, a), swellOn: t => Choreo.swellOn(t), lift: t => Choreo.lift(t), liftUp: t => Choreo.liftUp(t), tailOn: t => Choreo.tailOn(t), tail: (t, a, w, out) => Choreo.tail(t, a, w, out), rail: a => Choreo.red(a), acts: (imp, d) => Choreo.redActs(imp, d), stir: t => Choreo.stir(t, 0), calm: t => Choreo.calm(t), pose: (t, st) => Choreo.redPose(t, st), gaze: (t, st, out) => Choreo.redGaze(t, st, out), lensRoll: t => Choreo.lensRoll(t) });
            const snake2 = make({ name: 'snake2', pal: 'snake2', heads: 1, isCobra: true, noLegs: true, LEN: 145, RMAX: 3.0, NS: 240, seed: 3141, phase: 1.4, rail: a => Choreo.snake2(a), acts: (imp, d) => Choreo.snake2Acts(imp, d), stir: t => Choreo.stir(t, 1), calm: t => Choreo.calm(t), pose: (t, st) => Choreo.snake2Pose(t, st), gaze: (t, st, out) => Choreo.snake2Gaze(t, st, out), lensRoll: t => Choreo.lensRoll(t) });
            const snake3 = make({ name: 'snake3', pal: 'snake3', heads: 1, isCobra: true, noLegs: true, LEN: 165, RMAX: 3.45, NS: 280, seed: 2718, phase: 3.8, rail: a => Choreo.snake3(a), acts: (imp, d) => Choreo.snake3Acts(imp, d), stir: t => Choreo.stir(t, 1), calm: t => Choreo.calm(t), pose: (t, st) => Choreo.snake3Pose(t, st), gaze: (t, st, out) => Choreo.snake3Gaze(t, st, out), lensRoll: t => Choreo.lensRoll(t) });
            const white = make({ name: 'white', pal: 'white', LEN: 150, RMAX: 3.1, NS: 264, seed: 4242, phase: 2.1, rail: a => Choreo.white(a), acts: (imp, d) => Choreo.whiteActs(imp, d), stir: t => Choreo.stir(t, 1), calm: t => Choreo.calm(t), pose: (t, st) => Choreo.whitePose(t, st), gaze: (t, st, out) => Choreo.whiteGaze(t, st, out), lensRoll: t => Choreo.lensRoll(t) });

            const Choreo = {
                // ---- the coil on the spire, and what lives in it while the loong sleeps ----
                SEAT_D: 2.72,                                 // metres from the rail to the rock under a seated coil: the thickest ring's belly sits 0.3 m into the block field
                CH: { x: -3.8, y: 1.6, z0: 23.4, z1: 33.2, hy: 24.5, hz: 41.5 },      // the channel between the lake pavilions: the furrow's line and height (lake level 0.05), and the close-up mark above its lens end
                // breath: a slow swell that runs tail-ward down the coils (one breath in 4.4 s), deepest asleep, gone once it climbs
                swellOn: t => 1 - sm(10.5, 13.5, t),
                swell(t, a) { const k = Choreo.swellOn(t); if (k <= 0) return 1; const b = 0.5 - 0.5 * Math.cos(TAU * (t / 4.4 - a / 190) + 0.6); return 1 + 0.13 * k * b * b * sm(5, 22, a) * (1 - sm(120, 160, a)); },
                // the head and neck off the rock (m, along the rock's normal at the head) and extra height: asleep the head lies against the
                // shaft; at 3 s it lifts and looks about; it sinks, lifts again as it sets off; DRUMS: it rears on the summit; then crouches to leap
                lift: keyed([[0, 2.6], [2.9, 2.6], [4.9, 7.0], [6.6, 5.0], [8.6, 6.2], [10.2, 4.4], [14.3, 4.4], [15.4, 8.0], [16.3, 7.0], [17.1, 3.0], [17.6, 3.0]]),
                liftUp: keyed([[0, -0.9], [2.9, -0.9], [4.9, 2.2], [6.6, 1.0], [8.6, 2.0], [10.2, 1.2], [14.3, 1.0], [15.4, 0], [18, 0]]),
                // the free tail: slow figure-of-eight sway all the time it hangs clear, and four quick flicks of the tip
                FLICKS: [1.5, 4.0, 6.3, 8.1],
                tailOn: t => 1 - sm(11.5, 14.5, t),
                tail(t, a, w, out) {
                    const q = clamp((a - (red.LEN - 34)) / 34), q2 = q * q; let f = 0; for (const t0 of Choreo.FLICKS) { const d = t - t0 - 0.25 * q; if (d > 0 && d < 2.4) f += Math.sin(d * 9.5) * Math.exp(-d * 2.1); }
                    const sw = Math.sin(t * 0.9 - q * 2.2), sv = Math.sin(t * 0.63 + 1.1 - q * 1.6);
                    out.x += w * q2 * (2.2 * sw + 3.4 * f); out.y += w * q2 * (2.6 * sv + 4.2 * f); out.z += w * q2 * (1.6 * sw - 1.2 * f);
                },
                // how hard the bodies roll their backs toward the lens (0..1). Off while red is wrapped round its spire (belly to the rock), and
                // through the beats whose contacts were fitted without it: CLASH1, BOLT to SPLASH (the bolt, the lock, the knot), BEAM and BLAST
                lensRoll: keyed([[18.2, 0], [19.4, 1], [40.9, 1], [41.5, 0], [43.0, 0], [43.9, 1], [48.9, 1], [49.3, 0], [57.9, 0], [58.9, 1], [61.5, 1], [62.4, 0], [68.4, 0], [69.8, 1], [90, 1]]),
                // ================= the red loong: fire, earth and dusk =================
                red({ add, key, at, P, helix, zone }) {
                    const S = Rock.L.main, F = Film.T, A = Film.A, SD = Choreo.SEAT_D, C = Choreo.CH;
                    Seat.init(sceneRef);
                    // 0-17.3: COILED ON the main spire from first light: two and three quarter turns of body lying on the rock, belly to the
                    // stone, from the lens side low on the shaft (y 55) round and up to the head, which rests against the lens side of the shaft
                    // at y 88. The last 34 m of tail hang free in the air to the right of the spire and sway. The coil's height by angle is
                    // chosen (it threads under the maple that crowns the left spire at th 150, y 70 to 86, and comes back over it a turn later);
                    // its RADIUS is not: at every angle a ball of the belly's radius is rolled in from outside until it touches the real rock.
                    add(41, 82, -19); add(37, 73.5, -28); add(33.5, 66.5, -35.5); add(30.5, 60.6, -41.5); add(25.5, 56.6, -46.5); add(18.6, 54.9, -50.8);
                    const TH0 = -270, TH1 = 705, DT = 7.5, cTh = [-270, -205, -75, 0, 155, 285, 389, 445, 495, 515, 645, 705], coilY = mono(cTh, [55.2, 56.5, 59, 61.3, 64.5, 73.5, 82.5, 88, 93.8, 94.8, 98.8, 100.3]);
                    const fitR = (th, y) => { const a = rad(th), ex = Math.cos(a), ez = Math.sin(a); return Seat.ok ? 19 - Seat.drop(tA.set(S.x + 19 * ex, y, S.z + 19 * ez), tB.set(-ex, 0, -ez), 17.5, SD) : lerp(S.r0, S.r1, clamp((y + 6) / (S.top + 6))) * 0.8 + SD; };
                    let cr = []; for (let th = TH0; th <= TH1 + 0.01; th += DT) cr.push(fitR(th, coilY(th)));
                    for (let pass = 0; pass < 2; pass++) cr = cr.map((r, i) => i && i < cr.length - 1 ? 0.25 * cr[i - 1] + 0.5 * r + 0.25 * cr[i + 1] : r);      // a body cannot follow single blocks
                    for (let i = 0; i < cr.length; i += 2) { const th = TH0 + i * DT, a = rad(th); add(S.x + cr[i] * Math.cos(a), coilY(th), S.z + cr[i] * Math.sin(a), th % 45 === 0 || i + 2 >= cr.length ? 'h' + th : null); }
                    // DRUMS: over the east rim onto the flat summit (a ball dropped from above finds the height), across it to the west edge
                    { tA.set(S.x + 9.6, 108.6, S.z + 2.6); tB.set(S.x - 1.5, 99, S.z + 1.2).sub(tA); const L = tB.length(); tB.multiplyScalar(1 / L); const l = Seat.ok ? Seat.drop(tA, tB, L, SD) : 5.2; add(tA.x + tB.x * l, tA.y + tB.y * l, tA.z + tB.z * l, 'rim'); }
                    const onTop = (x, z, name) => { const y = Seat.ok ? 119 - Seat.drop(tA.set(x, 119, z), tB.set(0, -1, 0), 22, SD) : S.top + 1.5 + SD; add(x, y, z, name); };
                    onTop(S.x + 2.0, S.z + 4.2, 'on'); onTop(S.x - 1.7, S.z + 3.4, 'top'); onTop(S.x - 5.2, S.z + 2.2, 'edge');
                    zone('seat', ['h-270'], ['edge'], 5);
                    // asleep it does not lie dead still: a breath, and the coils creep round and settle back (2.4 to 7.2); EMERGE: it slides
                    // on round the front of the shaft and up; DRUMS: the head comes over the rim, and it rears on the summit; 17.3: it leaps
                    key(0, 'h450', -0.33); key(2.4, 'h450', -0.33); key(5.2, 'h450', 1.2); key(7.2, 'h450', 0.75); key(F.EMERGE, 'h450', 1.33); key(11.9, 'h540', 0.33); key(13.1, 'h630', -0.33); key(F.DRUMS, 'h675', 1.6); key(16.15, 'top'); key(17.15, 'edge');
                    // 17.3-19.0: off the west edge of the summit, three metres over the crown of the maple on the left spire, down the left side
                    // of the valley in one dive, and low over the left hall and the two maples beside it (2.5 to 3.5 m over their crowns)
                    P(-2.5, 102, -61.2, 17.36); P(-10, 96.8, -57.5, 17.53); P(-13.5, 93.6, -50.5); P(-17.5, 86.3, -43.5); P(-23, 68.5, -31); P(-27.5, 54, -19.5); add(-27.4, 47.8, -10.6, 'hallA'); key(18.6, 'hallA'); add(-20.3, 44.3, 1.5, 'hall'); key(18.82, 'hall');
                    // 19.0-19.8: down off the terrace into the channel between the two lake pavilions (over the low rocks north of it), and
                    // THROUGH THE WATER: for eleven metres the spine runs 1.6 m above the lake, the belly a metre and a half under it, straight at
                    // the lens. The whole body follows down the same furrow.
                    P(-13.8, 40.6, 8.0); P(-10.0, 27.9, 13.6); P(-6.8, 12.6, 18.9); add(C.x - 0.7, 3.0, C.z0, 'down'); key(19.56, 'down'); add(C.x - 0.1, C.y + 0.1, C.z0 + 4, 'skim'); add(C.x, C.y, C.z1 - 2.2);
                    // 19.8-21.15: it rears out of the lake: up and back over itself in an S (the neck leans away from the lens, the head comes
                    // forward over the top of it), braking, and holds there 31 m from the lens, face to the lens (the close-up; CHARGE: it
                    // inhales, the throat glows). Side view: a 6.8 m bend out of the water, a 5.5 m bend over the top.
                    {
                        const zb = C.z1, yb = C.y + 6.8, zt = C.hz - 5.5 * Math.sin(rad(20)), yt = C.hy - 5.5 * Math.cos(rad(20)), bend = (f, t) => { const a = rad(f); P(C.x + 0.2 * f / 135, yb - 6.8 * Math.cos(a), zb + 6.8 * Math.sin(a), t); }, over = f => { const a = rad(f); add(C.x + 0.3, yt + 5.5 * Math.cos(a), zt + 5.5 * Math.sin(a), f === -135 ? 'rear' : null); };
                        bend(0); bend(35); bend(70); bend(100); bend(135); over(-135); key(20.04, 'rear'); over(-100); over(-60); over(-20);
                    }
                    add(C.x + 0.4, C.hy, C.hz, 'hov1'); key(21.15, 'hov1'); add(C.x, C.hy - 1.2, C.hz + 3.5, 'hov2'); key(21.85, 'hov2');
                    zone('quiet', ['hallA'], ['hov2'], 12); zone('tuck', ['edge', 1], ['hov2'], 10); zone('up', ['skim'], ['hov2'], 5);
                    // 21.9-27: it whips left and up into a rising coil over the lake pool (one turn, its flank to the lens), and rears out of the
                    // top of it on the lens side for the ROAR, creeping on round. OMEN: it slithers round the near side to the left of the coil
                    // and stops there with its back to the lens, looking up at the tower: the lens sees it over its shoulder as white comes
                    const HX = -10, HZ = 30, HRAD = 8, hy = mono([28, 90, 150, 210, 270, 330, 380, 530, 575], [23.2, 26.6, 29.6, 31.4, 32.8, 35.2, 38.6, 45, 46.6]);
                    const hel = (th, t) => P(HX + HRAD * Math.cos(rad(th)), hy(th), HZ + HRAD * Math.sin(rad(th)), t);
                    add(-7.2, 23.9, 49.3, 'whip'); P(-12.7, 25.7, 49.4); P(-17.1, 28.4, 44.7); add(-18.1, 29.5, 38.2, 'whipB'); zone('tuck', ['whip'], ['whipB', 1], 8);      // the whip left: out round the lens side, 3 m over the crown of the great maple on the left bank, and onto the coil
                    for (let th = 180; th <= 300; th += 30) hel(th); hel(335, 23.75); hel(357); hel(380, F.OMEN); for (let th = 410; th <= 500; th += 30) hel(th); hel(530, 28.25); hel(552); hel(572, 30.95);
                    // 31-36: as white dives, red launches straight up past it, loops over the top high above the lake (its tail follows it up
                    // out of the frame), and winds down a tight coil above the left hall: a turn and two thirds, out of it onto its mark. The coil
                    // stays stacked behind its head through the face-off
                    P(-15.5, 55, 21.5); P(-12.5, 70, 15, 31.55); P(-9, 88, 10); P(-8.5, 103, 2, 32.3); P(-10.5, 110, -5); P(-17, 101, -10.5, 32.85);
                    { const CX = -29, CZ = -12, CR = 10, y0 = 96, y1 = 57.3, a0 = 0, a1 = -600; for (let a = a0; a >= a1; a -= 30) { const u = (a0 - a) / (a0 - a1); P(CX + CR * Math.cos(rad(a)), lerp(y0, y1, u), CZ + CR * Math.sin(rad(a)), a === -300 ? 34.45 : a === -600 ? 35.72 : null); } }
                    P(-28.5, 55.6, 0.3);
                    // FACEOFF: stalk toward the lens down the left side, head turned to white, then turn in
                    P(-23.5, 54.5, 2.5, F.FACEOFF); P(-21.5, 52.6, 8, 38.0); P(-18.5, 51.5, 12, 40.0); P(-14.5, 51.2, 13.6, 41.1);
                    // CLASH1: the rail only closes to striking distance; the strike itself is acted (fightActs): the neck shoots out and the two
                    // mouths meet at Film.A.clash1 on the beat. Then each rears up and back in a wide curl (mirrored), and wheels north: red round
                    // the WEST side of the main spire (above the pines of the lower spire), behind the summit, out round the east side
                    const C1 = A.clash1; P(C1.x - 15.6, C1.y + 0.3, C1.z - 0.3, F.CLASH1); P(C1.x - 11.5, C1.y + 2.6, C1.z); P(C1.x - 9.5, C1.y + 9, C1.z - 1.5, 42.75); P(C1.x - 11.5, C1.y + 15.5, C1.z - 4.5); P(-11.5, 71.5, 2.5, 43.3); P(-13.5, 77.5, -11); P(-14, 86.5, -30, 43.95); P(-13, 97, -49); P(-12.5, 100.5, -66, 44.6); P(-5.5, 100.5, -82); P(10, 98.5, -88, 45.15); P(21.5, 96.5, -84); P(27.5, 94.5, -70, 45.7); P(30.5, 88.5, -54);
                    // FIRE2: out in front of the spire on the right, it slows and pours fire across the valley, across the path white is diving
                    // down; as the fire dies it slips west UNDER white's line, wheels round above the left hall and comes back at white, who is
                    // looping over the right bank. BOLT: its head is on the bolt's line a quarter of a second before the bolt comes; it ducks and
                    // the bolt passes over its antlers. From 47 s on red flies level and low in the frame, so everything it trails stays under
                    // the line the bolt draws across the sky
                    P(27.5, 84, -40, 46.4); P(17, 78.5, -33.5, 47.0); P(6, 72.5, -27.5, 47.5); P(-8, 66, -20.5, 47.9); P(-21, 59.5, -9, 48.32); P(-25.8, 54.5, 6, 48.78); P(-18.5, 54.5, 16.5, 49.18); P(-11.3, 63.2, 17, F.BOLT); P(-9.5, 68.5, 9.5, 50.02); P(-9.8, 75.5, -1.5); P(-5.5, 78, -9.8); P(1, 74.5, -12.8);
                    Choreo.knot(P, 0);
                    // SPLASH: under, north along the channel and out again behind the column (the pool has no clear water beside it). It sweeps
                    // up the left side of the valley over the left hall and winds a rising coil behind its place for the BEAM, so that by then
                    // its whole length is out of the lake and coiled behind it, and it leaves the coil eastward, straight at white
                    const S0 = A.splash, X = A.exitR, HR = Choreo.HOV[0];
                    P(-8.6, -8, 36.5); P(X.x - 1.2, -8.5, X.z + 6); P(X.x, 0.05, X.z, 57.66); P(X.x - 0.2, 10, X.z - 0.3); P(-5.5, 20.5, 22.6, 58.02); P(-13.5, 27.5, 19.6); P(-22, 36.5, 17, 58.5); P(-28.5, 46, 10); P(-28, 51.5, -4, 59.1); P(-21, 54.5, -16); P(-17.5, 57.5, -28, 59.75);
                    helix(59.75, 61.6, -29.5, -28, 360, 90, 12, 12, 57.5, 73.4, 45, 0.75, 2);
                    P(HR.x - 6, HR.y - 0.6, HR.z + 0.2); add(HR.x, HR.y, HR.z, 'hov'); key(62.3, 'hov'); key(F.BEAM, 'hov', 0.05); key(F.BLAST, 'hov', 0.10); key(F.BLAST + 1.0, 'hov', 0.14);
                    Choreo.finale(P, -1);
                },
                redActs(imp, d) {
                    const F = Film.T, h = V(0, 0, 0), up = V(0, 1, 0);
                    imp(19.3, 20.0, V(0, 1, 0.1).normalize(), t => 1.7 * sm(19.33, 19.53, t) * (1 - sm(19.75, 19.98, t)), 9);      // in the furrow the head is carried just clear of the water, its beard in it: the body ploughs, the head does not
                    heading(d, 23.75, h); imp(22.8, F.OMEN + 1, h.clone().multiplyScalar(-0.75).add(V(0, 0.65, 0)).normalize(), t => 3.6 * sm(22.8, F.ROAR - 0.2, t) * (1 - sm(F.ROAR - 0.05, F.ROAR + 0.25, t)), 24);       // CHARGE: out of the top of the coil it rears back and up
                    imp(F.ROAR - 0.05, F.OMEN + 1.5, h.clone().add(V(0, 0.55, 0)).normalize(), t => 3.2 * sm(F.ROAR - 0.05, F.ROAR + 0.3, t) * (1 - sm(F.ROAR_END - 0.6, F.ROAR_END + 1.2, t)), 22);                                                   // ROAR: thrust
                    imp(F.OMEN + 0.5, F.DESCENT + 1.6, V(0.15, 0.55, 0.45).normalize(), t => 5.5 * sm(F.OMEN + 0.5, F.OMEN + 1.5, t) * (1 - sm(F.DESCENT + 0.6, F.DESCENT + 1.5, t)), 24);       // OMEN: it tenses above its coil, peering down at the lake and banks as the giant snakes emerge
                    snake3.railAt(F.WROAR, tA); d.railAt(F.WROAR, tB); tC.subVectors(tB, tA).setY(0).normalize();                                                                                                                                  // away from the attacking serpents
                    imp(F.WROAR, F.WROAR + 2.9, tC.clone().multiplyScalar(0.5).add(V(0, -0.86, 0.1)).normalize(), t => 8.5 * sm(F.WROAR + 0.05, F.WROAR + 0.42, t) * (1 - sm(F.WROAR_END - 0.35, F.WROAR_END + 0.5, t)), 18, 60);                     // serpents' venom roar: red is driven back and down, struggling under the dual assault
                    imp(F.WROAR + 1.4, F.WROAR + 2.7, tC, t => -2.4 * sm(F.WROAR + 1.5, F.WROAR + 1.9, t) * (1 - sm(F.WROAR_END - 0.2, F.WROAR_END + 0.35, t)), 22);                                                                             // and from down there it snarls back
                    imp(F.BOLT - 0.36, F.BOLT + 1.1, V(-0.25, -0.9, 0.36).normalize(), t => 11.5 * sm(F.BOLT - 0.36, F.BOLT - 0.05, t) * (1 - sm(F.BOLT + 0.2, F.BOLT + 1.05, t)), 26);                                                             // BOLT: duck down as the serpent's venom-bolt strikes
                    Choreo.fightActs(imp, d, snake3, -1);
                },
                redPose(t, st) {
                    const F = Film.T;
                    const cROAR = sm(F.CHARGE, F.ROAR - 0.15, t) * (1 - sm(F.ROAR + 0.5, F.ROAR_END + 0.8, t));
                    st.charge = Math.max(cROAR, 0.6 * env(t, 41.15, F.CLASH1, 0.4, 0.2), 0.7 * env(t, F.FIRE2 - 0.7, F.FIRE2 + 0.2, 0.5, 0.2), env(t, F.BEAM - 1.5, F.BEAM + 0.25, 0.9, 0.25));
                    st.roar = Math.max(sm(F.ROAR - 0.08, F.ROAR + 0.04, t) * (1 - sm(F.ROAR_END - 0.9, F.ROAR_END + 0.2, t)), 0.5 * env(t, F.WROAR + 1.5, F.WROAR_END + 0.4, 0.25, 0.5));     // the roar (the jaw is open ON the beat: the picture leads the sound by a frame or two, never trails it), then the snarl back at white
                    st.breath = Math.max(sm(F.ROAR - 0.02, F.ROAR + 0.09, t) * (1 - sm(F.ROAR_END - 1.0, F.ROAR_END - 0.1, t)), env(t, F.FIRE2, F.FIRE2 + 1.6, 0.15, 0.35), env(t, F.BEAM, F.BLAST + 0.1, 0.25, 0.15));
                    st.jaw = Math.max(st.roar, 0.85 * st.breath, 0.8 * Choreo.bite(t, 0), 0.10 * sm(F.CHARGE, F.ROAR, t) * (1 - st.roar), 0.05 + 0.04 * Math.sin(t * 0.9));
                    st.glow = Math.max(st.charge * 0.9, st.roar, 0.9 * st.breath) + 0.06 * (0.5 + 0.5 * Math.sin(t * 1.7));
                    st.aim = Math.max(env(t, F.ROAR - 0.45, F.ROAR_END + 0.1, 0.5, 0.7), 0.4 * env(t, F.WROAR + 1.3, F.WROAR_END + 0.5, 0.4, 0.5), env(t, F.FIRE2 - 0.45, F.FIRE2 + 1.75, 0.45, 0.45), env(t, F.BEAM - 0.55, F.BLAST + 0.25, 0.5, 0.3));
                    { const yawn = env(t, 14.8, 16.4, 0.2, 0.8); st.roar = Math.max(st.roar, 0.62 * yawn); st.jaw = Math.max(st.jaw, 0.8 * yawn); }      // DRUMS: it bursts round the summit, jaws open
                    { const em = env(t, 4.5, 6.0, 0.6, 0.8); st.charge = Math.max(st.charge, 0.32 * em); st.glow = Math.max(st.glow, 0.5 * em); st.jaw = Math.max(st.jaw, 0.2 * em); st.breath = Math.max(st.breath, 0.2 * env(t, 5.0, 5.75, 0.25, 0.4)); }      // asleep: one slow breath of embers
                    st.reach = Math.max(st.roar, 0.85 * st.charge * sm(6.5, 7.5, t), Choreo.bite(t, 0), 0.4 * st.breath);
                    st.lid = 1 - sm(3.0, 3.3, t);                                  // eyes shut until 3.0 s
                    st.vis = 1 - sm(red.tGone, red.tGone + 0.04, t);
                },          // never see-through: the rift swallows it (gateOf), and once the tail tip is in it is gone
                redGaze(t, st, out) {
                    const F = Film.T, knot = env(t, KNOT0 - 0.3, F.SPLASH, 0.3, 0.3);
                    snake3.headAt(t, foe);
                    Film.pearlAt(t, prl); gz(out);
                    pull(out, 0.6 * env(t, 3.3, 5.6, 0.8, 0.6) + 0.65 * env(t, 7.0, 8.9, 0.6, 0.9) + 0.6 * env(t, 16.2, 17.2, 0.5, 0.15) + 0.95 * env(t, 18.9, 22.15, 0.5, 0.45), G.camera.position);
                    pull(out, 0.75 * env(t, 5.2, 7.4, 0.6, 0.6), tA.set(64, 52, 6));
                    pull(out, 0.9 * sm(22.9, 23.8, t) * (1 - sm(F.OMEN + 0.05, F.OMEN + 0.4, t)), tA.set(45, 68.5, 49));
                    pull(out, 0.85 * sm(F.OMEN + 0.2, F.OMEN + 1.1, t) * (1 - sm(F.DESCENT + 0.3, F.DESCENT + 1.6, t)), tA.set(18, 4, 38));
                    const fire = env(t, F.FIRE2 - 0.5, F.FIRE2 + 1.75, 0.4, 0.35);
                    pull(out, (1 - fire) * (1 - knot) * sm(F.DESCENT + 0.3, F.DESCENT + 1.6, t) * (1 - env(t, 31.25, 35.55, 0.25, 0.5)) * (0.9 - 0.75 * env(t, F.CLASH1 + 0.7, 46.2, 0.6, 0.5)) * (1 - env(t, 56.9, 61.6, 0.15, 0.5)) * (1 - sm(F.BLAST + 0.3, F.FINALE + 0.6, t)), foe);
                    if (fire > 0) {
                        snake3.headAt(t, tB); snake3.headAt(t + 0.12, tC).sub(tB); if (tC.lengthSq() > 1e-6) tB.addScaledVector(tC.normalize(), 6);
                        pull(out, 0.95 * fire, tB.lerp(tC.set(-40, 60, -1), sm(47.05, 47.5, t)));
                    }
                    if (knot > 0) pull(out, 0.9 * knot, Choreo.neckOf(snake3, t, tB));
                    pull(out, 0.7 * sm(F.BLAST + 0.6, F.FINALE + 1.5, t) * (1 - sm(F.GONG - 0.5, F.GONG + 0.1, t)), prl);
                    return gzEnd(out);
                },

                // ================= Single-Headed Royal Emperor King Cobra (snake3 · রাজগোখরা / Ophiophagus hannah) =================
                // Strictly 1-headed King Cobra emerging from the LAKE WATER and rocky ghats at 27 s.
                // Exhibits authentic Ophiophagus hannah behavior: rearing the anterior 1/3 of its body vertically upright like a standing pillar,
                // expanding its oblong-oval cervical hood (ফণা) with golden-black throat bands, weaving hypnotically side-to-side, cocking back
                // in an S-coil, and launching downward-forward whip-strikes (ছোবল) with fixed proteroglyphous venom fangs!
                snake3({ add, key, at, P, helix }) {
                    const F = Film.T, A = Film.A, C1 = A.clash1;
                    // Hidden beneath the eastern lake water & right rocky bank before 27.0s, then bursts out of the water and rears its hood!
                    at(0, 56, -14, 46); at(26.4, 44, -10, 42);
                    at(27.5, 34, 0.05, 38);                             // bursts up through the right lake surface!
                    P(25, 2.2, 36, 28.6); P(14, 1.2, 41, 29.8);         // glides across the water with wide horizontal S-waves throwing spray
                    P(4, 3.8, 46, 30.8); P(-6, 5.2, 49, 31.6);          // surges across the pool in front of the lens, hood flaring
                    P(8, 11.5, 44, 32.5); P(24, 21.0, 36, 33.4);        // slithers up the right rocky bank and terrace ledges
                    P(36, 31.0, 26, 34.3); P(39, 43.0, 18, 35.1); P(34, 53.5, 13, 35.8);
                    // FACEOFF (36.0s): stands tall in a towering vertical King Cobra rear-up on the right terrace, single hooded head swaying!
                    P(30.5, 57.5, 11.5, 37.5); P(23.5, 56.8, 12.0, 38.6);
                    // WROAR (39.0s-41.2s): cocks its hooded S-neck high, then whip-strikes downward & forward (ছোবল) to bite Red's neck!
                    P(-9.5, 52.2, 12.8, 39.35); P(-11.0, 51.0, 13.4, 40.15);
                    P(18.5, 55.5, 13.5, 41.15);                         // rears back into upright hooded striking coil for CLASH1
                    // CLASH1 (42.0s): violent mid-air cobra fang strike at Film.A.clash1, then slithers around the eastern mountain ledges
                    P(C1.x + 15.4, C1.y + 1.2, C1.z - 0.3, F.CLASH1); P(C1.x + 11.3, C1.y + 3.5, C1.z); P(C1.x + 9.3, C1.y + 9.8, C1.z - 1.5, 42.75); P(C1.x + 11.3, C1.y + 16.2, C1.z - 4.5);
                    P(22.5, 66.5, 2.5, 43.3); P(26, 70.5, -11); P(27, 75.5, -30, 43.95); P(30, 80.0, -49); P(31, 84.5, -66, 44.55); P(25, 86.5, -81); P(10, 88.0, -88, 45.15); P(-9, 86.0, -83); P(-19, 82.0, -68, 45.75); P(-21, 78.0, -52);
                    // FIRE2 (46.5s) & BOLT (49.5s): slithers low under Red's fire plume, rears up high on the terrace, and snaps downward at Red!
                    P(-21.5, 74.0, -38, 46.4); P(-19, 66.5, -24, 46.9); P(-10, 56.5, -9, 47.4); P(2.5, 46.0, 6.5); P(9.5, 38.0, 20); P(11.5, 35.0, 26.5, 48.3);
                    P(15, 41.0, 31.0); P(8.5, 54.0, 25.5, 49.0);        // rears high above Red before the downward cobra strike
                    P(-7.5, 61.8, 17.5, F.BOLT);                        // downward-forward King Cobra whip-strike right at Red's head at BOLT!
                    P(16.0, 67.5, 12.0, 50.12); P(14.5, 71.2, 4.6);
                    // CLASH2 (51.0s-57.0s): locks its proteroglyphous fangs onto Red's neck and wraps in a tight King Cobra constriction coil!
                    Choreo.knot(P, 1);
                    // SPLASH (57.0s) & BEAM (63.0s-67.5s): bursts out of the right lake pool, winds a basal support coil, and rears its giant hood!
                    const X = A.exitW, HW = Choreo.HOV[1];
                    P(X.x - 1.6, -7.5, X.z - 2.6, 57.45); P(X.x, 0.05, X.z); P(X.x - 0.2, 10, X.z - 0.3, 57.82); P(2.2, 21, 48.6); P(5.5, 30, 43); P(11.5, 36, 31); P(19, 38, 15.5, 58.74); P(26.5, 45.5, 6); P(31, 52, -6, 59.3); P(32, 54.5, -17); P(32, 56, -27, 59.68);
                    helix(59.68, 61.8, 42.5, -27, 180, 810, 10.5, 10.5, 56, 73.8, 45, 0.85, 2);
                    P(HW.x + 6, HW.y - 0.6, HW.z + 0.2); add(HW.x, HW.y, HW.z, 'hov'); key(62.3, 'hov'); key(F.BEAM, 'hov', 0.05); key(F.BLAST, 'hov', 0.10);
                    // Defeated by the combined Dragon Team at BLAST: hurled down into the deep eastern ravine!
                    P(58, 62, -25, F.BLAST + 0.8); P(88, 32, -42, F.BLAST + 2.2); P(125, -15, -68, F.BLAST + 4.2); P(165, -55, -95, 76.0); P(210, -90, -120, 90.0);
                },
                snake3Acts(imp, d) {
                    const F = Film.T;
                    red.railAt(F.WROAR, tA); d.railAt(F.WROAR, tB); tC.subVectors(tA, tB).normalize();
                    // Authentic King Cobra Strike (ছোবল): first cocks the upright hooded neck back & high (-tC + up), then snaps downward & forward with chewing venom pulses!
                    imp(F.WROAR - 0.75, F.WROAR + 0.05, tC.clone().multiplyScalar(-0.65).add(V(0, 0.76, 0)).normalize(), t => 5.2 * sm(F.WROAR - 0.75, F.WROAR - 0.18, t) * (1 - sm(F.WROAR - 0.10, F.WROAR + 0.04, t)), 26);
                    imp(F.WROAR - 0.12, F.WROAR_END + 0.6, tC.clone().add(V(0, -0.22, 0)).normalize(), t => 6.4 * sm(F.WROAR - 0.10, F.WROAR + 0.08, t) * (1 - sm(F.WROAR_END - 0.2, F.WROAR_END + 0.5, t)) + 3.1 * Math.sin((t - F.WROAR) * 16) * env(t, F.WROAR, F.WROAR_END, 0.08, 0.2), 26, 85);
                    imp(F.FIRE2 + 0.05, F.FIRE2 + 2.6, V(-0.72, 0.62, 0.3).normalize(), t => 10 * sm(F.FIRE2 + 0.05, F.FIRE2 + 0.7, t) * (1 - sm(F.FIRE2 + 1.25, F.FIRE2 + 2.5, t)), 60, 70);
                    Choreo.fightActs(imp, d, red, 1);
                    { const t0 = F.CLASH2; imp(t0 - 0.1, t0 + 1.7, V(0.3, 0.75, 0.55).normalize(), t => 8 * sm(t0 - 0.06, t0 + 0.46, t) * (1 - sm(t0 + 0.8, t0 + 1.6, t)), 16); }
                },
                snake3Pose(t, st) {
                    const F = Film.T;
                    // Pure physical King Cobra: full hood expansion during threat displays and strikes, wide fang-baring gape!
                    st.charge = Math.max(env(t, 35.0, 39.0, 0.5, 0.3), env(t, F.WROAR - 0.8, F.WROAR_END + 0.2, 0.3, 0.3), 0.9 * env(t, 41.0, F.CLASH1 + 0.3, 0.3, 0.2), 0.95 * env(t, F.BOLT - 0.5, F.BOLT + 0.3, 0.25, 0.2), env(t, F.BEAM - 1.2, F.BLAST + 0.2, 0.5, 0.2));
                    st.roar = Math.max(env(t, 27.6, 31.8, 0.3, 0.5), 0.65 * env(t, 35.8, 38.9, 0.4, 0.3), env(t, F.WROAR - 0.1, F.WROAR_END + 0.2, 0.1, 0.4), env(t, F.BOLT - 0.15, F.BOLT + 0.35, 0.1, 0.2), env(t, F.BEAM - 0.4, F.BLAST + 2.5, 0.2, 0.8));
                    st.hood = clamp(0.65 + 0.35 * Math.max(st.charge, st.roar, env(t, 34.0, 43.0, 0.6, 0.5), env(t, 48.0, 52.0, 0.4, 0.4), env(t, 58.0, 68.0, 0.5, 0.4)), 0.52, 1.10);
                    st.breath = 0;
                    st.jaw = Math.max(st.roar, 0.98 * Choreo.bite(t, 1), 0.95 * env(t, F.WROAR - 0.1, F.WROAR_END + 0.1, 0.08, 0.25), 0.94 * env(t, F.BOLT - 0.15, F.BOLT + 0.25, 0.08, 0.15), 0.14 + 0.10 * Math.sin(t * 2.7 + 2));
                    st.glow = 0;
                    st.aim = 0;
                    { const pain = env(t, F.CLASH2 - 0.05, F.CLASH2 + 1.0, 0.15, 0.4); st.roar = Math.max(st.roar, 0.85 * pain); st.jaw = Math.max(st.jaw, 0.98 * pain); }
                    st.reach = 0;
                    st.lid = 0;
                    st.vis = sm(26.6, 27.3, t) * (1 - sm(F.BLAST + 3.2, F.BLAST + 4.4, t));
                },
                snake3Gaze(t, st, out) {
                    const F = Film.T, knot = env(t, KNOT0 - 0.3, F.SPLASH, 0.3, 0.3);
                    red.headAt(t, foe); gz(out);
                    pull(out, 0.88 * env(t, 28.0, 31.8, 0.4, 0.4), red.st.head);
                    pull(out, (1 - knot) * sm(31.5, 33.0, t) * (1 - sm(F.BLAST + 0.3, F.FINALE + 0.6, t)), foe);
                    if (knot > 0) pull(out, 0.95 * knot, Choreo.neckOf(red, t, tB));
                    return gzEnd(out);
                },

                // ---- Secondary snake2 is kept hidden (st.vis = 0) with a valid 4-point rail so the scene features strictly ONE 1-headed King Cobra ----
                snake2({ add, key, at, P, helix }) {
                    at(0, -180, -95, -180);
                    P(-180, -95, -160);
                    P(-170, -95, -140);
                    at(90, -180, -95, -120);
                },
                snake2Acts(imp, d) { },
                snake2Pose(t, st) {
                    st.charge = 0; st.roar = 0; st.hood = 0.5; st.breath = 0; st.jaw = 0; st.glow = 0; st.aim = 0; st.reach = 0; st.lid = 0;
                    st.vis = 0;
                },
                snake2Gaze(t, st, out) {
                    const F = Film.T, knot = env(t, KNOT0 - 0.3, F.SPLASH, 0.3, 0.3);
                    red.headAt(t, foe); gz(out);
                    pull(out, 0.85 * env(t, 27.8, 31.8, 0.4, 0.4), red.st.head);
                    pull(out, (1 - knot) * sm(31.5, 33.5, t), foe);
                    if (knot > 0) pull(out, 0.95 * knot, Choreo.neckOf(red, t, tB));
                    return gzEnd(out);
                },

                // ================= the White Dragon: emerges from the Portal (57.2s) to rescue the Crimson Dragon! =================
                white({ add, key, at, P, helix }) {
                    const F = Film.T, A = Film.A, R = A.rift, HR = Choreo.HOV[0];
                    // Hidden inside the portal rift until 57.2s (right after the snakes drag Red into the lake at SPLASH = 57.0s)
                    Film.camAt(58.0, tA); tB.subVectors(R, tA).normalize();
                    at(0, R.x + tB.x * 420, R.y + tB.y * 420, R.z + tB.z * 420);
                    at(54.0, R.x + tB.x * 220, R.y + tB.y * 220, R.z + tB.z * 220);
                    at(57.2, R.x, R.y, R.z);
                    // Bursts out of the portal in a blazing dive across the valley to join Red on the left flank!
                    P(-6, 124, -18, 57.85); P(-22, 106, -4, 58.45); P(-32, 88, 12, 59.15); P(-26, 76, 4, 59.85);
                    helix(59.85, 61.7, -26.5, -22, 320, 80, 10.5, 10.5, 72, 82.0, 45, 0.8, 2);
                    P(HR.x - 4, HR.y + 6.8, HR.z + 3.2);
                    add(HR.x + 1.5, HR.y + 6.5, HR.z + 3.5, 'hovW'); key(62.3, 'hovW'); key(F.BEAM, 'hovW', 0.05); key(F.BLAST, 'hovW', 0.10); key(F.BLAST + 1.0, 'hovW', 0.14);
                    // Victorious Dragon Team finale: spirals upward with the Crimson Dragon chasing the pearl into the heavens!
                    Choreo.finale(P, 1);
                },
                whiteActs(imp, d) {
                    const F = Film.T, h = V(1, 0.05, 0).normalize();
                    // BEAM: White Dragon unleashes its frost-lightning beam side-by-side with Red's fire beam to obliterate the serpents!
                    imp(F.BEAM - 1.5, F.BEAM + 0.4, h.clone().multiplyScalar(-0.8).add(V(0, 0.6, 0)).normalize(), t => 4.0 * sm(F.BEAM - 1.5, F.BEAM - 0.25, t) * (1 - sm(F.BEAM - 0.08, F.BEAM + 0.3, t)), 26);
                    imp(F.BEAM - 0.08, F.BLAST + 0.5, h, t => 2.8 * pulse(t, F.BEAM - 0.08, 0.2, 0.5) * (1 - sm(F.BLAST, F.BLAST + 0.5, t)), 30);
                    imp(F.BLAST, F.BLAST + 3.5, V(-0.8, 0.4, 0).normalize(), t => 10 * sm(F.BLAST, F.BLAST + 0.5, t) * (1 - sm(F.BLAST + 0.8, F.BLAST + 3.2, t)), 24, 70);
                },
                whitePose(t, st) {
                    const F = Film.T;
                    st.charge = Math.max(env(t, 57.4, 59.2, 0.3, 0.4), env(t, F.BEAM - 1.5, F.BEAM + 0.25, 0.9, 0.25));
                    st.roar = Math.max(env(t, 57.6, 59.5, 0.2, 0.5), env(t, F.BEAM - 0.1, F.BEAM + 1.2, 0.15, 0.4));
                    st.breath = Math.max(env(t, 58.0, 59.4, 0.15, 0.35), env(t, F.BEAM, F.BLAST + 0.1, 0.25, 0.15));
                    st.jaw = Math.max(st.roar, 0.85 * st.breath, 0.05 + 0.04 * Math.sin(t * 0.9 + 2));
                    st.glow = Math.max(st.charge * 0.9, st.roar, 0.9 * st.breath) + 0.15 * (0.5 + 0.5 * Math.sin(t * 1.7 + 2));
                    st.aim = env(t, F.BEAM - 0.55, F.BLAST + 0.25, 0.5, 0.3);
                    st.reach = Math.max(st.roar, 0.85 * st.charge, 0.4 * st.breath);
                    st.lid = 0;
                    st.vis = sm(56.9, 57.15, t) * (1 - sm(white.tGone, white.tGone + 0.04, t));
                },
                whiteGaze(t, st, out) {
                    const F = Film.T;
                    snake3.headAt(t, foe); Film.pearlAt(t, prl); gz(out);
                    pull(out, 0.9 * env(t, 57.3, 59.2, 0.3, 0.4), G.camera.position);
                    pull(out, 0.95 * env(t, 59.0, F.BLAST + 0.3, 0.4, 0.3), foe);
                    pull(out, 0.8 * sm(F.BLAST + 0.5, F.FINALE + 1.5, t) * (1 - sm(F.GONG - 0.5, F.GONG + 0.1, t)), prl);
                    return gzEnd(out);
                },
                neckOf(d, t, out) { return d.pathAt(d.sOf(t) - 12.5 * d.K, out); },                                            // where a loong's neck is on its rail (the bite target)

                // ---- shared by both: CLASH2 and the knot. who: 0 red, 1 white ----
                // The two rails are the two strands of one double helix about the line Film.A.clash2 -> the lake, half a turn apart. The heads
                // pass each other at the top (KNOT0); half a turn later, on the beat, each is beside the other's neck. The first turn is wound
                // tight (the bodies touch: locked), then the helix opens and the pitch grows as it falls. n = turns wound so far (0..3.5).
                K0: V(7, 70, -4),                            // the top of the knot (Film.A.clash2 itself is moved onto the bite at build)
                KT: 2.75, KC: [V(3.5, 47, 5), V(-2.6, 31, 40)],  // turns wound by the time it hits the water; the bend of the fall line
                // the fall line: from Film.A.clash2 it drops as steeply as it starts, carries on out over the island and the two lake pavilions
                // toward the lens, and comes down into the open pool at Film.A.splash
                knotAxis(u, out) {
                    const K0 = Choreo.K0, S0 = Film.A.splash, c = Choreo.KC, v = 1 - u, a = v * v * v, b = 3 * u * v * v, d = 3 * u * u * v, e = u * u * u;
                    return out.set(a * K0.x + b * c[0].x + d * c[1].x + e * S0.x, a * K0.y + b * c[0].y + d * c[1].y + e * (S0.y + 0.4), a * K0.z + b * c[0].z + d * c[1].z + e * S0.z);
                },
                knotAt(n, who, out) {
                    const KT = Choreo.KT, pit = x => 17 * x + 16 * (x <= 0.5 ? 0 : (x - 0.5) * (x - 0.5) / 4), u = pit(n) / pit(KT);        // way down the fall line: about a fifth of it per turn at the top, half at the bottom
                    Choreo.knotAxis(u + 0.01, tA).sub(Choreo.knotAxis(u - 0.01, tB)).normalize();                                          // axis, pointing down
                    const flat = sm(KT - 0.8, KT - 0.1, n);                                                                               // the last turn levels out: both strands meet the water together
                    tB.set(1, 0, 0).addScaledVector(tA, -tA.x * (1 - flat)).normalize(); tC.crossVectors(tA, tB); if (flat > 0) tC.lerp(AZ, flat).normalize();   // tB: level +X; tC: square to both, toward the lens
                    const th = rad(who ? 90 : 270) + TAU * n, r = lerp(4.6, 6.6, sm(0.5, 1.4, n)) - 2.2 * sm(1.9, 2.65, n) + 0.6 * Math.sin(n * 3.3 + 1) * sm(0.9, 1.6, n) * (1 - sm(1.9, 2.3, n));
                    const sw = sm(0.5, 1.3, n) * (1 - sm(1.8, 2.4, n)), swx = 2.4 * Math.sin(n * 2.6 + 0.6) * sw, swz = 2.0 * Math.sin(n * 2.0 + 2.2) * sw;   // the axis sways as the knot tumbles
                    Choreo.knotAxis(u, out); out.x += swx; out.z += swz;
                    return out.addScaledVector(tB, r * Math.cos(th)).addScaledVector(tC, r * Math.sin(th));
                },
                // turns wound at time t: half a turn in the last lunge, held almost still in the lock, then falling faster and faster
                KN: [[KNOT0, 0], [51.0, 0.25], [52.5, 0.56], [54.0, 1.16], [55.5, 1.92], [57.0, 2.75]],
                knot(P, who) {
                    const KN = Choreo.KN;
                    for (let k = 0; k < KN.length - 1; k++) {
                        const [t0, n0] = KN[k], [t1, n1] = KN[k + 1], m = Math.max(2, Math.round((n1 - n0) * 10));
                        for (let i = k ? 1 : 0; i <= m; i++) { const u = i / m; Choreo.knotAt(lerp(n0, n1, u), who, tD); P(tD.x, tD.y, tD.z, i === m || (i === 0 && !k) ? lerp(t0, t1, u) : null); }
                    }
                    { Choreo.knotAt(Choreo.KT + 0.1, who, tD); P(tD.x, tD.y, tD.z); }
                },      // the helix carries on below the surface: nothing kinks at the water line
                calm(t) { return 1 - 0.8 * env(t, KNOT0, Film.T.SPLASH + 0.6, 0.5, 1.0); },      // wound tight, the bodies do not swim
                // ---- FINALE: no longer fighting, the two wind round the pearl's line, always opposite each other across it (so one of the
                // two always has its face to the lens). Thrown wide by the blast, each flies in at the pearl, peels off to its right and
                // swings into the orbit; the orbit is level while the pearl hangs and drifts, then it is carried along the pearl's climbing
                // path, tightens, and closes to a pair side by side as they run into the cloud. side: -1 red, +1 white ----
                HOV: [V(-17.5, 75.2, -15.5), V(31, 75.6, -15.5)],               // where each holds its ground for the BEAM
                finale(P, side) {
                    const F = Film.T, c = V(0, 0, 0), c1 = V(0, 0, 0), tg = V(0, 1, 0), e1 = V(1, 0, 0), e2 = V(0, 0, -1), q = V(0, 0, 0), hov = Choreo.HOV[side < 0 ? 0 : 1], last = hov.clone(), dt = 0.05, t0 = F.BLAST + 1.0;
                    Film.pearlLine(t0, c); const r0 = Math.hypot(hov.x - c.x, hov.z - c.z); let ph = side < 0 ? Math.PI : 0;
                    for (let t = t0; t <= Film.DUR + 1; t += dt) {
                        const lag = lerp(0.25, 0.6, sm(F.FINALE, F.FINALE + 6, t)) * (1 - 0.8 * sm(F.GONG - 3, F.GONG - 0.5, t));     // how far behind the pearl the pair flies (s); they catch it at the cloud
                        Film.pearlLine(t - lag, c); Film.pearlLine(t - lag + 0.25, c1).sub(c);
                        const k = sm(73.5, 78, t); tg.set(0, 1, 0); if (c1.lengthSq() > 1e-6) tg.lerp(c1.normalize(), k).normalize();   // the orbit's axis
                        e1.addScaledVector(tg, -e1.dot(tg)).normalize(); e2.crossVectors(tg, e1);
                        const r = lerp(lerp(lerp(r0, 15.5, sm(t0, F.FINALE + 1.7, t)), 12, sm(73, 79, t)), 4.6, sm(F.GONG - 2.5, F.GONG + 0.6, t));
                        ph += dt * 1.0 * sm(t0 + 0.15, t0 + 1.5, t) * lerp(1, 0.75, sm(75, 80, t));                                  // peel off to the right, into the orbit
                        q.copy(c).addScaledVector(e1, r * Math.cos(ph)).addScaledVector(e2, r * Math.sin(ph)); q.y += side * 0.8 * (1 - sm(t0, F.FINALE + 1.5, t));
                        if (q.distanceTo(last) < 8.5) continue;                                                                   // control points too close together kink the rail
                        P(q.x, q.y, q.z, t); last.copy(q);
                    }
                },
                // how tense each is (0..1.4): a second, faster wave down the body while it holds its ground or strains
                stir(t, who) {
                    const F = Film.T;
                    return Math.max(who ? 0.9 * env(t, F.FACEOFF - 0.5, F.CLASH1 - 0.2, 1.5, 0.3) : Math.max(0.9 * env(t, 23.0, 30.4, 1.2, 0.8), env(t, 35.2, F.CLASH1 - 0.2, 1.2, 0.3)),
                        0.45 * env(t, F.CLASH2 - 0.2, F.SPLASH - 0.4, 0.5, 1.2), 1.2 * env(t, F.BEAM - 1.8, F.BLAST + 0.1, 1.2, 0.1));
                },
                // jaw snaps: the two bites, and the heads snapping at each other down the knot
                SNAPS: [51.9, 52.75, 53.5, 54.2, 54.85, 55.45, 56.0, 56.5],
                bite(t, who) {
                    const F = Film.T; let b = pulse(t, F.CLASH1 - 0.13, 0.12, 0.28) + pulse(t, F.CLASH2 - 0.16, 0.14, 0.55);
                    for (let i = who; i < Choreo.SNAPS.length; i += 2) b += 0.9 * pulse(t, Choreo.SNAPS[i] - 0.1, 0.1, 0.22); return Math.min(1, b);
                },
                fightActs(imp, d, other, side) {
                    const F = Film.T, h = V(0, 0, 0), who = side < 0 ? 0 : 1;
                    // CLASH1: draw back, strike (the neck shoots out so the mouth reaches Film.A.clash1 on the beat), and the collision throws the
                    // head back and up; the whip runs down the neck
                    d.railAt(F.CLASH1, tA); h.set(Film.A.clash1.x - tA.x, 0, 0); const reachX = Math.abs(h.x) - 7.95 * d.K; h.normalize();     // the mouth is 7.95 m (x K) ahead of the spine's front
                    imp(41.1, F.CLASH1 + 0.5, h, t => -4.2 * sm(41.1, 41.6, t) * (1 - sm(41.74, 41.94, t)) + reachX * sm(41.76, F.CLASH1, t) * (1 - sm(F.CLASH1 + 0.04, F.CLASH1 + 0.42, t)), 17);
                    imp(F.CLASH1, F.CLASH1 + 1.6, h.clone().multiplyScalar(-0.85).add(V(0, 0.5, 0)).normalize(), kick(F.CLASH1, 0.16, 0.38, 6.5), 40, 90);
                    // CLASH2: strike at the other's neck (its rail 12 m behind its head) on the beat, then snap at it again and again down the knot
                    const neckOf = (t, out) => Choreo.neckOf(other, t, out);
                    // (the size and direction of this strike are set by Choreo.tuneBite once both loongs are scripted: bite.v is the head's shove on the beat)
                    {
                        const t0 = F.CLASH2, bite = d.bite = { v: V(0, 0, 0), amp: 0, m: null };
                        bite.m = imp(t0 - 0.3, t0 + 1.3, V(1, 0, 0), t => bite.amp * sm(t0 - 0.3, t0 - 0.02, t) * (1 - 0.45 * sm(t0 + 0.2, t0 + 0.6, t)) * (1 - sm(t0 + 0.7, t0 + 1.25, t)), 10);
                    }
                    for (let i = who; i < Choreo.SNAPS.length; i += 2) { const t0 = Choreo.SNAPS[i]; neckOf(t0, tA); d.railAt(t0, tB); tC.subVectors(tA, tB); const L = tC.length(); tC.normalize(); imp(t0 - 0.22, t0 + 0.5, tC, t => Math.max(0, Math.min(4.2, L - 7.95 * d.K - 0.95 * other.RMAX)) * sm(t0 - 0.22, t0, t) * (1 - sm(t0 + 0.06, t0 + 0.45, t)), 12); }     // the mouth, 7.95 m ahead of the spine's front, stops on the neck's surface
                    // BEAM: Red charges and fires its flame beam; the snakes (who=1) lunge with snapping fangs and writhe as the twin Dragon beams hit them!
                    h.set(-side, 0.05, 0).normalize();
                    if (who) {
                        imp(F.BEAM - 1.2, F.BLAST + 0.4, h, t => (5.2 * Math.max(0, Math.sin(t * 9.5 + d.cfg.seed)) * (1 - 0.65 * sm(F.BEAM + 0.5, F.BLAST, t)) - 6.5 * sm(F.BEAM + 0.3, F.BLAST, t)) * (1 - sm(F.BLAST, F.BLAST + 0.4, t)), 28);
                    } else {
                        imp(F.BEAM - 1.5, F.BEAM + 0.4, h.clone().multiplyScalar(-0.8).add(V(0, 0.6, 0)).normalize(), t => 4.0 * sm(F.BEAM - 1.5, F.BEAM - 0.25, t) * (1 - sm(F.BEAM - 0.08, F.BEAM + 0.3, t)), 26);
                        imp(F.BEAM - 0.08, F.BLAST + 0.5, h, t => (2.6 * pulse(t, F.BEAM - 0.08, 0.2, 0.5) - (0.8 + 2.5 * sm(F.BEAM + 0.4, F.BLAST - 0.2, t) + 0.35 * Math.sin(t * 23 + side) * sm(F.BEAM + 0.3, F.BEAM + 1, t)) * sm(F.BEAM + 0.25, F.BEAM + 1.1, t)) * (1 - sm(F.BLAST, F.BLAST + 0.5, t)), 30);
                    }
                    // BLAST: thrown back 15 m in 0.6 s; the whip runs down the body; the rail then carries them off after the pearl
                    imp(F.BLAST, F.BLAST + 4.5, h.clone().multiplyScalar(-1).add(V(0, 0.22, 0)).normalize(), t => 20 * sm(F.BLAST, F.BLAST + 0.6, t) * (1 - sm(F.BLAST + 0.9, F.BLAST + 4.2, t)), 27, 75);
                },
            };

            const list = [red, white, snake2, snake3];
            function tuneBite() {
                const t0 = Film.T.CLASH2;
                for (let it = 0; it < 7; it++) {
                    for (const d of [red, snake3]) d.spine(t0);
                    for (const [d, o] of [[red, snake3], [snake3, red]]) { const b = d.bite; if (b) { tA.subVectors(o.st.neck, d.st.mouth); const L = tA.length(), W = 0.95 * o.RMAX; b.v.addScaledVector(tA, 0.8 * (1 - W / L)); } }
                    for (const d of [red, snake3]) { const b = d.bite; if (b && b.m) { b.amp = b.v.length(); if (b.amp > 1e-4) b.m.d.copy(b.v).multiplyScalar(1 / b.amp); } }
                }
                for (const d of list) d.spine(t0); Film.A.clash2.copy(red.st.mouth);
                G.info.bite = [+red.st.mouth.distanceTo(snake3.st.neck).toFixed(2), +snake3.st.mouth.distanceTo(red.st.neck).toFixed(2), +red.st.head.distanceTo(snake3.st.neck).toFixed(2), +snake3.st.head.distanceTo(red.st.neck).toFixed(2)];
            }
            function gates() {
                const F = Film.T, R = Film.A.rift, n = new THREE.Vector3();
                white.sIn = white.sOf(57.2);
                snake2.sIn = -1e9; snake3.sIn = -1e9;
                snake2.sOut = 1e9; snake3.sOut = 1e9;
                snake2.tGone = F.BLAST + 4.0; snake3.tGone = F.BLAST + 4.2;
                Film.camAt(F.GONG, tA); n.subVectors(R, tA).normalize();
                for (const d of [red, white]) {
                    let s = d.sOf(F.GONG + 1.5); const s0 = d.sOf(F.GONG - 3); while (s > s0 && d.pathAt(s, tB).sub(R).dot(n) > 0) s -= 0.25; d.sOut = s;
                    let t = F.GONG - 2; while (t < Film.DUR + 3 && d.sOf(t) - d.LEN < s) t += 1 / 240; d.tGone = t;
                }
                G.info.gone = [+red.tGone.toFixed(2), +white.tGone.toFixed(2)];
            }
            function plan() { for (const d of list) d.plan(); for (const d of list) d.script(); gates(); tuneBite(); }
            function update(t) { for (const d of list) d.update(t); }
            function aimBolt(scene) {
                if (typeof Rock === 'undefined' || !Rock.mat) return; let rock = null; scene.traverse(o => { if (o.isMesh && o.material === Rock.mat) rock = o; }); if (!rock) return;
                const F = Film.T; G.camera.position.copy(Film.camAt(F.BOLT, tA)); tB.subVectors(Film.A.boltHit, Film.A.rift); const L = tB.length(); tB.normalize();
                const hit = new THREE.Raycaster(Film.A.rift.clone(), tB.clone(), L - 12, L + 12).intersectObject(rock, false)[0];
                if (hit && hit.point.distanceTo(Film.A.boltHit) < 4) Film.A.boltHit.copy(hit.point); G.info.boltHit = Film.A.boltHit.toArray().map(x => +x.toFixed(2)); G.info.boltRay = !!hit;
            }
            async function build(scene, fx, prog, tick) {
                const n = list.length; sceneRef = scene; plan(); aimBolt(scene);
                for (let i = 0; i < n; i++) await list[i].build(scene, p => prog((i + p) / n * 0.98), tick);
                G.tick.push(update); update(0); prog(1);
            }
            return { make, build, update, plan, list, red, white, snake2, snake3, st: red.st, Choreo };
        })();

if (typeof window !== 'undefined') {
    window.Dragon = Dragon;
}

export const createDragon = () => Dragon;
export { Dragon };
export const { make, build, update, plan, list, red, white, snake2, snake3, st, Choreo } = Dragon;
export default Dragon;
