import fs from "node:fs";
import { m30, SYMS, SPLIT, START, aligned, loadTF, commissionBps, canOpen, exitIndex } from "./cand-lib.mts";
import { POLL_TIMEFRAME } from "../../artifacts/api-server/src/lib/poll-engine.ts";
import { STRATEGIES } from "../../artifacts/api-server/src/lib/poll-strategies.ts";
const B = new URL("./data", import.meta.url).pathname + "";
for (const tf of ["M30", "H1", "H4"]) { loadTF(tf); loadTF(tf, `${B}/votes-new-${tf}.json`); }
const NEW = ["cot_extremes", "cot_flow_reversal", "lyapunov_regime", "recurrence_determinism", "phase_space_analogues"];
const fam = Object.fromEntries(STRATEGIES.map((s) => [s.id, s.family]));
// Single-voter score: every vote, hourly samples, 4-day hold (Friday cut), net of commission, selection period only.
function score(id: string, tf: string, from = START, to = SPLIT) {
  const a: number[] = [];
  for (const s of SYMS) { const b = m30[s], v = aligned[tf][s][id];
    for (let i = 1; i < b.t.length - 1; i += 2) { const d = v[i]; if (!d || b.t[i] < from || b.t[i] >= to || !canOpen(b.t[i] + 1800_000) || b.t[i + 1] - b.t[i] > 1800_000) continue;
      const e = exitIndex(s, i, 192), e0 = b.o[i + 1]; a.push(d * (b.c[e] - e0) / e0 * 1e4 - commissionBps(b.t[i + 1])); } }
  return { n: a.length, m: a.length ? a.reduce((x, y) => x + y, 0) / a.length : -99 };
}
const newChoice = NEW.map((id) => { const best = ["M30", "H1", "H4"].map((tf) => ({ tf, ...score(id, tf) })).sort((a, b) => b.m - a.m)[0]; return { id, tf: best.tf, m: best.m, n: best.n }; });
console.log("new voters (best timeframe, Nov-Jun bps/trade):", newChoice.map((c) => `${c.id}@${c.tf} ${c.m.toFixed(1)} (${c.n})`).join(", "));
const current = Object.entries(POLL_TIMEFRAME).map(([id, tf]) => ({ id, tf, ...score(id, tf) }));
const weakQuant = current.filter((c) => fam[c.id] === "quant").sort((a, b) => a.m - b.m).slice(0, 5);
console.log("weakest current quant voters:", weakQuant.map((c) => `${c.id}@${c.tf} ${c.m.toFixed(1)}`).join(", "));
function poll(voters: { id: string; tf: string }[], from: number, to: number) {
  const out: number[] = [];
  for (const s of SYMS) { const b = m30[s], vs = voters.map((v) => aligned[v.tf][s][v.id]); let busy = -1;
    for (let i = 1; i < b.t.length - 1; i++) {
      if (i <= busy || b.t[i] < from || b.t[i] >= to || !canOpen(b.t[i] + 1800_000) || b.t[i + 1] - b.t[i] > 1800_000) continue;
      let up = 0, dn = 0; for (const v of vs) { if (v[i] > 0) up++; else if (v[i] < 0) dn++; }
      if (up + dn < 30 || up === dn) continue;
      const d = up > dn ? 1 : -1, e = exitIndex(s, i, 192), e0 = b.o[i + 1]; out.push(d * (b.c[e] - e0) / e0 * 1e4 - commissionBps(b.t[i + 1])); busy = e; } }
  return `${(out.reduce((a, x) => a + x, 0) / out.length).toFixed(1)} bps/trade, win ${(100 * out.filter((x) => x > 0).length / out.length).toFixed(0)}% (${out.length})`;
}
const base = current.map(({ id, tf }) => ({ id, tf }));
const drop = new Set(weakQuant.map((c) => c.id));
const upgraded = [...base.filter((v) => !drop.has(v.id)), ...newChoice.map(({ id, tf }) => ({ id, tf }))];
const onlyCot = [...base.filter((v) => !drop.has(v.id) || !["", ""].includes(v.id)).filter((v) => !weakQuant.slice(0, 2).some((w) => w.id === v.id)), ...newChoice.filter((c) => c.id.startsWith("cot")).map(({ id, tf }) => ({ id, tf }))];
const onlyChaos = [...base.filter((v) => !weakQuant.slice(0, 3).some((w) => w.id === v.id)), ...newChoice.filter((c) => !c.id.startsWith("cot")).map(({ id, tf }) => ({ id, tf }))];
for (const [name, set] of [["current 60", base], ["+ COT (2 swapped in)", onlyCot], ["+ chaos (3 swapped in)", onlyChaos], ["+ COT + chaos (5 swapped in)", upgraded]] as const)
  console.log(name.padEnd(30), `${(set as any[]).length} voters | Nov-Jun: ${poll(set as any, START, SPLIT)} | Jul-Sep: ${poll(set as any, SPLIT, Infinity)}`);
fs.writeFileSync(`${B}/upgrade-sets.json`, JSON.stringify({ base, onlyCot, onlyChaos, upgraded, newChoice, weakQuant }));
