"use strict";

const state = {
  token: "",
  runs: [],
  total: 0,
  offset: 0,
  limit: 30,
  selectedId: null,
  detail: null,
  readiness: null,
  loading: false,
  streamAbort: null,
  streamCursor: "",
  streamBackoff: 1000,
  refreshTimer: null,
  selectedAttempt: null,
  selectedLog: 0,
};

const $ = (id) => document.getElementById(id);
const terminal = new Set(["SUCCEEDED", "NEEDS_HUMAN", "BUDGET_EXHAUSTED", "REJECTED", "FAILED", "CANCELLED"]);
const running = new Set(["AUTHORIZING", "PREPARING", "PROVISIONING", "BASELINING", "DIAGNOSING", "PATCHING", "VERIFYING", "PUBLISHING"]);

function node(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value == null || value === false) continue;
    if (key === "className") element.className = value;
    else if (key === "text") element.textContent = value;
    else if (key === "onClick") element.addEventListener("click", value);
    else if (key === "onSubmit") element.addEventListener("submit", value);
    else if (key === "disabled") element.disabled = Boolean(value);
    else if (key === "checked") element.checked = Boolean(value);
    else element.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

function replace(id, ...children) {
  $(id).replaceChildren(...children.flat(Infinity).filter(Boolean));
}

function formatDate(value, relative = false) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Invalid date";
  if (relative) {
    const seconds = Math.round((date.getTime() - Date.now()) / 1000);
    const divisions = [[60, "second"], [60, "minute"], [24, "hour"], [7, "day"], [4.345, "week"], [12, "month"], [Infinity, "year"]];
    let amount = seconds;
    for (const [divisor, unit] of divisions) {
      if (Math.abs(amount) < divisor) return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(Math.round(amount), unit);
      amount /= divisor;
    }
  }
  return date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function formatNumber(value) { return new Intl.NumberFormat().format(Number(value || 0)); }
function shortId(value) { return value ? `${value.slice(0, 8)}…${value.slice(-4)}` : "—"; }
function titleCase(value) { return String(value || "unknown").toLowerCase().replace(/[_-]+/g, " ").replace(/(^|\s)\S/g, (letter) => letter.toUpperCase()).replace(/\bGithub\b/g, "GitHub"); }

const statusLabels = {
  AUTHORIZING: "Checking access",
  PREPARING: "Preparing",
  PROVISIONING: "Getting code",
  BASELINING: "Running baseline",
  DIAGNOSING: "Investigating",
  PATCHING: "Preparing change",
  VERIFYING: "Running checks",
  AWAITING_CLARIFICATION: "Waiting for answer",
  PUBLISHING: "Publishing review",
  SUCCEEDED: "Completed",
  NEEDS_HUMAN: "Needs review",
  BUDGET_EXHAUSTED: "Run limit reached",
  REJECTED: "Not authorized",
  FAILED: "Could not complete",
  CANCELLED: "Cancelled",
};

function statusLabel(status) { return statusLabels[status] || titleCase(status); }
function modeLabel(mode) { return mode === "FIX" ? "Repair" : mode === "TEST" ? "Test only" : titleCase(mode); }

function displayReason(detail) {
  const { run } = detail;
  const hasPatch = detail.attempts.some((attempt) => attempt.proposal);
  if (run.status === "PUBLISHING" && hasPatch) return "The change passed the requested check and the full suite. DevSentinel is preparing it for review.";
  if (run.status === "SUCCEEDED") return hasPatch ? "The change passed the requested check and the full suite. It is ready for review." : "The requested checks finished. The saved results are below.";
  if (run.status === "AWAITING_CLARIFICATION" || run.failureClassification === "UNCLEAR_TASK") return "DevSentinel needs one clear answer before it can continue safely.";
  if (run.failureClassification === "UNREPRODUCED_BUG") return "The reported problem did not appear in the saved checks, so no source change was made.";
  if (run.failureClassification === "POLICY_BLOCKED") return "The requested work falls outside the approved repository or file scope.";
  if (run.failureClassification === "UNSUCCESSFUL_PATCH") return "The proposed change did not pass every required check.";
  if (run.status === "BUDGET_EXHAUSTED" || run.failureClassification === "BUDGET_EXHAUSTED") return "The run reached its configured safety limit and stopped.";
  if (run.failureClassification === "PERMANENT_CONFIGURATION") return "A service or repository setting needs attention before this run can continue.";
  if (run.failureClassification === "TRANSIENT_INFRASTRUCTURE") return "A temporary service or execution problem stopped this run. Its saved checkpoint is intact.";
  if (run.failureClassification === "VERIFIED_UNDELIVERED") return "The requested check passed, but another required check or delivery step still needs review.";
  if (run.status === "REJECTED") return "This request was not authorized to run.";
  if (run.status === "CANCELLED") return "The run stopped at a safe checkpoint.";
  if (run.status === "FAILED") return "DevSentinel could not complete this run. The saved details below explain where it stopped.";
  return run.statusReason || "No status explanation has been recorded yet.";
}

