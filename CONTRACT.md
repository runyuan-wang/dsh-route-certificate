# RouteCertificate DeepSeek Harness Adapter Contract v0

Status: installable community-plugin contract implemented for the inspected DeepSeek Harness rc.6 surface. The adapter is additive, raw-first, and advisory relative to Harness. Its bundled policy is a real but deliberately narrow structural policy; stronger semantic policies remain optional external validators.

## Compatibility

- Source-verified review anchor: `deepseek-ai/deepseek-harness@47f943859bef60e4160492346772ded9b24f765a`.
- Inspected official npm CLI: `@deepseek-ai/dsh@0.1.0-rc.6`.
- Supported active runtime package version: `0.1.0-rc.6` only, unless `allowUnsupportedHarness=true` is explicitly set for local experimentation.
- Active mode discovers the installed npm **package version**. The pinned commit is a source-review mapping corresponding to the inspected rc.6 surface, not a runtime-detected commit.

## Invocation seam

- Prebuilt ESM Cordis plugin with `apply(ctx, config)` and `dsh.bundle.patch`.
- Required service: `sessions`; optional official `subprocess` seam, otherwise a bounded Node child process for the bundled validator.
- Live trigger: committed `session/event` with `event.type === "turn/end"`.
- Cold trigger: idempotent reconciliation on `session/created`.
- `agent/turn-stopping` is not used.

## Request

Schema: `routecertificate.deepseek-harness.request/v1`.

- `requestId`: lowercase SHA-256 over canonical request material excluding `requestId`.
- `harness`: repository, pinned source-review commit, detected package version, session-format version.
- `subject`: session id, turn, terminal sequence/time, and only a bounded terminal summary (`kind`, optional finite `status`, optional stable non-secret `code`).
- `evidence`: event range, immutable raw event prefix, recomputed prefix digest, final assistant text, and bounded artifact descriptors.
- `policy`: policy id and policy digest.

Canonicalization is adapter-owned sorted-key JSON over UTF-8, not claimed as RFC 8785.

Default caps: 2,000 events; 8 MiB input; 1 MiB output per stream; 32 artifacts; 16 MiB per artifact. Event prefix collection and cold reconciliation stop after the needed prefix or `maxEvents + 1` entries; count overflow persists `preflight_event_count_oversize`, with null turn-end fields when a generic cold boundary is nonterminal. A bounded lower-bound walk rejects definitely oversized event JSON before cloning, and the later canonical request byte check remains exact. The Node child collector retains no more than `maxOutputBytes + 1` aggregate bytes per stream; either retained bytes above the cap or any collector loss/truncation signal is `validator_output_oversize`. Artifact oversize is decided from open-handle metadata when possible, otherwise with at most a `maxArtifactBytes + 1` read. Oversize or omitted evidence never becomes a pass.

## Response

Schema: `routecertificate.result/v1`.

Required binding: exact request id, evidence digest and policy digest. Outcome is `pass`, `fail`, or `indeterminate`; checks, optional bounded certificate, and bounded non-secret diagnostics are validated structurally. Exit code alone is never a pass signal.

## Bundled terminal-envelope policy

- ID: `terminal-envelope-default`.
- Digest: `sha256:d973daa08041bbe7423bd5602a629a7c87b28c692e5e04289a5c6291880f7f1d`.
- Scope: only Harness terminal state and source-bound event envelope.

The validator recomputes request ID, event-prefix digest, event range, terminal event/sequence/time, terminal ordinal/reason summary, and artifact completeness.

- Valid complete `completed` terminal → structural `pass`.
- Valid complete `error` terminal → structural `fail`.
- Interrupted, aborted, disposed, max-token, unknown, or omitted-artifact cases → `indeterminate`.
- Malformed or mismatched request/envelope binding → structural `fail`.

Every certificate says `scope: terminal-envelope-only` and `semanticJudgment: false`. It does not establish answer truth, task success, semantic correctness, quality, safety, or production fitness.

## Idempotency and claims

Stable receipt key binds session id, turn, terminal sequence, evidence digest and policy digest. Receipt writes preserve the first canonical value. Cross-instance claim ownership prevents duplicate validation; configuration is rejected unless `receiptClaimStaleMs > max(timeoutMs, receiptClaimWaitMs)`.

## Security and data boundaries

- No certificate is appended to session logs or model prompts; there is no global gate.
- Raw event/error objects stay only in bounded validator evidence. Persisted subjects omit messages, arbitrary nesting and secret-shaped data.
- Child environment is scrubbed by default and forwards only explicit non-secret values.
- Artifact paths are realpath-checked under component-aware active-platform allowlist roots before and after read, final-component `O_NOFOLLOW` is requested, bytes are bounded/hashed, and handle/path metadata is compared. Omitted artifacts are represented to the validator explicitly; receipts retain only path-free bounded omission facts (`eventSeq`, stable `reason`, and optional `size`). A bound validator pass over omitted artifact evidence is downgraded to `indeterminate`. This is best-effort race detection, not an `openat` hostile-concurrency guarantee.

## Failure semantics

Default mode is raw-first/fail-open relative to Harness:

- Harness result is never suppressed, rewritten, duplicated, or replaced.
- Validator/plugin failures persist `indeterminate` receipts where possible.
- Advisory listener/reconciliation dispatch catches terminal observer failures, including receipt-store failure, so they do not become unhandled rejections.
- With `requireCertificate=true`, awaited seams retain failure propagation.
- Disposal stops admission, aborts active validation and waits a bounded `allSettled` interval.

## Default installation

`mode: observe`, `command: null`, and `outputDir: null` resolve to the bundled validator and a profile-owned `.route-certificate` directory. External `command`, `policyId`, and `policyDigest` overrides are optional and must be changed together for a stronger policy.
