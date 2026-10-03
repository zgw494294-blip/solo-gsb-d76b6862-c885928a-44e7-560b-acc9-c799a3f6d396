"use strict";

/* 最近一次从服务端拿到的状态；所有变更请求都携带 state.version。
 * 服务端版本不一致会返回 409 + 最新状态，页面据此刷新。 */
let state = null;
let editingId = null; // 正在编辑的待发提示 id
let editingIssueId = null; // 正在追加现场问题记录的提示 id（已发或待发）
let busy = false;     // 有请求在途时禁用确认按钮，防止重复点击
let prevStatus = null; // 上一帧状态，用于识别回到开场前的切换

/* ---------------------------------------------------------------- 单控制席
 * 启用后所有写操作须携带本标签页保存的凭据（请求头 X-Control-Token）。
 * 凭据存 sessionStorage：刷新保留、标签页之间各自独立；启用状态与凭据在
 * 服务端数据库中，跨场、刷新页面、重启服务都继续有效。 */

const CONTROL_TOKEN_KEY = "cueControlToken";
let controlToken = loadControlToken();

function loadControlToken() {
  try {
    if (typeof sessionStorage !== "undefined") {
      return sessionStorage.getItem(CONTROL_TOKEN_KEY) || null;
    }
  } catch (err) { /* 存储不可用时按无凭据处理 */ }
  return null;
}

function saveControlToken(token) {
  controlToken = token || null;
  try {
    if (typeof sessionStorage !== "undefined") {
      if (controlToken) sessionStorage.setItem(CONTROL_TOKEN_KEY, controlToken);
      else sessionStorage.removeItem(CONTROL_TOKEN_KEY);
    }
  } catch (err) { /* 存储不可用时仅保留在内存中 */ }
}

/* 本页是否具备控制资格：未启用控制席时任何页面可写；启用后须持有当前凭据。 */
function canWrite() {
  return !!state && (!state.control_enabled || !!controlToken);
}

function apiHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (controlToken) headers["X-Control-Token"] = controlToken;
  return headers;
}

/* 403：凭据缺失或已被接管替换——清除本页控制标记并刷新为最新状态。 */
function handleForbidden(data) {
  saveControlToken(null);
  if (data && data.state) applyState(data.state);
  else render();
  toast((data && data.message) || "本页面不是当前控制席，写操作未生效");
}

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

let toastTimer = null;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

/* ---------------------------------------------------------------- 请求 */

async function api(path, body) {
  busy = true;
  updateBusy();
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (res.status === 403) {
      // 凭据缺失或已被接管：清除本页控制标记，刷新为最新状态
      handleForbidden(data);
      return null;
    }
    if (res.status === 409) {
      // 操作过期：同版本已有其他先生效，用最新状态刷新页面
      applyState(data.state);
      toast("操作未生效：已有人先操作，页面已刷新为最新状态");
      return null;
    }
    if (!res.ok) {
      toast(data.error || "请求失败");
      return null;
    }
    applyState(data);
    return data;
  } catch (err) {
    toast("网络错误：" + err.message);
    return null;
  } finally {
    busy = false;
    updateBusy();
  }
}

function applyState(s) {
  state = s;
  if (editingId !== null && !s.pending.some((c) => c.id === editingId)) {
    editingId = null; // 正在编辑的提示已不在待发列表（如已被确认）
  }
  if (editingIssueId !== null &&
      !s.pending.some((c) => c.id === editingIssueId) &&
      !s.issued.some((c) => c.id === editingIssueId)) {
    editingIssueId = null; // 追加问题的提示已不在本场（归档 / 重置 / 开新场）
  }
  render();
}

function updateBusy() {
  const writable = canWrite(); // 非控制席禁用一切写操作（仍可接管）
  const btn = $("#confirm-btn");
  // 暂停期间禁用确认按钮（服务端同样会拒绝并返回 409）
  if (btn) btn.disabled = busy || !writable || !state || !state.current || state.paused;
  const archiveBtn = $("#archive-btn");
  if (archiveBtn) archiveBtn.disabled = busy || !writable || archiveSubmitting || !state || state.status === "setup";
  const pauseBtn = $("#pause-btn");
  if (pauseBtn) pauseBtn.disabled = busy || !writable || !state || state.status !== "live";
  const resetBtn = $("#reset-btn");
  if (resetBtn) resetBtn.disabled = busy || !writable;
  const startBtn = $("#start-show");
  if (startBtn) startBtn.disabled = busy || !writable;
  const controlBtn = $("#control-btn");
  if (controlBtn) controlBtn.disabled = busy;
}

