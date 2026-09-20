<img width="960" height="360" alt="hero" src="https://github.com/user-attachments/assets/52106fc9-ba54-4348-891c-dc740a939c9b" />


An AI-powered app on Cloudflare that checks code and config against a team's **engineering standards** (a small, illustrative "codex") and answers questions about them in chat.

I built it for the Cloudflare Developer Productivity assignment because the role is about turning engineering standards into automated guardrails. Codex Guard is a miniature version of that idea: policy-as-code checks for hard evidence, an LLM for judgment and explanation, and an agent that remembers your team's context and exceptions.

> The rules in `src/codex.ts` are examples I wrote for this project. They are not Cloudflare's real Engineering Codex.

## What it does

- **Review a file.** Paste a Dockerfile, GitHub Actions workflow, Kubernetes manifest, or TypeScript / Go / shell code. A durable workflow detects the file type, picks the rules that apply, runs deterministic checks, asks the LLM to evaluate each rule, and writes a scored report. Progress streams live to the UI.
- **Chat about the codex.** Streaming answers from Llama 3.3. The assistant's prompt includes your team, stack, active waivers and recent reviews, so answers stay relevant between sessions.
- **Record exceptions.** Waive a failing rule with a reason. Waivers live in the agent's memory and are honored by later reviews.

## How it maps to the assignment

| Requirement | Where |
| --- | --- |
| LLM (Llama 3.3 on Workers AI) | `src/llm.ts` (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`), streaming for chat and one-shot for reviews |
| Workflow / coordination | `src/workflow.ts` (Cloudflare Workflows via `AgentWorkflow`) started and observed by the agent in `src/agent.ts` |
| User input via chat | `public/index.html`, a WebSocket chat plus a review form |
| Memory or state | Agents SDK state (profile, waivers, active review) synced to the browser, plus SQLite tables for chat and review history, all inside one Durable Object per user room |

## Architecture

```
Browser (public/index.html)
   |  WebSocket  /agents/codex-agent/<room>
   v
CodexAgent  (Durable Object, Agents SDK)                 src/agent.ts
   |- state:  profile, waivers, active review   -> synced to every connected tab
   |- SQLite: chat history, review reports      -> survives reloads and restarts
   |- chat:   streams tokens from Workers AI
   '- review: runWorkflow("REVIEW_WORKFLOW") ---------------------+
                                                                  v
ReviewWorkflow  (Cloudflare Workflows)                   src/workflow.ts
   classify -> select rules -> policy checks -> evaluate rules (parallel, 1 step per rule) -> summarize
      each step is checkpointed and retried on its own; progress is reported back to the agent
```

### Design choices worth knowing

- **Hybrid checking.** Each rule has a deterministic check (`src/codex.ts`). "Authoritative" rules are decided by that check alone. Fuzzier rules fall back to the LLM when the check finds nothing. Hard evidence always overrides the model's opinion, and the model can never turn a real finding into a pass.
- **Untrusted input.** The pasted code is treated as data in the prompt, and model output is parsed defensively. A malformed reply degrades one rule to "needs review" instead of failing the whole review.
- **Durable by construction.** Each rule evaluation is its own workflow step with retries and a timeout, so one flaky model call does not redo the whole review.
- **State lives with the user.** The room id in the browser (`localStorage`, or `?room=`) addresses that user's Durable Object. There are no accounts in this demo; anyone who knows the room id can open the room.

## Run it

Requirements: Node 22+, a Cloudflare account (the free plan is enough).

```bash
npm install
npx wrangler login
npm run dev        # http://localhost:8787
```

`wrangler dev` runs the Worker, Durable Object and Workflow locally. The Workers AI binding always talks to your Cloudflare account, so the LLM calls need `wrangler login` and count toward your Workers AI usage.

Deploy:

```bash
npm run deploy
```

Checks (also run in CI):

```bash
npm run typecheck   # generates binding types, then tsc
npm test            # unit tests for the policy-as-code checks
```

## Project layout

```
src/index.ts      Worker entry: routes /agents/* to the agent
src/agent.ts      CodexAgent: chat, memory, workflow orchestration
src/workflow.ts   ReviewWorkflow: the durable review pipeline
src/codex.ts      Rules, file detection, deterministic checks, scoring
src/llm.ts        Workers AI helpers (streaming, JSON extraction)
public/index.html Chat and review UI (no build step)
test/             Unit tests for src/codex.ts
```

To try a different model, change `MODEL` in `src/llm.ts`.

## What I would build next

- Human approval for waivers with `waitForApproval` in a second workflow, so exceptions expire and need a reviewer.
- Expose reviews as an **MCP server** so editors and other agents can call `review_file` directly.
- An eval set of files with known findings to track model accuracy per rule.
- Run the same checks as a CI job that comments on pull requests.
