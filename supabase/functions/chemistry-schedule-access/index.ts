import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const allowedOrigins = new Set([
  "https://ganlu6633-source.github.io",
  "http://localhost:4173",
  "http://localhost:5173",
]);

const cors = (req: Request) => {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": allowedOrigins.has(origin)
      ? origin
      : "https://ganlu6633-source.github.io",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-app-session",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Vary": "Origin",
  };
};

const reply = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: cors(req) });

class RequestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "RequestError";
    this.status = status;
  }
}

type DataRow = Record<string, unknown>;
type CourseRow = {
  id: string;
  day: 6 | 7;
  startMinute: number;
  endMinute: number;
  title: string;
  locationId: string;
  isFixed: boolean;
  adjustDifficulty: 1 | 2 | 3 | 4 | 5;
  notes?: string;
};

const cleanText = (value: unknown, max = 120) =>
  String(value ?? "").trim().slice(0, max);

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function singleRow(value: unknown): DataRow | null {
  if (Array.isArray(value)) return (value[0] as DataRow | undefined) || null;
  if (value && typeof value === "object") return value as DataRow;
  return null;
}

function normalizeName(value: string) {
  return value.normalize("NFKC").replace(/[\s·•．.]/g, "").toLocaleLowerCase("zh-CN");
}

function extractSchool(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return "";
  const record = metadata as DataRow;
  const direct = cleanText(record.school || record.schoolName, 80);
  if (direct) return direct;
  const notes = cleanText(record.profileNotes, 500);
  const segment = notes
    .split(/[；;]/)
    .map((item) => item.trim())
    .find((item) => /中学|学校|一中/.test(item));
  if (!segment) return "";
  const match = segment.match(/[^，,。]*(?:中学|学校|一中)/);
  return cleanText(match?.[0] || segment.replace(/小班.*$/, ""), 80);
}

function dayValue(value: unknown): 6 | 7 | null {
  const normalized = cleanText(value, 20).toLowerCase();
  if (["周六", "星期六", "saturday", "sat", "6"].includes(normalized)) return 6;
  if (["周日", "星期日", "星期天", "sunday", "sun", "0", "7"].includes(normalized)) return 7;
  return null;
}

function timeMinutes(value: string) {
  const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function minutesTime(value: number) {
  return String(Math.floor(value / 60)).padStart(2, "0") + ":" +
    String(value % 60).padStart(2, "0");
}

function mapLocation(row: DataRow) {
  return {
    id: String(row.id),
    name: String(row.name),
    shortName: String(row.short_name || row.name),
    address: String(row.address || ""),
    capacity: Number(row.capacity) || 1,
    active: row.active !== false,
  };
}

function mapTravel(row: DataRow) {
  return {
    id: String(row.id),
    fromLocationId: String(row.from_location_id),
    toLocationId: String(row.to_location_id),
    minutes: Number(row.minutes) || 0,
    bufferMinutes: Number(row.buffer_minutes) || 0,
  };
}

async function loadProfile(chemStudentId: string) {
  const [
    chemResult,
    scheduleResult,
    locationsResult,
    travelResult,
  ] = await Promise.all([
    supabase
      .from("chem_students_v2")
      .select("id,display_name,grade_band,record_status,school_class,metadata")
      .eq("id", chemStudentId)
      .eq("record_status", "active")
      .maybeSingle(),
    supabase
      .from("sched_students")
      .select("*")
      .eq("chem_student_id", chemStudentId)
      .eq("active", true)
      .maybeSingle(),
    supabase
      .from("sched_locations")
      .select("id,name,short_name,address,capacity,active")
      .eq("active", true)
      .order("priority_weight", { ascending: false })
      .order("name"),
    supabase
      .from("sched_travel_times")
      .select("id,from_location_id,to_location_id,minutes,buffer_minutes"),
  ]);

  if (chemResult.error) throw chemResult.error;
  if (!chemResult.data) throw new RequestError(403, "该学生资料当前不可用，请联系甘老师。");
  if (scheduleResult.error) throw scheduleResult.error;
  if (locationsResult.error) throw locationsResult.error;
  if (travelResult.error) throw travelResult.error;

  const chem = chemResult.data as DataRow;
  const schedule = (scheduleResult.data || null) as DataRow | null;
  const scheduleStudentId = schedule ? String(schedule.id) : "";
  let classes: DataRow[] = [];

  if (scheduleStudentId) {
    const membersResult = await supabase
      .from("sched_class_members")
      .select("class_id")
      .eq("student_id", scheduleStudentId)
      .eq("active", true);
    if (membersResult.error) throw membersResult.error;
    const classIds = (membersResult.data || []).map((row) => String(row.class_id));
    if (classIds.length) {
      const classesResult = await supabase
        .from("sched_classes")
        .select("id,name,fixed_location_id,status")
        .in("id", classIds)
        .neq("status", "archived");
      if (classesResult.error) throw classesResult.error;
      classes = (classesResult.data || []) as DataRow[];
    }
  }

  const allLocations = (locationsResult.data || []).map((row) =>
    mapLocation(row as DataRow)
  );
  const validLocationIds = new Set(allLocations.map((location) => location.id));
  const preferences = Array.isArray(schedule?.location_preferences)
    ? schedule!.location_preferences.map(String).filter((id) => validLocationIds.has(id))
    : [];
  const classLocationIds = classes
    .map((row) => String(row.fixed_location_id || ""))
    .filter((id) => validLocationIds.has(id));
  const selectedIds = new Set(
    preferences.length ? preferences : classLocationIds.length ? classLocationIds : allLocations.map((item) => item.id),
  );
  const locations = allLocations.filter((location) => selectedIds.has(location.id));
  const classNames = classes.map((row) => String(row.name));
  const school = cleanText(schedule?.school, 80) || extractSchool(chem.metadata) || "资料库暂未登记";
  const schoolClass = cleanText(chem.school_class, 100) ||
    (classNames.length ? classNames.join("、") : "资料库暂未登记");
  const commitments = Array.isArray(schedule?.commitments)
    ? schedule!.commitments
    : [];

  return {
    chemStudentId: String(chem.id),
    scheduleStudentId: scheduleStudentId || undefined,
    displayName: String(chem.display_name),
    gradeBand: String(chem.grade_band || "资料库暂未登记"),
    school,
    schoolClass,
    classes: classes.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      locationId: row.fixed_location_id ? String(row.fixed_location_id) : undefined,
    })),
    classNames,
    currentClasses: classNames,
    locations,
    teachingLocations: locations,
    travelTimes: (travelResult.data || []).map((row) => mapTravel(row as DataRow)),
    commitments,
    existingCourses: commitments,
    dbCourseNeed: schedule?.course_need || null,
    dbClassMode: schedule?.class_mode || "either",
    weeklySessions: Number(schedule?.weekly_sessions) || 1,
    sessionMinutes: Number(schedule?.session_minutes) || 120,
    targetGroupSize: Number(schedule?.target_group_size) || 6,
  };
}

