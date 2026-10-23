"""Causal player history for exploratory post-draft models.

Only call update after a completed map becomes available, in availability order.
features must run strictly after the latest update. Current inputs need only
account_id and hero_id; current lane_role is deliberately ignored. Logged past
lane_role means OpenDota lane category (1..4), NOT farm position 1..5.

rating is a transparent team-result Elo proxy assigned to participating players,
not personal MMR/Glicko, individual mechanical skill, or a production model.
No current-map scalar stats or result are read by features.
"""
from collections import defaultdict, deque
from dataclasses import dataclass
import math

DAY = 86400.0


def _finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def _account(value):
    return type(value) is int and 0 < value < 4294967295


def _players(players):
    """Partial lineups are allowed, but repeated/cross-side IDs are not."""
    out = []
    for player in players:
        account = player.get('account_id')
        if not _account(account):
            continue
        hero = player.get('hero_id')
        hero = hero if type(hero) is int and hero > 0 else None
        role = player.get('lane_role')
        role = role if type(role) is int and role in (1, 2, 3, 4) else None
        out.append((account, hero, role))
    if len({p[0] for p in out}) != len(out):
        raise ValueError('Duplicate account IDs in a lineup')
    return out


def _lineups(radiant, dire):
    r, d = _players(radiant), _players(dire)
    if {p[0] for p in r} & {p[0] for p in d}:
        raise ValueError('The same account cannot belong to both sides')
    return r, d


@dataclass(frozen=True, slots=True)
class Event:
    available_at: float
    won: int
    hero: int | None
    role: int | None


