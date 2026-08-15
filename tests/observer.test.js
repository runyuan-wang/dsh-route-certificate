import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { __testing, createRouteCertificateObserver } from '../testing.js'

function tempRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-route-cert-'))
}

function makeCtx(session) {
  const handlers = new Map()
  return {
    sessions: {
      values: () => session ? [session] : [],
    },
    on(event, fn) {
      const rows = handlers.get(event) ?? []
      rows.push(fn)
      handlers.set(event, rows)
      return () => {
        const next = (handlers.get(event) ?? []).filter((row) => row !== fn)
        handlers.set(event, next)
      }
    },
    emit(event, ...args) {
      return Promise.all((handlers.get(event) ?? []).map((fn) => fn(...args)))
    },
    count(event) {
      return (handlers.get(event) ?? []).length
    },
  }
}

function makeSession(events = []) {
  return {
    id: 'sess-1',
    header: { id: 'sess-1', version: 0, cwd: '/tmp' },
    events,
  }
}

function turnEnd(seq, reason = { kind: 'completed' }) {
  return { type: 'turn/end', seq, time: 1800000000000 + seq, data: reason }
}

function assistant(seq, text) {
  return { type: 'assistant/message', seq, time: 1800000000000 + seq, data: { text } }
}

function config(outputDir, extra = {}) {
  return {
    mode: 'observe',
    outputDir,
    policyDigest: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
    actualHarnessCommit: __testing.SUPPORTED_HARNESS.commit,
    actualHarnessPackageVersion: __testing.SUPPORTED_HARNESS.packageVersion,
    ...extra,
  }
}

function responseFor(request, outcome = 'pass') {
  return {
    schema: __testing.RESPONSE_SCHEMA,
    requestId: request.requestId,
    outcome,
    checks: [{ id: 'fixture', outcome }],
    evidenceDigest: __testing.digestJson(request.evidence),
    policyDigest: request.policy.policyDigest,
    diagnostics: [],
  }
}

