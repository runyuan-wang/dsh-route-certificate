# Install

Requires the official DeepSeek Harness CLI `@deepseek-ai/dsh@0.1.0-rc.6` and `pnpm` on `PATH`, because `dsh plugin` forwards package operations to pnpm.

```sh
PROFILE=tui
PACKAGE_URL=https://raw.githubusercontent.com/runyuan-wang/dsh-route-certificate/main/dist/dsh-route-certificate-0.0.3-universal.20260815.tgz
dsh plugin --profile "$PROFILE" add -w "$PACKAGE_URL"
dsh --profile "$PROFILE" --dump-config
```

Verify the dump contains exactly one row id `route-certificate-deepseek-harness` with:

- `mode: observe`
- `command: null` (the bundled validator)
- `policyId: terminal-envelope-default`
- `policyDigest: sha256:d973daa08041bbe7423bd5602a629a7c87b28c692e5e04289a5c6291880f7f1d`
- `expectedHarnessPackageVersion: 0.1.0-rc.6`

The dump is static composition only. At plugin activation, the bundle discovers the actual Harness package version from the official DSH launcher/package surface and refuses unsupported versions by default; the profile-owned receipt records that detected version.

Receipts default to:

```text
$DSH_HOME/profiles/<profile>/.route-certificate/receipts/
```

A completed turn with a valid complete envelope receives a structural `pass`; an error turn receives a structural `fail`; interrupted/unknown/omitted-artifact cases remain `indeterminate`. Every certificate is labeled `terminal-envelope-only` and `semanticJudgment: false`.

Uninstall and verify rollback:

```sh
dsh plugin --profile "$PROFILE" remove -w dsh-route-certificate
dsh --profile "$PROFILE" --dump-config
```

The post-remove dump must contain no `route-certificate-deepseek-harness` row. Existing Harness session/result data is never rewritten by this plugin.
