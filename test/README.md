# Running tests

Run `pnpm test` with Node.js 24+ (the runtime fixtures use `node:module.stripTypeScriptTypes`). The multiprocess tests require a POSIX system and `bash`.

The default suite covers core policies, extension lifecycle, in-flight edits, cancellation, expiry, history, and shared-store contention/recovery using separate Node processes. Those fixtures stub Pi's API; the multiprocess fixture executes real shell commands.

To also test the installed Pi SDK, run:

```sh
PI_SCHEDULER_LIVE_TESTS=1 pnpm test
```

Pi is discovered from `pi` on PATH. Set `PI_SCHEDULER_PI_PACKAGE` to its package directory if needed. If Pi's installation cannot resolve its TypeBox peer, set `PI_SCHEDULER_TYPEBOX_PACKAGE` to the absolute path of that installation's `typebox/value` module entry file.

The live tests load the extension through Pi, inspect its registered schemas, and execute scheduled shell commands including a timeout. They use isolated temporary state and do not start model turns or make paid model calls. They are explicitly skipped unless enabled.

The Alt+Up regression also needs a Pi build that preserves custom messages when editing the user queue (`AgentSession.dequeueUserMessages`). To run it with that build:

```sh
PI_SCHEDULER_PI_PACKAGE=/path/to/pi/packages/coding-agent \
PI_SCHEDULER_LIVE_TESTS=1 PI_SCHEDULER_QUEUE_TEST=1 node --test test/live-pi.test.cjs
```

It runs a real scheduled shell command, invokes the Alt+Up action, and verifies that the editor gets only the user draft and the shell result is still queued. No model call is made.

These tests do not prove exactly-once wake delivery across crashes, nor do they exercise a real model's response to a wake.
