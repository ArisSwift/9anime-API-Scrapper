# nineanime-api

A read-only JSON API over the four calls 9anime's own player makes, so a client
can go from "this anime's English title" to "a plain MP4" without scraping a
page or touching an ad.

It is deliberately small: no database, no accounts, no video proxying. It reads
their index, returns what it found, and gets out of the way. The video file
itself travels from their host to whoever is watching it — this API only ever
returns its address.

```
GET /health
GET /search?q=<title>
GET /anime/<slug>                 → show + episode list
GET /anime?title=<title>          → same, resolving the slug for you
GET /episode/<episode id>         → audio + file for one episode
GET /resolve?title=<t>&ep=<n>     → the whole chain, one request
GET /resolve?show=<id>&ep=<n>     → same, skipping the title lookup
```

Every answer is JSON, every error is `{ error, status }` with a matching HTTP
status, and every route is CORS-open so a browser can call it directly.

## Examples

```bash
# what a search box would show
curl -s "https://nineanime-api.<account>.workers.dev/search?q=Solo%20Leveling"

# resolve a title + episode to a file
curl -s "https://nineanime-api.<account>.workers.dev/resolve?title=Solo%20Leveling%20Season%202&ep=3"
```

```json
{
  "show": { "id": 3512, "slug": "magic-repo-man-dumped-by-my-party-ill-cash-in-with-a-cute-support-fairy-to-become-the-strongest", "via": "slug" },
  "episode": { "number": 3, "id": 3619, "url": "https://9anime.or.at/..." },
  "available": [1, 2, 3, 4, 5, 6],
  "audio": "sub",
  "host": "my.1anime.site",
  "file": "https://my.1anime.site/videos/....mp4"
}
```

## How a title becomes a file

1. **Show** — their WordPress search answers with the show's id, slug and real
   title in about 400 bytes. Titles with awkward punctuation get a second, more
   forgiving query. Only if that finds nothing do we compute the slug and try
   the show page directly (a 100 KB page, exact when it lands).
2. **Episodes** — asked for by show id. Their episode addresses are hand-typed
   and contain typos (`english-subed`), so they are never constructed.
3. **Player** — the server row carries the player address base64-encoded; decode
   it and the last path segment is an opaque token.
4. **File** — `/stream/<token>` needs one of their own pages as `Referer` and
   answers with a `302` to the MP4. That redirect *is* the answer.

Caching is done with the Cache API, per URL: show pages and searches for a day,
episode lists for an hour, server rows for fifteen minutes. Nothing is cached
per user, and a cold isolate simply pays for one more request.

## Where it can go wrong

- **Sub only, sometimes.** Plenty of shows have no dub row at all; `audio` says
  which one the file is.
- **It is a mirror, not all of anime.** Their series sitemap lists around 200
  shows — roughly the current-season shelf. A title outside it comes back as a
  `404`, which is the normal case for back catalogue.
- **Not every episode is a file.** 9anime spreads shows across several sources:
  1anime answers with an MP4, while others (megaplay, seen on Solo Leveling)
  answer with an HLS player on another domain. Those come back as a `422` with
  the hosts listed in `sources` — nothing is broken, there is just no file to
  hand over.
- **A wrong title is refused, not guessed.** If their search returns no close
  match, the answer is a `404` with up to eight `candidates` — never another
  show's episodes.
- **Tokens are opaque.** Nothing about them can be derived from a title or an
  episode number, and an old one can point at a different upload. Always resolve
  an episode immediately before playing it.
- **They can disappear.** This is somebody else's site; the whole API is one
  change on their end away from being useless. Treat it as a bonus source, not
  a backbone.

## Run it

```bash
npm install
npm run dev      # http://127.0.0.1:8787
npm run deploy   # publishes to workers.dev
npm run check    # syntax check both modules, no network
```
