import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  AppState,
  AvailabilityStatus,
  ClassProfile,
  ClassType,
  IntakeSubmission,
  IntakeSubmissionStatus,
  Location,
  OptimizerSettings,
  ScheduleRun,
  Student,
  StudentLoginResult,
  StudentOriginalCourse,
  StudentSubmissionPayload,
  TeacherCourse,
  TeacherTimeStatus,
  TravelTime,
  WEEK_DAYS,
  WeekDay,
} from '../types';
import { DAY_END_MIN, DAY_START_MIN, SLOT_MINUTES, slotStarts, toSlotKey } from '../utils/time';
import { createUuid } from '../utils/id';

type DbRow = Record<string, unknown>;

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
const DEFAULT_CLASS_TYPES: ClassType[] = ['一对一', '一对二', '一对三', '小班', '已有固定班课', '两者均可', '尚未确定'];
const VALID_SESSION_MINUTES = [60, 90, 120, 150, 180];

let client: SupabaseClient | null = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  client = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
}

const asRecord = (value: unknown): DbRow => {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as DbRow;
  return {};
};

const asString = (value: unknown) => (value == null ? '' : String(value));
const asNumber = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const asBoolean = (value: unknown) => value === true || value === 'true' || value === 1 || value === '1';
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asStringArray = (value: unknown): string[] =>
  asArray(value)
    .map((item) => (typeof item === 'string' ? item : asString(asRecord(item).id)))
    .map((item) => item.trim())
    .filter(Boolean);
const nowIso = () => new Date().toISOString();
const normalizeName = (value: string) => value.trim().toLowerCase().replace(/\s+/g, '');
const unique = (values: string[]) => [...new Set(values.filter(Boolean))];
const validSessionMinutes = (value: number | undefined) =>
  VALID_SESSION_MINUTES.includes(value || 0) ? (value as number) : 60;
const dbRows = (value: unknown): DbRow[] => asArray(value).map(asRecord);

const ensureNoError = (label: string, error: { message?: string } | null | undefined) => {
  if (error) throw new Error(label + '失败：' + (error.message || '未知错误'));
};

const dbClassMode = (classType: ClassType) => {
  if (classType === '一对一') return 'one_to_one';
  if (classType === '两者均可' || classType === '尚未确定') return 'either';
  if (classType === '一对二' || classType === '一对三') return 'prefer_group';
  if (classType === '小班' || classType === '已有固定班课') return 'group_only';
  return 'either';
};

const classTypeFrom = (mode: unknown, metadata?: DbRow): ClassType => {
  const detail = asString(metadata?.classType || metadata?.class_type);
  if (DEFAULT_CLASS_TYPES.includes(detail as ClassType)) return detail as ClassType;
  switch (asString(mode)) {
    case 'one_to_one':
      return '一对一';
    case 'prefer_one_to_one':
      return '一对二';
    case 'prefer_group':
      return '一对三';
    case 'group_only':
      return '小班';
    default:
      return '两者均可';
  }
};

const mapAvailability = (value: unknown): AvailabilityStatus => {
  if (value === 'adjust') return 'adjust';
  if (value === 'hardAdjust') return 'hardAdjust';
  if (value === 'blocked') return 'blocked';
  return 'free';
};

const buildAvailability = (value: unknown): Record<string, AvailabilityStatus> => {
  const result: Record<string, AvailabilityStatus> = {};
  for (const day of WEEK_DAYS) {
    for (const start of slotStarts) result[toSlotKey(day, start)] = 'free';
  }
  const raw = asRecord(value);
  Object.entries(raw).forEach(([key, status]) => {
    result[key] = mapAvailability(status);
  });
  return result;
};

