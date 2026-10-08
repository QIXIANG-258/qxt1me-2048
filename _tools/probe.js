/* =========================================================
   2048 · 真实浏览器验收探针（CDP / 无头 Edge）
   逻辑冒烟（smoke.js）证明的是算法，本探针证明的是**页面真的能跑**：
     - 无控制台报错、无未捕获异常
     - 开局正好 2 个方块，棋盘几何正确（4×4 对齐、不出界）
     - 真键盘事件能移动；真鼠标拖动能移动
     - 撤销 / 新游戏 / 主题 / 语言按钮真的有反应
     - 主题切换后文字与底色仍有足够对比（不是白底白字）
     - 字体真的加载了
   跑法：先起服务，再 node _tools/probe.js
   ========================================================= */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const EDGE = process.env.EDGE || "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = Number(process.env.CDP_PORT || 9394);
const URL_BASE = process.env.PROBE_URL || "http://127.0.0.1:8793";

const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const crypto = require("crypto");

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; fails.push(name); console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 极简 WebSocket 客户端（够跑 CDP 就行） ──────────
function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const key = crypto.randomBytes(16).toString("base64");
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: {
        Connection: "Upgrade", Upgrade: "websocket",
        "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13"
      }
    });
    req.on("error", reject);
    req.end();
    req.on("upgrade", (res, socket) => {
      socket.setNoDelay(true);
      resolve({ socket, buf: Buffer.alloc(0) });
    });
  });
}

function wsSend(sock, str) {
  const payload = Buffer.from(str, "utf8");
  const len = payload.length;
  let head;
  if (len < 126) { head = Buffer.from([0x81, 0x80 | len]); }
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0xfe; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 0xff; head.writeBigUInt64BE(BigInt(len), 2); }
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
  sock.write(Buffer.concat([head, mask, masked]));
}

