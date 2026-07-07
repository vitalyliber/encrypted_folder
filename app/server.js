import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, rmdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = process.env.DATA_DIR || '/data';
const VAULTS_DIR = process.env.VAULTS_DIR || path.join(DATA_DIR, 'vaults');
const MOUNTS_DIR = process.env.MOUNTS_DIR || path.join(DATA_DIR, 'unlocked');
const IMPORTS_DIR = process.env.IMPORTS_DIR || path.join(DATA_DIR, 'pending-imports');
const PORT = Number(process.env.PORT || 3000);

mkdirSync(VAULTS_DIR, { recursive: true });
mkdirSync(MOUNTS_DIR, { recursive: true });
mkdirSync(IMPORTS_DIR, { recursive: true });

const app = Fastify({ logger: true });
await app.register(fastifyStatic, {
  root: path.join(__dirname, '..', 'public'),
});

function safeName(name) {
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name || '')) throw new Error('Use only letters, numbers, dot, underscore and dash. Max 64 chars.');
  return name;
}

function run(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...opts, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', d => out += d.toString());
    child.stderr.on('data', d => err += d.toString());
    if (opts.input) child.stdin.write(opts.input);
    child.stdin.end();
    child.on('error', err => {
      reject(new Error(`${command} failed to start: ${err.message}`));
    });
    child.on('close', code => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(err || out || `${command} exited with code ${code}`));
    });
  });
}

async function isMountPoint(dir) {
  try {
    await run('mountpoint', ['-q', dir]);
    return true;
  } catch {
    return false;
  }
}

async function unmount(mountPath) {
  let lastError;
  try {
    await run('fusermount3', ['-u', mountPath]);
  } catch (e) {
    lastError = e;
    try {
      await run('umount', ['-l', mountPath]);
    } catch (fallbackError) {
      lastError = fallbackError;
    }
  }
  if (await isMountPoint(mountPath)) {
    throw lastError || new Error(`Failed to unmount ${mountPath}`);
  }
}

function removeMountDir(mountPath) {
  try {
    rmdirSync(mountPath);
  } catch (e) {
    if (e.code === 'ENOENT') return;
    if (e.code === 'ENOTEMPTY' || e.code === 'EEXIST') {
      throw new Error(`Unlocked folder ${mountPath} contains files but is not mounted. Refusing to delete unencrypted files.`);
    }
    throw e;
  }
}

async function movePlaintextAside(mountPath, name) {
  try {
    rmdirSync(mountPath);
    return null;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    if (e.code === 'ENOTCONN') {
      await unmount(mountPath);
      return movePlaintextAside(mountPath, name);
    }
    if (e.code !== 'ENOTEMPTY' && e.code !== 'EEXIST') throw e;
  }

  const importPath = path.join(IMPORTS_DIR, `${name}-${Date.now()}`);
  renameSync(mountPath, importPath);
  return importPath;
}

function importPlaintext(importPath, mountPath) {
  if (!importPath) return false;
  cpSync(importPath, mountPath, { recursive: true, force: false, errorOnExist: true });
  rmSync(importPath, { recursive: true, force: true });
  return true;
}

function pendingImportPath(name) {
  const prefix = `${name}-`;
  const matches = readdirSync(IMPORTS_DIR)
    .filter(entry => entry.startsWith(prefix))
    .sort();
  if (matches.length === 0) return null;
  return path.join(IMPORTS_DIR, matches[0]);
}

async function ensureMountDir(mountPath) {
  try {
    if (existsSync(mountPath) && !await isMountPoint(mountPath)) {
      removeMountDir(mountPath);
    }
    mkdirSync(mountPath, { recursive: true });
  } catch (e) {
    if (e.code !== 'ENOTCONN') throw e;
    await unmount(mountPath);
    removeMountDir(mountPath);
    mkdirSync(mountPath, { recursive: true });
  }
}

