import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

async function waitForApi() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await api('/api/vaults');
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw new Error(`API did not become ready at ${BASE_URL}`);
}

function dockerExec(command) {
  return execFileSync('docker', ['compose', 'exec', '-T', 'encrypted-folder', 'sh', '-lc', command], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
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
    const stillVisible = dockerExec(`[ -e /data/unlocked/${name}/keep.txt ] && echo yes || echo no`).trim();
    assert.equal(stillVisible, 'no');

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

async function testBinaryFilesSurviveLock() {
  const name = 'it-binary';
  const binaryPath = path.join('data', 'unlocked', name, 'image.bin');
  const binaryBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0xff, 0x10, 0x80, 0x42, 0x24, 0x00, 0x7f,
    0xde, 0xad, 0xbe, 0xef,
  ]);

  await createVault(name);
  try {
    await unlock(name);
    mkdirSync(path.dirname(binaryPath), { recursive: true });
    writeFileSync(binaryPath, binaryBytes);
    const before = sha256(binaryPath);

    const lockResult = await lock(name);
    assert.equal(lockResult.pendingImport, false);
    assert.equal(lockResult.encryptedImport, true);
    const pendingTree = dockerExec(`find /data/pending-imports -maxdepth 2 -name '${name}-*' -print`);
    assert.equal(pendingTree, '');

    await unlock(name);

    const importedHash = dockerExec(`sha256sum /data/unlocked/${name}/image.bin | cut -d' ' -f1`).trim();
    assert.equal(importedHash, before);

    await lock(name);
    await unlock(name);

    const afterRelockHash = dockerExec(`sha256sum /data/unlocked/${name}/image.bin | cut -d' ' -f1`).trim();
    assert.equal(afterRelockHash, before);
  } finally {
    await deleteVault(name);
  }
}

async function testHostAddedFileOverwritesExistingVaultFile() {
  const name = 'it-overwrite';
  const filePath = path.join('data', 'unlocked', name, 'same-name.bin');
  const oldBytes = Buffer.from([0x01, 0x02, 0x03]);
  const newBytes = Buffer.from([0xff, 0x00, 0xee, 0x44]);

  await createVault(name);
  try {
    await unlock(name);
    dockerExec(`printf '\\001\\002\\003' > /data/unlocked/${name}/same-name.bin`);
    await lock(name);

    await unlock(name);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, newBytes);
    const expectedHash = sha256(filePath);

    const lockResult = await lock(name);
    assert.equal(lockResult.pendingImport, false);
    assert.equal(lockResult.encryptedImport, true);

    await unlock(name);
    const actualHash = dockerExec(`sha256sum /data/unlocked/${name}/same-name.bin | cut -d' ' -f1`).trim();
    assert.equal(actualHash, expectedHash);
    assert.notEqual(actualHash, createHash('sha256').update(oldBytes).digest('hex'));
  } finally {
    await deleteVault(name);
  }
}

await waitForApi();
await testMountedFilesSurviveLock();
await testPlaintextAddedWhileNotMountedIsImported();
await testBinaryFilesSurviveLock();
await testHostAddedFileOverwritesExistingVaultFile();
console.log('integration tests passed');
