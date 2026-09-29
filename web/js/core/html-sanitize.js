/**
 * StuartMD core — HTML sanitization (DOMPurify preferred, pure DOM allowlist fallback).
 * Host: window.StuartCore.htmlSanitize
 *
 * API:
 *   sanitizeHtml(html, opts)            → safe HTML string (paste / innerHTML)
 *   sanitizeUntrustedMarkdown(text)     → markdown-ish text with neutralized HTML
 *   isSafeHref(url)                     → URL policy check
 *   escapeHtml(text)                    → entity-escape plain text
 *
 * opts for sanitizeHtml:
 *   allowSvg, allowMathMl, allowStyleTag, allowStyleAttr (all default false)
 *   RICH_OPTS enables svg/mathml/style for Mermaid + KaTeX twins.
 */
(function (global) {
  "use strict";

  /** URL policy: http(s), mailto, #fragment, and relative paths only. */
  function isSafeHref(rawHref) {
    if (rawHref == null) return false;
    // Strip C0/DEL + whitespace first so `jav&#x09;ascript:` style tricks die.
    const normalized = String(rawHref)
      .replace(/[\u0000-\u001F\u007F\s]/g, "")
      .toLowerCase();
    if (!normalized) return false;
    if (
      normalized.includes("javascript:") ||
      normalized.includes("vbscript:") ||
      normalized.includes("data:") ||
      normalized.includes("file:") ||
      normalized.includes("about:") ||
      normalized.includes("blob:")
    ) {
      return false;
    }
    // Absolute schemes we accept.
    if (/^(?:https?|mailto):/.test(normalized)) return true;
    // Anchor.
    if (normalized.charAt(0) === "#") return true;
    // Protocol-relative (`//evil`) is NOT relative — reject.
    if (normalized.startsWith("//")) return false;
    // Any other explicit scheme is rejected.
    if (/^[a-z][a-z0-9+.\-]*:/.test(normalized)) return false;
    // Relative path / query.
    return true;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** Text-node escape: re-close any tag/entity that the parser decoded. */
  function escapeText(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // ---- Allowlists (pure DOM walker) ----

  const BASE_TAGS = new Set([
    "P", "BR", "HR", "H1", "H2", "H3", "H4", "H5", "H6",
    "BLOCKQUOTE", "PRE", "CODE", "UL", "OL", "LI", "DL", "DT", "DD",
    "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TH", "TD", "CAPTION",
    "STRONG", "B", "EM", "I", "U", "DEL", "S", "A", "IMG",
    "SPAN", "DIV", "SUB", "SUP", "MARK", "SMALL", "ABBR", "SUMMARY", "DETAILS",
    "KBD", "VAR", "SAMP", "CITE", "Q", "TIME", "DATA", "WBR",
    "FIGURE", "FIGCAPTION", "SECTION", "ARTICLE", "HEADER", "FOOTER", "MAIN",
    "INPUT",
  ]);

  const SVG_TAGS = new Set([
    "SVG", "G", "PATH", "RECT", "CIRCLE", "LINE", "POLYLINE", "POLYGON",
    "ELLIPSE", "TEXT", "TSPAN", "DEFS", "MARKER", "CLIPPATH", "FILTER",
    "FOREIGNOBJECT", "LINEARGRADIENT", "RADIALGRADIENT", "STOP", "USE",
    "SYMBOL", "TITLE", "DESC", "CLIPPATH",
  ]);

  const MATHML_TAGS = new Set([
    "MATH", "MI", "MN", "MO", "MSUP", "MSUB", "MFRAC", "MSQRT", "MROW",
    "MTEXT", "MSPACE", "MSTYLE", "MERROR", "MPADDED", "MPHANTOM",
  ]);

  // Active content / parser-context traps: always dropped (element + descendants).
  const ALWAYS_DROP = new Set([
    "SCRIPT", "NOSCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "APPLET",
    "BASE", "FORM", "META", "LINK", "TEMPLATE", "TITLE", "TEXTAREA",
    "SELECT", "OPTION", "OPTGROUP", "BUTTON", "FIELDSET", "LEGEND",
    "DIALOG", "PORTAL",
  ]);

  const VOID_TAGS = new Set([
    "BR", "HR", "IMG", "INPUT", "WBR", "COL", "SOURCE", "TRACK",
  ]);

  const BASE_ATTRS = {
    A: new Set(["href", "target", "rel", "title", "class", "id"]),
    IMG: new Set(["src", "alt", "title", "width", "height", "class", "id", "loading"]),
    CODE: new Set(["class", "id", "data-language"]),
    PRE: new Set(["class", "id", "data-mermaid"]),
    TH: new Set(["align", "colspan", "rowspan", "class", "id", "scope"]),
    TD: new Set(["align", "colspan", "rowspan", "class", "id"]),
    OL: new Set(["start", "type", "class", "id"]),
    LI: new Set(["value", "class", "id"]),
    INPUT: new Set(["type", "disabled", "checked", "class", "id"]),
    DEFAULT: new Set(["class", "id", "title", "dir", "lang", "data-index", "data-mermaid", "data-language"]),
  };

  const SVG_ATTRS = new Set([
    "class", "id", "title", "viewBox", "xmlns", "width", "height", "x", "y",
    "cx", "cy", "r", "rx", "ry", "x1", "y1", "x2", "y2", "d", "fill", "stroke",
    "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray",
    "stroke-dashoffset", "opacity", "transform", "points", "offset", "stop-color",
    "stop-opacity", "marker-end", "marker-start", "marker-mid", "markerWidth",
    "markerHeight", "refX", "refY", "orient", "clip-path", "fill-rule", "fill-opacity",
    "stroke-opacity", "font-size", "font-family", "font-weight", "text-anchor",
    "dominant-baseline", "alignment-baseline", "href", "xlink:href", "data-icon",
    "aria-hidden", "focusable", "role", "vector-effect", "xmlns:xlink", "preserveAspectRatio",
  ]);

  const MATHML_ATTRS = new Set([
    "class", "id", "title", "mathvariant", "displaystyle", "scriptlevel",
    "stretchy", "fence", "separator", "accent", "accentunder", "columnalign",
    "rowspacing", "columnspacing", "linethickness", "width", "height", "depth",
    "voffset", "display", "dir", "mathsize", "mathcolor", "mathbackground",
  ]);

  const URI_ATTRS = new Set(["href", "src", "xlink:href", "cite", "poster", "background"]);

  const CLASS_ID_RE = { class: /^[a-zA-Z0-9_\-\s]+$/, id: /^[a-zA-Z0-9_\-]+$/ };

  function normalizeOpts(opts) {
    const o = opts || {};
    return {
      allowSvg: !!o.allowSvg,
      allowMathMl: !!o.allowMathMl,
      allowStyleTag: !!o.allowStyleTag,
      allowStyleAttr: !!o.allowStyleAttr,
    };
  }

  function isAllowedTag(tagUpper, cfg) {
    if (ALWAYS_DROP.has(tagUpper)) return false;
    // STYLE is both an HTML and an SVG tag; gate on the style switch first.
    if (tagUpper === "STYLE") return cfg.allowStyleTag;
    // SVG family (TITLE/DESC are SVG children only when allowSvg).
    if (SVG_TAGS.has(tagUpper)) return cfg.allowSvg;
    if (MATHML_TAGS.has(tagUpper)) return cfg.allowMathMl;
    return BASE_TAGS.has(tagUpper);
  }

  function allowedAttrsFor(tagUpper, cfg) {
    if (SVG_TAGS.has(tagUpper) && cfg.allowSvg) {
      return cfg.allowStyleAttr ? new Set([...SVG_ATTRS, "style"]) : SVG_ATTRS;
    }
    if (MATHML_TAGS.has(tagUpper) && cfg.allowMathMl) {
      return cfg.allowStyleAttr ? new Set([...MATHML_ATTRS, "style"]) : MATHML_ATTRS;
    }
    const set = BASE_ATTRS[tagUpper] || BASE_ATTRS.DEFAULT;
    return cfg.allowStyleAttr ? new Set([...set, "style"]) : set;
  }

  function attrIsSafe(tagUpper, name, value, cfg) {
    const n = String(name || "").toLowerCase();
    // Event handlers are never allowed.
    if (n.indexOf("on") === 0) return false;
    if (n === "style" && !cfg.allowStyleAttr) return false;
    if (n === "srcdoc" || n === "formaction" || n === "action") return false;

    const allowed = allowedAttrsFor(tagUpper, cfg);
    if (!allowed.has(n) && !allowed.has(name)) return false;

    if (URI_ATTRS.has(n)) return isSafeHref(value);
    if (n === "class") return CLASS_ID_RE.class.test(String(value == null ? "" : value));
    if (n === "id") return CLASS_ID_RE.id.test(String(value == null ? "" : value));
    if (n === "target") return String(value) === "_blank" || String(value) === "_self";
    return true;
  }

  /** Output tag name: preserve SVG/MathML camelCase, lowercase HTML. */
  function outTagName(node, tagUpper) {
    if (SVG_TAGS.has(tagUpper) || MATHML_TAGS.has(tagUpper)) return node.tagName;
    return tagUpper.toLowerCase();
  }

  /**
   * Pure DOM allowlist walker (no regex blacklist of source text).
   * Parses with the HTML parser, walks the live tree, then serializes.
   */
  function sanitizeFragmentPure(rawHtml, cfg) {
    const container = document.createElement("div");
    container.innerHTML = String(rawHtml == null ? "" : rawHtml);

    // Snapshot first: mutation while walking a live NodeList is unsafe.
    const all = Array.from(container.querySelectorAll("*"));
    for (const el of all) {
      if (!el.parentNode) continue; // already detached
      const tagUpper = el.tagName.toUpperCase();

      if (!isAllowedTag(tagUpper, cfg)) {
        el.remove();
        continue;
      }
      if (tagUpper === "INPUT" && String(el.getAttribute("type") || "").toLowerCase() !== "checkbox") {
        el.remove();
        continue;
      }

      const attrs = Array.from(el.attributes);
      for (const attr of attrs) {
        if (!attrIsSafe(tagUpper, attr.name, attr.value, cfg)) {
          el.removeAttribute(attr.name);
        }
      }

      if (tagUpper === "A" && el.getAttribute("target") === "_blank") {
        el.setAttribute("rel", "noopener noreferrer");
      }
    }

    return container.innerHTML;
  }

  /**
   * DOMPurify config mirroring the strict product policy.
   * Style is forbidden unless the caller opts in (Mermaid/KaTeX twins).
   */
  function domPurifyConfig(cfg) {
    const forbid = [
      "script", "iframe", "object", "embed", "base", "form", "meta",
      "link", "applet", "noscript", "template",
    ];
    if (!cfg.allowStyleTag) forbid.push("style");
    const forbidAttr = [];
    if (!cfg.allowStyleAttr) forbidAttr.push("style");
    return {
      USE_PROFILES: { html: true, svg: cfg.allowSvg, mathMl: cfg.allowMathMl },
      FORBID_TAGS: forbid,
      FORBID_ATTR: forbidAttr,
      // http(s) / mailto / relative-or-anchor (same spirit as isSafeHref)
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
      ADD_ATTR: ["target"],
      ALLOW_DATA_ATTR: false,
    };
  }

  /**
   * Sanitize an HTML fragment for innerHTML insertion.
   * Prefers DOMPurify (web/libs/dompurify.min.js) when present.
   * @param {string} html
   * @param {{allowSvg?:boolean, allowMathMl?:boolean, allowStyleTag?:boolean, allowStyleAttr?:boolean}} [opts]
   * @returns {string}
   */
  function sanitizeHtml(html, opts) {
    const raw = String(html == null ? "" : html);
    if (!raw) return "";
    const cfg = normalizeOpts(opts);
    const DP = global.DOMPurify;
    if (DP && typeof DP.sanitize === "function") {
      try {
        return String(DP.sanitize(raw, domPurifyConfig(cfg)));
      } catch (_) {
        // fall through to pure walker
      }
    }
    return sanitizeFragmentPure(raw, cfg);
  }

  // ---- Untrusted markdown (DOM parse + allowlist walk) ----

  // Private-use codepoints as slot sentinels (never appear in real documents).
  const SLOT_OPEN = "\uE000";
  const SLOT_CLOSE = "\uE001";

  /**
   * Pull fenced code blocks and inline code spans out of the text.
   * Markdown escapes their HTML at render time, so they are already inert —
   * sanitizing them would only destroy legitimate code samples.
   */
  function extractCodeSlots(src) {
    const slots = [];
    const push = (raw) => {
      const id = slots.length;
      slots.push(raw);
      return SLOT_OPEN + id + SLOT_CLOSE;
    };

    // 1) Fenced code (``` / ~~~) — line oriented.
    const lines = src.split("\n");
    const kept = [];
    let openFence = null; // { marker: "```", lines: [...] }
    for (const line of lines) {
      const m = line.match(/^(\s{0,3})(`{3,}|~{3,})(.*)$/);
      if (openFence) {
        if (
          m &&
          m[2].charAt(0) === openFence.marker.charAt(0) &&
          m[2].length >= openFence.marker.length &&
          !m[3].trim()
        ) {
          // closing fence: park the whole block as one slot
          openFence.lines.push(line);
          kept.push(push(openFence.lines.join("\n")));
          openFence = null;
        } else {
          openFence.lines.push(line);
        }
        continue;
      }
      if (m) {
        openFence = { marker: m[2], lines: [line] };
        continue;
      }
      kept.push(line);
    }
    if (openFence) {
      kept.push(push(openFence.lines.join("\n")));
    }

    // 2) Inline code spans on the remaining text.
    const joined = kept.join("\n");
    let out = "";
    let i = 0;
    while (i < joined.length) {
      if (joined.charAt(i) === "`") {
        let n = 1;
        while (i + n < joined.length && joined.charAt(i + n) === "`") n++;
        const marker = "`".repeat(n);
        let j = joined.indexOf(marker, i + n);
        while (j !== -1) {
          // reject a longer run that merely contains our marker
          let k = j;
          while (k < joined.length && joined.charAt(k) === "`") k++;
          if (k - j === n) break;
          j = joined.indexOf(marker, k);
        }
        if (j !== -1) {
          out += push(joined.slice(i, j + n));
          i = j + n;
          continue;
        }
      }
      out += joined.charAt(i);
      i++;
    }
    return { text: out, slots };
  }

  function restoreCodeSlots(text, slots) {
    let out = String(text == null ? "" : text);
    for (let i = 0; i < slots.length; i++) {
      out = out.split(SLOT_OPEN + i + SLOT_CLOSE).join(slots[i]);
    }
    // Defensive: drop any sentinel leftovers that were not restored.
    return out.split(SLOT_OPEN).join("").split(SLOT_CLOSE).join("");
  }

  /**
   * Walk a parsed tree and rebuild a markdown-safe string.
   * - text nodes: re-escaped (parser decoded entities; raw "<" must not survive)
   * - allowlisted elements: rebuilt with safe attrs only
   * - non-allowlisted / active content: dropped (element + descendants)
   */
  function walkMarkdownNode(node, buf, cfg) {
    if (!node) return;
    const type = node.nodeType;
    if (type === 3) {
      // TEXT — re-escape so a decoded "<script>" cannot reopen as markup.
      buf.push(escapeText(node.data));
      return;
    }
    if (type !== 1) {
      // comments, doctypes, etc.
      return;
    }

    const tagUpper = node.tagName.toUpperCase();
    if (!isAllowedTag(tagUpper, cfg)) return; // drop with content

    if (tagUpper === "INPUT" && String(node.getAttribute("type") || "").toLowerCase() !== "checkbox") {
      return;
    }

    const tagNameOut = outTagName(node, tagUpper);
    let attrsOut = "";
    const attrs = Array.from(node.attributes);
    for (const attr of attrs) {
      if (!attrIsSafe(tagUpper, attr.name, attr.value, cfg)) continue;
      attrsOut += " " + attr.name + '="' + escapeHtml(attr.value) + '"';
    }

    if (VOID_TAGS.has(tagUpper)) {
      buf.push("<" + tagNameOut + attrsOut + ">");
      return;
    }

    buf.push("<" + tagNameOut + attrsOut + ">");
    for (let child = node.firstChild; child; child = child.nextSibling) {
      walkMarkdownNode(child, buf, cfg);
    }
    buf.push("</" + tagNameOut + ">");
  }

  function sanitizeMarkdownSegment(src) {
    const cfg = normalizeOpts(null); // strict: no style, no svg/mathml
    const container = document.createElement("div");
    // Parse as HTML fragment. Markdown text becomes text nodes; embedded HTML
    // becomes elements we then filter with the allowlist walk.
    container.innerHTML = src;
    const buf = [];
    // Walk fragment children only — the host <div> must not appear in output.
    for (let child = container.firstChild; child; child = child.nextSibling) {
      walkMarkdownNode(child, buf, cfg);
    }
    return buf.join("");
  }

  /**
   * Sanitize untrusted markdown-ish text (AI / plugin document writes).
   * Uses DOM parse + allowlist walk — never a regex tag blacklist.
   * Preserves plain markdown when the source contains no "<".
   * @param {string} text
   * @returns {string}
   */
  function sanitizeUntrustedMarkdown(text) {
    const src = String(text == null ? "" : text);
    if (!src) return "";
    // Fast path: no "<" means no tags can be formed; entities like &lt;script&gt;
    // stay inert when rendered. Keep the bytes exactly.
    if (src.indexOf("<") === -1) return src;

    const extracted = extractCodeSlots(src);
    const sanitized = sanitizeMarkdownSegment(extracted.text);
    return restoreCodeSlots(sanitized, extracted.slots);
  }

  // Named presets for app.js (createBlockNode / Mermaid / KaTeX).
  const STRICT_OPTS = {
    allowSvg: false,
    allowMathMl: false,
    allowStyleTag: false,
    allowStyleAttr: false,
  };
  const RICH_OPTS = {
    allowSvg: true,
    allowMathMl: true,
    allowStyleTag: true,
    allowStyleAttr: true,
  };

  global.StuartCore = global.StuartCore || {};
  global.StuartCore.htmlSanitize = {
    sanitizeHtml,
    sanitizeUntrustedMarkdown,
    isSafeHref,
    escapeHtml,
    STRICT_OPTS,
    RICH_OPTS,
  };
})(typeof window !== "undefined" ? window : globalThis);
