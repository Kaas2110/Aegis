"""Pure exact-source proposal. No IO, runtime registration, requests or models.

The normalizer never returns the bridge's accepted evidence discriminator.
The reviewed proposal is separate, exact-capture scoped, and requires a pinned
root review whose availability is included in knownAt. Nothing installs it.
"""
from __future__ import annotations
import hashlib
import json
import re
from datetime import datetime, timezone

SOURCE = 'Steam/IDOTA2MatchStats_570/GetRealtimeStats/v1:/match/start_timestamp'
REALTIME_URL = 'https://api.steampowered.com/IDOTA2MatchStats_570/GetRealtimeStats/v1/'
DISCOVERY_URL = 'https://www.dota2.com/webapi/IDOTA2League/GetLiveGames/v001'
CANDIDATE = 'steam_exact_start_candidate.proposal.v2'
REVIEW = 'steam_exact_capture_start_review.proposal.v2'
PROPOSAL = 'steam_local_c2_start_witness.proposal.v2'
IDENTITY_POLICY = 'match_server_roster_v1'
MAX_SAFE = 2**53 - 1
U64 = 2**64 - 1
FLAGS = dict(runtimeAdapterInstalled=False, acceptedRuntimeWitness=False,
             eligibleForServing=False, coverage95Validated=False,
             eventLatencyVerified=False, sourceKnownBeforeStartProven=False)
CAPTURE_KEYS = ('realtimeBody', 'realtimeReceipt', 'discoveryBody',
                'discoveryReceipt', 'selectedIdentity')

class Refusal(ValueError):
    pass

def require(ok, reason):
    if not ok:
        raise Refusal('steam_start_' + reason)

def digest(raw):
    return hashlib.sha256(raw).hexdigest()

def hex64(value):
    return type(value) is str and re.fullmatch('[0-9a-f]{64}', value) is not None

class NonIntegerNumber(str):
    """A JSON decimal/exponent token is never an identity or epoch integer."""

def parse(raw, limit=1024*1024):
    require(type(raw) is bytes and 0 < len(raw) <= limit, 'raw_bytes_bound')
    def pairs(items):
        out = {}
        for k, v in items:
            require(k not in out, 'duplicate_json_key')
            out[k] = v
        return out
    try:
        return json.loads(raw.decode('utf-8'), object_pairs_hook=pairs,
                          parse_float=NonIntegerNumber,
                          parse_constant=lambda _: require(False, 'nonfinite_json'))
    except Refusal:
        raise
    except (ValueError, UnicodeError, RecursionError):
        raise Refusal('steam_start_invalid_json') from None

def decimal_id(value):
    """Canonical positive ASCII decimal string/int, parsed directly from bytes.

    Integers stay arbitrary precision in Python. No float conversion, signs,
    leading zeros, unicode digits, decimal/exponent tokens, or JS round trip.
    """
    if type(value) is int:
        require(1 <= value <= U64, 'identity_range')
        return str(value)
    require(type(value) is str and re.fullmatch('[1-9][0-9]{0,19}', value)
            is not None and int(value) <= U64, 'lossless_decimal_identity')
    return value

def aware(value):
    require(type(value) is str and len(value) <= 64 and
            re.search(r'(Z|[+-][0-9]{2}:[0-9]{2})$', value) is not None,
            'aware_local_timestamp')
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
        require(result.tzinfo is not None and result.timestamp() > 0,
                'aware_local_timestamp')
        return result.astimezone(timezone.utc)
    except (ValueError, OverflowError, OSError):
        raise Refusal('steam_start_aware_local_timestamp') from None

def utc(value):
    return value.isoformat(timespec='microseconds').replace('+00:00', 'Z')

def epoch(value):
    require(type(value) is int and 0 < value <= 2**32-1, 'explicit_start_integer_seconds')
    return value

