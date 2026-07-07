import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, rmdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = process.env.DATA_DIR || '/data';
const VAULTS_DIR = process.env.VAULTS_DIR || path.join(DATA_DIR, 'vaults');
const MOUNTS_DIR = process.env.MOUNTS_DIR || path.join(DATA_DIR, 'unlocked');
const PORT = Number(process.env.PORT || 3000);

mkdirSync(VAULTS_DIR, { recursive: true });
mkdirSync(MOUNTS_DIR, { recursive: true });

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
  try {
    await run('fusermount3', ['-u', mountPath]);
  } catch (e) {
    try { await run('umount', ['-l', mountPath]); } catch {}
  }
}

async function ensureMountDir(mountPath) {
  try {
    mkdirSync(mountPath, { recursive: true });
  } catch (e) {
    if (e.code !== 'ENOTCONN') throw e;
    await unmount(mountPath);
    mkdirSync(mountPath, { recursive: true });
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
    await ensureMountDir(mountPath);
    if (await isMountPoint(mountPath)) return { ok: true, alreadyUnlocked: true };
    await run('gocryptfs', ['-allow_other', encryptedPath, mountPath], { input: `${password}\n` });
    return { ok: true, unlockedPath: mountPath };
  } catch (e) {
    reply.code(400);
    return { ok: false, error: e.message };
  }
});

app.post('/api/vaults/:name/lock', async (req, reply) => {
  try {
    const name = safeName(req.params.name);
    const mountPath = path.join(MOUNTS_DIR, name);
    if (!existsSync(mountPath)) return { ok: true };
    await unmount(mountPath);
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
