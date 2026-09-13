# Pi Scheduler

**Run checks on a schedule. Wake the agent when there’s something to do.**

Schedule shell commands, agent prompts, and reminders inside [Pi](https://github.com/earendil-works/pi). Commands run directly and bring their output back to the agent when your wake policy matches.

> “Run the tests every five minutes. Wake yourself if they fail. Stop after ten runs.”

## Why this package?

Pi Scheduler focuses on **scheduled actions**: run a command, capture stdout/stderr, and trigger a follow-up on success or failure. Execution limits, persistent tasks, and atomic claims let multiple Pi processes share scheduled work.

Prompt loops suit checks that need agent judgment every time. Broader packages such as [pi-loop](https://github.com/trvon/pi-loop) also provide workflows, event triggers, orchestration, and command monitoring. Choose Pi Scheduler when you want a focused scheduler for commands, prompts, and reminders.

**Pi must be running for tasks to fire.** Tasks persist across restarts, but this package does not run an always-on daemon.

## Get started

```bash
pi install npm:@jl1990/pi-scheduler
```

Restart Pi or run `/reload`. Ask for a scheduled task in plain language, or try:

```text
/remind 20m take a break
/schedule prompt 5m :: Check whether the deployment has finished.
/schedules
```

A compact widget shows upcoming tasks below the editor.

## Example: run tests, investigate failures

Ask Pi to schedule this, or use these arguments with its `schedule_task` tool:

```json
{
  "action": "shell",
  "type": "interval",
  "schedule": "5m",
  "command": "npm test",
  "timeoutMs": 120000,
  "wakeOn": "failure",
  "failurePrompt": "Review the test output, diagnose the failure, and report the cause.",
  "maxRuns": 10,
  "scope": "cwd"
}
```

Use a test command that finishes rather than entering watch mode. Every five minutes, the scheduler runs it and captures the result:

- **Pass:** no agent turn. Pi may still show execution notifications and result messages.
- **Non-zero exit or timeout:** wake the agent with stdout/stderr to investigate.
- **Ten executions:** disable the task automatically.

For recurring shell tasks, `stopOn` may be `success`, `failure`, or `never` (the default). It disables recurrence after the matching result; non-zero exits, timeouts, and killed commands count as failures. `stopOn` is independent of `wakeOn`.

Recurring tasks do not stop when an external goal completes unless configured with `stopOn`. Cancel them when finished, or bound them with `maxRuns`.

## Scheduling options

| Option | Choices |
| --- | --- |
| Action | `shell` runs a command; `prompt` wakes the agent; `notify` shows a reminder; `message` adds a custom message |
| Schedule | `once`: `5m`, `tomorrow at 9am`, ISO datetime; `interval`: `30s`, `5m`, `1h`; `cron`: `0 0 9 * * 1-5` (weekdays at 9am) |
| Scope | `session` (default): creating session; `cwd`: sessions in the same project directory; `global`: any session |
| Limits | `maxRuns` caps executions; `timeoutMs` bounds each shell command |
| `stopOn` | For shell actions, stop recurrence after `success`, `failure`, or `never` (default) |

Cron uses `croner`; six-field expressions with seconds are recommended. Use `session` scope when a follow-up must return to a specific session. For shared scopes, the process that claims the task receives the follow-up.

### Shell wake policy

| `wakeOn` | Wake the agent when… |
| --- | --- |
| `failure` | The command exits non-zero or is killed/times out |
| `success` | The command exits 0 without being killed |
| `always` | Any run finishes |
| `never` | Never; just record the result |

Use `successPrompt` or `failurePrompt` for outcome-specific instructions, or `followUpPrompt` for either outcome. The wake policy is checked first. Without an explicit policy, supplying a prompt defaults to `always`; otherwise the default is `never`. An explicit matching policy without a custom prompt uses a default review instruction.

**Exit status matters.** A command that prints a failed CI pipeline may still exit 0. For CI polling, use a command or wrapper that maps pipeline states to the intended exit status; pending is not automatically a separate state.

## Manage tasks

Ask Pi to list, update, disable, or remove tasks. Its tools are `schedule_task`, `list_scheduled_tasks`, `cancel_scheduled_task`, and `manage_scheduled_task`.

```text
/schedules                       # active tasks
/schedules all                   # include history
/schedule-cancel <id-or-prefix>
/schedule-enable <id-or-prefix>
/schedule-disable <id-or-prefix>
/schedule-remove <id-or-prefix>
/schedule-cleanup
/schedule-widget [on|off]
```

To create tasks directly:

```text
/schedule [notify|prompt|shell|message] [once|interval|cron|every] <schedule> :: <payload>
```

## Persistence and recovery

Tasks live in `~/.pi/agent/state/scheduler/tasks.json`. Atomic state transactions and task claims coordinate execution across Pi processes; shared state refreshes every five seconds.

On restart, overdue one-shot and interval tasks run. Cron catches up the most recent missed occurrence per task, newest first, within these limits:

| Environment variable | Default |
| --- | --- |
| `PI_SCHEDULER_CATCHUP_WINDOW_H` | `24` hours |
| `PI_SCHEDULER_CATCHUP_MAX` | `5` tasks per startup; `0` disables cron catch-up |

Interrupted executions are recorded as failed: one-shot tasks remain failed, while recurring tasks are rescheduled. Shell commands run with your local user permissions.

## Development

```bash
npm test
npm pack --dry-run
PI_OFFLINE=1 pi --no-extensions -e ./extensions/scheduler/index.ts --list-models __unlikely_model_filter__
```

Published GitHub Releases trigger the [npm publishing workflow](.github/workflows/publish-npm.yml), which tests, checks package contents, and publishes with provenance.

[MIT license](LICENSE.md)
