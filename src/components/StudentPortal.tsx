import React from 'react';
import {
  AppState,
  AvailabilityStatus,
  StudentLoginResult,
  StudentOriginalCourse,
  StudentSubmissionPayload,
  TravelTime,
  WeekDay,
} from '../types';
import { createUuid } from '../utils/id';
import { slotStarts, toSlotKey } from '../utils/time';

const SESSION_KEY = 'ganschedule_student_session_v3';
const WEEKEND_DAYS: WeekDay[] = [6, 7];

type CourseDraft = {
  id: string;
  day: WeekDay;
  start: string;
  end: string;
  title: string;
  locationId: string;
};

type CommuteCheck = {
  id: string;
  severity: 'ok' | 'warning' | 'error';
  text: string;
};

const toMinute = (value: string) => {
  const [hour, minute] = value.split(':').map(Number);
  return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : 0;
};

const toClock = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

const makeDefaultAvailability = (): Record<string, AvailabilityStatus> => {
  const result: Record<string, AvailabilityStatus> = {};
  for (let day = 1; day <= 7; day++) {
    slotStarts.forEach((start) => {
      result[toSlotKey(day as WeekDay, start)] = 'free';
    });
  }
  return result;
};

const courseToDraft = (course: StudentOriginalCourse): CourseDraft => ({
  id: course.id || createUuid(),
  day: WEEKEND_DAYS.includes(course.day) ? course.day : 6,
  start: toClock(course.startMinute),
  end: toClock(course.endMinute),
  title: course.title === '已有安排' || course.title === '原有课程' ? '' : course.title,
  locationId: course.locationId,
});

const draftToCourse = (course: CourseDraft): StudentOriginalCourse => ({
  id: course.id,
  day: course.day,
  startMinute: toMinute(course.start),
  endMinute: toMinute(course.end),
  title: course.title.trim() || '已有课程',
  locationId: course.locationId,
  isFixed: true,
  adjustDifficulty: 1,
});

const travelFor = (travelTimes: TravelTime[], from: string, to: string) =>
  travelTimes.find((item) => item.fromLocationId === from && item.toLocationId === to);

