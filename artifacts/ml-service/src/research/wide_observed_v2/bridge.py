"""Existing immutable AnchorStore + v2 roster DTO + unchanged36114 formulas.

No anchor creation, cache refresh, DB/provider, model loading, or serving path.
The caller must enforce trusted-reader authentication and durable outcome checks.
"""
from pathlib import Path
import json,re,hashlib
import numpy as np
from src.research.wide_observed import sources,frozen_wide,frozen_form
from src.research.wide_observed.anchor import AnchorStore,observation
from src.research.wide_observed.lineage import Refusal,canonical,objhash,stamp,type_equal,parse
from src.research.postdraft_full.wide_history import WideSchema
from .roster_resolution import gate_projection_current,verify_projection,POLICY as ROSTER_POLICY

HERE=Path(__file__).resolve().parent
ANCHOR_BINDING='wide.verified-stored-anchor-binding.v1'
READER_POLICY='wide.committed-observation-reader.immutable-roster.v2'

def verify_package():
 from .pins import MANIFEST_SHA256
 raw=sources.bounded(HERE/'SOURCE-MANIFEST.json',100000)
 if hashlib.sha256(raw).hexdigest()!=MANIFEST_SHA256:raise Refusal('v2_source_manifest_pin')
 manifest=parse(raw)
 for name,pin in manifest['python'].items():
  if Path(name).name!=name or hashlib.sha256(sources.bounded(HERE/name,2000000)).hexdigest()!=pin:raise Refusal('v2_own_source_pin')
 if sources.verify_sources()!=manifest['frozenFormulaBundleSha256']:raise Refusal('v2_frozen_formula_bundle_changed')
 return MANIFEST_SHA256

def binding_from_loaded(anchor):
 return dict(contract=ANCHOR_BINDING,anchorSha256=anchor['anchorSha256'],matchId=anchor['matchId'],
  anchorObservation=anchor['anchorObservation'],featureAsOf=anchor['featureAsOf'],priorComputedAt=anchor['priorComputedAt'],
  builderBundleSha256=anchor['builderBundleSha256'],priorFeatureNamesSha256=anchor['priorFeatureNamesSha256'],
  anchorStoreValidated=True,trustedCallerRequired=True,eligibleForServing=False)

def load_anchor_binding(store,match_id):
 """Trusted internal seam. Hashes alone are not a public authentication API."""
 verify_package()
 if not isinstance(store,AnchorStore):raise Refusal('actual_anchor_store_required')
 return parse(canonical(binding_from_loaded(store.load(match_id))))

def validate_provenance(value,current,now):
 if not isinstance(value,dict):raise Refusal('committed_reader_provenance_required')
 required={'policy','source','readAt','snapshotId','isolation','originalCommitTimeProven',
  'servingEligibilityAssessed','maxCandidates','queryHash','sourceAvailability','sourceQualityReasons'}
 if set(value)!=required:raise Refusal('reader_provenance_keys')
 contract=parse(sources.bounded(HERE/'READER-CONTRACT.json',10000))
 if value['policy']!=contract['policy'] or value['queryHash']!=contract['querySha256'] or value['source']!='local_committed_journal':raise Refusal('reader_policy_or_query_pin')
 if value['isolation']!='repeatable_read_read_only' or value['originalCommitTimeProven'] is not False or value['servingEligibilityAssessed'] is not False or type(value['maxCandidates']) is not int or value['maxCandidates']!=1024:raise Refusal('reader_scope')
 if not isinstance(value['snapshotId'],str) or len(value['snapshotId'])>512 or not re.fullmatch(r'[0-9]+:[0-9]+:[0-9,]*',value['snapshotId']):raise Refusal('reader_snapshot_id')
 if not stamp(current['recorded_at'])/1000<=sources.seconds(value['readAt'])<=sources.seconds(now):raise Refusal('reader_time_order')
 if not type_equal(value['sourceAvailability'],current.get('availability')):raise Refusal('reader_availability_binding')
 raw=canonical(value)
 if len(raw)>65536:raise Refusal('reader_provenance_size')
 return parse(raw)

