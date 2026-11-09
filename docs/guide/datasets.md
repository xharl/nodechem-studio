# Datasets and input blocks

A **dataset** is a named, ordered set of molecule **records** stored inside the project. An
**input block** binds a flow to one dataset and makes the rest of that flow run once per enabled
record. The graph is still the workspace: there is no "for each" block to draw and no second
canvas. The dataset is the loop.

```
input block ──▶ optimise ──▶ frequency ──▶ output
   enols        (mol1)       (mol1)        one table
  12 records     (mol2)       (mol2)
                 …            …
```

A flow without an input block runs once on the project molecule, exactly as every v1 project did.

## Importing a dataset

Select an input block and use **Import dataset file…** in the inspector. The file picker accepts:

| Format | What one record is |
| --- | --- |
| `.sdf` | Everything up to a `$$$$` terminator; the first line is the label and `M  CHG` sets the formal charge |
| `.xyz` | One frame: a count line, a comment line (the label), then the atom lines |
| `.csv` | Rows grouped by `id`/`label` (one atom per row), or repeated `x1,y1,z1,…` columns (one record per row) |
| `.json` | An array of records, or an object with a `records` array |
| `.cdxml` | One `<fragment>` of a ChemDraw drawing; see [ChemDraw drawings](#chemdraw-drawings-cdxml) below |

Every record needs coordinates. **A file with no geometry is refused**: this app does not invent a
structure, embed a SMILES string or fill in a demo molecule. Bad records are skipped and named in
the toast; if nothing usable remains, nothing is imported.

The supported record shape, as JSON:

```json
[
  {
    "id": "acetylacetone-enol",
    "label": "acetylacetone (enol)",
    "charge": 0,
    "multiplicity": 1,
    "enabled": true,
    "coords": [
      { "element": "C", "x": 0.0, "y": 0.0, "z": 0.0 }
    ]
  }
]
```

A CSV may carry one atom per row:

```csv
id,label,charge,multiplicity,element,x,y,z
water,Water,0,1,O,0,0,0.1173
water,Water,0,1,H,0,0.7572,-0.4692
```

or one record per row with repeated atom groups:

```csv
id,label,charge,multiplicity,element1,x1,y1,z1,element2,x2,y2,z2
water,Water,0,1,O,0,0,0,H,0,0,0.97
```

The CSV needs an `element` column (or `element1`, `element2`, … beside the coordinates). A file with
`x,y,z` but no element column is refused rather than guessed at.

When the file picker is unavailable, the same inspector has a **Paste records instead** field: paste
the SDF, XYZ, CSV, JSON or CDXML text, choose a format (or let it detect), and import. This is also what
keeps the browser preview usable without the desktop bridge.

### ChemDraw drawings (`.cdxml`)

ChemDraw can save its drawing as CDXML, the XML form, and that is what this app reads. Every
`<fragment>` becomes one record, so a salt, a host–guest pair or a scheme drawn on one page imports as
several records instead of one merged molecule.

| The file says | The import reads |
| --- | --- |
| `<n p="x y">` | one atom at `z = 0` |
| a `<t>` label inside a node — `O`, `N`, `Cl`, `Na`, `N+`, `O-`, `NH4+` | that element and its formal charge |
| an unlabelled node | carbon |
| `<b B="…" E="…" Order="…">` | a bond; `Order="1.5"` stays aromatic |
| `Display="WedgeBegin"`, `WedgeEnd`, `WedgedHashBegin`, `WedgedHashEnd` | the narrow end, recorded as a tetrahedral **drawing cue** |

**It is a drawing, not a geometry.** Coordinates are the page units ChemDraw stores (y up), with `z`
set to `0`; bond lengths are typographic, not physical, and only the drawn skeleton is present —
hydrogens that the drawing leaves implicit are not added. The record therefore carries
`geometry.dimension = "2d"` and a warning that says the same thing, so nothing downstream can mistake
planar page coordinates for a conformer. No R/S is assigned: a wedge states which end is narrow, and
that is all that is kept. The import never embeds, optimises or "cleans up" the drawing.

**Labels and ids.** A record is labelled from the fragment's own text — its `Name` attribute, or a
text block drawn beside it — and from its **index** (`fragment 2`) only when the drawing gave it none.
Two fragments drawn with the same text keep that same label, because that is what the drawing says;
their **ids** are made unique with a numeric suffix (`ligand`, `ligand-2`), because a task id
(`freq~ligand`) has to name one record. Repeated SDF titles behave the same way.

**The run gate.** A frequency or a single point on a drawing reports on the drawing, not the
molecule, so a flow whose **first calculation block** is one of those refuses a drawing record until
you confirm it. The refusal names the record and the block, the record is not dropped, and nothing is
queued: the run asks once, and **Use the drawings and continue** stores `drawingConfirmed` on those
records and plans the flow again. An optimisation first, or a block that reads a checkpoint, needs no
confirmation — it hands over a geometry it built. The record is stored as:

```json
{ "id": "ligand-2", "label": "ligand", "coords": [ … ], "geometry": { "dimension": "2d" }, "drawingConfirmed": true }
```

Refused **by name**, with the reason in the message:

- a node label that cannot be reduced to one element (`CO2H`, `SO3H`, a stray word) — it is never
  quietly turned into carbon;
- a bond `Order` other than 1, 2, 3 or 1.5, and a bond whose `B`/`E` names a node outside its own
  fragment;
- a fragment with no nodes or a node with no readable `p`; the other fragments in the file still
  import, and the error names the fragment it belongs to.

Arrows, curves, TLC plates and other non-molecule graphics are not chemistry and are skipped, but the
first record's warnings name the element types that were ignored, so nothing disappears in silence. A
text block drawn near a fragment is used as that record's label.

`.cdx` — the proprietary binary ChemDraw document — is **not** read. The refusal names the format and
asks for a CDXML save (or an SDF export): the binary layout has no public specification and this
reader does not guess at one.

## Records in the inspector

The input inspector lists every record with its label, charge, multiplicity and an **on** checkbox.
Unchecking a record keeps it in the project file but removes it from the next plan; it is not
deleted. The block card shows `enabled / total` and the dataset's format. A record imported from a
drawing carries a **2D** pill beside its id, and the card counts them.

Importing into a bound input block **replaces** that dataset's records and source in place, so the
graph keeps pointing at the same dataset id. Importing into an unbound block creates a new dataset
named after the file, with a unique id slug.

## What a run does

The planner expands one task per enabled record for every block downstream of the input:

| Situation | Task id |
| --- | --- |
| one record | `opt` — unchanged from v1 |
| several records | `opt~mol1`, `opt~mol2` |
| conformer fan-out inside a record | `opt~mol1~c2` |

`dependency` edges hand off within the same record. A `barrier` edge waits for the source block to
be terminal for **every enabled record** before the next block starts, which is how a stage fence is
drawn without a group abstraction. Independent records may overlap when the run console's
**Parallel tasks** value (or `runner.maxParallel` in the project) is above 1; the default of 1 is the
sequential behaviour every earlier project had.

A record that fails blocks only its own downstream tasks. The other records continue, the flow
finishes as **partial**, and the run console's record table names the failed records and the first
error. This is deliberate: a 200-molecule screen that lost three records is neither a pass nor a
total failure.

## Limits

| Limit | Value |
| --- | --- |
| Records per dataset | 2 000 |
| Atoms per record | 1 000 |
| Planned tasks per flow | 5 000 (`records × blocks`) |
| Flows per project | 32 |

If a plan hits the task cap, disable some records or split the family across flows; the error names
the product that hit it.

## Output blocks

An output block names the artifact a flow produces. The inspector offers:

| Kind | Artifact |
| --- | --- |
| `html` | the workflow report, one section per record |
| `csv` | an RFC 4180 table, one row per record × block |
| `json` | `{ schemaVersion, generatedAt, records[], runs[] }` |
| `zip` | run bundle(s) plus manifest and checksums |

The path is relative and must stay inside the output folder (no `..`), and its extension must match
the kind. **Include** chooses one artifact for the whole flow or one per record. **Include manifest**
adds the SHA-256 list beside the artifact.

## Homologous series

A record set is usually a set of *different* molecules. A **series block** is the other case: one
record is a repeat unit, and the block expands it into the n-mer, where n runs over a range. Select
an input block, bind a dataset, and press **Repeat this record as a series…**. The block stays an
`input` block — it is a *kind* of structure block, not a new block type — so fan-out, conformer
searches, gates, writers and the report need no change: they see N ordinary records.

```
series block ──▶ optimise ──▶ frequency ──▶ output
 unit: monomer    (n=1)        (n=1)        one row per n
 n = 1…4          (n=2)        (n=2)
                  (n=3)        (n=3)
```

The inspector asks for five things:

| Field | Meaning |
| --- | --- |
| Repeat unit | which record of the dataset is repeated (one record, not a set) |
| from n / to n | the range; n = 1 is the unit itself |
| Donor atom | the atom of copy *i* that forms the new bond (1-based, as written in the geometry) |
| Acceptor atom | the atom of copy *i+1* that forms it |
| Junction bond | the length of that new bond, in Å |
| Leaving atoms | atoms dropped where a junction forms, written `9, 10` |

Member ids name their parent and their n — `monomer-n3` — so a queue row or a record folder is
traceable without opening the project. Each generated record also carries `parentId`, `n`, the
member count and the linkage rule.

### What the geometry is, and is not

Each copy of the unit is the unit's **own coordinates**, moved rigidly along the donor → acceptor
axis. Nothing is rebuilt: every bond length and angle inside a copy is the unit's, and the one new
bond at each junction is exactly the requested length. That makes the result **a starting point for
optimisation, not a minimum** — the same status as an imported structure. Optimise a member before
reading any energy from it.

The step from one copy to the next is the unit's own donor → acceptor distance plus the junction
bond, which is what makes the new bond come out at the requested length instead of zero.

**Terminal rule.** Leaving atoms are dropped only where a junction forms: a leaving atom on the
donor side is removed from every copy that uses its donor (all but the first), and one on the
acceptor side from every copy that uses its acceptor (all but the last). The first and last copies
therefore keep their outer leaving groups, the chain is capped at both ends, and **n = 1 is the unit
unchanged**.

Each member's own run folder records the derivation, not just the generated structure:
`series: { parentId, n, count, linkage }` in `run.json` says which unit it repeats, which member it
is and the junction rule that joined it. That is what makes an archived member auditable after the
task id (`sp~ethene-n3`) and the file name have both moved on.

### Refused by name

Nothing is generated unless the whole series can be built. The message names the atoms:

| Refused | Message names |
| --- | --- |
| donor = acceptor, or either outside the unit | the index and the unit's atom count |
| a bond that would exceed the element's standard valence | the atom, its element, its current bond order and the limit |
| a leaving atom bonded to something other than the linkage atoms | both atoms |
| copies that overlap (an atom pair below 0.5 Å) | both copies and both atoms |
| `to` above 24, or `from` below 1 | the range and the cap |
| a member that would hold more than 1 000 atoms | the member size |

Bond orders are not stored on dataset records, so the unit's bonds are perceived from covalent
radii and counted as single bonds. The valence guard therefore catches over-coordination, not an
over-valent double bond; a linkage on an atom whose multiple bond matters is a judgement the user
still has to make.

## Derivatives

A **derivative block** is the other kind of structure block: instead of a set of molecules or a
chain, it is *one* parent record seen through a list of atom-level edits. Select an input block,
bind a dataset, and press **Derive a related structure…**. The block stays an `input` block with
`kind: "derivative"`, so every downstream block runs once per derivative, unchanged.

```
derivative block ──▶ optimise ──▶ frequency ──▶ output
 benzene (parent)     H7 → F       H7 → F       one row per edit
 edits: H7 → F        H8 → Cl      H8 → Cl
        H8 → Cl
```

| Field | Meaning |
| --- | --- |
| Parent record | which record of the dataset is edited; **every enabled record** when none is named |
| Op | `substitute`, `add`, `remove`, `isotope`, `protonate` or `deprotonate` |
| Atom | the 1-based atom index, as written in the parent's geometry |
| Element | the element a `substitute` or `add` introduces |
| Mass | the mass number an `isotope` sets |
| Charge, Mult | the spin state a `protonate`/`deprotonate` **must** state |

Each row is its own record: the edits do not chain. That is what makes one block a substituent scan
(H → F, Cl, OMe), a protonated/deprotonated pair, or an isotopologue series. Record ids name the
parent, the op and the atom — `benzene-sub7-F`, `benzene-iso7-2` — so a queue row, a run folder or a
record row is traceable without opening the project. Each generated record carries
`derivative { parentId, operations, atomIndexBase: 1, formula, summary, geometryStatus }`, and the
task carries the same object.

### What the geometry is, and is not

A derivative is **a topology with a plausible starting geometry, not a minimum**, and the block says
`needs optimisation` in those words. The geometry rule:

- `substitute` keeps the direction of the replaced bond, seen from the atom that stays, and sets the
  new bond length to the sum of the two Cordero covalent radii;
- `add` places the new atom opposite the parent atom's existing bonds (the bisector when there are
  several) at the same radii-sum distance;