function statusClass(status) {
  if (status === "SUCCEEDED") return "status-success";
  if (["FAILED", "REJECTED", "CANCELLED"].includes(status)) return "status-danger";
  if (["NEEDS_HUMAN", "BUDGET_EXHAUSTED", "AWAITING_CLARIFICATION"].includes(status)) return "status-warning";
  return "status-running";
}

function statusBadge(status) {
  return node("span", { className: `status-badge ${statusClass(status)}`, text: statusLabel(status) });
}

function toast(message, error = false) {
  const item = node("div", { className: `toast${error ? " is-error" : ""}`, text: message });
  $("toasts").append(item);
  setTimeout(() => item.remove(), 4200);
}

function setConnection(kind, label) {
  const pill = $("connection");
  pill.className = `connection-pill is-${kind}`;
  pill.querySelector("span").textContent = label;
}

async function api(path, options = {}) {
  const headers = { Authorization: `Bearer ${state.token}`, ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) };
  const response = await fetch(`/ops${path}`, { method: options.method || "GET", headers, body: options.body ? JSON.stringify(options.body) : undefined, cache: "no-store", signal: options.signal });
  const type = response.headers.get("content-type") || "";
  const value = type.includes("json") ? await response.json() : await response.text();
  if (!response.ok) {
    if (response.status === 401) lockWorkspace("Access denied. Check your dashboard access key.");
    if (response.status === 404 && path === "/readiness") lockWorkspace("The review console is disabled on this service.");
    throw new Error(value?.error || `Request failed with HTTP ${response.status}`);
  }
  return value;
}

function lockWorkspace(message = "Workspace locked.") {
  state.streamAbort?.abort();
  state.streamAbort = null;
  state.token = "";
  state.runs = [];
  state.detail = null;
  state.selectedId = null;
  $("app-view").hidden = true;
  $("auth-view").hidden = false;
  $("disconnect").hidden = true;
  $("auth-status").textContent = message;
  setConnection("offline", "Not connected");
  $("token").focus();
}

function skeletons(count = 5) {
  return Array.from({ length: count }, () => node("div", { className: "skeleton", "aria-hidden": "true" }));
}

function queryString() {
  const query = new URLSearchParams({ limit: String(state.limit), offset: String(state.offset) });
  const search = $("search").value.trim();
  const mode = $("mode-filter").value;
  const status = $("status-filter").value;
  if (search) query.set("q", search);
  if (mode) query.set("mode", mode);
  if (status) query.set("status", status);
  return query.toString();
}

async function loadRuns({ includeDetail = true, throwErrors = false } = {}) {
  if (!state.token || state.loading) return;
  state.loading = true;
  try {
    const [page, readiness] = await Promise.all([api(`/runs?${queryString()}`), api("/readiness")]);
    state.runs = page.items;
    state.total = page.total;
    state.readiness = readiness;
    renderRunNavigation();
    renderOverview();
    if (includeDetail && state.selectedId) await loadDetail(state.selectedId, false);
    setConnection("live", "Connected");
  } catch (error) {
    if (state.token) { setConnection("retrying", "Reconnecting"); toast(error.message, true); }
    if (throwErrors) throw error;
  } finally { state.loading = false; }
}

function deliveryMode(run) {
  const mode = run.delivery?.mode;
  if (mode === "dry-run") return "Dry run";
  if (mode === "github-app") return run.delivery?.pullRequestUrl ? "Draft PR" : "GitHub";
  return "Pending";
}

function renderRunNavigation() {
  const items = state.runs.map((run) => node("button", {
    className: `run-item${state.selectedId === run.id ? " is-active" : ""}`,
    type: "button",
    onClick: () => void loadDetail(run.id),
    "aria-current": state.selectedId === run.id ? "page" : null,
  },
  node("div", { className: "run-item-top" }, node("strong", { text: run.issueTitle || `${run.repositoryFullName} #${run.issueNumber}` }), statusBadge(run.status)),
  node("p", { text: `${run.repositoryFullName} · #${run.issueNumber}` }),
  node("div", { className: "run-item-bottom" }, node("span", { text: modeLabel(run.mode) }), node("time", { datetime: run.updatedAt, text: formatDate(run.updatedAt, true) }))));
  replace("run-list", ...(items.length ? items : [node("div", { className: "empty-state" }, node("p", { text: "No matching runs." }))]));
  const pages = Math.max(1, Math.ceil(state.total / state.limit));
  const current = Math.floor(state.offset / state.limit) + 1;
  $("pager").hidden = state.total <= state.limit;
  $("page-label").textContent = `${current} / ${pages}`;
  $("previous-page").disabled = current === 1;
  $("next-page").disabled = current === pages;
}

function readinessCard(label, value, detail, tone = "") {
  return node("article", { className: "readiness-card" }, node("span", { text: label }), node("strong", { className: tone, text: value }), node("small", { text: detail }));
}

