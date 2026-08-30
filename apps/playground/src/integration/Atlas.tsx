/**
 * "Atlas" — our walks on somebody else's map.
 *
 * The other two integration tabs answer "they pressed Travel, now what". This
 * one answers the question before it: how does anyone find a walk at all? It
 * reads `/v1/feed` and draws every published walk where it physically happens,
 * which is the thing a list of years cannot do. Standing in front of Big Ben is
 * a reason to take a walk; scrolling past "1850" is not.
 *
 * It is also the reference implementation. The map style, the route line and
 * the numbered stop pins are all written to be lifted into a host app, which is
 * why nothing here depends on the playground around it beyond `api.feed()`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import type { Feed, FeedStop, FeedTour } from "@timetravel/schema";
import { api } from "../api.ts";
import { archiveStyle } from "./mapStyle.ts";
import "maplibre-gl/dist/maplibre-gl.css";

/** Far enough out that the whole world fits. */
const WORLD = { center: [10, 30] as [number, number], zoom: 1.2 };

/**
 * Below this a city is a single pin; above it the walks inside it are drawn
 * individually. Chosen so a country fills the screen at the switch, which is the
 * point where one pin per city stops being enough information.
 */
const CITY_ZOOM = 6;

/**
 * Above this the stops of every walk in view are drawn, whether or not a walk is
 * selected. This is the "I zoomed in myself and the tour points are there"
 * case: at street level the pins are the discovery surface.
 */
const STOP_ZOOM = 11;

const ROUTE_SOURCE = "tt-routes";
const ROUTE_LAYER = "tt-routes-line";

interface Props {
  /** Opens the hosted player, the same way the Embed tab does. */
  onOpen: (tourId: string) => void;
}

/** Every stop of a walk, as the line that joins them in walking order. */
function routeFeature(tour: FeedTour) {
  return {
    type: "Feature" as const,
    properties: { tourId: tour.id },
    geometry: { type: "LineString" as const, coordinates: tour.stops.map((s) => [s.lng, s.lat]) },
  };
}

function bounds(stops: FeedStop[]): maplibregl.LngLatBounds {
  const b = new maplibregl.LngLatBounds();
  for (const s of stops) b.extend([s.lng, s.lat]);
  return b;
}

function chip(className: string, label: string, title: string): HTMLElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = className;
  el.textContent = label;
  el.title = title;
  el.setAttribute("aria-label", title);
  return el;
}

