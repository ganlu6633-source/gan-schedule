import React from 'react';
import { FormatWeek } from './format';
import {
  DAY_START_MIN,
  SLOT_MINUTES,
  formatMinute,
  slotStarts,
  toSlotKey,
  WeekDay,
} from '../utils/time';

interface PaletteItem<TStatus extends string> {
  value: TStatus;
  text: string;
  color: string;
}
interface TimeGridEditorProps<TStatus extends string> {
  value: Record<string, TStatus>;
  readOnly?: boolean;
  title: string;
  palette: Array<PaletteItem<TStatus>>;
  onChange(next: Record<string, TStatus>): void;
  onCellClick?: (day: WeekDay, startMinute: number) => TStatus;
}

export function TimeGridEditor<TStatus extends string>({
  value,
  readOnly,
  title,
  palette,
  onChange,
}: TimeGridEditorProps<TStatus>) {
  const days: WeekDay[] = [1, 2, 3, 4, 5, 6, 7];
  const [painting, setPainting] = React.useState<TStatus | null>(null);

  const next = (current: TStatus) => {
    const idx = palette.findIndex((item) => item.value === current);
    return palette[(idx + 1) % palette.length].value;
  };

  const apply = (day: WeekDay, start: number, status: TStatus) => {
    const key = toSlotKey(day, start);
    onChange({
      ...value,
      [key]: status,
    });
  };

  const startPaint = (day: WeekDay, start: number) => {
    if (readOnly) return;
    const key = toSlotKey(day, start);
    const nextStatus = next(value[key] ?? palette[0].value);
    setPainting(nextStatus);
    apply(day, start, nextStatus);
  };

  const paint = (day: WeekDay, start: number) => {
    if (!painting || readOnly) return;
    apply(day, start, painting);
  };

  React.useEffect(() => {
    const stop = () => setPainting(null);
    window.addEventListener('pointerup', stop);
    return () => window.removeEventListener('pointerup', stop);
  }, []);

  return (
    <section className="card">
      <h3>{title}</h3>
      <div className="legend">
        {palette.map((item) => (
          <span key={item.value} className="legend-item">
            <i className={`dot ${item.color}`}></i>
            {item.text}
          </span>
        ))}
      </div>
      <div className="time-grid-wrap">
        <div className="time-grid">
          <div className="time-grid-head">
            <div className="corner">时间</div>
            {days.map((day) => (
              <div key={day} className="cell head">
                <FormatWeek day={day} />
              </div>
            ))}
          </div>
          {slotStarts.map((startMinute) => (
            <div key={startMinute} className="time-row">
              <div className="cell time-col">{formatMinute(startMinute)}</div>
              {days.map((day) => {
                const key = toSlotKey(day, startMinute);
                const current = value[key] ?? palette[0].value;
                const item = palette.find((p) => p.value === current) ?? palette[0];
                return (
                  <button
                    key={key}
                    className={`cell slot ${item.color}`}
                    aria-label={`${key}-${current}`}
                    onPointerDown={() => startPaint(day, startMinute)}
                    onPointerEnter={() => paint(day, startMinute)}
                  >
                    {formatMinute(startMinute)}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <small>提示：按住并拖拽可连续涂色，点击切换状态。</small>
    </section>
  );
}
