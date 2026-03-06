---
title: "Non-Blocking Client Logging with Web Workers in Webpack"
tags: post
date: 2026-03-06
---

<div class="post-header">
<h1>{{ title }}</h1>
<p class="post-date">{{ page.date | postDate }}</p>
</div>

<div class="post-content">

In the past I came across a situation where we were wanting to preserve client-side application logs and errors in a way that didn't clog the main thread. The idea was floated that we should use Web Workers and the solution worked so well that I decided to write up the full process.

---

## Browser main thread & Web Workers

Browsers run JavaScript on a single thread. That same thread handles rendering, layout, event listeners, and all your JavaScript operations. When something blocks it — a slow `fetch`, a heavy computation, a lot of JSON serialization — the browser literally can't respond to user input until it's done. This is why synchronous operations feel "jank-y."

A Web Worker is a JavaScript file that runs on a **separate background thread**. The main thread and the worker can't share variables directly — they communicate by passing messages back and forth. Workers can't touch the DOM, but they have full access to `fetch`, `setTimeout`, `setInterval`, `IndexedDB`, and most browser APIs that don't involve rendering.

The simplest worker looks like this:

```typescript
// echo.worker.ts — runs on a background thread
self.onmessage = ({ data }: MessageEvent<{ text: string }>) => {
  self.postMessage({ echo: data.text.toUpperCase() });
};
```

```typescript
// main.ts — fires and forgets immediately
const worker = new Worker(new URL('./echo.worker.ts', import.meta.url));
worker.onmessage = ({ data }) => console.log(data.echo); // 'HELLO'
worker.postMessage({ text: 'hello' }); // returns immediately, never blocks
```

`postMessage` is the key — it's non-blocking. The main thread sends and moves on. The worker does its work in the background.

---

## Setting up Workers in your build

**Webpack 4** (still common in legacy codebases) requires the `worker-loader` package:

```bash
npm install --save-dev worker-loader
```

```javascript
// webpack.config.js (Webpack 4)
module.exports = {
  module: {
    rules: [
      {
        test: /\.worker\.(js|ts)$/,
        use: { loader: 'worker-loader', options: { inline: 'no-fallback' } },
      },
    ],
  },
};
```

```typescript
// Webpack 4 import style
import LoggerWorker from './logger.worker.ts';
const worker = new LoggerWorker();
```

**Webpack 5** supports workers natively with no extra config:

```typescript
// Webpack 5 — no additional configuration required
const worker = new Worker(new URL('./logger.worker.ts', import.meta.url), { type: 'module' });
```

---

## The pattern: Worker and Monitor

Two files with a clear division of responsibility:

- **`logger.worker.ts`** — the background thread. Owns the queue, the batch logic, the flush timer, and the `fetch` call. No DOM access needed.
- **`LogMonitor.ts`** — the main-thread class. Spins up the worker, intercepts `console` globally, and relays everything to the worker. Contains no I/O logic itself.

The key design decision: `LogMonitor` **replaces `console` methods** at the global level. That means you initialize it once at app startup and every `console.warn`, `console.error`, and `console.log` your existing code already fires gets automatically captured and shipped — no refactoring required.

### logger.worker.ts

```typescript
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  message: string;
  context: Record<string, unknown>;
  url: string;
  ts: number;
}

interface WorkerConfig {
  logLevel: LogLevel;
  endpoint: string;
  batchSize: number;
}

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let config: WorkerConfig = { logLevel: 'warn', endpoint: '', batchSize: 10 };
let queue: LogEntry[] = [];

self.onmessage = ({ data }: MessageEvent) => {
  if (data.type === 'init') { config = { ...config, ...data.payload }; startAutoFlush(); }
  if (data.type === 'log') {
    const entry = data.payload as Omit<LogEntry, 'ts'>;
    if (LEVELS[entry.level] >= LEVELS[config.logLevel]) {
      queue.push({ ...entry, ts: Date.now() });
      if (queue.length >= config.batchSize) flush();
    }
  }
  if (data.type === 'flush') flush();
};

function flush(): void {
  if (!queue.length) return;
  const batch = queue.splice(0); // atomically empty the queue
  fetch(config.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ logs: batch }),
  }).catch(() => queue.unshift(...batch)); // re-queue on failure
}

function startAutoFlush(): void {
  setInterval(flush, 5000); // drain anything below the batch threshold
}
```

