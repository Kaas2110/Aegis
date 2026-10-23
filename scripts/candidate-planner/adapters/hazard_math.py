"""Pure research proof helpers: no fitting, model inference, network or database.

Y is an integer remaining count or remaining seconds. A frame's at-risk loss is
the negative log of its PMF (or survival beyond U). Sampling controls conditional
on Y is a likelihood design. Only (observed state, candidate k) are model inputs.
"""
from dataclasses import dataclass
import hashlib
import math
import numbers
import numpy as np


def integer(value, name):
    if isinstance(value, (bool, np.bool_)) or not isinstance(value, numbers.Integral):
        raise ValueError(f'{name} must be an integer, not bool or float')
    return int(value)


@dataclass(frozen=True)
class RiskSample:
    positions: tuple
    labels: tuple
    weights: tuple
    control_count: int
    observed_event: bool
    frame_weight: float


def risk_spec(y, lower, upper, frame_weight):
    y=integer(y,'y'); lower=integer(lower,'lower'); upper=integer(upper,'upper')
    if lower < 0 or upper < lower or y < lower:
        raise ValueError('invalid support or target')
    if isinstance(frame_weight,(bool,np.bool_)) or not math.isfinite(frame_weight) or frame_weight<=0:
        raise ValueError('frame_weight must be positive finite')
    stop=min(y,upper+1)
    return y,lower,upper,stop-lower,y<=upper,float(frame_weight)


def assemble_risk_sample(y, lower, upper, frame_weight, controls):
    """Uniform fixed-size control design. Explicit controls support exact proofs.

    Caller must draw a simple random sample without replacement from all N
    positions lower..min(Y-1,U). Other inclusion designs need their own weights.
    """
    y,lower,upper,n,event,w=risk_spec(y,lower,upper,frame_weight)
    controls=tuple(integer(k,'control') for k in controls)
    if len(set(controls))!=len(controls) or any(k<lower or k>=lower+n for k in controls):
        raise ValueError('controls must be distinct in-risk positions')
    if n>0 and len(controls)==0:
        raise ValueError('nonempty risk set requires positive inclusion probability')
    ordered=tuple(sorted(controls)); s=len(ordered)
    positions=ordered+((y,) if event else ())
    labels=(0,)*s+((1,) if event else ())
    weights=(w*n/s,)*s if s else ()
    weights+=((w,) if event else ())
    return RiskSample(positions,labels,weights,n,event,w)


def sample_risk_set(y, lower, upper, frame_weight, *, row_id, target, control_budget=21):
    y,lower,upper,n,event,w=risk_spec(y,lower,upper,frame_weight)
    control_budget=integer(control_budget,'control_budget')
    if control_budget<1: raise ValueError('control_budget must be positive')
    if not isinstance(row_id,str) or not row_id or target not in ('kills','duration'):
        raise ValueError('stable row_id and target required')
    digest=hashlib.sha256(f'hazard-v1|42|{target}|{row_id}'.encode()).digest()
    rng=np.random.default_rng(int.from_bytes(digest[:16],'little'))
    controls=rng.choice(n,min(n,control_budget),replace=False)+lower if n else ()
    return assemble_risk_sample(y,lower,upper,w,controls)


def expanded_inputs(observed_state, positions):
    """No target/event label/risk length/IPW columns: X=(state, candidate k)."""
    state=np.asarray(observed_state,dtype=float)
    if state.ndim!=1 or not np.isfinite(state).all(): raise ValueError('invalid state')
    kk=np.array([integer(k,'position') for k in positions],dtype=float)
    return np.column_stack((np.tile(state,(len(kk),1)),kk))


def logistic_terms(logits, labels, weights):
    """Per-row weighted loss, gradient and Hessian w.r.t. the row's logit."""
    z=np.asarray(logits,dtype=float); y=np.asarray(labels,dtype=float); w=np.asarray(weights,dtype=float)
    if z.ndim!=1 or z.shape!=y.shape or z.shape!=w.shape:
        raise ValueError('one-dimensional equal shapes required')
    if not (np.isfinite(z).all() and np.isfinite(w).all() and (w>0).all() and np.isin(y,[0,1]).all()):
        raise ValueError('invalid loss inputs')
    e=np.exp(-np.abs(z)); p=np.where(z>=0,1/(1+e),e/(1+e))
    loss=w*np.logaddexp(0,np.where(y==1,-z,z))
    return loss,w*(p-y),w*p*(1-p)


def log_distribution(logits):
    """Canonical finite log PMF plus separate right tail; no forced F(U)=1.

    Finite logits give mathematically positive atoms and tail. Converting very
    small masses to float probabilities can underflow; preserve logs, report
    underflow, and never describe that as structural zero model probability.
    """
    z=np.asarray(logits,dtype=float)
    if z.ndim!=1 or len(z)==0 or not np.isfinite(z).all():
        raise ValueError('finite nonempty one-dimensional logits required')
    log_h=-np.logaddexp(0,-z); log_one_minus_h=-np.logaddexp(0,z)
    log_survival=np.cumsum(log_one_minus_h)
    if not np.isfinite(log_survival).all(): raise ValueError('log survival overflow')
    before=np.concatenate(([0.0],log_survival[:-1]))
    log_pmf=before+log_h
    log_tail=float(log_survival[-1])
    probability=np.exp(log_pmf)
    return {'log_pmf':log_pmf,'log_tail':log_tail,'log_survival':log_survival,
            'pmf':probability,'tail':float(np.exp(log_tail)),
            'underflow_atoms':int((probability==0).sum()),'tail_underflow':bool(np.exp(log_tail)==0)}


def global_temperature(logits, temperature):
    """One shared temperature; no line-wise calibrators, no data fitting here."""
    if isinstance(temperature,(bool,np.bool_)) or not math.isfinite(temperature) or temperature<=0:
        raise ValueError('positive finite temperature required')
    z=np.asarray(logits,dtype=float)
    if not np.isfinite(z).all(): raise ValueError('finite logits required')
    return z/temperature
