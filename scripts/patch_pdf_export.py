from pathlib import Path

p = Path(
    r"C:\Users\Administrator\XiaomiMiMoProjects\.mimo-sessions\2026-09-15\一比一复刻一个阅读markdown文件的typora软件出来，要求风格简约美观、\tauri\src-tauri\src\win_api.rs"
)
t = p.read_text(encoding="utf-8")
start = t.find("/// Write sidecar annotations into the PDF")
end = t.find("fn uuid_like() -> u128 {")
if start < 0 or end < 0:
    raise SystemExit(f"markers not found start={start} end={end}")

new_fn = r'''/// Write sidecar annotations into the PDF as native /Highlight + /Text
/// (readable by WPS, Edge, Acrobat). If the original is read-only, saves
/// a sibling `<name>.annotated.pdf`.
#[tauri::command]
pub fn stuart_export_pdf_annotations(pdf_path: String, items: Value) -> Value {
    use lopdf::dictionary;
    use lopdf::{Document, Object};

    fn real(v: f64) -> Object {
        Object::Real(v as f32)
    }
    fn obj_num(o: &Object) -> Option<f64> {
        match o {
            Object::Real(x) => Some(*x as f64),
            Object::Integer(i) => Some(*i as f64),
            _ => None,
        }
    }
    fn rgb_for(id: &str) -> [f32; 3] {
        match id {
            "green" => [0.47, 0.78, 0.51],
            "blue" => [0.39, 0.67, 0.90],
            "pink" => [0.94, 0.59, 0.71],
            "orange" => [0.98, 0.71, 0.35],
            "purple" => [0.71, 0.59, 0.90],
            "gray" => [0.63, 0.63, 0.63],
            _ => [1.0, 0.91, 0.23],
        }
    }

    let src = Path::new(&pdf_path);
    if !src.is_file() {
        return json!({"error": "PDF 不存在"});
    }
    let arr = match items {
        Value::Array(a) => a,
        _ => vec![],
    };
    if arr.is_empty() {
        return json!({"error": "没有标注可写入"});
    }

    let mut doc = match Document::load(src) {
        Ok(d) => d,
        Err(e) => return json!({"error": format!("打开 PDF 失败: {e}")}),
    };
    let _ = doc.decompress();

    let pages = doc.get_pages();
    if pages.is_empty() {
        return json!({"error": "无法解析 PDF 页面"});
    }

    fn media_size(doc: &Document, page_id: (u32, u16)) -> (f64, f64) {
        if let Ok(Object::Dictionary(dict)) = doc.get_object(page_id) {
            if let Ok(Object::Array(mb)) = dict.get(b"MediaBox") {
                let nums: Vec<f64> = mb.iter().filter_map(obj_num).collect();
                if nums.len() >= 4 {
                    return ((nums[2] - nums[0]).abs(), (nums[3] - nums[1]).abs());
                }
            }
        }
        (595.0, 842.0)
    }

    let mut created = 0usize;
    for item in &arr {
        let Some(obj) = item.as_object() else { continue };
        let page_num = obj.get("page").and_then(|p| p.as_u64()).unwrap_or(1) as u32;
        let Some(&page_id) = pages.get(&page_num) else { continue };
        let (pw, ph) = media_size(&doc, page_id);
        let kind = obj.get("type").and_then(|t| t.as_str()).unwrap_or("highlight");
        let comment = obj
            .get("comment")
            .and_then(|c| c.as_str())
            .or_else(|| obj.get("text").and_then(|t| t.as_str()))
            .unwrap_or("");
        let color_id = obj.get("color").and_then(|c| c.as_str()).unwrap_or("yellow");
        let rgb = rgb_for(color_id);
        let color_arr = vec![
            Object::Real(rgb[0]),
            Object::Real(rgb[1]),
            Object::Real(rgb[2]),
        ];

        let mut new_refs: Vec<Object> = Vec::new();

        if let Some(rects) = obj.get("rects").and_then(|r| r.as_array()) {
            for r in rects {
                let Some(r) = r.as_object() else { continue };
                let x = r.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let y = r.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let w = r.get("w").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let h = r.get("h").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let x0 = x * pw;
                let x1 = (x + w) * pw;
                let y_top = ph - y * ph;
                let y_bot = ph - (y + h) * ph;
                let (rx0, rx1) = if x0 <= x1 { (x0, x1) } else { (x1, x0) };
                let (ry0, ry1) = if y_bot <= y_top {
                    (y_bot, y_top)
                } else {
                    (y_top, y_bot)
                };
                let mut dict = dictionary! {
                    "Type" => "Annot",
                    "Subtype" => "Highlight",
                    "Rect" => Object::Array(vec![real(rx0), real(ry0), real(rx1), real(ry1)]),
                    "QuadPoints" => Object::Array(vec![
                        real(x0), real(y_top),
                        real(x1), real(y_top),
                        real(x0), real(y_bot),
                        real(x1), real(y_bot),
                    ]),
                    "C" => Object::Array(color_arr.clone()),
                    "CA" => Object::Real(0.4),
                    "F" => Object::Integer(4),
                };
                if !comment.is_empty() {
                    dict.set("Contents", Object::string_literal(comment.as_bytes()));
                }
                let id = doc.add_object(Object::Dictionary(dict));
                new_refs.push(Object::Reference(id));
                created += 1;
            }
        }

        // Sticky-note comment (always attach when comment text exists)
        if !comment.is_empty() {
            let nx = obj
                .get("rects")
                .and_then(|r| r.as_array())
                .and_then(|a| a.first())
                .and_then(|r| r.as_object())
                .and_then(|o| o.get("x").and_then(|v| v.as_f64()))
                .unwrap_or(0.08);
            let ny = obj
                .get("rects")
                .and_then(|r| r.as_array())
                .and_then(|a| a.first())
                .and_then(|r| r.as_object())
                .and_then(|o| o.get("y").and_then(|v| v.as_f64()))
                .unwrap_or(0.08);
            let px = nx * pw + 2.0;
            let py = ph - ny * ph - 18.0;
            let dict = dictionary! {
                "Type" => "Annot",
                "Subtype" => "Text",
                "Rect" => Object::Array(vec![
                    real(px),
                    real(py),
                    real(px + 16.0),
                    real(py + 16.0),
                ]),
                "Contents" => Object::string_literal(comment.as_bytes()),
                "Name" => "Comment",
                "C" => Object::Array(color_arr.clone()),
                "F" => Object::Integer(4),
            };
            let id = doc.add_object(Object::Dictionary(dict));
            new_refs.push(Object::Reference(id));
            created += 1;
            let _ = kind; // comments always exported
        }

        if new_refs.is_empty() {
            continue;
        }

        // Merge page /Annots
        let mut existing: Vec<Object> = Vec::new();
        if let Ok(Object::Dictionary(page_dict)) = doc.get_object(page_id) {
            if let Ok(annots) = page_dict.get(b"Annots") {
                match annots {
                    Object::Array(a) => existing = a.clone(),
                    Object::Reference(id) => {
                        if let Ok(Object::Array(a)) = doc.get_object(*id) {
                            existing = a.clone();
                        }
                    }
                    _ => {}
                }
            }
        }
        existing.extend(new_refs);
        if let Ok(Object::Dictionary(page_dict)) = doc.get_object_mut(page_id) {
            page_dict.set("Annots", Object::Array(existing));
        }
    }

    if created == 0 {
        return json!({"error": "未能生成批注对象"});
    }

    let stem = src
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "out".into());
    let tmp = src.with_extension("stuart-annot.tmp.pdf");
    if let Err(e) = doc.save(&tmp) {
        return json!({"error": format!("保存失败: {e}")});
    }
    // Prefer overwrite original; fall back to sibling annotated file
    let final_path = match fs::rename(&tmp, src) {
        Ok(()) => src.to_path_buf(),
        Err(_) => {
            let alt = src.with_file_name(format!("{stem}.annotated.pdf"));
            match fs::rename(&tmp, &alt) {
                Ok(()) => alt,
                Err(e) => return json!({"error": format!("写入文件失败: {e}")}),
            }
        }
    };

    json!({
        "ok": true,
        "created": created,
        "path": final_path.to_string_lossy()
    })
}

'''

p.write_text(t[:start] + new_fn + t[end:], encoding="utf-8")
print("export function replaced, length", len(new_fn))
