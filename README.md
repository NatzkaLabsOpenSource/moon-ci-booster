# moon - CI booster

A GitHub action for [moon](https://moonrepo.dev) that posts a failure summary when `moon ci` tasks fail. The comment includes the error message, the command that was run, and the stderr logs for each failed task, so you can diagnose failures without leaving the pull request.

When all tasks pass, the action does nothing.

## Installation

The action _must run after_ the `moon ci` command, and should run even when `moon ci` fails
(`if: success() || failure()`).

## Inputs

- `access-token` (`string`) - **Required.** A GitHub access token used to post comments on
  the pull request.
- `workspace-root` (`string`) - Root of the moon workspace (if running in a sub-directory).
  Defaults to working directory.

[Sharded CI jobs](https://moonrepo.dev/docs/guides/ci#parallelizing-tasks) are supported as the action will output a comment per task.

## Outputs

- `comment-created` (`string`) - Whether a comment was created or updated on the pull request.
- `has-failures` (`string`) - `'true'` if any failing tasks were found.
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
