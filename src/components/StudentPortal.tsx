import React from 'react';
import { AppState, AvailabilityStatus, ClassType, StudentOriginalCourse, StudentSubmissionPayload, WeekDay } from '../types';
import { TimeGridEditor } from './TimeGridEditor';
import { FormatWeek } from './format';
import { slotStarts, toSlotKey } from '../utils/time';

const DEFAULT_CLASS_TYPES: ClassType[] = ['一对一', '一对二', '一对三', '小班', '已有固定班课', '两者均可', '尚未确定'];
const DRAFT_KEY = 'ganschedule_student_draft_v2';

const makeDefaultAvailability = (): Record<string, AvailabilityStatus> => {
  const map: Record<string, AvailabilityStatus> = {};
  for (let day = 1; day <= 7; day++) {
    slotStarts.forEach((start) => {
      map[toSlotKey(day as WeekDay, start)] = 'free';
    });
  }
  return map;
};

const toMinute = (value: string) => {
  const [h, m] = value.split(':').map((item) => Number(item));
  if (Number.isNaN(h) || Number.isNaN(m)) return 0;
  return h * 60 + m;
};

const newCourse = (state: AppState) => ({
  day: 1 as WeekDay,
  start: '13:00',
  end: '14:00',
  title: '原有课程',
  locationId: state.locations[0]?.id || '',
  isFixed: false,
  adjustDifficulty: 3 as 1 | 2 | 3 | 4 | 5,
  notes: '',
});

interface FormDraft {
  step: number;
  name: string;
  grade: string;
  contact: string;
  teacherClassNote: string;
  school: string;
  classType: ClassType;
  availability: Record<string, AvailabilityStatus>;
  courses: Array<{
    day: WeekDay;
    start: string;
    end: string;
    title: string;
    locationId: string;
    isFixed: boolean;
    adjustDifficulty: 1 | 2 | 3 | 4 | 5;
    notes: string;
  }>;
  acceptedLocationIds: string[];
  targetStudentCount: string;
  notes: string;
  weeklySessionNeed: string;
  lessonMinutes: string;
}

const createEmptyDraft = (state: AppState): FormDraft => ({
  step: 0,
  name: '',
  grade: '',
  contact: '',
  teacherClassNote: '',
  school: '',
  classType: '一对一',
  availability: makeDefaultAvailability(),
  courses: [newCourse(state)],
  acceptedLocationIds: [],
  targetStudentCount: '',
  notes: '',
  weeklySessionNeed: '',
  lessonMinutes: '',
});

const mapCourseForPayload = (course: FormDraft['courses'][number]): StudentOriginalCourse => ({
  id: `stu-course-${Date.now()}-${course.day}-${course.start}-${course.end}-${course.title}`,
  title: course.title || '原有课程',
  day: course.day,
  startMinute: toMinute(course.start),
  endMinute: toMinute(course.end),
  locationId: course.locationId,
  isFixed: course.isFixed,
  adjustDifficulty: course.adjustDifficulty,
  notes: course.notes,
});

