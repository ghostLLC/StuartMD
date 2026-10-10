use std::collections::BTreeMap;
use std::path::Path;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool,Ordering};
use pdfium_render::prelude::*;
use serde::{Deserialize,Serialize};
use super::model_registry::file_sha256;
use super::ocr;

#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct PdfAnchor { pub page_box:[f32;4],pub rotation:i32,pub rects:Vec<[f32;4]>,pub method:String,pub confidence:f32,pub source_hash:String }

#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct PdfBlock { pub text:String,pub rects:Vec<[f32;4]>,pub method:String,pub confidence:f32,pub display_box:[f32;4] }

#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct PdfPageContent { pub page_number:usize,pub page_box:[f32;4],pub rotation:i32,pub blocks:Vec<PdfBlock>,pub method:String,pub confidence:f32,pub needs_review:bool,pub ocr_outputs:Vec<String> }

#[derive(Debug,Clone,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct PdfContent { pub source_hash:String,pub total_pages:usize,pub pages:Vec<PdfPageContent> }

fn rect_array(rect:PdfRect)->[f32;4] { [rect.left().value,rect.bottom().value,rect.right().value,rect.top().value] }

fn pdfium(native:&Path)->Result<&'static Pdfium,String> {
    static PDFIUM:OnceLock<Result<Pdfium,String>>=OnceLock::new();
    let path=native.join("bin/pdfium.dll");
    if file_sha256(&path)? != "79d4676b656cfb1abcea88f9ade3b4b0826c5200382db5f4ec72a636c598c118" { return Err("PDFium资源指纹不匹配".into()); }
    PDFIUM.get_or_init(|| Pdfium::bind_to_library(&path).map(Pdfium::new).map_err(|error|format!("PDFium7881加载失败：{error}"))).as_ref().map_err(Clone::clone)
}

fn device_rect(page:&PdfPage<'_>,rect:[f32;4],config:&PdfRenderConfig)->Result<[f32;4],String> {
    let (x1,y1)=page.points_to_pixels(PdfPoints::new(rect[0]),PdfPoints::new(rect[1]),config).map_err(|error|error.to_string())?;
    let (x2,y2)=page.points_to_pixels(PdfPoints::new(rect[2]),PdfPoints::new(rect[3]),config).map_err(|error|error.to_string())?;
    Ok([x1.min(x2) as f32,y1.min(y2) as f32,x1.max(x2) as f32,y1.max(y2) as f32])
}

fn union(left:[f32;4],right:[f32;4])->[f32;4] { [left[0].min(right[0]),left[1].min(right[1]),left[2].max(right[2]),left[3].max(right[3])] }
fn intersection(left:[f32;4],right:[f32;4])->f32 { (left[2].min(right[2])-left[0].max(right[0])).max(0.)*(left[3].min(right[3])-left[1].max(right[1])).max(0.) }

struct Glyph { character:char,bounds:[f32;4],display:[f32;4],reading:[f32;4],angle:f32,baseline:f32 }

fn reading_rect(bounds:[f32;4],angle:f32)->[f32;4] {
    let (sine,cosine)=angle.sin_cos();
    let corners=[[bounds[0],bounds[1]],[bounds[0],bounds[3]],[bounds[2],bounds[1]],[bounds[2],bounds[3]]];
    let mut result=[f32::INFINITY,f32::INFINITY,f32::NEG_INFINITY,f32::NEG_INFINITY];
    for [x,y] in corners {
        let along=x*cosine+y*sine;let across=x*sine-y*cosine;
        result[0]=result[0].min(along);result[1]=result[1].min(across);result[2]=result[2].max(along);result[3]=result[3].max(across);
    }
    result
}

pub fn extract_pdf(path:&Path,native:&Path,cancel:&AtomicBool)->Result<PdfContent,String> {
    let output_root=dirs::data_local_dir().ok_or("应用数据目录不可用")?.join("StuartMD/ocr");
    extract_pdf_pages(path,native,cancel,&output_root,None)
}

pub fn extract_pdf_context(path:&Path,native:&Path,cancel:&AtomicBool,page_number:usize)->Result<PdfContent,String> {
    let output_root=dirs::data_local_dir().ok_or("应用数据目录不可用")?.join("StuartMD/ocr");
    extract_pdf_pages(path,native,cancel,&output_root,Some(page_number))
}

pub fn extract_pdf_with_output(path:&Path,native:&Path,cancel:&AtomicBool,output_root:&Path)->Result<PdfContent,String> {
    extract_pdf_pages(path,native,cancel,output_root,None)
}

