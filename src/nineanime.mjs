/**
 * Everything that talks to 9anime.
 *
 * Two rules this file exists to enforce:
 *
 *  - We never load their pages as pages. No HTML is rendered, no ads, no
 *    trackers — only the show page's markup as text, to read two attributes.
 *  - An answer from their side is never trusted as the final word. Every reply
 *    is checked for the fields we need before it goes any further, so a change
 *    on their end becomes a clean 502 instead of a player that hangs.
 */

const BASE = 'https://9anime.or.at'

/**
 * The hosts we know serve a plain MP4 behind a token.
 *
 * 9anime mixes sources: some episodes answer from 1anime (a file), others from
 * an HLS player on a different domain (megaplay and friends). Only the first
 * kind is usable here — an HLS playlist cannot be handed to a `<video>` tag.
 */
const DIRECT_HOSTS = ['my.1anime.site']

/** Their bot rules are aimed at scripts that look like scripts. */
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** Long enough for a slow page, short enough that nobody waits on a dead host. */
const TIMEOUT = 20_000

/**
 * Answers are kept here so a page of six episodes is one request, not six.
 *
 * Read lazily: this module is also imported by plain Node during tests, where
 * there is no Cache API at all — caching is an optimisation, never a
 * requirement, so a missing store simply means every call goes upstream.
 */
const store = () => (typeof caches === 'undefined' ? null : caches.default)

/**
 * A GET with our own rules: a browser-shaped request, a real deadline, and the
 * answer kept for `ttl` seconds. `redirect: 'manual'` is deliberate — the
 * stream endpoint answers with a 302 that *is* the answer.
 */
async function get(url, { ttl = 0, headers = {} } = {}) {
  const cache = store()
  const key = new Request(url, { headers: { 'x-probe': 'nineanime-api' } })

  if (cache && ttl > 0) {
    const hit = await cache.match(key)
    if (hit) return hit
  }

  const res = await fetch(url, {
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      ...headers,
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT),
  })

  if (cache && ttl > 0 && res.ok) {
    const copy = new Response(res.clone().body, res)
    // The body arriving here is already decoded, while the headers may still
    // describe the encoded version. A cached copy must agree with itself.
    copy.headers.delete('content-encoding')
    copy.headers.delete('content-length')
    copy.headers.set('cache-control', `public, max-age=${ttl}`)
    await cache.put(key, copy)
  }

  return res
}

/** JSON, or nothing. A page that answers 200 with HTML is not an answer. */
async function json(url, options) {
  const res = await get(url, options)
  if (!res.ok) throw new Failure(res.status, `upstream said ${res.status}`)
  const type = res.headers.get('content-type') ?? ''
  if (!type.includes('json')) throw new Failure(502, 'upstream sent something that is not json')
  return res.json()
}

/** Thrown with the status we want *the caller* to see, not the one we got. */
export class Failure extends Error {
  constructor(status, message, details = {}) {
    super(message)
    this.status = status
    this.details = details
  }
}

