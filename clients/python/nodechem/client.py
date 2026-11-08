"""A dependency-free client for NodeChem Studio's headless CLI.

The client does two things:

* it reads a run folder the way the app writes it -- ``<out>/runs/<id>/run.json``
  -- and returns plain dictionaries;
* it calls ``ncs validate`` and ``ncs export`` and parses their JSON, raising a
  typed error instead of returning a partial result when the CLI refuses.

Nothing here imports a third-party package and nothing touches the network.
"""

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

from .errors import CliError, NodeChemError, RecordNotFoundError

#: The run-record contract this client understands.
RECORD_SCHEMA_VERSION = 1

#: Seconds a single CLI call may take. A real workflow can be long; a caller
#: running a notebook cell usually lowers this.
DEFAULT_TIMEOUT = 900

# A run id is a folder name. The app writes `<stamp>-<suffix>`; the pattern is
# deliberately the safe set rather than the exact format, so an older or a
# cluster-imported id still reads.
_RUN_ID = re.compile(r"^[A-Za-z0-9._-]{1,124}$")


def _is_repo_cli(path):
    return path.is_file() and path.suffix == ".js"


def _command_for(cli):
    """Turn a CLI path (or an explicit argv list) into an executable argv."""
    if isinstance(cli, (list, tuple)):
        return [str(part) for part in cli]
    text = str(cli)
    if text.endswith(".js"):
        node = shutil.which("node")
        if not node:
            raise NodeChemError(
                "found {0} but no `node` on PATH; install Node 22+ or set "
                "NODECHEM_NCS to an `ncs` executable".format(text)
            )
        return [node, text]
    if text.endswith(".py"):
        return [sys.executable, text]
    return [text]


def _find_cli():
    """Locate ``ncs``: environment, PATH, then this source checkout."""
    for variable in ("NODECHEM_NCS", "NCS"):
        configured = os.environ.get(variable)
        if configured:
            return _command_for(configured)
    found = shutil.which("ncs")
    if found:
        return [found]
    # clients/python/nodechem/client.py -> repository root is three levels up.
    here = Path(__file__).resolve()
    for base in [here, Path.cwd().resolve()]:
        for parent in [base] + list(base.parents):
            candidate = parent / "bin" / "ncs.js"
            if _is_repo_cli(candidate):
                return _command_for(candidate)
    raise NodeChemError(
        "could not find the `ncs` CLI: set NODECHEM_NCS to its path, put it on "
        "PATH, or run this client from a NodeChem Studio checkout"
    )


