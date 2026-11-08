# Install

NodeChem Studio is a desktop application. There is no server, no account and no install step for
either calculation engine — the app drives Gaussian 16 or xTB **where they already are**.

## What you need

| | Requirement |
| --- | --- |
| Operating system | Windows 10/11 x64, or a modern Linux x64 distribution. macOS runs from source; there is no packaged macOS build. |
| For a real Gaussian run | A licensed Gaussian 16 installation on the same machine and operating system as the app. Platform-bound: a Windows licence does not authorise a Linux binary, and a Windows licence may not be used under WSL. |
| For a real xTB run | An `xtb` executable (`xtb.exe` on Windows) and its `share/xtb` parameter directory, or `XTBPATH` pointing at it. No licence file. |
| To use neither | Nothing. The dry run is a labelled fixture and needs no engine. |

The app itself is free software under the Apache License 2.0. That licence covers this project's
code; it grants no rights to Gaussian. See [Privacy and licensing](privacy-and-licensing.md).

## Windows

Download `nodechem-studio-<version>-x64.exe` from the release page and run it. It is a per-user
NSIS installer: it installs for the current user and does not need an administrator account.

**The build is unsigned.** Windows SmartScreen shows "Windows protected your PC" on first launch.
Choose **More info → Run anyway**. This is expected for an unsigned build, not a sign of a broken
download; the release page publishes a SHA-256 for each artifact if you want to check the file you
received.

## Linux

Download `nodechem-studio-<version>-x86_64.AppImage`, make it executable and run it:

```bash
chmod +x nodechem-studio-0.3.0-x86_64.AppImage
./nodechem-studio-0.3.0-x86_64.AppImage
```

The AppImage bundles Electron and needs no Node installation on the target machine. It is unsigned
as well. If your distribution refuses to start AppImages because FUSE is missing, install
`libfuse2` (Ubuntu 22.04 and later) or run the AppImage with `--appimage-extract-and-run`.

## From source

For development, or on macOS:

```bash
npm ci
npm test
npm run dev
```

`npm run dev` starts Vite on `127.0.0.1:5173` and then Electron against it. For a production-style
run against the built renderer:

```bash
npm run build
npm start
```

Node.js 22 or newer and npm 10 or newer are required to build from source. The packaged app does
not need Node on the target machine.

### Building the installers

On a Windows machine with Node 22:

```powershell
npm ci
npm test
npm run dist
```

`release\nodechem-studio-0.3.0-x64.exe` is a per-user NSIS installer; the target machine does not
need Node. The build is unsigned, so SmartScreen warns on first launch.

On a Linux machine with Node 22:

```bash
npm ci
npm test
npm run dist:linux
```

`release/nodechem-studio-0.3.0-x86_64.AppImage` is a portable, unsigned AppImage; it bundles Electron
and needs no Node on the target machine. It is not a Gaussian installer and contains no Gaussian
binaries or licence files — it drives an installation the user already has on that Linux machine.

## Where your data lives

The app writes to Electron's `userData` directory, pinned to a folder named `nodechem-studio`:

| Platform | Path |
| --- | --- |
| Windows | `%APPDATA%\nodechem-studio` |
| Linux | `~/.config/nodechem-studio` |
| macOS | `~/Library/Application Support/nodechem-studio` |

```
nodechem-studio/
  runs/<runId>/       one immutable folder per run
  queues/<queueId>/   persisted workflow state
```

Your project files are **not** stored there — a `.ncs` project lives wherever you saved it. Removing
the application does not delete either location; delete them yourself if you want a clean slate.

## What is not installed

- No Gaussian binaries, licence files or scratch data — in the repository, the installer or any
  release artifact.
- No xTB binary. You install xTB yourself; the app only runs it.
- No service, driver, background daemon or auto-updater.
- No background network activity. The only outbound call is the update check you trigger yourself,
  and it never downloads anything. See [Privacy and licensing](privacy-and-licensing.md).

## Next

[Your first project →](first-project.md)
