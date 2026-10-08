/* =========================================================
   2048 逻辑冒烟测试（无浏览器）
   思路：不复制算法，而是给 src/js/app.js 造一套最小 DOM stub，
   让**真实的源码**在 node 里跑起来，再通过 DOM 观测结果。
   重点验证 2048 最容易写错的几处：
     ① 一行四连 2 2 2 2 → 4 4（而不是 8）
     ② 一次移动中同一个方块不能被合并两次（4 4 8 → 8 8 而非 16）
     ③ 无法移动时不应产生新方块 / 不应加分
     ④ 合并计分 = 合成值之和
     ⑤ 棋盘满且四向都堵 → over
   跑法： node _tools/smoke.js
   ========================================================= */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SRC = path.join(__dirname, "..", "src", "js", "app.js");

// ── 最小 DOM stub ──────────────────────────────────
function makeEl(tag) {
  const el = {
    tagName: (tag || "div").toUpperCase(),
    className: "",
    id: "",
    hidden: false,
    disabled: false,
    textContent: "",
    dataset: {},
    children: [],
    parentNode: null,
    style: { _v: {}, setProperty(k, v) { this._v[k] = v; }, removeProperty(k) { delete this._v[k]; } },
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      contains(c) { return this._s.has(c); }
    },
    attrs: {},
    listeners: {},
    offsetWidth: 1,
    appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); c.parentNode = null; return c; },
    setAttribute(k, v) { el.attrs[k] = String(v); },
    getAttribute(k) { return k in el.attrs ? el.attrs[k] : null; },
    querySelector(sel) { return qs(el, sel); },
    querySelectorAll(sel) { return qsa(el, sel); },
    addEventListener(t, fn) { (el.listeners[t] = el.listeners[t] || []).push(fn); },
    dispatch(t, ev) { (el.listeners[t] || []).forEach((fn) => fn(ev || {})); },
    get firstChild() { return el.children[0] || null; },
    get innerHTML() { return el._html || ""; },
    set innerHTML(v) {
      el._html = v;
      el.children = [];
      // 把字符串切成 token 流再嵌回去：.tile 的 innerHTML 现在是
      //   <div class="tile-inner"><span class="tile-face"></span></div>
      // 旧的单层解析拿不到 .tile-inner，新方块的弹跳就没目标挂。
      // 做法：手写一个简化 parser —— 遇到开标签就 push，遇到闭标签
      // 就 pop，文本节点忽略。够这个项目用。
      const re = /<(\/?)(\w+)([^>]*)>|([^<]+)/g;
      const stack = [el];
      let mm;
      while ((mm = re.exec(v))) {
        if (mm[4] !== undefined) continue;       // 文本节点，丢掉
        const isClose = mm[1] === "/";
        const tag = mm[2].toLowerCase();
        if (isClose) {
          if (stack.length > 1) stack.pop();
          continue;
        }
        const c = makeEl(tag);
        // 解析 class="..." 这种属性（够用了）
        const classMatch = /class=["']([^"']+)["']/.exec(mm[3] || "");
        if (classMatch) c.attrs.class = classMatch[1];
        const parent = stack[stack.length - 1];
        c.parentNode = parent;
        parent.children.push(c);
        // 自闭合标签要特殊处理：br / img / ... 这里都没用到，先不写
        if (!(mm[3] || "").endsWith("/")) stack.push(c);
      }
    }
  };
  return el;
}

// ── 极简 querySelector ────────────────────────────
// 只支持 `.className` 这种选择器 —— 对这个项目够了。
// 提到模块顶层是因为 makeEl 内部的 querySelector 也要用到。
function qsa(root, sel) {
  const out = [];
  function walk(e) {
    for (const c of e.children || []) {
      if (matches(c, sel)) out.push(c);
      walk(c);
    }
  }
  function matches(e, sel) {
    if (sel.startsWith(".")) return (e.attrs.class || "").split(/\s+/).includes(sel.slice(1));
    return false;
  }
  walk(root);
  return out;
}
function qs(root, sel) { return qsa(root, sel)[0] || null; }

