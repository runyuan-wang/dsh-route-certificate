# dsh-route-certificate

Installable community RouteCertificate observer bundle for DeepSeek Harness users.

The plugin watches durable `turn/end` session events, writes separate RouteCertificate receipts, and never rewrites or suppresses the raw Harness result. The bundled default is immediately usable without a user-written validator: it certifies only the **Harness terminal state and source-bound event envelope**.

- `completed` + a valid, complete envelope → structural `pass`.
- `error` + a valid, complete envelope → structural `fail`.
- interrupted, aborted, disposed, max-token, unknown, or omitted-artifact cases → `indeterminate`.

This policy does **not** judge answer truth, semantic correctness, output quality, safety, task success, or production fitness. An external validator remains optional when an operator wants a stronger policy.

## Compatibility

Tested against:

- Source-verified mapping: `https://github.com/deepseek-ai/deepseek-harness`, commit `47f943859bef60e4160492346772ded9b24f765a`, corresponding to the inspected rc.6 package surface.
- Official npm CLI: `@deepseek-ai/dsh@0.1.0-rc.6`.
- Session format: `0`.

Active mode discovers the running `@deepseek-ai/dsh` **package version** from the launcher/package installation surface and refuses unsupported versions by default. The source commit is a pinned review anchor; it is not claimed to be runtime-detected from the npm installation.

## Install

Choose the existing Harness profile you want to observe, then install the published prebuilt package directly with the official plugin command:

```sh
PROFILE=tui
PACKAGE_URL=https://raw.githubusercontent.com/runyuan-wang/dsh-route-certificate/main/dist/dsh-route-certificate-0.0.3-universal.20260815.tgz
dsh plugin --profile "$PROFILE" add -w "$PACKAGE_URL"
dsh --profile "$PROFILE" --dump-config
```

The plugin owns receipts under that profile directory by default:

```text
$DSH_HOME/profiles/<profile>/.route-certificate/receipts/
```

Each receipt includes explicit `terminal-envelope-only` scope and `semanticJudgment: false`. To remove the plugin:

```sh
dsh plugin --profile "$PROFILE" remove -w dsh-route-certificate
dsh --profile "$PROFILE" --dump-config
```

## Optional stronger validator

Patch the installed row by id only when you intentionally want a stronger local policy:

```yaml
- id: route-certificate-deepseek-harness
  config:
    mode: observe
    command: /absolute/path/to/validator
    args: []
    outputDir: null
    policyId: your-policy-id
    policyDigest: sha256:REPLACE_WITH_YOUR_POLICY_DIGEST
```

Override `command`, `policyId`, and `policyDigest` together. `outputDir: null` keeps the profile-owned default. Set an absolute `outputDir` only when you intentionally want receipts elsewhere.

## Failure and data boundary

Validation and receipt work is additive. In advisory mode, validator or receipt-persistence failure cannot replace the raw Harness result or create an unhandled observer rejection. Raw terminal error objects stay in the validator's bounded evidence input; the persisted receipt subject keeps only an allowlisted terminal kind plus an optional bounded status/stable code.

## License

Apache-2.0. This package is not official DeepSeek software.
