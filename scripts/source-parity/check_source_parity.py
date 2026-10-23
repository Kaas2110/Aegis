"""Read-only comparison of public APP bytes with a pinned, locally available Git commit.

No fetch, checkout, provider call, training, rewrite, secret export or PR mutation.
Only paths, SHA256, sizes and classification are emitted; never source contents.
Requires Python >=3.9 and git. No third-party Python dependency.
"""
import argparse
import collections
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys

CONTRACT = 'aegis.public-source-parity.v1'
SHA = re.compile(r'^[0-9a-f]{40}$')
SECRET_PATTERNS = {
    'private_key': re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    'jwt': re.compile(rb'eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{12,}'),
    'github_token': re.compile(rb'(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})'),
    'steam_key_literal': re.compile(rb'(?i)(?:steam_web_api_key|api_key)\s*[=:]\s*["\']?[0-9a-f]{32}(?![0-9a-f])'),
    'credential_url': re.compile(rb'(?i)(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?)://[^\s"\'/:]+:[^\s"\'@]+@'),
    'literal_secret': re.compile(rb'''(?i)(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|bearer)\s*[=:]\s*["']([A-Za-z0-9_./+=-]{20,})["']'''),
    'literal_bearer': re.compile(rb'(?i)bearer\s+(?!\$|<)[A-Za-z0-9_.-]{30,}'),
    'query_api_key': re.compile(rb'(?i)[?&](?:api_key|access_token|key)=[A-Za-z0-9_-]{28,}'),
}
TREE_WEIGHTS = re.compile(rb'(?m)^Tree=\d+\r?$')
WINDOWS_RESERVED = re.compile(r'(?i)^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)')

class AuditError(Exception):
    """Contains only a controlled error code, never external stderr or source data."""

def digest(data):
    return hashlib.sha256(data).hexdigest()

def git(root, *args, input_data=None):
    env = dict(os.environ, GIT_OPTIONAL_LOCKS='0', GIT_LFS_SKIP_SMUDGE='1',
               GIT_NO_REPLACE_OBJECTS='1', GIT_NO_LAZY_FETCH='1', GIT_TERMINAL_PROMPT='0')
    result = subprocess.run(['git', '--no-replace-objects', '--no-lazy-fetch',
                             '-c', 'core.fsmonitor=false', '-C', str(root), *args],
                            input=input_data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, timeout=30)
    if result.returncode:
        raise AuditError('git_read_failed')
    return result.stdout

def safe_path(value):
    p = PurePosixPath(value)
    if (not value or p.is_absolute() or '..' in p.parts or '\\' in value or ':' in value
            or value != p.as_posix() or not p.parts
            or any(part.endswith((' ', '.')) or WINDOWS_RESERVED.match(part) for part in p.parts)
            or any(ord(c) < 32 or ord(c) == 127 for c in value)):
        raise AuditError('unsafe_repository_path')
    return p

def policy_reason(path, policy):
    p = safe_path(path)
    path = path.casefold()
    p = PurePosixPath(path)
    name = p.name
    if name.startswith('.env') and name != '.env.example':
        return 'private_environment'
    if path in policy['excludedPaths']:
        return 'explicit_nonpublic_path'
    if any(path.startswith(x) for x in policy['excludedPrefixes']):
        return 'excluded_prefix'
    if any(x in policy['excludedComponents'] for x in p.parts):
        return 'runtime_or_generated_component'
    if any(x.startswith(prefix) for x in p.parts for prefix in policy['excludedComponentPrefixes']):
        return 'previous_generated_build'
    if p.suffix.lower() in policy['excludedSuffixes']:
        return 'data_model_private_or_runtime_suffix'
    if name in policy['excludedBasenames']:
        return 'machine_private_basename'
    if any(fragment in name.lower() for fragment in policy['excludedNameContains']):
        return 'real_data_fixture'
    return None

