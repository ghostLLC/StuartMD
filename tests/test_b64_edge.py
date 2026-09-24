import subprocess
import base64
import re
import json

html = """<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body>
<div id="results"></div>
<script>
function sanitizeHtmlStrict(rawHtml) {
  if (!rawHtml) return "";
  const template = document.createElement("template");
  template.innerHTML = rawHtml;
  const content = template.content;
  content.querySelectorAll("script, iframe, object, embed, base, form, meta, link, applet").forEach((el) => el.remove());
  const allElements = content.querySelectorAll("*");
  for (let i = 0; i < allElements.length; i++) {
    const el = allElements[i];
    const attrs = Array.from(el.attributes);
    for (const attr of attrs) {
      const name = attr.name.toLowerCase();
      const val = attr.value.trim().toLowerCase();
      if (name.startsWith("on") || val.startsWith("javascript:") || val.startsWith("data:") || val.startsWith("vbscript:")) {
        el.removeAttribute(attr.name);
      }
    }
  }
  const container = document.createElement("div");
  container.appendChild(content);
  return container.innerHTML;
}

function currentAppJsSanitize(html) {
  const wrap = document.createElement("div");
  wrap.innerHTML = html;
  if (
    html.indexOf("<script") >= 0 ||
    html.indexOf("<iframe") >= 0 ||
    html.indexOf("<object") >= 0 ||
    html.indexOf("<embed") >= 0 ||
    html.indexOf("javascript:") >= 0 ||
    /\\son\\w+\\s*=/i.test(html)
  ) {
    try {
      wrap.querySelectorAll("script,iframe,object,embed,link[rel=import]").forEach((n) => n.remove());
      const all = wrap.querySelectorAll("*");
      for (let i = 0; i < all.length; i++) {
        const node = all[i];
        const attrs = node.attributes;
        if (!attrs || !attrs.length) continue;
        for (let j = attrs.length - 1; j >= 0; j--) {
          const a = attrs[j];
          const n = a.name || "";
          const v = a.value || "";
          if (/^on/i.test(n)) node.removeAttribute(n);
          else if ((n === "href" || n === "src" || n === "xlink:href") && /^\\s*javascript:/i.test(v)) {
            node.removeAttribute(n);
          }
        }
      }
    } catch (_) {}
  }
  return wrap.innerHTML;
}

const testPayloads = [
  { name: "SVG onload with slash", payload: '<svg/onload="window.__xss=1">' },
  { name: "IMG onerror with slash", payload: '<img/src=data:,/onerror="window.__xss=2">' },
  { name: "Uppercase SCRIPT tag", payload: '<SCRIPT>window.__xss=3<\\/SCRIPT>' },
  { name: "Uppercase JAVASCRIPT: href", payload: '<a href="JAVASCRIPT:window.__xss=4">click</a>' },
  { name: "Tab-separated javascript: href", payload: '<a href="jav&#x09;ascript:window.__xss=5">click</a>' },
  { name: "Newline-separated javascript: href", payload: '<a href="jav&#x0a;ascript:window.__xss=6">click</a>' },
  { name: "Tab-separated data: href", payload: '<a href="da&#x09;ta:text/html;base64,PHNjcmlwdD53aW5kb3cuX194c3M9Nzwvc2NyaXB0Pg==">click</a>' },
  { name: "SVG animate values with javascript", payload: '<svg><animate href="#link" attributeName="href" values="https://x;javascript:window.__xss=8" /><a id="link"><text y="20">Click</text></a></svg>' },
  { name: "mXSS MathML style payload", payload: '<math><mtext><table><mglyph><style>/*--</style><img src=data:, onerror="window.__xss=9">' },
  { name: "SVG foreignObject script", payload: '<svg><foreignObject><script>window.__xss=10<\\/script></foreignObject></svg>' },
  { name: "Audio onerror event with newline", payload: '<audio\\nsrc=data:,\\nonerror="window.__xss=11">' },
];

const results = [];
for (const t of testPayloads) {
  const currentOut = currentAppJsSanitize(t.payload);
  const proposedFallbackOut = sanitizeHtmlStrict(t.payload);
  results.push({
    test: t.name,
    payload: t.payload,
    currentOut: currentOut,
    proposedFallbackOut: proposedFallbackOut
  });
}
document.getElementById("results").textContent = JSON.stringify(results);
</script>
</body>
</html>"""

b64 = base64.b64encode(html.encode("utf-8")).decode("ascii")
edge_path = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
cmd = [
    edge_path,
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--blink-settings=imagesEnabled=false",
    "--host-resolver-rules=MAP * ~NOTFOUND",
    "--dump-dom",
    f"data:text/html;base64,{b64}"
]

res = subprocess.run(cmd, capture_output=True, text=True, timeout=10, encoding="utf-8", errors="replace")
m = re.search(r'<div id="results">([\s\S]*?)</div>', res.stdout)
if m:
    raw = m.group(1).replace("&quot;", '"').replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
    data = json.loads(raw)
    print(json.dumps(data, indent=2))
else:
    print("Match failed. Stdout:")
    print(res.stdout[:500])
