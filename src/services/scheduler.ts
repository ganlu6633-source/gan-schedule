import {
  AvailabilityStatus,
  AppState,
  CommonFreeWindow,
  ConflictItem,
  ScheduleProposal,
  Student,
  TeacherTimeStatus,
  WeekDay,
} from '../types';
import { DAY_END_MIN, DAY_START_MIN, SLOT_MINUTES, overlap, toSlotKey } from '../utils/time';
import { createUuid } from '../utils/id';

type TravelRequirement = {
  minutes: number;
  bufferMinutes: number;
};

const STRATEGIES: ScheduleProposal['strategy'][] = ['最少调学生', '教师最少通勤', '课程更集中'];

const getDuration = (students: Student[], requested?: number) => {
  if (requested && requested > 0) return requested;
  const durations = students
    .map((student) => student.lessonMinutes || 60)
    .filter((minutes) => [60, 90, 120, 150, 180].includes(minutes));
  return Math.max(60, ...durations);
};

const studentStatusAt = (student: Student, day: WeekDay, start: number, end: number): AvailabilityStatus => {
  const values: AvailabilityStatus[] = [];
  for (let minute = start; minute < end; minute += SLOT_MINUTES) {
    values.push(student.availability[toSlotKey(day, minute)] || 'free');
  }
  if (values.includes('blocked')) return 'blocked';
  if (values.includes('hardAdjust')) return 'hardAdjust';
  if (values.includes('adjust')) return 'adjust';
  return 'free';
};

const teacherStatusAt = (state: AppState, day: WeekDay, start: number, end: number): TeacherTimeStatus[] => {
  const values: TeacherTimeStatus[] = [];
  for (let minute = start; minute < end; minute += SLOT_MINUTES) {
    values.push(state.teacherAvailability[toSlotKey(day, minute)] || 'free');
  }
  return values;
};

const teacherIsAvailable = (state: AppState, day: WeekDay, start: number, end: number) =>
  teacherStatusAt(state, day, start, end).every((status) => status === 'free');

const travelBetween = (state: AppState, fromLocationId: string, toLocationId: string): TravelRequirement | null => {
  if (fromLocationId === toLocationId) return { minutes: 0, bufferMinutes: 0 };
  const direct = state.travelTimes.find(
    (item) => item.fromLocationId === fromLocationId && item.toLocationId === toLocationId
  );
  if (!direct) return null;
  return {
    minutes: direct.minutes,
    bufferMinutes: direct.bufferMinutes || 0,
  };
};

const locationAllowed = (student: Student, locationId: string) =>
  student.acceptedLocationIds.length === 0 || student.acceptedLocationIds.includes(locationId);

const courseConflict = (student: Student, day: WeekDay, start: number, end: number) =>
  student.originalCourses.filter((course) => course.day === day && overlap(course.startMinute, course.endMinute, start, end));

const hardCommitmentConflict = (student: Student, day: WeekDay, start: number, end: number) =>
  courseConflict(student, day, start, end).some((course) => course.isFixed || course.adjustDifficulty <= 1);

const studentPenalty = (student: Student, day: WeekDay, start: number, end: number) => {
  const slotStatus = studentStatusAt(student, day, start, end);
  if (slotStatus === 'blocked' || hardCommitmentConflict(student, day, start, end)) {
    return { blocked: true, adjust: 0, hardAdjust: 0 };
  }
  let adjust = slotStatus === 'adjust' ? 1 : 0;
  let hardAdjust = slotStatus === 'hardAdjust' ? 1 : 0;
  for (const course of courseConflict(student, day, start, end)) {
    if (course.adjustDifficulty <= 2) hardAdjust += 1;
    else if (course.adjustDifficulty <= 4) adjust += 1;
  }
  return { blocked: false, adjust, hardAdjust };
};

const hasTeacherOverlap = (state: AppState, day: WeekDay, start: number, end: number) =>
  state.teacherCourses.some(
    (course) =>
      course.status !== 'cancelled' &&
      course.day === day &&
      overlap(course.startMinute, course.endMinute, start, end)
  );

