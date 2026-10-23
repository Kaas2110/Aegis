from pathlib import Path
from .common import HERE,Refusal,bounded,parse,digest

def verify_host_package():
 from .pins import HOST_MANIFEST_SHA256
 raw=bounded(HERE/'host-manifest.json',100000)
 if digest(raw)!=HOST_MANIFEST_SHA256:raise Refusal('wide_host_manifest_pin')
 manifest=parse(raw)
 for name,expected in manifest['files'].items():
  relative=Path(name)
  if relative.is_absolute() or '..' in relative.parts:raise Refusal('wide_host_manifest_path')
  if digest(bounded(HERE/relative,8*1024*1024))!=expected:raise Refusal('wide_host_source_pin')
 resource=HERE.parent/'shadow_postdraft/resource.py'
 if digest(bounded(resource,100000))!=manifest['resourceProbeSha256']:raise Refusal('wide_resource_source_pin')
 return {'hostManifestSha256':digest(raw),'frozenFormulaBundleSha256':manifest['frozenFormulaBundleSha256'],
  'projectionBundleSha256':manifest['projectionBundleSha256'],'candidateManifestSha256':manifest['candidateManifestSha256']}
