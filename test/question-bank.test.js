const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('公开版教师题库包含通用示例且不含答案和测试点', () => {
  const items = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'question-bank.json'), 'utf8'));
  assert.equal(items.length, 1);
  assert.equal(new Set(items.map((item) => item.id)).size, items.length);
  assert.equal(new Set(items.map((item) => item.source_paper_id)).size, 1);
  assert.ok(items.every((item) => item.statement && item.allowed_exts.includes('.cpp')));
  assert.ok(items.every((item) => !('reference_solution' in item) && !('test_cases' in item)));
});

async function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('测试服务器启动超时')), 5000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('已就绪')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('error', reject);
  });
}

test('教师题库仅需后台认证；选入并发布后题面才通过学生端比赛接口公开', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-question-bank-'));
  fs.writeFileSync(path.join(dataDir, 'contests.json'), '[]');
  fs.writeFileSync(path.join(dataDir, 'locks.json'), '{}');
  fs.writeFileSync(path.join(dataDir, 'question-bank.json'), JSON.stringify([{
    id: 'ja1',
    title: '双信标',
    code: 'ja1',
    group: 'CSP-J组',
    volume: 'A卷',
    source_paper_id: 'csp2026-j-a',
    statement: '题目题面\n输入格式：读取一个整数。',
    allowed_exts: ['.cpp'],
    file_type_desc: 'C++ 源码 (.cpp)',
    template_code: '',
    rules: { max_file_size_mb: 5 },
    reference_solution: '不得通过教师题库接口公开'
  }]));
  fs.mkdirSync(path.join(dataDir, 'submissions'), { recursive: true });

  const port = 36000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      ADMIN_SECRET: 'test-secret',
      NODE_ENV: 'development',
      CODE_COLLECTOR_DATA_DIR: dataDir
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForServer(child);
    const unauthenticated = await fetch(`http://127.0.0.1:${port}/api/admin/question-bank`);
    assert.equal(unauthenticated.status, 401);

    const login = await fetch(`http://127.0.0.1:${port}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: 'test-secret' })
    });
    const loginData = await login.json();
    assert.equal(loginData.success, true);

    const questionBank = await fetch(`http://127.0.0.1:${port}/api/admin/question-bank`, {
      headers: { 'x-admin-token': loginData.token }
    });
    assert.equal(questionBank.status, 200);
    const bankData = await questionBank.json();
    assert.equal(bankData.items.length, 1);
    assert.equal(bankData.items[0].title, '双信标');
    assert.equal('reference_solution' in bankData.items[0], false);

    const saveDraft = await fetch(`http://127.0.0.1:${port}/api/admin/contest/save`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-token': loginData.token
      },
      body: JSON.stringify({
        id: 'selected-question',
        title: '教师选题测试',
        problems: [{
          num: 1,
          name: bankData.items[0].title,
          code: bankData.items[0].code,
          question_bank_id: bankData.items[0].id,
          statement: bankData.items[0].statement,
          allowed_exts: bankData.items[0].allowed_exts,
          template_code: bankData.items[0].template_code,
          rules: bankData.items[0].rules
        }]
      })
    });
    assert.equal(saveDraft.status, 200);
    assert.deepEqual((await (await fetch(`http://127.0.0.1:${port}/api/contests`)).json()).contests, []);

    const publish = await fetch(`http://127.0.0.1:${port}/api/admin/contests/selected-question/publish`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-token': loginData.token
      },
      body: JSON.stringify({ activate: false, expected_revision: 0 })
    });
    assert.equal(publish.status, 200);

    const statusResponse = await fetch(`http://127.0.0.1:${port}/api/submissions/status?contest=selected-question`);
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json();
    assert.equal(status.problems[0].statement, '题目题面\n输入格式：读取一个整数。');
    assert.equal(JSON.stringify(status).includes('不得通过教师题库接口公开'), false);
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('外置生产数据目录首次启动会无损补齐教师题库', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-question-bank-bootstrap-'));
  fs.mkdirSync(path.join(dataDir, 'submissions'), { recursive: true });
  const port = 37000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      ADMIN_SECRET: 'test-secret',
      NODE_ENV: 'development',
      CODE_COLLECTOR_DATA_DIR: dataDir
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForServer(child);
    const bankFile = path.join(dataDir, 'question-bank.json');
    assert.equal(fs.existsSync(bankFile), true);
    const bank = JSON.parse(fs.readFileSync(bankFile, 'utf8'));
    assert.deepEqual(bank, JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'question-bank.json'), 'utf8')));
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
