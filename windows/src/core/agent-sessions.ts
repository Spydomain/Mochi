/** Lifecycle, not elapsed time, decides whether a session is still working. */
export interface SessionActivity {
  id: string;
  cwd: string;
  state: "thinking" | "working" | "approval";
  active: boolean;
  closed: boolean;
}

export class AgentSessions {
  private agents = new Map<string, Map<string, SessionActivity>>();

  clear() { this.agents.clear(); }

  remaining(agent: string): SessionActivity | undefined {
    return [...(this.agents.get(agent)?.values() ?? [])].reverse().find(session => session.active);
  }

  observe(agent: string, id: string, event: string, cwd: string) {
    let sessions = this.agents.get(agent);
    if (!sessions) this.agents.set(agent, sessions = new Map());
    const previous = sessions.get(id);
    const starts = event === "SessionStart" || event === "UserPromptSubmit" || event === "PermissionRequest";
    const terminal = ["Stop", "StopFailure", "Interrupt", "SessionEnd"].includes(event);
    const work = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest"].includes(event);
    // Background tools can finish after a turn ended. They cannot open a new
    // turn; only the agent's explicit lifecycle start can do that.
    if (previous?.closed && !starts) return { ignore: true, terminal, remaining: this.remaining(agent) };
    if (starts || work || terminal) {
      sessions.delete(id);
      sessions.set(id, { id, cwd: cwd || previous?.cwd || "", closed: terminal,
        active: !terminal && event !== "SessionStart",
        state: event === "UserPromptSubmit" ? "thinking" : event === "PermissionRequest" ? "approval" : "working" });
      // Keep tombstones after a transient pill disappears, without retaining
      // an unbounded history. Never evict a genuinely active session.
      while (sessions.size > 256) {
        const old = [...sessions].find(([, session]) => !session.active);
        if (!old) break;
        sessions.delete(old[0]);
      }
    }
    return { ignore: false, terminal, remaining: this.remaining(agent) };
  }
}
