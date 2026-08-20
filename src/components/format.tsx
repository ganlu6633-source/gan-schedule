import { WEEK_LABELS, WeekDay } from '../types';

export function FormatWeek({ day }: { day: WeekDay }) {
  return <>{WEEK_LABELS[day]}</>;
}