const movePenalty = (state: AppState, day: WeekDay, start: number, end: number, locationId: string) => {
  const sameDay = state.teacherCourses
    .filter((course) => course.status !== 'cancelled' && course.day === day)
    .sort((a, b) => a.startMinute - b.startMinute);
  const before = sameDay.filter((course) => course.endMinute <= start).slice(-1)[0];
  const after = sameDay.find((course) => course.startMinute >= end);
  let penalty = 0;
  let warnings = 0;

  for (const item of [
    before ? { from: before.locationId, to: locationId, available: start - before.endMinute } : null,
    after ? { from: locationId, to: after.locationId, available: after.startMinute - end } : null,
  ]) {
    if (!item || item.from === item.to) continue;
    const requirement = travelBetween(state, item.from, item.to);
    if (!requirement) {
      penalty += 100;
      warnings += 1;
    } else if (item.available < requirement.minutes + requirement.bufferMinutes) {
      penalty += 60;
      warnings += 1;
    } else {
      penalty += Math.min(20, requirement.minutes / 4);
    }
  }
  return { penalty, warnings };
};

const weightsFor = (state: AppState) => ({
  studentPreferred: state.optimizerSettings?.weights.student_preferred_time || 80,
  teacherPreferred: state.optimizerSettings?.weights.teacher_preferred_time || 65,
  sameLocation: state.optimizerSettings?.weights.same_location_cluster || 75,
  travel: state.optimizerSettings?.weights.minimize_travel || 65,
  compact: state.optimizerSettings?.weights.compact_schedule || 55,
  locked: state.optimizerSettings?.weights.student_locked_schedule || 100,
});

export function detectConflicts(state: AppState): ConflictItem[] {
  const output: ConflictItem[] = [];
  const classesById = new Map(state.classes.map((item) => [item.id, item]));
  const byDay = new Map<WeekDay, typeof state.teacherCourses>();

  state.teacherCourses
    .filter((course) => course.status !== 'cancelled')
    .forEach((course) => byDay.set(course.day, [...(byDay.get(course.day) || []), course]));

  byDay.forEach((courses, day) => {
    const sorted = [...courses].sort((a, b) => a.startMinute - b.startMinute);
    for (let index = 0; index < sorted.length; index += 1) {
      const current = sorted[index];
      const next = sorted[index + 1];
      if (next && overlap(current.startMinute, current.endMinute, next.startMinute, next.endMinute)) {
        output.push({
          id: createUuid(),
          kind: 'teacher',
          severity: 'error',
          day,
          title: '教师时间冲突',
          detail: current.title + ' 与 ' + next.title + ' 时间重叠。',
        });
      }
      if (!next || current.locationId === next.locationId) continue;
      const requirement = travelBetween(state, current.locationId, next.locationId);
      if (!requirement) {
        output.push({
          id: createUuid(),
          kind: 'commute',
          severity: 'error',
          day,
          title: '通勤时间未设置',
          detail: current.title + ' 到 ' + next.title + ' 没有方向性通勤记录，不能判定连续排课安全。',
        });
      } else if (current.endMinute + requirement.minutes + requirement.bufferMinutes > next.startMinute) {
        output.push({
          id: createUuid(),
          kind: 'commute',
          severity: 'error',
          day,
          title: '通勤冲突',
          detail:
            current.title +
            ' 到 ' +
            next.title +
            ' 需要 ' +
            (requirement.minutes + requirement.bufferMinutes) +
            ' 分钟（通勤 ' +
            requirement.minutes +
            ' + 缓冲 ' +
            requirement.bufferMinutes +
            '）。',
        });
      }
      if (index >= 1 && sorted[index - 1].locationId === next.locationId) {
        output.push({
          id: createUuid(),
          kind: 'efficiency',
          severity: 'warning',
          day,
          title: '低效率场地往返',
          detail: '出现 ' + sorted[index - 1].title + ' → ' + current.title + ' → ' + next.title + ' 的场地往返。',
        });
      }
    }
  });

  state.teacherCourses
    .filter((course) => course.status !== 'cancelled')
    .forEach((course) => {
      const location = state.locations.find((item) => item.id === course.locationId);
      const classSize = classesById.get(course.classId || '')?.studentIds.length || course.studentIds.length;
      if (location && location.capacity != null && classSize > location.capacity) {
        output.push({
          id: createUuid(),
          kind: 'location',
          severity: 'error',
          day: course.day,
          title: '地点容量不足',
          detail: location.name + ' 容量为 ' + location.capacity + ' 人，本课程有 ' + classSize + ' 人。',
        });
      }
      course.studentIds.forEach((studentId) => {
        const student = state.students.find((item) => item.id === studentId);
        if (!student) return;
        const penalty = studentPenalty(student, course.day, course.startMinute, course.endMinute);
        if (penalty.blocked) {
          output.push({
            id: createUuid(),
            kind: 'student',
            severity: 'error',
            day: course.day,
            title: '学生硬时间冲突',
            detail: student.name + ' 在该时段不可上课，或与不可调整的已有课程冲突。',
          });
        } else if (penalty.adjust > 0 || penalty.hardAdjust > 0) {
          output.push({
            id: createUuid(),
            kind: 'student',
            severity: 'warning',
            day: course.day,
            title: '学生需要调课',
            detail: student.name + ' 需要 ' + (penalty.hardAdjust > 0 ? '较高成本调整' : '轻微调整') + '。',
          });
        }
      });
      if (!teacherIsAvailable(state, course.day, course.startMinute, course.endMinute) && !course.locked) {
        output.push({
          id: createUuid(),
          kind: 'teacher',
          severity: 'error',
          day: course.day,
          title: '教师不可安排',
          detail: course.title + ' 落在教师不可用时段。',
        });
      }
    });

  return output;
}

