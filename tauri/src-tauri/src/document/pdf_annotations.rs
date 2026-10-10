use lopdf::{content::{Content, Operation}, dictionary, Document, Object, ObjectId, Stream};
use serde::Deserialize;
use serde_json::Value;
use super::{identity, DocumentService, SavePayload, SaveRequest, SaveResult};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Annotation {
    pub id: String,
    pub page: u32,
    #[serde(rename = "type")]
    pub kind: String,
    pub color: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub comment: String,
    #[serde(default)]
    pub rects: Vec<Value>,
    pub pdf_rects: Vec<[f32; 4]>,
    pub pdf_quads: Vec<[f32; 8]>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum NativeEdit {
    Color { page: u32, id: String, color: String },
    Comment { page: u32, id: String, comment: String },
    Delete { page: u32, id: String },
}

fn error(error: impl std::fmt::Display) -> String { format!("PDF批注处理失败：{error}") }

pub fn color(id: &str) -> Result<[f32; 3], String> {
    match id {
        "yellow" => Ok([1., 0.91, 0.23]), "lime" => Ok([0.64, 0.82, 0.31]), "red" => Ok([1., 0.31, 0.35]),
        "blue" => Ok([0.39, 0.67, 0.90]), "green" => Ok([0.47, 0.78, 0.51]), "pink" => Ok([0.94, 0.59, 0.71]),
        "orange" => Ok([0.98, 0.71, 0.35]), "purple" => Ok([0.71, 0.59, 0.90]), "gray" => Ok([0.63, 0.63, 0.63]),
        _ => Err("PDF批注颜色无效".into()),
    }
}

fn numbers(values: &[f32]) -> Object { Object::Array(values.iter().copied().map(Object::Real).collect()) }
fn pdf_text(text: &str) -> Object {
    let mut bytes = vec![0xfe, 0xff];
    for unit in text.encode_utf16() { bytes.extend_from_slice(&unit.to_be_bytes()); }
    Object::string_literal(bytes)
}

fn quad_bounds(quads: &[[f32; 8]]) -> Result<[f32; 4], String> {
    if quads.is_empty() { return Err("PDF批注缺少实际选区坐标".into()); }
    let mut bounds = [f32::INFINITY, f32::INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY];
    for quad in quads {
        if quad.iter().any(|value| !value.is_finite()) { return Err("PDF批注坐标包含无效数值".into()); }
        let cross = (quad[2]-quad[0])*(quad[5]-quad[1])-(quad[3]-quad[1])*(quad[4]-quad[0]);
        if cross.abs() < 0.01 { return Err("PDF批注选区面积无效".into()); }
        for point in quad.chunks_exact(2) {
            bounds[0]=bounds[0].min(point[0]); bounds[1]=bounds[1].min(point[1]);
            bounds[2]=bounds[2].max(point[0]); bounds[3]=bounds[3].max(point[1]);
        }
    }
    Ok(bounds)
}

fn appearance(document: &mut Document, subtype: &str, quads: &[[f32; 8]], rgb: [f32; 3], bounds: [f32; 4]) -> Result<ObjectId, String> {
    let alpha = if subtype == "Highlight" { 0.4 } else { 1. };
    let graphics = document.add_object(dictionary! { "Type"=>"ExtGState", "ca"=>Object::Real(alpha), "CA"=>Object::Real(alpha), "BM"=>"Multiply" });
    let mut operations = vec![Operation::new("q", vec![]), Operation::new("gs", vec![Object::Name(b"StuartGS".to_vec())]),
        Operation::new(if subtype=="Highlight" {"rg"} else {"RG"}, rgb.into_iter().map(Object::Real).collect())];
    for quad in quads {
        let point = |index: usize| vec![Object::Real(quad[index]-bounds[0]),Object::Real(quad[index+1]-bounds[1])];
        match subtype {
            "Highlight" => {
                operations.push(Operation::new("m", point(0)));
                for index in [2, 6, 4] { operations.push(Operation::new("l", point(index))); }
                operations.push(Operation::new("h", vec![])); operations.push(Operation::new("f", vec![]));
            }
            "Underline" | "StrikeOut" | "Squiggly" => {
                let height = ((quad[4]-quad[0]).powi(2)+(quad[5]-quad[1]).powi(2)).sqrt();
                operations.push(Operation::new("w",vec![Object::Real((height*0.08).clamp(0.6,2.))]));
                let factor = if subtype=="StrikeOut" {0.5} else {0.92};
                let start = [(1.-factor)*quad[0]+factor*quad[4]-bounds[0],(1.-factor)*quad[1]+factor*quad[5]-bounds[1]];
                let end = [(1.-factor)*quad[2]+factor*quad[6]-bounds[0],(1.-factor)*quad[3]+factor*quad[7]-bounds[1]];
                operations.push(Operation::new("m",start.into_iter().map(Object::Real).collect()));
                if subtype=="Squiggly" {
                    let distance=((end[0]-start[0]).powi(2)+(end[1]-start[1]).powi(2)).sqrt();
                    let steps=(distance/2.).ceil().max(2.) as usize;
                    for step in 1..=steps {
                        let ratio=step as f32/steps as f32;
                        let amplitude=if step==steps {0.} else if step%2==0 {0.8} else {-0.8};
                        let x=start[0]+(end[0]-start[0])*ratio-(end[1]-start[1])/distance*amplitude;
                        let y=start[1]+(end[1]-start[1])*ratio+(end[0]-start[0])/distance*amplitude;
                        operations.push(Operation::new("l",vec![Object::Real(x),Object::Real(y)]));
                    }
                } else { operations.push(Operation::new("l",end.into_iter().map(Object::Real).collect())); }
                operations.push(Operation::new("S",vec![]));
            }
            _ => return Err("当前PDF批注类型不支持修改颜色".into()),
        }
    }
    operations.push(Operation::new("Q",vec![]));
    let content=Content {operations}.encode().map_err(error)?;
    Ok(document.add_object(Stream::new(dictionary! {
        "Type"=>"XObject", "Subtype"=>"Form", "FormType"=>1,
        "BBox"=>numbers(&[0.,0.,bounds[2]-bounds[0],bounds[3]-bounds[1]]),
        "Resources"=>dictionary! {"ExtGState"=>dictionary! {"StuartGS"=>Object::Reference(graphics)}}
    },content)))
}

fn page_annotations(document: &Document, page: ObjectId) -> Result<Vec<Object>, String> {
    let dictionary=document.get_dictionary(page).map_err(error)?;
    if !dictionary.has(b"Annots") {return Ok(Vec::new());}
    Ok(document.dereference(dictionary.get(b"Annots").map_err(error)?).map_err(error)?.1.as_array().map_err(error)?.clone())
}

fn load(bytes: &[u8]) -> Result<Document, String> {
    let document=Document::load_mem(bytes).map_err(error)?;
    if document.trailer.has(b"Encrypt") { return Err("加密PDF需要解密后保存批注".into()); }
    if document.get_pages().is_empty() { return Err("PDF缺少实际页面".into()); }
    Ok(document)
}

fn serialize(mut document: Document, page_count: usize) -> Result<Vec<u8>, String> {
    let mut bytes=Vec::new(); document.save_to(&mut bytes).map_err(error)?;
    if load(&bytes)?.get_pages().len()!=page_count { return Err("PDF批注保存改变了页面数量".into()); }
    Ok(bytes)
}

pub fn export(bytes: &[u8], annotations: &[Annotation]) -> Result<Vec<u8>, String> {
    if annotations.is_empty() { return Err("没有批注可以写入PDF".into()); }
    let mut document=load(bytes)?; let pages=document.get_pages();
    let mut ids=std::collections::HashSet::new();
    for annotation in annotations {
        if annotation.id.is_empty() || !ids.insert(&annotation.id) { return Err("PDF批注编号缺失或重复".into()); }
        let page=*pages.get(&annotation.page).ok_or("PDF批注页码超出文档范围")?;
        let subtype=match annotation.kind.as_str() {"highlight"=>"Highlight","underline"|"comment"=>"Underline","strike"=>"StrikeOut",_=>return Err("PDF批注类型无效".into())};
        let rgb=color(&annotation.color)?; let bounds=quad_bounds(&annotation.pdf_quads)?;
        if annotation.pdf_rects.len()!=annotation.pdf_quads.len() { return Err("PDF批注矩形与选区数量不一致".into()); }
        for (quad,rect) in annotation.pdf_quads.iter().zip(&annotation.pdf_rects) {
            let actual=quad_bounds(&[*quad])?;
            if rect.iter().zip(actual).any(|(value,actual)|!value.is_finite() || (*value-actual).abs()>0.05) {return Err("PDF批注矩形与实际选区不一致".into());}
        }
        let name=pdf_text(&annotation.id);
        for page_id in pages.values() {
            let existing=page_annotations(&document,*page_id)?;
            let mut retained=Vec::with_capacity(existing.len());
            for object in existing {
                let dictionary=document.dereference(&object).map_err(error)?.1.as_dict().map_err(error)?;
                if dictionary.get(b"NM").ok()!=Some(&name) {retained.push(object);}
            }
            document.get_dictionary_mut(*page_id).map_err(error)?.set("Annots",Object::Array(retained));
        }
        let appearance=appearance(&mut document,subtype,&annotation.pdf_quads,rgb,bounds)?;
        let flattened:Vec<_>=annotation.pdf_quads.iter().flatten().copied().collect();
        let object=document.add_object(dictionary! {
            "Type"=>"Annot", "Subtype"=>subtype, "Rect"=>numbers(&bounds), "QuadPoints"=>numbers(&flattened),
            "C"=>numbers(&rgb), "CA"=>Object::Real(if subtype=="Highlight" {0.4} else {1.}), "F"=>4,
            "P"=>Object::Reference(page), "NM"=>name, "Contents"=>pdf_text(&annotation.comment), "StuartQuote"=>pdf_text(&annotation.text),
            "AP"=>dictionary! {"N"=>Object::Reference(appearance)}
        });
        let mut existing=page_annotations(&document,page)?; existing.push(Object::Reference(object));
        document.get_dictionary_mut(page).map_err(error)?.set("Annots",Object::Array(existing));
    }
    serialize(document,pages.len())
}

fn pdfjs_id(id: ObjectId) -> String {if id.1==0 {format!("{}R",id.0)} else {format!("{}R{}",id.0,id.1)}}

pub fn edit(bytes: &[u8], edits: &[NativeEdit]) -> Result<Vec<u8>, String> {
    if edits.is_empty() { return Err("PDF原生批注修改内容为空".into()); }
    let mut document=load(bytes)?; let pages=document.get_pages();
    for edit in edits {
        let (number,id)=match edit {NativeEdit::Color {page,id,..}|NativeEdit::Comment {page,id,..}|NativeEdit::Delete {page,id}=>(*page,id)};
        let page=*pages.get(&number).ok_or("PDF原生批注页码无效")?;
        let mut annotations=page_annotations(&document,page)?;
        let index=annotations.iter().position(|object|object.as_reference().is_ok_and(|reference|pdfjs_id(reference)==*id)).ok_or("PDF原生批注来源已经变化")?;
        let reference=annotations[index].as_reference().map_err(error)?;
        match edit {
            NativeEdit::Delete {..} => { annotations.remove(index); document.get_dictionary_mut(page).map_err(error)?.set("Annots",Object::Array(annotations)); }
            NativeEdit::Comment {comment,..} => { document.get_dictionary_mut(reference).map_err(error)?.set("Contents",pdf_text(comment)); }
            NativeEdit::Color {color:color_id,..} => {
                let rgb=color(color_id)?;
                let annotation=document.get_dictionary(reference).map_err(error)?;
                let subtype=std::str::from_utf8(annotation.get(b"Subtype").map_err(error)?.as_name().map_err(error)?).map_err(error)?.to_owned();
                let values=document.dereference(annotation.get(b"QuadPoints").map_err(error)?).map_err(error)?.1.as_array().map_err(error)?;
                if values.len()%8!=0 {return Err("PDF原生批注选区坐标数量无效".into());}
                let mut quads=Vec::new();
                for group in values.chunks_exact(8) {let mut quad=[0.;8];for (index,number) in group.iter().enumerate() {quad[index]=number.as_float().map_err(error)?;}quads.push(quad);}
                let bounds=quad_bounds(&quads)?;
                let appearance=appearance(&mut document,&subtype,&quads,rgb,bounds)?;
                let annotation=document.get_dictionary_mut(reference).map_err(error)?;
                annotation.set("C",numbers(&rgb)); annotation.set("Rect",numbers(&bounds));
                annotation.set("AP",dictionary! {"N"=>Object::Reference(appearance)});
            }
        }
    }
    serialize(document,pages.len())
}

impl DocumentService {
    pub fn save_pdf_annotations(&self, owner: &str, document_id: &str, annotations: &[Annotation]) -> Result<SaveResult,String> {
        let state=self.state(owner,document_id)?;
        if state.kind!="pdf" { return Err("批注来源需要PDF文档".into()); }
        let bytes=export(&state.bytes,annotations)?;
        let result=self.save_pdf_bytes(owner,document_id,state,bytes)?;
        if result.result==super::SaveStatus::Saved {self.save_store.pin_pdf_history(document_id,&result.operation_id)?;}
        Ok(result)
    }
    pub fn edit_pdf_annotations(&self, owner: &str, document_id: &str, edits: &[NativeEdit]) -> Result<SaveResult,String> {
        let state=self.state(owner,document_id)?;
        if state.kind!="pdf" { return Err("批注来源需要PDF文档".into()); }
        let bytes=edit(&state.bytes,edits)?;
        let result=self.save_pdf_bytes(owner,document_id,state,bytes)?;
        if result.result==super::SaveStatus::Saved {self.save_store.pin_pdf_history(document_id,&result.operation_id)?;}
        Ok(result)
    }
    pub fn restore_pdf_history(&self, owner: &str, document_id: &str, operation_id: &str, version: &str) -> Result<SaveResult,String> {
        let state=self.state(owner,document_id)?;
        if state.kind!="pdf" {return Err("批注恢复需要PDF文档".into());}
        let operation=self.save_store.operations()?.into_iter().find(|operation|operation.operation_id==operation_id && operation.document_id==document_id && operation.stage=="Saved").ok_or("PDF批注保存版本已经不可用")?;
        let target=identity::canonical_target(std::path::Path::new(&operation.target_path))?;
        if state.path.as_ref()!=Some(&target) {return Err("PDF批注恢复版本所属文件不一致".into());}
        let path=match version {"base"=>operation.base_path,"local"=>operation.local_path,_=>return Err("PDF批注恢复版本无效".into())};
        let bytes=std::fs::read(path).map_err(error)?;load(&bytes)?;
        self.save_pdf_bytes(owner,document_id,state,bytes)
    }
    fn save_pdf_bytes(&self, owner: &str, document_id: &str, state: super::DocumentState, bytes: Vec<u8>) -> Result<SaveResult,String> {
        let path=state.path.ok_or("PDF文件来源路径缺失")?;
        self.save(owner,SaveRequest {operation_id:uuid::Uuid::new_v4().to_string(),document_id:document_id.into(),editor_revision:state.current_editor_revision,
            target_path:identity::display_path(&path),expected_disk_revision:state.disk_revision,
            payload:SavePayload::ValidatedBytes {validation_hash:identity::sha256(&bytes),bytes,producer:"pdf-annotations".into()}})
    }
}

#[cfg(test)]
mod tests;
