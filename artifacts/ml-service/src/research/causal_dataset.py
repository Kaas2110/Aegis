"""Research-only feature contract. No current aggregate tables or model priors.

Historical availability is reconstructed at outcome end + 5 minutes; it is NOT
a claim of prospective provider availability. Candidate models must not serve
until their identical online feature contract and a fresh shadow test exist.
"""
from __future__ import annotations
from collections import defaultdict, deque
import heapq
import math
import hashlib
import json
from itertools import combinations

DAY = 86400
CONTRACT = "causal_reconstruction_v2"
BASE_NAMES = ["elo_diff", "elo_prior", "history_log_diff", "min_history_log",
              "winrate_diff", "recent10_diff", "inactivity_diff", "games30_diff",
              "min_games30", "duration_history_diff", "killrate_history_diff",
              "h2h_diff", "h2h_log_count", "series_format", "series_map_index",
              "series_score_diff"]
DRAFT_NAMES = ["hero_winrate_diff", "hero_history_min", "synergy_diff",
               "counter_diff", "hero_short_game_wr_diff", "hero_long_game_wr_diff"]
ROSTER_NAMES = ["player_winrate_diff", "player_hero_winrate_diff", "player_hero_coverage",
                "roster_continuity_diff", "min_player_history"]
LIVE_NAMES = ["game_minutes", "gold_lead_k", "kill_diff", "total_kills", "kills_per_minute",
              "gold_change_per_minute", "kill_change_per_minute", "trajectory_gap_minutes",
              "draft_observed", "provider_delay_seconds"]
UNSUPPORTED_LIVE_FEATURES = ["towers_remaining_diff", "total_towers_remaining", "tower_change"]

def mean(a, default=0.0):
    a = list(a)
    return sum(a) / len(a) if a else default

def rate(counts, prior=0.5, strength=20):
    n, wins = counts
    return (wins + strength * prior) / (n + strength)

def finite_number(value):
    # bool is an int subclass in Python, but not a numeric JSON event field.
    return type(value) in (int, float) and math.isfinite(value)


def valid_picks(r, d):
    return (isinstance(r, list) and isinstance(d, list) and len(r) == len(d) == 5
            and all(type(h) is int and 0 < h < 1000 for h in r + d)
            and len(set(r + d)) == 10)


def first_blood(objectives, players):
    """Same strict contract as scripts/src/lib/first-blood-label.ts.

    A unique explicit objective must identify a unique player with a kill at
    exactly that time. Negative/zero game time is valid. Never infer from winner.
    """
    if not isinstance(objectives, list) or not isinstance(players, list):
        return None
    events = [e for e in objectives if isinstance(e, dict) and e.get("type") == "CHAT_MESSAGE_FIRSTBLOOD"]
    if len(events) != 1:
        return None
    event = events[0]
    slot, timestamp = event.get("player_slot"), event.get("time")
    if (not finite_number(slot) or not float(slot).is_integer()
            or slot not in (*range(5), *range(128, 133)) or not finite_number(timestamp)):
        return None
    ordinary_slot = event.get("slot")
    if ordinary_slot is not None and (not finite_number(ordinary_slot)
            or ordinary_slot != (slot if slot < 128 else slot - 123)):
        return None
    matching = [p for p in players if isinstance(p, dict)
                and finite_number(p.get("player_slot")) and p["player_slot"] == slot]
    if len(matching) != 1 or not isinstance(matching[0].get("kills_log"), list):
        return None
    if not any(isinstance(k, dict) and finite_number(k.get("time")) and k["time"] == timestamp
               for k in matching[0]["kills_log"]):
        return None
    return int(slot < 128)


def known_series(m):
    value = m.get("series_id")
    return value if type(value) is int and value > 0 else None

def group_id(m):
    if known_series(m) is not None:
        return "series:" + str(m["series_id"])
    pair = sorted([m["radiant_team_id"], m["dire_team_id"]])
    return f"pairday:{m.get('league_id')}:{pair[0]}:{pair[1]}:{int(m['start_time']) // DAY}"

