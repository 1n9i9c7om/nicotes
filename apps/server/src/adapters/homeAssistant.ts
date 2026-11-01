import { parseSensors, type AdapterValue, type HaSensor } from '@nicotes/shared';
import { startOfDay } from '../time.js';
import { AdapterError, getJson, round, type Source, type SourceContext } from './sources.js';

interface HaState {
  entity_id?: string;
  state: string;
  last_changed?: string;
  attributes?: { unit_of_measurement?: string; friendly_name?: string };
}

/** The numbers a sensor reported over the day (states like "unavailable" are skipped). */
const samples = (states: HaState[]) =>
  states.flatMap((s) => {
    const value = Number(s.state);
    const at = Date.parse(s.last_changed ?? '');
    return s.state.trim() !== '' && Number.isFinite(value) && Number.isFinite(at) ? [{ at, value }] : [];
  });

/** A figure over the day from a sensor's history, `end` being now or midnight. */
export function aggregate(take: Exclude<HaSensor['take'], 'state'>, states: HaState[], end: number): number | null {
  const points = samples(states).sort((a, b) => a.at - b.at);
  if (!points.length) return null;
  const values = points.map((p) => p.value);
  if (take === 'min') return Math.min(...values);
  if (take === 'max') return Math.max(...values);
  if (take === 'average') {
    // Weighted by how long each value held, as a reading every minute would give.
    let sum = 0;
    let span = 0;
    points.forEach((p, i) => {
      const until = Math.max(points[i + 1]?.at ?? end, p.at);
      sum += p.value * (until - p.at);
      span += until - p.at;
    });
    return span > 0 ? sum / span : values.at(-1)!;
  }
  // "change": how much a counter grew; a drop of more than 10% is a reset to zero.
  let total = 0;
  for (let i = 1; i < values.length; i++) {
    const before = values[i - 1]!;
    const after = values[i]!;
    total += after < before * 0.9 ? after : after - before;
  }
  return total;
}

/**
 * Sensor values from Home Assistant's REST API: the state now (and its unit) for each sensor,
 * plus the day's history for those that take an average, minimum, maximum or change.
 */
export const homeAssistant: Source = {
  check(config) {
    return parseSensors(config.entities ?? '').errors[0] ?? null;
  },

  async read(ctx: SourceContext) {
    const base = ctx.config.url!.replace(/\/+$/, '');
    const { sensors } = parseSensors(ctx.config.entities ?? '');
    const init = { headers: { Authorization: `Bearer ${ctx.secrets.token ?? ''}` } };
    const statuses = { 401: 'Home Assistant did not accept the access token', 403: 'Home Assistant did not accept the access token' };

    const states = new Map<string, HaState>();
    for (const sensor of sensors) {
      try {
        states.set(sensor.entityId, (await getJson(ctx, `${base}/api/states/${sensor.entityId}`, 'Home Assistant', init, statuses)) as HaState);
      } catch (err) {
        // An unknown sensor is a 404: say which one.
        if (err instanceof AdapterError && / 404\b/.test(err.message)) throw new AdapterError(`Home Assistant has no ${sensor.entityId}`);
        throw err;
      }
    }

    const history = new Map<string, HaState[]>();
    const over = sensors.filter((s) => s.take !== 'state');
    const start = startOfDay(ctx.date, ctx.timeZone);
    const end = Math.min(ctx.now, startOfDay(nextDay(ctx.date), ctx.timeZone));
    if (over.length) {
      const ids = [...new Set(over.map((s) => s.entityId))].join(',');
      const query = `filter_entity_id=${ids}&end_time=${encodeURIComponent(new Date(end).toISOString())}&minimal_response&no_attributes`;
      const lists = (await getJson(ctx, `${base}/api/history/period/${new Date(start).toISOString()}?${query}`, 'Home Assistant', init, statuses)) as HaState[][];
      for (const list of Array.isArray(lists) ? lists : []) {
        const id = list[0]?.entity_id;
        if (id) history.set(id, list);
      }
    }

    const values: AdapterValue[] = sensors.map((sensor) => {
      const state = states.get(sensor.entityId)!;
      const label = sensor.label ?? state.attributes?.friendly_name ?? sensor.entityId;
      const unit = state.attributes?.unit_of_measurement?.trim() || null;
      if (sensor.take === 'state') {
        const number = Number(state.state);
        const known = !['unavailable', 'unknown', ''].includes(state.state.trim());
        return { label, unit, value: !known ? null : Number.isFinite(number) ? round(number) : state.state };
      }
      const value = aggregate(sensor.take, history.get(sensor.entityId) ?? [], end);
      return { label, unit, value: value === null ? null : round(value) };
    });
    return { values };
  },
};

function nextDay(date: string) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
