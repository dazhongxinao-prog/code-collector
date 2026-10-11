/* ================================================================
   大中信奥 · 代码回收系统 考生端逻辑
   ================================================================ */
let me = null;               // 官网账号 { uuid, username, email, name }
let contestsList = [];       // 公开比赛列表
let currentContestId = '';   // 当前选中的比赛 ID
let currentContestData = null; // 当前比赛元数据与题目
let contestEnd = null;
let isLocked = false;
let activeUploadProblem = null;
let uploadMode = 'file';
let statusRequestSerial = 0;
let statusAbortController = null;

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function toast(type, msg) {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerText = msg;
  $('toast-box').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .3s';
    setTimeout(() => el.remove(), 320);
  }, 4200);
}

function closeModal(id) { $(id).classList.remove('show'); }

/* ================================================================
   初始化：加载比赛列表 → 检测官网登录态 → 加载提交状态
   ================================================================ */
async function init() {
  const urlParams = new URLSearchParams(window.location.search);
  const qContest = urlParams.get('contest');

  // 1. 加载比赛列表
  await loadContestsList(qContest);

  // 2. 检测官网账号登录态
  try {
    const res = await fetch('api/me');
    me = await res.json();
  } catch (e) {
    me = { authenticated: false };
  }

  renderAuthArea();
  await loadStatus();

  setInterval(tickCountdown, 1000);
  setInterval(async () => {
    await loadContestsList(currentContestId);
    await loadStatus();
  }, 30000);
}

// 加载公开比赛列表
async function loadContestsList(presetContestId) {
  try {
    const res = await fetch('api/contests');
    const data = await res.json();
    if (data.success && data.contests) {
      contestsList = data.contests;
      const selector = $('contest-selector');
      selector.innerHTML = '';
      
      let matched = false;
      contestsList.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.innerText = `${c.short_title || c.title} (${c.category || '机考'})`;
        if (presetContestId && c.id === presetContestId) {
          opt.selected = true;
          currentContestId = c.id;
          matched = true;
        } else if (!presetContestId && c.is_active && !matched) {
          opt.selected = true;
          currentContestId = c.id;
          matched = true;
        }
        selector.appendChild(opt);
      });

      if (!matched && contestsList.length > 0) {
        currentContestId = contestsList[0].id;
        selector.value = currentContestId;
      }
    }
  } catch (err) {
    console.error('获取比赛列表失败:', err);
  }
}

function onContestChange(newContestId) {
  if (newContestId === currentContestId) return;
  currentContestId = newContestId;
  const url = new URL(window.location.href);
  url.searchParams.set('contest', newContestId);
  window.history.pushState({}, '', url);
  loadStatus();
}

function renderAuthArea() {
  const box = $('auth-area');
  if (me && me.authenticated) {
    box.innerHTML = `
      <div class="user-chip">
        <div class="user-avatar">${(me.user.name || '学')[0]}</div>
        <div>
          <div class="u-name">${escapeHtml(me.user.name)}</div>
          <div class="u-sub">官网账号已登录</div>
        </div>
      </div>`;
  } else {
    box.innerHTML = `
      <a class="btn-login" href="https://open.moblm.com/auth/login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}">官网登录</a>
      <a class="btn-signup" href="https://open.moblm.com/auth/signup" target="_blank" rel="noopener">注册</a>`;
  }
}

function renderBindCard() {
  const card = $('bind-card');
  const body = $('bind-body');
  const action = $('bind-action');

  if (me && me.authenticated) {
    card.classList.add('ok');
    body.innerHTML = `
      <h3>已登录官网账号，当前账号即考生身份</h3>
      <p>当前账号「<b>${escapeHtml(me.user.name)}</b>」已直接作为考生身份，提交文件将自动归档到你名下，无需手动输入准考证号。</p>`;
    action.innerHTML = `<span style="font-size:12px;color:var(--text-3);">座位由考务系统统一分配，可直接提交</span>`;
  } else {
    card.classList.remove('ok');
    body.innerHTML = `
      <h3>请使用大中信奥官网账号登录本代码回收系统</h3>
      <p>本系统与官网账号打通：<b>登录即考生</b>，提交记录自动以官网账号建立归档。未登录可浏览比赛与题目，上传、查看和交卷需先登录。</p>`;
    action.innerHTML = `
      <a class="btn btn-brand btn-sm" href="https://open.moblm.com/auth/login?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}"><i data-lucide="log-in" style="width:13px;height:13px;"></i> 官网账号登录</a>`;
  }
  renderIcons();
}

