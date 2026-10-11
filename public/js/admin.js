const safeStorage = {
  get: (key) => { try { return window.localStorage.getItem(key); } catch { return null; } },
  set: (key, value) => { try { window.localStorage.setItem(key, value); } catch {} },
  remove: (key) => { try { window.localStorage.removeItem(key); } catch {} },
};
let adminToken = safeStorage.get('admin_token') || '';
let contests = [];
let currentEditingId = null;
let currentMaterials = [];
let currentOfficialTestData = null;
let overviewRequestSerial = 0;
let overviewAbortController = null;

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value || '').replace(/[&<>"']/g, (ch) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[ch]));
const collectorApi = (path) => (
  window.location.pathname.startsWith('/csp-collector')
    ? `/csp-collector/api${path}`
    : `api${path}`
);

function toast(type, msg) {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerText = msg;
  $('toast-box').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .3s';
    setTimeout(() => el.remove(), 320);
  }, 4000);
}

function closeModal(id) { $(id).classList.remove('show'); }

// 渲染顶部官方管理员徽章
function showOfficialAdminBadge(user) {
  const container = document.getElementById('topbar-actions');
  if (!container) return;
  const existing = document.getElementById('official-admin-badge');
  if (existing) existing.remove();

  const badge = document.createElement('div');
  badge.id = 'official-admin-badge';
  badge.style.display = 'inline-flex';
  badge.style.alignItems = 'center';
  badge.style.gap = '6px';
  badge.style.padding = '4px 10px';
  badge.style.background = '#f0fdf4';
  badge.style.border = '1px solid #bbf7d0';
  badge.style.borderRadius = '9999px';
  badge.style.fontSize = '12px';
  badge.style.color = '#15803d';
  badge.style.fontWeight = '600';

  const roleText = user.is_superadmin
    ? '超级管理员'
    : ((user.role_names || []).join(' / ') || '官方教师');
  const orgText = (user.organizations || []).map((org) => org.name).filter(Boolean).join(' / ');
  const scopeText = orgText ? ` · ${orgText}` : '';
  badge.innerHTML = `<span style="color:#16a34a;">●</span> 官方已认证: ${user.name || user.username} (${roleText}${scopeText})`;
  container.prepend(badge);
}

// 官网管理员跳转登录
function loginWithOfficial() {
  const currentPath = window.location.pathname + window.location.search;
  window.location.href = "https://open.moblm.com/auth/login?redirect=" + encodeURIComponent(currentPath);
}

// 统一数据加载
async function loadAdminContestsData() {
  const res = await fetch('api/admin/contests', {
    credentials: 'same-origin', headers: { 'x-admin-token': adminToken }
  });
  if (res.ok) {
    const data = await res.json();
    const items = data.items || data.contests || [];
    contests = items.map((item) => {
      const config = item.draft || item.published || { id: item.id, title: item.id, problems: [] };
      return { ...config, _meta: item };
    });
    renderContestsGrid();
    initOverviewSelect();
    return true;
  }
  return false;
}

// 验证登录（支持官方系统管理员免密穿透与独立密钥双轨运行）
async function checkAuth() {
  // 1. 优先尝试与官方系统管理员身份免密绑定
  try {
    const offRes = await fetch('api/admin/check-official', { credentials: 'same-origin' });
    if (offRes.ok) {
      const offData = await offRes.json();
      if (offData.is_official_admin) {
        // SSO 请求直接携带 LH_access，不在浏览器保存或回传管理密钥。
        adminToken = '';
        safeStorage.remove('admin_token');
        showOfficialAdminBadge(offData.user);
        $('modal-login').classList.remove('show');
        toast('ok', "欢迎回来，官方管理员 " + (offData.user.name || offData.user.username) + "！已自动授权进入考务控制台。");
        await loadAdminContestsData();
        return true;
      } else if (offData.user) {
        const desc = $('official-status-desc');
        if (desc) {
          desc.innerHTML = `<span style="color:#e11d48;font-weight:700;">当前官网账号「${offData.user.name || offData.user.username}」非管理员</span><br>请切换官方管理员账号，或在下方输入考务应急密钥。`;
        }
      }
    }
  } catch (e) {
    console.warn('检查官方管理员身份异常:', e);
  }

  // 2. 如果存在保存的 admin_token，尝试使用 token 验证
  if (adminToken) {
    try {
      const ok = await loadAdminContestsData();
      if (ok) {
        $('modal-login').classList.remove('show');
        return true;
      }
    } catch (e) {}
  }

  // 3. 既非官方管理员也未输入有效口令，显示登录弹窗
  adminToken = '';
  safeStorage.remove('admin_token');
  $('modal-login').classList.add('show');
  renderIcons();
  return false;
}

