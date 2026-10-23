"""Uninstalled full C1/C2 diagnostic binding; no model import at module load.

Only a guarded structurally exact bridge output reaches the lazy model backend.
Measured real vector parity remains diagnostic metadata, never a circular
prerequisite to computing the diagnostic used to investigate it.
"""
from __future__ import annotations
import hashlib, json, math, re, struct
from datetime import datetime, timezone

WIDTH={'C1':36114,'C2':45938}
CONTRACT='c2_full_vector_fitted_diagnostic.proposal.v1'
MODEL_SCOPE='explicit_cv_fold3_diagnostic_not_final_fit'
FLAGS={k:False for k in ('active','eligibleForServing','eligibleForPromotion',
                         'eligibleForQualityClaims','coverage95Validated','eventLatencyVerified')}

class Refusal(ValueError):pass
def require(ok,reason):
    if not ok:raise Refusal('c2_fitted_'+reason)
def digest(raw):return hashlib.sha256(raw).hexdigest()
def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
def parse(raw):
    def pairs(items):
        out={}
        for key,value in items:
            require(key not in out,'duplicate_json_key');out[key]=value
        return out
    try:return json.loads(raw,object_pairs_hook=pairs,parse_constant=lambda _:require(False,'nonfinite_json'))
    except Refusal:raise
    except(ValueError,UnicodeError,RecursionError):raise Refusal('c2_fitted_invalid_json')from None
def timestamp(value):
    require(type(value)is str and len(value)<=64,'aware_timestamp')
    try:d=datetime.fromisoformat(value.replace('Z','+00:00'))
    except ValueError:raise Refusal('c2_fitted_aware_timestamp')from None
    require(d.tzinfo is not None and d.timestamp()>0,'aware_timestamp');return d.timestamp()

def decode(value,width):
    require(type(value)is dict and set(value)=={'values','missing','float32Sha256'},'vector_contract')
    values,missing=value['values'],value['missing']
    require(type(values)is list and type(missing)is list and len(values)==len(missing)==width,'full_vector_width')
    parts=[]
    for x,m in zip(values,missing):
        require(type(m)is bool and (x is None)==m and
                (x is None or type(x)in(int,float)and math.isfinite(x)),'vector_null_mask')
        try:part=struct.pack('<f',math.nan if m else x)
        except(OverflowError,struct.error):raise Refusal('c2_fitted_vector_scalar')from None
        actual=struct.unpack('<f',part)[0]
        require(m or math.isfinite(actual)and actual==x,'vector_float32_roundtrip')
        parts.append(part)
    raw=b''.join(parts);require(digest(raw)==value['float32Sha256'],'vector_hash')
    return raw

def model_header(raw):
    require(type(raw)is bytes and 0<len(raw)<=32*1024**2 and b'\r'not in raw,'model_raw_framing')
    header=raw.split(b'\nTree=0\n',1)[0]
    try:fields=dict(line.decode('utf8').split('=',1)for line in header.splitlines()if b'='in line)
    except(ValueError,UnicodeError):raise Refusal('c2_fitted_model_header')from None
    require(fields.get('objective','').startswith('binary sigmoid:1')and
            fields.get('num_class')=='1'and fields.get('num_tree_per_iteration')=='1','binary_objective')
    names=fields.get('feature_names','').split(' ')
    trees=raw.count(b'\nTree=')
    require(trees==256 and len(names)==len(set(names)) and
            fields.get('max_feature_idx')==str(len(names)-1),'model_full_schema')
    return names

