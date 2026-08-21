import React from 'react';
import {
  AppState,
  ClassType,
  ClassProfile,
  IntakeSubmission,
  ConflictItem,
  GroupSuggestion,
  ScheduleProposal,
  Student,
  TeacherCourse,
  TeacherTimeStatus,
  WEEK_LABELS,
  WeekDay,
} from '../types';
import { detectConflicts, computeCommonFree, generateGroupSuggestions, generateProposals } from '../services/scheduler';
import { TimeGridEditor } from './TimeGridEditor';
import { DAY_END_MIN, DAY_START_MIN, SLOT_MINUTES, formatMinute, toSlotKey, overlap } from '../utils/time';
import { createUuid } from '../utils/id';

const classTypeList: Array<ClassType | '全部'> = ['全部', '一对一', '一对二', '一对三', '小班', '已有固定班课', '两者均可', '尚未确定'];

function createEmptyStudent(state: AppState): Student {
  const availability: Record<string, 'free' | 'adjust' | 'hardAdjust' | 'blocked'> = {};
  for (let day = 1; day <= 7; day++) {
    for (let start = DAY_START_MIN; start < DAY_END_MIN; start += SLOT_MINUTES) {
      availability[toSlotKey(day as WeekDay, start)] = 'free';
    }
  }
  return {
    id: createUuid(),
    name: '',
    grade: '',
    classType: '尚未确定',
    availability,
    originalCourses: [],
    acceptedLocationIds: [],
    notes: '',
    updatedAt: new Date().toISOString(),
  };
}

const emptyCourseDraft = (state: AppState) => ({
  id: undefined as string | undefined,
  title: '新增课程',
  studentIds: [] as string[],
  day: 1 as WeekDay,
  startMinute: 13 * 60,
  endMinute: 14 * 60,
  locationId: state.locations[0]?.id ?? '',
  classType: '一对一' as ClassType,
  isFixed: false,
  adjustDifficulty: 3 as 1 | 2 | 3 | 4 | 5,
  notes: '',
  locked: false,
});

const createEmptyClassDraft = (state: AppState): ClassProfile => ({
  id: createUuid(),
  title: '未命名班级',
  classType: '一对一',
  minStudentCount: 1,
  maxStudentCount: 1,
  weeklySessionNeed: 1,
  durationMinutes: 60,
  preferredLocationId: state.locations[0]?.id,
  status: 'active',
  source: 'manual',
  locked: false,
  studentIds: [],
});

type TeacherPortalProps = {
  state: AppState;
  onUpdate(next: AppState): Promise<AppState> | void;
  onApplyProposal(proposal: ScheduleProposal): Promise<void> | void;
  onGenerateProposals(studentIds: string[]): Promise<ScheduleProposal[]>;
  onSaveTeacherAvailability(value: Record<string, TeacherTimeStatus>): Promise<void>;
  onAcceptSubmission(id: string, forceCreate?: boolean): Promise<void>;
  onMergeSubmission(id: string, targetStudentId: string): Promise<void>;
  onIgnoreSubmission(id: string): Promise<void>;
  onStartSubmissionEdit(id: string): void;
  onSaveSubmissionEdit(id: string, student: Student): Promise<void>;
  onCancelSubmissionEdit(): void;
  submissionDraft: Student | null;
  submissionDraftId: string | null;
};