class History:
    def __init__(self):
        self.elo = defaultdict(lambda: 1500.0)
        self.teams = defaultdict(deque)
        self.heroes = defaultdict(lambda: [0, 0])
        self.short = defaultdict(lambda: [0, 0])
        self.long = defaultdict(lambda: [0, 0])
        self.players = defaultdict(lambda: [0, 0])
        self.player_hero = defaultdict(lambda: [0, 0])
        self.synergy = defaultdict(lambda: [0, 0])
        self.counters = defaultdict(lambda: [0, 0])
        self.h2h = defaultdict(lambda: [0, 0])
        self.last_roster = {}
        self.series = defaultdict(list)
        self.latest_outcome = 0

    def _team(self, team, now):
        q = self.teams[team]
        while q and q[0][0] < now - 180 * DAY:
            q.popleft()
        n = len(q)
        return [math.log1p(n), (sum(v[1] for v in q) + 5) / (n + 10),
                (sum(v[1] for v in list(q)[-10:]) + 2) / (min(n, 10) + 4),
                min(120, (now - q[-1][0]) / DAY) if q else 120,
                sum(v[0] >= now - 30 * DAY for v in q),
                mean(v[2] / 60 for v in q), mean(v[3] for v in q if v[3] is not None)]

    def features(self, m, *, as_of=None):
        # Batch research defaults to map start; shadow snapshots must use the
        # actual prediction clock, never a future scheduled/actual start.
        now = m["start_time"] if as_of is None else as_of
        r, d = m["radiant_team_id"], m["dire_team_id"]
        assert self.latest_outcome < now, "future outcome reached prematch features"
        a, b = self._team(r, now), self._team(d, now)
        prior = 1 / (1 + 10 ** ((self.elo[d] - self.elo[r]) / 400))
        pair = tuple(sorted((r, d)))
        hr = rate(self.h2h[pair], strength=10)
        if pair[0] != r:
            hr = 1 - hr
        series = self.series.get(known_series(m), []) if known_series(m) is not None else []
        score = sum(1 if winner == r else -1 if winner == d else 0 for winner in series)
        base = [(self.elo[r] - self.elo[d]) / 400, prior, a[0] - b[0], min(a[0], b[0]),
                a[1] - b[1], a[2] - b[2], (a[3] - b[3]) / 30, (a[4] - b[4]) / 20,
                min(a[4], b[4]) / 20, (a[5] - b[5]) / 20, a[6] - b[6],
                hr - .5, math.log1p(self.h2h[pair][0]),
                float(m.get("series_type") or 0), len(series), score]
        rp, dp = m.get("radiant_picks"), m.get("dire_picks")
        draft = roster = None
        if valid_picks(rp, dp):
            def wrdiff(table):
                return mean(rate(table[h]) for h in rp) - mean(rate(table[h]) for h in dp)
            draft = [wrdiff(self.heroes), math.log1p(min(self.heroes[h][0] for h in rp + dp)),
                     mean(rate(self.synergy[tuple(sorted(p))]) for p in combinations(rp, 2)) -
                     mean(rate(self.synergy[tuple(sorted(p))]) for p in combinations(dp, 2)),
                     mean(rate(self.counters[(a, b)]) - .5 for a in rp for b in dp),
                     wrdiff(self.short), wrdiff(self.long)]
            ra, da = m.get("radiant_account_ids") or [], m.get("dire_account_ids") or []
            if len(ra) == len(da) == 5 and len(set(ra + da)) == 10 and all(isinstance(x, int) and 0 < x < 4294967295 for x in ra + da):
                roster = [mean(rate(self.players[p]) for p in ra) - mean(rate(self.players[p]) for p in da),
                          mean(rate(self.player_hero[(p, h)]) for p, h in zip(ra, rp)) -
                          mean(rate(self.player_hero[(p, h)]) for p, h in zip(da, dp)),
                          mean(min(1, self.player_hero[(p, h)][0] / 10) for p, h in list(zip(ra, rp)) + list(zip(da, dp))),
                          (len(set(ra) & self.last_roster.get(r, set())) - len(set(da) & self.last_roster.get(d, set()))) / 5,
                          math.log1p(min(self.players[p][0] for p in ra + da))]
        return base, draft, roster

    def update(self, m, *, available_at=None):
        r, d, win = m["radiant_team_id"], m["dire_team_id"], int(m["radiant_win"])
        # Explicit arrivals are validated by the shadow adapter. Retaining the
        # default preserves the archived end+300 research contract exactly.
        end = m["start_time"] + m["duration"] + 300 if available_at is None else available_at
        self.latest_outcome = max(self.latest_outcome, end)
        prior = 1 / (1 + 10 ** ((self.elo[d] - self.elo[r]) / 400))
        self.elo[r] += 24 * (win - prior)
        self.elo[d] -= 24 * (win - prior)
        total = (m["radiant_score"] + m["dire_score"]) if m.get("radiant_score") is not None and m.get("dire_score") is not None else None
        for team, won in ((r, win), (d, 1 - win)):
            self.teams[team].append((end, won, m["duration"], total / (m["duration"] / 60) if total is not None else None))
        pair = tuple(sorted((r, d)))
        self._add(self.h2h, pair, win if pair[0] == r else 1 - win)
        if known_series(m) is not None:
            self.series[m["series_id"]].append(r if win else d)
        rp, dp = m.get("radiant_picks"), m.get("dire_picks")
        if not valid_picks(rp, dp):
            return
        for team, heroes, accounts, won in ((r, rp, m.get("radiant_account_ids"), win),
                                           (d, dp, m.get("dire_account_ids"), 1 - win)):
            for h in heroes:
                self._add(self.heroes, h, won)
                if m["duration"] <= 1800:
                    self._add(self.short, h, won)
                if m["duration"] >= 2400:
                    self._add(self.long, h, won)
            for p in combinations(heroes, 2):
                self._add(self.synergy, tuple(sorted(p)), won)
            if accounts and len(accounts) == 5:
                for p, h in zip(accounts, heroes):
                    if isinstance(p, int) and 0 < p < 4294967295:
                        self._add(self.players, p, won)
                        self._add(self.player_hero, (p, h), won)
                self.last_roster[team] = {p for p in accounts if isinstance(p, int) and 0 < p < 4294967295}
        for a in rp:
            for b in dp:
                self._add(self.counters, (a, b), win)
                self._add(self.counters, (b, a), 1 - win)

    @staticmethod
    def _add(table, key, won):
        table[key][0] += 1
        table[key][1] += won

