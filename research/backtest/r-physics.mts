// Physics-style voters, each judged alone and inside the poll under the weekly cycle.
//   kramers_moyal   Fokker-Planck / Kramers-Moyal: estimate the drift D1(x) of the next-bar return
//                   conditional on the state x (z-score of price vs its 96-bar mean) from the trailing 3,000
//                   bars, binned; vote with the sign of D1 at today's state when it is 1.5 standard errors from 0.
//   quantum_well    Schroedinger-style bound state: the stationary density p(x) of the same state over the
//                   trailing 3,000 bars defines a potential V = -ln p; vote with the "force" -dV/dx when the
//                   state sits on a steep wall (|force| in its top 30%). (The ground state of a quantum
//                   harmonic oscillator is a Gaussian, so this is the data-driven version of that model.)
//   fluid_reynolds  Navier-Stokes analogy: "Reynolds number" = |drift| x length / diffusion (drift = mean
//                   return over L bars, diffusion = variance); laminar flow (top 30% of its history) is followed,
//                   turbulent flow gives no vote.
//   burgers_shock   viscous Burgers equation u_t + u u_x = nu u_xx on the velocity u (EMA of returns): when the
//                   advection term outruns viscosity the wave steepens into a shock (a sharp move) that the
//                   equation says dissipates; fade u when |u u_x| / (nu |u_xx|) is in its top 10%.
// Lengths for "H1"/"H4" versions are x2 / x8 on M30 bars.
import { LIVE, decisions, aligned, okTime } from "./book-lib.mts";
import { m30, SYMS, START, SPLIT, END, LIVE_RULES, runPairs, sumLine, account, type Rules } from "./r-lib.mts";
import { commissionBps } from "./cand-lib.mts";

type F = (c: number[], m: number) => Int8Array;
const rets = (c: number[]) => c.map((x, i) => (i ? Math.log(x / c[i - 1]) : 0));
function zstate(c: number[], L: number) { const z = new Float64Array(c.length); let s = 0, s2 = 0;
  for (let i = 0; i < c.length; i++) { s += c[i]; s2 += c[i] ** 2; if (i >= L) { s -= c[i - L]; s2 -= c[i - L] ** 2; } if (i >= L) { const m = s / L, sd = Math.sqrt(Math.max(1e-18, s2 / L - m * m)); z[i] = (c[i] - m) / sd; } } return z; }
