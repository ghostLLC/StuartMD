"""
Empirical verification of URL handling:
1. cmd.exe /C start "" argument injection behavior
2. ShellExecuteW behavior with special characters, schemes, and quotes
3. Evaluation of roadmap proposal stuart_open_url
"""
import ctypes
import os
import subprocess
import sys

def test_cmd_injection():
    print("=== TEST 1: cmd.exe /C start \"\" Argument Handling ===")
    
    # We test whether cmd.exe splits commands on '&' when called without quotes
    # Specifically: cmd.exe /C start "" https://example.com/?q=1&echo INJECTED_COMMAND_TRIGGERED > cmd_out.txt
    test_out = os.path.abspath("tests/cmd_inject_result.txt")
    if os.path.exists(test_out):
        os.remove(test_out)
        
    injected_url = f"https://example.com/?q=1&echo INJECTED_SUCCESS > \"{test_out}\""
    
    # Simulate exact Rust std::process::Command::new("cmd").args(["/C", "start", "", u])
    # Note: On Windows, CreateProcess receives command line: cmd /C start "" <injected_url>
    # When injected_url contains no spaces in the URL part until the &, CRT does not wrap it in quotes.
    # To be exact, let's see how Rust formats it or test directly with cmd:
    proc = subprocess.run(["cmd", "/C", "start", "", f"https://example.com/?q=1&echo INJECTED_SUCCESS > \"{test_out}\""],
                          capture_output=True, text=True, shell=False)
    
    if os.path.exists(test_out):
        with open(test_out, "r") as f:
            content = f.read().strip()
        print(f"[-] CONFIRMED: cmd.exe executed injected command! Output: {content}")
        os.remove(test_out)
        cmd_vulnerable = True
    else:
        print("[+] cmd.exe did not execute injected command directly via subprocess list")
        cmd_vulnerable = False

    # Now test with unquoted URL containing & in the query string
    # e.g. cmd /C echo URL: https://example.com/?a=1&calc.exe
    proc2 = subprocess.run(f'cmd /C start "" https://example.com/?a=1^&echo INJECTED_VIA_RAW_CMD > "{test_out}"',
                           shell=True, capture_output=True, text=True)
    if os.path.exists(test_out):
        with open(test_out, "r") as f:
            content = f.read().strip()
        print(f"[-] CONFIRMED via shell invocation: Output: {content}")
        os.remove(test_out)

    return cmd_vulnerable

def test_shellexecute_url():
    print("\n=== TEST 2: ShellExecuteW Behavior & Edge Cases ===")
    shell32 = ctypes.windll.shell32
    
    # ShellExecuteW signature:
    # HINSTANCE ShellExecuteW(HWND hwnd, LPCWSTR lpOperation, LPCWSTR lpFile, LPCWSTR lpParameters, LPCWSTR lpDirectory, INT nShowCmd)
    # Return value > 32 indicates success.
    
    # 2.1 Special character '&': Does ShellExecuteW treat '&' as a command separator?
    # We pass a harmless URL with & and check that it does NOT execute an external command.
    url_with_amp = "https://example.com/test?a=1&calc.exe"
    print(f"Testing ShellExecuteW with '&': {url_with_amp}")
    # We won't actually launch the browser window to avoid popping up UI on the test machine,
    # or we can test with a dummy protocol or query registered handler.
    # Let's inspect what protocol handlers are registered in registry for http/https.
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, r"https\shell\open\command") as key:
            val, _ = winreg.QueryValueEx(key, "")
            print(f"Registered HTTPS handler in registry: {val}")
    except Exception as e:
        print(f"Registry query error: {e}")

    # 2.2 Test ShellExecuteW return codes:
    # Test invalid scheme / non-existent protocol
    invalid_url = "nonexistentproto://test"
    res = shell32.ShellExecuteW(None, "open", invalid_url, None, None, 0)
    print(f"ShellExecuteW on invalid protocol: return HINSTANCE = {res} (Success: {res > 32})")
    
    # 2.3 What happens if URL contains double quotes? e.g. https://example.com" -arg
    url_with_quote = 'https://example.com/test" --injected-arg'
    # Check if ShellExecuteW handles or errors on quotes in URL
    # Note: On Windows, passing quotes in lpFile can cause argument injection in certain handlers!
    res_quote = shell32.ShellExecuteW(None, "open", url_with_quote, None, None, 0)
    print(f"ShellExecuteW with quote in URL: return HINSTANCE = {res_quote}")

def test_roadmap_url_validation():
    print("\n=== TEST 3: Adversarial Challenge of Roadmap URL Validation ===")
    # Roadmap proposal checks:
    # let u = url.trim();
    # if !(u.starts_with("http://") || u.starts_with("https://")) { return false; }
    
    test_cases = [
        ("http://example.com", True, "Normal HTTP"),
        ("https://example.com", True, "Normal HTTPS"),
        ("https://example.com/path?foo=bar&baz=qux", True, "Standard query params"),
        ("https://example.com\" --disable-web-security", True, "Quote argument injection"),
        ("https://example.com\r\nHeader-Injection: true", True, "CRLF injection"),
        ("https://example.com\0evil.exe", True, "Null byte truncation"),
        ("https:example.com", False, "Missing slashes"),
        ("http://", True, "Empty host"),
        ("https://user:pass@evil.com", True, "Embedded credentials"),
        ("javascript:alert(1)", False, "Javascript pseudo-protocol"),
        ("file:///C:/Windows/System32/cmd.exe", False, "File protocol"),
        ("https://127.0.0.1:8080/internal", True, "SSRF / local loopback access"),
        ("https://", True, "Scheme only with no host"),
        ("https://example.com/   ", True, "Trailing spaces"),
    ]
    
    print("Evaluating roadmap check: `u.starts_with('http://') || u.starts_with('https://')`:")
    flaws = []
    for url, allowed_by_roadmap, desc in test_cases:
        passes_roadmap = url.strip().startswith("http://") or url.strip().startswith("https://")
        
        # Check against standard URL parsing
        import urllib.parse
        parsed = urllib.parse.urlparse(url.strip())
        is_rfc_valid = bool(parsed.scheme in ("http", "https") and parsed.netloc and '"' not in url and '\r' not in url and '\n' not in url and '\0' not in url)
        
        status = "PASS" if passes_roadmap == is_rfc_valid else "VULNERABILITY"
        print(f"  [{status}] {desc:<30} | Roadmap: {passes_roadmap} | RFC Valid: {is_rfc_valid} | URL: {repr(url)}")
        if status == "VULNERABILITY":
            flaws.append((url, desc, "Roadmap allows invalid/dangerous URL" if passes_roadmap else "Roadmap blocks valid URL"))

    print(f"\nTotal flaws in roadmap URL validation logic: {len(flaws)}")
    for url, desc, reason in flaws:
        print(f"  - Flaw: {desc} ({reason})")

if __name__ == "__main__":
    test_cmd_injection()
    test_shellexecute_url()
    test_roadmap_url_validation()