function renderContestMaterials(materials, testData) {
  const box = $('contest-materials');
  const list = $('contest-materials-list');
  if (!box || !list) return;
  if ((!materials || materials.length === 0) && !testData) {
    box.style.display = 'none';
    list.innerHTML = '';
    return;
  }
  box.style.display = 'block';
  const materialLinks = (materials || []).map((material) => {
    const isZip = (material.file_extension || '').toLowerCase() === '.zip'
      || /\.zip$/i.test(material.filename || '');
    const label = material.name || material.filename || (isZip ? 'ZIP 资料' : 'PDF 资料');
    return `
    <a class="btn btn-outline btn-sm" style="margin:0 8px 8px 0;" href="api/contest-material/${encodeURIComponent(currentContestId)}/${encodeURIComponent(material.id)}" ${isZip ? 'download' : 'target="_blank" rel="noopener"'}>
      <i data-lucide="file-text"></i> ${isZip ? '下载 ZIP：' : '查看 PDF：'}${escapeHtml(label)}
    </a>
  `;
  }).join('');
  const testDataLink = testData ? `
    <a class="btn btn-outline btn-sm" style="margin:0 8px 8px 0;" href="api/contest-test-data/${encodeURIComponent(currentContestId)}" download>
      <i data-lucide="file-text"></i> 下载完整测试数据 ZIP：${escapeHtml(testData.filename || '测试数据.zip')}
    </a>
  ` : '';
  list.innerHTML = materialLinks + testDataLink;
  renderIcons();
}

/* ================================================================
   加载比赛与题目状态
   ================================================================ */
async function loadStatus() {
  const contestIdAtRequest = currentContestId;
  const requestSerial = ++statusRequestSerial;
  if (statusAbortController) statusAbortController.abort();
  statusAbortController = new AbortController();
  const url = `api/submissions/status?contest=${encodeURIComponent(contestIdAtRequest)}`;
  const tbody = $('student-tbody');
  if (tbody) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--text-3);">正在加载当前比赛提交状态…</td></tr>';
  }
  if ($('status-submitted-count')) $('status-submitted-count').innerText = '加载中';
  try {
    const res = await fetch(url, { cache: 'no-store', signal: statusAbortController.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (
      requestSerial !== statusRequestSerial
      || currentContestId !== contestIdAtRequest
      || data.contest_code !== contestIdAtRequest
    ) return;
    currentContestData = data;
    isLocked = data.is_locked;
    contestEnd = data.contest_end || null;
    renderContestMaterials(data.materials || [], data.test_data || null);

    // 渲染 HUD
    $('hud-contest-name').innerText = data.contest_name;
    $('page-contest-title').innerText = data.contest_name;
    $('hud-name').innerText = data.student_name || '—';
    $('hud-exam').innerText = data.account || '—';
    $('hud-seat').innerText = data.seat || '—';
    $('hud-school').innerText = data.school || '大中信奥';

    // 提醒公告
    if (data.alert_notice) {
      $('alert-content').innerText = data.alert_notice;
    }

    renderBindCard();
    renderTable(data.problems || []);
    tickCountdown();
  } catch (err) {
    if (err.name === 'AbortError' || requestSerial !== statusRequestSerial || currentContestId !== contestIdAtRequest) return;
    console.error('加载状态失败:', err);
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--danger);">当前比赛状态加载失败，请稍后重试。</td></tr>`;
    }
  } finally {
    if (requestSerial === statusRequestSerial) statusAbortController = null;
  }
}

function opsEnabled() {
  return !!(me && me.authenticated && !isLocked);
}

