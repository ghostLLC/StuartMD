use std::path::Path;
use std::sync::atomic::AtomicBool;
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use super::config::{RagChunk, RagDocument};
use super::pdf_extract::extract_pdf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedDocument {
    pub document: RagDocument,
    pub chunks: Vec<RagChunk>,
    pub is_scanned_pdf: bool,
    pub scan_warning: Option<String>,
}

pub fn compute_sha256(content: &[u8]) -> String { format!("{:x}", Sha256::digest(content)) }

fn chunk(doc_id: &str, rel_path: &str, index: usize, heading: String, source: &str, range: std::ops::Range<usize>) -> RagChunk {
    let content = source[range.clone()].to_string();
    RagChunk { chunk_id: format!("{doc_id}_{index}"), doc_id: doc_id.into(), rel_path: rel_path.into(), chunk_index:index, heading_path:heading,
        start_line:Some(source[..range.start].bytes().filter(|value| *value == b'\n').count()+1),
        end_line:Some(source[..range.end].bytes().filter(|value| *value == b'\n').count()+1),
        page_number:None,bounding_box:None,char_offset:source[..range.start].chars().count(),char_length:content.chars().count(),token_count:0,content,embedding:None }
}

pub fn chunk_markdown(doc_id: &str, rel_path: &str, source: &str, target_size: usize, _overlap: usize) -> Vec<RagChunk> {
    let mut chunks = Vec::new();
    let mut headings: Vec<(usize,String)> = Vec::new();
    let mut heading_text: Option<(usize,String)> = None;
    let mut depth = 0usize;
    let mut start = 0usize;
    let mut pending: Option<std::ops::Range<usize>> = None;
    let mut pending_heading = String::new();
    for (event, range) in Parser::new_ext(source, Options::all()).into_offset_iter() {
        match event {
            Event::Start(tag) => {
                if depth == 0 {
                    start = range.start;
                    if matches!(tag,Tag::Heading{..}) {
                        if let Some(previous) = pending.take() { chunks.push(chunk(doc_id,rel_path,chunks.len(),pending_heading.clone(),source,previous)); }
                    }
                }
                if let Tag::Heading{level,..} = tag { heading_text = Some((level as usize,String::new())); }
                depth += 1;
            }
            Event::Text(text) | Event::Code(text) => { if let Some((_,title)) = &mut heading_text { title.push_str(&text); } }
            Event::End(tag) => {
                if matches!(tag,TagEnd::Heading(_)) {
                    let (level,title) = heading_text.take().expect("Markdown标题事件缺少开始事件");
                    while headings.last().is_some_and(|(old,_)| *old >= level) { headings.pop(); }
                    headings.push((level,title));
                }
                depth = depth.checked_sub(1).expect("Markdown事件不配对");
                if depth == 0 {
                    let heading = headings.iter().map(|(level,title)| format!("{} {title}", "#".repeat(*level))).collect::<Vec<_>>().join(" > ");
                    let new_range = start..range.end;
                    if let Some(previous) = &mut pending { previous.end = new_range.end; }
                    else { pending = Some(new_range); pending_heading = heading; }
                    if pending.as_ref().is_some_and(|span| source[span.clone()].chars().count() >= target_size.max(1)) {
                        chunks.push(chunk(doc_id,rel_path,chunks.len(),pending_heading.clone(),source,pending.take().expect("片段范围缺失")));
                    }
                }
            }
            Event::Rule if depth == 0 => {
                if let Some(previous) = &mut pending { previous.end = range.end; }
                else { pending = Some(range); }
            }
            _ => {}
        }
    }
    if let Some(previous) = pending { chunks.push(chunk(doc_id,rel_path,chunks.len(),pending_heading,source,previous)); }
    chunks
}

pub fn parse_file_to_document(rel_path:&str,path:&Path,target_size:usize,overlap:usize) -> Result<ParsedDocument,String> {
    parse_file_with_resources(rel_path,path,target_size,overlap,Path::new("resources/native"),&AtomicBool::new(false))
}

