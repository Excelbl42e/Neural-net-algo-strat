import fs from "node:fs";
const c = JSON.parse(fs.readFileSync(new URL("./data", import.meta.url).pathname + "/candidates.json", "utf8"));
const k: Record<string, number> = {};
for (const x of c) {
  const buy = x.dir === "buy";
  const stopBad = buy ? !(x.stop < x.lo) : !(x.stop > x.hi);
  const tgtBad = buy ? !(x.target > x.hi) : !(x.target < x.lo);
  if (!stopBad && !tgtBad) continue;
  const key = `${stopBad ? "stop inside/beyond zone" : ""}${stopBad && tgtBad ? " + " : ""}${tgtBad ? "target inside zone" : ""}`;
  k[key] = (k[key] ?? 0) + 1;
  if ((k[key] ?? 0) <= 2) console.log(key, x.sym, x.dir, "stop", x.stop, "zone", x.lo, "-", x.hi, "target", x.target);
}
console.log(k);
