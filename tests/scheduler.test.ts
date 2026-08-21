import { describe, expect, it } from 'vitest';
import { computeCommonFree, detectConflicts, generateGroupSuggestions, generateProposals } from '../src/services/scheduler';
import { overlap, toSlotKey } from '../src/utils/time';
import type { AppState, Student, WeekDay } from '../src/types';

const availability = (blocked: Array<[WeekDay, number]> = []) => {
  const values: Record<string, 'free' | 'adjust' | 'hardAdjust' | 'blocked'> = {};
  for (let day = 1; day <= 7; day += 1) {
    for (let minute = 8 * 60; minute < 22 * 60; minute += 30) values[toSlotKey(day as WeekDay, minute)] = 'free';
  }
  blocked.forEach(([day, minute]) => {
    values[toSlotKey(day, minute)] = 'blocked';
  });
  return values;
};

const student = (id: string, changes: Partial<Student> = {}): Student => ({
  id,
  name: id,
  grade: '高一',
  classType: '两者均可',
  availability: availability(),
  originalCourses: [],
  acceptedLocationIds: ['loc-a', 'loc-b'],
  weeklySessionNeed: 1,
  lessonMinutes: 60,
  updatedAt: '2026-08-20T00:00:00.000Z',
  ...changes,
});

const makeState = (): AppState => ({
  students: [student('stu-a'), student('stu-b')],
  locations: [
    { id: 'loc-a', name: '地点 A', address: '', capacity: 4, priorityWeight: 1, active: true },
    { id: 'loc-b', name: '地点 B', address: '', capacity: 4, priorityWeight: 1, active: true },
  ],
  travelTimes: [
    { fromLocationId: 'loc-a', toLocationId: 'loc-b', minutes: 30, bufferMinutes: 10 },
    { fromLocationId: 'loc-b', toLocationId: 'loc-a', minutes: 20, bufferMinutes: 5 },
  ],
  teacherAvailability: {},
  teacherCourses: [],
  classes: [],
  pendingSubmissions: [],
  scheduleRuns: [],
  optimizerSettings: {
    weights: {
      student_preferred_time: 80,
      teacher_preferred_time: 65,
      same_location_cluster: 75,
      minimize_travel: 65,
      compact_schedule: 55,
      student_locked_schedule: 100,
    },
    rules: { slot_minutes: 30 },
  },
});

describe('排课时间与冲突规则', () => {
  it('准确判断半开区间是否重叠', () => {
    expect(overlap(540, 600, 600, 660)).toBe(false);
    expect(overlap(540, 610, 600, 660)).toBe(true);
  });

  it('共同空闲排除学生硬不可用时间和固定课程', () => {
    const state = makeState();
    state.students[0] = student('stu-a', {
      availability: availability([[1, 9 * 60]]),
      originalCourses: [
        {
          id: 'fixed-1',
          title: '固定课',
          day: 1,
          startMinute: 11 * 60,
          endMinute: 12 * 60,
          locationId: 'loc-a',
          isFixed: true,
          adjustDifficulty: 1,
        },
      ],
    });
    const windows = computeCommonFree(state, ['stu-a', 'stu-b'], 60);
    expect(windows.some((item) => item.day === 1 && item.startMinute === 9 * 60)).toBe(false);
    expect(windows.some((item) => item.day === 1 && item.startMinute === 11 * 60)).toBe(false);
  });

  it('把方向性通勤和缓冲时间纳入硬冲突', () => {
    const state = makeState();
    state.teacherCourses = [
      {
        id: 'course-a',
        studentIds: ['stu-a'],
        title: 'A 课',
        day: 1,
        startMinute: 14 * 60,
        endMinute: 15 * 60,
        locationId: 'loc-a',
        classType: '一对一',
        isFixed: false,
        adjustDifficulty: 3,
      },
      {
        id: 'course-b',
        studentIds: ['stu-b'],
        title: 'B 课',
        day: 1,
        startMinute: 15 * 60 + 10,
        endMinute: 16 * 60 + 10,
        locationId: 'loc-b',
        classType: '一对一',
        isFixed: false,
        adjustDifficulty: 3,
      },
    ];
    expect(detectConflicts(state).some((item) => item.kind === 'commute' && item.title === '通勤冲突')).toBe(true);
  });

  it('未知通勤时间不能被当作零分钟', () => {
    const state = makeState();
    state.travelTimes = [];
    state.teacherCourses = [
      {
        id: 'course-a',
        studentIds: [],
        title: 'A 课',
        day: 1,
        startMinute: 10 * 60,
        endMinute: 11 * 60,
        locationId: 'loc-a',
        classType: '一对一',
        isFixed: false,
        adjustDifficulty: 3,
      },
      {
        id: 'course-b',
        studentIds: [],
        title: 'B 课',
        day: 1,
        startMinute: 11 * 60,
        endMinute: 12 * 60,
        locationId: 'loc-b',
        classType: '一对一',
        isFixed: false,
        adjustDifficulty: 3,
      },
    ];
    expect(detectConflicts(state).some((item) => item.title === '通勤时间未设置')).toBe(true);
  });

  it('地点容量、锁定课程和每周需求同时参与方案生成', () => {
    const state = makeState();
    state.students[0] = student('stu-a', { weeklySessionNeed: 2 });
    state.students[1] = student('stu-b', { weeklySessionNeed: 2 });
    state.teacherCourses = [
      {
        id: 'locked',
        studentIds: [],
        title: '锁定课程',
        day: 1,
        startMinute: 8 * 60,
        endMinute: 10 * 60,
        locationId: 'loc-a',
        classType: '一对一',
        isFixed: true,
        locked: true,
        adjustDifficulty: 1,
      },
    ];
    const proposals = generateProposals(state, ['stu-a', 'stu-b']);
    expect(proposals.some((proposal) => (proposal.assignments || []).length === 2)).toBe(true);
    expect(
      proposals.some((proposal) =>
        (proposal.assignments || []).some((assignment) => assignment.day === 1 && assignment.startMinute < 10 * 60)
      )
    ).toBe(false);
  });

  it('共同空闲把学生相邻课程的方向性通勤作为硬约束', () => {
    const state = makeState();
    state.students[0] = student('stu-a', {
      originalCourses: [
        {
          id: 'before',
          title: '前一地点课程',
          day: 1,
          startMinute: 10 * 60,
          endMinute: 11 * 60,
          locationId: 'loc-a',
          isFixed: true,
          adjustDifficulty: 1,
        },
      ],
    });
    const windows = computeCommonFree(state, ['stu-a'], 60);
    expect(
      windows.some((window) => window.day === 1 && window.startMinute === 11 * 60 + 30 && window.locationId === 'loc-b')
    ).toBe(false);
    expect(
      windows.some((window) => window.day === 1 && window.startMinute === 11 * 60 + 30 && window.locationId === 'loc-a')
    ).toBe(true);
  });

  it('自动组班只组合基础条件兼容且存在共同可行时段的学生', () => {
    const state = makeState();
    state.students.push(student('stu-c', { grade: '高二' }));
    const suggestions = generateGroupSuggestions(state);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0].studentIds.sort()).toEqual(['stu-a', 'stu-b']);
    expect(suggestions[0].studentIds).not.toContain('stu-c');
  });
});