pub fn parse_file_with_resources(rel_path:&str,path:&Path,target_size:usize,overlap:usize,native:&Path,cancel:&AtomicBool) -> Result<ParsedDocument,String> {
    if target_size == 0 || overlap >= target_size { return Err("片段大小与重叠范围配置无效".into()); }
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    let content_hash = compute_sha256(&bytes);
    let doc_id = compute_sha256(rel_path.replace('\\',"/").as_bytes());
    let format = path.extension().and_then(|value| value.to_str()).ok_or("文件缺少扩展名")?.to_lowercase();
    let mut warning = None;
    let mut scanned = false;
    let chunks = if format == "pdf" {
        let extracted = extract_pdf(path,native,cancel)?;
        scanned = extracted.pages.iter().any(|page| page.method != "native");
        let mut chunks = Vec::new();
        for page in extracted.pages {
            if page.needs_review { warning = Some(format!("OCR 页面需要检查，页面编号 {}，平均置信度 {:.1}",page.page_number,page.confidence)); }
            for block in page.blocks {
                let index = chunks.len();
                chunks.push(RagChunk { chunk_id:format!("{doc_id}_p{}_{}",page.page_number,index),doc_id:doc_id.clone(),rel_path:rel_path.into(),chunk_index:index,heading_path:format!("页面 {}",page.page_number),start_line:None,end_line:None,page_number:Some(page.page_number),
                    bounding_box:Some(serde_json::to_string(&super::pdf_extract::PdfAnchor { page_box:page.page_box,rotation:page.rotation,rects:block.rects.clone(),method:block.method.clone(),confidence:block.confidence,source_hash:content_hash.clone() }).map_err(|error| error.to_string())?),
                    char_offset:0,char_length:block.text.chars().count(),token_count:0,content:block.text,embedding:None });
            }
        }
        chunks
    } else {
        let content = String::from_utf8(bytes.clone()).map_err(|error| format!("知识资料需要有效UTF-8编码：{error}"))?;
        if format == "md" || format == "markdown" { chunk_markdown(&doc_id,rel_path,&content,target_size,overlap) }
        else {
            let mut chunks = Vec::new();
            let mut start = 0;
            let boundaries: Vec<usize> = content.char_indices().map(|(position,_)| position).chain(std::iter::once(content.len())).collect();
            for end in boundaries.iter().skip(target_size).step_by(target_size).copied().chain(std::iter::once(content.len())) {
                if end > start { chunks.push(chunk(&doc_id,rel_path,chunks.len(),"正文".into(),&content,start..end)); start=end; }
            }
            chunks
        }
    };
    let file_mtime = metadata.modified().map_err(|error| error.to_string())?.duration_since(std::time::UNIX_EPOCH).map_err(|error| error.to_string())?.as_millis() as i64;
    let indexed_at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|error| error.to_string())?.as_millis() as i64;
    Ok(ParsedDocument { document:RagDocument { doc_id,rel_path:rel_path.into(),file_format:format,content_hash,file_size:metadata.len(),file_mtime,indexed_at },chunks,is_scanned_pdf:scanned,scan_warning:warning })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn content_fingerprint_is_sha256() { assert_eq!(compute_sha256(b"abc"),"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"); }
    #[test]
    fn markdown_parser_preserves_fences_and_heading_sources() {
        let source = "# Architecture\r\n\r\nIntroduction\r\n\r\n```rust\r\nfn calculate_hash() -> u64 {\r\n 42\r\n}\r\n```\r\n\r\n## Details\r\nDetails text contains the source.\r\n";
        let chunks = chunk_markdown("document","document.md",source,40,10);
        let code = chunks.iter().find(|part| part.content.contains("calculate_hash")).unwrap();
        assert!(code.content.contains("```rust\r\n")); assert!(code.content.contains("}\r\n```"));
        let detail = chunks.iter().find(|part| part.content.contains("Details text")).unwrap();
        assert!(detail.heading_path.contains("Details"));
        for part in chunks { assert!(source.contains(&part.content)); }
    }
}