def project_observed(reader,store,*,clock=sources.utcnow):
 package=verify_package()
 if not isinstance(reader,dict) or not isinstance(store,AnchorStore):raise Refusal('reader_and_actual_store_required')
 row=reader.get('current');candidates=reader.get('candidates')
 if not isinstance(row,dict) or not isinstance(candidates,list) or len(candidates)>1024:raise Refusal('reader_current_or_candidates')
 # Loads/validates an existing computed prior. There is no creation fallback.
 anchor=store.load(row.get('match_id'));expected=binding_from_loaded(anchor)
 if not type_equal(reader.get('storedAnchor'),expected):raise Refusal('stored_anchor_binding_changed_or_unverified')
 now=sources.wall(clock)
 resolution=gate_projection_current(row,anchor['anchorObservation'],now_epoch_seconds=sources.seconds(now),
  capture_outcome_known=reader.get('captureOutcomeKnown'),outcome_known_at_read=reader.get('outcomeKnownAtRead'))
 origin=validate_provenance(reader.get('provenance'),row,now)
 selection=verify_projection(reader.get('selection'),row,candidates,anchor['anchorObservation'],query_truncated=reader.get('queryTruncated'))
 if resolution['identity']!=anchor['identity']:raise Refusal('anchor_roster_or_side_changed')
 if sources.seconds(anchor['priorComputedAt'])>stamp(row['received_at'])/1000:raise Refusal('anchor_not_available_before_current')
 bundle=sources.verify_sources();schema=frozen_wide.Schema.load(sources.HERE)
 prior=sources.decoded(anchor['prior7148'],7148);proof=anchor['snapshotProof']
 context={'mode':'observed_receipt_context','match_id':row['match_id'],'feature_schema_sha256':frozen_wide.NAMES_SHA,
  'target_start':stamp(anchor['featureAsOf'])/1000,'latest_prior_outcome_available_at':proof['latestPriorReconstructedAvailableAt'],
  'latest_prior_receipt_at':sources.seconds(proof['cacheBuiltAt']),'context_built_at':sources.seconds(anchor['priorComputedAt']),
  'feature_vector_sha256':anchor['prior7148']['float32Sha256']}
 base,evidence=frozen_wide.build(schema,prior_vector=prior,context=context,current=selection['current'],history=selection['history'])
 extension=frozen_form.FormComebackSchema(schema.names(),dict(WideSchema.load(sources.HERE).groups))
 with np.errstate(over='ignore',invalid='ignore'):vector=extension.expand(base.reshape(1,-1))[0]
 lineage=[{k:r[k] for k in ('id','input_hash','schema_hash','match_id','game_time_sec','received_at','recorded_at')} for r in candidates]
 source={'current':observation(row),'candidateLineage':lineage,'queryTruncated':False,'selection':selection,
  'storedAnchor':expected,'anchorSha256':anchor['anchorSha256'],'captureOutcomeKnown':False,'outcomeKnownAtRead':False,
  'readerProvenance':origin,'projectionBundleSha256':package}
 return {'contract':'observed_wide36114_immutable_roster_projection_v2','status':'projected_diagnostic','matchId':row['match_id'],
  'phase':'live','gameTimeSeconds':row['game_time_sec'],'featureAsOf':row['received_at'],'actualGameStart':None,
  'priorFeatureAsOf':anchor['featureAsOf'],'anchorSha256':anchor['anchorSha256'],'sourceInputSha256':objhash(source),
  'sourceSchemaSha256':row['schema_hash'],'builderBundleSha256':bundle,'projectionBundleSha256':package,
  'rosterPolicy':ROSTER_POLICY,'readerPolicy':READER_POLICY,'featureNamesSha256':objhash(extension.names),
  'features36114':sources.encoded(vector),'sourceLineage':source,'formulaEvidence':evidence,
  'rosterResolution':selection['rosterResolution'],'contextTimeSemantics':'draft_receipt_anchor_not_actual_match_start',
  'historicalProfiles':'end_plus_300_reconstruction_available_via_pre_draft_immutable_snapshot',
  'prediction':None,'modelHash':None,'modelClockSupportValidated':False,'measuredEventToReceiptSeconds':None,
  'quality':{'eligibleForServing':False,'eligibleForPromotion':False,'prospectiveValidated':False,'coverage95Validated':False,
   'eventLatencyVerified':False,'currentStateFreshnessIndependentlyVerified':False,'originalHistoricalReceiptProven':False,
   'currentPlayerStatisticsReconstructed':False},
  'limitations':['Feature projection only; no model execution or public quality claim.',
   'Resolved draft identity does not reconstruct missing player statistics.',
   'Trusted reader authentication and durable dispatch/finish outcome checks remain required.']}