def prematch_rows(matches):
    history, queue, rows = History(), [], []
    for m in sorted(matches, key=lambda x: (x["start_time"], x["match_id"])):
        if (not m.get("radiant_team_id") or not m.get("dire_team_id") or
                m["radiant_team_id"] == m["dire_team_id"] or not 600 <= m["duration"] <= 10800):
            continue
        while queue and queue[0][0] < m["start_time"]:
            history.update(heapq.heappop(queue)[2])
        base, draft, roster = history.features(m)
        rows.append({"match_id": m["match_id"], "group": group_id(m), "start": m["start_time"],
                     "label_available": m["start_time"] + m["duration"] + 300,
                     "base": base, "draft": base + draft if draft is not None else None,
                     "roster": base + draft + roster if draft is not None and roster is not None else None,
                     "winner": int(m["radiant_win"]), "first_blood": m.get("first_blood_label"),
                     "kills": (m["radiant_score"] + m["dire_score"]) if m.get("radiant_score") is not None and m.get("dire_score") is not None else None,
                     "duration": m["duration"], "latest_feature_outcome": history.latest_outcome,
                     "radiant_picks": m.get("radiant_picks"), "dire_picks": m.get("dire_picks")})
        heapq.heappush(queue, (m["start_time"] + m["duration"] + 300, m["match_id"], m))
    return rows

def live_features(s, previous=None):
    t = s["game_time_sec"]
    if (not finite_number(t) or t < 60
            or any(not finite_number(s.get(k)) for k in ("radiant_lead", "radiant_score", "dire_score"))
            or s["radiant_score"] < 0 or s["dire_score"] < 0):
        return None
    gap = (t - previous["game_time_sec"]) / 60 if previous else 0
    trajectory = previous and 0 < gap <= 5
    kills = s["radiant_score"] + s["dire_score"]
    rp, dp = observed_draft(s)
    payload = s.get("raw_payload")
    delay = payload.get("delay") if isinstance(payload, dict) else None
    missing = float("nan")
    return [t / 60, s["radiant_lead"] / 1000, s["radiant_score"] - s["dire_score"], kills,
            kills / (t / 60),
            (s["radiant_lead"] - previous["radiant_lead"]) / 1000 / gap if trajectory and previous.get("radiant_lead") is not None else missing,
            (kills - previous["radiant_score"] - previous["dire_score"]) / gap if trajectory and previous.get("radiant_score") is not None and previous.get("dire_score") is not None else missing,
            gap if trajectory else missing, int(valid_picks(rp, dp)), float(delay) if finite_number(delay) and delay >= 0 else missing]

def observed_draft(snapshot):
    payload = snapshot.get("raw_payload")
    players = payload.get("players") if isinstance(payload, dict) else None
    if not isinstance(players, list):
        return [], []
    return ([p.get("hero_id") for p in players if isinstance(p, dict) and type(p.get("team")) is int and p["team"] == 0],
            [p.get("hero_id") for p in players if isinstance(p, dict) and type(p.get("team")) is int and p["team"] == 1])