/** Their URLs carry escaped slashes; nothing else in a show page is parsed. */
const decode = (text) =>
  text
    .replace(/&#0?39;/g, "'")
    .replace(/&#8217;/g, "'")
    .replace(/&#8211;/g, '-')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')

/**
 * Their slugs are WordPress slugs: punctuation is *deleted*, not replaced, so
 * "I'll" becomes "ill" and "Re:ZERO" becomes "rezero". Getting this wrong is
 * the difference between one request and a search on every show.
 */
export function slugify(title) {
  return decode(title)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** What a title looks like when we only care whether two of them are the same. */
const flatten = (title) => slugify(title).replace(/-/g, '')

/** The show's internal id, which is the only key their episode API accepts. */
function seriesIdOf(html) {
  const direct = html.match(/data-series="(\d+)"/)
  if (direct) return Number(direct[1])
  const shortlink = html.match(/\?p=(\d+)/)
  return shortlink ? Number(shortlink[1]) : null
}

/**
 * Their catalogue, searched through the WordPress API they already expose.
 *
 * This is the single best endpoint on the whole site: 400 bytes, JSON, and it
 * answers with the show's id, its real slug and its real title at once. The
 * theme's own `?s=` page is 100 KB of markup for less information, so it is no
 * longer used for anything.
 */
async function searchCatalogue(title, { perPage = 10 } = {}) {
  const query = new URLSearchParams({
    search: title,
    per_page: String(perPage),
    subtype: 'any',
    _fields: 'id,title,url,subtype',
  })

  const body = await json(`${BASE}/wp-json/wp/v2/search?${query}`, { ttl: 86_400 })
  if (!Array.isArray(body)) return []

  return body
    .filter((hit) => hit?.subtype === 'series')
    .map((hit) => {
      const slug = String(hit.url ?? '')
        .replace(/\/+$/, '')
        .split('/')
        .pop()

      return { id: Number(hit.id), slug, title: decode(String(hit.title ?? '')) }
    })
    .filter((hit) => Number.isInteger(hit.id) && hit.id > 0 && hit.slug)
}

/** Episodes, as their own page already links them — never built from a number. */
function episodesOf(pages) {
  const found = []
  const pattern = /href="([^"]+)"[^>]*data-number="(\d+)"[^>]*data-id="(\d+)"/g
  for (const [, url, number, id] of pages.matchAll(pattern)) {
    found.push({ number: Number(number), id: Number(id), url })
  }
  return found
}

/**
 * Every server row for an episode, in the order they appear.
 *
 * The address is base64 and the host matters: 9anime serves some shows from
 * 1anime (a plain file behind a token) and others from a player like megaplay
 * (an HLS stream we cannot use). Reading all rows means we can pick a file when
 * one exists instead of refusing the episode because the first row was HLS.
 */
function sourcesOf(html) {
  const found = []
  const pattern = /data-type="(sub|dub)"[^>]*data-embed="([^"]+)"/g
  for (const [, audio, encoded] of html.matchAll(pattern)) {
    let url
    try {
      url = atob(encoded)
    } catch {
      continue
    }

    let host = ''
    let token = null
    try {
      const parsed = new URL(url)
      host = parsed.host
      token = parsed.pathname.split('/').filter(Boolean).pop() ?? null
    } catch {
      continue
    }

    found.push({ audio, host, url, token })
  }
  return found
}

/**
 * Their catalogue search, as `{ id, slug, title }` candidates.
 *
 * An empty list is a valid answer — the catalogue is a fixed set of shows, not
 * the whole of anime, so "no such title" is common and must stay quiet.
 */
export async function search(title) {
  return searchCatalogue(title, { perPage: 20 })
}

/**
 * Their WordPress search is fussy about punctuation and long queries: ask it
 * for a 15-word title with an apostrophe in it and it answers "nothing".
 *
 * So a title becomes a couple of short queries instead — the title as written,
 * then the same words with punctuation flattened to spaces. Both are tiny, and
 * a single one of them matching is enough.
 */
function queriesFor(title) {
  const clean = decode(title)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')

  const words = clean.split(/\s+/).filter(Boolean)
  const plain = clean.replace(/[^a-z0-9\s]/gi, ' ').split(/\s+/).filter(Boolean)

  return [...new Set([words.slice(0, 6).join(' '), plain.slice(0, 6).join(' ')])].filter(
    (query) => query.length >= 3,
  )
}

/** Exact title first, then a title that is a longer or shorter version of it. */
function bestMatch(candidates, title) {
  const wanted = flatten(title)
  return (
    candidates.find((hit) => flatten(hit.title) === wanted) ??
    candidates.find(
      (hit) =>
        flatten(hit.title).startsWith(wanted) ||
        wanted.startsWith(flatten(hit.title)) ||
        flatten(hit.title).includes(wanted),
    ) ??
    null
  )
}

