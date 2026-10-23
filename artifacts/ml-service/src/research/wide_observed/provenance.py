"""Validate reader metadata without pretending metadata authenticates the caller."""
from __future__ import annotations
import re
from .lineage import Refusal,canonical,parse,type_equal,stamp
from .sources import HERE,bounded,seconds

def validate(value,current,now):
 if not isinstance(value,dict):raise Refusal('committed_reader_provenance_required')
 required={'policy','source','readAt','snapshotId','isolation','originalCommitTimeProven',
           'servingEligibilityAssessed','maxCandidates','queryHash','sourceAvailability','sourceQualityReasons'}
 if set(value)!=required:raise Refusal('reader_provenance_keys')
 contract=parse(bounded(HERE/'READER-CONTRACT.json',10000))
 if value['policy']!=contract['policy'] or value['queryHash']!=contract['querySha256'] or value['source']!='local_committed_journal':raise Refusal('reader_policy_or_query_pin')
 if value['isolation']!='repeatable_read_read_only' or value['originalCommitTimeProven'] is not False or value['servingEligibilityAssessed'] is not False or type(value['maxCandidates']) is not int or value['maxCandidates']!=1024:raise Refusal('reader_scope')
 if not isinstance(value['snapshotId'],str) or len(value['snapshotId'])>512 or not re.fullmatch(r'[0-9]+:[0-9]+:[0-9,]*',value['snapshotId']):raise Refusal('reader_snapshot_id')
 # Transaction timestamps preserve microseconds; journal IDs still require ms.
 if not stamp(current['recorded_at'])/1000<=seconds(value['readAt'])<=seconds(now):raise Refusal('reader_time_order')
 if not type_equal(value['sourceAvailability'],current.get('availability')):raise Refusal('reader_availability_binding')
 raw=canonical(value)
 if len(raw)>65536:raise Refusal('reader_provenance_size')
 return parse(raw)

def decode_reader_body(raw):
 """Optional pure wire boundary. HTTP wrapper must bound its stream too."""
 if not isinstance(raw,bytes) or len(raw)>16*1024*1024:raise Refusal('reader_wire_bound')
 result=parse(raw)
 if not isinstance(result,dict):raise Refusal('reader_body_object')
 return result