const mapCommitment = (value: unknown, index: number): StudentOriginalCourse | null => {
  const row = asRecord(value);
  const day = asNumber(row.day ?? row.day_of_week);
  const startMinute = asNumber(row.startMinute ?? row.start_minute);
  const endMinute = asNumber(row.endMinute ?? row.end_minute);
  if (!day || startMinute == null || endMinute == null || endMinute <= startMinute) return null;
  return {
    id: asString(row.id) || 'commitment-' + index,
    day: Math.max(1, Math.min(7, day)) as WeekDay,
    startMinute,
    endMinute,
    title: asString(row.title) || '已有安排',
    locationId: asString(row.locationId ?? row.location_id),
    isFixed: asBoolean(row.isFixed ?? row.is_fixed),
    adjustDifficulty: Math.max(1, Math.min(5, asNumber(row.adjustDifficulty ?? row.adjust_difficulty) || 3)) as 1 | 2 | 3 | 4 | 5,
    notes: asString(row.notes) || undefined,
    teacherName: asString(row.teacherName) || undefined,
    studentReferenceName: asString(row.studentReferenceName) || undefined,
  };
};

const mapCourses = (value: unknown) =>
  asArray(value)
    .map(mapCommitment)
    .filter((course): course is StudentOriginalCourse => course !== null);

const mapLocation = (row: DbRow): Location => ({
  id: asString(row.id),
  name: asString(row.name) || '未命名地点',
  shortName: asString(row.short_name) || undefined,
  address: asString(row.address),
  note: asString(row.notes) || undefined,
  capacity: asNumber(row.capacity) || 1,
  priorityWeight: asNumber(row.priority_weight) || 1,
  active: row.active !== false,
});

const mapTravel = (row: DbRow): TravelTime => ({
  fromLocationId: asString(row.from_location_id),
  toLocationId: asString(row.to_location_id),
  minutes: asNumber(row.minutes) || 0,
  bufferMinutes: asNumber(row.buffer_minutes) || 0,
});

const mapStudent = (row: DbRow): Student => {
  const metadata = asRecord(row.metadata);
  return {
    id: asString(row.id),
    chemStudentId: asString(row.chem_student_id) || undefined,
    name: asString(row.display_name),
    grade: asString(row.grade_band),
    contact: asString(row.contact) || undefined,
    school: asString(row.school) || undefined,
    teacherClassNote: asString(metadata.teacherClassNote) || undefined,
    courseNeed: asString(row.course_need) || undefined,
    classType: classTypeFrom(row.class_mode, metadata),
    targetStudentCount: asNumber(row.target_group_size),
    availability: buildAvailability(row.availability),
    originalCourses: mapCourses(row.commitments),
    acceptedLocationIds: asStringArray(row.location_preferences),
    notes: asString(metadata.notes) || undefined,
    weeklySessionNeed: asNumber(row.weekly_sessions),
    lessonMinutes: asNumber(row.session_minutes),
    active: row.active !== false,
    metadata,
    updatedAt: asString(row.updated_at) || nowIso(),
  };
};

const mapSubmissionStatus = (status: unknown): IntakeSubmissionStatus => {
  if (status === 'converted') return 'accepted';
  if (status === 'archived') return 'ignored';
  return 'pending';
};

const mapSubmission = (row: DbRow): IntakeSubmission => {
  const metadata: DbRow = {
    teacherClassNote: asString(row.course_need) || undefined,
    courseNeed: asString(row.course_need) || undefined,
  };
  const payload: StudentSubmissionPayload = {
    chemStudentId: asString(row.chem_student_id) || undefined,
    name: asString(row.student_name),
    grade: asString(row.grade_band),
    contact: asString(row.contact) || undefined,
    school: asString(row.school) || undefined,
    teacherClassNote: asString(metadata.teacherClassNote) || undefined,
    courseNeed: asString(row.course_need) || undefined,
    classType: classTypeFrom(row.class_mode, metadata),
    targetStudentCount: asNumber(row.target_group_size),
    weeklySessionNeed: asNumber(row.weekly_sessions),
    lessonMinutes: asNumber(row.session_minutes),
    availability: buildAvailability(row.availability),
    originalCourses: mapCourses(row.commitments),
    acceptedLocationIds: asStringArray(row.location_preferences),
    notes: asString(row.notes) || undefined,
  };
  const flexibility = asString(row.overall_flexibility);
  const flexibilityScore = flexibility === 'flexible' ? 5 : flexibility === 'normal' ? 3 : flexibility === 'prefer_not' ? 2 : 1;
  const completeParts = [
    payload.name,
    payload.grade,
    payload.classType,
    Object.keys(payload.availability).length > 0,
    payload.weeklySessionNeed,
    payload.lessonMinutes,
  ];
  return {
    id: asString(row.id),
    status: mapSubmissionStatus(row.status),
    source: 'student_form',
    studentName: payload.name,
    contact: payload.contact,
    grade: payload.grade,
    school: payload.school,
    classType: payload.classType,
    targetStudentCount: payload.targetStudentCount,
    payload,
    submittedAt: asString(row.created_at) || nowIso(),
    updatedAt: asString(row.updated_at) || nowIso(),
    timeCompleteness: Math.round((completeParts.filter(Boolean).length / completeParts.length) * 100),
    acceptedLocationSummary: payload.acceptedLocationIds,
    originalCourseCount: payload.originalCourses.length,
    flexibilityScore,
    weeklySessionNeed: payload.weeklySessionNeed,
    lessonMinutes: payload.lessonMinutes,
  };
};