export function computeCommonFree(state: AppState, studentIds: string[], duration?: number): CommonFreeWindow[] {
  const students = state.students.filter((student) => studentIds.includes(student.id) && student.active !== false);
  if (!students.length) return [];
  const lessonMinutes = getDuration(students, duration);
  const windows: CommonFreeWindow[] = [];

  for (const day of [1, 2, 3, 4, 5, 6, 7] as WeekDay[]) {
    for (let start = DAY_START_MIN; start + lessonMinutes <= DAY_END_MIN; start += SLOT_MINUTES) {
      const end = start + lessonMinutes;
      if (!teacherIsAvailable(state, day, start, end) || hasTeacherOverlap(state, day, start, end)) continue;
      for (const location of state.locations.filter((item) => item.active !== false)) {
        if (location.capacity != null && students.length > location.capacity) continue;
        let adjust = 0;
        let hardAdjust = 0;
        let blocked = false;
        const reasons: Record<string, string> = {};
        students.forEach((student) => {
          if (!locationAllowed(student, location.id)) {
            blocked = true;
            reasons[student.id] = 'locationRestricted';
            return;
          }
          const penalty = studentPenalty(student, day, start, end);
          if (penalty.blocked) {
            blocked = true;
            reasons[student.id] = 'blocked';
            return;
          }
          adjust += penalty.adjust;
          hardAdjust += penalty.hardAdjust;
          reasons[student.id] = penalty.hardAdjust > 0 ? 'hardAdjust' : penalty.adjust > 0 ? 'adjust' : 'free';
        });
        if (blocked) continue;
        const movement = movePenalty(state, day, start, end, location.id);
        const score = 100 - adjust * 12 - hardAdjust * 32 - movement.penalty + (location.priorityWeight || 1) * 2;
        const quality: CommonFreeWindow['quality'] =
          hardAdjust > 0 ? '勉强可用' : adjust > 0 || movement.warnings > 0 ? '可接受' : '推荐';
        windows.push({
          id: createUuid(),
          day,
          startMinute: start,
          endMinute: end,
          locationId: location.id,
          score,
          quality,
          reasons: [quality, movement.warnings > 0 ? '通勤需确认' : ''].filter(Boolean),
          adjustableStudents: adjust,
          hardAdjustStudents: hardAdjust,
          fixedConflictStudents: 0,
          allStudents: students.map((student) => student.id),
          studentReasons: reasons,
        });
      }
    }
  }

  return windows.sort((left, right) => right.score - left.score);
}

