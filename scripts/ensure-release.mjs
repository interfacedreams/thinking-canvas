// Pre-create the GitHub release for the current version, if it doesn't exist.
//
// electron-builder publishes artifacts on parallel tasks, and each task tries
// to create the release when none exists. With releaseType: release that race
// is fatal: the first task creates it, the rest get 422 already_exists, and
// the publish aborts half-uploaded. (In draft mode the same race merely left
// duplicate junk drafts — the pattern seen on every release before 0.1.8.)
// Creating the release up front means every task finds it by tag and just
// attaches assets.
//
// Requires GH_TOKEN in the environment (same token the publish step uses).
import { readFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const tag = `v${version}`
const repo = 'interfacedreams/thinking-canvas'
const token = process.env.GH_TOKEN
if (!token) {
  console.error('ensure-release: GH_TOKEN is not set')
  process.exit(1)
}

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json'
}

const existing = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, {
  headers
})
if (existing.ok) {
  console.log(`ensure-release: ${tag} already exists`)
  process.exit(0)
}

const created = await fetch(`https://api.github.com/repos/${repo}/releases`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ tag_name: tag, name: version, draft: false, prerelease: false })
})
if (!created.ok) {
  console.error(`ensure-release: create failed (${created.status}): ${await created.text()}`)
  process.exit(1)
}
console.log(`ensure-release: created live release ${tag}`)