// 解析服务端帧（无掩码，可能分片/粘包）
function makeFrameParser(onMsg) {
  let buf = Buffer.alloc(0);
  let frags = [];
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const op = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + len) return;
      const payload = buf.slice(off, off + len);
      buf = buf.slice(off + len);
      if (op === 0x1) frags.push(payload);
      else if (op === 0x2 || op === 0x0) frags.push(payload);
      else if (op === 0x8) return;
      if (fin) { onMsg(Buffer.concat(frags).toString("utf8")); frags = []; }
    }
  };
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "edge-2048-"));
  // ⚠️ 打线上地址时必须走系统代理（本机 Clash 在 127.0.0.1:7897）。
  //    固定 --no-proxy-server 会让 Page.navigate 直接超时（直连出不去）。
  //    打本地 http://127.0.0.1 时用 --no-proxy-server 更快也更稳。
  const isRemote = !/127\.0\.0\.1|localhost/.test(URL_BASE);
  const proxyArgs = isRemote
    ? ["--proxy-server=http://127.0.0.1:7897", "--proxy-bypass-list=<-loopback>"]
    : ["--no-proxy-server"];
  const child = spawn(EDGE, [
    "--headless=new", "--disable-gpu", "--no-first-run",
    "--hide-scrollbars", "--remote-debugging-port=" + PORT,
    "--user-data-dir=" + tmp, "--window-size=1280,900", "about:blank"
  ].concat(proxyArgs), { stdio: "ignore" });

  const cleanup = () => { try { child.kill(); } catch (e) {} };
  process.on("exit", cleanup);

  // 等 /json/list
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(300);
    try {
      const body = await new Promise((res, rej) => {
        http.get({ host: "127.0.0.1", port: PORT, path: "/json/list" }, (r) => {
          let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => res(d));
        }).on("error", rej);
      });
      const list = JSON.parse(body);
      target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl) || null;
    } catch (e) {}
  }
  if (!target) { console.error("拿不到 CDP target"); process.exit(2); }

  const conn = await wsConnect(target.webSocketDebuggerUrl);
  let seqId = 0;
  const waiting = new Map();
  const consoleErrors = [];
  const exceptions = [];
  let readyResolve;
  const readyPromise = new Promise((r) => (readyResolve = r));

  const onMsg = (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.id && waiting.has(m.id)) {
      const { resolve, reject } = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
      return;
    }
    if (m.method === "Runtime.exceptionThrown") {
      exceptions.push((m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description)
        || m.params.exceptionDetails.text || "?");
    }
    if (m.method === "Runtime.consoleAPICalled" && (m.params.type === "error" || m.params.type === "warning")) {
      consoleErrors.push(m.params.type + ": " + (m.params.args || []).map((a) => a.value || a.description || "").join(" "));
    }
  };
  conn.socket.on("data", makeFrameParser(onMsg));
  conn.socket.on("error", () => {});

  function send(method, params) {
    const id = ++seqId;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      wsSend(conn.socket, JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); reject(new Error("timeout " + method)); } }, 20000);
    });
  }

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Log.enable").catch(() => {});

  async function ev(expr) {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || ""));
    return r.result.value;
  }

  // ── 导航 ──────────────────────────────────────────
  await send("Page.navigate", { url: URL_BASE + "/index.html" });
  await sleep(1500);

  // 等就绪：棋盘存在 + 开局 2 个方块
  let tiles = 0;
  for (let i = 0; i < 40; i++) {
    try {
      tiles = await ev("document.querySelectorAll('#tiles .tile').length");
      if (tiles >= 2) break;
    } catch (e) {}
    await sleep(250);
  }

  console.log("\n2048 · 浏览器验收（CDP / 无头 Edge）\n");
  ok(tiles === 2, "开局棋盘上正好 2 个方块", "got " + tiles);

  // ── ① 无脚本异常 / 控制台错误 ────────────────────
  ok(exceptions.length === 0, "无未捕获异常", exceptions.join(" | "));
  const realErrors = consoleErrors.filter((e) => !/favicon/i.test(e));
  ok(realErrors.length === 0, "无控制台 error/warning", realErrors.join(" | "));

  // ── ② 棋盘几何：4×4 对齐，方块不出界 ────────────
  const geo = await ev(`(function(){
    var b = document.getElementById('board').getBoundingClientRect();
    var ts = [].slice.call(document.querySelectorAll('#tiles .tile'));
    var cells = [].slice.call(document.querySelectorAll('.cells .cell'));
    var bad = [];
    ts.forEach(function(t){
      var r = t.getBoundingClientRect();
      if (r.left < b.left - 1 || r.right > b.right + 1 || r.top < b.top - 1 || r.bottom > b.bottom + 1) bad.push('out:'+t.dataset.v);
      if (r.width < 20) bad.push('tiny:'+r.width);
    });
    return {
      board: [Math.round(b.width), Math.round(b.height)],
      cells: cells.length,
      tiles: ts.length,
      bad: bad,
      square: Math.abs(b.width - b.height) < 2
    };
  })()`);
  ok(geo.cells === 16, "底格正好 16 个", "got " + geo.cells);
  ok(geo.bad.length === 0, "全部方块都在棋盘内且尺寸正常", geo.bad.join(","));
  ok(geo.square, "棋盘是正方形", geo.board.join("x"));

  // 格子尺寸应当大致等于 (棋盘 - padding - gaps) / 4
  const cellInfo = await ev(`(function(){
    var c = document.querySelector('.cells .cell').getBoundingClientRect();
    var t = document.querySelector('#tiles .tile').getBoundingClientRect();
    return { cell:[Math.round(c.width),Math.round(c.height)], tile:[Math.round(t.width),Math.round(t.height)] };
  })()`);
  ok(Math.abs(cellInfo.cell[0] - cellInfo.tile[0]) <= 2, "方块尺寸与底格一致",
    "cell " + cellInfo.cell.join("x") + " tile " + cellInfo.tile.join("x"));

  // ⚠️ 守住 2026-10-07 那一版棋盘塌方 bug：方块实测几何必须与背景底格严格对齐。
  // 修法是把 CSS 里 100% 推算 cell 的算式全去掉，由 JS 量 grid-template-columns
  // 写 --cell-px / --step。这一条再不能下 1px —— 那是塌方的先兆。
  const alignment = await ev(`(function(){
    var b = document.getElementById('board');
    var cells = [].slice.call(document.querySelectorAll('.cells .cell'));
    var tiles = [].slice.call(document.querySelectorAll('#tiles .tile'));
    var br = b.getBoundingClientRect();
    var off = { l: br.left, t: br.top };
    function r(e){ var x = e.getBoundingClientRect(); return [x.left - off.l, x.top - off.t, x.width, x.height]; }
    // 已知：grid-template-columns/rows = repeat(4, 1fr)，行优先填充，
    // 所以 cells[i] 的 (col, row) = (i % 4, Math.floor(i / 4))。
    var ref00 = null, ref10 = null, ref01 = null;
    for (var i = 0; i < cells.length; i++) {
      var c = r(cells[i]);
      var col = i % 4, row = Math.floor(i / 4);
      if (col === 0 && row === 0) ref00 = { x: c[0], y: c[1] };
      if (col === 1 && row === 0) ref10 = { x: c[0], y: c[1] };
      if (col === 0 && row === 1) ref01 = { x: c[0], y: c[1] };
    }
    if (!ref00 || !ref10 || !ref01) return { bad: ['背景底格不齐，' + cells.length + ' 个'] };
    var stepX = ref10.x - ref00.x;
    var stepY = ref01.y - ref00.y;
    var bad = [];
    tiles.forEach(function(t){
      var rt = r(t);
      var tx = +t.style.getPropertyValue('--x');
      var ty = +t.style.getPropertyValue('--y');
      var expectX = ref00.x + tx * stepX;
      var expectY = ref00.y + ty * stepY;
      var dx = Math.abs(rt[0] - expectX);
      var dy = Math.abs(rt[1] - expectY);
      if (dx > 1.5 || dy > 1.5) bad.push('tile('+t.dataset.v+')@('+tx+','+ty+') 偏差 ('+dx.toFixed(1)+','+dy.toFixed(1)+')px');
      // 还必须完全落在棋盘内。
      // ⚠️ rt 是**相对棋盘左上角**的坐标（r() 里已减掉 off），所以边界要用
      //    0 与 br.width/height，不能拿 br.left/br.right 这些**绝对**值来比
      //    —— 混用会让每条都报"溢出"，是纯粹的判据假红（踩过一次）。
      if (rt[0] < -1 || rt[0] + rt[2] > br.width + 1) bad.push('tile 横向溢出 rel=' + rt[0].toFixed(1) + '+' + rt[2].toFixed(1) + ' vs ' + br.width.toFixed(1));
      if (rt[1] < -1 || rt[1] + rt[3] > br.height + 1) bad.push('tile 纵向溢出 rel=' + rt[1].toFixed(1) + '+' + rt[3].toFixed(1) + ' vs ' + br.height.toFixed(1));
    });
    return { stepX: stepX, stepY: stepY, ref00: ref00, bad: bad };
  })()`);
  ok(alignment.stepX > 0 && alignment.stepY > 0, "网格步长 > 0（grid 真的排好了）",
    "stepX=" + alignment.stepX + " stepY=" + alignment.stepY);
  ok(alignment.bad.length === 0, "全部 tile 与背景 16 格对齐且不溢出棋盘",
    alignment.bad.join(" | "));

  // ── ②a favicon 套件（2026-10-08 加）────────────────
  // 验：① favicon.ico 多分辨率 ② manifest 链接存在 ③ apple-touch-icon 链接存在
  // ④ 响应头确实送了 Cache-Control（防止下次忘加 cache 又每次回源）
  // ⚠️ 走页面内的 fetch 不是 node 的 fetch —— 沙箱里 node fetch 没接
  //    Edge 的 --proxy-server，远程地址会 ECONNRESET（这条踩过）。
  {
    const checks = {
      favicon: { url: "/favicon.ico", expectSizes: [16, 32, 48] },
      icon192: { url: "/icon-192.png", expect: 192 },
      icon512: { url: "/icon-512.png", expect: 512 },
      manifest: { url: "/manifest.webmanifest", expectContentType: "application/manifest+json" },
      appleTouch: { url: "/icon-180.png", expect: 180 }
    };
    const results = await ev(`(async function(){
      var checks = ${JSON.stringify(checks)};
      var out = {};
      for (var k in checks) {
        var c = checks[k];
        try {
          var r = await fetch(location.origin + c.url);
          out[k] = { status: r.status, ct: r.headers.get('content-type'),
            buf: r.status >= 200 && r.status < 300 ? Array.from(new Uint8Array(await r.arrayBuffer())) : null };
        } catch (e) { out[k] = { error: String(e) }; }
      }
      return out;
    })()`);
    for (const key of Object.keys(checks)) {
      const c = checks[key];
      const r = results[key];
      ok(r && r.status === 200, "favicon 套件：" + c.url + " 200", "status=" + (r && r.status) + " " + (r && r.error || ""));
      if (c.expect && r && r.buf) {
        const u8 = r.buf;
        if (u8[0] === 137 && u8[1] === 80) {
          const w = (u8[16] << 24) | (u8[17] << 16) | (u8[18] << 8) | u8[19];
          ok(w === c.expect, c.url + " 尺寸 = " + c.expect + "px", "got " + w + "px");
        } else {
          ok(false, c.url + " 是有效 PNG", "magic bytes 不匹配");
        }
      }
      if (c.expectContentType && r) {
        ok((r.ct || "").includes(c.expectContentType),
          c.url + " content-type 含 " + c.expectContentType,
          "got " + r.ct);
      }
      if (c.expectSizes && r && r.buf) {
        const u8 = r.buf;
        if (u8[0] === 0 && u8[1] === 0 && u8[2] === 1 && u8[3] === 0) {
          const count = u8[4] | (u8[5] << 8);
          const sizes = [];
          for (let i = 0; i < count; i++) {
            const off = 6 + i * 16;
            const w = u8[off] || 256, h = u8[off + 1] || 256;
            sizes.push(w + "x" + h);
          }
          ok(count >= c.expectSizes.length,
            "favicon.ico 含至少 " + c.expectSizes.length + " 个尺寸（" + c.expectSizes.join("/") + "）",
            "实际 " + count + " 个：" + sizes.join(","));
        }
      }
    }
  }

  // HTML 是否真把这几个 link 写上了
  const headHtml = await ev("document.head.outerHTML");
  ok(/rel=["']icon["'][^>]*href=["']favicon\.ico["']/.test(headHtml), "HTML <link rel='icon'> 指向 favicon.ico");
  ok(/rel=["']apple-touch-icon["']/.test(headHtml), "HTML <link rel='apple-touch-icon'> 存在");
  ok(/rel=["']manifest["']/.test(headHtml), "HTML <link rel='manifest'> 存在");

  // ── ②c robots.txt / sitemap.xml（2026-10-08 补）──────────────────
  // 此前线上两个路径都是 404（blog 与 gear 都已补，本站漏了）。
  // ⚠️ 判据不能只看「200」—— 内容也要对：robots 要 Allow 且声明 Sitemap，
  //    sitemap 要含本站唯一 URL。只看状态码的话，一个空的 200 也能骗过去。
  // ⚠️ 走**页面内** fetch（同上面 favicon 套件）：沙箱里 node fetch 没接
  //    Edge 的 --proxy-server，打远程地址会 ECONNRESET。
  {
    const meta = await ev(`(async function(){
      var out = {};
      for (var u of ['/robots.txt','/sitemap.xml']) {
        try {
          var r = await fetch(location.origin + u);
          out[u] = { status: r.status, body: r.status === 200 ? await r.text() : null };
        } catch (e) { out[u] = { error: String(e) }; }
      }
      return out;
    })()`);
    const rob = meta["/robots.txt"] || {};
    const sm = meta["/sitemap.xml"] || {};

    ok(rob.status === 200, "robots.txt 200", "status=" + rob.status + " " + (rob.error || ""));
    const rt = rob.body || "";
    ok(/User-agent:\s*\*/i.test(rt), "robots.txt 有 User-agent: *");
    ok(/Allow:\s*\//i.test(rt), "robots.txt 允许抓取（Allow: /）");
    ok(!/^\s*Disallow:\s*\/\s*$/im.test(rt), "robots.txt 没有 Disallow: /（否则整站被挡）");
    ok(/Sitemap:\s*https:\/\/2048\.qxt1me\.dpdns\.org\/sitemap\.xml/.test(rt),
       "robots.txt 声明了本站的 sitemap（绝对 https 地址）",
       JSON.stringify(rt.replace(/\s+/g, " ").slice(0, 100)));

    ok(sm.status === 200, "sitemap.xml 200", "status=" + sm.status + " " + (sm.error || ""));
    const st = sm.body || "";
    ok(/<urlset\b/.test(st) && /sitemaps\.org\/schemas\/sitemap\/0\.9/.test(st),
       "sitemap.xml 是合法 urlset（标准命名空间）");
    ok(/<loc>https:\/\/2048\.qxt1me\.dpdns\.org\/<\/loc>/.test(st),
       "sitemap.xml 含本站唯一 URL（单页站只应有 1 条）",
       "loc 条数=" + (st.match(/<loc>/g) || []).length);
    ok((st.match(/<loc>/g) || []).length === 1,
       "sitemap.xml 恰好 1 条 loc（单页站不该列不存在的路径）",
       "实测 " + (st.match(/<loc>/g) || []).length + " 条");
  }

  // ── ②b 配色可辨性（2026-10-07 加）────────────────
  // 🔴 起因：作者反馈"方块容易和背景融为一体"。实测根因是数值 2 的
  //    底色 rgb(33,33,33) 与空格 rgb(32,32,32) 几乎同色，而 2 是棋盘上
  //    最多的方块 —— 整盘糊成一片。
  //    这里量化守三条：与空格的亮度差、数字对比度、相邻数值的亮度差。
  //    ⚠️ 空格色是半透明层合成出来的，必须**合成后再比**，只比 .cell 的
  //       声明色会算出假的差值。
  async function colorAudit(theme) {
    await ev("document.documentElement.setAttribute('data-theme','" + theme + "')");
    await sleep(300);
    return await ev(`(function(){
      var vals = [2,4,8,16,32,64,128,256,512,1024,2048];
      function toRGB(c){ var m=String(c).match(/[\\d.]+/g); return m?m.slice(0,3).map(Number):[0,0,0]; }
      function alpha(c){ var m=String(c).match(/[\\d.]+/g); return (m&&m.length>3)?Number(m[3]):1; }
      var board = document.getElementById('board');
      var cell  = document.querySelector('.cells .cell');
      var bRGB = toRGB(getComputedStyle(board).backgroundColor);
      var cRGB = toRGB(getComputedStyle(cell).backgroundColor);
      var cA   = alpha(getComputedStyle(cell).backgroundColor);
      var empty = cRGB.map(function(v,i){ return v*cA + bRGB[i]*(1-cA); });
      var tilesEl = document.getElementById('tiles');
      var out = {};
      vals.forEach(function(v){
        // ⚠️ 方块现在是两层结构：.tile（位移）+ .tile-inner（外观）。
        //    配色挂在 .tile-inner 上 —— 量它才是用户看到的颜色。
        //    量 .tile 会拿到透明背景，旧判据就是这里假红。
        var t = document.createElement('div');
        t.className='tile'; t.dataset.v=String(v);
        t.innerHTML='<div class="tile-inner"><span class="tile-face">'+v+'</span></div>';
        tilesEl.appendChild(t);
        var inner = t.firstChild;
        var cs=getComputedStyle(inner);
        out[v]={bg:toRGB(cs.backgroundColor), fg:toRGB(cs.color)};
        tilesEl.removeChild(t);
      });
      return { empty: empty, tiles: out };
    })()`);
  }
  const lumOf = (rgb) => {
    const m = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
  };
  const contrastOf = (a, b) => {
    const l1 = lumOf(a), l2 = lumOf(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };

  {
    const VALUES = [2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048];
    for (const theme of ["dark", "light"]) {
      const d = await colorAudit(theme);
      const eL = lumOf(d.empty);
      let minEmpty = 9, minEmptyV = null;
      let minText = 99, minTextV = null;
      let minAdj = 9, minAdjPair = null;
      for (const v of VALUES) {
        const diff = Math.abs(lumOf(d.tiles[v].bg) - eL);
        if (diff < minEmpty) { minEmpty = diff; minEmptyV = v; }
        const r = contrastOf(d.tiles[v].bg, d.tiles[v].fg);
        if (r < minText) { minText = r; minTextV = v; }
      }
      for (let i = 1; i < VALUES.length; i++) {
        const dd = Math.abs(lumOf(d.tiles[VALUES[i]].bg) - lumOf(d.tiles[VALUES[i - 1]].bg));
        if (dd < minAdj) { minAdj = dd; minAdjPair = VALUES[i - 1] + "→" + VALUES[i]; }
      }
      ok(minEmpty >= 0.05, theme + "：每个数值都与空格有可辨亮度差 ≥0.05（防 融为一体）",
        "最差 " + minEmptyV + " 仅 " + minEmpty.toFixed(4));
      ok(minText >= 3, theme + "：所有数值的数字对比度 ≥ 3:1",
        "最差 " + minTextV + " 仅 " + minText.toFixed(2));
      ok(minAdj >= 0.02, theme + "：相邻数值之间亮度差 ≥0.02",
        "最差 " + minAdjPair + " 仅 " + minAdj.toFixed(4));
    }
    // 量完切回深色，别影响后面的用例
    await ev("document.documentElement.setAttribute('data-theme','dark')");
    await sleep(250);
  }

  // ── ③ 真实键盘事件能移动 ────────────────────────
  // 连按四次，至少有一次改变了局面（记录签名变化）
  async function signature() {
    return await ev(`(function(){
      return [].slice.call(document.querySelectorAll('#tiles .tile')).map(function(t){
        return t.dataset.v + '@' + t.style.getPropertyValue('--x') + ',' + t.style.getPropertyValue('--y');
      }).sort().join('|');
    })()`);
  }
  async function key(k) {
    await send("Input.dispatchKeyEvent", {
      type: "rawKeyDown", key: k, code: k,
      windowsVirtualKeyCode: { ArrowLeft: 37, ArrowRight: 39, ArrowUp: 38, ArrowDown: 40 }[k] || 0,
      nativeVirtualKeyCode: { ArrowLeft: 37, ArrowRight: 39, ArrowUp: 38, ArrowDown: 40 }[k] || 0
    });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k });
    await sleep(320);
  }

  /* 按**物理键位**（code）派事件 —— 字母键必须用这个：
     key() 只传 key 名，不带 code，浏览器不会把它当成 QWERTY 上的
     那个键，页面里的 e.key 可能是未定义，R/C 就收不到。
     ⚠️ 这里同时给 key 与 code，才能真的模拟「按下 R 键」。 */
  async function pressKey(code) {
    const ch = code.replace(/^Key/, "");
    await send("Input.dispatchKeyEvent", {
      type: "rawKeyDown", key: ch, code: code,
      windowsVirtualKeyCode: ch.charCodeAt(0),
      nativeVirtualKeyCode: ch.charCodeAt(0)
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp", key: ch, code: code,
      windowsVirtualKeyCode: ch.charCodeAt(0),
      nativeVirtualKeyCode: ch.charCodeAt(0)
    });
    await sleep(320);
  }

  const sig0 = await signature();
  await key("ArrowLeft");
  await key("ArrowDown");
  await key("ArrowRight");
  await key("ArrowUp");
  const sig1 = await signature();
  ok(sig0 !== sig1, "真实方向键事件能移动方块", "sig 未变化：" + sig0);

  // ── ④ 真鼠标拖动能移动（pointer 事件路径） ──────
  const box = await ev(`(function(){ var r = document.getElementById('board').getBoundingClientRect();
    return {x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2)}; })()`);
  const dragRes = await retryUntilChanged(async () => {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 5; i++) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x - i * 18, y: box.y, button: "left", buttons: 1 });
      await sleep(30);
    }
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x - 90, y: box.y, button: "left", buttons: 0, clickCount: 1 });
  }, 3);
  ok(dragRes.changed, "鼠标拖动也能移动方块（pointer 路径通）",
    "3 次尝试局面都未变");

  // ── ⑤ 撤销按钮 ──────────────────────────────────
  const undoDisabled = await ev("document.getElementById('undoBtn').disabled");
  ok(undoDisabled === false, "移动过后撤销按钮变为可用");
  const scoreBeforeUndo = await ev("Number(document.getElementById('score').textContent)");
  await ev("document.getElementById('undoBtn').click()");
  await sleep(300);
  const scoreAfterUndo = await ev("Number(document.getElementById('score').textContent)");
  ok(scoreAfterUndo <= scoreBeforeUndo, "撤销后分数不高于撤销前", scoreBeforeUndo + " → " + scoreAfterUndo);

  // ── ⑥ 新游戏按钮：回到 2 个方块、分数归零 ────────
  await ev("document.getElementById('newBtn').click()");
  await sleep(400);
  const afterNew = await ev(`(function(){ return {
    tiles: document.querySelectorAll('#tiles .tile').length,
    score: Number(document.getElementById('score').textContent),
    overlayHidden: document.getElementById('overlay').hidden
  }; })()`);
  ok(afterNew.tiles === 2, "新游戏后棋盘回到 2 个方块", "got " + afterNew.tiles);
  ok(afterNew.score === 0, "新游戏后分数归零", "got " + afterNew.score);
  ok(afterNew.overlayHidden === true, "新游戏后浮层关闭");

  // ── ⑦ 主题切换：真的换了，而且对比度够 ──────────
  const beforeTheme = await ev("document.documentElement.getAttribute('data-theme')");
  await ev("document.getElementById('themeBtn').click()");
  await sleep(400);
  const afterTheme = await ev("document.documentElement.getAttribute('data-theme')");
  ok(beforeTheme !== afterTheme, "主题按钮真的切换了 data-theme", beforeTheme + " → " + afterTheme);

  const contrast = await ev(`(function(){
    function lum(c){ var m = c.match(/\\d+/g).map(Number).slice(0,3).map(function(v){
      v/=255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); });
      return 0.2126*m[0] + 0.7152*m[1] + 0.0722*m[2]; }
    var cs = getComputedStyle(document.body);
    var bg = cs.backgroundColor, fg = cs.color;
    var l1 = lum(bg), l2 = lum(fg);
    var ratio = (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05);
    return { bg: bg, fg: fg, ratio: Math.round(ratio*100)/100 };
  })()`);
  ok(contrast.ratio >= 4.5, "切换后正文与底色对比度 ≥ 4.5:1", "ratio " + contrast.ratio + " (bg " + contrast.bg + " / fg " + contrast.fg + ")");

  // 方块在浅色下也不能白底白字
  const tileContrast = await ev(`(function(){
    function lum(c){ var m = c.match(/\\d+/g).map(Number).slice(0,3).map(function(v){
      v/=255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); });
      return 0.2126*m[0] + 0.7152*m[1] + 0.0722*m[2]; }
    var out = [];
    // 配色挂在 .tile-inner 上 —— 这里采样它而不是 .tile
    [].slice.call(document.querySelectorAll('#tiles .tile-inner')).forEach(function(t){
      var cs = getComputedStyle(t);
      var l1 = lum(cs.backgroundColor), l2 = lum(cs.color);
      var r = (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05);
      var tile = t.parentNode;
      out.push({ v: tile.dataset.v, r: Math.round(r*100)/100 });
    });
    return out;
  })()`);
  const worst = tileContrast.reduce((a, b) => (a && a.r < b.r ? a : b), null);
  ok(worst && worst.r >= 3, "方块数字与方块底色对比度 ≥ 3:1（浅色下别白底白字）",
    "最差 " + (worst ? worst.v + " → " + worst.r : "无方块"));

  // 切回深色，避免影响后续
  await ev("document.getElementById('themeBtn').click()");
  await sleep(350);

  // ── ⑧ 语言切换：中英文案真的变了 ────────────────
  const zhText = await ev("document.querySelector('.hint').textContent.trim()");
  await ev("document.getElementById('langBtn').click()");
  await sleep(350);
  const enText = await ev("document.querySelector('.hint').textContent.trim()");
  const langAttr = await ev("document.documentElement.getAttribute('lang')");
  ok(zhText !== enText, "语言按钮真的换了文案", "「" + zhText + "」→「" + enText + "」");
  ok(langAttr === "en", "切到英文后 html lang=en", "got " + langAttr);
  await ev("document.getElementById('langBtn').click()");
  await sleep(300);

  // ── ⑨ 字体真的加载 ──────────────────────────────
  const fonts = await ev(`(function(){
    var out = [];
    document.fonts.forEach(function(f){ out.push(f.family + '|' + f.status); });
    return { count: document.fonts.size, loaded: out.filter(function(s){ return /loaded/.test(s); }).length, sample: out.slice(0,3) };
  })()`);
  ok(fonts.count > 0, "页面声明了自托管字体", "count " + fonts.count);
  ok(fonts.loaded > 0, "至少有字体真正 loaded（不是全部 fallback）",
    "loaded " + fonts.loaded + "/" + fonts.count + " " + JSON.stringify(fonts.sample));

  // ── ⑩ 存档：刷新后局面还在 ──────────────────────
  const beforeReload = await ev(`(function(){ return {
    tiles: document.querySelectorAll('#tiles .tile').length,
    score: Number(document.getElementById('score').textContent),
    best: Number(document.getElementById('best').textContent)
  }; })()`);
  await send("Page.navigate", { url: URL_BASE + "/index.html" });
  await sleep(1600);
  for (let i = 0; i < 30; i++) {
    try { if (await ev("document.querySelectorAll('#tiles .tile').length") >= 1) break; } catch (e) {}
    await sleep(250);
  }
  const afterReload = await ev(`(function(){ return {
    tiles: document.querySelectorAll('#tiles .tile').length,
    score: Number(document.getElementById('score').textContent)
  }; })()`);
  ok(afterReload.tiles === beforeReload.tiles, "刷新后方块数量保持（存档生效）",
    beforeReload.tiles + " → " + afterReload.tiles);
  ok(afterReload.score === beforeReload.score, "刷新后分数保持", beforeReload.score + " → " + afterReload.score);

  // ── ⑪ 窄屏（手机视口）不横向溢出 ────────────────
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(600);
  const mobile = await ev(`(function(){
    var de = document.documentElement;
    var over = [];
    [].slice.call(document.querySelectorAll('body *')).forEach(function(el){
      var r = el.getBoundingClientRect();
      if (r.width === 0) return;
      // ⚠️ 跳过纯装饰层：.ambient 是 position:fixed; inset:-20vmax 的背景雾，
      //    **故意**画到视口外且 pointer-events:none，fixed 元素也不占滚动宽度
      //    （上一条 scrollWidth 断言已经守住了真正的溢出）。
      //    不排除它会让这条断言变成**假红**。
      var cs = getComputedStyle(el);
      if (cs.position === 'fixed' && cs.pointerEvents === 'none') return;
      if (r.right > de.clientWidth + 1 || r.left < -1) {
        over.push((el.tagName + '.' + el.className).slice(0, 40) + '[' + Math.round(r.left) + ',' + Math.round(r.right) + ']');
      }
    });
    return { scrollW: de.scrollWidth, clientW: de.clientWidth, over: over.slice(0, 5) };
  })()`);
  ok(mobile.scrollW <= mobile.clientW + 1, "手机视口无横向溢出", "scrollW " + mobile.scrollW + " vs clientW " + mobile.clientW);
  ok(mobile.over.length === 0, "没有元素超出手机视口宽度", mobile.over.join(" | "));

  // 手机上棋盘仍然可见且尺寸合理
  const mBoard = await ev(`(function(){ var r = document.getElementById('board').getBoundingClientRect();
    return [Math.round(r.width), Math.round(r.height), Math.round(r.top)]; })()`);
  ok(mBoard[0] > 200 && Math.abs(mBoard[0] - mBoard[1]) < 2, "手机视口下棋盘尺寸合理且正方",
    mBoard.join("/"));

  await send("Emulation.clearDeviceMetricsOverride");

  /* ⚠️ 判据加固（2026-10-08）：signature() 是**局面哈希**，而一次合法移动
     完全可能让哈希回到原值（方块滑了位、又补了个一样的方块，或该方向本就
     只有个别方块动了但净布局一致）。实测线上跑出过一次红、紧接着一次绿 ——
     这就是「判据自己不稳」而不是产品坏。
     正确做法：**重试输入本身**，只要有一次让局面变了就算这条路径通。
     比「多等一会儿」更可靠 —— 等再久，可重复的哈希也还是那个哈希。 */
  async function retryUntilChanged(sendInput, tries, label) {
    const before = await signature();
    let after = before;
    for (let i = 0; i < tries; i++) {
      await sendInput();
      // 滑动动画 + 收尾补新方块，两步都要等；轮询而不是写死 sleep
      for (let k = 0; k < 12 && after === before; k++) {
        await sleep(100);
        after = await signature();
      }
      if (after !== before) return { changed: true, tries: i + 1, before, after };
    }
    return { changed: false, tries: tries, before, after };
  }

  // ── ⑫ 触摸滑动（移动端主路径） ──────────────────
  /* 🔴 关键（2026-10-08 实测定位）：**`setDeviceMetricsOverride({mobile:true})`
     并不会打开触摸模拟** —— 实测之后 `'ontouchstart' in window === false`、
     `navigator.maxTouchPoints === 0`，页面里那套 touch 监听根本不会挂上，
     合成出来的 touchStart/Move/End 自然推不动方块。
     必须**另外**调 `Emulation.setTouchEmulationEnabled` 才会把
     `maxTouchPoints` 变成 5、`ontouchstart` 变成 true。
     （这条之前只在 localhost 上侥幸通过 —— 那是「重试输入」也救不了的假红，
       因为再怎么重试，环境本身没有触摸能力。） */
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await sleep(600);
  const touchOn = await ev("'ontouchstart' in window || navigator.maxTouchPoints > 0");
  ok(touchOn === true, "移动端模拟下触摸能力已开启（ontouchstart / maxTouchPoints）",
     "touchOn=" + touchOn + " —— 没开的话下面的滑动必假红");
  const mBox = await ev(`(function(){ var r = document.getElementById('board').getBoundingClientRect();
    return {x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2)}; })()`);
  const touchRes = await retryUntilChanged(async () => {
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: mBox.x, y: mBox.y }] });
    for (let i = 1; i <= 5; i++) {
      await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: mBox.x, y: mBox.y - i * 20 }] });
      await sleep(30);
    }
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }, 3);
  ok(touchRes.changed, "触摸滑动能移动方块（移动端主路径）",
    "3 次尝试局面都未变（touch 可用=" + touchOn + "，滑动起点 " + JSON.stringify(mBox) + "）");
  /* 触摸模拟也要一起关掉，否则会泄漏到后面的用例
     （后续若有用例依赖「非触摸设备」的鼠标路径，开着触摸会改变事件走向）。 */
  await send("Emulation.setTouchEmulationEnabled", { enabled: false });
  await send("Emulation.clearDeviceMetricsOverride");

  // ── ⑬ 键盘功能键：R 重开 / C 撤销 ────────────────
  // 注：键盘是**真实 CDP 按键事件**，不是 JS 合成 —— 能验到浏览器原生行为。
  {
    // 先走一步拿到分数
    await key("ArrowLeft");
    const scoreBeforeR = await ev("Number(document.getElementById('score').textContent)");
    await pressKey("KeyR");
    await sleep(350);
    const afterR = await ev(`(function(){ return {
      score: Number(document.getElementById('score').textContent),
      tiles: document.querySelectorAll('#tiles .tile').length
    }; })()`);
    ok(afterR.score === 0, "R 键重开：分数归零", scoreBeforeR + " → " + afterR.score);
    ok(afterR.tiles === 2, "R 键重开：棋盘回到 2 个方块", "got " + afterR.tiles);

    // 再走一步，然后用 C 撤销
    await key("ArrowLeft");
    await sleep(300);
    const scoreBeforeC = await ev("Number(document.getElementById('score').textContent)");
    await pressKey("KeyC");
    await sleep(350);
    const scoreAfterC = await ev("Number(document.getElementById('score').textContent)");
    ok(scoreAfterC <= scoreBeforeC, "C 键撤销：分数回退", scoreBeforeC + " → " + scoreAfterC);
  }

  // ⚠️ 回归守卫：D 必须还是「右移」，不能被撤销抢走
  {
    const dRes = await retryUntilChanged(async () => { await pressKey("KeyD"); }, 3);
    ok(dRes.changed, "D 键仍然是「右移」（撤销键挑的是 C，没抢 D）",
      "3 次尝试局面都未变");
  }

  // ── ⑭ 手柄：D-pad 方向 + B 撤销 + Y 重开 ─────────
  // 没有真手柄可插，所以在页面里**注入一个虚拟 Gamepad** 再派真实按钮状态。
  // ⚠️ 必须验「按住不放只触发一次」—— 手柄是轮询的，边沿判断写错会一帧连发。
  const padOk = await ev(`(function(){
    // 造一个 16 键的标准布局手柄，覆盖 navigator.getGamepads
    var fake = { id: 'probe-pad', index: 0, connected: true, mapping: 'standard',
      buttons: [], axes: [0, 0, 0, 0] };
    for (var i = 0; i < 16; i++) fake.buttons.push({ pressed: false, value: 0, touched: false });
    navigator.getGamepads = function () { return [fake]; };
    window.__pad = fake;
    // 让页面重新读一次（initGamepad 的 rAF 循环每帧都会调 getGamepads）
    return true;
  })()`);
  ok(padOk === true, "虚拟手柄已注入（navigator.getGamepads 被接管）");

  async function padPress(idx, ms) {
    await ev("window.__pad.buttons[" + idx + "].pressed = true; 1");
    await sleep(ms || 120);
    await ev("window.__pad.buttons[" + idx + "].pressed = false; 1");
    await sleep(220);
  }

  // D-pad 右 = buttons[15]
  {
    // ⚠️ 判据不能假设"向右一定动得了" —— 若方块本就贴着右墙，
    //    向右是合法的无操作，这条就会**偶发假红**（踩过三次：
    //    同样代码一会儿红一会儿绿，最耗时的就是这类）。
    //    做法：先左移把方块推到左边腾出右侧空间，再验右移必然可动。
    await padPress(14);                    // 先按 D-pad 左（buttons[14]）
    const sigBeforePad = await signature();
    await padPress(15);                    // 再按 D-pad 右（buttons[15]）
    // 手柄是 rAF 轮询的，从「按下」到「页面读到」隔 1~2 帧，再叠加
    // 滑动动画与补新方块 —— 轮询等局面真的落定，别写死 sleep。
    let sigAfterPad = await signature();
    for (let i = 0; i < 20 && sigAfterPad === sigBeforePad; i++) {
      await sleep(100);
      sigAfterPad = await signature();
    }
    ok(sigBeforePad !== sigAfterPad, "手柄十字键「右」能移动方块（buttons[15]）", "sig 未变化");
  }

  // D-pad 四个方向都应能触发移动（14 左 / 15 右 / 12 上 / 13 下）
  {
    const results = {};
    for (const [idx, name] of [[14, "左"], [15, "右"], [12, "上"], [13, "下"]]) {
      // 每个方向都先按一下反方向腾出空间，保证该方向必然可动
      const back = { 14: 15, 15: 14, 12: 13, 13: 12 }[idx];
      await padPress(back);
      const before = await signature();
      await padPress(idx);
      let after = await signature();
      for (let i = 0; i < 12 && after === before; i++) { await sleep(100); after = await signature(); }
      results[name] = before !== after;
    }
    const bad = Object.keys(results).filter((k) => !results[k]);
    ok(bad.length === 0, "手柄十字键四个方向都能移动", "失效方向：" + bad.join("/"));
  }

  // 按住不放只应触发一次：连按计数应只 +1（用分数变化做代理太弱，
  // 这里直接数"移动次数"不可得，改用「按住 600ms 期间局面只变一次」的
  // 近似：按住期间移动后棋盘会补新方块，若连发会看到方块数异常增长）
  {
    const before = await ev("document.querySelectorAll('#tiles .tile').length");
    await ev("window.__pad.buttons[15].pressed = true; 1");
    await sleep(700);                     // 按住 700ms ≈ 40+ 帧
    await ev("window.__pad.buttons[15].pressed = false; 1");
    await sleep(300);
    const after = await ev("document.querySelectorAll('#tiles .tile').length");
    // 一次移动最多 +1 个方块；若边沿判断写错，40 帧会补出一整盘
    ok(after - before <= 1, "手柄按住不放只触发一次（边沿判断正确，没连发）",
      "方块数 " + before + " → " + after + "（连发会涨很多）");
  }

  // Y = buttons[3] 重开
  {
    await key("ArrowLeft");
    await sleep(300);
    const beforeY = await ev("Number(document.getElementById('score').textContent)");
    await padPress(3);
    const afterY = await ev("Number(document.getElementById('score').textContent)");
    ok(afterY === 0 && beforeY >= 0, "手柄 Y 键重开：分数归零", beforeY + " → " + afterY);
  }

  // B = buttons[1] 撤销
  {
    await key("ArrowLeft");
    await sleep(300);
    const beforeB = await ev("Number(document.getElementById('score').textContent)");
    await padPress(1);
    const afterB = await ev("Number(document.getElementById('score').textContent)");
    ok(afterB <= beforeB, "手柄 B 键撤销：分数回退", beforeB + " → " + afterB);
  }

  /* ══════════ 多档里程碑 + 礼花（2026-10-08 新增）══════════
     smoke.js 已在逻辑层证明「继续挑战后 4096 仍会弹」，这里证明
     **页面上**三件事真的发生：①弹窗内容对 ②礼花 canvas 真的出现
     ③礼花在最上层（没被弹窗盖住）。

     做法：直接改 localStorage 存档再刷新页面 —— 存档是启动时读的，
     这与真实「玩到那一步」在读档路径上等价，且不必真去凑方块。 */
  async function seedAndReload(cells, extra) {
    const payload = Object.assign({
      cells: cells, score: 0, best: 0, won: false, reached: 0, over: false, keep: false
    }, extra || {});
    await ev("(function(){ localStorage.setItem('g2048State', " +
             JSON.stringify(JSON.stringify(payload)) + "); return 1; })()");
    await send("Page.navigate", { url: URL_BASE + "/index.html" });
    await sleep(1400);
    for (let i = 0; i < 40; i++) {
      try {
        if (await ev("document.readyState === 'complete' && document.querySelectorAll('#tiles .tile').length >= 1")) break;
      } catch (e) {}
      await sleep(200);
    }
    await sleep(400);
  }

  // ① 盘上已是 4096（reached=0 走回推路径）→ 读档即弹 4096
  {
    await seedAndReload([[0, 0, 4096], [1, 0, 8]]);
    const shown = await ev("!document.getElementById('overlay').hidden");
    const title = await ev("(document.getElementById('ovTitle').textContent || '').trim()");
    ok(shown === true, "里程碑：读回已达 4096 的存档仍弹浮层（旧实现在此不弹）",
       "shown=" + shown);
    ok(title === "4096", "里程碑：浮层标题是 4096（不是写死的 2048）", "got " + title);
    const ovKeepVisible = await ev("!document.getElementById('ovKeep').hidden");
    ok(ovKeepVisible === true, "里程碑：4096 弹窗仍提供「继续挑战」按钮");
  }

  // ② 已达 2048 且已点过「继续挑战」→ 合并出 4096 必须再弹一次
  {
    await seedAndReload([[0, 0, 2048], [1, 0, 2048]],
                        { won: true, reached: 2048, keep: true });
    const shown0 = await ev("!document.getElementById('overlay').hidden");
    ok(shown0 === false, "里程碑：keep=true 时读档不弹（玩家已选择继续）",
       "shown=" + shown0);

    await key("ArrowLeft");
    await sleep(700);
    const shown = await ev("!document.getElementById('overlay').hidden");
    const title = await ev("(document.getElementById('ovTitle').textContent || '').trim()");
    ok(shown === true, "★ 继续挑战后合成 4096 仍然弹窗（用户报的缺陷）", "shown=" + shown);
    ok(title === "4096", "★ 浮层标题是 4096", "got " + title);

    // ③ 礼花 canvas 真的出现，且在弹窗之上
    const conf = await ev(`(function(){
      var cv = document.getElementById('confetti');
      if (!cv) return { found: false };
      var cs = getComputedStyle(cv);
      var ov = document.getElementById('overlay');
      var ovz = ov ? parseInt(getComputedStyle(ov).zIndex, 10) || 0 : 0;
      var cz = parseInt(cs.zIndex, 10) || 0;
      return { found: true, z: cz, overlayZ: ovz, aboveOverlay: cz > ovz,
               pointerEvents: cs.pointerEvents, w: cv.width, h: cv.height,
               position: cs.position };
    })()`);
    ok(conf && conf.found === true, "礼花：里程碑达成时 #confetti canvas 被创建",
       JSON.stringify(conf));
    if (conf && conf.found) {
      ok(conf.aboveOverlay === true, "礼花：z-index 高于弹窗（否则被弹窗盖住＝看不见）",
         "confetti z=" + conf.z + " overlay z=" + conf.overlayZ);
      ok(conf.pointerEvents === "none", "礼花：pointer-events:none（不能吃掉弹窗点击）",
         "got " + conf.pointerEvents);
      ok(conf.w > 0 && conf.h > 0, "礼花：canvas 有实际尺寸", conf.w + "x" + conf.h);
    }

    // ④ 弹窗按钮在礼花覆盖下仍可点（礼花不能挡住交互）
    const clickable = await ev(`(function(){
      var b = document.getElementById('ovKeep');
      if (!b) return 'no-btn';
      var r = b.getBoundingClientRect();
      if (!r.width) return 'zero-size';
      var el = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
      if (!el) return 'nothing';
      return (el === b || b.contains(el)) ? 'ok' : ('blocked-by:' + el.id + '.' + el.className);
    })()`);
    ok(clickable === "ok", "礼花：弹窗按钮在礼花之下仍可点击（未被 canvas 挡住）",
       "命中=" + clickable);
  }

  // ⑤ 重开一局后 reached 清零：再合成 2048 仍会庆祝
  {
    await seedAndReload([[0, 0, 1024], [1, 0, 1024]]);
    await key("ArrowLeft");
    await sleep(700);
    let title = await ev("(document.getElementById('ovTitle').textContent || '').trim()");
    ok(title === "2048", "里程碑：合成 2048 弹 2048", "got " + title);

    await ev("(function(){ var b=document.getElementById('ovKeep'); if(b) b.click(); return 1; })()");
    await sleep(300);
    await ev("(function(){ var b=document.getElementById('newBtn'); if(b) b.click(); return 1; })()");
    await sleep(600);
    await seedAndReload([[0, 0, 1024], [1, 0, 1024]]);
    await key("ArrowLeft");
    await sleep(700);
    title = await ev("(document.getElementById('ovTitle').textContent || '').trim()");
    ok(title === "2048", "★ 重开后再次合成 2048 仍会弹（reached 已清零）", "got " + title);
  }

  // ── 收尾：再查一次异常 ──────────────────────────
  ok(exceptions.length === 0, "全程无未捕获异常（收尾复查）", exceptions.slice(0, 2).join(" | "));

  console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
  if (fail) console.log("失败项：\n - " + fails.join("\n - "));
  console.log("");
  cleanup();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("探针崩溃：", e && e.message || e); process.exit(2); });
