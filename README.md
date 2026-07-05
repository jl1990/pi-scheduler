# Pi Scheduler

**Scheduled actions for Pi agents: reminders, self-waking prompts, recurring shell commands, and command-output follow-ups.**

Pi Scheduler is a [Pi](https://github.com/earendil-works/pi) extension that lets an agent schedule future work from inside the conversation. It focuses on **scheduled actions**, not just prompts: the agent can wake itself later, run shell commands directly, capture stdout/stderr, and decide what to do next.

## Why?

Coding agents often need to wait:

- A GitLab/GitHub pipeline is still running.
- A deployment needs a few minutes to roll out.
- A long build or test command should be checked later.
- You want a reminder or a recurring project check.

Without scheduling, the agent has to stop and hope you come back. With Pi Scheduler, it can schedule follow-up work such as:

> “Run `glab pipeline view` every 5 minutes, wake me only on failure, and stop after 10 checks.”

## Features

- **Self-waking prompts** — schedule a future prompt that wakes the agent in the current Pi session.
- **Direct shell scheduling** — run commands later or repeatedly without first asking the model to call `bash`.
- **Command-output follow-ups** — feed stdout/stderr back to the agent with success/failure-specific instructions.
- **Recurring schedules** — `once`, `interval`, and `cron` schedules for all action types.
- **Bounded polling** — `maxRuns` disables recurring tasks after a fixed number of executions.
- **Task lifecycle management** — enable, disable, update, remove, cleanup, list.
- **Scopes** — bind tasks to a session, cwd/project, or all sessions.
- **Compact widget** — shows the next few scheduled actions below the editor.
- **Persistent state** — scheduled tasks are stored in `~/.pi/agent/state/scheduler/tasks.json`.

## Install

Install from npm:

```bash
pi install npm:@jl1990/pi-scheduler
```

Or install directly from GitHub:

```bash
pi install git:git@github.com:jl1990/pi-scheduler.git
```

Then restart Pi, or run:

```text
/reload
```

## Agent tools

Pi Scheduler registers these tools for the agent:

- `schedule_task` — schedule a future or recurring action.
- `list_scheduled_tasks` — list active or historical tasks.
- `cancel_scheduled_task` — cancel a task by ID or prefix.
- `manage_scheduled_task` — enable, disable, remove, update, or cleanup tasks.

### Scheduled action types

| Action | What it does | Best for |
| --- | --- | --- |
| `shell` | Runs a shell command and stores stdout/stderr | CI polling, tests, status commands |
| `prompt` | Injects a user prompt and wakes the agent | Agentic follow-ups |
| `notify` | Shows a reminder/notification | Human reminders |
| `message` | Injects a scheduled custom message | Lightweight status/context messages |

### Schedule types

| Type | Example | Meaning |
| --- | --- | --- |
| `once` | `5m`, `tomorrow at 9am`, ISO datetime | Run one time |
| `interval` | `5m`, `1h`, `30s` | Run repeatedly after each interval |
| `cron` | `0 */5 * * * *` | Run on a cron schedule via `croner` |

Cron expressions use `croner`; 6-field expressions with seconds are recommended:

```text
0 */5 * * * *   every 5 minutes
0 0 * * * *     hourly
0 0 9 * * 1-5   weekdays at 9am
```

## Example: bounded GitLab pipeline polling

Schedule a direct command every 5 minutes, wake the agent only if it fails, and stop after 10 checks:

```json
{
  "action": "shell",
  "type": "interval",
  "schedule": "5m",
  "name": "pipeline-123",
  "command": "glab pipeline view 123 --repo jl1990/example",
  "wakeOn": "failure",
  "failurePrompt": "The scheduled pipeline check failed or returned a non-zero status. Inspect the pipeline/jobs/logs and propose or apply fixes.",
  "maxRuns": 10,
  "scope": "cwd"
}
```

## Example: recurring agent prompt

```json
{
  "action": "prompt",
  "type": "interval",
  "schedule": "10m",
  "prompt": "Check whether the deployment has finished. If it failed, inspect logs. If it is still running, continue monitoring.",
  "maxRuns": 6
}
```

## Example: one-shot command with output review

```json
{
  "action": "shell",
  "type": "once",
  "schedule": "2m",
  "command": "npm test",
  "wakeOn": "always",
  "followUpPrompt": "Review this test output. If tests failed, fix the issue. If they passed, summarize the result."
}
```

## Slash commands

```text
/schedule [notify|prompt|shell|message] [once|interval|cron|every] <schedule> :: <payload>
/remind <when> <message>
/schedules
/schedules all
/schedule-cancel <id-or-prefix>
/schedule-enable <id-or-prefix>
/schedule-disable <id-or-prefix>
/schedule-remove <id-or-prefix>
/schedule-cleanup
/schedule-widget [on|off]
```

Examples:

```text
/remind 5m stretch
/schedule prompt 3m :: Check the GitLab pipeline and schedule another check if still running.
/schedule shell every 5m :: glab pipeline view 123 --repo jl1990/example
/schedule shell cron 0 */5 * * * * :: date
/schedules
/schedules all
/schedule-disable task_abc123
/schedule-cleanup
```

## Time formats

One-shot schedules support examples like:

```text
5m
+5m
in 10 minutes
1h30m
2 days
tomorrow at 9am
14:30
2026-07-06T10:00:00
```

Interval schedules use durations like:

```text
30s
5m
1h
2d
```

## Scopes

`scope` controls where a task is visible and allowed to fire:

| Scope | Behavior |
| --- | --- |
| `session` | Default. Bound to the Pi session that created it. |
| `cwd` | Visible to Pi sessions in the same working directory. Good for project automation. |
| `global` | Visible from any Pi session. |

## Wake behavior for shell tasks

Shell tasks can control when the parent agent is woken:

| `wakeOn` | Behavior |
| --- | --- |
| `always` | Wake after every run if a prompt is configured. |
| `failure` | Wake only when the command exits non-zero or is killed/timed out. |
| `success` | Wake only on exit code 0. |
| `never` | Never wake the agent; just record the result. |

Prompt priority:

1. `successPrompt` on success
2. `failurePrompt` on failure
3. `followUpPrompt` fallback

## How this differs from `pi-schedule-prompt`

[`pi-schedule-prompt`](https://github.com/tintinweb/pi-schedule-prompt) is a mature prompt scheduler with a richer prompt-focused UI and optional per-task model/subagent mode.

Pi Scheduler focuses on **scheduled actions**:

- direct scheduled shell commands
- deterministic stdout/stderr capture
- success/failure-specific agent wakeups
- bounded command polling with `maxRuns`
- prompt/notify/message actions as lightweight companions

If you mainly want recurring prompts and a full jobs overlay, `pi-schedule-prompt` may be the better fit. If you want delayed or recurring command execution with result-aware follow-up, use Pi Scheduler.

## Important limitations

Pi Scheduler currently uses **in-process timers**:

- If Pi is running, tasks fire at the scheduled time.
- If Pi is closed, tasks do not fire while Pi is closed.
- Pending/missed tasks are loaded again when the relevant Pi session starts, and due tasks fire then.

This is enough for live agent workflows like CI polling while a Pi session is open. A future version could add OS-level `cron`, `at`, launchd, systemd, or a small daemon for exact wakeups while Pi is not running.

## Development

Run tests:

```bash
npm test
```

Check what will be published to npm:

```bash
npm pack --dry-run
```

Load-check the extension locally:

```bash
PI_OFFLINE=1 pi --no-extensions -e ./extensions/scheduler/index.ts --list-models __unlikely_model_filter__
```

Try a command without starting a model turn:

```bash
PI_OFFLINE=1 pi --no-extensions -e ./extensions/scheduler/index.ts --no-session --mode json -p "/schedules"
```

## Publishing

This package is published as:

```text
@jl1990/pi-scheduler
```

The GitHub Actions workflow `.github/workflows/publish-npm.yml` publishes to npm when a GitHub Release is published.

Release flow:

```bash
npm version patch   # or minor/major
git push --follow-tags
```

Then create/publish a GitHub Release for the new tag. The workflow will run tests, check package contents, and publish with npm provenance.

## Security notes

This extension can run scheduled shell commands with your local user permissions. Only install Pi packages from sources you trust, and review scheduled shell tasks before using them in sensitive environments.
