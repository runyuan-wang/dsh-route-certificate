import { createHash } from 'node:crypto'

export const BUNDLED_POLICY_SPEC = Object.freeze({
  schema: 'routecertificate.bundled-policy/v1',
  policyId: 'terminal-envelope-default',
  scope: 'DeepSeek Harness terminal state and source-bound event envelope only',
  passKinds: ['completed'],
  failKinds: ['error'],
  indeterminateKinds: ['aborted', 'interrupted', 'disposed', 'max-tokens', 'unknown'],
  omittedArtifacts: 'indeterminate',
  semanticJudgment: false,
})

export const BUNDLED_POLICY_DIGEST = digestJson(BUNDLED_POLICY_SPEC)
export const CERTIFICATE_SCHEMA = 'routecertificate.terminal-envelope-certificate/v1'

export function sortJson(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(sortJson)
  const out = {}
  for (const key of Object.keys(value).sort()) out[key] = sortJson(value[key])
  return out
}

export function canonicalString(value) {
  return JSON.stringify(sortJson(JSON.parse(JSON.stringify(value))))
}

export function sha256Text(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`
}

export function digestJson(value) {
  return sha256Text(canonicalString(value))
}

export function requestIdForRequest(request) {
  const body = JSON.parse(JSON.stringify(request))
  delete body.requestId
  return digestJson(body)
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function safeLabel(value, max = 64) {
  if (typeof value !== 'string') return null
  const label = value.trim().toLowerCase()
  if (!label || label.length > max || !/^[a-z0-9][a-z0-9._:-]*$/.test(label)) return null
  return label
}

function safeCode(value) {
  const code = safeLabel(value, 80)
  if (!code) return null
  if (/(?:key|password|passwd|secret|token|authorization|bearer)/i.test(code)) return null
  if (/^(?:sk-|gh[pousr]_|xox[baprs]-|akia)/i.test(code)) return null
  return code
}

export function sanitizeTerminalReason(data) {
  const outer = isPlainObject(data) ? data : {}
  const reason = isPlainObject(outer.reason) ? outer.reason : outer
  const kind = safeLabel(reason.kind) ?? 'unknown'
  const error = isPlainObject(reason.error) ? reason.error : reason
  const out = { kind }
  if (Number.isSafeInteger(error.status) && error.status >= 0 && error.status <= 9999) out.status = error.status
  const code = safeCode(error.code)
  if (code) out.code = code
  return out
}

function equalJson(left, right) {
  try {
    return canonicalString(left) === canonicalString(right)
  } catch {
    return false
  }
}

function validEvent(event) {
  return isPlainObject(event)
    && typeof event.type === 'string'
    && event.type.length > 0
    && event.type.length <= 128
    && Number.isSafeInteger(event.seq)
    && event.seq >= 0
    && Number.isSafeInteger(event.time)
    && event.time >= 0
}

function validArtifactDescriptor(row) {
  if (!isPlainObject(row)) return false
  if (row.omitted === true) {
    return typeof row.name === 'string'
      && row.name.length > 0
      && row.name.length <= 1024
      && typeof row.reason === 'string'
      && /^[a-z0-9_]{1,80}$/.test(row.reason)
      && (row.eventSeq === null || Number.isSafeInteger(row.eventSeq))
      && (row.size === null || (Number.isSafeInteger(row.size) && row.size >= 0))
  }
  return typeof row.name === 'string'
    && row.name.length > 0
    && row.name.length <= 1024
    && Number.isSafeInteger(row.eventSeq)
    && Number.isSafeInteger(row.size)
    && row.size >= 0
    && /^sha256:[0-9a-f]{64}$/.test(row.sha256)
    && typeof row.mediaType === 'string'
    && row.mediaType.length > 0
    && row.mediaType.length <= 256
    && /^artifact:[0-9a-f]{64}$/.test(row.handle)
}

export function analyzeTerminalEnvelope(request) {
  const evidence = isPlainObject(request?.evidence) ? request.evidence : null
  const subject = isPlainObject(request?.subject) ? request.subject : null
  const policy = isPlainObject(request?.policy) ? request.policy : null
  const events = Array.isArray(evidence?.events) ? evidence.events : []
  const last = events.at(-1)

  const bindingValid = request?.schema === 'routecertificate.deepseek-harness.request/v1'
    && typeof request?.requestId === 'string'
    && request.requestId === requestIdForRequest(request)
    && policy?.policyId === BUNDLED_POLICY_SPEC.policyId
    && policy?.policyDigest === BUNDLED_POLICY_DIGEST

  let sequenceValid = events.length > 0 && events.every(validEvent)
  if (sequenceValid) {
    for (let index = 1; index < events.length; index += 1) {
      if (events[index].seq <= events[index - 1].seq) sequenceValid = false
    }
  }
  const prefixValid = sequenceValid
    && isPlainObject(evidence?.eventRange)
    && evidence.eventRange.fromSeq === events[0].seq
    && evidence.eventRange.throughSeq === last.seq
    && evidence.sessionPrefixDigest === digestJson(events)

  const terminalSummary = last?.type === 'turn/end' ? sanitizeTerminalReason(last.data) : { kind: 'unknown' }
  const terminalCount = events.filter((event) => event?.type === 'turn/end').length
  const declaredTurnMatchesEvent = !Number.isSafeInteger(last?.data?.turn) || last.data.turn === subject?.turn
  const terminalValid = prefixValid
    && last.type === 'turn/end'
    && Number.isSafeInteger(subject?.turn)
    && subject.turn > 0
    && subject.turn === terminalCount
    && subject.turnEndSeq === last.seq
    && subject.turnEndTime === last.time
    && declaredTurnMatchesEvent
    && equalJson(subject.harnessReason, terminalSummary)

  const artifacts = Array.isArray(evidence?.artifacts) ? evidence.artifacts : null
  const artifactsStructurallyValid = artifacts !== null && artifacts.every(validArtifactDescriptor)
  const hasOmittedArtifacts = artifactsStructurallyValid && artifacts.some((row) => row.omitted === true)

  let outcome
  if (!bindingValid || !prefixValid || !terminalValid || !artifactsStructurallyValid) outcome = 'fail'
  else if (hasOmittedArtifacts) outcome = 'indeterminate'
  else if (BUNDLED_POLICY_SPEC.passKinds.includes(terminalSummary.kind)) outcome = 'pass'
  else if (BUNDLED_POLICY_SPEC.failKinds.includes(terminalSummary.kind)) outcome = 'fail'
  else outcome = 'indeterminate'

  const checks = [
    {
      id: 'request-policy-binding',
      outcome: bindingValid ? 'pass' : 'fail',
      evidence: { requestIdRecomputed: bindingValid, bundledPolicyBound: policy?.policyDigest === BUNDLED_POLICY_DIGEST },
    },
    {
      id: 'event-prefix-binding',
      outcome: prefixValid ? 'pass' : 'fail',
      evidence: { eventCount: events.length, prefixDigestRecomputed: prefixValid },
    },
    {
      id: 'terminal-envelope',
      outcome: terminalValid ? 'pass' : 'fail',
      evidence: { terminalKind: terminalSummary.kind, terminalSequenceBound: terminalValid },
    },
    {
      id: 'artifact-evidence',
      outcome: !artifactsStructurallyValid ? 'fail' : hasOmittedArtifacts ? 'indeterminate' : 'pass',
      evidence: { artifactCount: artifacts?.length ?? 0, complete: artifactsStructurallyValid && !hasOmittedArtifacts },
    },
    {
      id: 'terminal-status-policy',
      outcome,
      evidence: {
        terminalKind: terminalSummary.kind,
        scope: 'terminal-envelope-only',
        semanticJudgment: false,
      },
    },
  ]

  const envelopeValid = bindingValid && prefixValid && terminalValid && artifactsStructurallyValid
  const certificate = {
    schema: CERTIFICATE_SCHEMA,
    policyId: BUNDLED_POLICY_SPEC.policyId,
    scope: 'terminal-envelope-only',
    envelopeValid,
    terminalKind: terminalSummary.kind,
    artifactEvidenceComplete: artifactsStructurallyValid && !hasOmittedArtifacts,
    semanticJudgment: false,
  }

  return {
    outcome,
    checks,
    certificate,
    diagnostics: [{ code: 'bundled_terminal_envelope_policy', terminalKind: terminalSummary.kind, semanticJudgment: false }],
  }
}
