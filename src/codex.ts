/**
 * A small, illustrative "engineering codex": standards that can be checked
 * automatically. Each rule has
 *   1. a plain-English standard (given to the LLM), and
 *   2. a deterministic check (policy-as-code) that collects hard evidence.
 *
 * Rules marked `authoritative` are decided by the deterministic check alone.
 * The others fall back to the LLM when the check finds nothing, because
 * "did the author handle X?" often can't be answered with a regex.
 *
 * NOTE: these rules are examples written for this project. They are not
 * Cloudflare's real Engineering Codex.
 */

export type ArtifactKind =
  | "typescript"
  | "go"
  | "shell"
  | "dockerfile"
  | "ci-yaml"
  | "kubernetes"
  | "other";

export type Severity = "high" | "medium" | "low";

export interface Evidence {
  line: number;
  text: string;
}

export interface Rule {
  id: string;
  title: string;
  severity: Severity;
  appliesTo: ArtifactKind[] | "any";
  standard: string;
  authoritative: boolean;
  check: (code: string, kind: ArtifactKind) => Evidence[];
}

// ---------- helpers ----------

function grep(code: string, re: RegExp): Evidence[] {
  const out: Evidence[] = [];
  code.split(/\r?\n/).forEach((text, i) => {
    if (re.test(text)) out.push({ line: i + 1, text: text.trim().slice(0, 160) });
  });
  return out;
}

/** Match across lines; report the line where each match starts. */
function grepMultiline(code: string, re: RegExp): Evidence[] {
  const out: Evidence[] = [];
  const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  for (const m of code.matchAll(global)) {
    const line = code.slice(0, m.index ?? 0).split(/\r?\n/).length;
    out.push({ line, text: m[0].replace(/\s+/g, " ").trim().slice(0, 160) });
  }
  return out;
}

function dedupe(evidence: Evidence[]): Evidence[] {
  const seen = new Set<number>();
  return evidence.filter((e) => (seen.has(e.line) ? false : (seen.add(e.line), true)));
}

// ---------- artifact detection ----------

