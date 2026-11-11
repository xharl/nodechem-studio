# Exporting a graph to a SLURM or PBS cluster

NodeChem Studio is local-only: it never submits jobs and never opens a
network connection. **Export cluster scripts** is an offline artifact builder.
It writes a self-contained folder that you can copy to a cluster and submit
yourself with the generated `submit-all.sh`.

## What the export produces

One folder per export, named `cluster-<format>-<timestamp>`:

```
manifest.json      machine-readable plan: schemaVersion/kind, nodes[], edges[], warnings[]
submit-all.sh      submits every job in dependency order
README.txt         usage and licence notes, including the cluster licence warning
<task>.gjf         the exact input the local runner would have written
<task>.slurm       one SLURM script per calculation node (or <task>.pbs)
```

If that folder name already exists, the exporter adds `-2`, `-3`, … rather than writing into the
old one.

The `.gjf` files are built by the same `buildGaussianInput` code the local
runner uses, including the `%Chk`/`%OldChk` hand-off, so a local run and a
cluster run consume identical inputs.

## Dependency mapping

`manifest.json` records `dependsOn` for every job. `submit-all.sh` submits in
topological order and passes the dependencies to the scheduler:

| Format | Dependency argument |
| --- | --- |
| SLURM | `sbatch --dependency=afterok:<jobids>` |
| PBS | `qsub -W depend=afterok:<jobids>` |

Rules, matching the local queue:

- `dependency`, `checkpoint`, `branch` and `barrier` edges are ordering constraints.
- `loop` edges are control flow and are ignored.
- A calculation depends on its nearest calculation ancestors. Control nodes
  (conditions, loops, merges) and notes are not scheduled; a calculation behind
  a condition depends on the condition's upstream calculation.
- A declared checkpoint hand-off (`checkpointFrom`, rendered as `%OldChk`) is
  always a dependency, even if the checkpoint edge is missing.
- Checkpoint hand-offs are validated: a downstream job that reads a different
  `.chk` name than its upstream writes is rejected, and two jobs writing the
  same checkpoint file in one shared folder are rejected.

Because a scheduler cannot evaluate Gaussian gates, a condition's branches are
exported as unconditional dependencies. The export records a warning for every
condition and loop node; review `manifest.json` before submitting.

## Resource mapping

| Gaussian input | SLURM | PBS |
| --- | --- | --- |
| `%NProcShared=N` | `#SBATCH --cpus-per-task=N` | `#PBS -l nodes=1:ppn=N` |
| `%Mem=<N> GB` | `#SBATCH --mem=<N>G` | `#PBS -l mem=<N>gb` |
| `%Mem=<N> MB` | `#SBATCH --mem=<N>M` | `#PBS -l mem=<N>mb` |
| `%Mem=<N> MW` | `#SBATCH --mem=<N*8>M` | `#PBS -l mem=<N*8>mb` |

Megawords are 64-bit words, so one MW is eight megabytes. An input with no `%NProcShared` line is
refused, because the core count cannot be mapped.

The exporter refuses rather than guess in three more cases: a project that contains a `generate`
block (run the ensemble and export from a project whose geometry is the chosen member), a node id or
input/output/checkpoint name that is not a safe basename, and an input above 2 MiB.

Scratch is node-local: every script runs `export GAUSS_SCRDIR="${TMPDIR:-/tmp}"`
and creates the directory. Clusters normally set `TMPDIR` to a per-job local
scratch path; `/tmp` is only a fallback for schedulers that do not.

The scripts assume `g16` is on `PATH` (for example after `module load gaussian`).
Set `G16_EXE` to an absolute path when the cluster installs it elsewhere.

## Importing returned outputs

Copy the whole export folder back after the jobs finish and use **Import
cluster results** in the app's overflow menu. The importer:

1. reads `manifest.json` and the node gate set recorded at export time;
2. finds each returned output (`<task>.out`, falling back to `<task>.log`);
3. parses it with `parseGaussianOutput` and evaluates gates with
   `evaluateGates`, exactly like a local run;
4. writes a normal run folder (`run.json`, `request.json`, the returned output,
   the staged `.gjf`) into the app's run history.

There is no exit code in a batch result, so the parser and gates are the only
authority — an `Error termination` is imported as `failed`, never a pass.
Outputs are reported as missing when absent; the importer never fabricates a
run record for a job that did not return anything.

## Licence implications

Gaussian is licensed commercial software. Running an exported script set
requires a Gaussian licence that covers the cluster, its users and every node
that executes a job. NodeChem Studio does not include, copy or redistribute
Gaussian; you must install and licence it on the cluster yourself. Check the
licence terms before submitting — site licences can restrict named users,
specific hosts or the number of concurrent jobs. The exported `README.txt`
repeats this warning next to the scripts.

## Limitations

- The export cannot evaluate conditions or retry loops; both branches of a
  condition are scheduled conservatively and loops are not exported.
- Job IDs are only known at submission time, so the `afterok` wiring lives in
  `submit-all.sh`, not in a literal `#SBATCH --dependency=` line inside each
  per-node script.
- Real SLURM/PBS execution has not been verified in this repository's Linux
  container: there is no scheduler here. Generation, file contents and output
  import are covered by Vitest.
