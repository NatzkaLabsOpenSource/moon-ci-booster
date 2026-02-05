import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import * as core from "@actions/core";
import * as github from "@actions/github";

import type { Action, ActionNodeRunTask, ActionStatus, OperationMetaTaskExecution, RunReport } from "@moonrepo/types";

// --- Report loading ---

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadReport(workspaceRoot: string): Promise<RunReport | null> {
  for (const fileName of ["ciReport.json", "runReport.json"]) {
    const reportPath = path.join(workspaceRoot, ".moon/cache", fileName);
    core.debug(`Finding run report at ${reportPath}`);
    if (await fileExists(reportPath)) {
      core.debug("Found!");
      const content = await readFile(reportPath, { encoding: "utf8" });
      return JSON.parse(content) as RunReport;
    }
  }
  return null;
}

// --- Target parsing & log reading ---

interface TargetIdentity {
  project: string;
  task: string;
}

function encodeComponent(component: string): string {
  let encoded = component.replaceAll("/", "-");
  encoded = encoded.replace(/[.-]+$/, "");
  encoded = encoded.replace(/^[.-]+/, "");
  return encoded;
}

function parseTarget(target: string): TargetIdentity {
  const parts = target.split(":");
  return {
    project: parts[0] ?? "unknown",
    task: parts[1] ?? "unknown",
  };
}

function commandOf(action: Action): string | null {
  for (const operation of action.operations) {
    if (operation.meta.type === "task-execution") {
      return (operation.meta as OperationMetaTaskExecution).command ?? null;
    }
  }
  return null;
}

async function readTaskLogs(
  workspaceRoot: string,
  { project, task }: TargetIdentity,
): Promise<{ stdout: string; stderr: string }> {
  const statusDir = path.join(workspaceRoot, ".moon/cache/states", encodeComponent(project), encodeComponent(task));

  const stdoutPath = path.join(statusDir, "stdout.log");
  const stderrPath = path.join(statusDir, "stderr.log");

  const stdout = (await fileExists(stdoutPath)) ? await readFile(stdoutPath, { encoding: "utf8" }) : "";
  const stderr = (await fileExists(stderrPath)) ? await readFile(stderrPath, { encoding: "utf8" }) : "";

  return { stdout, stderr };
}

// --- Failure filtering ---

const FAILURE_STATUSES = new Set<ActionStatus>(["failed", "failed-and-abort"]);

function isFailedTask(action: Action): action is Action & { node: ActionNodeRunTask } {
  return action.node.action === "run-task" && FAILURE_STATUSES.has(action.status);
}

// --- Formatting helpers ---

function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching ANSI escape sequences
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function truncateLog(log: string, maxLines: number): string {
  const lines = log.split("\n");
  if (lines.length <= maxLines) {
    return log;
  }
  return "";
}

// --- CI log deep-linking ---

interface CILinkContext {
  serverUrl: string;
  repository: string;
  runId: number;
  jobId: number;
  stepNumber: number;
  prNumber: number | undefined;
}

type Octokit = ReturnType<typeof github.getOctokit>;

async function resolveCILinkContext(octokit: Octokit): Promise<CILinkContext | null> {
  const { runId, serverUrl, payload, repo, job: jobKey } = github.context;

  if (!runId || !jobKey) {
    core.debug("Missing GITHUB_RUN_ID or GITHUB_JOB, skipping CI link resolution");
    return null;
  }

  try {
    const { data } = await octokit.rest.actions.listJobsForWorkflowRun({
      ...repo,
      run_id: runId,
      filter: "latest",
    });

    const job = data.jobs.find((j) => j.status === "in_progress" && j.name.startsWith(jobKey));

    if (!job) {
      core.debug(`Could not find in_progress job matching "${jobKey}" among ${data.jobs.length} jobs`);
      return null;
    }

    const step = job.steps?.find((s) => s.status === "in_progress");
    if (!step?.number) {
      core.debug("Could not find in_progress step");
      return null;
    }

    return {
      serverUrl,
      repository: `${repo.owner}/${repo.repo}`,
      runId,
      jobId: job.id,
      stepNumber: step.number,
      prNumber: payload.pull_request?.number,
    };
  } catch (error) {
    core.debug(`Failed to resolve CI link context: ${error}`);
    return null;
  }
}