export function detectKind(filename: string, code: string): ArtifactKind {
  const name = filename.toLowerCase();
  if (/(^|\/)dockerfile(\.|$)/.test(name) || name.endsWith(".dockerfile")) return "dockerfile";
  if (/\.(ts|tsx|js|mjs|cjs|jsx)$/.test(name)) return "typescript";
  if (name.endsWith(".go")) return "go";
  if (/\.(sh|bash)$/.test(name)) return "shell";
  if (/\.ya?ml$/.test(name)) {
    if (/^\s*apiVersion:/m.test(code) && /^\s*kind:/m.test(code)) return "kubernetes";
    return "ci-yaml";
  }

  // Fall back to sniffing the content.
  if (/^\s*FROM\s+\S+/im.test(code) && /^\s*(RUN|CMD|COPY|ENTRYPOINT)\b/im.test(code)) return "dockerfile";
  if (/^\s*apiVersion:/m.test(code) && /^\s*kind:/m.test(code)) return "kubernetes";
  if (/^\s*(on|jobs|steps):/m.test(code) || /\buses:\s*\S+@/.test(code)) return "ci-yaml";
  if (/^#!\/.*\b(ba)?sh\b/.test(code)) return "shell";
  if (/^\s*package\s+\w+/m.test(code) && /\bfunc\s/.test(code)) return "go";
  if (/\b(import|export|const|interface)\b/.test(code)) return "typescript";
  return "other";
}

// ---------- the rules ----------

export const CODEX_RULES: Rule[] = [
  {
    id: "CDX-001",
    title: "No secrets in source",
    severity: "high",
    appliesTo: "any",
    authoritative: false,
    standard:
      "Credentials, tokens, API keys and private keys must never appear in source or config. Read them from the platform's secret store or environment at runtime.",
    check: (code) =>
      dedupe([
        ...grep(code, /[\w-]*(api[_-]?key|secret|token|passw(or)?d)[\w-]*\s*[:=]\s*["'][^"'\s]{8,}["']/i),
        ...grep(code, /AKIA[0-9A-Z]{16}/),
        ...grep(code, /-----BEGIN [A-Z ]*PRIVATE KEY-----/),
      ]),
  },
  {
    id: "CDX-002",
    title: "Pin dependencies and base images",
    severity: "medium",
    appliesTo: ["dockerfile", "ci-yaml", "kubernetes"],
    authoritative: true,
    standard:
      "Container images and CI actions must be pinned to a specific version or digest. Never use ':latest', an untagged image, or a moving branch such as @main.",
    check: (code, kind) =>
      dedupe([
        ...grep(code, /:latest\b/),
        ...grep(code, /\buses:\s*[\w.-]+\/[\w./-]+@(main|master|latest)\b/),
        ...(kind === "dockerfile"
          ? grep(code, /^\s*FROM\s+(?!scratch\b)[^\s:@]+(\s+AS\s+\S+)?\s*$/i)
          : []),
      ]),
  },
  {
    id: "CDX-003",
    title: "Containers run as non-root",
    severity: "high",
    appliesTo: ["dockerfile", "kubernetes"],
    authoritative: true,
    standard:
      "Containers must not run as root. Dockerfiles need a non-root USER; Kubernetes pods must set runAsNonRoot: true and never run privileged.",
    check: (code, kind) => {
      if (kind === "dockerfile") {
        const hasUser = /^\s*USER\s+(?!root\b)\S+/im.test(code);
        return hasUser ? [] : [{ line: 1, text: "No non-root USER instruction found" }];
      }
      const out = [...grep(code, /privileged:\s*true/), ...grep(code, /runAsUser:\s*0\b/)];
      if (!/runAsNonRoot:\s*true/.test(code)) out.push({ line: 1, text: "runAsNonRoot: true is not set" });
      return dedupe(out);
    },
  },
  {
    id: "CDX-004",
    title: "Timeouts on outbound calls",
    severity: "medium",
    appliesTo: ["typescript", "go", "shell"],
    authoritative: false,
    standard:
      "Every outbound network call needs an explicit timeout (and a retry policy where the call is idempotent). Default clients that wait forever are not allowed.",
    check: (code, kind) => {
      if (kind === "typescript") {
        const calls = grep(code, /\bfetch\(/).filter((e) => !/^(async\s+)?fetch\s*\(/.test(e.text));
        return calls.length && !/AbortSignal|signal\s*:/.test(code) ? calls.slice(0, 3) : [];
      }
      if (kind === "go") return grep(code, /\bhttp\.(Get|Post|Head|PostForm)\(|http\.DefaultClient/);
      return grep(code, /\bcurl\b/).filter((e) => !/--max-time|\s-m\s/.test(e.text));
    },
  },
  {
    id: "CDX-005",
    title: "Errors are handled, not swallowed",
    severity: "medium",
    appliesTo: ["typescript", "go", "shell"],
    authoritative: false,
    standard:
      "Errors must be handled, returned or logged with context. Empty catch blocks, discarded Go errors, and shell scripts without 'set -e' (ideally 'set -euo pipefail') are not allowed.",
    check: (code, kind) => {
      if (kind === "typescript")
        return dedupe([
          ...grepMultiline(code, /catch\s*(\([^)]*\))?\s*\{\s*\}/),
          ...grep(code, /\.catch\(\s*\(\s*\w*\s*\)\s*=>\s*\{\s*\}\s*\)/),
        ]);
      if (kind === "go") return dedupe([...grep(code, /,\s*_\s*(:=|=)\s/), ...grep(code, /^\s*_\s*=\s*err\b/)]);
      return /^\s*set\s+-[a-z]*e/m.test(code) ? [] : [{ line: 1, text: "Script does not enable 'set -e'" }];
    },
  },
  {
    id: "CDX-006",
    title: "Use structured logging",
    severity: "low",
    appliesTo: ["typescript", "go"],
    authoritative: true,
    standard:
      "Services log through the structured logger (JSON with fields), not console.log or fmt.Println, so logs can be queried and correlated.",
    check: (code, kind) =>
      kind === "typescript" ? grep(code, /\bconsole\.(log|debug)\(/) : grep(code, /\bfmt\.Print(f|ln)?\(/),
  },
  {
    id: "CDX-007",
    title: "Kubernetes workloads set resource limits",
    severity: "medium",
    appliesTo: ["kubernetes"],
    authoritative: true,
    standard: "Every workload container must declare resource requests and limits.",
    check: (code) =>
      /^\s*kind:\s*(Deployment|StatefulSet|DaemonSet|Job|CronJob|Pod)\b/m.test(code) && !/^\s*limits:/m.test(code)
        ? [{ line: 1, text: "No resources.limits found on the workload" }]
        : [],
  },
  {
    id: "CDX-008",
    title: "CI uses least-privilege tokens",
    severity: "high",
    appliesTo: ["ci-yaml"],
    authoritative: true,
    standard:
      "CI workflows must declare a minimal top-level 'permissions:' block. write-all is forbidden, and pull_request_target must not check out untrusted code.",
    check: (code) =>
      dedupe([
        ...(/^permissions:/m.test(code) ? [] : [{ line: 1, text: "No top-level permissions: block" }]),
        ...grep(code, /permissions:\s*write-all/),
        ...grep(code, /pull_request_target/),
      ]),
  },
  {
    id: "CDX-009",
    title: "Pipelines run tests",
    severity: "medium",
    appliesTo: ["ci-yaml"],
    authoritative: false,
    standard: "A CI pipeline must run the project's automated tests before anything is built, published or deployed.",
    check: (code) =>
      /\b(test|pytest|vitest|jest|go test)\b/i.test(code) ? [] : [{ line: 1, text: "No test command found in the pipeline" }],
  },
];

export function selectRules(kind: ArtifactKind): Rule[] {
  return CODEX_RULES.filter((r) => r.appliesTo === "any" || r.appliesTo.includes(kind));
}

export function scoreFrom(results: { severity: Severity; status: string }[]): number {
  const weight: Record<Severity, number> = { high: 25, medium: 12, low: 5 };
  const penalty = results
    .filter((r) => r.status === "fail")
    .reduce((sum, r) => sum + weight[r.severity], 0);
  return Math.max(0, 100 - penalty);
}
