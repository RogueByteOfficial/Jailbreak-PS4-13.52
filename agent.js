/**
 * RogueByte Browser-Native Dev Agent (agent.js)
 * =========================================================================
 * يعيش داخل المتصفح مع jb.js في الوقت الفعلي.
 * يراقب سير عملية الجيلبريك، يضبط التوقيتات تكيفياً (Adaptive Timing)،
 * يعترض الأخطاء والجمود، ويقوم بالإصلاح التلقائي مع دعم Qwen المحلي.
 * =========================================================================
 */

;(function () {
  'use strict';

  // ── 1. إعدادات الوكيل (Agent Configuration) ───────────────────────────
  const AGENT_CFG = {
    // عنوان خادم Ollama المحلي (يمكن ضبطه عبر الرابط ?ollama=...)
    ollamaUrl: (new URLSearchParams(location.search)).get('ollama') || 'http://localhost:11434',
    ollamaModel: 'qwen2.5-coder:7b',

    // الحد الأقصى لمحاولات إعادة المحاولة التلقائية
    maxRetries: 4,

    // زمن التأخير الأساسي بين المحاولات (ms)
    baseRetryDelayMs: 2500,

    // كشف الجمود (Stall detection): إذا توقفت الرسائل لأكثر من هذه المدة (ms)
    stallTimeoutMs: 38000,

    // إظهار واجهة المراقبة HUD
    showHud: true,

    // تمكين التكيف التلقائي مع سرعة المعالج (Adaptive Timing)
    adaptiveTiming: true,

    // تمكين التخزين الدائم للتشخيص
    persistDiagnostics: true,
  };

  // ── 2. الحالة الداخلية (Agent State) ──────────────────────────────────
  const _state = {
    retryCount: 0,
    lastMarkTime: Date.now(),
    stallTimer: null,
    timerInterval: null,
    eventLog: [],
    failureLog: [],
    phase: 'IDLE', // IDLE | READY | RUNNING | RETRYING | FAILED | SUCCESS | STALLED | AI_ANALYZING
    fixAttempted: false,
    startTime: null,
    preflightPassed: false,
    benchmarkLatency: 0,
    stabilityScore: 'STABLE', // FAST | STABLE | DEGRADED
    recommendedGcPause: 80,
    strategy: 'DEFAULT', // DEFAULT | CONSERVATIVE_TIMING | HIGH_GC_PAUSE | AGGRESSIVE_CLEAN
  };

  // ── 3. كواشف الأنماط وقواعد البيانات المصغرة ──────────────────────────
  const BAD_RE = /FAIL|ERROR|THREW|REBOOT|LOST|POISON|TIMEOUT|MISMATCH|ABORTED|PANIC|CORRUPT|CRASH/i;
  const WARN_RE = /WARN|SKIP|REFUSED|COMMITTED|DIRTY|UNSTABLE/i;
  const OK_RE = /\bOK\b|PASS|ACHIEVED|RUNNING|ARMED|PROOF-OK|FOUND/i;
  const DONE_RE = /\bDONE\b|SUCCESS|JAILBROKEN|KERNEL.*OK|finishUI\(true\)/i;

  // خوارزمية التشخيص والقواعد المعرفية المضمنة (Offline Expert Rules)
  const FIX_RULES = [
    {
      id: 'timeout_stall',
      pattern: /TIMEOUT|STALL/i,
      label: 'Stall / Timeout detected',
      fix: 'retry_with_backoff',
      desc: 'Exploit loop stalled. Increasing GC stabilization delay and retrying.',
      cause: 'Memory pressure or WebKit thread lock prevented execution flow.',
    },
    {
      id: 'memory_poison',
      pattern: /POISON|MISMATCH|CORRUPT|BAD_ADDR/i,
      label: 'Memory state corrupted',
      fix: 'hard_reload',
      desc: 'Corrupted pointers detected. Purging session caches and initiating hard reload.',
      cause: 'WebKit heap layout shifted unexpectedly causing invalid spray addresses.',
    },
    {
      id: 'exception_thrown',
      pattern: /THREW|EXCEPTION|TypeError|ReferenceError|SyntaxError/i,
      label: 'JavaScript runtime exception',
      fix: 'soft_retry',
      desc: 'Caught JS exception. Clearing temporary objects and retrying execution.',
      cause: 'Unhandled exception inside WebKit primitive handler or DOM helper.',
    },
    {
      id: 'prim_failure',
      pattern: /FAIL.*prim|prim.*FAIL|PRIMITIVE/i,
      label: 'Read/Write Primitive failure',
      fix: 'retry_with_backoff',
      desc: 'Addrof/fakeobj primitive unstable. Applying backoff delay.',
      cause: 'ArrayBuffer backing store or JIT optimization mismatch during primitive setup.',
    },
    {
      id: 'generic_failure',
      pattern: /FAIL|ERROR/i,
      label: 'Exploit stage failure',
      fix: 'soft_retry',
      desc: 'Exploit step returned failure. Triggering auto-recovery retry.',
      cause: 'Kernel/WebKit race condition window missed.',
    },
  ];

  // ── 4. الفحوصات الاستباقية (Preflight Checks) ──────────────────────────
  const PREFLIGHT_TESTS = [
    {
      id: 'ps4_ua',
      label: 'PS4 WebKit UA',
      short: 'PS4-UA',
      test: () => /PlayStation 4/.test(navigator.userAgent),
      warn: true,
    },
    {
      id: 'es6_support',
      label: 'ES6 / Promise Engine',
      short: 'ES6',
      test: () => typeof Symbol !== 'undefined' && typeof Promise !== 'undefined' && typeof BigInt !== 'undefined',
      warn: false,
    },
    {
      id: 'sab_check',
      label: 'SharedArrayBuffer',
      short: 'SAB',
      test: () => typeof SharedArrayBuffer !== 'undefined',
      warn: true,
    },
    {
      id: 'wasm_check',
      label: 'WebAssembly Core',
      short: 'WASM',
      test: () => typeof WebAssembly !== 'undefined',
      warn: true,
    },
    {
      id: 'int_math',
      label: 'Int32 / Int64 math',
      short: 'Math',
      test: () => (0xffffffff | 0) === -1 && (0x80000000 >> 0) === -2147483648,
      warn: false,
    },
    {
      id: 'storage',
      label: 'Storage Persistence',
      short: 'Storage',
      test: () => {
        try {
          localStorage.setItem('__rb_test', '1');
          localStorage.removeItem('__rb_test');
          return true;
        } catch (e) {
          return false;
        }
      },
      warn: true,
    },
  ];

  // ── 5. محرك قياس الأداء والتهيئة التكيفية للذاكرة (Adaptive Timing & Sanitizer) ─
  function _runBenchmarkAndSanitize() {
    const t0 = (window.performance && window.performance.now) ? performance.now() : Date.now();

    // 1. تقييم زمن استجابة دورة معالجة الجافاسكريبت (Micro-benchmark)
    let acc = 0;
    for (let i = 0; i < 150000; i++) {
      acc = (acc + ((i * 3) ^ 7)) | 0;
    }

    // 2. تنظيف وتمهيد مبدئي لـ Garbage Collection عبر حجز وتحرير مصفوفات عابرة
    try {
      const ephemeral = [];
      for (let j = 0; j < 32; j++) {
        ephemeral.push(new Uint32Array(1024));
      }
      ephemeral.length = 0;
    } catch (e) {}

    const t1 = (window.performance && window.performance.now) ? performance.now() : Date.now();
    const latency = Math.max(1, Math.round(t1 - t0));
    _state.benchmarkLatency = latency;

    // 3. تصنيف سرعة واستقرار الجهاز وتحديد معاملات التوقيت التكيفي
    if (latency < 18) {
      _state.stabilityScore = 'FAST';
      _state.recommendedGcPause = 50;
    } else if (latency <= 55) {
      _state.stabilityScore = 'STABLE';
      _state.recommendedGcPause = 90;
    } else {
      _state.stabilityScore = 'DEGRADED';
      _state.recommendedGcPause = 180;
    }

    // 4. ضبط استراتيجية العمل وفق المحاولة الحالية
    if (_state.retryCount === 1) {
      _state.strategy = 'CONSERVATIVE_TIMING';
      _state.recommendedGcPause = Math.round(_state.recommendedGcPause * 1.5);
    } else if (_state.retryCount >= 2) {
      _state.strategy = 'HIGH_GC_PAUSE';
      _state.recommendedGcPause = Math.round(_state.recommendedGcPause * 2.2);
    } else {
      _state.strategy = 'DEFAULT';
    }

    // تصدير المعطيات التكيفية ليستفيد منها أي سكربت آخر
    window.__agentTiming = {
      latencyMs: _state.benchmarkLatency,
      stability: _state.stabilityScore,
      gcPauseMs: _state.recommendedGcPause,
      strategy: _state.strategy,
      retryCount: _state.retryCount,
    };

    _agLog('AGENT-ADAPT', `Bench: ${latency}ms | Profile: ${_state.stabilityScore} | Strategy: ${_state.strategy}`, 'ok');
  }

  // ── 6. واجهة المراقبة التفاعلية (HUD UI) ────────────────────────────────
  let _hud = null;
  let _hudRows = null;
  let _hudStatus = null;
  let _hudPhase = null;
  let _hudRetry = null;
  let _hudTimer = null;
  let _hudMem = null;
  let _hudBench = null;
  let _hudToggleBtn = null;
  let _hudCollapsed = false;

  function _createHud() {
    if (!AGENT_CFG.showHud || _hud) return;

    const style = document.createElement('style');
    style.id = '__ag-styles';
    style.textContent = `
      #__ag-hud {
        position: fixed;
        bottom: 14px;
        right: 14px;
        z-index: 999999;
        width: 330px;
        background: rgba(6, 11, 24, 0.94);
        border: 1px solid rgba(0, 240, 255, 0.35);
        border-radius: 14px;
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        box-shadow: 0 12px 40px rgba(0,0,0,0.85), 0 0 25px rgba(0,240,255,0.15);
        font-family: Consolas, "Fira Code", "Courier New", monospace;
        font-size: 11px;
        overflow: hidden;
        transition: height 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s ease;
        user-select: none;
        -webkit-user-select: none;
        color: #e2e8f0;
      }
      #__ag-hud.collapsed { height: 38px; }

      #__ag-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 12px;
        background: linear-gradient(90deg, rgba(0,240,255,0.14), rgba(157,78,221,0.14));
        border-bottom: 1px solid rgba(0,240,255,0.22);
        cursor: pointer;
      }
      #__ag-head-left {
        display: flex;
        align-items: center;
        gap: 8px;
        font-weight: 700;
        font-size: 11px;
        letter-spacing: 0.12em;
        color: #00f0ff;
        text-transform: uppercase;
      }
      #__ag-dot {
        width: 8px; height: 8px;
        border-radius: 50%;
        background: #00ffa3;
        box-shadow: 0 0 8px #00ffa3;
        animation: ag-pulse 1.4s infinite ease-in-out;
      }
      @keyframes ag-pulse { 0%,100%{opacity:1; transform:scale(1);} 50%{opacity:0.4; transform:scale(0.85);} }

      #__ag-head-meta {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 10px;
        color: #94a3b8;
      }
      #__ag-toggle {
        background: none;
        border: none;
        color: #94a3b8;
        font-size: 12px;
        cursor: pointer;
        padding: 2px 4px;
      }

      #__ag-body { padding: 10px 12px; }

      #__ag-metrics {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 5px 8px;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.05);
        border-radius: 6px;
        margin-bottom: 8px;
        font-size: 10px;
        color: #94a3b8;
      }
      #__ag-metrics span strong { color: #f1f5f9; }

      #__ag-preflight {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-bottom: 8px;
      }
      .ag-pf {
        font-size: 9px;
        padding: 2px 6px;
        border-radius: 6px;
        font-weight: 700;
      }
      .ag-pf.ok   { background: rgba(0,255,163,0.15); color: #00ffa3; border: 1px solid rgba(0,255,163,0.3); }
      .ag-pf.fail { background: rgba(255,51,102,0.15); color: #ff3366; border: 1px solid rgba(255,51,102,0.3); }
      .ag-pf.warn { background: rgba(255,183,3,0.15);  color: #ffb703; border: 1px solid rgba(255,183,3,0.3); }

      #__ag-phase-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 6px;
      }
      #__ag-phase {
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: #00f0ff;
      }
      #__ag-phase.ok   { color: #00ffa3; text-shadow: 0 0 8px #00ffa3; }
      #__ag-phase.fail { color: #ff3366; text-shadow: 0 0 8px #ff3366; }
      #__ag-phase.warn { color: #ffb703; text-shadow: 0 0 8px #ffb703; }
      #__ag-phase.fix  { color: #9d4edd; text-shadow: 0 0 8px #9d4edd; }

      #__ag-status {
        font-size: 10px;
        color: #cbd5e1;
        line-height: 1.4;
        min-height: 28px;
        margin-bottom: 6px;
        word-break: break-word;
      }
      #__ag-retry {
        font-size: 10px;
        color: #ffb703;
        font-weight: 600;
        margin-bottom: 6px;
        display: none;
      }

      #__ag-actions {
        display: flex;
        gap: 6px;
        margin-bottom: 8px;
      }
      .ag-btn {
        flex: 1;
        background: rgba(0,240,255,0.08);
        border: 1px solid rgba(0,240,255,0.25);
        border-radius: 6px;
        color: #00f0ff;
        font-size: 9px;
        font-weight: 700;
        padding: 4px 6px;
        cursor: pointer;
        transition: all 0.2s;
        text-align: center;
      }
      .ag-btn:hover {
        background: rgba(0,240,255,0.2);
        box-shadow: 0 0 8px rgba(0,240,255,0.3);
      }
      .ag-btn.ai {
        background: rgba(157,78,221,0.15);
        border-color: rgba(157,78,221,0.4);
        color: #d8b4fe;
      }
      .ag-btn.ai:hover { background: rgba(157,78,221,0.3); }

      #__ag-log {
        max-height: 100px;
        overflow-y: auto;
        border-top: 1px solid rgba(255,255,255,0.08);
        padding-top: 6px;
      }
      #__ag-log::-webkit-scrollbar { width: 4px; }
      #__ag-log::-webkit-scrollbar-thumb { background: rgba(0,240,255,0.25); border-radius: 2px; }

      .ag-row {
        display: flex;
        gap: 6px;
        padding: 2px 0;
        font-size: 10px;
        color: #64748b;
        line-height: 1.3;
      }
      .ag-row.ok   { color: #00ffa3; }
      .ag-row.fail { color: #ff3366; }
      .ag-row.warn { color: #ffb703; }
      .ag-row.fix  { color: #c084fc; }
      .ag-row .ag-tag { opacity: 0.8; font-weight: 700; min-width: 44px; }
    `;
    document.head.appendChild(style);

    _hud = document.createElement('div');
    _hud.id = '__ag-hud';
    _hud.innerHTML = `
      <div id="__ag-head">
        <div id="__ag-head-left">
          <span id="__ag-dot"></span>
          <span>Rogue Agent</span>
        </div>
        <div id="__ag-head-meta">
          <span id="__ag-timer">00:00</span>
          <button id="__ag-toggle" title="Toggle Collapse">▲</button>
        </div>
      </div>
      <div id="__ag-body">
        <div id="__ag-metrics">
          <span>Mem: <strong id="__ag-mem">--</strong></span>
          <span>Latency: <strong id="__ag-bench">--</strong></span>
          <span>Retries: <strong id="__ag-rt-count">${_state.retryCount}/${AGENT_CFG.maxRetries}</strong></span>
        </div>
        <div id="__ag-preflight"></div>
        <div id="__ag-phase-row">
          <span id="__ag-phase">IDLE</span>
        </div>
        <div id="__ag-status">Waiting for exploit bootstrap...</div>
        <div id="__ag-retry"></div>
        <div id="__ag-actions">
          <button class="ag-btn" id="__ag-btn-retry">🔄 Retry</button>
          <button class="ag-btn" id="__ag-btn-copy">📋 Copy Log</button>
          <button class="ag-btn ai" id="__ag-btn-ai">🤖 AI Analyze</button>
        </div>
        <div id="__ag-log"></div>
      </div>
    `;
    document.body.appendChild(_hud);

    _hudPhase     = document.getElementById('__ag-phase');
    _hudStatus    = document.getElementById('__ag-status');
    _hudRetry     = document.getElementById('__ag-retry');
    _hudTimer     = document.getElementById('__ag-timer');
    _hudMem       = document.getElementById('__ag-mem');
    _hudBench     = document.getElementById('__ag-bench');
    _hudRows      = document.getElementById('__ag-log');
    _hudToggleBtn = document.getElementById('__ag-toggle');

    // تفاعلات الأزرار
    document.getElementById('__ag-head').addEventListener('click', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      _hudCollapsed = !_hudCollapsed;
      _hud.classList.toggle('collapsed', _hudCollapsed);
      _hudToggleBtn.textContent = _hudCollapsed ? '▼' : '▲';
    });

    document.getElementById('__ag-btn-retry').addEventListener('click', () => {
      _applyFix({
        id: 'manual_retry',
        label: 'Manual Retry Requested',
        fix: 'soft_retry',
        desc: 'Manual restart triggered by user.'
      });
    });

    document.getElementById('__ag-btn-copy').addEventListener('click', () => {
      const dump = JSON.stringify(window.__agentDump(), null, 2);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(dump);
        _hudSetStatus('Diagnostic dump copied to clipboard!');
      } else {
        console.log('[AGENT DUMP]', dump);
        _hudSetStatus('Dump printed to console.');
      }
    });

    document.getElementById('__ag-btn-ai').addEventListener('click', () => {
      _hudSetPhase('AI DIAGNOSING', 'fix');
      _hudSetStatus('Querying local Qwen / Heuristic analyzer...');
      _sendToQwen('manual_request', { userRequested: true });
    });

    _startTimer();
    _updateMemoryMetric();
  }

  function _startTimer() {
    if (_state.timerInterval) clearInterval(_state.timerInterval);
    _state.timerInterval = setInterval(() => {
      if (!_hudTimer) return;
      if (!_state.startTime) {
        _hudTimer.textContent = '00:00';
        return;
      }
      const elapsed = Math.floor((Date.now() - _state.startTime) / 1000);
      const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const s = String(elapsed % 60).padStart(2, '0');
      _hudTimer.textContent = `${m}:${s}`;
      _updateMemoryMetric();
    }, 1000);
  }

  function _updateMemoryMetric() {
    if (_hudMem) {
      if (window.performance && window.performance.memory) {
        const used = Math.round(window.performance.memory.usedJSHeapSize / (1024 * 1024));
        _hudMem.textContent = `${used}MB`;
      } else {
        _hudMem.textContent = 'Active';
      }
    }
    if (_hudBench) {
      _hudBench.textContent = `${_state.benchmarkLatency}ms (${_state.stabilityScore})`;
    }
  }

  function _hudSetPhase(label, cls) {
    if (!_hudPhase) return;
    _hudPhase.textContent = label;
    _hudPhase.className = cls || '';
  }

  function _hudSetStatus(text) {
    if (_hudStatus) _hudStatus.textContent = text;
  }

  function _hudSetRetry(text) {
    if (!_hudRetry) return;
    if (text) {
      _hudRetry.style.display = 'block';
      _hudRetry.textContent = text;
    } else {
      _hudRetry.style.display = 'none';
    }
  }

  function _hudAddRow(tag, detail, cls) {
    if (!_hudRows) return;
    const row = document.createElement('div');
    row.className = 'ag-row ' + (cls || '');
    row.innerHTML = `<span class="ag-tag">${_escHtml(tag)}</span><span>${_escHtml(String(detail || '').slice(0, 100))}</span>`;
    _hudRows.appendChild(row);
    while (_hudRows.children.length > 50) _hudRows.removeChild(_hudRows.firstChild);
    _hudRows.scrollTop = _hudRows.scrollHeight;
  }

  function _hudShowPreflight(results) {
    const el = document.getElementById('__ag-preflight');
    if (!el) return;
    el.innerHTML = results.map(r =>
      `<span class="ag-pf ${r.cls}" title="${r.label}">${r.short || r.label.split(' ')[0]}</span>`
    ).join('');
  }

  function _escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  }

  // ── 7. تشغيل الفحوصات الاستباقية ────────────────────────────────────────
  function _runPreflight() {
    const results = [];
    let allOk = true;

    for (const t of PREFLIGHT_TESTS) {
      let passed = false;
      try { passed = !!t.test(); } catch (e) { passed = false; }

      let cls, logCls;
      if (passed) {
        cls = logCls = 'ok';
      } else if (t.warn) {
        cls = logCls = 'warn';
      } else {
        cls = logCls = 'fail';
        allOk = false;
      }

      results.push({ label: t.label, short: t.short, cls });
      _agLog(`PREFLIGHT`, `${t.label}: ${passed ? 'OK' : (t.warn ? 'WARN' : 'FAIL')}`, logCls);
    }

    _state.preflightPassed = allOk;
    _hudShowPreflight(results);
    return allOk;
  }

  // ── 8. نظام التسجيل (Agent Logging) ──────────────────────────────────
  function _agLog(tag, detail, cls) {
    const entry = { tag, detail: String(detail || ''), ts: Date.now(), cls };
    _state.eventLog.push(entry);
    _hudAddRow(tag, detail, cls || _tagClass(tag));
    _updateMemoryMetric();
  }

  function _tagClass(tag) {
    if (BAD_RE.test(tag)) return 'fail';
    if (WARN_RE.test(tag)) return 'warn';
    if (OK_RE.test(tag) || DONE_RE.test(tag)) return 'ok';
    return '';
  }

  // ── 9. استراتيجيات الإصلاح الذاتي (Self-Healing Strategies) ─────────────
  function _applyFix(rule) {
    _state.fixAttempted = true;
    _agLog('AGENT-FIX', `${rule.label} → ${rule.fix}`, 'fix');
    _hudSetPhase('FIXING…', 'fix');
    _hudSetStatus(rule.desc);

    const delay = AGENT_CFG.baseRetryDelayMs + (_state.retryCount * 900);

    switch (rule.fix) {
      case 'retry_with_backoff':
      case 'retry_with_delay':
        _state.retryCount++;
        _hudSetRetry(`Auto-Retry ${_state.retryCount}/${AGENT_CFG.maxRetries} (Delay ${delay}ms)…`);
        _state.phase = 'RETRYING';
        setTimeout(() => {
          if (_state.retryCount <= AGENT_CFG.maxRetries) {
            _agLog('AGENT-RETRY', `Attempt ${_state.retryCount}`, 'fix');
            _hudSetStatus(`Reloading context (Attempt ${_state.retryCount})...`);
            location.reload();
          } else {
            _onExhausted();
          }
        }, delay);
        break;

      case 'soft_retry':
        _state.retryCount++;
        _state.phase = 'RETRYING';
        _hudSetRetry(`Soft retry ${_state.retryCount}/${AGENT_CFG.maxRetries}…`);
        setTimeout(() => {
          if (_state.retryCount <= AGENT_CFG.maxRetries) {
            _agLog('AGENT-SOFT-RETRY', `Attempt ${_state.retryCount}`, 'fix');
            try { sessionStorage.removeItem('__rb_temp'); } catch (e) {}
            location.reload();
          } else {
            _onExhausted();
          }
        }, delay);
        break;

      case 'hard_reload':
        _state.retryCount++;
        _agLog('AGENT-PURGE', 'Clearing caches for clean memory layout', 'fix');
        try {
          sessionStorage.clear();
        } catch (e) {}
        setTimeout(() => location.reload(true), 1500);
        break;

      default:
        _agLog('AGENT-UNKNOWN-FIX', rule.fix, 'warn');
        setTimeout(() => location.reload(), 2000);
    }
  }

  function _onExhausted() {
    _agLog('AGENT-GIVE-UP', 'Max retries reached', 'fail');
    _state.phase = 'FAILED';
    _hudSetPhase('EXHAUSTED', 'fail');
    _hudSetStatus('All auto-retries failed. AI diagnostic initiated.');
    _hudSetRetry('');
    _sendToQwen('max_retries_reached', {
      cause: 'Max retry threshold reached without achieving kernel read/write.',
    });
  }

  // ── 10. مراقبة الجمود وتوقف الاستجابة (Stall Monitor) ──────────────────
  function _resetStallTimer() {
    if (_state.stallTimer) clearTimeout(_state.stallTimer);
    if (_state.phase !== 'RUNNING') return;

    _state.stallTimer = setTimeout(() => {
      _agLog('AGENT-STALL', `No mark() received in ${AGENT_CFG.stallTimeoutMs / 1000}s`, 'warn');
      _hudSetPhase('STALLED', 'warn');
      _hudSetStatus('Exploit loop frozen or timed out. Initiating recovery...');
      _onFailureDetected('STALL TIMEOUT', 'Exploit loop inactive');
    }, AGENT_CFG.stallTimeoutMs);
  }

  // ── 11. محرك اتخاذ القرار عند الفشل (Decision Engine) ─────────────────
  function _onFailureDetected(tag, detail) {
    if (_state.phase === 'SUCCESS') return;
    if (_state.phase === 'FAILED' || _state.phase === 'RETRYING') return;

    _state.failureLog.push({ tag, detail, ts: Date.now() });
    _hudSetPhase('FAIL DETECTED', 'fail');

    if (_state.retryCount >= AGENT_CFG.maxRetries) {
      _onExhausted();
      return;
    }

    const combined = `${tag} ${detail}`;
    const rule = FIX_RULES.find(r => r.pattern.test(combined)) || FIX_RULES[FIX_RULES.length - 1];

    _agLog('AGENT-DECIDE', `${rule.label} [${rule.fix}]`, 'fix');
    _applyFix(rule);
  }

  // ── 12. التشخيص الذكي وربط Qwen المحلي (Local AI & Heuristics) ─────────
  function _sendToQwen(eventType, extraData) {
    const summary = _state.eventLog.slice(-25).map(e => `[${e.tag}] ${e.detail}`).join('\n');
    const matchedRule = FIX_RULES.find(r =>
      _state.failureLog.some(f => r.pattern.test(f.tag + ' ' + f.detail))
    );

    // Fallback Heuristic Analysis (يعمل بدون انترنت وبدون خادم خارجي)
    const localAnalysis = matchedRule
      ? `Heuristic: ${matchedRule.label}. Suggested: ${matchedRule.desc}`
      : `Heuristic: Generic instability. Restart console or clear browser cache recommended.`;

    _hudSetStatus(localAnalysis);

    if (!AGENT_CFG.ollamaUrl) {
      _agLog('AGENT-AI', localAnalysis, 'fix');
      return;
    }

    const prompt = `
You are a PS4 WebKit/Kernel exploit assistant.
Event: ${eventType}
Logs:
${summary}
Failures: ${JSON.stringify(_state.failureLog)}
${extraData ? 'Extra: ' + JSON.stringify(extraData) : ''}

Provide 1-line root cause, 1-line action, and probability of success on next retry.
`.trim();

    fetch(AGENT_CFG.ollamaUrl + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: AGENT_CFG.ollamaModel,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        options: { temperature: 0.1, num_predict: 150 }
      }),
      mode: 'cors'
    })
      .then(r => r.json())
      .then(resp => {
        const msg = (resp.message && resp.message.content) || '';
        if (msg) {
          _agLog('AGENT-AI', msg.slice(0, 140), 'fix');
          _hudSetStatus('AI: ' + msg.slice(0, 100));
        }
      })
      .catch(() => {
        _agLog('AGENT-AI', `Local Qwen offline — using Built-in Heuristics`, 'warn');
      });
  }

  // ── 13. التقاط الأخطاء العامة للمتصفح ──────────────────────────────────
  window.addEventListener('error', function (e) {
    const msg = `${e.message} @ ${e.filename || 'script'}:${e.lineno || 0}`;
    _agLog('AGENT-ERR', msg, 'fail');
    _onFailureDetected('THREW', msg);
  });

  window.addEventListener('unhandledrejection', function (e) {
    const msg = String(e.reason ? (e.reason.message || e.reason) : 'Unknown Promise Rejection');
    _agLog('AGENT-REJECT', msg, 'fail');
    _onFailureDetected('THREW_PROMISE', msg);
  });

  // ── 14. مراقبة تغيرات الصفحة (DOM Class Observer) ───────────────────────
  function _watchBodyClass() {
    const mo = new MutationObserver(function () {
      const cls = document.body.className;
      if (cls === 'done') {
        if (_state.stallTimer) clearTimeout(_state.stallTimer);
        _state.phase = 'SUCCESS';
        _agLog('AGENT-SUCCESS', 'Exploit finished with SUCCESS status', 'ok');
        _hudSetPhase('SUCCESS', 'ok');
        _hudSetStatus('Jailbreak execution complete!');
        _hudSetRetry('');
        const dot = document.getElementById('__ag-dot');
        if (dot) {
          dot.style.background = '#00ffa3';
          dot.style.boxShadow = '0 0 14px #00ffa3';
        }
      } else if (cls === 'fail') {
        if (_state.phase === 'SUCCESS') return;
        _agLog('AGENT-FAIL', 'body.fail detected from finishUI(false)', 'fail');
        _onFailureDetected('finishUI:FAIL', 'Exploit signaled termination failure');
      }
    });
    mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  // ── 15. واجهة الربط المباشرة مع jb.js ─────────────────────────────────
  window.__agentMark = function (tag, detail) {
    _state.lastMarkTime = Date.now();
    _resetStallTimer();

    if (_state.phase === 'IDLE' || _state.phase === 'READY' || _state.phase === 'RETRYING') {
      _state.phase = 'RUNNING';
      _state.startTime = _state.startTime || Date.now();
      _hudSetPhase('RUNNING', '');
      _hudSetStatus(`Executing stage: ${tag}`);
    }

    const cls = _tagClass(tag);
    _agLog(tag, detail, cls);

    if (BAD_RE.test(tag) || BAD_RE.test(detail)) {
      _onFailureDetected(tag, detail);
    } else if (DONE_RE.test(tag) || DONE_RE.test(detail)) {
      _state.phase = 'SUCCESS';
      _hudSetPhase('SUCCESS', 'ok');
      _hudSetStatus('Kernel privileges achieved successfully!');
    }
  };

  window.__agentDump = function () {
    return {
      phase: _state.phase,
      retries: _state.retryCount,
      timing: window.__agentTiming || {},
      failures: _state.failureLog,
      preflightPassed: _state.preflightPassed,
      elapsedSec: _state.startTime ? Math.round((Date.now() - _state.startTime) / 1000) : 0,
      events: _state.eventLog,
      config: AGENT_CFG,
    };
  };

  // ── 16. التهيئة والتشغيل (Bootstrap) ──────────────────────────────────
  function _bootstrap() {
    try {
      const saved = parseInt(sessionStorage.getItem('__ag_retries') || '0', 10);
      _state.retryCount = isNaN(saved) ? 0 : saved;
      if (_state.retryCount > 0) {
        _agLog('AGENT-RESUME', `Session attempt ${_state.retryCount}/${AGENT_CFG.maxRetries}`, 'fix');
      }
    } catch (e) {}

    window.addEventListener('beforeunload', function () {
      try {
        sessionStorage.setItem('__ag_retries', String(_state.retryCount));
      } catch (e) {}
    });

    const initHud = () => {
      _createHud();
      _watchBodyClass();
      _agLog('AGENT-INIT', 'Rogue Agent ready & watching', 'ok');
      _hudSetPhase('READY', '');
      _hudSetStatus('Running preflight checks and memory benchmark...');
      _runPreflight();
      _runBenchmarkAndSanitize();
      _hudSetStatus('Ready. Awaiting payload bootstrap...');
    };

    if (document.body) {
      initHud();
    } else {
      document.addEventListener('DOMContentLoaded', initHud);
    }
  }

  _bootstrap();

})();
