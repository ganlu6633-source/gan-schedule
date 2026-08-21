import React from 'react';
import { AppState, ClassProfile, ClassType, IntakeSubmissionStatus, ScheduleProposal, Student, StudentSubmissionPayload } from './types';
import { StudentPortal } from './components/StudentPortal';
import { TeacherPortal } from './components/TeacherPortal';
import { createUuid } from './utils/id';
import {
  authenticateStudentSchedule,
  checkTeacherCanAccess,
  emptyAppState,
  getAuthClient,
  loadStudentFormConfig,
  loadStudentPublicContext,
  verifyTeacherWorkspaceAccess,
  loadTeacherWorkspace,
  persistScheduleRun,
  persistTeacherAvailability,
  markSubmissionStatus,
  persistTeacherWorkspace,
  submitStudentDraft,
} from './services/scheduleRepository';
import { generateProposals } from './services/scheduler';

type Route = 'student' | 'teacher';

const DEFAULT_CLASS_TYPES: ClassType[] = ['一对一', '一对二', '一对三', '小班', '已有固定班课', '两者均可', '尚未确定'];

function getRoute(): Route {
  if (typeof window === 'undefined') return 'student';
  const authRoute = new URLSearchParams(window.location.search).get('auth');
  return window.location.hash.includes('teacher') || authRoute === 'teacher' ? 'teacher' : 'student';
}

const normalizeTeacherState = (): AppState => emptyAppState();

const toStudentFromPayload = (payload: StudentSubmissionPayload, studentId = createUuid()): Student => ({
  id: studentId,
  chemStudentId: payload.chemStudentId,
  name: payload.name,
  grade: payload.grade,
  contact: payload.contact,
  teacherClassNote: payload.teacherClassNote,
  courseNeed: payload.courseNeed,
  school: payload.school,
  classType: payload.classType,
  targetStudentCount: payload.targetStudentCount || undefined,
  availability: payload.availability,
  originalCourses: payload.originalCourses,
  acceptedLocationIds: payload.acceptedLocationIds,
  notes: payload.notes,
  weeklySessionNeed: payload.weeklySessionNeed,
  lessonMinutes: payload.lessonMinutes,
  updatedAt: new Date().toISOString(),
});

const mergeAvailability = (base: Record<string, any>, next: Record<string, any>) => {
  const output = { ...base };
  Object.entries(next || {}).forEach(([slot, status]) => {
    if (status === 'free' && output[slot]) return;
    output[slot] = status as any;
  });
  return output;
};

const mergeSubmissionStudent = (target: Student, payload: StudentSubmissionPayload): Student => {
  const mergedCourses = [...target.originalCourses];
  payload.originalCourses.forEach((course) => {
    const exists = target.originalCourses.some(
      (existing) =>
        existing.day === course.day && existing.startMinute === course.startMinute && existing.endMinute === course.endMinute && existing.title === course.title
    );
    if (!exists) mergedCourses.push(course);
  });

  return {
    ...target,
    chemStudentId: target.chemStudentId || payload.chemStudentId,
    contact: target.contact || payload.contact,
    teacherClassNote: target.teacherClassNote || payload.teacherClassNote,
    school: target.school || payload.school,
    notes: [target.notes, payload.notes].filter(Boolean).join('；') || target.notes || payload.notes,
    availability: mergeAvailability(target.availability, payload.availability),
    originalCourses: mergedCourses,
    acceptedLocationIds: Array.from(new Set([...target.acceptedLocationIds, ...payload.acceptedLocationIds])),
    weeklySessionNeed: target.weeklySessionNeed || payload.weeklySessionNeed,
    lessonMinutes: target.lessonMinutes || payload.lessonMinutes,
    targetStudentCount: target.targetStudentCount || payload.targetStudentCount || undefined,
    updatedAt: new Date().toISOString(),
  };
};

const normalizeStudentName = (name: string) => name.trim().toLowerCase();

