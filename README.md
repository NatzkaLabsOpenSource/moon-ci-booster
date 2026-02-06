# moon - CI booster

A GitHub action for [moon](https://moonrepo.dev) that posts a failure summary when `moon ci` tasks fail. The comment includes the error message, the command that was run, and the stdout/stderr logs for each failed task, so you can diagnose failures without leaving the pull request.

When all tasks pass, the action does nothing.

## Installation

The action _must run after_ the `moon ci` command, and should run even when `moon ci` fails
(`if: success() || failure()`).

## Inputs

- `access-token` (`string`) - **Required.** A GitHub access token used to post comments on
  the pull request.
- `max-log-lines` (`number`) - Maximum number of log lines to include inline per task per
  stream (stdout/stderr). Logs exceeding this are printed to the CI console with a deep-link
  in the PR comment. Set to `0` to always link, never inline. Defaults to `200`.
- `workspace-root` (`string`) - Root of the moon workspace (if running in a sub-directory).
  Defaults to working directory.
- `job-id` (`string`) - Numeric job ID for accurate deep-linking in matrix builds. Pass
  `${{ job.check_run_id }}`. When provided, each matrix job gets its own comment and deep
  links point to the correct job. Omit for non-matrix workflows.

## Outputs

- `comment-created` (`string`) - Whether a comment was created or updated on the pull request.
- `has-failures` (`string`) - `'true'` if any failing tasks were found.
- `report` (`string`) - The generated failure summary markdown.

## Example

An example of the failure summary comment looks like the following:

---

### :x: Moon CI Failure Summary

**3 tasks failed**

#### `a:make-error`

**Error:** Task a:make-error failed to run.

**Command:** `make build`

<details><summary><strong>stderr</strong></summary>

```
make: *** No rule to make target 'build'. Stop.
```

</details>

<details><summary><strong>stdout</strong></summary>

```
Building project a...
```

</details>

---

#### `b:make-error`

**Error:** Task b:make-error failed to run.

<details><summary><strong>stderr</strong></summary>

```
make: *** No rule to make target 'build'. Stop.
```

</details>

---