function renderTable(problems) {
  const tbody = $('student-tbody');
  tbody.innerHTML = '';
  let uploadedCount = 0;
  const authenticated = !!(me && me.authenticated);

  $('prob-total-count').innerText = problems.length;
  $('prob-total-denom').innerText = authenticated ? problems.length : '—';

  problems.forEach((p) => {
    if (p.status === 'uploaded') uploadedCount++;
    const tr = document.createElement('tr');

    const extsBadge = (p.allowed_exts || []).map(e => `<span class="type-badge">${escapeHtml(e)}</span>`).join('');

    tr.innerHTML = `
      <td style="font-family:'JetBrains Mono',monospace;color:var(--text-3);font-weight:600;">T${p.num}</td>
      <td>
        <div class="p-name">${escapeHtml(p.name)}</div>
        <div class="p-sub">子目录: /${escapeHtml(p.code)}/</div>
        ${p.statement ? `<details class="problem-statement"><summary>查看题面</summary><pre>${escapeHtml(p.statement)}</pre></details>` : ''}
      </td>
      <td>
        <span class="code-tag">${authenticated ? escapeHtml(p.filename) : '登录后显示'}</span>
        ${extsBadge}
      </td>
      <td>${p.status === 'uploaded'
        ? '<span class="pill pill-ok"><i data-lucide="check" style="width:12px;height:12px;"></i> 已提交</span>'
        : p.status === 'login_required'
          ? '<span class="pill pill-login"><i data-lucide="lock" style="width:12px;height:12px;"></i> 登录后查看</span>'
        : '<span class="pill pill-pending"><i data-lucide="circle-dashed" style="width:12px;height:12px;"></i> 未上传</span>'}
      </td>
      <td class="mono-dim">${authenticated ? p.size : '—'}</td>
      <td class="mono-dim">${authenticated && p.md5 !== '-' ? p.md5.slice(0, 10) + '…' : '—'}</td>
      <td style="text-align:right;">
        <div style="display:inline-flex;gap:8px;align-items:center;">
          ${authenticated && p.status === 'uploaded' ? '<button class="btn btn-ghost btn-sm" data-action="view-code"><i data-lucide="eye" style="width:13px;height:13px;"></i> 查看</button>' : ''}
          <button class="btn btn-primary btn-sm ${authenticated && !isLocked ? '' : 'btn-gated'}" data-action="upload-code">
            <i data-lucide="${authenticated && !isLocked ? 'upload' : 'lock'}" style="width:13px;height:13px;"></i> ${authenticated ? (p.status === 'uploaded' ? '重新上传' : '上传代码') : '登录后上传'}
          </button>
        </div>
      </td>`;
    tr.querySelector('[data-action="view-code"]')?.addEventListener('click', () => viewRealCode(p.code, p.name));
    tr.querySelector('[data-action="upload-code"]')?.addEventListener('click', () => openUploadModal(p.code, p.name, p.num));
    tbody.appendChild(tr);
  });

  $('status-submitted-count').innerText = authenticated ? uploadedCount : '登录后查看';
  $('btn-receipt').classList.toggle('btn-gated', !authenticated);
  $('btn-finalize').classList.toggle('btn-gated', !authenticated || isLocked);
  renderIcons();
}

function currentReturnUrl() {
  return window.location.pathname + window.location.search + window.location.hash;
}

function showLoginPrompt(reason = '此操作需要使用大中信奥官网账号登录') {
  const message = $('login-prompt-message');
  if (message) message.innerText = reason;
  $('modal-login-prompt').classList.add('show');
  renderIcons();
}

function goToOfficialLogin() {
  window.location.href = `https://open.moblm.com/auth/login?redirect=${encodeURIComponent(currentReturnUrl())}`;
}

function handleAuthRequired(res, data) {
  if (res.status === 401 && data && data.code === 'AUTH_REQUIRED') {
    showLoginPrompt();
    return true;
  }
  return false;
}

/* ================================================================
   倒计时
   ================================================================ */
function tickCountdown() {
  const el = $('cd-time');
  if (!contestEnd) { el.innerText = '--:--:--'; return; }
  const end = new Date(contestEnd.replace(' ', 'T')).getTime();
  let diff = Math.floor((end - Date.now()) / 1000);
  el.classList.remove('warn', 'over');
  if (diff <= 0) {
    el.innerText = '考试已结束';
    el.classList.add('over');
    return;
  }
  const h = String(Math.floor(diff / 3600)).padStart(2, '0');
  const m = String(Math.floor((diff % 3600) / 60)).padStart(2, '0');
  const s = String(diff % 60).padStart(2, '0');
  el.innerText = `${h}:${m}:${s}`;
  if (diff < 600) el.classList.add('warn');
}

function switchMainTab(tab) {
  ['sub', 'doc'].forEach(t => {
    $('tab-btn-' + t).classList.toggle('active', t === tab);
    $('tab-content-' + t).style.display = (t === tab) ? 'block' : 'none';
  });
}

/* ================================================================
   上传逻辑
   ================================================================ */
