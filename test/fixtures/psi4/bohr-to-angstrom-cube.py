#!/usr/bin/env python3
"""Rewrite a bohr cube (positive grid counts) as the negative-count Å form.

A cube states no units of its own: the sign of the grid counts does. Positive
means the atom rows, origin and step vector are in bohr (what `cubegen`, Psi4
and PySCF all write); negative means they are in Å. Gaussian writes the second
form when it is asked for angstrom, and most tools that write a cube for
another program emit it, but none of the writers available when this fixture
was captured can be asked for it: Psi4 1.11's CUBEPROP module has no units
option (its option registry holds CUBEPROP_TASKS, CUBEPROP_ORBITALS,
CUBEPROP_BASIS_FUNCTIONS, CUBEPROP_ISOCONTOUR_THRESHOLD and CUBEPROP_FILEPATH,
nothing more) and Gaussian's `cubegen` is not installed.

So the Å member of the pair is a **conversion** of the captured Psi4 file, not
a second capture, and it says so in the README. The conversion touches the
header only: the origin, the three step vectors and the three atom columns are
multiplied by the bohr-to-Å constant and the three counts are negated. The
value block is copied byte for byte, which is the point — the same field on the
same grid, differing only in the units its header declares.

    python3 bohr-to-angstrom-cube.py <input-bohr.cube> <output-angstrom.cube>

Both files are then read by `parseCube` in the tests; the Å file is not trusted
as an oracle for the scale factor, only for the sign convention, and the
assertions that matter (step identical across the pair, origin in Å in both)
are made against the *captured* bohr file and its declared units.
"""

import sys

BOHR_TO_ANGSTROM = 0.529177210903  # CODATA 2018, the same constant the reader uses
COUNT_WIDTH = 5
COLUMN_WIDTH = 12
COLUMN_PLACES = 6


def column(value):
    """`%12.6f`, the field width cubegen and Psi4 use."""
    return f'{value:{COLUMN_WIDTH}.{COLUMN_PLACES}f}'


def row(count, values):
    return f'{count:{COUNT_WIDTH}d}' + ''.join(column(value) for value in values)


def main(source, destination):
    with open(source, encoding='utf-8') as handle:
        lines = handle.read().splitlines()

    # Two comment lines, then `natoms ox oy oz`, three grid rows, then the atoms.
    natoms = int(lines[2].split()[0])
    out = [lines[0], lines[1]]

    header = lines[2].split()
    origin = [float(token) * BOHR_TO_ANGSTROM for token in header[1:4]]
    out.append(row(natoms, origin))

    for line in lines[3:6]:
        parts = line.split()
        step = [float(token) * BOHR_TO_ANGSTROM for token in parts[1:4]]
        # A negative count is the whole convention: it is what declares Å.
        out.append(row(-abs(int(parts[0])), step))

    for line in lines[6:6 + natoms]:
        parts = line.split()
        position = [float(token) * BOHR_TO_ANGSTROM for token in parts[2:5]]
        # The nuclear charge column is not a distance, so it is copied as written.
        out.append(row(int(parts[0]), [float(parts[1])] + position))

    same_field = lines[6 + natoms:]
    text = '\n'.join(out + same_field)
    # Psi4's own file ends without a newline; keep that so the value block is
    # copied byte for byte rather than "reformatted to look tidy".
    with open(source, 'rb') as handle:
        ended_with_newline = handle.read()[-1:] == b'\n'
    with open(destination, 'w', encoding='utf-8') as handle:
        handle.write(text + ('\n' if ended_with_newline else ''))


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit('usage: bohr-to-angstrom-cube.py <input-bohr.cube> <output-angstrom.cube>')
    main(sys.argv[1], sys.argv[2])
