# Pi Scheduler

**Give Pi coding agents a clock: schedule reminders, shell commands, and self-waking prompts for CI polling and autonomous follow-ups.**

Pi Scheduler is a [Pi](https://github.com/earendil-works/pi) extension that lets an agent schedule future work from inside the conversation. Use it for simple reminders, delayed shell commands, or autonomous workflows where the agent needs to wake itself up later, check an external system, and continue.

## Why?

Coding agents often need to wait:

- A GitLab/GitHub pipeline is still running.
- A deployment needs a few minutes to roll out.
- A long build or test command should be checked later.
- You want the agent to remind you or continue a task after a delay.

Without scheduling, the agent has to stop and hope you come back. With Pi Scheduler, it can schedule its own follow-up prompt:

> “Check the pipeline again in 3 minutes. If it failed, inspect logs and fix it. If it is still running, schedule another check.”

## Features

- **Self-waking prompts** — schedule a future prompt that wakes the agent in the current Pi session.
- **Delayed shell commands** — run commands later with optional follow-up prompts containing stdout/stderr.
- **Reminders and messages** — notify the user or inject scheduled messages.
- **Agent-callable tools** — the LLM can schedule, list, and cancel tasks itself.
- **Slash commands** — manually schedule tasks from the Pi prompt.
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

- `schedule_task` — schedule a future action.
- `list_scheduled_tasks` — list pending or historical tasks.
- `cancel_scheduled_task` — cancel a pending task by ID or prefix.

### Scheduled action types

| Action | What it does | Best for |
| --- | --- | --- |
| `prompt` | Injects a future user prompt and wakes the agent | CI polling, deployments, autonomous follow-ups |
| `shell` | Runs a future shell command | Delayed checks, tests, status commands |
| `notify` | Shows a reminder/notification | Human reminders |
| `message` | Injects a scheduled custom message | Lightweight status/context messages |

## Example: autonomous GitLab pipeline polling

Ask the agent to create a pipeline, then schedule itself to check it:

```json
{
  "action": "prompt",
  "when": "3m",
  "prompt": "Check GitLab pipeline 123 for project jl1990/example. If it passed, report success. If it failed, inspect the failed job logs and propose or apply fixes. If it is still running, schedule another check in 3 minutes."
}
```

This pattern lets the agent keep working without you manually nudging it every few minutes.

## Example: run a command later, then wake the agent

```json
{
  "action": "shell",
  "when": "2m",
  "command": "glab pipeline view 123 --repo jl1990/example",
  "followUpPrompt": "Review this pipeline status. If it is still running, schedule another check. If it failed, inspect logs and fix the issue."
}
```

When the command finishes, Pi Scheduler sends the command output back to the agent together with your follow-up instruction.

## Slash commands

```text
/schedule [notify|prompt|shell|message] <when> :: <payload>
/remind <when> <message>
/schedules
/schedules all
/schedule-cancel <id-or-prefix>
```

Examples:

```text
/remind 5m stretch
/schedule prompt 3m :: Check the GitLab pipeline and schedule another check if still running.
/schedule shell at 14:30 :: npm test
/schedules
/schedule-cancel task_abc123
```

## Time formats

Supported examples:

```text
5m
in 10 minutes
1h30m
2 days
tomorrow at 9am
14:30
2026-07-06T10:00:00
```

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

The GitHub Actions workflow `.github/workflows/publish-npm.yml` publishes to npm when a GitHub Release is published. It also supports manual runs from the Actions tab, including a dry-run option.

Before the first automated publish, configure one of these npm auth methods:

1. **Trusted publishing** on npm, for repository `jl1990/pi-scheduler` and workflow `publish-npm.yml`.
2. Or a GitHub repository secret named `NPM_TOKEN` with publish permission.

Release flow:

```bash
npm version patch   # or minor/major
git push --follow-tags
```

Then create/publish a GitHub Release for the new tag. The workflow will run tests, check package contents, and publish with npm provenance.

## Security notes

This extension can run scheduled shell commands with your local user permissions. Only install Pi packages from sources you trust, and review scheduled shell tasks before using them in sensitive environments.