async function openUploadModal(problemCode, problemName, num) {
  if (!opsEnabled()) {
    if (isLocked) toast('err', '试卷已最终锁定封存，无法再修改或上传文件！');
    else showLoginPrompt();
    return;
  }

  const problem = (currentContestData.problems || []).find(p => p.code === problemCode);
  if (!problem) return;

  activeUploadProblem = problem;
  $('upload-modal-title').innerText = `上传 T${num} ${problemName}（${problemCode}）`;
  $('upload-modal-subtitle').innerText = `考生：${me.user.name} ｜ 允许格式: ${(problem.allowed_exts || []).join(' / ')}`;
  $('hint-expected-filename').innerText = (problem.allowed_exts || []).join(' / ');

  const fileInput = $('native-file-input');
  fileInput.value = '';
  fileInput.accept = (problem.allowed_exts || []).join(',');
  $('selected-file-info').style.display = 'none';

  // 判断是否支持在线纯文本代码提交（如 zip 则隐藏在线代码）
  const textExts = ['.cpp', '.c', '.cc', '.cxx', '.py', '.java', '.txt', '.sql', '.js', '.ts', '.pas'];
  const hasTextFormat = (problem.allowed_exts || []).some(ext => textExts.includes(ext.toLowerCase()));

  if (hasTextFormat) {
    $('upload-mode-tabs').style.display = 'flex';
    loadProblemTemplate();
    switchUploadTab('file');
  } else {
    $('upload-mode-tabs').style.display = 'none';
    switchUploadTab('file');
  }

  $('modal-upload').classList.add('show');
  renderIcons();
}

function switchUploadTab(mode) {
  uploadMode = mode;
  $('btn-tab-file').classList.toggle('active', mode === 'file');
  $('btn-tab-paste').classList.toggle('active', mode === 'paste');
  $('panel-file').style.display = mode === 'file' ? 'block' : 'none';
  $('panel-paste').style.display = mode === 'paste' ? 'block' : 'none';
}

async function loadProblemTemplate() {
  if (!activeUploadProblem) return;
  try {
    const res = await fetch(`api/problem-template?contest=${encodeURIComponent(currentContestId)}&problem=${encodeURIComponent(activeUploadProblem.code)}`);
    const data = await res.json();
    if (!res.ok) {
      if (handleAuthRequired(res, data)) return;
      throw new Error(data.error || '获取答题模板失败');
    }
    $('paste-code-input').value = data.template_code || `// ${activeUploadProblem.name} (${activeUploadProblem.code})\n`;
  } catch (e) {
    if (e && e.message === 'AUTH_REQUIRED') return;
    $('paste-code-input').value = `// ${activeUploadProblem.name}\n`;
  }
}

$('native-file-input').addEventListener('change', function (e) {
  const file = e.target.files[0];
  const infoEl = $('selected-file-info');
  if (file) {
    infoEl.style.display = 'block';
    infoEl.innerText = `已选中文件: ${file.name}（${file.size} 字节）`;
  } else {
    infoEl.style.display = 'none';
  }
});

const dropZone = $('drop-zone');
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag');
  if (e.dataTransfer.files.length > 0) {
    $('native-file-input').files = e.dataTransfer.files;
    const file = e.dataTransfer.files[0];
    const infoEl = $('selected-file-info');
    infoEl.style.display = 'block';
    infoEl.innerText = `已拖入文件: ${file.name}（${file.size} 字节）`;
  }
});

async function executeUpload() {
  if (!activeUploadProblem) return;
  const problemCode = activeUploadProblem.code;

  if (uploadMode === 'file') {
    const file = $('native-file-input').files[0];
    if (!file) { toast('err', '请先选择或拖入本地代码/工程文件！'); return; }
    if (file.size === 0) { toast('err', '严禁上传 0 字节空文件！'); return; }

    const formData = new FormData();
    formData.append('contest_id', currentContestId);
    formData.append('problem_code', problemCode);
    formData.append('code_file', file);

    try {
      const res = await fetch('api/upload', { method: 'POST', body: formData });
      const result = await res.json();
      if (res.ok && result.success) {
        toast('ok', `✅ 上传成功并完成落盘：${result.filename}（${result.size} 字节）`);
        closeModal('modal-upload');
        loadStatus();
      } else if (!handleAuthRequired(res, result)) {
        toast('err', result.error || '上传失败');
      }
    } catch (err) {
      toast('err', '上传请求出错: ' + err.message);
    }
  } else {
    const codeText = $('paste-code-input').value;
    if (!codeText.trim()) { toast('err', '代码内容不能为空！'); return; }

    try {
      const res = await fetch('api/upload-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contest_id: currentContestId,
          problem_code: problemCode,
          filename: `${problemCode}${activeUploadProblem.allowed_exts[0] || '.cpp'}`,
          code_text: codeText
        })
      });
      const result = await res.json();
      if (res.ok && result.success) {
        toast('ok', `✅ 在线提交成功并完成落盘：${result.filename}（${result.size} 字节）`);
        closeModal('modal-upload');
        loadStatus();
      } else if (!handleAuthRequired(res, result)) {
        toast('err', result.error || '提交失败');
      }
    } catch (err) {
      toast('err', '提交请求出错: ' + err.message);
    }
  }
}

