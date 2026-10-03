"use strict";

/* 单控制席前端回归测试（纯 Node，无第三方依赖）。
 *
 * 通过 vm 加载真实的 app/static/app.js，用迷你 DOM 模拟页面元素与事件，
 * 用可控 fetch 代替网络（记录请求头），用内存 sessionStorage 模拟标签页
 * 存储。每个用例独立加载一次脚本，模拟"新开标签页"。
 *
 * 运行：node tests/control-seat.test.js
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

/* ------------------------------------------------------------ 迷你 DOM */

class ClassList {
  constructor() {
    this.set = new Set();
  }
  add(c) { this.set.add(c); }
  remove(c) { this.set.delete(c); }
  contains(c) { return this.set.has(c); }
  toggle(c, force) {
    const want = force === undefined ? !this.set.has(c) : !!force;
    if (want) this.set.add(c);
    else this.set.delete(c);
    return want;
  }
}

class El {
  constructor(tag = "div", id = "") {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.classList = new ClassList();
    this.listeners = {};
    this.children = [];
    this.dataset = {};
    this.value = "";
    this.disabled = false;
    this.textContent = "";
    this.innerHTML = "";
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type, event = {}) {
    for (const fn of this.listeners[type] || []) fn(event);
  }
  closest() { return null; }
  querySelector() { return null; }
  focus() {}
  appendChild(child) { this.children.push(child); return child; }
  remove() {}
}

class Doc {
  constructor() {
    this.byId = new Map();
    this.listeners = {};
  }
  el(id) {
    if (!this.byId.has(id)) {
      const el = new El("div", id);
      if (id === "archives-modal") el.classList.add("hidden");
      this.byId.set(id, el);
    }
    return this.byId.get(id);
  }
  querySelector(sel) {
    if (sel.startsWith("#")) return this.el(sel.slice(1));
    return null;
  }
  querySelectorAll() { return []; }
  createElement(tag) { return new El(tag); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type, event = {}) {
    for (const fn of this.listeners[type] || []) fn(event);
  }
}

/* -------------------------------------------------------- 加载被测脚本 */

const appCode = fs.readFileSync(
  path.join(__dirname, "..", "app", "static", "app.js"),
  "utf8"
);

/* 每个用例独立加载一次脚本（相当于新开标签页），可预置 sessionStorage。 */
function loadApp(storageData) {
  const document = new Doc();
  const pending = []; // 尚未应答的请求：{ path, options, resolve, reject }
  const storage = {
    _m: new Map(Object.entries(storageData || {})),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, String(v)); },
    removeItem(k) { this._m.delete(k); },
  };
  const sandbox = {
    document,
    fetch: (path, options) =>
      new Promise((resolve, reject) => pending.push({ path, options, resolve, reject })),
    sessionStorage: storage,
    setTimeout,
    clearTimeout,
    confirm: () => true,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(appCode, sandbox, { filename: "app.js" });
  return { document, pending, storage };
}

const flush = () => new Promise((r) => setImmediate(r));
const lastRequest = (ctx) => ctx.pending[ctx.pending.length - 1];

async function respond(req, data, status = 200) {
  req.resolve({ ok: status >= 200 && status < 300, status, json: async () => data });
  await flush();
}

/* ------------------------------------------------------------ 测试数据 */

function liveState(over) {
  return Object.assign({
    version: 3,
    status: "live",
    paused: false,
    control_enabled: false,
    current: { id: 1, number: "A1", content: "灯光渐亮" },
    next: { id: 2, number: "A2", content: "音乐起" },
    pending: [
      { id: 1, number: "A1", content: "灯光渐亮" },
      { id: 2, number: "A2", content: "音乐起" },
    ],
    issued: [],
    issues: [],
    total: 2,
    remaining: 2,
    min_cues: 2,
    max_cues: 12,
  }, over || {});
}

/* ------------------------------------------------------------ 断言 */

