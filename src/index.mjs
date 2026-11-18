/**
 * A small read-only API over 9anime's own four calls.
 *
 * It exists so the player never has to know this site exists: one request per
 * question, plain JSON out, and the awkward parts (their slugs, their episode
 * ids, the referer on the stream redirect) stay in one place.
 *
 *   GET /health
 *   GET /search?q=<title>
 *   GET /anime/<slug>            → show + episodes
 *   GET /anime?title=<title>     → same, resolving the slug for you
 *   GET /episode/<id>            → the file for one episode id
 *   GET /resolve?title=<t>&ep=<n> → everything, in one round trip
 *
 * Nothing here proxies video. `/episode` and `/resolve` return the address of
 * an MP4 on their host, and the file travels from them to whoever is watching.
 */

import { Failure, fileFor, findShow, listEpisodes, playableFor, search } from './nineanime.mjs'

const VERSION = '1.0.0'

/** Everything this API says is JSON, and anything can call it. */
function reply(data, { status = 200, cache = 'no-store' } = {}) {
  return Response.json(data, {
    status,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'cache-control': cache,
    },
  })
}

/** One shape for every problem, so a caller can branch on `status` alone. */
function fail(error) {
  const status = error instanceof Failure ? error.status : 500
  const message = error instanceof Error ? error.message : String(error)
  if (status >= 500) console.error('nineanime api:', status, message)

  const hint = error instanceof Failure && error.details ? error.details : {}
  return reply({ error: message, status, ...hint }, { status })
}

/** The episode they asked for, or a clear answer about what does exist. */
function pickEpisode(episodes, wanted) {
  const number = Number(wanted)
  if (!Number.isFinite(number)) {
    throw new Failure(400, '`ep` must be an episode number')
  }

  const found = episodes.find((episode) => episode.number === number)
  if (found) return found

  const have = episodes.map((episode) => episode.number)
  throw new Failure(
    404,
    `no episode ${number}; ${episodes.length === 1 ? 'only episode' : 'episodes'} ${have.join(', ')} exist`,
  )
}

export default {
  async fetch(request) {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, '') || '/'

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, OPTIONS',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '86400',
        },
      })
    }

    if (request.method !== 'GET') {
      return reply({ error: 'only GET is allowed', status: 405 }, { status: 405 })
    }

    const at = Date.now()

    try {
      if (path === '/') {
        return reply({
          name: 'nineanime-api',
          version: VERSION,
          endpoints: [
            'GET /health',
            'GET /search?q=',
            'GET /anime/<slug>',
            'GET /anime?title=',
            'GET /episode/<id>',
            'GET /resolve?title=&ep=   (or ?show=<id>&ep= once the id is known)',
          ],
        })
      }

      if (path === '/health') {
        return reply({ ok: true, version: VERSION })
      }

      if (path === '/search') {
        const query = url.searchParams.get('q')?.trim()
        if (!query) throw new Failure(400, '`q` is required')

        // An empty answer is a valid answer for a search, not an error.
        let results = []
        try {
          results = await search(query)
        } catch (error) {
          if (!(error instanceof Failure && error.status === 404)) throw error
        }

        // Their search answers a miss with the whole catalogue, so a caller
        // needs to be told how much of this list actually resembles the query.
        const wanted = query
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, ' ')
          .trim()
        const matched = results.filter((result) =>
          result.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').includes(wanted),
        ).length

        return reply({ query, count: results.length, matched, results }, { cache: 'public, max-age=3600' })
      }

      if (path === '/anime') {
        const title = url.searchParams.get('title')?.trim()
        const slug = url.searchParams.get('slug')?.trim()
        if (!title && !slug) throw new Failure(400, '`title` or `slug` is required')

        const show = await findShow(title, { slug })
        const episodes = await listEpisodes(show.id)

        return reply(
          { show, count: episodes.length, episodes, ms: Date.now() - at },
          { cache: 'public, max-age=600' },
        )
      }

      if (path.startsWith('/anime/')) {
        const slug = decodeURIComponent(path.slice('/anime/'.length))
        const show = await findShow(undefined, { slug })
        const episodes = await listEpisodes(show.id)

        return reply(
          { show, count: episodes.length, episodes, ms: Date.now() - at },
          { cache: 'public, max-age=600' },
        )
      }

      if (path.startsWith('/episode/')) {
        const id = Number(path.slice('/episode/'.length))
        if (!Number.isInteger(id) || id <= 0) throw new Failure(400, 'episode id must be a number')

        const playable = await playableFor(id)
        const file = await fileFor(playable)

        return reply({
          episode: { id },
          audio: playable.audio,
          host: playable.host,
          file,
          ms: Date.now() - at,
        })
      }

      if (path === '/resolve') {
        const title = url.searchParams.get('title')?.trim()
        const slug = url.searchParams.get('slug')?.trim()
        const known = Number(url.searchParams.get('show'))

        // A caller that already stored the show id skips the expensive half of
        // this: no slug guess, no search, no show page.
        const show = Number.isInteger(known) && known > 0 ? { id: known } : await findShow(title, { slug })
        if (!Number.isInteger(show.id) || show.id <= 0) {
          throw new Failure(400, '`title`, `slug` or `show` is required')
        }

        const wanted = url.searchParams.get('ep') ?? '1'

        const episodes = await listEpisodes(show.id)
        const episode = pickEpisode(episodes, wanted)

        const playable = await playableFor(episode.id)
        const file = await fileFor(playable)

        return reply({
          show,
          episode: { number: episode.number, id: episode.id, url: episode.url },
          available: episodes.map((ep) => ep.number),
          audio: playable.audio,
          host: playable.host,
          file,
          ms: Date.now() - at,
        })
      }

      return reply({ error: 'no such route', status: 404 }, { status: 404 })
    } catch (error) {
      return fail(error)
    }
  },
}
