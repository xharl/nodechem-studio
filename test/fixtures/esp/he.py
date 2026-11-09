molecule = psi4.geometry("""
He 0.0 0.0 0.0
symmetry c1
""")
psi4.set_memory('400 MB')
psi4.core.set_output_file('he.out', False)
psi4.set_options({'basis': 'sto-3g', 'scf_type': 'df', 'reference': 'rhf'})
energy, wfn = psi4.energy('scf', return_wfn=True, molecule=molecule)
psi4.fchk(wfn, 'he-sto3g.fchk')
psi4.set_options({'cubeprop_tasks': ['esp'], 'cubic_grid_spacing': [0.5, 0.5, 0.5], 'cubeprop_filepath': '.'})
psi4.cubeprop(wfn)
