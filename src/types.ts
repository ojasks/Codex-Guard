import type { ArtifactKind, Evidence, Severity } from "./codex";

export type Status = "pass" | "fail" | "review" | "waived";

export interface RuleResult {
  ruleId: string;
  title: string;
  severity: Severity;
  status: Status;
  explanation: string;
  fix: string;
  evidence: Evidence[];
}

export interface ReviewReport {
  reviewId: string;
  filename: string;
  kind: ArtifactKind;
  score: number;
  summary: string;
  results: RuleResult[];
  createdAt: number;
}

export interface Waiver {
  ruleId: string;
  reason: string;
  at: number;
}

export interface StepProgress {
  step: string;
  status: "pending" | "running" | "complete" | "error";
  message?: string;
}

/** Synced to every connected client automatically by the Agents SDK. */
export interface CodexState {
  profile: { team: string; stack: string };
  waivers: Waiver[];
  reviewsRun: number;
  active: null | { reviewId: string; filename: string; steps: StepProgress[] };
}

/** What the agent hands to the workflow. */
export interface ReviewParams {
  reviewId: string;
  filename: string;
  code: string;
  waivedRuleIds: string[];
}
