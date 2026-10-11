const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const archiver = require('archiver');
const { isOfficialAdmin, roleNames } = require('./adminAccess');

const app = express();
const PORT = process.env.PORT || 3456;
// 管理后台应优先使用官网 SSO；应急密钥必须显式配置，避免部署后存在通用默认口令。
const ADMIN_SECRET = String(process.env.ADMIN_SECRET || '').trim();
const DEV_AUTH_ENABLED = String(process.env.CODE_COLLECTOR_DEV_AUTH || '').toLowerCase() === 'true';
const DEV_STUDENT_USERNAME = String(process.env.CODE_COLLECTOR_DEV_USERNAME || 'demo_student').trim() || 'demo_student';
const DEV_STUDENT_NAME = String(process.env.CODE_COLLECTOR_DEV_NAME || '本地演示学员').trim() || '本地演示学员';

const LEGACY_DATA_DIR = path.join(__dirname, 'data');
const DATA_DIR = path.resolve(process.env.CODE_COLLECTOR_DATA_DIR || LEGACY_DATA_DIR);
const CONTESTS_FILE = path.join(DATA_DIR, 'contests.json');
const DRAFTS_FILE = path.join(DATA_DIR, 'contest-drafts.json');
const QUESTION_BANK_FILE = path.join(DATA_DIR, 'question-bank.json');
const HISTORY_DIR = path.join(DATA_DIR, 'contest-history');
const MATERIALS_DIR = path.join(DATA_DIR, 'materials');
const TEST_DATA_DIR = path.join(DATA_DIR, 'test-data');
const LOCKS_FILE = path.join(DATA_DIR, 'locks.json');
const SUBMISSIONS_DIR = path.join(DATA_DIR, 'submissions');
const TMP_UPLOADS_DIR = path.join(DATA_DIR, 'tmp_uploads');

function copyIfMissing(source, target) {
  if (!fs.existsSync(source) || fs.existsSync(target)) return;
  fs.cpSync(source, target, { recursive: true });
}

// 生产环境将数据放在仓库之外；首次启动时无损继承旧仓库内的数据。
fs.mkdirSync(DATA_DIR, { recursive: true });
if (DATA_DIR !== path.resolve(LEGACY_DATA_DIR)) {
  copyIfMissing(path.join(LEGACY_DATA_DIR, 'contests.json'), CONTESTS_FILE);
  copyIfMissing(path.join(LEGACY_DATA_DIR, 'locks.json'), LOCKS_FILE);
  copyIfMissing(path.join(LEGACY_DATA_DIR, 'question-bank.json'), QUESTION_BANK_FILE);
  copyIfMissing(path.join(LEGACY_DATA_DIR, 'submissions'), SUBMISSIONS_DIR);
}
fs.mkdirSync(SUBMISSIONS_DIR, { recursive: true });
fs.mkdirSync(TMP_UPLOADS_DIR, { recursive: true });
fs.mkdirSync(HISTORY_DIR, { recursive: true });
fs.mkdirSync(MATERIALS_DIR, { recursive: true });
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

app.use(cors());
app.use(cookieParser());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// 临时文件上传目录
const upload = multer({ dest: TMP_UPLOADS_DIR });

// 读取与写入配置帮助函数
function readContests() {
  try {
    return JSON.parse(fs.readFileSync(CONTESTS_FILE, 'utf-8'));
  } catch (e) {
    return [];
  }
}

function saveContests(contests) {
  fs.writeFileSync(CONTESTS_FILE, JSON.stringify(contests, null, 2), 'utf-8');
}

