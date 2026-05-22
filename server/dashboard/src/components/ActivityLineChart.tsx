import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Timeseries } from '../api';

interface Props {
  timeseries: Timeseries;
}

/**
 * Four-series line chart: machines/day, installs/day, users/day, events/day.
 * Drives off /v1/stats/timeseries?days=30. The gap between Machines and Installs
 * is the reinstall churn (same physical machine reinstalling the extension).
 */
export default function ActivityLineChart({ timeseries }: Props) {
  const data = timeseries.series;

  if (!data.length) {
    return (
      <div className="panel">
        <h2>Activity (last {timeseries.days} days)</h2>
        <p style={{ color: 'var(--text-dim)' }}>No activity in the selected window.</p>
      </div>
    );
  }

  return (
    <div className="panel">
      <h2>Activity (last {timeseries.days} days)</h2>
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={data} margin={{ top: 8, right: 24, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="date" tick={{ fontSize: 12 }} />
          <YAxis tick={{ fontSize: 12 }} />
          <Tooltip />
          <Legend />
          <Line
            type="monotone"
            dataKey="unique_machines_seen"
            name="Machines"
            stroke="var(--accent)"
            strokeWidth={2}
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="unique_installs_seen"
            name="Installs"
            stroke="var(--warn, #f59e0b)"
            strokeWidth={2}
            strokeDasharray="4 2"
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="unique_users_seen"
            name="Users"
            stroke="var(--accent-2)"
            strokeWidth={2}
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="events_count"
            name="Events"
            stroke="var(--good)"
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
