"""Evaluate numerical LightGBM raw scores over one integer candidate axis.

All state features remain fixed. Traverse their branches once per tree, then
fill each reachable candidate interval. No model or feature is changed.
Numerical missing semantics match LightGBM v4.6.0 tree.h NumericalDecision.
Unsupported model forms fail closed. This is research code, not installed.
"""
import math
import numpy as np


def compile_node(node, width, depth=0):
    if depth>128:raise ValueError('tree_too_deep')
    if any(k in node for k in ('leaf_coeff','leaf_const','leaf_features')):raise ValueError('linear_leaf_not_supported')
    if 'leaf_value' in node:
        value=float(node['leaf_value'])
        if not math.isfinite(value):raise ValueError('nonfinite_leaf')
        return (value,)
    feature=node.get('split_feature');threshold=node.get('threshold');missing=node.get('missing_type')
    if type(feature)is not int or not 0<=feature<width or node.get('decision_type')!='<=':raise ValueError('numerical_split_required')
    if type(threshold)not in (int,float) or not math.isfinite(threshold):raise ValueError('invalid_threshold')
    if missing not in ('None','NaN'):raise ValueError('unsupported_missing_semantics')
    if type(node.get('default_left'))is not bool:raise ValueError('missing_default_direction')
    return (feature,float(threshold),missing,node['default_left'],
            compile_node(node['left_child'],width,depth+1),compile_node(node['right_child'],width,depth+1))


class ConditionalTreeGrid:
    def __init__(self,dump,*,axis_feature):
        if dump.get('num_tree_per_iteration')!=1 or dump.get('num_class')!=1 or dump.get('average_output')is not False:
            raise ValueError('single_output_additive_model_required')
        if dump.get('objective')!='binary sigmoid:1':raise ValueError('binary_unit_sigmoid_required')
        self.width=dump['max_feature_idx']+1
        if type(axis_feature)is not int or not 0<=axis_feature<self.width:raise ValueError('invalid_axis')
        self.axis=axis_feature
        if not dump.get('tree_info'):raise ValueError('empty_model')
        self.trees=tuple(compile_node(t['tree_structure'],self.width) for t in dump['tree_info'])

    def predict(self,state,lower,upper):
        state=np.asarray(state)
        if state.shape!=(self.width,) or state.dtype!=np.float32 or np.isinf(state).any():raise ValueError('full_float32_state_required')
        if type(lower)is not int or type(upper)is not int or not 0<=lower<=upper<=2**24 or upper-lower>10000:raise ValueError('invalid_integer_support')
        out=np.zeros(upper-lower+1,dtype=np.float64)
        for tree in self.trees:
            stack=[(tree,lower,upper)]
            while stack:
                node,lo,hi=stack.pop()
                if lo>hi:continue
                if len(node)==1:
                    out[lo-lower:hi-lower+1]+=node[0]
                    continue
                f,t,missing,default,left,right=node
                if f==self.axis:
                    cut=math.floor(t)
                    stack.append((right,max(lo,cut+1),hi));stack.append((left,lo,min(hi,cut)))
                else:
                    value=float(state[f])
                    if math.isnan(value):
                        take_left=default if missing=='NaN' else 0.<=t
                    else:take_left=value<=t
                    stack.append((left if take_left else right,lo,hi))
        if not np.isfinite(out).all():raise ValueError('nonfinite_raw_prediction')
        return out