class PlayerHistory:
    """Monotonic streaming history; outcome updates are separate from reads."""
    def __init__(self, k_factor=24.0, prior_games=10.0):
        if not _finite(k_factor) or k_factor <= 0:
            raise ValueError('k_factor must be positive')
        if not _finite(prior_games) or prior_games <= 0:
            raise ValueError('prior_games must be positive')
        self.k_factor = float(k_factor)
        self.prior_games = float(prior_games)
        self.rating = defaultdict(lambda: 1500.0)
        self.games = defaultdict(int)
        self.hero_games = defaultdict(lambda: [0, 0])
        self.last_hero = {}
        self.events = defaultdict(deque)
        self.last_available_at = float('-inf')
        self.last_prediction_at = float('-inf')
        self.seen_matches = set()
        self.feature_groups = {}

    def _wr(self, events):
        return (sum(e.won for e in events) + self.prior_games / 2) / (len(events) + self.prior_games)

    @staticmethod
    def _stats(values):
        values = [v for v in values if _finite(v)]
        if not values:
            return dict(mean=float('nan'), min=float('nan'), max=float('nan'), std=float('nan'))
        mean = sum(values) / len(values)
        return dict(mean=mean, min=min(values), max=max(values),
                    std=math.sqrt(sum((v - mean)**2 for v in values) / len(values)))

    def features(self, radiant_players, dire_players, at):
        if not _finite(at) or at <= self.last_available_at:
            raise ValueError('Prediction must be strictly after all available outcome updates')
        if at < self.last_prediction_at:
            raise ValueError('Prediction times must be monotonic')
        self.last_prediction_at = float(at)
        lineups = _lineups(radiant_players, dire_players)
        per_side = []
        for lineup in lineups:
            values = defaultdict(list)
            for player, hero, _ignored_current_role in lineup:
                history = list(self.events[player])
                windows = {days: [e for e in history if at - days * DAY <= e.available_at < at]
                           for days in (30, 90)}
                values['result_rating'].append((self.rating[player] - 1500) / 200)
                values['result_rating_log_games'].append(math.log1p(self.games[player]))
                for days, events in windows.items():
                    values[f'form_wr_{days}d'].append(self._wr(events))
                    values[f'form_log_games_{days}d'].append(math.log1p(len(events)))
                    if hero is not None:
                        selected = [e for e in events if e.hero == hero]
                        values[f'hero_wr_{days}d'].append(self._wr(selected))
                        values[f'hero_log_games_{days}d'].append(math.log1p(len(selected)))
                        values[f'hero_pick_share_{days}d'].append(len(selected) / len(events) if events else float('nan'))
                if hero is not None:
                    count, wins = self.hero_games[(player, hero)]
                    values['hero_lifetime_wr'].append((wins + self.prior_games / 2) / (count + self.prior_games))
                    values['hero_lifetime_log_games'].append(math.log1p(count))
                    last = self.last_hero.get((player, hero))
                    values['hero_days_since_last'].append((at - last) / DAY if last is not None else float('nan'))
                role_events = [e for e in windows[90] if e.role is not None]
                counts = {role: sum(e.role == role for e in role_events) for role in (1, 2, 3, 4)}
                total = len(role_events)
                values['role_log_observations_90d'].append(math.log1p(total))
                if total:
                    fractions = {role: count / total for role, count in counts.items()}
                    values['role_modal_share_90d'].append(max(fractions.values()))
                    values['role_entropy_90d'].append(-sum(p * math.log(p) for p in fractions.values() if p) / math.log(4))
                    values['role_last_continuity_90d'].append(fractions[role_events[-1].role])
                    values['role_switch_fraction_90d'].append(
                        sum(a.role != b.role for a, b in zip(role_events, role_events[1:])) / (total - 1)
                        if total > 1 else float('nan'))
                    for role, fraction in fractions.items():
                        values[f'role_lane_{role}_share_90d'].append(fraction)
            per_side.append(values)
        # Fixed schema even for an empty roster or no historical role observations.
        prefixes = [('result_rating', 'player_rating'), ('result_rating_log_games', 'player_rating')]
        prefixes += [(f'form_{what}_{days}d', 'player_form') for days in (30, 90) for what in ('wr', 'log_games')]
        prefixes += [(f'hero_{what}_{days}d', 'player_hero') for days in (30, 90) for what in ('wr', 'log_games', 'pick_share')]
        prefixes += [(f'hero_{what}', 'player_hero') for what in ('lifetime_wr', 'lifetime_log_games', 'days_since_last')]
        prefixes += [(f'role_{what}_90d', 'player_role') for what in
                     ('log_observations', 'modal_share', 'entropy', 'last_continuity', 'switch_fraction',
                      'lane_1_share', 'lane_2_share', 'lane_3_share', 'lane_4_share')]
        result = {}
        for prefix, group in prefixes:
            summaries = [self._stats(side[prefix]) for side in per_side]
            for stat in ('mean', 'min', 'max', 'std'):
                for side, name in enumerate(('radiant', 'dire')):
                    result[f'player_{prefix}_{stat}_{name}'] = summaries[side][stat]
                result[f'player_{prefix}_{stat}_diff'] = summaries[0][stat] - summaries[1][stat]
            for side, name in enumerate(('radiant', 'dire')):
                result[f'player_{prefix}_coverage_{name}'] = sum(_finite(v) for v in per_side[side][prefix]) / 5
            for name in list(result)[-14:]:
                self.feature_groups[name] = group
        return result

    def update(self, radiant_players, dire_players, radiant_win, available_at,
               started_at=None, match_id=None):
        """Apply a *completed* map after its declared data-availability time.

        Elo expectation is computed using ratings known immediately before this
        update, in availability order. All present teammates get the same delta;
        partial lineups receive a rating update only if both sides have members.
        Historical form and hero counts can still update when one side is unknown.
        Timestamps are archive availability assumptions supplied by the caller.
        """
        if type(radiant_win) is not bool:
            raise ValueError('radiant_win must be a boolean completed-map outcome')
        if not _finite(available_at) or available_at < self.last_available_at:
            raise ValueError('Updates must be monotonic in availability time')
        if started_at is not None and (not _finite(started_at) or started_at >= available_at):
            raise ValueError('Map must start before its result becomes available')
        if match_id is not None and match_id in self.seen_matches:
            raise ValueError('Duplicate match outcome update')
        r, d = _lineups(radiant_players, dire_players)
        if r and d:
            mean_r = sum(self.rating[p] for p, _, _ in r) / len(r)
            mean_d = sum(self.rating[p] for p, _, _ in d) / len(d)
            exponent = max(-20.0, min(20.0, (mean_d - mean_r) / 400))
            expected = 1 / (1 + 10**exponent)
            delta = self.k_factor * (int(radiant_win) - expected)
            for lineup, sign in ((r, 1), (d, -1)):
                for player, _, _ in lineup:
                    self.rating[player] += sign * delta
        for lineup, won in ((r, int(radiant_win)), (d, int(not radiant_win))):
            for player, hero, role in lineup:
                self.games[player] += 1
                history = self.events[player]
                while history and history[0].available_at < available_at - 90 * DAY:
                    history.popleft()
                history.append(Event(float(available_at), won, hero, role))
                if hero is not None:
                    counter = self.hero_games[(player, hero)]
                    counter[0] += 1
                    counter[1] += won
                    self.last_hero[(player, hero)] = float(available_at)
        self.last_available_at = float(available_at)
        if match_id is not None:
            self.seen_matches.add(match_id)
