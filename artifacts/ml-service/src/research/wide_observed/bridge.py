"""Source-bound 7148 + 56 state + interactions -> 36114, no inference.

The trusted reader provides complete raw candidate lineage before DISTINCT or
lower-clock filtering. We repeat selection from raw hashes; an arbitrary caller
can manufacture hashes, so this is NOT an authenticated DB provenance boundary.
"""
from __future__ import annotations
import numpy as np
from .lineage import Refusal,verify_projection,stamp,objhash,canonical
from .sources import HERE,verify_sources,seconds,wall,utcnow,decoded,encoded
from .anchor import AnchorStore,check_current,observation
from . import frozen_wide
from .frozen_form import FormComebackSchema
from ..postdraft_full.wide_history import WideSchema
from .provenance import validate as validate_provenance

def project_observed(reader,store,*,clock=utcnow):
 if not isinstance(reader,dict) or not isinstance(store,AnchorStore):raise Refusal('reader_and_store_required')
 # The external wrapper MUST byte-limit JSON BEFORE parsing; this in-process
 # function additionally bounds candidate count and per-source bytes.
 row=reader.get('current');candidates=reader.get('candidates')
 if not isinstance(candidates,list) or len(candidates)>1024:raise Refusal('candidate_count_bound')
 now=wall(clock);ident=check_current(row,capture_outcome_known=reader.get('captureOutcomeKnown'),
  outcome_known_at_read=reader.get('outcomeKnownAtRead'),now=now)
 origin=validate_provenance(reader.get('provenance'),row,now)
 selection=verify_projection(reader.get('selection'),row,candidates,query_truncated=reader.get('queryTruncated'))
 anchor=store.load(row['match_id'])
 if anchor['identity']!=ident:raise Refusal('anchor_roster_or_side_changed')
 if stamp(row['received_at'])<stamp(anchor['featureAsOf']) or stamp(row['recorded_at'])<stamp(anchor['anchorObservation']['recorded_at']):raise Refusal('current_before_anchor')
 if seconds(anchor['priorComputedAt'])>stamp(row['received_at'])/1000:raise Refusal('anchor_not_available_before_current')
 bundle=verify_sources();schema=frozen_wide.Schema.load(HERE);prior=decoded(anchor['prior7148'],7148);proof=anchor['snapshotProof']
 context={'mode':'observed_receipt_context','match_id':row['match_id'],'feature_schema_sha256':frozen_wide.NAMES_SHA,
  'target_start':stamp(anchor['featureAsOf'])/1000, # formula field name, NOT actual game start
  'latest_prior_outcome_available_at':proof['latestPriorReconstructedAvailableAt'],
  'latest_prior_receipt_at':seconds(proof['cacheBuiltAt']),
  'context_built_at':seconds(anchor['priorComputedAt']),'feature_vector_sha256':anchor['prior7148']['float32Sha256']}
 base,evidence=frozen_wide.build(schema,prior_vector=prior,context=context,current=selection['current'],history=selection['history'])
 extension=FormComebackSchema(schema.names(),dict(WideSchema.load(HERE).groups))
 with np.errstate(over='ignore',invalid='ignore'):vector=extension.expand(base.reshape(1,-1))[0]
 current_source=observation(row)
 # Pin ALL input candidates, including excluded rows that witness a reset or
 # future receipt, so changing selection evidence changes the input hash.
 lineage=[{k:r[k] for k in ('id','input_hash','schema_hash','match_id','game_time_sec','received_at','recorded_at')} for r in candidates]
 source={'current':current_source,'candidateLineage':lineage,'queryTruncated':False,
  'selection':selection,'anchorSha256':anchor['anchorSha256'],'captureOutcomeKnown':False,'outcomeKnownAtRead':False,
  'readerProvenance':origin}
 return {'contract':'observed_wide36114_projection_v1','status':'projected_diagnostic','matchId':row['match_id'],
  'phase':'live','gameTimeSeconds':row['game_time_sec'],'featureAsOf':row['received_at'],'actualGameStart':None,
  'priorFeatureAsOf':anchor['featureAsOf'],'anchorSha256':anchor['anchorSha256'],'sourceInputSha256':objhash(source),
  'sourceSchemaSha256':row['schema_hash'],'builderBundleSha256':bundle,'featureNamesSha256':objhash(extension.names),
  'features36114':encoded(vector),'sourceLineage':source,'formulaEvidence':evidence,
  'contextTimeSemantics':'draft_receipt_anchor_not_actual_match_start',
  'historicalProfiles':'end_plus_300_reconstruction_available_via_pre_draft_immutable_snapshot',
  'prediction':None,'modelHash':None,'modelClockSupportValidated':False,
  'measuredEventToReceiptSeconds':None,'quality':{'eligibleForServing':False,'eligibleForPromotion':False,
   'prospectiveValidated':False,'coverage95Validated':False,'eventLatencyVerified':False,
   'currentStateFreshnessIndependentlyVerified':False,'originalHistoricalReceiptProven':False},
  'limitations':['Projection only; no model domain or prediction is asserted.',
   'Natural unseen/missing historical values remain NaN/null; no transport-success claim.',
   'Receipt freshness is not actual game event latency.',
   'Trusted committed-row reader and durable outcome checks are required at integration.']}