function readDrafts() {
  try {
    const value = JSON.parse(fs.readFileSync(DRAFTS_FILE, 'utf-8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (e) {
    return {};
  }
}

function saveDrafts(drafts) {
  fs.writeFileSync(DRAFTS_FILE, JSON.stringify(drafts, null, 2), 'utf-8');
}

function readQuestionBank() {
  try {
    const value = JSON.parse(fs.readFileSync(QUESTION_BANK_FILE, 'utf-8'));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function toQuestionBankItem(item) {
  return {
    id: String(item.id || ''),
    title: String(item.title || ''),
    code: String(item.code || ''),
    group: String(item.group || ''),
    volume: String(item.volume || ''),
    source_paper_id: String(item.source_paper_id || ''),
    statement: String(item.statement || ''),
    allowed_exts: Array.isArray(item.allowed_exts) ? item.allowed_exts : ['.cpp'],
    file_type_desc: String(item.file_type_desc || ''),
    template_code: String(item.template_code || ''),
    rules: {
      freopen_check: item.rules?.freopen_check === true,
      return_0_check: item.rules?.return_0_check === true,
      forbidden_headers: item.rules?.forbidden_headers === true,
      max_file_size_mb: Number(item.rules?.max_file_size_mb) || 5
    }
  };
}

function getMaterialExtension(material) {
  const candidate = String(material?.file_extension || path.extname(material?.filename || '')).toLowerCase();
  return candidate === '.zip' ? '.zip' : '.pdf';
}

function toPublicMaterial(material) {
  return {
    id: material.id,
    name: material.name,
    filename: material.filename,
    size: material.size,
    file_extension: getMaterialExtension(material)
  };
}

function normalizeContest(contest) {
  return {
    ...contest,
    revision: Number(contest.revision) || 1,
    updated_at: contest.updated_at || '1970-01-01T00:00:00.000Z',
    archived: contest.archived === true
  };
}

function writeHistory(contest, revision, action = 'publish') {
  const dir = path.join(HISTORY_DIR, contest.id);
  fs.mkdirSync(dir, { recursive: true });
  const snapshot = {
    ...normalizeContest(contest),
    revision,
    history_action: action,
    history_at: new Date().toISOString()
  };
  fs.writeFileSync(path.join(dir, `${revision}.json`), JSON.stringify(snapshot, null, 2), 'utf-8');
  return snapshot;
}

function readHistory(contestId) {
  const dir = path.join(HISTORY_DIR, contestId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => /^\d+\.json$/.test(name))
    .map((name) => {
      try {
        const item = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8'));
        return {
          revision: Number(item.revision) || Number(path.basename(name, '.json')),
          updated_at: item.updated_at || item.history_at,
          title: item.title,
          action: item.history_action || 'publish'
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.revision - a.revision);
}

// 将旧版 contests.json 视为 revision 1，首次启动时补齐可恢复历史。
for (const contest of readContests()) {
  const revision = Number(contest.revision) || 1;
  const historyFile = path.join(HISTORY_DIR, contest.id, `${revision}.json`);
  if (!fs.existsSync(historyFile)) writeHistory(contest, revision, 'migration');
}

function listSubmittedProblemCodes(contestId) {
  const contestDir = path.join(SUBMISSIONS_DIR, contestId);
  const codes = new Set();
  if (!fs.existsSync(contestDir)) return codes;
  for (const student of fs.readdirSync(contestDir)) {
    const studentDir = path.join(contestDir, student);
    if (!fs.statSync(studentDir).isDirectory()) continue;
    for (const code of fs.readdirSync(studentDir)) {
      const codeDir = path.join(studentDir, code);
      if (fs.statSync(codeDir).isDirectory() && fs.readdirSync(codeDir).some((f) => !f.startsWith('.'))) {
        codes.add(code);
      }
    }
  }
  return codes;
}

function validateContestConfig(contest) {
  const errors = [];
  const id = String(contest?.id || '').trim();
  const title = String(contest?.title || '').trim();
  if (!id) errors.push('比赛 ID 不能为空');
  if (id && !/^[a-z0-9_-]+$/.test(id)) errors.push('比赛 ID 只能包含小写字母、数字、短横线和下划线');
  if (!title) errors.push('比赛名称不能为空');
  const problems = Array.isArray(contest?.problems) ? contest.problems : [];
  const seen = new Set();
  for (const [index, problem] of problems.entries()) {
    const code = String(problem?.code || '').trim().toLowerCase();
    if (!String(problem?.name || '').trim()) errors.push(`第 ${index + 1} 题名称不能为空`);
    if (!code || !/^[a-z0-9_-]+$/.test(code)) errors.push(`第 ${index + 1} 题代号格式不正确`);
    if (seen.has(code)) errors.push(`题目代号重复：${code}`);
    seen.add(code);
    const exts = Array.isArray(problem?.allowed_exts) ? problem.allowed_exts : [];
    if (!exts.length || exts.some((ext) => !/^\.[a-z0-9]+$/.test(String(ext).trim().toLowerCase()))) {
      errors.push(`第 ${index + 1} 题文件扩展名格式不正确`);
    }
    const maxSize = Number(problem?.rules?.max_file_size_mb || 5);
    if (!Number.isFinite(maxSize) || maxSize <= 0) errors.push(`第 ${index + 1} 题文件大小上限必须大于 0`);
  }
  if (contest?.contest_start && contest?.contest_end) {
    const start = Date.parse(String(contest.contest_start).replace(' ', 'T'));
    const end = Date.parse(String(contest.contest_end).replace(' ', 'T'));
    if (Number.isFinite(start) && Number.isFinite(end) && start >= end) errors.push('比赛开始时间必须早于结束时间');
  }
  return errors;
}

function getPublishedContests() {
  return readContests().map(normalizeContest);
}

function readLocks() {
  try {
    return JSON.parse(fs.readFileSync(LOCKS_FILE, 'utf-8'));
  } catch (e) {
    return {};
  }
}

function saveLocks(locks) {
  fs.writeFileSync(LOCKS_FILE, JSON.stringify(locks, null, 2), 'utf-8');
}

function getActiveContest(contestId) {
  const contests = getPublishedContests().filter((c) => !c.archived);
  if (contestId) {
    const found = contests.find(c => c.id === contestId);
    if (found) return found;
  }
  return contests.find(c => c.is_active) || contests[0] || null;
}

function calcMd5(filePath) {
  if (!fs.existsSync(filePath)) return '-';
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('md5').update(buffer).digest('hex');
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const sizes = ['B', 'KB', 'MB', 'GB'];
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}

// 解析比赛测试数据 ZIP：提取 .in/.out 测试点，不执行 ZIP 内任何文件。
function parseOfficialTestZip(buffer, problemCodes = []) {
  const MAX_ENTRIES = 2000;
  const MAX_ENTRY_SIZE = 20 * 1024 * 1024;
  const MAX_TOTAL_SIZE = 300 * 1024 * 1024;
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0 || eocd + 22 > buffer.length) throw new Error('无效的 ZIP 文件');

  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('暂不支持 ZIP64 测试数据包');
  }
  if (entryCount > MAX_ENTRIES || centralOffset + centralSize > buffer.length) {
    throw new Error('ZIP 文件结构或文件数量超出限制');
  }

  const knownCodes = new Set((problemCodes || []).map((code) => String(code).trim().toLowerCase()));
  const grouped = {};
  let cursor = centralOffset;
  let totalUncompressed = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('ZIP 中央目录损坏');
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const rawName = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    cursor += 46 + nameLength + extraLength + commentLength;

    if (!rawName || rawName.endsWith('/')) continue;
    if ((flags & 0x1) !== 0 || (flags & 0x8) !== 0) {
      throw new Error(`不支持加密或数据描述符 ZIP 条目：${rawName}`);
    }
    const normalizedName = rawName.replaceAll('\\', '/');
    const parts = normalizedName.split('/').filter(Boolean);
    if (!parts.length || parts.some((part) => part === '..' || part.includes('\0')) || normalizedName.startsWith('/')) {
      throw new Error(`ZIP 包含不安全路径：${rawName}`);
    }
    const filename = parts[parts.length - 1];
    const extension = path.extname(filename).toLowerCase();
    if (!['.in', '.out'].includes(extension)) continue;
    if (uncompressedSize > MAX_ENTRY_SIZE || totalUncompressed + uncompressedSize > MAX_TOTAL_SIZE) {
      throw new Error('ZIP 测试数据解压后超过安全限制');
    }
    if (compressedSize > 0 && uncompressedSize / compressedSize > 1000) {
      throw new Error(`ZIP 压缩比异常，已拒绝条目：${rawName}`);
    }
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`ZIP 本地条目损坏：${rawName}`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataStart < 0 || dataEnd > buffer.length) throw new Error(`ZIP 数据越界：${rawName}`);
    let content;
    if (method === 0) content = buffer.subarray(dataStart, dataEnd);
    else if (method === 8) content = zlib.inflateRawSync(buffer.subarray(dataStart, dataEnd));
    else throw new Error(`不支持的压缩方式：${rawName}`);
    if (content.length !== uncompressedSize) throw new Error(`ZIP 大小校验失败：${rawName}`);
    totalUncompressed += content.length;

    const code = parts
      .slice(0, -1)
      .map((part) => part.toLowerCase())
      .find((part) => knownCodes.has(part)) || '';
    const baseName = path.basename(filename, extension);
    const targetCode = code || (knownCodes.size === 1 ? [...knownCodes][0] : '');
    if (!targetCode || !knownCodes.has(targetCode)) {
      throw new Error(`无法将测试文件映射到题目代号：${rawName}`);
    }
    grouped[targetCode] ||= {};
    grouped[targetCode][baseName] ||= {};
    grouped[targetCode][baseName][extension.slice(1)] = Buffer.from(content);
  }

  const problems = {};
  let totalTests = 0;
  for (const [code, tests] of Object.entries(grouped)) {
    const names = Object.keys(tests).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const normalized = [];
    for (const name of names) {
      const pair = tests[name];
      if (!pair.in || !pair.out) throw new Error(`题目 ${code} 的测试点 ${name} 缺少 .in 或 .out`);
      normalized.push({
        name,
        input: pair.in,
        output: pair.out,
        input_size: pair.in.length,
        output_size: pair.out.length
      });
    }
    if (!normalized.length) throw new Error(`题目 ${code} 未找到有效测试点`);
    problems[code] = { test_count: normalized.length, tests: normalized };
    totalTests += normalized.length;
  }
  if (!totalTests) throw new Error('ZIP 中未找到有效的 .in/.out 测试点');
  return { total_tests: totalTests, problems };
}

function storeOfficialTestData(contestId, parsed, originalZip) {
  const packageId = crypto.randomUUID();
  const packageDir = path.join(TEST_DATA_DIR, contestId, packageId);
  fs.mkdirSync(packageDir, { recursive: true });
  const metadata = { package_id: packageId, total_tests: parsed.total_tests, problems: {} };
  for (const [code, data] of Object.entries(parsed.problems)) {
    const problemDir = path.join(packageDir, code);
    fs.mkdirSync(problemDir, { recursive: true });
    metadata.problems[code] = { test_count: data.test_count, tests: [] };
    for (const test of data.tests) {
      const inputPath = path.join(problemDir, `${test.name}.in`);
      const outputPath = path.join(problemDir, `${test.name}.out`);
      fs.writeFileSync(inputPath, test.input);
      fs.writeFileSync(outputPath, test.output);
      metadata.problems[code].tests.push({
        name: test.name,
        input_size: test.input_size,
        output_size: test.output_size
      });
    }
  }
  // 保留原始包供已登录学员下载；历史包没有原始文件时由下载接口重建 .in/.out 包。
  fs.writeFileSync(path.join(packageDir, 'original.zip'), originalZip);
  return metadata;
}

function isSensitiveCredentialContent(filePath, buffer) {
  const ext = path.extname(filePath).toLowerCase();
  if (!['.json', '.txt', '.cpp', '.c', '.cc', '.cxx', '.py', '.js', '.ts', '.java'].includes(ext)) return false;
  const text = buffer.toString('utf8').trim();
  if (!text) return false;
  try {
    const value = JSON.parse(text);
    if (value && typeof value === 'object' && (value.installed || value.web || value.client_secret || value.private_key)) {
      return true;
    }
  } catch {}
  return /["']?(client_secret|private_key|access_token|refresh_token)["']?\s*[:=]/i.test(text);
}

function getSubmissionEntries(contest, studentDir) {
  const entries = [];
  for (const problem of contest.problems || []) {
    const problemDir = path.join(studentDir, problem.code);
    if (!fs.existsSync(problemDir)) continue;
    const allowed = (problem.allowed_exts || []).map((ext) => String(ext).toLowerCase());
    const files = fs.readdirSync(problemDir)
      .filter((name) => !name.startsWith('.'))
      .map((name) => ({ name, fullPath: path.join(problemDir, name) }))
      .filter(({ name }) => allowed.includes(path.extname(name).toLowerCase()) || allowed.includes('*'))
      .sort((a, b) => fs.statSync(b.fullPath).mtimeMs - fs.statSync(a.fullPath).mtimeMs);
    if (files[0]) entries.push({ problem, ...files[0] });
  }
  return entries;
}

// 官网真实账号 Session 校验与身份解析
async function getAuthenticatedUser(req) {
  // 仅允许显式开启、且请求来自本机的本地预览假登录，生产域名永远不会命中。
  if (
    DEV_AUTH_ENABLED
    && process.env.NODE_ENV !== 'production'
    && ['localhost', '127.0.0.1', '::1'].includes(String(req.hostname || '').toLowerCase())
  ) {
    return {
      authenticated: true,
      user: {
        uuid: 'dev-local-student',
        id: 'dev-local-student',
        username: DEV_STUDENT_USERNAME,
        name: DEV_STUDENT_NAME,
        email: 'demo_student@localhost'
      },
      identity: DEV_STUDENT_USERNAME
    };
  }

  // 1. 优先向 大中信奥编程教学系统 主站后端校验真实学员 Cookie (LH_access)
  const token = req.cookies && req.cookies['LH_access'];
  if (token) {
    try {
      const resp = await fetch('http://127.0.0.1:9000/api/v1/users/session', {
        headers: { 'Cookie': 'LH_access=' + token },
        signal: AbortSignal.timeout(3000)
      });
      if (resp.ok) {
        const data = await resp.json();
        const u = data.user || data;
        const displayName = [u.first_name, u.last_name].filter(Boolean).join('') || u.name || u.username || u.email || '官网学员';
        const raw = (u.username || u.email || u.user_uuid || u.uuid || 'user').trim().toLowerCase();
        const safe = raw.replace(/[^a-z0-9._-]/g, '_') || u.uuid;
        return {
          authenticated: true,
          user: {
            uuid: u.user_uuid || u.uuid || String(u.id || ''),
            id: u.id,
            username: u.username || '',
            name: displayName,
            email: u.email || ''
          },
          identity: safe
        };
      }
    } catch (e) {}
  }

  return { authenticated: false };
}

function authRequired(res, message = '请先登录官网账号') {
  return res.status(401).json({
    success: false,
    code: 'AUTH_REQUIRED',
    error: message
  });
}

/* ====================================================================
   公开业务 API
   ==================================================================== */

// 1. 官网 SSO 登录态检查
app.get('/api/me', async (req, res) => {
  const auth = await getAuthenticatedUser(req);
  res.json(auth);
});

// 2. 获取公开比赛列表
app.get('/api/contests', (req, res) => {
  const contests = getPublishedContests().filter((c) => !c.archived);
  const list = contests.map(c => ({
    id: c.id,
    title: c.title,
    short_title: c.short_title,
    school: c.school,
    category: c.category,
    contest_start: c.contest_start,
    contest_end: c.contest_end,
    is_active: !!c.is_active,
    problem_count: (c.problems || []).length,
    materials: (c.materials || []).map(toPublicMaterial),
    revision: c.revision,
    updated_at: c.updated_at
  }));
  res.json({ success: true, contests: list });
});

// 3. 考生提交状态查询
app.get('/api/submissions/status', async (req, res) => {
  const contest = getActiveContest(req.query.contest);
  if (!contest) {
    return res.status(404).json({ success: false, error: '未找到比赛' });
  }

  const auth = await getAuthenticatedUser(req);
  const locks = readLocks();
  const contestId = contest.id;

  // 未登录仍可浏览公开题目，但不返回任何模拟考生、模拟提交或个人文件信息。
  if (!auth.authenticated) {
    const problems = (contest.problems || []).map((p, idx) => ({
      num: p.num || (idx + 1),
      code: p.code,
      name: p.name,
      allowed_exts: p.allowed_exts || ['.cpp'],
      file_type_desc: p.file_type_desc || (p.allowed_exts || []).join('/'),
      statement: p.statement || '',
      status: 'login_required',
      filename: '登录后显示',
      size: '-',
      file_bytes: 0,
      md5: '-',
      submitted_at: '-'
    }));

    return res.json({
      contest_code: contest.id,
      contest_name: contest.title,
      contest_end: contest.contest_end,
      school: contest.school,
      alert_notice: contest.alert_notice,
      materials: (contest.materials || []).map(toPublicMaterial),
      identity: null,
      student_name: '登录后显示',
      account: '登录后显示',
      seat: '登录后显示',
      is_locked: false,
      authenticated: false,
      login_required: true,
      problems
    });
  }

  // 已登录状态，读取实际磁盘落盘文件
  const username = auth.user.username;
  const userDir = path.join(SUBMISSIONS_DIR, contestId, username);
  const lockKey = `${contestId}__${username}`;
  const isLocked = !!locks[lockKey];

  const problems = (contest.problems || []).map((p, idx) => {
    const probDir = path.join(userDir, p.code);
    let uploadedFile = null;
    let fileStats = null;
    let fileMd5 = '-';
    let submittedAt = '-';

    if (fs.existsSync(probDir)) {
      const files = fs.readdirSync(probDir).filter(f => !f.startsWith('.'));
      if (files.length > 0) {
        uploadedFile = files[0];
        const fullPath = path.join(probDir, uploadedFile);
        fileStats = fs.statSync(fullPath);
        fileMd5 = calcMd5(fullPath);
        const d = new Date(fileStats.mtime);
        submittedAt = d.toLocaleString('zh-CN', { hour12: false });
      }
    }

    return {
      num: p.num || (idx + 1),
      code: p.code,
      name: p.name,
      allowed_exts: p.allowed_exts || ['.cpp'],
      file_type_desc: p.file_type_desc || (p.allowed_exts || []).join('/'),
      statement: p.statement || '',
      status: uploadedFile ? 'uploaded' : 'pending',
      filename: uploadedFile || `${p.code}${p.allowed_exts[0] || '.cpp'}`,
      size: fileStats ? `${formatBytes(fileStats.size)} (${(fileStats.size / 1024).toFixed(1)} KB)` : '-',
      file_bytes: fileStats ? fileStats.size : 0,
      md5: fileMd5,
      submitted_at: submittedAt
    };
  });

  res.json({
    contest_code: contest.id,
    contest_name: contest.title,
    contest_end: contest.contest_end,
    school: contest.school,
    alert_notice: contest.alert_notice,
    materials: (contest.materials || []).map(toPublicMaterial),
    test_data: contest.official_test_data
      ? { filename: contest.official_test_data.filename, size: contest.official_test_data.size }
      : null,
    identity: auth.user.uuid,
    student_name: auth.user.name,
    account: auth.user.username,
    seat: 'LAB-' + (Math.abs(username.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0)) % 50 + 1).toString().padStart(2, '0'),
    is_locked: isLocked,
    authenticated: true,
    problems
  });
});

// 4. 获取题目模板（模板属于考务资料，需登录后访问）
app.get('/api/problem-template', async (req, res) => {
  const auth = await getAuthenticatedUser(req);
  if (!auth.authenticated) return authRequired(res);

  const { contest: contestId, problem: problemCode } = req.query;
  const contest = getActiveContest(contestId);
  if (!contest) return res.status(404).json({ error: '未找到比赛' });

  const problem = (contest.problems || []).find(p => p.code === problemCode);
  if (!problem) return res.status(404).json({ error: '未找到题目' });

  res.json({
    code: problem.code,
    name: problem.name,
    allowed_exts: problem.allowed_exts || ['.cpp'],
    template_code: problem.template_code || ''
  });
});

// 学生查看或下载已发布比赛的公开资料（PDF / 原始 ZIP）。
app.get('/api/contest-material/:contestId/:materialId', (req, res) => {
  const contest = getActiveContest(req.params.contestId);
  if (!contest || contest.id !== req.params.contestId) return res.status(404).send('比赛不存在');
  const material = (contest.materials || []).find((item) => item.id === req.params.materialId);
  if (!material) return res.status(404).send('资料不存在');
  const contestDir = path.resolve(MATERIALS_DIR, contest.id);
  const extension = getMaterialExtension(material);
  const filePath = path.resolve(contestDir, material.id + extension);
  if (!filePath.startsWith(`${contestDir}${path.sep}`) || !fs.existsSync(filePath)) {
    return res.status(404).send('资料文件不存在');
  }
  if (extension === '.zip') {
    return res.download(filePath, path.basename(material.filename || `${material.name || '比赛资料'}.zip`));
  }
  res.type('application/pdf').sendFile(filePath);
});

// 官方测试 ZIP 是公开练习资料：只有已登录学员能下载已发布比赛的完整原包。
app.get('/api/contest-test-data/:contestId', async (req, res) => {
  const auth = await getAuthenticatedUser(req);
  if (!auth.authenticated) return authRequired(res);
  const contest = getPublishedContests().find(
    (item) => !item.archived && item.id === req.params.contestId
  );
  const metadata = contest?.official_test_data;
  if (!metadata || !/^[0-9a-f-]{36}$/i.test(String(metadata.package_id || ''))) {
    return res.status(404).json({ success: false, error: '比赛测试数据不存在' });
  }
  const packageDir = path.join(TEST_DATA_DIR, contest.id, metadata.package_id);
  const originalZip = path.join(packageDir, 'original.zip');
  const downloadName = String(metadata.filename || 'contest-test-data.zip')
    .replace(/[/\\\r\n"]/g, '_');
  if (fs.existsSync(originalZip)) {
    return res.download(originalZip, downloadName);
  }
  // 老版本上传时只保存了提取后的测试点，按原目录重建完整的 .in/.out 数据包。
  if (!fs.existsSync(packageDir)) {
    return res.status(404).json({ success: false, error: '比赛测试数据文件不存在' });
  }
  const entries = [];
  for (const [code, problem] of Object.entries(metadata.problems || {})) {
    if (!/^[a-z0-9_-]+$/.test(code)) continue;
    for (const test of problem.tests || []) {
      if (!/^[a-zA-Z0-9_]+$/.test(String(test.name))) continue;
      for (const ext of ['in', 'out']) {
        const fullPath = path.join(packageDir, code, `${test.name}.${ext}`);
        if (fs.existsSync(fullPath)) entries.push({ fullPath, name: `${code}/${test.name}.${ext}` });
      }
    }
  }
  if (!entries.length) return res.status(404).json({ success: false, error: '比赛测试数据文件不存在' });
  res.attachment(downloadName);
  const archive = typeof archiver === 'function'
    ? archiver('zip')
    : new archiver.ZipArchive();
  archive.on('error', (error) => res.destroy(error));
  archive.pipe(res);
  entries.forEach(({ fullPath, name }) => archive.file(fullPath, { name }));
  archive.finalize();
});

// 5. 本地文件上传 (multipart/form-data)
app.post('/api/upload', upload.single('code_file'), async (req, res) => {
  const auth = await getAuthenticatedUser(req);
  if (!auth.authenticated) {
    if (req.file) fs.unlinkSync(req.file.path);
    return authRequired(res);
  }

  const { contest_id, problem_code } = req.body;
  const contest = getActiveContest(contest_id);
  if (!contest) {
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(404).json({ success: false, error: '比赛不存在' });
  }

  const username = auth.user.username;
  const locks = readLocks();
  if (locks[`${contest.id}__${username}`]) {
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(403).json({ success: false, error: '试卷已最终交卷封存，无法再修改或上传代码！' });
  }

  const problem = (contest.problems || []).find(p => p.code === problem_code);
  if (!problem) {
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(404).json({ success: false, error: '题目不存在' });
  }

  if (!req.file) {
    return res.status(400).json({ success: false, error: '未接收到上传文件！' });
  }

  if (req.file.size === 0) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ success: false, error: '严禁上传 0 字节空文件（防爆零守则）！' });
  }

  const origName = req.file.originalname;
  const ext = path.extname(origName).toLowerCase();
  const allowed = problem.allowed_exts.map(e => e.toLowerCase());

  if (!allowed.includes(ext) && !allowed.includes('*')) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({
      success: false,
      error: `文件类型不符合要求！本题仅允许上传 ${allowed.join(' / ')} 格式文件。`
    });
  }

  // 严格要求文件名：统一存为 problem_code + ext，符合 NOI / 比赛规范
  const targetFilename = `${problem.code}${ext}`;
  const targetDir = path.join(SUBMISSIONS_DIR, contest.id, username, problem.code);
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  const targetPath = path.join(targetDir, targetFilename);
  const uploadedBuffer = fs.readFileSync(req.file.path);
  if (isSensitiveCredentialContent(origName, uploadedBuffer)) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ success: false, code: 'SENSITIVE_CONTENT_DETECTED', error: '检测到疑似密钥或 OAuth 凭据，禁止上传。' });
  }
  for (const oldFile of fs.readdirSync(targetDir)) {
    if (!oldFile.startsWith('.')) fs.unlinkSync(path.join(targetDir, oldFile));
  }
  fs.copyFileSync(req.file.path, targetPath);
  fs.unlinkSync(req.file.path);

  const fileMd5 = calcMd5(targetPath);
  const fileStats = fs.statSync(targetPath);

  res.json({
    success: true,
    filename: targetFilename,
    size: fileStats.size,
    md5: fileMd5,
    message: '上传成功并完成真实物理磁盘落盘'
  });
});

