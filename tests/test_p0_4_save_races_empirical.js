// Empirical Verification for P0-4 (Save Races & tab.rev Generational Token)
const assert = require("assert");

console.log("============================================================");
console.log(">>> TARGET 2: P0-4 (Save Races & tab.rev Generational Token)");
console.log("============================================================\n");

function createMockEnvironment() {
  const disk = {};
  let writeCallCount = 0;

  const mockApi = {
    async write_file(path, content, delayMs = 30) {
      writeCallCount++;
      await new Promise((r) => setTimeout(r, delayMs));
      disk[path] = content;
      return { ok: true, path };
    }
  };

  const el = {
    source: { value: "Initial text" },
    dirtyDot: { hidden: true },
    fileTitle: { textContent: "file1.md" }
  };

  const state = {
    apiReady: true,
    activeTabId: "tab-1",
    path: "C:\\docs\\file1.md",
    name: "file1.md",
    content: "Initial text",
    dirty: false,
    autosaveEnabled: true,
    lastAutosaveAt: 0,
    tabs: [
      { id: "tab-1", path: "C:\\docs\\file1.md", name: "file1.md", content: "Initial text", dirty: false, rev: 0 },
      { id: "tab-2", path: "C:\\docs\\file2.md", name: "file2.md", content: "Tab 2 content", dirty: false, rev: 0 }
    ]
  };

  function commitActiveBlockEdits() {}
  function updateAutosaveStatus() {}
  function renderTabs() {}
  function updateWindowTitle() {}
  function toast(msg) {}

  function markDirty() {
    state.dirty = true;
    el.dirtyDot.hidden = false;
    const tab = state.tabs.find((t) => t.id === state.activeTabId);
    if (tab) {
      tab.dirty = true;
      tab.rev = (tab.rev || 0) + 1;
    }
  }

  // Exact implementation from app.js:3285
  async function saveFile(customDelay = 30) {
    if (!state.apiReady) return;
    commitActiveBlockEdits();

    const targetTabId = state.activeTabId;
    const tab = state.tabs.find((t) => t.id === targetTabId);
    const targetPath = tab?.path || state.path;
    const contentToSave = el.source.value;
    const saveRev = tab ? (tab.rev || 0) : 0;

    if (targetPath) {
      const res = await mockApi.write_file(targetPath, contentToSave, customDelay);
      if (res?.error) {
        toast("保存失败: " + res.error);
        return;
      }

      if (tab) {
        tab.path = targetPath;
        if (tab.rev === saveRev) {
          tab.content = contentToSave;
          tab.dirty = false;
        } else {
          // Generational token mismatch: user edited document while save was in flight!
        }
      }

      if (state.activeTabId === targetTabId) {
        if (tab && tab.dirty === false) {
          state.dirty = false;
          el.dirtyDot.hidden = true;
        }
        state.content = tab ? tab.content : contentToSave;
        updateWindowTitle();
      }

      updateAutosaveStatus();
      renderTabs();
    }
  }

  // Exact implementation from app.js:2562
  async function doAutoSave(customDelay = 30) {
    if (!state.autosaveEnabled || !state.path || !state.dirty) return;
    if (String(state.path).toLowerCase().endsWith(".pdf")) return;
    if (!state.apiReady || !mockApi.write_file) return;
    try {
      const path = state.path;
      const tabId = state.activeTabId;
      const content = el.source.value;
      const res = await mockApi.write_file(path, content, customDelay);
      if (res?.error) return;
      if (state.path !== path) return;
      state.content = content;
      state.lastAutosaveAt = Date.now();
      if (el.source.value === content) {
        state.dirty = false;
        el.dirtyDot.hidden = true;
        const tab = state.tabs.find((t) => t.id === tabId && t.path === path);
        if (tab) tab.dirty = false;
        updateWindowTitle();
      }
      updateAutosaveStatus();
    } catch (_) {}
  }

  return { state, el, mockApi, disk, markDirty, saveFile, doAutoSave };
}