class Client(object):
    """Read run records and call the CLI for one output folder.

    Args:
        out_dir: the folder ``ncs run --out`` wrote. Defaults to the current
            directory; records live under ``<out_dir>/runs``.
        cli: an ``ncs`` executable, a ``bin/ncs.js`` path, an argv list, or
            ``None`` to discover one (``NODECHEM_NCS``, ``PATH``, checkout).
        timeout: seconds per CLI call.
        cwd: working directory for CLI calls. ``None`` inherits the caller's,
            which keeps relative project paths meaningful.
    """

    def __init__(self, out_dir=None, cli=None, timeout=DEFAULT_TIMEOUT, cwd=None):
        self.out_dir = Path(out_dir) if out_dir is not None else Path.cwd()
        self.timeout = timeout
        self.cwd = cwd
        self._cli = cli
        self._command = None

    # -- CLI plumbing ----------------------------------------------------

    @property
    def command(self):
        """The argv prefix used to call the CLI, resolved on first use."""
        if self._command is None:
            self._command = _find_cli() if self._cli is None else _command_for(self._cli)
        return list(self._command)

    def _run(self, args, allow=(0,)):
        command = self.command + [str(part) for part in args]
        try:
            completed = subprocess.run(
                command,
                cwd=self.cwd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=self.timeout,
            )
        except subprocess.TimeoutExpired:
            raise NodeChemError(
                "ncs did not finish within {0}s: {1}".format(self.timeout, " ".join(command))
            )
        except OSError as error:
            raise NodeChemError("could not run {0}: {1}".format(" ".join(command), error))
        stdout = completed.stdout.decode("utf-8", "replace")
        stderr = completed.stderr.decode("utf-8", "replace")
        if completed.returncode not in allow:
            raise CliError(command, completed.returncode, stdout, stderr)
        return completed.returncode, stdout, stderr

    def _json(self, args, allow=(0,)):
        _, stdout, _ = self._run(args, allow=allow)
        try:
            return json.loads(stdout)
        except ValueError:
            lines = stdout.strip().splitlines()
            first = lines[0] if lines else ""
            raise NodeChemError(
                "ncs {0} did not print JSON; first line: {1!r}".format(
                    " ".join(str(part) for part in args), first
                )
            )

    # -- records ---------------------------------------------------------

    def runs_dir(self, out_dir=None):
        """The ``runs`` folder for an output directory."""
        root = Path(out_dir) if out_dir is not None else self.out_dir
        return root / "runs"

    def list_runs(self, out_dir=None):
        """Summaries of every run folder, newest first.

        Each entry is a plain dict: ``id``, ``path``, ``status``, ``engine``,
        ``title``, ``startedAt``, ``finishedAt``, ``dryRun``, ``gates``,
        ``error`` and ``schemaVersion``. A folder without a readable
        ``run.json`` is reported with ``status: "unreadable"`` rather than
        skipped, so a count never hides a broken run.
        """
        runs = self.runs_dir(out_dir)
        if not runs.is_dir():
            return []
        summaries = []
        for entry in sorted(runs.iterdir(), key=lambda item: item.name, reverse=True):
            if not entry.is_dir() or entry.name.startswith("."):
                continue
            summary = {
                "id": entry.name,
                "path": str(entry),
                "status": "unreadable",
                "engine": None,
                "title": None,
                "startedAt": None,
                "finishedAt": None,
                "dryRun": None,
                "gates": None,
                "error": None,
                "schemaVersion": None,
            }
            try:
                record = json.loads((entry / "run.json").read_text(encoding="utf-8"))
            except (OSError, ValueError) as error:
                summary["error"] = str(error)
                summaries.append(summary)
                continue
            if isinstance(record, dict):
                for key in ("status", "engine", "title", "startedAt", "finishedAt", "dryRun", "error", "schemaVersion"):
                    if key in record:
                        summary[key] = record[key]
                gates = record.get("gates")
                summary["gates"] = gates.get("overall") if isinstance(gates, dict) else None
            summaries.append(summary)
        return summaries

    def read_record(self, run_id, out_dir=None):
        """The full ``run.json`` for one run, as a plain dict."""
        run_id = str(run_id)
        if not _RUN_ID.match(run_id) or run_id in (".", ".."):
            raise NodeChemError("{0!r} is not a run id (a run folder name)".format(run_id))
        path = self.runs_dir(out_dir) / run_id / "run.json"
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            raise RecordNotFoundError(run_id, path)
        try:
            record = json.loads(text)
        except ValueError as error:
            raise NodeChemError("run.json for {0!r} is not valid JSON: {1}".format(run_id, error))
        if not isinstance(record, dict):
            raise NodeChemError("run.json for {0!r} is not a JSON object".format(run_id))
        return record

    def export_document(self, out_dir=None, schema_version=None):
        """The whole ``ncs export`` envelope: schema path, version, records."""
        root = Path(out_dir) if out_dir is not None else self.out_dir
        args = ["export", str(root), "--json"]
        if schema_version is not None:
            args += ["--schema-version", str(schema_version)]
        envelope = self._json(args)
        if not isinstance(envelope, dict) or not isinstance(envelope.get("records"), list):
            raise NodeChemError("ncs export returned an envelope without a records array")
        return envelope

    def export(self, out_dir=None, schema_version=None):
        """Every record in the output folder, as a list of plain dicts.

        Raises :class:`CliError` when the CLI refuses -- for example an unknown
        schema version or a record that does not conform -- instead of
        returning the records that happened to be readable.
        """
        return self.export_document(out_dir=out_dir, schema_version=schema_version)["records"]

    # -- CLI answers -----------------------------------------------------

    def validate(self, project_path):
        """Run ``ncs validate`` and return its payload.

        A project that does not validate is a normal answer, not an exception:
        the payload has ``ok: False`` and the ``errors`` array. Exit codes that
        mean the CLI could not answer (usage, engine failure, a crash) raise
        :class:`CliError`.
        """
        return self._json(["validate", str(project_path), "--json"], allow=(0, 2))


def _default_client(out_dir=None, cli=None):
    return Client(out_dir=out_dir, cli=cli)


def validate(project_path, cli=None):
    """Module-level :meth:`Client.validate`."""
    return _default_client(cli=cli).validate(project_path)


def list_runs(out_dir=None, cli=None):
    """Module-level :meth:`Client.list_runs`; defaults to the current folder."""
    return _default_client(out_dir=out_dir, cli=cli).list_runs()


def read_record(run_id, out_dir=None, cli=None):
    """Module-level :meth:`Client.read_record`."""
    return _default_client(out_dir=out_dir, cli=cli).read_record(run_id)


def export(out_dir=None, schema_version=None, cli=None):
    """Module-level :meth:`Client.export`."""
    return _default_client(out_dir=out_dir, cli=cli).export(
        schema_version=schema_version
    )