/* 页头控制席标记：未启用 / 本页控制 / 他人控制（本页只读，可接管）。 */
function renderControl() {
  const badge = $("#control-badge");
  const btn = $("#control-btn");
  if (!badge || !btn) return;
  if (!state) {
    badge.textContent = "控制席：…";
    badge.className = "control-badge off";
    btn.classList.add("hidden");
    return;
  }
  if (!state.control_enabled) {
    badge.textContent = "控制席：未启用";
    badge.className = "control-badge off";
    btn.textContent = "启用控制席";
    btn.classList.remove("hidden");
  } else if (controlToken) {
    badge.textContent = "控制席：本页 ✓";
    badge.className = "control-badge own";
    btn.classList.add("hidden");
  } else {
    badge.textContent = "控制席：他人 · 本页只读";
    badge.className = "control-badge other";
    btn.textContent = "接管控制席";
    btn.classList.remove("hidden");
  }
}

/* 启用或接管控制席：凭当前版本号，成功返回的随机凭据只保存在本标签页。 */
async function claimControl(enabling) {
  busy = true;
  updateBusy();
  try {
    const res = await fetch(enabling ? "/api/control/enable" : "/api/control/takeover", {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ version: state.version }),
    });
    const data = await res.json();
    if (res.status === 409) {
      // 同版本已有其他操作先生效（含他人抢先启用/接管），刷新为最新状态
      applyState(data.state);
      toast("操作未生效：已有人先操作，页面已刷新为最新状态");
      return;
    }
    if (res.status === 403) { handleForbidden(data); return; }
    if (!res.ok) {
      toast(data.error || "请求失败");
      return;
    }
    saveControlToken(data.control_token); // 凭据仅保存在本标签页
    delete data.control_token;            // 不留在页面状态里
    applyState(data);
    toast(enabling
      ? "已启用控制席：本页面获得控制资格，其他页面变为只读"
      : "已接管控制席：原控制席凭据已失效");
  } catch (err) {
    toast("网络错误：" + err.message);
  } finally {
    busy = false;
    updateBusy();
  }
}

/* ---------------------------------------------------------------- 档案库 */

let archiveSubmitting = false; // 归档请求在途，禁用提交防止重复建档案
let currentDetail = null;      // 当前查看的档案详情（"以此开新场"使用）
let startSubmitting = false;   // 以此开新场请求在途，禁用提交防重复
/* 档案弹窗视图序号：进入列表/详情/归档表单/对照任一视图、或关闭弹窗时 +1。
 * 视图内发出的请求都记下发起时的序号；响应回来时序号不符，说明弹窗已关闭
 * 或已切到别的视图——无论成功、空列表还是失败都直接丢弃，不改写当前视图。 */
let archivesViewSeq = 0;

function statusLabel(status) {
  return status === "done" ? "已完成" : "提前收场";
}

/* 档案详情中的现场问题记录区块：按保存顺序，已发/待发状态与内容均为归档快照。 */
function archiveIssuesHtml(issues) {
  return `
    <h3>现场问题记录（${issues.length}）<span class="hint-inline">按保存顺序 · 随档案快照保存</span></h3>
    <ul class="issue-list">
      ${issues.length ? issues.map((it) => {
        const tag = it.cue_status === "issued"
          ? `<span class="tag issue-issued">已发</span>`
          : `<span class="tag issue-pending">待发</span>`;
        return `<li class="issue-item">
          <div class="issue-top">
            <span class="badge">${escapeHtml(it.cue_number)}</span>
            ${tag}
            <span class="time">${fmtTime(it.created_at)}</span>
          </div>
          <div class="issue-text">${escapeHtml(it.text)}</div>
          <div class="issue-cue-content" title="记录时该提示的内容快照">↳ ${escapeHtml(it.cue_content)}</div>
        </li>`;
      }).join("") : `<li class="empty">无（本场未记录现场问题）</li>`}
    </ul>`;
}

function fmtTime(iso) {
  return iso ? new Date(iso).toLocaleString() : "";
}

function openArchivesModal() {
  $("#archives-modal").classList.remove("hidden");
  loadArchiveList();
}

function closeArchivesModal() {
  archivesViewSeq++; // 关闭弹窗：列表/详情/对照的在途请求一并失效
  $("#archives-modal").classList.add("hidden");
}

async function apiGetJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

