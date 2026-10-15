import hashlib
import json
import os
from pathlib import Path

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer


workspace = Path(__file__).resolve().parent.parent
manifest = json.loads((workspace / "resources/models/manifest.json").read_text(encoding="utf-8"))
cache = Path(os.environ["LOCALAPPDATA"]) / "StuartMD/models"
texts = [
    "如何保存文档并恢复未保存的修改？",
    "文档保存和草稿恢复的使用说明",
    "天文学介绍恒星、行星和银河系",
    "Instructions for saving documents and recovering unsaved edits",
]
results = []
for model in manifest["models"]:
    directory = cache / model["key"]
    for artifact in model["artifacts"]:
        resource = directory / artifact["localPath"]
        with resource.open("rb") as stream:
            actual_hash = hashlib.file_digest(stream, "sha256").hexdigest()
        if actual_hash != artifact["sha256"]:
            raise ValueError(f"模型资源指纹不匹配：{resource}")
    tokenizer = Tokenizer.from_file(str(directory / "tokenizer.json"))
    tokenizer.enable_truncation(max_length=model["maxInputLength"])
    session = ort.InferenceSession(str(directory / "model.onnx"), providers=["CPUExecutionProvider"])
    vectors = []
    for text in texts:
        encoded = tokenizer.encode(text)
        inputs = {
            "input_ids": np.array([encoded.ids], dtype=np.int64),
            "attention_mask": np.array([encoded.attention_mask], dtype=np.int64),
            "token_type_ids": np.array([encoded.type_ids], dtype=np.int64),
        }
        actual_inputs = {value.name: inputs[value.name] for value in session.get_inputs()}
        hidden = session.run(None, actual_inputs)[0].astype(np.float32)
        if model["pooling"] == "cls":
            vector = hidden[0, 0]
        elif model["pooling"] == "mean":
            mask = inputs["attention_mask"][0].astype(np.float32)
            vector = (hidden[0] * mask[:, None]).sum(axis=0) / mask.sum()
        else:
            raise ValueError(f"模型池化方式未注册：{model['pooling']}")
        vector /= np.linalg.norm(vector)
        if vector.shape != (model["dimension"],) or not np.isfinite(vector).all():
            raise ValueError("模型输出无效")
        vectors.append(vector.tolist())
    results.append({"modelId": model["modelId"], "runtimeVersion": ort.__version__, "texts": texts, "vectors": vectors})
    print(json.dumps({"modelId": model["modelId"], "runtimeVersion": ort.__version__, "dimension": model["dimension"]}))
version = json.loads((workspace / "package.json").read_text(encoding="utf-8"))["version"]
destination = workspace / "docs/validation" / version / "model-reference.json"
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
