const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ZIP_FIXTURE = Buffer.from(
  'UEsDBBQAAAAIAFxJS11T/FFnBAAAAAIAAAAUAAAAd3JvbmctcXVlc3Rpb24vMDEuaW4z5AIAUEsDBBQAAAAIAFxJS11T/FFnBAAAAAIAAAAVAAAAd3JvbmctcXVlc3Rpb24vMDEuYW5zM+QCAFBLAwQUAAAICABcSUtdlF1w4SAAAAAeAAAAEAAAAOivhOWIhumFjee9ri5jc3YrSSzO1ilOzi9K5Sovys9L1y0sTS0uyczP0zE0MOACAFBLAQIUAxQAAAAIAFxJS11T/FFnBAAAAAIAAAAUAAAAAAAAAAAAAACAAQAAAAB3cm9uZy1xdWVzdGlvbi8wMS5pblBLAQIUAxQAAAAIAFxJS11T/FFnBAAAAAIAAAAVAAAAAAAAAAAAAACAATYAAAB3cm9uZy1xdWVzdGlvbi8wMS5hbnNQSwECFAMUAAAICABcSUtdlF1w4SAAAAAeAAAAEAAAAAAAAAAAAAAAgAFtAAAA6K+E5YiG6YWN572uLmNzdlBLBQYAAAAAAwADAMMAAAC7AAAAAAA=',
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

test('教师上传 ZIP 不解析内部测试格式；发布后学生可直接下载原包', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-zip-material-'));
  fs.writeFileSync(path.join(dataDir, 'contests.json'), '[]');
  fs.writeFileSync(path.join(dataDir, 'locks.json'), '{}');
  fs.mkdirSync(path.join(dataDir, 'submissions'), { recursive: true });

  const port = 38000 + Math.floor(Math.random() * 1000);
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
  const base = `http://127.0.0.1:${port}`;

  try {
    await waitForServer(child);
    const login = await fetch(`${base}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: 'test-secret' })
    });
    const { token } = await login.json();

    const save = await fetch(`${base}/api/admin/contest/save`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-token': token },
      body: JSON.stringify({
        id: 'zip-material-test',
        title: 'ZIP 资料测试赛',
        problems: [{
          num: 1,
          name: '代号与压缩包目录不同的题目',
          code: 'configured-code',
          allowed_exts: ['.cpp'],
          rules: { max_file_size_mb: 5 }
        }]
      })
    });
    assert.equal(save.status, 200);

    const form = new FormData();
    form.append('zip', new Blob([ZIP_FIXTURE], { type: 'application/zip' }), 'teacher-materials.zip');
    const upload = await fetch(`${base}/api/admin/contests/zip-material-test/materials/zip`, {
      method: 'POST',
      headers: { 'x-admin-token': token },
      body: form
    });
    const uploadData = await upload.json();
    assert.equal(upload.status, 200);
    assert.equal(uploadData.success, true);
    assert.equal(uploadData.material.file_extension, '.zip');
    assert.equal(uploadData.published, false);

    const storedPath = path.join(dataDir, 'materials', 'zip-material-test', `${uploadData.material.id}.zip`);
    assert.deepEqual(fs.readFileSync(storedPath), ZIP_FIXTURE);
    const draftList = await (await fetch(`${base}/api/contests`)).json();
    assert.equal(draftList.contests.some((item) => item.id === 'zip-material-test'), false);
    const hiddenDownload = await fetch(`${base}/api/contest-material/zip-material-test/${uploadData.material.id}`);
    assert.equal(hiddenDownload.status, 404);

    const publish = await fetch(`${base}/api/admin/contests/zip-material-test/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-token': token },
      body: JSON.stringify({ activate: false, expected_revision: 0 })
    });
    assert.equal(publish.status, 200);

    const publicList = await (await fetch(`${base}/api/contests`)).json();
    const contest = publicList.contests.find((item) => item.id === 'zip-material-test');
    assert.equal(contest.materials[0].file_extension, '.zip');
    const download = await fetch(`${base}/api/contest-material/zip-material-test/${uploadData.material.id}`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type').split(';')[0], 'application/zip');
    assert.match(download.headers.get('content-disposition'), /teacher-materials\.zip/);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), ZIP_FIXTURE);
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
