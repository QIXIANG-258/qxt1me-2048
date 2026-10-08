/* 拍一张「达成里程碑」的现场图 —— 用来肉眼确认礼花真的在放、弹窗真在显示。
   跑法：先起 8793 服务，再 node _tools/shoot_milestone.js */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const EDGE = process.env.EDGE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = Number(process.env.CDP_PORT || 9491);
const BASE = process.env.PROBE_URL || "http://127.0.0.1:8793";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "g2048-shot-"));
  const child = spawn(EDGE, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars",
    "--remote-debugging-port=" + PORT, "--user-data-dir=" + tmp,
    "--window-size=1280,900", "--no-proxy-server", "about:blank",
  ], { stdio: "ignore" });

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(300);
    try {
      const body = await new Promise((res, rej) => {
        http.get({ host: "127.0.0.1", port: PORT, path: "/json/list" }, (r) => {
          let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => res(d));
        }).on("error", rej);
      });
      target = JSON.parse(body).find((t) => t.type === "page" && t.webSocketDebuggerUrl) || null;
    } catch (e) {}
  }
  if (!target) { console.error("no target"); process.exit(2); }

  // 直接用 ws 模块（比手搓帧简单，这里不是发布物）
  const WebSocket = require("ws");
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 1 << 28 });
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  let id = 0; const waiting = new Map();
  ws.on("message", (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  });
  const send = (method, params) => new Promise((res) => {
    const mid = ++id; waiting.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  const ev = async (e) => {
    const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  await send("Page.enable");
  await send("Runtime.enable");

  // 种一个「已达 2048 且已选继续」的局面，合并出 4096 → 触发礼花
  const payload = { cells: [[0, 0, 2048], [1, 0, 2048]], score: 4096, best: 4096,
                    won: true, reached: 2048, over: false, keep: true };
  await send("Page.navigate", { url: BASE + "/index.html" });
  await sleep(1500);
  await ev("localStorage.setItem('g2048State', " + JSON.stringify(JSON.stringify(payload)) + ")");
  await send("Page.navigate", { url: BASE + "/index.html" });
  await sleep(1800);

  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "ArrowLeft", code: "ArrowLeft",
    windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowLeft", code: "ArrowLeft" });

  // 等到礼花确实在飞（canvas 存在且有内容）再截图
  let got = false;
  for (let i = 0; i < 40; i++) {
    await sleep(120);
    const st = await ev(`(function(){
      var cv=document.getElementById('confetti');
      if(!cv) return null;
      var ctx=cv.getContext('2d');
      var d=ctx.getImageData(0,0,cv.width,cv.height).data;
      var n=0; for(var i=3;i<d.length;i+=4*97){ if(d[i]>8) n++; }
      return {w:cv.width,h:cv.height,nonEmptySamples:n,
              title:(document.getElementById('ovTitle').textContent||'').trim(),
              overlay:!document.getElementById('overlay').hidden};
    })()`);
    if (st && st.nonEmptySamples > 0) {
      console.log("礼花已绘制：canvas " + st.w + "x" + st.h +
                  "，非空采样 " + st.nonEmptySamples + "，弹窗标题 " + JSON.stringify(st.title) +
                  "，弹窗可见 " + st.overlay);
      got = true;
      break;
    }
  }
  if (!got) console.log("⚠ 没等到礼花绘制出内容");

  const out = path.join(__dirname, "..", "_shots", "milestone-4096.png");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const shot = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(out, Buffer.from(shot.result.data, "base64"));
  console.log("saved " + out);

  try { ws.close(); } catch (e) {}
  try { child.kill(); } catch (e) {}
  process.exit(got ? 0 : 1);
})().catch((e) => { console.error("ERR " + e.message); process.exit(2); });
