#!/usr/bin/env python3
"""Self-test for the NodeChem Studio Python client.

Run it with the interpreter only -- there is no test dependency and no network:

    python3 clients/python/test_client.py

Most tests drive a stand-in CLI written to a temporary folder, so they prove
the client's contract (JSON parsing, exit-code handling, typed errors) without
Node. When this file sits in a checkout that has ``examples/single-point.ncs``
and a Node runtime, one extra test calls the real ``ncs validate`` and is
skipped otherwise.
"""

import json
import shutil
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import nodechem  # noqa: E402  (the path insert must happen first)

FIXTURES = HERE / "tests" / "fixtures"
RUN_ID = "20260101-120000-abc123"

FAKE_CLI = textwrap.dedent(
    '''
    import json
    import sys
    from pathlib import Path

    argv = sys.argv[1:]
    command = argv[0] if argv else ""


    def flag(name):
        if name in argv:
            index = argv.index(name)
            return argv[index + 1] if index + 1 < len(argv) else True
        return None


    if command == "validate":
        path = Path(argv[1])
        text = path.read_text(encoding="utf-8")
        if "EXPLODE" in text:
            sys.stderr.write("ncs: the engine refused to start\\n")
            sys.exit(4)
        if "BROKEN" in text:
            print(json.dumps({
                "ok": False,
                "file": str(path),
                "schemaVersion": 1,
                "migrated": False,
                "errors": [{"path": "/nodes/0", "message": "settings.jobType is not a known job"}],
                "warnings": [],
                "validity": {"overall": "unknown", "findings": [], "blocking": []},
            }))
            sys.exit(2)
        print(json.dumps({
            "ok": True,
            "file": str(path),
            "schemaVersion": 1,
            "migrated": False,
            "errors": [],
            "warnings": [],
            "validity": {"overall": "pass", "findings": [], "blocking": []},
        }))
        sys.exit(0)

    if command == "export":
        root = Path(argv[1])
        version = flag("--schema-version")
        if version is not None and str(version) != "1":
            sys.stderr.write(
                'ncs: unsupported run-record schema version "%s"; this build ships version 1.\\n'
                % version
            )
            sys.exit(2)
        records = [
            json.loads(path.read_text(encoding="utf-8"))
            for path in sorted((root / "runs").glob("*/run.json"))
        ]
        print(json.dumps({
            "kind": "nodechem-studio.records",
            "schemaVersion": 1,
            "schema": "schemas/run-record.v1.schema.json",
            "generatedAt": "2026-01-01T00:00:00.000Z",
            "outDir": str(root),
            "recordCount": len(records),
            "records": records,
        }))
        sys.exit(0)

    sys.stderr.write("ncs: unknown command\\n")
    sys.exit(1)
    '''
).lstrip()


class ClientTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="nodechem-client-")
        cls.fake = Path(cls.tmp) / "fake_ncs.py"
        cls.fake.write_text(FAKE_CLI, encoding="utf-8")
        cls.cli = [sys.executable, str(cls.fake)]
        cls.project_ok = Path(cls.tmp) / "ok.ncs"
        cls.project_ok.write_text('{"schemaVersion": 1}', encoding="utf-8")
        cls.project_broken = Path(cls.tmp) / "broken.ncs"
        cls.project_broken.write_text('{"BROKEN": true}', encoding="utf-8")
        cls.project_explodes = Path(cls.tmp) / "explode.ncs"
        cls.project_explodes.write_text('{"EXPLODE": true}', encoding="utf-8")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def client(self):
        return nodechem.Client(out_dir=FIXTURES, cli=self.cli)

    # -- records ---------------------------------------------------------

    def test_list_runs_returns_plain_dicts(self):
        runs = self.client().list_runs()
        self.assertIsInstance(runs, list)
        self.assertEqual([run["id"] for run in runs], [RUN_ID])
        run = runs[0]
        self.assertIsInstance(run, dict)
        self.assertEqual(run["status"], "completed")
        self.assertEqual(run["engine"], "xtb")
        self.assertEqual(run["gates"], "pass")
        self.assertIs(run["dryRun"], True)
        self.assertEqual(run["schemaVersion"], 1)
        self.assertTrue(Path(run["path"]).is_dir())

    def test_read_record_returns_the_record(self):
        record = self.client().read_record(RUN_ID)
        self.assertIsInstance(record, dict)
        self.assertEqual(record["id"], RUN_ID)
        self.assertEqual(record["parsed"]["finalEnergy"]["hartree"], -5.070370764545)
        self.assertEqual(record["schemaVersion"], 1)

    def test_read_record_missing_raises(self):
        with self.assertRaises(nodechem.RecordNotFoundError) as caught:
            self.client().read_record("20260101-000000-nope00")
        self.assertEqual(caught.exception.run_id, "20260101-000000-nope00")

    def test_read_record_refuses_a_path(self):
        for bad in ("../escape", "a/b", "..", ""):
            with self.assertRaises(nodechem.NodeChemError):
                self.client().read_record(bad)

    def test_list_runs_of_a_missing_folder_is_empty(self):
        self.assertEqual(nodechem.Client(out_dir=Path(self.tmp) / "nothing").list_runs(), [])

    # -- CLI answers -----------------------------------------------------

    def test_validate_returns_the_payload(self):
        result = self.client().validate(self.project_ok)
        self.assertTrue(result["ok"])
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["schemaVersion"], 1)

    def test_validate_of_an_invalid_project_is_an_answer_not_an_error(self):
        result = self.client().validate(self.project_broken)
        self.assertFalse(result["ok"])
        self.assertEqual(len(result["errors"]), 1)
        self.assertIn("jobType", result["errors"][0]["message"])

    def test_validate_of_a_cli_refusal_raises_typed_error(self):
        with self.assertRaises(nodechem.CliError) as caught:
            self.client().validate(self.project_explodes)
        error = caught.exception
        self.assertEqual(error.exit_code, 4)
        self.assertIn("engine refused", error.detail)
        self.assertIsInstance(error, nodechem.NodeChemError)

    def test_export_returns_records(self):
        records = self.client().export()
        self.assertIsInstance(records, list)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["id"], RUN_ID)
        self.assertEqual(records[0]["schemaVersion"], 1)

    def test_export_document_names_the_schema(self):
        document = self.client().export_document()
        self.assertEqual(document["kind"], "nodechem-studio.records")
        self.assertEqual(document["schemaVersion"], 1)
        self.assertTrue(document["schema"].endswith("run-record.v1.schema.json"))
        self.assertEqual(document["recordCount"], 1)

    def test_export_of_an_unknown_schema_version_raises(self):
        with self.assertRaises(nodechem.CliError) as caught:
            self.client().export(schema_version=2)
        self.assertEqual(caught.exception.exit_code, 2)
        self.assertIn("schema version", caught.exception.detail)

    # -- the real CLI ----------------------------------------------------

    def test_real_cli_accepts_a_shipped_example(self):
        repo = HERE.parents[1]
        example = repo / "examples" / "single-point.ncs"
        has_node = shutil.which("node") is not None or shutil.which("ncs") is not None
        if not example.is_file() or not has_node:
            self.skipTest("no checkout example or no Node runtime")
        result = nodechem.Client(cli=repo / "bin" / "ncs.js").validate(example)
        self.assertTrue(result["ok"], result.get("errors"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
