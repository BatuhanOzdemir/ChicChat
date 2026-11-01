// The chat simulator's browser side (port of simulator-client.tsx and the
// panels it rendered).
//
// What lives here: showing chat bubbles, the tappable options, the inspector,
// and turning button clicks into POSTs to /api/simulator. What does NOT live
// here: any intake logic. The server runs the real parser and handler; for
// presets, the server (/api/simulator/preset-step) decides each next answer
// and this file only loops and honours the Stop button.
"use strict";

(function () {
  const root = document.getElementById("simulator");
  if (!root) return;

  const merchants = JSON.parse(root.dataset.merchants);
  const $ = (id) => document.getElementById(id);
  const TOO_LONG = "Preset paused after 30 steps. Continue manually or reset the conversation.";

  // --- State ---------------------------------------------------------------
  const state = {
    merchantId: root.dataset.selected || (merchants[0] && merchants[0].id) || "",
    transcript: [], // {role: customer|bot|system, text, options?, isPhoto?, notification?}
    session: null,
    sessionMeta: null,
    completedCase: null,
    error: null,
    notice: null,
    injection: "", // applies to the next message only
    busy: false,
    presetRunning: false,
    stopRequested: false,
  };

  function csrfToken() {
    const match = document.cookie.match(/(?:^|;\s*)chicchat_csrf=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  async function postJson(url, body) {
    const response = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(30000),
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken() },
      body: JSON.stringify(body),
    });
    return { ok: response.ok, status: response.status, data: await response.json() };
  }

  // --- Talking to the server --------------------------------------------------

  function bubbleFor(message) {
    if (message.type === "text") return { role: "bot", text: message.text.body };
    const { header, body, action } = message.interactive;
    const text = [header && header.text, body.text].filter(Boolean).join("\n");
    return { role: "bot", text, options: (action.sections[0] && action.sections[0].rows) || [] };
  }

  async function call(body) {
    const { ok, status, data } = await postJson("/api/simulator", {
      merchantId: state.merchantId,
      phone: $("phone").value,
      ...body,
    });
    if (!ok) {
      state.error = data.error || `request failed (${status})`;
      render();
      return null;
    }
    state.session = data.session;
    state.sessionMeta = data.sessionMeta;
    state.error = data.error;
    state.notice = data.notice;
    if (data.completedCase) state.completedCase = data.completedCase;
    const notification = body.action === "maintenance" || body.action === "time_travel";
    for (const message of data.outbound || []) state.transcript.push({ ...bubbleFor(message), notification });
    if (data.error) state.transcript.push({ role: "system", text: `⚠ ${data.error}` });
    render();
    return data;
  }

  async function send(message, label) {
    state.transcript.push({
      role: "customer",
      text: label === undefined ? message.value : label,
      isPhoto: message.kind === "photo",
    });
    const injection = state.injection;
    state.injection = "";
    $("inject").value = "";
    render();
    return call({ action: "message", message, ...(injection ? { injectError: injection } : {}) });
  }

  // Only one request at a time, as the original UI enforced.
  async function guard(work) {
    if (state.busy) return;
    state.busy = true;
    render();
    try {
      await work();
    } catch (err) {
      state.error =
        "The request could not finish. Refresh the session before retrying; it may already have been processed.";
    } finally {
      state.busy = false;
      render();
    }
  }

  // --- Presets -----------------------------------------------------------------

  async function playPreset(button) {
    const presetId = button.dataset.preset;
    const replay = button.dataset.replay === "true";
    const stopped = () => state.stopRequested;
    const reset = await call({ action: "reset" });
    if (!reset || reset.error || stopped()) return;
    const greeting = { kind: "text", value: button.dataset.greeting };
    if (replay) greeting.messageId = `wamid.sim.replay.${crypto.randomUUID()}`;
    let last = await send(greeting);
    if (!last || last.error || stopped()) return;
    if (replay) {
      await send(greeting);
      return;
    }
    const visited = [];
    for (let step = 0; step < 30 && !stopped(); step++) {
      if (!last || last.error || last.completedCase || !last.session) return;
      const { data } = await postJson("/api/simulator/preset-step", { presetId, session: last.session, visited });
      if (!data.message) {
        state.transcript.push({ role: "system", text: data.notice });
        return;
      }
      visited.push(data.visitedKey);
      last = await send(data.message);
    }
    if (!stopped() && last && last.session) state.transcript.push({ role: "system", text: TOO_LONG });
  }

  async function runPreset(button) {
    state.stopRequested = false;
    state.presetRunning = true;
    state.transcript = [];
    state.completedCase = null;
    render();
    try {
      await playPreset(button);
    } finally {
      state.presetRunning = false;
      if (state.stopRequested)
        state.transcript.push({
          role: "system",
          text: "Preset stopped. The last request may have finished. Continue manually or reset the conversation.",
        });
      render();
    }
  }

  // --- Rendering -----------------------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text; // never innerHTML: customer text is untrusted
    return node;
  }

  // Istanbul time, DD/MM/YYYY, 24-hour — the same as the server's dates.
  function formatDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Istanbul",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }

  // The tappable choices: those of the last real question (a nudge does not
  // replace it), and none once the session has ended.
  function availableOptions() {
    if (state.session === null) return [];
    for (let i = state.transcript.length - 1; i >= 0; i--) {
      const entry = state.transcript[i];
      if (entry.role === "bot" && !entry.notification) return entry.options || [];
    }
    return [];
  }

  const BUBBLE = {
    customer: "ms-auto bg-emerald-100 dark:bg-emerald-900/60",
    bot: "me-auto bg-white dark:bg-zinc-800",
    system: "mx-auto bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-100",
  };

  function renderTranscript() {
    const box = $("transcript");
    box.replaceChildren();
    if (state.transcript.length === 0) {
      box.append(el("p", "py-8 text-center text-sm text-zinc-500", "Send a message to start an intake."));
      return;
    }
    for (const entry of state.transcript) {
      const row = el("div", "flex");
      const bubble = el("div", `max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm shadow-sm ${BUBBLE[entry.role]}`);
      if (entry.isPhoto) bubble.append(el("div", "mb-1 text-2xl", "🖼️"));
      bubble.append(document.createTextNode(entry.text));
      row.append(bubble);
      box.append(row);
    }
    box.lastChild.scrollIntoView({ behavior: "smooth" });
  }

  function renderOptions() {
    const box = $("options");
    const options = availableOptions();
    box.replaceChildren();
    box.hidden = options.length === 0;
    for (const row of options) {
      const button = el(
        "button",
        "rounded-full border border-emerald-600 px-3 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 dark:text-emerald-300 dark:hover:bg-emerald-900/40",
        row.title,
      );
      button.type = "button";
      button.disabled = state.busy;
      button.title = row.description || row.title;
      button.addEventListener("click", () => guard(() => send({ kind: "list", value: row.id }, row.title)));
      box.append(button);
    }
  }

  function row(label, value) {
    const line = el("div", "flex justify-between gap-2 border-b border-zinc-100 py-1 last:border-0 dark:border-zinc-800");
    line.append(el("span", "text-zinc-500", label), el("span", "text-right font-mono text-xs", value));
    return line;
  }

  function heading(text) {
    return el("h3", "mb-1 text-xs font-semibold uppercase text-zinc-500", text);
  }

  function renderInspector() {
    const box = $("inspector");
    box.replaceChildren(el("h2", "font-medium", "Live internals"));
    if (state.error) {
      const p = el("p", "rounded bg-red-100 p-2 text-xs text-red-800 dark:bg-red-950 dark:text-red-200");
      p.append(el("strong", "", "error:"), document.createTextNode(` ${state.error}`));
      box.append(p);
    }
    if (state.notice) box.append(el("p", "rounded bg-amber-100 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100", state.notice));

    const session = el("div");
    session.append(heading("Session"));
    if (state.session) {
      const s = state.session;
      session.append(
        row("status", s.status),
        row("category", s.categoryKey || "—"),
        row("subcategory", s.subcategoryKey || "—"),
        row("awaiting field", s.pendingFieldKey || "—"),
      );
      if (state.sessionMeta) session.append(row("last activity", formatDateTime(state.sessionMeta.updated_at)));
    } else session.append(el("p", "text-xs text-zinc-500", "No active session."));
    box.append(session);

    const collected = state.session ? Object.entries(state.session.fields) : [];
    const fields = el("div");
    fields.append(heading(`Collected fields (${collected.length})`));
    if (collected.length === 0) fields.append(el("p", "text-xs text-zinc-500", "Nothing captured yet."));
    else {
      const list = el("ul", "space-y-1 font-mono text-xs");
      for (const [key, value] of collected) {
        const item = el("li", "break-all");
        item.append(el("span", "text-zinc-500", `${key}:`), document.createTextNode(` ${value.normalized ?? "—"}`));
        if (value.raw !== value.normalized) item.append(el("span", "text-zinc-400", ` (raw: ${value.raw})`));
        list.append(item);
      }
      fields.append(list);
    }
    box.append(fields);

    const persisted = el("div");
    persisted.append(heading("Persisted case"));
    const c = state.completedCase;
    if (c) {
      persisted.append(row("queue", c.queue ?? "unrouted"), row("priority", c.priority), row("status", c.status));
      const link = el("a", "mb-2 mt-1 inline-block text-xs underline", "open in the agent console →");
      link.href = `/console/${c.case_id}`;
      link.target = "_blank";
      link.rel = "noreferrer";
      persisted.append(link, el("pre", "max-h-72 overflow-auto rounded bg-zinc-950 p-2 text-[11px] leading-relaxed text-zinc-100", JSON.stringify(c, null, 2)));
    } else persisted.append(el("p", "text-xs text-zinc-500", "Appears here when an intake completes."));
    box.append(persisted);
  }

  function render() {
    const merchant = merchants.find((m) => m.id === state.merchantId);
    $("chat").dir = merchant && merchant.rtl ? "rtl" : "ltr";
    for (const node of root.querySelectorAll("[data-busy]")) node.disabled = state.busy;
    $("composer").querySelector("button").textContent = state.busy ? "…" : "Send";
    $("stop-preset").disabled = !state.presetRunning;
    renderTranscript();
    renderOptions();
    renderInspector();
  }

  // --- Wiring the controls ---------------------------------------------------------

  $("composer").addEventListener("submit", (event) => {
    event.preventDefault();
    const text = $("draft").value.trim();
    if (text === "" || state.busy) return;
    $("draft").value = "";
    guard(() => send({ kind: "text", value: text }));
  });
  // Switching tenants starts a different conversation: the chat log belongs to
  // the merchant it came from. The server-side session is left alone, so
  // interleaved conversations stay visible when switching back.
  $("merchant").addEventListener("change", (event) => {
    state.merchantId = event.target.value;
    state.transcript = [];
    state.completedCase = null;
    state.error = null;
    guard(() => call({ action: "state" }));
  });
  $("inject").addEventListener("change", (event) => (state.injection = event.target.value));
  $("send-photo").addEventListener("click", () => guard(() => send({ kind: "photo", value: `media.sim.${Date.now()}` }, "(photo)")));
  $("send-flow").addEventListener("click", () =>
    guard(() => send({ kind: "flow", value: '{"item_ref":"Slim Fit Shirt — Blue / M"}' }, "(Flow submitted)")),
  );
  $("stop-preset").addEventListener("click", () => {
    state.stopRequested = true;
    state.notice = "Stopping after the current request finishes…";
    render();
  });
  for (const button of root.querySelectorAll("[data-preset]"))
    button.addEventListener("click", () => guard(() => runPreset(button)));
  for (const button of root.querySelectorAll("[data-age]"))
    button.addEventListener("click", () => guard(() => call({ action: "time_travel", ageMinutes: Number(button.dataset.age) })));
  $("maintenance").addEventListener("click", () => guard(() => call({ action: "maintenance" })));
  $("retry-delivery").addEventListener("click", () => guard(() => call({ action: "retry_delivery" })));
  $("refresh").addEventListener("click", () => guard(() => call({ action: "state" })));
  $("reset").addEventListener("click", () =>
    guard(async () => {
      state.transcript = [];
      state.completedCase = null;
      state.notice = null;
      await call({ action: "reset" });
    }),
  );

  render();
})();
