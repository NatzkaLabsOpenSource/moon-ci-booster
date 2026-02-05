import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "execa";
import { afterEach, beforeEach, expect, test } from "vitest";

const indexJs = path.resolve("dist/index.js");

let tempDir: string;
let summaryFile: string;
let outputFile: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fail-summary-test-"));
  summaryFile = path.join(tempDir, "summary.md");
  outputFile = path.join(tempDir, "output.txt");
  fs.writeFileSync(summaryFile, "");
  fs.writeFileSync(outputFile, "");
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function stripDebug(output: string): string {
  return output
    .split("\n")
    .filter((line) => !line.startsWith("::debug::"))
    .join("\n");
}

function baseEnv() {
  return {
    "INPUT_ACCESS-TOKEN": "fake-token-for-tests",
    "INPUT_MAX-LOG-LINES": "200",
    "INPUT_WORKSPACE-ROOT": "",
    GITHUB_STEP_SUMMARY: summaryFile,
    GITHUB_OUTPUT: outputFile,
    GITHUB_WORKSPACE: "",
    GITHUB_REPOSITORY: "",
  };
}

test("reports failures with logs", async () => {
  const cwd = path.join(import.meta.dirname, "workspaces/failures");
  const { stdout } = await $({ cwd, env: { ...process.env, ...baseEnv() } })`node ${indexJs}`;
  expect(stripDebug(stdout)).toMatchSnapshot();

  const summary = fs.readFileSync(summaryFile, "utf8");
  expect(summary).toContain("Moon CI Failure Summary");
  expect(summary).toContain("c:make-error");
  expect(summary).toContain("b:make-error");
  expect(summary).toContain("a:make-error");
});

test("no failures produces info message", async () => {
  const cwd = path.join(import.meta.dirname, "workspaces/no-failures");
  const { stdout } = await $({ cwd, env: { ...process.env, ...baseEnv() } })`node ${indexJs}`;
  expect(stripDebug(stdout)).toMatchSnapshot();
});

test("no report warns gracefully", async () => {
  const cwd = path.join(import.meta.dirname, "workspaces/no-report");
  const { stdout } = await $({ cwd, env: { ...process.env, ...baseEnv() } })`node ${indexJs}`;
  expect(stripDebug(stdout)).toMatchSnapshot();
});

test("outputs contain has-failures and report", async () => {
  const cwd = path.join(import.meta.dirname, "workspaces/failures");
  await $({ cwd, env: { ...process.env, ...baseEnv() } })`node ${indexJs}`;

  const output = fs.readFileSync(outputFile, "utf8");
  expect(output).toMatch(/has-failures<<.*\ntrue\n/);
  expect(output).toMatch(/report<<.*\n/);
});

test("no failures sets has-failures to false", async () => {
  const cwd = path.join(import.meta.dirname, "workspaces/no-failures");
  await $({ cwd, env: { ...process.env, ...baseEnv() } })`node ${indexJs}`;

  const output = fs.readFileSync(outputFile, "utf8");
  expect(output).toMatch(/has-failures<<.*\nfalse\n/);
});

test("stderr is included in summary", async () => {
  const cwd = path.join(import.meta.dirname, "workspaces/failures");
  await $({ cwd, env: { ...process.env, ...baseEnv() } })`node ${indexJs}`;

  const summary = fs.readFileSync(summaryFile, "utf8");
  expect(summary).toContain("This is an error message");
  expect(summary).toContain("Error: something went wrong in project b");
});

test("stdout is included when present", async () => {
  const cwd = path.join(import.meta.dirname, "workspaces/failures");
  await $({ cwd, env: { ...process.env, ...baseEnv() } })`node ${indexJs}`;

  const summary = fs.readFileSync(summaryFile, "utf8");
  expect(summary).toContain("Starting build...");
  expect(summary).toContain("Compiling module B...");
});

test("logs exceeding max-log-lines are excluded from summary but printed to console", async () => {
  const cwd = path.join(import.meta.dirname, "workspaces/failures");
  const { stdout } = await $({
    cwd,
    env: { ...process.env, ...baseEnv(), "INPUT_MAX-LOG-LINES": "1" },
  })`node ${indexJs}`;

  const summary = fs.readFileSync(summaryFile, "utf8");
  // b:make-error stdout has 2 lines, so it should be excluded from the summary
  expect(summary).not.toContain("Starting build...");
  expect(summary).not.toContain("Compiling module B...");
  // single-line logs should still be included inline
  expect(summary).toContain("This is an error message");

  // full logs should appear in console output inside groups
  expect(stdout).toContain("::group::Full stdout for b:make-error");
  expect(stdout).toContain("Starting build...");
  expect(stdout).toContain("Compiling module B...");
  expect(stdout).toContain("::endgroup::");
});

test("no deep-links without CI environment", async () => {
  const cwd = path.join(import.meta.dirname, "workspaces/failures");
  const { stdout } = await $({
    cwd,
    env: { ...process.env, ...baseEnv(), "INPUT_MAX-LOG-LINES": "1" },
  })`node ${indexJs}`;

  // without GITHUB_RUN_ID / GITHUB_JOB, no deep-links should be generated
  expect(stdout).not.toContain("View full log in CI output");

  const summary = fs.readFileSync(summaryFile, "utf8");
  expect(summary).not.toContain("View full log in CI output");
});

test("index input produces shard-specific comment token", async () => {
  const cwd = path.join(import.meta.dirname, "workspaces/failures");

  const { stdout: stdout1 } = await $({ cwd, env: { ...process.env, ...baseEnv() } })`node ${indexJs}`;
  expect(stdout1).toContain("<!-- moon-ci-booster-1 -->");

  const { stdout: stdout2 } = await $({
    cwd,
    env: { ...process.env, ...baseEnv(), INPUT_INDEX: "2" },
  })`node ${indexJs}`;
  expect(stdout2).toContain("<!-- moon-ci-booster-2 -->");
});

test("ansi codes are stripped from error messages", async () => {
  const cwd = path.join(import.meta.dirname, "workspaces/failures");
  await $({ cwd, env: { ...process.env, ...baseEnv() } })`node ${indexJs}`;

  const summary = fs.readFileSync(summaryFile, "utf8");
  // The ciReport.json has ANSI codes in error messages like \u001b[38;5;39m
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching ANSI escape sequences
  expect(summary).not.toMatch(/\u001b/);
});