// 6. 在线源码粘贴提交
app.post('/api/upload-text', async (req, res) => {
  const auth = await getAuthenticatedUser(req);
  if (!auth.authenticated) {
    return authRequired(res);
  }

  const { contest_id, problem_code, filename, code_text } = req.body;
  if (!code_text || !code_text.trim()) {
    return res.status(400).json({ success: false, error: '提交源码内容不能为空！' });
  }

  const contest = getActiveContest(contest_id);
  if (!contest) return res.status(404).json({ success: false, error: '比赛不存在' });

  const username = auth.user.username;
  const locks = readLocks();
  if (locks[`${contest.id}__${username}`]) {
    return res.status(403).json({ success: false, error: '试卷已最终交卷封存，无法再修改或提交代码！' });
  }

  const problem = (contest.problems || []).find(p => p.code === problem_code);
  if (!problem) return res.status(404).json({ success: false, error: '题目不存在' });

  const ext = (path.extname(filename || '') || problem.allowed_exts[0] || '.cpp').toLowerCase();
  const targetFilename = `${problem.code}${ext}`;
  const targetDir = path.join(SUBMISSIONS_DIR, contest.id, username, problem.code);
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  const targetPath = path.join(targetDir, targetFilename);
  if (isSensitiveCredentialContent(filename || targetFilename, Buffer.from(code_text, 'utf8'))) {
    return res.status(400).json({ success: false, code: 'SENSITIVE_CONTENT_DETECTED', error: '检测到疑似密钥或 OAuth 凭据，禁止提交。' });
  }
  for (const oldFile of fs.readdirSync(targetDir)) {
    if (!oldFile.startsWith('.')) fs.unlinkSync(path.join(targetDir, oldFile));
  }
  fs.writeFileSync(targetPath, code_text, 'utf-8');

  const fileMd5 = calcMd5(targetPath);
  const fileStats = fs.statSync(targetPath);

  res.json({
    success: true,
    filename: targetFilename,
    size: fileStats.size,
    md5: fileMd5,
    message: '在线代码提交成功并完成真实物理磁盘落盘'
  });
});

