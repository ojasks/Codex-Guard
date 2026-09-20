<img width="960" height="360" alt="hero" src="https://github.com/user-attachments/assets/52106fc9-ba54-4348-891c-dc740a939c9b" />


# Codex Guard

**Standards nobody reads are just decoration. Codex Guard makes them read your code back.**

Paste a Dockerfile, CI workflow, Kubernetes manifest, or TypeScript / Go / shell file. Get a scored review in seconds, with the exact lines that broke the rules, a fix for each one, and a chat assistant that remembers your team and your exceptions.

Built on Cloudflare **Agents**, **Workflows**, **Durable Objects** and **Workers AI (Llama 3.3)**, for the Developer Productivity assignment. It's a miniature of the job itself: turn engineering standards into automated guardrails.

> The rules in `src/codex.ts` are examples I wrote for this project. They are not Cloudflare's real Engineering Codex.

## Try it in 60 seconds

1. Open the live demo, choose **Load a sample → Dockerfile**, and click **Run review**.
2. Watch the pipeline light up step by step. You should end at **38 / 100** with three failures: a hard-coded token, `node:latest`, and a container running as root.
3. Click **Request a waiver** on the root finding, type a reason, and save it.
4. Run the review again. The finding now reads **Waived** and the score jumps to **63**.
5. Ask the chat "what waivers do we have?" It knows, and it knows your team and stack too.
6. Refresh the page. Everything is still there.

## The one rule that makes it trustworthy

**Evidence beats opinion.**

LLMs are great at explaining a problem and unreliable at deciding whether it exists. So every rule has a deterministic check (policy-as-code) that collects hard evidence, with line numbers. The model explains and judges only the fuzzy cases. If the check finds a violation, the model cannot talk its way to a pass. A prompt injection hidden in your Dockerfile changes nothing.

| Rule type | Who decides | Example |
| --- | --- | --- |
| Authoritative | The check alone | Unpinned `:latest`, missing `USER`, no `permissions:` block |
| Fuzzy | Check first, then the LLM | Timeouts on outbound calls, swallowed errors, secrets in odd shapes |



## What happens when you click Run review

<img width="3200" height="1760" alt="architecture" src="https://github.com/user-attachments/assets/9025a02a-55b6-40aa-8774-b149a688f905" />




- **One flaky model call doesn't sink the review.** Each rule is its own workflow step with retries and a timeout. A garbled model reply downgrades one rule to "needs review" instead of failing everything.
- **State lives with the user.** Each browser gets a room, and each room is its own Durable Object. There are no accounts in this demo, so anyone with a room id can open that room.

## Checklist

| Requirement | Where it lives |
| --- | --- |
| LLM (Llama 3.3 on Workers AI) | `src/llm.ts`, using `@cf/meta/llama-3.3-70b-instruct-fp8-fast`; streaming for chat, one-shot for reviews |
| Workflow / coordination | `src/workflow.ts` (Cloudflare Workflows), started and observed by the agent in `src/agent.ts` |
| User input via chat | `public/index.html`: a WebSocket chat plus a review form |
| Memory or state | Agents SDK state (profile, waivers, active review) plus SQLite history, inside one Durable Object per room |

## Run it yourself

You need Node 22+ and a free Cloudflare account. These are the exact commands I used, in order.

```bash
npm install                    # dependencies
npx wrangler login             # authenticate with Cloudflare (opens your browser)
npm run dev                    # local server at http://localhost:8787

npm run typecheck              # generates binding types, then tsc
npm test                       # unit tests for the policy-as-code checks
npx wrangler deploy --dry-run  # bundle everything without deploying

npm run deploy                 # ship it to *.workers.dev
npx wrangler tail              # stream live production logs (Ctrl+C to stop)
```

Good to know:

- `npm run dev` runs the Worker, Durable Object and Workflow locally, but the Workers AI binding always calls your Cloudflare account, so LLM calls need `wrangler login` and count toward your usage.
- `wrangler tail` only shows the **deployed** app. Start it, then use the live URL.
- Local and live have separate data. A waiver saved on `localhost` won't exist on `workers.dev`.
- `.github/workflows/ci.yml` runs typecheck, tests and a deploy dry run on every push. It follows the same standards the app enforces: pinned versions, least-privilege permissions, and tests before deploy.

### Field notes

Local dev sometimes printed `The Workers runtime canceled this request because it detected that your Worker's code had hung`. It appeared even on a fresh start with a single tab, while every feature kept working. In production, `wrangler tail` showed `Ok` on every event and no errors, so I treated it as a local dev-server quirk and moved on.
But still Working on it ..

## Built with AI

I built this with Claude and kept the full record in `PROMPTS.md`. I tested it locally and in production, and I can walk through every file.

## Project layout

```
src/index.ts       Worker entry: routes /agents/* to the agent
src/agent.ts       CodexAgent: chat, memory, workflow orchestration
src/workflow.ts    ReviewWorkflow: the durable review pipeline
src/codex.ts       Rules, file detection, deterministic checks, scoring
src/llm.ts         Workers AI helpers (streaming, JSON extraction)
public/index.html  Chat and review UI (no build step)
test/              Unit tests for src/codex.ts
```

To try another model, change `MODEL` in `src/llm.ts`.

## Screenshots

<img width="1440" height="858" alt="Screenshot 2026-09-20 at 6 03 26 PM" src="https://github.com/user-attachments/assets/eed0b48c-2429-4ad6-b2b6-9635c5edf3b4" />

<img width="1440" height="858" alt="Screenshot 2026-09-20 at 6 03 36 PM" src="https://github.com/user-attachments/assets/3ba40374-fdde-461e-9cad-158cf57c12e8" />

<img width="1440" height="812" alt="Screenshot 2026-09-20 at 8 23 42 PM" src="https://github.com/user-attachments/assets/9b3dbe88-d17b-491d-ac85-9104a3e63d43" />

