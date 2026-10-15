use super::*;
use pdfium_render::prelude::*;

fn fixture() -> std::path::PathBuf { std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/pdf/layout-and-ocr.pdf") }

fn annotation(page:u32,kind:&str,quad:[f32;8]) -> Annotation {
    Annotation {id:uuid::Uuid::new_v4().to_string(),page,kind:kind.into(),color:"blue".into(),text:"实际来源".into(),comment:"中文评论😀".into(),rects:vec![],pdf_rects:vec![quad_bounds(&[quad]).unwrap()],pdf_quads:vec![quad]}
}

#[test]
fn actual_pdf_annotations_render_edit_and_preserve_rotation_cropbox() {
    let root=std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let directory=root.join("tests/native-artifacts/pdf-annotations").join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&directory).unwrap();
    let path=directory.join("actual.pdf");std::fs::copy(fixture(),&path).unwrap();
    let service=DocumentService::new(directory.join("data")).unwrap();let read=service.read_binary("pdf-verification",&path).unwrap();
    let expected:serde_json::Value=serde_json::from_slice(&std::fs::read(root.join("tests/fixtures/pdf/expected.json")).unwrap()).unwrap();
    let annotations:Vec<_>=[(1,"highlight"),(4,"underline"),(5,"strike")].into_iter().map(|(page,kind)| {
        let anchor=expected["anchors"].as_array().unwrap().iter().find(|anchor|anchor["pageNumber"]==page && anchor["method"]=="native").unwrap();
        let [left,bottom,right,top]:[f32;4]=serde_json::from_value(anchor["rect"].clone()).unwrap();
        annotation(page,kind,[left,top,right,top,left,bottom,right,bottom])
    }).collect();
    let result=service.save_pdf_annotations("pdf-verification",&read.document_id,&annotations).unwrap();assert_eq!(result.result,super::super::SaveStatus::Saved);
    let bytes=std::fs::read(&path).unwrap();let document=load(&bytes).unwrap();let pages=document.get_pages();
    let original=load(&std::fs::read(fixture()).unwrap()).unwrap();
    for number in [4,5] {for key in [b"Rotate".as_slice(),b"CropBox".as_slice()] {assert_eq!(document.get_dictionary(pages[&number]).unwrap().get(key).ok(),original.get_dictionary(original.get_pages()[&number]).unwrap().get(key).ok());}}
    let references:Vec<_>=[1,4,5].into_iter().map(|number|page_annotations(&document,pages[&number]).unwrap()[0].as_reference().unwrap()).collect();
    for reference in &references {let dictionary=document.get_dictionary(*reference).unwrap();assert!(dictionary.get(b"AP").is_ok());assert_eq!(dictionary.get(b"Contents").unwrap(),&pdf_text("中文评论😀"));}
    let mut changed=annotations[0].clone();changed.comment="再次写入的实际评论".into();changed.color="red".into();
    let repeated=load(&export(&bytes,&[changed]).unwrap()).unwrap();
    let repeated_annotations=page_annotations(&repeated,repeated.get_pages()[&1]).unwrap();
    assert_eq!(repeated_annotations.len(),1);
    assert_eq!(repeated.dereference(&repeated_annotations[0]).unwrap().1.as_dict().unwrap().get(b"Contents").unwrap(),&pdf_text("再次写入的实际评论"));
    let pdfium=crate::document::pdf_runtime::pdfium(&root.join("resources/native")).unwrap();
    let parsed=pdfium.load_pdf_from_byte_slice(&bytes,None).unwrap();
    let mut rendered=Vec::new();
    for number in [1,4,5] {
        let page=parsed.pages().get(number-1).unwrap();assert_eq!(page.annotations().len(),1);
        let with=page.render_with_config(&PdfRenderConfig::new().set_target_width(800).render_annotations(true)).unwrap().as_image().unwrap().to_rgb8();
        let without=page.render_with_config(&PdfRenderConfig::new().set_target_width(800).render_annotations(false)).unwrap().as_image().unwrap().to_rgb8();
        let changed=with.pixels().zip(without.pixels()).filter(|(left,right)|left.0!=right.0).count();
        assert!(changed>80,"第{number}页批注没有实际显示：{changed}");
        with.save(directory.join(format!("page-{number}.png"))).unwrap();rendered.push(serde_json::json!({"page":number,"changedPixels":changed}));
    }
    drop(parsed);
    let result=service.edit_pdf_annotations("pdf-verification",&read.document_id,&[
        NativeEdit::Color {page:1,id:pdfjs_id(references[0]),color:"red".into()},NativeEdit::Comment {page:1,id:pdfjs_id(references[0]),comment:"修改后的评论😀".into()},NativeEdit::Delete {page:4,id:pdfjs_id(references[1])}
    ]).unwrap();assert_eq!(result.result,super::super::SaveStatus::Saved);
    let edited=load(&std::fs::read(&path).unwrap()).unwrap();let dictionary=edited.get_dictionary(references[0]).unwrap();
    assert_eq!(dictionary.get(b"C").unwrap().as_array().unwrap().iter().map(|number|number.as_float().unwrap()).collect::<Vec<_>>(),color("red").unwrap());assert_eq!(dictionary.get(b"Contents").unwrap(),&pdf_text("修改后的评论😀"));
    assert!(page_annotations(&edited,pages[&4]).unwrap().is_empty());
    let restored=service.restore_pdf_history("pdf-verification",&read.document_id,&result.operation_id,"base").unwrap();assert_eq!(restored.result,super::super::SaveStatus::Saved);
    assert_eq!(std::fs::read(&path).unwrap(),bytes);
    let restored=service.restore_pdf_history("pdf-verification",&read.document_id,&result.operation_id,"local").unwrap();assert_eq!(restored.result,super::super::SaveStatus::Saved);
    let verified_path=directory.join("verified.pdf");std::fs::copy(&path,&verified_path).unwrap();
    let external=std::fs::read(fixture()).unwrap();std::fs::write(&path,&external).unwrap();
    let conflict=service.save_pdf_annotations("pdf-verification",&read.document_id,&annotations).unwrap();assert_eq!(conflict.result,super::super::SaveStatus::Conflict);assert_eq!(std::fs::read(&path).unwrap(),external);
    let package:serde_json::Value=serde_json::from_slice(&std::fs::read(root.join("package.json")).unwrap()).unwrap();
    let evidence=root.join("docs/validation").join(package["version"].as_str().unwrap());std::fs::create_dir_all(&evidence).unwrap();
    std::fs::write(evidence.join("pdf-annotation-results.json"),serde_json::to_vec_pretty(&serde_json::json!({"path":verified_path,"conflictPath":path,"rendered":rendered,"nativeEdit":true,"conflictPreserved":true,"passed":true})).unwrap()).unwrap();
}

#[test]
fn invalid_annotation_coordinates_and_missing_sources_stop_before_saving() {
    let bytes=std::fs::read(fixture()).unwrap();let mut source=annotation(1,"highlight",[72.,710.,301.,710.,72.,699.,301.,699.]);
    source.pdf_quads[0][0]=f32::NAN;assert!(export(&bytes,&[source]).is_err());
    let source=annotation(99,"highlight",[72.,710.,301.,710.,72.,699.,301.,699.]);assert!(export(&bytes,&[source]).is_err());
    assert!(edit(&bytes,&[NativeEdit::Delete {page:1,id:"unknown".into()}]).is_err());
}