/* ================================================================
   查看代码与合规分析
   ================================================================ */
async function viewRealCode(problemCode, problemName) {
  if (!me || !me.authenticated) {
    showLoginPrompt();
    return;
  }
  try {
    const res = await fetch(`api/view-code/${encodeURIComponent(problemCode)}?contest=${encodeURIComponent(currentContestId)}`);
    const data = await res.json();
    if (!res.ok) {
      if (handleAuthRequired(res, data)) return;
      throw new Error(data.error || '获取代码失败');
    }

    $('code-modal-title').innerText = `已提交文件：${data.filename}（${problemName}）`;
    $('code-modal-filename').innerText = `考生：${me.user.name} ｜ 大小: ${data.size} ｜ MD5: ${data.md5}`;
    $('code-modal-content').innerText = data.code;

    const analysisBar = $('code-analysis-bar');
    analysisBar.innerHTML = '';

    if (data.analysis) {
      const a = data.analysis;
      analysisBar.innerHTML = `
        <span class="a-chip ${a.has_freopen_in ? 'a-good' : 'a-bad'}">freopen .in ${a.has_freopen_in ? '✓ 开启' : '✗ 未检出'}</span>
        <span class="a-chip ${a.has_freopen_out ? 'a-good' : 'a-bad'}">freopen .out ${a.has_freopen_out ? '✓ 开启' : '✗ 未检出'}</span>
        <span class="a-chip ${a.has_return_0 ? 'a-good' : 'a-bad'}">return 0 ${a.has_return_0 ? '✓ 包含' : '✗ 未检出'}</span>
        <span class="a-chip ${a.has_forbidden_headers ? 'a-bad' : 'a-good'}">Windows 头文件 ${a.has_forbidden_headers ? '✗ 检出违规' : '✓ 未检出'}</span>`;
    } else {
      analysisBar.innerHTML = `<span class="a-chip a-good">非 C++ 源码题型，已完成物理存储校验</span>`;
    }

    $('modal-code').classList.add('show');
  } catch (err) {
    toast('err', err.message);
  }
}

/* ================================================================
   最终交卷 & 确认单打印
   ================================================================ */
async function doFinalize() {
  if (!me || !me.authenticated) {
    showLoginPrompt();
    return;
  }
  if (!opsEnabled()) {
    toast('err', '试卷已最终锁定封存，无法再次交卷。');
    return;
  }
  if (!confirm('确认最终交卷？交卷后代码将被锁定封存，无法再修改或重新上传！')) return;

  try {
    const res = await fetch('api/finalize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contest_id: currentContestId })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      toast('ok', data.message);
      loadStatus();
    } else if (!handleAuthRequired(res, data)) {
      toast('err', data.error || '交卷失败');
    }
  } catch (e) {
    toast('err', '交卷请求出错: ' + e.message);
  }
}

