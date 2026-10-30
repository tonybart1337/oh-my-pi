OMP-native repository security scans: plan, start, inspect, cancel, validate.
`preflight`: immutable plan pinned to repository snapshot, model, exact OAuth credential.
`start`: plan → background OMP job.
`status`, `cancel`: returned operation ID.
`repository`: target another repository; path MUST be the working directory or inside a `/add-dir` workspace directory. Pass the same value to `start`, `status`, `cancel`, `validate`, `cloud_pull` for that repository's plans and scans.
`cloud_scans`: Codex Security cloud configurations for the selected ChatGPT account: stored `openai-codex` OAuth account, else the sole provider route a proxy extension registered.
`cloud_start`: creates/enables configuration using `repository_id`, `repository_url`, `environment_id`; consumes account's separate Codex Security cloud allowance; NEVER native-scan fallback.
`cloud_status`: cloud progress.
`cloud_pull`: cloud findings → canonical OMP security store, available through `security://`.
Cloud actions: `cloud_configuration_id` required; `credential_id` MAY pin OAuth account; `cloud_provider` MAY pick provider route (REQUIRED when several are registered).
Security MUST be enabled in settings.
