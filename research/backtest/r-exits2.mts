// Exits re-checked under the Mon-Tue entry rule: stop x target, hold until Friday, break-even.
import { LIVE, decisions } from "./book-lib.mts";
import { m30, LIVE_RULES, runPairs, sumLine, type Rules } from "./r-lib.mts";

const dec = decisions(LIVE);
const dow = (s: string, i: number) => new Date(m30[s].t[i] + 1800_000).getUTCDay();
const MT: Rules = { ...LIVE_RULES, entry: (s, i) => dow(s, i) <= 2 };
const show = (n: string, R: Rules) => console.log(n.padEnd(36), sumLine(runPairs(dec, R)));
show("Mon-Tue, live exits", MT);
for (const stop of [0.005, 0.006, 0.007, 0.0078]) for (const rr of [1, 1.5, 2, 3, null]) show(`stop ${(stop * 100).toFixed(2)}% target ${rr ?? "none"}`, { ...MT, stop, rr });
for (const hold of [144, 192, 240, 300]) show(`hold ${hold / 48} days (Friday close still applies)`, { ...MT, hold });
for (const be of [0.004, 0.005, 0.006]) show(`break-even after +${(be * 100).toFixed(1)}%`, { ...MT, be });