function makeDoc() {
  const byId = {};
  const doc = {
    readyState: "complete",
    documentElement: makeEl("html"),
    listeners: {},
    getElementById(id) { return byId[id] || (byId[id] = Object.assign(makeEl("div"), { id })); },
    createElement: makeEl,
    querySelector(sel) { return qs(doc.documentElement, sel); },
    querySelectorAll(sel) { return qsa(doc.documentElement, sel); },
    addEventListener(t, fn) { (doc.listeners[t] = doc.listeners[t] || []).push(fn); },
    dispatch(t, ev) { (doc.listeners[t] || []).forEach((fn) => fn(ev || {})); }
  };
  return doc;
}

function makeStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear()
  };
}

// ── 起一个实例 ─────────────────────────────────────
// ⚠️ 传 seed 时必须把同一个 store 交给 boot —— 存档是**启动瞬间**读的，
//    换一个新 store 就等于没种上局面（这坑让首轮 12 条全红）。
function boot(seedCells, sharedStore) {
  const doc = makeDoc();
  const store = sharedStore || makeStore();
  // ⚠️ 真实 index.html 里 <div id="overlay" hidden> 带 hidden 属性，
  //    而 stub 默认 hidden=false。不补这一条的话 over() 恒为真，
  //    死局用例会变成**假绿**（首轮就是这样混过去的）。
  doc.getElementById("overlay").hidden = true;
  if (seedCells) {
    store.setItem("g2048State", JSON.stringify({
      cells: seedCells, score: 0, best: 0, won: false, over: false, keep: false
    }));
  }
  const timers = [];
  const sandbox = {
    document: doc,
    localStorage: store,
    console,
    Math,
    JSON,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    fonts: { ready: { then: (fn) => fn() } },   // 字体就绪回调：stub 直接同步执行
    ResizeObserver: undefined,
    // 手柄：node 里没有 navigator，给一个「永远没插手柄」的桩，
    // 让 initGamepad() 安静跳过而不是抛 ReferenceError。
    navigator: { getGamepads: () => null },
    requestAnimationFrame: undefined,
    window: {}
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.addEventListener = (t, fn) => { (sandbox._l = sandbox._l || {})[t] = (sandbox._l[t] || []).concat([fn]); };

  const code = fs.readFileSync(SRC, "utf8");
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "app.js" });

  return {
    doc, store, timers,
    // 跑到所有定时器清空（模拟动画收尾）
    async settle() {
      for (let guard = 0; guard < 50 && timers.length; guard++) {
        const batch = timers.splice(0, timers.length).sort((a, b) => (a.ms || 0) - (b.ms || 0));
        for (const t of batch) t.fn();
        await new Promise((r) => setImmediate(r));
      }
    },
    key(k) { doc.dispatch("keydown", { key: k, preventDefault() {} }); },
    // 读棋盘：从 #tiles 的子元素拿 (--x,--y,text)
    board() {
      const tilesEl = doc.getElementById("tiles");
      const out = [];
      for (const c of tilesEl.children) {
        out.push({
          x: Number(c.style._v["--x"]),
          y: Number(c.style._v["--y"]),
          v: Number(c.dataset.v)
        });
      }
      return out;
    },
    grid() {
      const g = [[null, null, null, null], [null, null, null, null], [null, null, null, null], [null, null, null, null]];
      for (const t of this.board()) if (!Number.isNaN(t.x) && !Number.isNaN(t.y)) g[t.y][t.x] = t.v;
      return g;
    },
    score() { return Number(doc.getElementById("score").textContent); },
    best() { return Number(doc.getElementById("best").textContent); },
    over() { return !doc.getElementById("overlay").hidden; },
    // 语义别名：这条读起来是「浮层是否可见」，比 over() 直白 ——
    // over() 只是因为它最初只用于「游戏结束」才叫这个名字。
    overlayShown() { return !doc.getElementById("overlay").hidden; },
    // 浮层标题（多档里程碑靠它区分 2048 / 4096 / 8192）
    overlayTitle() { return String(doc.getElementById("ovTitle").textContent || "").trim(); },
    // 点「继续挑战」（走真实的 click 监听，不直接改内部状态）
    keepGoing() { doc.getElementById("ovKeep").dispatch("click", {}); },
    /* ⚠️ 不要试图「只改 DOM 就换盘面」—— move() 走的是内部 grid，不是 DOM，
       那样改完按方向键读到的还是旧盘面（第一版就踩了这个坑）。
       正确做法是**改存档后重新 boot**：存档是启动瞬间读的。这同时也是在
       读档路径上做验证，且 reached 会由 reachedFromGrid() 从盘面回推，
       所以「盘上已有 2048，再合并出 4096」等价于真实玩到那一步。 */
    setSavedCells(cells) {
      const raw = JSON.parse(store.getItem("g2048State") || "{}");
      raw.cells = cells;
      // 保留 reached / keep —— 模拟「已经到过 2048 并点了继续挑战」的状态
      store.setItem("g2048State", JSON.stringify(raw));
      return this;
    },
    store
  };
}

