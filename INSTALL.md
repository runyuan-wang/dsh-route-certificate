# Install

Requires the official DeepSeek Harness CLI `@deepseek-ai/dsh@0.1.0-rc.7` and `pnpm` on `PATH`, because `dsh plugin` forwards package operations to pnpm.

For DSH-Store review or reproducible installation, use a fixed public GitHub commit containing this semantic package version. Do not use a floating branch or raw-main archive as the recommended source, and do not treat this package as listed in DSH-Store until an actual store entry exists.

```sh
PROFILE=tui
PACKAGE_SPEC=git+https://github.com/runyuan-wang/dsh-route-certificate.git#<fixed-public-commit>
dsh plugin --profile "$PROFILE" add "$PACKAGE_SPEC"
dsh --profile "$PROFILE" --dump-config
```

Verify the dump contains exactly one row id `route-certificate-deepseek-harness` with:

- `mode: observe`
- `command: null` (the bundled validator)
- `policyId: terminal-envelope-default`
- `policyDigest: sha256:d973daa08041bbe7423bd5602a629a7c87b28c692e5e04289a5c6291880f7f1d`
- `expectedHarnessPackageVersion: 0.1.0-rc.7`

The dump is static composition only. At plugin activation, the bundle discovers the actual Harness package version from the official DSH launcher/package surface and refuses unsupported versions by default; the profile-owned receipt records that detected version. In rc.7, `dsh plugin --profile <name> <args...>` initializes the profile if needed, forwards `<args...>` to pnpm from the profile directory, anchors relative path specs to the invoking directory, and reconciles installed `dsh.bundle.patch` packages into the profile bundle stack after a successful pnpm command.

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
