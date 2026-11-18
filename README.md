# 9anime API Scrapper

A small read-only JSON API over the four calls 9anime's player already makes. You
give it an English title and an episode number, it gives you a link to an MP4.

I built it for my own player, so it does one job. It fetches their pages as
plain text and never renders them: no ads, no trackers, just the few responses
the player needs. There is no database and there are no accounts. It does not
proxy video either. The file travels from their host to whoever is watching it,
and this only hands over the address.

## Routes

| Route | What you get back |
| --- | --- |
| `GET /health` | `{ ok: true, version }` |
| `GET /search?q=<title>` | Candidate shows, plus `count` and `matched` |
| `GET /anime/<slug>` | One show and its episode list |
| `GET /anime?title=<title>` | The same, with the slug found for you |
| `GET /episode/<id>` | Audio, host and file for one episode id |
| `GET /resolve?title=<t>&ep=<n>` | The whole chain in one request |
| `GET /resolve?show=<id>&ep=<n>` | The same, once you have the show id |

`/` lists the routes too. Everything answers JSON, every failure is
`{ error, status }` with the matching HTTP status, and every route is CORS open
so a browser can call it directly.

## Run it

```bash
git clone https://github.com/ArisSwift/9anime-API-Scrapper.git
cd 9anime-API-Scrapper
npm install
npm run dev
```

It listens on `http://127.0.0.1:8787`.

```bash
# what a search box would show
curl -s "http://127.0.0.1:8787/search?q=Frieren"

# the show id from that answer, episode 1
curl -s "http://127.0.0.1:8787/resolve?show=<id>&ep=1"
```

## Deploy your own

`npm run deploy` publishes it with Wrangler. You need a Cloudflare account of
your own and nothing else. `workers_dev = true` in `wrangler.toml` gives you a
`.workers.dev` address for free. Add a `routes` entry there if you want a custom
domain; Cloudflare makes the DNS record and the certificate for you.

Before you deploy, look at `BASE` at the top of `src/nineanime.mjs`. That is the
site it reads. These mirrors move to a new domain every so often, and when this
one does, that constant is the only line you should need to change.

## What a resolve looks like

```json
{
  "show": { "id": 3512, "slug": "…", "via": "search" },
  "episode": { "number": 3, "id": 3619, "url": "…" },
  "available": [1, 2, 3, 4, 5, 6],
  "audio": "sub",
  "host": "…",
  "file": "https://<their file host>/videos/<id>.mp4",
  "ms": 1840
}
```

Values are shortened above. `via` says how the show was found: `search` or
`slug`. `ms` is how long the answer took.

## How a title becomes a file

1. **Show.** Their WordPress search answers with the id, slug and real title in
   about 400 bytes. Titles with awkward punctuation get a second, more forgiving
   query. Only if that finds nothing does it compute the slug and ask for the
   show page directly.
2. **Episodes.** Asked for by show id. Their episode addresses are typed by hand
   and contain typos, so they are read from the answer, never built.
3. **Player.** The server row carries the player address base64 encoded. Decode
   it and the last path segment is an opaque token.
4. **File.** Their stream route wants one of their own pages as `Referer` and
   answers with a redirect. That redirect is the answer.

Answers are cached per URL: shows and searches for a day, episode lists for an
hour, server rows for fifteen minutes. Nothing is cached per user.

## When it does not work

| Status | Meaning |
| --- | --- |
| `400` | A parameter is missing or the wrong shape |
| `404` | No show close enough to that title, no such episode number, or no player |
| `405` | Only `GET` and `OPTIONS` are allowed |
| `422` | No direct file. `sources` lists the hosts it did find |
| `502` | Upstream refused, or answered with something that is not JSON |

A missing episode comes back as a `404` with `available`, so you can tell "wrong
episode number" from "wrong show" without guessing. A title that does not match
comes back with up to eight `candidates` and no episodes, because handing you
another show's file would be worse than an error.

## What to expect

- **It is one mirror, not all of anime.** The series list is around 200 shows,
  roughly the current season. Back catalogue titles come back `404`, which is
  the normal case, not a bug.
- **Sub only, sometimes.** Plenty of shows have no dub row. `audio` says which
  one you got.
- **Not every episode is a file.** Some shows are served by an HLS player on
  another host. Those answer `422` with the hosts named. Nothing is broken;
  there is just no file to hand over.
- **Tokens are opaque.** Nothing about them follows from a title or an episode
  number, and an old one can point at a different upload. Resolve an episode
  again right before you play it.
- **They can change it whenever they like.** This is somebody else's site, and
  the whole thing is one change on their end away from being useless. Treat it
  as a bonus source, not a backbone.
- **Be gentle.** It is a scraper aimed at a site that would rather it were not.
  Send one request per question, keep the cache on, and do not build a crawler
  out of it.

## Notes

Not affiliated with 9anime. No files are hosted here and nothing is proxied, so
whatever is served is served by them, under their terms. Read only, personal
use, and no warranty.