async function loadArchiveList() {
  const viewSeq = ++archivesViewSeq; // 进入列表视图：旧视图（含对照）在途请求失效
  currentDetail = null;
  $("#archives-title").textContent = "📚 档案库";
  $("#archives-body").innerHTML = `<p class="empty">加载中…</p>`;
  let data;
  try {
    data = await apiGetJson("/api/archives");
  } catch (err) {
    if (viewSeq !== archivesViewSeq) return; // 已离开列表或弹窗已关闭，过期失败不覆盖当前视图
    $("#archives-body").innerHTML = `<p class="empty">档案加载失败：${escapeHtml(err.message)}</p>`;
    return;
  }
  if (viewSeq !== archivesViewSeq) return; // 已离开列表或弹窗已关闭，丢弃过期响应
  const items = data.archives || [];
  const canArchive = state && state.status !== "setup" && canWrite();
  if (!items.length) {
    $("#archives-body").innerHTML = `
      <p class="empty">还没有归档档案。演出结束或提前收场后，可点击「归档本场」保存回看。</p>
      ${canArchive ? `<div class="actions"><button class="primary" data-action="archive-form">归档当前场次 🗂</button></div>` : ""}`;
    return;
  }
  $("#archives-body").innerHTML = `
    <div class="actions">
      ${canArchive ? `<button class="primary" data-action="archive-form">归档当前场次 🗂</button>` : ""}
      <button data-action="compare-view">场次对照 ⇄</button>
    </div>
    <ul class="archive-list">
      ${items.map((a) => `
        <li class="archive-item" data-action="archive-detail" data-id="${a.id}" tabindex="0">
          <span class="archive-name">${escapeHtml(a.name)}</span>
          <span class="archive-meta">
            <span class="tag ${a.status === "done" ? "done" : "early"}">${statusLabel(a.status)}</span>
            <span class="time">${fmtTime(a.archived_at)}</span>
          </span>
          <span class="archive-count">已发 ${a.issued_count} · 剩余 ${a.pending_count} · 问题 ${a.issue_count || 0}</span>
        </li>`).join("")}
    </ul>`;
}

async function loadArchiveDetail(id) {
  const viewSeq = ++archivesViewSeq; // 进入详情视图：旧视图在途请求失效
  $("#archives-title").textContent = "档案详情";
  $("#archives-body").innerHTML = `<p class="empty">加载中…</p>`;
  let a;
  try {
    a = await apiGetJson("/api/archives/" + encodeURIComponent(id));
  } catch (err) {
    if (viewSeq !== archivesViewSeq) return; // 已离开详情或弹窗已关闭，过期失败不覆盖当前视图
    $("#archives-body").innerHTML = `
      <p class="empty">档案加载失败：${escapeHtml(err.message)}</p>
      <div class="actions"><button data-action="archive-list">← 返回列表</button></div>`;
    return;
  }
  if (viewSeq !== archivesViewSeq) return; // 已离开详情或弹窗已关闭，丢弃过期响应
  currentDetail = a;
  const total = a.issued.length + a.pending.length;
  const canStart = state && state.status === "setup" && canWrite();
  $("#archives-body").innerHTML = `
    <div class="archive-detail-head">
      <div class="archive-detail-name">${escapeHtml(a.name)}</div>
      <div class="archive-detail-meta">
        <span class="tag ${a.status === "done" ? "done" : "early"}">${statusLabel(a.status)}</span>
        归档时间：${fmtTime(a.archived_at)}
      </div>
    </div>
    <div class="archive-columns">
      <div>
        <h3>已发记录（${a.issued.length}）<span class="hint-inline">按发出顺序</span></h3>
        <ul class="cue-list">
          ${a.issued.length ? a.issued.map((c) => `
            <li class="issued-item">
              <span class="badge done">✓ ${escapeHtml(c.number)}</span>
              <span class="content">${escapeHtml(c.content)}</span>
              <span class="time">${fmtTime(c.issued_at)}</span>
            </li>`).join("")
            : `<li class="empty">无已发记录（开场后未发出即收场）</li>`}
        </ul>
      </div>
      <div>
        <h3>剩余未发（${a.pending.length}）<span class="hint-inline">按待发顺序</span></h3>
        <ul class="cue-list">
          ${a.pending.length ? a.pending.map((c) => `
            <li class="pending-item">
              <span class="badge">${escapeHtml(c.number)}</span>
              <span class="content">${escapeHtml(c.content)}</span>
            </li>`).join("")
            : `<li class="empty">无（全部提示均已发出）</li>`}
        </ul>
      </div>
    </div>
    ${archiveIssuesHtml(a.issues || [])}
    <div class="actions">
      <button data-action="archive-list">← 返回列表</button>
      <button id="start-from-archive" class="primary" data-action="start-from-archive"
        ${canStart ? "" : "disabled"}>以此开新场 ▶</button>
    </div>
    <p class="hint">
      ${canStart
        ? `将按<b>已发顺序</b>取 ${a.issued.length} 条编号与内容快照，再接<b>待发顺序</b>的 ${a.pending.length} 条，共 ${total} 条全部作为新场待发提示；不继承发出时间或进度，原档案保持不变。`
        : !state || state.status !== "setup"
          ? "仅开场前（设置页）可以此开新场；当前场次进行中，请先收场或重新开始。"
          : "本页面不是当前控制席：接管后方可以此开新场。"}
    </p>`;
}