const pct = (hist: number[], x: number) => hist.filter((v) => v < x).length / hist.length;
const V: Record<string, F> = {
  kramers_moyal: (c, m) => { const L = 96 * m, W = 3000, h = 8 * m, z = zstate(c, L), v = new Int8Array(c.length), bins = [-Infinity, -2, -1, -0.3, 0.3, 1, 2, Infinity];
    for (let i = L + W + h; i < c.length; i += 1) { if (i % (2 * m) && v[i - 1] !== undefined) { v[i] = v[i - 1]; continue; } // refit every 2m bars
      const bi = bins.findIndex((b, k) => z[i] >= b && z[i] < bins[k + 1]); const ys: number[] = [];
      for (let k = i - W; k < i - h; k++) if (z[k] >= bins[bi] && z[k] < bins[bi + 1]) ys.push(Math.log(c[k + h] / c[k]));
      if (ys.length < 30) continue; const mu = ys.reduce((a, b) => a + b, 0) / ys.length, se = Math.sqrt(ys.reduce((a, b) => a + (b - mu) ** 2, 0) / ys.length / ys.length);
      v[i] = Math.abs(mu) > 1.5 * se ? Math.sign(mu) as any : 0; } return v; },
  quantum_well: (c, m) => { const L = 96 * m, W = 3000, z = zstate(c, L), v = new Int8Array(c.length); const grid = Array.from({ length: 41 }, (_, k) => -4 + k * 0.2); const forces: number[] = [];
    for (let i = L + W; i < c.length; i++) { if (i % (2 * m)) { v[i] = v[i - 1]; continue; }
      const hist = new Float64Array(41); for (let k = i - W; k < i; k++) { const g = Math.round((Math.max(-4, Math.min(4, z[k])) + 4) / 0.2); hist[g]++; }
      const p = (g: number) => (hist[Math.max(0, Math.min(40, g))] + 1) / (W + 41); const g = Math.round((Math.max(-4, Math.min(4, z[i])) + 4) / 0.2);
      const force = -(-Math.log(p(g + 1)) + Math.log(p(g - 1))) / 0.4; forces.push(Math.abs(force)); if (forces.length > 500) forces.shift();
      v[i] = forces.length > 100 && pct(forces, Math.abs(force)) > 0.7 ? Math.sign(force) as any : 0; } return v; },
  fluid_reynolds: (c, m) => { const r = rets(c), L = 48 * m, v = new Int8Array(c.length); const re: number[] = [];
    for (let i = L; i < c.length; i++) { let s = 0, s2 = 0; for (let k = i - L + 1; k <= i; k++) { s += r[k]; s2 += r[k] ** 2; } const mu = s / L, va = Math.max(1e-14, s2 / L - mu * mu);
      const R = Math.abs(mu) * L / (va * L) * Math.sqrt(va); re.push(R); if (re.length > 2000) re.shift(); v[i] = re.length > 300 && pct(re, R) > 0.7 ? Math.sign(mu) as any : 0; } return v; },
  burgers_shock: (c, m) => { const r = rets(c), a = 2 / (12 * m + 1), v = new Int8Array(c.length); let u = 0, up = 0, upp = 0; const sh: number[] = [];
    for (let i = 1; i < c.length; i++) { upp = up; up = u; u = u + a * (r[i] - u); const ux = u - up, uxx = u - 2 * up + upp, nu = 1;
      const S = Math.abs(u * ux) / (nu * Math.abs(uxx) + 1e-12); sh.push(S); if (sh.length > 2000) sh.shift(); v[i] = sh.length > 300 && pct(sh, S) > 0.9 ? -Math.sign(u) as any : 0; } return v; },
};
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const dow = (s: string, i: number) => new Date(m30[s].t[i] + 1800_000).getUTCDay();
const WKR: Rules = { ...LIVE_RULES, hold: 300, entry: (s, i) => dow(s, i) <= 2 };
const dec = decisions(LIVE), base = runPairs(dec, WKR);
// correlation with the existing poll direction (how different is the new voter?)
const agreeWithPoll = (id: string) => { let a = 0, n = 0; for (const s of SYMS) { const v = aligned.M30[s][id]; for (let i = 0; i < v.length; i += 3) if (v[i] && dec[s][i].d) { n++; if (v[i] === dec[s][i].d) a++; } } return n ? a / n : NaN; };
console.log("weekly cycle, 60 voters".padEnd(34), sumLine(base));
for (const [id, f] of Object.entries(V)) {
  const rows = [1, 2, 8].map((m) => { const vid = `${id}_x${m}`; for (const s of SYMS) aligned.M30[s][vid] = f(m30[s].c, m);
    const tr: number[] = [], te: number[] = []; let n = 0, vo = 0;
    for (const s of SYMS) { const b = m30[s], a = aligned.M30[s][vid]; for (let i = 1; i + 193 < b.t.length; i += 2) { if (b.t[i] < START || !okTime(b.t[i] + 1800_000)) continue; n++; if (!a[i]) continue; vo++;
      const r = a[i] * (b.c[i + 192] - b.o[i + 1]) / b.o[i + 1] * 1e4 - commissionBps(b.t[i + 1]); (b.t[i] < SPLIT ? tr : te).push(r); } }
    return { vid, sel: mean(tr), test: mean(te), cover: vo / n }; });
  console.log(`\n${id}: alone, bps per vote over 4 days after commission:`, rows.map((r) => `${r.vid.slice(-3)} sel ${r.sel.toFixed(1)} test ${r.test.toFixed(1)} (votes ${(100 * r.cover).toFixed(0)}%, agrees with poll ${(100 * agreeWithPoll(r.vid)).toFixed(0)}%)`).join(" | "));
  const best = rows.reduce((a, r) => (r.sel > a.sel ? r : a));
  console.log(`  + ${best.vid} in the poll`.padEnd(34), sumLine(runPairs(decisions([...LIVE, { id: best.vid, tf: "M30" }]), WKR)));
}