- `remove` and `isotope` move nothing at all;
- every atom that was not edited keeps its coordinates **to the last bit**.

A C–F placed on a C–H vector is not a relaxed C–F. Optimise a derivative before reading any energy
from it.

### Refused by name

Every refusal comes from the edit engine itself, so the message the card shows is the message the
plan would give — and it happens before a single input file is written:

| Refused | Message names |
| --- | --- |
| the parent states no bonds | that the topology must be stated; a valence check on a perceived topology would be a guess |
| an atom index outside the parent | the index and the parent's atom count |
| a bond that refers to a missing atom | both atoms |
| a substitution past the element's valence | the atom, its element, the bonds it uses and the limit |
| `add` to an atom with no free valence | the atom, its element and its ceiling |
| an `isotope` mass the element does not have | the atom, the element and the masses that exist |
| `protonate`/`deprotonate` without a charge or multiplicity | which of the two is missing |
| two edits that produce the same structure | both edits and the record id |
| a record with no 3D coordinates | the record id |
| an empty list, or more than 32 edits | the list |

**A parent must state its bonds.** The edit engine refuses a molecule without a topology rather than
perceiving one from distances, so a dataset record needs a `bonds` array (see
[`docs/PROJECT-FORMAT.md`](../PROJECT-FORMAT.md)) for a derivative to be built at all. The SDF reader
does not carry the bond block today, so a record imported from an SDF is refused by name instead of
being given a guessed valence.

