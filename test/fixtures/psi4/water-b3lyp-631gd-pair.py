import psi4

psi4.set_memory('1 GB')
psi4.core.set_output_file('cube-pair-bohr.out', False)

mol = psi4.geometry("""
0 1
O   0.000000000   0.000000000   0.000000000
H   0.757000000   0.586000000   0.000000000
H  -0.757000000   0.586000000   0.000000000
symmetry c1
""")

psi4.set_options({
    'basis': '6-31G*',
    'reference': 'rhf',
    'scf_type': 'df',
    'puream': True,
    'cubeprop_tasks': ['orbitals'],
    'cubeprop_orbitals': [5],
    'cubic_grid_spacing': [0.5, 0.5, 0.5],
    'cubeprop_filepath': './pair',
})

energy, wfn = psi4.energy('b3lyp', return_wfn=True)
psi4.cubeprop(wfn)
print('FINAL ENERGY', energy)
print('PSI4 VERSION', psi4.__version__)