test('successful receipt preserves raw events and writes once', async () => {
  const root = await tempRoot()
  try {
    const session = makeSession([assistant(0, 'done'), turnEnd(1)])
    const ctx = makeCtx(null)
    let calls = 0
    const runner = async ({ input, request }) => {
      calls += 1
      assert.deepEqual(JSON.parse(input).evidence.events, session.events)
      return { exitCode: 0, signal: null, stdout: JSON.stringify(responseFor(request)), stderr: '' }
    }
    const observer = createRouteCertificateObserver(ctx, config(root), { runner })
    observer.start()
    await observer.enqueue(session, session.events[1], 'test')
    await observer.enqueue(session, session.events[1], 'duplicate')
    assert.equal(calls, 1)
    const key = [...observer.completedKeys][0]
    const receipt = JSON.parse(await readFile(join(root, 'receipts', `${key.slice(7)}.json`), 'utf8'))
    assert.equal(receipt.outcome, 'pass')
    assert.equal(receipt.rawDiagnosticsSeparated, true)
    assert.equal(receipt.subject.turnEndSeq, 1)
    await observer.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('validator nonzero, malformed, oversize, timeout, and secret-like diagnostics are indeterminate', async () => {
  const cases = [
    ['nonzero', async () => ({ exitCode: 2, signal: null, stdout: '{}', stderr: 'bad' }), 'validator_nonzero'],
    ['malformed', async () => ({ exitCode: 0, signal: null, stdout: '{', stderr: '' }), 'invalid_validator_output'],
    ['oversize', async () => ({ exitCode: 0, signal: null, stdout: 'x'.repeat(64), stderr: '' }), 'validator_output_oversize'],
    ['secret', async () => ({ exitCode: 0, signal: null, stdout: '{}', stderr: 'Bearer abcdefghijklmnop' }), 'secret_like_diagnostics'],
    ['timeout', async ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    }), 'validator_timeout'],
  ]
  for (const [name, runner, reason] of cases) {
    const root = await tempRoot()
    try {
      const session = makeSession([turnEnd(0)])
      const observer = createRouteCertificateObserver(makeCtx(null), config(root, { maxOutputBytes: 32, timeoutMs: 5 }), { runner })
      const receipt = await observer.enqueue(session, session.events[0], name)
      assert.equal(receipt.outcome, 'indeterminate', name)
      assert.equal(receipt.reason, reason, name)
      await observer.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test('cold history reconciliation certifies missed terminal turns idempotently', async () => {
  const root = await tempRoot()
  try {
    const session = makeSession([turnEnd(0, { kind: 'interrupted' }), assistant(1, 'later'), turnEnd(2)])
    const ctx = makeCtx(session)
    let calls = 0
    const runner = async ({ request }) => {
      calls += 1
      return { exitCode: 0, signal: null, stdout: JSON.stringify(responseFor(request, 'pass')), stderr: '' }
    }
    const observer = createRouteCertificateObserver(ctx, config(root), { runner })
    observer.start()
    await observer.flush(session)
    assert.equal(calls, 2)
    observer.reconcile(session)
    await observer.flush(session)
    assert.equal(calls, 2)
    await observer.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('artifact allowlist handles traversal, symlink, race, and size limits', async () => {
  const root = await tempRoot()
  try {
    const allowed = join(root, 'allowed')
    const outside = join(root, 'outside.txt')
    await mkdir(allowed)
    await writeFile(join(allowed, 'ok.txt'), 'ok')
    await writeFile(join(allowed, 'big.txt'), '123456')
    await writeFile(outside, 'no')
    await symlink(outside, join(allowed, 'link.txt'))
    const cfg = config(root, { artifactRoots: [allowed], maxArtifactBytes: 4 })
    const ok = await __testing.safeArtifactDescriptor(cfg, { path: join(allowed, 'ok.txt'), eventSeq: 1 })
    assert.equal(ok.sha256, 'sha256:2689367b205c16ce32ed4200942b8b8b1e262dfc70d9bc9fbc77c49699a4f1df')
    assert.equal((await __testing.safeArtifactDescriptor(cfg, { path: outside, eventSeq: 1 })).reason, 'artifact_outside_allowlist')
    assert.equal((await __testing.safeArtifactDescriptor(cfg, { path: join(allowed, 'link.txt'), eventSeq: 1 })).reason, 'artifact_outside_allowlist')
    assert.equal((await __testing.safeArtifactDescriptor(cfg, { path: join(allowed, 'big.txt'), eventSeq: 1 })).reason, 'artifact_oversize')
    assert.equal((await __testing.safeArtifactDescriptor(cfg, { path: '../x', eventSeq: 1 })).reason, 'artifact_path_not_absolute')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cancellation and disposal abort active validation and remove listeners', async () => {
  const root = await tempRoot()
  try {
    const session = makeSession([turnEnd(0)])
    const ctx = makeCtx(null)
    let aborted = false
    let markStarted
    const started = new Promise((resolve) => { markStarted = resolve })
    const runner = async ({ signal }) => new Promise((resolve, reject) => {
      markStarted()
      signal.addEventListener('abort', () => {
        aborted = true
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      })
    })
    const observer = createRouteCertificateObserver(ctx, config(root), { runner })
    observer.start()
    const task = observer.enqueue(session, session.events[0], 'test')
    await started
    await observer.dispose()
    await task
    assert.equal(aborted, true)
    assert.equal(ctx.count('session/event'), 0)
    assert.equal(ctx.count('session/created'), 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('unsupported platform and inactive observe mode fail closed', async () => {
  const root = await tempRoot()
  try {
    assert.throws(() => createRouteCertificateObserver(makeCtx(null), config(root, { command: 'echo hi' })), /shell string/)
    assert.throws(() => createRouteCertificateObserver(makeCtx(null), config(root, { policyDigest: 'bad' }), { runner: async () => ({}) }), /policyDigest/)
    assert.throws(() => createRouteCertificateObserver(makeCtx(null), config(root, { expectedHarnessPackageVersion: '0.1.0-rc.5' }), { runner: async () => ({}) }), /unsupported DeepSeek Harness package version/)
    assert.doesNotThrow(() => createRouteCertificateObserver(makeCtx(null), config(root, { expectedHarnessPackageVersion: '0.1.0-rc.5', allowUnsupportedHarness: true }), { runner: async () => ({}) }))
    assert.throws(
      () => createRouteCertificateObserver(makeCtx(null), config(root, { timeoutMs: 100, receiptClaimWaitMs: 200, receiptClaimStaleMs: 200 }), { runner: async () => ({}) }),
      /receiptClaimStaleMs must exceed/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('persisted terminal summary excludes raw secret and oversized error payloads', async () => {
  const root = await tempRoot()
  try {
    const event = turnEnd(0, {
      turn: 1,
      reason: {
        kind: 'error',
        error: {
          status: 503,
          code: 'sk-not-a-safe-code',
          message: `Bearer ${'x'.repeat(256)}`,
          nested: { authorization: 'private-value', detail: 'y'.repeat(5000) },
        },
      },
    })
    const session = makeSession([event])
    const request = __testing.buildPreliminaryRequest(__testing.normalizeConfig(config(root)), session, event, session.events)
    assert.deepEqual(request.subject.harnessReason, { kind: 'error', status: 503 })
    const persistedSubject = __testing.canonicalString(request.subject)
    assert.doesNotMatch(persistedSubject, /Bearer|authorization|private-value|x{20}|y{20}/)

    const oversizedKind = turnEnd(1, { turn: 2, reason: { kind: 'z'.repeat(1000) } })
    const second = makeSession([event, oversizedKind])
    const secondRequest = __testing.buildPreliminaryRequest(__testing.normalizeConfig(config(root)), second, oversizedKind, second.events)
    assert.deepEqual(secondRequest.subject.harnessReason, { kind: 'unknown' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('component-aware containment handles POSIX and Windows roots', () => {
  const { posix, win32 } = __testing.pathApis
  assert.equal(__testing.isPathWithin('/allowed', '/allowed/nested/file.txt', posix), true)
  assert.equal(__testing.isPathWithin('/allowed', '/allowed-other/file.txt', posix), false)
  assert.equal(__testing.isPathWithin('C:\\allowed', 'C:\\allowed\\nested\\file.txt', win32), true)
  assert.equal(__testing.isPathWithin('C:\\allowed', 'C:\\allowed-other\\file.txt', win32), false)
  assert.equal(__testing.isPathWithin('C:\\allowed', 'D:\\allowed\\file.txt', win32), false)
})

test('advisory event dispatch contains receipt-store failure without altering raw session flow', async () => {
  const root = await tempRoot()
  const unhandled = []
  const onUnhandled = (reason) => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    const event = turnEnd(0)
    const session = makeSession([event])
    const ctx = makeCtx(null)
    const receiptStore = {
      exists: async () => false,
      read: async () => undefined,
      claim: async () => ({ owned: true, token: 'claim' }),
      release: async () => {},
      write: async () => { throw new Error('receipt disk unavailable') },
    }
    const observer = createRouteCertificateObserver(ctx, config(root), {
      receiptStore,
      runner: async ({ request }) => ({ exitCode: 0, signal: null, stdout: JSON.stringify(responseFor(request)), stderr: '' }),
    })
    observer.start()
    await ctx.emit('session/event', session, event)
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.deepEqual(session.events, [event])
    assert.deepEqual(unhandled, [])
    await observer.dispose()
  } finally {
    process.off('unhandledRejection', onUnhandled)
    await rm(root, { recursive: true, force: true })
  }
})

test('requireCertificate preserves receipt-store failure propagation', async () => {
  const root = await tempRoot()
  try {
    const event = turnEnd(0)
    const session = makeSession([event])
    const receiptStore = {
      exists: async () => false,
      read: async () => undefined,
      claim: async () => ({ owned: true, token: 'claim' }),
      release: async () => {},
      write: async () => { throw new Error('receipt disk unavailable') },
    }
    const observer = createRouteCertificateObserver(makeCtx(null), config(root, { requireCertificate: true }), {
      receiptStore,
      runner: async ({ request }) => ({ exitCode: 0, signal: null, stdout: JSON.stringify(responseFor(request)), stderr: '' }),
    })
    await assert.rejects(observer.enqueue(session, event, 'required'), /receipt disk unavailable/)
    await observer.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