// 7. 查看代码与合规分析
app.get('/api/view-code/:problemCode', async (req, res) => {
  const auth = await getAuthenticatedUser(req);
  if (!auth.authenticated) {
    return authRequired(res);
  }

  const { problemCode } = req.params;
  const contest = getActiveContest(req.query.contest);
  if (!contest) return res.status(404).json({ success: false, error: '比赛不存在' });

  const username = auth.user.username;
  const probDir = path.join(SUBMISSIONS_DIR, contest.id, username, problemCode);

  if (!fs.existsSync(probDir)) {
    return res.status(404).json({ success: false, error: '该题目尚未提交代码！' });
  }

  const files = fs.readdirSync(probDir).filter(f => !f.startsWith('.'));
  if (files.length === 0) {
    return res.status(404).json({ success: false, error: '未找到提交的代码文件！' });
  }

  const filename = files[0];
  const filePath = path.join(probDir, filename);
  const ext = path.extname(filename).toLowerCase();
  const fileStats = fs.statSync(filePath);
  const md5 = calcMd5(filePath);

  // 判断是否为纯文本代码文件
  const textExts = ['.cpp', '.c', '.cc', '.cxx', '.h', '.hpp', '.py', '.java', '.txt', '.sql', '.js', '.ts', '.pas'];
  if (!textExts.includes(ext)) {
    return res.json({
      success: true,
      filename,
      is_binary: true,
      size: formatBytes(fileStats.size),
      md5,
      analysis: null,
      code: `[该文件为二进制/压缩包文件 (${ext})，文件大小 ${formatBytes(fileStats.size)}，MD5: ${md5}]`
    });
  }

  const code = fs.readFileSync(filePath, 'utf-8');

  // 静态代码合规扫描
  const hasFreopenIn = new RegExp(`freopen\\s*\\(\\s*["'].*${problemCode}\\.in["']`, 'i').test(code) || /freopen\s*\(\s*["'][^"']+\.in["']/i.test(code);
  const hasFreopenOut = new RegExp(`freopen\\s*\\(\\s*["'].*${problemCode}\\.out["']`, 'i').test(code) || /freopen\s*\(\s*["'][^"']+\.out["']/i.test(code);
  const hasReturn0 = /return\s+0\s*;/i.test(code);
  const hasForbiddenHeaders = /#\s*include\s*<s*(conio\.h|windows\.h|direct\.h|process\.h)>/i.test(code);

  res.json({
    success: true,
    filename,
    is_binary: false,
    code,
    size: formatBytes(fileStats.size),
    md5,
    analysis: {
      has_freopen_in: hasFreopenIn,
      has_freopen_out: hasFreopenOut,
      has_return_0: hasReturn0,
      has_forbidden_headers: hasForbiddenHeaders
    }
  });
});

// 8. 最终交卷锁定
app.post('/api/finalize', async (req, res) => {
  const auth = await getAuthenticatedUser(req);
  if (!auth.authenticated) {
    return authRequired(res);
  }

  const { contest_id } = req.body;
  const contest = getActiveContest(contest_id);
  if (!contest) return res.status(404).json({ success: false, error: '比赛不存在' });

  const username = auth.user.username;
  const locks = readLocks();
  const lockKey = `${contest.id}__${username}`;
  locks[lockKey] = {
    locked_at: new Date().toISOString(),
    user: username
  };
  saveLocks(locks);

  res.json({
    success: true,
    message: '交卷成功！您的代码已最终锁定封存，无法再修改。请前往监考老师处签字确认。'
  });
});

/* ====================================================================
   考务管理后台 API (Protected by ADMIN_SECRET & 官方系统管理员绑定)
   ==================================================================== */

// 提取并校验官方主站 Session
async function checkOfficialAdminSession(req) {
  let token = (req.cookies && req.cookies['LH_access']);
  if (!token && req.headers.cookie) {
    const pairs = req.headers.cookie.split(';');
    for (const p of pairs) {
      const idx = p.indexOf('=');
      if (idx > -1 && p.slice(0, idx).trim() === 'LH_access') {
        token = decodeURIComponent(p.slice(idx + 1).trim());
        break;
      }
    }
  }
  if (!token) return { isOfficialAdmin: false, reason: 'no_token' };

  try {
    const resp = await fetch('http://127.0.0.1:9000/api/v1/users/session', {
      headers: { 'Cookie': 'LH_access=' + token },
      signal: AbortSignal.timeout(3000)
    });
    if (!resp.ok) return { isOfficialAdmin: false, reason: 'invalid_session' };
    const sessionData = await resp.json();
    const user = sessionData.user || sessionData;
    const ok = isOfficialAdmin(sessionData);
    const organizations = (sessionData.roles || [])
      .map((r) => r && r.org)
      .filter(Boolean)
      .map((org) => ({
        id: org.id,
        uuid: org.org_uuid || org.uuid,
        slug: org.slug,
        name: org.name
      }));
    const displayName = [user.first_name, user.last_name].filter(Boolean).join('') || user.name || user.username || '官方管理员';
    return {
      isOfficialAdmin: ok,
      user: {
        id: user.id,
        uuid: user.user_uuid || user.uuid,
        username: user.username,
        name: displayName,
        is_superadmin: user.is_superadmin === true,
        role_names: roleNames(sessionData),
        organizations
      },
      raw: sessionData
    };
  } catch (err) {
    return { isOfficialAdmin: false, reason: 'fetch_error', error: err.message };
  }
}

async function adminAuth(req, res, next) {
  // 1. 传统管理密钥 (header / cookie / query)
  const token = req.headers['x-admin-token'] || req.query.admin_token || (req.cookies && req.cookies.admin_token);
  if (ADMIN_SECRET && token && token === ADMIN_SECRET) {
    return next();
  }

  // 2. 官方主站管理员身份自动识别与穿透
  const off = await checkOfficialAdminSession(req);
  if (off.isOfficialAdmin) {
    req.officialAdmin = off.user;
    return next();
  }

  return res.status(401).json({
    success: false,
    code: 'ADMIN_AUTH_REQUIRED',
    error: '管理员口令错误或未登录官方管理账号，禁止访问！',
    need_login: true
  });
}

// 检查官方管理员登录态（供前端页面加载时自动免密放行）
app.get('/api/admin/check-official', async (req, res) => {
  const off = await checkOfficialAdminSession(req);
  if (off.isOfficialAdmin) {
    return res.json({
      success: true,
      is_official_admin: true,
      user: off.user
    });
  }
  return res.json({
    success: false,
    is_official_admin: false,
    reason: off.reason,
    user: off.user || null
  });
});

// 管理员验证登录口令
app.post('/api/admin/login', (req, res) => {
  const { secret } = req.body;
  if (ADMIN_SECRET && secret === ADMIN_SECRET) {
    res.cookie('admin_token', secret, { httpOnly: false, maxAge: 24 * 3600 * 1000, path: '/' });
    return res.json({ success: true, token: ADMIN_SECRET });
  }
  res.status(401).json({ success: false, error: '管理密钥错误！' });
});

function adminContestItems() {
  const published = getPublishedContests();
  const drafts = readDrafts();
  const ids = new Set([...published.map((c) => c.id), ...Object.keys(drafts)]);
  return [...ids].map((id) => {
    const live = published.find((c) => c.id === id) || null;
    const draftEntry = drafts[id] || null;
    const draft = draftEntry?.config || null;
    return {
      id,
      status: live?.archived ? 'archived' : draft ? 'draft' : live?.is_active ? 'active' : 'published',
      published: live,
      draft,
      revision: live?.revision || draftEntry?.base_revision || 0,
      has_submissions: listSubmittedProblemCodes(id).size > 0,
      draft_updated_at: draftEntry?.updated_at || null
    };
  });
}

function saveDraftConfig(contestData, expectedRevision) {
  const { expected_revision: _ignoredRevision, ...rawContestData } = contestData || {};
  const draftStore = readDrafts();
  const existingDraft = draftStore[String(rawContestData?.id || '').trim().toLowerCase()]?.config;
  const liveConfig = getPublishedContests().find(
    (contest) => contest.id === String(rawContestData?.id || '').trim().toLowerCase()
  );
  const config = normalizeContest({
    ...(existingDraft || liveConfig || {}),
    ...rawContestData,
    id: String(rawContestData?.id || '').trim().toLowerCase(),
    title: String(rawContestData?.title || '').trim(),
    problems: Array.isArray(rawContestData?.problems)
      ? rawContestData.problems.map((p, index) => ({
          ...p,
          num: Number(p.num) || index + 1,
          code: String(p.code || '').trim().toLowerCase(),
          allowed_exts: (p.allowed_exts || []).map((ext) => String(ext).trim().toLowerCase())
        }))
      : []
  });
  const errors = validateContestConfig(config);
  if (errors.length) return { error: errors.join('；') };

  const live = getPublishedContests().find((c) => c.id === config.id);
  const currentRevision = live?.revision || 0;
  if (expectedRevision != null && Number(expectedRevision) !== currentRevision) {
    return { conflict: true, currentRevision };
  }
  draftStore[config.id] = {
    config: { ...config, is_active: false, archived: false },
    base_revision: currentRevision,
    updated_at: new Date().toISOString()
  };
  saveDrafts(draftStore);
  return { config: draftStore[config.id].config };
}

// 管理后台读取已发布版本和草稿版本
app.get('/api/admin/contests', adminAuth, (req, res) => {
  res.json({ success: true, items: adminContestItems() });
});

// 教师题库只通过考务后台读取；学生端仅能看到已发布比赛中明确选入的题目题面。
app.get('/api/admin/question-bank', adminAuth, (req, res) => {
  const items = readQuestionBank()
    .map(toQuestionBankItem)
    .filter((item) => item.id && item.title && item.code && item.statement);
  res.json({ success: true, items });
});

// 保存草稿；保留旧接口作为兼容别名，但不再直接覆盖学生端配置。
app.put('/api/admin/contests/:id/draft', adminAuth, (req, res) => {
  const result = saveDraftConfig({ ...req.body, id: req.params.id }, req.body.expected_revision);
  if (result.error) return res.status(400).json({ success: false, error: result.error });
  if (result.conflict) return res.status(409).json({ success: false, code: 'REVISION_CONFLICT', current_revision: result.currentRevision });
  res.json({ success: true, draft: result.config, message: '草稿已保存，发布后对学生生效。' });
});

app.post('/api/admin/contest/save', adminAuth, (req, res) => {
  const result = saveDraftConfig(req.body, req.body.expected_revision);
  if (result.error) return res.status(400).json({ success: false, error: result.error });
  if (result.conflict) return res.status(409).json({ success: false, code: 'REVISION_CONFLICT', current_revision: result.currentRevision });
  res.json({ success: true, draft: result.config, message: '草稿已保存，发布后对学生生效。' });
});

// 管理员向比赛草稿上传 PDF 资料
app.post('/api/admin/contests/:id/materials', adminAuth, upload.single('pdf'), (req, res) => {
  const id = String(req.params.id || '').trim().toLowerCase();
  console.log(`[PDF] upload request contest=${id} file=${req.file?.originalname || '-'} size=${req.file?.size || 0}`);
  if (!req.file) return res.status(400).json({ success: false, error: '请选择 PDF 文件' });
  const originalName = req.file.originalname || '比赛资料.pdf';
  const pdfHeader = fs.readFileSync(req.file.path).subarray(0, 5).toString('ascii');
  if (path.extname(originalName).toLowerCase() !== '.pdf' || pdfHeader !== '%PDF-') {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ success: false, error: '只允许上传 PDF 文件' });
  }
  if (req.file.size > 20 * 1024 * 1024) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ success: false, error: 'PDF 文件不能超过 20MB' });
  }

  const drafts = readDrafts();
  const live = getPublishedContests().find((contest) => contest.id === id);
  const base = drafts[id]?.config || live;
  if (!base) {
    fs.unlinkSync(req.file.path);
    return res.status(404).json({ success: false, error: '请先保存比赛草稿' });
  }
  const materialId = crypto.randomUUID();
  const contestDir = path.join(MATERIALS_DIR, id);
  fs.mkdirSync(contestDir, { recursive: true });
  fs.copyFileSync(req.file.path, path.join(contestDir, `${materialId}.pdf`));
  fs.unlinkSync(req.file.path);

  const material = {
    id: materialId,
    name: String(req.body.name || originalName).trim(),
    filename: originalName,
    file_extension: '.pdf',
    size: req.file.size,
    uploaded_at: new Date().toISOString()
  };
  drafts[id] = {
    config: { ...base, materials: [...(base.materials || []), material], is_active: false, archived: false },
    base_revision: live?.revision || 0,
    updated_at: new Date().toISOString()
  };
  saveDrafts(drafts);
  // 已发布比赛的 PDF 直接同步到线上配置，避免资料链路依赖二次发布。
  if (live) {
    const contests = getPublishedContests();
    const index = contests.findIndex((contest) => contest.id === id);
    const nextLive = {
      ...contests[index],
      materials: [...(contests[index].materials || []), material],
      revision: contests[index].revision + 1,
      updated_at: new Date().toISOString()
    };
    contests[index] = nextLive;
    writeHistory(nextLive, nextLive.revision, 'material-upload');
    saveContests(contests);
  }
  console.log(`[PDF] stored contest=${id} material=${materialId} published=${!!live}`);
  res.json({ success: true, material, published: !!live, message: live ? 'PDF 已发布，学生端刷新后即可查看。' : 'PDF 已加入草稿，发布比赛后学生可查看。' });
});