function openArchiveForm() {
  if (!state || state.status === "setup") {
    toast("开场前没有可归档的场次");
    return;
  }
  if (!canWrite()) {
    toast("本页面不是当前控制席：可接管后再归档");
    return;
  }
  archivesViewSeq++; // 进入归档表单视图：列表/对照的在途请求失效
  $("#archives-title").textContent = "归档本场";
  $("#archives-body").innerHTML = `
    <p class="hint">归档后本场将保存为独立档案，并清空当前提示、回到开场前设置；之后录入、重置和重启都不会影响档案。</p>
    <label class="field-label" for="archive-name">场次名称</label>
    <input id="archive-name" maxlength="60" placeholder="例如：10 月 1 日晚场" autocomplete="off">
    <p class="hint-inline">当前页面版本 v${state.version} · ${statusLabel(state.status === "done" ? "done" : "live")}</p>
    <div class="actions">
      <button id="archive-submit" class="primary" data-action="archive-submit">保存档案并收场 🗂</button>
      <button data-action="archive-cancel">取消</button>
    </div>`;
  $("#archives-modal").classList.remove("hidden");
  $("#archive-name").focus();
}

async function submitArchive() {
  if (archiveSubmitting) return;
  const input = $("#archive-name");
  const name = input.value.trim();
  if (!name) { toast("请输入场次名称"); input.focus(); return; }
  archiveSubmitting = true;
  const btn = $("#archive-submit");
  if (btn) btn.disabled = true;
  updateBusy();
  try {
    const res = await fetch("/api/archive", {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ version: state.version, name }),
    });
    const data = await res.json();
    if (res.status === 403) {
      handleForbidden(data);
      closeArchivesModal();
      return;
    }
    if (res.status === 409) {
      applyState(data.state);
      closeArchivesModal();
      toast("归档未生效：操作已过期，页面已刷新为最新状态");
      return;
    }
    if (!res.ok) {
      toast(data.error || "归档失败");
      if (btn) btn.disabled = false;
      return;
    }
    // 档案已落库且当前提示已一起清空（同一事务）
    applyState(data);
    toast(`已归档「${name}」，当前提示已清空`);
    loadArchiveList();
  } catch (err) {
    toast("网络错误：" + err.message);
    if (btn) btn.disabled = false;
  } finally {
    archiveSubmitting = false;
    updateBusy();
  }
}

async function submitStartFromArchive() {
  if (startSubmitting || !currentDetail) return;
  if (!state || state.status !== "setup") {
    toast("仅开场前可以此开新场");
    return;
  }
  const a = currentDetail;
  const total = a.issued.length + a.pending.length;
  const ok = confirm(
    `将以档案「${a.name}」开新场：\n` +
    `先按已发顺序取 ${a.issued.length} 条（编号与发出时内容快照），` +
    `再接待发顺序的 ${a.pending.length} 条，共 ${total} 条，全部作为待发提示。\n\n` +
    "不继承发出时间或进度，原档案不变。确认开始新场吗？"
  );
  if (!ok) return;
  startSubmitting = true;
  const btn = $("#start-from-archive");
  if (btn) btn.disabled = true;
  try {
    const res = await fetch("/api/archives/" + encodeURIComponent(a.id) + "/start", {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ version: state.version }),
    });
    const data = await res.json();
    if (res.status === 403) {
      handleForbidden(data);
      closeArchivesModal();
      return;
    }
    if (res.status === 409) {
      applyState(data.state);
      closeArchivesModal();
      toast("开新场未生效：非开场前或版本已过期，页面已刷新");
      return;
    }
    if (res.status === 404) {
      toast("档案不存在，可能已被删除");
      closeArchivesModal();
      return;
    }
    if (!res.ok) {
      toast(data.error || "开新场失败");
      if (btn) btn.disabled = false;
      return;
    }
    // 新场提示已写入且状态一并推进（同一事务）
    applyState(data);
    closeArchivesModal();
    toast(`已按档案「${a.name}」开始新场，共 ${total} 条待发提示`);
  } catch (err) {
    toast("网络错误：" + err.message);
    if (btn) btn.disabled = false;
  } finally {
    startSubmitting = false;
  }
}

/* ---------------------------------------------------------------- 场次对照 */

let compareSeq = 0; // 对照选择序号：切换场次即作废旧响应；离开视图/关闭弹窗由 archivesViewSeq 兜底

const COMPARE_STATUS = {
  issued: { label: "已发", cls: "issued" },
  pending: { label: "未发", cls: "pending" },
  missing: { label: "缺失", cls: "missing" },
};

function fmtSeconds(s, signed) {
  if (s === null || s === undefined) return "—";
  const v = Number(s).toFixed(3);
  return signed && s > 0 ? `+${v} s` : `${v} s`;
}

