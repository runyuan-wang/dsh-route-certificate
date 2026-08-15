import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { __testing, createRouteCertificateObserver } from '../testing.js'

const TEMP_BASE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tmp', 'large-log-tests')

async function tempProfile(label) {
  await mkdir(TEMP_BASE, { recursive: true })
  return mkdtemp(join(TEMP_BASE, `${label}-`))
}

function makeCtx() {
  return {
    sessions: { values: () => [] },
    on() { return () => {} },
  }
}

function assistant(seq, text) {
  return { type: 'assistant/message', seq, time: 1800000000000 + seq, data: { text } }
}

function turnEnd(seq, kind = 'completed', extra = {}) {
  return {
    type: 'turn/end',
    seq,
    time: 1800000000000 + seq,
    data: { turn: 1, reason: { kind }, ...extra },
  }
}

function makeSession(id, events) {
  return { id, header: { id, version: 0, cwd: '/tmp/routecert-fixture' }, events }
}

function config(profile, extra = {}) {
  return {
    mode: 'observe',
    outputDir: join(profile, '.route-certificate'),
    policyId: __testing.BUNDLED_POLICY_SPEC.policyId,
    policyDigest: __testing.BUNDLED_POLICY_DIGEST,
    actualHarnessPackageVersion: __testing.SUPPORTED_HARNESS.packageVersion,
    ...extra,
  }
}

function responseFor(request, outcome = 'pass') {
  return {
    schema: __testing.RESPONSE_SCHEMA,
    requestId: request.requestId,
    outcome,
    checks: [{ id: 'large-log-fixture', outcome }],
    evidenceDigest: __testing.digestJson(request.evidence),
    policyDigest: request.policy.policyDigest,
    diagnostics: [],
  }
}

async function persistedReceipt(profile, receipt) {
  const path = join(profile, '.route-certificate', 'receipts', `${receipt.idempotencyKey.slice('sha256:'.length)}.json`)
  return { path, text: await readFile(path, 'utf8'), row: JSON.parse(await readFile(path, 'utf8')) }
}

