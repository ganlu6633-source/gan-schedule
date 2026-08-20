import { AvailabilityStatus, DAY_END_MIN, DAY_START_MIN, SLOT_MINUTES, StudentOriginalCourse, WeekDay, TeacherCourse } from '../types';

export { DAY_END_MIN, DAY_START_MIN, SLOT_MINUTES };
export type { WeekDay };

export const slotStarts = Array.from(
  { length: (DAY_END_MIN - DAY_START_MIN) / SLOT_MINUTES },
  (_, i) => DAY_START_MIN + i * SLOT_MINUTES
);

export function toSlotKey(day: WeekDay, startMinute: number) {
  return `${day}-${startMinute}`;
}

export function formatMinute(minute: number) {
  const h = Math.floor(minute / 60).toString().padStart(2, '0');
  const m = (minute % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

export function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  return Math.max(aStart, bStart) < Math.min(aEnd, bEnd);
}

export function studentHasCourseAt(studentCourses: StudentOriginalCourse[], day: WeekDay, start: number, end: number) {
  return studentCourses.some((course) => course.day === day && overlap(course.startMinute, course.endMinute, start, end));
}

export function teacherHasCourseAt(courses: TeacherCourse[], day: WeekDay, start: number, end: number) {
  return courses.some((course) => course.day === day && overlap(course.startMinute, course.endMinute, start, end));
}
