# Portrait gallery

Every guide's presence loop on one page, so the twelve can be looked at
together rather than one walk at a time.

    node tools/portrait-gallery/build.mjs      # copies the clips and writes index.html

The page is generated from the recipes and each companion's finished loop, so
it cannot drift from what the guides actually look like. Run it again after any
presence rebuild.

`content/tours/` is generated media and is not in git, so the generator lives
here and writes into `content/tours/_portraits`. Publishing:

    RAILWAY_TOKEN=<project token> railway volume files \
      --volume worldasitwas-tours-volume \
      upload content/tours/_portraits /tours --overwrite --concurrency 4

It is served at `/media/_portraits/`, which needs no platform key: `/media/` is
public, and a folder with no `manifest.json` is skipped by the catalogue, so it
cannot appear as a walk. Media is served with a year's cache life, so link to
`/media/_portraits/?v=N` with a new N whenever the page itself changes.

## Related

- `tools/rebuild-presence.sh` rebuilds every guide's loop and republishes the walk.
- `tools/check-presence.mjs` measures length, motion and the loop join for all twelve.
- `apps/pipeline/src/stages/presence.ts` explains why the loop is built in
  segments and why nothing in the prompt asks the guide to hold still.