export function StudentPortal({
  state,
  onSubmit,
  classTypeOptions,
}: {
  state: AppState;
  onSubmit: (payload: StudentSubmissionPayload) => Promise<{ id: string }>;
  classTypeOptions?: ClassType[];
}) {
  const [draft, setDraft] = React.useState<FormDraft>(createEmptyDraft(state));
  const [submitting, setSubmitting] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const [messageType, setMessageType] = React.useState<'success' | 'error' | ''>('');

  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<FormDraft>;
      const availability = parsed.availability || draft.availability;
      setDraft((prev) => ({ ...prev, ...parsed, step: parsed.step ?? 0, availability }));
    } catch {
      // ignore local draft parse error
    }
  }, []);

  React.useEffect(() => {
    const resolvedCourses = draft.courses.map((course) => ({
      ...course,
      locationId: course.locationId || state.locations[0]?.id || '',
    }));
    const normalizedAccepted = draft.acceptedLocationIds.filter((id) => state.locations.some((loc) => loc.id === id));
    setDraft((prev) => ({ ...prev, courses: resolvedCourses, acceptedLocationIds: normalizedAccepted }));
  }, [state.locations.length]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  }, [draft]);

  const progress = ((draft.step + 1) / 6) * 100;
  const classTypes = classTypeOptions && classTypeOptions.length > 0 ? classTypeOptions : DEFAULT_CLASS_TYPES;

  const reset = (clearMessage = true) => {
    setDraft(createEmptyDraft(state));
    if (clearMessage) {
      setMessage('');
      setMessageType('');
    }
    window.localStorage.removeItem(DRAFT_KEY);
  };

  const addCourse = () => setDraft((prev) => ({ ...prev, courses: [...prev.courses, newCourse(state)] }));
  const removeCourse = (index: number) => setDraft((prev) => ({ ...prev, courses: prev.courses.filter((_, i) => i !== index) }));

  const updateCourse = (
    index: number,
    patch: Partial<{
      day: WeekDay;
      start: string;
      end: string;
      title: string;
      locationId: string;
      isFixed: boolean;
      adjustDifficulty: 1 | 2 | 3 | 4 | 5;
      notes: string;
    }>
  ) => {
    setDraft((prev) => ({
      ...prev,
      courses: prev.courses.map((course, idx) => (idx === index ? { ...course, ...patch } : course)),
    }));
  };

  const toPayload = (): StudentSubmissionPayload => {
    const originalCourses = draft.courses
      .filter((course) => course.title.trim().length > 0 && course.start !== course.end)
      .map((course) => mapCourseForPayload(course));

    return {
      name: draft.name.trim(),
      grade: draft.grade.trim(),
      contact: draft.contact.trim() || undefined,
      teacherClassNote: draft.teacherClassNote.trim() || undefined,
      courseNeed: draft.teacherClassNote.trim() || undefined,
      school: draft.school.trim() || undefined,
      classType: draft.classType,
      availability: draft.availability,
      originalCourses,
      acceptedLocationIds: draft.acceptedLocationIds,
      targetStudentCount: Number(draft.targetStudentCount) || undefined,
      notes: draft.notes.trim() || undefined,
      weeklySessionNeed: Number(draft.weeklySessionNeed) || undefined,
      lessonMinutes: Number(draft.lessonMinutes) || undefined,
    };
  };

  const submit = async () => {
    if (!draft.name.trim() || !draft.grade.trim()) {
      setMessageType('error');
      setMessage('请先填写姓名和年级。');
      return;
    }
    if (draft.courses.some((course) => toMinute(course.end) <= toMinute(course.start))) {
      setMessageType('error');
      setMessage('已有安排的结束时间必须晚于开始时间。');
      return;
    }
    setSubmitting(true);
    setMessageType('');
    try {
      const payload = toPayload();
      const result = await onSubmit(payload);
      setMessageType('success');
      setMessage(`提交成功，编号：${result.id}`);
      reset(false);
    } catch (error: any) {
      setMessageType('error');
      setMessage(error?.message || '提交失败，请重试。');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="app-shell">
      <header className="hero">
        <p>学生端 · 填写链接</p>
        <h1>甘老师智能排课 · 学生信息提交</h1>
      </header>

      <div className="progress">
        <div className="bar" style={{ width: `${progress}%` }} />
      </div>

      {message && (
        <p className="tiny" style={{ color: messageType === 'error' ? '#d12f2f' : '#2ca46f' }}>
          {message}
        </p>
      )}

      {draft.step === 0 && (
        <section className="card">
          <h2>1. 基本信息</h2>
          <label>
            学生姓名 *
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="例如：张同学" />
          </label>
          <label>
            年级 *
            <input value={draft.grade} onChange={(e) => setDraft({ ...draft, grade: e.target.value })} placeholder="例如：高三" />
          </label>
          <label>
            联系方式（选填）
            <input
              value={draft.contact}
              onChange={(e) => setDraft({ ...draft, contact: e.target.value })}
              placeholder="微信 / 电话"
            />
          </label>
          <label>
            学校（选填）
            <input value={draft.school} onChange={(e) => setDraft({ ...draft, school: e.target.value })} placeholder="例如：北京第一中学" />
          </label>
          <label>
            课程需求（选填）
            <input
              value={draft.teacherClassNote}
              onChange={(e) => setDraft({ ...draft, teacherClassNote: e.target.value })}
              placeholder="例如：已在 X 班学习英语"
            />
          </label>
          <div className="actions">
            <button
              disabled={!draft.name.trim() || !draft.grade.trim() || submitting}
              onClick={() => setDraft({ ...draft, step: 1 })}
            >
              下一步
            </button>
          </div>
        </section>
      )}

      {draft.step === 1 && (
        <section className="card">
          <h2>2. 上课类型</h2>
          <label>
            课程类型
            <select value={draft.classType} onChange={(e) => setDraft({ ...draft, classType: e.target.value as ClassType })}>
              {classTypes.map((type) => (
                <option key={type}>{type}</option>
              ))}
            </select>
          </label>
          <label>
            目标班级人数（选填）
            <input
              value={draft.targetStudentCount}
              inputMode="numeric"
              onChange={(e) => setDraft({ ...draft, targetStudentCount: e.target.value.replace(/[^0-9]/g, '') })}
              placeholder="如：2"
            />
          </label>
          <div className="actions">
            <button onClick={() => setDraft({ ...draft, step: 0 })}>上一步</button>
            <button onClick={() => setDraft({ ...draft, step: 2 })}>下一步</button>
          </div>
        </section>
      )}

      {draft.step === 2 && (
        <section className="card">
          <h2>3. 每周可上课情况</h2>
          <TimeGridEditor
            title="点击设置每周时间状态（每30分钟）"
            value={draft.availability}
            palette={[
              { value: 'free', text: '可上课', color: 'status-free' },
              { value: 'adjust', text: '可调整', color: 'status-adjust' },
              { value: 'hardAdjust', text: '不太方便调整', color: 'status-hard' },
              { value: 'blocked', text: '不能上课', color: 'status-blocked' },
            ]}
            onChange={(next) => setDraft({ ...draft, availability: next })}
          />
          <div className="actions">
            <button onClick={() => setDraft({ ...draft, step: 1 })}>上一步</button>
            <button onClick={() => setDraft({ ...draft, step: 3 })}>下一步</button>
          </div>
        </section>
      )}

      {draft.step === 3 && (
        <section className="card">
          <h2>4. 原有课程（可添加多条）</h2>
          {draft.courses.map((course, index) => (
            <div key={`${index}-${course.title}`} className="course-card">
              <label>
                课程名称
                <input
                  value={course.title}
                  onChange={(e) => updateCourse(index, { title: e.target.value })}
                  placeholder="课程名"
                />
              </label>
              <div className="row">
                <label>
                  星期
                  <select value={course.day} onChange={(e) => updateCourse(index, { day: Number(e.target.value) as WeekDay })}>
                    {[1, 2, 3, 4, 5, 6, 7].map((day) => (
                      <option key={day} value={day}>
                        <FormatWeek day={day as WeekDay} />
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  开始
                  <input type="time" value={course.start} onChange={(e) => updateCourse(index, { start: e.target.value })} />
                </label>
                <label>
                  结束
                  <input type="time" value={course.end} onChange={(e) => updateCourse(index, { end: e.target.value })} />
                </label>
              </div>
              <div className="row">
                <label>
                  地点
                  <select value={course.locationId} onChange={(e) => updateCourse(index, { locationId: e.target.value })}>
                    {state.locations.map((loc) => (
                      <option key={loc.id} value={loc.id}>
                        {loc.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  是否固定
                  <select value={course.isFixed ? '1' : '0'} onChange={(e) => updateCourse(index, { isFixed: e.target.value === '1' })}>
                    <option value="1">是</option>
                    <option value="0">否</option>
                  </select>
                </label>
                <label>
                  调整难度
                  <select
                    value={course.adjustDifficulty}
                    onChange={(e) => updateCourse(index, { adjustDifficulty: Number(e.target.value) as 1 | 2 | 3 | 4 | 5 })}
                  >
                    {[1, 2, 3, 4, 5].map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                备注
                <input value={course.notes} onChange={(e) => updateCourse(index, { notes: e.target.value })} />
              </label>
              {draft.courses.length > 1 && (
                <button type="button" className="danger" onClick={() => removeCourse(index)}>
                  删除课程
                </button>
              )}
            </div>
          ))}
          <button type="button" onClick={addCourse}>
            + 添加课程
          </button>
          <div className="actions">
            <button onClick={() => setDraft({ ...draft, step: 2 })}>上一步</button>
            <button onClick={() => setDraft({ ...draft, step: 4 })}>下一步</button>
          </div>
        </section>
      )}

      {draft.step === 4 && (
        <section className="card">
          <h2>5. 可接受上课地点</h2>
          <div className="location-list">
            {state.locations.map((location) => (
              <label key={location.id} className="check-item">
                <input
                  type="checkbox"
                  checked={draft.acceptedLocationIds.includes(location.id)}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setDraft((prev) => ({ ...prev, acceptedLocationIds: [...prev.acceptedLocationIds, location.id] }));
                    } else {
                      setDraft((prev) => ({
                        ...prev,
                        acceptedLocationIds: prev.acceptedLocationIds.filter((id) => id !== location.id),
                      }));
                    }
                  }}
                />
                {location.name}
              </label>
            ))}
          </div>
          <label>
            每周希望节数
            <input
              value={draft.weeklySessionNeed}
              onChange={(e) => setDraft((prev) => ({ ...prev, weeklySessionNeed: e.target.value }))}
              placeholder="如：2"
            />
          </label>
          <label>
            单节时长（分钟）
            <select
              value={draft.lessonMinutes}
              onChange={(e) => setDraft((prev) => ({ ...prev, lessonMinutes: e.target.value }))}
            >
              <option value="">请选择</option>
              <option value="60">60</option>
              <option value="90">90</option>
              <option value="120">120</option>
            </select>
          </label>
          <label>
            备注
            <textarea value={draft.notes} rows={3} onChange={(e) => setDraft((prev) => ({ ...prev, notes: e.target.value }))} />
          </label>
          <div className="actions">
            <button onClick={() => setDraft({ ...draft, step: 3 })}>上一步</button>
            <button onClick={() => setDraft({ ...draft, step: 5 })}>下一步</button>
          </div>
        </section>
      )}

      {draft.step === 5 && (
        <section className="card">
          <h2>6. 提交确认</h2>
          <p>请确认后提交审核。</p>
          <div className="summary">
            <p>
              <strong>姓名：</strong>
              {draft.name || '未填写'}
            </p>
            <p>
              <strong>年级：</strong>
              {draft.grade || '未填写'}
            </p>
            <p>
              <strong>上课类型：</strong>
              {draft.classType}
            </p>
            <p>
              <strong>已设置课程：</strong>
              {draft.courses.filter((course) => course.title.trim().length > 0 && course.start !== course.end).length} 条
            </p>
            <p>
              <strong>目标班级人数：</strong>
              {draft.targetStudentCount || '未填写'}
            </p>
            <p>
              <strong>可接受地点：</strong>
              {draft.acceptedLocationIds.length
                ? draft.acceptedLocationIds.map((id) => state.locations.find((loc) => loc.id === id)?.name || id).join('、')
                : '不限'}
            </p>
          </div>
          <div className="actions">
            <button onClick={() => setDraft({ ...draft, step: 4 })}>上一步</button>
            <button disabled={submitting} onClick={submit}>
              {submitting ? '提交中...' : '提交并进入审核'}
            </button>
          </div>
        </section>
      )}
    </main>
  );
}