// 教师上传 ZIP 资料时只保存原包，不解析测试点；发布比赛后学生可直接下载。
app.post('/api/admin/contests/:id/materials/zip', adminAuth, upload.single('zip'), (req, res) => {
  const id = String(req.params.id || '').trim().toLowerCase();
  if (!req.file) return res.status(400).json({ success: false, error: '请选择 ZIP 资料文件' });
  const originalName = req.file.originalname || '比赛资料.zip';
  if (path.extname(originalName).toLowerCase() !== '.zip' || req.file.size > 50 * 1024 * 1024) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ success: false, error: '只允许上传不超过 50MB 的 ZIP 文件' });
  }

  try {
    const drafts = readDrafts();
    const live = getPublishedContests().find((contest) => contest.id === id);
    const base = drafts[id]?.config || live;
    if (!base) {
      return res.status(404).json({ success: false, error: '请先保存比赛草稿' });
    }

    const materialId = crypto.randomUUID();
    const contestDir = path.join(MATERIALS_DIR, id);
    fs.mkdirSync(contestDir, { recursive: true });
    fs.copyFileSync(req.file.path, path.join(contestDir, `${materialId}.zip`));

    const material = {
      id: materialId,
      name: String(req.body.name || originalName).trim(),
      filename: originalName,
      file_extension: '.zip',
      size: req.file.size,
      uploaded_at: new Date().toISOString()
    };
    drafts[id] = {
      config: { ...base, materials: [...(base.materials || []), material], is_active: false, archived: false },
      base_revision: live?.revision || 0,
      updated_at: new Date().toISOString()
    };
    saveDrafts(drafts);

    if (live) {
      const contests = getPublishedContests();
      const index = contests.findIndex((contest) => contest.id === id);
      const nextLive = {
        ...contests[index],
        materials: [...(contests[index].materials || []), material],
        revision: contests[index].revision + 1,
        updated_at: new Date().toISOString()
      };
      contests[index] = nextLive;
      writeHistory(nextLive, nextLive.revision, 'material-upload');
      saveContests(contests);
    }

    res.json({
      success: true,
      material,
      published: !!live && !live.archived,
      message: live && !live.archived
        ? 'ZIP 资料已发布，学生端可直接下载。'
        : 'ZIP 资料已加入比赛草稿，发布比赛后学生可下载。'
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message || 'ZIP 资料保存失败' });
  } finally {
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
  }
});

