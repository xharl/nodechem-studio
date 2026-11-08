# Synthetic Molden fixtures

Every `.molden` file in this directory was written by hand for the reader tests.
None was captured from ORCA, Psi4, PySCF, Gaussian or any other program, and no
number here is a chemical result. They are valid Molden text whose only job is
to exercise a section, a marker or a refusal.

The round-trip test in `test/molden-read.test.js` does not use these files: it
writes a file with this repository's own Molden writer and reads it back.
