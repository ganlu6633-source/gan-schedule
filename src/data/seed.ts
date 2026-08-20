import {
  AvailabilityStatus,
  AppState,
  ClassType,
  DAY_START_MIN,
  SLOT_MINUTES,
  Student,
  StudentOriginalCourse,
  WeekDay,
} from '../types';
import { slotStarts, toSlotKey } from '../utils/time';

const makeAllFree = () => {
  const availability: Record<string, AvailabilityStatus> = {};
  for (let day = 1; day <= 7; day++) {
    slotStarts.forEach((startMinute) => {
      availability[toSlotKey(day as WeekDay, startMinute)] = 'free';
    });
  }
  return availability;
};

const setRange = (
  availability: Record<string, AvailabilityStatus>,
  day: WeekDay,
  startMinute: number,
  endMinute: number,
  status: AvailabilityStatus
) => {
  for (let m = startMinute; m < endMinute; m += SLOT_MINUTES) {
    availability[toSlotKey(day, m)] = status;
  }
};

const buildStudent = (
  partial: Omit<Student, 'id' | 'updatedAt' | 'availability' | 'originalCourses'> & {
    availabilityTweaks: Array<{
      day: WeekDay;
      startMinute: number;
      endMinute: number;
      status: AvailabilityStatus;
    }>;
    originalCourses: Omit<StudentOriginalCourse, 'id'>[];
  },
  id: string
): Student => {
  const availability = makeAllFree();
  partial.availabilityTweaks.forEach(({ day, startMinute, endMinute, status }) => {
    setRange(availability, day, startMinute, endMinute, status);
  });
  return {
    id,
    availability,
    updatedAt: new Date().toISOString(),
    ...partial,
    originalCourses: partial.originalCourses.map((course, index) => ({ ...course, id: `course-${id}-${index + 1}` })),
  };
};

const studentType: ClassType = '一对一';

const studentA = buildStudent(
  {
    name: '学生A',
    grade: '高三',
    contact: '138-0000-0001',
    teacherClassNote: '张老师 A 班',
    classType: studentType,
    acceptedLocationIds: ['loc-a'],
    notes: '偏好周末下午，临时调整可配合。',
    availabilityTweaks: [
      { day: 1, startMinute: 8 * 60, endMinute: 10 * 60, status: 'blocked' },
      { day: 2, startMinute: 14 * 60, endMinute: 17 * 60, status: 'hardAdjust' },
    ],
    originalCourses: [
      {
        title: '每周固定课',
        day: 4,
        startMinute: 9 * 60,
        endMinute: 10 * 60,
        locationId: 'loc-a',
        isFixed: true,
        adjustDifficulty: 2,
        notes: '每周四不可改',
      },
    ],
  },
  'stu-a'
);

const studentB = buildStudent(
  {
    name: '学生B',
    grade: '初二',
    contact: '138-0000-0002',
    teacherClassNote: '李老师 B 班',
    classType: '小班',
    acceptedLocationIds: ['loc-a', 'loc-b'],
    notes: '数学薄弱，能接受线上和线下。',
    availabilityTweaks: [
      { day: 3, startMinute: 15 * 60, endMinute: 18 * 60, status: 'adjust' },
      { day: 6, startMinute: 8 * 60, endMinute: 10 * 60, status: 'blocked' },
      { day: 1, startMinute: 13 * 60, endMinute: 17 * 60, status: 'hardAdjust' },
    ],
    originalCourses: [
      {
        title: '周一课',
        day: 1,
        startMinute: 10 * 60,
        endMinute: 11 * 60,
        locationId: 'loc-b',
        isFixed: true,
        adjustDifficulty: 4,
        notes: '可微调',
      },
    ],
  },
  'stu-b'
);

const studentC = buildStudent(
  {
    name: '学生C',
    grade: '高一',
    contact: '138-0000-0003',
    classType: '一对三',
    acceptedLocationIds: ['loc-b'],
    notes: '周末偏好早些时间。',
    availabilityTweaks: [
      { day: 6, startMinute: 10 * 60, endMinute: 12 * 60, status: 'free' },
      { day: 6, startMinute: 13 * 60, endMinute: 18 * 60, status: 'adjust' },
      { day: 7, startMinute: 13 * 60, endMinute: 18 * 60, status: 'free' },
    ],
    originalCourses: [
      {
        title: '周二固定',
        day: 2,
        startMinute: 11 * 60,
        endMinute: 12 * 60,
        locationId: 'loc-b',
        isFixed: true,
        adjustDifficulty: 1,
        notes: '完全不改',
      },
    ],
  },
  'stu-c'
);

const studentD = buildStudent(
  {
    name: '学生D',
    grade: '初三',
    classType: '已有固定班课',
    acceptedLocationIds: ['loc-a', 'loc-b'],
    notes: '家长可协调到 30 分钟窗口。',
    availabilityTweaks: [
      { day: 2, startMinute: 8 * 60, endMinute: 22 * 60, status: 'adjust' },
      { day: 5, startMinute: 14 * 60, endMinute: 16 * 60, status: 'hardAdjust' },
    ],
    originalCourses: [],
  },
  'stu-d'
);

export const seedState = (): AppState => {
  const locations = [
    { id: 'loc-a', name: '地点A', address: '人民大道 101 号', note: '靠近地铁站，适合下午课', capacity: 6, priorityWeight: 1, active: true },
    { id: 'loc-b', name: '地点B', address: '光华路 88 号', note: '楼梯较多，通勤时间稍长', capacity: 6, priorityWeight: 1, active: true },
  ];

  const travelTimes = [
    { fromLocationId: 'loc-a', toLocationId: 'loc-b', minutes: 45, bufferMinutes: 10 },
    { fromLocationId: 'loc-b', toLocationId: 'loc-a', minutes: 42, bufferMinutes: 10 },
  ];

  const teacherAvailability: Record<string, any> = {};
  for (let day = 1; day <= 7; day++) {
    for (const startMinute of slotStarts) {
      teacherAvailability[toSlotKey(day as WeekDay, startMinute)] = 'free';
    }
  }
  const setTeacherBlock = (day: WeekDay, start: number, end: number, status: 'occupied' | 'blocked' | 'commute') => {
    for (let m = start; m < end; m += SLOT_MINUTES) {
      teacherAvailability[toSlotKey(day, m)] = status;
    }
  };
  setTeacherBlock(5, 19 * 60, 21 * 60, 'occupied');

  return {
    students: [studentA, studentB, studentC, studentD],
    locations,
    travelTimes,
    teacherAvailability,
    teacherCourses: [
      {
        id: 'tc-a',
        studentIds: ['stu-a'],
        title: '周一常规课',
        day: 1,
        startMinute: 9 * 60,
        endMinute: 10 * 60,
        locationId: 'loc-a',
        classType: '一对一',
        isFixed: true,
        adjustDifficulty: 1,
      },
      {
        id: 'tc-b',
        studentIds: ['stu-b'],
        title: '周一课程',
        day: 1,
        startMinute: 10 * 60 + 30,
        endMinute: 11 * 60 + 30,
        locationId: 'loc-b',
        classType: '小班',
        isFixed: true,
        adjustDifficulty: 2,
      },
    ],
    pendingSubmissions: [],
    classes: [],
    scheduleRuns: [],
  };
};