async function exchangeCode(req: Request, name: string, code: string) {
  if (!name || name.length > 40 || !/^\d{6,12}$/.test(code)) {
    throw new RequestError(400, "请输入学生姓名和复习系统的 6-12 位数字登录码。");
  }

  const token = randomToken();
  const tokenHash = await sha256(token);
  const fingerprint = await sha256(
    [
      req.headers.get("x-forwarded-for") || "",
      req.headers.get("user-agent") || "",
      req.headers.get("accept-language") || "",
    ].join("|"),
  );
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase.rpc("chem_exchange_access_code", {
    p_name: name,
    p_code: code,
    p_fingerprint_hash: fingerprint,
    p_token_hash: tokenHash,
    p_expires_at: expiresAt,
  });
  const access = singleRow(data);

  if (error || !access || String(access.access_role) !== "student" || !access.student_id) {
    throw new RequestError(401, "姓名或登录码不正确，请使用复习系统的同一登录码。");
  }

  const fullProfile = await loadProfile(String(access.student_id));
  const classMode = String(fullProfile.dbClassMode);
  const classType = classMode === "one_to_one" || classMode === "prefer_one_to_one"
    ? "一对一"
    : classMode === "group_only" || classMode === "prefer_group"
    ? "小班"
    : "两者均可";
  const profile = {
    chemStudentId: fullProfile.chemStudentId,
    scheduleStudentId: fullProfile.scheduleStudentId,
    displayName: fullProfile.displayName,
    gradeBand: fullProfile.gradeBand,
    school: fullProfile.school,
    schoolClass: fullProfile.schoolClass,
    classNames: fullProfile.classNames,
    classType,
    acceptedLocationIds: fullProfile.locations.map((location) => location.id),
    existingCourses: fullProfile.commitments,
    weeklySessionNeed: fullProfile.weeklySessions,
    lessonMinutes: fullProfile.sessionMinutes,
  };

  return {
    session: { token, expiresAt },
    profile,
    locations: fullProfile.locations,
    travelTimes: fullProfile.travelTimes,
    sessionToken: token,
    expiresAt,
  };
}