const mapClass = (row: DbRow, memberMap: Map<string, string[]>): ClassProfile => {
  const id = asString(row.id);
  const metadata = asRecord(row.metadata);
  const status = asString(row.status);
  return {
    id,
    title: asString(row.name) || '未命名班级',
    classType: classTypeFrom(row.class_mode, metadata),
    minStudentCount: asNumber(row.min_students),
    maxStudentCount: asNumber(row.max_students),
    weeklySessionNeed: asNumber(row.weekly_sessions),
    durationMinutes: asNumber(row.session_minutes),
    preferredLocationId: asString(row.fixed_location_id) || undefined,
    status: status === 'ended' || status === 'paused' ? 'archived' : status === 'draft' || status === 'proposed' ? 'draft' : 'active',
    locked: asBoolean(row.locked),
    source: metadata.source === 'proposal' ? 'proposal' : 'manual',
    studentIds: memberMap.get(id) || [],
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  };
};

const mapCourse = (row: DbRow, classMap: Map<string, ClassProfile>): TeacherCourse => {
  const classId = asString(row.class_id);
  const profile = classMap.get(classId);
  const scoreBreakdown = asRecord(row.score_breakdown);
  const start = asNumber(row.start_minute) || 0;
  return {
    id: asString(row.id),
    classId,
    studentIds: profile?.studentIds || [],
    title: profile?.title || asString(scoreBreakdown.title) || '课程',
    day: (asNumber(row.day_of_week) || 1) as WeekDay,
    startMinute: start,
    endMinute: start + (asNumber(row.duration_minutes) || 60),
    locationId: asString(row.location_id),
    classType: profile?.classType || classTypeFrom(scoreBreakdown.classType),
    isFixed: asBoolean(scoreBreakdown.isFixed) || asBoolean(row.locked),
    adjustDifficulty: Math.max(1, Math.min(5, asNumber(scoreBreakdown.adjustDifficulty) || 3)) as 1 | 2 | 3 | 4 | 5,
    notes: asString(scoreBreakdown.notes) || undefined,
    source: row.source === 'optimizer' ? 'proposal' : 'manual',
    runId: asString(row.schedule_run_id) || undefined,
    locked: asBoolean(row.locked),
    status: asString(row.status) === 'cancelled' ? 'cancelled' : asString(row.status) === 'proposed' ? 'proposed' : 'confirmed',
    scoreBreakdown,
  };
};

const mapScheduleRun = (row: DbRow): ScheduleRun => ({
  id: asString(row.id),
  algorithmVersion: asString(row.algorithm_version),
  totalScore: asNumber(row.total_score),
  status: asString(row.status),
  createdAt: asString(row.created_at),
});

const blankTeacherAvailability = (): Record<string, TeacherTimeStatus> => {
  const value: Record<string, TeacherTimeStatus> = {};
  for (const day of WEEK_DAYS) {
    for (const start of slotStarts) value[toSlotKey(day, start)] = 'free';
  }
  return value;
};