// 管理员上传比赛测试数据 ZIP；草稿不公开，发布后已登录学员可下载原包。
app.post('/api/admin/contests/:id/test-data', adminAuth, upload.single('test_zip'), (req, res) => {
  const id = String(req.params.id || '').trim().toLowerCase();
  if (!req.file) return res.status(400).json({ success: false, error: '请选择比赛测试数据 ZIP 文件' });
  const originalName = req.file.originalname || 'official-test-data.zip';
  try {
    if (path.extname(originalName).toLowerCase() !== '.zip' || req.file.size > 50 * 1024 * 1024) {
      throw new Error('只允许上传不超过 50MB 的 ZIP 测试数据文件');
    }
    const drafts = readDrafts();
    const live = getPublishedContests().find((contest) => contest.id === id);
    const base = drafts[id]?.config || live;
    if (!base) {
      throw new Error('请先保存比赛草稿');
    }
    const problemCodes = (base.problems || []).map((problem) => problem.code);
    const parsed = parseOfficialTestZip(fs.readFileSync(req.file.path), problemCodes);
    const stored = storeOfficialTestData(id, parsed, fs.readFileSync(req.file.path));
    const officialTestData = {
      ...stored,
      filename: originalName,
      size: req.file.size,
      uploaded_at: new Date().toISOString(),
      visibility: 'published_authenticated'
    };
    drafts[id] = {
      config: { ...base, official_test_data: officialTestData, is_active: false, archived: false },
      base_revision: live?.revision || 0,
      updated_at: new Date().toISOString()
    };
    saveDrafts(drafts);
    res.json({
      success: true,
      official_test_data: officialTestData,
      message: `测试数据解析成功，共 ${parsed.total_tests} 个测试点，已保存到比赛草稿。`
    });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message || '测试数据 ZIP 解析失败' });
  } finally {
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
  }
});