async function resolveSession(req: Request) {
  const token = cleanText(req.headers.get("x-app-session"), 256);
  if (token.length < 32) throw new RequestError(401, "登录已失效，请重新登录。");
  const { data, error } = await supabase.rpc("chem_resolve_app_session", {
    p_token_hash: await sha256(token),
  });
  const session = singleRow(data);
  if (
    error ||
    !session ||
    String(session.access_role) !== "student" ||
    !session.student_id ||
    new Date(String(session.expires_at)).getTime() <= Date.now()
  ) {
    throw new RequestError(401, "登录已失效，请重新登录。");
  }
  return String(session.student_id);
}

function normalizeCommitments(value: unknown, locationIds: Set<string>) {
  if (!Array.isArray(value) || value.length > 24) {
    throw new RequestError(400, "已有课程格式不正确，最多可填写 24 条。");
  }

  return value.map((candidate, index): CourseRow => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new RequestError(400, "第 " + (index + 1) + " 条课程格式不正确。");
    }
    const row = candidate as DataRow;
    const day = dayValue(row.day);
    const numericStart = Number(row.startMinute);
    const numericEnd = Number(row.endMinute);
    const startMinute = Number.isFinite(numericStart)
      ? numericStart
      : timeMinutes(cleanText(row.start || row.startTime, 5));
    const endMinute = Number.isFinite(numericEnd)
      ? numericEnd
      : timeMinutes(cleanText(row.end || row.endTime, 5));
    const locationId = cleanText(row.locationId || row.location_id, 50);
    if (!day || startMinute === null || endMinute === null || endMinute <= startMinute) {
      throw new RequestError(400, "第 " + (index + 1) + " 条课程的日期或时间不正确。");
    }
    if (startMinute < 8 * 60 || endMinute > 22 * 60) {
      throw new RequestError(400, "课程时间需在 08:00-22:00 之间。");
    }
    if (!locationIds.has(locationId)) {
      throw new RequestError(400, "请选择系统中已登记的上课地点。");
    }
    const suppliedId = cleanText(row.id, 50);
    const difficulty = Number(row.adjustDifficulty);
    return {
      id: /^[0-9a-f-]{36}$/i.test(suppliedId) ? suppliedId : crypto.randomUUID(),
      day,
      startMinute,
      endMinute,
      title: cleanText(row.title || row.courseName, 60) || "已有课程",
      locationId,
      isFixed: row.isFixed !== false,
      adjustDifficulty: ([1, 2, 3, 4, 5].includes(difficulty) ? difficulty : 1) as 1 | 2 | 3 | 4 | 5,
      notes: cleanText(row.notes, 300) || undefined,
    };
  }).sort((a, b) => a.day - b.day || a.startMinute - b.startMinute);
}
function travelChecks(
  courses: CourseRow[],
  travelTimes: Array<{ fromLocationId: string; toLocationId: string; minutes: number; bufferMinutes: number }>,
) {
  const lookup = new Map(
    travelTimes.map((item) => [
      item.fromLocationId + ">" + item.toLocationId,
      item.minutes + item.bufferMinutes,
    ]),
  );
  const warnings: Array<{
    level: "error" | "warning" | "ok";
    day: string;
    fromCourseId: string;
    toCourseId: string;
    message: string;
  }> = [];

  for (const day of [6, 7] as const) {
    const rows = courses
      .filter((course) => course.day === day)
      .sort((a, b) => a.startMinute - b.startMinute);
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1];
      const current = rows[index];
      const gap = current.startMinute - previous.endMinute;
      if (gap < 0) {
        warnings.push({
          level: "error",
          day: day === 6 ? "周六" : "周日",
          fromCourseId: previous.id,
          toCourseId: current.id,
          message: previous.title + " 与 " + current.title + " 时间重叠 " + Math.abs(gap) + " 分钟。",
        });
        continue;
      }
      if (previous.locationId === current.locationId) {
        warnings.push({
          level: "ok",
          day: day === 6 ? "周六" : "周日",
          fromCourseId: previous.id,
          toCourseId: current.id,
          message: "两节课地点相同，间隔 " + gap + " 分钟。",
        });
        continue;
      }
      const required = lookup.get(previous.locationId + ">" + current.locationId);
      if (required === undefined) {
        warnings.push({
          level: "warning",
          day: day === 6 ? "周六" : "周日",
          fromCourseId: previous.id,
          toCourseId: current.id,
          message: "两个地点之间暂未配置通勤时间，请甘老师确认。",
        });
      } else if (gap < required) {
        warnings.push({
          level: "error",
          day: day === 6 ? "周六" : "周日",
          fromCourseId: previous.id,
          toCourseId: current.id,
          message: "两节课间隔 " + gap + " 分钟，通勤至少需要 " + required + " 分钟。",
        });
      } else {
        warnings.push({
          level: "ok",
          day: day === 6 ? "周六" : "周日",
          fromCourseId: previous.id,
          toCourseId: current.id,
          message: "通勤至少需要 " + required + " 分钟，当前间隔 " + gap + " 分钟。",
        });
      }
    }
  }
  return warnings;
}

