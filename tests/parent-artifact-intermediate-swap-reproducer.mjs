import assert from 'node:assert/strict'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdtemp, mkdir, open, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const root = await mkdtemp(join(tmpdir(), 'dsh-route-cert-intermediate-swap-'))
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

  // This is the exact security-relevant sequence used by the current helper:
  // realpath containment first, then open(O_NOFOLLOW) on the resolved string,
  // then handle/path metadata comparison.  The controlled rename+symlink is
  // inserted only between realpath and open to make the race deterministic.
  const rootReal = await realpath(allowed)
  const resolved = await realpath(candidate)
  assert.ok(resolved.startsWith(`${rootReal}/`))
  await rename(slot, parked)
  await symlink(outside, slot, 'dir')
  assert.equal((await lstat(resolved)).isSymbolicLink(), false)

  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
  const handle = await open(resolved, flags)
  let before
  let bytes
  try {
    before = await handle.stat()
    bytes = await handle.readFile()
  } finally {
    await handle.close()
  }
  const after = await stat(resolved)
  const currentAlgorithmAccepts = before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
  const payload = bytes.toString('utf8')
  assert.equal(payload, 'OUTSIDE')
  assert.equal(currentAlgorithmAccepts, true)

  process.stdout.write(`${JSON.stringify({
    status: 'REPRODUCED',
    finding: 'intermediate_directory_swap_can_escape_prechecked_realpath',
    initial_resolved_path_inside_allowed_root: true,
    final_component_is_symlink: false,
    bytes_read: payload,
    current_metadata_comparison_accepts: currentAlgorithmAccepts,
    boundary: 'This faithful algorithm reproducer does not call the helper directly because the helper exposes no hook between realpath and open. A directory-fd/openat design is required for a strong hostile-concurrency guarantee; otherwise the contract must be narrowed.',
  }, null, 2)}\n`)
} finally {
  await rm(root, { recursive: true, force: true })
}
