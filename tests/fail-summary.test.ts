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
    "INPUT_WORKSPACE-ROOT": "",
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

  test("console output contains collapsible blocks for all tasks", () => {
    expect(stripDebug(stdout)).toMatchSnapshot();
  });

  test("step summary is a lightweight table", () => {
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

describe("per-task PR comments", () => {
  let server: http.Server;
  let createdComments: string[];
  let stdout: string;

  beforeEach(async () => {
    createdComments = [];

    server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });

      if (req.url?.includes("/commits/") && req.url?.includes("/pulls")) {
        res.end(JSON.stringify([{ number: 42 }]));
      } else if (req.url?.includes("/issues/42/comments") && req.method === "GET") {
        res.end(JSON.stringify([]));
      } else if (req.url?.includes("/issues/42/comments") && req.method === "POST") {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          createdComments.push(JSON.parse(body).body);
          res.end(JSON.stringify({ id: createdComments.length }));
        });
        return;
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
        GITHUB_REPOSITORY: "test-owner/test-repo",
        GITHUB_API_URL: `http://127.0.0.1:${port}`,
      },
    })`node ${indexJs}`;

    stdout = result.stdout;
  });

  afterEach(() => {
    server.close();
  });

  test("creates one comment per failing task", () => {
    expect(createdComments).toHaveLength(3);
  });

  test("each comment contains the correct comment token", () => {
    expect(createdComments[0]).toContain("<!-- moon-ci-booster-c:make-error -->");
    expect(createdComments[1]).toContain("<!-- moon-ci-booster-b:make-error -->");
    expect(createdComments[2]).toContain("<!-- moon-ci-booster-a:make-error -->");
  });

  test("comments contain stderr but not stdout", () => {
    for (const comment of createdComments) {
      if (comment.includes("b:make-error")) {
        expect(comment).toContain("something went wrong in project b");
        expect(comment).not.toContain("Starting build");
        expect(comment).not.toContain("Compiling module B");
      }
    }
  });

  test("comment text matches snapshot", () => {
    expect(createdComments).toMatchSnapshot();
  });

  test("console output still contains collapsible blocks", () => {
    expect(stripDebug(stdout)).toMatchSnapshot();
  });
});

describe("stale comment deletion", () => {
  let server: http.Server;
  let deletedCommentIds: number[];

  beforeEach(async () => {
    deletedCommentIds = [];

    server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });

      if (req.url?.includes("/commits/") && req.url?.includes("/pulls")) {
        res.end(JSON.stringify([{ number: 42 }]));
      } else if (req.url?.includes("/issues/42/comments") && req.method === "GET") {
        res.end(
          JSON.stringify([
            { id: 100, body: "<!-- moon-ci-booster-c:make-error -->\nold failure" },
            { id: 101, body: "<!-- moon-ci-booster-old:gone-task -->\nstale failure" },
            { id: 102, body: "unrelated comment" },
          ]),
        );
      } else if (req.url?.includes("/issues/42/comments") && req.method === "POST") {
        req.on("data", () => {});
        req.on("end", () => {
          res.end(JSON.stringify({ id: 200 }));
        });
        return;
      } else if (req.url?.includes("/issues/comments/") && req.method === "PATCH") {
        req.on("data", () => {});
        req.on("end", () => {
          res.end(JSON.stringify({ id: 200 }));
        });
        return;
      } else if (req.url?.includes("/issues/comments/") && req.method === "DELETE") {
        const idMatch = req.url.match(/\/issues\/comments\/(\d+)/);
        if (idMatch) {
          deletedCommentIds.push(Number(idMatch[1]));
        }
        res.end(JSON.stringify({}));
      } else {
        res.end(JSON.stringify([]));
      }
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    const cwd = path.join(import.meta.dirname, "workspaces/failures");
    await $({
      cwd,
      env: {
        ...process.env,
        ...baseEnv(),
        GITHUB_REPOSITORY: "test-owner/test-repo",
        GITHUB_API_URL: `http://127.0.0.1:${port}`,
      },
    })`node ${indexJs}`;
  });

  afterEach(() => {
    server.close();
  });

  test("deletes stale comment but keeps active and unrelated ones", () => {
    expect(deletedCommentIds).toEqual([101]);
  });
});