## Complexes

A **complex block** combines two or more records into **one** system at a stated relative geometry.
Select an input block, bind a dataset, and press **Combine records into a complex…**. The block
stays an `input` block with `kind: "complex"`, and it yields **one record**, so every downstream
block runs once on the whole system:

```
complex block ──▶ SAPT0 ──▶ output
 water-a + water-b   one run   one row
```

The members of a complex are records, not new molecules: each one is placed as a **rigid body**, so
every bond length, angle and dihedral inside a member is the member's own. What the block decides is
where the members sit relative to each other.

```json
{ "type": "input", "kind": "complex",
  "input": { "datasetId": "monomers",
    "complex": {
      "members": [
        { "recordId": "water-a" },
        { "datasetId": "guests", "recordId": "water-b" } ],
      "placement": { "mode": "axis", "axis": [1,0,0],
                     "distanceAngstrom": 3.0, "angleDegrees": 0 } } } }
```

| Field | Meaning |
| --- | --- |
| Member | which record a member places; `datasetId` defaults to the block's dataset |
| Member charge / mult | that member's contribution, when it differs from the record's |
| Placement | `as-drawn`, `axis` or `principal` |
| Axis | the direction the centres of mass are laid along (`axis` mode) |
| Separation | the centre-of-mass distance between members, in Å (`axis`, `principal`) |
| Angle | the turn about the axis, in degrees (`axis` mode) |
| Homodimer | the pair is the same record twice — otherwise a duplicate is refused |

