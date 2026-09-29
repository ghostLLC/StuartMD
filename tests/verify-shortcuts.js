// Empirical verification of Shortcut Normalization (R4 / P0-5)

function createShortcutHandler(isMac = false) {
  let undoCount = 0;
  let redoCount = 0;
  let boldCount = 0;

  function undoEdit() { undoCount++; return true; }
  function redoEdit() { redoCount++; return true; }
  function formatSelection(fmt) { if (fmt === "bold") boldCount++; }
  function toast(msg) {}

  // Roadmap P0-5 implementation:
  function roadmapHandler(e) {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (!mod) return;

    const key = e.key.toLowerCase();

    if (key === "z") {
      e.preventDefault();
      if (e.shiftKey) {
        if (!redoEdit()) toast("没有可重做的操作");
      } else {
        if (!undoEdit()) toast("没有可撤销的操作");
      }
      return;
    }

    if (key === "y" && !isMac) {
      e.preventDefault();
      if (!redoEdit()) toast("没有可重做的操作");
      return;
    }

    if (key === "b") {
      // Bold formatting
    }
  }

  return {
    dispatch: roadmapHandler,
    getCounts: () => ({ undoCount, redoCount, boldCount })
  };
}

console.log("=== VERIFYING SHORTCUT NORMALIZATION ===");

// 1. Windows: Ctrl+Shift+Z -> Redo
{
  const win = createShortcutHandler(false);
  let prevented = false;
  win.dispatch({
    ctrlKey: true,
    metaKey: false,
    shiftKey: true,
    key: "z",
    preventDefault: () => { prevented = true; }
  });
  console.log("Windows Ctrl+Shift+Z -> Redo count:", win.getCounts().redoCount, "Prevented:", prevented);
  console.assert(win.getCounts().redoCount === 1, "Windows Ctrl+Shift+Z must trigger Redo");
}

// 2. Windows: Ctrl+Y -> Redo
{
  const win = createShortcutHandler(false);
  let prevented = false;
  win.dispatch({
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    key: "y",
    preventDefault: () => { prevented = true; }
  });
  console.log("Windows Ctrl+Y -> Redo count:", win.getCounts().redoCount, "Prevented:", prevented);
  console.assert(win.getCounts().redoCount === 1, "Windows Ctrl+Y must trigger Redo");
}

// 3. macOS: Meta+Shift+Z (Cmd+Shift+Z) -> Redo
{
  const mac = createShortcutHandler(true);
  let prevented = false;
  mac.dispatch({
    ctrlKey: false,
    metaKey: true,
    shiftKey: true,
    key: "z",
    preventDefault: () => { prevented = true; }
  });
  console.log("macOS Meta+Shift+Z -> Redo count:", mac.getCounts().redoCount, "Prevented:", prevented);
  console.assert(mac.getCounts().redoCount === 1, "macOS Meta+Shift+Z must trigger Redo");
}

// 4. macOS: Meta+Y -> Should NOT trigger Redo (reserved for History / system)
{
  const mac = createShortcutHandler(true);
  let prevented = false;
  mac.dispatch({
    ctrlKey: false,
    metaKey: true,
    shiftKey: false,
    key: "y",
    preventDefault: () => { prevented = true; }
  });
  console.log("macOS Meta+Y -> Redo count:", mac.getCounts().redoCount, "Prevented:", prevented);
  console.assert(win = mac.getCounts().redoCount === 0 && !prevented, "macOS Meta+Y must NOT trigger Redo");
}

// 5. Input Field Collision Hazard
console.log("\n--- Testing Native Input Field Collision Hazard ---");
{
  const win = createShortcutHandler(false);
  let defaultPrevented = false;
  // User typing in search input field
  const fakeEvent = {
    target: { tagName: "INPUT", id: "search-input" },
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    key: "z",
    preventDefault: () => { defaultPrevented = true; }
  };
  win.dispatch(fakeEvent);
  console.log("Typing in <input> and pressing Ctrl+Z: defaultPrevented =", defaultPrevented, "UndoEdit called =", win.getCounts().undoCount);
  if (defaultPrevented && win.getCounts().undoCount === 1) {
    console.log("=> CRITICAL UX BUG FOUND: Roadmap shortcut handler hijacks Ctrl+Z inside native text inputs (<input>, <textarea>, AI chat)! Native input undo is broken.");
  }
}
