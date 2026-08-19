# Release Notes

## 0.0.4

- Maintenance update for the official `@deepseek-ai/dsh@0.1.0-rc.7` package surface.
- Updates the source-review anchor to `deepseek-ai/deepseek-harness@99f6f02fecdb7dff40c3fbc9470f5907c29f74ca` after verifying the plugin-used CLI, app-boot, session, and subprocess seam files are unchanged from the previous reviewed anchor.
- Keeps the existing terminal-envelope-only observer behavior and claims unchanged.
- Uses a semantic package version and fixed-Git-commit installation guidance for DSH-Store candidacy. This does not claim an existing DSH-Store listing.

## 0.0.3-universal.20260815

- Ships as a prebuilt npm tarball installable through the official `dsh plugin --profile <name> add -w <tgz-or-package-spec>` path.
- Replaces the transport-only default with a real bundled terminal-envelope policy: valid completed/error terminations receive scoped structural pass/fail; interrupted, aborted, max-token, unknown, and omitted-artifact cases remain indeterminate.
- Emits an explicit `terminal-envelope-only` certificate with `semanticJudgment: false`; it never claims answer truth, semantic correctness, quality, safety, task success, or production fitness.
- Uses a real documented bundled-policy digest and recomputes request ID, event-prefix digest, terminal event/sequence/time, event range and artifact completeness.
- Bounds persisted terminal reasons to allowlisted kind/status/stable-code fields; raw error objects remain only in bounded validator evidence.
- Contains advisory receipt-write failures without creating unhandled observer rejections; `requireCertificate=true` still propagates failure through awaited seams.
- Uses component-aware active-platform artifact containment and rejects unsafe claim timing where stale ownership can expire before a live validator/wait window.
- Discovers the running official `@deepseek-ai/dsh` package version and supports only `0.1.0-rc.6` by default. The pinned source commit is a review anchor corresponding to that inspected package surface, not a runtime-detected commit.
- Resolves receipts under the owning Harness profile when `outputDir` is `null`, preserves raw-first behavior, and removes through the official plugin manager.
- Apache-2.0; community package, not official DeepSeek software.
