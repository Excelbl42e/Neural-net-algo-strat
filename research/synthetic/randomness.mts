// Are Deriv synthetic indices predictable at all? Per index, on M30 returns:
//   lag-1 autocorrelation (0 = next move unrelated to this one; |x| > 2/sqrt(n) is significant),
//   variance ratio over 8 bars (1 = random walk; >1 trending, <1 mean-reverting),
//   for Boom/Crash: chance of a spike bar after N quiet bars (flat = memoryless, "never due").
import fs from "node:fs";
const raw = JSON.parse(fs.readFileSync(new URL("./data/candles.json", import.meta.url).pathname, "utf8"));
for (const [s, tf] of Object.entries<any>(raw)) {
  const c: number[] = tf.M30.map((x: number[]) => x[4]); const r = c.slice(1).map((x, i) => Math.log(x / c[i])); const n = r.length;
  const m = r.reduce((a, b) => a + b, 0) / n, v = r.reduce((a, b) => a + (b - m) ** 2, 0) / n;
  let ac = 0; for (let i = 1; i < n; i++) ac += (r[i] - m) * (r[i - 1] - m); ac /= (n - 1) * v;
  const q = 8; const rq: number[] = []; for (let i = q; i <= n; i++) { let s2 = 0; for (let k = i - q; k < i; k++) s2 += r[k]; rq.push(s2); }
  const vq = rq.reduce((a, b) => a + (b - m * q) ** 2, 0) / rq.length, vr = vq / (q * v);
  let line = `${s.padEnd(10)} lag-1 autocorr ${ac.toFixed(3).padStart(6)} (significant beyond ±${(2 / Math.sqrt(n)).toFixed(3)}) | variance ratio(8) ${vr.toFixed(3)}`;
  if (/BOOM|CRASH/.test(s)) { const up = /BOOM/.test(s); const sd = Math.sqrt(v); const spike = r.map((x) => (up ? x > 4 * sd : x < -4 * sd));
    const by: Record<string, [number, number]> = {}; let quiet = 0;
    for (let i = 0; i < n; i++) { const k = quiet < 4 ? "0-3" : quiet < 12 ? "4-11" : quiet < 24 ? "12-23" : "24+"; (by[k] ??= [0, 0])[1]++; if (spike[i]) { by[k][0]++; quiet = 0; } else quiet++; }
    line += ` | spike chance after N quiet bars: ${["0-3", "4-11", "12-23", "24+"].map((k) => `${k}: ${(100 * by[k][0] / by[k][1]).toFixed(1)}%`).join(", ")}`; }
  console.log(line);
}