async function testScenario1_CleanSave() {
  console.log("[Test 1] Clean Save (No edits during save)...");
  const env = createMockEnvironment();
  env.el.source.value = "Modified clean";
  env.markDirty();

  assert.strictEqual(env.state.dirty, true);
  assert.strictEqual(env.state.tabs[0].dirty, true);
  assert.strictEqual(env.state.tabs[0].rev, 1);
  assert.strictEqual(env.el.dirtyDot.hidden, false);

  await env.saveFile(20);

  assert.strictEqual(env.state.tabs[0].dirty, false, "Tab 1 dirty should be cleared");
  assert.strictEqual(env.state.dirty, false, "Global dirty should be cleared");
  assert.strictEqual(env.el.dirtyDot.hidden, true, "Dirty dot should be hidden");
  assert.strictEqual(env.disk["C:\\docs\\file1.md"], "Modified clean");
  console.log("  -> PASS: Clean save successfully cleared dirty flag and persisted data.");
}

async function testScenario2_TypingDuringSaveInFlight() {
  console.log("\n[Test 2] Adversarial: Concurrent typing while async save is in-flight...");
  const env = createMockEnvironment();

  // Initial modification
  env.el.source.value = "Version A";
  env.markDirty();
  assert.strictEqual(env.state.tabs[0].rev, 1);

  // Trigger save with 60ms simulated async I/O delay
  const savePromise = env.saveFile(60);

  // At t=20ms (while save is in-flight), user continues typing "Version B"
  await new Promise((r) => setTimeout(r, 20));
  env.el.source.value = "Version B (Fresh typing in-flight)";
  env.markDirty(); // tab.rev increments to 2!
  assert.strictEqual(env.state.tabs[0].rev, 2);
  assert.strictEqual(env.state.dirty, true);
  assert.strictEqual(env.el.dirtyDot.hidden, false);

  // Wait for the t=0 save to complete
  await savePromise;

  // VERIFY CRITICAL INVARIANT:
  // tab.rev (2) !== saveRev (1).
  // The tab MUST REMAIN DIRTY! Global dirty flag MUST NOT BE CLEARED!
  console.log("  Editor value:", env.el.source.value);
  console.log("  Tab 1 rev:", env.state.tabs[0].rev);
  console.log("  Tab 1 dirty:", env.state.tabs[0].dirty);
  console.log("  Global state.dirty:", env.state.dirty);
  console.log("  Dirty dot hidden:", env.el.dirtyDot.hidden);

  assert.strictEqual(
    env.state.tabs[0].dirty,
    true,
    "CRITICAL BUG: tab.dirty was prematurely cleared despite concurrent edits!"
  );
  assert.strictEqual(
    env.state.dirty,
    true,
    "CRITICAL BUG: state.dirty was prematurely cleared! User edits would be lost!"
  );
  assert.strictEqual(
    env.el.dirtyDot.hidden,
    false,
    "CRITICAL BUG: dirty dot was prematurely hidden!"
  );

  console.log("  -> PASS: tab.rev successfully prevented premature clearing of dirty state!");

  // Now perform a subsequent save for Version B
  await env.saveFile(20);
  assert.strictEqual(env.state.tabs[0].dirty, false);
  assert.strictEqual(env.state.dirty, false);
  assert.strictEqual(env.disk["C:\\docs\\file1.md"], "Version B (Fresh typing in-flight)");
  console.log("  -> PASS: Subsequent save cleanly persisted latest revision and cleared dirty state.");
}

