# Umbrel Encrypted Folder Prototype

Tiny Web UI for creating, unlocking and locking `gocryptfs` encrypted folders.

## What it does

- Creates encrypted vaults in `./data/vaults/<name>`.
- Mounts unlocked folders to `./data/unlocked/<name>`.
- Provides a small Web UI on port `3009`.

## Run on Umbrel via SSH

```bash
cd ~/umbrel-encrypted-folder
docker compose up -d --build
```

Open:

```text
http://umbrel.local:3009
```

## Important

This is a prototype. Do not use it for critical data before testing backups and recovery.

For FUSE mounts inside Docker, the compose file uses:

- `/dev/fuse`
- `SYS_ADMIN`
- `apparmor:unconfined`
- `rshared` bind mount

On some hosts you may need to adjust mount propagation or run the container as privileged.

## Folder layout

```text
data/
  vaults/      # encrypted data, safe to back up
  unlocked/    # decrypted mount points, only visible while unlocked
```

Back up `data/vaults`, not `data/unlocked`.
