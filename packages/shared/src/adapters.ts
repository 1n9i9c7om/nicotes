import { z } from 'zod';

/**
 * Adapters bring data from other services into Nicotes on a schedule: a row per day in a
 * logbook page (a table that the "Charts" view draws), or a line in the day's journal.
 */
export const ADAPTER_TYPES = ['home-assistant', 'weather'] as const;
export type AdapterType = (typeof ADAPTER_TYPES)[number];

export const ADAPTER_TARGETS = ['logbook', 'journal'] as const;
export type AdapterTarget = (typeof ADAPTER_TARGETS)[number];

export interface AdapterField {
  key: string;
  label: string;
  /** "secret" fields are stored encrypted and never sent back; "lines" is a textarea. */
  kind: 'text' | 'url' | 'secret' | 'lines';
  placeholder?: string;
  help?: string;
  required?: boolean;
}

export interface AdapterTypeInfo {
  type: AdapterType;
  label: string;
  description: string;
  fields: AdapterField[];
  /** Defaults for a new adapter of this type. */
  target: AdapterTarget;
  dailyAt: string;
}

export const ADAPTER_TYPE_INFO: Record<AdapterType, AdapterTypeInfo> = {
  'home-assistant': {
    type: 'home-assistant',
    label: 'Home Assistant',
    description: 'Sensor values of the day from Home Assistant, e.g. solar energy produced, average temperature, consumption.',
    fields: [
      { key: 'url', label: 'Address', kind: 'url', placeholder: 'http://homeassistant.local:8123', required: true },
      {
        key: 'token',
        label: 'Long-lived access token',
        kind: 'secret',
        required: true,
        help: 'In Home Assistant: your profile → Security → Long-lived access tokens → Create token.',
      },
      {
        key: 'entities',
        label: 'Sensors',
        kind: 'lines',
        required: true,
        placeholder: 'sensor.solar_energy_today, Solar\nsensor.outdoor_temperature, Temperature, average\nsensor.grid_import_total, Grid import, change',
        help: 'One per line: entity id, a name (optional) and what to take: state (the value now, default), average, min, max, or change (how much a counter grew today).',
      },
    ],
    target: 'logbook',
    dailyAt: '23:55',
  },
  weather: {
    type: 'weather',
    label: 'Weather',
    description: 'The day’s forecast from Open-Meteo (free, no account): weather, high and low, rain, sunshine.',
    fields: [
      { key: 'place', label: 'Place', kind: 'text', placeholder: 'Hamburg', required: true, help: 'A town or city; the first match is used.' },
    ],
    target: 'journal',
    dailyAt: '07:00',
  },
};

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected a time like 07:00');

export const adapterSaveSchema = z.object({
  type: z.enum(ADAPTER_TYPES),
  name: z.string().trim().min(1).max(80),
  config: z.record(z.string(), z.string().max(4000)).default({}),
  /** Secret fields: a value replaces the stored one, null removes it, absent keeps it. */
  secrets: z.record(z.string(), z.string().max(4000).nullable()).default({}),
  target: z.enum(ADAPTER_TARGETS),
  dailyAt: time,
  enabled: z.boolean().default(true),
});
export type AdapterSave = z.input<typeof adapterSaveSchema>;

export interface Adapter {
  id: string;
  type: AdapterType;
  name: string;
  config: Record<string, string>;
  /** Which secret fields have a value. */
  secretsSet: string[];
  target: AdapterTarget;
  dailyAt: string;
  enabled: boolean;
  /** The logbook page, once the first run created it. */
  pageId: string | null;
  lastRunAt: number | null;
  lastStatus: 'ok' | 'error' | null;
  /** What the last run wrote, or why it failed. */
  lastMessage: string | null;
}

/** One value an adapter read, e.g. { label: "Solar", value: 12.3, unit: "kWh" }. */
export interface AdapterValue {
  label: string;
  value: number | string | null;
  unit: string | null;
}

/** What a Home Assistant sensor contributes: its value now, or a figure over the day. */
export const HA_TAKES = ['state', 'average', 'min', 'max', 'change'] as const;
export type HaTake = (typeof HA_TAKES)[number];

export interface HaSensor {
  entityId: string;
  label: string | null;
  take: HaTake;
}

/** The "Sensors" field: `entity id[, name][, state|average|min|max|change]` per line. */
export function parseSensors(text: string): { sensors: HaSensor[]; errors: string[] } {
  const sensors: HaSensor[] = [];
  const errors: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(',').map((p) => p.trim());
    const entityId = parts[0]!.toLowerCase();
    if (!/^[a-z_]+\.[a-z0-9_]+$/.test(entityId)) {
      errors.push(`“${parts[0]}” is not an entity id like sensor.solar_energy`);
      continue;
    }
    let take: HaTake = 'state';
    const last = parts.at(-1)!.toLowerCase();
    if (parts.length > 1 && (HA_TAKES as readonly string[]).includes(last)) {
      take = last as HaTake;
      parts.pop();
    } else if (parts.length > 2) {
      errors.push(`${entityId}: “${parts.at(-1)}” should be state, average, min, max or change`);
      continue;
    }
    sensors.push({ entityId, label: parts.slice(1).join(', ') || null, take });
  }
  if (!sensors.length && !errors.length) errors.push('Add at least one sensor');
  if (sensors.length > 30) errors.push('At most 30 sensors per adapter');
  return { sensors, errors };
}

/** POST /api/adapters/:id/run */
export interface AdapterRun {
  date: string;
  values: AdapterValue[];
  pageId: string;
  message: string;
}
