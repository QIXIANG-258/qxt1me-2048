/* =========================================================
   配色量化检查：方块 vs 空格 的明度差够不够（就是"融为一体"的根因）
   —— 不靠眼睛，直接算 WCAG 相对亮度与对比度。
   判据：
     ① 每个数值方块 vs 空格底色：亮度差 ≥ 0.05（否则分不清有没有方块）
     ② 方块数字 vs 方块底色：对比度 ≥ 3:1（大字的最低可读线）
     ③ 相邻数值之间：亮度差 ≥ 0.02（否则分不清 2 和 4）
   跑法：需先起本地服务；node _tools/check_contrast.js
   ========================================================= */
"use strict";

const fs = require("fs"), os = require("os"), path = require("path"), http = require("http"), crypto = require("crypto");
const { spawn } = require("child_process");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9403;
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "edge-cc-"));
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
      setTimeout(() => { if (w.has(i)) { w.delete(i); rej(new Error("timeout " + method)); } }, 20000); });
  }
  const ev = async (e) => {
    const r = await send("Runtime.evaluate", { expression: e, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };

  await send("Runtime.enable"); await send("Page.enable");
  await send("Page.navigate", { url: BASE + "/index.html" });
  await sleep(2200);
  for (let i = 0; i < 30; i++) { try { if (await ev("document.querySelectorAll('#tiles .tile').length") >= 2) break; } catch (e) {} await sleep(250); }

  const VALUES = [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048];

  // 在每个主题下：造出所有数值的方块，量它们的实际渲染色
  async function measure(theme) {
    await ev("document.documentElement.setAttribute('data-theme','" + theme + "')");
    await sleep(300);
    return await ev(`(function(){
      var vals = ${JSON.stringify(VALUES)};
      // 量空格底色（.cell 是叠在棋盘上的半透明层，要合成到棋盘色上）
      var cell = document.querySelector('.cells .cell');
      var board = document.getElementById('board');
      function toRGB(c){ var m = String(c).match(/[\\d.]+/g); return m ? m.slice(0,3).map(Number) : [0,0,0]; }
      function alpha(c){ var m = String(c).match(/[\\d.]+/g); return (m && m.length > 3) ? Number(m[3]) : 1; }
      var boardRGB = toRGB(getComputedStyle(board).backgroundColor);
      var cellRGB  = toRGB(getComputedStyle(cell).backgroundColor);
      var cellA    = alpha(getComputedStyle(cell).backgroundColor);
      // 空格实际观感 = cell 半透明层合成到棋盘上
      var emptyRGB = cellRGB.map(function(v, i){ return v * cellA + boardRGB[i] * (1 - cellA); });

      var tilesEl = document.getElementById('tiles');
      var out = {};
      vals.forEach(function(v){
        // ⚠️ 方块是两层结构：.tile（位移）+ .tile-inner（外观）。
        //    配色挂在 .tile-inner 上 —— 量 .tile 会拿到**透明背景**，
        //    于是每个数值都算出同一个"空格色"，三条判据全假红
        //    （2026-10-08 分层重构后就是这样误报过一轮）。
        var t = document.createElement('div');
        t.className = 'tile';
        t.dataset.v = String(v);
        t.innerHTML = '<div class="tile-inner"><span class="tile-face">' + v + '</span></div>';
        tilesEl.appendChild(t);
        var inner = t.firstChild;
        var cs = getComputedStyle(inner);
        out[v] = { bg: toRGB(cs.backgroundColor), fg: toRGB(cs.color) };
        tilesEl.removeChild(t);
      });
      return { empty: emptyRGB, tiles: out };
    })()`);
  }

  function lum(rgb) {
    const m = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
  }
  function contrast(a, b) {
    const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }

  for (const theme of ["dark", "light"]) {
    console.log("\n── " + theme + " 主题 ──");
    const d = await measure(theme);
    const emptyLum = lum(d.empty);
    console.log("  空格底色 rgb(" + d.empty.map(Math.round).join(",") + ")  亮度 " + emptyLum.toFixed(4));

    // ① 方块 vs 空格：亮度差
    const vsEmpty = [];
    for (const v of VALUES) {
      const l = lum(d.tiles[v].bg);
      vsEmpty.push({ v, l, diff: Math.abs(l - emptyLum) });
    }
    const worstEmpty = vsEmpty.reduce((a, b) => (a.diff < b.diff ? a : b));
    console.log("  方块 vs 空格亮度差：最小 " + worstEmpty.diff.toFixed(4) + "（" + worstEmpty.v + "）");
    ok(worstEmpty.diff >= 0.05, theme + "：每个数值都与空格有可辨亮度差（≥0.05）",
      "最差 " + worstEmpty.v + " 仅 " + worstEmpty.diff.toFixed(4));

    // ② 数字 vs 方块底色
    const ratios = [];
    for (const v of VALUES) {
      ratios.push({ v, r: contrast(d.tiles[v].bg, d.tiles[v].fg) });
    }
    const worstText = ratios.reduce((a, b) => (a.r < b.r ? a : b));
    console.log("  数字对比度：最小 " + worstText.r.toFixed(2) + ":1（" + worstText.v + "）");
    ok(worstText.r >= 3, theme + "：所有数值的数字对比度 ≥ 3:1",
      "最差 " + worstText.v + " 仅 " + worstText.r.toFixed(2));

    // ③ 相邻数值之间
    const adj = [];
    for (let i = 1; i < VALUES.length; i++) {
      const a = VALUES[i - 1], b = VALUES[i];
      adj.push({ pair: a + "→" + b, diff: Math.abs(lum(d.tiles[b].bg) - lum(d.tiles[a].bg)) });
    }
    const worstAdj = adj.reduce((a, b) => (a.diff < b.diff ? a : b));
    console.log("  相邻数值亮度差：最小 " + worstAdj.diff.toFixed(4) + "（" + worstAdj.pair + "）");
    ok(worstAdj.diff >= 0.02, theme + "：相邻数值之间亮度差 ≥ 0.02",
      "最差 " + worstAdj.pair + " 仅 " + worstAdj.diff.toFixed(4));

    // 顺带把每个数值的实测值打出来，方便人工核对
    console.log("  各数值底色亮度：");
    vsEmpty.forEach((x) => console.log("    " + String(x.v).padStart(4) + "  rgb(" + d.tiles[x.v].bg.map(Math.round).join(",").padEnd(11) + ")  L=" + x.l.toFixed(4) + "  与空格差 " + x.diff.toFixed(4)));
  }

  console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
  if (fail) console.log("失败项：\n - " + fails.join("\n - "));
  console.log("");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("崩溃：", e.message); process.exit(2); });
