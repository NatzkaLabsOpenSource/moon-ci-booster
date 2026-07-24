# moon - CI booster

A GitHub action for [moon](https://moonrepo.dev) that posts a failure summary when `moon ci` tasks fail. The comment includes the error message, the command that was run, and the error logs for each failed task, so you can diagnose failures without leaving the pull request.

When all tasks pass, the action does nothing.

## Installation

The action _must run after_ the `moon ci` command, and should run even when `moon ci` fails
(`if: success() || failure()`).

## Inputs

- `access-token` (`string`) - **Required.** A GitHub access token used to post comments on
  the pull request.
- `workspace-root` (`string`) - Root of the moon workspace (if running in a sub-directory).
  Defaults to working directory.
- `aggregate-threshold` (`string`) - When the number of failing tasks reaches this threshold, a
  single aggregate comment is posted instead of one comment per task, to keep the pull request
  readable when something is fundamentally broken. Defaults to `10`.

[Sharded CI jobs](https://moonrepo.dev/docs/guides/ci#parallelizing-tasks) are supported as the action will output a comment per task.

When a large number of tasks fail at once (for example when a broken `Cargo.toml` or workspace
config breaks everything), posting one comment per task makes the pull request unreadable. Once the
number of failures reaches `aggregate-threshold`, the action instead posts a single aggregate
comment summarizing all failures in a table. Switching between per-task and aggregate mode is handled
transparently: stale comments from the other mode are cleaned up on the next run.

## Outputs

- `comment-created` (`string`) - Whether a comment was created or updated on the pull request.
- `has-failures` (`string`) - `'true'` if any failing tasks were found.
- `aggregated` (`string`) - `'true'` if a single aggregate comment was posted instead of per-task
  comments.
- `report` (`string`) - The generated failure summary markdown.

## Example

Each failing task gets its own PR comment. An example looks like:

---

## :x: `a:make-error`

**Error:** Task a:make-error failed to run.

<details open><summary><strong>stderr</strong></summary>

```
make: *** No rule to make target 'build'. Stop.
```

</details>

---
