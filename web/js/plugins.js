/* StuartMD plugin loader — consent-gated, capability-limited execution.
 *
 * loadAll() only discovers plugins and records consent status. It never
 * executes plugin code. Execution happens solely in enablePlugin() and only
 * after a stored consent hash (sha256 of the current source) matches.
 *
 * Plugins receive a frozen StuartPlugin capability object. Host globals
 * (window / document / __TAURI__ / pywebview / eval / Function / network)
 * are shadowed with frozen or undefined stand-ins.
 */
(function () {
  "use strict";

  const CONSENT_LS_KEY = "StuartMD-plugin-consent";
  const CONSENT_SETTINGS_KEY = "plugin_consent";
  const MAX_SOURCE_CHARS = 512 * 1024;
  const MAX_STYLE_CHARS = 256 * 1024;
  const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
  const RESERVED_TOOLS = new Set([
    "get_document",
    "set_document",
    "get_outline",
    "memory_get",
    "memory_set",
    "search_workspace",
  ]);
  const TOOL_DEF_KEYS = new Set(["name", "description", "run", "source"]);

  const discovered = new Map(); // id -> discovery entry
  const loaded = new Map(); // id -> entry, only after enablePlugin()
  const styleEls = new Map(); // id -> [HTMLStyleElement]

  /** Frozen inert stand-in for host globals. */
  const SANDBOX = Object.freeze(Object.create(null));

  /** Parameter names shadowed inside plugin bodies (null-proto / undefined). */
  const SHADOW_PARAMS = [
    "window",
    "document",
    "globalThis",
    "self",
    "top",
    "parent",
    "frames",
    "eval",
    "Function",
    "require",
    "process",
    "module",
    "exports",
    "fetch",
    "XMLHttpRequest",
    "WebSocket",
    "EventSource",
    "Worker",
    "SharedWorker",
    "importScripts",
    "__TAURI__",
    "pywebview",
    "StuartPlugin",
  ];
  const SHADOW_OBJECT_PARAMS = new Set([
    "window",
    "document",
    "globalThis",
    "self",
    "top",
    "parent",
    "frames",
    "StuartPlugin",
  ]);

  // ----- sha256 (pure JS: works without a secure context) -----

  function utf8Bytes(str) {
    const out = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        const c2 = str.charCodeAt(++i);
        const u = 0x10000 + (((c & 0x3ff) << 10) | (c2 & 0x3ff));
        out.push(
          0xf0 | (u >> 18),
          0x80 | ((u >> 12) & 63),
          0x80 | ((u >> 6) & 63),
          0x80 | (u & 63)
        );
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
    }
    return out;
  }

  const SHA_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  function sha256Hex(str) {
    const bytes = utf8Bytes(String(str));
    const bitLen = bytes.length * 8;
    const data = bytes.slice();
    data.push(0x80);
    while (data.length % 64 !== 56) data.push(0);
    const hi = Math.floor(bitLen / 0x100000000);
    const lo = bitLen >>> 0;
    data.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255);
    data.push((lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);

    const H = [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];
    const w = new Array(64);
    for (let i = 0; i < data.length; i += 64) {
      for (let j = 0; j < 16; j++) {
        const o = i + j * 4;
        w[j] =
          (data[o] << 24) | (data[o + 1] << 16) | (data[o + 2] << 8) | data[o + 3];
      }
      for (let j = 16; j < 64; j++) {
        const s0 =
          ((w[j - 15] >>> 7) | (w[j - 15] << 25)) ^
          ((w[j - 15] >>> 18) | (w[j - 15] << 14)) ^
          (w[j - 15] >>> 3);
        const s1 =
          ((w[j - 2] >>> 17) | (w[j - 2] << 15)) ^
          ((w[j - 2] >>> 19) | (w[j - 2] << 13)) ^
          (w[j - 2] >>> 10);
        w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0;
      }
      let a = H[0], b = H[1], c = H[2], d = H[3];
      let e = H[4], f = H[5], g = H[6], h = H[7];
      for (let j = 0; j < 64; j++) {
        const S1 =
          ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + SHA_K[j] + w[j]) | 0;
        const S0 =
          ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) | 0;
        h = g;
        g = f;
        f = e;
        e = (d + t1) | 0;
        d = c;
        c = b;
        b = a;
        a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0;
      H[1] = (H[1] + b) | 0;
      H[2] = (H[2] + c) | 0;
      H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0;
      H[5] = (H[5] + f) | 0;
      H[6] = (H[6] + g) | 0;
      H[7] = (H[7] + h) | 0;
    }
    return H.map((x) => (x >>> 0).toString(16).padStart(8, "0")).join("");
  }

  // ----- consent store (settings.json + localStorage mirror) -----

  let consentCache = Object.create(null);

  function readConsentLocal() {
    try {
      const raw = localStorage.getItem(CONSENT_LS_KEY);
      const obj = raw ? JSON.parse(raw) : null;
      return obj && typeof obj === "object" ? obj : Object.create(null);
    } catch (_) {
      return Object.create(null);
    }
  }

  function writeConsentLocal(map) {
    try {
      localStorage.setItem(CONSENT_LS_KEY, JSON.stringify(map));
    } catch (_) {}
  }

  async function loadConsent() {
    const merged = Object.assign(Object.create(null), readConsentLocal());
    try {
      const api = window.pywebview && window.pywebview.api;
      if (api && api.get_settings) {
        const s = await api.get_settings();
        const stored = s && s[CONSENT_SETTINGS_KEY];
        if (stored && typeof stored === "object") {
          for (const k of Object.keys(stored)) {
            if (typeof stored[k] === "string") merged[k] = stored[k];
          }
        }
      }
    } catch (_) {}
    consentCache = merged;
    writeConsentLocal(merged);
    return merged;
  }

  async function persistConsent(map) {
    consentCache = map;
    writeConsentLocal(map);
    try {
      const api = window.pywebview && window.pywebview.api;
      if (api && api.save_settings) {
        await api.save_settings({ [CONSENT_SETTINGS_KEY]: map });
      }
    } catch (_) {}
  }

  function getConsentHash(id) {
    return consentCache[id] || readConsentLocal()[id] || null;
  }

  // ----- per-plugin frozen capability object -----

  function makePluginApi(id) {
    const styleList = styleEls.get(id) || [];

    const api = {
      id: String(id),
      /** Inject a CSS stylesheet scoped to this plugin. */
      addStyle(css) {
        const text = String(css == null ? "" : css);
        if (!text) return { ok: false, error: "empty css" };
        if (text.length > MAX_STYLE_CHARS) {
          return { ok: false, error: "css too large" };
        }
        const el = document.createElement("style");
        el.setAttribute("data-stuart-plugin", String(id));
        el.textContent = text;
        document.head.appendChild(el);
        styleList.push(el);
        styleEls.set(id, styleList);
        return { ok: true };
      },
      /** Prefixed console log. */
      log(...args) {
        try {
          console.log(`[plugin:${id}]`, ...args);
        } catch (_) {}
      },
      /**
       * Markdown-it hook (backward compat). `fn` receives the app's
       * markdown-it instance when the renderer is created.
       */
      registerMarkdownIt(fn) {
        if (typeof fn !== "function") return { ok: false, error: "fn required" };
        try {
          if (window.__stuartMd) fn(window.__stuartMd);
          else {
            window.__stuartMdHooks = (window.__stuartMdHooks || []).concat(fn);
          }
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e && e.message ? e.message : String(e) };
        }
      },
      /**
       * Register an AI tool. `def` fields are allowlisted to
       * name / description / run. Names must match [a-z][a-z0-9_]{0,63}
       * and must not collide with built-in tools.
       */
      registerTool(def) {
        if (!def || typeof def !== "object") return { error: "tool def required" };
        for (const k of Object.keys(def)) {
          if (!TOOL_DEF_KEYS.has(k)) {
            return { error: "tool field not allowed: " + k };
          }
        }
        const name = String(def.name || "");
        if (!TOOL_NAME_RE.test(name)) return { error: "invalid tool name" };
        if (RESERVED_TOOLS.has(name)) return { error: "reserved tool name: " + name };
        if (typeof def.run !== "function") return { error: "tool run must be a function" };
        const description = String(def.description || "").slice(0, 500);
        const host = window.StuartAgent || window.Stuart;
        if (!host || typeof host.registerTool !== "function") {
          return { error: "agent api missing" };
        }
        return host.registerTool({
          name,
          description,
          run: def.run,
          source: "plugin:" + id,
        });
      },
    };
    return Object.freeze(api);
  }

  /** Legacy shared surface (host-side callers only; not given to plugins). */
  const legacyApi = makePluginApi("host");

  // ----- execution -----

  function executePlugin(entry) {
    const api = makePluginApi(entry.id);
    // Outer wrapper stays non-strict so `eval` / `Function` may be parameter
    // names; the inner strict function sees only the shadowed bindings.
    const params = SHADOW_PARAMS.join(", ");
    const args = SHADOW_PARAMS.map((name) => {
      if (SHADOW_OBJECT_PARAMS.has(name)) {
        return name === "StuartPlugin" ? api : SANDBOX;
      }
      return undefined;
    });
    const body =
      "return (function () {\n\"use strict\";\n" +
      entry.source +
      "\n}).call(undefined);";
    // eslint-disable-next-line no-new-func
    const fn = new Function(params, body);
    fn(...args);
  }

  function publicEntry(entry) {
    return {
      id: entry.id,
      name: entry.name,
      path: entry.path,
      enabled: entry.enabled,
      hash: entry.hash,
      consent: entry.consent,
      pending_consent: !!entry.pending_consent,
      status: entry.status,
      loaded: loaded.has(entry.id),
    };
  }

  async function ensureDiscovered(name) {
    const id = String(name || "");
    if (discovered.has(id)) return discovered.get(id);
    await loadAll();
    return discovered.get(id) || null;
  }

  /**
   * Discover plugins. Never executes plugin code.
   * Entries with `pending_consent: true` need consentPlugin() before enable.
   */
  async function loadAll() {
    discovered.clear();
    const bridge = window.pywebview && window.pywebview.api;
    if (!bridge || !bridge.list_plugins) return [];
    try {
      const res = await bridge.list_plugins();
      const list = (res && res.plugins) || [];
      const consent = await loadConsent();
      const out = [];
      for (const p of list) {
        const id = String(p.id || p.name || p.path || "");
        if (!id) continue;
        const entry = {
          id,
          name: p.name || id,
          path: p.path || "",
          enabled: !!p.enabled,
          source: "",
          hash: "",
          consent: typeof consent[id] === "string" ? consent[id] : null,
          pending_consent: false,
          status: "unknown",
        };
        try {
          const src = entry.path ? await bridge.read_plugin_source(entry.path) : null;
          if (src && !src.error && src.source != null) {
            entry.source = String(src.source).slice(0, MAX_SOURCE_CHARS);
            entry.hash = sha256Hex(entry.source);
          }
        } catch (_) {}
        if (!entry.enabled) {
          entry.status = "disabled";
        } else if (!entry.hash) {
          entry.status = "error";
        } else if (entry.consent && entry.consent === entry.hash) {
          entry.status = "ready";
        } else {
          entry.pending_consent = true;
          entry.status = "pending_consent";
        }
        discovered.set(id, entry);
        out.push(publicEntry(entry));
      }
      return out;
    } catch (_) {
      return [];
    }
  }

  /**
   * Execute a plugin. Requires (1) enabled in settings and (2) a stored
   * consent hash matching sha256 of the current source. Otherwise the
   * entry is left with `pending_consent: true` and nothing runs.
   */
  async function enablePlugin(name) {
    const entry = await ensureDiscovered(name);
    if (!entry) return { error: "plugin not found", name: String(name || "") };
    const id = entry.id;
    if (!entry.enabled) return { error: "plugin disabled in settings", id };
    if (loaded.has(id)) return { ok: true, id, already: true };
    if (!entry.source || !entry.hash) return { error: "plugin source unavailable", id };
    const consented = getConsentHash(id);
    if (!consented || consented !== entry.hash) {
      entry.pending_consent = true;
      entry.status = "pending_consent";
      return { ok: false, id, pending_consent: true, hash: entry.hash };
    }
    try {
      executePlugin(entry);
      loaded.set(id, entry);
      entry.status = "loaded";
      entry.pending_consent = false;
      return { ok: true, id };
    } catch (e) {
      return {
        error: "plugin execution failed: " + (e && e.message ? e.message : String(e)),
        id,
      };
    }
  }

  /**
   * Record user consent for the current plugin source (sha256). Does not
   * execute; call enablePlugin() afterwards (or use consentAndEnable).
   */
  async function consentPlugin(name) {
    const entry = await ensureDiscovered(name);
    if (!entry) return { error: "plugin not found", name: String(name || "") };
    if (!entry.hash) return { error: "plugin source unavailable", id: entry.id };
    const map = Object.assign(Object.create(null), readConsentLocal(), consentCache);
    map[entry.id] = entry.hash;
    await persistConsent(map);
    entry.consent = entry.hash;
    entry.pending_consent = false;
    if (entry.enabled) entry.status = "ready";
    return { ok: true, id: entry.id, hash: entry.hash };
  }

  /** Consent to the current source and immediately enable. */
  async function consentAndEnable(name) {
    const c = await consentPlugin(name);
    if (c && c.error) return c;
    return enablePlugin(name);
  }

  /** Drop stored consent for a plugin (source changes will also invalidate). */
  async function revokeConsent(name) {
    const entry = await ensureDiscovered(name);
    const id = entry ? entry.id : String(name || "");
    const map = Object.assign(Object.create(null), readConsentLocal(), consentCache);
    delete map[id];
    await persistConsent(map);
    if (entry) {
      entry.consent = null;
      entry.pending_consent = entry.enabled;
      if (entry.enabled) entry.status = "pending_consent";
    }
    return { ok: true, id };
  }

  /**
   * Unload an already-executed plugin's injected styles. Markdown hooks and
   * tools cannot be removed once registered — revoke consent and reload to
   * fully reset them.
   */
  function disablePlugin(name) {
    const id = String(name || "");
    const els = styleEls.get(id) || [];
    for (const el of els) {
      try {
        el.remove();
      } catch (_) {}
    }
    styleEls.delete(id);
    loaded.delete(id);
    const entry = discovered.get(id);
    if (entry) {
      entry.status = entry.enabled
        ? entry.consent && entry.consent === entry.hash
          ? "ready"
          : "pending_consent"
        : "disabled";
    }
    return { ok: true, id };
  }

  window.StuartPlugins = {
    // discovery only — never executes
    loadAll,
    list: () => [...discovered.values()].map(publicEntry),
    pending: () =>
      [...discovered.values()].filter((e) => e.pending_consent).map(publicEntry),
    // explicit execution path
    enablePlugin,
    consentPlugin,
    consentAndEnable,
    revokeConsent,
    disablePlugin,
    // internals
    sha256Hex,
    loaded,
    discovered,
    api: legacyApi,
  };
})();
