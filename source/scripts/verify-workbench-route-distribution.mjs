#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROUTE_PATH =
  'source/src/app/api/workbench/agents/[id]/sessions/route.ts'
const ALLOWED_CHANGES = [
  '.gitignore',
  ROUTE_PATH,
  'source/scripts/verify-workbench-route-distribution.mjs',
]
const MUST_REMAIN_IGNORED = [
  'source/src/app/api/workbench/agents/[id]/sessions/local-session.json',
  'source/src/app/api/workbench/agents/other/sessions/route.ts',
]

function git(args, { cwd, env = process.env } = {}) {
  return spawnSync('git', args, {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
  })
}

function gitOutput(args, options) {
  const result = git(args, options)
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim()
    throw new Error(`git ${args.join(' ')} failed: ${detail}`)
  }
  return result.stdout.trim()
}

function assertNotIgnored(repoRoot, path) {
  const result = git(['check-ignore', '--quiet', '--no-index', '--', path], {
    cwd: repoRoot,
  })
  if (result.status === 0) {
    throw new Error(`${path} is still ignored`)
  }
  if (result.status !== 1) {
    throw new Error(
      `git check-ignore failed for ${path}: ${(result.stderr || '').trim()}`,
    )
  }
}

function assertIgnored(repoRoot, path) {
  const result = git(['check-ignore', '--quiet', '--no-index', '--', path], {
    cwd: repoRoot,
  })
  if (result.status !== 0) {
    throw new Error(`${path} must remain ignored`)
  }
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = gitOutput(['rev-parse', '--show-toplevel'], {
  cwd: scriptDirectory,
})
const absoluteRoutePath = join(repoRoot, ...ROUTE_PATH.split('/'))

if (!existsSync(absoluteRoutePath)) {
  throw new Error(`Required Route Handler is missing: ${ROUTE_PATH}`)
}

assertNotIgnored(repoRoot, ROUTE_PATH)
for (const path of MUST_REMAIN_IGNORED) {
  assertIgnored(repoRoot, path)
}

const candidates = gitOutput(
  ['ls-files', '--cached', '--others', '--exclude-standard', '--', ROUTE_PATH],
  { cwd: repoRoot },
)
  .split(/\r?\n/u)
  .filter(Boolean)

if (!candidates.includes(ROUTE_PATH)) {
  throw new Error(`${ROUTE_PATH} is absent from Git's distributable file set`)
}

const trackedResult = git(['ls-files', '--error-unmatch', '--', ROUTE_PATH], {
  cwd: repoRoot,
})
if (trackedResult.status !== 0 && trackedResult.status !== 1) {
  throw new Error(
    `Unable to determine tracked state for ${ROUTE_PATH}: ${(
      trackedResult.stderr || ''
    ).trim()}`,
  )
}
const trackedInCurrentIndex = trackedResult.status === 0

const scratchRoot = resolve(repoRoot, '.tmp')
mkdirSync(scratchRoot, { recursive: true })
const scratchDirectory = mkdtempSync(
  join(scratchRoot, 'workbench-route-distribution-'),
)
const resolvedScratchDirectory = resolve(scratchDirectory)

if (!resolvedScratchDirectory.startsWith(`${scratchRoot}${sep}`)) {
  throw new Error('Refusing to use a scratch directory outside the repository')
}

try {
  const temporaryIndex = join(resolvedScratchDirectory, 'index')
  const temporaryEnvironment = {
    ...process.env,
    GIT_INDEX_FILE: temporaryIndex,
  }

  gitOutput(['read-tree', 'HEAD'], {
    cwd: repoRoot,
    env: temporaryEnvironment,
  })
  gitOutput(['add', '--', ...ALLOWED_CHANGES], {
    cwd: repoRoot,
    env: temporaryEnvironment,
  })

  const prospectiveTree = gitOutput(['write-tree'], {
    cwd: repoRoot,
    env: temporaryEnvironment,
  })
  const archivedRoute = gitOutput(
    ['ls-tree', '-r', '--name-only', prospectiveTree, '--', ROUTE_PATH],
    { cwd: repoRoot },
  )

  if (archivedRoute !== ROUTE_PATH) {
    throw new Error(
      `${ROUTE_PATH} is absent from the isolated clean Git tree ${prospectiveTree}`,
    )
  }

  console.log('Workbench route distribution gate: PASS')
  console.log(`route=${ROUTE_PATH}`)
  console.log(`ignored=false`)
  console.log(`tracked_in_current_index=${trackedInCurrentIndex}`)
  console.log(`isolated_clean_tree=${prospectiveTree}`)
  console.log(`isolated_clean_tree_contains_route=true`)
} finally {
  rmSync(resolvedScratchDirectory, { recursive: true, force: true })
}
