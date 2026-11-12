"""`depict` — a 2D depiction as SVG (ADR 0003 §3.4).

The drawing is generated here, never in the renderer. The answer is one SVG
string; the client validates it before embedding it in a report or the DOM.
CoordGen is used when the build has it, because a depiction that moves between
releases is not a figure a paper can cite.
"""


def run(request):
    from ..common import fail, molecule_from_request

    try:
        from rdkit import Chem
        from rdkit.Chem.Draw import rdMolDraw2D
    except ImportError as error:
        fail("capability-missing", f"This RDKit build does not expose MolDraw2D: {error}.", op="depict")

    options = request.get("options") if isinstance(request.get("options"), dict) else {}
    width = options.get("width", 320)
    height = options.get("height", 240)
    if isinstance(width, bool) or not isinstance(width, int) or not 80 <= width <= 1600:
        fail("bad-input", "options.width must be an integer between 80 and 1600.", op="depict")
    if isinstance(height, bool) or not isinstance(height, int) or not 80 <= height <= 1600:
        fail("bad-input", "options.height must be an integer between 80 and 1600.", op="depict")
    highlights = options.get("highlights", [])
    if not isinstance(highlights, list) or any(
        isinstance(index, bool) or not isinstance(index, int) or index < 0 for index in highlights
    ):
        fail("bad-input", "options.highlights must be a list of atom indices.", op="depict")

    mol, _charge, _multiplicity = molecule_from_request(request.get("molecule"), op="depict")
    try:
        # A depiction shows the molecular graph, not every explicit hydrogen.
        mol = Chem.RemoveHs(mol)
    except Exception:  # noqa: BLE001 - an unusual valence may keep its hydrogens
        pass
    try:
        from rdkit.Chem import rdCoordGen

        rdCoordGen.AddCoords(mol)
        coordinates = "coordgen"
    except Exception:  # noqa: BLE001 - CoordGen is optional; ETKDG-free 2D is the fallback
        from rdkit.Chem import AllChem

        AllChem.Compute2DCoords(mol)
        coordinates = "rdkit-2d"

    if highlights and max(highlights) >= mol.GetNumAtoms():
        fail("bad-input", "options.highlights names an atom outside the molecule.", op="depict")

    try:
        drawer = rdMolDraw2D.MolDraw2DSVG(width, height)
        drawer.DrawMolecule(mol, highlightAtoms=list(highlights))
        drawer.FinishDrawing()
        svg = drawer.GetDrawingText()
    except Exception as error:  # noqa: BLE001 - RDKit raises several unrelated types
        fail("op-failed", f"RDKit could not draw this molecule: {error}.", op="depict")

    if not isinstance(svg, str) or "<svg" not in svg:
        fail("op-failed", "RDKit returned no SVG for this molecule.", op="depict")
    # MolDraw2DSVG prefixes an XML declaration; the client's validator expects
    # exactly one <svg> root, so the prolog is dropped here, not forgiven there.
    svg = svg[svg.find("<svg"):]

    legend = str(options.get("legend") or "").strip()
    return {
        "program": "RDKit",
        "options": {"width": width, "height": height, "coordinates": coordinates, **({"highlights": highlights} if highlights else {})},
        "result": {"svg": svg, **({"legend": legend} if legend else {})},
    }
