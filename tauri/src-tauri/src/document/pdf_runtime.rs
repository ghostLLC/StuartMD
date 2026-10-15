use std::path::Path;
use std::sync::OnceLock;
use pdfium_render::prelude::Pdfium;

pub(crate) fn pdfium(native:&Path)->Result<&'static Pdfium,String> {
    static PDFIUM:OnceLock<Result<Pdfium,String>>=OnceLock::new();
    let path=native.join("bin/pdfium.dll");
    let bytes=std::fs::read(&path).map_err(|error|format!("读取 PDFium 资源失败：{error}"))?;
    if super::identity::sha256(&bytes)!="79d4676b656cfb1abcea88f9ade3b4b0826c5200382db5f4ec72a636c598c118" {return Err("PDFium 资源指纹不匹配".into());}
    PDFIUM.get_or_init(||Pdfium::bind_to_library(&path).map(Pdfium::new).map_err(|error|format!("PDFium 7881 加载失败：{error}"))).as_ref().map_err(Clone::clone)
}