const mapTeacherAvailability = (rows: DbRow[]) => {
  const result = blankTeacherAvailability();
  rows.forEach((row) => {
    const day = asNumber(row.day_of_week);
    const start = asNumber(row.start_minute);
    const end = asNumber(row.end_minute);
    if (!day || start == null || end == null) return;
    const note = safeJsonRecord(asString(row.notes));
    const uiState = asString(note.uiState) as TeacherTimeStatus;
    const status: TeacherTimeStatus =
      uiState === 'course' || uiState === 'occupied' || uiState === 'commute' || uiState === 'blocked'
        ? uiState
        : row.state === 'unavailable'
          ? 'blocked'
          : 'free';
    for (let minute = start; minute < end; minute += SLOT_MINUTES) {
      result[toSlotKey(day as WeekDay, minute)] = status;
    }
  });
  return result;
};

const safeJsonRecord = (value: string): DbRow => {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return {};
  }
};

const submissionFlexibility = (payload: StudentSubmissionPayload) => {
  if (Object.values(payload.availability).includes('blocked') || payload.originalCourses.some((course) => course.isFixed || course.adjustDifficulty <= 1)) {
    return 'locked';
  }
  if (Object.values(payload.availability).includes('hardAdjust') || payload.originalCourses.some((course) => course.adjustDifficulty <= 2)) {
    return 'prefer_not';
  }
  if (Object.values(payload.availability).includes('adjust') || payload.originalCourses.some((course) => course.adjustDifficulty <= 4)) {
    return 'normal';
  }
  return 'flexible';
};

const databaseSubmissionStatus = (status: IntakeSubmissionStatus) => {
  if (status === 'ignored') return 'archived';
  if (status === 'pending') return 'reviewed';
  return 'converted';
};

const databaseClassStatus = (status: ClassProfile['status']) => {
  if (status === 'archived') return 'ended';
  if (status === 'draft') return 'draft';
  return 'confirmed';
};

const databaseRunStatus = (status: string | undefined) => {
  if (status === 'accepted' || status === 'rejected' || status === 'superseded') return status;
  return 'generated';
};

const locationRow = (location: Location) => ({
  id: location.id,
  name: location.name.trim(),
  short_name: location.shortName?.trim() || null,
  address: location.address.trim() || null,
  capacity: Math.max(1, Math.min(100, location.capacity || 1)),
  priority_weight: Math.max(0.1, location.priorityWeight || 1),
  active: location.active !== false,
  notes: location.note?.trim() || null,
  updated_at: nowIso(),
});

const studentRow = (student: Student) => ({
  id: student.id,
  chem_student_id: student.chemStudentId || null,
  display_name: student.name.trim(),
  normalized_name: normalizeName(student.name),
  grade_band: student.grade.trim() || null,
  school: student.school?.trim() || null,
  contact: student.contact?.trim() || null,
  course_need: student.courseNeed?.trim() || student.teacherClassNote?.trim() || null,
  class_mode: dbClassMode(student.classType),
  weekly_sessions: Math.max(1, Math.min(7, student.weeklySessionNeed || 1)),
  session_minutes: validSessionMinutes(student.lessonMinutes),
  target_group_size: student.targetStudentCount ? Math.max(1, Math.min(12, student.targetStudentCount)) : null,
  availability: student.availability,
  commitments: student.originalCourses,
  location_preferences: unique(student.acceptedLocationIds),
  overall_flexibility: submissionFlexibility(student),
  active: student.active !== false,
  metadata: {
    ...student.metadata,
    classType: student.classType,
    teacherClassNote: student.teacherClassNote || null,
    notes: student.notes?.trim() || null,
  },
  updated_at: nowIso(),
});

export const emptyAppState = (): AppState => ({
  students: [],
  locations: [],
  travelTimes: [],
  teacherAvailability: blankTeacherAvailability(),
  teacherCourses: [],
  classes: [],
  pendingSubmissions: [],
  scheduleRuns: [],
});

export function getAuthClient() {
  return client;
}

