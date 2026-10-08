/* 404 页面专项检查：app.js 在没有棋盘时也必须安静退场，不能报错。 */
"use strict";
const path = require("path");
// 独立实现一份精简 CDP 客户端（probe.js 的客户端不方便导出复用）。
const fs = require("fs"), os = require("os"), http = require("http"), crypto = require("crypto");
const { spawn } = require("child_process");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9395;
const BASE = process.env.PROBE_URL || "http://127.0.0.1:8793";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString("base64");
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13" } });
    req.on("error", reject); req.end();
    req.on("upgrade", (res, socket) => { socket.setNoDelay(true); resolve({ socket }); });
  });
}
function wsSend(sock, str) {
  const p = Buffer.from(str, "utf8"); const len = p.length; let head;
  if (len < 126) head = Buffer.from([0x81, 0x80 | len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0xfe; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0xff; head.writeBigUInt64BE(BigInt(len), 2); }
  const mask = crypto.randomBytes(4); const m = Buffer.alloc(len);
  for (let i = 0; i < len; i++) m[i] = p[i] ^ mask[i % 4];
  sock.write(Buffer.concat([head, mask, m]));
}
function parser(onMsg) {
  let buf = Buffer.alloc(0), frags = [];
  return (c) => { buf = Buffer.concat([buf, c]);
    for (;;) { if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0, op = buf[0] & 0x0f; let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) return;
      const pl = buf.slice(off, off + len); buf = buf.slice(off + len);
      if (op === 0x1 || op === 0x0 || op === 0x2) frags.push(pl);
      if (fin) { onMsg(Buffer.concat(frags).toString("utf8")); frags = []; } } };
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "edge-404-"));
  const child = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-proxy-server", "--no-first-run",
    "--remote-debugging-port=" + PORT, "--user-data-dir=" + tmp, "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
  process.on("exit", () => { try { child.kill(); } catch (e) {} });

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(300);
    try {
      const b = await new Promise((res, rej) => http.get({ host: "127.0.0.1", port: PORT, path: "/json/list" }, (r) => {
        let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => res(d)); }).on("error", rej));
      target = JSON.parse(b).find((t) => t.type === "page" && t.webSocketDebuggerUrl) || null;
    } catch (e) {}
  }
  if (!target) { console.error("无 target"); process.exit(2); }

  const conn = await wsConnect(target.webSocketDebuggerUrl);
  let id = 0; const wait = new Map(); const exc = []; const cerr = [];
  conn.socket.on("data", parser((raw) => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.id && wait.has(m.id)) { const w = wait.get(m.id); wait.delete(m.id); m.error ? w.reject(new Error(JSON.stringify(m.error))) : w.resolve(m.result); return; }
    if (m.method === "Runtime.exceptionThrown") exc.push(m.params.exceptionDetails.text || "?");
    if (m.method === "Runtime.consoleAPICalled" && /error|warning/.test(m.params.type)) cerr.push(m.params.type);
  }));
  function send(method, params) {
    const i = ++id;
    return new Promise((res, rej) => { wait.set(i, { resolve: res, reject: rej });
      wsSend(conn.socket, JSON.stringify({ id: i, method, params: params || {} }));
      setTimeout(() => { if (wait.has(i)) { wait.delete(i); rej(new Error("timeout")); } }, 15000); });
  }
  const ev = async (e) => {
    const r = await send("Runtime.evaluate", { expression: e, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };

  await send("Runtime.enable"); await send("Page.enable");
  await send("Page.navigate", { url: BASE + "/404.html" });
  await sleep(1800);

  console.log("\n404 页面检查\n");
  let pass = 0, fail = 0;
  const ok = (c, n, x) => { c ? (pass++, console.log("  ✓ " + n)) : (fail++, console.log("  ✗ " + n + (x ? " → " + x : ""))); };

  ok(exc.length === 0, "404 页无未捕获异常（app.js 无棋盘时应安静退场）", exc.join(" | "));
  ok(cerr.length === 0, "404 页无控制台 error/warning", cerr.join(","));
  ok(await ev("!!document.querySelector('.nf-code')"), "404 页渲染出 404 码");
  ok(await ev("document.querySelector('.nf-code').textContent.trim()") === "404", "404 码文案正确");
  ok(await ev("!!document.getElementById('board')") === false, "404 页没有棋盘（符合预期）");

  // 主题按钮在 404 页不存在，但语言/主题仍应可用（顶栏没有，所以只查不崩）
  console.log("\n结果：" + pass + " 通过 / " + fail + " 失败\n");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("崩溃：", e.message); process.exit(2); });