def inventory_of(app):
    paths = sorted(set(x.decode('utf8') for x in git(app, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').split(b'\0') if x))
    if len({p.casefold() for p in paths}) != len(paths):
        raise AuditError('case_colliding_local_paths')
    return paths

def checked_local_path(app, path):
    relative = safe_path(path)
    f = app.joinpath(*relative.parts)
    if not f.resolve().is_relative_to(app):
        raise AuditError('local_path_escape_or_symlink')
    for ancestor in [f, *f.parents]:
        if ancestor == app:
            break
        if ancestor.is_symlink() or (hasattr(ancestor, 'is_junction') and ancestor.is_junction()):
            raise AuditError('local_path_escape_or_symlink')
    return f

def read_bounded(path, limit):
    with path.open('rb') as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise AuditError('file_byte_bound_exceeded')
    return data

def read_blobs(repo, entries, policy):
    """Two bounded Git batch reads instead of one subprocess per source file."""
    if len(entries) > policy['maxFiles']:
        raise AuditError('reference_file_bound_exceeded')
    if not entries:
        return {}
    request = ''.join(oid + '\n' for _, oid in entries).encode('ascii')
    infos = git(repo, 'cat-file', '--batch-check', input_data=request).splitlines()
    if len(infos) != len(entries):
        raise AuditError('invalid_reference_batch')
    sizes, total = [], 0
    for info, (_, expected) in zip(infos, entries):
        parts = info.decode('ascii').split()
        if len(parts) != 3 or parts[0] != expected or parts[1] != 'blob':
            raise AuditError('invalid_reference_batch')
        size = int(parts[2])
        total += size
        if size < 0 or size > policy['maxFileBytes'] or total > policy['maxTotalBytes']:
            raise AuditError('reference_byte_bound_exceeded')
        sizes.append(size)
    payload = git(repo, 'cat-file', '--batch', input_data=request)
    result, offset = {}, 0
    for (path, oid), size in zip(entries, sizes):
        header = (oid + ' blob ' + str(size) + '\n').encode('ascii')
        if payload[offset:offset + len(header)] != header:
            raise AuditError('invalid_reference_batch')
        offset += len(header)
        data = payload[offset:offset + size]
        offset += size
        if len(data) != size or payload[offset:offset + 1] != b'\n':
            raise AuditError('invalid_reference_batch')
        offset += 1
        result[path] = (oid, data)
    if offset != len(payload):
        raise AuditError('invalid_reference_batch')
    return result

def load_policy(path):
    raw = Path(path).read_bytes()
    policy = json.loads(raw)
    if policy.get('contract') != 'aegis.public-source-policy.v1':
        raise AuditError('unsupported_policy')
    for key in ['excludedPaths', 'excludedPrefixes', 'excludedComponents',
                'excludedComponentPrefixes', 'excludedSuffixes', 'excludedBasenames', 'excludedNameContains']:
        if not isinstance(policy.get(key), list) or not all(isinstance(x, str) and x for x in policy[key]):
            raise AuditError('invalid_policy')
        if any(x != x.casefold() for x in policy[key]):
            raise AuditError('policy_paths_must_be_lowercase')
    for key in ['maxFiles', 'maxFileBytes', 'maxTotalBytes']:
        if type(policy.get(key)) is not int or policy[key] <= 0:
            raise AuditError('invalid_policy_bounds')
    examples = policy.get('reviewedSecretExamples', [])
    if not isinstance(examples, list):
        raise AuditError('invalid_reviewed_examples')
    for example in examples:
        if (not isinstance(example, dict) or example.get('rule') not in SECRET_PATTERNS
                or not re.fullmatch(r'[0-9a-f]{64}', example.get('fileSha256', ''))
                or not isinstance(example.get('path'), str)):
            raise AuditError('invalid_reviewed_examples')
        safe_path(example['path'])
    return policy, digest(raw)

def inspect_data(path, data, policy, findings, reviewed=None):
    if len(data) > policy['maxFileBytes']:
        raise AuditError('file_byte_bound_exceeded')
    for rule, pattern in SECRET_PATTERNS.items():
        if pattern.search(data):
            permitted = any(x['path'] == path and x['rule'] == rule and x['fileSha256'] == digest(data)
                            for x in policy.get('reviewedSecretExamples', []))
            if permitted:
                if reviewed is not None:
                    reviewed.append({'path': path, 'rule': rule, 'fileSha256': digest(data)})
            else:
                findings.append({'path': path, 'rule': rule})
    return 'fitted_tree_weights' if TREE_WEIGHTS.search(data) else None

def compare(app_root, reference_repo, commit, policy_path):
    app = Path(app_root).resolve(strict=True)
    repo = Path(reference_repo).resolve(strict=True)
    if not SHA.fullmatch(commit):
        raise AuditError('reference_must_be_full_commit_sha')
    policy, policy_sha = load_policy(policy_path)
    if git(repo, 'cat-file', '-t', commit).strip() != b'commit':
        raise AuditError('reference_object_must_be_commit')
    tree = git(repo, 'rev-parse', '--verify', commit + '^{tree}').decode().strip()
    if not SHA.fullmatch(tree):
        raise AuditError('invalid_reference_tree')
    entries = git(repo, 'ls-tree', '-rz', tree).split(b'\0')
    remote, excluded, findings, reviewed = {}, [], [], []
    blob_entries = []
    seen_casefold = set()
    for entry in entries:
        if not entry:
            continue
        meta, raw_path = entry.split(b'\t', 1)
        mode, kind, oid = meta.decode().split()
        path = raw_path.decode('utf8')
        safe_path(path)
        if path.casefold() in seen_casefold:
            raise AuditError('case_colliding_reference_paths')
        seen_casefold.add(path.casefold())
        if kind != 'blob' or mode not in ['100644', '100755']:
            raise AuditError('unsupported_reference_entry')
        reason = policy_reason(path, policy)
        if reason:
            findings.append({'path': path, 'rule': 'excluded_content_in_reference', 'reason': reason})
            excluded.append({'path': path, 'side': 'reference', 'reason': reason})
            continue
        if not SHA.fullmatch(oid):
            raise AuditError('invalid_reference_blob')
        blob_entries.append((path, oid))
    for path, (oid, data) in read_blobs(repo, blob_entries, policy).items():
        if inspect_data(path, data, policy, findings, reviewed):
            findings.append({'path': path, 'rule': 'fitted_weights_in_reference'})
        remote[path] = {'data': data, 'sha256': digest(data), 'bytes': len(data), 'blob': oid}
        if len(remote) > policy['maxFiles']:
            raise AuditError('reference_file_bound_exceeded')
    inventory = inventory_of(app)
    rows, local_hashes, included = [], {}, set()
    local_bytes = 0
    for path in inventory:
        safe_path(path)
        reason = policy_reason(path, policy)
        if reason:
            excluded.append({'path': path, 'side': 'local', 'reason': reason})
            continue
        f = checked_local_path(app, path)
        if not f.is_file():
            # A tracked deletion is represented by remote_missing_locally below.
            continue
        size = f.stat().st_size
        if size > policy['maxFileBytes'] or local_bytes + size > policy['maxTotalBytes']:
            raise AuditError('local_byte_bound_exceeded')
        data = read_bounded(f, min(policy['maxFileBytes'], policy['maxTotalBytes'] - local_bytes))
        local_bytes += len(data)
        reason = inspect_data(path, data, policy, findings, reviewed)
        if reason:
            excluded.append({'path': path, 'side': 'local', 'reason': reason})
            continue
        included.add(path)
        sha = digest(data)
        local_hashes[path] = sha
        row = {'path': path, 'localSha256': sha, 'localBytes': len(data)}
        if path not in remote:
            row['status'] = 'local_missing_from_reference'
        else:
            r = remote[path]
            row.update(remoteSha256=r['sha256'], remoteBytes=r['bytes'], remoteBlob=r['blob'])
            row['status'] = 'byte_equal' if data == r['data'] else 'line_endings_only' if data.replace(b'\r\n', b'\n') == r['data'].replace(b'\r\n', b'\n') else 'content_mismatch'
        rows.append(row)
        if len(rows) > policy['maxFiles']:
            raise AuditError('local_file_bound_exceeded')
    for path in sorted(set(remote) - included):
        r = remote[path]
        rows.append({'path': path, 'status': 'reference_missing_locally', 'remoteSha256': r['sha256'], 'remoteBytes': r['bytes'], 'remoteBlob': r['blob']})
    # A new private/runtime file does not change the public source contract.
    unstable = sorted(p for p in set(inventory) ^ set(inventory_of(app)) if not policy_reason(p, policy))
    for path, expected in local_hashes.items():
        f = checked_local_path(app, path)
        if not f.is_file() or digest(read_bounded(f, policy['maxFileBytes'])) != expected:
            unstable.append(path)
    # Do not traverse ignored dependencies/private data. Record this explicit boundary.
    ignored_roots = [x.decode('utf8') for x in git(app, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z').split(b'\0') if x]
    counts = dict(collections.Counter(x['status'] for x in rows))
    return {'contract': CONTRACT, 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'referenceCommit': commit, 'referenceTree': tree, 'policySha256': policy_sha,
            'byteParity': bool(rows) and not findings and not unstable and all(x['status'] == 'byte_equal' for x in rows),
            'lfCanonicalParity': bool(rows) and not findings and not unstable and all(x['status'] in ['byte_equal', 'line_endings_only'] for x in rows),
            'counts': counts, 'files': rows, 'excluded': excluded, 'secretAndPolicyFindings': findings,
            'reviewedSecretExamples': [{'path': p, 'rule': r, 'fileSha256': s}
                                      for p, r, s in sorted({(x['path'], x['rule'], x['fileSha256']) for x in reviewed})],
            'changedDuringRead': unstable, 'ignoredRootsNotTraversed': ignored_roots,
            'scope': 'Git-tracked and nonignored working files filtered by explicit policy; reference forbidden paths fail; generated/private/runtime excluded; not full-folder parity',
            'mutations': {'source': 0, 'gitRefs': 0, 'providers': 0},
            'limitations': ['Secret detection is heuristic, not a historical audit.', 'Ignored source scope and clean native regeneration require separate review.']}

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app-root', required=True)
    parser.add_argument('--reference-repo', required=True)
    parser.add_argument('--ref', required=True, help='Full immutable 40-character commit SHA, already present locally')
    parser.add_argument('--policy', default=str(Path(__file__).with_name('source-policy.json')))
    parser.add_argument('--output', required=True, help='Evidence JSON outside both source repositories')
    args = parser.parse_args(argv)
    try:
        output = Path(args.output).resolve()
        if any(output.is_relative_to(Path(p).resolve()) for p in [args.app_root, args.reference_repo]):
            raise AuditError('evidence_output_must_be_outside_source_repositories')
        result = compare(args.app_root, args.reference_repo, args.ref, args.policy)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
        print(json.dumps({k: result[k] for k in ['contract', 'referenceCommit', 'referenceTree', 'byteParity', 'lfCanonicalParity', 'counts']}, ensure_ascii=False))
        return 0 if result['byteParity'] else 1
    except (AuditError, OSError, ValueError, subprocess.SubprocessError) as error:
        code = str(error) if isinstance(error, AuditError) else 'audit_unavailable'
        print(json.dumps({'contract': CONTRACT, 'status': 'error', 'code': code}), file=sys.stderr)
        return 2

if __name__ == '__main__':
    raise SystemExit(main())
