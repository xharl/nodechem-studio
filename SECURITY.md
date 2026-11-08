# Security policy

## Supported versions

The latest release on the default branch. This is a preview: security fixes ship in a new tagged
release rather than as patches to older ones.

| Version | Supported |
| --- | --- |
| 0.2.x | Yes |
| 0.1.x | No |

## Reporting a vulnerability

Report privately through GitHub's **Security → Advisories → Report a vulnerability** on this
repository. Do not open a public issue, and do not attach a working exploit to an issue or a pull
request.

Please include:

- the version and platform,
- what you did, step by step,
- what happened, and what you expected,
- the smallest project file or run folder that reproduces it, if one exists.

You will get an acknowledgement, an assessment of impact, and a fix or a reasoned "will not fix"
with the reasoning. Credit in the advisory unless you ask otherwise.

## In scope

The app runs with the user's privileges and drives a licensed engine, so the interesting failure
modes are about untrusted data and file handling:

- **Project files (`.ncs`)** — a crafted project that achieves code execution, reads outside the
  paths it should, or writes outside its own run/bundle folder. In particular: condition expressions
  must stay a data-only grammar, and input/output names must stay validated before any path join.
- **Structure import** (`.xyz`, `.mol`, `.sdf`, `.mol2`, `.pdb`/`.pdbqt`, `.cjson`, `.gjf`, `.com`, Gaussian `.log`) — parser crashes, memory exhaustion,
  or file reads outside the chosen file.
- **Cluster-export import** — a returned folder that reads or writes outside the target directory, or
  that fabricates a passing gate.
- **Run bundles** — writing outside the chosen parent folder, overwriting a previous bundle, or
  producing a manifest whose hashes do not match the files.
- **Renderer boundary** — anything that gives page content access to Node, `child_process` or the
  filesystem beyond the preload API.
- **Command construction** — any path from project data to a shell string. There is no shell: engine
  processes are spawned with an argument vector and `shell: false`. Report anything that breaks that.

## Out of scope

- **Gaussian 16 and xTB themselves.** Vulnerabilities in the engines belong to their vendors. This
  project never bundles either, and cannot patch them.
- **Licence enforcement.** The app deliberately does not verify or enforce Gaussian licensing; do not
  report "it ran without a licence" as a vulnerability. Licensing is between the user and Gaussian,
  Inc.
- **Denial of service by huge legitimate inputs** (a 2 GB log, a 2 000-block project) beyond the
  documented caps.
- **Findings that require a compromised OS account**, a modified binary, or `--inspect` on the
  renderer.
- **Missing hardening headers / CSP suggestions** with no demonstrated impact: this is a local
  Electron app with no remote content loaded.

## Design commitments you can rely on

- No network capability in the app sources; a test fails if a client is introduced.
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- Engine processes: argument array, `shell: false`, `windowsHide: true`.
- Every generated file name is validated against an explicit pattern before a path join.
- A missing or unjudgeable value is `unknown`, never `pass` — including in imported results.
