import fs from "node:fs";
import { B, bars, votes, SYMS, SPLIT, WARM, canOpen, simTrade, STRAT_IDS, FAMILY, type Fill, type Bracket } from "./poll-lib.mts";
export interface PollCfg { name: string; ids: string[]; agree: number; minPart: number; br: Bracket; session: boolean; maxOpen: number; dailyLoss: number }
export function runPoll(cfg: PollCfg, from: number, to: number) {
  // Candidate signals: every bar where the poll clears the bar; then a time-ordered portfolio walk.
  const sigs: { s: string; i: number; t: number; dir: 1 | -1; share: number }[] = [];
  for (const s of SYMS) {
    const b = bars[s], vs = cfg.ids.map((id) => votes[s][id]);
    for (let i = 1; i < b.c.length - 1; i++) {
      const close = b.t[i] + 1800_000;
      if (b.t[i] < from || b.t[i] >= to || !canOpen(close, cfg.session)) continue;
      let up = 0, dn = 0; for (const v of vs) { if (v[i] > 0) up++; else if (v[i] < 0) dn++; }
      const p = up + dn; if (p < cfg.minPart) continue;
      if (up / p >= cfg.agree) sigs.push({ s, i, t: close, dir: 1, share: up / p });
      else if (dn / p >= cfg.agree) sigs.push({ s, i, t: close, dir: -1, share: dn / p });
    }
  }
  sigs.sort((a, b) => a.t - b.t || b.share - a.share);
  const open: Fill[] = [], trades: Fill[] = [];
  let day = "", realized = 0, equity = 5;
  for (const g of sigs) {
    for (let k = open.length - 1; k >= 0; k--) if (open[k].exitAt <= g.t) { const f = open.splice(k, 1)[0]; equity += f.pnl; if (new Date(f.exitAt).toISOString().slice(0, 10) === day) realized += f.pnl; }
    const d = new Date(g.t).toISOString().slice(0, 10); if (d !== day) { day = d; realized = 0; }
    if (open.length >= cfg.maxOpen || open.some((f) => f.sym === g.s) || equity < 1.2) continue;
    const f = simTrade(g.s, g.i, g.dir, cfg.br); if (!f) continue;
    const worstOpen = open.reduce((x, o) => x + o.risk, 0);
    if (-Math.min(0, realized) + worstOpen + f.risk > cfg.dailyLoss * equity) continue;
    open.push(f); trades.push(f);
  }
  return trades;
}
export function summary(tr: Fill[]) {
  const net = tr.reduce((a, f) => a + f.pnl, 0), w = tr.filter((f) => f.pnl > 0).length;
  let eq = 0, pk = 0, dd = 0; for (const f of [...tr].sort((a, b) => a.exitAt - b.exitAt)) { eq += f.pnl; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }
  const months: Record<string, number> = {}; for (const f of tr) { const m = new Date(f.at).toISOString().slice(0, 7); months[m] = +((months[m] ?? 0) + f.pnl).toFixed(2); }
  const oc: Record<string, number> = {}; for (const f of tr) oc[f.outcome] = (oc[f.outcome] ?? 0) + 1;
  return { n: tr.length, win: +(100 * w / (tr.length || 1)).toFixed(1), net: +net.toFixed(2), perTrade: +(net / (tr.length || 1)).toFixed(3), R: +tr.reduce((a, f) => a + f.pnl / f.risk, 0).toFixed(1), dd: +dd.toFixed(2), oc, months };
}