async function doAdminLogin() {
  const secret = $('admin-secret-input').value.trim();
  if (!secret) return toast('err', '请输入密码！');
  try {
    const res = await fetch('api/admin/login', {
      method: 'POST',
      credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      adminToken = data.token;
      safeStorage.set('admin_token', adminToken);
      $('modal-login').classList.remove('show');
      toast('ok', '口令验证成功！');
      checkAuth();
    } else {
      toast('err', data.error || '管理口令错误！');
    }
  } catch (e) {
    toast('err', '请求出错: ' + e.message);
  }
}

function logoutAdmin() {
  safeStorage.remove('admin_token');
  document.cookie = "admin_token=; Max-Age=0; path=/;";
  location.reload();
}

// 渲染比赛卡片
function renderContestsGrid() {
  const container = $('contests-grid');
  container.innerHTML = '';

  contests.forEach(c => {
    const meta = c._meta || {};
    const isDraft = meta.status === 'draft';
    const isArchived = meta.status === 'archived' || c.archived;
    const statusLabel = isArchived ? '已归档' : isDraft ? '● 草稿未发布' : c.is_active ? '● 当前默认激活' : '已发布';
    const card = document.createElement('div');
    card.className = `contest-card ${c.is_active && !isDraft ? 'active-c' : ''}`;
    
    card.innerHTML = `
      <div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <span class="c-badge ${c.is_active && !isDraft ? 'active' : ''}">${statusLabel}</span>
          <span style="font-size:11px;color:var(--text-3);font-family:'JetBrains Mono',monospace;">ID: ${c.id}</span>
        </div>
        <h4 style="font-size:14px;font-weight:600;color:var(--text-main);margin-bottom:4px;">${c.title}</h4>
        <div style="font-size:12px;color:var(--text-2);margin-bottom:8px;">
          类别: <b>${c.category || '机考'}</b> ｜ 题数: <b>${(c.problems || []).length} 题</b> ｜ 考点: <b>${c.school || '默认'}</b>
        </div>
        <div style="font-size:11.5px;color:var(--text-3);">
          结束时间: ${c.contest_end || '无限制'}
        </div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;border-top:1px solid var(--border);padding-top:10px;">
        <div>
          ${isDraft ? `<button class="btn btn-brand btn-sm" onclick="publishContest('${c.id}')"><i data-lucide="upload"></i> 发布草稿</button>` : isArchived ? `<button class="btn btn-brand btn-sm" onclick="reopenContest('${c.id}')"><i data-lucide="refresh-cw"></i> 重启比赛</button>` : !c.is_active ? `<button class="btn btn-outline btn-sm" onclick="setActiveContest('${c.id}')"><i data-lucide="check"></i> 设为激活</button>` : '<span style="font-size:12px;color:var(--success);font-weight:700;">正在生效中</span>'}
        </div>
        <div style="display:flex;gap:6px;">
          <button class="btn btn-outline btn-sm" onclick="editContest('${c.id}')"><i data-lucide="settings"></i> 编辑配置</button>
          ${!isArchived ? `<button class="btn btn-outline btn-sm" style="color:var(--danger);" onclick="deleteContest('${c.id}')"><i data-lucide="archive"></i> 归档</button>` : ''}
          <button class="btn btn-outline btn-sm" style="color:var(--danger);" onclick="permanentDeleteContest('${c.id}')"><i data-lucide="trash"></i> 永久删除</button>
        </div>
      </div>
    `;
    container.appendChild(card);
  });
  renderIcons();
}

async function setActiveContest(id) {
  try {
    const res = await fetch(`api/admin/contests/${encodeURIComponent(id)}/activate`, {
      method: 'POST',
      credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
      body: '{}'
    });
    const d = await res.json();
    if (d.success) {
      toast('ok', d.message);
      checkAuth();
    } else toast('err', d.error);
  } catch (e) { toast('err', e.message); }
}

async function deleteContest(id) {
  if (!confirm(`确定要归档比赛 [${id}] 吗？学生端将隐藏，但历史和提交数据会保留。`)) return;
  try {
    const res = await fetch(`api/admin/contests/${encodeURIComponent(id)}/archive`, {
      method: 'POST',
      credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
      body: '{}'
    });
    const d = await res.json();
    if (d.success) {
      toast('ok', d.message);
      checkAuth();
    } else toast('err', d.error);
  } catch (e) { toast('err', e.message); }
}

async function publishContest(id) {
  const c = contests.find((item) => item.id === id);
  const expectedRevision = c?._meta?.revision ?? 0;
  if (!confirm(`发布比赛 [${id}]？发布后学生端将看到这版比赛和题目。`)) return;
  try {
    const res = await fetch(`api/admin/contests/${encodeURIComponent(id)}/publish`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
      body: JSON.stringify({ activate: false, expected_revision: expectedRevision })
    });
    const data = await res.json();
    if (data.success) { toast('ok', data.message); checkAuth(); }
    else toast('err', data.error || '发布失败');
  } catch (e) { toast('err', e.message); }
}

