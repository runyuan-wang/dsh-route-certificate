import Schema from '@deepseek-ai/schemastery'
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { link, mkdir, open, readFile, realpath, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import * as pathModule from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUNDLED_POLICY_DIGEST, BUNDLED_POLICY_SPEC, sanitizeTerminalReason } from './policy.js'

export const name = 'route-certificate-deepseek-harness'
export const inject = ['sessions']

const SUPPORTED_HARNESS = Object.freeze({
  repository: 'https://github.com/deepseek-ai/deepseek-harness',
  commit: '99f6f02fecdb7dff40c3fbc9470f5907c29f74ca',
  packageVersion: '0.1.0-rc.7',
  packageVersions: ['0.1.0-rc.7'],
  sessionFormatVersion: 0,
})

const REQUEST_SCHEMA = 'routecertificate.deepseek-harness.request/v1'
const RESPONSE_SCHEMA = 'routecertificate.result/v1'
const RECEIPT_SCHEMA = 'routecertificate.deepseek-harness.receipt/v1'
const OUTCOMES = new Set(['pass', 'fail', 'indeterminate'])
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/
const SECRET_KEY_RE = /(?:key|password|passwd|secret|token|authorization)/i
const SECRET_VALUE_RE = /(-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-[A-Za-z0-9_-]{12,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[baprs]-[A-Za-z0-9-]{10,}|\bAKIA[A-Z0-9]{16}\b)/i

export const Config = Schema.object({
  mode: Schema.union(['disabled', 'observe']).default('observe'),
  command: Schema.union([Schema.string(), Schema.const(null)]).default(null),
  args: Schema.array(Schema.string()).default([]),
  outputDir: Schema.union([Schema.string(), Schema.const(null)]).default(null),
  artifactRoots: Schema.array(Schema.string()).default([]),
  policyId: Schema.string().default(BUNDLED_POLICY_SPEC.policyId),
  policyDigest: Schema.string().default(BUNDLED_POLICY_DIGEST),
  timeoutMs: Schema.number().default(30000),
  disposeTimeoutMs: Schema.number().default(5000),
  receiptClaimWaitMs: Schema.number().default(35000),
  receiptClaimStaleMs: Schema.number().default(60000),
  maxInputBytes: Schema.number().default(8 * 1024 * 1024),
  maxOutputBytes: Schema.number().default(1024 * 1024),
  maxEvents: Schema.number().default(2000),
  maxArtifacts: Schema.number().default(32),
  maxArtifactBytes: Schema.number().default(16 * 1024 * 1024),
  awaitOnFlush: Schema.boolean().default(true),
  requireCertificate: Schema.boolean().default(false),
  allowUnsupportedHarness: Schema.boolean().default(false),
  actualHarnessPackageVersion: Schema.union([Schema.string(), Schema.const(null)]).default(null),
  expectedHarnessCommit: Schema.string().default(SUPPORTED_HARNESS.commit),
  expectedHarnessPackageVersion: Schema.string().default(SUPPORTED_HARNESS.packageVersion),
})

export function apply(ctx, config) {
  const observer = createRouteCertificateObserver(ctx, config)
  ctx.effect(() => {
    observer.start()
    return () => observer.dispose()
  })
}

export function createRouteCertificateObserver(ctx, rawConfig, overrides = {}) {
  const config = normalizeConfig(rawConfig, { ctx, runtime: overrides.runtime, packageUrl: import.meta.url })
  validateConfig(config, overrides)
  const runner = overrides.runner ?? createSubprocessRunner(ctx, config)
  const receiptStore = overrides.receiptStore ?? createFileReceiptStore(config.outputDir)
  const artifactReader = overrides.artifactReader ?? createArtifactReader(config)
  const pendingBySession = new Map()
  const activeControllers = new Set()
  const completedKeys = new Set()
  let accepting = true
  let unlisteners = []

  async function enqueue(session, event, source) {
    if (!accepting || config.mode === 'disabled') return
    if (!event || event.type !== 'turn/end') return
    const sessionId = sessionIdOf(session)
    let snapshot
    let preliminary
    let preliminaryKey
    try {
      snapshot = collectEventPrefix(session.events ?? [], event, config.maxEvents)
      preliminary = buildPreliminaryRequest(config, session, event, snapshot)
      preliminaryKey = idempotencyKey(preliminary)
    } catch (error) {
      const receipt = await persistPreflightFailure({ config, receiptStore, session, event, source, error })
      if (receipt?.idempotencyKey) completedKeys.add(receipt.idempotencyKey)
      if (config.requireCertificate) throw error
      return receipt
    }
    if (completedKeys.has(preliminaryKey)) return await receiptStore.read(preliminaryKey).catch(() => undefined)
    const prior = pendingBySession.get(sessionId) ?? Promise.resolve()
    const task = prior
      .then(async () => {
        if (!accepting) throw new Error('route-certificate plugin disposed')
        return certifyOne({ config, runner, receiptStore, artifactReader, activeControllers, session, event, snapshot, source, preliminary })
      })
      .then((receipt) => {
        if (receipt?.idempotencyKey) completedKeys.add(receipt.idempotencyKey)
        return receipt
      })
      .catch(async (error) => {
        const receipt = indeterminateReceiptFromError(config, preliminary, error, stableErrorCode(error, 'adapter_uncaught'))
        const stored = await receiptStore.write(preliminaryKey, receipt)
        completedKeys.add(stored.idempotencyKey)
        if (config.requireCertificate) throw error
        return stored
      })
      .finally(() => {
        if (pendingBySession.get(sessionId) === task) pendingBySession.delete(sessionId)
      })
    pendingBySession.set(sessionId, task)
    return task
  }

  function dispatch(session, event, source) {
    const task = enqueue(session, event, source)
    if (config.requireCertificate) return task
    void task.catch(() => undefined)
    return undefined
  }

  function dispatchPreflightFailure(session, event, source, error) {
    const sessionId = sessionIdOf(session)
    const prior = pendingBySession.get(sessionId) ?? Promise.resolve()
    const settledPrior = config.requireCertificate ? prior : prior.catch(() => undefined)
    const task = settledPrior
      .then(() => persistPreflightFailure({ config, receiptStore, session, event, source, error }))
      .then((receipt) => {
        if (receipt?.idempotencyKey) completedKeys.add(receipt.idempotencyKey)
        return receipt
      })
      .finally(() => {
        if (pendingBySession.get(sessionId) === task) pendingBySession.delete(sessionId)
      })
    pendingBySession.set(sessionId, task)
    if (config.requireCertificate) return task
    void task.catch(() => undefined)
    return undefined
  }

  function reconcile(session) {
    if (!accepting || config.mode === 'disabled') return
    const requiredTasks = []
    let eventCount = 0
    for (const event of session.events ?? []) {
      eventCount += 1
      if (eventCount > config.maxEvents) {
        const error = Object.assign(new Error('event_count_oversize'), { code: 'event_count_oversize' })
        const task = dispatchPreflightFailure(session, event, 'session/created', error)
        if (task) requiredTasks.push(task)
        break
      }
      if (event?.type === 'turn/end') {
        const task = dispatch(session, event, 'session/created')
        if (task) requiredTasks.push(task)
      }
    }
    if (requiredTasks.length > 0) return Promise.all(requiredTasks)
  }

  async function flush(session) {
    if (!config.awaitOnFlush) return
    const sessionId = sessionIdOf(session)
    const task = pendingBySession.get(sessionId)
    if (!task) return
    if (config.requireCertificate) return task
    await task.catch(() => undefined)
  }

  return {
    start() {
      if (config.mode === 'disabled') return
      unlisteners = [
        listen(ctx, 'session/event', (session, event) => dispatch(session, event, 'session/event')),
        listen(ctx, 'session/created', (session) => reconcile(session)),
        listen(ctx, 'session/flush', (session) => flush(session)),
      ].filter(Boolean)
      for (const session of currentSessions(ctx)) {
        const task = reconcile(session)
        if (task) void task.catch(() => undefined)
      }
    },
    async dispose() {
      accepting = false
      for (const off of unlisteners.splice(0)) off()
      for (const controller of activeControllers) controller.abort(Object.assign(new Error('route-certificate plugin disposed'), { code: 'validator_aborted' }))
      await settleWithin(Promise.allSettled([...pendingBySession.values()]), config.disposeTimeoutMs)
      pendingBySession.clear()
    },
    enqueue,
    reconcile,
    flush,
    pendingBySession,
    completedKeys,
  }
}

export async function certifyOne({ config, runner, receiptStore, artifactReader, activeControllers, session, event, snapshot, source, preliminary: suppliedPreliminary }) {
  const preliminary = suppliedPreliminary ?? buildPreliminaryRequest(config, session, event, snapshot)
  const preliminaryKey = idempotencyKey(preliminary)
  let request
  try {
    request = await finalizeRequest(config, preliminary, artifactReader)
    assertByteCap(canonicalBytes(request), config.maxInputBytes, 'request_oversize')
  } catch (error) {
    return persistCertificationFailure({ config, receiptStore, key: preliminaryKey, request: preliminary, error, source })
  }
  const key = idempotencyKey(request)
  if (await receiptStore.exists(key)) return await receiptStore.read(key)
  const claim = await claimReceipt(receiptStore, key, config)
  if (!claim.owned) {
    if (claim.receipt) return claim.receipt
    return {
      ...indeterminateReceiptFromError(config, request, new Error('receipt claim wait timed out'), 'receipt_claim_wait_timeout'),
      persisted: false,
      source,
    }
  }
  try {
    if (await receiptStore.exists(key)) return await receiptStore.read(key)
    const input = canonicalBytes(request)
    const controller = new AbortController()
    activeControllers.add(controller)
    let transport
    try {
      transport = await runWithHardDeadline(runner, { input, signal: controller.signal, config, request }, controller, config.timeoutMs)
    } catch (error) {
      const reason = error?.code === 'validator_timeout'
        ? 'validator_timeout'
        : error?.code === 'validator_aborted' || controller.signal.aborted
          ? 'validator_aborted'
          : 'validator_transport'
      const receipt = { ...indeterminateReceiptFromError(config, request, error, reason), source }
      return await receiptStore.write(key, receipt)
    } finally {
      activeControllers.delete(controller)
    }
    const receipt = validateTransportAndResponse(config, request, transport, source)
    return await receiptStore.write(key, receipt)
  } finally {
    await releaseReceiptClaim(receiptStore, key, claim.token)
  }
}

async function persistPreflightFailure({ config, receiptStore, session, event, source, error }) {
  const reason = `preflight_${stableErrorCode(error, 'adapter_uncaught')}`
  const request = buildPreflightRequest(config, session, event, reason)
  const key = idempotencyKey(request)
  if (await receiptStore.exists(key)) return await receiptStore.read(key)
  const claim = await claimReceipt(receiptStore, key, config)
  if (!claim.owned) {
    if (claim.receipt) return claim.receipt
    return { ...indeterminateReceiptFromError(config, request, error, 'preflight_receipt_claim_wait_timeout'), persisted: false, source }
  }
  try {
    if (await receiptStore.exists(key)) return await receiptStore.read(key)
    const receipt = { ...indeterminateReceiptFromError(config, request, error, reason), source, persisted: true }
    return await receiptStore.write(key, receipt)
  } finally {
    await releaseReceiptClaim(receiptStore, key, claim.token)
  }
}

async function persistCertificationFailure({ config, receiptStore, key, request, error, source }) {
  if (await receiptStore.exists(key)) return await receiptStore.read(key)
  const claim = await claimReceipt(receiptStore, key, config)
  if (!claim.owned) {
    if (claim.receipt) return claim.receipt
    return { ...indeterminateReceiptFromError(config, request, error, 'receipt_claim_wait_timeout'), persisted: false, source }
  }
  try {
    if (await receiptStore.exists(key)) return await receiptStore.read(key)
    const receipt = { ...indeterminateReceiptFromError(config, request, error, stableErrorCode(error, 'adapter_uncaught')), source }
    return await receiptStore.write(key, receipt)
  } finally {
    await releaseReceiptClaim(receiptStore, key, claim.token)
  }
}

async function claimReceipt(receiptStore, key, config) {
  if (typeof receiptStore.claim !== 'function') return { owned: true, token: null }
  return receiptStore.claim(key, { waitMs: config.receiptClaimWaitMs, staleMs: config.receiptClaimStaleMs })
}

async function releaseReceiptClaim(receiptStore, key, token) {
  if (typeof receiptStore.release === 'function') await receiptStore.release(key, token)
}

async function runWithHardDeadline(runner, args, controller, timeoutMs) {
  let onAbort
  const aborted = new Promise((resolve, reject) => {
    onAbort = () => reject(controller.signal.reason ?? Object.assign(new Error('validator aborted'), { code: 'validator_aborted' }))
    controller.signal.addEventListener('abort', onAbort, { once: true })
  })
  const runnerPromise = Promise.resolve().then(() => runner(args))
  void runnerPromise.catch(() => undefined)
  const timeout = setTimeout(() => {
    controller.abort(Object.assign(new Error('validator timeout'), { name: 'AbortError', code: 'validator_timeout' }))
  }, timeoutMs)
  try {
    return await Promise.race([runnerPromise, aborted])
  } finally {
    clearTimeout(timeout)
    controller.signal.removeEventListener('abort', onAbort)
  }
}

async function settleWithin(promise, timeoutMs) {
  await Promise.race([promise, delay(timeoutMs)])
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function stableErrorCode(error, fallback) {
  const message = String(error?.code ?? error?.message ?? '')
  return /^[a-z0-9_]{1,80}$/.test(message) ? message : fallback
}

function normalizeConfig(input = {}, options = {}) {
  const packageUrl = options.packageUrl ?? import.meta.url
  const runtime = options.runtime ?? detectHarnessRuntime({ packageUrl })
  const outputDir = input.outputDir ?? defaultReceiptDir(packageUrl)
  const command = input.command ?? defaultValidatorCommand(packageUrl)
  return {
    mode: input.mode ?? 'observe',
    command,
    args: input.args ?? [],
    outputDir,
    artifactRoots: input.artifactRoots ?? [],
    policyId: input.policyId ?? BUNDLED_POLICY_SPEC.policyId,
    policyDigest: input.policyDigest ?? BUNDLED_POLICY_DIGEST,
    timeoutMs: input.timeoutMs ?? 30000,
    disposeTimeoutMs: input.disposeTimeoutMs ?? 5000,
    receiptClaimWaitMs: input.receiptClaimWaitMs ?? 35000,
    receiptClaimStaleMs: input.receiptClaimStaleMs ?? 60000,
    maxInputBytes: input.maxInputBytes ?? 8 * 1024 * 1024,
    maxOutputBytes: input.maxOutputBytes ?? 1024 * 1024,
    maxEvents: input.maxEvents ?? 2000,
    maxArtifacts: input.maxArtifacts ?? 32,
    maxArtifactBytes: input.maxArtifactBytes ?? 16 * 1024 * 1024,
    awaitOnFlush: input.awaitOnFlush ?? true,
    requireCertificate: input.requireCertificate ?? false,
    allowUnsupportedHarness: input.allowUnsupportedHarness ?? false,
    actualHarnessCommit: SUPPORTED_HARNESS.commit,
    actualHarnessPackageVersion: runtime.packageVersion ?? input.actualHarnessPackageVersion ?? null,
    expectedHarnessCommit: input.expectedHarnessCommit ?? SUPPORTED_HARNESS.commit,
    expectedHarnessPackageVersion: input.expectedHarnessPackageVersion ?? SUPPORTED_HARNESS.packageVersion,
  }
}

function validateConfig(config, overrides) {
  if (!['disabled', 'observe'].includes(config.mode)) throw new Error('mode must be disabled or observe')
  for (const [key, value] of Object.entries(config)) {
    if (SECRET_KEY_RE.test(key) && typeof value === 'string' && value) throw new Error(`secret-shaped config key is forbidden: ${key}`)
  }
  for (const field of ['timeoutMs', 'disposeTimeoutMs', 'receiptClaimWaitMs', 'receiptClaimStaleMs', 'maxInputBytes', 'maxOutputBytes', 'maxEvents', 'maxArtifacts', 'maxArtifactBytes']) {
    if (!Number.isSafeInteger(config[field]) || config[field] <= 0) throw new Error(`${field} must be a positive safe integer`)
  }
  if (config.mode === 'observe') {
    if (!config.outputDir || !isAbsolute(config.outputDir)) throw new Error('observe mode requires absolute outputDir')
    if (!config.command && !overrides.runner) throw new Error('observe mode requires command or injected runner')
    if (typeof config.actualHarnessPackageVersion !== 'string' || !config.actualHarnessPackageVersion.trim()) {
      throw new Error('observe mode requires detected DeepSeek Harness package version')
    }
    if (config.command && /[\s;&|<>$`]/.test(config.command) && !isAbsolute(config.command)) throw new Error('command must be an executable path or bare name, not a shell string')
  }
  if (!DIGEST_RE.test(config.policyDigest)) throw new Error('policyDigest must be sha256:<64 lowercase hex>')
  if (config.receiptClaimStaleMs <= Math.max(config.timeoutMs, config.receiptClaimWaitMs)) {
    throw new Error('receiptClaimStaleMs must exceed both timeoutMs and receiptClaimWaitMs')
  }
  if (!config.allowUnsupportedHarness) {
    if (config.expectedHarnessCommit !== SUPPORTED_HARNESS.commit) throw new Error(`unsupported DeepSeek Harness commit: ${config.expectedHarnessCommit}`)
    if (config.expectedHarnessPackageVersion !== SUPPORTED_HARNESS.packageVersion) throw new Error(`unsupported DeepSeek Harness package version: ${config.expectedHarnessPackageVersion}`)
    if (config.mode === 'observe' && config.actualHarnessCommit !== config.expectedHarnessCommit) throw new Error(`unsupported actual DeepSeek Harness commit: ${config.actualHarnessCommit}`)
    if (config.mode === 'observe' && config.actualHarnessPackageVersion !== config.expectedHarnessPackageVersion) throw new Error(`unsupported actual DeepSeek Harness package version: ${config.actualHarnessPackageVersion}`)
  }
  for (const root of config.artifactRoots) {
    if (!isAbsolute(root)) throw new Error('artifactRoots must be absolute paths')
  }
}

function harnessDescriptor(config) {
  return {
    repository: SUPPORTED_HARNESS.repository,
    commit: SUPPORTED_HARNESS.commit,
    packageVersion: config.actualHarnessPackageVersion,
    sessionFormatVersion: SUPPORTED_HARNESS.sessionFormatVersion,
  }
}

function defaultValidatorCommand(packageUrl = import.meta.url) {
  return join(dirname(fileURLToPath(packageUrl)), 'bin', 'routecert-local-validator.js')
}

function defaultReceiptDir(packageUrl = import.meta.url) {
  const packageDir = dirname(fileURLToPath(packageUrl))
  const profileDir = inferProfileDir(packageDir)
  if (!profileDir) return null
  return join(profileDir, '.route-certificate')
}

function inferProfileDir(packageDir) {
  let cursor = packageDir
  for (let depth = 0; depth < 16; depth += 1) {
    const base = dirname(cursor)
    if (base === cursor) return null
    if (basename(base) === 'node_modules') {
      const parent = dirname(base)
      const grandparent = dirname(parent)
      if (basename(grandparent) === '.pnpm') return dirname(dirname(grandparent))
      return parent
    }
    cursor = base
  }
  return null
}

function detectHarnessRuntime({ packageUrl = import.meta.url } = {}) {
  const candidates = []
  if (typeof process.argv[1] === 'string') candidates.push(resolve(dirname(process.argv[1]), '..', 'package.json'))
  candidates.push(resolve(dirname(fileURLToPath(packageUrl)), '..', '@deepseek-ai', 'dsh', 'package.json'))
  candidates.push(resolve(dirname(fileURLToPath(packageUrl)), '..', '..', '@deepseek-ai', 'dsh', 'package.json'))
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue
      const manifest = JSON.parse(readFileSync(candidate, 'utf8'))
      if (manifest?.name === '@deepseek-ai/dsh' && typeof manifest.version === 'string') {
        return { packageName: manifest.name, packageVersion: manifest.version, packageJson: candidate }
      }
    } catch {
      // Try the next official package surface.
    }
  }
  return { packageName: '@deepseek-ai/dsh', packageVersion: null, packageJson: null }
}

function buildPreflightRequest(config, session, endEvent, reason) {
  const isTurnEnd = endEvent?.type === 'turn/end'
  const body = {
    schema: REQUEST_SCHEMA,
    harness: harnessDescriptor(config),
    subject: {
      sessionId: sessionIdOf(session),
      turn: null,
      turnEndSeq: isTurnEnd && Number.isSafeInteger(endEvent?.seq) ? endEvent.seq : null,
      turnEndTime: isTurnEnd ? endEvent?.time ?? null : null,
      harnessReason: null,
      preflightReason: reason,
    },
    evidence: {
      eventRange: null,
      events: [],
      sessionPrefixDigest: digestJson([]),
      finalAssistantText: '',
      artifacts: [],
    },
    policy: { policyId: config.policyId, policyDigest: config.policyDigest },
  }
  return { ...body, requestId: requestIdFor(body) }
}

function collectEventPrefix(source, endEvent, maxEvents) {
  if (!Number.isSafeInteger(endEvent?.seq) || endEvent.seq < 0 || !Number.isSafeInteger(endEvent.seq + 1)) {
    throw new Error('event_sequence_invalid')
  }
  const targetLength = endEvent.seq + 1
  const events = []
  const iterator = source[Symbol.iterator]()
  let exhausted = false
  try {
    while (events.length < targetLength) {
      const next = iterator.next()
      if (next.done) {
        exhausted = true
        break
      }
      events.push(next.value)
      if (events.length > maxEvents) throw new Error('event_count_oversize')
    }
  } finally {
    if (!exhausted && typeof iterator.return === 'function') iterator.return()
  }
  return events
}

function buildPreliminaryRequest(config, session, endEvent, snapshot) {
  if (snapshot.length > config.maxEvents) throw new Error('event_count_oversize')
  assertJsonByteLowerBound(snapshot, config.maxInputBytes, 'request_oversize')
  const events = snapshot.map(cloneJson)
  const sessionId = sessionIdOf(session)
  const subject = {
    sessionId,
    turn: turnOrdinal(events, endEvent),
    turnEndSeq: endEvent.seq,
    turnEndTime: endEvent.time,
    harnessReason: sanitizeTerminalReason(endEvent.data),
  }
  const eventRange = { fromSeq: events[0]?.seq ?? 0, throughSeq: endEvent.seq }
  const evidence = {
    eventRange,
    events,
    sessionPrefixDigest: digestJson(events),
    finalAssistantText: finalAssistantText(events),
    artifacts: [],
  }
  const body = {
    schema: REQUEST_SCHEMA,
    harness: harnessDescriptor(config),
    subject,
    evidence,
    policy: {
      policyId: config.policyId,
      policyDigest: config.policyDigest,
    },
  }
  return { ...body, requestId: requestIdFor(body) }
}

async function finalizeRequest(config, request, artifactReader) {
  const artifacts = await artifactReader(request)
  if (artifacts.length > config.maxArtifacts) throw new Error('artifact_count_oversize')
  const body = {
    ...request,
    evidence: {
      ...request.evidence,
      artifacts,
    },
  }
  delete body.requestId
  return { ...body, requestId: requestIdFor(body) }
}

function validateTransportAndResponse(config, request, transport, source) {
  const stdout = String(transport?.stdout ?? '')
  const stderr = String(transport?.stderr ?? '')
  const stdoutBytes = Buffer.byteLength(stdout)
  const stderrBytes = Buffer.byteLength(stderr)
  const stdoutTruncated = Boolean(transport?.stdoutTruncated)
  const stderrTruncated = Boolean(transport?.stderrTruncated)
  const base = receiptBase(config, request, {
    source,
    transport: {
      exitCode: transport?.exitCode ?? null,
      signal: transport?.signal ?? null,
      stdoutBytes,
      stderrBytes,
      stdoutDigest: sha256Text(stdout),
      stderrDigest: sha256Text(stderr),
      stdoutTruncated,
      stderrTruncated,
    },
  })
  if (stdoutBytes > config.maxOutputBytes || stderrBytes > config.maxOutputBytes || stdoutTruncated || stderrTruncated) {
    return { ...base, outcome: 'indeterminate', reason: 'validator_output_oversize', userSummary: 'RouteCertificate validation indeterminate: validator output exceeded bounds.' }
  }
  if (containsSecretLike(stdout) || containsSecretLike(stderr)) {
    return { ...base, outcome: 'indeterminate', reason: 'secret_like_diagnostics', userSummary: 'RouteCertificate validation indeterminate: validator diagnostics looked secret-like.' }
  }
  if (transport?.exitCode !== 0 || transport?.signal) {
    return { ...base, outcome: 'indeterminate', reason: 'validator_nonzero', userSummary: 'RouteCertificate validation indeterminate: validator transport failed.' }
  }
  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return { ...base, outcome: 'indeterminate', reason: 'invalid_validator_output', userSummary: 'RouteCertificate validation indeterminate: validator returned malformed JSON.' }
  }
  const responseError = validateResponse(request, parsed)
  if (responseError) {
    return { ...base, outcome: 'indeterminate', reason: responseError, userSummary: 'RouteCertificate validation indeterminate: validator response did not match the request.' }
  }
  if (parsed.outcome === 'pass' && boundedEvidenceOmissions(request).length > 0) {
    return {
      ...base,
      outcome: 'indeterminate',
      reason: 'artifact_evidence_incomplete',
      diagnosticsDigest: digestJson(parsed.diagnostics ?? []),
      userSummary: 'RouteCertificate validation indeterminate: artifact evidence was omitted by a bounded adapter check.',
    }
  }
  return {
    ...base,
    outcome: parsed.outcome,
    reason: `validator_${parsed.outcome}`,
    checks: parsed.checks,
    certificate: parsed.certificate ?? null,
    diagnosticsDigest: digestJson(parsed.diagnostics ?? []),
    userSummary: `RouteCertificate validation ${parsed.outcome}.`,
  }
}

function validateResponse(request, response) {
  if (!isPlainObject(response)) return 'invalid_validator_output'
  const topError = exactObjectKeys(
    response,
    ['schema', 'requestId', 'outcome', 'checks', 'evidenceDigest', 'policyDigest', 'diagnostics'],
    ['certificate'],
  )
  if (topError) return 'validator_response_keys_invalid'
  if (response.schema !== RESPONSE_SCHEMA) return 'validator_schema_mismatch'
  if (response.requestId !== request.requestId) return 'validator_request_mismatch'
  if (!OUTCOMES.has(response.outcome)) return 'validator_outcome_invalid'
  if (response.evidenceDigest !== digestJson(request.evidence)) return 'validator_evidence_mismatch'
  if (response.policyDigest !== request.policy.policyDigest) return 'validator_policy_mismatch'
  if (!Array.isArray(response.checks) || response.checks.length > 256) return 'validator_checks_invalid'
  const ids = new Set()
  for (const check of response.checks) {
    if (!isPlainObject(check) || exactObjectKeys(check, ['id', 'outcome'], ['evidence'])) return 'validator_checks_invalid'
    if (typeof check.id !== 'string' || check.id !== check.id.trim() || !check.id || check.id.length > 128 || ids.has(check.id)) return 'validator_checks_invalid'
    if (!OUTCOMES.has(check.outcome)) return 'validator_checks_invalid'
    ids.add(check.id)
    if ('evidence' in check && boundedJsonError(check.evidence)) return 'validator_checks_invalid'
  }
  if (!Array.isArray(response.diagnostics) || response.diagnostics.length > 128) return 'validator_diagnostics_invalid'
  for (const row of response.diagnostics) {
    if (!(typeof row === 'string' || isPlainObject(row)) || boundedJsonError(row)) return 'validator_diagnostics_invalid'
  }
  if (canonicalBytes(response.diagnostics).length > 64 * 1024) return 'validator_diagnostics_invalid'
  if ('certificate' in response) {
    if (!isPlainObject(response.certificate) || boundedJsonError(response.certificate) || canonicalBytes(response.certificate).length > 64 * 1024) return 'validator_certificate_invalid'
  }
  try {
    canonicalBytes(response)
  } catch {
    return 'validator_response_noncanonical_domain'
  }
  return null
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function exactObjectKeys(value, required, optional = []) {
  const keys = Object.keys(value)
  const allowed = new Set([...required, ...optional])
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) return true
  return keys.some((key) => !allowed.has(key))
}

function boundedJsonError(value, depth = 0, state = { nodes: 0 }) {
  state.nodes += 1
  if (state.nodes > 2048 || depth > 8) return true
  if (value === null || typeof value === 'boolean') return false
  if (typeof value === 'number') return !Number.isFinite(value)
  if (typeof value === 'string') return value.length > 8192 || containsSecretLike(value)
  if (Array.isArray(value)) {
    if (value.length > 256) return true
    return value.some((row) => boundedJsonError(row, depth + 1, state))
  }
  if (!isPlainObject(value)) return true
  const keys = Object.keys(value)
  if (keys.length > 128) return true
  for (const key of keys) {
    if (!key || key.length > 128 || SECRET_KEY_RE.test(key) || boundedJsonError(value[key], depth + 1, state)) return true
  }
  return false
}

function indeterminateReceiptFromError(config, request, error, reason) {
  return {
    ...receiptBase(config, request, {
      transport: {
        exitCode: null,
        signal: error?.name === 'AbortError' ? 'ABORT' : null,
        stdoutBytes: 0,
        stderrBytes: 0,
        stdoutDigest: sha256Text(''),
        stderrDigest: sha256Text(''),
      },
    }),
    outcome: 'indeterminate',
    reason,
    errorName: error?.name ?? 'Error',
    userSummary: `RouteCertificate validation indeterminate: ${reason}.`,
  }
}

function boundedEvidenceOmissions(request) {
  const artifacts = Array.isArray(request?.evidence?.artifacts) ? request.evidence.artifacts : []
  const omissions = []
  for (const row of artifacts) {
    if (!isPlainObject(row) || row.omitted !== true) continue
    omissions.push({
      eventSeq: Number.isSafeInteger(row.eventSeq) ? row.eventSeq : null,
      reason: typeof row.reason === 'string' && /^[a-z0-9_]{1,80}$/.test(row.reason) ? row.reason : 'artifact_omitted',
      size: Number.isSafeInteger(row.size) && row.size >= 0 ? row.size : null,
    })
  }
  return omissions
}

function receiptBase(config, request, extra = {}) {
  const evidenceDigest = digestJson(request.evidence)
  const key = idempotencyKey({ ...request, evidenceDigest })
  const omissions = boundedEvidenceOmissions(request)
  return {
    schema: RECEIPT_SCHEMA,
    createdAt: new Date().toISOString(),
    idempotencyKey: key,
    requestId: request.requestId,
    evidenceDigest,
    policyDigest: request.policy.policyDigest,
    harness: request.harness,
    subject: request.subject,
    requireCertificate: config.requireCertificate,
    rawDiagnosticsSeparated: true,
    ...(omissions.length > 0 ? { evidenceOmissions: omissions } : {}),
    ...extra,
  }
}

function idempotencyKey(request) {
  const evidenceDigest = request.evidenceDigest ?? digestJson(request.evidence)
  return sha256Text(`${request.subject.sessionId}\n${request.subject.turn}\n${request.subject.turnEndSeq}\n${evidenceDigest}\n${request.policy.policyDigest}`)
}

function requestIdFor(body) {
  return sha256Text(canonicalString(body))
}

function turnOrdinal(events, endEvent) {
  return events.filter((event) => event.type === 'turn/end' && event.seq <= endEvent.seq).length
}

function finalAssistantText(events) {
  for (let idx = events.length - 1; idx >= 0; idx -= 1) {
    const event = events[idx]
    if (event.type === 'assistant/message') {
      const data = event.data ?? {}
      if (typeof data.text === 'string') return data.text
      if (typeof data.content === 'string') return data.content
      if (Array.isArray(data.content)) return data.content.map((part) => typeof part?.text === 'string' ? part.text : '').join('')
    }
  }
  return ''
}

function sessionIdOf(session) {
  return String(session?.id ?? session?.header?.id ?? session?.header?.sessionId ?? 'unknown-session')
}

function createFileReceiptStore(outputDir) {
  return {
    async exists(key) {
      try {
        await stat(receiptPath(outputDir, key))
        return true
      } catch (error) {
        if (error?.code === 'ENOENT') return false
        throw error
      }
    },
    async read(key) {
      return JSON.parse(await readFile(receiptPath(outputDir, key), 'utf8'))
    },
    async write(key, receipt) {
      const target = receiptPath(outputDir, key)
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      const temp = `${target}.${process.pid}.${Date.now()}.${randomBytes(8).toString('hex')}.tmp`
      await writeFile(temp, `${canonicalString(receipt)}\n`, { mode: 0o600, flag: 'wx' })
      try {
        await link(temp, target)
        return receipt
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        return await this.read(key)
      } finally {
        await unlink(temp).catch(() => undefined)
      }
    },
    async claim(key, { waitMs, staleMs }) {
      const target = claimPath(outputDir, key)
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      const token = randomBytes(16).toString('hex')
      const deadline = Date.now() + waitMs
      while (true) {
        try {
          const handle = await open(target, 'wx', 0o600)
          try {
            await handle.writeFile(`${canonicalString({ token, pid: process.pid, createdAtMs: Date.now() })}\n`, 'utf8')
          } finally {
            await handle.close()
          }
          if (await this.exists(key)) {
            const receipt = await this.read(key)
            await this.release(key, token)
            return { owned: false, receipt }
          }
          return { owned: true, token }
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error
        }
        if (await this.exists(key)) return { owned: false, receipt: await this.read(key) }
        try {
          const info = await stat(target)
          if (Date.now() - info.mtimeMs > staleMs) {
            const quarantine = `${target}.${Date.now()}.${token}.stale`
            try {
              await rename(target, quarantine)
              await unlink(quarantine).catch(() => undefined)
              continue
            } catch (error) {
              if (!['ENOENT', 'EEXIST'].includes(error?.code)) throw error
            }
          }
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
          continue
        }
        if (Date.now() >= deadline) return { owned: false, receipt: null, reason: 'receipt_claim_wait_timeout' }
        await delay(Math.min(25, Math.max(1, deadline - Date.now())))
      }
    },
    async release(key, token) {
      if (!token) return
      const target = claimPath(outputDir, key)
      let row
      try {
        row = JSON.parse(await readFile(target, 'utf8'))
      } catch (error) {
        if (error?.code === 'ENOENT') return
        return
      }
      if (row?.token === token) await unlink(target).catch(() => undefined)
    },
  }
}

function receiptPath(outputDir, key) {
  if (!DIGEST_RE.test(key)) throw new Error('invalid receipt key')
  return join(outputDir, 'receipts', `${key.slice('sha256:'.length)}.json`)
}

function claimPath(outputDir, key) {
  if (!DIGEST_RE.test(key)) throw new Error('invalid receipt key')
  return join(outputDir, 'receipts', `${key.slice('sha256:'.length)}.claim`)
}

function createArtifactReader(config) {
  return async (request) => {
    const candidates = collectArtifactCandidates(request.evidence.events)
    if (candidates.length > config.maxArtifacts) throw new Error('artifact_count_oversize')
    const out = []
    for (const candidate of candidates) {
      out.push(await safeArtifactDescriptor(config, candidate))
    }
    return out
  }
}

function isPathWithin(root, candidate, pathApi = pathModule) {
  const relativePath = pathApi.relative(root, candidate)
  return relativePath === '' || (
    relativePath !== '..'
    && !relativePath.startsWith(`..${pathApi.sep}`)
    && !pathApi.isAbsolute(relativePath)
  )
}

function collectArtifactCandidates(events) {
  const candidates = []
  for (const event of events) {
    const data = event.data
    if (!data || typeof data !== 'object') continue
    const maybe = data.artifacts ?? data.artifact ?? data.path
    const rows = Array.isArray(maybe) ? maybe : maybe ? [maybe] : []
    for (const row of rows) {
      if (typeof row === 'string') candidates.push({ path: row, eventSeq: event.seq })
      else if (row && typeof row.path === 'string') candidates.push({ ...row, eventSeq: event.seq })
    }
  }
  return candidates
}

async function safeArtifactDescriptor(config, candidate, testHooks = {}) {
  const candidatePath = String(candidate.path)
  if (!isAbsolute(candidatePath)) return omittedArtifact(candidate, 'artifact_path_not_absolute')
  const roots = []
  for (const root of config.artifactRoots) roots.push(await realpath(root))
  let resolved
  try {
    resolved = await realpath(candidatePath)
  } catch {
    return omittedArtifact(candidate, 'artifact_missing')
  }
  if (!roots.some((root) => isPathWithin(root, resolved))) return omittedArtifact(candidate, 'artifact_outside_allowlist')
  if (typeof testHooks.afterCandidateRealpath === 'function') await testHooks.afterCandidateRealpath({ candidatePath, resolved, roots: [...roots] })
  const handle = await open(resolved, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(() => null)
  if (!handle) return omittedArtifact(candidate, 'artifact_symlink_or_unopenable')
  try {
    const before = await handle.stat()
    if (!before.isFile()) return omittedArtifact(candidate, 'artifact_not_regular_file')
    if (before.size > config.maxArtifactBytes) return omittedArtifact(candidate, 'artifact_oversize', before.size)
    const bounded = await readBoundedFile(handle, config.maxArtifactBytes)
    if (bounded.oversize) return omittedArtifact(candidate, 'artifact_oversize', bounded.size)
    const bytes = bounded.bytes
    const handleAfter = await handle.stat()
    let pathAfter
    let resolvedAfter
    try {
      ;[pathAfter, resolvedAfter] = await Promise.all([stat(resolved), realpath(candidatePath)])
    } catch {
      return omittedArtifact(candidate, 'artifact_race_detected', before.size)
    }
    const stable = resolvedAfter === resolved
      && roots.some((root) => isPathWithin(root, resolvedAfter))
      && bytes.length === before.size
      && sameFileSnapshot(before, handleAfter)
      && sameFileSnapshot(before, pathAfter)
    if (!stable) return omittedArtifact(candidate, 'artifact_race_detected', before.size)
    return {
      name: String(candidate.name ?? candidate.logicalName ?? `artifact-${candidate.eventSeq}`),
      eventSeq: candidate.eventSeq,
      size: bytes.length,
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      mediaType: String(candidate.mediaType ?? 'application/octet-stream'),
      handle: `artifact:${sha256Text(resolved).slice('sha256:'.length)}`,
    }
  } finally {
    await handle.close()
  }
}

async function readBoundedFile(handle, maxBytes) {
  const chunks = []
  let total = 0
  let position = 0
  while (true) {
    const remaining = maxBytes + 1 - total
    if (remaining <= 0) return { oversize: true, size: total }
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining))
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, position)
    if (bytesRead === 0) break
    chunks.push(chunk.subarray(0, bytesRead))
    total += bytesRead
    position += bytesRead
    if (total > maxBytes) return { oversize: true, size: total }
  }
  return { oversize: false, size: total, bytes: Buffer.concat(chunks, total) }
}

function sameFileSnapshot(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
}

function omittedArtifact(candidate, reason, size = null) {
  return {
    name: String(candidate.name ?? candidate.logicalName ?? `artifact-${candidate.eventSeq ?? 'unknown'}`),
    eventSeq: candidate.eventSeq ?? null,
    omitted: true,
    reason,
    size,
  }
}

function createSubprocessRunner(ctx, config) {
  const subprocess = ctx?.reflect && typeof ctx.reflect.get === 'function'
    ? ctx.reflect.get('subprocess')
    : ctx?.subprocess
  if (!subprocess || typeof subprocess.spawn !== 'function' || !config.command) {
    return createNodeSubprocessRunner(config)
  }
  return async ({ input, signal }) => {
    await mkdir(config.outputDir, { recursive: true, mode: 0o700 })
    const handle = await subprocess.spawn({
      argv: [config.command, ...config.args],
      cwd: config.outputDir,
      stdio: {
        stdin: { data: input },
        stdout: { maxBytes: config.maxOutputBytes },
        stderr: { maxBytes: config.maxOutputBytes },
      },
      graceMs: Math.min(5000, config.timeoutMs),
      signal,
      env: scrubExplicitEnv({}),
    })
    const outcome = await handle.done
    const stdout = await readCollected(handle, 'stdout')
    const stderr = await readCollected(handle, 'stderr')
    return {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
    }
  }
}

function createNodeSubprocessRunner(config) {
  return async ({ input, signal }) => await new Promise((resolve, reject) => {
    mkdir(config.outputDir, { recursive: true, mode: 0o700 }).then(() => {
    const child = spawn(config.command, config.args, {
      cwd: config.outputDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: scrubExplicitEnv({ PATH: process.env.PATH ?? '' }),
    })
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let stdoutTruncated = false
    let stderrTruncated = false
    const append = (current, chunk, stream) => {
      const limit = config.maxOutputBytes + 1
      const markTruncated = () => {
        if (stream === 'stdout') stdoutTruncated = true
        else stderrTruncated = true
      }
      if (current.length >= limit) {
        markTruncated()
        return current
      }
      const remaining = limit - current.length
      if (chunk.length > remaining) {
        markTruncated()
        return Buffer.concat([current, chunk.subarray(0, remaining)], limit)
      }
      return Buffer.concat([current, chunk], current.length + chunk.length)
    }
    const abort = () => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), Math.min(1000, config.timeoutMs)).unref()
    }
    signal.addEventListener('abort', abort, { once: true })
    child.once('error', reject)
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk, 'stdout') })
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk, 'stderr') })
    child.once('close', (exitCode, childSignal) => {
      signal.removeEventListener('abort', abort)
      resolve({
        exitCode,
        signal: childSignal,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        stdoutTruncated,
        stderrTruncated,
      })
    })
    child.stdin.end(input)
    }).catch(reject)
  })
}

async function readCollected(handle, stream) {
  const reader = handle?.collected?.[stream]
  if (!reader) return { text: '', truncated: false }
  if (typeof reader.readFrom === 'function') {
    const out = await reader.readFrom(0)
    return { text: out.text ?? '', truncated: Boolean(out.lossy) }
  }
  if (typeof reader.text === 'string') {
    return { text: reader.text, truncated: Boolean(reader.truncated ?? reader.lossy) }
  }
  return { text: '', truncated: false }
}

function scrubExplicitEnv(env) {
  const out = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !SECRET_KEY_RE.test(key) && !key.toUpperCase().startsWith('DSH_')) out[key] = value
  }
  return out
}

function listen(ctx, event, fn) {
  const result = ctx.on?.(event, fn)
  if (typeof result === 'function') return result
  if (result && typeof result.dispose === 'function') return () => result.dispose()
  if (result && typeof result[Symbol.dispose] === 'function') return () => result[Symbol.dispose]()
  return null
}

function currentSessions(ctx) {
  const store = ctx?.sessions
  if (!store) return []
  if (typeof store.values === 'function') return Array.from(store.values())
  if (Array.isArray(store.sessions)) return store.sessions
  return []
}

function assertJsonByteLowerBound(value, max, code) {
  let total = 0
  const active = new WeakSet()
  const stack = [{ kind: 'value', value }]
  const add = (amount) => {
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > max - total) throw new Error(code)
    total += amount
  }
  const ownEntries = function* (object) {
    for (const key in object) {
      if (Object.prototype.hasOwnProperty.call(object, key)) yield [key, object[key]]
    }
  }

  while (stack.length > 0) {
    const frame = stack.pop()
    if (frame.kind === 'exit') {
      active.delete(frame.value)
      continue
    }
    if (frame.kind === 'array') {
      if (frame.index >= frame.value.length) continue
      stack.push({ ...frame, index: frame.index + 1 })
      stack.push({ kind: 'value', value: frame.value[frame.index] })
      continue
    }
    if (frame.kind === 'object') {
      const next = frame.iterator.next()
      if (next.done) continue
      const [key, child] = next.value
      const childType = typeof child
      const omitted = childType === 'undefined' || childType === 'function' || childType === 'symbol'
        || (child !== null && childType === 'object' && typeof child.toJSON === 'function')
      if (omitted) {
        stack.push(frame)
        continue
      }
      add(key.length + 3 + (frame.first ? 0 : 1))
      stack.push({ ...frame, first: false })
      stack.push({ kind: 'value', value: child })
      continue
    }

    const current = frame.value
    if (current === null) {
      add(4)
    } else if (typeof current === 'string') {
      add(current.length + 2)
    } else if (typeof current === 'boolean') {
      add(current ? 4 : 5)
    } else if (typeof current === 'number' || typeof current === 'bigint') {
      add(1)
    } else if (typeof current === 'object') {
      if (typeof current.toJSON === 'function') continue
      if (active.has(current)) continue
      active.add(current)
      stack.push({ kind: 'exit', value: current })
      if (Array.isArray(current)) {
        add(2 + Math.max(0, current.length - 1))
        stack.push({ kind: 'array', value: current, index: 0 })
      } else {
        add(2)
        stack.push({ kind: 'object', iterator: ownEntries(current), first: true })
      }
    }
  }
}

function assertByteCap(bytes, max, code) {
  const size = typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.length
  if (size > max) throw new Error(code)
}

function containsSecretLike(value) {
  return SECRET_VALUE_RE.test(String(value))
}

function canonicalBytes(value) {
  return Buffer.from(canonicalString(value), 'utf8')
}

function canonicalString(value) {
  return JSON.stringify(sortJson(cloneJson(value)))
}

function sortJson(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(sortJson)
  const out = {}
  for (const key of Object.keys(value).sort()) out[key] = sortJson(value[key])
  return out
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function digestJson(value) {
  return sha256Text(canonicalString(value))
}

function sha256Text(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`
}

export const __testing = {
  SUPPORTED_HARNESS,
  REQUEST_SCHEMA,
  RESPONSE_SCHEMA,
  RECEIPT_SCHEMA,
  BUNDLED_POLICY_SPEC,
  BUNDLED_POLICY_DIGEST,
  sanitizeTerminalReason,
  buildPreliminaryRequest,
  finalizeRequest,
  validateResponse,
  validateTransportAndResponse,
  createFileReceiptStore,
  safeArtifactDescriptor,
  isPathWithin,
  pathApis: { posix: pathModule.posix, win32: pathModule.win32 },
  collectArtifactCandidates,
  canonicalString,
  digestJson,
  idempotencyKey,
  normalizeConfig,
  validateConfig,
  harnessDescriptor,
  buildPreflightRequest,
  defaultReceiptDir,
  defaultValidatorCommand,
  detectHarnessRuntime,
  inferProfileDir,
  claimPath,
  symlink,
  unlink,
  fileURLToPath,
  resolve,
}
