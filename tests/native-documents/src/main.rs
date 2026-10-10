#[path = "../../../tauri/src-tauri/src/document/mod.rs"]
mod document;

fn main() {
    let arguments: Vec<String> = std::env::args().collect();
    if arguments.len() != 5 || arguments[1] != "save" {
        panic!("用法: stuart-document-verification save 数据目录 草稿编号 保存请求JSON文件");
    }
    let service = document::DocumentService::new(arguments[2].clone().into()).expect("初始化文档服务失败");
    service.restore("worker", &arguments[3]).expect("恢复真实文档失败");
    let request: document::SaveRequest = serde_json::from_slice(&std::fs::read(&arguments[4]).expect("读取请求失败")).expect("解析请求失败");
    let result = service.save("worker", request).expect("真实保存失败");
    println!("{}", serde_json::to_string(&result).expect("结果序列化失败"));
}
