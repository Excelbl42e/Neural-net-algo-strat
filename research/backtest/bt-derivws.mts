// Minimal Deriv public-WS client tunnelled through the sandbox's HTTPS proxy.
import WebSocket from "ws";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import fs from "node:fs";
const proxy = new URL(process.env.HTTPS_PROXY!);
const ca = fs.readFileSync("/root/.ccr/ca-bundle.crt");
class TunnelAgent extends https.Agent {
  createConnection(opts: any, cb: any) {
    const r = http.request({ host: proxy.hostname, port: Number(proxy.port), method: "CONNECT", path: `${opts.host}:443` });
    r.on("connect", (_res, socket) => cb(null, tls.connect({ socket, servername: opts.host, ca })));
    r.on("error", (e) => cb(e));
    r.end();
    return undefined as any;
  }
}
export async function openPublic() {
  const ws = new WebSocket("wss://api.derivws.com/trading/v1/options/ws/public", { agent: new TunnelAgent() });
  let id = 0; const pending = new Map<number, (m: any) => void>();
  ws.on("message", (raw) => { const m = JSON.parse(raw.toString()); const cb = pending.get(m.req_id); if (cb) { pending.delete(m.req_id); cb(m); } });
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  const req = (o: any) => new Promise<any>((res) => { const r = ++id; pending.set(r, res); ws.send(JSON.stringify({ ...o, req_id: r })); });
  return { req, close: () => ws.close() };
}
