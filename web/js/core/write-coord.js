/**
 * StuartMD core — per-path write coordinator (pure, testable).
 * Host: window.StuartCore.writeCoord
 *
 * Serializes async write work per absolute path so autosave / manual save
 * cannot reorder on the same file. Generation tokens (nextSeq / isStale)
 * let callers drop results that were overtaken by a newer write.
 */
(function (global) {
  "use strict";

  /** path → tail of the promise chain (single-flight queue). */
  const queues = new Map();
  /** path → latest generation number. */
  const seqs = new Map();

  function normKey(path) {
    return String(path == null ? "" : path).replace(/\\/g, "/").toLowerCase();
  }

  /**
   * Next generation token for a path. Capture before enqueue; after the write
   * settles, isStale(path, seq) tells you whether a newer write superseded it.
   */
  function nextSeq(path) {
    const key = normKey(path);
    const n = (seqs.get(key) || 0) + 1;
    seqs.set(key, n);
    return n;
  }

  /** True when seq is no longer the latest generation for path. */
  function isStale(path, seq) {
    const key = normKey(path);
    if (seq == null) return true;
    return seq !== seqs.get(key);
  }

  /** Latest generation for path (0 if none issued yet). */
  function currentSeq(path) {
    return seqs.get(normKey(path)) || 0;
  }

  /**
   * Run fn after every previously enqueued fn for the same absolute path.
   * 调用者获得原始成功结果或错误，下一次写入继续按顺序执行。
   */
  function enqueue(path, fn) {
    const key = normKey(path);
    const prev = queues.get(key) || Promise.resolve();
    if (typeof fn !== "function") throw new TypeError("写入操作必须提供函数");
    // 前一次失败已交给对应调用者，本次操作仍按文件顺序执行。
    const next = prev.then(fn, fn);
    queues.set(key, next);
    next.then(
      () => {
        if (queues.get(key) === next) queues.delete(key);
      },
      () => {
        if (queues.get(key) === next) queues.delete(key);
      }
    );
    return next;
  }

  /** Test helper: drop all queues/tokens (not used by app code). */
  function reset() {
    queues.clear();
    seqs.clear();
  }

  async function flush() {
    while (queues.size) await Promise.all([...queues.values()]);
  }

  global.StuartCore = global.StuartCore || {};
  global.StuartCore.writeCoord = {
    enqueue,
    nextSeq,
    isStale,
    currentSeq,
    reset,
    flush,
  };
})(typeof window !== "undefined" ? window : globalThis);
