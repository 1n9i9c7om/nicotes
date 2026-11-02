import type { AdapterValue } from '@nicotes/shared';
import { AdapterError, getJson, round, type Source } from './sources.js';

/** Open-Meteo: forecasts without an account or key (free for non-commercial use). */
const GEOCODING = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST = 'https://api.open-meteo.com/v1/forecast';

/** WMO weather interpretation codes, as Open-Meteo reports them. */
const CODES: [number[], string][] = [
  [[0], 'Clear sky'],
  [[1], 'Mainly clear'],
  [[2], 'Partly cloudy'],
  [[3], 'Overcast'],
  [[45, 48], 'Fog'],
  [[51, 53, 55], 'Drizzle'],
  [[56, 57], 'Freezing drizzle'],
  [[61], 'Light rain'],
  [[63], 'Rain'],
  [[65], 'Heavy rain'],
  [[66, 67], 'Freezing rain'],
  [[71], 'Light snow'],
  [[73], 'Snow'],
  [[75], 'Heavy snow'],
  [[77], 'Snow grains'],
  [[80, 81, 82], 'Rain showers'],
  [[85, 86], 'Snow showers'],
  [[95], 'Thunderstorm'],
  [[96, 99], 'Thunderstorm with hail'],
];
export const weatherText = (code: number | null | undefined) => CODES.find(([codes]) => codes.includes(code ?? -1))?.[1] ?? null;

const COORDINATES = /^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/;

interface Daily {
  time?: string[];
  weather_code?: (number | null)[];
  temperature_2m_max?: (number | null)[];
  temperature_2m_min?: (number | null)[];
  precipitation_sum?: (number | null)[];
  precipitation_probability_max?: (number | null)[];
  sunshine_duration?: (number | null)[];
  wind_speed_10m_max?: (number | null)[];
}

const num = (value: number | null | undefined) => (typeof value === 'number' && Number.isFinite(value) ? round(value) : null);

/** The day's forecast for a place: weather, high and low, rain, sunshine, wind. */
export const weather: Source = {
  async read(ctx) {
    const place = ctx.config.place!.trim();
    let latitude: number;
    let longitude: number;
    const coords = COORDINATES.exec(place);
    if (coords) {
      latitude = Number(coords[1]);
      longitude = Number(coords[2]);
    } else {
      const found = (await getJson(ctx, `${GEOCODING}?name=${encodeURIComponent(place)}&count=1&format=json`, 'Open-Meteo')) as {
        results?: { latitude: number; longitude: number }[];
      };
      const first = found.results?.[0];
      if (!first) throw new AdapterError(`Open-Meteo knows no place called “${place}”`);
      ({ latitude, longitude } = first);
    }
    const params = new URLSearchParams({
      latitude: String(latitude),
      longitude: String(longitude),
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,sunshine_duration,wind_speed_10m_max',
      timezone: ctx.timeZone,
      start_date: ctx.date,
      end_date: ctx.date,
    });
    const data = (await getJson(ctx, `${FORECAST}?${params}`, 'Open-Meteo')) as { daily?: Daily };
    const daily = data.daily ?? {};
    const at = daily.time?.indexOf(ctx.date) ?? -1;
    if (at < 0) throw new AdapterError(`Open-Meteo has no forecast for ${ctx.date}`);

    const sky = weatherText(daily.weather_code?.[at]);
    const high = num(daily.temperature_2m_max?.[at]);
    const low = num(daily.temperature_2m_min?.[at]);
    const rain = num(daily.precipitation_sum?.[at]);
    const chance = num(daily.precipitation_probability_max?.[at]);
    const sunSeconds = daily.sunshine_duration?.[at];
    const sun = typeof sunSeconds === 'number' ? round(sunSeconds / 3600) : null;
    const wind = num(daily.wind_speed_10m_max?.[at]);
    const values: AdapterValue[] = [
      { label: 'Weather', value: sky, unit: null },
      { label: 'High', value: high, unit: '°C' },
      { label: 'Low', value: low, unit: '°C' },
      { label: 'Rain', value: rain, unit: 'mm' },
      { label: 'Rain chance', value: chance, unit: '%' },
      { label: 'Sunshine', value: sun, unit: 'h' },
      { label: 'Wind', value: wind, unit: 'km/h' },
    ];

    // "Partly cloudy, 8 to 14 °C, 2.1 mm rain (60%), 5.2 h sunshine, wind up to 21 km/h"
    const parts = [
      sky,
      high !== null && low !== null ? `${Math.round(low)} to ${Math.round(high)} °C` : null,
      rain ? `${rain} mm rain${chance !== null ? ` (${Math.round(chance)}%)` : ''}` : chance ? `${Math.round(chance)}% chance of rain` : 'no rain',
      sun !== null ? `${Math.round(sun * 10) / 10} h sunshine` : null,
      wind !== null ? `wind up to ${Math.round(wind)} km/h` : null,
    ];
    return { values, summary: parts.filter(Boolean).join(', ') };
  },
};