export async function loadStudentFormConfig() {
  if (!client) throw new Error('Supabase 正式环境变量未配置。');
  const { data, error } = await client
    .from('sched_student_form_config')
    .select('*')
    .eq('active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  ensureNoError('读取公开表单配置', error);
  if (!data) throw new Error('当前没有可用的学生信息表单。');
  const raw = asRecord(data);
  const settings = asRecord(raw.settings);
  const rawOptions = settings.classTypeOptions ?? settings.class_type_options;
  const options = asStringArray(rawOptions).filter((item): item is ClassType => DEFAULT_CLASS_TYPES.includes(item as ClassType));
  return {
    classTypeOptions: options.length ? options : DEFAULT_CLASS_TYPES,
    classTypeEnabled: true,
    raw,
  };
}

export async function loadStudentPublicContext(): Promise<{ locations: Location[]; travelTimes: TravelTime[] }> {
  if (!client) throw new Error('Supabase 正式环境变量未配置。');
  const { data, error } = await client
    .from('sched_locations')
    .select('id,name,short_name,address,capacity,priority_weight,active,notes')
    .eq('active', true)
    .order('priority_weight', { ascending: false });
  ensureNoError('读取公开地点配置', error);
  return {
    locations: dbRows(data).map(mapLocation),
    travelTimes: [],
  };
}

export async function checkTeacherCanAccess(email: string | undefined) {
  if (!client || !email) return false;
  const { data, error } = await client
    .from('sched_teacher_allowlist')
    .select('id')
    .eq('email', email.trim().toLowerCase())
    .eq('active', true)
    .limit(1)
    .maybeSingle();
  return !error && Boolean(data);
}

type TableAccessCheck = { table: string; ok: boolean; message?: string };

export async function verifyTeacherWorkspaceAccess(): Promise<{ ok: boolean; checks: TableAccessCheck[] }> {
  if (!client) return { ok: false, checks: [{ table: 'supabase-client', ok: false, message: 'Supabase 未配置' }] };
  const tables: Array<[string, string]> = [
    ['sched_teacher_allowlist', 'id'],
    ['sched_locations', 'id'],
    ['sched_travel_times', 'id'],
    ['sched_teacher_availability', 'id'],
    ['sched_students', 'id'],
    ['sched_sessions', 'id'],
    ['sched_classes', 'id'],
    ['sched_class_members', 'class_id'],
    ['sched_schedule_runs', 'id'],
    ['sched_intake_submissions', 'id'],
    ['sched_student_form_config', 'form_key'],
    ['sched_optimizer_settings', 'id'],
  ];
  const checks: TableAccessCheck[] = [];
  for (const [table, column] of tables) {
    const { error } = await client.from(table).select(column).limit(1);
    checks.push(error ? { table, ok: false, message: error.message } : { table, ok: true });
  }
  return { ok: checks.every((item) => item.ok), checks };
}

async function studentAccessRequest<T>(body: Record<string, unknown>, sessionToken?: string): Promise<T> {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Supabase 正式环境变量未配置。');
  const response = await fetch(`${SUPABASE_URL}/functions/v1/chemistry-schedule-access`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...(sessionToken ? { 'x-app-session': sessionToken } : {}),
    },
    body: JSON.stringify(body),
  });
  const result = (await response.json().catch(() => ({}))) as { error?: string } & T;
  if (!response.ok) throw new Error(result.error || '学生身份服务暂时不可用，请稍后重试。');
  return result;
}

export async function authenticateStudentSchedule(name: string, code: string): Promise<StudentLoginResult> {
  return studentAccessRequest<StudentLoginResult>({ action: 'login', name: name.trim(), code: code.trim() });
}

export async function submitStudentDraft(payload: StudentSubmissionPayload, sessionToken: string): Promise<{ id: string }> {
  if (!sessionToken) throw new Error('登录已失效，请重新输入姓名和登录码。');
  return studentAccessRequest<{ id: string }>({
    action: 'submit',
    data: {
      chemStudentId: payload.chemStudentId,
      commitments: payload.originalCourses,
      notes: payload.notes || '',
    },
  }, sessionToken);
}

export async function loadPendingSubmissions(): Promise<IntakeSubmission[]> {
  if (!client) throw new Error('Supabase 正式环境变量未配置。');
  const { data, error } = await client
    .from('sched_intake_submissions')
    .select('*')
    .eq('status', 'new')
    .order('created_at', { ascending: false });
  ensureNoError('读取待处理提交', error);
  return dbRows(data).map(mapSubmission);
}