async function openCompareView() {
  const viewSeq = ++archivesViewSeq; // 进入对照视图：旧视图（含列表）在途请求失效
  $("#archives-title").textContent = "场次对照";
  $("#archives-body").innerHTML = `<p class="empty">加载中…</p>`;
  let data;
  try {
    data = await apiGetJson("/api/archives");
  } catch (err) {
    if (viewSeq !== archivesViewSeq) return; // 已离开对照或弹窗已关闭，过期失败不覆盖当前视图
    $("#archives-body").innerHTML = `
      <p class="empty">档案加载失败：${escapeHtml(err.message)}</p>
      <div class="actions"><button data-action="archive-list">← 返回列表</button></div>`;
    return;
  }
  // 已离开对照或弹窗已关闭：过期响应不得重建选择器、恢复默认组合或触发默认对照查询
  if (viewSeq !== archivesViewSeq) return;
  const items = data.archives || [];
  if (!items.length) {
    $("#archives-body").innerHTML = `
      <p class="empty">还没有归档档案，无法对照。演出结束或提前收场后，可先「归档本场」保存档案。</p>
      <div class="actions"><button data-action="archive-list">← 返回列表</button></div>`;
    return;
  }
  const optionsHtml = items.map((a) =>
    `<option value="${a.id}">#${a.id} ${escapeHtml(a.name)}（${statusLabel(a.status)} · ${fmtTime(a.archived_at)}）</option>`
  ).join("");
  $("#archives-body").innerHTML = `
    <p class="hint">按编号精确匹配两场提示，各场以<b>首条已发</b>提示的发出时间为零点比较节奏（暂停时长计入）。仅两侧均已发出且内容完全一致的编号才计算「对照 − 基准」秒数差，<b>正值表示对照场更晚</b>。</p>
    <div class="compare-selects">
      <div class="compare-field">
        <label for="compare-base">基准场次</label>
        <select id="compare-base">${optionsHtml}</select>
      </div>
      <div class="compare-field">
        <label for="compare-compare">对照场次</label>
        <select id="compare-compare">${optionsHtml}</select>
      </div>
    </div>
    <div id="compare-result"></div>
    <div class="actions"><button data-action="archive-list">← 返回列表</button></div>`;
  // 默认：基准选较早一场、对照选最新一场，便于直接看到差异
  $("#compare-compare").value = String(items[0].id);
  $("#compare-base").value = String(items.length > 1 ? items[1].id : items[0].id);
  compareSelectionChanged();
}

function compareSelectionChanged() {
  const baseId = $("#compare-base").value;
  const compareId = $("#compare-compare").value;
  if (!baseId || !compareId) {
    compareSeq++; // 作废旧响应并清空旧结果，避免残留
    $("#compare-result").innerHTML = `<p class="hint">请选择基准场次与对照场次。</p>`;
    return;
  }
  runCompare(Number(baseId), Number(compareId));
}

async function runCompare(baseId, compareId) {
  const seq = ++compareSeq; // 新选择作废旧响应；响应回来时序号不符即丢弃
  const viewSeq = archivesViewSeq; // 离开对照视图或关闭弹窗后，响应同样丢弃
  const result = $("#compare-result");
  result.innerHTML = `<p class="empty">对照中…</p>`;
  let res, data;
  try {
    res = await fetch(
      `/api/compare?base=${encodeURIComponent(baseId)}&compare=${encodeURIComponent(compareId)}`
    );
    data = await res.json();
  } catch (err) {
    if (seq !== compareSeq || viewSeq !== archivesViewSeq) return;
    result.innerHTML = `<p class="empty">对照失败：${escapeHtml(err.message)}</p>`;
    return;
  }
  // 场次已切换、已离开对照视图或弹窗已关闭：不用旧响应覆盖当前结果
  if (seq !== compareSeq || viewSeq !== archivesViewSeq) return;
  if (res.status === 404) {
    result.innerHTML = `<p class="empty">档案不存在，可能已被删除，请返回列表刷新。</p>`;
    return;
  }
  if (!res.ok) {
    result.innerHTML = `<p class="empty">对照失败：${escapeHtml(data.error || "请求失败")}</p>`;
    return;
  }
  renderCompareResult(data);
}

function compareSideHtml(side) {
  const meta = COMPARE_STATUS[side.status] || COMPARE_STATUS.missing;
  const content = side.content === null || side.content === undefined
    ? "—" : escapeHtml(side.content);
  const offset = side.offset_seconds === null || side.offset_seconds === undefined
    ? "" : `<div class="compare-offset">零点 +${fmtSeconds(side.offset_seconds)}</div>`;
  return `<span class="tag ${meta.cls}">${meta.label}</span>
    <div class="content">${content}</div>${offset}`;
}

function renderCompareResult(data) {
  const result = $("#compare-result");
  if (!result) return; // 已离开对照视图，丢弃结果
  const rows = data.rows || [];
  const comparable = rows.filter((r) => r.delta_seconds !== null).length;
  const emptyHint = comparable === 0
    ? `<p class="hint compare-no-match">⚠ 两场没有可对照的提示：需同一编号在两侧均已发出且内容完全一致，才能计算秒数差。</p>`
    : "";
  result.innerHTML = `
    ${emptyHint}
    <div class="compare-head">
      <span>编号</span>
      <span>基准 · ${escapeHtml(data.base.name)}</span>
      <span>对照 · ${escapeHtml(data.compare.name)}</span>
      <span>对照 − 基准</span>
    </div>
    ${rows.map((r) => {
      let deltaHtml;
      if (r.delta_seconds !== null) {
        const cls = r.delta_seconds > 0 ? "later" : r.delta_seconds < 0 ? "earlier" : "same";
        deltaHtml = `<span class="compare-delta ${cls}">${fmtSeconds(r.delta_seconds, true)}</span>`;
      } else {
        deltaHtml = `<span class="compare-delta na">—</span>
          <div class="compare-reason">${escapeHtml(r.delta_reason || "")}</div>`;
      }
      return `<div class="compare-row">
        <span class="badge">${escapeHtml(r.number)}</span>
        <div class="compare-side">${compareSideHtml(r.base)}</div>
        <div class="compare-side">${compareSideHtml(r.compare)}</div>
        <div class="compare-delta-cell">${deltaHtml}</div>
      </div>`;
    }).join("")}
    <p class="hint">零点为各场首条已发提示的发出时间；秒数保留毫秒，暂停时长计入。共 ${rows.length} 个编号，其中 ${comparable} 条可对照。</p>`;
}