function buildLogDeepLink(ctx: CILinkContext, lineNumber: number): string {
  const base = `${ctx.serverUrl}/${ctx.repository}/actions/runs/${ctx.runId}/job/${ctx.jobId}`;
  const query = ctx.prNumber ? `?pr=${ctx.prNumber}` : "";
  return `${base}${query}#step:${ctx.stepNumber}:${lineNumber}`;
}

type LogLinkMap = Map<string, { stderrLine?: number; stdoutLine?: number }>;

function emitFullLogsToConsole(failures: FailedTaskInfo[], maxLogLines: number): LogLinkMap {
  const linkMap: LogLinkMap = new Map();
  let currentLine = 1;

  for (const failure of failures) {
    const stderrTrimmed = failure.stderr.trim();
    const stdoutTrimmed = failure.stdout.trim();

    const stderrTooLong = stderrTrimmed !== "" && stderrTrimmed.split("\n").length > maxLogLines;
    const stdoutTooLong = stdoutTrimmed !== "" && stdoutTrimmed.split("\n").length > maxLogLines;

    if (!stderrTooLong && !stdoutTooLong) {
      continue;
    }

    const links: { stderrLine?: number; stdoutLine?: number } = {};

    if (stderrTooLong) {
      core.startGroup(`Full stderr for ${failure.target}`);
      currentLine++;

      links.stderrLine = currentLine;
      core.info(stripAnsi(stderrTrimmed));
      currentLine += stderrTrimmed.split("\n").length;

      core.endGroup();
      currentLine++;
    }

    if (stdoutTooLong) {
      core.startGroup(`Full stdout for ${failure.target}`);
      currentLine++;

      links.stdoutLine = currentLine;
      core.info(stripAnsi(stdoutTrimmed));
      currentLine += stdoutTrimmed.split("\n").length;

      core.endGroup();
      currentLine++;
    }

    linkMap.set(failure.target, links);
  }

  return linkMap;
}

// --- Markdown generation ---

interface FailedTaskInfo {
  target: string;
  error: string | null;
  command: string | null;
  stdout: string;
  stderr: string;
}

function commentToken(index: number): string {
  return `<!-- moon-ci-booster-${index} -->`;
}
const GITHUB_COMMENT_MAX_SIZE = 65536;

function formatFailureSummary(
  failures: FailedTaskInfo[],
  maxLogLines: number,
  linkMap: LogLinkMap,
  ciCtx: CILinkContext | null,
  index: number,
): string {
  const lines: string[] = [
    commentToken(index),
    "",
    "## :x: Moon CI Failure Summary",
    "",
    `**${failures.length} task${failures.length === 1 ? "" : "s"} failed**`,
    "",
  ];

  for (const failure of failures) {
    lines.push(`### \`${failure.target}\``);
    lines.push("");

    if (failure.error) {
      lines.push(`**Error:** ${stripAnsi(failure.error)}`);
      lines.push("");
    }

    if (failure.command) {
      lines.push(`**Command:** \`${failure.command}\``);
      lines.push("");
    }

    const truncatedStderr = truncateLog(failure.stderr.trim(), maxLogLines);
    const truncatedStdout = truncateLog(failure.stdout.trim(), maxLogLines);
    const links = linkMap.get(failure.target);

    if (truncatedStderr !== "") {
      lines.push(
        "<details><summary><strong>stderr</strong></summary>",
        "",
        "```",
        truncatedStderr,
        "```",
        "",
        "</details>",
        "",
      );
    } else if (failure.stderr.trim() !== "" && links?.stderrLine != null && ciCtx) {
      const url = buildLogDeepLink(ciCtx, links.stderrLine);
      lines.push(`**stderr:** [View full log in CI output](${url})`, "");
    }

    if (truncatedStdout !== "") {
      lines.push(
        "<details><summary><strong>stdout</strong></summary>",
        "",
        "```",
        truncatedStdout,
        "```",
        "",
        "</details>",
        "",
      );
    } else if (failure.stdout.trim() !== "" && links?.stdoutLine != null && ciCtx) {
      const url = buildLogDeepLink(ciCtx, links.stdoutLine);
      lines.push(`**stdout:** [View full log in CI output](${url})`, "");
    }

    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}

function enforceCommentSizeLimit(markdown: string): string {
  if (markdown.length <= GITHUB_COMMENT_MAX_SIZE) {
    return markdown;
  }
  const truncationNotice = "\n\n> **Note:** Output was truncated to fit within GitHub comment size limits.\n";
  const budget = GITHUB_COMMENT_MAX_SIZE - truncationNotice.length;
  return markdown.slice(0, budget) + truncationNotice;
}

// --- PR commenting ---

async function postComment(octokit: Octokit, markdown: string, index: number): Promise<void> {
  const {
    payload: { pull_request: pr, issue },
    repo,
  } = github.context;

  let id = pr?.number ?? issue?.number;

  if (!id) {
    core.debug("No pull request or issue found from context, trying to find pull requests associated with commit");
    const { data: pullRequests } = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
      ...repo,
      commit_sha: github.context.sha,
    });
    id = pullRequests[0]?.number;
  }

  if (!id) {
    core.warning("No pull request or issue found, will not add a comment.");
    return;
  }

  const { data: comments } = await octokit.rest.issues.listComments({
    ...repo,
    issue_number: id,
  });

  const token = commentToken(index);
  const existingComment = comments.find((comment) => comment.body?.includes(token));

  if (existingComment) {
    core.debug(`Updating existing comment #${existingComment.id}`);
    await octokit.rest.issues.updateComment({
      ...repo,
      body: markdown,
      comment_id: existingComment.id,
    });
  } else {
    core.debug("Creating a new comment");
    await octokit.rest.issues.createComment({
      ...repo,
      body: markdown,
      issue_number: id,
    });
  }
}

