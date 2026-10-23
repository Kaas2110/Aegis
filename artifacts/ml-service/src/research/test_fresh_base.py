import json
from pathlib import Path
import tempfile
import unittest
from .run_fresh_base import (DAY, epoch, frozen_inputs, immutable_json, select_frames, sha, source_hashes)


def row(match_id, start, group=None):
    return {'match_id': match_id, 'group': group or f'series:{match_id}', 'start': start,
            'label_available': start + 3600, 'latest_feature_outcome': start - 7200,
            'base': [0.0] * 16, 'winner': match_id % 2}


class FreshBaseTests(unittest.TestCase):
    def test_reserve_and_series_crossing_boundaries_are_excluded(self):
        train = [row(i + 1, epoch('2026-06-01') + i * 3600) for i in range(510)]
        validation = [row(i + 1000, epoch('2026-09-02') + i * 3600) for i in range(40)]
        calib = [row(i + 2000, epoch('2026-09-16') + i * 3600) for i in range(30)]
        test = [row(i + 3000, epoch('2026-09-24') + i * 3600) for i in range(60)]
        cross = [row(9001, epoch('2026-08-30'), 'cross'), row(9002, epoch('2026-09-02'), 'cross')]
        forbidden = [row(9901, epoch('2026-10-04')), row(9902, epoch('2026-10-04') - 1800)]
        splits, _ = select_frames(train + validation + calib + test + cross + forbidden, epoch('2026-10-05'))
        ids = {r['match_id'] for rows in splits.values() for r in rows}
        self.assertTrue(ids.isdisjoint({9001, 9002, 9901, 9902}))
        self.assertEqual([len(splits[key]) for key in ('train', 'validation', 'calib', 'test')], [510, 40, 30, 60])
        self.assertTrue(all(r['label_available'] < epoch('2026-10-04') for rows in splits.values() for r in rows))

    def test_frozen_artifacts_refuse_overwrite_and_detect_dataset_tampering(self):
        with tempfile.TemporaryDirectory(prefix='aegis-fresh-base-test-') as directory:
            out = Path(directory)
            for filename in ('design.json', 'feature-contract.json', 'frozen-dataset.json'):
                immutable_json(out / filename, {})
            with self.assertRaises(FileExistsError):
                immutable_json(out / 'design.json', {'changed': True})
            protocol = {'source_hashes': source_hashes(), 'design_sha256': sha(out / 'design.json'),
                'feature_contract_sha256': sha(out / 'feature-contract.json'), 'dataset_sha256': sha(out / 'frozen-dataset.json')}
            immutable_json(out / 'protocol.json', protocol)
            self.assertEqual(frozen_inputs(out)[1], {})
            (out / 'frozen-dataset.json').write_text('{"test": []}', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'frozen-dataset.json changed'):
                frozen_inputs(out)


if __name__ == '__main__':
    unittest.main()