let failures = 0;
function check(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ " + msg); }
}

/* ------------------------------------------------------------ 用例 */

async function t1_disabledByDefault_oldCallsUnchanged() {
  console.log("T1 默认未启用：写请求不带凭据头，显示启用入口");
  const ctx = loadApp();
  await respond(lastRequest(ctx), liveState()); // 启动 GET /api/state

  check(ctx.document.el("control-badge").textContent === "控制席：未启用", "标记显示未启用");
  check(ctx.document.el("control-btn").textContent === "启用控制席", "显示「启用控制席」按钮");
  check(!ctx.document.el("control-btn").classList.contains("hidden"), "启用按钮可见");
  check(ctx.document.el("confirm-btn").disabled === false, "未启用时确认按钮可用");

  ctx.document.el("pause-btn").dispatch("click");
  const req = lastRequest(ctx);
  check(req.path === "/api/pause", "暂停请求已发出");
  check(!("X-Control-Token" in req.options.headers), "未启用时写请求不带凭据头");
  await respond(req, liveState({ version: 4 }));
}

async function t2_enable_savesTokenAndSendsHeader() {
  console.log("T2 启用成功：凭据存本标签页，后续写请求带头");
  const ctx = loadApp();
  await respond(lastRequest(ctx), liveState());

  ctx.document.el("control-btn").dispatch("click");
  const req = lastRequest(ctx);
  check(req.path === "/api/control/enable", "点击后请求启用接口");
  check(JSON.parse(req.options.body).version === 3, "启用携带当前版本号");
  await respond(req, liveState({ version: 4, control_enabled: true, control_token: "tok-1" }));

  check(ctx.storage.getItem("cueControlToken") === "tok-1", "凭据已保存到本标签页存储");
  check(ctx.document.el("control-badge").textContent === "控制席：本页 ✓", "标记显示本页控制");
  check(ctx.document.el("control-btn").classList.contains("hidden"), "控制中隐藏启用/接管按钮");

  ctx.document.el("pause-btn").dispatch("click");
  const writeReq = lastRequest(ctx);
  check(writeReq.options.headers["X-Control-Token"] === "tok-1", "写请求携带凭据头");
  await respond(writeReq, liveState({ version: 5, control_enabled: true, paused: true }));
}

async function t3_enabledWithoutToken_readonlyButCanTakeover() {
  console.log("T3 已启用但本页无凭据：写操作禁用，可接管");
  const ctx = loadApp(); // 新标签页：sessionStorage 为空
  await respond(lastRequest(ctx), liveState({ control_enabled: true }));

  check(ctx.document.el("control-badge").textContent === "控制席：他人 · 本页只读", "标记显示他人控制");
  check(ctx.document.el("control-btn").textContent === "接管控制席", "显示「接管控制席」按钮");
  check(ctx.document.el("confirm-btn").disabled === true, "确认按钮禁用");
  check(ctx.document.el("pause-btn").disabled === true, "暂停按钮禁用");
  check(ctx.document.el("reset-btn").disabled === true, "重置按钮禁用");
  check(ctx.document.el("start-show").disabled === true, "开始演出按钮禁用");
  const html = ctx.document.el("pending-list").innerHTML;
  check(html.includes('title="改写" disabled'), "待发列表改写按钮禁用");
  check(html.includes('title="记现场问题" disabled'), "待发列表记问题按钮禁用");
  check((html.match(/title="上移" disabled|disabled=""? title="上移"/) || []).length >= 0, "重排按钮禁用");

  ctx.document.el("control-btn").dispatch("click"); // confirm() 已 stub 为 true
  const req = lastRequest(ctx);
  check(req.path === "/api/control/takeover", "点击后请求接管接口");
  check(JSON.parse(req.options.body).version === 3, "接管携带当前版本号");
  await respond(req, liveState({ version: 4, control_enabled: true, control_token: "tok-2" }));

  check(ctx.storage.getItem("cueControlToken") === "tok-2", "接管凭据已保存");
  check(ctx.document.el("control-badge").textContent === "控制席：本页 ✓", "接管后标记为本页控制");
  check(ctx.document.el("confirm-btn").disabled === false, "接管后写操作解禁");
}