The worker's entire job is the queue and the batch. When a `log` message arrives it checks the level threshold — entries below the configured level are dropped immediately, before they ever touch the queue. Once the queue reaches `batchSize`, `flush()` fires: it atomically empties the queue with `splice(0)`, serializes the batch, and calls `fetch`. If the request fails the batch gets pushed back to the front of the queue to retry on the next flush.

The `setInterval` flush is the safety net. Without it, a low-traffic page that only fires one warning every few minutes would never fill a full batch and those logs would never ship. The interval catches everything that falls below the batch threshold and drains it on a predictable schedule.

All of this — the queue allocation, JSON serialization, and HTTP overhead — runs on the worker thread. The main thread never waits for any of it.

### LogMonitor.ts

```typescript
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogMonitorOptions {
  logLevel?: LogLevel;
  endpoint: string;
  batchSize?: number;
}

type ConsoleMethod = 'log' | 'debug' | 'info' | 'warn' | 'error';

export class LogMonitor {
  private worker: Worker;
  private originalConsole: Partial<Record<ConsoleMethod, (...args: unknown[]) => void>> = {};

  constructor({ logLevel = 'warn', endpoint, batchSize = 10 }: LogMonitorOptions) {
    this.worker = new Worker(new URL('./logger.worker.ts', import.meta.url), { type: 'module' });
    this.worker.postMessage({ type: 'init', payload: { logLevel, endpoint, batchSize } });
    this.intercept();
    window.addEventListener('beforeunload', () => this.flush());
  }

  private intercept(): void {
    // Map each console method to a LogLevel
    const methods: Array<[ConsoleMethod, LogLevel]> = [
      ['log',   'debug'],
      ['debug', 'debug'],
      ['info',  'info'],
      ['warn',  'warn'],
      ['error', 'error'],
    ];

    methods.forEach(([method, level]) => {
      const original = console[method].bind(console);
      this.originalConsole[method] = original;

      console[method] = (...args: unknown[]): void => {
        original(...args); // preserve normal devtools output

        // Use the first string arg as the message; collect objects as context
        const message = args.find((a): a is string => typeof a === 'string')
          ?? String(args[0] ?? '');
        const context = args.reduce<Record<string, unknown>>((acc, arg, i) => {
          if (arg !== null && typeof arg === 'object') acc[`arg${i}`] = arg;
          return acc;
        }, {});

        this.worker.postMessage({
          type: 'log',
          payload: { level, message, context, url: location.href },
        });
      };
    });
  }

  flush = (): void => { this.worker.postMessage({ type: 'flush' }); };
}
```

`intercept()` replaces each `console` method with a wrapper. The wrapper still calls the original (so your browser devtools stay unchanged) and then posts the log entry to the worker. Both `console.log` and `console.debug` map to the `debug` level so you can filter them out cleanly in production.

The important thing here: **no existing code needs to change.** Every `console.warn`, `console.error`, and `console.info` already in your codebase is automatically captured and filtered at the level you configure. There's nothing to refactor.

### Wiring it up

One call at app startup, before anything else runs. Where exactly that goes depends on your setup:

- **Webpack** — `src/index.ts`, the entry point listed in `webpack.config.js` under `entry`
- **React** — top of `src/index.tsx`, before `ReactDOM.createRoot(...).render(...)`
- **Next.js** — `instrumentation.ts` at the project root (Next 13.4+), or `pages/_app.tsx` for older setups

```typescript
import { LogMonitor } from './LogMonitor';

new LogMonitor({
  logLevel: process.env.NODE_ENV === 'development' ? 'debug' : 'warn',
  endpoint: '/api/logs',
  batchSize: 20,
});

// Everything below ships automatically — no other changes in your codebase:
console.warn('Cart price mismatch', { expected: 42.00, actual: 41.99 });
console.error('Checkout failed', { code: err.code, cartId });
console.info('User signed in', { userId });
```

