use super::service::{ChatMessage, ContextSelection, KnowledgeSourceRef, RequestContext};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::ops::Range;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadingAnchor {
    pub document_id: String,
    pub revision: u64,
    pub source_hash: String,
    pub utf16_offset: Option<usize>,
    pub page: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceInput {
    pub input_id: String,
    pub kind: String,
    pub selection: Option<ContextSelection>,
    pub chunk_id: Option<String>,
    pub workspace_id: Option<String>,
    pub index_generation: Option<String>,
    pub index_status: Option<String>,
    #[serde(default)]
    pub rrf_score: f32,
    #[serde(default)]
    pub partial_confirmed: bool,
    pub coverage_hash: Option<String>,
    pub memory_id: Option<String>,
    pub record_id: Option<String>,
    pub version: Option<u64>,
    pub message_id: Option<String>,
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRef {
    pub source_id: String,
    pub kind: String,
    pub title: String,
    pub excerpt: String,
    pub anchor: Value,
    pub mandatory: bool,
    pub used: bool,
    pub input_ids: Vec<String>,
    pub memory_id: Option<String>,
}

impl SourceRef {
    pub fn message(&self) -> ChatMessage {
        ChatMessage { role: "system".into(), content: format!("引用材料 {}，{}。引用此材料时使用 Markdown 链接 [来源](stuart-source:{})。\n{}", self.source_id, self.title, self.source_id, self.excerpt) }
    }
}

pub fn archived_source(request_id: &str, kind: &str, title: String, excerpt: String, anchor: Value, mandatory: bool) -> Result<SourceRef, String> {
    let identity = serde_json::to_vec(&json!({"requestId":request_id,"position":source_position(&anchor),"excerpt":excerpt})).map_err(|error| error.to_string())?;
    Ok(SourceRef {source_id: format!("s-{:x}", Sha256::digest(identity)), kind:kind.into(), title, excerpt, anchor, mandatory, used:false, input_ids:Vec::new(), memory_id:None})
}

fn source_position(anchor: &Value) -> Value {
    json!({"documentId":anchor["documentId"],"path":anchor["path"],"sourceHash":anchor["sourceHash"],"revision":anchor["revision"],"page":anchor["page"],"bounds":anchor["bounds"],"rects":anchor["rects"],"segments":anchor["segments"],"startLine":anchor["startLine"],"endLine":anchor["endLine"],"charOffset":anchor["charOffset"],"charLength":anchor["charLength"],"byteRange":anchor["byteRange"],"utf16Range":anchor["utf16Range"],"recordId":anchor["recordId"],"version":anchor["version"],"messageId":anchor["messageId"]})
}

fn source(request_id: &str, kind: &str, title: String, excerpt: String, anchor: Value, mandatory: bool) -> Result<SourceRef, String> {
    archived_source(request_id,kind,title,excerpt,anchor,mandatory)
}

pub fn normalize_scope(scope: &str) -> Result<&str, String> {
    match scope { "full" | "neighborhood" | "" => Ok("document"), "selection" | "section" | "document" | "workspace" => Ok(scope), _ => Err("上下文范围无效".into()) }
}

fn normalized_source(source: &str) -> String { source.replace("\r\n", "\n").replace('\r', "\n") }

pub fn utf16_byte_offset(source: &str, offset: usize) -> Result<usize, String> {
    let mut units = 0;
    for (byte, character) in source.char_indices() {
        if units == offset { return Ok(byte); }
        units += character.len_utf16();
        if units > offset { return Err("正文位置位于 UTF-16 字符内部".into()); }
    }
    if units == offset { Ok(source.len()) } else { Err("正文位置超出当前文档".into()) }
}

fn editor_byte_offset(source: &str, offset: usize) -> Result<usize, String> {
    let mut units=0;
    let mut previous_cr=false;
    for (byte,character) in source.char_indices() {
        if character=='\n' && previous_cr {previous_cr=false;continue;}
        if units==offset {return Ok(byte);}
        units+=character.len_utf16(); previous_cr=character=='\r';
        if units>offset {return Err("正文位置位于 UTF-16 字符内部".into());}
    }
    if units==offset {Ok(source.len())} else {Err("正文位置超出当前文档".into())}
}

pub fn markdown_section(source: &str, position: usize) -> Result<(Range<usize>, String), String> {
    if position > source.len() || !source.is_char_boundary(position) { return Err("章节位置超出当前正文".into()); }
    let headings: Vec<_> = pulldown_cmark::Parser::new_ext(source, pulldown_cmark::Options::all()).into_offset_iter().filter_map(|(event, range)| {
        if let pulldown_cmark::Event::Start(pulldown_cmark::Tag::Heading {level, ..}) = event { Some((range, level as u8)) } else { None }
    }).collect();
    let Some(index) = headings.iter().rposition(|(range, _)| range.start <= position) else {
        return Ok((0..headings.first().map(|(range, _)|range.start).unwrap_or(source.len()), "文档开头".into()));
    };
    let (heading, level) = &headings[index];
    let end = headings[index + 1..].iter().find(|(_, next_level)| next_level <= level).map(|(range, _)|range.start).unwrap_or(source.len());
    Ok((heading.start..end, source[heading.clone()].trim().to_owned()))
}

fn document_anchor(document: &crate::document::DocumentContextSnapshot) -> Value {
    json!({"documentId":document.document_id,"sourceHash":document.content_hash,"revision":document.revision,"path":document.path,"fileFingerprint":document.disk_revision.raw_byte_sha256})
}

pub fn validate_request(request: &RequestContext) -> Result<(), String> {
    let scope = normalize_scope(&request.input.scope)?;
    if request.request_id.is_empty() || request.session_id.is_empty() || request.window_id.is_empty() { return Err("上下文缺少请求、会话或窗口编号".into()); }
    if let Some(document) = &request.document {
        if document.document_id.is_empty() || document.revision != request.input.editor_revision || document.content_hash != request.input.source_hash { return Err("上下文来源版本已经失效".into()); }
    } else if scope != "workspace" { return Err("所选提问范围需要实际文档".into()); }
    if scope == "workspace" && request.input.workspace_root.is_none() { return Err("工作区提问缺少实际工作区".into()); }
    if let Some(selection) = &request.input.selection { selection_source(request, selection)?; }
    if let Some(anchor) = &request.input.reading_anchor {
        let document = request.document.as_ref().ok_or("阅读位置缺少实际文档")?;
        if anchor.document_id != document.document_id || anchor.revision != document.revision || anchor.source_hash != document.content_hash { return Err("阅读位置所属文档或版本已经失效".into()); }
    }
    Ok(())
}

pub fn selection_source(request: &RequestContext, selection: &ContextSelection) -> Result<SourceRef, String> {
    let document = request.document.as_ref().ok_or("选区缺少实际文档")?;
    if selection.document_id != document.document_id || selection.revision != document.revision || selection.kind != document.kind || selection.quote.trim().is_empty() { return Err("选区身份或版本无效".into()); }
    let mut anchor = document_anchor(document);
    if document.kind == "markdown" {
        let text = normalized_source(&document.source);
        let from = selection.from.ok_or("选区缺少实际 UTF-16 起始位置")?;
        let to = selection.to.ok_or("选区缺少实际 UTF-16 结束位置")?;
        let start = utf16_byte_offset(&text, from)?;
        let end = utf16_byte_offset(&text, to)?;
        if start > end {return Err("选区范围超出当前正文".into());}
        if text[start..end] != selection.quote {
            let mut rendered=String::new();
            for event in pulldown_cmark::Parser::new_ext(&text[start..end],pulldown_cmark::Options::all()) {
                match event {
                    pulldown_cmark::Event::Text(value) | pulldown_cmark::Event::Code(value) => rendered.push_str(&value),
                    pulldown_cmark::Event::SoftBreak | pulldown_cmark::Event::HardBreak | pulldown_cmark::Event::End(pulldown_cmark::TagEnd::Paragraph) => rendered.push('\n'),
                    _=>{},
                }
            }
            let normalized = |text:&str|text.split_whitespace().collect::<String>();
            let needle=normalized(&selection.quote);
            if needle.is_empty() || normalized(&rendered).match_indices(&needle).count()!=1 {return Err("选区文字与当前正文不一致，或来源位置无法唯一核对".into());}
            anchor["renderedQuote"]=json!(true);
        }
        anchor["utf16Range"] = json!([from,to]);
        anchor["byteRange"] = json!([editor_byte_offset(&document.source,from)?,editor_byte_offset(&document.source,to)?]);
        anchor["normalizedNewlines"] = json!(true);
    } else if document.kind == "pdf" {
        let pdf = request.pdf_source.as_ref().ok_or("PDF 选区缺少实际页面来源")?;
        if pdf.source_hash != document.content_hash || selection.file_fingerprint.as_deref() != Some(pdf.source_hash.as_str()) { return Err("PDF 选区文件指纹已经变化".into()); }
        let normalized = |text:&str|text.split_whitespace().collect::<String>();
        if selection.segments.is_empty() { return Err("PDF 选区缺少逐页实际位置".into()); }
        if selection.segments.windows(2).any(|pair|pair[0].page.checked_add(1)!=Some(pair[1].page)) { return Err("PDF 跨页选区页面必须连续且按正文顺序排列".into()); }
        let quotes=selection.segments.iter().map(|segment|segment.quote.as_str()).collect::<Vec<_>>().join("\n");
        if normalized(&quotes)!=normalized(&selection.quote) {return Err("PDF 完整选区与逐页正文不一致".into());}
        let first=&selection.segments[0];
        if selection.page.is_some_and(|page|page!=first.page) || !selection.rects.is_empty() && selection.rects!=first.rects {return Err("PDF 选区首页位置与逐页位置不一致".into());}
        let mut segments=Vec::new();
        for segment in &selection.segments {
            if segment.file_fingerprint!=pdf.source_hash {return Err(format!("PDF 第 {} 页选区文件指纹已经变化",segment.page));}
            let page=pdf.pages.iter().find(|page|page.page_number==segment.page).ok_or_else(||format!("PDF 选区缺少第 {} 页实际正文",segment.page))?;
            if page.needs_review || page.blocks.is_empty() { return Err(format!("PDF 第 {} 页缺少可靠正文",page.page_number)); }
            if segment.quote.trim().is_empty() || segment.rects.is_empty() || segment.rects.iter().any(|rect|rect.iter().any(|value|!value.is_finite()) || rect[0]>=rect[2] || rect[1]>=rect[3] || rect[0]<page.page_box[0] || rect[1]<page.page_box[1] || rect[2]>page.page_box[2] || rect[3]>page.page_box[3]) { return Err(format!("PDF 第 {} 页选区矩形缺少有效页面位置",segment.page)); }
            let overlaps=|bounds:&[f32;4]|segment.rects.iter().any(|rect|rect[0]<bounds[2] && rect[2]>bounds[0] && rect[1]<bounds[3] && rect[3]>bounds[1]);
            let mut selected=String::new();
            for block in &page.blocks {
                if block.method=="native" {
                    let characters:Vec<_>=block.text.chars().filter(|character|!character.is_whitespace()).collect();
                    if characters.len()!=block.rects.len() {return Err("PDF 原生文字与字符坐标数量不一致".into());}
                    for (character,bounds) in characters.iter().zip(&block.rects) {if overlaps(bounds) {selected.push(*character);}}
                } else {
                    let words:Vec<_>=block.text.split_whitespace().collect();
                    if words.len()!=block.rects.len() {return Err("PDF 识别文字与词语坐标数量不一致".into());}
                    for (word,bounds) in words.iter().zip(&block.rects) {if overlaps(bounds) {selected.push_str(word);}}
                }
            }
            if !normalized(&selected).contains(&normalized(&segment.quote)) || segment.rects.iter().any(|rect|!page.blocks.iter().flat_map(|block|&block.rects).any(|bounds|rect[0]<bounds[2] && rect[2]>bounds[0] && rect[1]<bounds[3] && rect[3]>bounds[1])) {return Err(format!("PDF 第 {} 页选区文字与实际坐标内正文不一致",segment.page));}
            segments.push(json!({"page":segment.page,"quote":segment.quote,"rects":segment.rects,"fileFingerprint":segment.file_fingerprint,"pageBox":page.page_box,"rotation":page.rotation}));
        }
        anchor["page"]=json!(first.page); anchor["rects"]=json!(first.rects);
        anchor["segments"]=json!(segments);
    } else { return Err("选区文档类型无效".into()); }
    source(&request.request_id, "selection", "选中内容".into(), selection.quote.clone(), anchor, true)
}

pub fn document_sources(request: &RequestContext) -> Result<Vec<SourceRef>, String> {
    let scope = normalize_scope(&request.input.scope)?;
    if scope == "workspace" { return Ok(Vec::new()); }
    let document = request.document.as_ref().ok_or("所选提问范围缺少实际文档")?;
    if scope == "selection" { return Ok(vec![selection_source(request, request.input.selection.as_ref().ok_or("选中内容范围需要有效选区")?)?]); }
    if document.kind == "markdown" {
        let mut anchor = document_anchor(document);
        let (excerpt, title) = if scope == "section" {
            let position = request.input.reading_anchor.as_ref().and_then(|anchor|anchor.utf16_offset).ok_or("当前章节缺少实际阅读位置")?;
            let (range,title) = markdown_section(&document.source,editor_byte_offset(&document.source,position)?)?;
            anchor["byteRange"]=json!([range.start,range.end]);
            (document.source[range].to_owned(),title)
        } else { (document.source.clone(),"文档完整正文".into()) };
        return Ok(vec![source(&request.request_id,scope,title,excerpt,anchor,true)?]);
    }
    if document.kind != "pdf" { return Err("文档上下文类型无效".into()); }
    let pdf = request.pdf_source.as_ref().ok_or("PDF 上下文缺少实际页面内容")?;
    if pdf.source_hash != document.content_hash { return Err("PDF 页面来源指纹不一致".into()); }
    let page_number = if scope == "section" { Some(request.input.reading_anchor.as_ref().and_then(|anchor|anchor.page).ok_or("当前页面缺少实际阅读页码")?) } else { None };
    if scope == "document" && (pdf.pages.len()!=pdf.total_pages || (1..=pdf.total_pages).any(|number|pdf.pages.iter().filter(|page|page.page_number==number).count()!=1)) { return Err("PDF 完整文档缺少实际页面正文".into()); }
    let pages: Vec<_> = pdf.pages.iter().filter(|page|page_number.is_none() || Some(page.page_number)==page_number).collect();
    if pages.is_empty() { return Err("PDF 阅读页码没有实际页面来源".into()); }
    let mut parts = Vec::new();
    for page in pages {
        if page.needs_review || page.blocks.is_empty() || page.blocks.iter().any(|block|block.text.trim().is_empty()) { return Err(format!("PDF 第 {} 页缺少可靠正文",page.page_number)); }
        let mut anchor = document_anchor(document); anchor["page"]=json!(page.page_number); anchor["pageBox"]=json!(page.page_box); anchor["rotation"]=json!(page.rotation); anchor["blocks"]=json!(page.blocks);
        parts.push(source(&request.request_id,scope,format!("PDF 第 {} 页",page.page_number),page.blocks.iter().map(|block|block.text.as_str()).collect::<Vec<_>>().join("\n"),anchor,true)?);
    }
    Ok(parts)
}

pub fn merge_sources(parts: Vec<SourceRef>) -> Result<Vec<SourceRef>, String> {
    let mut merged: Vec<SourceRef> = Vec::new();
    for part in parts {
        if let Some(existing) = merged.iter_mut().find(|item| item.source_id == part.source_id) {
            if existing.excerpt != part.excerpt || source_position(&existing.anchor) != source_position(&part.anchor) { return Err("来源编号对应的实际内容发生冲突".into()); }
            existing.mandatory |= part.mandatory;
            let mut chunks:Vec<Value> = existing.anchor.get("chunkIds").and_then(Value::as_array).cloned().unwrap_or_default();
            if let Some(ids) = part.anchor.get("chunkIds").and_then(Value::as_array) { for id in ids { if !chunks.contains(id) {chunks.push(id.clone());} } }
            if !chunks.is_empty() {existing.anchor["chunkIds"]=json!(chunks);}
            for id in part.input_ids { if !existing.input_ids.contains(&id) { existing.input_ids.push(id); } }
        } else { merged.push(part); }
    }
    Ok(merged)
}

pub fn knowledge_source(request_id: &str, root: &Path, reference: &KnowledgeSourceRef, mandatory: bool) -> Result<SourceRef, String> {
    read_knowledge_source(request_id,root,reference,mandatory,false)
}

pub fn preview_knowledge_source(request_id:&str,root:&Path,reference:&KnowledgeSourceRef)->Result<SourceRef,String> {
    read_knowledge_source(request_id,root,reference,true,true)
}

fn read_knowledge_source(request_id:&str,root:&Path,reference:&KnowledgeSourceRef,mandatory:bool,partial_preview:bool)->Result<SourceRef,String> {
    let root = crate::fs_api::ensure_dir_allowed(&root.to_string_lossy())?;
    let workspace_id = crate::rag::generation::workspace_id(&root);
    let catalog = rusqlite::Connection::open_with_flags(root.join(".stuart/index_catalog.db"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|error|error.to_string())?;
    let (generation,status,database,parser):(String,String,String,u32) = catalog.query_row("SELECT g.id,g.status,g.database_path,g.parser_version FROM current_generation c JOIN generations g ON g.id=c.generation_id WHERE c.singleton=1",[],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).map_err(|error|error.to_string())?;
    if parser != crate::rag::generation::PARSER_VERSION || !["Ready","Partial"].contains(&status.as_str()) { return Err("知识索引尚未形成有效实际来源".into()); }
    if reference.workspace_id != workspace_id || reference.index_generation != generation || reference.index_status != status { return Err("知识引用所属工作区或索引代际已经变化".into()); }
    if status=="Partial" && !partial_preview && !reference.partial_confirmed { return Err("引用部分索引前需要确认未完成的文件范围".into()); }
    let database = std::fs::canonicalize(database).map_err(|error|error.to_string())?;
    let indices = std::fs::canonicalize(root.join(".stuart/indices")).map_err(|error|error.to_string())?;
    if !database.starts_with(indices) { return Err("知识数据库位置超出当前工作区".into()); }
    let connection = rusqlite::Connection::open_with_flags(database,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|error|error.to_string())?;
    let (content,path,hash,page,bounds,start,end,char_offset,char_length,heading):(String,String,String,Option<usize>,Option<String>,Option<usize>,Option<usize>,usize,usize,String)=connection.query_row("SELECT c.content,d.rel_path,d.content_hash,c.page_number,c.bounding_box,c.start_line,c.end_line,c.char_offset,c.char_length,c.heading_path FROM rag_chunks c JOIN rag_documents d ON d.doc_id=c.doc_id WHERE c.chunk_id=?1",[&reference.chunk_id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?,row.get(8)?,row.get(9)?))).map_err(|error|error.to_string())?;
    let file = std::fs::canonicalize(root.join(&path)).map_err(|error|error.to_string())?;
    if !file.starts_with(&root) || crate::rag::model_registry::file_sha256(&file)? != hash { return Err("知识来源文件已经变化，请更新索引".into()); }
    if content.trim().is_empty() { return Err("知识片段缺少实际正文".into()); }
    let bounds:Option<Value> = bounds.map(|bounds|serde_json::from_str(&bounds).map_err(|error|error.to_string())).transpose()?;
    if let Some(page)=page {
        let pdf_anchor:crate::rag::pdf_extract::PdfAnchor=serde_json::from_value(bounds.clone().ok_or("PDF 知识片段缺少实际页面坐标")?).map_err(|error|error.to_string())?;
        if pdf_anchor.source_hash!=hash || pdf_anchor.rects.is_empty() || !pdf_anchor.confidence.is_finite() || pdf_anchor.confidence<70. || !["native","ocr"].contains(&pdf_anchor.method.as_str()) {return Err("PDF 知识片段缺少可靠页面依据".into());}
        let actual=lopdf::Document::load(&file).map_err(|error|format!("PDF 实际页面校验失败：{error}"))?;
        let page=u32::try_from(page).map_err(|error|error.to_string())?;
        if !actual.get_pages().contains_key(&page) {return Err("PDF 知识片段引用的实际页码不存在".into());}
    } else {
        let actual=std::fs::read_to_string(&file).map_err(|error|error.to_string())?;
        let excerpt:String=actual.chars().skip(char_offset).take(char_length).collect();
        if excerpt!=content {return Err("知识片段正文与实际文件位置不一致".into());}
    }
    let title=if heading.is_empty(){path.clone()}else{format!("{path} · {heading}")};
    source(request_id,"knowledge",title,content,json!({"chunkId":reference.chunk_id,"chunkIds":[reference.chunk_id],"workspaceId":workspace_id,"indexGeneration":generation,"indexStatus":status,"sourceHash":hash,"path":crate::fs_api::display_path(&file),"page":page,"bounds":bounds,"startLine":start,"endLine":end,"headingPath":heading,"charOffset":char_offset,"charLength":char_length}),mandatory)
}

pub fn prepare_sources(request: &RequestContext) -> Result<Vec<SourceRef>, String> {
    validate_request(request)?;
    let mut parts = document_sources(request)?;
    parts.extend(request.workspace_sources.iter().cloned());
    let root = request.input.workspace_root.as_deref().map(Path::new);
    for reference in &request.input.knowledge_sources { parts.push(knowledge_source(&request.request_id,root.ok_or("知识引用缺少授权工作区")?,reference,true)?); }
    for input in &request.input.explicit_sources {
        if input.input_id.trim().is_empty() { return Err("显式引用缺少输入编号".into()); }
        let mut part = match input.kind.as_str() {
            "selection" => {
                let selection=input.selection.as_ref().ok_or("显式选区引用缺少位置")?;
                if let Some(source)=request.resolved_sources.iter().find(|source|source.input_ids.contains(&input.input_id)) {
                    if source.kind!="selection" || source.excerpt!=selection.quote || source.anchor["documentId"].as_str()!=Some(&selection.document_id) || source.anchor["revision"].as_u64()!=Some(selection.revision) {return Err("显式选区引用与实际核验来源不同".into());}
                    source.clone()
                } else {selection_source(request,selection)?}
            },
            "knowledge" => knowledge_source(&request.request_id,root.ok_or("知识引用缺少授权工作区")?,&KnowledgeSourceRef {
                chunk_id:input.chunk_id.clone().ok_or("知识引用缺少 chunkId")?, workspace_id:input.workspace_id.clone().ok_or("知识引用缺少 workspaceId")?,index_generation:input.index_generation.clone().ok_or("知识引用缺少 indexGeneration")?,index_status:input.index_status.clone().ok_or("知识引用缺少 indexStatus")?,rrf_score:input.rrf_score,partial_confirmed:input.partial_confirmed},true)?,
            "memory" | "message" => {
                let part = request.resolved_sources.iter().find(|part|part.input_ids.contains(&input.input_id)).cloned().ok_or("显式记录引用缺少原生核验来源")?;
                if part.kind != input.kind {return Err("显式引用类型与实际来源不一致".into());}
                if input.kind=="memory" {
                    if input.memory_id.is_none() && input.record_id.is_none() {return Err("记忆引用缺少实际记录编号".into());}
                    if input.memory_id.as_ref().is_some_and(|id|part.anchor["memoryId"].as_str()!=Some(id)) || input.record_id.as_ref().is_some_and(|id|part.anchor["recordId"].as_str()!=Some(id)) || input.version.is_some_and(|version|part.anchor["version"].as_u64()!=Some(version)) {return Err("记忆引用的实际版本已经变化".into());}
                } else if part.anchor["messageId"].as_str()!=input.message_id.as_deref() || input.message_id.is_none() || input.request_id.as_ref().is_some_and(|id|part.anchor["requestId"].as_str()!=Some(id)) {return Err("历史消息引用与实际来源不一致".into());}
                part
            },
            _ => return Err("显式引用类型无效".into()),
        };
        part.mandatory = true; if !part.input_ids.contains(&input.input_id) {part.input_ids.push(input.input_id.clone());} parts.push(part);
    }
    if normalize_scope(&request.input.scope)? == "workspace" && parts.is_empty() { return Err("工作区检索没有可用的实际来源".into()); }
    merge_sources(parts)
}

pub fn prepare_materials(request: &RequestContext, use_memory: bool) -> Result<Vec<SourceRef>, String> {
    let mut parts = prepare_sources(request)?;
    if use_memory {
        let query = request.messages.iter().rev().find(|message|message.role=="user").ok_or("材料准备缺少实际问题")?;
        let memories = crate::memory::get_archive_storage()?.effective_target_memories(request.input.workspace_root.as_deref(),request.document_key.as_deref(),&query.content,true)?;
        for memory in memories {
            let mut part = memory_source(&request.request_id,&memory,memory.pinned || ["preference","decision"].contains(&memory.category.as_str()))?;
            part.memory_id=Some(memory.memory_id); parts.push(part);
        }
    }
    merge_sources(parts)
}

pub fn memory_source(request_id: &str, memory: &crate::memory::OrganicMemoryItem, mandatory: bool) -> Result<SourceRef, String> {
    let mut part = source(request_id,"memory",format!("适用记忆：{}",memory.category),memory.content.clone(),json!({"recordId":memory.record_id,"memoryId":memory.memory_id,"version":memory.version,"sourceHash":format!("{:x}",Sha256::digest(memory.content.as_bytes())),"scope":memory.scope,"workspaceKey":memory.workspace_id,"documentKey":memory.document_id,"approvalKind":memory.approval_kind,"sourceAnchor":memory.source_anchor,"sourceMessageId":memory.source_message_id}),mandatory)?;
    part.memory_id=Some(memory.memory_id.clone()); Ok(part)
}

pub fn preview_context(request: &RequestContext, use_memory: bool, spec: Option<&super::model_spec::ProviderModelSpec>) -> Result<Value, String> {
    let sources = prepare_materials(request,use_memory)?;
    let local_count = if let Some(spec) = spec.filter(|spec|spec.count_method=="local-tokenizer") {
        let messages:Vec<_> = sources.iter().map(SourceRef::message).chain(request.messages.iter().cloned()).collect();
        Some(super::service::count_local(spec,&messages)?)
    } else { None };
    Ok(json!({"sources":sources,"promptTokens":local_count,"countStatus":if local_count.is_some(){"LocalCounted"}else{"CountOnSend"},"scope":normalize_scope(&request.input.scope)?}))
}

pub fn verify_source_path(window: &tauri::WebviewWindow, source: &SourceRef) -> Result<std::path::PathBuf, String> {
    let path=source.anchor.get("path").and_then(Value::as_str).ok_or("来源没有实际文件路径")?;
    let file=crate::fs_api::ensure_window_read_allowed(window,path)?;
    let hash=source.anchor.get("fileFingerprint").or_else(||source.anchor.get("sourceHash")).and_then(Value::as_str).ok_or("来源没有实际文件指纹")?;
    if crate::rag::model_registry::file_sha256(&file)? != hash { return Err("来源文件已经变化，发送时摘录仍可查看".into()); }
    Ok(file)
}

pub fn validate_workspace_binding(state: &crate::rag::RagState, window_id: &str, root: &str, index_generation: Option<&str>, partial_confirmed: bool, coverage_hash: Option<&str>) -> Result<crate::rag::WorkspaceBinding, String> {
    let binding=read_workspace_binding(state,window_id,root)?;
    let generation=binding.generation.as_ref().ok_or("工作区缺少真实语义索引")?;
    if index_generation.is_some_and(|id|id!=generation.generation_id) {return Err("确认的知识索引代际已经变化".into());}
    if generation.status=="Partial" {
        let hash=format!("{:x}",Sha256::digest(generation.failures_json.as_bytes()));
        if !partial_confirmed || index_generation!=Some(generation.generation_id.as_str()) || coverage_hash!=Some(hash.as_str()) {return Err("工作区部分索引的代际或未完成文件范围需要重新确认".into());}
    }
    Ok(binding)
}

pub fn read_workspace_binding(state:&crate::rag::RagState,window_id:&str,root:&str)->Result<crate::rag::WorkspaceBinding,String> {
    let root = crate::fs_api::ensure_dir_allowed(root)?;
    if state.window_workspaces.read().map_err(|error|error.to_string())?.get(window_id) != Some(&root) { return Err("当前窗口未绑定所选知识工作区".into()); }
    let workspace_id = crate::rag::generation::workspace_id(&root);
    let binding = state.workspaces.read().map_err(|error|error.to_string())?.get(&workspace_id).cloned().ok_or("知识工作区尚未加载")?;
    if binding.status.source_changed || binding.source_revision.load(std::sync::atomic::Ordering::Acquire)!=binding.indexed_revision { return Err("工作区资料已经变化，请等待索引更新".into()); }
    let generation = binding.generation.as_ref().ok_or("工作区缺少真实语义索引")?;
    if generation.parser_version != crate::rag::generation::PARSER_VERSION || !["Ready","Partial"].contains(&generation.status.as_str()) { return Err("工作区索引尚未形成可用来源".into()); }
    Ok(binding)
}

pub async fn workspace_sources(state: &crate::rag::RagState, window_id: &str, root: &str, query: &str, request_id: &str, partial_confirmed: bool) -> Result<Vec<SourceRef>, String> {
    let root = crate::fs_api::ensure_dir_allowed(root)?;
    if state.window_workspaces.read().map_err(|error|error.to_string())?.get(window_id) != Some(&root) { return Err("当前窗口未绑定所选知识工作区".into()); }
    let workspace_id = crate::rag::generation::workspace_id(&root);
    let binding = state.workspaces.read().map_err(|error|error.to_string())?.get(&workspace_id).cloned().ok_or("知识工作区尚未加载")?;
    if binding.status.source_changed || binding.source_revision.load(std::sync::atomic::Ordering::Acquire)!=binding.indexed_revision { return Err("工作区资料已经变化，请等待索引更新".into()); }
    let generation = binding.generation.as_ref().ok_or("工作区缺少真实语义索引")?;
    if generation.parser_version != crate::rag::generation::PARSER_VERSION || !["Ready","Partial"].contains(&generation.status.as_str()) { return Err("工作区索引尚未形成可用来源".into()); }
    if generation.status == "Partial" && !partial_confirmed { return Err("工作区包含未完成资料，请确认索引覆盖范围".into()); }
    if query.trim().is_empty() { return Err("工作区检索需要实际问题".into()); }
    let storage = binding.storage.as_ref().ok_or("工作区知识数据库尚未加载")?;
    let engine = state.engine_for(&generation.model.model_id)?;
    let vector = engine.embed_query(query).await.map_err(|error|error.to_string())?;
    let database=std::fs::canonicalize(&generation.database_path).map_err(|error|error.to_string())?;
    let indices=std::fs::canonicalize(root.join(".stuart/indices")).map_err(|error|error.to_string())?;
    if !database.starts_with(indices) {return Err("知识检索数据库位置超出当前工作区".into());}
    let reader=rusqlite::Connection::open_with_flags(database,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|error|error.to_string())?;
    let vector_hits:Vec<_> = storage.search_vector_knn(&reader,&vector,50)?.into_iter().enumerate().map(|(index,hit)|(hit.chunk_id,index+1)).collect();
    let text_hits:Vec<_> = crate::rag::search_fts5_bm25(&reader,query,50).map_err(|error|error.to_string())?.into_iter().map(|(id,rank,_)|(id,rank)).collect();
    let (vector_weight,text_weight) = crate::rag::resolve_query_weights(query);
    let candidates = crate::rag::execute_rrf_fusion(&vector_hits,&text_hits,vector_weight,text_weight,20);
    let mut parts = Vec::new();
    for hit in candidates {
        let reference = KnowledgeSourceRef {chunk_id:hit.chunk_id,workspace_id:workspace_id.clone(),index_generation:generation.generation_id.clone(),index_status:generation.status.clone(),rrf_score:hit.rrf_score,partial_confirmed};
        let mut part = knowledge_source(request_id,&root,&reference,false)?;
        part.anchor["rrfScore"]=json!(hit.rrf_score);
        parts.push(part);
        if merge_sources(parts.clone())?.len() == 5 { break; }
    }
    let latest = state.workspaces.read().map_err(|error|error.to_string())?.get(&workspace_id).cloned().ok_or("知识工作区已经释放")?;
    if latest.status.source_changed || latest.source_revision.load(std::sync::atomic::Ordering::Acquire)!=latest.indexed_revision || latest.generation.as_ref().map(|item|&item.generation_id)!=Some(&generation.generation_id) { return Err("检索期间知识来源或索引代际已经变化".into()); }
    if parts.is_empty() { return Err("工作区检索没有可用结果".into()); }
    merge_sources(parts)
}
