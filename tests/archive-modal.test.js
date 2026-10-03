"use strict";

/* 档案弹窗「过期响应」回归测试（纯 Node，无第三方依赖）。
 *
 * 通过 vm 加载真实的 app/static/app.js，用迷你 DOM 模拟页面元素与事件，
 * 用可控 fetch 代替网络：每个请求挂起后由测试手动决定返回顺序与成败，
 * 从而精确复现「关闭重开 / 返回列表 / 快速切换场次」时响应交错到达的场景。
 *
 * 运行：node tests/archive-modal.test.js
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
      if (id === "archives-modal") el.classList.add("hidden"); // 与 index.html 初始状态一致
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

/* ---------------------------------------------------------- 可控 fetch */

const pending = []; // 尚未应答的请求：{ path, resolve, reject }

function fetchStub(path) {
  return new Promise((resolve, reject) => pending.push({ path, resolve, reject }));
}

function jsonResponse(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

const flush = () => new Promise((r) => setImmediate(r)); // 排空微任务队列
const lastRequest = () => pending[pending.length - 1];

async function respond(req, data, status = 200) {
  req.resolve(jsonResponse(data, status));
  await flush();
}
const failHttp = (req, status = 500) => respond(req, { error: "HTTP " + status }, status);
async function failNetwork(req) {
  req.reject(new Error("网络中断"));
  await flush();
}

/* -------------------------------------------------------- 加载被测脚本 */

const document = new Doc();
const sandbox = {
  document,
  fetch: fetchStub,
  setTimeout,
  clearTimeout,
  confirm: () => true,
  console,
};
vm.createContext(sandbox);
const appCode = fs.readFileSync(
  path.join(__dirname, "..", "app", "static", "app.js"),
  "utf8"
);
vm.runInContext(appCode, sandbox, { filename: "app.js" });

/* ------------------------------------------------------------ 交互辅助 */

const bodyHtml = () => document.el("archives-body").innerHTML;
const titleText = () => document.el("archives-title").textContent;
const resultHtml = () => document.el("compare-result").innerHTML;

const openModal = () => document.el("archives-btn").dispatch("click");
const closeModal = () => document.el("archives-close").dispatch("click");
const closeModalByEscape = () => document.dispatch("keydown", { key: "Escape" });

function clickAction(action, dataset = {}) {
  const btn = {
    disabled: false,
    dataset: { action, ...dataset },
    closest(sel) { return sel === "[data-action]" ? this : null; },
  };
  document.el("archives-body").dispatch("click", { target: btn });
}

function changeSelect(id, value) {
  document.el(id).value = value;
  document.el("archives-body").dispatch("change", { target: { id } });
}

/* ------------------------------------------------------------ 测试数据 */

const TS1 = "2026-10-01T13:00:00+00:00";
const TS2 = "2026-10-02T13:00:00+00:00";

const ARCHIVE_LIST = {
  archives: [
    { id: 2, name: "10 月 2 日晚场", archived_at: TS2, status: "done", issued_count: 2, pending_count: 1 },
    { id: 1, name: "10 月 1 日晚场", archived_at: TS1, status: "live", issued_count: 2, pending_count: 1 },
  ],
};

const ARCHIVE_DETAIL = {
  id: 1,
  name: "10 月 1 日晚场",
  archived_at: TS1,
  status: "done",
  version: 4,
  issued: [{ number: "A1", content: "灯光渐亮", issued_at: "2026-10-01T13:01:00+00:00" }],
  pending: [{ number: "A2", content: "音乐起" }],
};

function compareData(marker) {
  return {
    base: { id: 1, name: `标记${marker}基准`, archived_at: TS1, status: "done", issued_count: 1, pending_count: 0 },
    compare: { id: 2, name: `标记${marker}对照`, archived_at: TS2, status: "done", issued_count: 1, pending_count: 0 },
    rows: [{
      number: "A1",
      base: { status: "issued", content: "灯光渐亮", offset_seconds: 0 },
      compare: { status: "issued", content: "灯光渐亮", offset_seconds: 2.5 },
      delta_seconds: 2.5,
      delta_reason: null,
    }],
  };
}

/* ------------------------------------------------------------ 断言 */

let failures = 0;
function check(cond, msg) {
  if (cond) console.log("  ✓ " + msg);
  else { failures++; console.error("  ✗ " + msg); }
}

/* 每个用例间复位：关闭弹窗（作废在途请求）并排空未应答请求 */
async function resetBetween() {
  closeModal();
  while (pending.length) pending.shift().reject(new Error("测试清理"));
  await flush();
}

/* ------------------------------------------------------------ 用例 */

async function t1_closeReopen_staleSuccessDiscarded() {
  console.log("T1 关闭重开：迟到的旧列表成功响应不覆盖新列表");
  openModal();
  const oldReq = lastRequest();
  check(oldReq.path === "/api/archives", "首次打开请求 GET /api/archives");
  closeModal();
  openModal();
  const newReq = lastRequest();
  check(newReq !== oldReq && newReq.path === "/api/archives", "关闭重开发起新的列表请求");

  await respond(oldReq, {
    archives: [{ id: 9, name: "旧响应场次", archived_at: TS1, status: "done", issued_count: 0, pending_count: 2 }],
  });
  check(bodyHtml().includes("加载中"), "旧成功响应返回后仍显示加载中（未覆盖）");
  check(!bodyHtml().includes("旧响应场次"), "旧响应的档案名未出现在页面上");

  await respond(newReq, ARCHIVE_LIST);
  check(bodyHtml().includes("10 月 2 日晚场"), "新响应正常渲染列表");
  check(titleText() === "📚 档案库", "标题保持档案库");
}

async function t2_closeReopen_staleFailureHidden_currentEmptyRenders() {
  console.log("T2 关闭重开：旧请求失败不显示错误，当前空列表正常渲染");
  openModal();
  const r1 = lastRequest();
  closeModalByEscape(); // 覆盖 Esc 关闭路径
  openModal();
  const r2 = lastRequest();

  await failHttp(r1, 500);
  check(!bodyHtml().includes("档案加载失败"), "旧请求的失败不显示错误");
  check(bodyHtml().includes("加载中"), "当前请求仍在加载中");

  await respond(r2, { archives: [] });
  check(bodyHtml().includes("还没有归档档案"), "当前空列表响应正常渲染");
}

async function t3_staleCompareArchivesResponse_noDefaultRestore() {
  console.log("T3 对照页的旧 /api/archives 响应：不恢复默认选择、不触发默认查询、不替换列表");
  openModal();
  await respond(lastRequest(), ARCHIVE_LIST);

  clickAction("compare-view");
  const compareReq = lastRequest();
  check(compareReq.path === "/api/archives", "进入对照请求 GET /api/archives");

  clickAction("archive-list"); // 未等对照页响应就返回列表
  await respond(lastRequest(), ARCHIVE_LIST);
  check(titleText() === "📚 档案库", "已返回列表视图");

  const inFlight = pending.length;
  await respond(compareReq, ARCHIVE_LIST); // 迟到的对照页响应
  check(titleText() === "📚 档案库", "旧响应未改写标题");
  check(!bodyHtml().includes("基准场次"), "旧响应未重建对照选择器（未恢复默认组合）");
  check(bodyHtml().includes("10 月 2 日晚场"), "对照页未被旧响应替换成别的内容，列表保持");
  check(pending.length === inFlight, "旧响应未触发默认组合对照查询");
}

async function t4_closeModal_inflightCompareDiscarded() {
  console.log("T4 关闭弹窗：在途对照请求无论成功或失败都失效");
  openModal();
  await respond(lastRequest(), ARCHIVE_LIST);
  clickAction("compare-view");
  await respond(lastRequest(), ARCHIVE_LIST);
  check(bodyHtml().includes("基准场次"), "对照视图渲染完成");

  const defaultReq = lastRequest();
  check(defaultReq.path === "/api/compare?base=1&compare=2", "默认组合查询 base/compare 参数不变");

  changeSelect("compare-base", "2");
  const selReq = lastRequest();
  check(selReq.path === "/api/compare?base=2&compare=2", "切换场次发起新对照请求");
  check(resultHtml().includes("对照中"), "切换后立即清空旧结果");

  closeModal();
  await respond(selReq, compareData("X"));
  check(resultHtml().includes("对照中"), "关闭后迟到的对照成功响应被丢弃");
  await failNetwork(defaultReq);
  check(resultHtml().includes("对照中"), "关闭后迟到的对照失败响应被丢弃");

  openModal();
  await respond(lastRequest(), ARCHIVE_LIST);
  check(bodyHtml().includes("10 月 2 日晚场"), "重开后列表正常加载");
}

async function t5_rapidSwitch_onlyLatestShown() {
  console.log("T5 快速切换场次：交错成功/失败，仅最新选择的响应可展示");
  openModal();
  await respond(lastRequest(), ARCHIVE_LIST);
  clickAction("compare-view");
  await respond(lastRequest(), ARCHIVE_LIST);

  const q1 = lastRequest(); // 默认 base=1&compare=2
  changeSelect("compare-compare", "1");
  const q2 = lastRequest(); // base=1&compare=1
  changeSelect("compare-base", "2");
  const q3 = lastRequest(); // base=2&compare=1
  check(q3.path === "/api/compare?base=2&compare=1", "最新选择发起对应请求");
  check(resultHtml().includes("对照中"), "快速切换后旧结果已清空");

  await respond(q3, compareData("C"));
  check(resultHtml().includes("标记C"), "最新选择的响应展示");

  await respond(q1, compareData("A"));
  check(resultHtml().includes("标记C") && !resultHtml().includes("标记A"), "更旧的成功响应不覆盖最新结果");

  await failHttp(q2, 500);
  check(resultHtml().includes("标记C") && !resultHtml().includes("对照失败"), "旧失败响应不覆盖最新结果");

  changeSelect("compare-compare", "2");
  const q4 = lastRequest();
  check(resultHtml().includes("对照中"), "再次切换立即清空旧结果");
  await failHttp(q4, 500);
  check(resultHtml().includes("对照失败"), "当前请求的失败正常显示错误");
}

async function t6_backToList_loadsAndShowsCurrentFailure() {
  console.log("T6 返回列表：正常加载；当前加载失败显示错误");
  openModal();
  await respond(lastRequest(), ARCHIVE_LIST);
  clickAction("compare-view");
  await respond(lastRequest(), ARCHIVE_LIST);
  await respond(lastRequest(), compareData("D"));
  check(resultHtml().includes("标记D"), "对照结果已展示");

  clickAction("archive-list");
  check(bodyHtml().includes("加载中"), "返回列表立即进入加载态");
  await respond(lastRequest(), ARCHIVE_LIST);
  check(bodyHtml().includes("10 月 2 日晚场") && titleText() === "📚 档案库", "返回列表正常加载");

  clickAction("compare-view");
  await respond(lastRequest(), ARCHIVE_LIST);
  clickAction("archive-list");
  await failHttp(lastRequest(), 500);
  check(bodyHtml().includes("档案加载失败"), "当前列表加载失败显示错误");
}

async function t7_staleDetailResponseDiscarded() {
  console.log("T7 离开详情视图：迟到的详情响应不覆盖列表");
  openModal();
  await respond(lastRequest(), ARCHIVE_LIST);

  clickAction("archive-detail", { id: "1" });
  const detailReq = lastRequest();
  check(detailReq.path === "/api/archives/1", "进入详情请求详情接口");

  clickAction("archive-list");
  await respond(lastRequest(), ARCHIVE_LIST);
  await respond(detailReq, ARCHIVE_DETAIL); // 迟到的详情响应
  check(titleText() === "📚 档案库", "迟到的详情响应不改写标题");
  check(bodyHtml().includes("10 月 2 日晚场"), "列表内容保持");
}

/* ------------------------------------------------------------ 主流程 */

(async function main() {
  // 启动：app.js 的 init() 请求 /api/state，应答一个演出中状态
  const stateReq = lastRequest();
  check(stateReq && stateReq.path === "/api/state", "启动时请求 GET /api/state");
  await respond(stateReq, {
    version: 3,
    status: "live",
    paused: false,
    current: { id: 1, number: "A1", content: "灯光渐亮" },
    next: { id: 2, number: "A2", content: "音乐起" },
    pending: [
      { id: 1, number: "A1", content: "灯光渐亮" },
      { id: 2, number: "A2", content: "音乐起" },
    ],
    issued: [],
    total: 2,
    remaining: 2,
    min_cues: 2,
    max_cues: 12,
  });

  const cases = [
    t1_closeReopen_staleSuccessDiscarded,
    t2_closeReopen_staleFailureHidden_currentEmptyRenders,
    t3_staleCompareArchivesResponse_noDefaultRestore,
    t4_closeModal_inflightCompareDiscarded,
    t5_rapidSwitch_onlyLatestShown,
    t6_backToList_loadsAndShowsCurrentFailure,
    t7_staleDetailResponseDiscarded,
  ];
  for (const run of cases) {
    await resetBetween();
    await run();
  }

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
