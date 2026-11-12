import { defineConfig } from 'vite';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const ROOT = path.dirname(fileURLToPath(import.meta.url));

// Issue #375: the renderer used to ship one 1.38 MB chunk. `resultsView` is a
// dynamic import now; these groups split the modules the shell *does* need
// statically into feature-sized chunks so no emitted file crosses the 500 kB
// build gate. Modules reachable only through the dynamic import are left out,
// so they stay deferred instead of being pulled back into an eager chunk.
const PROJECT_MODULES = new Set([
  'projectSchema.js', 'workflowTasks.js', 'validityChecks.js', 'flows.js',
  'templates.js', 'editHistory.js', 'queueReconcile.js', 'appSettings.js',
  'projectFile.js', 'projectMerge.js', 'recentProjects.js', 'floatingWindow.js',
  'draft.js', 'gaussianInput.js', 'blockContracts.js',
]);
const ANALYSIS_MODULES = new Set([
  'conformers.js', 'costEstimate.js', 'multiwfn.js', 'dp4.js', 'dp4Workflow.js',
  'compute.js', 'derivative.js', 'constraints.js', 'spinSweep.js',
  'chargeTransfer.js', 'reactionPath.js', 'kinetics.js', 'esp.js', 'qtaim.js',
  'epr.js', 'uncertainty.js', 'pka.js', 'nmr.js', 'excitedStates.js',
  'series.js', 'complex.js', 'exciton.js', 'tautomers.js', 'scorer.js',
  'tsForceConstants.js', 'formula.js', 'prepare.js', 'explicitSolvation.js',
]);

/**
 * Every module the renderer imports statically, starting at `app.js`. The
 * parser is deliberately small: the repository has no aliases and no
 * `export *` re-export chains outside these relative imports.
 */
function staticModuleGraph(entry) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      return;
    }
    const patterns = [
      /\bimport\s+[^'"]*?\bfrom\s+['"]([^'"]+)['"]/g,
      /\bimport\s+['"]([^'"]+)['"]/g,
      /\bexport\s+[^'"]*?\bfrom\s+['"]([^'"]+)['"]/g,
    ];
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1];
        if (!specifier.startsWith('.')) continue;
        const resolved = path.resolve(path.dirname(file), specifier);
        const target = statSync(resolved, { throwIfNoEntry: false })?.isFile()
          ? resolved
          : `${resolved}.js`;
        if (statSync(target, { throwIfNoEntry: false })?.isFile()) visit(target);
      }
    }
  };
  visit(entry);
  return seen;
}

const STATIC_MODULES = staticModuleGraph(path.join(ROOT, 'src', 'renderer', 'app.js'));

function sharedChunkName(id) {
  const modulePath = path.resolve(String(id).split('?')[0]);
  if (!STATIC_MODULES.has(modulePath)) return null;
  const match = modulePath.match(/[\\/]src[\\/]shared[\\/](.+)$/);
  if (!match) return null;
  const file = match[1].replace(/\\/g, '/');
  if (file.startsWith('engines/')) return 'chem-engines';
  const base = file.split('/').pop();
  if (PROJECT_MODULES.has(base)) return 'chem-project';
  if (ANALYSIS_MODULES.has(base)) return 'chem-analysis';
  return 'chem-support';
}

export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          minSize: 20_000,
          groups: [
            {
              name: sharedChunkName,
              debugName: 'nodechem-shared',
              test: /[\\/]src[\\/]shared[\\/]/,
              minSize: 20_000,
            },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    // The queue and runner suites drive real child processes and wait on files
    // landing in the run folder. Vitest's 5 s default is a statement about the
    // speed of the CI runner, not about the code, and windows-latest loses that
    // bet: the crash-recovery test timed out waiting for a persisted state that
    // does arrive. Assertions are unchanged; only the patience is.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