async function reopenContest(id) {
  if (!confirm(`重启比赛 [${id}]？比赛将重新出现在学生端。`)) return;
  const res = await fetch(`api/admin/contests/${encodeURIComponent(id)}/reopen`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
    body: JSON.stringify({ activate: false })
  });
  const data = await res.json();
  if (data.success) { toast('ok', data.message); checkAuth(); }
  else toast('err', data.error || '重启失败');
}

async function permanentDeleteContest(id) {
  if (!confirm(`永久删除比赛 [${id}]？将同时删除历史、PDF资料和所有学生提交代码，无法恢复。`)) return;
  const res = await fetch(`api/admin/contests/${encodeURIComponent(id)}?confirm=${encodeURIComponent(id)}`, {
    method: 'DELETE', credentials: 'same-origin',
    headers: { 'x-admin-token': adminToken }
  });
  const data = await res.json();
  if (data.success) { toast('ok', data.message); checkAuth(); }
  else toast('err', data.error || '删除失败');
}

// 初始化考情下拉框
function initOverviewSelect() {
  const sel = $('overview-contest-select');
  const previousContestId = sel.value;
  sel.innerHTML = '<option value="">选择比赛查看实时考情...</option>';
  const publishedContests = contests
    .map((contest) => contest._meta?.published)
    .filter((contest) => contest && !contest.archived);

  publishedContests.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.innerText = `${c.short_title || c.title} (${c.id})`;
    if (c.id === previousContestId || (!previousContestId && c.is_active)) opt.selected = true;
    sel.appendChild(opt);
  });
  loadSubmissionsOverview(sel.value);
}

async function loadSubmissionsOverview(contestId) {
  const tbody = $('overview-tbody');
  overviewRequestSerial++;
  const requestSerial = overviewRequestSerial;
  if (overviewAbortController) overviewAbortController.abort();
  overviewAbortController = null;

  if (!contestId) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-3);padding:24px;">请选择上方比赛查看实时考情。</td></tr>';
    return;
  }

  overviewAbortController = new AbortController();
  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:16px;">正在拉取实时数据...</td></tr>';
  try {
    const res = await fetch(`api/admin/submissions/overview?contest=${encodeURIComponent(contestId)}`, {
      credentials: 'same-origin',
      headers: { 'x-admin-token': adminToken },
      signal: overviewAbortController.signal
    });
    const data = await res.json().catch(() => ({}));
    if (requestSerial !== overviewRequestSerial || $('overview-contest-select').value !== contestId) return;
    if (!res.ok || !data.success) {
      throw new Error(data.error || `加载失败（HTTP ${res.status}）`);
    }
    if (data.contest_id !== contestId) {
      throw new Error('返回的比赛数据与当前选择不一致，请重新选择比赛');
    }
    if (!Array.isArray(data.students) || data.students.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-3);padding:24px;">暂无考生提交记录。</td></tr>';
      return;
    }
    tbody.innerHTML = '';
    data.students.forEach(s => {
      const tr = document.createElement('tr');
      const probBadges = Object.keys(s.problems).map(pCode => {
        const p = s.problems[pCode];
        return p.status === 'uploaded'
          ? `<span class="pill pill-ok" style="margin-right:4px;">${escapeHtml(pCode)} (${escapeHtml(p.size)})</span>`
          : `<span class="pill pill-pending" style="margin-right:4px;">${escapeHtml(pCode)} (未交)</span>`;
      }).join('');

      tr.innerHTML = `
        <td style="font-weight:600;">${escapeHtml(s.username)}</td>
        <td><span class="mono">${escapeHtml(s.seat)}</span></td>
        <td><b>${s.total_submitted}</b> 题</td>
        <td>${s.is_locked ? '<span class="pill pill-ok">已锁定交卷</span>' : '<span class="pill pill-pending">作答中</span>'}</td>
        <td>${probBadges}</td>
        <td><button class="btn btn-outline btn-sm" onclick="downloadStudentCode('${data.contest_id}', '${encodeURIComponent(s.username)}')"><i data-lucide="download"></i> 下载代码</button></td>
      `;
      tbody.appendChild(tr);
    });
    renderIcons(tbody);
  } catch (e) {
    if (e.name === 'AbortError' || requestSerial !== overviewRequestSerial) return;
    tbody.innerHTML = `<tr><td colspan="6" style="color:red;padding:16px;">加载失败：${escapeHtml(e.message)}</td></tr>`;
  } finally {
    if (requestSerial === overviewRequestSerial) overviewAbortController = null;
  }
}

