"""Exercise the spoke LoRA nodes with installed ComfyUI code and mocked model I/O."""

import ast
import importlib.util
from pathlib import Path
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import Mock, call, patch


REPO = Path(__file__).resolve().parents[1]
COMFY = REPO / "dlbackend/comfy/ComfyUI"
BACKEND = REPO / "src/BuiltinExtensions/ComfyUIBackend"
SWARM_NODES = BACKEND / "ExtraNodes/SwarmComfyCommon"
LORA_NAME = "example/adapter.safetensors"


def load_definitions(path, namespace, *names):
    """Load selected definitions without importing ComfyUI or its GPU dependencies."""
    source = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    source.body = [node for node in source.body if getattr(node, "name", None) in names]
    source.body.insert(0, ast.parse("from __future__ import annotations").body[0])
    ast.fix_missing_locations(source)
    exec(compile(source, str(path), "exec"), namespace)


class SpokeLoraLoaderTests(unittest.TestCase):
    def setUp(self):
        self.folder_paths = SimpleNamespace(
            get_filename_list=Mock(side_effect=AssertionError("LoRA folder enumeration")),
            get_full_path_or_raise=Mock(return_value="cache/example/adapter.safetensors"),
        )
        self.weights = object()
        self.metadata = {"example": "metadata"}
        self.outputs = (object(), object())
        self.load_file = Mock(return_value=(self.weights, self.metadata))
        self.apply_lora = Mock(return_value=self.outputs)
        comfy = SimpleNamespace(
            utils=SimpleNamespace(load_torch_file=self.load_file),
            sd=SimpleNamespace(load_lora_for_models=self.apply_lora),
        )
        self.stock = ModuleType("nodes")
        self.stock.folder_paths = self.folder_paths
        self.stock.comfy = comfy
        load_definitions(COMFY / "nodes.py", vars(self.stock), "LoraLoader", "LoraLoaderModelOnly")
        spec = importlib.util.spec_from_file_location("swarm_spoke_lora_test", SWARM_NODES / "SwarmSpokeLoraLoader.py")
        module = importlib.util.module_from_spec(spec)
        with patch.dict("sys.modules", {"nodes": self.stock}):
            spec.loader.exec_module(module)
        self.nodes = module.NODE_CLASS_MAPPINGS

    def test_lookup_and_execution_bookkeeping_do_not_enumerate(self):
        namespace = {"_ComfyNodeInternal": type("_ComfyNodeInternal", (), {})}
        load_definitions(COMFY / "comfy_execution/graph.py", namespace, "get_input_info")
        load_definitions(COMFY / "comfy_execution/graph_utils.py", namespace, "is_link")
        load_definitions(COMFY / "execution.py", namespace, "get_input_data")
        get_input_data = namespace["get_input_data"]

        for stock_name in ("LoraLoader", "LoraLoaderModelOnly"):
            with self.subTest(stock_name=stock_name):
                spoke = self.nodes[f"SwarmSpoke{stock_name}"]
                stock = getattr(self.stock, stock_name)
                # The same bookkeeping call demonstrates the original enumeration.
                with self.assertRaisesRegex(AssertionError, "LoRA folder enumeration"):
                    get_input_data({"lora_name": LORA_NAME}, stock, "1")
                self.folder_paths.get_filename_list.reset_mock()
                required = spoke.INPUT_TYPES()["required"]
                self.assertEqual(required["lora_name"][0], "STRING")
                with patch.object(self.folder_paths, "get_filename_list", return_value=[LORA_NAME]):
                    stock_required = stock.INPUT_TYPES()["required"]
                self.assertEqual(set(required), set(stock_required))
                for name in required.keys() - {"lora_name"}:
                    self.assertEqual(required[name], stock_required[name])
                inputs, missing, _ = get_input_data({"lora_name": LORA_NAME}, spoke, "1")
                self.assertEqual(inputs, {"lora_name": [LORA_NAME]})
                self.assertEqual(missing, {})
                self.assertEqual(spoke.RETURN_TYPES, stock.RETURN_TYPES)
                self.assertEqual(spoke.FUNCTION, stock.FUNCTION)
                self.folder_paths.get_filename_list.assert_not_called()
                self.folder_paths.get_full_path_or_raise.assert_not_called()

    def test_model_and_clip_use_stock_weights_metadata_and_cache(self):
        loader = self.nodes["SwarmSpokeLoraLoader"]()
        model, clip = object(), object()
        local_path = self.folder_paths.get_full_path_or_raise.return_value
        share_path = "share/example/adapter.safetensors"
        # A cache freshness check can change the resolved path for the same name.
        self.folder_paths.get_full_path_or_raise.side_effect = [local_path, local_path, share_path]
        self.assertEqual(loader.load_lora(model, clip, LORA_NAME, -0.5, 0.75), self.outputs)
        self.assertEqual(loader.load_lora(model, clip, LORA_NAME, 0.0, 0.25), self.outputs)
        self.assertEqual(loader.load_lora(model, clip, LORA_NAME, 0.8, 0.0), self.outputs)
        self.assertEqual(self.folder_paths.get_full_path_or_raise.call_args_list, [call("loras", LORA_NAME)] * 3)
        self.assertEqual(self.load_file.call_args_list, [
            call(local_path, safe_load=True, return_metadata=True),
            call(share_path, safe_load=True, return_metadata=True),
        ])
        self.assertEqual(self.apply_lora.call_args_list, [
            call(model, clip, self.weights, -0.5, 0.75, lora_metadata=self.metadata),
            call(model, clip, self.weights, 0.0, 0.25, lora_metadata=self.metadata),
            call(model, clip, self.weights, 0.8, 0.0, lora_metadata=self.metadata),
        ])
        self.folder_paths.get_filename_list.assert_not_called()

    def test_model_only_passes_no_clip(self):
        loader = self.nodes["SwarmSpokeLoraLoaderModelOnly"]()
        model = object()
        self.assertEqual(loader.load_lora_model_only(model, LORA_NAME, 0.4), (self.outputs[0],))
        self.apply_lora.assert_called_once_with(model, None, self.weights, 0.4, 0, lora_metadata=self.metadata)

    def test_zero_strength_skips_resolution_and_file_load(self):
        model, clip = object(), object()
        loader = self.nodes["SwarmSpokeLoraLoader"]()
        model_only_loader = self.nodes["SwarmSpokeLoraLoaderModelOnly"]()
        self.assertEqual(loader.load_lora(model, clip, LORA_NAME, 0, 0), (model, clip))
        self.assertEqual(model_only_loader.load_lora_model_only(model, LORA_NAME, 0), (model,))
        self.folder_paths.get_full_path_or_raise.assert_not_called()
        self.load_file.assert_not_called()
        self.apply_lora.assert_not_called()

    def test_missing_file_raises_at_load(self):
        self.folder_paths.get_full_path_or_raise.side_effect = FileNotFoundError(LORA_NAME)
        for name, inputs in (
            ("SwarmSpokeLoraLoader", (object(), object(), LORA_NAME, 1.0, 1.0)),
            ("SwarmSpokeLoraLoaderModelOnly", (object(), LORA_NAME, 1.0)),
        ):
            with self.subTest(name=name):
                loader = self.nodes[name]()
                with self.assertRaisesRegex(FileNotFoundError, "adapter"):
                    getattr(loader, loader.FUNCTION)(*inputs)
        self.load_file.assert_not_called()
        self.apply_lora.assert_not_called()


if __name__ == "__main__":
    unittest.main()
