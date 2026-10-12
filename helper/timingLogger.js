const fs = require("fs");
const path = require("path");
const { AsyncLocalStorage } = require("async_hooks");

// Per-run timing log: one line per step, tagged with the SKU being processed,
// so a slow run can be read back as "where did the time go for SKU123".
//
//   2026-10-12 15:42:07.123 | SKU123 | Search page fetch (Nahdi) started
//   2026-10-12 15:42:09.456 | SKU123 | Search page fetch (Nahdi) ended in 2.33s — 412 KB
//
// The current run (log file + SKU) lives in AsyncLocalStorage rather than a
// module global, so two runs started by two overlapping requests each write to
// their own file, and helpers deep in the fetch path (httpClient retries, etc.)
// can log against the right SKU without it being threaded through every call.
// Outside a run every function here is a no-op.

const storage = new AsyncLocalStorage();

const LOG_DIR = path.join(__dirname, "..", "logs");

function pad(n, width = 2) {
  return String(n).padStart(width, "0");
}

function timestamp(date = new Date()) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
  );
}

function formatDuration(ms) {
  // 59995ms and up would print "60.00s" at two decimals, so it takes the
  // minutes form.
  if (ms < 59995) return `${(ms / 1000).toFixed(2)}s`;
  // Round once, to tenths, before splitting into minutes and seconds —
  // rounding only the seconds part printed 119960ms as "1m 60.0s".
  const tenths = Math.round(ms / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = ((tenths % 600) / 10).toFixed(1);
  return `${minutes}m ${seconds}s`;
}

function write(store, sku, message) {
  try {
    fs.appendFileSync(store.file, `${timestamp()} | ${sku || "-"} | ${message}\n`, "utf8");
  } catch (err) {
    // Timing is diagnostics — never let it break a matching run.
    console.error("timing log write failed:", err.message);
  }
}

// The current run's store, or null outside a run / before startRun().
function activeStore() {
  const store = storage.getStore();
  return store && store.file ? store : null;
}

// Builds a path under logs/ for a run's timing file.
function timingLogPath(name) {
  return path.join(LOG_DIR, `timing_${name.replace(/[^\w.-]+/g, "_")}.log`);
}

// Gives `fn` (and everything it awaits) its own timing context. Wrap each
// run's entry point in this; the log file itself is named later by startRun(),
// once the run knows enough (brand, project) to name it. A run that throws is
// closed out here so its log still ends with a "Run ended" line.
function withTimingContext(fn) {
  return storage.run({ file: null, startedAt: null, sku: null, skuStartedAt: null }, async () => {
    try {
      return await fn();
    } catch (err) {
      endRun(`aborted: ${err.message}`);
      throw err;
    }
  });
}

// Points the current context at `file` and opens the run.
function startRun(file, description) {
  const store = storage.getStore();
  if (!store) return null;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  store.file = file;
  store.startedAt = Date.now();

  write(store, null, `Run started${description ? ` — ${description}` : ""}`);
  return file;
}

function endSku(store) {
  if (!store.sku) return;
  write(store, store.sku, `Processing ended in ${formatDuration(Date.now() - store.skuStartedAt)}`);
  store.sku = null;
  store.skuStartedAt = null;
}

// Switches the run to `sku`, closing out the previous SKU's total. A retry of
// the same SKU is logged as a fresh attempt, so each attempt gets its own total.
// Mutating the store is safe: a run processes its SKUs one at a time.
function beginSku(sku, note) {
  const store = activeStore();
  if (!store) return;

  endSku(store);

  store.sku = String(sku);
  store.skuStartedAt = Date.now();

  write(store, store.sku, `Processing started${note ? ` (${note})` : ""}`);
}

function endRun(note) {
  const store = activeStore();
  if (!store) return;

  endSku(store);
  write(store, null, `Run ended in ${formatDuration(Date.now() - store.startedAt)}${note ? ` — ${note}` : ""}`);

  // Closed: anything after this (e.g. a failed report email landing in the
  // caller's catch) must not reopen the log or end the run a second time.
  store.file = null;
}

// A single point-in-time line, e.g. "18 product link(s) extracted".
function logEvent(message) {
  const store = activeStore();
  if (!store) return;
  write(store, store.sku, message);
}

// Times `fn`, logging "<label> started" / "<label> ended in Xs" (or "failed
// after Xs"). Rethrows, so callers keep their own error handling.
//   detail    -> appended to the started line (a URL, a batch size, ...)
//   summarize -> result => string, appended to the ended line
async function step(label, fn, { detail, summarize } = {}) {
  const store = activeStore();
  if (!store) return fn();

  const sku = store.sku;
  const startedAt = Date.now();
  write(store, sku, `${label} started${detail ? ` — ${detail}` : ""}`);

  try {
    const result = await fn();
    let summary = "";
    if (summarize) {
      try {
        summary = summarize(result);
      } catch (_) {
        // A summary is decoration; a bad one shouldn't fail the step.
      }
    }
    write(store, sku, `${label} ended in ${formatDuration(Date.now() - startedAt)}${summary ? ` — ${summary}` : ""}`);
    return result;
  } catch (err) {
    write(store, sku, `${label} failed after ${formatDuration(Date.now() - startedAt)} — ${err.message}`);
    throw err;
  }
}

function currentLogFile() {
  const store = activeStore();
  return store ? store.file : null;
}

module.exports = { withTimingContext, timingLogPath, startRun, beginSku, endRun, logEvent, step, currentLogFile };
