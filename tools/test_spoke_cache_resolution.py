"""Test the spoke wrapper against the installed Comfy resolver, without starting a GPU backend."""

import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "dlbackend/comfy/ComfyUI"))
import folder_paths

ORIGINAL = folder_paths.get_full_path
SPEC = importlib.util.spec_from_file_location("swarm_spoke_cache_test", REPO / "src/BuiltinExtensions/ComfyUIBackend/ExtraNodes/SwarmComfyCommon/SwarmSpokeCache.py")
POLICY = importlib.util.module_from_spec(SPEC)
with patch.dict(os.environ, {}, clear=True):
    SPEC.loader.exec_module(POLICY)


class SpokeCacheResolutionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="swarm-resolver-")
        self.root = Path(self.temp.name)
        self.cache = self.root / "cache"
        self.share = self.root / "share"
        self.second = self.root / "second"
        for root in (self.cache, self.share, self.second):
            (root / "text_encoders").mkdir(parents=True)
        self.cached = self.cache / "text_encoders/model.safetensors"
        self.source = self.share / "text_encoders/model.safetensors"
        self.cached.write_bytes(b"old!")
        self.source.write_bytes(b"new!")
        os.utime(self.cached, ns=(1_700_000_000_000_000_000,) * 2)
        os.utime(self.source, ns=(1_700_000_001_000_000_000,) * 2)
        self.saved_paths = folder_paths.folder_names_and_paths
        folder_paths.folder_names_and_paths = {
            "text_encoders": ([str(root / "text_encoders") for root in (self.cache, self.share, self.second)], {".safetensors"})
        }
        folder_paths.get_full_path = ORIGINAL
        POLICY.install(str(self.cache))

    def tearDown(self):
        folder_paths.get_full_path = ORIGINAL
        folder_paths.folder_names_and_paths = self.saved_paths
        self.temp.cleanup()

    def resolve(self, category="clip"):
        return folder_paths.get_full_path(category, "model.safetensors")

    def test_same_size_stale_cache_reads_share_even_with_open_local_handle(self):
        with self.cached.open("rb"):
            self.assertEqual(self.resolve(), str(self.source))

    def test_valid_cache_keeps_local_precedence(self):
        self.cached.write_bytes(self.source.read_bytes())
        stamp = self.source.stat().st_mtime_ns
        os.utime(self.cached, ns=(stamp, stamp))
        self.assertEqual(self.resolve(), str(self.cached))

    def test_size_mismatch_reads_share(self):
        self.cached.write_bytes(b"short")
        stamp = self.source.stat().st_mtime_ns
        os.utime(self.cached, ns=(stamp, stamp))
        self.assertEqual(self.resolve(), str(self.source))

    def test_missing_source_does_not_serve_unverified_cache(self):
        self.source.unlink()
        self.assertIsNone(self.resolve())

    def test_multi_root_source_order_is_preserved(self):
        later = self.second / "text_encoders/model.safetensors"
        later.write_bytes(b"last")
        self.assertEqual(self.resolve(), str(self.source))
        self.source.unlink()
        self.assertEqual(self.resolve(), str(later))

    def test_inaccessible_authoritative_source_fails_closed(self):
        actual_stat = os.stat

        def guarded_stat(path, *args, **kwargs):
            if os.fspath(path) == str(self.source):
                raise PermissionError("share is offline")
            return actual_stat(path, *args, **kwargs)

        with patch.object(POLICY.os, "stat", side_effect=guarded_stat):
            self.assertIsNone(self.resolve())

    def test_cache_boundary_and_standalone_are_unchanged(self):
        self.assertFalse(POLICY.is_under(str(self.root / "cache-other/model"), str(self.cache)))
        folder_paths.get_full_path = ORIGINAL
        with patch.dict(os.environ, {}, clear=True):
            SPEC.loader.exec_module(POLICY)
        self.assertIs(folder_paths.get_full_path, ORIGINAL)
        self.assertEqual(self.resolve(), str(self.cached))


if __name__ == "__main__":
    unittest.main()
