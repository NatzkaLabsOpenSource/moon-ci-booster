import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "execa";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

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
    "INPUT_JOB-ID": "",
    GITHUB_STEP_SUMMARY: summaryFile,
    GITHUB_OUTPUT: outputFile,
    GITHUB_WORKSPACE: "",
    GITHUB_REPOSITORY: "",
  };
}

describe("failures with default settings", () => {
  let stdout: string;

  beforeEach(async () => {
    const cwd = path.join(import.meta.dirname, "workspaces/failures");
    const result = await $({ cwd, env: { ...process.env, ...baseEnv() } })`node ${indexJs}`;
    stdout = result.stdout;
  });

  test("console output", () => {
    expect(stripDebug(stdout)).toMatchSnapshot();
  });

  test("comment text", () => {
    const summary = fs.readFileSync(summaryFile, "utf8");
    expect(summary).toMatchSnapshot();
  });

  test("outputs contain has-failures and report", () => {
    const output = fs.readFileSync(outputFile, "utf8");
    expect(output).toMatch(/has-failures<<.*\ntrue\n/);
    expect(output).toMatch(/report<<.*\n/);
  });

  test("ansi codes are stripped from error messages", () => {
    const summary = fs.readFileSync(summaryFile, "utf8");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching ANSI escape sequences
    expect(summary).not.toMatch(/\u001b/);
  });
});

describe("no failures", () => {
  let stdout: string;

  beforeEach(async () => {
    const cwd = path.join(import.meta.dirname, "workspaces/no-failures");
    const result = await $({ cwd, env: { ...process.env, ...baseEnv() } })`node ${indexJs}`;
    stdout = result.stdout;
  });

  test("console output", () => {
    expect(stripDebug(stdout)).toMatchSnapshot();
  });

  test("has-failures is false", () => {
    const output = fs.readFileSync(outputFile, "utf8");
    expect(output).toMatch(/has-failures<<.*\nfalse\n/);
  });
});

test("no report warns gracefully", async () => {
  const cwd = path.join(import.meta.dirname, "workspaces/no-report");
  const { stdout } = await $({ cwd, env: { ...process.env, ...baseEnv() } })`node ${indexJs}`;
  expect(stripDebug(stdout)).toMatchSnapshot();
});

describe("long logs without CI context", () => {
  let stdout: string;

  beforeEach(async () => {
    const cwd = path.join(import.meta.dirname, "workspaces/failures");
    const result = await $({
      cwd,
      env: { ...process.env, ...baseEnv(), "INPUT_MAX-LOG-LINES": "1" },
    })`node ${indexJs}`;
    stdout = result.stdout;
  });

  test("console output contains collapsible blocks", () => {
    expect(stripDebug(stdout)).toMatchSnapshot();
  });

  test("comment text excludes long logs", () => {
    const summary = fs.readFileSync(summaryFile, "utf8");
    expect(summary).toMatchSnapshot();
  });
});

describe("long logs with CI context", () => {
  let server: http.Server;
  let stdout: string;

  beforeEach(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url?.includes("/actions/runs/") && req.url?.includes("/jobs")) {
        res.end(
          JSON.stringify({
            total_count: 1,
            jobs: [
              {
                id: 456,
                name: "test-job",
                status: "in_progress",
                steps: [{ number: 3, status: "in_progress", name: "Run tests" }],
              },
            ],
          }),
        );
      } else {
        res.end(JSON.stringify([]));
      }
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    const cwd = path.join(import.meta.dirname, "workspaces/failures");
    const result = await $({
      cwd,
      env: {
        ...process.env,
        ...baseEnv(),
        "INPUT_MAX-LOG-LINES": "1",
        GITHUB_REPOSITORY: "test-owner/test-repo",
        GITHUB_RUN_ID: "123",
        GITHUB_JOB: "test-job",
        GITHUB_API_URL: `http://127.0.0.1:${port}`,
        GITHUB_SERVER_URL: "https://github.com",
      },
    })`node ${indexJs}`;

    stdout = result.stdout;
  });

  afterEach(() => {
    server.close();
  });

  test("console output contains collapsible blocks", () => {
    expect(stripDebug(stdout)).toMatchSnapshot();
  });

  test("comment text includes deep links", () => {
    const summary = fs.readFileSync(summaryFile, "utf8");
    expect(summary).toMatchSnapshot();
  });
});