function exportEvaluationZip() {
  const contestId = $('overview-contest-select').value;
  if (!contestId) return toast('err', '请先选择需要导出的比赛！');
  downloadZip(`api/admin/export/${encodeURIComponent(contestId)}?admin_token=${encodeURIComponent(adminToken)}`, `${contestId}_evaluation_package.zip`);
}

function downloadStudentCode(contestId, encodedStudent) {
  if (!contestId || $('overview-contest-select').value !== contestId) {
    return toast('err', '比赛已切换，请等待当前比赛数据加载完成！');
  }
  downloadZip(`api/admin/export/${encodeURIComponent(contestId)}/student/${encodedStudent}?admin_token=${encodeURIComponent(adminToken)}`, `${contestId}_student_code.zip`);
}

async function downloadZip(url, filename) {
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok || !contentType.includes('application/zip')) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `导出失败（HTTP ${res.status}）`);
    }
    const blob = await res.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  } catch (e) {
    toast('err', e.message || '导出失败');
  }
}

// 题目动态表单
let problemFormList = [];
let questionBankItems = [];
let questionBankLoaded = false;
let selectedQuestionBankIds = new Set();
let visibleQuestionBankItems = [];

function openCreateContestModal() {
  currentEditingId = null;
  $('contest-modal-title').innerText = '创建新比赛';
  $('c-id').value = '';
  $('c-id').disabled = false;
  $('c-category').value = '信奥复赛 (C++)';
  $('c-title').value = '';
  $('c-short-title').value = '';
  $('c-school').value = '河南 · 大中信奥';
  $('c-start').value = new Date().toISOString().slice(0, 10) + ' 09:00:00';
  $('c-end').value = new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10) + ' 13:00:00';
  $('c-notice').value = '1. 提交文件严禁为空文件（0 字节）。\n2. 请确认代码已正确开启 freopen 且文件名拼写完全准确。';
  
  problemFormList = [
    { num: 1, name: '第一题', code: 'p1', allowed_exts: ['.cpp'], template_code: '', rules: { freopen_check: true, return_0_check: true, forbidden_headers: true, max_file_size_mb: 5 } }
  ];
  renderMaterialsList([]);
  renderOfficialTestData(null);
  renderProblemRows();
  $('modal-contest').classList.add('show');
}

function editContest(id) {
  const c = contests.find(item => item.id === id);
  if (!c) return;
  currentEditingId = id;
  $('contest-modal-title').innerText = `编辑比赛：${c.title}`;
  $('c-id').value = c.id;
  $('c-id').disabled = true;
  $('c-category').value = c.category || '';
  $('c-title').value = c.title || '';
  $('c-short-title').value = c.short_title || '';
  $('c-school').value = c.school || '';
  $('c-start').value = c.contest_start || '';
  $('c-end').value = c.contest_end || '';
  $('c-notice').value = c.alert_notice || '';

  problemFormList = JSON.parse(JSON.stringify(c.problems || []));
  renderMaterialsList(c.materials || []);
  renderOfficialTestData(c.official_test_data || null);
  renderProblemRows();
  $('modal-contest').classList.add('show');
}