function renderOverview() {
  const ready = state.readiness;
  if (ready) {
    replace("readiness-grid",
      readinessCard("Review delivery", titleCase(ready.deliveryMode), ready.deliveryMode === "dry-run" ? "Nothing will be written to GitHub" : "Draft pull requests are enabled", ready.deliveryMode === "dry-run" ? "status-warning" : "status-success"),
      readinessCard("Repository access", titleCase(ready.repositorySourceMode), `${ready.allowedRepositoryCount} approved repositor${ready.allowedRepositoryCount === 1 ? "y" : "ies"}`),
      readinessCard("Repair engine", titleCase(ready.model), ready.model === "configured" ? "Server-side and limited per run" : "Code changes are paused", ready.model === "configured" ? "status-success" : "status-warning"),
      readinessCard("Queue health", ready.deadLetters ? `${ready.deadLetters} item${ready.deadLetters === 1 ? "" : "s"} need review` : "Everything is moving", `${ready.pendingOutbox} update${ready.pendingOutbox === 1 ? "" : "s"} waiting`, ready.deadLetters ? "status-danger" : "status-success"));
    $("overview-copy").textContent = `The database is ${ready.database}. GitHub access uses ${titleCase(ready.authorizationMode)}. The run inspector is ${ready.inspector} and cannot start or change work.`;
  }
  $("run-count").textContent = `${formatNumber(state.total)} total`;
  const body = $("run-table");
  body.replaceChildren();
  for (const run of state.runs.slice(0, 12)) {
    const row = node("tr", { tabindex: "0", role: "button", onClick: () => void loadDetail(run.id) },
      node("td", { className: "request-cell" }, node("strong", { text: run.issueTitle || `Issue #${run.issueNumber}` }), node("small", { text: `${run.repositoryFullName} · ${shortId(run.id)}` })),
      node("td", {}, node("span", { className: "mode-chip", text: modeLabel(run.mode) })),
      node("td", {}, statusBadge(run.status)),
      node("td", { text: deliveryMode(run) }),
      node("td", { text: formatDate(run.updatedAt, true), title: formatDate(run.updatedAt) }));
    row.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void loadDetail(run.id); } });
    body.append(row);
  }
  $("overview-empty").hidden = state.runs.length > 0;
}

async function loadDetail(id, updateHash = true) {
  const selectionChanged = state.selectedId !== id;
  state.selectedId = id;
  if (selectionChanged) {
    state.selectedAttempt = null;
    state.selectedLog = 0;
  }
  if (updateHash) history.replaceState(null, "", `#run/${id}`);
  $("overview-view").hidden = true;
  $("run-view").hidden = false;
  replace("task-panel", ...skeletons(2));
  renderRunNavigation();
  try {
    state.detail = await api(`/runs/${id}`);
    renderDetail();
  } catch (error) { toast(error.message, true); }
}

function sectionHeading(eyebrow, title, aside = null) {
  return node("div", { className: "panel-heading" }, node("div", {}, node("span", { className: "eyebrow", text: eyebrow }), node("h2", { text: title })), aside);
}

function definition(label, value) {
  return node("div", { className: "definition" }, node("dt", { text: label }), node("dd", {}, value instanceof Node ? value : String(value ?? "Not recorded")));
}

function renderTask(detail) {
  const brief = detail.taskBrief;
  const acceptance = detail.attempts.at(-1)?.acceptanceEvidence || [];
  const criterion = (text) => {
    const evidence = acceptance.find((item) => item.criterion === text);
    const supported = evidence?.status === "SUPPORTED";
    return node("li", {}, node("span", { className: `criteria-state${supported ? " is-supported" : ""}`, text: supported ? "✓" : "·" }), node("div", {}, node("strong", { text }), evidence ? node("small", { className: "muted", text: supported ? `Supported by ${evidence.evidenceReferences.join(", ")}` : "No supporting execution evidence recorded" }) : node("small", { className: "muted", text: "Pending execution evidence" })));
  };
  return [
    sectionHeading("Request", "Goal & boundaries", node("span", { className: "meta", text: brief?.contractVersion ? `Brief ${brief.contractVersion}` : "Earlier run" })),
    node("p", { text: brief?.requestedOutcome || displayReason(detail) || "This earlier run does not have a saved request summary." }),
    node("dl", { className: "definition-grid" },
      definition("Requested by", brief?.authorizedActor || detail.run.actorLogin),
      definition("Code snapshot", node("code", { text: detail.run.targetCommitSha || "Pending" })),
      definition("Files in scope", brief?.approvedPaths?.length ? brief.approvedPaths.join(", ") : "Only source files allowed by repository policy"),
      definition("Repository guidance", brief?.guidanceHash ? `${brief.guidancePath} · v${brief.guidanceVersion} · ${shortId(brief.guidanceHash)}` : "No guidance file was saved")),
    node("h3", { text: "What success means" }),
    node("ul", { className: "criteria-list" }, ...(brief?.acceptanceCriteria || ["No explicit criteria captured"]).map(criterion)),
    ...(brief?.constraints?.length ? [node("h3", { text: "Constraints" }), node("ul", { className: "chip-list" }, ...brief.constraints.map((item) => node("li", { text: item })))] : []),
  ];
}