pub fn verify_resources(native:&Path)->Result<(),String> {
    let manifest:serde_json::Value=serde_json::from_str(include_str!("../../../../resources/native-manifest.json")).map_err(|error|format!("Resources：{error}"))?;
    for file in manifest["files"].as_array().ok_or("Resources：原生资源清单缺少文件")? {
        let relative=file["path"].as_str().ok_or("Resources：原生资源路径无效")?;
        let expected=file["sha256"].as_str().ok_or("Resources：原生资源指纹无效")?;
        if file_sha256(&native.join(relative)).map_err(|error|format!("Resources：{error}"))?!=expected {return Err(format!("Resources：原生资源指纹不匹配：{relative}"));}
    }
    Ok(())
}

fn extract_pdf_pages(path:&Path,native:&Path,cancel:&AtomicBool,output_root:&Path,focus_page:Option<usize>)->Result<PdfContent,String> {
    verify_resources(native)?;
    let source_hash=file_sha256(path)?;
    let pdfium=pdfium(native)?;
    let document=pdfium.load_pdf_from_file(path,None).map_err(|error|format!("PDF打开失败：{error}"))?;
    let total_pages=document.pages().len() as usize;
    if focus_page.is_some_and(|number|number==0 || number>total_pages) {return Err("PDF页码超出文档范围".into());}
    let mut result=PdfContent { source_hash:source_hash.clone(),total_pages,pages:Vec::new() };
    let output_root=output_root.join(&source_hash).join(uuid::Uuid::new_v4().to_string());
    for (index,page) in document.pages().iter().enumerate() {
        if focus_page.is_some_and(|number|number.abs_diff(index+1)>1) {continue;}
        if cancel.load(Ordering::Acquire) { return Err("Cancelled".into()); }
        let config=PdfRenderConfig::new().scale_page_by_factor(300.0/72.0);
        let page_box=rect_array(page.boundaries().bounding().map_err(|error|error.to_string())?.bounds);
        let rotation=page.rotation().map_err(|error|error.to_string())?.as_degrees() as i32;
        let text=page.text().map_err(|error|error.to_string())?;
        let mut glyphs=Vec::new();
        for character in text.chars().iter() {
            let unicode=character.unicode_char().ok_or("PDF字符Unicode无效")?;
            if unicode.is_control() || unicode.is_whitespace() { continue; }
            let bounds=rect_array(character.tight_bounds().map_err(|error|error.to_string())?);
            if bounds[2]<=bounds[0] || bounds[3]<=bounds[1] { continue; }
            let display=device_rect(&page,bounds,&config)?;
            let angle=character.angle_radians().map_err(|error|error.to_string())?.rem_euclid(std::f32::consts::TAU);
            let origin=character.origin().map_err(|error|error.to_string())?;
            let baseline=origin.0.value*angle.sin()-origin.1.value*angle.cos();
            glyphs.push(Glyph {character:unicode,bounds,display,reading:reading_rect(bounds,angle),angle,baseline});
        }
        glyphs.sort_by(|left,right|left.angle.total_cmp(&right.angle).then(left.baseline.total_cmp(&right.baseline)).then(left.reading[0].total_cmp(&right.reading[0])));
        let mut lines:Vec<Vec<Glyph>>=Vec::new();
        for glyph in glyphs {
            let height=glyph.reading[3]-glyph.reading[1];
            if let Some(line)=lines.iter_mut().find(|line| { let first=&line[0]; (first.angle-glyph.angle).abs()<0.01 && (first.baseline-glyph.baseline).abs()<=height.max(first.reading[3]-first.reading[1])*0.25 }) { line.push(glyph); }
            else { lines.push(vec![glyph]); }
        }
        let mut blocks=Vec::new();
        for mut line in lines {
            line.sort_by(|left,right|left.reading[0].total_cmp(&right.reading[0]));
            let mut block:Option<PdfBlock>=None;
            let mut previous_end=None;
            for Glyph {character,bounds,display,reading,..} in line {
                let gap=previous_end.map(|end|reading[0]-end).unwrap_or(0.);
                let height=reading[3]-reading[1];
                if gap>height*2.5 { blocks.push(block.take().expect("文字段落缺失")); }
                let active=block.get_or_insert_with(||PdfBlock { text:String::new(),rects:Vec::new(),method:"native".into(),confidence:100.,display_box:display });
                if gap>height*0.2 && !active.text.is_empty() { active.text.push(' '); }
                active.text.push(character); active.rects.push(bounds); active.display_box=union(active.display_box,display);
                previous_end=Some(reading[2]);
            }
            if let Some(block)=block { blocks.push(block); }
        }
        let image_rects:Vec<[f32;4]>=page.objects().iter().filter(|object|object.as_image_object().is_some()).map(|object|object.bounds().map(|bounds|rect_array(bounds.to_rect())).map_err(|error|error.to_string())).collect::<Result<_,_>>()?;
        let mut ocr_outputs=Vec::new();
        let mut ocr_count=0;
        let mut confidence_sum=0.;
        if blocks.is_empty() || !image_rects.is_empty() {
            std::fs::create_dir_all(&output_root).map_err(|error|error.to_string())?;
            let bitmap=page.render_with_config(&config).map_err(|error|format!("PDF页面渲染失败：{error}"))?;
            let image=output_root.join(format!("page-{}.png",index+1));
            bitmap.as_image().map_err(|error|error.to_string())?.save(&image).map_err(|error|error.to_string())?;
            let output=output_root.join(format!("page-{}.tsv",index+1));
            let words=ocr::recognize(&image,native,&output,cancel)?;
            ocr_outputs=vec![output.to_string_lossy().into_owned(),output.with_extension("150.tsv").to_string_lossy().into_owned()];
            let mut ocr_lines:BTreeMap<(i32,i32,i32),PdfBlock>=BTreeMap::new();
            for word in words {
                let top_left=page.pixels_to_points(word.rect[0],word.rect[1],&config).map_err(|error|error.to_string())?;
                let bottom_right=page.pixels_to_points(word.rect[2],word.rect[3],&config).map_err(|error|error.to_string())?;
                let bounds=[top_left.0.value.min(bottom_right.0.value),top_left.1.value.min(bottom_right.1.value),top_left.0.value.max(bottom_right.0.value),top_left.1.value.max(bottom_right.1.value)];
                let display=word.rect.map(|coordinate|coordinate as f32);
                let duplicate=blocks.iter().any(|block| intersection(block.display_box,display)>((display[2]-display[0])*(display[3]-display[1]))*0.5 && block.text.replace(' ',"").contains(&word.text.replace(' ',"")));
                if duplicate { continue; }
                if !image_rects.is_empty() && !blocks.is_empty() && !image_rects.iter().any(|image| intersection(*image,bounds)>0.) { continue; }
                let line=ocr_lines.entry((word.block,word.paragraph,word.line)).or_insert_with(||PdfBlock { text:String::new(),rects:Vec::new(),method:"ocr".into(),confidence:100.,display_box:display });
                if !line.text.is_empty() { line.text.push(' '); }
                line.text.push_str(&word.text);line.rects.push(bounds);line.confidence=line.confidence.min(word.confidence);line.display_box=union(line.display_box,display);
                confidence_sum+=word.confidence;ocr_count+=1;
            }
            blocks.extend(ocr_lines.into_values());
        }
        if blocks.is_empty() { return Err(format!("PDF页面 {} 没有有效文字",index+1)); }
        let width=page.width().value*300./72.;
        let split=(width*0.4..width*0.6).contains(&(width*0.5)) && blocks.iter().all(|block| !(block.display_box[0]<width*0.5 && block.display_box[2]>width*0.5));
        blocks.sort_by(|left,right| {
            let left_column=if split && left.display_box[0]>=width*0.5 {1}else{0};
            let right_column=if split && right.display_box[0]>=width*0.5 {1}else{0};
            left_column.cmp(&right_column).then(left.display_box[1].total_cmp(&right.display_box[1])).then(left.display_box[0].total_cmp(&right.display_box[0]))
        });
        let confidence=if ocr_count>0 {confidence_sum/ocr_count as f32}else{100.};
        let method=if ocr_count>0 {if blocks.iter().any(|block|block.method=="native"){"mixed"}else{"ocr"}}else{"native"};
        let needs_review=confidence<70. || blocks.iter().any(|block|block.method=="ocr" && block.confidence<70.);
        result.pages.push(PdfPageContent {page_number:index+1,page_box,rotation,blocks,method:method.into(),confidence,needs_review,ocr_outputs});
    }
    if result.pages.is_empty() { return Err("PDF没有页面".into()); }
    if file_sha256(path)? != source_hash { return Err("PDF在解析期间发生变化".into()); }
    Ok(result)
}