function renderMaterialsList(materials) {
  currentMaterials = Array.isArray(materials) ? materials : [];
  const list = $('materials-list');
  if (!list) return;
  if (currentMaterials.length === 0) {
    list.innerText = '尚未上传比赛资料。';
    return;
  }
  list.innerHTML = currentMaterials.map((item) =>
    `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;">
      <span>📄 ${escapeHtml(item.file_extension === '.zip' ? 'ZIP' : 'PDF')} · ${escapeHtml(item.name || item.filename)}（${item.size ? Math.round(item.size / 1024) + ' KB' : '未知大小'}）</span>
      <button type="button" class="btn btn-outline btn-sm" onclick="removeContestMaterial('${item.id}')">移除</button>
    </div>`
  ).join('');
}

function renderOfficialTestData(testData) {
  currentOfficialTestData = testData || null;
  const box = $('test-data-status');
  if (!box) return;
  if (!currentOfficialTestData) {
    box.innerText = '尚未上传官方测试数据。';
    return;
  }
  const problemSummary = Object.entries(currentOfficialTestData.problems || {})
    .map(([code, item]) => `${code}: ${item.test_count} 个测试点`)
    .join('；');
  box.innerHTML = `<span style="color:var(--success);font-weight:600;">已解析并保存（发布后学生可下载）</span> · ${escapeHtml(currentOfficialTestData.filename || '测试数据 ZIP')} · 共 ${currentOfficialTestData.total_tests || 0} 个测试点<br><span style="color:var(--text-3);">${escapeHtml(problemSummary || '暂无题目映射')}</span>`;
}

async function uploadContestPdf() {
  if (!currentEditingId) {
    return saveContestForm(true);
  }
  return uploadSelectedPdf();
}

async function uploadSelectedPdf() {
  const input = $('c-pdf');
  const file = input && input.files && input.files[0];
  if (!file) return toast('err', '请选择 PDF 文件。');
  const form = new FormData();
  form.append('pdf', file);
  form.append('name', file.name);
  try {
    const res = await fetch(`/csp-collector/api/admin/contests/${encodeURIComponent(currentEditingId)}/materials`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'x-admin-token': adminToken },
      body: form
    });
    const data = await res.json();
    if (!res.ok || !data.success) return toast('err', data.error || 'PDF 上传失败');
    currentMaterials = [...currentMaterials, data.material];
    renderMaterialsList(currentMaterials);
    input.value = '';
    toast('ok', data.message);
    return true;
  } catch (e) {
    toast('err', e.message || 'PDF 上传失败');
    return false;
  }
}

async function uploadContestZipMaterial() {
  if (!currentEditingId) return saveContestForm(true);
  return uploadSelectedZipMaterial();
}

async function uploadSelectedZipMaterial() {
  const input = $('c-zip-material');
  const file = input && input.files && input.files[0];
  if (!file) return toast('err', '请选择 ZIP 资料文件。');
  const form = new FormData();
  form.append('zip', file);
  form.append('name', file.name);
  try {
    const res = await fetch(collectorApi(`/admin/contests/${encodeURIComponent(currentEditingId)}/materials/zip`), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'x-admin-token': adminToken },
      body: form
    });
    const data = await res.json();
    if (!res.ok || !data.success) return toast('err', data.error || 'ZIP 资料上传失败');
    currentMaterials = [...currentMaterials, data.material];
    renderMaterialsList(currentMaterials);
    input.value = '';
    toast('ok', data.message);
    return true;
  } catch (e) {
    toast('err', e.message || 'ZIP 资料上传失败');
    return false;
  }
}

async function uploadOfficialTestData() {
  if (!currentEditingId) {
    const savedId = await saveContestForm(true);
    if (!savedId) return;
  }
  const input = $('c-test-zip');
  const file = input && input.files && input.files[0];
  if (!file) return toast('err', '请选择比赛测试数据 ZIP 文件。');
  const form = new FormData();
  form.append('test_zip', file);
  try {
    const res = await fetch(collectorApi(`/admin/contests/${encodeURIComponent(currentEditingId)}/test-data`), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'x-admin-token': adminToken },
      body: form
    });
    const data = await res.json();
    if (!res.ok || !data.success) return toast('err', data.error || '测试数据解析失败');
    renderOfficialTestData(data.official_test_data);
    input.value = '';
    toast('ok', data.message || '官方测试数据已保存');
    return true;
  } catch (e) {
    toast('err', e.message || '测试数据上传失败');
    return false;
  }
}

