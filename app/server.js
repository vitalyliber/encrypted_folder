import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, rmdirSync, statSync } from 'node:fs';
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
chmodSync(MOUNTS_DIR, 0o777);

const app = Fastify({ logger: true });
await app.register(fastifyStatic, {
  root: path.join(__dirname, '..', 'public'),
});

const unlockedPasswords = new Map();
let shuttingDown = false;

function safeName(name) {
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(name || '')) throw new Error('Use only letters, numbers, dot, underscore and dash. Max 64 chars.');
  return name;
}

function safeRelativePath(value = '') {
  if (typeof value !== 'string') throw new Error('Invalid path.');
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if (normalized === '.' || normalized === '/') return '';
  if (normalized.startsWith('../') || normalized === '..' || path.posix.isAbsolute(normalized)) {
    throw new Error('Invalid path.');
  }
  return normalized;
}

function resolveInside(root, relativePath = '') {
  const target = path.resolve(root, safeRelativePath(relativePath));
  const resolvedRoot = path.resolve(root);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('Invalid path.');
  }
  return target;
}

function isImageFile(name) {
  return /\.(avif|bmp|gif|jpe?g|png|svg|webp)$/i.test(name);
}

function contentTypeFor(name) {
  const ext = path.extname(name).toLowerCase();
  return {
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
    '.gif': 'image/gif',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.txt': 'text/plain; charset=utf-8',
    '.pdf': 'application/pdf',
  }[ext] || 'application/octet-stream';
}

function firstImageInDirectory(dirPath, relativePath) {
  try {
    const image = readdirSync(dirPath, { withFileTypes: true })
      .filter(entry => entry.isFile() && isImageFile(entry.name))
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))[0];
    return image ? path.posix.join(relativePath, image) : null;
  } catch {
    return null;
  }
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
  cpSync(importPath, mountPath, { recursive: true, force: true });
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

async function cleanUnlockedDirOnStartup() {
  for (const entry of readdirSync(MOUNTS_DIR)) {
    const entryPath = path.join(MOUNTS_DIR, entry);
    try {
      await unmount(entryPath);
    } catch (e) {
      app.log.debug({ err: e, path: entryPath }, 'Unlocked folder was not mounted during startup cleanup');
    }
    try {
      rmSync(entryPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (e) {
      app.log.error({ err: e, path: entryPath }, 'Failed to remove unlocked folder during startup cleanup');
      throw e;
    }
  }
  chmodSync(MOUNTS_DIR, 0o777);
}

async function mountVault(encryptedPath, mountPath, password) {
  await run('gocryptfs', ['-allow_other', encryptedPath, mountPath], { input: `${password}\n` });
  chmodSync(mountPath, 0o777);
}

async function encryptPlaintextImport(name, encryptedPath, mountPath, importPath) {
  if (!importPath) return false;
  const password = unlockedPasswords.get(name);
  if (!password) return false;

  mkdirSync(mountPath, { recursive: true });
  try {
    await mountVault(encryptedPath, mountPath, password);
    importPlaintext(importPath, mountPath);
  } finally {
    if (await isMountPoint(mountPath)) await unmount(mountPath);
    removeMountDir(mountPath);
  }
  return true;
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

async function lockVault(name) {
  const encryptedPath = path.join(VAULTS_DIR, name);
  const mountPath = path.join(MOUNTS_DIR, name);
  if (!existsSync(encryptedPath)) throw new Error('Vault not found.');

  if (!await isMountPoint(mountPath)) {
    const importPath = await movePlaintextAside(mountPath, name);
    const encryptedImport = await encryptPlaintextImport(name, encryptedPath, mountPath, importPath);
    if (encryptedImport) unlockedPasswords.delete(name);
    return { ok: true, pendingImport: Boolean(importPath && !encryptedImport), encryptedImport };
  }

  await unmount(mountPath);
  const importPath = await movePlaintextAside(mountPath, name);
  const encryptedImport = await encryptPlaintextImport(name, encryptedPath, mountPath, importPath);
  unlockedPasswords.delete(name);
  return { ok: true, pendingImport: Boolean(importPath && !encryptedImport), encryptedImport };
}

async function lockAllVaultsForShutdown() {
  const names = new Set(unlockedPasswords.keys());
  for (const name of readdirSync(MOUNTS_DIR)) {
    try {
      if (await isMountPoint(path.join(MOUNTS_DIR, name))) names.add(name);
    } catch (e) {
      app.log.warn({ err: e, name }, 'Failed to inspect unlocked folder during shutdown');
    }
  }

  for (const name of names) {
    try {
      const result = await lockVault(name);
      app.log.info({ name, result }, 'Locked vault during shutdown');
    } catch (e) {
      app.log.error({ err: e, name }, 'Failed to lock vault during shutdown');
    }
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

app.get('/api/vaults/:name/files', async (req, reply) => {
  try {
    const name = safeName(req.params.name);
    const requestedPath = safeRelativePath(req.query?.path || '');
    const mountPath = path.join(MOUNTS_DIR, name);
    if (!await isMountPoint(mountPath)) throw new Error('Vault is locked.');

    const dirPath = resolveInside(mountPath, requestedPath);
    const dirStat = statSync(dirPath);
    if (!dirStat.isDirectory()) throw new Error('Path is not a directory.');

    const entries = readdirSync(dirPath, { withFileTypes: true })
      .filter(entry => !entry.name.startsWith('.'))
      .map(entry => {
        const relativePath = path.posix.join(requestedPath, entry.name);
        const fullPath = path.join(dirPath, entry.name);
        const stats = statSync(fullPath);
        const type = entry.isDirectory() ? 'directory' : 'file';
        const previewPath = type === 'directory' ? firstImageInDirectory(fullPath, relativePath) : null;
        return {
          name: entry.name,
          path: relativePath,
          type,
          size: stats.size,
          modifiedAt: stats.mtime.toISOString(),
          isImage: type === 'file' && isImageFile(entry.name),
          previewUrl: previewPath ? `/api/vaults/${encodeURIComponent(name)}/file?path=${encodeURIComponent(previewPath)}` : null,
          url: type === 'file' ? `/api/vaults/${encodeURIComponent(name)}/file?path=${encodeURIComponent(relativePath)}` : null,
        };
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });

    return { ok: true, name, path: requestedPath, entries };
  } catch (e) {
    reply.code(400);
    return { ok: false, error: e.message };
  }
});

app.get('/api/vaults/:name/file', async (req, reply) => {
  try {
    const name = safeName(req.params.name);
    const requestedPath = safeRelativePath(req.query?.path || '');
    if (!requestedPath) throw new Error('File path is required.');
    const mountPath = path.join(MOUNTS_DIR, name);
    if (!await isMountPoint(mountPath)) throw new Error('Vault is locked.');

    const filePath = resolveInside(mountPath, requestedPath);
    const stats = statSync(filePath);
    if (!stats.isFile()) throw new Error('Path is not a file.');
    reply.type(contentTypeFor(filePath));
    reply.header('content-length', stats.size);
    return reply.send(createReadStream(filePath));
  } catch (e) {
    reply.code(400);
    return { ok: false, error: e.message };
  }
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
      await mountVault(encryptedPath, mountPath, password);
      unlockedPasswords.set(name, password);
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
    return await lockVault(name);
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
    unlockedPasswords.delete(name);
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

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'Shutting down');
  try {
    await lockAllVaultsForShutdown();
  } finally {
    await app.close();
    process.exit(0);
  }
}

process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });

await cleanUnlockedDirOnStartup();
await app.listen({ port: PORT, host: '0.0.0.0' });