// --- Main ---

async function main(): Promise<void> {
  const accessToken = core.getInput("access-token");
  // biome-ignore lint/complexity/useLiteralKeys: TS strict requires bracket notation for index signatures
  const workspaceRoot = core.getInput("workspace-root") || process.env["GITHUB_WORKSPACE"] || process.cwd();
  const maxLogLines = Number(core.getInput("max-log-lines") || "200");
  const index = Number(core.getInput("index") || "1");
  core.debug(`Using workspace root ${workspaceRoot}`);

  if (!accessToken) {
    throw new Error("An `access-token` input is required.");
  }

  const report = await loadReport(workspaceRoot);
  if (!report) {
    core.warning("Run report does not exist, has `moon ci` or `moon run` ran?");
    core.setOutput("has-failures", "false");
    core.setOutput("comment-created", "false");
    return;
  }

  const failedActions = report.actions.filter(isFailedTask);

  if (failedActions.length === 0) {
    core.info("No failing tasks found.");
    core.setOutput("has-failures", "false");
    core.setOutput("comment-created", "false");
    return;
  }

  core.setOutput("has-failures", "true");

  const failures: FailedTaskInfo[] = [];
  for (const action of failedActions) {
    const target = action.node.params.target;
    const identity = parseTarget(target);
    const { stdout, stderr } = await readTaskLogs(workspaceRoot, identity);

    failures.push({
      target: `${identity.project}:${identity.task}`,
      error: action.error ?? null,
      command: commandOf(action),
      stdout,
      stderr,
    });
  }

  // biome-ignore lint/complexity/useLiteralKeys: TS strict requires bracket notation for index signatures
  const inCI = !!process.env["GITHUB_REPOSITORY"];
  const octokit = inCI ? github.getOctokit(accessToken) : null;

  let ciCtx: CILinkContext | null = null;
  if (octokit) {
    ciCtx = await resolveCILinkContext(octokit);
    if (ciCtx) {
      core.debug(`Resolved CI link context: job=${ciCtx.jobId}, step=${ciCtx.stepNumber}`);
    }
  }

  const linkMap = emitFullLogsToConsole(failures, maxLogLines);
  const markdown = enforceCommentSizeLimit(formatFailureSummary(failures, maxLogLines, linkMap, ciCtx, index));
  core.setOutput("report", markdown);
  core.info(markdown);

  if (octokit) {
    try {
      await postComment(octokit, markdown, index);
      core.setOutput("comment-created", "true");
    } catch (error: unknown) {
      core.warning(String(error));
      core.notice("\nFailed to create comment on pull request. Perhaps this is ran in a fork?\n");
      core.setOutput("comment-created", "false");
    }
  } else {
    core.debug("No GITHUB_REPOSITORY set, skipping PR comment");
    core.setOutput("comment-created", "false");
  }

  await core.summary.addRaw(markdown).write();
}

try {
  await main();
} catch (error) {
  core.setFailed(error instanceof Error ? error.message : String(error));
}
