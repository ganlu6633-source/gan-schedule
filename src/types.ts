export type WeekDay = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const WEEK_DAYS: WeekDay[] = [1, 2, 3, 4, 5, 6, 7];
export const WEEK_LABELS: Record<WeekDay, string> = {
  1: '周一',
  2: '周二',
  3: '周三',
  4: '周四',
  5: '周五',
  6: '周六',
  7: '周日',
};

export const DAY_START_MIN = 8 * 60;
export const DAY_END_MIN = 22 * 60;
export const SLOT_MINUTES = 30;

export type AvailabilityStatus = 'free' | 'adjust' | 'hardAdjust' | 'blocked';

export const AvailabilityLabel: Record<AvailabilityStatus, string> = {
  free: '可上课',
  adjust: '可调整',
  hardAdjust: '不太方便调整',
  blocked: '完全不能上课',
};

export type ClassType =
  | '一对一'
  | '一对二'
  | '一对三'
  | '小班'
  | '已有固定班课'
  | '两者均可'
  | '尚未确定';

export interface TimeWindow {
  day: WeekDay;
  startMinute: number;
  endMinute: number;
}

export interface CourseBase {
  id: string;
  day: WeekDay;
  startMinute: number;
  endMinute: number;
  title: string;
  locationId: string;
  isFixed: boolean;
  adjustDifficulty: 1 | 2 | 3 | 4 | 5;
  notes?: string;
}

export interface StudentOriginalCourse extends CourseBase {
  teacherName?: string;
  studentReferenceName?: string;
}

export interface Student {
  id: string;
  chemStudentId?: string;
  name: string;
  grade: string;
  contact?: string;
  teacherClassNote?: string;
  school?: string;
  classType: ClassType;
  targetStudentCount?: number;
  availability: Record<string, AvailabilityStatus>;
  originalCourses: StudentOriginalCourse[];
  acceptedLocationIds: string[];
  notes?: string;
  weeklySessionNeed?: number;
  lessonMinutes?: number;
  courseNeed?: string;
  active?: boolean;
  metadata?: Record<string, unknown>;
  updatedAt: string;
}

export interface TeacherCourse {
  id: string;
  studentIds: string[];
  classId?: string;
  title: string;
  day: WeekDay;
  startMinute: number;
  endMinute: number;
  locationId: string;
  classType: ClassType;
  isFixed: boolean;
  adjustDifficulty: 1 | 2 | 3 | 4 | 5;
  notes?: string;
  source?: 'manual' | 'proposal';
  runId?: string | null;
  locked?: boolean;
  status?: 'proposed' | 'confirmed' | 'cancelled';
  scoreBreakdown?: Record<string, unknown>;
}

