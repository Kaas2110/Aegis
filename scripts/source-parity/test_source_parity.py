"""Offline synthetic acceptance. Creates only temporary Git repositories; never fetches."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('source_parity', HERE / 'check_source_parity.py')
parity = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(parity)
POLICY = HERE / 'source-policy.json'
FIXTURES = json.loads((HERE / 'fixtures/synthetic-cases.json').read_text(encoding='utf8'))

def run_git(root, *args, input_data=None):
    env = dict(os.environ, GIT_OPTIONAL_LOCKS='0', GIT_LFS_SKIP_SMUDGE='1', GIT_TERMINAL_PROMPT='0')
    return subprocess.run(['git', '-c', 'core.autocrlf=false', '-c', 'core.hooksPath=' + str(root / '.empty-hooks'),
                           '-c', 'commit.gpgsign=false', '-c', 'user.name=Parity Fixture',
                           '-c', 'user.email=fixture@example.invalid', '-C', str(root), *args],
                          input=input_data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          env=env, check=True, timeout=10).stdout

class SourceParityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='aegis-source-parity-fixture-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.app, self.ref = self.base / 'app', self.base / 'reference'
        for p in [self.app, self.ref]:
            p.mkdir()
            run_git(p, 'init', '-q')
        self.put_both('.gitignore', b'node_modules/\n.env\n')
        self.put_both('src/main.js', b'export const value = 1;\n')

    def put(self, root, path, content):
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)

    def put_both(self, path, content):
        for root in [self.app, self.ref]:
            self.put(root, path, content)

    def commit(self):
        run_git(self.ref, 'add', '--all')
        run_git(self.ref, 'commit', '-q', '--no-verify', '-m', 'Synthetic fixture')
        return run_git(self.ref, 'rev-parse', 'HEAD').decode().strip()

    def compare(self, commit=None, policy=POLICY):
        return parity.compare(self.app, self.ref, commit or self.commit(), policy)

    def bounded_policy(self, **overrides):
        obj = json.loads(POLICY.read_text(encoding='utf8'))
        obj.update(overrides)
        p = self.base / 'policy.json'
        p.write_text(json.dumps(obj), encoding='utf8')
        return p

    def test_synthetic_byte_and_canonical_cases(self):
        commit = self.commit()
        for case in FIXTURES['cases']:
            with self.subTest(case=case['name']):
                self.put(self.ref, 'src/main.js', case['reference'].encode())
                self.put(self.app, 'src/main.js', case['local'].encode())
                # Reference content is unchanged across these fixtures.
                result = self.compare(commit)
                row = next(r for r in result['files'] if r['path'] == 'src/main.js')
                self.assertEqual(row['status'], case['status'])
                self.assertEqual(result['byteParity'], case['byteParity'])
                self.assertEqual(result['lfCanonicalParity'], case['lfCanonicalParity'])

    def test_untracked_public_source_detected(self):
        commit = self.commit()
        self.put(self.app, 'src/new.js', b'new source\n')
        result = self.compare(commit)
        self.assertEqual(result['counts']['local_missing_from_reference'], 1)
        self.assertFalse(result['byteParity'])

    def test_local_deleted_source_detected(self):
        commit = self.commit()
        run_git(self.app, 'add', '--all')
        (self.app / 'src/main.js').unlink()
        result = self.compare(commit)
        self.assertEqual(result['counts']['reference_missing_locally'], 1)

    def test_generated_and_private_local_data_are_outside_scope(self):
        commit = self.commit()
        marker = b'-----BEGIN ' + b'PRIVATE KEY-----'
        self.put(self.app, 'node_modules/dependency/private.txt', marker)
        self.put(self.app, '.env', marker)
        self.put(self.app, 'backups/archive.dump', marker)
        result = self.compare(commit)
        self.assertTrue(result['byteParity'])
        self.assertEqual(result['secretAndPolicyFindings'], [])
        self.assertIn('.env', result['ignoredRootsNotTraversed'])
        self.assertTrue(any(r['path'] == 'backups/archive.dump' for r in result['excluded']))

    def test_private_case_variant_is_excluded(self):
        self.assertEqual(parity.policy_reason('.ENV.production', json.loads(POLICY.read_text())), 'private_environment')
        self.assertIsNotNone(parity.policy_reason('Backups/a.txt', json.loads(POLICY.read_text())))

    def test_forbidden_reference_data_fails_without_reading_content(self):
        self.put(self.ref, 'backups/archive.dump', b'private dummy data')
        result = self.compare()
        self.assertFalse(result['byteParity'])
        self.assertTrue(any(r['rule'] == 'excluded_content_in_reference' for r in result['secretAndPolicyFindings']))

    def test_fitted_weight_signature_fails_reference(self):
        self.put_both('src/model.txt', b'Tree=' + b'0\nleaf_value=0.25\n')
        result = self.compare()
        self.assertFalse(result['byteParity'])
        self.assertTrue(any(r['rule'] == 'fitted_weights_in_reference' for r in result['secretAndPolicyFindings']))

    def test_local_fitted_weight_signature_classified(self):
        commit = self.commit()
        self.put(self.app, 'src/model.txt', b'Tree=' + b'0\nleaf_value=0.25\n')
        result = self.compare(commit)
        self.assertTrue(result['byteParity'])
        self.assertTrue(any(r['reason'] == 'fitted_tree_weights' for r in result['excluded']))

    def test_secret_findings_never_emit_values(self):
        value = b'gh' + b'p_' + b'12345' * 8
        self.put_both('src/unsafe.txt', b'token=' + value)
        result = self.compare()
        self.assertFalse(result['byteParity'])
        self.assertNotIn(value.decode(), json.dumps(result))
        self.assertTrue(any(r['rule'] == 'github_token' for r in result['secretAndPolicyFindings']))

    def test_database_url_is_not_treated_as_public_safe(self):
        value = b'postgres' + b'ql://exampleuser:' + b'ExampleOnly-NotARealPassword' + b'@localhost/fixture'
        self.put_both('src/settings.txt', value)
        result = self.compare()
        self.assertFalse(result['byteParity'])
        self.assertTrue(any(r['rule'] == 'credential_url' for r in result['secretAndPolicyFindings']))
        self.assertNotIn(value.decode(), json.dumps(result))

    def test_generic_literal_secret_is_detected(self):
        value = b'api_' + b'key="' + b'EXAMPLE_ONLY_' * 3 + b'"'
        self.put_both('src/settings.txt', value)
        result = self.compare()
        self.assertFalse(result['byteParity'])
        self.assertTrue(any(r['rule'] == 'literal_secret' for r in result['secretAndPolicyFindings']))

    def test_bearer_secret_is_detected(self):
        value = b'Bearer' + b' ' + b'EXAMPLE_ONLY_' * 3
        self.put_both('src/settings.txt', value)
        result = self.compare()
        self.assertFalse(result['byteParity'])
        self.assertTrue(any(r['rule'] == 'literal_bearer' for r in result['secretAndPolicyFindings']))

    def test_query_secret_is_detected(self):
        value = b'https://example.invalid/?' + b'api_key=' + b'EXAMPLE_ONLY_' * 3
        self.put_both('src/settings.txt', value)
        result = self.compare()
        self.assertFalse(result['byteParity'])
        self.assertTrue(any(r['rule'] == 'query_api_key' for r in result['secretAndPolicyFindings']))

    def test_reviewed_example_exception_requires_exact_whole_file_hash(self):
        value = b'postgres' + b'ql://exampleuser:' + b'ExampleOnly-NotARealPassword' + b'@localhost/fixture'
        self.put_both('src/example.txt', value)
        commit = self.commit()
        policy = self.bounded_policy(reviewedSecretExamples=[{
            'path': 'src/example.txt', 'rule': 'credential_url', 'fileSha256': parity.digest(value)}])
        result = self.compare(commit, policy)
        self.assertTrue(result['byteParity'])
        self.assertEqual(len(result['reviewedSecretExamples']), 1)
        # Even a one-byte change invalidates the whole-file reviewed exception.
        self.put(self.app, 'src/example.txt', value + b'\n')
        changed = self.compare(commit, policy)
        self.assertFalse(changed['byteParity'])
        self.assertTrue(any(r['rule'] == 'credential_url' for r in changed['secretAndPolicyFindings']))

    def test_full_immutable_commit_is_required(self):
        self.commit()
        with self.assertRaisesRegex(parity.AuditError, 'reference_must_be_full_commit_sha'):
            self.compare('HEAD')

    def test_tree_sha_is_not_mislabeled_as_commit(self):
        commit = self.commit()
        tree = run_git(self.ref, 'rev-parse', commit + '^{tree}').decode().strip()
        with self.assertRaisesRegex(parity.AuditError, 'reference_object_must_be_commit'):
            self.compare(tree)

    def test_case_colliding_reference_names_are_rejected(self):
        run_git(self.ref, 'add', '--all')
        oid = run_git(self.ref, 'hash-object', '-w', '--stdin', input_data=b'other\n').decode().strip()
        run_git(self.ref, 'update-index', '--add', '--cacheinfo', '100644,' + oid + ',SRC/MAIN.JS')
        run_git(self.ref, 'commit', '-q', '--no-verify', '-m', 'Synthetic colliding names')
        commit = run_git(self.ref, 'rev-parse', 'HEAD').decode().strip()
        with self.assertRaisesRegex(parity.AuditError, 'case_colliding_reference_paths'):
            self.compare(commit)

    def test_previous_pinned_commit_not_reference_worktree(self):
        commit = self.commit()
        self.put(self.ref, 'src/main.js', b'different uncommitted text\n')
        self.assertTrue(self.compare(commit)['byteParity'])

    def test_git_replace_cannot_substitute_pinned_commit(self):
        original = self.commit()
        self.put_both('src/main.js', b'replacement source\n')
        replacement = self.commit()
        run_git(self.ref, 'replace', original, replacement)
        self.assertEqual(run_git(self.ref, 'show', original + ':src/main.js'), b'replacement source\n')
        result = self.compare(original)
        self.assertFalse(result['byteParity'])
        self.assertEqual(result['counts']['content_mismatch'], 1)

    def test_partial_clone_missing_blob_does_not_lazy_fetch(self):
        commit = self.commit()
        # Local filesystem remote only: this regression never uses the network.
        origin = self.base / 'local-origin-copy'
        shutil.copytree(self.ref, origin)
        blob = run_git(self.ref, 'rev-parse', commit + ':src/main.js').decode().strip()
        run_git(self.ref, 'config', 'extensions.partialClone', 'fixture')
        run_git(self.ref, 'config', 'remote.fixture.url', str(origin))
        run_git(self.ref, 'config', 'remote.fixture.promisor', 'true')
        run_git(self.ref, 'config', 'remote.fixture.partialCloneFilter', 'blob:none')
        object_path = self.ref / '.git/objects' / blob[:2] / blob[2:]
        object_path.rename(self.base / 'temporarily-absent-fixture-blob')
        with self.assertRaisesRegex(parity.AuditError, 'invalid_reference_batch'):
            self.compare(commit)
        self.assertFalse(object_path.exists())
        self.assertFalse((self.ref / '.git/FETCH_HEAD').exists())

    def test_output_inside_source_is_rejected(self):
        commit = self.commit()
        with contextlib.redirect_stderr(io.StringIO()) as stderr:
            code = parity.main(['--app-root', str(self.app), '--reference-repo', str(self.ref), '--ref', commit,
                                '--output', str(self.app / 'evidence.json')])
        self.assertEqual(code, 2)
        self.assertFalse((self.app / 'evidence.json').exists())
        self.assertIn('evidence_output_must_be_outside_source_repositories', stderr.getvalue())

    def test_cli_external_evidence_and_zero_exit(self):
        commit = self.commit()
        output = self.base / 'evidence.json'
        with contextlib.redirect_stdout(io.StringIO()):
            code = parity.main(['--app-root', str(self.app), '--reference-repo', str(self.ref), '--ref', commit,
                                '--output', str(output)])
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(output.read_text(encoding='utf8'))['byteParity'])

    def test_cli_mismatch_exits_one_with_evidence(self):
        commit = self.commit()
        self.put(self.app, 'src/main.js', b'changed\n')
        output = self.base / 'evidence.json'
        with contextlib.redirect_stdout(io.StringIO()):
            code = parity.main(['--app-root', str(self.app), '--reference-repo', str(self.ref), '--ref', commit,
                                '--output', str(output)])
        self.assertEqual(code, 1)
        self.assertFalse(json.loads(output.read_text(encoding='utf8'))['byteParity'])

    def test_reference_file_limit_is_enforced(self):
        with self.assertRaisesRegex(parity.AuditError, 'reference_file_bound_exceeded'):
            self.compare(policy=self.bounded_policy(maxFiles=1))

    def test_reference_byte_limit_is_enforced_before_payload(self):
        with self.assertRaisesRegex(parity.AuditError, 'reference_byte_bound_exceeded'):
            self.compare(policy=self.bounded_policy(maxFileBytes=1))

    def test_reference_total_byte_limit_is_enforced(self):
        with self.assertRaisesRegex(parity.AuditError, 'reference_byte_bound_exceeded'):
            self.compare(policy=self.bounded_policy(maxTotalBytes=1))

    def test_local_byte_limit_is_enforced(self):
        commit = self.commit()
        self.put(self.app, 'src/new.js', b'x' * 100)
        with self.assertRaisesRegex(parity.AuditError, 'local_byte_bound_exceeded'):
            self.compare(commit, self.bounded_policy(maxFileBytes=30))

    def test_reference_symlink_mode_is_rejected(self):
        blob = run_git(self.ref, 'hash-object', '-w', '--stdin', input_data=b'../outside').decode().strip()
        run_git(self.ref, 'add', '--all')
        run_git(self.ref, 'update-index', '--add', '--cacheinfo', '120000,' + blob + ',escape')
        run_git(self.ref, 'commit', '-q', '--no-verify', '-m', 'Synthetic symlink mode')
        commit = run_git(self.ref, 'rev-parse', 'HEAD').decode().strip()
        with self.assertRaisesRegex(parity.AuditError, 'unsupported_reference_entry'):
            self.compare(commit)

    def test_unsafe_paths_are_rejected(self):
        for path in ['../escape', '/absolute', 'C:/absolute', 'src\\file', 'src/new\nline',
                     'src//file', 'src/./file', 'src/file.', 'src/file ', 'src/CON.txt',
                     'src/nul', 'src/com1.py', '.']:
            with self.subTest(path=repr(path)), self.assertRaises(parity.AuditError):
                parity.safe_path(path)

    def test_inventory_changes_during_read_fail(self):
        commit = self.commit()
        original, calls = parity.inventory_of, 0
        def changed_inventory(app):
            nonlocal calls
            calls += 1
            if calls == 2:
                self.put(self.app, 'src/new.js', b'created during audit\n')
            return original(app)
        with mock.patch.object(parity, 'inventory_of', changed_inventory):
            result = self.compare(commit)
        self.assertFalse(result['byteParity'])
        self.assertIn('src/new.js', result['changedDuringRead'])

    def test_existing_source_changes_during_read_fail(self):
        commit = self.commit()
        original, calls = parity.inventory_of, 0
        def changed_inventory(app):
            nonlocal calls
            calls += 1
            if calls == 2:
                self.put(self.app, 'src/main.js', b'changed during audit\n')
            return original(app)
        with mock.patch.object(parity, 'inventory_of', changed_inventory):
            result = self.compare(commit)
        self.assertFalse(result['byteParity'])
        self.assertIn('src/main.js', result['changedDuringRead'])

if __name__ == '__main__':
    unittest.main(verbosity=2)
