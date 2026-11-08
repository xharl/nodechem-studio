# Spectra: reading a JCAMP-DX file

NodeChem writes `.jdx` and, since #119, reads one back. Both directions matter: exporting a computed
spectrum is only half of an exchange format, and the comparison surface is only useful if the
spectrum from the spectrometer — or from a colleague's program — can sit beside the computed one.
Before this, a `.jdx` could be written and not opened, which made the format a one-way door.

The reader is `src/shared/jcamp.js`; the results panel reaches it through
`src/shared/spectrumImport.js`. Nothing in it knows what produced the file.

## What is read

| Section | Form | What it carries |
| --- | --- | --- |
| `##XYDATA` | `(X++(Y..Y))` | one x value per line, then as many y values as fit |
| `##XYDATA` | `(XY..XY)` | explicit pairs, for writers that use `##XYDATA` for the pair form |
| `##XYPOINTS` | `(XY..XY)` | explicit pairs, the older form |

Both return the shape the results panel already draws: `points` of `{x, y}`, `rows`, `skipped`,
`minX`/`maxX`/`minY`/`maxY`, plus the header fields and a `notes` list. There is no second code path
in the view for an imported file.

Header fields that are honoured, not merely noticed:

| Field | Use |
| --- | --- |
| `##XUNITS`, `##YUNITS` | carried verbatim; never guessed — see below |
| `##XFACTOR` | the x increment and the scale of the stored x (`actual x = stored x × XFACTOR`) |
| `##YFACTOR` | every intensity, differences included, is multiplied by it |
| `##NPOINTS` | checked against the number of points the data block delivered |
| `##FIRSTX`, `##LASTX` | checked against the first and last point actually delivered |
| `##TITLE`, `##DATA TYPE`, `##ORIGIN`, `##OWNER`, `##DATE` | carried through unchanged |

## The x axis is reconstructed, then checked

In `X++(Y..Y)` only the first x of each line is written. The reader takes that value, multiplies by
`##XFACTOR`, and advances by exactly `##XFACTOR` for each further y on the line. The next line's
starting x is then compared with where that grid says it should be. If it disagrees, the file is
refused rather than resampled:

```
data line 2 starts at x = 4003, but the preceding points put the next x at 4002; the file is not on
the even grid ##XFACTOR declares, and this reader will not invent the step.
```

A descending axis is legal and common for NMR: it is declared by `##FIRSTX` being larger than
`##LASTX`, and the stored x then decreases by one per point. The points are reordered ascending for
plotting and the returned `notes` say so; the values are unchanged.

`##NPOINTS`, `##FIRSTX` and `##LASTX` are integrity checks, not instructions. A file whose header
and data disagree is refused with both numbers named — never silently trusted, and never silently
corrected by spreading the points evenly:

```
##NPOINTS says 6 but the data block delivered 5 points.
##FIRSTX says 4000 but the data block starts at 3999.
##LASTX says 4002.5 but the data block ends at 4002.
```

## Compression

JCAMP-DX compresses the y column with pseudo-digits. The reader expands all four forms:

| Marker | Name | Meaning | Example |
| --- | --- | --- | --- |
| `@`, `A`–`I`, `a`–`i` | SQZ | the leading digit and sign are replaced | `A000` = +1000, `a001` = −1001 |
| `%`, `J`–`R`, `j`–`r` | DIF | a difference from the previous y | `J000` = +1000, `%` = no change |
| `?` | DIF, numeric | the same difference, written out | `?7` = previous + 7, `?-10` = previous − 10 |
| `S`–`Z`, `s` | DUP | the previous value repeated, itself included | `U` = three identical values |

A difference at the start of a line continues from the last y of the previous line, so a two-line
file can hide the join. This fixture (`test/fixtures/jcamp/xydata-difdup.jdx`, hand-written for these
tests) uses every marker:

```
##NPOINTS=10
##FIRSTX=1600
##LASTX=1609
##XYDATA= (X++(Y..Y))
1600 A000J000JJJ
1605 %U ?7 ?-10
```

