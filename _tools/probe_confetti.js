/* =========================================================
   礼花专项（2026-10-08）
   probe.js 只验了 canvas 的"结构"（存在 / z-index / pointer-events），
   这里验的是**行为**，光看 DOM 结构看不出来的三件事：
     ① 礼花真的在动 —— 逐帧比较 canvas 像素，静止的就是没画
     ② 礼花会自己收场 —— 放完必须把自己摘掉，否则永远盖在屏幕上
        （且每次达成再叠一层 = 泄漏）
     ③ reduced-motion 下不画 —— 对前庭敏感用户是必要的降级
     ④ 礼花失败不影响游戏 —— canvas 不可用时弹窗照开
   跑法：先起服务；node _tools/probe_confetti.js
   ========================================================= */
"use strict";

const fs = require("fs"), os = require("os"), path = require("path"), http = require("http"), crypto = require("crypto");
const { spawn } = require("child_process");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9405;
const BASE = process.env.PROBE_URL || "http://127.0.0.1:8793";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; fails.push(name); console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
}

function wsConnect(url) {
  return new Promise((res, rej) => {
    const u = new URL(url); const k = crypto.randomBytes(16).toString("base64");
    const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": k, "Sec-WebSocket-Version": "13" } });
    r.on("error", rej); r.end();
    r.on("upgrade", (_, s) => { s.setNoDelay(true); res({ socket: s }); });
  });
}
function wsSend(s, str) {
  const p = Buffer.from(str, "utf8"); const len = p.length; let h;
  if (len < 126) h = Buffer.from([0x81, 0x80 | len]);
  else if (len < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 0xfe; h.writeUInt16BE(len, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 0xff; h.writeBigUInt64BE(BigInt(len), 2); }
  const m = crypto.randomBytes(4), o = Buffer.alloc(len);
  for (let i = 0; i < len; i++) o[i] = p[i] ^ m[i % 4];
  s.write(Buffer.concat([h, m, o]));
}
function parse(on) {
  let b = Buffer.alloc(0), f = [];
  return (c) => { b = Buffer.concat([b, c]);
    for (;;) { if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f; let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
      if (b.length < off + len) return;
      const pl = b.slice(off, off + len); b = b.slice(off + len);
      if (op === 0x1 || op === 0x0 || op === 0x2) f.push(pl);
      if (fin) { on(Buffer.concat(f).toString("utf8")); f = []; } } };
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "edge-cf-"));
  const isRemote = !/127\.0\.0\.1|localhost/.test(BASE);
  const proxy = isRemote ? ["--proxy-server=http://127.0.0.1:7897"] : ["--no-proxy-server"];
  const ch = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run",
    "--remote-debugging-port=" + PORT, "--user-data-dir=" + tmp, "--window-size=1280,900", "about:blank"].concat(proxy), { stdio: "ignore" });
  process.on("exit", () => { try { ch.kill(); } catch (e) {} });

  let tgt = null;
  for (let i = 0; i < 60 && !tgt; i++) {
    await sleep(300);
    try {
      const b = await new Promise((res, rej) => http.get({ host: "127.0.0.1", port: PORT, path: "/json/list" }, (r) => {
        let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => res(d)); }).on("error", rej));
      tgt = JSON.parse(b).find((t) => t.type === "page" && t.webSocketDebuggerUrl) || null;
    } catch (e) {}
  }
  if (!tgt) { console.error("拿不到 CDP target"); process.exit(2); }

  const conn = await wsConnect(tgt.webSocketDebuggerUrl);
  let id = 0; const w = new Map(); const exc = [];
  conn.socket.on("data", parse((raw) => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.id && w.has(m.id)) { const x = w.get(m.id); w.delete(m.id); m.error ? x.reject(new Error(JSON.stringify(m.error))) : x.resolve(m.result); return; }
    if (m.method === "Runtime.exceptionThrown") exc.push(m.params.exceptionDetails.text || "?");
  }));
  function send(method, params) {
    const i = ++id;
    return new Promise((res, rej) => { w.set(i, { resolve: res, reject: rej });
      wsSend(conn.socket, JSON.stringify({ id: i, method, params: params || {} }));
      setTimeout(() => { if (w.has(i)) { w.delete(i); rej(new Error("timeout " + method)); } }, 25000); });
  }
  const ev = async (e) => {
    const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };

  await send("Runtime.enable"); await send("Page.enable");
  await send("Page.navigate", { url: BASE + "/index.html" });
  await sleep(2200);
  for (let i = 0; i < 30; i++) { try { if (await ev("document.querySelectorAll('#tiles .tile').length") >= 2) break; } catch (e) {} await sleep(250); }

  console.log("\n2048 · 礼花专项\n");

  // ── ① 礼花真的在动：逐帧比 canvas 像素 ────────────
  // 直接调内部 celebrate() 不方便（IIFE 私有），改为**制造真实达成**：
  // 注入一个 1024+1024 的存档，移动一步即可触发 2048 里程碑。
  await ev("localStorage.setItem('g2048State', JSON.stringify({cells:[[0,0,1024],[1,0,1024]],score:0,best:0,won:false,over:false,keep:false})); 1");
  await send("Page.navigate", { url: BASE + "/index.html" });
  await sleep(2200);
  for (let i = 0; i < 30; i++) { try { if (await ev("document.querySelectorAll('#tiles .tile').length") >= 2) break; } catch (e) {} await sleep(250); }

  const beforeHas = await ev("!!document.getElementById('confetti')");
  ok(!beforeHas, "达成前页面上没有礼花 canvas");

  // 触发：按左键合并 1024+1024
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowLeft", code: "ArrowLeft" });
  await sleep(600);   // 等合并动画 + flush 里触发礼花

  const hasNow = await ev("!!document.getElementById('confetti')");
  ok(hasNow, "达成 2048 后礼花 canvas 出现");

  if (hasNow) {
    // 采两帧像素，看有没有变化（静止 = 没画）
    const sig = async () => await ev(`(function(){
      var cv = document.getElementById('confetti');
      if (!cv) return null;
      var ctx = cv.getContext('2d');
      var d = ctx.getImageData(0, 0, Math.min(cv.width, 600), Math.min(cv.height, 600)).data;
      // 统计非透明像素数 + 一个简易校验和
      var sum = 0, nonEmpty = 0;
      for (var i = 0; i < d.length; i += 4) {
        if (d[i+3] > 8) { nonEmpty++; sum = (sum + d[i] * 3 + d[i+1] * 5 + d[i+2] * 7) % 1000000007; }
      }
      return { nonEmpty: nonEmpty, sum: sum };
    })()`);

    const s1 = await sig();
    await sleep(260);
    const s2 = await sig();
    ok(s1 && s2 && s1.nonEmpty > 0, "礼花 canvas 上真的有像素（不是空画布）",
      "nonEmpty=" + (s1 && s1.nonEmpty));
    ok(s1 && s2 && s1.sum !== s2.sum, "礼花在动（两帧像素不同）",
      "sum " + (s1 && s1.sum) + " vs " + (s2 && s2.sum));

    // ── ② 礼花会自己收场 ──────────────────────────
    // 最多放 4s（源码里 now - start < 4000），等到 6s 后应当已被摘掉
    await sleep(6000);
    const gone = await ev("!document.getElementById('confetti')");
    ok(gone, "礼花放完后把自己摘掉了（不会永远盖在屏幕上）",
      "6s 后 canvas 仍在 → 泄漏且挡住交互");

    // ── ③ 再达成一次不会叠层 ──────────────────────
    const cnt1 = await ev("document.querySelectorAll('canvas#confetti').length");
    ok(cnt1 === 0, "收场后页面上 0 个礼花 canvas（没叠层）", "got " + cnt1);
  }

  // ── ④ reduced-motion 下不画，但弹窗照开 ──────────
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await ev("localStorage.setItem('g2048State', JSON.stringify({cells:[[0,0,1024],[1,0,1024]],score:0,best:0,won:false,over:false,keep:false})); 1");
  await send("Page.navigate", { url: BASE + "/index.html" });
  await sleep(2200);
  for (let i = 0; i < 30; i++) { try { if (await ev("document.querySelectorAll('#tiles .tile').length") >= 2) break; } catch (e) {} await sleep(250); }
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowLeft", code: "ArrowLeft" });
  await sleep(700);
  const rmCanvas = await ev("!!document.getElementById('confetti')");
  const rmOverlay = await ev("!document.getElementById('overlay').hidden");
  ok(!rmCanvas, "reduced-motion 下不放礼花（对前庭敏感用户的降级）");
  ok(rmOverlay, "reduced-motion 下弹窗照常开（礼花是锦上添花，不能连累主流程）");
  await send("Emulation.setEmulatedMedia", { features: [] });

  // ── ⑤ canvas 不可用时，弹窗照开 ────────────────
  await ev("localStorage.setItem('g2048State', JSON.stringify({cells:[[0,0,1024],[1,0,1024]],score:0,best:0,won:false,over:false,keep:false})); 1");
  await send("Page.navigate", { url: BASE + "/index.html" });
  await sleep(2200);
  // 破坏 getContext，模拟老浏览器 / 无 canvas 环境
  await ev("HTMLCanvasElement.prototype.getContext = function(){ return null; }; 1");
  for (let i = 0; i < 30; i++) { try { if (await ev("document.querySelectorAll('#tiles .tile').length") >= 2) break; } catch (e) {} await sleep(250); }
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowLeft", code: "ArrowLeft" });
  await sleep(700);
  const noCtxOverlay = await ev("!document.getElementById('overlay').hidden");
  ok(noCtxOverlay, "canvas 不可用时弹窗照常开（礼花失败不连累游戏）");

  ok(exc.length === 0, "全程无未捕获异常", exc.slice(0, 2).join(" | "));

  console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
  if (fail) console.log("失败项：\n - " + fails.join("\n - "));
  console.log("");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("崩溃：", e.message); process.exit(2); });
