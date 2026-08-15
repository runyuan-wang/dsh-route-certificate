# RouteCertificate DeepSeek Harness Adapter Contract v0

Status: local community-plugin v0 contract, frozen before implementation. This is an adapter-owned contract because the generic RouteCertificate core has no stable DeepSeek Harness turn-validation operation. The generic public core remains advisory and source-bound; this adapter invokes an external validator over the schema below or records `indeterminate`.

## Platform Compatibility

- DeepSeek Harness source reviewed at commit `47f943859bef60e4160492346772ded9b24f765a`.
- Reviewed source/package version: `0.1.0-rc.5`.
- Public npm CLI latest/next was independently observed as `0.1.0-rc.6`; this package does not claim source-to-package correspondence or broad compatibility.
- Supported Harness source commit is exact-match by default. Unsupported metadata fails closed at plugin load unless `allowUnsupportedHarness=true` is explicitly configured for local experimentation.
- Active observe mode requires operator-supplied `actualHarnessCommit` and `actualHarnessPackageVersion`. The plugin validates those values against the expected pair but does **not** discover them from the running Harness process or package tree; they are explicit operator attestation, not independent runtime proof.

## Invocation Seam

- Plugin form: prebuilt ESM Cordis plugin with `apply(ctx, config)`.
- Bundle form: `package.json` declares `dsh.bundle.patch`; `cordis.patch.yml` inserts one unique row id, `route-certificate-deepseek-harness`.
- Required services: `sessions`. Optional service use: `subprocess` if the official subprocess seam is available. Tests use a strictly injectable runner.
- Triggers:
  - live: post-commit `session/event` events where `event.type === "turn/end"`;
  - cold/missed: idempotent history reconciliation on `session/created`.
- Non-trigger: `agent/turn-stopping` is never used for validation.

## Request Schema

The plugin writes exactly one canonical JSON request to the validator's stdin:

`schema = "routecertificate.deepseek-harness.request/v1"`

Required fields:

- `requestId`: `sha256:` plus lowercase SHA-256 over canonical request material excluding `requestId`.
- `harness`: `{ repository, commit, packageVersion, sessionFormatVersion }`.
- `subject`: `{ sessionId, turn, turnEndSeq, turnEndTime, harnessReason }`.
- `evidence`: `{ eventRange, events, sessionPrefixDigest, finalAssistantText, artifacts }`.
- `policy`: `{ policyId, policyDigest }`.

Canonicalization profile: adapter-owned `routecertificate-dsh-canonical-json-v1`, implemented as strict JSON with sorted object keys and SHA-256 over UTF-8 bytes. It is not claimed to be RFC 8785.

Caps:

- `maxEvents`: default 2000.
- `maxInputBytes`: default 8388608.
- `maxOutputBytes`: default 1048576.
- `maxArtifactBytes`: default 16777216.
- `maxArtifacts`: default 32.
- Oversize request/evidence produces `indeterminate`; it is not silently truncated into a pass.

## Response Schema

The validator must return JSON on stdout:

`schema = "routecertificate.result/v1"`

Required fields:

- `requestId`: exact request id.
- `outcome`: one of `pass`, `fail`, `indeterminate`.
- `checks`: array of `{ id, outcome, evidence? }`, with outcome in the same enum.
- `evidenceDigest`: exact request evidence digest.
- `policyDigest`: exact policy digest.
- `certificate`: optional object, bounded and strict JSON.
- `diagnostics`: array of bounded non-secret strings or objects.

Exit code alone is never a pass signal. Nonzero, malformed, mismatched, timeout, or oversize output yields adapter `indeterminate`.

## Idempotency

Stable key:

`sha256(sessionId + "\n" + turn + "\n" + turnEndSeq + "\n" + evidenceDigest + "\n" + policyDigest)`

Receipt writes are idempotent upserts to adapter-owned JSON files outside the DSH session log. Duplicate `turn/end`, HMR replay, and cold reconciliation cannot create duplicate validator invocations after a receipt exists.

## Security and Data Boundaries

- No certificate content is appended to the DSH session log.
- No certificate content is fed back into the model prompt.
- No global tool gate or enforcement in v0.
- Secrets are references only; config must not contain credential values.
- Validator child environment is scrubbed by default and forwards only explicit non-secret entries.
- Raw event/result/artifact inputs are copied immutably into the request or hashed before certification.
- Adapter-owned receipts separate bounded user summary from raw diagnostics.
- Artifact paths are realpath-checked under configured roots before open, final-component `O_NOFOLLOW` is requested, bytes are size-bounded and hashed, and handle/path/realpath metadata is compared again after the read. This is a best-effort path-stability check that detects the tested ancestor-directory rename+symlink swap, not a complete hostile-concurrency guarantee: Node's path-based API here does not provide a retained directory descriptor plus `openat`-style traversal, so an adversary able to replace ancestor directories concurrently remains outside the v0 guarantee.

## Failure Semantics

Default mode is raw-first/fail-open relative to Harness:

- Harness result is never suppressed, rewritten, duplicated, or delayed indefinitely.
- Validator/plugin failures persist an `indeterminate` receipt where possible.
- `session/flush` may await bounded pending work when `awaitOnFlush=true`; the listener catches validator failures and resolves unless `requireCertificate=true`.
- Disposal/HMR stops new admission, aborts active validators, waits bounded `allSettled`, and leaves existing DSH session data untouched.

## Fallback

If no validator command/runner is configured, the plugin loads only when `mode="disabled"`; active observe mode requires an explicit command or injected runner. This prevents fake integration. The local package tests use injected runners to prove the adapter contract.