async function testScenario3_TabSwitchingDuringSave() {
  console.log("\n[Test 3] Adversarial: Tab switching while save is in-flight...");
  const env = createMockEnvironment();

  // Tab 1 is active, modify it
  env.el.source.value = "Tab 1 Content";
  env.markDirty();

  // Start save on Tab 1 (60ms)
  const savePromise = env.saveFile(60);

  // At t=20ms, user switches to Tab 2
  await new Promise((r) => setTimeout(r, 20));
  env.state.activeTabId = "tab-2";
  env.state.path = "C:\\docs\\file2.md";
  env.state.name = "file2.md";
  env.state.content = "Tab 2 Content";
  env.el.source.value = "Tab 2 Content";
  env.state.dirty = false;
  env.el.dirtyDot.hidden = true;

  // Wait for Tab 1 save to complete
  await savePromise;

  // Tab 1 on disk should be updated
  assert.strictEqual(env.disk["C:\\docs\\file1.md"], "Tab 1 Content");
  // Tab 1 state should have dirty = false
  assert.strictEqual(env.state.tabs[0].dirty, false);

  // Active tab is still Tab 2; its UI and dirty state MUST NOT BE CLOBBERED
  assert.strictEqual(env.state.activeTabId, "tab-2");
  assert.strictEqual(env.state.dirty, false);
  assert.strictEqual(env.el.source.value, "Tab 2 Content");
  assert.strictEqual(env.state.content, "Tab 2 Content");

  console.log("  -> PASS: Tab 1 save completed without clobbering active Tab 2 state or UI.");
}

async function testScenario4_AutoSaveTypingRace() {
  console.log("\n[Test 4] Adversarial: Typing during doAutoSave()...");
  const env = createMockEnvironment();

  env.el.source.value = "Autosave V1";
  env.markDirty();

  // Trigger autosave (60ms)
  const autoSavePromise = env.doAutoSave(60);

  // User types more text at t=20ms
  await new Promise((r) => setTimeout(r, 20));
  env.el.source.value = "Autosave V2 (typed while autosaving)";
  env.markDirty();

  await autoSavePromise;

  // el.source.value !== content, so dirty flag must NOT be cleared
  assert.strictEqual(env.state.dirty, true, "Autosave prematurely cleared state.dirty!");
  assert.strictEqual(env.state.tabs[0].dirty, true, "Autosave prematurely cleared tab.dirty!");
  assert.strictEqual(env.el.dirtyDot.hidden, false, "Autosave prematurely hid dirty dot!");

  console.log("  -> PASS: doAutoSave correctly avoided clearing dirty state when text was edited.");
}

async function testScenario5_RapidConcurrentSaves() {
  console.log("\n[Test 5] Adversarial: Multiple rapid saves with interleaved edits...");
  const env = createMockEnvironment();

  // 10 interleaved rapid edits and saves
  for (let i = 1; i <= 5; i++) {
    env.el.source.value = `Revision ${i}`;
    env.markDirty();
    // Fire save asynchronously with varying network/disk delay
    const delay = 10 + (i % 3) * 15;
    env.saveFile(delay);
  }

  // Type final unsaved change
  env.el.source.value = "Final un-saved revision 6";
  env.markDirty();

  // Wait for all in-flight saves to settle
  await new Promise((r) => setTimeout(r, 150));

  // The final change was NEVER saved by a matching rev save, so it MUST STILL BE DIRTY
  assert.strictEqual(env.state.tabs[0].dirty, true);
  assert.strictEqual(env.state.dirty, true);
  assert.strictEqual(env.el.dirtyDot.hidden, false);

  console.log("  -> PASS: Interleaved rapid saves maintained strict dirty integrity for unsaved edits.");
}

(async () => {
  try {
    await testScenario1_CleanSave();
    await testScenario2_TypingDuringSaveInFlight();
    await testScenario3_TabSwitchingDuringSave();
    await testScenario4_AutoSaveTypingRace();
    await testScenario5_RapidConcurrentSaves();

    console.log("\n############################################################");
    console.log("# P0-4 TAB.REV SAVE RACE VERIFICATION: ALL 5 SUITES PASSED  #");
    console.log("############################################################");
  } catch (err) {
    console.error("\n[-] TEST FAILED WITH ASSERTION ERROR:", err);
    process.exit(1);
  }
})();