export default function App() {
  const [route, setRoute] = React.useState<Route>(getRoute());
  const [state, setState] = React.useState<AppState>(emptyAppState());
  const [feedback, setFeedback] = React.useState<string>('');
  const [loading, setLoading] = React.useState(false);
  const [classTypeOptions, setClassTypeOptions] = React.useState<ClassType[]>(DEFAULT_CLASS_TYPES);
  const [hasTeacherSession, setHasTeacherSession] = React.useState(false);
  const [teacherSessionEmail, setTeacherSessionEmail] = React.useState('');
  const [teacherAllowed, setTeacherAllowed] = React.useState(false);
  const [teacherEmail, setTeacherEmail] = React.useState('');
  const [submissionEditDraft, setSubmissionEditDraft] = React.useState<{ id: string; student: Student } | null>(null);

  React.useEffect(() => {
    const onHash = () => setRoute(getRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const refreshStudentMode = React.useCallback(async () => {
    setLoading(true);
    setFeedback('');
    setHasTeacherSession(false);
    setTeacherAllowed(false);
    setSubmissionEditDraft(null);
    try {
      const nextState = normalizeTeacherState();
      const formConfig = await loadStudentFormConfig();
      setClassTypeOptions(formConfig.classTypeOptions);
      const publicContext = await loadStudentPublicContext();
      if (publicContext.locations.length > 0) nextState.locations = publicContext.locations;
      if (publicContext.travelTimes.length > 0) nextState.travelTimes = publicContext.travelTimes;
      setState(nextState);
      setFeedback('学生入口已就绪');
    } catch (error: any) {
      setState(normalizeTeacherState());
      setFeedback(`学生端数据加载失败：${error?.message || '请稍后重试'}`);
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshTeacherMode = React.useCallback(async () => {
    setLoading(true);
    setFeedback('');
    setSubmissionEditDraft(null);
    setTeacherAllowed(false);
    const client = getAuthClient();

    if (!client) {
      setState(normalizeTeacherState());
      setHasTeacherSession(false);
      setFeedback('未配置 Supabase，教师端无法登录。');
      setLoading(false);
      return;
    }

    try {
      const { data: sessionData } = await client.auth.getSession();
      const session = sessionData?.session;
      if (!session || !session.user) {
        setHasTeacherSession(false);
        setTeacherSessionEmail('');
        setState(normalizeTeacherState());
        setFeedback('请先登录教师账号。');
        return;
      }
      setHasTeacherSession(true);
      setTeacherSessionEmail(session.user.email || '');
      const allow = await checkTeacherCanAccess(session.user.email);
      if (!allow) {
        setTeacherAllowed(false);
        setState(normalizeTeacherState());
        setFeedback(`该账号未通过教师 allowlist：${session.user.email || ''}`);
        return;
      }

      const accessCheck = await verifyTeacherWorkspaceAccess();
      if (!accessCheck.ok) {
        const failedTables = accessCheck.checks.filter((item) => !item.ok);
        const reason = failedTables.map((item) => `${item.table}: ${item.message || '无权限/未配置'}`).join('；');
        setTeacherAllowed(false);
        setState(normalizeTeacherState());
        setFeedback(`教师工作区表访问验证失败：${reason}`);
        return;
      }

      setTeacherAllowed(true);
      const next = await loadTeacherWorkspace();
      setState(next);
      setFeedback('教师工作台已同步。');
    } catch (error: any) {
      setState(normalizeTeacherState());
      setFeedback(`教师端加载失败：${error?.message || '请稍后重试'}`);
      setTeacherAllowed(false);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (route === 'teacher') {
      void refreshTeacherMode();
    } else {
      void refreshStudentMode();
    }
  }, [route, refreshTeacherMode, refreshStudentMode]);

  const persistTeacherState = async (next: AppState) => {
    if (!teacherAllowed) return next;
    const updated = await persistTeacherWorkspace(next);
    setState(updated);
    return updated;
  };

  const persistTeacherResult = async (next: AppState): Promise<AppState> => {
    try {
      return await persistTeacherState(next);
    } catch (error: any) {
      setFeedback(`保存失败：${error?.message || '请检查网络后重试'}`);
      throw error;
    }
  };

  const refreshTeacherState = async () => {
    const next = await loadTeacherWorkspace();
    setState(next);
    return next;
  };

  const sendLoginLink = async () => {
    if (!teacherEmail.trim()) {
      setFeedback('请输入教师邮箱。');
      return;
    }
    const client = getAuthClient();
    if (!client) {
      setFeedback('未配置 Supabase，暂不支持登录。');
      return;
    }
    setLoading(true);
    // Supabase appends its access token as a URL fragment. Keep the teacher
    // destination in the query string so it cannot collide with our hash route.
    const redirectTo = `${window.location.origin}${window.location.pathname}?auth=teacher`;
    const { error } = await client.auth.signInWithOtp({
      email: teacherEmail.trim(),
      options: { emailRedirectTo: redirectTo },
    });
    if (error) {
      setFeedback(`发送登录链接失败：${error.message}`);
    } else {
      setFeedback('登录邮件已发送，请到邮箱点击链接登录。');
    }
    setLoading(false);
  };

  const signOut = async () => {
    const client = getAuthClient();
    if (!client) return;
    setLoading(true);
    await client.auth.signOut();
    setHasTeacherSession(false);
    setTeacherAllowed(false);
    setTeacherSessionEmail('');
    await refreshTeacherMode();
    setLoading(false);
  };

  const submitStudent = async (payload: StudentSubmissionPayload, sessionToken: string) => {
    if (!payload.name || !payload.grade) {
      throw new Error('姓名和年级为必填项');
    }
    const result = await submitStudentDraft(payload, sessionToken);
    setFeedback('排课信息提交成功。');
    return result;
  };

  const markAndSync = async (submissionId: string, status: IntakeSubmissionStatus) => {
    await markSubmissionStatus(submissionId, status);
    await refreshTeacherState();
  };

  const acceptSubmission = async (submissionId: string, forceCreate = false) => {
    const target = state.pendingSubmissions.find((item) => item.id === submissionId);
    if (!target) {
      setFeedback('提交不存在或已处理。');
      return;
    }
    const identityMatch = target.payload.chemStudentId
      ? state.students.find((student) => student.chemStudentId === target.payload.chemStudentId)
      : undefined;
    if (!forceCreate && identityMatch) {
      const students = state.students.map((student) =>
        student.id === identityMatch.id ? mergeSubmissionStudent(student, target.payload) : student
      );
      await persistTeacherResult({ ...state, students });
      await markAndSync(submissionId, 'accepted');
      setFeedback(`已匹配复习系统学生并更新排课资料：「${target.payload.name}」。`);
      return;
    }
    const hasSameName = state.students.some((student) => normalizeStudentName(student.name) === normalizeStudentName(target.payload.name));
    if (!forceCreate && hasSameName) {
      setFeedback(`已检测到同名学生：「${target.payload.name}」可能已存在。请先合并或改用“新建(同名允许)”进行新建。`);
      return;
    }
    const nextState = {
      ...state,
      students: [...state.students, toStudentFromPayload(target.payload)],
    };
    await persistTeacherResult(nextState);
    await markAndSync(submissionId, 'accepted');
    clearSubmissionDraftById(submissionId);
    setFeedback(forceCreate ? `已按“新建”接收 ${target.studentName}` : `已接收 ${target.studentName}`);
  };

  const mergeSubmission = async (submissionId: string, targetStudentId: string) => {
    const target = state.pendingSubmissions.find((item) => item.id === submissionId);
    if (!target) {
      setFeedback('提交不存在或已处理。');
      return;
    }
    const students = [...state.students];
    const index = students.findIndex((item) => item.id === targetStudentId);
    if (index < 0) {
      setFeedback('未选择有效的目标学生。');
      return;
    }
    students[index] = mergeSubmissionStudent(students[index], target.payload);
    const nextState = { ...state, students };
    await persistTeacherResult(nextState);
    await markAndSync(submissionId, 'merged');
    clearSubmissionDraftById(submissionId);
    setFeedback(`已将 ${target.studentName} 合并入 ${students[index].name}`);
  };

  const applyProposal = async (proposal: ScheduleProposal) => {
    if (!proposal.assignment.allStudents.length) {
      setFeedback('该排课方案没有可用学生。');
      return;
    }

    const students = state.students.filter((item) => proposal.assignment.allStudents.includes(item.id));
    if (students.length === 0) {
      setFeedback('该方案的学生已不存在，无法直接应用。');
      return;
    }

    const classType = (() => {
      if (students.every((item) => item.classType === '一对一')) return '一对一';
      if (students.length === 2) return '一对二';
      if (students.length === 3) return '一对三';
      if (students.length >= 4) return '小班';
      return students[0].classType || '一对一';
    })();

    const locationId = proposal.assignment.locationId || state.locations[0]?.id || '';
    const classId = createUuid();
    const now = new Date().toISOString();
    const classItem: ClassProfile = {
      id: classId,
      title: proposal.title,
      classType,
      minStudentCount: students.length,
      maxStudentCount: students.length,
      weeklySessionNeed: students[0]?.weeklySessionNeed,
      durationMinutes: proposal.assignment.endMinute - proposal.assignment.startMinute,
      preferredLocationId: locationId || undefined,
      status: 'active',
      source: 'proposal',
      studentIds: students.map((item) => item.id),
      createdAt: now,
      updatedAt: now,
    };

    const runId =
      proposal.runId ||
      (await persistScheduleRun({
        algorithmVersion: 'rule-based-v3',
        totalScore: proposal.score,
        status: 'generated',
        payload: JSON.stringify({
          proposalId: proposal.id,
          proposal,
          studentIds: proposal.assignment.allStudents,
          generatedAt: now,
        }),
      }));

    const assignments = proposal.assignments?.length ? proposal.assignments : [proposal.assignment];
    const nextCourses = assignments.map((assignment) => ({
      id: createUuid(),
      classId,
      studentIds: students.map((item) => item.id),
      title: proposal.title,
      day: assignment.day,
      startMinute: assignment.startMinute,
      endMinute: assignment.endMinute,
      locationId: assignment.locationId || locationId,
      classType,
      isFixed: false,
      adjustDifficulty: 3 as 1 | 2 | 3 | 4 | 5,
      notes: proposal.explanation,
      source: 'proposal' as const,
      runId,
      status: 'confirmed' as const,
      scoreBreakdown: {
        totalScore: proposal.score,
        strategy: proposal.strategy,
        assignmentScore: assignment.score,
        adjustableStudents: assignment.adjustableStudents,
        hardAdjustStudents: assignment.hardAdjustStudents,
      },
    }));

    const saved = await persistTeacherResult({
      ...state,
      classes: [...state.classes.filter((item) => item.id !== classId), classItem],
      teacherCourses: [...state.teacherCourses, ...nextCourses],
    });
    await persistScheduleRun({
      runId,
      algorithmVersion: 'rule-based-v3',
      totalScore: proposal.score,
      status: 'accepted',
      payload: JSON.stringify({
        proposalId: proposal.id,
        proposal,
        generatedAt: now,
      }),
    });
    setState({
      ...saved,
      scheduleRuns: saved.scheduleRuns.some((item) => item.id === runId)
        ? saved.scheduleRuns
        : [
            ...saved.scheduleRuns,
            {
              id: runId,
              algorithmVersion: 'rule-based-v3',
              totalScore: proposal.score,
              status: 'accepted',
              createdAt: now,
            },
          ],
    });
    setFeedback('方案已应用：班级、课程和排课运行记录均已写入云端。');
  };

  const generateAndPersistProposals = async (studentIds: string[]) => {
    const candidates = generateProposals(state, studentIds);
    if (!candidates.length) {
      setFeedback('当前选择没有满足硬约束的排课方案。');
      return [];
    }
    const now = new Date().toISOString();
    const runId = await persistScheduleRun({
      algorithmVersion: 'rule-based-v3',
      totalScore: Math.max(...candidates.map((proposal) => proposal.score)),
      status: 'generated',
      payload: JSON.stringify({
        proposal: { candidates, studentIds },
        studentIds,
        generatedAt: now,
      }),
    });
    const withRun = candidates.map((proposal) => ({ ...proposal, runId }));
    setState((current) => ({
      ...current,
      scheduleRuns: [
        {
          id: runId,
          algorithmVersion: 'rule-based-v3',
          totalScore: Math.max(...candidates.map((proposal) => proposal.score)),
          status: 'generated',
          createdAt: now,
        },
        ...current.scheduleRuns.filter((item) => item.id !== runId),
      ],
    }));
    setFeedback(`已生成 ${candidates.length} 套方案，并记录本次排课运行。`);
    return withRun;
  };

  const saveTeacherTime = async (availability: AppState['teacherAvailability']) => {
    try {
      await persistTeacherAvailability(availability);
      setState((current) => ({ ...current, teacherAvailability: availability }));
      setFeedback('教师时间已保存。');
    } catch (error: any) {
      setFeedback(`教师时间保存失败：${error?.message || '请检查网络后重试'}`);
      throw error;
    }
  };

  const ignoreSubmission = async (submissionId: string) => {
    await markAndSync(submissionId, 'ignored');
    clearSubmissionDraftById(submissionId);
    setFeedback('已忽略该提交。');
  };

  const clearSubmissionDraftById = (submissionId: string) => {
    if (submissionEditDraft?.id === submissionId) {
      setSubmissionEditDraft(null);
    }
  };

  const startSubmissionEdit = (submissionId: string) => {
    const target = state.pendingSubmissions.find((item) => item.id === submissionId);
    if (!target) {
      setFeedback('提交不存在或已处理。');
      return;
    }
    setSubmissionEditDraft({
      id: target.id,
      student: toStudentFromPayload(target.payload, createUuid()),
    });
    setFeedback(`已载入 ${target.studentName} 的提交草稿，请编辑后保存。`);
  };

  const saveEditedSubmission = async (submissionId: string, student: Student) => {
    const target = state.pendingSubmissions.find((item) => item.id === submissionId);
    if (!target) {
      setFeedback('提交不存在或已处理。');
      return;
    }
    const students = [...state.students];
    const existingIndex = students.findIndex((item) => item.id === student.id);
    if (existingIndex >= 0) {
      students[existingIndex] = { ...student, updatedAt: new Date().toISOString() };
    } else {
      students.push({ ...student, updatedAt: new Date().toISOString() });
    }
    await persistTeacherResult({ ...state, students });
    await markAndSync(submissionId, 'edited_and_accepted');
    setSubmissionEditDraft(null);
    setFeedback('已编辑后接收提交。');
  };

  const cancelSubmissionEdit = () => {
    setSubmissionEditDraft(null);
    setFeedback('已取消“编辑后接受”。');
  };

  return (
    <div>
      <div className="top-nav">
        <a href="#/student" className={route === 'student' ? 'active' : ''}>
          学生入口
        </a>
        <a href="#/teacher" className={route === 'teacher' ? 'active' : ''}>
          教师端
        </a>
      </div>
      {loading && <p className="tiny">加载中...</p>}
      {feedback && <p className="tiny">{feedback}</p>}

      {route === 'student' ? (
        <StudentPortal state={state} onAuthenticate={authenticateStudentSchedule} onSubmit={submitStudent} />
      ) : teacherAllowed ? (
        <TeacherPortal
          state={state}
          onUpdate={persistTeacherResult}
          onApplyProposal={applyProposal}
          onGenerateProposals={generateAndPersistProposals}
          onSaveTeacherAvailability={saveTeacherTime}
          onAcceptSubmission={acceptSubmission}
          onMergeSubmission={mergeSubmission}
          onIgnoreSubmission={ignoreSubmission}
          onStartSubmissionEdit={startSubmissionEdit}
          onSaveSubmissionEdit={saveEditedSubmission}
          onCancelSubmissionEdit={cancelSubmissionEdit}
          submissionDraft={submissionEditDraft?.student ?? null}
          submissionDraftId={submissionEditDraft?.id ?? null}
        />
      ) : (
        <section className="card">
          <h2>{hasTeacherSession ? '教师账号未授权' : '教师端登录'}</h2>
          {hasTeacherSession ? (
            <>
              <p className="tiny">当前登录：{teacherSessionEmail || '未识别到邮箱'}</p>
              <p className="tiny">当前账号不在教师 allowlist，请联系管理员。</p>
              <div className="actions">
                <button onClick={signOut}>退出</button>
              </div>
            </>
          ) : (
            <>
              <p className="tiny">请使用教师邮箱登录，系统会发送无密码登录链接。</p>
              <label>
                教师邮箱
                <input value={teacherEmail} onChange={(e) => setTeacherEmail(e.target.value)} placeholder="name@domain.com" />
              </label>
              <div className="actions">
                <button onClick={sendLoginLink} disabled={loading}>
                  {loading ? '发送中...' : '发送登录链接'}
                </button>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