/**
 * A show by title, or by slug when the title is not in the catalogue.
 *
 * The catalogue search goes first because it is both cheap and forgiving: it
 * matches words, so it survives the differences between our titles and theirs.
 * A computed slug is the fallback — smaller odds, but exact when it lands.
 */
export async function findShow(title, { slug } = {}) {
  if (!title && !slug) throw new Failure(400, 'a title or a slug is required')

  const seen = new Map()

  if (title) {
    for (const query of queriesFor(title)) {
      try {
        for (const hit of await searchCatalogue(query)) {
          if (!seen.has(hit.id)) seen.set(hit.id, hit)
        }
      } catch {
        // A broken search is not a dead end; the slug guess below may still work.
      }

      const best = bestMatch([...seen.values()], title)
      if (best) return { ...best, via: 'search' }
    }
  }

  const guess = slug ?? slugify(title)
  const page = await get(`${BASE}/anime/${guess}/`, { ttl: 86_400 })

  if (page.ok) {
    const id = seriesIdOf(await page.text())
    if (id) return { id, slug: guess, via: 'slug' }
  }

  // Called with a slug alone there is nothing left to try.
  if (!title) throw new Failure(404, `no show at ${guess}`)

  // Their search answers a miss with something arbitrary, so a miss must stay
  // a miss. Handing back a random show would mean serving another programme.
  throw new Failure(404, 'no show matches that title closely enough', {
    candidates: [...seen.values()].slice(0, 8),
  })
}

/** Every episode the show has, with the ids their own pages use. */
export async function listEpisodes(seriesId) {
  const body = await json(`${BASE}/wp-json/9animetv/v1/episodes/${seriesId}?active=0`, {
    ttl: 3_600,
  })
  if (!body || body.status !== true) throw new Failure(502, 'episode list refused')
  const episodes = episodesOf(String(body.pages ?? ''))
  if (!episodes.length) throw new Failure(404, 'this show has no episodes')
  return episodes
}

/**
 * Where their player keeps the file for one episode.
 *
 * Not every episode has one: some shows are served by an HLS player on another
 * host, which this API deliberately does not touch. That is a 422 with the
 * hosts named, not a 502 — nothing is broken upstream, we just do not have a
 * file to hand over.
 */
export async function playableFor(episodeId) {
  const body = await json(`${BASE}/ajax/episode/servers/?id=${episodeId}`, {
    ttl: 900,
    headers: { referer: `${BASE}/`, 'x-requested-with': 'XMLHttpRequest' },
  })

  const sources = sourcesOf(String(body?.html ?? ''))
  if (!sources.length) throw new Failure(404, 'no player for this episode')

  const direct = sources.find(
    (source) => DIRECT_HOSTS.includes(source.host) && /^[a-f0-9]{16,64}$/i.test(source.token ?? ''),
  )

  if (!direct) {
    throw new Failure(422, 'this episode is not available as a direct file', {
      sources: sources.map(({ audio, host }) => ({ audio, host })),
    })
  }

  return direct
}

/**
 * The file behind a token.
 *
 * Their stream endpoint refuses anyone without one of their own pages as
 * referer, and then answers with a redirect — so this is the one place we send
 * a header we are not supposed to have, and the one place the answer is a
 * header rather than a body.
 */
export async function fileFor(source) {
  const { host, token } = source ?? {}

  // The host came from someone else's JSON. Refuse to fetch anywhere but the
  // one host we know serves files, whatever an upstream answer claims.
  if (!DIRECT_HOSTS.includes(host) || !token) {
    throw new Failure(502, 'a direct file needs a known host and a token')
  }

  const res = await get(`https://${host}/stream/${token}`, {
    headers: { referer: `https://${host}/` },
  })

  const location = res.headers.get('location')
  if (!location) throw new Failure(502, 'stream gave no file')

  // A redirect to their own uploads is the only shape worth passing on; an
  // unexpected host means we are being pointed somewhere we did not agree to.
  if (!location.startsWith(`https://${host}/videos/`)) {
    throw new Failure(502, 'stream pointed somewhere unexpected')
  }

  return location
}