def optional_lobby(match):
    if 'lobby_id' not in match or match['lobby_id'] is None:
        return {'decimal': None, 'missing': True, 'status': 'source_field_absent_or_null'}
    return {'decimal': decimal_id(match['lobby_id']), 'missing': False,
            'status': 'explicit_lossless_source_identity'}

def identity_rows(players):
    return sorted((p['side'], p['teamIdDecimal'], p['accountIdDecimal'], p['heroIdDecimal'])
                  for p in players)

def pinned(raw, expected, limit=1024*1024):
    require(hex64(expected) and digest(raw) == expected, 'artifact_pin')
    return parse(raw, limit)

def _receipt(receipt, raw, endpoint, *, server=None):
    require(type(receipt) is dict and receipt.get('endpoint') == endpoint and
            receipt.get('httpStatus') == 200 and type(receipt.get('httpStatus')) is int,
            'endpoint_success')
    require(type(receipt.get('bytes')) is int and receipt['bytes'] == len(raw) and
            receipt.get('sha256') == digest(raw), 'receipt_raw_binding')
    a, b, c = (aware(receipt.get(k)) for k in
               ('requestStartedAt', 'receivedAt', 'persistedAt'))
    require(a <= b <= c, 'receipt_order')
    if server is not None:
        require(receipt.get('authMode') == 'header' and
                type(receipt.get('parameters')) is dict and
                set(receipt['parameters']) == {'server_steam_id'} and
                decimal_id(receipt['parameters']['server_steam_id']) == server,
                'exact_server_request')
    else:
        require(receipt.get('authMode') == 'none' and receipt.get('parameters') == {},
                'discovery_request')
    return a, b, c

