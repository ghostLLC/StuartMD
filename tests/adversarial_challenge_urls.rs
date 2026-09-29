// Adversarial empirical stress-testing for stuart_open_url validation
extern crate url;

fn validate_url_for_open(url: &str) -> bool {
    let u = url.trim();
    let lower = u.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return false;
    }

    if u.chars().any(|c| c.is_control() || c == '"' || c == '\'' || c == '`' || c == ' ' || c == '\r' || c == '\n') {
        return false;
    }

    if url::Url::parse(u).is_err() {
        return false;
    }

    true
}

struct TestCase {
    category: &'static str,
    url: &'static str,
    expected_allowed: bool,
    description: &'static str,
}

fn main() {
    println!("=== P0-1 ADVERSARIAL STRESS-TEST: stuart_open_url Logic ===");

    let tests = vec![
        // 1. Command separators & shell injection
        TestCase { category: "Command Separators", url: "calc.exe &", expected_allowed: false, description: "Raw command with ampersand" },
        TestCase { category: "Command Separators", url: "calc.exe & https://example.com", expected_allowed: false, description: "Command prepended with ampersand" },
        TestCase { category: "Command Separators", url: "https://example.com/|calc.exe", expected_allowed: false, description: "Pipe separator in path" },
        TestCase { category: "Command Separators", url: "https://example.com/^calc.exe", expected_allowed: false, description: "Caret escape in path" },
        TestCase { category: "Command Separators", url: "https://example.com/&calc.exe", expected_allowed: true, description: "Ampersand in path (safe in ShellExecuteW)" },
        TestCase { category: "Command Separators", url: "https://example.com/;calc.exe", expected_allowed: true, description: "Semicolon in path (safe in ShellExecuteW)" },
        TestCase { category: "Command Separators", url: "https://example.com/?q=1&param=2", expected_allowed: true, description: "Standard query parameters with ampersand" },
        TestCase { category: "Command Separators", url: "https://example.com/$(calc.exe)", expected_allowed: false, description: "Subshell dollar expansion" },
        TestCase { category: "Command Separators", url: "https://example.com/%windir%\\system32\\calc.exe", expected_allowed: false, description: "Windows env var with backslash" },

        // 2. Quotes
        TestCase { category: "Quotes", url: "https://example.com\" --new-window", expected_allowed: false, description: "Double quote followed by argument" },
        TestCase { category: "Quotes", url: "https://example.com' --new-window", expected_allowed: false, description: "Single quote followed by argument" },
        TestCase { category: "Quotes", url: "https://example.com`calc.exe`", expected_allowed: false, description: "Backticks in URL" },
        TestCase { category: "Quotes", url: "\"https://example.com\"", expected_allowed: false, description: "Enclosing double quotes" },
        TestCase { category: "Quotes", url: "'https://example.com'", expected_allowed: false, description: "Enclosing single quotes" },
        TestCase { category: "Quotes", url: "`https://example.com`", expected_allowed: false, description: "Enclosing backticks" },
        TestCase { category: "Quotes", url: "https://example.com/\"test\"", expected_allowed: false, description: "Double quotes in path" },
        TestCase { category: "Quotes", url: "https://example.com/'test'", expected_allowed: false, description: "Single quotes in path" },

        // 3. Argument Injection
        TestCase { category: "Argument Injection", url: "--new-window", expected_allowed: false, description: "Bare flag --new-window" },
        TestCase { category: "Argument Injection", url: "--new-window https://example.com", expected_allowed: false, description: "Leading argument injection" },
        TestCase { category: "Argument Injection", url: "-k https://example.com", expected_allowed: false, description: "Leading short flag" },
        TestCase { category: "Argument Injection", url: "/new-window https://example.com", expected_allowed: false, description: "Leading slash flag" },
        TestCase { category: "Argument Injection", url: "https://example.com --new-window", expected_allowed: false, description: "Trailing argument injection with space" },
        TestCase { category: "Argument Injection", url: "https://example.com -k", expected_allowed: false, description: "Trailing short flag with space" },
        TestCase { category: "Argument Injection", url: "https://example.com /k calc.exe", expected_allowed: false, description: "Trailing cmd flag with space" },

        // 4. Control Characters
        TestCase { category: "Control Characters", url: "https://example.com\0calc.exe", expected_allowed: false, description: "Null byte injection" },
        TestCase { category: "Control Characters", url: "https://example.com\rcalc.exe", expected_allowed: false, description: "Carriage return injection" },
        TestCase { category: "Control Characters", url: "https://example.com\ncalc.exe", expected_allowed: false, description: "Newline injection" },
        TestCase { category: "Control Characters", url: "https://example.com\r\ncalc.exe", expected_allowed: false, description: "CRLF injection" },
        TestCase { category: "Control Characters", url: "https://example.com\tcalc.exe", expected_allowed: false, description: "Tab control char" },
        TestCase { category: "Control Characters", url: "https://example.com\x08calc.exe", expected_allowed: false, description: "Backspace control char" },
        TestCase { category: "Control Characters", url: "https://example.com\x1bcalc.exe", expected_allowed: false, description: "Escape control char" },
        TestCase { category: "Control Characters", url: "https://example.com\x7fcalc.exe", expected_allowed: false, description: "DEL control char" },
        TestCase { category: "Control Characters", url: "\x00https://example.com", expected_allowed: false, description: "Leading null byte" },

        // 5. Non-HTTP Schemes
        TestCase { category: "Non-HTTP Schemes", url: "file:///C:/Windows/System32/calc.exe", expected_allowed: false, description: "File scheme calc.exe" },
        TestCase { category: "Non-HTTP Schemes", url: "file://C:/Windows/System32/notepad.exe", expected_allowed: false, description: "File scheme notepad.exe" },
        TestCase { category: "Non-HTTP Schemes", url: "javascript:alert(1)", expected_allowed: false, description: "Javascript pseudo-protocol" },
        TestCase { category: "Non-HTTP Schemes", url: "javascript://https://example.com/%0Aalert(1)", expected_allowed: false, description: "Javascript pseudo-protocol with https comment" },
        TestCase { category: "Non-HTTP Schemes", url: "shell:startup", expected_allowed: false, description: "Shell protocol folder" },
        TestCase { category: "Non-HTTP Schemes", url: "shell:::{20D04FE0-3AEA-1069-A2D8-08002B30309D}", expected_allowed: false, description: "Shell CLSID shortcut" },
        TestCase { category: "Non-HTTP Schemes", url: "ms-settings:", expected_allowed: false, description: "Windows settings protocol" },
        TestCase { category: "Non-HTTP Schemes", url: "ms-settings:windowsupdate", expected_allowed: false, description: "Windows update settings" },
        TestCase { category: "Non-HTTP Schemes", url: "data:text/html,<script>alert(1)</script>", expected_allowed: false, description: "Data URI HTML" },
        TestCase { category: "Non-HTTP Schemes", url: "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==", expected_allowed: false, description: "Data URI base64" },
        TestCase { category: "Non-HTTP Schemes", url: "vbscript:msgbox(1)", expected_allowed: false, description: "VBScript protocol" },
        TestCase { category: "Non-HTTP Schemes", url: "about:blank", expected_allowed: false, description: "About protocol" },
        TestCase { category: "Non-HTTP Schemes", url: "chrome://settings", expected_allowed: false, description: "Chrome internal scheme" },
        TestCase { category: "Non-HTTP Schemes", url: "edge://flags", expected_allowed: false, description: "Edge internal scheme" },
        TestCase { category: "Non-HTTP Schemes", url: "calc:", expected_allowed: false, description: "Calc protocol" },
        TestCase { category: "Non-HTTP Schemes", url: "cmd:", expected_allowed: false, description: "CMD protocol" },
        TestCase { category: "Non-HTTP Schemes", url: "powershell:", expected_allowed: false, description: "PowerShell protocol" },
        TestCase { category: "Non-HTTP Schemes", url: "ws://evil.com", expected_allowed: false, description: "WebSocket protocol" },
        TestCase { category: "Non-HTTP Schemes", url: "wss://evil.com", expected_allowed: false, description: "Secure WebSocket protocol" },
        TestCase { category: "Non-HTTP Schemes", url: "ftp://ftp.example.com", expected_allowed: false, description: "FTP protocol" },

        // 6. Malformed & Edge Cases
        TestCase { category: "Malformed/Boundary", url: "http://", expected_allowed: false, description: "Empty host HTTP" },
        TestCase { category: "Malformed/Boundary", url: "https://", expected_allowed: false, description: "Empty host HTTPS" },
        TestCase { category: "Malformed/Boundary", url: "https://:80", expected_allowed: false, description: "Empty host with port" },
        TestCase { category: "Malformed/Boundary", url: "https:///path", expected_allowed: false, description: "Triple slash path without host" },
        TestCase { category: "Malformed/Boundary", url: "http:evil.com", expected_allowed: false, description: "Missing authority slashes" },
        TestCase { category: "Malformed/Boundary", url: "http//evil.com", expected_allowed: false, description: "Missing colon" },
        TestCase { category: "Malformed/Boundary", url: "https;evil.com", expected_allowed: false, description: "Semicolon instead of colon" },
        TestCase { category: "Malformed/Boundary", url: "   ", expected_allowed: false, description: "Whitespace only" },

        // 7. Legitimate URLs (Regression & Usability Checks)
        TestCase { category: "Legitimate URLs", url: "https://github.com/ghostLLC/StuartMD", expected_allowed: true, description: "Standard GitHub HTTPS" },
        TestCase { category: "Legitimate URLs", url: "http://example.com/page?query=123#anchor", expected_allowed: true, description: "Standard HTTP with query and anchor" },
        TestCase { category: "Legitimate URLs", url: "HTTPS://EXAMPLE.COM/DOCS", expected_allowed: true, description: "Uppercase HTTPS URL" },
        TestCase { category: "Legitimate URLs", url: "hTtP://eXaMpLe.CoM", expected_allowed: true, description: "Mixed case scheme" },
        TestCase { category: "Legitimate URLs", url: "  https://example.com/trimmed  ", expected_allowed: true, description: "Whitespace padded legitimate URL" },
        TestCase { category: "Legitimate URLs", url: "http://127.0.0.1:8080/dashboard", expected_allowed: true, description: "Local loopback IPv4" },
    ];

    let mut passed = 0;
    let mut failed = 0;

    for (i, t) in tests.iter().enumerate() {
        let result = validate_url_for_open(t.url);
        let status = if result == t.expected_allowed {
            passed += 1;
            "PASS"
        } else {
            failed += 1;
            "FAIL"
        };

        if status == "FAIL" {
            println!(
                "  [{}] Test #{}: [{}] {} | Expected: {}, Actual: {} | Input: {:?}",
                status, i + 1, t.category, t.description, t.expected_allowed, result, t.url
            );
        } else {
            println!(
                "  [{}] #{:02}: [{}] {} -> allowed: {}",
                status, i + 1, t.category, t.description, result
            );
        }
    }

    println!("\nSummary: Total: {}, Passed: {}, Failed: {}", tests.len(), passed, failed);
    if failed == 0 {
        println!("RESULT: ALL P0-1 ADVERSARIAL URL INJECTION TESTS PASSED!");
    } else {
        println!("RESULT: {} P0-1 TESTS FAILED!", failed);
        std::process::exit(1);
    }
}