export function TeacherPortal({
  state,
  onUpdate,
  onApplyProposal,
  onGenerateProposals,
  onSaveTeacherAvailability,
  onAcceptSubmission,
  onMergeSubmission,
  onIgnoreSubmission,
  onStartSubmissionEdit,
  onSaveSubmissionEdit,
  onCancelSubmissionEdit,
  submissionDraft,
  submissionDraftId,
}: TeacherPortalProps) {
  const [tab, setTab] = React.useState<'dashboard' | 'students' | 'classes' | 'schedule' | 'locations' | 'settings'>('dashboard');
  const [search, setSearch] = React.useState('');
  const [classFilter, setClassFilter] = React.useState<ClassType | '全部'>('全部');
  const [gradeFilter, setGradeFilter] = React.useState('全部');
  const [locationFilter, setLocationFilter] = React.useState('全部');
  const [selectedStudentIds, setSelectedStudentIds] = React.useState<string[]>([]);
  const [editor, setEditor] = React.useState<Student | null>(null);
  const [proposals, setProposals] = React.useState<ScheduleProposal[]>([]);
  const [groupSuggestions, setGroupSuggestions] = React.useState<GroupSuggestion[]>([]);
  const [courseDraft, setCourseDraft] = React.useState(() => emptyCourseDraft(state));
  const [classDraft, setClassDraft] = React.useState<ClassProfile | null>(null);
  const [teacherAvailability, setTeacherAvailability] = React.useState<Record<string, TeacherTimeStatus>>(state.teacherAvailability);
  const [newLocationName, setNewLocationName] = React.useState('');
  const [newLocationAddress, setNewLocationAddress] = React.useState('');
  const [newLocationNote, setNewLocationNote] = React.useState('');
  const [mergeTargetMap, setMergeTargetMap] = React.useState<Record<string, string>>({});
  const [editingSubmission, setEditingSubmission] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [operationMessage, setOperationMessage] = React.useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [settingsDraft, setSettingsDraft] = React.useState(
    state.optimizerSettings || { weights: {}, rules: {} }
  );
  const availabilityTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const normalizeStudentName = (name: string) => name.trim().toLowerCase();

  const resolveLocationSummary = (submission: IntakeSubmission) => {
    const names = (submission.acceptedLocationSummary || [])
      .map((id) => state.locations.find((loc) => loc.id === id)?.name || id)
      .filter(Boolean);
    return names.length > 0 ? names.join('、') : '不限';
  };

  const getSubmissionConflicts = (submission: IntakeSubmission) => {
    const target = normalizeStudentName(submission.studentName);
    return state.students.filter((student) => normalizeStudentName(student.name) === target);
  };

  const formatFlexibility = (score?: number) => {
    if (score == null) return '未评估';
    if (score >= 4) return `${score} / 5（较好）`;
    if (score >= 3) return `${score} / 5（一般）`;
    return `${score} / 5（较差）`;
  };

  React.useEffect(() => {
    if (submissionDraftId && submissionDraft) {
      setEditor(submissionDraft);
      setEditingSubmission(submissionDraftId);
      setTab('students');
    } else if (!submissionDraftId) {
      setEditingSubmission(null);
    }
  }, [submissionDraftId, submissionDraft]);

  React.useEffect(() => {
    if (state.optimizerSettings) setSettingsDraft(state.optimizerSettings);
  }, [state.optimizerSettings]);

  React.useEffect(
    () => () => {
      if (availabilityTimer.current) clearTimeout(availabilityTimer.current);
    },
    []
  );

  const conflicts = React.useMemo(
    () => detectConflicts(state),
    [state.teacherCourses, state.teacherAvailability, state.students, state.locations, state.travelTimes, state.classes]
  );

  const filteredStudents = React.useMemo(() => {
    return state.students.filter((student) => {
      if (search.trim() && !student.name.includes(search.trim())) return false;
      if (classFilter !== '全部' && student.classType !== classFilter) return false;
      if (gradeFilter !== '全部' && student.grade !== gradeFilter) return false;
      if (
        locationFilter !== '全部' &&
        student.acceptedLocationIds.length > 0 &&
        !student.acceptedLocationIds.includes(locationFilter)
      ) return false;
      return true;
    });
  }, [state.students, search, classFilter, gradeFilter, locationFilter]);

  const gradeOptions = React.useMemo(
    () => Array.from(new Set(state.students.map((student) => student.grade).filter(Boolean))).sort(),
    [state.students]
  );

  const commonWindows = React.useMemo(() => {
    if (selectedStudentIds.length === 0) return [];
    return computeCommonFree(state, selectedStudentIds);
  }, [selectedStudentIds, state]);

  const studentCompleteness = (student: Student) => {
    const fields = [
      student.name,
      student.grade,
      student.school,
      student.courseNeed,
      student.classType,
      student.weeklySessionNeed,
      student.lessonMinutes,
      student.acceptedLocationIds.length > 0,
      Object.keys(student.availability).length > 0,
    ];
    return Math.round((fields.filter(Boolean).length / fields.length) * 100);
  };

  const countIncomplete = state.students.filter((student) => studentCompleteness(student) < 80).length;

  const saveState = async (next: AppState): Promise<AppState> => {
    setBusy(true);
    setOperationMessage(null);
    try {
      const result = onUpdate(next);
      const saved = result && typeof (result as any).then === 'function' ? ((await result) as AppState) : next;
      setOperationMessage({ kind: 'success', text: '已保存到云端。' });
      return saved;
    } catch (error: any) {
      setOperationMessage({ kind: 'error', text: error?.message || '保存失败，请检查网络后重试。' });
      return state;
    } finally {
      setBusy(false);
    }
  };

  const runAction = async (action: () => Promise<void>, successText?: string) => {
    if (busy) return;
    setBusy(true);
    setOperationMessage(null);
    try {
      await action();
      if (successText) setOperationMessage({ kind: 'success', text: successText });
    } catch (error: any) {
      setOperationMessage({ kind: 'error', text: error?.message || '操作失败，请检查网络后重试。' });
    } finally {
      setBusy(false);
    }
  };

  const toggleSelectStudent = (id: string) => {
    setSelectedStudentIds((prev) => (prev.includes(id) ? prev.filter((it) => it !== id) : [...prev, id]));
  };

  const addOrUpdateStudent = async () => {
    if (!editor) return;
    const nextStudent = { ...editor, updatedAt: new Date().toISOString() };
    if (editingSubmission) {
      await onSaveSubmissionEdit(editingSubmission, nextStudent);
      setEditingSubmission(null);
      onCancelSubmissionEdit();
      setEditor(null);
      return;
    }

    const students = [...state.students];
    const index = state.students.findIndex((it) => it.id === nextStudent.id);
    if (index >= 0) students[index] = nextStudent;
    else students.push(nextStudent);
    await saveState({ ...state, students });
    setEditor(null);
  };

  const createProposal = async () => {
    if (!selectedStudentIds.length) {
      setOperationMessage({ kind: 'error', text: '请至少选择一名学生。' });
      return;
    }
    await runAction(async () => {
      setProposals(await onGenerateProposals(selectedStudentIds));
    });
  };

  const createGroupSuggestions = () => {
    setGroupSuggestions(generateGroupSuggestions(state));
  };

  const useGroupSuggestion = async (suggestion: GroupSuggestion) => {
    setSelectedStudentIds(suggestion.studentIds);
    await runAction(async () => {
      setProposals(await onGenerateProposals(suggestion.studentIds));
    });
  };

  const applyProposal = (proposal: ScheduleProposal) => {
    void runAction(async () => {
      await onApplyProposal(proposal);
      setProposals([]);
    }, '方案已应用并重新读取云端课表。');
  };

  const submitCourse = async () => {
    if (!courseDraft.locationId || courseDraft.endMinute <= courseDraft.startMinute || courseDraft.studentIds.length === 0) {
      setOperationMessage({ kind: 'error', text: '请设置有效时间、地点，并至少选择一名课程成员。' });
      return;
    }
    const courseId = courseDraft.id ?? createUuid();
    const nextCourse: TeacherCourse = {
      id: courseId,
      studentIds: courseDraft.studentIds,
      title: courseDraft.title || '课程',
      day: courseDraft.day,
      startMinute: courseDraft.startMinute,
      endMinute: courseDraft.endMinute,
      locationId: courseDraft.locationId,
      classType: courseDraft.classType,
      isFixed: courseDraft.isFixed,
      adjustDifficulty: courseDraft.adjustDifficulty,
      notes: courseDraft.notes,
      source: 'manual',
      locked: courseDraft.locked,
      status: 'confirmed',
    };
    const nextCourses = [...state.teacherCourses];
    const idx = nextCourses.findIndex((item) => item.id === courseId);
    if (idx >= 0) nextCourses[idx] = nextCourse;
    else nextCourses.push(nextCourse);
    const nextState = { ...state, teacherCourses: nextCourses };
    const newErrors = detectConflicts(nextState).filter((item) => item.severity === 'error');
    const currentErrors = conflicts.filter((item) => item.severity === 'error');
    if (newErrors.length > currentErrors.length && !window.confirm(`这次修改会产生 ${newErrors.length} 个硬冲突，仍要保存吗？`)) return;
    const saved = await saveState(nextState);
    if (saved.teacherCourses.some((course) => course.id === courseId)) setCourseDraft(emptyCourseDraft(saved));
  };

  const removeCourse = (id: string) => {
    if (!window.confirm('取消这节课程？课程会保留为“已取消”历史记录。')) return;
    void saveState({
      ...state,
      teacherCourses: state.teacherCourses.filter((item) => item.id !== id),
    });
  };

  const openNewClass = () => {
    setClassDraft(createEmptyClassDraft(state));
  };

  const editClass = (id: string) => {
    const target = state.classes.find((item) => item.id === id);
    setClassDraft(target ? { ...target } : null);
  };

  const saveClassDraft = async () => {
    if (!classDraft) return;
    if (!classDraft.title.trim()) {
      return;
    }
    const nextClass: ClassProfile = {
      ...classDraft,
      updatedAt: new Date().toISOString(),
      status: classDraft.status || 'active',
      source: classDraft.source || 'manual',
      minStudentCount: classDraft.minStudentCount || 1,
      maxStudentCount: classDraft.maxStudentCount || classDraft.minStudentCount || 1,
      studentIds: Array.from(new Set(classDraft.studentIds)),
    };
    const next = [...state.classes];
    const index = next.findIndex((item) => item.id === nextClass.id);
    if (index >= 0) {
      next[index] = nextClass;
    } else {
      next.unshift(nextClass);
    }
    const saved = await saveState({ ...state, classes: next });
    if (saved.classes.some((item) => item.id === nextClass.id)) setClassDraft(null);
  };

  const removeClass = (id: string) => {
    const hasLinkedCourse = state.teacherCourses.some((course) => course.classId === id);
    if (hasLinkedCourse) {
      return;
    }
    if (!window.confirm('结束这个班级？班级历史和成员关系会保留。')) return;
    const next = state.classes.filter((item) => item.id !== id);
    void saveState({
      ...state,
      classes: next,
      teacherCourses: state.teacherCourses.map((course) => (course.classId === id ? { ...course, classId: undefined } : course)),
    });
    if (classDraft?.id === id) {
      setClassDraft(null);
    }
  };

  const toggleClassMember = (classId: string, studentId: string, checked: boolean) => {
    if (!classDraft || classDraft.id !== classId) return;
    if (checked) {
      setClassDraft({
        ...classDraft,
        studentIds: Array.from(new Set([...classDraft.studentIds, studentId])),
      });
      return;
    }
    setClassDraft({
      ...classDraft,
      studentIds: classDraft.studentIds.filter((id) => id !== studentId),
    });
  };

  const setTravelTime = (from: string, to: string, patch: Partial<{ minutes: number; bufferMinutes: number }>) => {
    const nextTimes = [...state.travelTimes];
    const existing = nextTimes.findIndex((item) => item.fromLocationId === from && item.toLocationId === to);
    if (existing >= 0) {
      nextTimes[existing] = { ...nextTimes[existing], ...patch };
    } else {
      nextTimes.push({ fromLocationId: from, toLocationId: to, minutes: patch.minutes ?? 30, bufferMinutes: patch.bufferMinutes ?? 10 });
    }
    void saveState({ ...state, travelTimes: nextTimes });
  };

  const addLocation = () => {
    const name = newLocationName.trim();
    if (!name) return;
    const id = createUuid();
    const location = {
      id,
      name,
      address: newLocationAddress.trim(),
      note: newLocationNote.trim() || undefined,
      capacity: 6,
      priorityWeight: 1,
      active: true,
    };
    const travelTimes = [...state.travelTimes];
    state.locations.forEach((item) => {
      travelTimes.push({ fromLocationId: id, toLocationId: item.id, minutes: 30, bufferMinutes: 10 });
      travelTimes.push({ fromLocationId: item.id, toLocationId: id, minutes: 30, bufferMinutes: 10 });
    });
    void saveState({
      ...state,
      locations: [...state.locations, location],
      travelTimes,
    });
    setNewLocationName('');
    setNewLocationAddress('');
    setNewLocationNote('');
  };

  const removeLocation = (id: string) => {
    if (state.locations.filter((item) => item.active !== false).length <= 1) return;
    const target = state.locations.find((item) => item.id === id);
    if (!target || !window.confirm('停用地点“' + target.name + '”？历史课程和通勤记录将保留。')) return;
    void saveState({
      ...state,
      locations: state.locations.map((item) => (item.id === id ? { ...item, active: false } : item)),
    });
  };

  const updateTeacherAvailability = (next: Record<string, TeacherTimeStatus>) => {
    setTeacherAvailability(next);
    if (availabilityTimer.current) clearTimeout(availabilityTimer.current);
    availabilityTimer.current = setTimeout(() => {
      void runAction(async () => onSaveTeacherAvailability(next), '教师时间已保存。');
    }, 700);
  };

  const handleCancelEditor = () => {
    if (editingSubmission) {
      setEditingSubmission(null);
      onCancelSubmissionEdit();
    }
    setEditor(null);
  };

  return (
    <main>
      <header className="hero">
        <h1>教师工作台</h1>
        <p>支持排课、冲突检测、学生提交审核与地点管理。</p>
      </header>

      <div className="tabs">
        <button className={tab === 'dashboard' ? 'active' : ''} onClick={() => setTab('dashboard')}>
          工作台
        </button>
        <button className={tab === 'students' ? 'active' : ''} onClick={() => setTab('students')}>
          学生
        </button>
        <button className={tab === 'classes' ? 'active' : ''} onClick={() => setTab('classes')}>
          班级
        </button>
        <button className={tab === 'schedule' ? 'active' : ''} onClick={() => setTab('schedule')}>
          周课表
        </button>
        <button className={tab === 'locations' ? 'active' : ''} onClick={() => setTab('locations')}>
          地点/通勤
        </button>
        <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
          设置
        </button>
      </div>

      {operationMessage && <p className={`operation-message ${operationMessage.kind}`}>{operationMessage.text}</p>}
      {busy && <p className="operation-message saving">正在处理，请勿重复操作...</p>}

      {tab === 'dashboard' && (
        <section className="card">
          <div className="cards">
            <div className="mini">
              <h3>本周课程</h3>
              <p>{state.teacherCourses.length}</p>
            </div>
            <div className="mini">
              <h3>待完善学生</h3>
              <p>{countIncomplete}</p>
            </div>
            <div className="mini">
              <h3>待处理提交</h3>
              <p>{state.pendingSubmissions.length}</p>
            </div>
            <div className="mini">
              <h3>错误冲突</h3>
              <p>{conflicts.filter((item) => item.severity === 'error').length}</p>
            </div>
          </div>

          <h2>学生提交待审核</h2>
          {state.pendingSubmissions.length === 0 && <p>暂无待审核提交。</p>}
          {state.pendingSubmissions.map((submission) => (
            (() => {
              const sameNameStudents = getSubmissionConflicts(submission);
              const hasSameName = sameNameStudents.length > 0;
              const selectedTarget = mergeTargetMap[submission.id] || sameNameStudents[0]?.id || '';
              return (
                <div className="list-item" key={submission.id} style={{ flexDirection: 'column' }}>
                  <div>
                    <h3>{submission.studentName}</h3>
                    <p>
                      年级：{submission.grade} · 课程：{submission.classType} · 学校：{submission.school || '未填写'} · 联系方式：{submission.contact || '未填写'}
                    </p>
                    <p>
                      每周次数：{submission.weeklySessionNeed ?? '未填写'} · 单节时长：{submission.lessonMinutes ? `${submission.lessonMinutes}分钟` : '未填写'} · 目标人数：
                      {submission.targetStudentCount || '未填写'} · 地点偏好：{resolveLocationSummary(submission)}
                    </p>
                    <p>
                      提交时间：{new Date(submission.submittedAt).toLocaleString()} · 时间完整度：{submission.timeCompleteness}% ·
                      固定课程：{submission.originalCourseCount || 0}条 · 灵活性：{formatFlexibility(submission.flexibilityScore)}
                    </p>
                  </div>
                  <div className="row-actions">
                    {hasSameName ? (
                      <>
                        <button disabled={busy} onClick={() => void runAction(() => onAcceptSubmission(submission.id, true))}>新建（同名允许）</button>
                        <button onClick={() => onStartSubmissionEdit(submission.id)}>编辑后接受</button>
                        <button
                          className="danger"
                          onClick={() => {
                            if (window.confirm('忽略该学生提交？该操作会归档提交。')) void runAction(() => onIgnoreSubmission(submission.id));
                          }}
                        >
                          忽略
                        </button>
                      </>
                    ) : (
                      <>
                        <button disabled={busy} onClick={() => void runAction(() => onAcceptSubmission(submission.id))}>接收并加入学生库</button>
                        <button onClick={() => onStartSubmissionEdit(submission.id)}>编辑后接受</button>
                        <button
                          className="danger"
                          onClick={() => {
                            if (window.confirm('忽略该学生提交？该操作会归档提交。')) void runAction(() => onIgnoreSubmission(submission.id));
                          }}
                        >
                          忽略
                        </button>
                      </>
                    )}
                  </div>
                  {hasSameName && (
                    <div className="tiny" style={{ color: '#b15b00', margin: '8px 0' }}>
                      可能存在同名/已有学生：{sameNameStudents.map((item) => item.name).join('、')}
                    </div>
                  )}
                  <div className="toolbar" style={{ marginTop: 0 }}>
                    <select
                      value={selectedTarget}
                      onChange={(e) =>
                        setMergeTargetMap((prev) => ({
                          ...prev,
                          [submission.id]: e.target.value,
                        }))
                      }
                      disabled={!hasSameName}
                    >
                      <option value="">合并到已有学生（选择目标）</option>
                      {sameNameStudents.map((student) => (
                        <option key={student.id} value={student.id}>
                          {student.name}
                        </option>
                      ))}
                    </select>
                    <button disabled={!selectedTarget || busy} onClick={() => void runAction(() => onMergeSubmission(submission.id, selectedTarget))}>
                      合并到已有学生
                    </button>
                    <button className="danger" onClick={() => setMergeTargetMap((prev) => ({ ...prev, [submission.id]: '' }))}>
                      取消
                    </button>
                  </div>
                </div>
              );
            })()
          ))}

          <div className="functional-summary">
            <div>
              <strong>自动组班</strong>
              <span>按年级、课时、每周次数、共同地点和完整通勤约束计算。</span>
            </div>
            <button disabled={busy} onClick={createGroupSuggestions}>生成组班建议</button>
          </div>
          {groupSuggestions.length > 0 && (
            <div className="group-suggestion-grid" aria-label="自动组班建议">
              {groupSuggestions.map((suggestion) => (
                <article className="group-suggestion" key={suggestion.id}>
                  <div className="proposal-heading">
                    <h3>{suggestion.title}</h3>
                    <strong>{Math.round(suggestion.score)} 分</strong>
                  </div>
                  <p>
                    {suggestion.studentIds
                      .map((id) => state.students.find((student) => student.id === id)?.name || id)
                      .join('、')}
                  </p>
                  <p>
                    推荐时段：{WEEK_LABELS[suggestion.bestWindow.day]} {formatMinute(suggestion.bestWindow.startMinute)}-
                    {formatMinute(suggestion.bestWindow.endMinute)} ·{' '}
                    {state.locations.find((location) => location.id === suggestion.bestWindow.locationId)?.name || '未设置地点'}
                  </p>
                  <p className="tiny">{suggestion.reasons.join('；')}</p>
                  {suggestion.warnings.map((warning) => (
                    <p className="warning-note" key={warning}>{warning}</p>
                  ))}
                  <button disabled={busy} onClick={() => void useGroupSuggestion(suggestion)}>采用成员并生成排课方案</button>
                </article>
              ))}
            </div>
          )}
          {groupSuggestions.length === 0 && (
            <p className="tiny">尚未计算组班建议；已进入正式班级的学生不会被重复推荐。</p>
          )}

          <h2>学生列表选择</h2>
          <ul className="list">
            {state.students.map((student) => (
              <li key={student.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={selectedStudentIds.includes(student.id)}
                    onChange={() => toggleSelectStudent(student.id)}
                  />
                  {student.name} / {student.grade} / {student.classType}
                </label>
                {student.originalCourses.length > 0 ? ` · ${student.originalCourses.length} 条原课` : ' · 无原课'}
              </li>
            ))}
          </ul>

          <div className="actions">
            <button disabled={busy} onClick={() => void createProposal()}>智能排课并记录运行</button>
          </div>

          <h2>共同空闲时间</h2>
          <div className="list">
            {commonWindows.slice(0, 6).map((item) => (
              <div className="mini" key={item.id}>
                <p>
                  <strong>{WEEK_LABELS[item.day]}</strong> {formatMinute(item.startMinute)}-{formatMinute(item.endMinute)}
                </p>
                <p>地点：{state.locations.find((loc) => loc.id === item.locationId)?.name}</p>
                <p>质量：{item.quality}</p>
                <p>评分：{item.score}</p>
              </div>
            ))}
            {!commonWindows.length && <p>请选择学生后自动计算共同空闲时间。</p>}
          </div>

          <h2>智能排课方案</h2>
          {proposals.length === 0 && <p>尚未生成方案，先选择学生并点击按钮。</p>}
          <div className="proposals">
            {proposals.map((item) => (
              <article className="proposal-card" key={item.id}>
                <div className="proposal-heading">
                  <h4>{item.title}</h4>
                  <strong>{Math.round(item.score)} 分</strong>
                </div>
                <p>策略：{item.strategy}</p>
                <p>{item.explanation}</p>
                <div className="metric-strip">
                  <span>硬冲突 {item.breakdown.hardConflicts}</span>
                  <span>完成率 {item.breakdown.completenessRate}%</span>
                  <span>需调整 {item.breakdown.adjustedStudentSlots + item.breakdown.hardAdjustmentSlots}</span>
                  <span>学生通勤 {item.breakdown.studentTravelMinutes} 分钟</span>
                  <span>教师通勤 {item.breakdown.teacherTravelMinutes} 分钟</span>
                </div>
                <div className="proposal-assignments">
                  {(item.assignments || [item.assignment]).map((assignment) => (
                    <span key={assignment.id}>
                      {WEEK_LABELS[assignment.day]} {formatMinute(assignment.startMinute)}-{formatMinute(assignment.endMinute)} ·{' '}
                      {state.locations.find((location) => location.id === assignment.locationId)?.name || '未设置地点'}
                    </span>
                  ))}
                </div>
                {item.warnings.length > 0 && <p className="warning-note">{item.warnings.join('；')}</p>}
                <button disabled={busy} onClick={() => applyProposal(item)}>应用到周课表</button>
              </article>
            ))}
          </div>

          <h2>冲突检测</h2>
          <div className="severity-summary">
            <span>硬冲突：{conflicts.filter((item) => item.severity === 'error').length}</span>
            <span>提醒：{conflicts.filter((item) => item.severity === 'warning').length}</span>
            <span>学生/通勤：{conflicts.filter((item) => item.kind === 'student' || item.kind === 'commute').length}</span>
          </div>
          <ul className="list">
            {conflicts.length === 0 && <li>暂无冲突</li>}
            {conflicts.map((item: ConflictItem) => (
              <li key={item.id} className={item.severity}>
                <strong>[{WEEK_LABELS[item.day]}]</strong> {item.title}：{item.detail}
              </li>
            ))}
          </ul>
        </section>
      )}

      {tab === 'students' && (
        <section className="card">
          <div className="toolbar">
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="按姓名搜索" />
            <select value={classFilter} onChange={(e) => setClassFilter(e.target.value as ClassType | '全部')}>
              {classTypeList.map((type) => (
                <option key={type}>{type}</option>
              ))}
            </select>
            <select value={gradeFilter} onChange={(e) => setGradeFilter(e.target.value)}>
              <option value="全部">全部年级</option>
              {gradeOptions.map((grade) => <option key={grade} value={grade}>{grade}</option>)}
            </select>
            <select value={locationFilter} onChange={(e) => setLocationFilter(e.target.value)}>
              <option value="全部">全部地点</option>
              {state.locations.filter((location) => location.active !== false).map((location) => (
                <option key={location.id} value={location.id}>{location.name}</option>
              ))}
            </select>
            <button onClick={() => setEditor(createEmptyStudent(state))}>新增学生</button>
          </div>

          <div>
            {filteredStudents.map((student) => (
              <div className="list-item" key={student.id}>
                <div>
                  <h3>{student.name}</h3>
                  <p>{student.grade}</p>
                  <p>{student.school || '学校未登记'} · {student.classType}</p>
                  <p>课程需求：{student.courseNeed || '未登记'} · 每周 {student.weeklySessionNeed || 1} 次 · {student.lessonMinutes || 60} 分钟</p>
                  <p>信息完整度：{studentCompleteness(student)}%</p>
                  <p>最后更新：{new Date(student.updatedAt).toLocaleString()}</p>
                </div>
                <div className="row-actions">
                  <button onClick={() => setEditor(student)}>查看/编辑</button>
                    <button
                      className="danger"
                      onClick={() => {
                        if (!window.confirm(`停用学生“${student.name}”？历史班级和课程不会删除。`)) return;
                        void saveState({
                          ...state,
                          students: state.students.map((item) => item.id === student.id ? { ...item, active: false } : item),
                        });
                      }}
                    >
                    停用
                  </button>
                </div>
              </div>
            ))}
          </div>

          {editor && (
            <section className="card">
              <h3>学生详情编辑</h3>
              <label>
                姓名
                <input value={editor.name} onChange={(e) => setEditor({ ...editor, name: e.target.value })} />
              </label>
              <label>
                年级
                <input value={editor.grade} onChange={(e) => setEditor({ ...editor, grade: e.target.value })} />
              </label>
              <label>
                联系方式
                <input value={editor.contact ?? ''} onChange={(e) => setEditor({ ...editor, contact: e.target.value })} />
              </label>
              <label>
                学校
                <input value={editor.school ?? ''} onChange={(e) => setEditor({ ...editor, school: e.target.value })} />
              </label>
              <label>
                课程需求
                <input value={editor.courseNeed ?? ''} onChange={(e) => setEditor({ ...editor, courseNeed: e.target.value })} />
              </label>
              <div className="row">
                <label>
                  每周次数
                  <input type="number" min={1} max={7} value={editor.weeklySessionNeed || 1} onChange={(e) => setEditor({ ...editor, weeklySessionNeed: Number(e.target.value) || 1 })} />
                </label>
                <label>
                  单节时长
                  <select value={editor.lessonMinutes || 60} onChange={(e) => setEditor({ ...editor, lessonMinutes: Number(e.target.value) })}>
                    {[60, 90, 120, 150, 180].map((minutes) => <option key={minutes} value={minutes}>{minutes}分钟</option>)}
                  </select>
                </label>
                <label>
                  目标人数
                  <input type="number" min={1} max={12} value={editor.targetStudentCount || 1} onChange={(e) => setEditor({ ...editor, targetStudentCount: Number(e.target.value) || 1 })} />
                </label>
              </div>
              <label>
                上课类型
                <select
                  value={editor.classType}
                  onChange={(e) => setEditor({ ...editor, classType: e.target.value as ClassType })}
                >
                  {classTypeList
                    .filter((type): type is ClassType => type !== '全部')
                    .map((type) => (
                      <option key={type}>{type}</option>
                    ))}
                </select>
              </label>
              <div className="location-list">
                {state.locations.map((loc) => (
                  <label className="check-item" key={loc.id}>
                    <input
                      type="checkbox"
                      checked={editor.acceptedLocationIds.includes(loc.id)}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        const next = checked ? [...editor.acceptedLocationIds, loc.id] : editor.acceptedLocationIds.filter((id) => id !== loc.id);
                        setEditor({ ...editor, acceptedLocationIds: next });
                      }}
                    />
                    {loc.name}
                  </label>
                ))}
                <button onClick={() => setEditor({ ...editor, acceptedLocationIds: [] })} type="button" className="mini">
                  不限地点
                </button>
              </div>

              <h3>每周时间表</h3>
              <TimeGridEditor
                title="可上课状态"
                value={editor.availability}
                palette={[
                  { value: 'free', text: '可上课', color: 'status-free' },
                  { value: 'adjust', text: '可调整', color: 'status-adjust' },
                  { value: 'hardAdjust', text: '不太方便调整', color: 'status-hard' },
                  { value: 'blocked', text: '完全不能上课', color: 'status-blocked' },
                ]}
                onChange={(next) => setEditor({ ...editor, availability: next })}
              />

              <h3>原课程列表（可编辑）</h3>
              {editor.originalCourses.map((course, index) => (
                <p key={`${course.id}-${index}`}>
                  {WEEK_LABELS[course.day]} {formatMinute(course.startMinute)}-{formatMinute(course.endMinute)}｜{course.title}
                  {course.isFixed ? '（固定）' : ''}
                </p>
              ))}
              {editor.originalCourses.length === 0 && <p>暂无原课程</p>}

              <h3>当前班级与已排课程</h3>
              <p>
                班级：{state.classes.filter((item) => item.studentIds.includes(editor.id)).map((item) => item.title).join('、') || '暂未加入班级'}
              </p>
              {state.teacherCourses.filter((course) => course.status !== 'cancelled' && course.studentIds.includes(editor.id)).map((course) => (
                <p key={course.id}>{WEEK_LABELS[course.day]} {formatMinute(course.startMinute)}-{formatMinute(course.endMinute)} · {course.title}</p>
              ))}

              <label>
                备注
                <textarea rows={3} value={editor.notes ?? ''} onChange={(e) => setEditor({ ...editor, notes: e.target.value })} />
              </label>

              <div className="actions">
                <button onClick={handleCancelEditor}>取消</button>
                <button onClick={addOrUpdateStudent}>保存</button>
              </div>
            </section>
          )}
        </section>
      )}

      {tab === 'classes' && (
        <section className="card">
          <div className="toolbar">
            <h2>班级管理</h2>
            <button onClick={openNewClass}>新增班级</button>
          </div>
          {state.classes.length === 0 && <p>暂无班级。</p>}

          {state.classes.map((classItem) => (
            <div className="list-item" key={classItem.id}>
              <div>
                <h3>{classItem.title}</h3>
                <p>
                  类型：{classItem.classType} · 目标人数 {classItem.minStudentCount || 1}~{classItem.maxStudentCount || 1}
                </p>
                <p>
                  每周次数：{classItem.weeklySessionNeed || '-'} · 课时：{classItem.durationMinutes || '-'}分钟 · 地点：
                  {state.locations.find((loc) => loc.id === classItem.preferredLocationId)?.name || '未设置'}
                </p>
                <p>成员：{classItem.studentIds.length}人 · 状态：{classItem.status || 'active'} · 来源：{classItem.source || 'manual'}</p>
              </div>
              <div className="row-actions">
                <button onClick={() => editClass(classItem.id)}>编辑</button>
                <button
                  className="danger"
                  onClick={() => removeClass(classItem.id)}
                  title="班级有课程时仅允许取消关联，不会删除已排课程"
                >
                  删除
                </button>
              </div>
            </div>
          ))}

          {classDraft && (
            <section className="card">
              <h3>班级详情</h3>
              <label>
                班级名称
                <input value={classDraft.title} onChange={(e) => setClassDraft({ ...classDraft, title: e.target.value })} />
              </label>
              <label>
                课程类型
                <select value={classDraft.classType} onChange={(e) => setClassDraft({ ...classDraft, classType: e.target.value as ClassType })}>
                  {classTypeList
                    .filter((type): type is ClassType => type !== '全部')
                    .map((type) => (
                      <option key={type}>{type}</option>
                    ))}
                </select>
              </label>
              <div className="row">
                <label>
                  最少人数
                  <input
                    type="number"
                    min={1}
                    value={classDraft.minStudentCount || 1}
                    onChange={(e) =>
                      setClassDraft({ ...classDraft, minStudentCount: Number(e.target.value) || 1 })
                    }
                  />
                </label>
                <label>
                  最大人数
                  <input
                    type="number"
                    min={1}
                    value={classDraft.maxStudentCount || 1}
                    onChange={(e) =>
                      setClassDraft({ ...classDraft, maxStudentCount: Number(e.target.value) || 1 })
                    }
                  />
                </label>
                <label>
                  每周次数
                  <input
                    type="number"
                    min={1}
                    value={classDraft.weeklySessionNeed || 1}
                    onChange={(e) =>
                      setClassDraft({ ...classDraft, weeklySessionNeed: Number(e.target.value) || 1 })
                    }
                  />
                </label>
                <label>
                  每课时长（分钟）
                  <input
                    type="number"
                    min={30}
                    step={30}
                    value={classDraft.durationMinutes || 60}
                    onChange={(e) =>
                      setClassDraft({ ...classDraft, durationMinutes: Number(e.target.value) || 60 })
                    }
                  />
                </label>
                <label>
                  状态
                  <select
                    value={classDraft.status || 'active'}
                    onChange={(e) => setClassDraft({ ...classDraft, status: e.target.value as 'active' | 'archived' | 'draft' })}
                  >
                    <option value="active">active</option>
                    <option value="draft">draft</option>
                    <option value="archived">archived</option>
                  </select>
                </label>
                <label>
                  推荐地点
                  <select
                    value={classDraft.preferredLocationId || ''}
                    onChange={(e) => setClassDraft({ ...classDraft, preferredLocationId: e.target.value || undefined })}
                  >
                    <option value="">未设置</option>
                    {state.locations.map((loc) => (
                      <option key={loc.id} value={loc.id}>
                        {loc.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  锁定
                  <input
                    type="checkbox"
                    checked={classDraft.locked || false}
                    onChange={(e) => setClassDraft({ ...classDraft, locked: e.target.checked })}
                  />
                </label>
              </div>

              <label>成员</label>
              <div className="location-list">
                {state.students.map((student) => (
                  <label key={student.id} className="check-item">
                    <input
                      type="checkbox"
                      checked={classDraft.studentIds.includes(student.id)}
                      onChange={(e) => toggleClassMember(classDraft.id, student.id, e.target.checked)}
                    />
                    {student.name}
                  </label>
                ))}
                {state.students.length === 0 && <p className="tiny">暂无学生可加入。</p>}
              </div>
              <div className="actions">
                <button className="danger" onClick={() => setClassDraft(null)}>
                  取消
                </button>
                <button onClick={saveClassDraft}>保存</button>
              </div>
            </section>
          )}
        </section>
      )}

      {tab === 'schedule' && (
        <section className="card">
          <h2>教师时间设置</h2>
          <TimeGridEditor
            title="教师时间"
            value={teacherAvailability}
            palette={[
              { value: 'free', text: '可以上课', color: 'teacher-free' },
              { value: 'course', text: '已有课程', color: 'teacher-course' },
              { value: 'occupied', text: '不可安排', color: 'teacher-occupied' },
              { value: 'commute', text: '通勤', color: 'teacher-commute' },
              { value: 'blocked', text: '临时占用', color: 'teacher-blocked' },
            ]}
            onChange={updateTeacherAvailability}
          />

          <h2>新增课程</h2>
          <div className="row">
            <label>
              标题
              <input value={courseDraft.title} onChange={(e) => setCourseDraft({ ...courseDraft, title: e.target.value })} />
            </label>
            <label>
              星期
              <select value={courseDraft.day} onChange={(e) => setCourseDraft({ ...courseDraft, day: Number(e.target.value) as WeekDay })}>
                {[1, 2, 3, 4, 5, 6, 7].map((day) => (
                  <option key={day} value={day}>
                    {WEEK_LABELS[day as WeekDay]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              开始
              <input
                type="time"
                value={formatMinute(courseDraft.startMinute)}
                onChange={(e) =>
                  setCourseDraft({
                    ...courseDraft,
                    startMinute: e.target.value
                      ? (() => {
                          const [h, m] = e.target.value.split(':').map(Number);
                          return h * 60 + m;
                        })()
                      : 13 * 60,
                  })
                }
              />
            </label>
            <label>
              结束
              <input
                type="time"
                value={formatMinute(courseDraft.endMinute)}
                onChange={(e) =>
                  setCourseDraft({
                    ...courseDraft,
                    endMinute: e.target.value
                      ? (() => {
                          const [h, m] = e.target.value.split(':').map(Number);
                          return h * 60 + m;
                        })()
                      : 14 * 60,
                  })
                }
              />
            </label>
          </div>
          <div className="row">
            <label>
              地点
              <select value={courseDraft.locationId} onChange={(e) => setCourseDraft({ ...courseDraft, locationId: e.target.value })}>
                {state.locations.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              类型
              <select
                value={courseDraft.classType}
                onChange={(e) => setCourseDraft({ ...courseDraft, classType: e.target.value as ClassType })}
              >
                {classTypeList
                  .filter((item): item is ClassType => item !== '全部')
                  .map((type) => (
                    <option key={type}>{type}</option>
                  ))}
              </select>
            </label>
            <label>
              是否固定
              <select value={courseDraft.isFixed ? '1' : '0'} onChange={(e) => setCourseDraft({ ...courseDraft, isFixed: e.target.value === '1' })}>
                <option value="1">是</option>
                <option value="0">否</option>
              </select>
            </label>
            <label>
              调整难度
              <select
                value={courseDraft.adjustDifficulty}
                onChange={(e) => setCourseDraft({ ...courseDraft, adjustDifficulty: Number(e.target.value) as 1 | 2 | 3 | 4 | 5 })}
              >
                {[1, 2, 3, 4, 5].map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              锁定课程
              <input
                type="checkbox"
                checked={courseDraft.locked}
                onChange={(e) => setCourseDraft({ ...courseDraft, locked: e.target.checked })}
              />
            </label>
          </div>
          <label>课程成员</label>
          <div className="location-list">
            {state.students.filter((student) => student.active !== false).map((student) => (
              <label key={student.id} className="check-item">
                <input
                  type="checkbox"
                  checked={courseDraft.studentIds.includes(student.id)}
                  onChange={(e) =>
                    setCourseDraft({
                      ...courseDraft,
                      studentIds: e.target.checked
                        ? Array.from(new Set([...courseDraft.studentIds, student.id]))
                        : courseDraft.studentIds.filter((id) => id !== student.id),
                    })
                  }
                />
                {student.name}
              </label>
            ))}
          </div>
          <label>
            备注
            <input value={courseDraft.notes} onChange={(e) => setCourseDraft({ ...courseDraft, notes: e.target.value })} />
          </label>
          <div className="actions">
            <button disabled={busy} onClick={() => void submitCourse()}>{courseDraft.id ? '更新课程' : '添加课程'}</button>
            {courseDraft.id && (
              <button type="button" onClick={() => setCourseDraft(emptyCourseDraft(state))}>
                取消编辑
              </button>
            )}
          </div>

          <h2>本周课程列表</h2>
          <div className="week-calendar" aria-label="周课表">
            {[1, 2, 3, 4, 5, 6, 7].map((day) => (
              <section key={day} className="week-day">
                <h3>{WEEK_LABELS[day as WeekDay]}</h3>
                {state.teacherCourses
                  .filter((course) => course.status !== 'cancelled' && course.day === day)
                  .sort((left, right) => left.startMinute - right.startMinute)
                  .map((course) => (
                    <article key={course.id} className="week-course">
                      <strong>{formatMinute(course.startMinute)}-{formatMinute(course.endMinute)}</strong>
                      <span>{course.title}</span>
                      <small>{state.locations.find((location) => location.id === course.locationId)?.name || '未设置地点'}</small>
                    </article>
                  ))}
              </section>
            ))}
          </div>
          {state.teacherCourses.length === 0 ? (
            <p>暂无课程</p>
          ) : (
            <div>
              {state.teacherCourses
                .slice()
                .sort((a, b) => a.day - b.day || a.startMinute - b.startMinute)
                .map((course) => (
                  <div className="list-item" key={course.id}>
                    <div>
                      <h3>{course.title}</h3>
                      <p>
                        {WEEK_LABELS[course.day]} {formatMinute(course.startMinute)}-{formatMinute(course.endMinute)} ·{' '}
                        {state.locations.find((loc) => loc.id === course.locationId)?.name}
                      </p>
                      <p>
                        学生：
                        {course.studentIds.length
                          ? course.studentIds
                              .map((id) => state.students.find((student) => student.id === id)?.name || id)
                              .join('、')
                          : '未绑定学生'}
                      </p>
                      <p>来源：{course.source === 'proposal' ? '智能排课' : '手工'}</p>
                    </div>
                    <div className="row-actions">
                      <button
                        onClick={() =>
                          setCourseDraft({
                            id: course.id,
                            title: course.title,
                            studentIds: course.studentIds,
                            day: course.day,
                            startMinute: course.startMinute,
                            endMinute: course.endMinute,
                            locationId: course.locationId,
                            classType: course.classType,
                            isFixed: course.isFixed,
                            adjustDifficulty: course.adjustDifficulty,
                            notes: course.notes ?? '',
                            locked: Boolean(course.locked),
                          })
                        }
                      >
                        编辑
                      </button>
                      <button className="danger" onClick={() => removeCourse(course.id)}>
                        删除
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          )}
        </section>
      )}

      {tab === 'locations' && (
        <section className="card">
          <h2>地点管理</h2>
          <h3>新增地点</h3>
          <div className="row">
            <label>
              名称
              <input value={newLocationName} onChange={(e) => setNewLocationName(e.target.value)} />
            </label>
            <label>
              地址
              <input value={newLocationAddress} onChange={(e) => setNewLocationAddress(e.target.value)} />
            </label>
            <label>
              备注
              <input value={newLocationNote} onChange={(e) => setNewLocationNote(e.target.value)} />
            </label>
          </div>
          <div className="actions">
            <button onClick={addLocation}>新增地点</button>
          </div>
          <div className="list">
            {state.locations.map((location, index) => {
              return (
                <div className="list-item" key={location.id}>
                  <div>
                    <label>
                      名称
                      <input
                        value={location.name}
                        onChange={(e) => {
                          const next = [...state.locations];
                          next[index] = { ...next[index], name: e.target.value };
                          saveState({ ...state, locations: next });
                        }}
                      />
                    </label>
                    <label>
                      地址
                      <input
                        value={location.address}
                        onChange={(e) => {
                          const next = [...state.locations];
                          next[index] = { ...next[index], address: e.target.value };
                          saveState({ ...state, locations: next });
                        }}
                      />
                    </label>
                    <label>
                      简称
                      <input
                        value={location.shortName ?? ''}
                        onChange={(e) => {
                          const next = [...state.locations];
                          next[index] = { ...next[index], shortName: e.target.value };
                          void saveState({ ...state, locations: next });
                        }}
                      />
                    </label>
                    <label>
                      容量
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={location.capacity ?? 1}
                        onChange={(e) => {
                          const next = [...state.locations];
                          next[index] = { ...next[index], capacity: Number(e.target.value) || 1 };
                          void saveState({ ...state, locations: next });
                        }}
                      />
                    </label>
                    <label>
                      优先权重
                      <input
                        type="number"
                        min={0.1}
                        step={0.1}
                        value={location.priorityWeight ?? 1}
                        onChange={(e) => {
                          const next = [...state.locations];
                          next[index] = { ...next[index], priorityWeight: Number(e.target.value) || 1 };
                          void saveState({ ...state, locations: next });
                        }}
                      />
                    </label>
                    <label>
                      备注
                      <input
                        value={location.note ?? ''}
                        onChange={(e) => {
                          const next = [...state.locations];
                          next[index] = { ...next[index], note: e.target.value };
                          saveState({ ...state, locations: next });
                        }}
                      />
                    </label>
                    <label className="check-item">
                      <input
                        type="checkbox"
                        checked={location.active !== false}
                        onChange={(e) => {
                          const next = [...state.locations];
                          next[index] = { ...next[index], active: e.target.checked };
                          void saveState({ ...state, locations: next });
                        }}
                      />
                      对学生端公开
                    </label>
                    <button
                      type="button"
                      className="danger"
                      disabled={state.locations.length <= 1}
                      onClick={() => removeLocation(location.id)}
                    >
                      停用
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <h3>通勤矩阵（方向不同可分别设置，分钟 + 缓冲）</h3>
          <div className="travel-matrix">
            <table>
              <thead>
                <tr>
                  <th> </th>
                  {state.locations.map((to) => (
                    <th key={to.id}>{to.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {state.locations.map((from) => (
                  <tr key={from.id}>
                    <th>{from.name}</th>
                    {state.locations.map((to) => {
                      if (from.id === to.id) return <td key={to.id}>0</td>;
                      const found = state.travelTimes.find((item) => item.fromLocationId === from.id && item.toLocationId === to.id);
                      return (
                        <td key={to.id}>
                          <input
                            type="number"
                            min={0}
                            value={found?.minutes ?? ''}
                            placeholder="未设置"
                            onChange={(e) => setTravelTime(from.id, to.id, { minutes: Number(e.target.value) })}
                          />
                          <input
                            aria-label={from.name + '到' + to.name + '缓冲分钟'}
                            type="number"
                            min={0}
                            max={120}
                            value={found?.bufferMinutes ?? ''}
                            placeholder="缓冲"
                            onChange={(e) => setTravelTime(from.id, to.id, { bufferMinutes: Number(e.target.value) })}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === 'settings' && (
        <section className="card">
          <h2>智能排课参数</h2>
          <p className="tiny">这些权重直接参与方案评分；硬时间冲突、教师冲突和通勤不可行仍会直接淘汰，不受权重降低影响。</p>
          <div className="settings-grid">
            {[
              ['student_preferred_time', '学生时间偏好'],
              ['teacher_preferred_time', '教师时间偏好'],
              ['same_location_cluster', '同地点连续'],
              ['minimize_travel', '减少通勤'],
              ['compact_schedule', '课程集中'],
              ['student_locked_schedule', '保护固定安排'],
              ['grouping_efficiency', '组班效率'],
            ].map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  type="number"
                  min={0}
                  max={200}
                  value={settingsDraft.weights[key] ?? 50}
                  onChange={(e) => setSettingsDraft({
                    ...settingsDraft,
                    weights: { ...settingsDraft.weights, [key]: Number(e.target.value) || 0 },
                  })}
                />
              </label>
            ))}
          </div>
          <div className="actions">
            <button disabled={busy} onClick={() => void saveState({ ...state, optimizerSettings: settingsDraft })}>保存排课参数</button>
          </div>
          <h3>运行记录</h3>
          {state.scheduleRuns.length === 0 && <p>尚未运行智能排课。</p>}
          {state.scheduleRuns.slice(0, 20).map((run) => (
            <div className="list-item" key={run.id}>
              <span>{new Date(run.createdAt).toLocaleString()} · {run.algorithmVersion || '未标记版本'}</span>
              <strong>{run.status || 'generated'} · {run.totalScore == null ? '未评分' : `${Math.round(run.totalScore)}分`}</strong>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}