function deriveAvailability(courses: CourseRow[]) {
  const result: Record<string, "free" | "blocked"> = {};
  for (let day = 1; day <= 7; day += 1) {
    for (let start = 8 * 60; start < 22 * 60; start += 30) {
      const occupied = courses.some((course) =>
        course.day === day &&
        Math.max(course.startMinute, start) < Math.min(course.endMinute, start + 30)
      );
      result[String(day) + "-" + String(start)] = day < 6 || occupied ? "blocked" : "free";
    }
  }
  return result;
}
async function submitSchedule(req: Request, payload: DataRow) {
  const chemStudentId = await resolveSession(req);
  const profile = await loadProfile(chemStudentId);
  const locationIds = new Set(profile.locations.map((location) => location.id));
  const commitments = normalizeCommitments(payload.commitments, locationIds);
  const checks = travelChecks(commitments, profile.travelTimes);
  const availability = deriveAvailability(commitments);
  const locationPreferences = profile.locations.map((location) => location.id);
  const issueMessages = checks
    .filter((item) => item.level !== "ok")
    .map((item) => item.message);
  const notes = [
    "学生通过复习系统统一登录码提交。",
    cleanText(payload.notes, 1000),
    ...issueMessages,
  ].filter(Boolean).join("\n");
  const formResult = await supabase
    .from("sched_student_form_config")
    .select("form_key")
    .eq("active", true)
    .limit(1)
    .maybeSingle();
  if (formResult.error) throw formResult.error;
  if (!formResult.data?.form_key) {
    throw new RequestError(503, "学生登记表暂未开放，请联系甘老师。");
  }

  const submissionRow = {
    form_key: String(formResult.data.form_key),
    chem_student_id: chemStudentId,
    student_name: profile.displayName,
    normalized_name: normalizeName(profile.displayName),
    grade_band: profile.gradeBand,
    school: profile.school === "资料库暂未登记" ? null : profile.school,
    contact: null,
    course_need: profile.dbCourseNeed,
    class_mode: profile.dbClassMode,
    weekly_sessions: profile.weeklySessions,
    session_minutes: profile.sessionMinutes,
    target_group_size: profile.targetGroupSize,
    availability,
    commitments,
    location_preferences: locationPreferences,
    overall_flexibility: "normal",
    notes,
    status: "new",
    updated_at: new Date().toISOString(),
  };

  const existingResult = await supabase
    .from("sched_intake_submissions")
    .select("id")
    .eq("chem_student_id", chemStudentId)
    .eq("status", "new")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingResult.error) throw existingResult.error;

  let saved;
  if (existingResult.data?.id) {
    const updateResult = await supabase
      .from("sched_intake_submissions")
      .update(submissionRow)
      .eq("id", existingResult.data.id)
      .select("id,created_at,updated_at")
      .single();
    if (updateResult.error) throw updateResult.error;
    saved = updateResult.data;
  } else {
    const insertResult = await supabase
      .from("sched_intake_submissions")
      .insert({ ...submissionRow, created_at: new Date().toISOString() })
      .select("id,created_at,updated_at")
      .single();
    if (insertResult.error) throw insertResult.error;
    saved = insertResult.data;
  }

  return {
    ok: true,
    id: saved.id,
    submissionId: saved.id,
    updatedAt: saved.updated_at,
    warnings: checks,
    availability,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return reply(req, { error: "仅支持 POST 请求。" }, 405);

  try {
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new RequestError(400, "请求格式不正确。");
    }
    const payload = body as DataRow;
    const action = cleanText(payload.action, 20);
    if (action === "login") {
      return reply(
        req,
        await exchangeCode(
          req,
          cleanText(payload.name, 40),
          cleanText(payload.code, 20),
        ),
      );
    }
    if (action === "submit") {
      const candidate = payload.data || payload.payload;
      const submitted = candidate && typeof candidate === "object" &&
          !Array.isArray(candidate)
        ? candidate as DataRow
        : payload;
      return reply(req, await submitSchedule(req, submitted));
    }
    throw new RequestError(400, "不支持的操作。");
  } catch (error) {
    if (error instanceof RequestError) {
      return reply(req, { error: error.message }, error.status);
    }
    console.error("chemistry-schedule-access", error);
    return reply(req, { error: "服务暂时不可用，请稍后重试。" }, 500);
  }
});