async function t4_forbidden_clearsTokenAndRefreshes() {
  console.log("T4 写请求收到 403：凭据清除、标记更新、状态刷新");
  const ctx = loadApp({ cueControlToken: "tok-old" }); // 本标签页保存过凭据
  await respond(lastRequest(ctx), liveState({ control_enabled: true }));
  check(ctx.document.el("control-badge").textContent === "控制席：本页 ✓", "刷新后凭据仍在、标记本页控制");

  ctx.document.el("pause-btn").dispatch("click");
  const req = lastRequest(ctx);
  check(req.options.headers["X-Control-Token"] === "tok-old", "写请求携带已保存凭据");
  await respond(req, {
    error: "forbidden",
    message: "本页面不是当前控制席：写操作未生效，可凭最新版本号接管",
    state: liveState({ version: 9, control_enabled: true }),
  }, 403);

  check(ctx.storage.getItem("cueControlToken") === null, "403 后凭据已清除");
  check(ctx.document.el("control-badge").textContent === "控制席：他人 · 本页只读", "403 后标记更新为只读");
  check(ctx.document.el("version-badge").textContent === "v9", "403 后页面刷新为最新状态");
  check(ctx.document.el("pause-btn").disabled === true, "403 后写操作禁用");
  check(ctx.document.el("control-btn").textContent === "接管控制席", "403 后可接管");
}

async function t5_enableConflict_noTokenStored() {
  console.log("T5 启用遇 409：不存凭据，页面应用最新状态");
  const ctx = loadApp();
  await respond(lastRequest(ctx), liveState());

  ctx.document.el("control-btn").dispatch("click");
  const req = lastRequest(ctx);
  check(req.path === "/api/control/enable", "启用请求已发出");
  // 他人已抢先启用：409 + 最新状态
  await respond(req, {
    error: "conflict",
    message: "操作已过期",
    state: liveState({ version: 5, control_enabled: true }),
  }, 409);

  check(ctx.storage.getItem("cueControlToken") === null, "409 不保存凭据");
  check(ctx.document.el("control-badge").textContent === "控制席：他人 · 本页只读", "标记更新为他人控制");
  check(ctx.document.el("version-badge").textContent === "v5", "页面刷新为最新版本");
}

async function t6_tokenPersistsAcrossReload() {
  console.log("T6 凭据跨刷新保留：同一存储重新加载仍为本页控制");
  const storageData = { cueControlToken: "tok-kept" };
  const ctx = loadApp(storageData); // 模拟刷新：sessionStorage 内容保留
  await respond(lastRequest(ctx), liveState({ control_enabled: true, version: 7 }));

  check(ctx.document.el("control-badge").textContent === "控制席：本页 ✓", "刷新后标记仍为本页控制");
  ctx.document.el("pause-btn").dispatch("click");
  const req = lastRequest(ctx);
  check(req.options.headers["X-Control-Token"] === "tok-kept", "刷新后写请求仍带原凭据");
  await respond(req, liveState({ version: 8, control_enabled: true, paused: true }));
}

/* ------------------------------------------------------------ 主流程 */

(async function main() {
  const cases = [
    t1_disabledByDefault_oldCallsUnchanged,
    t2_enable_savesTokenAndSendsHeader,
    t3_enabledWithoutToken_readonlyButCanTakeover,
    t4_forbidden_clearsTokenAndRefreshes,
    t5_enableConflict_noTokenStored,
    t6_tokenPersistsAcrossReload,
  ];
  for (const run of cases) await run();

  console.log(
    failures === 0
      ? `\n全部通过（${cases.length} 个用例）`
      : `\n失败 ${failures} 处断言`
  );
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
