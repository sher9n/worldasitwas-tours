import type { StyleSpecification } from "maplibre-gl";

/**
 * The Archive map, as the host app draws it.
 *
 * This is a copy of `apps/web/src/map/style.ts` in World As It Was, on purpose:
 * the point of the Atlas tab is to show our feed on the map it will actually be
 * plotted on, not on a stock basemap that flatters it. It is also the file a
 * different host would start from, which is why it is here rather than hidden
 * inside the component.
 *
 * Tiles come from OpenFreeMap: no key, no account, no quota.
 */
const TILES = "https://tiles.openfreemap.org/planet";

export type Scheme = "light" | "dark";

const PALETTE: Record<Scheme, { ground: string; land: string; water: string; ink: string; coast: string; border: string }> = {
  light: {
    ground: "#f7f2e7",
    land: "#efe8d7",
    water: "#e2dbc8",
    ink: "#141110",
    coast: "rgba(20,17,12,0.20)",
    border: "rgba(20,17,12,0.14)",
  },
  dark: {
    ground: "#131822",
    land: "#1b2230",
    water: "#070b12",
    ink: "#f4ecd8",
    coast: "rgba(203,209,222,0.34)",
    border: "rgba(244,236,216,0.16)",
  },
};

export function archiveStyle(scheme: Scheme = "dark"): StyleSpecification {
  const p = PALETTE[scheme];
  return {
    version: 8,
    sources: { openmaptiles: { type: "vector", url: TILES } },
    layers: [
      { id: "background", type: "background", paint: { "background-color": p.ground } },
      { id: "landcover", type: "fill", source: "openmaptiles", "source-layer": "landcover", paint: { "fill-color": p.land, "fill-opacity": 0.5 } },
      { id: "water", type: "fill", source: "openmaptiles", "source-layer": "water", paint: { "fill-color": p.water } },
      {
        id: "coastline",
        type: "line",
        source: "openmaptiles",
        "source-layer": "water",
        paint: { "line-color": p.coast, "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.5, 6, 0.8, 12, 1.4] },
      },
      {
        id: "building",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "building",
        minzoom: 13,
        paint: { "fill-color": p.ink, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 13, 0, 15.5, scheme === "dark" ? 0.1 : 0.14] },
      },
      {
        id: "road",
        type: "line",
        source: "openmaptiles",
        "source-layer": "transportation",
        minzoom: 9,
        filter: ["!", ["in", ["get", "class"], ["literal", ["track", "path", "ferry"]]]],
        paint: {
          "line-color": p.ink,
          "line-opacity": ["interpolate", ["linear"], ["zoom"], 9, scheme === "dark" ? 0.14 : 0.18, 14, scheme === "dark" ? 0.3 : 0.4],
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            9, ["match", ["get", "class"], ["motorway", "trunk"], 0.8, 0.3],
            14, ["match", ["get", "class"], ["motorway", "trunk"], 2.4, ["primary", "secondary"], 1.6, 0.7],
            18, ["match", ["get", "class"], ["motorway", "trunk"], 8, ["primary", "secondary"], 6, 3],
          ],
        },
      },
      {
        id: "boundary",
        type: "line",
        source: "openmaptiles",
        "source-layer": "boundary",
        filter: ["<=", ["get", "admin_level"], 2],
        paint: { "line-color": p.border, "line-width": 0.6 },
      },
    ],
  };
}
