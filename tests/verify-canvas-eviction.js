const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const edgePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const htmlPath = path.join(__dirname, "canvas_bench.html").replace(/\\/g, "/");
const userDataDir = path.join(__dirname, "edge_profile_canvas");

// Clean user data dir if exists
try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}

function getMsEdgeMemoryMB() {
  try {
    const out = execSync(
      'powershell -NoProfile -Command "Get-Process msedge -ErrorAction SilentlyContinue | Measure-Object -Property WorkingSet64 -Sum | Select-Object -ExpandProperty Sum"',
      { encoding: "utf8" }
    ).trim();
    if (out && !isNaN(out)) {
      return (Number(out) / 1024 / 1024).toFixed(2);
    }
  } catch (_) {}
  return "0.00";
}

async function main() {
  console.log("=== STARTING CANVAS GPU/MEMORY EVICTION VERIFICATION ===");
  const edgeProc = spawn(edgePath, [
    "--headless=new",
    "--remote-debugging-port=9334",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    `file:///${htmlPath}`
  ]);

  let cdpUrl = null;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      const res = await fetch("http://127.0.0.1:9334/json");
      const list = await res.json();
      const page = list.find((t) => t.type === "page");
      if (page && page.webSocketDebuggerUrl) {
        cdpUrl = page.webSocketDebuggerUrl;
        break;
      }
    } catch (_) {}
  }

  if (!cdpUrl) {
    console.error("Failed to connect to CDP");
    edgeProc.kill();
    process.exit(1);
  }

  const ws = new WebSocket(cdpUrl);
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));

  let reqId = 1;
  function sendCdp(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = reqId++;
      const handler = (evt) => {
        const msg = JSON.parse(evt.data);
        if (msg.id === id) {
          ws.removeEventListener("message", handler);
          if (msg.error) reject(msg.error);
          else resolve(msg.result);
        }
      };
      ws.addEventListener("message", handler);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  function evaluate(expr) {
    return sendCdp("Runtime.evaluate", { expression: expr, awaitPromise: true });
  }

  const memInitial = getMsEdgeMemoryMB();
  console.log(`[Step 1] Initial Edge Process Memory (RAM/WorkingSet): ${memInitial} MB`);

  // Allocate 50 large canvases (2000x2000 * 4 = 16MB each * 50 = 800MB raw pixels)
  console.log("[Step 2] Allocating 50 Canvases (2000x2000 each, red fill)...");
  await evaluate("window.allocateCanvases()");
  await new Promise((r) => setTimeout(r, 1500));
  const memAllocated = getMsEdgeMemoryMB();
  console.log(`[Step 2] Memory after allocating 50 Canvases: ${memAllocated} MB (Delta: +${(memAllocated - memInitial).toFixed(2)} MB)`);

  // Now evict with width=0; height=0; remove()
  console.log("[Step 3] Executing Eviction: c.width = 0; c.height = 0; c.remove()...");
  await evaluate("window.evictCanvasesZero()");
  await new Promise((r) => setTimeout(r, 1500));
  const memEvictedZero = getMsEdgeMemoryMB();
  console.log(`[Step 3] Memory immediately after zero-dimension eviction: ${memEvictedZero} MB (Delta vs peak: ${(memEvictedZero - memAllocated).toFixed(2)} MB)`);

  // Force garbage collection & purge via CDP
  console.log("[Step 4] Forcing CDP Memory Purge (Heap & GPU Garbage Collection)...");
  try {
    await sendCdp("HeapProfiler.collectGarbage");
    await sendCdp("Memory.forciblyPurgeJavaScriptMemory");
  } catch (_) {}
  await new Promise((r) => setTimeout(r, 1500));
  const memPurged = getMsEdgeMemoryMB();
  console.log(`[Step 4] Memory after GC & CDP Purge: ${memPurged} MB (Delta vs initial: +${(memPurged - memInitial).toFixed(2)} MB)`);

  ws.close();
  edgeProc.kill();

  console.log("\n=== VERIFICATION CONCLUSION ===");
  const memoryFreed = memAllocated - memEvictedZero;
  console.log(`Total Memory Freed by zeroing canvas width/height: ${memoryFreed.toFixed(2)} MB`);
  if (memoryFreed > 200) {
    console.log("CONFIRMED: Setting canvas.width=0; canvas.height=0; c.remove() DOES release backing store memory in Chromium/WebView2!");
  } else {
    console.log("WARNING: Memory was NOT substantially reclaimed!");
  }
}

main().catch(console.error);
