import { useCallback, useEffect, useMemo, useState } from 'react';
import ActivityLineChart from './components/ActivityLineChart';
import EventBarChart from './components/EventBarChart';
import StatCard from './components/StatCard';
import VersionPie from './components/VersionPie';
import {
  fetchStats,
  fetchTimeseries,
  type Stats,
  type Timeseries,
} from './api';

function relativeTime(unixSec: number | null): string {
  if (!unixSec) return 'never';
  const diff = Date.now() / 1000 - unixSec;
  if (diff < 60) return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

export default function App() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [timeseries, setTimeseries] = useState<Timeseries | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    setRefreshing(true);
    try {
      const [s, t] = await Promise.all([fetchStats(), fetchTimeseries(30)]);
      setStats(s);
      setTimeseries(t);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const lastReceived = useMemo(
    () => (stats ? relativeTime(stats.last_event_received_at) : '—'),
    [stats]
  );

  return (
    <>
      <div className="header">
        <div>
          <h1>OC Pilot Telemetry</h1>
          <div className="meta">
            Last event {lastReceived}
            {stats?.last_event_received_at
              ? ' · ' +
                new Date(stats.last_event_received_at * 1000).toLocaleString()
              : ''}
          </div>
        </div>
        <button
          className="refresh-btn"
          onClick={load}
          disabled={refreshing}
          title="Re-fetch /v1/stats and /v1/stats/timeseries"
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error ? <div className="error">Failed to load: {error}</div> : null}
      {loading && !stats ? <div className="loading">Loading…</div> : null}

      {stats ? (
        <>
          <div className="grid cards">
            <StatCard label="Unique machines" value={stats.unique_machines} />
            <StatCard label="Unique users" value={stats.unique_users} />
            <StatCard
              label="Active 1 h"
              value={stats.active_machines_1h}
              sub="machines posting recently"
            />
            <StatCard label="Active 24 h" value={stats.active_machines_24h} />
            <StatCard label="Active 7 d" value={stats.active_machines_7d} />
            <StatCard label="Installs total" value={stats.installs_total} />
            <StatCard label="Updates total" value={stats.updates_total} />
          </div>

          <div className="grid charts">
            {timeseries ? <ActivityLineChart timeseries={timeseries} /> : null}
            <VersionPie stats={stats} />
          </div>

          <div className="grid">
            <EventBarChart stats={stats} />
          </div>
        </>
      ) : null}
    </>
  );
}