const rankForStrategy = (state: AppState, strategy: ScheduleProposal['strategy'], windows: CommonFreeWindow[]) => {
  const weights = weightsFor(state);
  return [...windows].sort((left, right) => {
    const score = (window: CommonFreeWindow) => {
      const movement = movePenalty(state, window.day, window.startMinute, window.endMinute, window.locationId);
      if (strategy === '最少调学生') {
        return window.score + weights.studentPreferred - window.adjustableStudents * 10 - window.hardAdjustStudents * weights.locked;
      }
      if (strategy === '教师最少通勤') {
        return window.score - movement.penalty * (weights.travel / 30);
      }
      return window.score - movement.penalty * (weights.compact / 25) + (100 - Math.abs(window.startMinute - 14 * 60) / 10);
    };
    return score(right) - score(left);
  });
};

const pickWeeklyWindows = (windows: CommonFreeWindow[], desiredCount: number) => {
  const selected: CommonFreeWindow[] = [];
  const usedDays = new Set<WeekDay>();
  for (const window of windows) {
    if (selected.length >= desiredCount) break;
    if (usedDays.has(window.day) && windows.some((item) => !usedDays.has(item.day))) continue;
    if (
      selected.some(
        (item) => item.day === window.day && overlap(item.startMinute, item.endMinute, window.startMinute, window.endMinute)
      )
    ) {
      continue;
    }
    selected.push(window);
    usedDays.add(window.day);
  }
  return selected;
};

export function generateProposals(state: AppState, studentIds: string[]): ScheduleProposal[] {
  const students = state.students.filter((student) => studentIds.includes(student.id) && student.active !== false);
  if (!students.length) return [];
  const duration = getDuration(students);
  const windows = computeCommonFree(state, studentIds, duration);
  if (!windows.length) return [];

  const expectedSessions = Math.max(1, ...students.map((student) => student.weeklySessionNeed || 1));
  const names = students.map((student) => student.name).join('、');
  const proposals: ScheduleProposal[] = [];

  STRATEGIES.forEach((strategy) => {
    const ranked = rankForStrategy(state, strategy, windows);
    for (let offset = 0; offset < 3; offset += 1) {
      const plan = pickWeeklyWindows([...ranked.slice(offset), ...ranked.slice(0, offset)], expectedSessions);
      if (!plan.length) continue;
      const movement = plan.reduce(
        (sum, item) => sum + movePenalty(state, item.day, item.startMinute, item.endMinute, item.locationId).penalty,
        0
      );
      const score = plan.reduce((sum, item) => sum + item.score, 0) - movement;
      const hard = plan.reduce((sum, item) => sum + item.hardAdjustStudents, 0);
      const adjusted = plan.reduce((sum, item) => sum + item.adjustableStudents, 0);
      const warnings: string[] = [];
      if (hard > 0) warnings.push('方案包含高成本调课时段，需要教师确认。');
      if (movement > 0) warnings.push('方案含有通勤或场地切换成本。');
      if (plan.length < expectedSessions) {
        warnings.push('仅找到 ' + plan.length + ' 节可行时段，少于学生需求的 ' + expectedSessions + ' 节。');
      }
      proposals.push({
        id: createUuid(),
        title: strategy + ' · ' + names,
        strategy,
        explanation:
          '共安排 ' +
          plan.length +
          ' 节课，' +
          (plan.length * students.length - adjusted - hard) +
          ' 个学生时段无需调整，预计地点切换成本 ' +
          Math.round(movement) +
          '。',
        score,
        assignment: plan[0],
        assignments: plan,
        warnings,
      });
    }
  });

  const unique = new Map<string, ScheduleProposal>();
  proposals.forEach((proposal) => {
    const key = proposal.strategy + ':' + (proposal.assignments || []).map((item) => item.id).join(',');
    if (!unique.has(key)) unique.set(key, proposal);
  });
  return [...unique.values()].sort((left, right) => right.score - left.score);
}
