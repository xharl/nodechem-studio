molecule = psi4.geometry("""
O  0.000000  0.000000  0.000000
H  0.757000  0.586000  0.000000
H -0.757000  0.586000  0.000000
symmetry c1
""")
psi4.set_memory('800 MB')
psi4.core.set_output_file('esp-water.out', False)
psi4.set_options({
    'basis': '6-31g*',
    'puream': True,
    'scf_type': 'df',
    'reference': 'rhf',
})
energy, wfn = psi4.energy('b3lyp', return_wfn=True, molecule=molecule)
psi4.print_out("FINAL ENERGY %.15f\n" % energy)
psi4.fchk(wfn, 'water-esp.fchk')
psi4.set_options({
    'cubeprop_tasks': ['esp', 'density', 'orbitals'],
    'cubeprop_orbitals': [5, 6],
    'cubic_grid_spacing': [0.4, 0.4, 0.4],
    'cubeprop_filepath': '.',
})
psi4.cubeprop(wfn)