async function prepareMountDir(mountPath, name) {
  try {
    if (existsSync(mountPath) && !await isMountPoint(mountPath)) {
      const importPath = await movePlaintextAside(mountPath, name);
      mkdirSync(mountPath, { recursive: true });
      return importPath;
    }
    mkdirSync(mountPath, { recursive: true });
    return null;
  } catch (e) {
    if (e.code !== 'ENOTCONN') throw e;
    await unmount(mountPath);
    const importPath = await movePlaintextAside(mountPath, name);
    mkdirSync(mountPath, { recursive: true });
    return importPath;
  }
}

app.get('/api/vaults', async () => {
  const names = readdirSync(VAULTS_DIR).filter(name => {
    try { return statSync(path.join(VAULTS_DIR, name)).isDirectory(); } catch { return false; }
  });
  const vaults = [];
  for (const name of names) {
    const mountPath = path.join(MOUNTS_DIR, name);
    vaults.push({ name, encryptedPath: path.join(VAULTS_DIR, name), unlockedPath: mountPath, unlocked: existsSync(mountPath) && await isMountPoint(mountPath) });
  }
  return { vaults, vaultsDir: VAULTS_DIR, mountsDir: MOUNTS_DIR };
});

app.post('/api/vaults', async (req, reply) => {
  try {
    const { name, password } = req.body || {};
    safeName(name);
    if (!password || password.length < 8) throw new Error('Password must be at least 8 characters.');
    const encryptedPath = path.join(VAULTS_DIR, name);
    if (existsSync(encryptedPath)) throw new Error('Vault already exists.');
    mkdirSync(encryptedPath, { recursive: true });
    try {
      await run('gocryptfs', ['-init', encryptedPath], { input: `${password}\n${password}\n` });
    } catch (e) {
      try { rmdirSync(encryptedPath); } catch {}
      throw e;
    }
    return { ok: true };
  } catch (e) {
    reply.code(400);
    return { ok: false, error: e.message };
  }
});

app.post('/api/vaults/:name/unlock', async (req, reply) => {
  try {
    const name = safeName(req.params.name);
    const { password } = req.body || {};
    if (!password) throw new Error('Password is required.');
    const encryptedPath = path.join(VAULTS_DIR, name);
    const mountPath = path.join(MOUNTS_DIR, name);
    if (!existsSync(encryptedPath)) throw new Error('Vault not found.');
    const importPath = await prepareMountDir(mountPath, name) || pendingImportPath(name);
    if (await isMountPoint(mountPath)) return { ok: true, alreadyUnlocked: true };
    try {
      await run('gocryptfs', ['-allow_other', encryptedPath, mountPath], { input: `${password}\n` });
      const importedPlaintext = importPlaintext(importPath, mountPath);
      return { ok: true, unlockedPath: mountPath, importedPlaintext };
    } catch (e) {
      removeMountDir(mountPath);
      if (importPath && existsSync(importPath) && !existsSync(mountPath)) renameSync(importPath, mountPath);
      throw e;
    }
  } catch (e) {
    reply.code(400);
    return { ok: false, error: e.message };
  }
});

app.post('/api/vaults/:name/lock', async (req, reply) => {
  try {
    const name = safeName(req.params.name);
    const mountPath = path.join(MOUNTS_DIR, name);
    if (!await isMountPoint(mountPath)) {
      const importPath = await movePlaintextAside(mountPath, name);
      return { ok: true, pendingImport: Boolean(importPath) };
    }
    await unmount(mountPath);
    removeMountDir(mountPath);
    return { ok: true };
  } catch (e) {
    reply.code(400);
    return { ok: false, error: e.message };
  }
});

app.delete('/api/vaults/:name', async (req, reply) => {
  try {
    const name = safeName(req.params.name);
    const encryptedPath = path.join(VAULTS_DIR, name);
    const mountPath = path.join(MOUNTS_DIR, name);
    if (!existsSync(encryptedPath) && !existsSync(mountPath)) return { ok: true };
    if (existsSync(mountPath)) await unmount(mountPath);
    rmSync(encryptedPath, { recursive: true, force: true });
    rmSync(mountPath, { recursive: true, force: true });
    return { ok: true };
  } catch (e) {
    reply.code(400);
    return { ok: false, error: e.message };
  }
});

app.listen({ port: PORT, host: '0.0.0.0' });
