# DJ Peligro — Disaster Recovery

A SYNC.dll project.

This document describes how to restore DJ Peligro after
a server failure or migration.

## Reference environment

Known working versions:

- Node.js: 22.23.2
- npm: 10.9.8
- yt-dlp: 2026.08.19
- Deno: 2.9.5
- FFmpeg: 4.4.2
- Python: 3.10.12
- ytmusicapi: 1.12.2

Node.js dependencies are pinned in package-lock.json.
Python dependencies are pinned in requirements-radio.txt.

## Backup scope

The public repository contains application code,
reproducible configuration, and recovery instructions.

Discord credentials must be backed up privately.
Never publish the .env file or authentication tokens.

## Restore the application

1. Prepare a Linux server with Git, Node.js 22, npm,
   Python 3, FFmpeg, yt-dlp and Deno.

2. Verify the target storage location. On SYNC Server,
   projects should preferably reside under /mnt/sd/.

3. Clone the published DJ Peligro GitHub repository.

4. Check out the tested recovery tag or commit.
   Do not assume the latest development branch is stable.

5. Enter the project directory.

## Install Node.js dependencies

Use Node.js 22 and run:

    npm ci

This installs the dependencies from package-lock.json.
Do not update dependencies during recovery.

## Install Python radio dependencies

Create a dedicated virtual environment:

    python3 -m venv .venv-radio

Install the pinned dependencies:

    .venv-radio/bin/python -m pip install -r requirements-radio.txt

Validate the installation:

    .venv-radio/bin/python -m pip check
    .venv-radio/bin/python -c "from ytmusicapi import YTMusic"

Do not change shared Python installations.

## Restore private configuration

Copy the configuration template:

    cp .env.example .env
    chmod 600 .env

Restore TOKEN from a separate encrypted backup.

Configure the executable paths:

- YTDLP_PATH
- FFMPEG_PATH
- YTMUSIC_PYTHON_PATH
- DENO_PATH

Use absolute paths for systemd deployments.
Never publish .env or private credentials.
Never run two production instances with the same token.

## Restore systemd

Use deploy/dj-peligro.service.example.

Replace these placeholders:

- __SERVICE_USER__: unprivileged Linux user
- __PROJECT_DIR__: absolute project path
- __NODE_BINARY__: absolute Node.js path

Verify the generated unit with systemd-analyze verify.

Review permissions, environment and security restrictions.
Install the unit only after validating its configuration.

Enable and start the service when no other instance is running.
Confirm its effective configuration, status and logs.

## Recovery validation

Before returning DJ Peligro to production:

1. Run node --check index.js.
2. Verify Python dependencies with pip check.
3. Verify yt-dlp, Deno and FFmpeg executables.
4. Confirm systemd uses the intended user and paths.
5. Check the service status and startup logs.
6. Test playback with a normal YouTube link.
7. Test Music Premium fallback.
8. Verify automatic radio recommendations.
9. Test playback controls and Stop.
10. Confirm session cleanup works correctly.

Recovery is complete only when functional tests pass.

## Recovery limitations

GitHub stores the application, not the entire server.
Credentials require a separate private backup.
External tools and authorized media must remain available.