/* ---------------------------------------------------------------- 渲染 */

function render() {
  if (!state) return;
  $("#version-badge").textContent = "v" + state.version;
  renderControl(); // 刷新或收到 403 后都会走到这里，标记随之更新

  const inSetup = state.status === "setup";
  $("#setup-view").classList.toggle("hidden", !inSetup);
  $("#live-view").classList.toggle("hidden", inSetup);
  if (inSetup) {
    // 从演出中/完成回到开场前（开始前加载、重置或归档成功）时清空旧录入
    if (prevStatus !== "setup") resetSetupRows();
    prevStatus = "setup";
    return;
  }
  prevStatus = state.status;

  $("#done-banner").classList.toggle("hidden", state.status !== "done");
  $("#paused-banner").classList.toggle("hidden", !state.paused);
  $("#live-view").classList.toggle("paused", !!state.paused);
  const pauseBtn = $("#pause-btn");
  pauseBtn.textContent = state.paused ? "恢复发出 ▶" : "暂停发出 ⏸";
  pauseBtn.classList.toggle("primary", !!state.paused);
  pauseBtn.classList.toggle("warning-outline", !state.paused);
  $("#progress").textContent =
    `已发 ${state.issued.length} / 共 ${state.total} · 待发 ${state.remaining}`;

  const cur = state.current;
  $("#current-card").innerHTML = cur
    ? `<div class="card-label">当前待发</div>
       <div class="cue-number">${escapeHtml(cur.number)}</div>
       <div class="cue-content">${escapeHtml(cur.content)}</div>
       <button id="confirm-btn" class="primary big" data-action="confirm">${state.paused ? "已暂停 · 恢复后可发出 ⏸" : "确认发出 ✓"}</button>`
    : `<div class="card-label">当前待发</div><div class="empty">— 全部已发出 —</div>`;

  const nxt = state.next;
  $("#next-card").innerHTML = nxt
    ? `<div class="card-label">下一条</div>
       <div class="cue-number small">${escapeHtml(nxt.number)}</div>
       <div class="cue-content small">${escapeHtml(nxt.content)}</div>`
    : `<div class="card-label">下一条</div><div class="empty">— 无 —</div>`;

  renderPending();
  renderIssued();
  renderIssues();
  updateBusy();
}

function renderPending() {
  const ul = $("#pending-list");
  const items = state.pending;
  const writable = canWrite(); // 非控制席：改写 / 记问题 / 重排按钮全部禁用
  if (!items.length) {
    ul.innerHTML = `<li class="empty">全部提示已发出</li>`;
    return;
  }
  ul.innerHTML = items.map((c, i) => {
    if (c.id === editingIssueId) {
      return issueEditHtml(c, "pending");
    }
    if (c.id === editingId) {
      return `<li class="pending-item editing" data-id="${c.id}">
        <input class="num-input" value="${escapeHtml(c.number)}" maxlength="30" aria-label="编号">
        <span class="ops">
          <button class="primary" data-action="save-edit" data-id="${c.id}" ${writable ? "" : "disabled"}>保存</button>
          <button data-action="cancel-edit">取消</button>
        </span>
        <textarea class="content-input" rows="2" aria-label="内容">${escapeHtml(c.content)}</textarea>
      </li>`;
    }
    const tag = i === 0 ? `<span class="tag now">当前</span>`
              : i === 1 ? `<span class="tag next">下一条</span>` : "";
    return `<li class="pending-item ${i === 0 ? "is-current" : ""}" data-id="${c.id}">
      <span class="badge">${escapeHtml(c.number)}</span>
      <span class="content">${escapeHtml(c.content)}</span>
      ${tag}
      <span class="ops">
        <button data-action="edit" data-id="${c.id}" title="改写" ${writable ? "" : "disabled"}>✎</button>
        <button data-action="add-issue" data-id="${c.id}" title="记现场问题" ${writable ? "" : "disabled"}>⚠</button>
        <button data-action="up" data-idx="${i}" ${i === 0 || !writable ? "disabled" : ""} title="上移">↑</button>
        <button data-action="down" data-idx="${i}" ${i === items.length - 1 || !writable ? "disabled" : ""} title="下移">↓</button>
      </span>
    </li>`;
  }).join("");
}

