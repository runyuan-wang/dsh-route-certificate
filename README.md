# dsh-route-certificate

Installable community RouteCertificate observer bundle for DeepSeek Harness users.

The plugin watches durable `turn/end` session events, writes separate RouteCertificate receipts, and never rewrites or suppresses the raw Harness result. The bundled default is immediately usable without a user-written validator: it certifies only the **Harness terminal state and source-bound event envelope**.

- `completed` + a valid, complete envelope → structural `pass`.
- `error` + a valid, complete envelope → structural `fail`.
- interrupted, aborted, disposed, max-token, unknown, or omitted-artifact cases → `indeterminate`.

This policy does **not** judge answer truth, semantic correctness, output quality, safety, task success, or production fitness. An external validator remains optional when an operator wants a stronger policy.

## 中文介绍

**RouteCertificate × DeepSeek Harness** 是一个可直接安装的 Harness 社区插件。它主要服务于多个子 Agent 同时或分阶段干活的场景：在每个子任务结束后旁路生成结构化完成凭证，把请求、执行前缀、终止事件、结果范围和产物指纹绑定起来，帮助上层 Agent 核验各子 Agent 交回的结果是否属于正确的任务、正确的执行和正确的终态。

### 真正的核心优势：多子 Agent 之间可核验的任务交接

普通的成功/失败状态或执行轨迹可以告诉人“某个子 Agent 记录了什么”；RouteCertificate 更进一步要回答的是：**当多个子 Agent 分头干活时，接收方怎样机械核验，每份交回结果确实属于这一次请求、这一次执行和这一个终态。**

它把每个子任务的交接链绑定进同一份可复算回执：

`本次请求 → 实际执行前缀 → 终止事件 → 终止事件范围 → 最终产物指纹`

因此，它专门帮助发现多子 Agent 协作交接里的四类混乱：

- 子 Agent A 错拿了子 Agent B 的产物；
- 某个子 Agent 的旧结果被当作本轮新完成；
- 子任务没有到达可信终态，却被上层 Agent 当作已经完成；
- 子任务的终止事件范围或产物内容后来发生变化，却仍沿用旧的完成声明。

这是一项**结构与来源完整性**能力，不是语义裁判：它不声称答案正确，也不声称自己是市场上唯一或首创的实现；它的产品中心，是把“多个子 Agent 各自交回结果”从口头声明变成可机械复核的证据链。

### 围绕核心的工程特性

1. **零构建直接安装**：普通用户不需要 clone、build，也不需要自己编写 validator；使用官方 `dsh plugin` 命令即可安装预构建包。
2. **原始结果优先**：插件只增加独立回执，不改写、不隐藏、不替换 Harness 的原始结果和原始终止事件。
3. **三态判断更诚实**：完整正常终态记为结构 `pass`，明确错误终态记为结构 `fail`；中断、信息不足或无法可靠判断时记为 `indeterminate`，不把未知包装成成功。
4. **请求与产物可追溯绑定**：回执重新计算请求、前缀、终态、事件范围和产物指纹，便于后续发现不一致、错配或过期声明。
5. **观察失败不阻断原任务**：在默认 advisory 模式下，即使 validator 或回执写入失败，插件也会回落到原始 Harness 结果，不把观察器故障变成任务故障。
6. **可完整撤除**：使用官方卸载命令即可移除插件；已验证卸载后不会残留插件行、包目录或锁文件条目。

它适合多个子 Agent 并行或串行施工、研究和审计后再由上层 Agent 汇总的任务。它证明的是**终态与来源绑定的结构完整性**，不证明答案语义正确、任务质量、安全性或生产适用性；需要更强判断时，仍可接入独立 validator。

一句话介绍：**给 DeepSeek Harness 的多子 Agent 协作加一条可机械复核的交接证据链，避免各子 Agent 串单、错拿产物、用旧结果冒充新完成，或未到终态就被上层当作完成。**

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

Large-log decisions are bounded by the configured limits. Event admission and cold reconciliation inspect only the needed terminal prefix and at most `maxEvents + 1` entries to detect count overflow; overflow is a persisted `preflight_event_count_oversize` indeterminate receipt, and a nonterminal cold-history boundary is not mislabeled as a turn end. Definitely oversized event JSON is rejected before cloning, and the exact canonical request must still fit `maxInputBytes`. The Node fallback retains at most `maxOutputBytes + 1` bytes per output stream, while an official collector's loss/truncation signal is also authoritative; either condition produces `indeterminate`, never a parsed pass. Artifact oversize is decided from open-handle metadata or a read of at most `maxArtifactBytes + 1`; the artifact is left untouched, the request uses an omitted descriptor, and the receipt records only path-free `eventSeq`/`reason`/`size` omission facts. Omitted evidence cannot become a pass. The original Harness events, result, and declared artifact remain unmodified and recoverable outside the separate receipt.

## License

Apache-2.0. This package is not official DeepSeek software.