export function Atlas({ onOpen }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const markers = useRef<maplibregl.Marker[]>([]);
  const [feed, setFeed] = useState<Feed | null>(null);
  const [error, setError] = useState("");
  const [tourId, setTourId] = useState<string | null>(null);
  const [stopId, setStopId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(WORLD.zoom);
  const [ready, setReady] = useState(false);

  const tour = useMemo(() => feed?.tours.find((t) => t.id === tourId) ?? null, [feed, tourId]);
  const stop = useMemo(() => tour?.stops.find((s) => s.id === stopId) ?? null, [tour, stopId]);

  useEffect(() => {
    api
      .feed()
      .then(setFeed)
      .catch((e: Error) => setError(e.message));
  }, []);

  /* ------------------------------- the map ------------------------------- */

  useEffect(() => {
    if (!container.current || map.current) return;
    const m = new maplibregl.Map({
      container: container.current,
      style: archiveStyle("dark"),
      ...WORLD,
      attributionControl: { compact: true },
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    m.on("load", () => {
      // One source for every route. Which of them is drawn is a filter, so
      // selecting a walk never rebuilds the source.
      m.addSource(ROUTE_SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addLayer({
        id: ROUTE_LAYER,
        type: "line",
        source: ROUTE_SOURCE,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#e8b86a",
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.5, 14, 3, 18, 5],
          "line-opacity": 0.85,
          "line-dasharray": [2, 1.4],
        },
      });
      setReady(true);
    });
    // Which pins are worth drawing is a function of how far in you are, so the
    // zoom has to reach React rather than staying inside the map.
    m.on("moveend", () => setZoom(m.getZoom()));
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
      setReady(false);
    };
  }, []);

  /* ------------------------------ the pins ------------------------------- */

  useEffect(() => {
    const m = map.current;
    if (!m || !ready || !feed) return;

    for (const marker of markers.current) marker.remove();
    markers.current = [];

    const add = (el: HTMLElement, lng: number, lat: number, onClick: () => void) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        onClick();
      });
      markers.current.push(new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(m));
    };

    // Far out: one pin per city, because forty stop pins on a world map is a
    // smear rather than information.
    if (zoom < CITY_ZOOM && !tour) {
      for (const city of feed.cities) {
        const walks = feed.tours.filter((t) => t.city.id === city.id);
        if (walks.length === 0) continue;
        add(
          chip("atlas-pin atlas-pin--city", `${city.name} · ${walks.length}`, `${walks.length} walk${walks.length === 1 ? "" : "s"} in ${city.name}`),
          city.anchor.lng,
          city.anchor.lat,
          () => {
            m.flyTo({ center: [city.anchor.lng, city.anchor.lat], zoom: 12.4, duration: 1200 });
            // Not selected outright: a city with three walks in it is a choice,
            // and picking one for them would hide the other two.
            setTourId(null);
            setStopId(null);
          },
        );
      }
    }

    // Mid: where each walk begins, labelled by its year. Only until the stops
    // themselves are drawn, because a walk's start pin sits on the exact
    // coordinate of its own first stop and the two would stack.
    if (zoom >= CITY_ZOOM && zoom < STOP_ZOOM && !tour) {
      for (const t of feed.tours) {
        add(chip("atlas-pin atlas-pin--tour", `${t.year}`, `${t.title} · ${t.city.name}`), t.start.lng, t.start.lat, () => {
          setTourId(t.id);
          setStopId(null);
        });
      }
    }

    // The stops themselves: always for a selected walk, and once you are close
    // enough, for every walk in view whether or not one is chosen.
    //
    // In view, not everywhere. Drawing all sixty stops on the planet put fifty
    // markers off-screen for every one you could see, and made the nearest pin
    // to a click something in another country.
    const inView = () => {
      const box = m.getBounds();
      return feed.tours.filter((t) => t.stops.some((s) => box.contains([s.lng, s.lat])));
    };
    const showing = tour ? [tour] : zoom >= STOP_ZOOM ? inView() : [];
    for (const t of showing) {
      for (const s of t.stops) {
        const selected = t.id === tourId && s.id === stopId;
        add(
          chip(`atlas-pin atlas-pin--stop${selected ? " is-on" : ""}`, String(s.order), `${s.name} · ${t.title}`),
          s.lng,
          s.lat,
          () => {
            setTourId(t.id);
            setStopId(s.id);
          },
        );
      }
    }

    const source = m.getSource(ROUTE_SOURCE) as maplibregl.GeoJSONSource | undefined;
    source?.setData({ type: "FeatureCollection", features: showing.map(routeFeature) });
  }, [feed, ready, zoom, tourId, stopId, tour]);

  // Selecting a walk frames the whole of it, so its shape is the first thing
  // you see. Padded generously at the bottom: the detail panel sits over the map.
  useEffect(() => {
    const m = map.current;
    if (!m || !tour) return;
    m.fitBounds(bounds(tour.stops), { padding: { top: 60, left: 470, right: 60, bottom: 60 }, maxZoom: 15.5, duration: 900 });
  }, [tour]);

  /* ------------------------------- render -------------------------------- */

  return (
    <div className="atlas">
      <div className="atlas-head">
        <div>
          <h3>Our walks, on your map</h3>
          <p>
            One call to <code>GET /v1/feed</code> returns every published walk with its stops. Everything drawn here comes
            from that one document: the city pins, the route, the numbered stops and the panel.
          </p>
        </div>
        {feed && (
          <p className="atlas-count">
            {feed.tours.length} walk{feed.tours.length === 1 ? "" : "s"} · {feed.tours.reduce((n, t) => n + t.stops.length, 0)} stops ·{" "}
            {feed.cities.length} cities
          </p>
        )}
      </div>

      {error && <p className="atlas-error">Could not read the feed: {error}</p>}

      <div className="atlas-stage">
        <div ref={container} className="atlas-map" />

        {tour && (
          <aside className="atlas-card">
            <button className="atlas-back" onClick={() => (setTourId(null), setStopId(null))} aria-label="Back to every walk">
              ×
            </button>
            <div className="atlas-card-top">
              <img className="atlas-cover" src={tour.cover.image} alt="" />
              <div>
                <p className="atlas-eyebrow">
                  {tour.city.name} · {tour.year}
                </p>
                <h4>{tour.title}</h4>
                <p className="atlas-meta">
                  {tour.companion.name}, {tour.companion.role} · {tour.stopCount} stops · {Math.round(tour.durationMin)} min
                </p>
              </div>
            </div>
            <p className="atlas-summary">{tour.summary}</p>
            <button className="atlas-open" onClick={() => onOpen(tour.id)}>
              Open this walk
            </button>

            <ol className="atlas-stops">
              {tour.stops.map((s) => (
                <li key={s.id}>
                  <button
                    className={s.id === stopId ? "is-on" : ""}
                    onClick={() => {
                      setStopId(s.id);
                      map.current?.flyTo({ center: [s.lng, s.lat], zoom: 16, duration: 800 });
                    }}
                  >
                    <span className="atlas-order">{s.order}</span>
                    <span className="atlas-stop-body">
                      <strong>{s.name}</strong>
                      <em>{s.description}</em>
                      <code>
                        {s.lat.toFixed(4)}, {s.lng.toFixed(4)}
                      </code>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </aside>
        )}

        {!tour && (
          <p className="atlas-hint">
            {zoom < CITY_ZOOM ? "Pick a city, or zoom in." : zoom < STOP_ZOOM ? "Pick a year to see where it goes." : "Every stop in view. Pick one."}
          </p>
        )}
      </div>

      {stop && !tour && <p className="atlas-hint">{stop.name}</p>}
    </div>
  );
}