test('large event streams and byte-oversized event input stop before unbounded materialization', async () => {
  const profile = await tempProfile('event-input')
  try {
    const maxEvents = 4
    const terminal = turnEnd(999_999)
    let reads = 0
    let iteratorClosed = false
    const eventStream = {
      [Symbol.iterator]() {
        let seq = 0
        return {
          next() {
            reads += 1
            if (reads > maxEvents + 1) throw new Error('event stream was consumed past the configured decision bound')
            const value = assistant(seq, `stream-${seq}`)
            seq += 1
            return { done: false, value }
          },
          return() {
            iteratorClosed = true
            return { done: true }
          },
        }
      },
    }
    let runnerCalls = 0
    const streamObserver = createRouteCertificateObserver(
      makeCtx(),
      config(profile, { maxEvents }),
      { runner: async () => { runnerCalls += 1; return {} } },
    )
    const streamReceipt = await streamObserver.enqueue(makeSession('large-event-stream', eventStream), terminal, 'large-log-test')
    assert.equal(reads, maxEvents + 1)
    assert.equal(iteratorClosed, true)
    assert.equal(runnerCalls, 0)
    assert.equal(streamReceipt.outcome, 'indeterminate')
    assert.equal(streamReceipt.reason, 'preflight_event_count_oversize')
    assert.deepEqual((await persistedReceipt(profile, streamReceipt)).row, streamReceipt)
    await streamObserver.dispose()

    const iteratorReadCounts = []
    const coldStream = {
      [Symbol.iterator]() {
        let seq = 0
        let iteratorReads = 0
        return {
          next() {
            iteratorReads += 1
            if (iteratorReads > maxEvents + 1) throw new Error('cold reconciliation consumed an unbounded event stream')
            const value = seq === 0 ? turnEnd(0) : assistant(seq, `cold-${seq}`)
            seq += 1
            return { done: false, value }
          },
          return() {
            iteratorReadCounts.push(iteratorReads)
            return { done: true }
          },
        }
      },
    }
    let coldRunnerCalls = 0
    const coldSession = makeSession('cold-large-event-stream', coldStream)
    const coldObserver = createRouteCertificateObserver(
      makeCtx(),
      config(profile, { maxEvents }),
      {
        runner: async ({ request }) => {
          coldRunnerCalls += 1
          return { exitCode: 0, signal: null, stdout: JSON.stringify(responseFor(request)), stderr: '' }
        },
      },
    )
    coldObserver.reconcile(coldSession)
    await coldObserver.flush(coldSession)
    assert.equal(coldRunnerCalls, 1)
    assert.deepEqual(iteratorReadCounts.sort((left, right) => left - right), [1, maxEvents + 1])
    assert.equal(coldObserver.completedKeys.size, 2)
    const coldRows = []
    for (const key of coldObserver.completedKeys) {
      coldRows.push((await persistedReceipt(profile, { idempotencyKey: key })).row)
    }
    assert.deepEqual(coldRows.map((row) => row.reason).sort(), ['preflight_event_count_oversize', 'validator_pass'])
    const coldOverflow = coldRows.find((row) => row.reason === 'preflight_event_count_oversize')
    assert.equal(coldOverflow.subject.turnEndSeq, null)
    assert.equal(coldOverflow.subject.turnEndTime, null)
    await coldObserver.dispose()

    const boundaryEvents = [
      assistant(0, 'a'),
      assistant(1, 'b'),
      assistant(2, 'c'),
      assistant(3, 'd'),
      turnEnd(4),
    ]
    let boundaryRunnerCalls = 0
    const boundarySession = makeSession('cold-terminal-at-overflow-boundary', boundaryEvents)
    const boundaryObserver = createRouteCertificateObserver(
      makeCtx(),
      config(profile, { maxEvents }),
      { runner: async () => { boundaryRunnerCalls += 1; return {} } },
    )
    boundaryObserver.reconcile(boundarySession)
    await boundaryObserver.flush(boundarySession)
    assert.equal(boundaryRunnerCalls, 0)
    assert.equal(boundaryObserver.completedKeys.size, 1)
    const [boundaryKey] = boundaryObserver.completedKeys
    const boundaryReceipt = (await persistedReceipt(profile, { idempotencyKey: boundaryKey })).row
    assert.equal(boundaryReceipt.reason, 'preflight_event_count_oversize')
    assert.equal(boundaryReceipt.subject.turnEndSeq, 4)
    assert.equal(boundaryReceipt.subject.turnEndTime, boundaryEvents[4].time)
    await boundaryObserver.dispose()

    const payload = 'Z'.repeat(256 * 1024)
    const rawEvents = [assistant(0, payload), turnEnd(1)]
    const rawControl = structuredClone(rawEvents)
    const byteObserver = createRouteCertificateObserver(
      makeCtx(),
      config(profile, { maxEvents: 8, maxInputBytes: 1024 }),
      { runner: async () => { runnerCalls += 1; return {} } },
    )
    const byteReceipt = await byteObserver.enqueue(makeSession('byte-oversized-event', rawEvents), rawEvents[1], 'large-log-test')
    assert.equal(runnerCalls, 0)
    assert.equal(byteReceipt.outcome, 'indeterminate')
    assert.equal(byteReceipt.reason, 'preflight_request_oversize')
    assert.deepEqual(rawEvents, rawControl)
    assert.equal(rawEvents[0].data.text, payload)
    const stored = await persistedReceipt(profile, byteReceipt)
    assert.equal(stored.text.includes('Z'.repeat(128)), false)
    await byteObserver.dispose()
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
})

test('fallback subprocess retains only a bounded stdout or stderr prefix and reports oversize', async () => {
  for (const stream of ['stdout', 'stderr']) {
    const profile = await tempProfile(`subprocess-${stream}`)
    try {
      const script = join(profile, `${stream}.mjs`)
      await writeFile(script, `process.${stream}.write('${stream === 'stdout' ? 'O' : 'E'}'.repeat(1024 * 1024))\n`)
      const events = [turnEnd(0)]
      const rawControl = structuredClone(events)
      const observer = createRouteCertificateObserver(
        makeCtx(),
        config(profile, { command: process.execPath, args: [script], maxOutputBytes: 1024 }),
      )
      const receipt = await observer.enqueue(makeSession(`oversized-${stream}`, events), events[0], 'large-log-test')
      assert.equal(receipt.outcome, 'indeterminate', stream)
      assert.equal(receipt.reason, 'validator_output_oversize', stream)
      assert.equal(receipt.transport[`${stream}Bytes`], 1025, stream)
      assert.equal(receipt.transport[`${stream}Truncated`], true, stream)
      assert.ok(receipt.transport.stdoutBytes <= 1025, stream)
      assert.ok(receipt.transport.stderrBytes <= 1025, stream)
      assert.deepEqual(events, rawControl, stream)
      assert.deepEqual((await persistedReceipt(profile, receipt)).row, receipt, stream)
      await observer.dispose()
    } finally {
      await rm(profile, { recursive: true, force: true })
    }
  }
})

test('lossy stdout or stderr at the configured cap cannot be interpreted as a pass', async () => {
  const profile = await tempProfile('lossy-at-cap')
  try {
    for (const stream of ['stdout', 'stderr']) {
      const events = [turnEnd(0)]
      const observer = createRouteCertificateObserver(
        makeCtx(),
        config(profile, { maxOutputBytes: 4096 }),
        {
          runner: async ({ request }) => ({
            exitCode: 0,
            signal: null,
            stdout: JSON.stringify(responseFor(request)),
            stderr: stream === 'stderr' ? 'retained diagnostic prefix' : '',
            stdoutTruncated: stream === 'stdout',
            stderrTruncated: stream === 'stderr',
          }),
        },
      )
      const receipt = await observer.enqueue(makeSession(`lossy-${stream}`, events), events[0], 'large-log-test')
      assert.equal(receipt.outcome, 'indeterminate', stream)
      assert.equal(receipt.reason, 'validator_output_oversize', stream)
      assert.equal(receipt.transport[`${stream}Truncated`], true, stream)
      assert.ok(receipt.transport[`${stream}Bytes`] < 4096, stream)
      await observer.dispose()
    }

    const directEvents = [turnEnd(0)]
    const directCtx = makeCtx()
    directCtx.reflect = {
      get() {
        return {
          async spawn({ stdio }) {
            const request = JSON.parse(String(stdio.stdin.data))
            return {
              done: Promise.resolve({ exitCode: 0, signal: null }),
              collected: {
                stdout: { text: JSON.stringify(responseFor(request)), lossy: true },
                stderr: { text: '', lossy: false },
              },
            }
          },
        }
      },
    }
    const directObserver = createRouteCertificateObserver(directCtx, config(profile, { maxOutputBytes: 4096 }))
    const directReceipt = await directObserver.enqueue(makeSession('direct-lossy-collector', directEvents), directEvents[0], 'large-log-test')
    assert.equal(directReceipt.outcome, 'indeterminate')
    assert.equal(directReceipt.reason, 'validator_output_oversize')
    assert.equal(directReceipt.transport.stdoutTruncated, true)
    await directObserver.dispose()
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
})

test('oversized declared artifact is not read into evidence, is reported, and cannot become pass', async () => {
  const profile = await tempProfile('artifact-oversize')
  try {
    const artifactRoot = join(profile, 'artifacts')
    const artifactPath = join(artifactRoot, 'oversized.log')
    const artifactBytes = Buffer.alloc(64 * 1024, 0x41)
    await mkdir(artifactRoot)
    await writeFile(artifactPath, artifactBytes)
    const before = await stat(artifactPath)
    const events = [turnEnd(0, 'completed', {
      artifacts: [{ path: artifactPath, name: 'oversized-log', mediaType: 'text/plain' }],
    })]
    const rawControl = structuredClone(events)
    const observer = createRouteCertificateObserver(
      makeCtx(),
      config(profile, { artifactRoots: [artifactRoot], maxArtifactBytes: 1024 }),
    )
    const receipt = await observer.enqueue(makeSession('artifact-oversize', events), events[0], 'large-log-test')
    assert.equal(receipt.outcome, 'indeterminate')
    assert.deepEqual(receipt.evidenceOmissions, [{ eventSeq: 0, reason: 'artifact_oversize', size: artifactBytes.length }])
    assert.equal(receipt.certificate.artifactEvidenceComplete, false)
    assert.equal(receipt.checks.find((row) => row.id === 'artifact-evidence').outcome, 'indeterminate')
    const after = await stat(artifactPath)
    assert.equal(after.size, before.size)
    assert.deepEqual(await readFile(artifactPath), artifactBytes)
    assert.deepEqual(events, rawControl)
    const stored = await persistedReceipt(profile, receipt)
    assert.equal(stored.text.includes(artifactPath), false)
    assert.deepEqual(stored.row.evidenceOmissions, receipt.evidenceOmissions)
    await observer.dispose()

    const externalEvents = [turnEnd(0)]
    const externalObserver = createRouteCertificateObserver(
      makeCtx(),
      config(profile),
      {
        artifactReader: async () => [{
          name: 'oversized-log',
          eventSeq: 0,
          omitted: true,
          reason: 'artifact_oversize',
          size: artifactBytes.length,
        }],
        runner: async ({ request }) => ({
          exitCode: 0,
          signal: null,
          stdout: JSON.stringify(responseFor(request, 'pass')),
          stderr: '',
        }),
      },
    )
    const downgraded = await externalObserver.enqueue(makeSession('artifact-external-pass', externalEvents), externalEvents[0], 'large-log-test')
    assert.equal(downgraded.outcome, 'indeterminate')
    assert.equal(downgraded.reason, 'artifact_evidence_incomplete')
    assert.deepEqual(downgraded.evidenceOmissions, [{ eventSeq: 0, reason: 'artifact_oversize', size: artifactBytes.length }])
    await externalObserver.dispose()
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
})

test('ordinary small completed, error, and interrupted results remain unchanged', async () => {
  const profile = await tempProfile('ordinary-control')
  try {
    for (const [kind, expected] of [
      ['completed', 'pass'],
      ['error', 'fail'],
      ['interrupted', 'indeterminate'],
    ]) {
      const events = [assistant(0, `small-${kind}`), turnEnd(1, kind)]
      const rawControl = structuredClone(events)
      const observer = createRouteCertificateObserver(makeCtx(), config(profile))
      const receipt = await observer.enqueue(makeSession(`ordinary-${kind}`, events), events[1], 'large-log-control')
      assert.equal(receipt.outcome, expected, kind)
      assert.equal(receipt.certificate.scope, 'terminal-envelope-only', kind)
      assert.equal(receipt.certificate.semanticJudgment, false, kind)
      assert.equal(receipt.certificate.terminalKind, kind, kind)
      assert.equal('evidenceOmissions' in receipt, false, kind)
      assert.equal(receipt.transport.stdoutTruncated, false, kind)
      assert.equal(receipt.transport.stderrTruncated, false, kind)
      assert.deepEqual(events, rawControl, kind)
      await observer.dispose()
    }
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
})
