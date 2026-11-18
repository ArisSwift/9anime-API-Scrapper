/**
 * Deploy this Worker, preferring a personal config when there is one.
 *
 * `wrangler.toml` is the copy everyone gets: no routes, because a route names
 * somebody's domain and this file is published. `wrangler.personal.toml` is
 * git-ignored and holds the custom domain, so an owner can deploy to their own
 * address while the published copy stays clean. Without that file the plain
 * config is used and the Worker goes to workers.dev, which is what a stranger
 * cloning this repo wants anyway.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const personal = 'wrangler.personal.toml'
const config = existsSync(personal) ? personal : 'wrangler.toml'
console.log(`deploying with ${config}`)

const run = spawnSync('npx', ['wrangler', 'deploy', '--config', config], { stdio: 'inherit' })
process.exit(run.status ?? 1)