def normalize_capture(artifacts, pins):
    """Validate five caller-pinned local byte artifacts; return a candidate only.

    Pins are a trusted local caller input, never an HTTP/request-supplied claim.
    Hashes prove byte identity, not source authenticity or field semantics.
    """
    require(type(artifacts) is dict and set(artifacts) == set(CAPTURE_KEYS) and
            type(pins) is dict and set(pins) == set(CAPTURE_KEYS), 'capture_artifacts')
    values = {k: pinned(artifacts[k], pins[k]) for k in CAPTURE_KEYS}
    selected = values['selectedIdentity']
    require(type(selected) is dict, 'selected_identity')
    match, server, league = (decimal_id(selected.get(k)) for k in
                            ('matchId', 'serverSteamId', 'leagueId'))
    d = values['discoveryBody']
    require(type(d) is dict and type(d.get('games')) is list and len(d['games']) <= 1000,
            'discovery_shape')
    address = selected.get('sourceObjectPath')
    require(type(address) is str and re.fullmatch('/games/(0|[1-9][0-9]{0,3})', address)
            is not None, 'discovery_pointer')
    index = int(address.split('/')[-1])
    require(index < len(d['games']), 'discovery_pointer')
    game = d['games'][index]
    require(type(game) is dict and selected.get('discoveryBodySha256') ==
            pins['discoveryBody'], 'discovery_selection_binding')
    require((decimal_id(game.get('match_id')), decimal_id(game.get('server_steam_id')),
             decimal_id(game.get('league_id'))) == (match, server, league),
            'discovery_exact_identity')
    radiant, dire = (decimal_id(game.get(k)) for k in ('radiant_team_id', 'dire_team_id'))
    require(radiant != dire, 'distinct_teams')
    da, db, dc = _receipt(values['discoveryReceipt'], artifacts['discoveryBody'], DISCOVERY_URL)
    a, b, c = _receipt(values['realtimeReceipt'], artifacts['realtimeBody'], REALTIME_URL,
                       server=server)
    require(dc <= a, 'discovery_not_persisted_before_request')
    raw = values['realtimeBody']
    require(type(raw) is dict and type(raw.get('match')) is dict, 'response_match')
    m = raw['match']
    require((decimal_id(m.get('match_id')), decimal_id(m.get('server_steam_id')),
             decimal_id(m.get('league_id'))) == (match, server, league),
            'realtime_exact_identity')
    teams = raw.get('teams')
    require(type(teams) is list and len(teams) == 2 and all(type(t) is dict for t in teams),
            'two_teams')
    ids = [decimal_id(t.get('team_id')) for t in teams]
    codes = [t.get('team_number') for t in teams]
    require(set(ids) == {radiant, dire} and len(set(ids)) == 2 and
            all(type(n) is int and n > 0 for n in codes) and len(set(codes)) == 2,
            'exact_team_identity')
    players = []
    accounts, heroes = set(), set()
    for team, tid, code in zip(teams, ids, codes):
        roster = team.get('players')
        require(type(roster) is list and len(roster) == 5, 'five_players_each_team')
        for player in roster:
            require(type(player) is dict and type(player.get('team')) is int and
                    player['team'] == code, 'player_team_code')
            account = decimal_id(player.get('accountid'))
            hero = decimal_id(player.get('heroid'))
            require(0 < int(account) < 4294967295 and int(hero) <= MAX_SAFE and
                    account not in accounts and hero not in heroes, 'complete_unique_accounts_heroes')
            accounts.add(account); heroes.add(hero)
            # Preserve provider slots as raw metadata. Never convert into roles
            # or Steam player_slot merely because these integers look familiar.
            slots = {k: player[k] for k in ('playerid', 'team_slot') if k in player}
            require(all(type(v) is int and 0 <= v <= MAX_SAFE for v in slots.values()),
                    'provider_slot_scalar')
            players.append({'side': 'radiant' if tid == radiant else 'dire',
                            'teamIdDecimal': tid, 'accountIdDecimal': account,
                            'heroIdDecimal': hero, 'providerSlotRaw': slots})
    lobby = optional_lobby(m)
    start = epoch(m.get('start_timestamp'))
    require(start <= b.timestamp(), 'start_after_receipt')
    runtime_id = int(match) if int(match) <= MAX_SAFE else None
    return {'contract': CANDIDATE, 'status': 'root_semantic_review_pending', **FLAGS,
            'sourceId': SOURCE, 'sourceField': '/match/start_timestamp',
            'identityPolicyProposal': IDENTITY_POLICY,
            'identity': {'matchIdDecimal': match, 'matchIdIntegerForExistingReader': runtime_id,
                         'serverSteamIdDecimal': server, 'leagueIdDecimal': league,
                         'radiantTeamIdDecimal': radiant, 'direTeamIdDecimal': dire,
                         'lobbyId': lobby,
                         'players': sorted(players, key=lambda p: (p['side'], int(p['accountIdDecimal']))),
                         'providerTeamCodes': {('radiant' if tid == radiant else 'dire'): code
                                               for tid, code in zip(ids, codes)}},
            'candidateStartEpochSeconds': start, 'candidateUnits': 'explicit integer Unix seconds; semantics pending',
            'requestStartedAt': utc(a), 'receivedAt': utc(b), 'persistedAt': utc(c),
            'rawFieldKnownAt': utc(b), 'rawFieldDurableAt': utc(c),
            'rawSourceSha256': pins['realtimeBody'], 'rawSourceBytes': len(artifacts['realtimeBody']),
            'receiptSha256': pins['realtimeReceipt'], 'discoverySha256': pins['discoveryBody'],
            'discoveryReceiptSha256': pins['discoveryReceipt'],
            'selectionSha256': pins['selectedIdentity'], 'discoveryObjectPath': address,
            'rawMatchIdRepresentation': 'decimal_string' if type(m['match_id']) is str else 'json_integer',
            'identityRule': 'canonical positive ASCII decimal <=uint64; no float or exponent; existing-reader int <=2^53-1',
            'runtimeEvidence': None}

