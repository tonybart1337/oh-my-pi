# tonybart1337 omp fork

Branch `tony/stable` = newest upstream release tag + the commits on top of it.
`omp-fork` keeps a standalone binary built from that branch installed as
`~/.local/bin/omp-dev` (a symlink into `~/.local/lib/omp-fork/<version>-<sha>/`).
The stock `omp` is left alone; switching to the fork is a separate, manual decision.

| Command | Effect |
|---|---|
| `omp-fork update` | fetch upstream tags; rebase the patches onto the newest `vX.Y.Z` whose natives are on npm (tags upstream never published are skipped; patches already upstream drop out); type-check, run the collab tests, build, install, push `tony/stable` |
| `omp-fork install` | rebuild and install the branch as it is |
| `omp-fork status` | installed build, patch series, newest upstream release |
| `omp-fork setup` | install the script and the `omp-fork` systemd user timer (every 6h) |

`omp-dev update` runs `omp-fork update` (`--check` runs `omp-fork status`), so
upstream's updater never replaces the patched binary.

Failures (rebase conflict, failed gate, failed build) leave the installed binary and
the branch untouched and notify via `agent-notify` (Telegram).

A rebase conflict starts a headless agent (`agent run -p personal omp --auto-approve -p
<prompt>`) in the transient user unit `omp-fork-resolve`; the timer run exits at once.
The agent redoes the rebase on a detached HEAD, resolves the conflicts, runs the gates,
and finishes with `omp-fork update`. When the unit ends, `omp-fork resolve` checks the
repo itself (on `tony/stable`, clean, on the target tag, that build installed) and
notifies success or failure. While the unit is active, other `update`/`install` runs
skip. Each target tag gets one attempt (`~/.local/state/omp-fork/resolve-target`);
after a failed one, rebase by hand in the `tony/stable` worktree, then run
`omp-fork update`. The agent's final summary lands in `journalctl --user -u omp-fork-resolve`.

Native addons come prebuilt from npm (`@oh-my-pi/pi-natives-linux-x64@<version>`);
they are compiled locally only when the patches touch `crates/` or `packages/natives`.

## Adding a patch

Commit it on `tony/stable` (upstreamable fixes also go on their own branch for a PR),
then `omp-fork install`.
