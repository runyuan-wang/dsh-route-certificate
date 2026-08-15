#!/usr/bin/env node
import {
  BUNDLED_POLICY_DIGEST,
  analyzeTerminalEnvelope,
  canonicalString,
  digestJson,
} from '../policy.js'

const REQUEST_SCHEMA = 'routecertificate.deepseek-harness.request/v1'
const RESPONSE_SCHEMA = 'routecertificate.result/v1'

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { input += chunk })
process.stdin.on('end', () => {
  try {
    const request = JSON.parse(input)
    if (request?.schema !== REQUEST_SCHEMA || typeof request.requestId !== 'string') {
      throw new Error('invalid request schema')
    }
    const result = analyzeTerminalEnvelope(request)
    const response = {
      schema: RESPONSE_SCHEMA,
      requestId: request.requestId,
      outcome: result.outcome,
      checks: result.checks,
      evidenceDigest: digestJson(request.evidence),
      policyDigest: request.policy?.policyDigest ?? BUNDLED_POLICY_DIGEST,
      certificate: result.certificate,
      diagnostics: result.diagnostics,
    }
    process.stdout.write(`${canonicalString(response)}\n`)
  } catch (error) {
    process.stderr.write(`routecert-local-validator: ${error?.message ?? String(error)}\n`)
    process.exitCode = 2
  }
})
