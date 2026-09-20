import { test } from "node:test";
import assert from "node:assert/strict";
import { CODEX_RULES, detectKind, scoreFrom, selectRules } from "../src/codex.ts";

const rule = (id: string) => {
  const r = CODEX_RULES.find((x) => x.id === id);
  if (!r) throw new Error(`missing rule ${id}`);
  return r;
};

test("detectKind uses filename first, then content", () => {
  assert.equal(detectKind("Dockerfile", ""), "dockerfile");
  assert.equal(detectKind("worker.ts", ""), "typescript");
  assert.equal(detectKind("main.go", ""), "go");
  assert.equal(detectKind("deploy.sh", ""), "shell");
  assert.equal(detectKind("app.yaml", "apiVersion: apps/v1\nkind: Deployment"), "kubernetes");
  assert.equal(detectKind("ci.yml", "on: push\njobs:\n  build:"), "ci-yaml");
  assert.equal(detectKind("snippet.txt", "FROM node\nRUN npm ci"), "dockerfile");
});

test("CDX-001 flags hard-coded secrets but not env lookups", () => {
  const bad = rule("CDX-001").check('const apiKey = "sk_live_abcdef123456";', "typescript");
  assert.equal(bad.length, 1);
  assert.equal(bad[0]?.line, 1);
  assert.equal(rule("CDX-001").check("const apiKey = env.API_KEY;", "typescript").length, 0);
  // prefixed names such as API_TOKEN / DB_PASSWORD must be caught too
  assert.equal(rule("CDX-001").check('ENV API_TOKEN="sk_live_51Hxample0123456789"', "dockerfile").length, 1);
  assert.equal(rule("CDX-001").check("DB_PASSWORD: 'hunter2hunter2'", "ci-yaml").length, 1);
  assert.equal(rule("CDX-001").check("token: ${{ secrets.GITHUB_TOKEN }}", "ci-yaml").length, 0);
});

test("CDX-002 flags :latest, untagged FROM and @main actions", () => {
  const docker = rule("CDX-002").check("FROM node:latest\nFROM alpine\nFROM node:22.4-slim", "dockerfile");
  assert.deepEqual(docker.map((e) => e.line), [1, 2]);
  const ci = rule("CDX-002").check("      - uses: actions/checkout@main\n      - uses: actions/setup-node@v4", "ci-yaml");
  assert.deepEqual(ci.map((e) => e.line), [1]);
});

test("CDX-003 wants a non-root USER in Dockerfiles", () => {
  assert.equal(rule("CDX-003").check("FROM node:22\nCMD node app.js", "dockerfile").length, 1);
  assert.equal(rule("CDX-003").check("FROM node:22\nUSER node\nCMD node app.js", "dockerfile").length, 0);
});

test("CDX-005 catches empty catch blocks and missing set -e", () => {
  assert.equal(rule("CDX-005").check("try { x() } catch (e) {}", "typescript").length, 1);
  assert.equal(rule("CDX-005").check("try { x() } catch (e) { log(e) }", "typescript").length, 0);
  assert.equal(rule("CDX-005").check("#!/bin/bash\necho hi", "shell").length, 1);
  assert.equal(rule("CDX-005").check("#!/bin/bash\nset -euo pipefail\necho hi", "shell").length, 0);
});

test("CDX-008 requires a permissions block in CI", () => {
  assert.equal(rule("CDX-008").check("on: push\njobs: {}", "ci-yaml").length, 1);
  assert.equal(rule("CDX-008").check("on: push\npermissions:\n  contents: read\njobs: {}", "ci-yaml").length, 0);
});

test("selectRules only returns rules that apply to the artifact kind", () => {
  const ids = selectRules("dockerfile").map((r) => r.id);
  assert.ok(ids.includes("CDX-001") && ids.includes("CDX-002") && ids.includes("CDX-003"));
  assert.ok(!ids.includes("CDX-008"));
  assert.deepEqual(selectRules("other").map((r) => r.id), ["CDX-001"]);
});

test("scoreFrom weights by severity and never goes below zero", () => {
  assert.equal(scoreFrom([{ severity: "high", status: "fail" }, { severity: "low", status: "fail" }]), 70);
  assert.equal(scoreFrom([{ severity: "high", status: "waived" }]), 100);
  assert.equal(scoreFrom(Array(10).fill({ severity: "high", status: "fail" })), 0);
});
