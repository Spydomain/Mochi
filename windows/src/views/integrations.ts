// Integration cards shown in the overview's left card — DOM ports of
// IntegrationCardView and friends from IslandViewContent.swift.
//
// Cal.com is the one simplification: macOS shows a three-level calendar
// (month → day → booking); here it is the list of upcoming bookings.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { State, type AgentTask } from "../core/state";
import { Bridge } from "../core/bridge";
import { isComingSoon, pillDefinition } from "../core/pills";
import { refreshHookPills } from "../island/integrations";
import { readActivity, readPulse, readStats } from "../core/github";
import { githubDetail, githubPulseCard } from "./github";
import { N_, language, t } from "../i18n/i18n";

/** Same shape as the Swift `timeAgo` computed properties. */
export function timeAgo(value: unknown): string {
  const date = typeof value === "number" ? new Date(value) : new Date(String(value));
  const diff = (Date.now() - date.getTime()) / 1000;
  if (!Number.isFinite(diff)) return "";
  if (diff < 60) return t("just now");
  if (diff < 3600) return t("{n}m", { n: Math.floor(diff / 60) });
  if (diff < 86400) return t("{n}h", { n: Math.floor(diff / 3600) });
  return t("{n}d", { n: Math.floor(diff / 86400) });
}

function header(color: string, name: string, kind: string, extra?: Node): HTMLElement {
  const row = h("div", { class: "int-head" }, dot(color, 7), h("b", { text: name }), h("span", { text: kind }));
  if (extra) row.append(extra);
  return row;
}

/** Highlighted first row + plain rows, the layout every list card shares. */
function listRow(accent: string, first: boolean, ...children: Node[]): HTMLElement {
  const row = h("div", { class: first ? "int-row first" : "int-row" }, dot(accent, 5), ...children);
  if (first) row.style.background = `${accent}14`;
  return row;
}

function get(id: string): Record<string, unknown> {
  return (State.integrations[id]?.data ?? {}) as Record<string, unknown>;
}

