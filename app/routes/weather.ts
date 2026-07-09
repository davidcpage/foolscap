import type { ServerResponse } from "node:http";
import { sendJson } from "../server-http.js";
import { exact, type GlobalRoute } from "./router.js";

// ── /api/weather (god-file split, Phase 1) ─────────────────────────────────────────────────────────
// The weather card's server proxy for Open-Meteo (a free, key-less endpoint), with a short TTL: weather
// drifts slowly and the public endpoint asks callers to be gentle, so a fleet of cards (or a tab reopen)
// collapses onto one fetch per location per window. Never throws to the client — an unresolved place or an
// offline upstream comes back as a 200 with an `error` tag the card renders as a message, mirroring the
// usage feed's last-good-with-an-error-pill discipline. The self-contained extraction (no shared state or
// helpers beyond sendJson): the cache is a plain module Map, TTL'd and best-effort, exactly as before.
interface WeatherCacheEntry {
  ts: number;
  data: unknown;
}
const weatherCache = new Map<string, WeatherCacheEntry>();
const WEATHER_TTL_MS = 10 * 60_000;

async function handleWeather(res: ServerResponse, q: string): Promise<void> {
  const query = q.trim();
  if (!query) return sendJson(res, 200, { q, resolved: false, error: "no-location", fetchedAt: Date.now() });
  const key = query.toLowerCase();
  const hit = weatherCache.get(key);
  if (hit && Date.now() - hit.ts < WEATHER_TTL_MS) return sendJson(res, 200, hit.data);

  const cache = (data: unknown): void => void weatherCache.set(key, { ts: Date.now(), data });
  try {
    const geoRes = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=en&format=json`,
    );
    const geo = (await geoRes.json()) as { results?: Array<Record<string, unknown>> };
    const loc = geo.results?.[0];
    if (!loc) {
      const data = { q: query, resolved: false, error: "not-found", fetchedAt: Date.now() };
      cache(data); // a misspelling shouldn't re-hit the geocoder every refresh tick
      return sendJson(res, 200, data);
    }
    const lat = Number(loc.latitude);
    const lon = Number(loc.longitude);
    const wxRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
        `&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m&timezone=auto`,
    );
    const wx = (await wxRes.json()) as {
      current?: Record<string, number | string>;
      current_units?: Record<string, string>;
    };
    const c = wx.current ?? {};
    const u = wx.current_units ?? {};
    const data = {
      q: query,
      resolved: true,
      name: loc.name as string,
      country: (loc.country as string | undefined) ?? undefined,
      admin1: (loc.admin1 as string | undefined) ?? undefined,
      latitude: lat,
      longitude: lon,
      current: {
        temperature: Number(c.temperature_2m),
        apparentTemperature: Number(c.apparent_temperature),
        humidity: Number(c.relative_humidity_2m),
        windSpeed: Number(c.wind_speed_10m),
        weatherCode: Number(c.weather_code),
        isDay: Number(c.is_day) === 1,
        time: String(c.time ?? ""),
      },
      units: { temperature: u.temperature_2m ?? "°C", windSpeed: u.wind_speed_10m ?? "km/h" },
      error: null,
      fetchedAt: Date.now(),
    };
    cache(data);
    sendJson(res, 200, data);
  } catch {
    // offline / upstream down — serve the last good reading with a staleness tag if we have one, else
    // a bare offline marker. Either way a 200 the card can render, never a 5xx it would have to special-case.
    const stale = weatherCache.get(key);
    if (stale) return sendJson(res, 200, { ...(stale.data as object), error: "offline", fetchedAt: Date.now() });
    sendJson(res, 200, { q: query, resolved: false, error: "offline", fetchedAt: Date.now() });
  }
}

export const weatherRoutes: GlobalRoute[] = [
  { match: exact("/api/weather"), run: (_req, res, url) => void handleWeather(res, url.searchParams.get("q") ?? "") },
];