export async function markSubmissionStatus(id: string, status: IntakeSubmissionStatus) {
  if (!client) throw new Error('Supabase 正式环境变量未配置。');
  const { data, error } = await client
    .from('sched_intake_submissions')
    .update({ status: databaseSubmissionStatus(status), updated_at: nowIso() })
    .eq('id', id)
    .select('id')
    .maybeSingle();
  ensureNoError('更新提交状态', error);
  if (!data) throw new Error('更新提交状态失败：记录不存在或无权限。');
}

export async function loadTeacherWorkspace(): Promise<AppState> {
  if (!client) throw new Error('Supabase 正式环境变量未配置。');
  const [
    locationsRes,
    travelRes,
    availabilityRes,
    studentsRes,
    membersRes,
    classesRes,
    sessionsRes,
    runsRes,
    settingsRes,
  ] = await Promise.all([
    client.from('sched_locations').select('*').order('priority_weight', { ascending: false }),
    client.from('sched_travel_times').select('*'),
    client.from('sched_teacher_availability').select('*'),
    client.from('sched_students').select('*').eq('active', true).order('updated_at', { ascending: false }),
    client.from('sched_class_members').select('*').eq('active', true),
    client.from('sched_classes').select('*').neq('status', 'ended'),
    client.from('sched_sessions').select('*').neq('status', 'cancelled'),
    client.from('sched_schedule_runs').select('*').order('created_at', { ascending: false }).limit(50),
    client.from('sched_optimizer_settings').select('*').eq('id', 'default').maybeSingle(),
  ]);
  const firstError =
    locationsRes.error ||
    travelRes.error ||
    availabilityRes.error ||
    studentsRes.error ||
    membersRes.error ||
    classesRes.error ||
    sessionsRes.error ||
    runsRes.error ||
    settingsRes.error;
  ensureNoError('加载教师工作台', firstError);

  const members = new Map<string, string[]>();
  dbRows(membersRes.data).forEach((row) => {
    const classId = asString(row.class_id);
    const studentId = asString(row.student_id);
    if (!classId || !studentId) return;
    members.set(classId, [...(members.get(classId) || []), studentId]);
  });
  const classes = dbRows(classesRes.data).map((row) => mapClass(row, members));
  const classMap = new Map(classes.map((item) => [item.id, item]));
  const settingsRow = asRecord(settingsRes.data);
  const optimizerSettings: OptimizerSettings | undefined = settingsRes.data
    ? {
        weights: asRecord(settingsRow.weights) as Record<string, number>,
        rules: asRecord(settingsRow.rules),
      }
    : undefined;
  return {
    students: dbRows(studentsRes.data).map(mapStudent),
    locations: dbRows(locationsRes.data).map(mapLocation),
    travelTimes: dbRows(travelRes.data).map(mapTravel),
    teacherAvailability: mapTeacherAvailability(dbRows(availabilityRes.data)),
    teacherCourses: dbRows(sessionsRes.data).map((row) => mapCourse(row, classMap)),
    classes,
    pendingSubmissions: await loadPendingSubmissions(),
    scheduleRuns: dbRows(runsRes.data).map(mapScheduleRun),
    optimizerSettings,
  };
}

export function toStudentPayload(student: Student): StudentSubmissionPayload {
  return {
    name: student.name,
    grade: student.grade,
    contact: student.contact,
    teacherClassNote: student.teacherClassNote,
    courseNeed: student.courseNeed,
    school: student.school,
    classType: student.classType,
    targetStudentCount: student.targetStudentCount,
    availability: student.availability,
    originalCourses: student.originalCourses,
    acceptedLocationIds: student.acceptedLocationIds,
    notes: student.notes,
    weeklySessionNeed: student.weeklySessionNeed,
    lessonMinutes: student.lessonMinutes,
  };
}

const classRow = (item: ClassProfile) => ({
  id: item.id,
  name: item.title.trim(),
  course_need: null,
  class_mode: item.classType === '一对一' ? 'one_to_one' : 'group',
  min_students: Math.max(1, Math.min(20, item.minStudentCount || 1)),
  max_students: Math.max(1, Math.min(20, item.maxStudentCount || item.minStudentCount || 1)),
  session_minutes: validSessionMinutes(item.durationMinutes),
  weekly_sessions: Math.max(1, Math.min(7, item.weeklySessionNeed || 1)),
  fixed_location_id: item.preferredLocationId || null,
  status: databaseClassStatus(item.status),
  locked: Boolean(item.locked),
  metadata: { classType: item.classType, source: item.source || 'manual' },
  updated_at: nowIso(),
});