function arr(id: string, key: string): Record<string, unknown>[] {
  const v = get(id)[key];
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

// ── Not configured / idle ─────────────────────────────────────────────────────

const OPEN_URLS: Record<string, string> = {
  integration_resend: "https://resend.com/emails",
  integration_vercel: "https://vercel.com/dashboard",
  integration_github: "https://github.com",
  integration_stripe: "https://dashboard.stripe.com/payments",
  integration_notion: "https://notion.so",
  integration_calcom: "https://app.cal.com/bookings",
};

/** IntegrationCardView.statusLabel on macOS. */
export function idleStatus(
  id: string,
  info: { configured: boolean; error: string | null } | undefined,
  chatModel: string,
): { label: string; color: string } {
  if (isComingSoon(id)) return { label: t("Coming soon"), color: "#6B7079" };
  if (info?.error) return { label: info.error, color: "#F4505E" };
  const configured = info?.configured ?? false;
  const def = pillDefinition(id);
  const ok = (label: string) => ({ label, color: "#22C55E" });
  const missing = (label: string) => ({ label, color: "#F4505E" });
  // Pills driven by hooks never have a key: they are connected once the hooks
  // are in place (Mac #183). A session replaces this card; nothing is loading.
  if (def?.connect.kind === "hooks") return configured ? ok(t("Hooks installed")) : missing(t("Hooks not installed"));
  if (def?.connect.kind === "none") return ok(t("Ready · no setup needed"));
  if (def?.connect.kind === "server") return configured ? ok(t("Connected")) : missing(t("Not connected"));
  if (def?.category === "ai") {
    if (!configured) return missing(t("Key not configured"));
    return ok(id === "ai_anthropic" ? t("Key configured · {model}", { model: chatModel }) : t("Key configured"));
  }
  return configured ? ok(t("Connected · loading…")) : missing(t("Key not configured"));
}

function idleCard(task: AgentTask, openSettings: () => void): HTMLElement {
  const info = State.integrations[task.id];
  const configured = info?.configured ?? false;
  const def = pillDefinition(task.id);
  const status = idleStatus(task.id, info, State.settings.model);

  const actions = h("div", { class: "int-actions" });
  if (task.id === "integration_claude") {
    actions.append(
      h("button", {
        class: "link-btn",
        style: `color:${task.color}b3`,
        text: t("Open Visual Studio Code"),
        onclick: () => void Bridge.openInVSCode(task.sessionCwd ?? null),
      }),
    );
  } else if (task.id === "agent_claude-desktop") {
    actions.append(
      h("button", {
        class: "link-btn",
        style: `color:${task.color}d9`,
        text: t("Open Claude"),
        onclick: () => void Bridge.openClaudeDesktop(),
      }),
    );
  } else if (task.id === "integration_n8n") {
    actions.append(
      h("button", {
        class: "link-btn",
        style: `color:${task.color}d9`,
        text: t("Open {name}", { name: "n8n" }),
        onclick: () => void Bridge.openN8n(),
      }),
    );
  } else if (OPEN_URLS[task.id]) {
    actions.append(
      h("button", {
        class: "link-btn",
        style: `color:${task.color}d9`,
        text: t("Open {name}", { name: task.name }),
        onclick: () => void Bridge.openUrl(OPEN_URLS[task.id]),
      }),
    );
  }
  const hookPill = def?.connect.kind === "hooks";
  if (isComingSoon(task.id) || def?.connect.kind === "none") {
    // Nothing to set up, and nothing to refresh.
  } else if (configured && (hookPill || def?.category !== "ai")) {
    actions.append(
      h("button", {
        class: "link-btn",
        style: `color:${task.color}d9`,
        text: t("Refresh"),
        // A hook pill has nothing to poll: look at its hooks again instead.
        onclick: () => void (hookPill ? refreshHookPills() : Bridge.refreshIntegration(task.id)),
      }),
    );
  } else if (!configured) {
    actions.append(
      h("button", { class: "link-btn", style: "color:#8e939c", text: t("Settings…"), onclick: openSettings }),
    );
  }

  return h(
    "div",
    { class: "int-card" },
    header(
      task.color,
      task.id === "integration_claude" ? "VS Code" : task.name,
      t(def?.subtitle ?? N_("Integration")),
    ),
    h("div", { class: "int-status" }, dot(status.color, 5), h("span", { text: status.label })),
    actions,
  );
}

// ── Vercel ────────────────────────────────────────────────────────────────────

function vercelCard(onDetail: () => void): HTMLElement {
  const deployments = arr("integration_vercel", "deployments");
  const rows = h("div", { class: "int-rows" });
  deployments.slice(0, 3).forEach((d, i) => {
    const accent = d.state === "READY" ? "#22C55E" : "#F4505E";
    const name = h("span", { class: "int-name", text: String(d.projectName ?? "") });
    const ago = h("span", { class: "int-ago", text: timeAgo(d.createdAt) });
    if (i === 0) {
      const more = h(
        "button",
        { class: "int-more", title: t("Details"), onclick: onDetail },
        svg(ICONS.ellipsis, 8),
      );
      rows.append(listRow(accent, true, name, ago, more));
    } else {
      rows.append(listRow(accent, false, name, ago));
    }
  });
  return h("div", { class: "int-card" }, header("#7C5CFF", "Vercel", t("Deployments")), rows);
}

function vercelDetail(onBack: () => void): HTMLElement {
  const d = arr("integration_vercel", "deployments")[0] ?? {};
  const success = d.state === "READY";
  const accent = success ? "#22C55E" : "#F4505E";
  const status = success ? t("Ready") : d.state === "CANCELED" ? t("Canceled") : t("Error");
  const body = h("div", { class: "int-detail-body" });
  if (d.commitMessage) body.append(h("div", { class: "int-commit", text: String(d.commitMessage) }));
  const meta = h("div", { class: "int-meta" });
  if (d.branch) meta.append(h("span", { text: String(d.branch) }));
  meta.append(h("span", { text: t("{time} ago", { time: timeAgo(d.createdAt) }) }));
  body.append(meta);
  if (d.url) {
    body.append(
      h("button", {
        class: "int-link",
        text: String(d.url),
        onclick: () => void Bridge.openUrl(`https://${d.url}`),
      }),
    );
  }
  return h(
    "div",
    { class: "int-card detail" },
    h(
      "div",
      { class: "int-detail-head" },
      h("button", { class: "int-back", onclick: onBack }, svg(ICONS.chevronLeft, 10, { stroke: 2.4 })),
      dot(accent, 6),
      h("b", { text: String(d.projectName ?? t("Deployment")) }),
      h("span", { class: "int-badge", style: `color:${accent};background:${accent}24`, text: status }),
    ),
    body,
  );
}

// ── Resend ────────────────────────────────────────────────────────────────────

function resendCard(): HTMLElement {
  const emails = arr("integration_resend", "emails");
  const total = get("integration_resend").total;
  const extra =
    total != null
      ? h("span", { class: "int-total" }, h("i", { class: "pulse" }), h("span", { text: String(total) }))
      : undefined;
  const rows = h("div", { class: "int-rows" });
  emails.slice(0, 3).forEach((e, i) => {
    const delivered = e.lastEvent === "delivered";
    const accent = delivered ? "#22C55E" : "#F4505E";
    const to = Array.isArray(e.to) ? String(e.to[0] ?? "?") : "?";
    const short = to.split("@")[0];
    const cells: Node[] = [
      h("span", { class: "int-name", text: short }),
      h("span", { class: "int-ago", text: timeAgo(e.createdAt) }),
    ];
    if (i === 0 && e.subject) cells.push(h("span", { class: "int-sub", text: String(e.subject) }));
    rows.append(listRow(accent, i === 0, ...cells));
  });
  return h("div", { class: "int-card" }, header("#22C55E", "Resend", t("Emails"), extra), rows);
}

// ── GitHub ────────────────────────────────────────────────────────────────────

function statRow(icon: string, color: string, label: string, value: string): HTMLElement {
  return h(
    "div",
    { class: "int-stat" },
    h("i", { class: "int-stat-icon", style: `color:${color}` }, svg(icon, 10)),
    h("span", { class: "int-stat-label", text: label }),
    h("span", { class: "int-stat-value", text: value }),
  );
}

function githubCard(): HTMLElement {
  const d = get("integration_github");
  const stars = Number(d.totalStars ?? 0);
  const repos = Number(d.totalRepos ?? 0);
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return h(
    "div",
    { class: "int-card" },
    header("#F4505E", "GitHub", t("Overview")),
    h(
      "div",
      { class: "int-stats" },
      statRow(ICONS.star, "#F5A524", t("Total stars"), fmt(stars)),
      statRow(ICONS.stack, "#6B7079", t("Repositories"), String(repos)),
    ),
  );
}

// ── Stripe ────────────────────────────────────────────────────────────────────

function stripeCard(): HTMLElement {
  const d = get("integration_stripe");
  const balance = (Number(d.balance ?? 0) / 100).toFixed(2);
  const currency = String(d.currency ?? "eur").toUpperCase();
  const rows = h("div", { class: "int-rows tight" });
  for (const p of arr("integration_stripe", "payments")) {
    const success = p.status === "succeeded";
    const accent = success ? "#22C55E" : "#F4505E";
    rows.append(
      h(
        "div",
        { class: "int-row" },
        dot(accent, 5),
        h("span", { class: "int-name", text: String(p.description ?? t("Payment")) }),
        h("span", {
          class: "int-amount",
          style: "color:#22c55e",
          text: `+${(Number(p.amount ?? 0) / 100).toFixed(2)}`,
        }),
        h("span", { class: "int-ago", text: timeAgo(p.createdAt) }),
      ),
    );
  }
  return h(
    "div",
    { class: "int-card" },
    header("#0570DE", "Stripe", t("Payments")),
    h("div", { class: "int-balance" }, h("span", { text: balance }), h("i", { text: currency })),
    rows,
  );
}

// ── Notion ────────────────────────────────────────────────────────────────────

function notionCard(): HTMLElement {
  const rows = h("div", { class: "int-rows tight" });
  for (const p of arr("integration_notion", "pages").slice(0, 3)) {
    rows.append(
      h(
        "button",
        {
          class: "int-page",
          onclick: () => {
            if (typeof p.url === "string") void Bridge.openUrl(p.url);
          },
        },
        p.emoji
          ? h("span", { class: "int-emoji", text: String(p.emoji) })
          : h("i", { class: "int-emoji" }, svg(ICONS.doc, 9)),
        h("span", { class: "int-name", text: String(p.title ?? t("Untitled")) }),
        h("span", { class: "int-ago", text: timeAgo(p.lastEditedAt) }),
      ),
    );
  }
  return h("div", { class: "int-card" }, header("#E8E8E8", "Notion", t("Recent")), rows);
}

// ── Cal.com ───────────────────────────────────────────────────────────────────

function calcomCard(): HTMLElement {
  const bookings = arr("integration_calcom", "bookings")
    .slice()
    .sort((a, b) => new Date(String(a.start)).getTime() - new Date(String(b.start)).getTime());
  const rows = h("div", { class: "int-rows tight" });
  if (bookings.length === 0) {
    rows.append(h("div", { class: "int-empty", text: t("No calls scheduled") }));
  }
  for (const b of bookings.slice(0, 3)) {
    const when = new Date(String(b.start));
    const day = when.toLocaleDateString(language(), { day: "2-digit", month: "2-digit" });
    const time = when.toLocaleTimeString(language(), { hour: "2-digit", minute: "2-digit" });
    rows.append(
      h(
        "div",
        { class: "int-row" },
        dot("#C9956A", 4),
        h("span", { class: "int-time", text: `${day} ${time}` }),
        h("span", { class: "int-name", text: String(b.title ?? t("Meeting")) }),
      ),
    );
  }
  return h("div", { class: "int-card" }, header("#C9956A", "Cal.com", t("Schedule")), rows);
}

// ── n8n ───────────────────────────────────────────────────────────────────────

function n8nCard(task: AgentTask, onDetail: () => void, openSettings: () => void): HTMLElement {
  const hasActivity = task.steps.length > 0 && (task.state === "finished" || task.state === "error");
  if (!hasActivity) return idleCard(task, openSettings);
  const success = task.state === "finished";
  const accent = success ? "#22C55E" : "#F4505E";
  return h(
    "div",
    { class: "int-card" },
    header("#F29B38", "n8n", t("Workflow")),
    h(
      "div",
      { class: "int-actions" },
      h(
        "button",
        {
          class: "int-pill",
          style: `background:${accent}1a;border-color:${accent}38`,
          onclick: onDetail,
        },
        dot(accent, 5),
        h("span", { class: "int-name", text: task.steps[0] ?? t("Workflow") }),
        svg(ICONS.ellipsis, 8),
      ),
    ),
  );
}

function n8nDetail(task: AgentTask, onBack: () => void): HTMLElement {
  const success = task.state === "finished";
  const accent = success ? "#22C55E" : "#F4505E";
  const detail = task.steps[1];
  return h(
    "div",
    { class: "int-card detail" },
    h(
      "div",
      { class: "int-detail-head" },
      h("button", { class: "int-back", onclick: onBack }, svg(ICONS.chevronLeft, 10, { stroke: 2.4 })),
      dot(accent, 6),
      h("b", { text: task.steps[0] ?? t("Workflow") }),
      h("span", {
        class: "int-badge",
        style: `color:${accent};background:${accent}24`,
        text: success ? t("Success") : t("Failed"),
      }),
    ),
    detail
      ? h("pre", { class: "int-detail-text", text: detail })
      : h("div", {
          class: "int-status",
          text: success ? t("Completed successfully.") : t("No error details available."),
        }),
  );
}

// ── System ────────────────────────────────────────────────────────────────────

let networkOpen = false;
let networkSnapshot: { addresses: string[]; listening: string[]; established: number } | null = null;

/** A labelled usage bar (CPU, memory) for the System card. */
function usageBar(color: string, label: string, value: string, percent: number): HTMLElement {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return h(
    "div",
    { class: "sys-gauge" },
    h(
      "div",
      { class: "sys-gauge-head" },
      h("span", { class: "int-stat-label", text: label }),
      h("span", { class: "int-stat-value", text: value }),
    ),
    h("div", { class: "sys-bar" }, h("i", { style: `width:${clamped}%;background:${color}` })),
  );
}

function systemCard(): HTMLElement {
  const d = get("integration_system");
  const cpu = Number(d.cpuPercent ?? 0);
  const memPct = Number(d.memPercent ?? 0);
  const memUsed = Number(d.memUsed ?? 0);
  const memTotal = Number(d.memTotal ?? 0);
  const processes = arr("integration_system", "processes");
  const procCount = Number(d.processCount ?? processes.length);
  const load1 = Number(d.load1 ?? 0);
  const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);

  const gauges = h(
    "div",
    { class: "int-stats" },
    usageBar("#38BDF8", "CPU", `${Math.round(cpu)}%`, cpu),
    usageBar("#22C55E", "Memory", `${gb(memUsed)} / ${gb(memTotal)} GB`, memPct),
  );

  const rows = h("div", { class: "int-rows tight" });
  processes.slice(0, 5).forEach((p, i) => {
    const cpuP = Number(p.cpu ?? 0);
    const accent = cpuP >= 25 ? "#F4505E" : cpuP >= 5 ? "#F5A524" : "#38BDF8";
    rows.append(
      listRow(
        accent,
        i === 0,
        h("span", { class: "int-name", text: String(p.name ?? p.pid ?? "") }),
        h("span", {
          class: "int-ago",
          text: `${cpuP.toFixed(0)}% · ${(Number(p.memKb ?? 0) / 1024).toFixed(0)} MB`,
        }),
      ),
    );
  });

  const network = h("div", { class: "int-rows tight int-network" });
  const syncNetwork = () => {
    rows.style.display = networkOpen ? "none" : "";
    network.style.display = networkOpen ? "" : "none";
    clear(network);
    if (!networkOpen) return;
    if (!networkSnapshot) {
      network.append(h("div", { class: "int-status", text: "Reading local network…" }));
      return;
    }
    const addresses = networkSnapshot.addresses.join(", ") || "No active IPv4 address";
    const ports = networkSnapshot.listening.join(", ") || "No listening ports";
    network.append(
      listRow("#38BDF8", true, h("span", { class: "int-name", text: "Local IP" }), h("span", { class: "int-ago", text: addresses, title: addresses })),
      listRow("#F5A524", false, h("span", { class: "int-name", text: "Listening" }), h("span", { class: "int-ago", text: ports, title: ports })),
      listRow("#22C55E", false, h("span", { class: "int-name", text: "Connections" }), h("span", { class: "int-ago", text: String(networkSnapshot.established) })),
    );
  };
  const networkButton = h("button", { class: "link-btn", style: "color:#38bdf8d9", text: networkOpen ? "Processes" : "Network snapshot" });
  networkButton.addEventListener("click", () => {
    networkOpen = !networkOpen;
    networkButton.textContent = networkOpen ? "Processes" : "Network snapshot";
    syncNetwork();
    if (networkOpen) void Bridge.securitySnapshot().then((snapshot) => {
      if (!snapshot) return;
      networkSnapshot = snapshot;
      if (network.isConnected) syncNetwork();
    });
  });
  syncNetwork();

  return h(
    "div",
    { class: "int-card" },
    header("#38BDF8", "System monitor", "Monitor"),
    gauges,
    rows,
    network,
    h("div", { class: "int-status" }, h("span", {
      text: `${procCount} processes · load ${load1.toFixed(2)}`,
    })),
    h("div", { class: "int-actions" }, networkButton, h("button", {
      class: "link-btn",
      style: "color:#38bdf8d9",
      text: t("Refresh"),
      onclick: () => void Bridge.refreshIntegration("integration_system"),
    })),
  );
}

