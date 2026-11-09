#!/usr/bin/env python3
"""Build src/shared/data/dp4plus-qm.json from the DP4+ reference package.

One-off, developer-side conversion. The app never runs this: the JSON is
committed, read by src/shared/dp4.js with no third-party code, and the source
archive is not. Requires `openpyxl` (only this script does).

Usage:
    python3 scripts/build-dp4-bank.py <unpacked dp4plus_app-x.y.z root> <out.json> [archive]
    python3 scripts/build-dp4-bank.py --example <root> <fixture.json>

The input archive is dp4plus_app-2.2.3.tar.gz from PyPI (MIT). Nothing here
selects, rounds or otherwise touches a number: every value written is the cell
value openpyxl reports, at full double precision.
"""
import hashlib
import json
import os
import sys

from openpyxl import load_workbook

PARAM_ROWS = ('Csp2', 'Csp3', 'Hsp2', 'Hsp3', 'Csca', 'Hsca')


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def level_identity(sheet):
    """`mPW1PW91.6-31+G(d,p).PCM` -> (method, basis, solvation)."""
    body = sheet
    solvation = 'gas'
    if body.endswith('.PCM'):
        body = body[: -len('.PCM')]
        solvation = 'PCM'
    method, basis = body.split('.', 1)
    return method, basis, solvation


def read_parameters(worksheet):
    rows = list(worksheet.iter_rows(values_only=True))
    head = [str(cell).strip() if cell is not None else '' for cell in rows[0]]
    assert head[:4] == ['', 'n', 'm', 's'], f'unexpected header {head!r}'
    out = {}
    for row in rows[1:]:
        if row[0] is None:
            continue
        name = str(row[0]).strip()
        assert name in PARAM_ROWS, f'unexpected parameter row {name!r}'
        out[name] = {'df': float(row[1]), 'mean': float(row[2]), 'scale': float(row[3])}
    assert set(out) == set(PARAM_ROWS), f'missing parameter rows: {set(PARAM_ROWS) - set(out)}'
    return out


def read_standards(worksheet):
    rows = list(worksheet.iter_rows(values_only=True))
    head = [str(cell).strip() if cell is not None else '' for cell in rows[0]]
    assert head[1:3] == ['C', 'H'], f'unexpected standard header {head!r}'
    out = {}
    for row in rows[1:]:
        if row[0] is None:
            continue
        out[str(row[0]).strip()] = {'C': float(row[1]), 'H': float(row[2])}
    return out


def main():
    root, out_path = sys.argv[1], sys.argv[2]
    bank_dir = os.path.join(root, 'src', 'dp4plus_app', 'parameters_bank')
    qm_path = os.path.join(bank_dir, 'data_base_QM.xlsx')
    book = load_workbook(qm_path, data_only=True)

    sheets = book.sheetnames
    # A parameter sheet's header row reads n, m, s; a solvent sheet's reads C, H.
    standards_by_sheet = {}
    level_sheets = []
    for name in sheets:
        if name == 'standard':
            continue
        first = next(book[name].iter_rows(min_row=1, max_row=1, values_only=True))
        if first[1:4] == ('n', 'm', 's'):
            level_sheets.append(name)
        else:
            standards_by_sheet[name] = read_standards(book[name])

    levels = {}
    for sheet in level_sheets:
        method, basis, solvation = level_identity(sheet)
        key = f'{method}/{basis}'
        entry = levels.setdefault(key, {'method': method, 'basis': basis})
        entry.setdefault('variants', {})[solvation] = {
            'parameters': read_parameters(book[sheet]),
            'standards': {},
            'sourceSheet': sheet,
        }

    # Attach the TMS/standard shielding for each (level, solvent) pair. A level
    # that appears in no solvent sheet gets no standard and is therefore
    # unusable — which is a refusal, not a zero.
    for solvent, table in standards_by_sheet.items():
        for sheet_name, standard in table.items():
            method, basis, solvation = level_identity(sheet_name)
            entry = levels.get(f'{method}/{basis}')
            if not entry:
                continue
            variant = entry['variants'].get(solvation)
            if not variant:
                continue
            variant['standards'][solvent] = standard

    payload = {
        'schemaVersion': 1,
        'source': {
            'package': 'dp4plus_app',
            'version': '2.2.3',
            'license': 'MIT',
            'repository': 'RosarioCCLab/DP4plus-App',
            'archive': 'dp4plus_app-2.2.3.tar.gz',
            'archiveSha256': sha256(sys.argv[3]) if len(sys.argv) > 3 else None,
            'workbook': 'src/dp4plus_app/parameters_bank/data_base_QM.xlsx',
            'workbookSha256': sha256(qm_path),
        },
        'method': 'DP4+ (Grimblat, Zanardi, Sarotti, J. Org. Chem. 2015, 80 (24), 12526-12534)',
        'comment': (
            'Per-level Student-t error fits (df, mean, scale) and the reference '
            'shielding of the standard, transcribed from the MIT-licensed DP4+ '
            'reference package by scripts/build-dp4-bank.py. Every number is the '
            'cell value as stored; see PROVENANCE.md. A level or solvent that is '
            'not a key here does not exist in the app.'
        ),
        'levels': levels,
    }
    with open(out_path, 'w', encoding='utf-8') as handle:
        json.dump(payload, handle, indent=2, sort_keys=True, ensure_ascii=False)
        handle.write('\n')

    total = sum(len(entry['variants']) for entry in levels.values())
    print(f'wrote {out_path}: {len(levels)} levels, {total} level variants, '
          f'{len(standards_by_sheet)} standard tables')