async function removeContestMaterial(materialId) {
  if (!currentEditingId || !confirm('确定移除这份比赛资料吗？')) return;
  const res = await fetch(`/csp-collector/api/admin/contests/${encodeURIComponent(currentEditingId)}/materials/${encodeURIComponent(materialId)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
    headers: { 'x-admin-token': adminToken }
  });
  const data = await res.json();
  if (!res.ok || !data.success) return toast('err', data.error || '移除失败');
  currentMaterials = currentMaterials.filter((item) => item.id !== materialId);
  renderMaterialsList(currentMaterials);
  toast('ok', data.message);
}

function addProblemRow() {
  const nextNum = problemFormList.length + 1;
  problemFormList.push({
    num: nextNum,
    name: `第 ${nextNum} 题`,
    code: `p${nextNum}`,
    allowed_exts: ['.cpp'],
    template_code: '',
    statement: '',
    rules: { freopen_check: false, return_0_check: false, forbidden_headers: false, max_file_size_mb: 5 }
  });
  renderProblemRows();
}

function removeProblemRow(index) {
  problemFormList.splice(index, 1);
  renderProblemRows();
}

async function openQuestionBankPicker() {
  selectedQuestionBankIds = new Set();
  $('qbank-search').value = '';
  if (!questionBankLoaded) {
    try {
      const res = await fetch('api/admin/question-bank', {
        credentials: 'same-origin',
        headers: { 'x-admin-token': adminToken }
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        return toast('err', data.error || '教师题库加载失败');
      }
      questionBankItems = Array.isArray(data.items) ? data.items : [];
      questionBankLoaded = true;
    } catch (e) {
      return toast('err', e.message || '教师题库加载失败');
    }
  }

  const filter = $('qbank-paper-filter');
  const selectedFilter = filter.value;
  const papers = [...new Map(questionBankItems.map((item) => [
    item.source_paper_id,
    `${item.group} · ${item.volume}`
  ])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'zh-CN'));
  filter.innerHTML = '<option value="">全部题目</option>' + papers
    .map(([id, label]) => `<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`)
    .join('');
  if (papers.some(([id]) => id === selectedFilter)) filter.value = selectedFilter;

  renderQuestionBankPicker();
  $('modal-question-bank').classList.add('show');
}

function renderQuestionBankPicker() {
  const query = String($('qbank-search')?.value || '').trim().toLocaleLowerCase();
  const paperId = $('qbank-paper-filter')?.value || '';
  visibleQuestionBankItems = questionBankItems.filter((item) => {
    if (paperId && item.source_paper_id !== paperId) return false;
    if (!query) return true;
    return `${item.title} ${item.code} ${item.group} ${item.volume} ${item.statement}`
      .toLocaleLowerCase().includes(query);
  });

  const results = $('qbank-results');
  if (!visibleQuestionBankItems.length) {
    results.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-3);">没有匹配的题目。</div>';
  } else {
    results.innerHTML = visibleQuestionBankItems.map((item) => `
      <div class="qbank-row">
        <div class="qbank-row-head">
          <input type="checkbox" id="qbank-${escapeHtml(item.id)}" value="${escapeHtml(item.id)}"
            ${selectedQuestionBankIds.has(item.id) ? 'checked' : ''}
            onchange="toggleQuestionBankItem('${escapeHtml(item.id)}', this.checked)">
          <div style="flex:1;min-width:0;">
            <label class="qbank-row-title" for="qbank-${escapeHtml(item.id)}">${escapeHtml(item.title)} <span style="font-family:'JetBrains Mono',monospace;">(${escapeHtml(item.code)})</span></label>
            <div class="qbank-row-meta">${escapeHtml(item.group)} · ${escapeHtml(item.volume)}</div>
            <details style="margin-top:6px;">
              <summary style="font-size:12px;color:var(--primary);cursor:pointer;">预览题面</summary>
              <pre class="qbank-statement">${escapeHtml(item.statement)}</pre>
            </details>
          </div>
        </div>
      </div>
    `).join('');
  }
  $('qbank-selected-count').innerText = `已选 ${selectedQuestionBankIds.size} 题`;
}

function toggleQuestionBankItem(id, checked) {
  if (checked) selectedQuestionBankIds.add(id);
  else selectedQuestionBankIds.delete(id);
  $('qbank-selected-count').innerText = `已选 ${selectedQuestionBankIds.size} 题`;
}

function toggleVisibleQuestionBankItems() {
  const allSelected = visibleQuestionBankItems.length > 0
    && visibleQuestionBankItems.every((item) => selectedQuestionBankIds.has(item.id));
  visibleQuestionBankItems.forEach((item) => {
    if (allSelected) selectedQuestionBankIds.delete(item.id);
    else selectedQuestionBankIds.add(item.id);
  });
  renderQuestionBankPicker();
}

function addSelectedQuestionBankItems() {
  const selected = questionBankItems.filter((item) => selectedQuestionBankIds.has(item.id));
  if (!selected.length) return toast('err', '请先选择题目。');

  if (
    problemFormList.length === 1
    && problemFormList[0].name === '第一题'
    && problemFormList[0].code === 'p1'
    && !problemFormList[0].statement
    && !problemFormList[0].template_code
  ) {
    problemFormList = [];
  }
  const existingIds = new Set(problemFormList.map((problem) => problem.question_bank_id).filter(Boolean));
  const existingCodes = new Set(problemFormList.map((problem) => String(problem.code || '').toLowerCase()));
  const added = [];
  const duplicates = [];
  selected.forEach((item) => {
    if (existingIds.has(item.id) || existingCodes.has(item.code.toLowerCase())) {
      duplicates.push(item.title);
      return;
    }
    const nextNum = Math.max(0, ...problemFormList.map((problem) => Number(problem.num) || 0)) + 1;
    const problem = {
      num: nextNum,
      name: item.title,
      code: item.code,
      question_bank_id: item.id,
      statement: item.statement,
      allowed_exts: [...(item.allowed_exts || ['.cpp'])],
      file_type_desc: item.file_type_desc || (item.allowed_exts || ['.cpp']).join('/'),
      template_code: item.template_code || '',
      rules: JSON.parse(JSON.stringify(item.rules || {}))
    };
    problemFormList.push(problem);
    existingIds.add(item.id);
    existingCodes.add(item.code.toLowerCase());
    added.push(problem);
  });

  renderProblemRows();
  closeModal('modal-question-bank');
  if (added.length) toast('ok', `已添加 ${added.length} 道题目。`);
  if (duplicates.length) toast('err', `以下题目已在本场比赛中，已跳过：${duplicates.join('、')}`);
}

function renderProblemRows() {
  const container = $('problems-container');
  container.innerHTML = '';

  problemFormList.forEach((p, idx) => {
    const box = document.createElement('div');
    box.className = 'problem-box';
    box.innerHTML = `
      <div class="prob-head">
        <span class="prob-title">题目 #${idx + 1}</span>
        ${problemFormList.length > 1 ? `<button type="button" class="prob-del-btn" onclick="removeProblemRow(${idx})"><i data-lucide="x"></i> 删除此题</button>` : ''}
      </div>
      <div class="flex-row">
        <div class="form-group flex-1">
          <label>题号序号</label>
          <input type="number" class="form-control" value="${escapeHtml(p.num || (idx + 1))}" onchange="problemFormList[${idx}].num=parseInt(this.value)">
        </div>
        <div class="form-group flex-1">
          <label>题目中文名 *</label>
          <input type="text" class="form-control" value="${escapeHtml(p.name || '')}" placeholder="如 苹果, 快速排序" onchange="problemFormList[${idx}].name=this.value">
        </div>
        <div class="form-group flex-1">
          <label>英文代号/子目录名 (全小写) *</label>
          <input type="text" class="form-control" value="${escapeHtml(p.code || '')}" placeholder="如 apple, qsort" onchange="problemFormList[${idx}].code=this.value.toLowerCase()">
        </div>
      </div>

      <div class="flex-row">
        <div class="form-group flex-1">
          <label>允许上交文件类型 (逗号分隔扩展名，如 .cpp,.py 或 .zip) *</label>
          <input type="text" class="form-control" value="${escapeHtml((p.allowed_exts || []).join(','))}" placeholder=".cpp 或 .py,.zip" onchange="problemFormList[${idx}].allowed_exts=this.value.split(',').map(s=>s.trim()).filter(Boolean)">
        </div>
        <div class="form-group flex-1">
          <label>文件大小上限 (MB)</label>
          <input type="number" class="form-control" value="${(p.rules && p.rules.max_file_size_mb) || 5}" onchange="if(!problemFormList[${idx}].rules) problemFormList[${idx}].rules={}; problemFormList[${idx}].rules.max_file_size_mb=parseInt(this.value)">
        </div>
      </div>

      <div class="form-group">
        <label>合规检查策略开关</label>
        <div class="chk-group">
          <label><input type="checkbox" ${p.rules && p.rules.freopen_check ? 'checked' : ''} onchange="problemFormList[${idx}].rules.freopen_check=this.checked"> freopen 读写重定向检查</label>
          <label><input type="checkbox" ${p.rules && p.rules.return_0_check ? 'checked' : ''} onchange="problemFormList[${idx}].rules.return_0_check=this.checked"> return 0 正常退出检查</label>
          <label><input type="checkbox" ${p.rules && p.rules.forbidden_headers ? 'checked' : ''} onchange="problemFormList[${idx}].rules.forbidden_headers=this.checked"> Windows 独有头文件违规拦截</label>
        </div>
      </div>

      <div class="form-group" style="margin-bottom:0;">
        <label>在线作答代码模板 (可选，用于一键载入)</label>
        <textarea class="form-control" style="height:70px;font-family:'JetBrains Mono',monospace;font-size:12px;" placeholder="// 输入该题目的预设代码模板..." onchange="problemFormList[${idx}].template_code=this.value">${escapeHtml(p.template_code || '')}</textarea>
      </div>
      <details style="margin-top:10px;">
        <summary style="font-size:12px;color:var(--primary);cursor:pointer;">题面内容（比赛发布后学生可见）${p.question_bank_id ? ' · 来自教师题库' : ''}</summary>
        <textarea class="form-control problem-statement-editor" style="margin-top:8px;" aria-label="题面内容" placeholder="输入题目描述、输入输出格式和样例；教师题库选入的题目会自动带入题面。" onchange="problemFormList[${idx}].statement=this.value">${escapeHtml(p.statement || '')}</textarea>
      </details>
    `;
    container.appendChild(box);
  });
  renderIcons();
}

async function saveContestForm(keepOpen = false) {
  const id = $('c-id').value.trim();
  const title = $('c-title').value.trim();
  if (!id || !title) return toast('err', '请填写比赛 ID 和比赛全称！');

  const payload = {
    id,
    title,
    category: $('c-category').value.trim(),
    short_title: $('c-short-title').value.trim() || title,
    school: $('c-school').value.trim() || '大中信奥',
    contest_start: $('c-start').value.trim(),
    contest_end: $('c-end').value.trim(),
    alert_notice: $('c-notice').value.trim(),
    problems: problemFormList,
    is_active: false,
    expected_revision: currentEditingId
      ? (contests.find((c) => c.id === currentEditingId)?._meta?.revision ?? 0)
      : 0
  };

  try {
    const res = await fetch('api/admin/contest/save', {
      method: 'POST',
      credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
      body: JSON.stringify(payload)
    });
    const d = await res.json();
    if (d.success) {
      toast('ok', d.message || '草稿已保存，请在比赛卡片点击发布。');
      currentEditingId = id;
      $('c-id').disabled = true;
      if ($('c-pdf')?.files?.[0]) {
        const uploaded = await uploadSelectedPdf();
        if (!uploaded) return null;
      }
      if ($('c-zip-material')?.files?.[0]) {
        const uploaded = await uploadSelectedZipMaterial();
        if (!uploaded) return null;
      }
      if (!keepOpen) {
        closeModal('modal-contest');
        checkAuth();
      }
      return id;
    } else {
      toast('err', d.error || '保存失败');
      return null;
    }
  } catch (e) {
    toast('err', '请求出错: ' + e.message);
    return null;
  }
}

// 离线 Lucide 图标字典
const LUCIDE_ICONS = {
  "settings": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`,
  "sparkles": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/></svg>`,
  "list-checks": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/></svg>`,
  "hard-drives": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" x2="2" y1="12" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" x2="6.01" y1="16" y2="16"/><line x1="10" x2="10.01" y1="16" y2="16"/></svg>`,
  "file-text": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>`,
  "check": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
  "x": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
  "eye": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>`,
  "lock": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
  "check-circle-2": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/></svg>`,
  "upload": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M5 21h14"/></svg>`,
  "archive": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M5 6v14h14V6"/><path d="M9 10h6"/><path d="m4 3 1 3h14l1-3z"/></svg>`,
  "download": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>`,
  "refresh-cw": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/></svg>`,
  "trash": `<svg class="lucide" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6v14H5V6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>`
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

document.addEventListener('DOMContentLoaded', checkAuth);
