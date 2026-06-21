import type { Subscribable } from "./lib";

// Off-log WEATHER projection — feeds.ts's pattern with an external fetch in it, keyed PER CARD by its
// title (a free-text location query). A weather card reads card.signals.weather(title), which resolves
// through here; the value is fetched from OUR dev server (/api/weather, which calls Open-Meteo
// SERVER-SIDE) — the card interior never touches the public internet, honouring the card-type rule
// that external data is polled by the host and the interior only ever reads a granted signal. Like
// every feed/content value it touches no diff, no intent event, no persistence: the durable log holds
// only the card's arrangement and its title. Refreshed on a slow timer while a card is subscribed —
// weather drifts over tens of minutes, not seconds — and the timer is dropped when the last card lets
// go, so an off-screen / deleted card stops polling. Shaped exactly like content.ts's per-key signals
// (dirListingSignal): cache + sub-set per normalized query, lazy fetch on first subscribe.

export interface WeatherData {
  q: string;
  resolved: boolean;
  name?: string;
  country?: string;
  admin1?: string;
  latitude?: number;
  longitude?: number;
  current?: {
    temperature: number;
    apparentTemperature: number;
    humidity: number;
    windSpeed: number;
    weatherCode: number;
    isDay: boolean;
    time: string;
  };
  units?: { temperature: string; windSpeed: string };
  error?: string | null;
  fetchedAt: number;
}

// 10 min: the API asks callers to be gentle and current conditions don't move faster than that. The
// server caches on the same horizon, so most ticks are a cheap cache hit anyway.
const REFRESH_MS = 10 * 60_000;

const values = new Map<string, WeatherData>();
const subs = new Map<string, Set<() => void>>();
const timers = new Map<string, ReturnType<typeof setInterval>>();
const inflight = new Set<string>();
const signals = new Map<string, Subscribable<WeatherData | undefined>>();

// Normalize the query to the cache key so "London", "london", and " London " share one fetch (the
// server normalizes identically). The original casing is still sent so the geocoder sees it verbatim.
const norm = (q: string): string => q.trim().toLowerCase();

async function fetchWeather(query: string): Promise<void> {
  const k = norm(query);
  if (inflight.has(k)) return;
  inflight.add(k);
  try {
    const r = await fetch(`/api/weather?q=${encodeURIComponent(query)}`);
    if (r.ok) {
      values.set(k, (await r.json()) as WeatherData);
      for (const fn of subs.get(k) ?? []) fn();
    }
  } catch {
    // offline — keep the last value (the card shows a staleness note); the next tick retries
  } finally {
    inflight.delete(k);
  }
}

// Channel-1 handle for one location's current weather, keyed by the normalized query — the weather
// card's `weather` capability resolves through this per render, exactly as the directory card's
// `dirListing` resolves through dirListingSignal. First subscribe lazily fetches and starts the slow
// refresh; the last unsubscribe stops it.
export function weatherSignal(query: string): Subscribable<WeatherData | undefined> {
  const k = norm(query);
  let s = signals.get(k);
  if (!s) {
    s = {
      get: () => values.get(k),
      subscribe(onChange) {
        let set = subs.get(k);
        if (!set) subs.set(k, (set = new Set()));
        set.add(onChange);
        if (!values.has(k)) void fetchWeather(query);
        if (!timers.has(k)) timers.set(k, setInterval(() => void fetchWeather(query), REFRESH_MS));
        return () => {
          set!.delete(onChange);
          if (set!.size === 0) {
            const t = timers.get(k);
            if (t) clearInterval(t);
            timers.delete(k);
          }
        };
      },
    };
    signals.set(k, s);
  }
  return s;
}