---

## Using `loglevel` instead of `console`

If your team is already using [loglevel](https://www.npmjs.com/package/loglevel), you can hook it into the same worker with a small addition to `LogMonitor.ts`. The same zero-touch principle applies — no changes to existing app code.

```bash
npm install loglevel
```

Add the import and a `hookLoglevel` method to `LogMonitor.ts`, and call it from the constructor:

```typescript
// Add at the top of LogMonitor.ts:
import log from 'loglevel';

// Add to the constructor, after this.intercept():
this.hookLoglevel();

// Add to the class body:
private hookLoglevel(): void {
  const orig = log.methodFactory;
  log.methodFactory = (methodName, logLevel, loggerName) => {
    const raw = orig(methodName, logLevel, loggerName);
    return (...args: unknown[]): void => {
      // Use the stored original console method directly — not the wrapped version —
      // so devtools still see the output without triggering the console interceptor
      // again and double-posting to the worker.
      (this.originalConsole[methodName as ConsoleMethod] ?? raw)(...args);

      const level: LogLevel = (methodName === 'log' ? 'debug' : methodName) as LogLevel;
      const message = args.find((a): a is string => typeof a === 'string') ?? String(args[0] ?? '');
      const context = args.reduce<Record<string, unknown>>((acc, arg, i) => {
        if (arg !== null && typeof arg === 'object') acc[`arg${i}`] = arg;
        return acc;
      }, {});
      this.worker.postMessage({ type: 'log', payload: { level, message, context, url: location.href } });
    };
  };
  log.setLevel(log.getLevel()); // rebuild methods with the new factory
}
```

The `originalConsole` reference matters here. Loglevel's default `methodFactory` calls `console[methodName]` internally — which is now the wrapped version from `intercept()`. If we called `raw()` instead of going through `originalConsole`, every loglevel call would post to the worker twice. Using `originalConsole` bypasses the wrapper and outputs directly to devtools, while the worker post below it handles the forwarding exactly once.

Then wire up the webpack alias so existing `import log from 'loglevel'` calls keep working unchanged:

```typescript
// src/logger/loglevel-alias.ts
// The alias target re-exports loglevel's API directly from its dist path.
// It can't import 'loglevel' here — that would resolve back to this file.
export { default, trace, debug, info, warn, error, setLevel, getLogger } from 'loglevel/dist/loglevel';
```

```javascript
// webpack.config.js
const path = require('path');

module.exports = {
  resolve: {
    alias: {
      loglevel: path.resolve(__dirname, 'src/logger/loglevel-alias.ts'),
    },
  },
};
```

Every `import log from 'loglevel'` across the codebase gets the real loglevel API. `LogMonitor` hooks it at startup — filtered by the same level you configured for `console`.

`loglevel`'s named logger API works too: `log.getLogger('payments').warn(...)` routes through the same factory and ships to the worker like everything else.

---

## Choosing your batch size

Batching is what makes this efficient. Every HTTP request carries overhead — headers, connection setup, a round trip. A batch of 50 log entries costs roughly the same as a batch of 1 in network overhead, so you want your batches as large as your backend can comfortably handle.

The right size depends on where you're sending:

**Your own backend**: `10–50` is a safe default. A typical log entry in this shape is 200–500 bytes, so 50 entries is well under 50KB and fast to deserialize.

**Datadog Logs API**: Accepts up to 1,000 events per request and 5MB per payload. You can push to `100–500` if you have high log volume. Datadog also expects its own field names:

```typescript
// Datadog payload shape
batch.map(entry => ({
  ddsource: 'browser',
  service: 'my-app',
  hostname: location.hostname,
  message: entry.message,
  status: entry.level, // Datadog uses "status" not "level"
  ddtags: `env:${config.env}`,
  ...entry.context,
}))
```

**AWS CloudWatch (PutLogEvents)**: Up to 10,000 events per call, 1MB max. Events must be in **chronological order** — the queue preserves this by default. Batch size `100–500` is typical.

**In development**, set `batchSize: 1` so every log ships the moment it fires. You still get the worker benefit (no main thread blocking) and you get immediate visibility without waiting for a flush:

```typescript
new LogMonitor({
  logLevel: 'debug',
  batchSize: 1,   // immediate in dev
  endpoint: '/api/logs',
});
```

---

## Try it

Fire logs below and watch the queue fill. Switch the active log level to see how lower-priority entries are filtered before they enter the queue at all.

</div>

<div class="logger-demo" id="logger-demo">
  <div class="logger-demo__section">
    <div class="logger-demo__label">Active log level</div>
    <div class="logger-demo__btn-group" id="level-btns">
      <button class="logger-demo__btn logger-demo__btn--debug" data-level="debug">debug</button>
      <button class="logger-demo__btn logger-demo__btn--info"  data-level="info">info</button>
      <button class="logger-demo__btn logger-demo__btn--warn logger-demo__btn--active"  data-level="warn">warn</button>
      <button class="logger-demo__btn logger-demo__btn--error" data-level="error">error</button>
    </div>
  </div>
  <div class="logger-demo__section">
    <div class="logger-demo__label">Fire a log</div>
    <div class="logger-demo__btn-group">
      <button class="logger-demo__btn logger-demo__fire-btn logger-demo__btn--debug" data-fire="debug">+ debug</button>
      <button class="logger-demo__btn logger-demo__fire-btn logger-demo__btn--info"  data-fire="info">+ info</button>
      <button class="logger-demo__btn logger-demo__fire-btn logger-demo__btn--warn"  data-fire="warn">+ warn</button>
      <button class="logger-demo__btn logger-demo__fire-btn logger-demo__btn--error" data-fire="error">+ error</button>
      <button class="logger-demo__btn" id="flush-btn">flush now</button>
      <button class="logger-demo__btn" id="reset-btn">reset</button>
    </div>
  </div>
  <div class="logger-demo__section">
    <div class="logger-demo__label">Queue</div>
    <div class="logger-demo__queue-bar-wrap">
      <div class="logger-demo__queue-bar" id="queue-bar"></div>
    </div>
    <div class="logger-demo__queue-label">
      <span id="queue-count">0 / 5 entries</span>
      <span id="flush-timer">auto-flush in 5s</span>
    </div>
  </div>
  <div class="logger-demo__section">
    <div class="logger-demo__label">Log activity</div>
    <div class="logger-demo__log-list" id="log-list">
      <div class="logger-demo__log-entry" style="color: var(--text-muted); font-style: italic;">Fire a log above to get started.</div>
    </div>
  </div>
</div>

<div class="post-content">

---

## What to do with the data

Your backend receives `{ logs: LogEntry[] }` on every batch. At minimum you can persist these to a database and query by level, URL, or timestamp. Point the endpoint at Datadog, CloudWatch, or Elastic and you get dashboards and alerting for free — set a threshold on `error` volume and you'll know about regressions before your users file tickets.

The worker pattern keeps all of this cheap. The main thread never blocks on I/O, batching collapses hundreds of small requests into a handful of large ones, and the `beforeunload` flush means you don't lose the last few logs when a tab closes.

---

If your app is doing any work that doesn't need the DOM — logging, analytics, prefetching, hashing — it belongs in a worker. The main thread has one job: keep the UI responsive.

</div>

<script>
(function () {
  var LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
  var BATCH_SIZE = 5;
  var activeLevel = 'warn';
  var queue = [];
  var timerCount = 5;
  var logCounter = 0;

  var queueBar   = document.getElementById('queue-bar');
  var queueCount = document.getElementById('queue-count');
  var flushTimer = document.getElementById('flush-timer');
  var logList    = document.getElementById('log-list');

  var workerSrc = [
    'var LEVELS={debug:0,info:1,warn:2,error:3};',
    'var config={logLevel:"warn",endpoint:"",batchSize:5};',
    'var queue=[];',
    'self.onmessage=function(e){',
    '  var d=e.data;',
    '  if(d.type==="init"){config=Object.assign({},config,d.payload);startFlush();}',
    '  if(d.type==="log"){',
    '    if(LEVELS[d.payload.level]>=LEVELS[config.logLevel]){',
    '      queue.push(Object.assign({},d.payload,{ts:Date.now()}));',
    '      if(queue.length>=config.batchSize)flush();',
    '    } else {',
    '      self.postMessage({type:"filtered",level:d.payload.level});',
    '    }',
    '  }',
    '  if(d.type==="flush")flush();',
    '  if(d.type==="reset"){queue=[];}',
    '};',
    'function flush(){',
    '  if(!queue.length)return;',
    '  var batch=queue.splice(0);',
    '  self.postMessage({type:"batch",batch:batch});',
    '}',
    'function startFlush(){setInterval(function(){if(queue.length)flush();self.postMessage({type:"tick"});},1000);}',
  ].join('\n');

  var blob = new Blob([workerSrc], { type: 'application/javascript' });
  var worker = new Worker(URL.createObjectURL(blob));
  worker.postMessage({ type: 'init', payload: { logLevel: activeLevel, batchSize: BATCH_SIZE } });

  worker.onmessage = function (e) {
    var msg = e.data;
    if (msg.type === 'batch') {
      var counts = {};
      msg.batch.forEach(function (entry) { counts[entry.level] = (counts[entry.level] || 0) + 1; });
      var summary = Object.keys(counts).map(function (k) { return counts[k] + ' ' + k; }).join(', ');
      var time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      addLogEntry('[' + time + '] sent batch of ' + msg.batch.length + ' — ' + summary, 'sent');
      queue = [];
      updateQueueUI();
      resetTimer();
    }
    if (msg.type === 'filtered') {
      addLogEntry(msg.level + ' log filtered (below ' + activeLevel + ' threshold)', 'filtered');
    }
    if (msg.type === 'tick') {
      timerCount--;
      if (timerCount <= 0) resetTimer();
      flushTimer.textContent = 'auto-flush in ' + timerCount + 's';
    }
  };

  function resetTimer() { timerCount = 5; flushTimer.textContent = 'auto-flush in 5s'; }

  function updateQueueUI() {
    queueBar.style.width = Math.min((queue.length / BATCH_SIZE) * 100, 100) + '%';
    queueCount.textContent = queue.length + ' / ' + BATCH_SIZE + ' entries';
  }

  function addLogEntry(text, type) {
    if (logList.children.length === 1 && logList.children[0].style.fontStyle === 'italic') logList.innerHTML = '';
    var el = document.createElement('div');
    el.className = 'logger-demo__log-entry' + (type ? ' logger-demo__log-entry--' + type : '');
    el.textContent = text;
    logList.insertBefore(el, logList.firstChild);
    while (logList.children.length > 20) logList.removeChild(logList.lastChild);
  }

  document.getElementById('level-btns').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-level]');
    if (!btn) return;
    activeLevel = btn.dataset.level;
    document.querySelectorAll('[data-level]').forEach(function (b) {
      b.classList.toggle('logger-demo__btn--active', b.dataset.level === activeLevel);
    });
    worker.postMessage({ type: 'init', payload: { logLevel: activeLevel, batchSize: BATCH_SIZE } });
    addLogEntry('log level set to ' + activeLevel, '');
  });

  document.querySelectorAll('[data-fire]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var level = btn.dataset.fire;
      logCounter++;
      var message = level + ' event #' + logCounter;
      worker.postMessage({ type: 'log', payload: { level: level, message: message, context: {}, url: location.href } });
      if (LEVELS[level] >= LEVELS[activeLevel]) {
        queue.push({ level: level });
        updateQueueUI();
        addLogEntry('queued: ' + message, '');
      }
    });
  });

  document.getElementById('flush-btn').addEventListener('click', function () { worker.postMessage({ type: 'flush' }); });

  document.getElementById('reset-btn').addEventListener('click', function () {
    worker.postMessage({ type: 'reset' });
    queue = []; logCounter = 0;
    updateQueueUI();
    logList.innerHTML = '<div class="logger-demo__log-entry" style="color: var(--text-muted); font-style: italic;">Fire a log above to get started.</div>';
    resetTimer();
  });
})();
</script>
