"""Request-owned lazy copies of only the history entries a draft reads.

The frozen cache is never updated by inference. A full deepcopy copied every
player, team, hero and match for each request. These views retain the original
feature methods, but copy a value on its first access and cache that private
copy. Mutable deques/counters/nested profiles are therefore never exposed from
the shared state, even when an existing feature method trims or appends to one.
Missing defaultdict entries are created locally, never in the frozen history.

This is not an update-capable Accumulator. Concurrent updates/bootstrap on its
source are unsupported: publish only a finished FutureCache.
"""
from __future__ import annotations
import copy
from collections.abc import Mapping


class LocalEntries(Mapping):
    """Mapping with normal get/default semantics and copy-on-read values."""
    __slots__ = ('_source', '_local', '_memo', '_factory')
    def __init__(self, source, memo):
        self._source = source
        self._local = {}
        self._memo = memo
        self._factory = getattr(source, 'default_factory', None)

    def __getitem__(self, key):
        if key in self._local:
            return self._local[key]
        if key in self._source:
            value = copy.deepcopy(self._source[key], self._memo)
        elif self._factory is not None:
            value = self._factory()
        else:
            raise KeyError(key)
        self._local[key] = value
        return value

    def __contains__(self, key):
        return key in self._local or key in self._source

    def get(self, key, default=None):
        return self[key] if key in self else default

    def __iter__(self):
        yield from self._source
        yield from (key for key in self._local if key not in self._source)

    def __len__(self):
        return len(self._source) + sum(key not in self._source for key in self._local)


def request_view(state):
    """O(1) setup; subsequent copies scale with this draft's accessed records.

    All original arithmetic, traversal order and missing defaults are retained.
    Only inference uses this view. Training/bootstrap still use the unchanged
    mutable accumulators. The memo preserves aliases between copied entries.
    """
    memo = {}
    def owner(source, tables, local_dicts=()):
        target = copy.copy(source)
        for name in tables:
            setattr(target, name, LocalEntries(getattr(source, name), memo))
        for name in local_dicts:
            setattr(target, name, dict(getattr(source, name)))
        return target

    result = copy.copy(state)
    result.rich = owner(state.rich,
        ('team_games', 'hero_perf', 'playerhero_perf', 'player_recent', 'rosters'),
        ('feature_groups',))
    result.rich.basic = owner(state.rich.basic,
        ('elo', 'teams', 'heroes', 'short', 'long', 'players', 'player_hero',
         'synergy', 'counters', 'h2h', 'last_roster', 'series'))
    result.rich.individual = owner(state.rich.individual,
        ('rating', 'games', 'hero_games', 'last_hero', 'events'), ('feature_groups',))
    # Decayed.get is read-only, but give each table a local view as well so no
    # shared mutable value is returned if its representation changes later.
    result.rich.rates = {}
    for half, tables in state.rich.rates.items():
        result.rich.rates[half] = {name: owner(table, ('data',)) for name, table in tables.items()}
    result.perf = owner(state.perf, ('player', 'hero'))
    result.first = owner(state.first, ('team_games', 'hero_perf', 'playerhero_perf'))
    return result