function renderIssued() {
  const ul = $("#issued-list");
  const writable = canWrite();
  if (!state.issued.length) {
    ul.innerHTML = `<li class="empty">尚无已发记录</li>`;
    return;
  }
  ul.innerHTML = state.issued.map((c) => {
    if (c.id === editingIssueId) return issueEditHtml(c, "issued");
    const t = c.issued_at ? new Date(c.issued_at).toLocaleTimeString() : "";
    return `<li class="issued-item">
      <span class="badge done">✓ ${escapeHtml(c.number)}</span>
      <span class="content">${escapeHtml(c.content)}</span>
      <span class="time">${t}</span>
      <span class="ops">
        <button data-action="add-issue" data-id="${c.id}" title="记现场问题" ${writable ? "" : "disabled"}>⚠</button>
      </span>
    </li>`;
  }).join("");
}

/* 为一条已发/待发提示追加现场问题记录的内联表单（暂停时同样可用）。
 * 已发提示记录其发出快照，待发提示记录当前编号与内容。 */
function issueEditHtml(c, cueStatus) {
  const statusTag = cueStatus === "issued"
    ? `<span class="tag issue-issued">已发</span>`
    : `<span class="tag issue-pending">待发</span>`;
  return `<li class="issue-edit" data-id="${c.id}">
    <span class="badge">${escapeHtml(c.number)}</span>
    ${statusTag}
    <span class="ops">
      <button class="primary" data-action="save-issue" data-id="${c.id}" ${canWrite() ? "" : "disabled"}>保存记录</button>
      <button data-action="cancel-issue">取消</button>
    </span>
    <textarea class="issue-input" rows="2" maxlength="200"
      placeholder="现场问题（去除首尾空白后 1～200 字符）" aria-label="现场问题"></textarea>
    <p class="hint-inline issue-meta">将随版本 v${state.version} 保存为服务端时间的快照；不改提示进度${state.paused ? "，暂停时也可记录" : ""}。</p>
  </li>`;
}

async function saveIssue(id) {
  const li = $(`.issue-edit[data-id="${id}"]`);
  const input = li ? $(".issue-input", li) : null;
  const text = input ? input.value.trim() : "";
  if (!text) { toast("问题内容不能为空"); if (input) input.focus(); return; }
  if (text.length > 200) { toast("问题内容不能超过 200 字符"); if (input) input.focus(); return; }
  // 400（正文不合规）时 api 不刷新状态，表单与已输入文字保留；
  // 409 时 api 已应用最新状态并提示；成功后退出表单，记录出现在侧栏。
  const data = await api("/api/issues", { version: state.version, cue_id: id, text });
  if (data) {
    editingIssueId = null;
    render();
  }
}

function renderIssues() {
  const ul = $("#issues-list");
  const count = $("#issues-count");
  const issues = state.issues || [];
  if (count) count.textContent = issues.length ? `（${issues.length} 条，按保存顺序）` : "";
  if (!issues.length) {
    ul.innerHTML = `<li class="empty">尚无现场问题记录；点提示后的 ⚠ 可随时记录（含暂停时）</li>`;
    return;
  }
  ul.innerHTML = issues.map((it) => {
    const tag = it.cue_status === "issued"
      ? `<span class="tag issue-issued">已发</span>`
      : `<span class="tag issue-pending">待发</span>`;
    const t = it.created_at ? new Date(it.created_at).toLocaleString() : "";
    return `<li class="issue-item">
      <div class="issue-top">
        <span class="badge">${escapeHtml(it.cue_number)}</span>
        ${tag}
        <span class="time">${t}</span>
      </div>
      <div class="issue-text">${escapeHtml(it.text)}</div>
      <div class="issue-cue-content" title="记录时该提示的内容快照">↳ ${escapeHtml(it.cue_content)}</div>
    </li>`;
  }).join("");
}

/* ---------------------------------------------------------------- 设置页 */

function resetSetupRows() {
  $("#cue-rows").innerHTML = "";
  addRow();
  addRow();
}

function addRow() {
  const div = document.createElement("div");
  div.className = "cue-row";
  div.innerHTML = `
    <span class="row-index"></span>
    <input class="num" placeholder="编号（唯一）" maxlength="30">
    <input class="cnt" placeholder="提示内容（必填）">
    <button class="remove-row" title="删除此行">✕</button>`;
  div.querySelector(".remove-row").addEventListener("click", () => {
    if ($$(".cue-row").length <= state.min_cues) {
      toast(`至少需要 ${state.min_cues} 条提示`);
      return;
    }
    div.remove();
    renumberRows();
  });
  $("#cue-rows").appendChild(div);
  renumberRows();
}

function renumberRows() {
  $$(".cue-row").forEach((r, i) => { $(".row-index", r).textContent = i + 1; });
  $("#add-row").disabled = $$(".cue-row").length >= state.max_cues;
}