function renderPlan(detail) {
  const plan = detail.plan;
  if (!plan) return [sectionHeading("Investigation", "Plan"), node("p", { className: "muted", text: "No plan has been saved yet. A plan is required before DevSentinel can prepare a code change." })];
  return [
    sectionHeading("Investigation", `Saved plan · v${plan.version}`),
    node("p", { text: plan.suspectedCause }),
    node("dl", { className: "definition-grid" },
      definition("Evidence reviewed", plan.evidenceReferences.join(" · ") || "None recorded"),
      definition("Files to change", plan.intendedFiles.join(", ") || "No source files"),
      definition("Out of scope", plan.scopeExclusions.join(" · ") || "None recorded"),
      definition("Checks to run", plan.verificationSteps.join(" · ") || "None recorded")),
  ];
}

function renderTimeline(detail) {
  const items = detail.events.slice(-80).map((event) => ({ key: event.id, kind: event.kind, message: event.message, time: event.createdAt }));
  for (const attempt of detail.attempts) for (const trace of attempt.toolTrace || []) items.push({ key: `tool-${attempt.id}-${trace.sequence}`, kind: `tool.${trace.tool}`, message: `Attempt ${attempt.iteration} · ${trace.phase.toLowerCase()} · ${trace.summary}`, time: attempt.updatedAt });
  items.sort((a, b) => new Date(a.time) - new Date(b.time) || a.key.localeCompare(b.key));
  replace("timeline", ...items.map((item) => node("li", { className: "timeline-item" }, node("span", { className: "timeline-dot", "aria-hidden": "true" }), node("div", {}, node("strong", { text: titleCase(item.kind.replaceAll(".", " ")) }), node("p", { text: item.message })), node("time", { datetime: item.time, text: formatDate(item.time, true), title: formatDate(item.time) }))));
  $("event-meta").textContent = `${items.length} update${items.length === 1 ? "" : "s"}`;
}

function lcsRows(before, after) {
  const left = before.split("\n");
  const right = after.split("\n");
  if (left.length > 250 || right.length > 250) {
    const length = Math.max(left.length, right.length);
    return Array.from({ length }, (_, index) => ({ old: left[index] ?? null, new: right[index] ?? null, type: left[index] === right[index] ? "same" : left[index] == null ? "add" : right[index] == null ? "remove" : "change" }));
  }
  const matrix = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) matrix[i][j] = left[i] === right[j] ? matrix[i + 1][j + 1] + 1 : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
  const rows = []; let i = 0; let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) { rows.push({ old: left[i++], new: right[j++], type: "same" }); }
    else if (j < right.length && (i === left.length || matrix[i][j + 1] >= matrix[i + 1][j])) { rows.push({ old: null, new: right[j++], type: "add" }); }
    else { rows.push({ old: left[i++], new: null, type: "remove" }); }
  }
  return rows;
}

function diffColumn(rows, side) {
  let line = 0;
  return node("div", { className: "diff-column" }, node("div", { className: "diff-column-title", text: side === "old" ? "Before" : "After" }), ...rows.map((row) => {
    const value = row[side];
    if (value != null) line += 1;
    const changed = side === "old" ? row.type === "remove" : row.type === "add";
    return node("div", { className: `diff-line${changed ? side === "old" ? " is-remove" : " is-add" : ""}` }, node("i", { text: value == null ? "" : line }), node("code", { text: value == null ? "" : value }));
  }));
}

function renderChanges(detail) {
  const attempts = detail.attempts.filter((attempt) => attempt.proposal);
  if (!attempts.length) return [sectionHeading("Code change", "What changed"), node("p", { className: "muted", text: "No code change was saved." })];
  const selected = attempts.find((attempt) => attempt.iteration === state.selectedAttempt) || attempts.at(-1);
  state.selectedAttempt = selected.iteration;
  const tabs = node("div", { className: "attempt-tabs" }, ...attempts.map((attempt) => node("button", { type: "button", className: `attempt-tab${attempt.id === selected.id ? " is-active" : ""}`, text: `Attempt ${attempt.iteration} · ${titleCase(attempt.status)}`, onClick: () => { state.selectedAttempt = attempt.iteration; renderChangesIntoPanel(state.detail); } })));
  const edits = selected.proposal?.edits || [];
  return [
    sectionHeading("Code change", "What changed", tabs),
    node("p", { text: selected.proposal?.summary || "No explanation recorded." }),
    ...(edits.length ? edits.map((edit) => {
      const original = detail.context.find((item) => item.attemptIteration === selected.iteration && item.reference === edit.path && item.selected)?.content;
      const rows = lcsRows(original ?? "", edit.content);
      return node("article", { className: "diff-file" }, node("header", {}, node("code", { text: edit.path }), node("span", { className: "meta", text: original == null ? "Original content unavailable" : `${rows.filter((row) => row.type === "add").length} additions · ${rows.filter((row) => row.type === "remove").length} deletions` })), node("div", { className: "diff-grid" }, diffColumn(rows, "old"), diffColumn(rows, "new")));
    }) : [node("p", { className: "muted", text: "DevSentinel stopped without changing source code. The reason is saved above." })]),
  ];
}