// ── Media ─────────────────────────────────────────────────────────────────────

/** Browser capability flags can be stale; let MPRIS decide whether to skip. */
function mediaButton(icon: string, label: string, onclick: () => void): HTMLElement {
  return h("button", {
    class: "np-icon", type: "button", title: label, "aria-label": label, onclick,
  }, svg(icon, 12));
}

function mediaCard(): HTMLElement {
  const d = get("integration_media");
  const players = (d.players as Array<Record<string, unknown>> ?? []);
  const activeBus = String(d.activeBus ?? "");

  const head = header("#F5A524", "Media", "Now playing");

  if (players.length === 0) {
    return h(
      "div",
      { class: "int-card" },
      head,
      h("div", { class: "int-status" }, h("span", { text: "No MPRIS players found" })),
    );
  }

  // Active player
  const active = players.find((p) => String(p.bus ?? "") === activeBus) ?? players[0];
  let selectedBus = String(active.bus ?? "");
  const selected = () => players.find((p) => String(p.bus ?? "") === selectedBus) ?? active;

  // Custom picker: native selects can grow to the height of their popup on
  // Linux/WebKit, which used to push the transport row out of the card.
  let pickerOpen = false;
  const pickerLabel = h("span", { text: String(active.name ?? "Media") });
  const pickerMenu = h("div", { class: "media-picker-menu" });
  const selector = h(
    "div",
    { class: "media-picker" },
    h("button", {
      class: "media-picker-button",
      type: "button",
      title: "Select media player",
      "aria-label": "Select media player",
      onclick: (e: Event) => {
        e.stopPropagation();
        pickerOpen = !pickerOpen;
        pickerMenu.classList.toggle("open", pickerOpen);
      },
    }, pickerLabel, svg(ICONS.chevronUpDown, 12, { stroke: 1.8 })),
    pickerMenu,
  );
  for (const p of players) {
    const bus = String(p.bus ?? "");
    const option = h("button", {
      type: "button",
      class: "media-picker-option",
      text: `${String(p.name ?? "")} ${p.playing === true ? "▶" : ""}`,
      onclick: (e: Event) => {
        e.stopPropagation();
        pickerOpen = false;
        pickerMenu.classList.remove("open");
        selectedBus = bus;
        syncSelected();
        void Bridge.mediaSetPlayer(bus);
      },
    });
    pickerMenu.append(option);
  }

  const title = h("span", { class: "np-title" });
  const subtitle = h("span", { class: "np-sub" });
  const text = h(
    "div",
    { class: "media-track" },
    title, subtitle,
  );

  const playPause = h("button", {
    class: "np-play", type: "button",
    onclick: () => {
      const p = selected();
      const isPlaying = p.playing === true;
      if ((isPlaying ? p.canPause : p.canPlay) !== false) {
        void Bridge.mediaControl(isPlaying ? "pause" : "play", selectedBus);
      }
    },
  });
  function syncSelected() {
    const p = selected();
    const playing = p.playing === true;
    const label = playing ? "Pause playback" : "Play playback";
    pickerLabel.textContent = String(p.name ?? "Media");
    title.textContent = String(p.title ?? "") || "—";
    subtitle.textContent = [p.artist, p.album, p.name].filter(Boolean).join(" · ");
    playPause.setAttribute("title", label);
    playPause.setAttribute("aria-label", label);
    if ((playing ? p.canPause : p.canPlay) === false) playPause.setAttribute("disabled", "");
    else playPause.removeAttribute("disabled");
    clear(playPause);
    playPause.append(svg(playing ? ICONS.pause : ICONS.play, 11));
  }
  syncSelected();

  const controls = h(
    "div",
    { class: "np-buttons media-controls" },
    mediaButton(ICONS.backward, "Previous track",
      () => void Bridge.mediaControl("previous", selectedBus)),
    playPause,
    mediaButton(ICONS.forward, "Next track",
      () => void Bridge.mediaControl("next", selectedBus)),
  );

  return h("div", { class: "int-card media-card" },
    h("div", { class: "media-top" }, head, selector), text, controls);
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

export interface IntegrationCardHooks {
  detailOpen: boolean;
  openDetail(): void;
  closeDetail(): void;
  openSettings(): void;
}

/** True when this integration has data worth showing instead of the idle card. */
export function hasIntegrationData(id: string): boolean {
  const info = State.integrations[id];
  if (!info || info.error) return false;
  switch (id) {
    case "integration_vercel":
      return arr(id, "deployments").length > 0;
    case "integration_resend":
      return arr(id, "emails").length > 0;
    case "integration_github":
      return get(id).totalRepos != null || readPulse(get(id)) != null;
    case "integration_stripe":
      return info.loaded;
    case "integration_notion":
      return arr(id, "pages").length > 0;
    case "integration_calcom":
      return info.loaded;
    case "integration_system":
      return info.loaded;
    case "integration_media":
      return info.loaded;
    default:
      return false;
  }
}

export function renderIntegrationCard(task: AgentTask, hooks: IntegrationCardHooks): HTMLElement {
  if (task.id === "integration_n8n") {
    const hasActivity = task.steps.length > 0 && (task.state === "finished" || task.state === "error");
    return hooks.detailOpen && hasActivity
      ? n8nDetail(task, hooks.closeDetail)
      : n8nCard(task, hooks.openDetail, hooks.openSettings);
  }
  if (task.id === "integration_vercel" && hasIntegrationData(task.id)) {
    return hooks.detailOpen ? vercelDetail(hooks.closeDetail) : vercelCard(hooks.openDetail);
  }
  if (!hasIntegrationData(task.id)) return idleCard(task, hooks.openSettings);

  // With the pulse in, GitHub gets the Mac's richer card and its lists.
  if (task.id === "integration_github") {
    const d = get(task.id);
    const pulse = readPulse(d);
    if (pulse) {
      return hooks.detailOpen
        ? githubDetail(pulse, readStats(d), readActivity(d), hooks.closeDetail)
        : githubPulseCard(pulse, readStats(d), readActivity(d), hooks.openDetail);
    }
  }

  switch (task.id) {
    case "integration_resend":
      return resendCard();
    case "integration_github":
      return githubCard();
    case "integration_stripe":
      return stripeCard();
    case "integration_notion":
      return notionCard();
    case "integration_calcom":
      return calcomCard();
    case "integration_system":
      return systemCard();
    case "integration_media":
      return mediaCard();
    default:
      return idleCard(task, hooks.openSettings);
  }
}

export { clear };
