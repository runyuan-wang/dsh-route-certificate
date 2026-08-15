# dsh-route-certificate

Experimental community RouteCertificate observer for the DeepSeek Harness developer preview. It watches durable terminal turns, invokes an operator-supplied external validator, and writes separate receipts without replacing the raw Harness result.

> **Status:** advisory, disabled by default, not official DeepSeek software, and not published to npm. Use an isolated disposable Harness profile for testing.

## What is verified

- The repository test suite passes **18/18** on the accepted package.
- The bundle has been loaded through the official `dsh 0.1.0-rc.6` plugin/profile path in an isolated profile, both disabled and active, then removed with effective configuration restored byte-for-byte.
- The active loader smoke used explicit **operator-supplied** runtime metadata only. It did not call a model, create a real provider session, or invoke a real RouteCertificate validator.
- The reviewed Harness source was commit `47f943859bef60e4160492346772ded9b24f765a` (`0.1.0-rc.5`). The public CLI was separately observed at `0.1.0-rc.6`; source-to-package correspondence and broad rc.6 compatibility are **not proven**.

This project does not claim truth, enforcement, quality improvement, token savings, production fitness, or official endorsement. Hashes and receipts bind inputs and outcomes; they do not prove that a result is correct.

## Fastest friend check

Requirements for the repository tests: Node.js `>=22.19.0` and npm.

```bash
git clone https://github.com/runyuan-wang/dsh-route-certificate.git
cd dsh-route-certificate
npm ci
npm test
# Expected: 18 tests passed

npm pack
# Produces dsh-route-certificate-0.0.1-local.20260814.1.tgz
```

`npm test` is the primary reproducible check. It exercises successful receipts, cold reconciliation, timeout and malformed-validator handling, response/privacy validation, artifact bounds/races, disposal, stale claims, and two-instance idempotency.

## Optional official Harness smoke

The official plugin-manager path additionally requires a separately installed DeepSeek Harness developer-preview CLI and `pnpm` available to that CLI. Use a **new disposable profile**; plugin-manager commands can initialize or leave package-manager bookkeeping in the profile. Never point this smoke at a profile you cannot safely restore.

```bash
# Run from this repository after npm pack. Choose a new disposable name.
PROFILE="routecert-friend-$(date +%s)"
TGZ="$(pwd)/dsh-route-certificate-0.0.1-local.20260814.1.tgz"

dsh plugin --profile "$PROFILE" add "$TGZ"
dsh --profile "$PROFILE" --dump-config
# The shipped patch must show mode: disabled.

dsh plugin --profile "$PROFILE" remove dsh-route-certificate
```

After removal, inspect the disposable profile before deleting it. The official remove path may leave `pnpm` bookkeeping; remove only the profile you created for this smoke, never an existing user profile.

## Disabled-first activation model

The shipped [`cordis.patch.yml`](./cordis.patch.yml) sets `mode: disabled`. In that state the plugin is a no-op and needs no runtime attestation or validator.

Active `mode: observe` requires all of the following:

- an absolute adapter-owned `outputDir`;
- an explicit validator `command` (or an injected runner in tests);
- an explicit `policyDigest`;
- operator-supplied `actualHarnessCommit` and `actualHarnessPackageVersion`;
- explicit `artifactRoots` if artifacts may be read.

See [`examples/observe.patch.template.yml`](./examples/observe.patch.template.yml). It is a reference template, not automatically loaded. Replace every placeholder with real local values. Do **not** copy the acceptance smoke's self-attested metadata as if the plugin discovered it. If your actual runtime differs from the reviewed rc.5 pair, the default is to refuse active mode. `allowUnsupportedHarness: true` is only an explicit local experimentation override; it does not establish compatibility.

The validator protocol and exact lifecycle contract are in [`CONTRACT.md`](./CONTRACT.md). This repository does not ship a validator implementation.

## Behavior and boundaries

The plugin:

- observes durable post-commit `turn/end` events;
- reconciles missed terminal history on `session/created`;
- sends a bounded canonical request to an explicit external validator;
- stores adapter-owned receipts outside the Harness session log;
- never feeds certificate content back into the model;
- never suppresses, rewrites, or replaces the raw Harness result.

Validator timeout, nonzero exit, malformed/mismatched output, unsupported metadata, oversize evidence, or plugin failure becomes `indeterminate` where a receipt can be written. `requireCertificate` remains `false` in the shipped patch so certification failure does not block the Harness result.

Artifact reads are allowlisted and bounded. They use realpath checks, final-component `O_NOFOLLOW`, and post-read handle/path/realpath comparisons. This detects the tested ancestor-directory rename-plus-symlink swap, but it is still **best effort**: Node's path API here does not retain a directory descriptor or provide an `openat`-style traversal, so hostile concurrent ancestor replacement is outside the v0 guarantee.

## Repository map

- `index.js` — Cordis plugin and observer implementation
- `testing.js` — narrow test helpers
- `cordis.patch.yml` — disabled-default Harness bundle patch
- `CONTRACT.md` — request/response, lifecycle, failure, and security contract
- `examples/observe.patch.template.yml` — placeholder-only active-mode reference
- `tests/` — 18 deterministic regressions

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
