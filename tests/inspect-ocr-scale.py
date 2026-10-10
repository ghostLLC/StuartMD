import json
import subprocess
from pathlib import Path

from PIL import Image


workspace = Path(__file__).resolve().parent.parent
directories = sorted((workspace / "tests/native-artifacts/models").glob("ocr-*"), key=lambda directory: directory.stat().st_mtime, reverse=True)
source = next(directories[0].rglob("page-7.png"))
image = Image.open(source)
for scale in [0.33, 0.5, 0.75]:
    target = source.with_name(f"ocr-scale-{scale}.png")
    image.resize((round(image.width * scale), round(image.height * scale)), Image.Resampling.LANCZOS).save(target)
    for languages in ["chi_sim+chi_tra+eng", "chi_sim"]:
        result = subprocess.run([
            str(workspace / "resources/native/tesseract/tesseract.exe"), str(target), "stdout", "--tessdata-dir",
            str(workspace / "resources/native/tesseract/tessdata"), "-l", languages, "--psm", "3", "--dpi", str(round(300 * scale)),
        ], capture_output=True, text=True, encoding="utf-8", check=True, creationflags=subprocess.CREATE_NO_WINDOW)
        print(json.dumps({"scale": scale, "languages": languages, "text": result.stdout}, ensure_ascii=False))
