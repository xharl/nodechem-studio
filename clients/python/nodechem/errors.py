"""Errors raised by the NodeChem Studio client.

Every failure is a subclass of :class:`NodeChemError`, so a caller can catch one
type. A non-zero exit from the ``ncs`` CLI becomes :class:`CliError`, which
carries the exit code and the raw streams; nothing is returned as a partial
result.
"""


class NodeChemError(Exception):
    """Base class for everything this package raises."""


class RecordNotFoundError(NodeChemError):
    """A run folder has no readable ``run.json``."""

    def __init__(self, run_id, path):
        self.run_id = run_id
        self.path = str(path)
        super().__init__("no run record for {0!r} at {1}".format(run_id, path))


class CliError(NodeChemError):
    """The ``ncs`` command refused or failed.

    Attributes:
        command: the argv that was executed, including the CLI path.
        exit_code: the process exit status.
        stdout: captured standard output, undecoded from the caller's view.
        stderr: captured standard error.
    """

    def __init__(self, command, exit_code, stdout="", stderr="", message=None):
        self.command = list(command)
        self.exit_code = exit_code
        self.stdout = stdout or ""
        self.stderr = stderr or ""
        detail = (self.stderr.strip() or self.stdout.strip()).splitlines()
        first = detail[0].strip() if detail else ""
        # The CLI prefixes every refusal with "ncs: "; keep the sentence, not
        # the program name, so the error reads well in a traceback.
        if first.startswith("ncs: "):
            first = first[len("ncs: "):]
        self.detail = first
        if message is None:
            message = "ncs exited with code {0}{1}".format(
                exit_code, ": " + first if first else ""
            )
        super().__init__(message)