function openReceipt() {
  if (!me || !me.authenticated) {
    showLoginPrompt();
    return;
  }
  const name = $('hud-name').innerText;
  const exam = $('hud-exam').innerText;
  const seat = $('hud-seat').innerText;
  const school = $('hud-school').innerText;
  const contestTitle = $('hud-contest-name').innerText;

  $('r-contest-title').innerText = contestTitle;
  $('r-contest-short').innerText = currentContestData ? currentContestData.contest_name : '上机认证';
  $('r-exam').innerText = exam;
  $('r-name').innerText = name;
  $('r-seat').innerText = seat;
  $('r-school').innerText = school;
  $('r-time').innerText = new Date().toLocaleString('zh-CN', { hour12: false });

  let rows = `
    <tr style="background:var(--bg-subtle);">
      <th style="padding:6px;">题号</th>
      <th style="padding:6px;">题目目录</th>
      <th style="padding:6px;">标准文件名</th>
      <th style="padding:6px;">允许类型</th>
      <th style="padding:6px;">文件大小</th>
      <th style="padding:6px;">提交时间</th>
    </tr>`;

  (currentContestData.problems || []).forEach(p => {
    rows += `
      <tr style="text-align:center;">
        <td style="padding:6px;">T${p.num}</td>
        <td style="padding:6px;">/${p.code}/</td>
        <td style="padding:6px;">${p.filename}</td>
        <td style="padding:6px;">${(p.allowed_exts || []).join(', ')}</td>
        <td style="padding:6px;">${p.status === 'uploaded' ? p.size : '未提交'}</td>
        <td style="padding:6px;">${p.submitted_at}</td>
      </tr>`;
  });

  $('receipt-table').innerHTML = rows;
  $('modal-receipt').classList.add('show');
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 离线 Lucide 图标字典
const LUCIDE_ICONS = {
  "hard-drives": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" x2="2" y1="12" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" x2="6.01" y1="16" y2="16"/><line x1="10" x2="10.01" y1="16" y2="16"/></svg>`,
  "hard-drive": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" x2="2" y1="12" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" x2="6.01" y1="16" y2="16"/><line x1="10" x2="10.01" y1="16" y2="16"/></svg>`,
  "trophy": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>`,
  "shield-check": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>`,
  "link-2": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" x2="16" y1="12" y2="12"/></svg>`,
  "upload-cloud": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 13v8"/><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="m8 17 4-4 4 4"/></svg>`,
  "book-open": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/></svg>`,
  "list-checks": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/></svg>`,
  "file-text": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>`,
  "lock": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
  "check": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
  "circle-dashed": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.1 2.182a10 10 0 0 1 3.8 0"/><path d="M13.9 21.818a10 10 0 0 1-3.8 0"/><path d="M17.609 3.721a10 10 0 0 1 2.69 2.7"/><path d="M2.182 13.9a10 10 0 0 1 0-3.8"/><path d="M20.279 17.609a10 10 0 0 1-2.7 2.69"/><path d="M21.818 10.1a10 10 0 0 1 0 3.8"/><path d="M3.721 6.391a10 10 0 0 1 2.7-2.69"/><path d="M6.391 20.279a10 10 0 0 1-2.69-2.7"/></svg>`,
  "eye": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>`,
  "upload": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>`,
  "sparkles": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/></svg>`,
  "check-circle-2": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/></svg>`,
  "printer": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"/><rect x="6" y="14" width="12" height="8" rx="1"/></svg>`,
  "settings": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`,
  "x": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
  "folder-tree": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1z"/><path d="M20 21a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.9a1 1 0 0 1-.88-.53l-.44-.88A1 1 0 0 0 15 14h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1z"/><path d="M3 3v18h6"/><path d="M9 9h3"/><path d="M9 17h3"/></svg>`,
  "cpu": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="16" height="16" x="4" y="4" rx="2"/><rect width="6" height="6" x="9" y="9" rx="1"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/></svg>`,
  "file-input": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 22h14a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v4"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M2 15h10"/><path d="m9 18 3-3-3-3"/></svg>`,
  "pen-line": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
  "log-in": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" x2="3" y1="12" y2="12"/></svg>`
};

function renderIcons(scope) {
  const els = (scope || document).querySelectorAll('i[data-lucide]');
  els.forEach((el) => {
    const iconName = el.getAttribute('data-lucide');
    const svgStr = LUCIDE_ICONS[iconName];
    if (!svgStr) return;
    const holder = document.createElement('div');
    holder.innerHTML = svgStr;
    const node = holder.firstChild;
    for (let i = 0; i < el.attributes.length; i++) {
      const a = el.attributes[i];
      if (a.name === 'data-lucide') continue;
      node.setAttribute(a.name, a.value);
    }
    if (!node.getAttribute('width') && (!node.style || !node.style.width)) {
      node.setAttribute('width', '16');
    }
    if (!node.getAttribute('height') && (!node.style || !node.style.height)) {
      node.setAttribute('height', '16');
    }
    el.parentNode.replaceChild(node, el);
  });
}

document.addEventListener('DOMContentLoaded', init);
