// StuartMD Roadmap P0-3 proposed fallback sanitizer:
function sanitizeHtmlStrict(rawHtml) {
  if (!rawHtml) return "";

  // If DOMPurify exists
  if (typeof DOMPurify !== "undefined") {
    return DOMPurify.sanitize(rawHtml, {
      USE_PROFILES: { html: true, svg: true },
      FORBID_TAGS: ["script", "iframe", "object", "embed", "base", "form", "meta", "link"],
      FORBID_ATTR: ["style"],
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|stuart-file):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
      ADD_ATTR: ["target"],
    });
  }

  // Fallback DOM sanitizer proposed in roadmap
  const template = document.createElement("template");
  template.innerHTML = rawHtml;
  const content = template.content;

  // Remove dangerous tags
  content.querySelectorAll("script, iframe, object, embed, base, form, meta, link, applet").forEach((el) => el.remove());

  // Check attributes
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

// Current StuartMD app.js sanitizer (from app.js:224-265)
function currentAppJsSanitize(html) {
  const wrap = document.createElement("div");
  wrap.innerHTML = html;
  if (
    html.indexOf("<script") >= 0 ||
    html.indexOf("<iframe") >= 0 ||
    html.indexOf("<object") >= 0 ||
    html.indexOf("<embed") >= 0 ||
    html.indexOf("javascript:") >= 0 ||
    /\son\w+\s*=/i.test(html)
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
          else if ((n === "href" || n === "src" || n === "xlink:href") && /^\s*javascript:/i.test(v)) {
            node.removeAttribute(n);
          }
        }
      }
    } catch (_) {}
  }
  return wrap.innerHTML;
}

window.addEventListener("DOMContentLoaded", () => {
  const testPayloads = [
    { name: "SVG onload with slash", payload: '<svg/onload="window.__xss=1">' },
    { name: "IMG onerror with slash", payload: '<img/src=x/onerror="window.__xss=2">' },
    { name: "Uppercase SCRIPT tag", payload: '<SCRIPT>window.__xss=3</' + 'script>' },
    { name: "Uppercase JAVASCRIPT: href", payload: '<a href="JAVASCRIPT:window.__xss=4">click</a>' },
    { name: "Tab-separated javascript: href", payload: '<a href="jav&#x09;ascript:window.__xss=5">click</a>' },
    { name: "Newline-separated javascript: href", payload: '<a href="jav&#x0a;ascript:window.__xss=6">click</a>' },
    { name: "Tab-separated data: href", payload: '<a href="da&#x09;ta:text/html;base64,PHNjcmlwdD53aW5kb3cuX194c3M9Nzwvc2NyaXB0Pg==">click</a>' },
    { name: "SVG animate values with javascript", payload: '<svg><animate href="#link" attributeName="href" values="https://x;javascript:window.__xss=8" /><a id="link"><text y="20">Click</text></a></svg>' },
    { name: "mXSS MathML style payload", payload: '<math><mtext><table><mglyph><style>\x3c!--</style><img src=x onerror="window.__xss=9">' },
    { name: "SVG foreignObject script", payload: '<svg><foreignObject><script>window.__xss=10</' + 'script></foreignObject></svg>' },
    { name: "Audio onerror event with newline", payload: '<audio\nsrc=x\nonerror="window.__xss=11">' },
  ];

  const results = [];

  for (const t of testPayloads) {
    const currentOut = currentAppJsSanitize(t.payload);
    const proposedFallbackOut = sanitizeHtmlStrict(t.payload);
    
    // Check if dangerous patterns survived
    const currentVulnerable = (
      /onload/i.test(currentOut) ||
      /onerror/i.test(currentOut) ||
      /<script/i.test(currentOut) ||
      /javascript:/i.test(currentOut) ||
      /jav[\t\n\r]ascript:/i.test(currentOut) ||
      /data:/i.test(currentOut)
    );

    const fallbackVulnerable = (
      /onload/i.test(proposedFallbackOut) ||
      /onerror/i.test(proposedFallbackOut) ||
      /<script/i.test(proposedFallbackOut) ||
      /javascript:/i.test(proposedFallbackOut) ||
      /jav[\t\n\r]ascript:/i.test(proposedFallbackOut) ||
      /da[\t\n\r]ta:/i.test(proposedFallbackOut)
    );

    results.push({
      test: t.name,
      payload: t.payload,
      currentOut: currentOut,
      currentVulnerable: currentVulnerable,
      proposedFallbackOut: proposedFallbackOut,
      fallbackVulnerable: fallbackVulnerable
    });
  }

  const resDiv = document.getElementById("results");
  resDiv.textContent = JSON.stringify(results);
});
