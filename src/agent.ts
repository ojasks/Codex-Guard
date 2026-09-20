import { Agent, type Connection, type WSMessage } from "agents";
import { CODEX_RULES } from "./codex";
import { streamText, type ChatMessage } from "./llm";
import type { CodexState, ReviewParams, ReviewReport, StepProgress } from "./types";

const MAX_CODE_CHARS = 12_000;
const MAX_CHAT_CHARS = 4_000;

type ClientMessage =
  | { type: "chat"; text: string }
  | { type: "review"; filename: string; code: string }
  | { type: "set_profile"; team: string; stack: string }
  | { type: "waive"; ruleId: string; reason: string }
  | { type: "unwaive"; ruleId: string }
  | { type: "clear_history" };

/**
 * One CodexAgent per user "room". It is a Durable Object, so it gives us:
 *  - memory/state: `this.state` (synced to clients) + SQLite (chat + review history)
 *  - coordination: starts ReviewWorkflow and reacts to its progress/completion
 *  - real-time chat: WebSocket connections handled in onMessage
 */
export class CodexAgent extends Agent<Env, CodexState> {
  initialState: CodexState = {
    profile: { team: "", stack: "" },
    waivers: [],
    reviewsRun: 0,
    active: null,
  };

  private generating = false;

  async onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      ts INTEGER NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      score INTEGER NOT NULL,
      report TEXT NOT NULL,
      ts INTEGER NOT NULL
    )`;
  }

  // ---------- connection lifecycle ----------

  onConnect(connection: Connection) {
    const messages = this.sql<{ role: string; content: string }>`
      SELECT role, content FROM (SELECT * FROM messages ORDER BY id DESC LIMIT 40) ORDER BY id ASC`;
    const reviews = this.sql<{ report: string }>`
      SELECT report FROM reviews ORDER BY ts DESC LIMIT 10`.map((r) => JSON.parse(r.report) as ReviewReport);
    connection.send(JSON.stringify({ type: "history", messages, reviews }));
  }

  async onMessage(connection: Connection, raw: WSMessage) {
    if (typeof raw !== "string") return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case "chat":
        return this.handleChat(connection, msg.text);
      case "review":
        return this.handleReview(connection, msg.filename, msg.code);
      case "set_profile":
        this.setState({
          ...this.state,
          profile: { team: String(msg.team ?? "").slice(0, 80), stack: String(msg.stack ?? "").slice(0, 120) },
        });
        return;
      case "waive": {
        if (!CODEX_RULES.some((r) => r.id === msg.ruleId)) return;
        const reason = String(msg.reason ?? "").trim().slice(0, 300);
        if (!reason) return this.fail(connection, "A waiver needs a reason.");
        const others = this.state.waivers.filter((w) => w.ruleId !== msg.ruleId);
        this.setState({ ...this.state, waivers: [...others, { ruleId: msg.ruleId, reason, at: Date.now() }] });
        return;
      }
      case "unwaive":
        this.setState({ ...this.state, waivers: this.state.waivers.filter((w) => w.ruleId !== msg.ruleId) });
        return;
      case "clear_history":
        this.sql`DELETE FROM messages`;
        this.sql`DELETE FROM reviews`;
        this.setState({ ...this.state, reviewsRun: 0 });
        this.broadcast(JSON.stringify({ type: "history", messages: [], reviews: [] }));
        return;
    }
  }

  // ---------- chat ----------

  private async handleChat(connection: Connection, input: string) {
    const text = String(input ?? "").trim().slice(0, MAX_CHAT_CHARS);
    if (!text) return;
    if (this.generating) return this.fail(connection, "Still answering the previous message.");

    this.saveMessage("user", text);
    this.broadcast(JSON.stringify({ type: "chat_user", text }));

    const id = crypto.randomUUID();
    this.generating = true;
    this.broadcast(JSON.stringify({ type: "chat_start", id }));

    let reply = "";
    try {
      for await (const token of streamText(this.env, this.buildPrompt())) {
        reply += token;
        this.broadcast(JSON.stringify({ type: "chat_token", id, token }));
      }
    } catch (err) {
      console.error("chat stream failed", err);
      if (!reply) {
        reply = "The model call failed. Try again in a moment.";
        this.broadcast(JSON.stringify({ type: "chat_token", id, token: reply }));
      }
    } finally {
      this.generating = false;
    }

    this.saveMessage("assistant", reply);
    this.broadcast(JSON.stringify({ type: "chat_end", id }));
  }

  /** Memory in action: the system prompt carries the profile, waivers and recent reviews. */
  private buildPrompt(): ChatMessage[] {
    const { profile, waivers } = this.state;
    const codex = CODEX_RULES.map((r) => `- ${r.id} [${r.severity}] ${r.title}: ${r.standard}`).join("\n");

    const recent = this.sql<{ report: string }>`SELECT report FROM reviews ORDER BY ts DESC LIMIT 3`
      .map((r) => JSON.parse(r.report) as ReviewReport)
      .map((r) => {
        const bad = r.results.filter((x) => x.status === "fail").map((x) => x.ruleId);
        return `- ${r.filename}: ${r.score}/100${bad.length ? `, failing ${bad.join(", ")}` : ", clean"}`;
      });

    const system = [
      "You are Codex Guard, an assistant that helps engineers follow their team's engineering codex.",
      "Be concise and concrete. Prefer short answers with a code snippet when a fix is needed.",
      "Only cite rule IDs from the codex below. If something is not covered, say so.",
      "",
      "Codex:",
      codex,
      "",
      `Team: ${profile.team || "unknown"}. Stack: ${profile.stack || "unknown"}.`,
      waivers.length
        ? `Active waivers:\n${waivers.map((w) => `- ${w.ruleId}: ${w.reason}`).join("\n")}`
        : "Active waivers: none.",
      recent.length ? `Recent reviews:\n${recent.join("\n")}` : "Recent reviews: none.",
    ].join("\n");

    const history = this.sql<{ role: "user" | "assistant"; content: string }>`
      SELECT role, content FROM (SELECT * FROM messages ORDER BY id DESC LIMIT 14) ORDER BY id ASC`;

    return [{ role: "system", content: system }, ...history];
  }

  private saveMessage(role: "user" | "assistant", content: string) {
    this.sql`INSERT INTO messages (role, content, ts) VALUES (${role}, ${content}, ${Date.now()})`;
  }

  // ---------- reviews (workflow) ----------

  private async handleReview(connection: Connection, filenameIn: string, codeIn: string) {
    const code = String(codeIn ?? "");
    const filename = String(filenameIn ?? "").trim().slice(0, 120) || "snippet.txt";
    if (!code.trim()) return this.fail(connection, "Paste some code or config to review.");
    if (code.length > MAX_CODE_CHARS) return this.fail(connection, `Keep it under ${MAX_CODE_CHARS} characters.`);
    if (this.state.active) return this.fail(connection, "A review is already running.");

    const reviewId = `rev-${crypto.randomUUID().slice(0, 8)}`;
    const params: ReviewParams = {
      reviewId,
      filename,
      code,
      waivedRuleIds: this.state.waivers.map((w) => w.ruleId),
    };

    this.setState({
      ...this.state,
      active: { reviewId, filename, steps: [{ step: "queued", status: "running", message: "Starting workflow" }] },
    });

    try {
      await this.runWorkflow("REVIEW_WORKFLOW", params, { id: reviewId });
    } catch (err) {
      console.error("could not start workflow", err);
      this.setState({ ...this.state, active: null });
      this.fail(connection, "Could not start the review workflow.");
    }
  }

  // Callbacks from ReviewWorkflow (via the Agents SDK)

  async onWorkflowProgress(_workflowName: string, workflowId: string, progress: unknown) {
    const active = this.state.active;
    if (!active || active.reviewId !== workflowId) return;
    const p = progress as StepProgress;
    const steps = active.steps.filter((s) => s.step !== "queued");
    const i = steps.findIndex((s) => s.step === p.step);
    if (i >= 0) steps[i] = { step: p.step, status: p.status, message: p.message };
    else steps.push({ step: p.step, status: p.status, message: p.message });
    this.setState({ ...this.state, active: { ...active, steps } });
  }

  async onWorkflowComplete(_workflowName: string, _workflowId: string, result?: unknown) {
    const report = result as ReviewReport;
    this.sql`INSERT OR REPLACE INTO reviews (id, filename, score, report, ts)
             VALUES (${report.reviewId}, ${report.filename}, ${report.score}, ${JSON.stringify(report)}, ${report.createdAt})`;
    this.saveMessage("assistant", `Review of ${report.filename}: ${report.score}/100. ${report.summary}`);
    this.setState({ ...this.state, active: null, reviewsRun: this.state.reviewsRun + 1 });
    this.broadcast(JSON.stringify({ type: "review_complete", report }));
  }

  async onWorkflowError(_workflowName: string, _workflowId: string, error: string) {
    console.error("review workflow failed", error);
    this.setState({ ...this.state, active: null });
    this.broadcast(JSON.stringify({ type: "error", message: "The review failed. Please try again." }));
  }

  private fail(connection: Connection, message: string) {
    connection.send(JSON.stringify({ type: "error", message }));
  }
}
