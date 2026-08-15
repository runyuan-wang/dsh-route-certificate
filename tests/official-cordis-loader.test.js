import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../index.js'

const CONFIG = {
  mode: 'disabled',
  actualHarnessCommit: '47f943859bef60e4160492346772ded9b24f765a',
  actualHarnessPackageVersion: '0.1.0-rc.6',
  disposeTimeoutMs: 20,
}

function timeout(ms, label) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${label} timeout`)), ms).unref()
  })
}

test('official Cordis registry loads the plugin with sessions only', async () => {
  const ctx = new Context()
  const fiber = ctx.plugin(plugin, CONFIG)

  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(fiber.state, 0, 'fiber must wait while sessions is absent')

  const removeSessions = ctx.provide('sessions', {
    list: () => [],
    on: () => () => {},
  })

  await Promise.race([fiber, timeout(1000, 'Cordis dependency registration')])
  for (let attempt = 0; attempt < 100 && fiber.state !== 2; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(fiber.state, 2, 'fiber must activate after sessions is provided')
  assert.deepEqual(plugin.inject, ['sessions'])
  assert.equal('required' in ctx, false)
  assert.equal('optional' in ctx, false)
  assert.equal(ctx.reflect.get('subprocess'), undefined)

  await Promise.race([fiber.dispose(), timeout(1000, 'Cordis plugin dispose')])
  removeSessions()
  await Promise.race([ctx.fiber.dispose(), timeout(1000, 'Cordis root dispose')])
})

test('official Cordis registry activates the rc.6 observer with a profile-owned output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-route-cert-cordis-active-'))
  const ctx = new Context()
  try {
    const fiber = ctx.plugin(plugin, {
      mode: 'observe',
      outputDir: root,
      actualHarnessPackageVersion: '0.1.0-rc.6',
      disposeTimeoutMs: 20,
    })
    const removeSessions = ctx.provide('sessions', {
      list: () => [],
      values: () => [],
      on: () => () => {},
    })
    await Promise.race([fiber, timeout(1000, 'active Cordis dependency registration')])
    for (let attempt = 0; attempt < 100 && fiber.state !== 2; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(fiber.state, 2, 'active rc.6 observer must activate')
    assert.deepEqual(plugin.inject, ['sessions'])
    await Promise.race([fiber.dispose(), timeout(1000, 'active Cordis plugin dispose')])
    removeSessions()
  } finally {
    await Promise.race([ctx.fiber.dispose(), timeout(1000, 'active Cordis root dispose')])
    await rm(root, { recursive: true, force: true })
  }
})
