# Integrating the tours into World As It Was

Copy-in files for `eriktall/worldasitwas-app`. Every path below mirrors where the
file goes in that repo, so the whole folder can be copied over the top of it.

The app is in design phase and its Travel row already routes to a screen the
workboard reserves for the tour: `apps/mobile/app/(app)/travel/[placeId]/[year].tsx`,
whose own comment says *"this screen is a placeholder. The partner's tour UI
replaces it."* That is exactly what this does, and it touches nothing else.

## What it costs

| | |
|---|---|
| New dependencies in the app | one — `react-native-webview` |
| Files replaced | one — the Travel placeholder |
| Files added | one — the vendored client |
| Contract changes | one method on `TourSource`, four names on the analytics union |
| API routes added | one — `GET /places/:id/eras/:year/tour` |
| Tour content in the bundle | none |
| App release needed for a new city | none |

## The files

```
apps/mobile/src/tours/timetravel.ts                     the client, vendored (no dependencies)
apps/mobile/app/(app)/travel/[placeId]/[year].tsx       replaces the placeholder
apps/mobile/src/data/tour-source.md                     the TourSource + analytics additions
apps/api/src/routes/tours.ts                            the only place the platform key lives
```

`timetravel.ts` is a byte-for-byte copy of `packages/client/src/index.ts` in the
tour repo, kept honest by `tools/check-vendored-client.cjs` there. It imports
nothing, so it works in Hermes with no polyfill; when the client is published to
npm, delete the file and change the import to `@timetravel/client`.

## Steps

```sh
npx expo install react-native-webview
```

```sh
# apps/mobile/.env — public by design
EXPO_PUBLIC_TOURS_PLAYER_URL=https://tours.worldasitwas.com

# apps/api — server-side, never EXPO_PUBLIC_
TOURS_API_URL=https://tours.worldasitwas.com
TOURS_PLAYER_URL=https://tours.worldasitwas.com
TOURS_PLATFORM_KEY=…
```

Then apply `apps/mobile/src/data/tour-source.md`, register the route in
`apps/api/src/app.ts` next to the others:

```ts
import { registerTourRoutes } from "./routes/tours.js";
registerTourRoutes(app, getPoolLazy);
```

and add to `apps/mobile/app.config.ts`, for the Ask button's microphone:

```ts
ios: { infoPlist: { NSMicrophoneUsageDescription: "Ask your guide a question while you walk." } },
android: { permissions: ["RECORD_AUDIO"] },
```

Everything else in the app is untouched. `EraList` already pushes the route.

## The one rule

`TOURS_PLATFORM_KEY` is a server-side credential. It must never reach the app:
an `EXPO_PUBLIC_` variable is compiled into the `.ipa` and can be read out of a
downloaded build. The app asks its own API which walk to open, and the API hands
back a player URL that carries no key at all.

## Trying it before any of this exists

The tour repo's playground has an **Integrate** tab (the code, per platform) and
an **Embed** tab (the real player in a frame, with the event bridge live, so you
can watch `stop_entered` arrive and send `pause` back). Run `npm run api` and
`npm run playground` there and open <http://localhost:5173>.

## Where the seam falls

| You own | We own |
|---|---|
| The route, the transition onto the screen, popping it again | Everything drawn inside the frame |
| The close affordance, in your safe area | Pause, skip, points of interest, the Ask button |
| Entitlement: whether this traveller may open this walk | Which walk exists for a city and year, and what is in it |
| Analytics, and remembering the stop they left at | Emitting the events those are built from |

## What the player sends

`parseTourEvent` returns a typed event or `null`; anything that is not ours
reads as `null` rather than throwing.

| Event | When | Act on it |
|---|---|---|
| `ready` | The manifest loaded, the cover is up | Hide your spinner. Sent once. |
| `tour_started` | They pressed begin | |
| `stop_entered` | They arrived at a stop | Store `stopId` to resume later |
| `card_viewed` | A screen was left behind | |
| `hotspot_opened` | They tapped a point of interest | |
| `ask_started` | They held Ask and interrupted her | |
| `companion_tool` | She acted on something they said | |
| `tour_completed` | They reached the end | **Pop the screen** |
| `tour_left` | They closed the walk early | **Pop the screen.** Keep `stopId` |
| `error` | The walk could not be shown | Show your failure state |

And back the other way, with `injectJavaScript(tourCommandScript(name))`:
`pause`, `resume`, `exit`. The screen here already wires `pause`/`resume` to
`AppState` and `exit` to the Android back button.

## Resuming

`tour_left` carries the stop they reached. Hand it back and the walk starts
there:

```ts
tours.playerUrl(tourId, { travellerId, stopId });
```

A stop that no longer exists — the tour was republished with a different
route — quietly starts from the beginning rather than failing.
