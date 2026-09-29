// Empirical verification of Tab State Desync & Save Race Conditions

let state = {
  activeTabId: "tab-1",
  path: "file1.md",
  name: "file1.md",
  content: "Version 1",
  dirty: false,
  tabs: [
    { id: "tab-1", name: "file1.md", path: "file1.md", content: "Version 1", dirty: false },
    { id: "tab-2", name: "file2.md", path: "file2.md", content: "Tab 2 Content", dirty: false }
  ]
};

let el = {
  source: { value: "Version 1" },
  dirtyDot: { hidden: true },
  fileTitle: { textContent: "file1.md" },
  statusPath: { textContent: "file1.md" }
};

function commitActiveBlockEdits() {}
function updateAutosaveStatus() {}
function renderTabs() {}
function updateWindowTitle() {}
function toast(msg) {}

// Simulated mock API with delay
let disk = {};
const mockApi = {
  async write_file(path, content, delayMs = 50) {
    await new Promise((r) => setTimeout(r, delayMs));
    disk[path] = content;
    return { ok: true, path };
  },
  async save_file_dialog(content, defaultName, delayMs = 50) {
    await new Promise((r) => setTimeout(r, delayMs));
    return { path: "C:\\saved\\as_new.md" };
  }
};

// Proposed Roadmap saveFile implementation (P0-4):
async function roadmapSaveFile(writeDelayMs = 50) {
  commitActiveBlockEdits();

  const targetTabId = state.activeTabId;
  const tab = state.tabs.find((t) => t.id === targetTabId);
  const targetPath = tab?.path || state.path;
  const content = el.source.value;

  if (targetPath) {
    const res = await mockApi.write_file(targetPath, content, writeDelayMs);
    if (res?.error) return;

    if (tab) {
      tab.content = content;
      tab.dirty = false;
      tab.path = targetPath;
    }

    if (state.activeTabId === targetTabId) {
      state.content = content;
      state.dirty = false;
      el.dirtyDot.hidden = true;
      updateWindowTitle();
    }
    updateAutosaveStatus();
    renderTabs();
  }
}

// Proposed Roadmap saveFileAs implementation (P0-4):
async function roadmapSaveFileAs(dialogDelayMs = 50) {
  commitActiveBlockEdits();

  const targetTabId = state.activeTabId;
  const content = el.source.value;
  const defaultName = state.name || "未命名.md";

  const res = await mockApi.save_file_dialog(content, defaultName, dialogDelayMs);
  if (!res || res.error) return;

  const newName = res.path.split(/[\\/]/).pop();

  // Lines 391-398 from roadmap: unconditional global state mutation!
  state.path = res.path;
  state.name = newName;
  state.content = content;
  state.dirty = false;
  el.dirtyDot.hidden = true;
  el.fileTitle.textContent = state.name;
  el.statusPath.textContent = res.path;

  const tab = state.tabs.find((t) => t.id === targetTabId);
  if (tab) {
    tab.path = res.path;
    tab.name = newName;
    tab.content = content;
    tab.dirty = false;
  }
}

async function testScenario1_DirtyFlagClearingRace() {
  console.log("--- TEST 1: Dirty Flag Clearing Race (Typing during save) ---");
  // Setup
  state.activeTabId = "tab-1";
  el.source.value = "Version 1";
  state.dirty = true;
  state.tabs[0].dirty = true;

  // Start save (takes 50ms)
  const savePromise = roadmapSaveFile(50);

  // User types "Version 2" at 10ms
  await new Promise((r) => setTimeout(r, 10));
  el.source.value = "Version 2 (Unsaved edits)";
  state.dirty = true;
  state.tabs[0].dirty = true;
  el.dirtyDot.hidden = false;

  // Wait for save to complete
  await savePromise;

  console.log("Editor value:", el.source.value);
  console.log("Tab 1 dirty:", state.tabs[0].dirty);
  console.log("Global state.dirty:", state.dirty);
  console.log("Dirty dot hidden:", el.dirtyDot.hidden);

  if (el.source.value === "Version 2 (Unsaved edits)" && state.dirty === false) {
    console.log("=> BUG CONFIRMED: Editor has unsaved changes, but dirty is FALSE! User edits will be silently lost on close.");
  } else {
    console.log("=> Safe.");
  }
}

async function testScenario2_SaveFileAsGlobalPollution() {
  console.log("\n--- TEST 2: saveFileAs Tab Switch Pollution ---");
  // Setup
  state.activeTabId = "tab-1";
  state.path = "file1.md";
  state.name = "file1.md";
  el.source.value = "Tab 1 Content";

  // Start Save As on Tab 1
  const saveAsPromise = roadmapSaveFileAs(50);

  // User switches to Tab 2 at 10ms
  await new Promise((r) => setTimeout(r, 10));
  state.activeTabId = "tab-2";
  state.path = "file2.md";
  state.name = "file2.md";
  el.source.value = "Tab 2 Content";
  el.fileTitle.textContent = "file2.md";
  el.statusPath.textContent = "file2.md";

  // Wait for Save As dialog to finish
  await saveAsPromise;

  console.log("Current activeTabId:", state.activeTabId);
  console.log("Current active tab title (el.fileTitle):", el.fileTitle.textContent);
  console.log("Current state.path:", state.path);
  console.log("Current state.name:", state.name);

  if (state.activeTabId === "tab-2" && (el.fileTitle.textContent === "as_new.md" || state.path.includes("as_new.md"))) {
    console.log("=> BUG CONFIRMED: Tab 2 UI and state were contaminated by Tab 1's Save As!");
  } else {
    console.log("=> Safe.");
  }
}

async function testScenario3_ConcurrentWriteReordering() {
  console.log("\n--- TEST 3: Concurrent Write Reordering Race ---");
  disk["doc.md"] = "initial";

  // Simulate two saves without locking: Save 1 (delay 100ms), Save 2 (delay 20ms)
  // Save 1 launched at t=0
  el.source.value = "Edit V1";
  const p1 = mockApi.write_file("doc.md", el.source.value, 100);

  // User types V2 and saves at t=10ms
  el.source.value = "Edit V2";
  const p2 = mockApi.write_file("doc.md", el.source.value, 20);

  await Promise.all([p1, p2]);

  console.log("Final disk content:", disk["doc.md"]);
  if (disk["doc.md"] === "Edit V1") {
    console.log("=> BUG CONFIRMED: Out-of-order write! Older save overwrote newer save!");
  } else {
    console.log("=> Safe.");
  }
}

(async () => {
  await testScenario1_DirtyFlagClearingRace();
  await testScenario2_SaveFileAsGlobalPollution();
  await testScenario3_ConcurrentWriteReordering();
})();
