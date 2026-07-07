# Umbrel Encrypted Folder

A small web app for creating and managing encrypted folders on Umbrel OS with
`gocryptfs`.

The app lets you create password-protected vaults, unlock them into a folder
that Umbrel File Browser can use, and lock them again so the files are stored
only in encrypted form.

## What It Does

- Creates encrypted vaults with `gocryptfs`.
- Shows vaults in a simple browser UI.
- Unlocks a vault into `data/unlocked/<vault-name>`.
- Locks a vault without asking for the password again during the same app
  session.
- Preserves files added through Umbrel File Browser while a vault is unlocked.
- Encrypts host-added files on `Lock`.
- Tries to lock open vaults automatically when the container is stopped.
- Deletes leftover `data/unlocked/*` folders on startup for safety.

## Folder Layout

```text
data/
  vaults/
    <vault-name>/        # encrypted gocryptfs storage
  unlocked/
    <vault-name>/        # decrypted FUSE mount while unlocked
  pending-imports/
    <vault-name>-.../    # temporary import staging, only for recovery cases
```

Back up `data/vaults`, not `data/unlocked`.

`data/unlocked` is a working view, not the source of truth. The encrypted vault
in `data/vaults/<vault-name>` is the durable storage.

## What Happens In `unlocked`

When a vault is unlocked, the app runs `gocryptfs` and mounts:

```text
data/vaults/<vault-name>    ->    data/unlocked/<vault-name>
```

`data/unlocked/<vault-name>` is not a normal copy of the files. It is also not a
folder full of symlinks. It is a FUSE mount point.

That means:

- The encrypted files physically live in `data/vaults/<vault-name>`.
- The readable filenames and file contents appear through
  `data/unlocked/<vault-name>` only while the vault is mounted.
- When an app or File Browser reads a file from `unlocked`, `gocryptfs`
  decrypts the needed blocks on demand.
- When an app or File Browser writes a file into `unlocked`, `gocryptfs`
  encrypts it and stores the encrypted result under `vaults`.

Unlock feels fast because `gocryptfs` does not decrypt the whole vault up front.
It mounts a live filesystem view. Files are decrypted lazily as they are opened
or read, and encrypted lazily as they are written. So unlocking a vault with many
files is mostly mounting and checking the password, not copying or decrypting
every byte.

On lock, the app unmounts the FUSE filesystem. After that,
`data/unlocked/<vault-name>` is removed, and the readable files should no longer
be visible.

## Lock And Unlock Flow

### Create

The app initializes a new `gocryptfs` vault in:

```text
data/vaults/<vault-name>
```

The password is passed to `gocryptfs` through stdin. It is not written to config
files, logs, environment variables, or disk by this app.

### Unlock

The app mounts the encrypted vault to:

```text
data/unlocked/<vault-name>
```

The password is kept only in the app process memory while the vault is unlocked.
This lets the app lock the vault later and import host-added files without
asking for the password again.

### Lock

The app:

1. Unmounts the FUSE mount.
2. Checks whether any plaintext files were left in the underlying
   `data/unlocked/<vault-name>` directory.
3. If needed, remounts the vault with the in-memory password.
4. Copies those plaintext files through the mounted encrypted view.
5. Unmounts again.
6. Deletes the unlocked folder.
7. Removes the password from memory.

This is what makes files added through Umbrel File Browser survive
`Lock -> Unlock`.

## Shutdown And Startup Safety

When Docker stops the container normally, it sends `SIGTERM`. The app handles
that signal and tries to lock all currently unlocked vaults before exiting.

The Docker Compose files use:

```yaml
stop_grace_period: 2m
```

This gives the app time to encrypt recently added files before Docker kills the
process.

On startup, the app removes everything inside:

```text
data/unlocked/
```

This is intentional. `unlocked` is treated as unsafe plaintext working space.
If the previous process died unexpectedly, the next start cleans that directory
so readable files are not left lying around.

Important limitation: graceful shutdown only works if the app receives a normal
stop signal. If the machine loses power, Docker is killed hard, or the process is
terminated with `SIGKILL`, the app cannot run cleanup code before exit. The next
startup still cleans `data/unlocked`.

## Umbrel File Browser

On Umbrel OS, open File Browser and look under:

```text
Apps / umbrel-encrypted-folder / data
```

Use:

```text
Apps / umbrel-encrypted-folder / data / unlocked / <vault-name>
```

as the folder where you read and add normal files after unlocking a vault.

Do not manually edit:

```text
Apps / umbrel-encrypted-folder / data / vaults / <vault-name>
```

That folder contains encrypted `gocryptfs` data.

## Running Locally

```bash
docker compose up -d --build
```

Open:

```text
http://127.0.0.1:3009
```

## Running On Umbrel

The Umbrel deployment uses the same app image, but with Umbrel-specific service
names:

```bash
docker compose -f docker-compose.umbrel.yml up -d --build
```

Open:

```text
http://umbrel.local:3009
```

The container needs FUSE access, so the Compose files include:

- `/dev/fuse`
- `SYS_ADMIN`
- `apparmor:unconfined`
- `rshared` bind mount propagation for `./data:/data`

## Password Handling

The app does not persist vault passwords.

Passwords are:

- Sent to `gocryptfs` through stdin.
- Stored temporarily in process memory only while a vault is unlocked.
- Removed from memory when the vault is locked or deleted.
- Lost when the container restarts.

Passwords are not stored in:

- `data/`
- config files
- logs
- environment variables
- browser local storage by this app

## Tests

Run:

```bash
npm test
```

The integration tests cover:

- Files surviving `Unlock -> Lock -> Unlock`.
- Files added while a vault is not mounted being imported safely.
- Binary files preserving their hash.
- Host-added files overwriting existing vault files.
- Container stop locking an unlocked vault.
- Startup cleanup removing plaintext files from `data/unlocked`.

## Current Caveats

- This is still a prototype. Test backups and recovery before trusting it with
  important data.
- Very large files may need more than the current Docker stop grace period.
- A hard power loss cannot run graceful lock logic.
- `data/vaults` is what should be backed up.
- `data/unlocked` should be treated as temporary plaintext workspace.
