import fsp from 'node:fs/promises';
import path from 'node:path';

const SAFE_CHECKPOINT = /^[A-Za-z0-9._-]{1,124}\.chk$/i;
// xTB's restart artifact has no extension (`xtbrestart`); the name is still
// constrained to one safe path segment, starting with an alphanumeric so `.`
// and `..` can never escape targetDir.
const SAFE_RESTART_ARTIFACT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,123}$/;
// ORCA's restart data is a `<job>.gbw` file, named by the block or derived from
// the checkpoint field, and read from the working directory on the next run.
const SAFE_ORCA_RESTART = /^[A-Za-z0-9._-]{1,124}\.gbw$/i;
const FIXTURE_HEADER = 'FIXTURE CHECKPOINT — synthetic staging artifact, ';
const FIXTURE_DETAIL = {
  gaussian: 'not a Gaussian checkpoint\n',
  xtb: 'not an xTB restart file\n',
  orca: 'not an ORCA .gbw file\n',
};

/**
 * Copy the upstream checkpoint into the downstream run folder.
 *
 * Gaussian resolves `%OldChk` against the job's working directory, so the file
 * must exist there before the process starts. xTB reads `xtbrestart` from the
 * working directory by itself, so the same copy makes a checkpoint edge work
 * for either engine. A dry run has no real checkpoint, so it stages a clearly
 * labelled fixture instead; a real run fails loudly if the upstream file is
 * missing or empty.
 */
export async function stageCheckpoint({
  sourceRunDir = '',
  checkpoint = '',
  targetDir,
  dryRun = false,
  sourceRunId = null,
  engine = 'gaussian',
}) {
  const isXtb = engine === 'xtb';
  const isOrca = engine === 'orca';
  const safe = isXtb ? SAFE_RESTART_ARTIFACT : isOrca ? SAFE_ORCA_RESTART : SAFE_CHECKPOINT;
  if (!safe.test(String(checkpoint))) {
    throw new Error(isXtb
      ? 'Checkpoint hand-off name must be a safe restart-artifact basename.'
      : isOrca
        ? 'Checkpoint hand-off name must be a safe .gbw basename.'
        : 'Checkpoint hand-off name must be a safe .chk basename.');
  }
  const target = path.join(targetDir, checkpoint);
  const fixture = async (reason) => {
    await fsp.writeFile(target, `${FIXTURE_HEADER}${FIXTURE_DETAIL[isXtb ? 'xtb' : isOrca ? 'orca' : 'gaussian']}reason: ${reason}\n`, 'utf8');
    const stat = await fsp.stat(target);
    return { file: checkpoint, bytes: stat.size, sourceRunId, kind: 'fixture', reason };
  };

  if (!sourceRunDir) {
    if (!dryRun) throw new Error(`Checkpoint hand-off for ${checkpoint} has no upstream run folder.`);
    return fixture('no upstream run folder in dry run');
  }

  const source = path.join(sourceRunDir, checkpoint);
  const stat = await fsp.stat(source).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!stat?.isFile()) {
    if (!dryRun) {
      throw new Error(`Checkpoint hand-off failed: ${source} does not exist. Re-run the upstream task.`);
    }
    return fixture(`missing upstream checkpoint ${source}`);
  }
  if (stat.size === 0) {
    if (!dryRun) {
      throw new Error(`Checkpoint hand-off failed: ${source} is empty (corrupt checkpoint).`);
    }
    return fixture(`empty upstream checkpoint ${source}`);
  }

  await fsp.copyFile(source, target);
  const copied = await fsp.stat(target);
  if (copied.size !== stat.size) {
    throw new Error(`Checkpoint hand-off failed: copied ${copied.size} of ${stat.size} bytes from ${source}.`);
  }
  return { file: checkpoint, bytes: copied.size, sourceRunId, kind: 'copy' };
}
