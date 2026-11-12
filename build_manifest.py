from pathlib import Path
import argparse
import json
import sys

# ファイル名や拡張子からカラーを自動判定するか、ファイル名にカラー名が含まれている前提にします
# 例: red.jpg, blue.png や red_sample.jpg など、ファイル名に色名が含まれている必要があります
COLORS = ["red", "blue", "yellow", "green", "black", "white"]
EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--images-dir", default="images")
    parser.add_argument("--output", default="manifest.json")
    args = parser.parse_args()

    root = Path(args.images_dir)
    if not root.is_dir():
        sys.exit(f"エラー: {root} フォルダが見つかりません。")

    manifest = []
    
    # images/ 内のカテゴリフォルダ（coat など）を自動検出
    categories = sorted(p.name for p in root.iterdir() if p.is_dir())
    if not categories:
        sys.exit(f"エラー: {root} 内にカテゴリフォルダが見つかりません。")

    for category in categories:
        category_dir = root / category
        # カテゴリ直下のフォルダ（coat_image など）を取得
        originals = sorted(p for p in category_dir.iterdir() if p.is_dir())

        for original_dir in originals:
            # フォルダ直下の画像ファイルを直接取得
            files = sorted(
                p for p in original_dir.iterdir()
                if p.is_file()
                and p.suffix.lower() in EXTS
                and "original" not in p.stem.lower()
            )

            for file_path in files:
                # ファイル名（拡張子除く）に色名が含まれているか判定する
                stem_lower = file_path.stem.lower()
                matched_color = None
                for color in COLORS:
                    if color in stem_lower:
                        matched_color = color
                        break
                
                # ファイル名から色が特定できない場合は、スキップまたはファイル名をそのまま使うなどの処理
                if not matched_color:
                    # 色がファイル名に含まれていない場合のフォールバック（必要に応じて調整）
                    continue

                image_id = f"{category}__{original_dir.name}__{matched_color}"
                manifest.append({
                    "imageId": image_id,
                    "category": category,
                    "originalId": original_dir.name,
                    "color": matched_color,
                    "path": file_path.as_posix()
                })

    if not manifest:
        sys.exit("エラー: 条件に一致する画像が見つかりませんでした。ファイル名に 'red', 'blue' などの色名が含まれているか確認してください。")

    Path(args.output).write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"作成完了: {args.output}（合計 {len(manifest)}枚の画像を登録しました）")

if __name__ == "__main__":
    main()