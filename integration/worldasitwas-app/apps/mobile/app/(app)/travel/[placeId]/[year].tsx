/**
 * The walk itself.
 *
 * Replaces the placeholder that reserved this route. Everything the traveller
 * sees from here is rendered by the tour service: the stills, her voice, the
 * points of interest, the live companion. This screen resolves which walk to
 * open, gives it the whole screen, and listens for the one event that means
 * they are done.
 *
 * Deliberately the only file the tour needs in the app. A new city, a rewritten
 * script, a new kind of card — none of it is an app release.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, BackHandler, Platform, Pressable, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { parseTourEvent, tourCommandScript } from "../../../../src/tours/timetravel";
import { hit, radius, space, type } from "../../../../src/theme/theme";
import { useTheme } from "../../../../src/theme/useTheme";
import { useTourSource } from "../../../../src/data/useTourSource";
import { useTrack } from "../../../../src/analytics/events";

export default function Travel() {
  const { color, material } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const track = useTrack();
  const { placeId, year } = useLocalSearchParams<{ placeId: string; year: string }>();
  const { resolveTour } = useTourSource();
  const web = useRef<WebView>(null);

  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState(false);

  /* ── which walk ──────────────────────────────────────────────────────── */

  useEffect(() => {
    let live = true;
    resolveTour(placeId, Number(year))
      .then((found) => {
        if (!live) return;
        // Null is an answer, not a failure: we hold the city but not that year.
        // It reads differently from a network error and must look different too.
        if (found) setUrl(found.playerUrl);
        else setMissing(true);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [placeId, year, resolveTour]);

  /* ── what the player tells us ────────────────────────────────────────── */

  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
      const ev = parseTourEvent(e.nativeEvent.data);
      // Not ours. A WebView carries other traffic and a host must never throw
      // on a message it did not ask for.
      if (!ev) return;

      switch (ev.name) {
        case "tour_started":
          track("tour_started", { tourId: String(ev.payload.tourId), placeId, year: Number(year) });
          break;
        case "stop_entered":
          track("tour_stop_entered", {
            tourId: String(ev.payload.tourId),
            stopId: String(ev.payload.stopId),
            order: Number(ev.payload.order),
          });
          break;
        case "tour_completed":
          track("tour_completed", { tourId: String(ev.payload.tourId), elapsedSec: Number(ev.payload.elapsedSec) });
          router.back();
          break;
        case "tour_left":
          // The player's own close button, or our exit command. Without this
          // the traveller is left looking at a cover they already walked away
          // from, with no way back.
          track("tour_left", {
            tourId: String(ev.payload.tourId),
            stopId: ev.payload.stopId ? String(ev.payload.stopId) : undefined,
            elapsedSec: Number(ev.payload.elapsedSec),
          });
          router.back();
          break;
        case "error":
          setFailed(true);
          break;
      }
    },
    [placeId, year, router, track],
  );

  /* ── the app's own lifecycle ─────────────────────────────────────────── */

  const command = useCallback((name: "pause" | "resume" | "exit") => {
    web.current?.injectJavaScript(tourCommandScript(name));
  }, []);

  useEffect(() => {
    // A backgrounded WebView keeps its audio going on Android, so she carries
    // on talking to a locked phone. Quieten her, and pick up mid-sentence.
    const sub = AppState.addEventListener("change", (state) => command(state === "active" ? "resume" : "pause"));
    return () => sub.remove();
  }, [command]);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    // Let the player close itself rather than popping the screen underneath
    // it: that is how her voice stops cleanly and how tour_left gets emitted
    // with the stop they actually reached.
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!url) return false;
      command("exit");
      return true;
    });
    return () => sub.remove();
  }, [command, url]);

  /* ── render ──────────────────────────────────────────────────────────── */

  if (missing || failed) {
    return (
      <View style={{ flex: 1, backgroundColor: color.ground, padding: space.inset, justifyContent: "center" }}>
        <Text style={[type.cityName, { color: color.paper }]}>{missing ? "Not this year" : "Not right now"}</Text>
        <Text style={[type.rowSub, { color: color.grey, marginTop: space.md, maxWidth: 320 }]}>
          {missing
            ? "There is no walk for this year yet. It is still in the archive."
            : "The walk could not be reached. Check your connection and try again."}
        </Text>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back" style={{ marginTop: space.xxl }}>
          <Text style={[type.rowSub, { color: color.grey }]}>Back</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: color.ground }}>
      {url ? (
        <WebView
          ref={web}
          source={{ uri: url }}
          onMessage={onMessage}
          style={{ flex: 1, backgroundColor: color.ground }}
          // She speaks the moment the walk begins, and every beat is timed to
          // her voice. Without these two the first stop is silent, or iOS
          // hands the video to the system full-screen player.
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          // The Ask button opens a live microphone. iOS also needs
          // NSMicrophoneUsageDescription; Android needs RECORD_AUDIO.
          mediaCapturePermissionGrantType="grant"
          // Nothing in the walk is typed, and a keyboard over a full-bleed
          // still is never wanted.
          keyboardDisplayRequiresUserAction
          // Read-only content from one origin: no downloads, no new windows.
          setSupportMultipleWindows={false}
          onError={() => setFailed(true)}
          onHttpError={() => setFailed(true)}
        />
      ) : (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={color.amber} />
        </View>
      )}

      {/* Ours, not the player's: it belongs in our safe area, in our chrome. */}
      <Pressable
        onPress={() => command("exit")}
        accessibilityRole="button"
        accessibilityLabel="Close the walk"
        style={{
          position: "absolute",
          top: insets.top + space.md,
          left: space.lg,
          height: hit.min,
          paddingHorizontal: space.lg,
          borderRadius: radius.pill,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: material.fill,
        }}
      >
        <Text style={[type.buttonQuiet, { color: color.paper }]}>Close</Text>
      </Pressable>
    </View>
  );
}
