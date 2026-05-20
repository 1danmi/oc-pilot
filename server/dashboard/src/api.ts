/**
 * Typed fetch helpers for the OC Pilot telemetry server.
 *
 * All endpoints behind basic auth — the browser handles the auth dialog and
 * caches creds for the session. `credentials: 'include'` ensures the cached
 * Authorization header rides along on subsequent fetches from the same origin.
 */

export interface Stats {
  unique_machines: number;
  unique_users: number;
  active_machines_1h: number;
  active_machines_24h: number;
  active_machines_7d: number;
  per_event_total: Record<string, number>;
  per_event_avg_per_user: Record<string, number>;
  version_distribution: Record<string, number>;
  installs_total: number;
  updates_total: number;
  last_event_received_at: number | null;
}

export interface TimeseriesRow {
  date: string;                  // "YYYY-MM-DD"
  unique_machines_seen: number;
  unique_users_seen: number;
  events_count: number;
  install_count: number;
  update_count: number;
}

export interface Timeseries {
  days: number;
  series: TimeseriesRow[];
}

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`${url} → ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export function fetchStats(): Promise<Stats> {
  return getJSON<Stats>('/v1/stats');
}

export function fetchTimeseries(days = 30): Promise<Timeseries> {
  return getJSON<Timeseries>(`/v1/stats/timeseries?days=${days}`);
}