def comparison_evidence(candidate, result_raw, result_sha, body_raw, body_sha):
    """Check the existing exact OpenDota pair; never return its outcomes/stats."""
    result = pinned(result_raw, result_sha)
    body = pinned(body_raw, body_sha, 8*1024*1024)
    require(type(result) is dict and type(body) is dict and
            result.get('status') == 'exact_opendota_start_received', 'comparison_status')
    cap = result.get('capture')
    require(type(cap) is dict and cap.get('endpoint') ==
            'https://api.opendota.com/api/matches/' + candidate['identity']['matchIdDecimal'] and
            type(cap.get('httpStatus')) is int and cap['httpStatus'] == 200 and
            cap.get('bodySha256') == body_sha and cap.get('bytes') == len(body_raw),
            'comparison_raw_binding')
    a, b, c, known = (aware(v) for v in
                       (cap.get('requestStartedAt'), cap.get('receivedAt'),
                        cap.get('persistedAt'), result.get('knownAt')))
    require(a <= b <= c and b <= known and c <= known, 'comparison_availability')
    match = candidate['identity']['matchIdDecimal']
    start = candidate['candidateStartEpochSeconds']
    require(decimal_id(body.get('match_id')) == match and decimal_id(result.get('matchId')) == match,
            'comparison_match')
    identity = candidate['identity']
    require(decimal_id(body.get('leagueid')) == identity['leagueIdDecimal'] and
            decimal_id(body.get('radiant_team_id')) == identity['radiantTeamIdDecimal'] and
            decimal_id(body.get('dire_team_id')) == identity['direTeamIdDecimal'],
            'comparison_league_teams')
    roster = body.get('players')
    require(type(roster) is list and len(roster) == 10, 'comparison_ten_players')
    players = []; accounts, heroes, slots = set(), set(), set()
    for p in roster:
        require(type(p) is dict and type(p.get('player_slot')) is int and
                p['player_slot'] in (*range(5), *range(128, 133)) and
                p['player_slot'] not in slots, 'comparison_steam_player_slot')
        slot = p['player_slot']; slots.add(slot); side = 'radiant' if slot < 128 else 'dire'
        if 'team_number' in p:
            require(type(p['team_number']) is int and p['team_number'] == (0 if side == 'radiant' else 1),
                    'comparison_player_side_conflict')
        if 'isRadiant' in p:
            require(type(p['isRadiant']) is bool and p['isRadiant'] == (side == 'radiant'),
                    'comparison_player_side_conflict')
        account, hero = decimal_id(p.get('account_id')), decimal_id(p.get('hero_id'))
        require(0 < int(account) < 4294967295 and int(hero) <= MAX_SAFE and
                account not in accounts and hero not in heroes, 'comparison_unique_accounts_heroes')
        accounts.add(account); heroes.add(hero)
        players.append({'side': side, 'teamIdDecimal': identity[side+'TeamIdDecimal'],
                        'accountIdDecimal': account, 'heroIdDecimal': hero})
    require(identity_rows(players) == identity_rows(identity['players']),
            'comparison_exact_side_account_hero_identity')
    other_lobby = optional_lobby(body); original_lobby = identity['lobbyId']
    if not original_lobby['missing'] and not other_lobby['missing']:
        require(other_lobby['decimal'] == original_lobby['decimal'], 'comparison_lobby_mismatch')
        lobby_status = 'exact_direct_fields_equal'
    else:
        lobby_status = ('absent_both_sources' if original_lobby['missing'] and other_lobby['missing']
                        else 'incomplete_direct_lobby_identity')
    require(epoch(body.get('start_time')) == start and
            result.get('openDotaStartTime') == start and
            result.get('originalRealtimeStartTimestamp') == start and
            result.get('startFieldsEqual') is True and
            type(result.get('differenceSeconds')) is int and result['differenceSeconds'] == 0,
            'comparison_start_mismatch')
    require(result.get('acceptedRuntimeStartWitness') is False and
            result.get('rawContainsOutcomeValues') is True and
            result.get('onePairDoesNotProveCoverageOrUniversalSemantics') is True,
            'comparison_scope')
    return {'contract': 'one_exact_start_pair_observation.proposal.v1',
            'matchIdDecimal': match, 'startValuesEqual': True, 'differenceSeconds': 0,
            'knownAt': utc(known), 'resultSha256': result_sha, 'rawBodySha256': body_sha,
            'exactTeamsAnd10SideAccountHeroIdentity': True,
            'lobbyIdentityStatus': lobby_status, 'lobbyExact': lobby_status == 'exact_direct_fields_equal',
            'lobbyEvidence': {'realtime': original_lobby, 'opendota': other_lobby},
            'rawContainsOutcomeValues': True, 'outcomeValuesCopied': False,
            'universalMeaningProven': False, 'coverageProven': False,
            'acceptedRuntimeWitness': False}