const sessionRow = (course: TeacherCourse, classId: string) => ({
  id: course.id,
  class_id: classId,
  schedule_run_id: course.runId || null,
  day_of_week: course.day,
  start_minute: course.startMinute,
  duration_minutes: validSessionMinutes(course.endMinute - course.startMinute),
  location_id: course.locationId,
  locked: Boolean(course.locked || course.isFixed),
  source: course.source === 'proposal' ? 'optimizer' : 'manual',
  status: course.status || 'confirmed',
  effective_from: null,
  effective_to: null,
  score_breakdown: {
    ...(course.scoreBreakdown || {}),
    title: course.title,
    classType: course.classType,
    isFixed: course.isFixed,
    adjustDifficulty: course.adjustDifficulty,
    notes: course.notes || null,
  },
  updated_at: nowIso(),
});

export async function persistTeacherWorkspace(state: AppState): Promise<AppState> {
  if (!client) throw new Error('Supabase 正式环境变量未配置。');
  if (!state.locations.length) throw new Error('至少需要保留一个地点。');

  const locations = state.locations.map(locationRow);
  const locationRes = await client.from('sched_locations').upsert(locations, { onConflict: 'id' });
  ensureNoError('保存地点', locationRes.error);

  const travelRows = state.travelTimes
    .filter((item) => item.fromLocationId && item.toLocationId && item.fromLocationId !== item.toLocationId)
    .map((item) => ({
      from_location_id: item.fromLocationId,
      to_location_id: item.toLocationId,
      minutes: Math.max(0, Math.min(240, item.minutes)),
      buffer_minutes: Math.max(0, Math.min(120, item.bufferMinutes || 0)),
      updated_at: nowIso(),
    }));
  if (travelRows.length) {
    const travelRes = await client
      .from('sched_travel_times')
      .upsert(travelRows, { onConflict: 'from_location_id,to_location_id' });
    ensureNoError('保存通勤矩阵', travelRes.error);
  }

  const clearAvailabilityRes = await client
    .from('sched_teacher_availability')
    .delete()
    .gte('day_of_week', 1)
    .lte('day_of_week', 7);
  ensureNoError('重置教师时间', clearAvailabilityRes.error);
  const availabilityRows = Object.entries(state.teacherAvailability).map(([key, uiState]) => {
    const [day, start] = key.split('-').map(Number);
    return {
      day_of_week: day,
      start_minute: start,
      end_minute: start + SLOT_MINUTES,
      state: uiState === 'free' ? 'available' : 'unavailable',
      preference: uiState === 'free' ? 0 : -5,
      notes: JSON.stringify({ uiState }),
      updated_at: nowIso(),
    };
  });
  const availabilityRes = await client.from('sched_teacher_availability').insert(availabilityRows);
  ensureNoError('保存教师时间', availabilityRes.error);

  if (state.students.length) {
    const studentsRes = await client.from('sched_students').upsert(state.students.map(studentRow), { onConflict: 'id' });
    ensureNoError('保存学生', studentsRes.error);
  }

  const classes = [...state.classes.map((item) => ({ ...item, studentIds: unique(item.studentIds) }))];
  const classesById = new Map(classes.map((item) => [item.id, item]));
  const courses: TeacherCourse[] = state.teacherCourses.map((course) => {
    let classId = course.classId;
    if (!classId || !classesById.has(classId)) {
      const sameMembers = classes.find(
        (item) =>
          item.studentIds.length === course.studentIds.length &&
          item.studentIds.every((studentId) => course.studentIds.includes(studentId))
      );
      classId = sameMembers?.id || createUuid();
      if (!classesById.has(classId)) {
        const generated: ClassProfile = {
          id: classId,
          title: course.title,
          classType: course.classType,
          minStudentCount: Math.max(1, course.studentIds.length),
          maxStudentCount: Math.max(1, course.studentIds.length),
          weeklySessionNeed: 1,
          durationMinutes: course.endMinute - course.startMinute,
          preferredLocationId: course.locationId,
          status: 'active',
          locked: Boolean(course.locked),
          source: course.source || 'manual',
          studentIds: unique(course.studentIds),
        };
        classes.push(generated);
        classesById.set(classId, generated);
      }
    }
    return { ...course, classId };
  });

  if (classes.length) {
    const classRes = await client.from('sched_classes').upsert(classes.map(classRow), { onConflict: 'id' });
    ensureNoError('保存班级', classRes.error);
    const currentClassIds = classes.map((item) => item.id);
    const clearMembersRes = await client.from('sched_class_members').delete().in('class_id', currentClassIds);
    ensureNoError('更新班级成员', clearMembersRes.error);
    const memberRows = classes.flatMap((item) =>
      item.studentIds.map((studentId) => ({
        class_id: item.id,
        student_id: studentId,
        active: true,
      }))
    );
    if (memberRows.length) {
      const membersRes = await client.from('sched_class_members').insert(memberRows);
      ensureNoError('保存班级成员', membersRes.error);
    }
  }

  const existingClassesRes = await client.from('sched_classes').select('id,status').neq('status', 'ended');
  ensureNoError('读取班级', existingClassesRes.error);
  const visibleClassIds = new Set(classes.map((item) => item.id));
  const endedClassIds = dbRows(existingClassesRes.data)
    .map((row) => asString(row.id))
    .filter((id) => id && !visibleClassIds.has(id));
  if (endedClassIds.length) {
    const endClassesRes = await client.from('sched_classes').update({ status: 'ended', updated_at: nowIso() }).in('id', endedClassIds);
    ensureNoError('停用已删除班级', endClassesRes.error);
  }

  const existingSessionsRes = await client.from('sched_sessions').select('id').neq('status', 'cancelled');
  ensureNoError('读取课程', existingSessionsRes.error);
  const currentSessionIds = new Set(courses.map((course) => course.id));
  const cancelledSessionIds = dbRows(existingSessionsRes.data)
    .map((row) => asString(row.id))
    .filter((id) => id && !currentSessionIds.has(id));
  if (cancelledSessionIds.length) {
    const cancelRes = await client
      .from('sched_sessions')
      .update({ status: 'cancelled', updated_at: nowIso() })
      .in('id', cancelledSessionIds);
    ensureNoError('取消已删除课程', cancelRes.error);
  }
  if (courses.length) {
    const courseRes = await client
      .from('sched_sessions')
      .upsert(courses.map((course) => sessionRow(course, course.classId as string)), { onConflict: 'id' });
    ensureNoError('保存课程', courseRes.error);
  }

  return loadTeacherWorkspace();
}