app.delete('/api/admin/contests/:id/materials/:materialId', adminAuth, (req, res) => {
  const id = String(req.params.id || '').trim().toLowerCase();
  const drafts = readDrafts();
  const live = getPublishedContests().find((contest) => contest.id === id);
  const base = drafts[id]?.config || live;
  if (!base) return res.status(404).json({ success: false, error: '比赛不存在' });
  const material = (base.materials || []).find((item) => item.id === req.params.materialId);
  const materials = (base.materials || []).filter((item) => item.id !== req.params.materialId);
  const filePath = path.join(MATERIALS_DIR, id, `${req.params.materialId}${getMaterialExtension(material)}`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  drafts[id] = { config: { ...base, materials, is_active: false, archived: false }, base_revision: live?.revision || 0, updated_at: new Date().toISOString() };
  saveDrafts(drafts);
  if (live) {
    const contests = getPublishedContests();
    const index = contests.findIndex((contest) => contest.id === id);
    contests[index] = {
      ...contests[index],
      materials: (contests[index].materials || []).filter((item) => item.id !== req.params.materialId),
      revision: contests[index].revision + 1,
      updated_at: new Date().toISOString()
    };
    saveContests(contests);
  }
  res.json({ success: true, message: '资料已从草稿移除。' });
});

app.post('/api/admin/contests/:id/publish', adminAuth, (req, res) => {
  const id = String(req.params.id).trim().toLowerCase();
  const drafts = readDrafts();
  const draftEntry = drafts[id];
  if (!draftEntry?.config) return res.status(404).json({ success: false, error: '未找到比赛草稿' });

  const live = getPublishedContests().find((c) => c.id === id);
  const expected = req.body.expected_revision;
  const currentRevision = live?.revision || 0;
  if (expected != null && Number(expected) !== currentRevision) {
    return res.status(409).json({ success: false, code: 'REVISION_CONFLICT', current_revision: currentRevision });
  }

  const submittedCodes = listSubmittedProblemCodes(id);
  const nextCodes = new Set((draftEntry.config.problems || []).map((p) => p.code));
  const destructiveCodes = [...submittedCodes].filter((code) => !nextCodes.has(code));
  if (destructiveCodes.length) {
    return res.status(409).json({
      success: false,
      code: 'SUBMISSIONS_PROTECT_CONFLICT',
      error: `已有提交的题目不能删除或重命名：${destructiveCodes.join(', ')}`,
      problem_codes: destructiveCodes
    });
  }

  const revision = currentRevision + 1;
  const activate = req.body.activate === true || (!live && getPublishedContests().length === 0);
  const contests = getPublishedContests().map((contest) => ({
    ...contest,
    is_active: activate ? false : contest.is_active
  }));
  const next = normalizeContest({
    ...draftEntry.config,
    revision,
    updated_at: new Date().toISOString(),
    is_active: activate,
    archived: false
  });
  const index = contests.findIndex((contest) => contest.id === id);
  if (index >= 0) contests[index] = next;
  else contests.push(next);
  writeHistory(next, revision, 'publish');
  saveContests(contests);
  delete drafts[id];
  saveDrafts(drafts);
  res.json({ success: true, contest: next, message: `比赛已发布（revision ${revision}）。` });
});

app.post('/api/admin/contests/:id/activate', adminAuth, (req, res) => {
  const id = String(req.params.id).trim().toLowerCase();
  const contests = getPublishedContests();
  const target = contests.find((contest) => contest.id === id);
  if (!target || target.archived) return res.status(404).json({ success: false, error: '比赛不存在或已归档' });
  contests.forEach((contest) => { contest.is_active = contest.id === id; });
  saveContests(contests);
  res.json({ success: true, message: '已激活已发布比赛。' });
});

// 兼容旧前端接口
app.post('/api/admin/contest/set-active', adminAuth, (req, res) => {
  req.params.id = req.body.id;
  const contests = getPublishedContests();
  const target = contests.find((contest) => contest.id === req.body.id);
  if (!target || target.archived) return res.status(404).json({ success: false, error: '比赛不存在或已归档' });
  contests.forEach((contest) => { contest.is_active = contest.id === req.body.id; });
  saveContests(contests);
  res.json({ success: true, message: '已激活已发布比赛。' });
});

app.post('/api/admin/contests/:id/archive', adminAuth, (req, res) => {
  const id = String(req.params.id).trim().toLowerCase();
  const contests = getPublishedContests();
  const index = contests.findIndex((contest) => contest.id === id);
  if (index < 0) return res.status(404).json({ success: false, error: '比赛不存在' });
  const next = { ...contests[index], archived: true, is_active: false, revision: contests[index].revision + 1, updated_at: new Date().toISOString() };
  writeHistory(next, next.revision, 'archive');
  contests[index] = next;
  saveContests(contests);
  const drafts = readDrafts();
  delete drafts[id];
  saveDrafts(drafts);
  res.json({ success: true, message: '比赛已归档，提交数据已保留。' });
});

app.post('/api/admin/contests/:id/reopen', adminAuth, (req, res) => {
  const id = String(req.params.id || '').trim().toLowerCase();
  const contests = getPublishedContests();
  const index = contests.findIndex((contest) => contest.id === id);
  if (index < 0) return res.status(404).json({ success: false, error: '比赛不存在' });
  const next = {
    ...contests[index],
    archived: false,
    is_active: req.body.activate === true,
    revision: contests[index].revision + 1,
    updated_at: new Date().toISOString()
  };
  if (next.is_active) contests.forEach((contest) => { contest.is_active = false; });
  contests[index] = next;
  writeHistory(next, next.revision, 'reopen');
  saveContests(contests);
  res.json({ success: true, contest: next, message: '比赛已重启，可重新发布和激活。' });
});

app.delete('/api/admin/contests/:id', adminAuth, (req, res) => {
  const id = String(req.params.id || '').trim().toLowerCase();
  if (req.body?.confirm !== id && req.query.confirm !== id) {
    return res.status(400).json({ success: false, error: `请提交 confirm=${id} 才能永久删除比赛` });
  }
  const contests = getPublishedContests();
  if (!contests.some((contest) => contest.id === id)) {
    return res.status(404).json({ success: false, error: '比赛不存在' });
  }
  saveContests(contests.filter((contest) => contest.id !== id));
  const drafts = readDrafts();
  delete drafts[id];
  saveDrafts(drafts);
  for (const dir of [path.join(HISTORY_DIR, id), path.join(MATERIALS_DIR, id), path.join(SUBMISSIONS_DIR, id)]) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
  res.json({ success: true, message: '比赛配置、历史、PDF资料和提交代码已永久删除。' });
});

app.post('/api/admin/contest/delete', adminAuth, (req, res) => {
  req.params.id = req.body.id;
  const id = String(req.body.id || '').trim().toLowerCase();
  const contests = getPublishedContests();
  const index = contests.findIndex((contest) => contest.id === id);
  if (index < 0) return res.status(404).json({ success: false, error: '比赛不存在' });
  contests[index] = {
    ...contests[index],
    archived: true,
    is_active: false,
    revision: contests[index].revision + 1,
    updated_at: new Date().toISOString()
  };
  writeHistory(contests[index], contests[index].revision, 'archive');
  saveContests(contests);
  res.json({ success: true, message: '比赛已归档，提交数据已保留。' });
});

app.get('/api/admin/contests/:id/history', adminAuth, (req, res) => {
  res.json({ success: true, history: readHistory(String(req.params.id).trim().toLowerCase()) });
});

app.post('/api/admin/contests/:id/restore', adminAuth, (req, res) => {
  const id = String(req.params.id).trim().toLowerCase();
  const revision = Number(req.body.revision);
  const file = path.join(HISTORY_DIR, id, `${revision}.json`);
  if (!fs.existsSync(file)) return res.status(404).json({ success: false, error: '历史版本不存在' });
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const drafts = readDrafts();
  drafts[id] = {
    config: { ...snapshot, archived: false, is_active: false, history_action: undefined, history_at: undefined },
    base_revision: getPublishedContests().find((c) => c.id === id)?.revision || 0,
    updated_at: new Date().toISOString()
  };
  saveDrafts(drafts);
  res.json({ success: true, draft: drafts[id].config, message: `revision ${revision} 已恢复为草稿。` });
});

// 考务人员查看某场比赛的所有提交记录概览
app.get('/api/admin/submissions/overview', adminAuth, (req, res) => {
  const contest = getActiveContest(req.query.contest);
  if (!contest) return res.status(404).json({ success: false, error: '比赛不存在' });

  const contestDir = path.join(SUBMISSIONS_DIR, contest.id);
  const locks = readLocks();
  const results = [];

  if (fs.existsSync(contestDir)) {
    const students = fs.readdirSync(contestDir).filter(f => !f.startsWith('.'));
    for (const student of students) {
      const studentDir = path.join(contestDir, student);
      const probMap = {};
      let totalSubmitted = 0;

      for (const p of contest.problems || []) {
        const pDir = path.join(studentDir, p.code);
        if (fs.existsSync(pDir)) {
          const files = fs.readdirSync(pDir).filter(f => !f.startsWith('.'));
          if (files.length > 0) {
            const fName = files[0];
            const stat = fs.statSync(path.join(pDir, fName));
            probMap[p.code] = {
              status: 'uploaded',
              filename: fName,
              size: formatBytes(stat.size),
              mtime: stat.mtime
            };
            totalSubmitted++;
            continue;
          }
        }
        probMap[p.code] = { status: 'pending' };
      }

      results.push({
        username: student,
        seat: 'LAB-' + (Math.abs(student.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0)) % 50 + 1).toString().padStart(2, '0'),
        is_locked: !!locks[`${contest.id}__${student}`],
        total_submitted: totalSubmitted,
        problems: probMap
      });
    }
  }

  res.json({ success: true, contest_id: contest.id, students: results });
});

