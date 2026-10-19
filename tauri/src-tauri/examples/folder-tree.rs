#[path = "../src/folder_tree.rs"]
mod folder_tree;

fn main() {
    let root = std::path::PathBuf::from(std::env::args_os().nth(1).expect("需要目录路径"));
    let tree = folder_tree::scan(&root, true, 3, None).expect("读取实际目录失败");
    println!("{}", serde_json::to_string(&tree).expect("序列化目录结果失败"));
}