export async function persistScheduleRun(data: {
  runId?: string;
  algorithmVersion?: string;
  totalScore?: number | null;
  payload: string;
  status?: string;
}): Promise<string> {
  if (!client) throw new Error('Supabase 正式环境变量未配置。');
  const payload = safeJsonRecord(data.payload);
  const proposal = asRecord(payload.proposal);
  const constraints = {
    proposalId: asString(payload.proposalId) || null,
    strategy: asString(proposal.strategy) || null,
    studentIds: asArray(asRecord(proposal.assignment).allStudents),
  };
  const row = {
    algorithm_version: data.algorithmVersion || 'rule-based-v2',
    constraints,
    proposal: Object.keys(proposal).length ? proposal : payload,
    total_score: data.totalScore ?? null,
    status: databaseRunStatus(data.status),
  };
  if (data.runId) {
    const { data: updated, error } = await client
      .from('sched_schedule_runs')
      .update(row)
      .eq('id', data.runId)
      .select('id')
      .maybeSingle();
    ensureNoError('更新排课运行记录', error);
    if (!updated) throw new Error('更新排课运行记录失败：记录不存在或无权限。');
    return data.runId;
  }
  const { data: inserted, error } = await client.from('sched_schedule_runs').insert(row).select('id').maybeSingle();
  ensureNoError('保存排课运行记录', error);
  const id = asString(asRecord(inserted).id);
  if (!id) throw new Error('保存排课运行记录失败：未返回记录 ID。');
  return id;
}