// 下载单个学生本场比赛的全部提交代码 ZIP 包
app.get('/api/admin/export/:contestId/student/:student', adminAuth, (req, res) => {
  const contestId = String(req.params.contestId || '');
  const student = String(req.params.student || '');
  const contest = getActiveContest(contestId);
  if (!contest || contest.id !== contestId) return res.status(404).send('比赛不存在');

  const contestRoot = path.resolve(SUBMISSIONS_DIR, contestId);
  const studentDir = path.resolve(contestRoot, student);
  if (!studentDir.startsWith(`${contestRoot}${path.sep}`)) return res.status(400).send('学生账号路径不合法');
  if (!fs.existsSync(studentDir) || !fs.statSync(studentDir).isDirectory()) {
    return res.status(404).send('该学生暂无提交代码');
  }

  res.attachment(`${contestId}_${student}_code_package.zip`);
  let archive;
  if (typeof archiver === 'function') {
    archive = archiver('zip', { zlib: { level: 9 } });
  } else if (archiver.ZipArchive) {
    archive = new archiver.ZipArchive({ zlib: { level: 9 } });
  } else if (archiver.create) {
    archive = archiver.create('zip', { zlib: { level: 9 } });
  }
  if (!archive) return res.status(500).send('ZIP 组件不可用');
  archive.on('error', (err) => {
    if (!res.headersSent) res.status(500).send({ error: err.message });
  });
  archive.pipe(res);
  for (const entry of getSubmissionEntries(contest, studentDir)) {
    archive.file(entry.fullPath, { name: `${entry.problem.code}/${entry.name}` });
  }
  archive.append('problem_code,file_name,size,md5\n' + getSubmissionEntries(contest, studentDir)
    .map((entry) => `${entry.problem.code},${entry.name},${fs.statSync(entry.fullPath).size},${calcMd5(entry.fullPath)}`)
    .join('\n') + '\n', { name: 'manifest.csv' });
  archive.finalize();
});

// 一键导出整场比赛所有考生代码的标准评测 ZIP 包
app.get('/api/admin/export/:contestId', adminAuth, (req, res) => {
  const contestId = req.params.contestId;
  const contest = getActiveContest(contestId);
  if (!contest) return res.status(404).send('比赛不存在');

  const contestDir = path.join(SUBMISSIONS_DIR, contestId);
  const zipFileName = `${contestId}_evaluation_package_${Date.now()}.zip`;

  res.attachment(zipFileName);
  let archive;
  if (typeof archiver === 'function') {
    archive = archiver('zip', { zlib: { level: 9 } });
  } else if (archiver.ZipArchive) {
    archive = new archiver.ZipArchive({ zlib: { level: 9 } });
  } else if (archiver.create) {
    archive = archiver.create('zip', { zlib: { level: 9 } });
  }

  archive.on('error', (err) => {
    res.status(500).send({ error: err.message });
  });

  archive.pipe(res);

  if (fs.existsSync(contestDir)) {
    // 按照标准 CCF 目录结构，仅导出当前比赛题目允许的最新文件。
    for (const student of fs.readdirSync(contestDir).filter((name) => !name.startsWith('.'))) {
      const studentDir = path.join(contestDir, student);
      if (!fs.statSync(studentDir).isDirectory()) continue;
      for (const entry of getSubmissionEntries(contest, studentDir)) {
        archive.file(entry.fullPath, { name: `${student}/${entry.problem.code}/${entry.name}` });
      }
    }
  }

  archive.finalize();
});

/* ====================================================================
   静态文件与页面路由
   ==================================================================== */
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (/\.(html|js|css)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
  }
}));

app.get(['/standalone', '/standalone.html'], (req, res) => {
  const saFile = path.join(__dirname, 'standalone.html');
  if (fs.existsSync(saFile)) {
    return res.sendFile(saFile);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/export-judge-zip', (req, res) => {
  const activeContest = getActiveContest();
  if (!activeContest) return res.status(404).send('暂无激活比赛');
  res.redirect('/api/admin/export/' + activeContest.id);
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(`🚀 代码回收系统 (Code Collector) 已就绪`);
  console.log(`🌐 考生端入口: http://localhost:${PORT}/`);
  console.log(`🛠️ 考务管理端: http://localhost:${PORT}/admin`);
  console.log(`🔑 考务默认密钥: ${ADMIN_SECRET}`);
  console.log(`===============================================`);
});