function renderChangesIntoPanel(detail) { replace("changes-panel", ...renderChanges(detail)); }

function testCard(label, execution) {
  const test = execution?.test;
  const passed = execution && execution.install?.exitCode === 0 && test?.exitCode === 0 && !test.timedOut;
  return node("article", { className: "test-result" }, node("span", { text: label }), node("strong", { className: passed ? "status-success" : execution ? "status-danger" : "muted", text: execution ? passed ? "Passed" : test?.timedOut ? "Timed out" : `Exit ${test?.exitCode ?? execution.install?.exitCode ?? "—"}` : "Not run" }), node("small", { text: execution ? `${formatNumber((execution.install?.durationMs || 0) + (test?.durationMs || 0))} ms · ${execution.image}` : "No evidence" }));
}

function storedBaseline(detail) {
  const install = detail.executions.find((item) => item.phase === "DEPENDENCY_INSTALL");
  const test = detail.executions.find((item) => item.phase === "BASELINE_TEST");
  return install ? { image: install.image, install, test } : null;
}

function renderTests(detail) {
  const attempt = detail.attempts.find((item) => item.iteration === state.selectedAttempt) || detail.attempts.at(-1);
  const evidence = attempt?.acceptanceEvidence || [];
  return [
    sectionHeading("Verification", "Test results", node("span", { className: "meta", text: attempt ? `Attempt ${attempt.iteration}` : "Baseline only" })),
    node("div", { className: "test-grid" }, testCard("Before the change", storedBaseline(detail)), testCard("Requested behavior", attempt?.targetedVerification), testCard("Full test suite", attempt?.verification)),
    node("h3", { text: "Acceptance checks" }),
    node("ul", { className: "criteria-list" }, ...(evidence.length ? evidence : (detail.taskBrief?.acceptanceCriteria || [])).map((item) => {
      const criterion = typeof item === "string" ? item : item.criterion;
      const supported = typeof item !== "string" && item.status === "SUPPORTED";
      return node("li", {}, node("span", { className: `criteria-state${supported ? " is-supported" : ""}`, text: supported ? "✓" : "·" }), node("div", {}, node("strong", { text: criterion }), node("small", { className: "muted", text: supported ? `Backed by saved checks: ${item.evidenceReferences.join(", ")}` : "No saved check supports this yet" })));
    })),
    ...(attempt?.unrelatedFailures?.length ? [node("div", { className: "evidence-callout", text: `${attempt.unrelatedFailures.length} unrelated failure(s) were already present. Delivery stays blocked while a required check is red; DevSentinel will not quietly change unrelated code.` })] : []),
    node("div", { className: "evidence-callout", text: "A checkmark appears only when saved execution evidence supports it—not because the AI said the work was done. Code review is still required." }),
  ];
}

function logSources(detail) {
  const sources = [];
  for (const execution of detail.executions) {
    sources.push({ label: `${titleCase(execution.phase)} · stdout`, text: execution.stdout || "(empty)" });
    if (execution.stderr) sources.push({ label: `${titleCase(execution.phase)} · stderr`, text: execution.stderr });
  }
  for (const attempt of detail.attempts) for (const [label, value] of [["targeted", attempt.targetedVerification], ["full", attempt.verification]]) {
    if (!value) continue;
    sources.push({ label: `Attempt ${attempt.iteration} ${label} · stdout`, text: value.test?.stdout || value.install.stdout || "(empty)" });
    if (value.test?.stderr || value.install.stderr) sources.push({ label: `Attempt ${attempt.iteration} ${label} · stderr`, text: [value.install.stderr, value.test?.stderr].filter(Boolean).join("\n") });
  }
  return sources;
}

function renderLogs(detail) {
  const sources = logSources(detail);
  state.selectedLog = Math.min(state.selectedLog, Math.max(0, sources.length - 1));
  return [
    sectionHeading("Command output", "Logs", node("span", { className: "meta", text: "Filtered · never cached" })),
    ...(sources.length ? [node("div", { className: "log-tabs" }, ...sources.map((source, index) => node("button", { type: "button", className: index === state.selectedLog ? "is-active" : "", text: source.label, onClick: () => { state.selectedLog = index; replace("logs-panel", ...renderLogs(state.detail)); } }))), node("pre", { className: "log-view", tabindex: "0", text: sources[state.selectedLog].text })] : [node("p", { className: "muted", text: "No command output was recorded." })]),
  ];
}

function budgetRow(label, value, note) { return node("div", { className: "budget-row" }, node("span", { text: label }), node("strong", { text: value }), node("small", { className: "muted", text: note })); }

