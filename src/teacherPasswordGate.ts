import { createClient } from '@supabase/supabase-js';
import './teacherPasswordGate.css';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
const gateId = 'teacher-password-gate';

const teacherAuth = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

function isTeacherRoute() {
  return window.location.hash === '#/teacher' || window.location.hash.startsWith('#/teacher/');
}

function removeGate() {
  document.getElementById(gateId)?.remove();
}

function createGate() {
  const existing = document.getElementById(gateId);
  if (existing) return existing;

  const gate = document.createElement('div');
  gate.id = gateId;
  gate.className = 'teacher-code-gate';
  gate.innerHTML = `
    <main class="teacher-code-card" aria-labelledby="teacher-code-title">
      <div class="teacher-code-mark" aria-hidden="true">排</div>
      <p class="teacher-code-kicker">智能排课系统 · 教师端</p>
      <h1 id="teacher-code-title">教师登录</h1>
      <p class="teacher-code-intro">填写本次使用的教师名称，再输入教师密码即可进入。</p>
      <form class="teacher-code-form">
        <label>
          <span>教师名称</span>
          <input name="teacherName" type="text" maxlength="30" autocomplete="username" placeholder="可填写任意教师名称" required />
        </label>
        <label>
          <span>教师密码</span>
          <input name="teacherCode" type="password" inputmode="numeric" pattern="[0-9]{6,12}" minlength="6" maxlength="12" autocomplete="current-password" placeholder="请输入 6 至 12 位数字密码" required />
        </label>
        <p class="teacher-code-error" role="alert" aria-live="polite"></p>
        <button type="submit">进入教师端</button>
      </form>
      <p class="teacher-code-note">教师名称只作为本次登录显示名称，身份权限由教师密码验证。</p>
    </main>
  `;

  const form = gate.querySelector<HTMLFormElement>('form')!;
  const nameInput = form.elements.namedItem('teacherName') as HTMLInputElement;
  const codeInput = form.elements.namedItem('teacherCode') as HTMLInputElement;
  const submitButton = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const errorBox = form.querySelector<HTMLElement>('.teacher-code-error')!;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const teacherName = nameInput.value.trim();
    const teacherCode = codeInput.value.trim();

    if (!teacherName || teacherName.length > 30) {
      errorBox.textContent = '请填写教师名称。';
      nameInput.focus();
      return;
    }
    if (!/^\d{6,12}$/.test(teacherCode)) {
      errorBox.textContent = '教师密码应为 6 至 12 位数字。';
      codeInput.focus();
      return;
    }
    if (!teacherAuth || !supabaseUrl || !supabaseKey) {
      errorBox.textContent = '教师登录服务尚未完成配置。';
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = '正在验证...';
    errorBox.textContent = '';

    try {
      const response = await fetch(`${supabaseUrl}/functions/v1/chemistry-schedule-teacher-login`, {
        method: 'POST',
        headers: {
          apikey: supabaseKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: teacherName, code: teacherCode }),
      });
      const payload = await response.json().catch(() => ({})) as {
        error?: string;
        tokenHash?: string;
        appSessionToken?: string;
      };
      if (!response.ok || !payload.tokenHash) {
        throw new Error(payload.error || '教师名称或密码不正确。');
      }

      const verified = await teacherAuth.auth.verifyOtp({
        token_hash: payload.tokenHash,
        type: 'magiclink',
      });
      if (verified.error || !verified.data.session) {
        throw new Error('教师登录会话建立失败，请重新输入密码。');
      }
      if (payload.appSessionToken) {
        window.sessionStorage.setItem('chem_teacher_session', payload.appSessionToken);
      }
      window.location.reload();
    } catch (error) {
      errorBox.textContent = error instanceof Error ? error.message : '教师登录暂时不可用，请稍后重试。';
      codeInput.value = '';
      codeInput.focus();
      submitButton.disabled = false;
      submitButton.textContent = '进入教师端';
    }
  });

  document.body.appendChild(gate);
  window.setTimeout(() => nameInput.focus(), 0);
  return gate;
}

let syncing = false;
async function syncTeacherGate() {
  if (syncing) return;
  if (!isTeacherRoute()) {
    removeGate();
    return;
  }

  createGate();
  if (!teacherAuth) return;
  syncing = true;
  try {
    const { data } = await teacherAuth.auth.getSession();
    if (data.session) removeGate();
  } finally {
    syncing = false;
  }
}

if (isTeacherRoute()) createGate();
window.addEventListener('hashchange', () => void syncTeacherGate());
window.addEventListener('storage', () => void syncTeacherGate());
window.setInterval(() => void syncTeacherGate(), 1000);
void syncTeacherGate();