EXAMPLE_LEVEL = {'method': 'mPW1PW91', 'basis': '6-31+G(d,p)', 'solvation': 'PCM', 'solvent': 'CHCl3'}


def read_shieldings(path):
    """The isotropic shieldings and the last SCF energy before the POP line.

    This is the same window the reference reads: every `Isotropic =` line, and
    the `SCF Done:` that precedes them in the NMR job.
    """
    shieldings, energy = [], None
    with open(path, 'rt', errors='replace') as handle:
        for line in handle:
            if 'SCF Done:' in line:
                energy = float(line.split()[4])
            if 'Isotropic = ' in line:
                shieldings.append(float(line.split()[4]))
            if 'Population analysis using the SCF density' in line and shieldings:
                break
    return shieldings, energy


def build_example(root, out_path):
    """Compact fixture of the reference package's example_nmr_only study.

    The example is the package's own synthetic study (its manual says so), used
    here as a reproduction of the reference procedure — not as measured data.
    """
    directory = os.path.join(root, 'src', 'dp4plus_app', 'examples', 'example_nmr_only')
    correlation = os.path.join(directory, '0_Correlation Isom 01.xlsx')
    sheet = load_workbook(correlation, data_only=True)['shifts']
    grid = [row for row in sheet.iter_rows(values_only=True)]
    table = [row for row in grid[1:] if row[0] is not None]
    isomers = sorted({
        os.path.basename(name).split('_', 1)[0]
        for name in os.listdir(directory)
        if name.endswith('.log') and 'brk' not in name.lower()
    })
    experimental, assignments = [], {isomer: [] for isomer in isomers}
    for row in table:
        experimental.append({
            'index': int(row[0]),
            'nucleus': str(row[1]).strip(),
            'sp2': row[2] in ('x', 'X', 1),
            'shift': float(row[3]),
            'exchange': str(row[4]).strip() if row[4] not in (None, '') else None,
        })
        for position, isomer in enumerate(isomers):
            labels = row[5 + 3 * position: 8 + 3 * position]
            assignments[isomer].append([int(value) for value in labels if value is not None])
    candidates = []
    for isomer in isomers:
        names = sorted(
            name for name in os.listdir(directory)
            if name.endswith('.log') and 'brk' not in name.lower() and name.startswith(f'{isomer}_')
        )
        conformers = []
        for name in names:
            shieldings, energy = read_shieldings(os.path.join(directory, name))
            # One line per conformer: the atom number is the array position.
            conformers.append({'energyHartree': energy, 'shieldings': shieldings})
        candidates.append({'id': isomer, 'title': f'isomer {isomer}', 'conformers': conformers,
                           'assignments': assignments[isomer]})
    payload = {
        'comment': (
            "Fixture from dp4plus_app 2.2.3's own example_nmr_only study: isotropic "
            'shieldings and SCF energies of every conformer, the experimental shifts and '
            'the atom assignment. The reference package calls this study synthetic '
            '(not real-world data); it is used to reproduce the reference procedure.'
        ),
        'source': {
            'package': 'dp4plus_app', 'version': '2.2.3', 'license': 'MIT',
            'directory': 'src/dp4plus_app/examples/example_nmr_only',
        },
        'level': EXAMPLE_LEVEL,
        'experimental': experimental,
        'candidates': candidates,
    }
    # Written by hand rather than by json.dump(indent=1): a 47-atom shielding
    # list belongs on one line, so the fixture stays readable in a diff.
    lines = ['{']
    lines.append(f' "comment": {json.dumps(payload["comment"])},')
    lines.append(f' "source": {json.dumps(payload["source"])},')
    lines.append(f' "level": {json.dumps(payload["level"])},')
    lines.append(' "experimental": [')
    lines.append(',\n'.join(f'  {json.dumps(row)}' for row in experimental))
    lines.append(' ],')
    lines.append(' "candidates": [')
    blocks = []
    for candidate in candidates:
        block = ['  {',
                 f'   "id": {json.dumps(candidate["id"])},',
                 f'   "title": {json.dumps(candidate["title"])},',
                 f'   "assignments": {json.dumps(candidate["assignments"])},',
                 '   "conformers": [']
        block.append(',\n'.join(f'    {json.dumps(conformer)}' for conformer in candidate['conformers']))
        block.append('   ]}')
        blocks.append('\n'.join(block))
    lines.append(',\n'.join(blocks))
    lines.append(' ]')
    lines.append('}')
    with open(out_path, 'w', encoding='utf-8') as handle:
        handle.write('\n'.join(lines) + '\n')
    print(f'wrote {out_path}: {len(candidates)} candidates, '
          f'{sum(len(c["conformers"]) for c in candidates)} conformers, {len(experimental)} shifts')


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--example':
        build_example(sys.argv[2], sys.argv[3])
    else:
        main()