function renderBudget(detail) {
  const workflow = detail.workflow || {};
  const hasAttempts = detail.attempts.length > 0;
  const knownInput = detail.attempts.reduce((sum, item) => sum + (item.inputTokens || 0), 0);
  const knownOutput = detail.attempts.reduce((sum, item) => sum + (item.outputTokens || 0), 0);
  const unknown = detail.attempts.filter((item) => item.inputTokens == null || item.outputTokens == null).length;
  const knownCost = detail.attempts.reduce((sum, item) => sum + (item.estimatedCostMicrousd || 0), 0);
  const unknownCost = detail.attempts.filter((item) => item.estimatedCostMicrousd == null).length;
  return [
    node("span", { className: "eyebrow", text: "Private operator data" }), node("h2", { text: "Usage & limits" }),
    node("div", { className: "budget-stack" },
      budgetRow("Model allowance used", `${formatNumber(workflow.reservedTokens)} units`, "Kept across retries so a restart cannot create extra allowance"),
      budgetRow("Recorded model use", `${formatNumber(knownInput)} in · ${formatNumber(knownOutput)} out`, unknown ? `${unknown} attempt${unknown === 1 ? " has" : "s have"} unknown usage` : "Usage was returned for every attempt"),
      budgetRow("Estimated model cost", !hasAttempts ? "Not recorded" : unknownCost ? "Unknown or partial" : `$${(knownCost / 1_000_000).toFixed(6)}`, !hasAttempts ? "No model attempt was made" : knownCost && unknownCost ? `Known portion $${(knownCost / 1_000_000).toFixed(6)} · not an invoice` : "Shown only when operator rates are configured; not an invoice"),
      budgetRow("Attempts used", formatNumber(workflow.attemptCount), "Asking for clarification does not reset this"),
      budgetRow("Tool allowance used", `${formatNumber(workflow.toolCallCount)} calls · ${formatNumber(workflow.toolOutputBytes)} B`, "Kept across retries, crashes, and continuations"),
      budgetRow("Run inspector", `${formatNumber(workflow.inspectorQueryCount)} questions · ${formatNumber(workflow.inspectorReservedTokens)} units`, "Separate, read-only allowance")),
  ];
}

function safeExternalHref(value) {
  try {
    const parsed = new URL(String(value));
    return parsed.protocol === "https:" ? parsed.href : null;
  } catch { return null; }
}

function artifact(label, value, link = false) {
  const href = link ? safeExternalHref(value) : null;
  return node("li", {}, node("span", { text: label }), href ? node("a", { href, target: "_blank", rel: "noreferrer", text: value }) : node("code", { text: String(value || "Not recorded") }));
}

function renderDelivery(detail) {
  const delivery = detail.workflow?.delivery || {};
  const controls = [];
  if (!terminal.has(detail.run.status) && detail.run.status !== "AWAITING_CLARIFICATION") controls.push(node("button", { type: "button", className: "danger", text: "Cancel at next safe boundary", onClick: () => void confirmMutation("Cancel this run?", "In-flight work will stop at the next fenced checkpoint. External writes already accepted by GitHub cannot be undone.", "Cancel run", () => mutate(`/runs/${detail.run.id}/cancel`, { confirmed: true })) }));
  if (!["SUCCEEDED", "CANCELLED", "REJECTED"].includes(detail.run.status) && detail.run.status !== "AWAITING_CLARIFICATION") controls.push(node("button", { type: "button", text: "Resume safely", onClick: () => void confirmMutation("Resume this run?", "DevSentinel will continue from the saved checkpoint. Previous attempts and safety limits stay intact.", "Resume run", () => mutate(`/runs/${detail.run.id}/retry`, { confirmed: true })) }));
  if (detail.run.mode === "FIX" && detail.run.status === "NEEDS_HUMAN") controls.push(node("button", { type: "button", text: "Approve more files…", onClick: () => void scopeDialog(detail.run.id) }));
  const clarification = detail.clarifications.find((item) => item.status === "OPEN");
  return [
    node("span", { className: "eyebrow", text: "Review & actions" }), node("h2", { text: delivery.mode === "dry-run" ? "Dry-run record" : "Delivery" }),
    node("ul", { className: "artifact-list" }, artifact("Mode", delivery.mode || "Not attempted"), artifact("Branch", delivery.branch), artifact("Head commit", delivery.headSha), artifact("Draft pull request", delivery.pullRequestUrl, Boolean(delivery.pullRequestUrl)), artifact("Check run", delivery.checkRunId), artifact("Status comment", delivery.commentId)),
    ...(clarification ? [node("div", { className: "clarification-box" }, node("strong", { text: "One answer needed" }), node("p", { text: clarification.question }), node("small", { className: "muted", text: `Answer by ${formatDate(clarification.deadlineAt)}` }), node("textarea", { id: "clarification-answer", placeholder: "Type your answer…", maxlength: "4000" }), node("button", { type: "button", className: "primary-button", text: "Answer & continue", onClick: () => { const answer = $("clarification-answer").value.trim(); if (!answer) return toast("Enter an answer first.", true); void confirmMutation("Continue this run?", "Your answer will be added to this run. Previous attempts remain counted, and only unused working time resumes.", "Save answer & continue", () => mutate(`/runs/${detail.run.id}/clarification`, { answer, confirmed: true })); } }))] : []),
    node("div", { className: "control-stack" }, ...controls),
  ];
}

