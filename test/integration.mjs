import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3009';
const PASSWORD = 'password123';

async function api(pathname, options = {}) {
  const headers = options.body ? { 'content-type': 'application/json' } : undefined;
  const res = await fetch(`${BASE_URL}${pathname}`, { ...options, headers });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || body.message || `HTTP ${res.status}`);
  return body;
}

function dockerExec(command) {
  return execFileSync('docker', ['compose', 'exec', '-T', 'encrypted-folder', 'sh', '-lc', command], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

async function createVault(name) {
  await api(`/api/vaults/${name}`, { method: 'DELETE' });
  await api('/api/vaults', {
    method: 'POST',
    body: JSON.stringify({ name, password: PASSWORD }),
  });
}

async function unlock(name) {
  return api(`/api/vaults/${name}/unlock`, {
    method: 'POST',
    body: JSON.stringify({ password: PASSWORD }),
  });
}

async function lock(name) {
  return api(`/api/vaults/${name}/lock`, { method: 'POST' });
}

async function deleteVault(name) {
  await api(`/api/vaults/${name}`, { method: 'DELETE' });
}

async function testMountedFilesSurviveLock() {
  const name = 'it-persist';
  await createVault(name);
  try {
    await unlock(name);
    dockerExec(`printf survives-lock > /data/unlocked/${name}/keep.txt`);

    await lock(name);
    const unlockedTree = dockerExec('find /data/unlocked -maxdepth 2 -print');
    assert(!unlockedTree.includes(`/data/unlocked/${name}/keep.txt`));

    await unlock(name);
    const contents = dockerExec(`cat /data/unlocked/${name}/keep.txt`);
    assert.equal(contents, 'survives-lock');
  } finally {
    await deleteVault(name);
  }
}

async function testPlaintextAddedWhileNotMountedIsImported() {
  const name = 'it-import';
  await createVault(name);
  try {
    const strayDir = path.join('data', 'unlocked', name);
    mkdirSync(strayDir, { recursive: true });
    writeFileSync(path.join(strayDir, 'stray.txt'), 'added-while-locked');

    const lockResult = await lock(name);
    assert.equal(lockResult.ok, true);
    assert.equal(lockResult.pendingImport, true);

    const unlockResult = await unlock(name);
    assert.equal(unlockResult.importedPlaintext, true);
    const contents = dockerExec(`cat /data/unlocked/${name}/stray.txt`);
    assert.equal(contents, 'added-while-locked');

    await lock(name);
    await unlock(name);
    const contentsAfterRelock = dockerExec(`cat /data/unlocked/${name}/stray.txt`);
    assert.equal(contentsAfterRelock, 'added-while-locked');
  } finally {
    await deleteVault(name);
    rmSync(path.join('data', 'unlocked', name), { recursive: true, force: true });
  }
}

await testMountedFilesSurviveLock();
await testPlaintextAddedWhileNotMountedIsImported();
console.log('integration tests passed');