export interface ClassProfile {
  id: string;
  title: string;
  classType: ClassType;
  minStudentCount?: number;
  maxStudentCount?: number;
  weeklySessionNeed?: number;
  durationMinutes?: number;
  preferredLocationId?: string;
  status?: 'active' | 'archived' | 'draft';
  locked?: boolean;
  source?: 'manual' | 'proposal';
  studentIds: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface ScheduleRun {
  id: string;
  algorithmVersion?: string;
  totalScore?: number;
  status?: string;
  createdAt: string;
  updatedAt?: string;
}

export type TeacherTimeStatus = 'free' | 'course' | 'occupied' | 'commute' | 'blocked';

export const TeacherTimeLabel: Record<TeacherTimeStatus, string> = {
  free: '可以上课',
  course: '已有课程',
  occupied: '不可安排',
  commute: '通勤',
  blocked: '临时占用',
};

export interface Location {
  id: string;
  name: string;
  address: string;
  note?: string;
  shortName?: string;
  capacity?: number;
  priorityWeight?: number;
  active?: boolean;
}

export interface TravelTime {
  fromLocationId: string;
  toLocationId: string;
  minutes: number;
  bufferMinutes?: number;
}

export interface StudentScheduleProfile {
  chemStudentId: string;
  scheduleStudentId?: string;
  displayName: string;
  gradeBand: string;
  school?: string;
  schoolClass?: string;
  classNames: string[];
  classType: ClassType;
  acceptedLocationIds: string[];
  existingCourses: StudentOriginalCourse[];
  weeklySessionNeed?: number;
  lessonMinutes?: number;
}

export interface StudentLoginResult {
  session: {
    token: string;
    expiresAt: string;
  };
  profile: StudentScheduleProfile;
  locations: Location[];
  travelTimes: TravelTime[];
}

export interface OptimizerSettings {
  weights: Record<string, number>;
  rules: Record<string, unknown>;
}

export interface AppState {
  students: Student[];
  locations: Location[];
  travelTimes: TravelTime[];
  teacherAvailability: Record<string, TeacherTimeStatus>;
  teacherCourses: TeacherCourse[];
  classes: ClassProfile[];
  pendingSubmissions: IntakeSubmission[];
  scheduleRuns: ScheduleRun[];
  optimizerSettings?: OptimizerSettings;
}

export interface StudentSubmissionPayload {
  chemStudentId?: string;
  name: string;
  grade: string;
  contact?: string;
  teacherClassNote?: string;
  school?: string;
  classType: ClassType;
  availability: Record<string, AvailabilityStatus>;
  originalCourses: StudentOriginalCourse[];
  acceptedLocationIds: string[];
  notes?: string;
  targetStudentCount?: number;
  weeklySessionNeed?: number;
  lessonMinutes?: number;
  courseNeed?: string;
}

export type IntakeSubmissionStatus =
  | 'pending'
  | 'accepted'
  | 'ignored'
  | 'merged'
  | 'edited_and_accepted';

export interface IntakeSubmission {
  id: string;
  status: IntakeSubmissionStatus;
  source: 'student_form';
  studentName: string;
  contact?: string;
  grade: string;
  school?: string;
  classType: ClassType;
  targetStudentCount?: number;
  preferredLocationMode?: 'single' | 'multiple' | 'any';
  payload: StudentSubmissionPayload;
  submittedAt: string;
  updatedAt: string;
  timeCompleteness: number;
  acceptedLocationSummary: string[];
  originalCourseCount?: number;
  flexibilityScore?: number;
  weeklySessionNeed?: number;
  lessonMinutes?: number;
}

export interface ConflictItem {
  id: string;
  kind: 'student' | 'teacher' | 'commute' | 'location' | 'efficiency';
  severity: 'error' | 'warning';
  title: string;
  detail: string;
  day: WeekDay;
}

export interface CommonFreeWindow {
  id: string;
  day: WeekDay;
  startMinute: number;
  endMinute: number;
  locationId: string;
  score: number;
  quality: '推荐' | '可接受' | '勉强可用' | '不推荐';
  reasons: string[];
  adjustableStudents: number;
  hardAdjustStudents: number;
  fixedConflictStudents: number;
  studentTravelMinutes?: number;
  teacherTravelMinutes?: number;
  travelWarnings?: string[];
  allStudents: string[];
  studentReasons: Record<string, string>;
}

export interface ScheduleScoreBreakdown {
  hardConflicts: number;
  requestedSessions: number;
  scheduledSessions: number;
  adjustedStudentSlots: number;
  hardAdjustmentSlots: number;
  studentTravelMinutes: number;
  teacherTravelMinutes: number;
  completenessRate: number;
}

export interface ScheduleProposal {
  id: string;
  title: string;
  strategy: '冲突最少' | '学生通勤最少' | '教师最少通勤' | '课程更集中';
  explanation: string;
  score: number;
  assignment: CommonFreeWindow;
  assignments?: CommonFreeWindow[];
  warnings: string[];
  breakdown: ScheduleScoreBreakdown;
}

export interface GroupSuggestion {
  id: string;
  title: string;
  studentIds: string[];
  grade: string;
  classType: ClassType;
  targetStudentCount: number;
  score: number;
  commonWindowCount: number;
  bestWindow: CommonFreeWindow;
  reasons: string[];
  warnings: string[];
}