and reads back as `1000, 2000, 2001, 2002, 2003, 2003, 2003, 2003, 2010, 2000` — `A000` sets the
first value, `J000` and the three `J` markers are differences, `%` is a zero difference, `U` repeats
the value three times including the first, and `?7`/`?-10` are numeric differences. The returned
`compression` field names the forms met, here `affn+sqz+dif+dup`, so a reader of the result can tell
what was expanded.

A character that is neither a number nor a marker from this table is an error, not a skipped token:

```
data line 2 contains "#", which is not a number and not a compression marker this reader implements.
```

## Units are carried, not assumed

A file with no `##XUNITS` comes back with `xUnits: null`, `xUnitsUnknown: true`, and a note saying
the axis declared nothing. A wavenumber is not filled in because a wavenumber is likely: the app
writes `1/CM` for a vibrational spectrum and `NM` for a UV/Vis one, and a reader that guessed would
turn "unknown" into a chemistry claim.

The panel uses that distinction when it overlays. `sameAxisUnits` maps the declared string to a
quantity (`1/CM`, `cm-1`, `CM^-1` are all wavenumber) and returns `null` when it cannot map one. An
imported trace whose declared axis is not `1/CM` is not drawn on the vibrational figure at all; the
caption says why. An undeclared axis is drawn, with a caption saying it was assumed to match.

## Refusals name the section

None of these are "unsupported file". Each names the tag and the reason:

| What the file is | What the reader says |
| --- | --- |
| `##RADATA` only | its only data section is `##RADATA`, which holds peaks or other derived rows rather than a sampled trace: it carries peaks, not points |
| `##PEAK TABLE` only | its only data section is `##PEAK TABLE`, which lists peaks, not points: a peak table is a summary and cannot be overlaid as a curve |
| `##NTUPLES` | declares a multi-block file: its `##PAGE` blocks hold several spectra and this reader returns one |
| `##DATA TABLE` | not implemented: its columns are an assignment rather than a sampled trace |
| an `##XYDATA` form such as `(X++(R..R))` | quotes the form and says it reads `(X++(Y..Y))` and `(XY..XY)` |
| no data section | this file carries neither `##XYDATA` nor `##XYPOINTS` |
| an axis that is not monotonic | names the point where the direction reverses |

A file that carries `##XYDATA` **and** a `##PEAK TABLE` is readable: the points are read and the
note says the peak table was ignored, because peaks are derived from the point list and a summary is
not a second measurement.

## Round-trip against this repository's writer

`test/jcamp.test.js` writes a spectrum with `writeJcampDx` and reads it back with `readJcampDx`:

| Source | Points | Worst difference |
| --- | --- | --- |
| Raman activities from `g16-h2o-raman.out` | 3 | exact in x and y |
| broadened UV/Vis from `g16-dvb-td.out` | 240 | 5.0·10⁻⁸ nm in x, 4.9·10⁻⁹ in y |

The writer formats x to 10 significant digits and y to 8, so those are the bounds a round-trip can
reach, not a tolerance the reader was given. Units, data type and title survive unchanged.

The three fixtures under `test/fixtures/jcamp/` are **hand-written for the tests**. They are valid
JCAMP-DX and deliberately small, and none of them came off an instrument: no real `.jdx` is
redistributed here, and no number in them is a measurement.

## What is not wired

- **No CLI verb.** `ncs spectra import spectrum.jdx` does not exist yet. The reader is a shared
  module with a documented shape, so the verb is a thin wrapper over `readJcampDx`; `bin/ncs.js` was
  deliberately left to the workstream that owns it.
- **One overlay slot.** The import lives on the Raman card's file input, which now accepts `.jdx`
  and `.dx` as well as `.csv`/`.txt`. There is no separate "import a spectrum" surface beside the
  other spectral cards.
- **Reading `##NTUPLES`, `##RADATA` and peak tables** is out of scope in #119, as are vendor binary
  formats. They are refused by name rather than half-read.

## Next

- [Converters](converters.md) — the formats `ncs convert` writes, and the conventions each carries.
- [Results and analysis](results.md) — the figures the imported trace is drawn against.
- [Command line](cli.md) — the rest of `ncs`.

Back to the [documentation index](README.md).
