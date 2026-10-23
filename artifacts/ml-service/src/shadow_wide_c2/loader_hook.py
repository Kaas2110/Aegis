"""Uninstalled trusted-local hook proposal. No HTTP, polling or model dependency.

A later reviewed host integration can call this instead of LocalBundle.start
only for a separately pinned binding. The legacy path is not patched here.
"""
if __package__:
    from . import steam_start as s
else:
    import steam_start as s

BINDING = 'steam_exact_start_local_binding.proposal.v2'

def reviewed_start_for_local_bundle(bundle, reader, binding_ref):
    """All paths/bytes are read via existing LocalBundle's contained pinned refs.

    Binding ref comes from a future root startup config, never request input.
    A real pending semantic review fails before any witness can be returned.
    Existing downstream C2 history/lineage/materialization guards still run.
    """
    binding_raw = bundle.bytes(binding_ref, 100_000)
    binding = s.parse(binding_raw, 100_000)
    s.require(type(binding) is dict and set(binding) ==
              {'contract', 'matchId', 'identityPolicy', 'captures', 'comparisonResult',
               'comparisonBody', 'semanticReview'} and binding['contract'] == BINDING and
              binding['identityPolicy'] == s.IDENTITY_POLICY and
              type(binding.get('matchId')) is int and
              type(reader) is dict and type(reader.get('current')) is dict and
              binding['matchId'] == reader['current'].get('match_id'), 'local_binding_contract')
    refs = binding.get('captures')
    s.require(type(refs) is dict and set(refs) == set(s.CAPTURE_KEYS), 'local_capture_refs')
    artifacts = {k: bundle.bytes(refs[k], 1024*1024) for k in s.CAPTURE_KEYS}
    pins = {k: refs[k]['sha256'] for k in s.CAPTURE_KEYS}
    c, b, r = (binding[k] for k in ('comparisonResult', 'comparisonBody', 'semanticReview'))
    value = s.reviewed_witness_proposal(artifacts, pins,
            bundle.bytes(c, 1024*1024), c['sha256'], bundle.bytes(b, 8*1024*1024), b['sha256'],
            bundle.bytes(r, 100_000), r['sha256'], reader['current'])
    evidence = value['proposedTargetStartEvidence']
    return {**evidence, 'captureSha256': refs['realtimeReceipt']['sha256'],
            'sourceBindingSha256': s.digest(binding_raw),
            'semanticsPolicySha256': r['sha256'],
            'hookInstalled': False, 'coverage95Validated': False,
            'eventLatencyVerified': False}