// ── 断言 ───────────────────────────────────────────
let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
}
function rowEq(g, y, expect, name) {
  const got = g[y].map((v) => (v === null ? "_" : v)).join(",");
  const want = expect.map((v) => (v === null ? "_" : v)).join(",");
  // 新增的随机方块会落在别处，只比对我们关心的这一行非新增部分
  ok(got === want, name, "第 " + y + " 行 got[" + got + "] want[" + want + "]");
}

// 起一局并种好局面（存档是启动时读的，所以 seed 必须在 boot 之前）
async function fresh(cells) {
  const t = boot(cells);
  await t.settle();
  return t;
}

/* 在**同一个 store** 上重新起一局 —— 用于「已经玩到某一步，接着往下走」。
   ⚠️ 必须复用 t.store，否则新实例读不到上一步写下的存档。 */
async function reboot(t, cells) {
  const n = boot(cells, t.store);
  await n.settle();
  return n;
}

// 取某一行/列上「排好序的值序列」，忽略新增随机方块的位置影响：
// 断言时只检查目标格子的值，其他格子可能混入新方块。
function at(g, x, y) { return g[y] && g[y][x] !== undefined ? g[y][x] : null; }

// ── 用例 ───────────────────────────────────────────
async function main() {
  console.log("\n2048 · 逻辑冒烟（真实 src/js/app.js + DOM stub）\n");

  // ① 一行四连：2 2 2 2 左移 → 4 4，绝不能是 8
  {
    const t = await fresh([[0, 0, 2], [1, 0, 2], [2, 0, 2], [3, 0, 2]]);
    t.key("ArrowLeft");
    await t.settle();
    const g = t.grid();
    ok(at(g, 0, 0) === 4 && at(g, 1, 0) === 4, "四连 2 2 2 2 左移 → 4 4（不是 8）", "[" + g[0].join(",") + "]");
    ok(t.score() === 8, "四连合并计分 = 4+4 = 8", "got " + t.score());
  }

  // ② 一次移动中同一方块不能合并两次：4 4 8 → 8 8
  {
    const t = await fresh([[0, 0, 4], [1, 0, 4], [2, 0, 8]]);
    t.key("ArrowLeft");
    await t.settle();
    const g = t.grid();
    ok(at(g, 0, 0) === 8 && at(g, 1, 0) === 8, "4 4 8 左移 → 8 8（不是 16）", "[" + g[0].join(",") + "]");
  }

  // ③ 孤立合并：2 2 4 → 4 4
  {
    const t = await fresh([[0, 0, 2], [1, 0, 2], [2, 0, 4]]);
    t.key("ArrowLeft");
    await t.settle();
    const g = t.grid();
    ok(at(g, 0, 0) === 4 && at(g, 1, 0) === 4, "2 2 4 左移 → 4 4", "[" + g[0].join(",") + "]");
  }

  // ④ 右移方向正确：2 2 2 2 右移 → _ _ 4 4
  {
    const t = await fresh([[0, 0, 2], [1, 0, 2], [2, 0, 2], [3, 0, 2]]);
    t.key("ArrowRight");
    await t.settle();
    const g = t.grid();
    ok(at(g, 2, 0) === 4 && at(g, 3, 0) === 4, "四连右移 → _ _ 4 4", "[" + g[0].join(",") + "]");
  }

  // ⑤ 纵向：整列 2 2 2 2 上移 → 4 4（列 x=1）
  {
    const t = await fresh([[1, 0, 2], [1, 1, 2], [1, 2, 2], [1, 3, 2]]);
    t.key("ArrowUp");
    await t.settle();
    const g = t.grid();
    ok(at(g, 1, 0) === 4 && at(g, 1, 1) === 4, "整列四连上移 → 4 4（列 x=1）", "[y0=" + at(g, 1, 0) + " y1=" + at(g, 1, 1) + "]");
  }

  // ⑥ 无效的移动（方块已贴边）不产生新方块、不加分
  {
    const t = await fresh([[0, 0, 2]]);
    const beforeCount = t.board().length;
    const beforeScore = t.score();
    t.key("ArrowLeft");
    t.key("ArrowUp");
    await t.settle();
    ok(t.board().length === beforeCount, "无效移动不生成新方块", "before " + beforeCount + " after " + t.board().length);
    ok(t.score() === beforeScore, "无效移动不加分", "before " + beforeScore + " after " + t.score());
  }

  // ⑦ 死局判定：棋盘填满且四向皆堵 → over
  {
    const cells = [];
    // 棋盘格交替 2/4，任何方向都无相邻同值
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) cells.push([x, y, ((x + y) % 2) ? 4 : 2]);
    const t = await fresh(cells);
    ok(t.over(), "填满且四向皆堵 → 判定为 over");
  }

  // ⑧ 满棋盘但有可合并对 → 不该判 over
  {
    const cells = [];
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) cells.push([x, y, 2]);
    const t = await fresh(cells);
    ok(!t.over(), "满棋盘但有可合并对 → 不判 over");
    t.key("ArrowLeft");
    await t.settle();
    ok(t.score() > 0, "全 2 满盘左移后有得分", "got " + t.score());
  }

  // ⑨ 每次有效移动后恰好新增一个方块
  {
    const t = await fresh([[0, 0, 2], [3, 0, 2]]);
    const before = t.board().length;
    t.key("ArrowLeft");
    await t.settle();
    // 两个 2 合成一个 4（-1），再加一个新方块（+1）→ 净 0
    ok(t.board().length === before, "有效移动后：合并 -1 + 新增 +1 = 净 0", "before " + before + " after " + t.board().length);
  }

  // ⑩ 撤销：分数与棋盘回到上一步
  {
    const t = await fresh([[0, 0, 8], [1, 0, 8]]);
    const snapshot = JSON.stringify(t.grid());
    const s0 = t.score();
    t.key("ArrowLeft");
    await t.settle();
    ok(t.score() > s0, "合并后分数上升", s0 + " → " + t.score());
    t.doc.getElementById("undoBtn").dispatch("click");
    await t.settle();
    ok(JSON.stringify(t.grid()) === snapshot, "撤销后棋盘回到上一步", JSON.stringify(t.grid()) + " vs " + snapshot);
    ok(t.score() === s0, "撤销后分数回到上一步", "got " + t.score() + " want " + s0);
  }

  // ⑪ 最高分持久化跨局保留
  {
    // ⚠️ 走 boot(seed, store) 而不是自己再搭一遍 sandbox ——
    //    重复的 sandbox 会漏掉新加的 API（navigator / requestAnimationFrame
    //    就是这样漏过一次的），共用一份才不会一条用例一个标准。
    const st = makeStore();
    st.setItem("g2048Best", "4242");
    const t = boot([[0, 0, 2]], st);
    await t.settle();
    ok(t.best() === 4242, "最高分从 localStorage 读出并显示", "got " + t.best());
  }

  // ⑫ WASD 与方向键等价
  {
    const t = await fresh([[0, 0, 2], [1, 0, 2], [2, 0, 2], [3, 0, 2]]);
    t.key("a");
    await t.settle();
    const g = t.grid();
    ok(at(g, 0, 0) === 4 && at(g, 1, 0) === 4, "WASD 的 a 等价于 ArrowLeft", "[" + g[0].join(",") + "]");
  }

  // ⑬ 达成 2048 应触发胜利浮层（这是修过的那条 bug）
  {
    const t = await fresh([[0, 0, 1024], [1, 0, 1024]]);
    t.key("ArrowLeft");
    await t.settle();
    ok(t.over(), "1024+1024 → 触发胜利浮层（合并值计入达成判据）");
    ok(t.score() === 2048, "合成 2048 计入 2048 分", "got " + t.score());
  }

  // ⑭ R 键 = 重开（2026-10-07 新增）
  {
    const t = await fresh([[0, 0, 8], [1, 0, 8]]);
    t.key("ArrowLeft");
    await t.settle();
    ok(t.score() > 0, "先走一步拿到分数", "got " + t.score());
    t.key("r");
    await t.settle();
    ok(t.score() === 0, "R 键把分数清零", "got " + t.score());
    ok(t.board().length === 2, "R 键后棋盘回到开局 2 个方块", "got " + t.board().length);
    ok(!t.overlayShown(), "R 键后浮层关闭");
  }

  // ⑮ C 键 = 撤销（2026-10-07 新增）
  {
    const t = await fresh([[0, 0, 8], [1, 0, 8]]);
    const snap = JSON.stringify(t.grid());
    const s0 = t.score();
    t.key("ArrowLeft");
    await t.settle();
    ok(t.score() > s0, "合并后分数上升", s0 + " → " + t.score());
    t.key("c");
    await t.settle();
    ok(t.score() === s0, "C 键把分数撤销回去", "got " + t.score() + " want " + s0);
    ok(JSON.stringify(t.grid()) === snap, "C 键把棋盘撤销回去");
  }

  // ⚠️ 关键的回归守卫：C 不能抢走 D 的「右移」
  //    D 是 WASD 的右移键，撤销键挑的是 C。这两条一起守住，
  //    以后谁把撤销改成 D，这里立刻红。
  {
    const t = await fresh([[0, 0, 2], [1, 0, 2], [2, 0, 2], [3, 0, 2]]);
    const before = t.score();
    t.key("d");
    await t.settle();
    const g = t.grid();
    ok(at(g, 2, 0) === 4 && at(g, 3, 0) === 4, "D 键仍然是「右移」（没被撤销抢走）", "[" + g[0].join(",") + "]");
    ok(t.score() > before, "D 键按下去是移动不是撤销", "score " + before + " → " + t.score());
  }

  // ⑯ 大写也要认（CapsLock / Shift 组合会给出大写 key）
  {
    const t = await fresh([[0, 0, 8], [1, 0, 8]]);
    t.key("ArrowLeft");
    await t.settle();
    t.key("R");
    await t.settle();
    ok(t.score() === 0, "大写 R 同样重开（CapsLock 下也要能用）", "got " + t.score());
  }

  /* ══════════ ⑰ 多档里程碑（2026-10-08 新增）══════════
     🔴 这是本轮修的真实缺陷：旧实现只用布尔 won 记住「是否达成过 2048」，
        玩家点过「继续挑战」再合成 4096 / 8192 时既不庆祝也不弹窗。
        下面的用例**就是照着这个场景写的**，任何人改回布尔语义都会立刻红。 */
  {
    // 合成 2048 → 弹窗，标题应是 "2048"
    const t = await fresh([[0, 0, 1024], [1, 0, 1024]]);
    t.key("ArrowLeft");
    await t.settle();
    ok(t.overlayShown(), "⑰-1 合成 2048 → 弹出浮层");
    ok(t.overlayTitle() === "2048", "⑰-2 浮层标题是 2048", "got " + t.overlayTitle());
  }

  {
    // 读档时盘上已是 4096：应弹 4096 而不是写死的 2048，也不该不弹
    const t = await fresh([[0, 0, 4096], [1, 0, 8]]);
    ok(t.overlayShown(), "⑰-3 读回已达 4096 的存档 → 仍弹浮层（旧实现在此不弹）",
       "overlayShown=" + t.overlayShown());
    ok(t.overlayTitle() === "4096", "⑰-4 读档弹窗标题是 4096（不是写死的 2048）",
       "got " + t.overlayTitle());
  }

  {
    /* 核心场景：已达 2048 → 点「继续挑战」→ 再合成 4096。
       旧代码这一步既不庆祝也不弹窗，正是用户报的缺陷。
       ⚠️ 换盘面必须**重新 boot**（move() 读的是内部 grid 不是 DOM）。 */
    let t = await fresh([[0, 0, 1024], [1, 0, 1024]]);
    t.key("ArrowLeft");
    await t.settle();
    ok(t.overlayTitle() === "2048", "⑰-5 先达成 2048", "got " + t.overlayTitle());

    t.keepGoing();          // 点「继续挑战」
    await t.settle();
    ok(!t.overlayShown(), "⑰-6 点继续挑战后浮层关闭");

    // 重新 boot 到「盘上已有一个 2048，再来一对 2048」的局面
    t = await reboot(t, [[0, 0, 2048], [1, 0, 2048]]);
    t.keepGoing();          // 读档后又会弹 2048，先继续挑战
    await t.settle();
    t.key("ArrowLeft");
    await t.settle();
    ok(t.overlayShown(),
       "⑰-7 ★ 继续挑战后合成 4096 仍然弹窗（旧实现在此不弹）",
       "overlayShown=" + t.overlayShown());
    ok(t.overlayTitle() === "4096", "⑰-8 ★ 浮层标题是 4096", "got " + t.overlayTitle());
  }

  {
    // 一路到 8192：每跨一档都要再弹一次
    let t = await fresh([[0, 0, 1024], [1, 0, 1024]]);
    t.key("ArrowLeft"); await t.settle();          // → 2048
    t.keepGoing(); await t.settle();

    t = await reboot(t, [[0, 0, 2048], [1, 0, 2048]]);
    t.keepGoing(); await t.settle();               // 读档弹的 2048 先关掉
    t.key("ArrowLeft"); await t.settle();          // → 4096
    ok(t.overlayTitle() === "4096", "⑰-9 第二档 = 4096", "got " + t.overlayTitle());
    t.keepGoing(); await t.settle();

    t = await reboot(t, [[0, 0, 4096], [1, 0, 4096]]);
    t.keepGoing(); await t.settle();
    t.key("ArrowLeft"); await t.settle();          // → 8192
    ok(t.overlayTitle() === "8192", "⑰-10 第三档 = 8192（连跨两档都能弹）",
       "got " + t.overlayTitle());
  }

  {
    // 未跨新档位时不该重复弹窗（例如继续挑战后只做普通合并）
    const t = await fresh([[0, 0, 2048], [1, 0, 8]]);
    t.keepGoing(); await t.settle();
    ok(!t.overlayShown(), "⑰-11 继续挑战后无新档位 → 不再弹窗");
  }

  {
    // 重开必须把 reached 清零，否则下一局到 2048 不会庆祝
    let t = await fresh([[0, 0, 1024], [1, 0, 1024]]);
    t.key("ArrowLeft"); await t.settle();
    ok(t.overlayTitle() === "2048", "⑰-12 先达成 2048");
    t.key("r"); await t.settle();
    ok(!t.overlayShown(), "⑰-13 R 重开后浮层关闭");
    t = await reboot(t, [[0, 0, 1024], [1, 0, 1024]]);
    t.key("ArrowLeft"); await t.settle();
    ok(t.overlayShown() && t.overlayTitle() === "2048",
       "⑰-14 ★ 重开后再次合成 2048 仍会弹（reached 已清零）",
       "shown=" + t.overlayShown() + " title=" + t.overlayTitle());
  }

  console.log("\n结果：" + pass + " 通过 / " + fail + " 失败\n");
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
