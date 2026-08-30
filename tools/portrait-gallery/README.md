# Portrait gallery

A one-page pick sheet for the guide's moving portrait: the same still,
animated several ways, so a direction can be chosen by eye rather than
argued about.

`content/tours/` is generated media and is not in git, so the authored page
lives here and is copied in at publish time:

    cp tools/portrait-gallery/index.html content/tours/_portraits/index.html
    RAILWAY_TOKEN=<project token> railway volume files \
      --volume worldasitwas-tours-volume \
      upload content/tours/_portraits /tours --overwrite --concurrency 4

It is served at `/media/_portraits/`, which needs no platform key: `/media/`
is public, and a folder with no `manifest.json` is skipped by the catalogue,
so it cannot appear as a walk.