The record id names every parent — `complex-water-a-water-b` — so a queue row or a run folder is
traceable without opening the project. The member list, the placement and its parameters are stored
on the generated record (`complex.members`, `complex.placement`) and on every task that consumes it.

### Fragment labels

The atoms of member *i* carry `fragment = i + 1`, in the order the members are listed. That is the
same numbering `atom.fragment` uses in the project format and the same numbering Psithon's `--`
separator carries, so a downstream **SAPT0** block writes two fragments and runs with no manual
labelling in the molecule editor. The inspector previews the fragment ranges before the block is
queued, and the preview is the expansion the plan makes, not a second count.

### What the geometry is, and is not

Every placement is **a starting geometry, not a minimum**. The record says so
(`complex.geometryStatus: "needs optimisation"`), the card says so, and nothing downstream presents
it as a stationary point. Rigid-body placement never relaxes a contact; optimise the complex before
reading an interaction energy from it.

| Mode | Rule |
| --- | --- |
| `as-drawn` | every coordinate is copied verbatim; the members keep the relative geometry they already had |
| `axis` | the members' centres of mass lie on the stated axis, `distanceAngstrom` apart; every member after the first is turned by `angleDegrees` about that axis, through its own centre of mass |
| `principal` | the members' centres of mass lie along **member 1's smallest principal axis of inertia**, `distanceAngstrom` apart; member 2 keeps its drawn orientation |