def exact_scope(candidate):
    identity = candidate['identity']
    return {'kind': 'exact_capture_only', 'rawSourceSha256': candidate['rawSourceSha256'],
            'matchIdDecimal': identity['matchIdDecimal'],
            'serverSteamIdDecimal': identity['serverSteamIdDecimal'],
            'radiantTeamIdDecimal': identity['radiantTeamIdDecimal'],
            'direTeamIdDecimal': identity['direTeamIdDecimal'],
            'lobbyIdDecimal': identity['lobbyId']['decimal'],
            'players': [list(row) for row in identity_rows(identity['players'])],
            'sourceId': SOURCE, 'sourceField': '/match/start_timestamp',
            'candidateStartEpochSeconds': candidate['candidateStartEpochSeconds']}

def reviewed_witness_proposal(artifacts, pins, comparison_raw, comparison_sha,
                             comparison_body, comparison_body_sha, review_raw,
                             trusted_review_sha, reader_current):
    """Stage a potential existing-contract witness; never register with loader.

    Root must review/install a loader hook separately. This returns an outer
    PROPOSAL contract and runtimeEvidence=None even for synthetic approved tests.
    Only exact-capture scope is implemented. No general endpoint approval exists.
    """
    candidate = normalize_capture(artifacts, pins)
    comparison = comparison_evidence(candidate, comparison_raw, comparison_sha,
                                     comparison_body, comparison_body_sha)
    review = pinned(review_raw, trusted_review_sha)
    keys = {'contract', 'status', 'approvedBy', 'reviewId', 'reviewKnownAt',
            'meaning', 'derivation', 'scope', 'comparisonResultSha256',
            'comparisonBodySha256', 'identityPolicy', 'limitations'}
    require(type(review) is dict and set(review) == keys and review.get('contract') == REVIEW,
            'review_contract')
    require(review.get('scope') == exact_scope(candidate) and
            review.get('identityPolicy') == IDENTITY_POLICY and
            review.get('comparisonResultSha256') == comparison_sha and
            review.get('comparisonBodySha256') == comparison_body_sha, 'review_exact_scope')
    require(review.get('status') == 'approved_exact_capture' and review.get('approvedBy') == 'root',
            'root_semantic_review_pending')
    require(type(review.get('reviewId')) is str and
            re.fullmatch('[a-zA-Z0-9_-]{1,80}', review['reviewId']) is not None and
            review.get('meaning') == 'actual_match_start_utc' and
            review.get('derivation') == 'provider_explicit_field', 'review_meaning')
    reviewed = aware(review.get('reviewKnownAt'))
    require(reviewed >= aware(comparison['knownAt']), 'semantic_review_backdated')
    require(type(review.get('limitations')) is list and
            review['limitations'] == ['exact_capture_only', 'no_universal_semantics',
                                     'no_coverage_or_latency_claim'], 'review_limitations')
    # The current C2 identity contract does not require lobby/server in reader
    # input. Packet server is independently bound to discovery+request above.
    # Missing lobby stays missing; this policy never claims lobby equality.
    require(type(reader_current) is dict and type(reader_current.get('match_id')) is int and
            1 <= reader_current['match_id'] <= MAX_SAFE and
            reader_current['match_id'] == candidate['identity']['matchIdIntegerForExistingReader'],
            'existing_reader_identity')
    observed = reader_current.get('input')
    require(type(observed) is dict and type(observed.get('matchId')) is int and
            observed['matchId'] == reader_current['match_id'] and
            all(type(observed.get(side+'TeamId')) is int and
                0 < observed[side+'TeamId'] <= MAX_SAFE for side in ('radiant', 'dire')) and
            decimal_id(observed.get('radiantTeamId')) == candidate['identity']['radiantTeamIdDecimal'] and
            decimal_id(observed.get('direTeamId')) == candidate['identity']['direTeamIdDecimal'],
            'reader_exact_match_teams')
    if observed.get('serverSteamId') is not None:
        require(decimal_id(observed['serverSteamId']) == candidate['identity']['serverSteamIdDecimal'],
                'reader_server_mismatch')
    if observed.get('lobbyId') is not None:
        supplied_lobby = decimal_id(observed['lobbyId'])
        require(all(x['missing'] or supplied_lobby == x['decimal']
                    for x in comparison['lobbyEvidence'].values()), 'reader_lobby_mismatch')
    roster = observed.get('players')
    require(type(roster) is list and len(roster) == 10, 'reader_ten_players')
    players = []
    for p in roster:
        require(type(p) is dict and type(p.get('team')) is int and p['team'] in (0, 1), 'reader_player_side')
        require(type(p.get('accountId')) is int and 0 < p['accountId'] < 4294967295 and
                type(p.get('heroId')) is int and 0 < p['heroId'] <= MAX_SAFE,
                'reader_existing_integer_account_hero')
        side = ('radiant', 'dire')[p['team']]
        players.append({'side': side, 'teamIdDecimal': candidate['identity'][side+'TeamIdDecimal'],
                        'accountIdDecimal': decimal_id(p.get('accountId')),
                        'heroIdDecimal': decimal_id(p.get('heroId'))})
    require(identity_rows(players) == identity_rows(candidate['identity']['players']),
            'reader_exact_side_account_hero_identity')
    receipt = aware(reader_current.get('received_at'))
    known = max(aware(candidate['persistedAt']), reviewed)
    require(candidate['candidateStartEpochSeconds'] <= known.timestamp() <= receipt.timestamp(),
            'review_not_known_at_target_receipt')
    evidence = {'contract': 'reviewed_target_start_evidence_v1',
                'matchId': reader_current['match_id'],
                'actualStart': candidate['candidateStartEpochSeconds'],
                'knownAt': known.timestamp(), 'source': SOURCE,
                'sourceSha256': candidate['rawSourceSha256'],
                'reviewId': review['reviewId'], 'reviewEvidenceSha256': trusted_review_sha,
                'rawFieldReceivedAt': candidate['receivedAt'],
                'rawFieldPersistedAt': candidate['persistedAt'],
                'semanticReviewKnownAt': utc(reviewed),
                'identityPolicy': IDENTITY_POLICY,
                'lobbyIdentityStatus': comparison['lobbyIdentityStatus'],
                'lobbyEqualityClaim': comparison['lobbyExact'],
                'exactIdentity': candidate['identity'],
                'scope': 'one_exact_capture; no universal endpoint semantics'}
    return {'contract': PROPOSAL, 'status': 'reviewed_exact_capture_proposal_only',
            **FLAGS, 'proposedTargetStartEvidence': evidence,
            'runtimeEvidence': None, 'candidate': candidate, 'comparison': comparison,
            'integrationRequired': 'separate reviewed LocalBundle.start hook and exact config/policy binding',
            'unchangedGates': ['source_known_at<=actual_start', 'prior7148_corrected_lineage',
                              'committed_reader_history_and_freshness', '45938_feature_parity',
                              'coverage95_false', 'event_latency_unverified']}
