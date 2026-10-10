use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use image::imageops::FilterType;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct OcrWord { pub text:String, pub rect:[i32;4], pub confidence:f32, pub block:i32, pub paragraph:i32, pub line:i32 }

#[derive(Deserialize)]
struct TsvWord { level:i32,block_num:i32,par_num:i32,line_num:i32,left:i32,top:i32,width:i32,height:i32,conf:f32,text:String }

pub fn recognize(image:&Path,native:&Path,output:&Path,cancel:&AtomicBool) -> Result<Vec<OcrWord>,String> {
    let original=image::open(image).map_err(|error|format!("读取OCR页面图像失败：{error}"))?;
    let reduced=image.with_extension("150.png");
    original.resize_exact(original.width().div_ceil(2),original.height().div_ceil(2),FilterType::Lanczos3).save(&reduced).map_err(|error|format!("生成OCR页面图像失败：{error}"))?;
    let mut candidates=Vec::new();
    for (source,tsv,dpi) in [(image.to_path_buf(),output.to_path_buf(),300),(reduced.clone(),output.with_extension("150.tsv"),150)] {
        let mut words=recognize_scale(&source,native,&tsv,cancel,dpi)?;
        if dpi==150 {
            let x_scale=original.width() as f64/original.width().div_ceil(2) as f64;
            let y_scale=original.height() as f64/original.height().div_ceil(2) as f64;
            for word in &mut words {word.rect=[(word.rect[0] as f64*x_scale).round() as i32,(word.rect[1] as f64*y_scale).round() as i32,(word.rect[2] as f64*x_scale).round() as i32,(word.rect[3] as f64*y_scale).round() as i32];}
        }
        let mut lines:BTreeMap<(i32,i32,i32),Vec<OcrWord>>=BTreeMap::new();
        for word in words {lines.entry((word.block,word.paragraph,word.line)).or_default().push(word);}
        for words in lines.into_values() {
            let rectangle=words.iter().map(|word|word.rect).reduce(|left,right|[left[0].min(right[0]),left[1].min(right[1]),left[2].max(right[2]),left[3].max(right[3])]).ok_or("OCR行没有词语")?;
            let length:usize=words.iter().map(|word|word.text.chars().count()).sum();
            let confidence=words.iter().map(|word|word.confidence*word.text.chars().count() as f32).sum::<f32>()/length as f32;
            candidates.push((confidence,rectangle,words));
        }
    }
    candidates.sort_by(|left,right|right.0.total_cmp(&left.0));
    let mut selected:Vec<([i32;4],Vec<OcrWord>)>=Vec::new();
    for (_,rectangle,words) in candidates {
        let duplicate=selected.iter().any(|(other,_)| {
            let area=|bounds:[i32;4]|(bounds[2]-bounds[0]) as f64*(bounds[3]-bounds[1]) as f64;
            let overlap=(rectangle[2].min(other[2])-rectangle[0].max(other[0])).max(0) as f64*(rectangle[3].min(other[3])-rectangle[1].max(other[1])).max(0) as f64;
            overlap>area(rectangle).min(area(*other))*0.5
        });
        if !duplicate {selected.push((rectangle,words));}
    }
    selected.sort_by_key(|(rectangle,_)|(rectangle[1],rectangle[0]));
    let mut result=Vec::new();
    for (index,(_,words)) in selected.into_iter().enumerate() {
        for mut word in words {word.block=index as i32+1;word.paragraph=1;word.line=1;result.push(word);}
    }
    Ok(result)
}

fn recognize_scale(image:&Path,native:&Path,output:&Path,cancel:&AtomicBool,dpi:u16) -> Result<Vec<OcrWord>,String> {
    let executable = native.join("tesseract/tesseract.exe");
    let data = native.join("tesseract/tessdata");
    for language in ["chi_sim","chi_tra","eng"] {
        if !data.join(format!("{language}.traineddata")).is_file() { return Err(format!("OCR语言资源缺失：{language}")); }
    }
    let output_file = std::fs::File::create(output).map_err(|error| error.to_string())?;
    let error_path = output.with_extension("stderr");
    let error_file = std::fs::File::create(&error_path).map_err(|error| error.to_string())?;
    let mut command = Command::new(executable);
    command.arg(image).arg("stdout").arg("--tessdata-dir").arg(data).args(["-l","chi_sim+chi_tra+eng","--dpi"]).arg(dpi.to_string()).args(["--psm","3","-c","tessedit_create_tsv=1"])
        .stdout(Stdio::from(output_file)).stderr(Stdio::from(error_file));
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    let mut child = command.spawn().map_err(|error| format!("启动OCR失败：{error}"))?;
    loop {
        if cancel.load(Ordering::Acquire) { child.kill().map_err(|error| error.to_string())?; child.wait().map_err(|error| error.to_string())?; return Err("Cancelled".into()); }
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            if !status.success() { return Err(format!("OCR失败：{}",std::fs::read_to_string(&error_path).map_err(|error| error.to_string())?)); }
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    let mut reader = csv::ReaderBuilder::new().delimiter(b'\t').quoting(false).from_path(output).map_err(|error| error.to_string())?;
    let mut words = Vec::new();
    for row in reader.deserialize::<TsvWord>() {
        let row = row.map_err(|error| format!("OCR TSV无效：{error}"))?;
        if row.level != 5 || row.text.trim().is_empty() { continue; }
        if row.width <= 0 || row.height <= 0 || !row.conf.is_finite() { return Err("OCR词语矩形或置信度无效".into()); }
        words.push(OcrWord { text:row.text,rect:[row.left,row.top,row.left+row.width,row.top+row.height],confidence:row.conf,block:row.block_num,paragraph:row.par_num,line:row.line_num });
    }
    if words.is_empty() { return Err("OCR没有识别出有效文字".into()); }
    Ok(words)
}
