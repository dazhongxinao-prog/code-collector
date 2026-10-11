const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ZIP_FIXTURE = Buffer.from(
  'UEsDBBQAAAAAALlqRV1T/FFnAgAAAAIAAAASAAAAY29udGVzdC9hcHBsZS8xLmluMQpQSwMEFAAAAAAAuWpFXZCvfEwCAAAAAgAAABMAAABjb250ZXN0L2FwcGxlLzEub3V0MgpQSwECFAMUAAAAAAC5akVdU/xRZwIAAAACAAAAEgAAAAAAAAAAAAAAgAEAAAAAY29udGVzdC9hcHBsZS8xLmluUEsBAhQDFAAAAAAAuWpFXZCvfEwCAAAAAgAAABMAAAAAAAAAAAAAAIABMgAAAGNvbnRlc3QvYXBwbGUvMS5vdXRQSwUGAAAAAAIAAgCBAAAAZQAAAAAA',
  'base64'
);

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

test('比赛草稿不公开 ZIP，发布后已登录学员可下载完整原包', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-test-data-'));
  fs.writeFileSync(path.join(dataDir, 'contests.json'), '[]');
  fs.writeFileSync(path.join(dataDir, 'locks.json'), '{}');
  fs.mkdirSync(path.join(dataDir, 'submissions'), { recursive: true });
  const port = 35000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      ADMIN_SECRET: 'test-secret',
      NODE_ENV: 'development',
      CODE_COLLECTOR_DEV_AUTH: 'true',
      CODE_COLLECTOR_DATA_DIR: dataDir
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let productionChild;

  try {
    await waitForServer(child);
    const login = await fetch(`http://127.0.0.1:${port}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: 'test-secret' })
    });
    const loginData = await login.json();
    assert.equal(loginData.success, true);

    const save = await fetch(`http://127.0.0.1:${port}/api/admin/contest/save`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-token': loginData.token
      },
      body: JSON.stringify({
        id: 'zip-test',
        title: 'ZIP 测试比赛',
        problems: [{
          num: 1,
          name: '苹果',
          code: 'apple',
          allowed_exts: ['.cpp'],
          rules: { max_file_size_mb: 5 }
        }]
      })
    });
    assert.equal(save.status, 200);

    const form = new FormData();
    form.append('test_zip', new Blob([ZIP_FIXTURE], { type: 'application/zip' }), 'official.zip');
    const upload = await fetch(`http://127.0.0.1:${port}/api/admin/contests/zip-test/test-data`, {
      method: 'POST',
      headers: { 'x-admin-token': loginData.token },
      body: form
    });
    const uploadData = await upload.json();
    assert.equal(upload.status, 200);
    assert.equal(uploadData.success, true);
    assert.equal(uploadData.official_test_data.total_tests, 1);
    assert.equal(uploadData.official_test_data.problems.apple.test_count, 1);
    assert.equal(uploadData.official_test_data.visibility, 'published_authenticated');

    const draft = JSON.parse(fs.readFileSync(path.join(dataDir, 'contest-drafts.json'), 'utf8'));
    assert.equal(draft['zip-test'].config.official_test_data.visibility, 'published_authenticated');
    const packageDir = path.join(
      dataDir,
      'test-data',
      'zip-test',
      draft['zip-test'].config.official_test_data.package_id
    );
    assert.equal(fs.existsSync(path.join(packageDir, 'apple', '1.in')), true);
    assert.deepEqual(fs.readFileSync(path.join(packageDir, 'original.zip')), ZIP_FIXTURE);

    const draftDownload = await fetch(`http://127.0.0.1:${port}/api/contest-test-data/zip-test`);
    assert.equal(draftDownload.status, 404);

    const publish = await fetch(`http://127.0.0.1:${port}/api/admin/contests/zip-test/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-token': loginData.token },
      body: JSON.stringify({ activate: true, expected_revision: 0 })
    });
    assert.equal(publish.status, 200);

    productionChild = spawn(process.execPath, ['server.js'], {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        PORT: String(port + 1),
        ADMIN_SECRET: 'test-secret',
        NODE_ENV: 'production',
        CODE_COLLECTOR_DEV_AUTH: 'true',
        CODE_COLLECTOR_DATA_DIR: dataDir
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    await waitForServer(productionChild);
    const anonymousDownload = await fetch(`http://127.0.0.1:${port + 1}/api/contest-test-data/zip-test`);
    assert.equal(anonymousDownload.status, 401);
    const anonymousStatus = await fetch(`http://127.0.0.1:${port + 1}/api/submissions/status?contest=zip-test`);
    assert.equal((await anonymousStatus.json()).test_data, undefined);

    const status = await fetch(`http://127.0.0.1:${port}/api/submissions/status?contest=zip-test`);
    assert.equal((await status.json()).test_data.filename, 'official.zip');
    const download = await fetch(`http://127.0.0.1:${port}/api/contest-test-data/zip-test`);
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), ZIP_FIXTURE);
    assert.match(download.headers.get('content-disposition'), /attachment/);

    fs.unlinkSync(path.join(packageDir, 'original.zip'));
    const legacyDownload = await fetch(`http://127.0.0.1:${port}/api/contest-test-data/zip-test`);
    assert.equal(legacyDownload.status, 200, await legacyDownload.clone().text());
    const legacyZip = Buffer.from(await legacyDownload.arrayBuffer());
    assert.equal(legacyZip.subarray(0, 2).toString(), 'PK');
    assert.ok(legacyZip.includes(Buffer.from('apple/1.in')));
    assert.ok(legacyZip.includes(Buffer.from('apple/1.out')));
  } finally {
    child.kill('SIGTERM');
    productionChild?.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
