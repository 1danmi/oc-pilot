import { useMemo } from 'react';
import {
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';
import type { Stats } from '../api';

interface Props {
  stats: Stats;
}

const PALETTE = [
  '#58a6ff',
  '#d2a8ff',
  '#3fb950',
  '#d29922',
  '#f85149',
  '#ff7b72',
  '#79c0ff',
  '#a5d6ff',
];

export default function VersionPie({ stats }: Props) {
  const data = useMemo(() => {
    return Object.entries(stats.version_distribution)
      .map(([version, count]) => ({ name: version, value: count }))
      .sort((a, b) => b.value - a.value);
  }, [stats]);

  if (!data.length) {
    return (
      <div className="panel">
        <h2>Versions</h2>
        <p style={{ color: 'var(--text-dim)' }}>No versions reported yet.</p>
      </div>
    );
  }

  return (
    <div className="panel">
      <h2>Versions</h2>
      <ResponsiveContainer width="100%" height={280}>
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            cx="50%"
            cy="50%"
            outerRadius={90}
            innerRadius={50}
            paddingAngle={2}
          >
            {data.map((_, i) => (
              <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
            ))}
          </Pie>
          <Tooltip
            formatter={(value: number, name: string) => [
              `${value} machine${value === 1 ? '' : 's'}`,
              name,
            ]}
          />
          <Legend verticalAlign="bottom" />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