export function StudentPortal({
  state,
  onAuthenticate,
  onSubmit,
}: {
  state: AppState;
  onAuthenticate: (name: string, code: string) => Promise<StudentLoginResult>;
  onSubmit: (payload: StudentSubmissionPayload, sessionToken: string) => Promise<{ id: string }>;
}) {
  const [name, setName] = React.useState('');
  const [code, setCode] = React.useState('');
  const [identity, setIdentity] = React.useState<StudentLoginResult | null>(null);
  const [courses, setCourses] = React.useState<CourseDraft[]>([]);
  const [notes, setNotes] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const [messageType, setMessageType] = React.useState<'success' | 'error' | ''>('');

  React.useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(SESSION_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as StudentLoginResult;
      if (!saved.session?.token || new Date(saved.session.expiresAt).getTime() <= Date.now()) {
        window.sessionStorage.removeItem(SESSION_KEY);
        return;
      }
      setIdentity(saved);
      setCourses(saved.profile.existingCourses.filter((course) => WEEKEND_DAYS.includes(course.day)).map(courseToDraft));
    } catch {
      window.sessionStorage.removeItem(SESSION_KEY);
    }
  }, []);

  const locations = identity?.locations.length ? identity.locations : state.locations;
  const travelTimes = identity?.travelTimes || [];

  const authenticate = async () => {
    if (!name.trim() || !/^\d{6,12}$/.test(code)) {
      setMessageType('error');
      setMessage('请输入学生姓名和复习系统的 6 至 12 位数字登录码。');
      return;
    }
    setLoading(true);
    setMessage('');
    try {
      const result = await onAuthenticate(name, code);
      setIdentity(result);
      setCourses(result.profile.existingCourses.filter((course) => WEEKEND_DAYS.includes(course.day)).map(courseToDraft));
      setCode('');
      window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(result));
      setMessageType('success');
      setMessage('身份匹配成功，年级、学校、班级和上课地点已自动读取。');
    } catch (error: any) {
      setMessageType('error');
      setMessage(error?.message || '姓名或登录码不正确。');
    } finally {
      setLoading(false);
    }
  };

  const switchStudent = () => {
    window.sessionStorage.removeItem(SESSION_KEY);
    setIdentity(null);
    setCourses([]);
    setNotes('');
    setMessage('');
    setMessageType('');
    setName('');
    setCode('');
  };

  const addCourse = () => {
    setCourses((current) => [
      ...current,
      {
        id: createUuid(),
        day: 6,
        start: '09:00',
        end: '10:00',
        title: '',
        locationId: locations[0]?.id || '',
      },
    ]);
  };

  const updateCourse = (id: string, next: Partial<CourseDraft>) => {
    setCourses((current) => current.map((course) => (course.id === id ? { ...course, ...next } : course)));
  };

  const validCourses = courses
    .filter((course) => course.locationId && toMinute(course.end) > toMinute(course.start))
    .map(draftToCourse)
    .sort((a, b) => a.day - b.day || a.startMinute - b.startMinute);

  const commuteChecks = React.useMemo<CommuteCheck[]>(() => {
    const checks: CommuteCheck[] = [];
    for (const day of WEEKEND_DAYS) {
      const daily = validCourses.filter((course) => course.day === day);
      for (let index = 1; index < daily.length; index++) {
        const previous = daily[index - 1];
        const next = daily[index];
        const previousLocation = locations.find((item) => item.id === previous.locationId)?.name || '上一地点';
        const nextLocation = locations.find((item) => item.id === next.locationId)?.name || '下一地点';
        const gap = next.startMinute - previous.endMinute;
        if (gap < 0) {
          checks.push({
            id: `${day}-${previous.id}-${next.id}`,
            severity: 'error',
            text: `${day === 6 ? '周六' : '周日'} ${previous.title} 与 ${next.title} 重叠 ${Math.abs(gap)} 分钟。`,
          });
          continue;
        }
        if (previous.locationId === next.locationId) {
          checks.push({
            id: `${day}-${previous.id}-${next.id}`,
            severity: 'ok',
            text: `${previousLocation}连续上课，间隔 ${gap} 分钟，不需要通勤。`,
          });
          continue;
        }
        const travel = travelFor(travelTimes, previous.locationId, next.locationId);
        if (!travel) {
          checks.push({
            id: `${day}-${previous.id}-${next.id}`,
            severity: 'warning',
            text: `${previousLocation} → ${nextLocation} 尚未配置通勤时间，教师端会收到补充提醒。`,
          });
          continue;
        }
        const required = travel.minutes + (travel.bufferMinutes || 0);
        const bufferText = travel.bufferMinutes ? ' + ' + travel.bufferMinutes + ' 分钟缓冲' : '';
        checks.push({
          id: `${day}-${previous.id}-${next.id}`,
          severity: gap < required ? 'error' : 'ok',
          text:
            `${previousLocation} → ${nextLocation} 需要 ${travel.minutes} 分钟${bufferText}；实际间隔 ${gap} 分钟，` +
            (gap < required ? `不足 ${required - gap} 分钟。` : `富余 ${gap - required} 分钟。`),
        });
      }
    }
    return checks;
  }, [validCourses, locations, travelTimes]);

  const submit = async () => {
    if (!identity) return;
    if (courses.some((course) => !course.locationId || toMinute(course.end) <= toMinute(course.start))) {
      setMessageType('error');
      setMessage('请为每条已有课程选择地点，并确保结束时间晚于开始时间。');
      return;
    }
    const availability = makeDefaultAvailability();
    validCourses.forEach((course) => {
      slotStarts.forEach((start) => {
        if (start < course.endMinute && start + 30 > course.startMinute) {
          availability[toSlotKey(course.day, start)] = 'blocked';
        }
      });
    });
    const generatedWarnings = commuteChecks
      .filter((item) => item.severity !== 'ok')
      .map((item) => item.text)
      .join('；');
    const payload: StudentSubmissionPayload = {
      chemStudentId: identity.profile.chemStudentId,
      name: identity.profile.displayName,
      grade: identity.profile.gradeBand,
      school: identity.profile.school || identity.profile.schoolClass,
      classType: identity.profile.classType,
      availability,
      originalCourses: validCourses,
      acceptedLocationIds: identity.profile.acceptedLocationIds.length
        ? identity.profile.acceptedLocationIds
        : locations.map((location) => location.id),
      weeklySessionNeed: identity.profile.weeklySessionNeed,
      lessonMinutes: identity.profile.lessonMinutes,
      notes: [notes.trim(), generatedWarnings].filter(Boolean).join('；') || undefined,
    };
    setLoading(true);
    setMessage('');
    try {
      const result = await onSubmit(payload, identity.session.token);
      setMessageType('success');
      setMessage(`周末安排已提交，编号：${result.id}。甘老师会在教师端直接看到更新。`);
    } catch (error: any) {
      setMessageType('error');
      setMessage(error?.message || '提交失败，请稍后重试。');
      if (/登录已失效/.test(error?.message || '')) switchStudent();
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="app-shell student-access-shell">
      <header className="hero student-hero">
        <div>
          <p>统一学生账号 · 周末排课</p>
          <h1>确认周六、周日已有课程</h1>
          <span>年级、学校、班级和甘老师上课地点由系统自动匹配，学生不需要重复填写。</span>
        </div>
        <div className="weekend-mark" aria-hidden="true"><strong>六</strong><strong>日</strong></div>
      </header>

      {message && <p className={`form-message ${messageType}`}>{message}</p>}

      {!identity ? (
        <section className="card student-login-card">
          <div className="section-kicker">和复习系统使用同一个登录码</div>
          <h2>学生登录</h2>
          <p className="tiny">这里只验证身份，不需要重新填写年级、学校或班级。</p>
          <label>
            学生姓名
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="请输入复习系统中的姓名" autoComplete="name" />
          </label>
          <label>
            复习系统登录码
            <input
              type="password"
              inputMode="numeric"
              value={code}
              maxLength={12}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 12))}
              placeholder="6 至 12 位数字"
              autoComplete="one-time-code"
            />
          </label>
          <button disabled={loading || !name.trim() || code.length < 6} onClick={authenticate}>
            {loading ? '正在匹配学生资料...' : '登录并读取我的资料'}
          </button>
          <p className="privacy-note">登录码只发送给统一身份服务验证，不会写入排课表或保存在浏览器草稿中。</p>
        </section>
      ) : (
        <>
          <section className="card matched-profile">
            <div><div className="section-kicker">已匹配复习系统学生</div><h2>{identity.profile.displayName}</h2></div>
            <button className="secondary-button" onClick={switchStudent}>切换学生</button>
            <div className="profile-facts">
              <div><span>年级</span><strong>{identity.profile.gradeBand || '资料库暂未登记'}</strong></div>
              <div><span>学校 / 班级</span><strong>{identity.profile.schoolClass || identity.profile.school || '资料库暂未登记'}</strong></div>
              <div><span>当前班级</span><strong>{identity.profile.classNames.length ? identity.profile.classNames.join('、') : '尚未正式组班'}</strong></div>
              <div>
                <span>甘老师上课地点</span>
                <strong>
                  {identity.profile.acceptedLocationIds.length
                    ? identity.profile.acceptedLocationIds.map((id) => locations.find((item) => item.id === id)?.name).filter(Boolean).join('、')
                    : locations.map((item) => item.name).join('、')}
                </strong>
              </div>
            </div>
          </section>

          <section className="card">
            <div className="section-heading">
              <div><div className="section-kicker">只填已经被占用的时间</div><h2>周六、周日已有课程</h2></div>
              <button className="compact-button" onClick={addCourse}>+ 添加一段已有课程</button>
            </div>
            {!courses.length && (
              <div className="empty-weekend">
                <strong>目前没有登记其他课程</strong>
                <p>如果周末完全没有其他课，可以直接提交；有课时再点击上方按钮添加。</p>
              </div>
            )}
            {courses.map((course, index) => (
              <article className="weekend-course-card" key={course.id}>
                <div className="course-number">{index + 1}</div>
                <div className="row">
                  <label>
                    星期
                    <select value={course.day} onChange={(event) => updateCourse(course.id, { day: Number(event.target.value) as WeekDay })}>
                      <option value={6}>周六</option>
                      <option value={7}>周日</option>
                    </select>
                  </label>
                  <label>开始时间<input type="time" value={course.start} onChange={(event) => updateCourse(course.id, { start: event.target.value })} /></label>
                  <label>结束时间<input type="time" value={course.end} onChange={(event) => updateCourse(course.id, { end: event.target.value })} /></label>
                </div>
                <div className="row">
                  <label>课程 / 安排名称（选填）<input value={course.title} onChange={(event) => updateCourse(course.id, { title: event.target.value })} placeholder="例如：数学课" /></label>
                  <label>
                    上课地点
                    <select value={course.locationId} onChange={(event) => updateCourse(course.id, { locationId: event.target.value })}>
                      <option value="">请选择地点</option>
                      {locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
                    </select>
                  </label>
                </div>
                <button className="text-danger" onClick={() => setCourses((current) => current.filter((item) => item.id !== course.id))}>删除这段课程</button>
              </article>
            ))}
          </section>

          <section className="card commute-card">
            <div className="section-kicker">系统自动核算</div>
            <h2>课程冲突与通勤检查</h2>
            {!commuteChecks.length ? (
              <p className="tiny">添加两段或以上课程后，系统会按时间顺序自动检查重叠和地点通勤。</p>
            ) : (
              <div className="commute-checks">
                {commuteChecks.map((check) => <div key={check.id} className={`commute-result ${check.severity}`}>{check.text}</div>)}
              </div>
            )}
            <details>
              <summary>查看全部地点通勤时间</summary>
              <div className="travel-list">
                {travelTimes.map((travel) => {
                  const from = locations.find((item) => item.id === travel.fromLocationId)?.name;
                  const to = locations.find((item) => item.id === travel.toLocationId)?.name;
                  if (!from || !to) return null;
                  return (
                    <div key={`${travel.fromLocationId}-${travel.toLocationId}`}>
                      <strong>{from} → {to}</strong>
                      <span>{travel.minutes} 分钟{travel.bufferMinutes ? ' + ' + travel.bufferMinutes + ' 分钟缓冲' : ''}</span>
                    </div>
                  );
                })}
              </div>
            </details>
          </section>

          <section className="card submit-weekend-card">
            <label>
              给甘老师的补充说明（选填）
              <textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="只写时间或地点需要特别说明的内容" />
            </label>
            <button disabled={loading} onClick={submit}>{loading ? '正在提交...' : '确认并提交周末安排'}</button>
            <p className="privacy-note">提交后会自动匹配到你在复习系统中的学生档案，不会创建同名重复学生。</p>
          </section>
        </>
      )}
    </main>
  );
}