class FittedBindings:
    def __init__(self,bundle,binding_ref,*,model_factory=None,guard=lambda:None):
        self.bundle=bundle;self.binding_ref=binding_ref;self.factory=model_factory
        self.guard=guard;self.engines={};self.names={};self.raw={}
        raw=bundle.bytes(binding_ref,200_000);self.binding=parse(raw)
        b=self.binding
        require(b.get('contract')==CONTRACT and b.get('enabled')is True and
                b.get('approvedBy')=='root'and b.get('scope')==MODEL_SCOPE and b.get('fold')==3 and
                b.get('widths')==WIDTH and b.get('rounds')==256 and b.get('calibration')=='none_raw_binary',
                'explicit_root_diagnostic_binding_required')
        self.known=timestamp(b.get('modelBindingKnownAt'))
        self.training_cutoff=timestamp(b.get('latestTrainingOutcomeKnownAt'))
        train=parse(bundle.bytes(b.get('trainingMapIds'),100_000))
        require(type(train)is list and train==sorted(set(train))and 0<len(train)<=50000 and
                all(type(mid)is int and 0<mid<=2**53-1 for mid in train),'training_map_cohort')
        self.training_maps=set(train)
        require(type(b.get('models'))is dict and set(b['models'])==set(WIDTH),'both_full_arms_required')
        for arm,width in WIDTH.items():
            guard();entry=b['models'][arm]
            names=parse(bundle.bytes(entry['featureNames'],8*1024**2))
            require(type(names)is list and len(names)==len(set(names))==width and
                    digest(canonical(names))==entry.get('featureNamesSha256'),'exact_feature_order')
            model=bundle.bytes(entry['model'],32*1024**2)
            require(model_header(model)==names,'model_names_changed')
            done=parse(bundle.bytes(entry['done'],100_000));success=parse(bundle.bytes(entry['success'],10_000))
            resource_raw=bundle.bytes(entry['resource'],100_000);resource=parse(resource_raw)
            parity=parse(bundle.bytes(entry['trainParity'],100_000))
            provenance=parse(bundle.bytes(entry['fitProvenance'],100_000))
            require(done.get('identity')=={'arm':arm,'fold':3}and done.get('trees')==256 and
                    done.get('features')==width and done.get('protocolSha256')==b['trainingProtocolSha256'] and
                    done.get('artifactHashes',{}).get('model.txt')==digest(model),'completed_exact_model')
            require(success=={'doneSha256':entry['done']['sha256'],
                    'resourceSha256':digest(resource_raw),'protocolSha256':b['trainingProtocolSha256']},'success_seal')
            require(resource.get('returncode')==0 and resource.get('stop_reason')is None and
                    resource.get('family_cleanup_confirmed')is True and resource.get('exit_code_observed')is True and
                    resource.get('monitoring_valid')is True,'successful_resource_completion')
            for key,name in [('trainParity','TRAIN-PARITY.json'),('fitProvenance','FIT-PROVENANCE.json')]:
                require(done['artifactHashes'].get(name)==entry[key]['sha256'],'completed_artifact_pin')
            require(parity.get('bitwiseRawScoreParity')is True and parity.get('features')==width and
                    parity.get('namesSha256')==entry['featureNamesSha256'],'train_serialization_parity')
            require(provenance.get('dataCompleteSha256')==b['trainingDataCompleteSha256']and
                    provenance.get('dataConfigSha256')==b['trainingDataConfigSha256']and
                    provenance.get('rounds')==256 and provenance.get('trainingCadence')==60 and
                    provenance.get('validationCadences')==[60,300]and provenance.get('noOuterHoldout')is True,
                    'corrected_training_lineage')
            self.names[arm]=names;self.raw[arm]=model
        require(self.names['C2'][:WIDTH['C1']]==self.names['C1'],'c1_prefix_names')

    def status(self):
        return {'modelsBound':len(self.names),'modelsLoaded':len(self.engines),
                'scope':MODEL_SCOPE,'fold':3,'publicPrediction':None,**FLAGS}

    def project(self,value,*,observation_received_at,clock_seconds):
        self.guard();b=self.binding
        require(type(value)is dict and value.get('contract')=='staged_runtime_profile_bridge_v1'and
                value.get('status')=='projected_diagnostic','guarded_bridge_result_required')
        require(value.get('eligibleForServing')is False and value.get('eligibleForPromotion')is False,
                'public_flags_must_stay_false')
        require(all(type(value.get(k))is str and re.fullmatch('[a-f0-9]{64}',value[k])
                    for k in ('sourceInputSha256','priorV4Sha256')),'source_input_hashes_required')
        receipt=timestamp(observation_received_at)
        require(type(clock_seconds)in(int,float)and math.isfinite(clock_seconds)and
                clock_seconds>=300,'live5min_plus_clock_required')
        require(max(self.known,self.training_cutoff)<=receipt,'model_not_known_at_observation')
        cache=value.get('cacheProof',{});local=value.get('localLoader',{})
        require(cache.get('contract')=='staged_purchase_v4_7148_startup_cache_v1'and
                cache.get('sourceBundleSha256')==b['bridgeSourceBundleSha256']and
                local.get('timingPolicy')=='immutable_input_known_before_actual_start; materialized_before_observation_receipt',
                'corrected_source_lineage')
        timing=value.get('targetStartEvidence',{})
        require(timing.get('contract')=='reviewed_target_start_evidence_v1'and
                type(value.get('matchId'))is int and timing.get('matchId')==value['matchId']and
                type(timing.get('actualStart'))in(int,float)and type(timing.get('knownAt'))in(int,float)and
                timing['actualStart']<=timing['knownAt']<=receipt and
                type(local.get('sourceKnownAt'))in(int,float)and
                local['sourceKnownAt']<=timing['actualStart'] and
                type(local.get('cacheMaterializedAt'))in(int,float)and local['cacheMaterializedAt']<=receipt,
                'existing_start_and_availability_guards_required')
        require(value.get('featureNamesSha256')==digest(canonical(self.names['C2'])),'bridge_feature_order')
        raw={arm:decode(value.get(arm.lower()),width)for arm,width in WIDTH.items()}
        require(raw['C2'][:WIDTH['C1']*4]==raw['C1'],'full_c1_prefix_bits')
        output={}
        for arm,width in WIDTH.items():
            self.guard()
            if arm not in self.engines:
                if self.factory is None:
                    import lightgbm as lgb
                    model=lgb.Booster(model_str=self.raw[arm].decode('utf8'))
                else:model=self.factory(arm,self.raw[arm])
                require(model.feature_name()==self.names[arm]and model.num_feature()==width and
                        model.num_trees()==256,'loaded_model_full_schema')
                self.engines[arm]=model
            # Native arrays are created only after all input/source gates above.
            if self.factory is None:
                import numpy as np
                row=np.frombuffer(raw[arm],dtype='<f4').reshape(1,-1)
            else:row=[struct.unpack('<'+str(width)+'f',raw[arm])]
            q=self.engines[arm].predict(row,num_threads=1)
            require(len(q)==1 and type(float(q[0]))is float and math.isfinite(float(q[0]))and
                    0<=float(q[0])<=1,'finite_binary_probability')
            output[arm]={'radiantWinProbability':float(q[0]),'direWinProbability':1-float(q[0]),
                         'modelSha256':b['models'][arm]['model']['sha256'],
                         'inputFloat32Sha256':digest(raw[arm]),'features':width,
                         'featureNamesSha256':b['models'][arm]['featureNamesSha256'],
                         'scope':MODEL_SCOPE,'fold':3,'calibration':'none_raw_binary'}
            self.guard()
        return {'contract':CONTRACT,'status':'predicted_diagnostic','candidates':output,
                'matchId':value['matchId'],'phase':'live5min_plus',
                'clockSeconds':clock_seconds,'observationReceivedAt':observation_received_at,
                'modelBindingKnownAt':b['modelBindingKnownAt'],
                'modelBindingSha256':self.binding_ref['sha256'],
                'sourceInputSha256':value.get('sourceInputSha256'),
                'priorV4Sha256':value['priorV4Sha256'],
                'noWinnerSelected':True,'publicPrediction':None,
                'inTraining':value['matchId']in self.training_maps,
                'runtimeOfflineRealVectorParityProven':False,
                'trainSerializationParityIsRuntimeParity':False,
                'limitations':['CV fold3 diagnostic, not full TRAIN final fit',
                               'measured runtime/offline fullvector parity pending',
                               'raw probabilities, no calibration or quality admission'],
                'inferenceThreads':1,'servingOrQualityAdmission':False,**FLAGS}