function renderInspector(detail) {
  const prompts = ["Why did this fail?", "What changed?", "What remains unverified?", "What should I do next?"];
  replace("prompt-grid", ...prompts.map((prompt) => node("button", { type: "button", text: prompt, onClick: () => void askInspector(prompt) })));
  let form = $("inspector-form");
  if (!form) {
    form = node("form", { className: "inspector-form", id: "inspector-form", onSubmit: (event) => { event.preventDefault(); const input = $("inspector-question"); const question = input.value.trim(); if (question) { input.value = ""; void askInspector(question); } } }, node("textarea", { id: "inspector-question", maxlength: "2000", placeholder: "Ask about this recorded run…", "aria-label": "Inspector question" }), node("button", { className: "primary-button", type: "submit", text: "Ask" }));
    $("prompt-grid").after(form, node("div", { className: "inspector-thread", id: "inspector-thread" }));
  }
  const sourceLabel = (status) => status === "GROUNDED_MODEL" ? "Evidence-backed answer" : status?.startsWith("FALLBACK_") ? "Built-in answer" : titleCase(status);
  replace("inspector-thread", ...(detail.inspector.length ? detail.inspector.slice().reverse().map((item) => node("article", { className: "answer-card" }, node("p", { text: item.answer }), node("footer", { text: `${sourceLabel(item.status)} · sources: ${item.evidenceReferences.join(", ")}` }))) : [node("p", { className: "muted", text: "Ask a question to inspect saved evidence." })]));
}

async function askInspector(question) {
  if (!state.detail) return;
  const submit = $("inspector-form")?.querySelector("button");
  if (submit) submit.disabled = true;
  try {
    const answer = await api(`/runs/${state.detail.run.id}/inspect`, { method: "POST", body: { question } });
    state.detail.inspector.push(answer);
    renderInspector(state.detail);
  } catch (error) { toast(error.message, true); }
  finally { if (submit) submit.disabled = false; }
}

function renderDetail() {
  const detail = state.detail;
  if (!detail) return;
  const { run } = detail;
  $("crumb-repo").textContent = run.repositoryFullName;
  $("crumb-issue").textContent = `Issue #${run.issueNumber}`;
  $("run-mode").textContent = modeLabel(run.mode);
  $("run-id").textContent = run.id;
  $("run-title").textContent = detail.taskBrief?.issueTitle || detail.taskBrief?.requestedOutcome || `Issue #${run.issueNumber}`;
  $("run-reason").textContent = displayReason(detail);
  const badge = statusBadge(run.status); badge.id = "run-status"; $("run-status").replaceWith(badge);
  $("run-delivery").textContent = detail.workflow?.delivery?.mode === "dry-run" ? "Dry run · nothing written to GitHub" : detail.workflow?.delivery?.mode === "github-app" ? "GitHub review published" : "Not published";
  replace("task-panel", ...renderTask(detail));
  replace("plan-panel", ...renderPlan(detail));
  renderTimeline(detail);
  renderChangesIntoPanel(detail);
  replace("tests-panel", ...renderTests(detail));
  replace("logs-panel", ...renderLogs(detail));
  replace("budget-panel", ...renderBudget(detail));
  replace("delivery-panel", ...renderDelivery(detail));
  renderInspector(detail);
}

async function mutate(path, body) {
  await api(path, { method: "POST", body });
  toast("Request accepted. Durable state will update shortly.");
  await loadRuns();
}

function confirmMutation(title, body, confirmLabel, action) {
  return openDialog({ title, body, confirmLabel }).then(async (confirmed) => { if (confirmed) await action(); });
}

function openDialog({ title, body, confirmLabel, fields = [] }) {
  const dialog = $("confirm-dialog");
  $("dialog-title").textContent = title;
  $("dialog-body").textContent = body;
  $("dialog-confirm").textContent = confirmLabel;
  replace("dialog-fields", ...fields.map((field) => node("label", {}, field.label, field.multiline ? node("textarea", { name: field.name, maxlength: field.maxlength || "2000", placeholder: field.placeholder || "" }) : node("input", { name: field.name, maxlength: field.maxlength || "1000", placeholder: field.placeholder || "" }))));
  dialog.showModal();
  return new Promise((resolve) => {
    const close = () => { dialog.removeEventListener("close", close); resolve(dialog.returnValue === "confirm"); };
    dialog.addEventListener("close", close);
  });
}

