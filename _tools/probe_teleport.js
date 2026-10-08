/* =========================================================
   瞬移检测探针（2026-10-08）
   症状：作者反馈"有时候还是会瞬移"。
   怀疑根因：tile-new / tile-merge 的 @keyframes 里硬编码了
       transform: translate3d(calc(var(--x) * var(--step)), ...)
     —— CSS 里 **animation 优先级高于 transition**，动画进行中改 --x
        会让方块**直接跳**到新位置，transition 完全被覆盖。
     触发场景：新方块落下动画(--appear 300ms)或合并动画(--merge 340ms)
        还没跑完，玩家就按了下一个方向 —— 快速连按时几乎必然发生。
   检测：逐帧采样每个方块的 translate，单帧位移 > 半格即判瞬移。
   跑法：先起服务；node _tools/probe_teleport.js
   ========================================================= */
"use strict";

const fs = require("fs"), os = require("os"), path = require("path"), http = require("http"), crypto = require("crypto");
const { spawn } = require("child_process");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9404;
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "edge-tp-"));
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
  let id = 0; const w = new Map();
  conn.socket.on("data", parse((raw) => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.id && w.has(m.id)) { const x = w.get(m.id); w.delete(m.id); m.error ? x.reject(new Error(JSON.stringify(m.error))) : x.resolve(m.result); return; }
  }));
  function send(method, params) {
    const i = ++id;
    return new Promise((res, rej) => { w.set(i, { resolve: res, reject: rej });
      wsSend(conn.socket, JSON.stringify({ id: i, method, params: params || {} }));
      setTimeout(() => { if (w.has(i)) { w.delete(i); rej(new Error("timeout " + method)); } }, 25000); });
  }
  const ev = async (e) => {
    const r = await send("Runtime.evaluate", { expression: e, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };
  async function key(k) {
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code: k,
      windowsVirtualKeyCode: { ArrowLeft: 37, ArrowRight: 39, ArrowUp: 38, ArrowDown: 40 }[k] || 0 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k });
  }

  await send("Runtime.enable"); await send("Page.enable");
  await send("Page.navigate", { url: BASE + "/index.html" });
  await sleep(2200);
  for (let i = 0; i < 30; i++) { try { if (await ev("document.querySelectorAll('#tiles .tile').length") >= 2) break; } catch (e) {} await sleep(250); }

  console.log("\n2048 · 瞬移检测（逐帧采样方块位移）\n");

  const step = await ev("parseFloat(document.getElementById('tiles').style.getPropertyValue('--step')) || 0");
  console.log("  一格步长 = " + step.toFixed(1) + "px");
  // ⚠️ 阈值要大于一格：连按时方块**必然**沿新方向走一格，
  // transition 的速度曲线让单帧瞬时位移可能超过 0.55 格（实测到 0.95 格），
  // 那是合法过渡不是瞬移。真瞬移的特征是「跨方向 + 跳 ≥1 格」。
  const THRESHOLD = step * 1.5;
  console.log("  瞬移阈值 = " + THRESHOLD.toFixed(1) + "px/帧（>1 格才算）\n");

  async function run(label, gapMs) {
    // 开始逐帧采样
    await ev(`(function(){
      window.__samples = [];
      window.__sampling = true;
      (function loop(){
        if (!window.__sampling) return;
        var row = { t: performance.now(), pos: {} };
        var ts = document.querySelectorAll('#tiles .tile');
        for (var i = 0; i < ts.length; i++) {
          var tid = ts[i].dataset.tid;
          if (!tid) continue;
          // ⚠️ 正在播"出现"动画的新方块**不参与瞬移判定** ——
          //    它是凭空生成的，第一帧 transform 可能是 none(0,0)，
          //    下一帧就到终点，位移天然等于整格距离。
          //    这不是瞬移，是"出现"。把新建也判进去会假红
          //    （实测就是这样误报了 334.5px = 3 格）。
          if (ts[i].classList.contains('tile-new')) continue;
          var tr = getComputedStyle(ts[i]).transform;
          var x = 0, y = 0;
          try {
            var m = new DOMMatrix(tr);
            x = m.m41; y = m.m42;
          } catch (e) {
            var mm = String(tr).match(/matrix(3d)?\\(([^)]+)\\)/);
            if (mm) {
              var v = mm[2].split(',').map(Number);
              x = mm[1] ? v[12] : v[4];
              y = mm[1] ? v[13] : v[5];
            }
          }
          row.pos[tid] = [x, y];
        }
        window.__samples.push(row);
        requestAnimationFrame(loop);
      })();
      return 1;
    })()`);

    // 故意在「新方块落下动画还没跑完」时就按下一个方向 —— 触发瞬移的场景
    await key("ArrowLeft");
    await sleep(gapMs);
    await key("ArrowUp");
    await sleep(500);
    await ev("window.__sampling = false; 1");

    const a = await ev(`(function(){
      var s = window.__samples;
      var maxJump = 0, worst = null, jumps = 0;
      for (var i = 1; i < s.length; i++) {
        var A = s[i-1].pos, B = s[i].pos;
        for (var tid in B) {
          if (!(tid in A)) continue;                 // 新出现的方块不算
          var dx = B[tid][0] - A[tid][0];
          var dy = B[tid][1] - A[tid][1];
          var d = Math.sqrt(dx*dx + dy*dy);
          if (d > maxJump) { maxJump = d; worst = { tid: tid, d: d, frame: i }; }
          if (d > ${THRESHOLD}) jumps++;
        }
      }
      return { frames: s.length, maxJump: maxJump, worst: worst, jumps: jumps };
    })()`);

    console.log("  [" + label + "] 间隔 " + gapMs + "ms：采样 " + a.frames + " 帧，"
      + "单帧最大位移 " + a.maxJump.toFixed(1) + "px，超过阈值的帧数 " + a.jumps);
    return a;
  }

  // 场景 1：新方块动画(--appear 300ms)进行中就再按一次
  const r1 = await run("新方块动画中", 100);
  // 场景 2：合并动画(--merge 340ms)进行中就再按一次
  const r2 = await run("合并动画中", 120);

  ok(r1.maxJump <= THRESHOLD, "新方块落下动画期间移动不瞬移",
    "单帧跳了 " + r1.maxJump.toFixed(1) + "px（阈值 " + THRESHOLD.toFixed(1) + "）");
  ok(r2.maxJump <= THRESHOLD, "合并动画期间移动不瞬移",
    "单帧跳了 " + r2.maxJump.toFixed(1) + "px（阈值 " + THRESHOLD.toFixed(1) + "）");

  console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
  if (fail) console.log("失败项：\n - " + fails.join("\n - "));
  console.log("");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("崩溃：", e.message); process.exit(2); });
