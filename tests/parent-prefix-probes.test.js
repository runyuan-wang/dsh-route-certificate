import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { __testing, createRouteCertificateObserver } from '../testing.js'

function tempRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-route-cert-parent-probe-'))
}

function makeCtx() {
  return {
    sessions: { values: () => [] },
    on() { return () => {} },
  }
}

function turnEnd(seq, data = { kind: 'completed' }) {
  return { type: 'turn/end', seq, time: 1800000000000 + seq, data }
}

function makeSession(events, id = 'parent-probe-session') {
  return { id, header: { id, version: 0, cwd: '/tmp' }, events }
}

function config(outputDir, extra = {}) {
  return {
    mode: 'observe',
    outputDir,
    policyDigest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    actualHarnessCommit: __testing.SUPPORTED_HARNESS.commit,
    actualHarnessPackageVersion: __testing.SUPPORTED_HARNESS.packageVersion,
    ...extra,
  }
}

function responseFor(request, extra = {}) {
  return {
    schema: __testing.RESPONSE_SCHEMA,
    requestId: request.requestId,
    outcome: 'pass',
    checks: [{ id: 'parent-probe', outcome: 'pass' }],
    evidenceDigest: __testing.digestJson(request.evidence),
    policyDigest: request.policy.policyDigest,
    diagnostics: [],
    ...extra,
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('observe mode requires explicit actual Harness runtime attestation', async () => {
  const root = await tempRoot()
  try {
    assert.throws(
      () => createRouteCertificateObserver(makeCtx(), {
        mode: 'observe',
        outputDir: root,
        policyDigest: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
      }, { runner: async () => ({}) }),
      /actual Harness runtime attestation/i,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('disabled default remains a no-op without actual Harness attestation', async () => {
  const observer = createRouteCertificateObserver(makeCtx(), { mode: 'disabled' })
  assert.equal(await observer.enqueue(makeSession([turnEnd(0)]), turnEnd(0), 'disabled-default'), undefined)
  await observer.dispose()
})

test('declared artifact overflow is indeterminate before validator invocation', async () => {
  const root = await tempRoot()
  try {
    const allowed = join(root, 'allowed')
    await mkdir(allowed)
    const first = join(allowed, 'first.txt')
    const second = join(allowed, 'second.txt')
    await writeFile(first, 'first')
    await writeFile(second, 'second')
    const event = turnEnd(0, { kind: 'completed', artifacts: [first, second] })
    const session = makeSession([event])
    let calls = 0
    const runner = async ({ request }) => {
      calls += 1
      return { exitCode: 0, signal: null, stdout: JSON.stringify(responseFor(request)), stderr: '' }
    }
    const observer = createRouteCertificateObserver(
      makeCtx(),
      config(root, { artifactRoots: [allowed], maxArtifacts: 1 }),
      { runner },
    )
    const receipt = await observer.enqueue(session, event, 'parent-probe')
    assert.equal(calls, 0)
    assert.equal(receipt.outcome, 'indeterminate')
    assert.equal(receipt.reason, 'artifact_count_oversize')
    await observer.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pre-queue event overflow resolves to a persisted preflight receipt instead of escaping', async () => {
  const root = await tempRoot()
  try {
    const events = [turnEnd(0), turnEnd(1)]
    const session = makeSession(events)
    let calls = 0
    const observer = createRouteCertificateObserver(
      makeCtx(),
      config(root, { maxEvents: 1 }),
      { runner: async () => { calls += 1; return {} } },
    )
    const receipt = await observer.enqueue(session, events[1], 'parent-probe')
    assert.equal(calls, 0)
    assert.equal(receipt.outcome, 'indeterminate')
    assert.match(receipt.reason, /^preflight_/)
    assert.match(receipt.idempotencyKey, /^sha256:[0-9a-f]{64}$/)
    await observer.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('plugin-owned deadline and disposal remain bounded when runner ignores AbortSignal', async () => {
  const root = await tempRoot()
  try {
    const event = turnEnd(0)
    const session = makeSession([event])
    const runner = async () => new Promise(() => {})
    const observer = createRouteCertificateObserver(
      makeCtx(),
      config(root, { timeoutMs: 10, disposeTimeoutMs: 25 }),
      { runner },
    )
    const task = observer.enqueue(session, event, 'parent-probe')
    const taskResult = await Promise.race([task, delay(80).then(() => 'HUNG')])
    const disposeResult = await Promise.race([observer.dispose().then(() => 'DONE'), delay(80).then(() => 'HUNG')])
    assert.notEqual(taskResult, 'HUNG')
    assert.equal(taskResult.outcome, 'indeterminate')
    assert.equal(taskResult.reason, 'validator_timeout')
    assert.equal(disposeResult, 'DONE')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('validator response schema rejects extras, duplicate or blank ids, and recursive secret-shaped data', async () => {
  const root = await tempRoot()
  try {
    const event = turnEnd(0)
    const session = makeSession([event])
    const cfg = __testing.normalizeConfig(config(root))
    const request = __testing.buildPreliminaryRequest(cfg, session, event, session.events)
    const mutations = [
      { name: 'extra top-level key', apply: (row) => { row.unexpected = true } },
      { name: 'duplicate check ids', apply: (row) => { row.checks.push({ id: 'parent-probe', outcome: 'pass' }) } },
      { name: 'blank check id', apply: (row) => { row.checks[0].id = '   ' } },
      { name: 'extra check key', apply: (row) => { row.checks[0].unexpected = true } },
      { name: 'secret-shaped certificate key', apply: (row) => { row.certificate = { accessToken: 'not-a-real-token' } } },
      { name: 'secret-like nested diagnostic value', apply: (row) => { row.diagnostics = [{ message: 'Bearer abcdefghijklmnop' }] } },
    ]
    for (const mutation of mutations) {
      const row = responseFor(request)
      mutation.apply(row)
      assert.notEqual(__testing.validateResponse(request, row), null, mutation.name)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('two observer instances sharing one output directory invoke validator once', async () => {
  const root = await tempRoot()
  try {
    const event = turnEnd(0)
    const session = makeSession([event], 'shared-session')
    let calls = 0
    let release
    const held = new Promise((resolve) => { release = resolve })
    const runner = async ({ request }) => {
      calls += 1
      await held
      return { exitCode: 0, signal: null, stdout: JSON.stringify(responseFor(request)), stderr: '' }
    }
    const first = createRouteCertificateObserver(makeCtx(), config(root), { runner })
    const second = createRouteCertificateObserver(makeCtx(), config(root), { runner })
    const firstTask = first.enqueue(session, event, 'first-instance')
    while (calls === 0) await delay(1)
    const secondTask = second.enqueue(session, event, 'second-instance')
    await delay(30)
    release()
    const [firstReceipt, secondReceipt] = await Promise.all([firstTask, secondTask])
    assert.equal(calls, 1)
    assert.equal(firstReceipt.idempotencyKey, secondReceipt.idempotencyKey)
    await Promise.all([first.dispose(), second.dispose()])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('late validator settlement cannot mutate an already persisted timeout receipt', async () => {
  const root = await tempRoot()
  try {
    const event = turnEnd(0)
    const session = makeSession([event], 'late-runner-session')
    let release
    const held = new Promise((resolve) => { release = resolve })
    const runner = async ({ request }) => {
      await held
      return { exitCode: 0, signal: null, stdout: JSON.stringify(responseFor(request)), stderr: '' }
    }
    const observer = createRouteCertificateObserver(
      makeCtx(),
      config(root, { timeoutMs: 10, disposeTimeoutMs: 25 }),
      { runner },
    )
    const receipt = await observer.enqueue(session, event, 'late-runner')
    assert.equal(receipt.outcome, 'indeterminate')
    assert.equal(receipt.reason, 'validator_timeout')
    const store = __testing.createFileReceiptStore(root)
    const receiptFile = join(root, 'receipts', `${receipt.idempotencyKey.slice('sha256:'.length)}.json`)
    const before = await readFile(receiptFile, 'utf8')
    const beforeRow = await store.read(receipt.idempotencyKey)
    release()
    await delay(50)
    assert.equal(await readFile(receiptFile, 'utf8'), before)
    assert.deepEqual(await store.read(receipt.idempotencyKey), beforeRow)
    await observer.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('stale receipt claim is quarantined and replaced by a fresh owner', async () => {
  const root = await tempRoot()
  try {
    const key = `sha256:${'a'.repeat(64)}`
    const target = __testing.claimPath(root, key)
    await mkdir(join(root, 'receipts'), { recursive: true })
    await writeFile(target, `${JSON.stringify({ token: 'stale-token', pid: 1, createdAtMs: 1 })}\n`, { mode: 0o600 })
    const old = new Date(Date.now() - 10_000)
    await utimes(target, old, old)
    const store = __testing.createFileReceiptStore(root)
    const claim = await store.claim(key, { waitMs: 100, staleMs: 10 })
    assert.equal(claim.owned, true)
    assert.notEqual(claim.token, 'stale-token')
    const row = JSON.parse(await readFile(target, 'utf8'))
    assert.equal(row.token, claim.token)
    await store.release(key, claim.token)
    await assert.rejects(readFile(target, 'utf8'), (error) => error?.code === 'ENOENT')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ancestor-directory rename and symlink swap is reported as an artifact race', async () => {
  const root = await tempRoot()
  try {
    const allowed = join(root, 'allowed')
    const slot = join(allowed, 'slot')
    const parked = join(allowed, 'slot-parked')
    const outside = join(root, 'outside')
    await mkdir(slot, { recursive: true })
    await mkdir(outside, { recursive: true })
    const candidate = join(slot, 'artifact.txt')
    await writeFile(candidate, 'INSIDE')
    await writeFile(join(outside, 'artifact.txt'), 'OUTSIDE')
    const descriptor = await __testing.safeArtifactDescriptor(
      { artifactRoots: [allowed], maxArtifactBytes: 1024 },
      { path: candidate, eventSeq: 7 },
      {
        async afterCandidateRealpath() {
          await rename(slot, parked)
          await symlink(outside, slot, 'dir')
        },
      },
    )
    assert.equal(descriptor.omitted, true)
    assert.equal(descriptor.reason, 'artifact_race_detected')
    assert.equal(descriptor.eventSeq, 7)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('direct same-key receipt writes preserve the first canonical receipt', async () => {
  const root = await tempRoot()
  try {
    const key = `sha256:${'b'.repeat(64)}`
    const first = { schema: 'test-receipt/v1', value: 'first' }
    const second = { schema: 'test-receipt/v1', value: 'second' }
    const store = __testing.createFileReceiptStore(root)
    assert.deepEqual(await store.write(key, first), first)
    assert.deepEqual(await store.write(key, second), first)
    assert.deepEqual(await store.read(key), first)
    const receiptFile = join(root, 'receipts', `${key.slice('sha256:'.length)}.json`)
    assert.equal(await readFile(receiptFile, 'utf8'), `${__testing.canonicalString(first)}\n`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
