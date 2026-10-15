use super::*;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool,Ordering};
use serde_json::{json,Value};

fn workspace() -> PathBuf { PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..") }
fn evidence(name:&str)->PathBuf {let directory=workspace().join(format!("docs/validation/{}",env!("CARGO_PKG_VERSION")));std::fs::create_dir_all(&directory).unwrap();directory.join(name)}
fn output(name:&str) -> PathBuf {
    let directory=workspace().join("tests/native-artifacts/models").join(format!("{name}-{}",uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory).unwrap();directory
}
fn cosine(left:&[f32],right:&[f32])->f32 {left.iter().zip(right).map(|(left,right)|left*right).sum()}

#[tokio::test]
#[ignore = "使用真实 ONNX 模型，由 Models 验收命令执行"]
async fn actual_models_produce_normalized_multilingual_semantic_vectors() {
    let reference:Value=serde_json::from_slice(&std::fs::read(evidence("model-reference.json")).expect("需要先执行独立ONNX Runtime参考计算")).unwrap();
    let texts=vec!["如何保存文档并恢复未保存的修改？".to_owned(),"文档保存和草稿恢复的使用说明".to_owned(),"天文学介绍恒星、行星和银河系".to_owned(),"Instructions for saving documents and recovering unsaved edits".to_owned()];
    let mut evidence=Vec::new();
    for model in ["BAAI/bge-m3","sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"] {
        let engine=LocalEmbeddingEngine::for_model(model).unwrap();
        let spec=engine.validated_spec().await.unwrap();
        let vectors=engine.embed_batch(&texts).await.unwrap();
        assert_eq!(vectors.len(),texts.len());
        for vector in &vectors {embedding::validate_vector(vector,spec.dimension).unwrap();}
        let expected=reference.as_array().unwrap().iter().find(|entry|entry["modelId"]==model).unwrap();
        assert_eq!(expected["runtimeVersion"],"1.20.1");
        assert_eq!(expected["texts"],json!(texts));
        let reference_cosines:Vec<f32>=vectors.iter().zip(expected["vectors"].as_array().unwrap()).map(|(actual,reference)| {
            let reference:Vec<f32>=reference.as_array().unwrap().iter().map(|value|value.as_f64().unwrap() as f32).collect();
            assert_eq!(reference.len(),actual.len());
            let similarity=cosine(actual,&reference);assert!(similarity>=0.995,"{model}: 参考输出余弦相似度={similarity}");similarity
        }).collect();
        let related=cosine(&vectors[0],&vectors[1]);let unrelated=cosine(&vectors[0],&vectors[2]);let translated=cosine(&vectors[0],&vectors[3]);
        assert!(related>unrelated,"{model}: {related} <= {unrelated}");
        assert!(translated>unrelated,"{model}: {translated} <= {unrelated}");
        evidence.push(json!({"model":spec,"referenceCosines":reference_cosines,"relatedCosine":related,"unrelatedCosine":unrelated,"translatedCosine":translated,"vectors":vectors}));
        engine.unload().await;
    }
    std::fs::write(self::evidence("actual-models.json"),serde_json::to_vec_pretty(&evidence).unwrap()).unwrap();
}

fn normalized(text:&str)->String {text.chars().filter(|character|!character.is_whitespace()).collect::<String>().to_lowercase()}
fn union(rectangles:&[[f32;4]])->[f32;4] {
    rectangles.iter().copied().reduce(|left,right|[left[0].min(right[0]),left[1].min(right[1]),left[2].max(right[2]),left[3].max(right[3])]).unwrap()
}
fn iou(left:[f32;4],right:[f32;4])->f32 {
    let intersection=(left[2].min(right[2])-left[0].max(right[0])).max(0.)*(left[3].min(right[3])-left[1].max(right[1])).max(0.);
    let area=|rectangle:[f32;4]|(rectangle[2]-rectangle[0])*(rectangle[3]-rectangle[1]);
    intersection/(area(left)+area(right)-intersection)
}

#[test]
#[ignore = "使用真实 PDFium、Tesseract 和实际 PDF 文件，由 Models 验收命令执行"]
fn actual_pdf_native_ocr_rotation_cropbox_and_sources() {
    let fixtures=workspace().join("tests/fixtures/pdf");let native=workspace().join("resources/native");
    let expected:Value=serde_json::from_slice(&std::fs::read(fixtures.join("expected.json")).unwrap()).unwrap();
    let data=pdf_extract::extract_pdf_with_output(&fixtures.join("layout-and-ocr.pdf"),&native,&AtomicBool::new(false),&output("ocr")).unwrap();
    assert_eq!(data.total_pages,expected["pageCount"].as_u64().unwrap() as usize);
    assert_eq!(data.source_hash,model_registry::file_sha256(&fixtures.join("layout-and-ocr.pdf")).unwrap());
    let mut measurements=Vec::new();
    for anchor in expected["anchors"].as_array().unwrap() {
        let number=anchor["pageNumber"].as_u64().unwrap() as usize;
        let page=data.pages.iter().find(|page|page.page_number==number).unwrap();
        let text=anchor["text"].as_str().unwrap();let method=anchor["method"].as_str().unwrap();
        let actual=page.blocks.iter().find(|block|normalized(&block.text).contains(&normalized(text)) && block.method==method).unwrap_or_else(||panic!("第{number}页没有实际来源：{text}。解析结果：{:?}",page.blocks));
        assert!(!actual.rects.is_empty());
        assert!(actual.rects.iter().all(|rectangle|rectangle.iter().all(|value|value.is_finite()) && rectangle[0]<rectangle[2] && rectangle[1]<rectangle[3]));
        let bounds=union(&actual.rects);
        if let Some(rectangle)=anchor["rect"].as_array() {
            let reference:[f32;4]=std::array::from_fn(|index|rectangle[index].as_f64().unwrap() as f32);
            let overlap=iou(bounds,reference);assert!(overlap>=expected["minimumNativeIoU"].as_f64().unwrap() as f32,"{text}: IoU={overlap}, actual={bounds:?}, expected={reference:?}");
            measurements.push(json!({"page":number,"text":text,"iou":overlap,"bounds":bounds}));
        }
    }
    let columns=&data.pages[1].blocks;
    let order:Vec<_>=columns.iter().map(|block|normalized(&block.text)).collect();
    let expected_order:Vec<_>=expected["columnOrder"].as_array().unwrap().iter().map(|text|normalized(text.as_str().unwrap())).collect();
    assert_eq!(order,expected_order);
    let crop=&data.pages[4];assert_eq!(crop.page_box,[40.,50.,550.,780.]);assert_eq!(data.pages[3].rotation,90);
    assert!(pdf_extract::extract_pdf_with_output(&fixtures.join("encrypted.pdf"),&native,&AtomicBool::new(false),&output("encrypted")).is_err());
    assert!(pdf_extract::extract_pdf_with_output(&fixtures.join("corrupt.pdf"),&native,&AtomicBool::new(false),&output("corrupt")).is_err());
    let low=pdf_extract::extract_pdf_with_output(&fixtures.join("low-confidence.pdf"),&native,&AtomicBool::new(false),&output("low"));
    match low {Ok(data)=>assert!(data.pages.iter().any(|page|page.needs_review)),Err(error)=>assert!(error.contains("没有有效文字"),"{error}")}
    std::fs::write(evidence("actual-pdf.json"),serde_json::to_vec_pretty(&data).unwrap()).unwrap();
    std::fs::write(evidence("pdf-source-measurements.json"),serde_json::to_vec_pretty(&measurements).unwrap()).unwrap();
}

#[tokio::test]
#[ignore = "使用真实模型、SQLite、201 个 Markdown 和实际 PDF，由 Models 验收命令执行"]
async fn actual_generation_retains_valid_index_on_cancel_and_file_changes() {
    let root=output("generation");let native=workspace().join("resources/native");
    for number in 0..201 {std::fs::write(root.join(format!("document-{number}.md")),format!("# 文档 {number}\n\n实际资料 {number}：天文学讨论银河系的结构。\n")).unwrap();}
    let mut pdf=lopdf::Document::load(workspace().join("tests/fixtures/pdf/layout-and-ocr.pdf")).unwrap();
    pdf.delete_pages(&[2,3,4,5,6,7,8]);pdf.save(root.join("actual-source.pdf")).unwrap();
    let source=root.join("document-200.md");std::fs::write(&source,"# 草稿恢复\n\n软件保存 Markdown 文档，使用草稿恢复尚未保存的编辑。\n").unwrap();
    let model="sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2";
    let engine=Arc::new(LocalEmbeddingEngine::for_model(model).unwrap());
    let config=RagConfig {model_id:model.into(),embedding_dim:384,native_resources:native,..Default::default()};
    let cancel=Arc::new(AtomicBool::new(false));
    let first=generation::build_generation(&root,&config,&engine,&cancel,&uuid::Uuid::new_v4().to_string(),|_|{}).await.unwrap();
    assert_eq!(first.summary.status,"Ready");assert_eq!(first.summary.total_files_scanned,202);assert_eq!(first.storage.get_all_documents().unwrap().len(),202);
    let query=engine.embed_query("怎样恢复尚未保存的 Markdown 编辑？").await.unwrap();
    let reader=first.storage.get_reader().unwrap();let hits=first.storage.search_vector_knn(&reader,&query,5).unwrap();
    let chunks=first.storage.get_chunks_by_ids(&hits.iter().map(|hit|hit.chunk_id.clone()).collect::<Vec<_>>()).unwrap();assert!(chunks.iter().any(|chunk|chunk.rel_path=="document-200.md"));drop(reader);
    let original_generation=first.generation.generation_id.clone();
    let cancelled=Arc::new(AtomicBool::new(true));assert!(generation::build_generation(&root,&config,&engine,&cancelled,&uuid::Uuid::new_v4().to_string(),|_|{}).await.is_err());
    assert_eq!(generation::GenerationCatalog::open(&root).unwrap().current().unwrap().unwrap().generation_id,original_generation);
    let during=Arc::new(AtomicBool::new(false));let cancel_during=during.clone();
    let interrupted=generation::build_generation(&root,&config,&engine,&during,&uuid::Uuid::new_v4().to_string(),move|event| {
        if event.processed_files>=2 {cancel_during.store(true,Ordering::Release);}
    }).await;
    assert!(interrupted.is_err_and(|error|error=="Cancelled"));
    assert_eq!(generation::GenerationCatalog::open(&root).unwrap().current().unwrap().unwrap().generation_id,original_generation);
    let change_path=root.join("document-0.md");let mut changed=false;
    let changed_generation=generation::build_generation(&root,&config,&engine,&cancel,&uuid::Uuid::new_v4().to_string(),|event| {
        if event.processed_files>=5 && !changed {std::fs::write(&change_path,"# 索引期间的实际修改\n\n来源版本已经变化。\n").unwrap();changed=true;}
    }).await;
    assert!(changed && changed_generation.is_err_and(|error|error.contains("版本发生变化")));
    assert_eq!(generation::GenerationCatalog::open(&root).unwrap().current().unwrap().unwrap().generation_id,original_generation);
    std::fs::rename(&source,root.join("renamed.md")).unwrap();std::fs::remove_file(root.join("document-0.md")).unwrap();std::fs::write(root.join("document-1.md"),"# 修改资料\n\n量子计算研究量子比特。\n").unwrap();
    let next=generation::build_generation(&root,&config,&engine,&cancel,&uuid::Uuid::new_v4().to_string(),|_|{}).await.unwrap();
    assert_ne!(next.generation.generation_id,original_generation);let documents=next.storage.get_all_documents().unwrap();assert_eq!(documents.len(),201);assert!(documents.iter().any(|(path,_,_)|path=="renamed.md"));assert!(!documents.iter().any(|(path,_,_)|["document-200.md","document-0.md"].contains(&path.as_str())));
    next.storage.validate_and_flush().unwrap();
    let pdf_query=engine.embed_query("SINGLE COLUMN SOURCE ALPHA").await.unwrap();
    let reader=next.storage.get_reader().unwrap();let hits=next.storage.search_vector_knn(&reader,&pdf_query,5).unwrap();
    let chunks=next.storage.get_chunks_by_ids(&hits.iter().map(|hit|hit.chunk_id.clone()).collect::<Vec<_>>()).unwrap();
    assert!(chunks.iter().any(|chunk|chunk.rel_path=="actual-source.pdf" && chunk.page_number==Some(1)));drop(reader);
    let mut catalog=generation::GenerationCatalog::open(&root).unwrap();catalog.select_model("BAAI/bge-m3").unwrap();
    assert_eq!(catalog.current().unwrap().unwrap().generation_id,next.generation.generation_id);
    let bge=Arc::new(LocalEmbeddingEngine::for_model("BAAI/bge-m3").unwrap());
    let bge_config=RagConfig {model_id:"BAAI/bge-m3".into(),embedding_dim:1024,..config.clone()};
    let switched=generation::build_generation(&root,&bge_config,&bge,&cancel,&uuid::Uuid::new_v4().to_string(),|_|{}).await.unwrap();
    assert_eq!(switched.generation.model.dimension,1024);assert_eq!(switched.summary.success_files,201);
    assert_eq!(catalog.current().unwrap().unwrap().generation_id,switched.generation.generation_id);
    assert_ne!(next.generation.database_path,switched.generation.database_path);
    bge.unload().await;catalog.select_model(model).unwrap();
    std::fs::write(root.join("invalid.pdf"),std::fs::read(workspace().join("tests/fixtures/pdf/corrupt.pdf")).unwrap()).unwrap();
    let partial=generation::build_generation(&root,&config,&engine,&cancel,&uuid::Uuid::new_v4().to_string(),|_|{}).await.unwrap();assert_eq!(partial.summary.status,"Partial");assert_eq!(partial.summary.failed_files.len(),1);
    let evidence=json!({"root":root,"first":first.summary,"updated":next.summary,"partial":partial.summary,"switched":switched.summary,"cancelDuringIndex":true,"sourceChangedDuringIndex":true,"pdfSourceReturned":true});
    std::fs::write(self::evidence("actual-generations.json"),serde_json::to_vec_pretty(&evidence).unwrap()).unwrap();
    engine.unload().await;
}