def live_rows(snapshots, prematches):
    by_match = {r["match_id"]: r for r in prematches}
    previous, buckets, rows = {}, set(), []
    # Only previously RECEIVED states can form trajectory features. Never sort
    # by game clock first: a delayed packet can otherwise leak a later arrival.
    for s in sorted(snapshots, key=lambda v: (v["captured_at"], v["id"])):
        m = by_match.get(s["match_id"])
        t = s.get("game_time_sec")
        payload = s.get("raw_payload")
        synthetic = isinstance(payload, dict) and (payload.get("source") in ("backfill", "synthetic") or payload.get("synthetic") is True)
        if s.get("source") != "live" or synthetic or not m or not finite_number(t) or not 60 <= t < m["duration"]:
            continue
        captured = s["captured_at"].timestamp()
        if captured < m["start"] or captured >= m["label_available"]:
            continue
        prior = previous.get(s["match_id"])
        # Ignore duplicate/regressing game clocks. A stale packet cannot become
        # the previous state for a later trajectory, or add an earlier bucket.
        if prior is not None and t <= prior["game_time_sec"]:
            continue
        x = live_features(s, prior)
        if x is None:
            continue
        previous[s["match_id"]] = s
        key = (s["match_id"], t // 180)
        if x is None or key in buckets:
            continue
        buckets.add(key)
        row = {k: m[k] for k in ("match_id", "group", "start", "label_available", "winner", "kills", "duration")}
        rp, dp = observed_draft(s)
        draft_matches = (valid_picks(rp, dp) and valid_picks(m.get("radiant_picks"), m.get("dire_picks"))
                         and set(rp) == set(m["radiant_picks"]) and set(dp) == set(m["dire_picks"]))
        row.update(snapshot_id=s["id"], captured=captured, base=m["base"] + x,
                   draft=m["draft"] + x if draft_matches and m["draft"] is not None else None,
                   roster=None, game_minute=t / 60)
        rows.append(row)
    return rows

def split_rows(rows, purge_seconds=DAY, boundaries=None):
    """Four fixed chronological series-disjoint splits with boundary purge."""
    groups = {}
    for r in rows:
        g = groups.setdefault(r["group"], {"first": r["start"], "last": r["label_available"]})
        g["first"] = min(g["first"], r["start"])
        g["last"] = max(g["last"], r["label_available"])
    ordered = sorted(groups, key=lambda g: (groups[g]["first"], g))
    if len(ordered) < 20:
        raise ValueError("fewer than 20 independent groups")
    fixed_boundaries = boundaries is not None
    if fixed_boundaries:
        if (len(boundaries) != 3 or any(type(v) is not int for v in boundaries)
                or not boundaries[0] < boundaries[1] < boundaries[2]):
            raise ValueError("exactly three increasing integer UTC boundaries required")
        boundaries = list(boundaries)
    else:
        boundaries = [groups[ordered[int(len(ordered) * f)]]["first"] for f in (.65, .75, .85)]
    result = {k: [] for k in ("train", "validation", "calib", "test")}
    purged = set()
    for r in rows:
        g = groups[r["group"]]
        index = sum(g["first"] >= b for b in boundaries)
        if index < 3 and g["last"] >= boundaries[index] - purge_seconds:
            purged.add(r["group"])
            continue
        result[list(result)[index]].append(r)
    manifest = {"boundaries_unix": boundaries, "purge_seconds": purge_seconds,
                "boundary_selection": "fixed_calendar_prespecified_from_coverage" if fixed_boundaries else "group_count_quantiles_65_75_85",
                "purged_groups": len(purged), "purged_group_ids": sorted(purged),
                "grouping": "known series_id else same team pair/league/UTC day (heuristic)", "splits": {}}
    for name, data in result.items():
        ids = sorted({r["match_id"] for r in data})
        manifest["splits"][name] = {"rows": len(data), "matches": len(ids),
              "groups": len({r["group"] for r in data}), "match_ids": ids,
              "group_ids": sorted({r["group"] for r in data}),
              "min_start": min((r["start"] for r in data), default=None),
              "max_label_available": max((r["label_available"] for r in data), default=None)}
    return result, manifest

def fingerprint(rows):
    return hashlib.sha256(json.dumps(rows, sort_keys=True, allow_nan=True, separators=(",", ":")).encode()).hexdigest()