async function scopeDialog(runId) {
  const confirmed = await openDialog({
    title: "Approve a scope expansion?",
    body: "This records additional repository paths as operator-authorized task scope. Platform protected-path rules and repository policy still cannot be overridden.",
    confirmLabel: "Approve paths",
    fields: [
      { name: "paths", label: "Repository paths (comma separated)", placeholder: "src/parser.ts, lib/format", maxlength: "1000" },
      { name: "reason", label: "Why this broader scope is required", multiline: true, maxlength: "2000" },
    ],
  });
  if (!confirmed) return;
  const form = $("confirm-dialog").querySelector("form");
  const data = new FormData(form);
  const paths = String(data.get("paths") || "").split(",").map((value) => value.trim()).filter(Boolean);
  const reason = String(data.get("reason") || "").trim();
  if (!paths.length || !reason) return toast("Paths and a reason are required.", true);
  try { await mutate(`/runs/${runId}/scope`, { paths, reason, confirmed: true }); }
  catch (error) { toast(error.message, true); }
}

function showOverview() {
  state.selectedId = null;
  state.detail = null;
  history.replaceState(null, "", location.pathname);
  $("run-view").hidden = true;
  $("overview-view").hidden = false;
  renderRunNavigation();
}

function scheduleRefresh() {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => void loadRuns(), 250);
}

async function streamEvents() {
  state.streamAbort?.abort();
  const controller = new AbortController();
  state.streamAbort = controller;
  while (state.token && !controller.signal.aborted) {
    try {
      const response = await fetch("/ops/events", { headers: { Authorization: `Bearer ${state.token}`, ...(state.streamCursor ? { "Last-Event-ID": state.streamCursor } : {}) }, cache: "no-store", signal: controller.signal });
      if (response.status === 401 || response.status === 404) return lockWorkspace("Your control session expired or live evidence is unavailable.");
      if (!response.ok || !response.body) throw new Error(`Live stream HTTP ${response.status}`);
      setConnection("live", "Live evidence");
      $("stream-label").textContent = "Authenticated live evidence";
      state.streamBackoff = 1000;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let split;
        while ((split = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, split); buffer = buffer.slice(split + 2);
          const id = block.split("\n").find((line) => line.startsWith("id: "))?.slice(4);
          if (id) state.streamCursor = id;
          if (block.includes("event: run")) scheduleRefresh();
        }
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      setConnection("retrying", "Reconnecting");
      $("stream-label").textContent = "Polling fallback active";
      await new Promise((resolve) => setTimeout(resolve, state.streamBackoff));
      state.streamBackoff = Math.min(state.streamBackoff * 2, 15000);
      if (!document.hidden) await loadRuns();
    }
  }
}

$("connect").addEventListener("submit", async (event) => {
  event.preventDefault();
  const supplied = $("token").value.trim();
  if (!supplied) return;
  state.token = supplied;
  $("token").value = "";
  $("auth-status").textContent = "Checking authenticated readiness…";
  try {
    await loadRuns({ includeDetail: false, throwErrors: true });
    $("auth-view").hidden = true;
    $("app-view").hidden = false;
    $("disconnect").hidden = false;
    $("auth-status").textContent = "";
    const match = /^#run\/([0-9a-f-]{36})$/i.exec(location.hash);
    if (match) await loadDetail(match[1], false);
    void streamEvents();
  } catch (error) { if (state.token) lockWorkspace(error.message); }
});

$("disconnect").addEventListener("click", () => lockWorkspace());
$("home").addEventListener("click", () => { if (state.token) showOverview(); });
$("back-overview").addEventListener("click", showOverview);
$("refresh").addEventListener("click", () => void loadRuns());
$("previous-page").addEventListener("click", () => { state.offset = Math.max(0, state.offset - state.limit); void loadRuns({ includeDetail: false }); });
$("next-page").addEventListener("click", () => { state.offset += state.limit; void loadRuns({ includeDetail: false }); });
for (const id of ["mode-filter", "status-filter"]) $(id).addEventListener("change", () => { state.offset = 0; void loadRuns({ includeDetail: false }); });
let searchTimer;
$("search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.offset = 0; void loadRuns({ includeDetail: false }); }, 250); });
document.addEventListener("keydown", (event) => { if (event.key === "/" && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "")) { event.preventDefault(); $("search").focus(); } });
$("copy-id").addEventListener("click", async () => { if (!state.selectedId) return; try { await navigator.clipboard.writeText(state.selectedId); toast("Run ID copied."); } catch { toast("Copy is unavailable in this browser.", true); } });
$("inspector-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("inspector-question");
  const question = input.value.trim();
  if (question) { input.value = ""; void askInspector(question); }
});

const savedTheme = (() => { try { return localStorage.getItem("devsentinel-theme"); } catch { return null; } })();
if (savedTheme === "light" || savedTheme === "dark") document.documentElement.dataset.theme = savedTheme;
$("theme-toggle").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("devsentinel-theme", next); } catch {}
});

setInterval(() => { if (state.token && !document.hidden && $("connection").classList.contains("is-retrying")) void loadRuns(); }, 15000);
replace("run-list", ...skeletons(6));
