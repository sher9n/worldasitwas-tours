# Socials pack

Sixteen posts, each with the words for four platforms and the picture or clip to
attach, on one page a social media manager can work straight from.

    node tools/socials/build.mjs

Served at `/media/_socials/`, which needs no platform key. A folder with no
`manifest.json` is skipped by the catalogue, so this cannot appear as a walk or
touch the app in any way.

## Where the media comes from

Nothing here is a mock-up.

- **Pictures** are real screenshots of the player, captured against the running
  app at 3x on a phone viewport. Each walk gives four: the opening screen with
  the interface (this is a product), and three from inside the walk with the
  buttons hidden (this is a place).
- **Clips** are composed by `tools/social-clip.sh` from those screenshots and
  the guide's own recorded voice. Screen recording was the obvious route and is
  the wrong one: the browser records no audio, and a narrated product with the
  narration stripped out is the one thing this must not be.

## Rebuilding

    # 1. the app must be running (npm run api, npm run playground)
    node tools/socials/shots.cjs <tour_id>...     # screenshots
    tools/social-clip.sh <tour_id>                # one clip
    node tools/socials/build.mjs                  # crops, montages, the page

Working pictures live in `content/work/socials/` rather than in the published
folder, so only what is actually served gets uploaded: 65 MB rather than 300.

## The words

`posts.json`. Four brand posts and one per walk, written per platform because a
LinkedIn paragraph dies on Twitter and a Snapchat line is not a LinkedIn post.
The page counts characters and marks anything over the 280 limit on X.

## Adding a post

1. Add an entry to `posts.json` (a brand post in `posts`, a walk post in
   `tourPosts`). Optional `schedule` ("2026-09-03 09:00 IST") flows into the
   agent brief; optional `platforms` narrows the copy columns.
2. `node tools/socials/build.mjs` — the build REFUSES to produce the page if
   anything is missing (a caption, a hook, a media file), naming every problem.
   Nothing half-made can ship.
3. `RAILWAY_TOKEN=... tools/socials/publish.sh` — sends only what changed.

Every post automatically gets its "Hand this post to an agent" block, and the
machine feed at `/media/_socials/briefs.json` regenerates with it. Agents are
told to fetch that feed fresh each run and to keep a ledger of published ids,
so re-running them after adding posts publishes only the new ones.
