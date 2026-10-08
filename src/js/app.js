/* =========================================================
   2048 · 憩想站群小游戏
   纯原生、零依赖。DOM 方块常驻，靠 CSS transform 过渡滑动，
   与 style.css 里的 --slide 时长保持一致。
   ========================================================= */
(function () {
  "use strict";

  var SIZE = 4;
  /* 里程碑档位（2026-10-08 由单一常量 WIN 改多档）。
     🔴 旧实现的缺陷：只用布尔 won 记「是否达成过 2048」，玩家点「继续挑战」后
        再合成 4096 / 8192 既不庆祝也不弹窗。现在改成「已跨过的最大档位」，
        每跨过一个新档位就再来一次礼花 + 弹窗。
     档位上限到 131072（4×4 理论上限远高于此，够用；再加只需往数组里补）。 */
  var MILESTONES = [2048, 4096, 8192, 16384, 32768, 65536, 131072];
  var WIN = MILESTONES[0];     // 保留：最低档仍叫 WIN，供存档兼容与文案判断
  var SLIDE_MS = 200;          // 必须与 css 的 --slide 一致（2026-10-07：110 → 200）
  var MERGE_MS = 340;          // 与 css 的 --merge 一致
  var APPEAR_MS = 300;         // 与 css 的 --appear 一致
  var SWIPE_MIN = 22;          // 手指滑动的最小位移（px）
  var STORE_KEY = "g2048State";

  var VECTORS = {
    up:    { x: 0, y: -1 },
    right: { x: 1, y: 0 },
    down:  { x: 0, y: 1 },
    left:  { x: -1, y: 0 }
  };

  var KEYS = {
    ArrowUp: "up", ArrowRight: "right", ArrowDown: "down", ArrowLeft: "left",
    w: "up", d: "right", s: "down", a: "left",
    W: "up", D: "right", S: "down", A: "left"
  };

  /* 功能键（2026-10-07）：R = 重开，C = 撤销。
     ⚠️ 撤销**故意不用 D** —— D 是 WASD 里的「右移」，抢过来会让 WASD
        缺一条腿（只剩 A/S/W 能移动）。C 与方向键、WASD 全都不冲突，
        是安全位置。改键前先确认新键没被 KEYS 占掉。
     ⚠️ R / C 都同时收大小写 —— 大写来自 CapsLock 或 Shift 组合。 */
  var ACTION_KEYS = {
    r: "restart", R: "restart",
    c: "undo", C: "undo"
  };

  var I18N = {
    winTitle: { zh: "2048", en: "2048" },
    winText:  { zh: "你合成了 2048。还可以继续往上叠。", en: "You made it to 2048. Keep stacking if you like." },
    /* 更高的里程碑：标题就是那个数字，正文用 %n 占位（运行时替换） */
    milestoneText: {
      zh: "你合成了 %n。下一个目标是 %next。",
      en: "You reached %n. Next stop: %next."
    },
    milestoneLast: {
      zh: "你合成了 %n —— 这已经是本作可玩到的最高档位，剩下的全靠你自己了。",
      en: "You reached %n — the highest tier here. The rest is up to you."
    },
    overTitle:{ zh: "无处可动了", en: "No moves left" },
    keepGoing:{ zh: "继续挑战", en: "Keep going" },
    tryAgain: { zh: "再来一局", en: "Try again" }
  };

  // ── 元素 ──────────────────────────────────────────
  var boardEl = document.getElementById("board");
  var tilesEl = document.getElementById("tiles");
  var scoreEl = document.getElementById("score");
  var bestEl = document.getElementById("best");
  var floatEl = document.getElementById("scoreFloat");
  var undoBtn = document.getElementById("undoBtn");
  var newBtn = document.getElementById("newBtn");
  var overlayEl = document.getElementById("overlay");
  var ovTitle = document.getElementById("ovTitle");
  var ovText = document.getElementById("ovText");
  var ovKeep = document.getElementById("ovKeep");
  var ovNew = document.getElementById("ovNew");
  var themeBtn = document.getElementById("themeBtn");
  var langBtn = document.getElementById("langBtn");
  var soundBtn = document.getElementById("soundBtn");
  var soundIcon = document.getElementById("soundIcon");

  // ── 状态 ──────────────────────────────────────────
  var grid;            // grid[y][x] = tile 对象 或 null
  var score = 0;
  var best = 0;
  var won = false;            // 本局是否已达成 2048（存档兼容字段，见 reached）
  var reached = 0;            // 本局已跨过的**最高档位**（0 = 还没到 2048）
  var over = false;
  var keepPlaying = false;    // 是否已选择「继续挑战」（每次弹窗后重置为 true）
  var prev = null;            // 一步撤销用的快照
  var seq = 0;                // tile id 自增
  var pending = null;         // 动画收尾任务
  var queued = null;          // 动画期间排队等待的下一个方向（防瞬移，见 move()）
  var lang = "zh";

  function tile(v, x, y) {
    return { id: ++seq, v: v, x: x, y: y, el: null, pendingValue: 0, dead: false };
  }

  function emptyGrid() {
    var g = [];
    for (var y = 0; y < SIZE; y++) {
      g.push([]);
      for (var x = 0; x < SIZE; x++) g[y].push(null);
    }
    return g;
  }

  function inBounds(x, y) { return x >= 0 && x < SIZE && y >= 0 && y < SIZE; }

  function eachCell(fn) {
    for (var y = 0; y < SIZE; y++) for (var x = 0; x < SIZE; x++) fn(x, y, grid[y][x]);
  }

  function forEachTile(fn) {
    for (var y = 0; y < SIZE; y++) {
      for (var x = 0; x < SIZE; x++) if (grid[y][x]) fn(grid[y][x]);
    }
  }

  // ── 存档 ──────────────────────────────────────────
  function loadPrefs() {
    try {
      best = parseInt(localStorage.getItem("g2048Best") || "0", 10) || 0;
      lang = localStorage.getItem("g2048Lang") === "en" ? "en" : "zh";
    } catch (e) {}
  }

  function saveState() {
    if (!boardEl) return;
    var cells = [];
    eachCell(function (x, y, t) { if (t) cells.push([x, y, t.v]); });
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        cells: cells, score: score, best: best, won: won, reached: reached,
        over: over, keep: keepPlaying
      }));
    } catch (e) {}
  }

  function restoreState() {
    var raw = null;
    try { raw = localStorage.getItem(STORE_KEY); } catch (e) { return false; }
    if (!raw) return false;
    var s;
    try { s = JSON.parse(raw); } catch (e) { return false; }
    if (!s || !Array.isArray(s.cells) || !s.cells.length) return false;

    grid = emptyGrid();
    for (var i = 0; i < s.cells.length; i++) {
      var c = s.cells[i];
      if (!Array.isArray(c) || c.length < 3) return false;
      if (!inBounds(c[0], c[1])) return false;
      grid[c[1]][c[0]] = tile(c[2], c[0], c[1]);
    }
    score = s.score || 0;
    won = !!s.won;
    /* reached 取「存档里的值」与「盘面回推值」的**较大者**。
       ⚠️ 不能只判 typeof —— 老存档压根没有该字段，而**写坏了的值**（比如
          reached=0 但盘上躺着 4096）同样会漏庆祝。盘面才是既成事实的真相，
          所以两边取大；这样字段缺失、字段为 0、字段偏小三种情形都收敛。 */
    reached = Math.max(
      typeof s.reached === "number" ? s.reached : 0,
      reachedFromGrid()
    );
    over = !!s.over;
    keepPlaying = !!s.keep;
    return true;
  }

  /* 盘面上已达成的最高档位（把所有方块值归到不超过它的最大档位）。 */
  function reachedFromGrid() {
    var m = 0;
    eachCell(function (x, y, t) { if (t && t.v > m) m = t.v; });
    var top = 0;
    for (var i = 0; i < MILESTONES.length; i++) {
      if (m >= MILESTONES[i]) top = MILESTONES[i];
    }
    return top;
  }

  // ── DOM ───────────────────────────────────────────
  function createEl(t) {
    var el = document.createElement("div");
    el.className = "tile";
    // 两层结构：.tile 只做位移，.tile-inner 承载外观与弹跳。
    // 见 style.css 里"方块分两层"的注释 —— 这是瞬移 bug 的根治。
    el.innerHTML = '<div class="tile-inner"><span class="tile-face"></span></div>';
    tilesEl.appendChild(el);
    t.el = el;
    // data-tid：给方块一个**稳定身份**（跟随逻辑对象 t.id，不跟随数值）。
    // 探针靠它逐帧追踪同一个方块 —— 只靠 data-v 会在合并/翻倍后错位。
    el.dataset.tid = t.id;
    paint(t);
    return el;
  }

  function paint(t) {
    if (!t.el) return;
    var s = String(t.v);
    t.el.dataset.v = s;
    t.el.dataset.len = s.length;
    t.el.dataset.tid = t.id;
    t.el.style.setProperty("--x", t.x);
    t.el.style.setProperty("--y", t.y);
    var face = t.el.querySelector(".tile-face");
    if (face) face.textContent = s;
  }

  function moveEl(t) {
    if (!t.el) return;
    t.el.style.setProperty("--x", t.x);
    t.el.style.setProperty("--y", t.y);
  }

  // 强制让所有现存方块重新触发 transform（CSS 变量变化时浏览器对
  // 已渲染的 transform 不一定重算，特别是只改了 --step/--cell-px
  // 而没动 --x/--y 的情况）。
  function repaintTiles() {
    forEachTile(function (t) {
      if (!t.el) return;
      t.el.style.setProperty("--x", t.x);
      t.el.style.setProperty("--y", t.y);
    });
  }

  function clearTiles() {
    if (tilesEl) tilesEl.innerHTML = "";
  }

  function renderAll() {
    clearTiles();
    forEachTile(function (t) { t.el = null; createEl(t); });
  }

  function addRandomTile(isInitial) {
    var spots = [];
    eachCell(function (x, y, t) { if (!t) spots.push({ x: x, y: y }); });
    if (!spots.length) return null;
    var p = spots[Math.floor(Math.random() * spots.length)];
    var v = Math.random() < 0.9 ? 2 : 4;
    var t = tile(v, p.x, p.y);
    grid[p.y][p.x] = t;
    createEl(t);
    if (!isInitial) {
      t.el.classList.add("tile-new");
      var el = t.el;
      // 用常量而不是写死 200 —— 动画时长改了这里必须跟着改，
      // 否则类会被提前摘掉，动画被截断（表现为"方块闪一下就没了"）。
      setTimeout(function () { el.classList.remove("tile-new"); }, APPEAR_MS);
    }
    return t;
  }

  // ── 移动 ──────────────────────────────────────────
  function buildTraversals(vec) {
    var xs = [], ys = [];
    for (var i = 0; i < SIZE; i++) { xs.push(i); ys.push(i); }
    // 靠目标边最近的先处理，保证合并链条正确
    if (vec.x === 1) xs.reverse();
    if (vec.y === 1) ys.reverse();
    return { xs: xs, ys: ys };
  }

  function findFarthest(x, y, vec) {
    var px = x, py = y, nx = x + vec.x, ny = y + vec.y;
    while (inBounds(nx, ny) && !grid[ny][nx]) {
      px = nx; py = ny; nx += vec.x; ny += vec.y;
    }
    return {
      far: { x: px, y: py },
      next: inBounds(nx, ny) ? { x: nx, y: ny } : null
    };
  }

  function snapshot() {
    var cells = [];
    eachCell(function (x, y, t) { if (t) cells.push([x, y, t.v]); });
    return { cells: cells, score: score, won: won, reached: reached, keep: keepPlaying };
  }

  function restoreSnapshot(s) {
    grid = emptyGrid();
    for (var i = 0; i < s.cells.length; i++) {
      var c = s.cells[i];
      grid[c[1]][c[0]] = tile(c[2], c[0], c[1]);
    }
    score = s.score;
    won = s.won;
    reached = typeof s.reached === "number" ? s.reached : 0;
    keepPlaying = s.keep;
    over = false;
    prev = null;
    renderAll();
    updateHud();
    hideOverlay();
    saveState();
  }

  function move(dir) {
    if (over || !grid) return;
    var vec = VECTORS[dir];
    if (!vec) return;

    // ⚠️ 上一次移动的动画还没收尾时，**不要** flush 后立刻再动 ——
    //    flush 会把"还在半路"的方块瞬间拉到终点（实测单帧跳 334.5px，
    //    一格才 111px，就是肉眼看到的"瞬移"）。
    //    改成**排队**：等这次收尾完成后立刻补上，手感是连贯的，也不丢操作。
    if (pending) {
      queued = dir;            // 只留最后一次，避免堆积成一长串
      return;
    }

    var before = snapshot();
    var trav = buildTraversals(vec);
    var moved = false;
    var gained = 0;
    var merges = [];         // { survivor, absorbed, v }
    var maxV = 0;

    forEachTile(function (t) { t.mergedThisMove = false; t.pendingValue = 0; });

    for (var iy = 0; iy < SIZE; iy++) {
      for (var ix = 0; ix < SIZE; ix++) {
        var x = trav.xs[ix], y = trav.ys[iy];
        var t = grid[y][x];
        if (!t) continue;

        var f = findFarthest(x, y, vec);
        var nextT = f.next ? grid[f.next.y][f.next.x] : null;

        if (nextT && nextT.v === t.v && !nextT.mergedThisMove) {
          // 合并：absorbed 滑到 survivor 的位置，survivor 结束后翻倍
          t.x = f.next.x;
          t.y = f.next.y;
          t.dead = true;
          moveEl(t);
          if (t.el) t.el.style.zIndex = "1";

          nextT.mergedThisMove = true;
          nextT.pendingValue = t.v * 2;
          if (nextT.el) nextT.el.style.zIndex = "2";

          grid[y][x] = null;
          merges.push({ survivor: nextT, absorbed: t, v: t.v * 2 });
          gained += t.v * 2;
          moved = true;
        } else if (f.far.x !== x || f.far.y !== y) {
          grid[f.far.y][f.far.x] = t;
          grid[y][x] = null;
          t.x = f.far.x;
          t.y = f.far.y;
          moveEl(t);
          moved = true;
        }

        if (grid[y][x] && grid[y][x].v > maxV) maxV = grid[y][x].v;
      }
    }

    forEachTile(function (t) { if (t.v > maxV) maxV = t.v; });
    // ⚠️ 上面只看方块**当前**的值，而合并的结果要等动画收尾才写回。
    //    漏掉这一步的话，1024+1024 那一次会被判成 maxV=1024 → 达成 2048 漏判。
    for (var mi = 0; mi < merges.length; mi++) {
      if (merges[mi].v > maxV) maxV = merges[mi].v;
    }

    if (!moved) return;

    prev = before;
    score += gained;

    /* 这一手跨过了哪个档位？取 maxV 落在的最高档，且必须**高于已记的 reached**。
       用 maxV 而不是「只看这一手的合并值」是刻意的：撤销再重做、或读档后
       盘上已经躺着 4096 的情况都能自然收敛。 */
    var hit = 0;
    for (var hi = 0; hi < MILESTONES.length; hi++) {
      if (maxV >= MILESTONES[hi]) hit = MILESTONES[hi];
    }
    var crossed = hit > reached ? hit : 0;

    // 动画收尾：移除被吸收的方块、给存活方块翻倍并弹一下、补一个新方块
    pending = {
      merges: merges,
      gained: gained,
      crossed: crossed
    };
    var job = pending;
    setTimeout(function () {
      if (pending !== job) return;   // 已经被 flush 掉了
      flushPending();
    }, SLIDE_MS + 20);
  }

  function flushPending() {
    if (!pending) return;
    var job = pending;
    pending = null;

    for (var i = 0; i < job.merges.length; i++) {
      var m = job.merges[i];
      if (m.absorbed.el && m.absorbed.el.parentNode) m.absorbed.el.parentNode.removeChild(m.absorbed.el);
      m.absorbed.el = null;
      m.survivor.v = m.survivor.pendingValue || m.survivor.v * 2;
      m.survivor.pendingValue = 0;
      m.survivor.dead = false;
      if (m.survivor.el) {
        m.survivor.el.classList.remove("tile-merge");
        // 强制重排，让同一元素能连续触发动画
        void m.survivor.el.offsetWidth;
        m.survivor.el.classList.add("tile-merge");
        m.survivor.el.style.zIndex = "";
        paint(m.survivor);
        var el = m.survivor.el;
        setTimeout(function () { el.classList.remove("tile-merge"); }, MERGE_MS);
      }
    }

    if (job.gained > 0) {
      showFloat("+" + job.gained);
      beep(job.gained);
    }

    // 跨过新档位：记下最高档、给所有达到该档的方块加呼吸光
    if (job.crossed) {
      reached = job.crossed;
      won = true;                     // 兼容旧字段：达成过最低档即 true
      forEachTile(function (t) {
        if (t.v >= reached && t.el) t.el.classList.add("tile-win");
      });
    }

    addRandomTile(false);
    updateHud();

    if (job.crossed) {
      /* 每跨过一个新档位都庆祝 + 弹窗 —— 这正是旧实现的缺陷所在：
         旧代码 `won && !keepPlaying` 在玩家点过「继续挑战」后永远为假，
         4096 / 8192 既不庆祝也不弹窗。现在改成每个新档位都弹一次。 */
      celebrate(job.crossed);
      keepPlaying = false;            // 每次弹窗都重置，下一个档位才会再弹
      showOverlay("win", job.crossed);
    } else if (!movesAvailable()) {
      over = true;
      showOverlay("over");
    }

    saveState();

    // 消费排队的输入：上一次动画期间玩家又按了一个方向，
    // 现在收尾已完成，立刻补上 —— 不掉操作，也不会让方块半路跳位。
    if (queued) {
      var next = queued;
      queued = null;
      move(next);
    }
  }

  function movesAvailable() {
    for (var y = 0; y < SIZE; y++) {
      for (var x = 0; x < SIZE; x++) {
        var t = grid[y][x];
        if (!t) return true;
        if (x + 1 < SIZE && grid[y][x + 1] && grid[y][x + 1].v === t.v) return true;
        if (y + 1 < SIZE && grid[y + 1][x] && grid[y + 1][x].v === t.v) return true;
      }
    }
    return false;
  }

  // ── 界面 ──────────────────────────────────────────
  function updateHud() {
    scoreEl.textContent = String(score);
    if (score > best) {
      best = score;
      try { localStorage.setItem("g2048Best", String(best)); } catch (e) {}
    }
    bestEl.textContent = String(best);
    undoBtn.disabled = !prev;
  }

  var floatTimer = null;
  function showFloat(text) {
    if (!floatEl) return;
    floatEl.textContent = text;
    floatEl.classList.remove("run");
    void floatEl.offsetWidth;
    floatEl.classList.add("run");
    clearTimeout(floatTimer);
    floatTimer = setTimeout(function () { floatEl.classList.remove("run"); }, 950);
  }

  /* ── 礼花（达成里程碑时放） ────────────────────────
     一次性 canvas，粒子放完自己摘掉。
     ⚠️ prefers-reduced-motion 下**直接不画**（但弹窗照常开）——
        对前庭敏感的用户，满屏高速粒子比弹窗难受得多。
     ⚠️ 每次调用先 stop 掉上一场：连跨两档（少见但可能）时别叠好几层 canvas，
        叠层会让帧率掉一半且旧 canvas 永远摘不掉。 */
  var CONF_N = 150;
  /* 与 2048 色阶同族的暖色盘 —— 和方块配色是一套语言 */
  var CONF_PAL = ["#f4d271", "#e8b34a", "#f09a5b", "#e07a5f", "#d9c27a",
                  "#f2e3b3", "#c9a227", "#e6cfa8"];
  var conf = null;

  function confettiStop() {
    if (!conf) return;
    if (conf.raf) window.cancelAnimationFrame(conf.raf);
    if (conf.cv && conf.cv.parentNode) conf.cv.parentNode.removeChild(conf.cv);
    conf = null;
  }

  function celebrate(milestone) {
    var still = false;
    try { still = window.matchMedia("(prefers-reduced-motion:reduce)").matches; } catch (e) {}
    if (still) return;
    confettiStop();

    /* ⚠️ 整段用 try 兜住：canvas 不可用（老浏览器 / 无头环境 / 测试桩）
       时**绝不能连累主流程** —— 礼花是锦上添花，弹窗和游戏本身必须照常。
       这里不是「为测试让路」，而是真实存在的降级路径。 */
    try {
      var cv = document.createElement("canvas");
      cv.id = "confetti";
      cv.setAttribute("aria-hidden", "true");
      document.body.appendChild(cv);
      var W = window.innerWidth, H = window.innerHeight;
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
      var ctx = cv.getContext && cv.getContext("2d");
      if (!ctx) { confettiStop(); return; }
      ctx.scale(dpr, dpr);

    /* 档位越高的里程碑，礼花越大 —— 8192 该比 2048 更值得看 */
    var power = 1 + Math.min(1.2, Math.log(milestone / WIN) / Math.log(8));
    var n = Math.round(CONF_N * power);

    var ps = [];
    /* delay 以「帧」记：两翼比主角晚十几帧到，像两发礼炮先后响 */
    function burst(x, y, ang, spread, num, sp, delayMax) {
      for (var i = 0; i < num; i++) {
        var a = ang + (Math.random() - .5) * spread;
        var v = sp * (0.5 + Math.random() * 0.85);
        ps.push({
          x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
          w: 5 + Math.random() * 7, h: 8 + Math.random() * 11,
          rot: Math.random() * Math.PI, vr: (Math.random() - .5) * .34,
          col: CONF_PAL[Math.floor(Math.random() * CONF_PAL.length)],
          age: 0, delay: Math.random() * (delayMax || 0),
          life: 1, decay: .004 + Math.random() * .0038,
          rib: Math.random() < .3
        });
      }
    }
    burst(W / 2, H * 0.42, -Math.PI / 2, Math.PI * 1.08, Math.round(n * .42), 12.5, 0);
    burst(0, H + 6, -Math.PI / 3.1, Math.PI * .34, Math.round(n * .29), 18, 16);
    burst(W, H + 6, -(Math.PI - Math.PI / 3.1), Math.PI * .34, Math.round(n * .29), 18, 16);

    var start = 0, prevT = 0;
    conf = { cv: cv, raf: 0 };
    function frame(now) {
      if (!start) { start = now; prevT = now; }
      var dt = Math.min(2.6, (now - prevT) / 16.67) || 1;   // 归一化成「60fps 下几帧」
      prevT = now;
      ctx.clearRect(0, 0, W, H);
      var alive = 0;
      for (var i = 0; i < ps.length; i++) {
        var p = ps[i];
        if (p.life <= 0) continue;
        p.age += dt;
        if (p.age < p.delay) { alive++; continue; }   // 还没轮到它出场，但别提前收场
        p.vy += .24 * dt;                             // 重力
        var drag = Math.pow(.985, dt);
        p.vx *= drag; p.vy *= drag;
        p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
        p.life -= p.decay * dt;
        if (p.life <= 0) continue;
        alive++;
        ctx.save();
        ctx.globalAlpha = p.life > 1 ? 1 : p.life;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.col;
        var hh = p.rib ? p.h * 2.2 : p.h;
        ctx.fillRect(-p.w / 2, -hh / 2, p.w, hh);
        ctx.restore();
      }
      if (alive && now - start < 4000) conf.raf = window.requestAnimationFrame(frame);
      else confettiStop();
    }
    conf.raf = window.requestAnimationFrame(frame);
    } catch (e) { confettiStop(); }   // 礼花失败绝不影响游戏
  }

  function showOverlay(kind, milestone) {
    if (!overlayEl) return;
    var t = lang === "en" ? I18N.winTitle.en : I18N.winTitle.zh;
    var txt = lang === "en" ? I18N.winText.en : I18N.winText.zh;
    if (kind === "over") {
      t = lang === "en" ? I18N.overTitle.en : I18N.overTitle.zh;
      txt = (lang === "en" ? "Final score " : "本局得分 ") + score + (lang === "en" ? "." : "。");
    } else if (kind === "win" && milestone) {
      /* 档位化的文案：标题就是那个数字；正文给出下一个目标，
         已是最后一档时换一句收尾（不给不存在的 next）。 */
      t = String(milestone);
      var idx = MILESTONES.indexOf(milestone);
      var next = idx >= 0 && idx + 1 < MILESTONES.length ? MILESTONES[idx + 1] : 0;
      var key = next ? "milestoneText" : "milestoneLast";
      txt = (lang === "en" ? I18N[key].en : I18N[key].zh)
        .replace("%n", milestone)
        .replace("%next", next);
    }
    ovTitle.textContent = t;
    ovText.textContent = txt;
    ovKeep.hidden = kind !== "win";
    overlayEl.hidden = false;
  }

  function hideOverlay() {
    if (overlayEl) overlayEl.hidden = true;
    if (ovKeep) ovKeep.hidden = true;
  }

  // ── 音效（WebAudio，无外部文件） ──────────────────
  var audioCtx = null;
  function soundOn() {
    try { return localStorage.getItem("g2048Sound") === "1"; } catch (e) { return false; }
  }
  function beep(gain) {
    if (!soundOn()) return;
    try {
      if (!audioCtx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        audioCtx = new AC();
      }
      if (audioCtx.state === "suspended") audioCtx.resume();
      var now = audioCtx.currentTime;
      var osc = audioCtx.createOscillator();
      var g = audioCtx.createGain();
      // 合成出的数字越大，音高越高
      var n = Math.min(11, Math.round(Math.log(gain) / Math.log(2)));
      osc.type = "triangle";
      osc.frequency.value = 220 * Math.pow(2, (n - 1) / 12);
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.06, now + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
      osc.connect(g);
      g.connect(audioCtx.destination);
      osc.start(now);
      osc.stop(now + 0.18);
    } catch (e) {}
  }

  // ── 主题 / 语言 ───────────────────────────────────
  function applyLang() {
    var nodes = document.querySelectorAll("[data-zh][data-en]");
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var txt = lang === "en" ? n.getAttribute("data-en") : n.getAttribute("data-zh");
      if (txt) n.textContent = txt;
    }
    document.documentElement.setAttribute("lang", lang === "en" ? "en" : "zh-CN");
    if (langBtn) langBtn.textContent = lang === "en" ? "中文" : "EN";
  }

  function initTools() {
    if (themeBtn) {
      var cur = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
      themeBtn.textContent = cur === "light" ? "◑" : "◐";
      themeBtn.addEventListener("click", function () {
        var next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
        document.documentElement.setAttribute("data-theme", next);
        themeBtn.textContent = next === "light" ? "◑" : "◐";
        try { localStorage.setItem("g2048Theme", next); } catch (e) {}
      });
    }

    if (langBtn) {
      langBtn.addEventListener("click", function () {
        lang = lang === "en" ? "zh" : "en";
        try { localStorage.setItem("g2048Lang", lang); } catch (e) {}
        applyLang();
      });
    }

    if (soundBtn) {
      soundIcon.textContent = soundOn() ? "🔈" : "🔇";
      soundBtn.setAttribute("aria-pressed", soundOn() ? "true" : "false");
      soundBtn.addEventListener("click", function () {
        var on = !soundOn();
        try { localStorage.setItem("g2048Sound", on ? "1" : "0"); } catch (e) {}
        soundIcon.textContent = on ? "🔈" : "🔇";
        soundBtn.setAttribute("aria-pressed", on ? "true" : "false");
        if (on) beep(4);
      });
    }

    if (newBtn) newBtn.addEventListener("click", function () { startGame(); });
    if (undoBtn) undoBtn.addEventListener("click", function () {
      if (prev) restoreSnapshot(prev);
    });

    if (ovKeep) ovKeep.addEventListener("click", function () {
      keepPlaying = true;
      hideOverlay();
      saveState();
    });
    if (ovNew) ovNew.addEventListener("click", function () { startGame(); });
  }

  // ── 输入 ──────────────────────────────────────────

  /* 统一的「动作」入口：按钮、键盘、手柄三条路都走这里，
     避免以后加新入口时漏掉某条（重开要清浮层、撤销要判断有没有快照）。 */
  function doRestart() {
    flushPending();
    startGame();
    beep(4);
  }

  function doUndo() {
    if (!prev) return;
    flushPending();
    restoreSnapshot(prev);
    beep(4);
  }

  function initInput() {
    document.addEventListener("keydown", function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var tag = e.target && e.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      var act = ACTION_KEYS[e.key];
      if (act) {
        e.preventDefault();
        if (act === "restart") doRestart();
        else if (act === "undo") doUndo();
        return;
      }

      var dir = KEYS[e.key];
      if (!dir) return;
      e.preventDefault();
      move(dir);
    });

    if (!boardEl) return;

    var sx = 0, sy = 0, tracking = false;

    boardEl.addEventListener("pointerdown", function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      tracking = true;
      sx = e.clientX;
      sy = e.clientY;
    });

    boardEl.addEventListener("pointermove", function (e) {
      if (!tracking) return;
      var dx = e.clientX - sx;
      var dy = e.clientY - sy;
      if (Math.abs(dx) < SWIPE_MIN && Math.abs(dy) < SWIPE_MIN) return;
      tracking = false;
      if (Math.abs(dx) > Math.abs(dy)) move(dx > 0 ? "right" : "left");
      else move(dy > 0 ? "down" : "up");
    });

    function stop() { tracking = false; }
    boardEl.addEventListener("pointerup", stop);
    boardEl.addEventListener("pointercancel", stop);
    boardEl.addEventListener("pointerleave", stop);

    initGamepad();
  }

  /* ── 手柄（Gamepad API）─────────────────────────────
     映射：十字键 D-pad 控方向；B = 撤销；Y = 重开（与键盘的 C / R 一致）。
     接线：
       buttons[12] = D-pad 上 / [13] 下 / [14] 左 / [15] 右
       buttons[0]  = A / [1] = B / [2] = X / [3] = Y   ← 标准布局（Xbox 位序）
     实现要点：
       ⚠️ Gamepad 是**轮询**的，没有 keydown 那样的事件 —— 必须自己在
          rAF 里每帧读，并用「上一帧按下 / 这一帧按下」的**边沿**判断，
          否则按住不放会一帧连发几十次（实测表现为棋盘疯狂乱动）。
       ⚠️ 不用 rAF 而用 setInterval 的话，标签页切到后台会被节流到 1s+，
          手感全丢；rAF 在后台自动停，回来立刻恢复，正合适。
       ⚠️ navigator.getGamepads() 在没插手柄时返回 null（不是空数组），
          别直接 .length。 */
  function initGamepad() {
    if (!navigator.getGamepads || !window.requestAnimationFrame) return;

    var wasDown = {};          // 上一帧各键的按下状态
    var GAMEPAD_DIRS = { 12: "up", 13: "down", 14: "left", 15: "right" };
    var GAMEPAD_ACTIONS = { 1: "undo", 3: "restart" };   // B = 撤销，Y = 重开

    function poll() {
      var pads = navigator.getGamepads();
      if (pads) {
        for (var i = 0; i < pads.length; i++) {
          var pad = pads[i];
          if (!pad || !pad.buttons) continue;
          Object.keys(GAMEPAD_DIRS).forEach(function (idx) {
            var held = !!(pad.buttons[idx] && pad.buttons[idx].pressed);
            if (held && !wasDown[idx]) move(GAMEPAD_DIRS[idx]);
            wasDown[idx] = held;
          });
          Object.keys(GAMEPAD_ACTIONS).forEach(function (idx) {
            var held = !!(pad.buttons[idx] && pad.buttons[idx].pressed);
            if (held && !wasDown[idx]) {
              if (GAMEPAD_ACTIONS[idx] === "undo") doUndo();
              else doRestart();
            }
            wasDown[idx] = held;
          });
          break;              // 只用第一个连上的手柄，避免两只手同时触发
        }
      }
      requestAnimationFrame(poll);
    }

    requestAnimationFrame(poll);
  }

  // ── 开局 ──────────────────────────────────────────
  function startGame() {
    grid = emptyGrid();
    score = 0;
    won = false;
    reached = 0;
    over = false;
    keepPlaying = false;
    prev = null;
    pending = null;
    queued = null;      // 排队的方向也要清 —— 否则重开后会补执行上一次残留的输入
    seq = 0;
    clearTiles();
    hideOverlay();
    addRandomTile(true);
    addRandomTile(true);
    updateHud();
    saveState();
  }

  // ── 棋盘尺寸 ─────────────────────────────────────
  // 实测棋盘内框 → 算出每格 px 与每格 + gap 的位移步长，
  // 写到 CSS 变量 --cell-px / --step / --step-y。CSS 里禁止再用
  // 100% 推算任何跟"格子尺寸"有关的东西（不同包含块上 100% 算出来
  // 不一致，方块宽 100 但格间距 112 → 全部跑位）。
  //
  // ⚠️ 不要用 `cells[4]` 之类的下标反推步长 —— grid 是 4×4 时下标
  // 推断与代码注释很容易错位（cell[4] = (1,0) 还是 (0,1) 全靠 grid
  // 的 auto-flow，浏览器差异会让下标在不同机器/主题下不同）。
  // 直接读 .cells 的 grid-template-columns 字符串，parse 出列宽，
  // 再 + column-gap，即得到 x 步长。y 同理。
  function measure() {
    if (!boardEl || !tilesEl) return;
    var cellsEl = document.querySelector(".cells");
    if (!cellsEl) return;
    var cs = getComputedStyle(cellsEl);
    var cols = cs.gridTemplateColumns.split(" ").map(parseFloat);
    var rows = cs.rowTemplate ? cs.gridTemplateRows.split(" ").map(parseFloat)
                              : cs.gridTemplateRows.split(" ").map(parseFloat);
    var colGap = parseFloat(cs.columnGap) || 0;
    var rowGap = parseFloat(cs.rowGap) || parseFloat(cs.gridRowGap) || 0;
    var cellW = cols[0] || 0;
    var cellH = rows[0] || 0;
    var stepX = cellW + colGap;
    var stepY = cellH + rowGap;

    // 兜底：grid 还没排好（首次 boot 在字体没加载时可能为 0），用棋盘内框推
    if (!(cellW > 0)) {
      var csRoot = getComputedStyle(document.documentElement);
      var pad = parseFloat(csRoot.getPropertyValue("--board-pad")) || 0;
      var gap = parseFloat(csRoot.getPropertyValue("--board-gap")) || 0;
      cellW = (boardEl.clientWidth - 2 * pad) / SIZE;
      cellH = (boardEl.clientHeight - 2 * pad) / SIZE;
      stepX = cellW + gap;
      stepY = cellH + gap;
    }

    tilesEl.style.setProperty("--cell-px", cellW + "px");
    tilesEl.style.setProperty("--step", stepX + "px");
    tilesEl.style.setProperty("--step-y", stepY + "px");
  }

  function onResize() {
    measure();
  }

  // ── 启动 ──────────────────────────────────────────
  function boot() {
    loadPrefs();
    applyLang();
    initTools();
    initInput();

    if (!boardEl || !tilesEl) return;   // 404 页面没有棋盘，只做主题/语言

    measure();
    // ⚠️ 防呆：测试用的 DOM stub 可能没给 window 加事件 API，
    // 真实浏览器一定有；这里走 (window || self || globalThis).addEventListener
    // 而不是裸 window.addEventListener，smoke 等无 window 的环境
    // 会安静跳过。
    var _evtHost = (typeof window !== "undefined" && window) || (typeof self !== "undefined" && self) || null;
    if (_evtHost && typeof _evtHost.addEventListener === "function") {
      _evtHost.addEventListener("resize", onResize);
      _evtHost.addEventListener("orientationchange", onResize);
    }
    if (_evtHost && _evtHost.ResizeObserver) {
      try { new _evtHost.ResizeObserver(onResize).observe(boardEl); } catch (e) {}
    }
    // ⚠️ measure() 的时机很关键：必须在 grid 真正把模板列宽算出来之后
    // 才准。字体异步加载会让 grid 列宽**先 0 再正确**，所以字体就绪后
    // 再量一次；并且 measure 跑了之后已存在的方块不会被重新定位，
    // 这里把所有现存 tile 重新触发 transform —— 否则首次 boot 时
    // 方块会带着错误的 --step 一直留在错的位置（CSS 变量更新了但
    // transform 没重算）。
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { measure(); repaintTiles(); });
    }

    if (restoreState()) {
      renderAll();
      updateHud();
      if (over) showOverlay("over");
      /* 读档时若已达档位且玩家尚未选择继续，恢复那个档位的弹窗
         （传 reached 而不是写死 2048 —— 读回一局已到 4096 的存档应弹 4096）。 */
      else if (reached && !keepPlaying) showOverlay("win", reached);
      else if (!movesAvailable()) { over = true; showOverlay("over"); }
    } else {
      startGame();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