/* ---------------------------------------------------------------- 事件 */

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn || btn.disabled) return;
  const action = btn.dataset.action;

  if (action === "confirm") {
    if (!state.current) return;
    api("/api/confirm", { version: state.version });
  } else if (action === "edit") {
    editingId = Number(btn.dataset.id);
    editingIssueId = null;
    render();
  } else if (action === "cancel-edit") {
    editingId = null;
    render();
  } else if (action === "save-edit") {
    const li = btn.closest("li");
    const number = $(".num-input", li).value.trim();
    const content = $(".content-input", li).value.trim();
    if (!number || !content) { toast("编号和内容都不能为空"); return; }
    const id = Number(btn.dataset.id);
    editingId = null;
    api("/api/edit", { version: state.version, cue_id: id, number, content });
  } else if (action === "up" || action === "down") {
    const ids = state.pending.map((c) => c.id);
    const i = Number(btn.dataset.idx);
    const j = action === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    api("/api/reorder", { version: state.version, order: ids });
  } else if (action === "add-issue") {
    const id = Number(btn.dataset.id);
    // 同一时刻只开一个问题记录表单
    editingIssueId = editingIssueId === id ? null : id;
    editingId = null;
    render();
  } else if (action === "cancel-issue") {
    editingIssueId = null;
    render();
  } else if (action === "save-issue") {
    saveIssue(Number(btn.dataset.id));
  }
});

$("#add-row").addEventListener("click", () => {
  if ($$(".cue-row").length >= state.max_cues) {
    toast(`最多 ${state.max_cues} 条提示`);
    return;
  }
  addRow();
});

$("#start-show").addEventListener("click", () => {
  const cues = $$(".cue-row").map((r) => ({
    number: $(".num", r).value.trim(),
    content: $(".cnt", r).value.trim(),
  }));
  if (cues.length < state.min_cues || cues.length > state.max_cues) {
    toast(`提示数量需在 ${state.min_cues}～${state.max_cues} 条之间`);
    return;
  }
  if (cues.some((c) => !c.number)) { toast("编号不能为空"); return; }
  if (new Set(cues.map((c) => c.number)).size !== cues.length) {
    toast("编号必须唯一");
    return;
  }
  if (cues.some((c) => !c.content)) { toast("内容不能为空"); return; }
  api("/api/setup", { cues });
});

$("#reset-btn").addEventListener("click", () => {
  if (!confirm("确定要清空当前进度，重新设置本场提示吗？")) return;
  api("/api/reset", {});
});

$("#pause-btn").addEventListener("click", () => {
  if (!state || state.status !== "live") return;
  // 提交目标暂停状态与页面所见版本号；同版本的其他操作先生效时会拿到 409
  api("/api/pause", { version: state.version, paused: !state.paused });
});

$("#control-btn").addEventListener("click", () => {
  if (!state || busy) return;
  if (!state.control_enabled) {
    claimControl(true); // 未启用：本页启用并成为控制席
    return;
  }
  if (controlToken) return; // 本页已是控制席（按钮此时隐藏，双保险）
  if (!confirm("接管后原控制席的凭据立即失效，其后续写操作将被拒绝（对方可凭最新版本号再次接管）。确定接管控制席吗？")) return;
  claimControl(false);
});

/* ---------------------------------------------------------------- 档案事件 */

$("#archives-btn").addEventListener("click", openArchivesModal);
$("#archive-btn").addEventListener("click", openArchiveForm);
$("#archives-close").addEventListener("click", closeArchivesModal);
$("#archives-modal").addEventListener("click", (e) => {
  if (e.target === $("#archives-modal")) closeArchivesModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#archives-modal").classList.contains("hidden")) {
    closeArchivesModal();
  }
});

$("#archives-body").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn || btn.disabled) return;
  const action = btn.dataset.action;
  if (action === "archive-form") {
    openArchiveForm();
  } else if (action === "archive-list") {
    loadArchiveList();
  } else if (action === "archive-cancel") {
    closeArchivesModal();
  } else if (action === "archive-submit") {
    submitArchive();
  } else if (action === "archive-detail") {
    loadArchiveDetail(Number(btn.dataset.id));
  } else if (action === "start-from-archive") {
    submitStartFromArchive();
  } else if (action === "compare-view") {
    openCompareView();
  }
});

$("#archives-body").addEventListener("change", (e) => {
  if (e.target.id === "compare-base" || e.target.id === "compare-compare") {
    compareSelectionChanged();
  }
});

$("#archives-body").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (e.target.id === "archive-name") {
    e.preventDefault();
    submitArchive();
    return;
  }
  const item = e.target.closest("[data-action='archive-detail']");
  if (item) loadArchiveDetail(Number(item.dataset.id));
});

/* ---------------------------------------------------------------- 启动 */

(async function init() {
  try {
    const res = await fetch("/api/state");
    applyState(await res.json());
  } catch (err) {
    toast("无法连接服务端：" + err.message);
  }
})();
