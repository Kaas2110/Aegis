"""Frozen init/expand only; no dataset/runner import."""
import numpy as np
GROUPS=('player_form','player_hero','player_rating','past_player_scalars','new_interactions',
        'comfort','team_style','style_response','style_response_elo','style_interaction','draft_style','comfort_style')

TRAJECTORIES=('recovery_from_minimum','retreat_from_maximum','kill_diff_per_minute',
              'lead_sign_changes','since_last_kill_lead_change_seconds')

class FormComebackSchema:

    def __init__(self, base_names, groups):
        if len(base_names) != 25074 or len(set(base_names)) != 25074:
            raise ValueError('base_schema_required')
        self.base_names = tuple(base_names)
        prior = [n.removeprefix('prior__') for n in base_names[:7148]]
        self.prior_indices = tuple((i for i, n in enumerate(prior) if not n.endswith('__missing') and groups[n] in GROUPS))
        self.trajectory_indices = tuple((base_names.index(f'trajectory__{window}s__{name}') for window in (300, 600) for name in TRAJECTORIES))
        if len(self.prior_indices) != 1104 or len(self.trajectory_indices) != 10:
            raise ValueError('extension_schema_drift')
        self.names = tuple(base_names) + tuple(('form_state__' + base_names[t] + '__' + prior[i] for t in self.trajectory_indices for i in self.prior_indices))
        if len(set(self.names)) != len(self.names):
            raise ValueError('duplicate_extension_name')

    def expand(self, base):
        base = np.asarray(base)
        if base.ndim != 2 or base.shape[1] != 25074 or base.dtype != np.float32 or np.isinf(base).any():
            raise ValueError('base_vector_contract')
        past = base[:, self.prior_indices].astype(np.float64)
        products = [(past * base[:, t, None]).astype('float32') for t in self.trajectory_indices]
        out = np.concatenate([base, *products], axis=1)
        if out.shape[1] != 36114 or np.isinf(out).any():
            raise ValueError('extension_overflow_or_width')
        return out