`principal` builds the inertia tensor properly — masses from the periodic table, tensor about the
centre of mass, diagonalised by a Jacobi rotation — and takes the eigenvector of the smallest
moment. A molecule whose principal moments are equal (a spherical top such as methane) has **no
unique principal axis**, and that is refused by name rather than guessed at; use `axis` and state the
direction.

Charge adds across the members. Multiplicity follows the highest-spin coupling (the sum of the
members' unpaired electrons plus one); a low-spin coupled complex has to be assembled outside this
block.

### Refused by name

Nothing is built unless the whole complex can be placed, and every refusal names what it refuses:

| Refused | Message names |
| --- | --- |
| a member with no 3D coordinates | the record — and that a demo geometry will not be substituted |
| an unknown or disabled record, or a dataset not in the project | the id and the records that do exist |
| the same record twice without `homodimer` | the record and the flag |
| a separation below the sum of the two members' largest covalent radii | both elements, both radii and the separation |
| an atom pair closer than 0.7 Å between two members | both members, both atoms and the distance |
| more than 4 members, or more than 1 000 atoms in total | the count and the cap |
| an unknown placement mode, a zero axis, or a degenerate principal axis | the mode or the member |

Bonds are copied from each member's own record and renumbered; a member whose record states no bonds
contributes none, and the block does not perceive a topology it was not given. Members may come from
different datasets of the same project, which is what makes a host–guest pair a single block instead
of two files assembled by hand.

## Next

- [Workflows](workflow.md) — the queue, barrier edges, checkpoint hand-off and cluster export.
- [Projects and runs on disk](project-files.md) — where the datasets and per-record run folders live.
