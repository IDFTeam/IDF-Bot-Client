// ==UserScript==
// @name         EchoClient Bridge
// @namespace    https://territorial.io/
// @version      2.0.0
// @description  Sends game state (borders, landData, troopData, offsets) to local EchoClient WS server
// @match        *://*/*
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const WS_URL = 'ws://localhost:60299';
  const UPDATE_INTERVAL_MS = 1000;
  const RECONNECT_INTERVAL_MS = 3000;

  let socket = null;
  let connectTimer = null;
  let lastGameState = null;
  let lastSpawnPhase = null;
  let offsetsSent = false;
  let lastSendTime = 0;
  let panelObserver = null;
  let panelCheckScheduled = false;
  let feedbackTimer = null;
  const PANEL_POS_KEY = 'EchoClientBridge.panelPosition';
  const PANEL_COLLAPSED_KEY = 'EchoClientBridge.panelCollapsed';
  const PANEL_GUARD_INTERVAL_MS = 2000;
  const RESIZE_DEBOUNCE_MS = 100;
  const COMMAND_LOG_LIMIT = 3;

  // ── WebSocket connection ──────────────────────────────────────────────────

  function scheduleReconnect() {
    if (connectTimer) return;
    connectTimer = setTimeout(() => { connectTimer = null; connect(); }, RECONNECT_INTERVAL_MS);
  }

  function connect() {
    if (socket && (socket.readyState === 0 || socket.readyState === 1)) return;
    console.log('[EchoClientBridge] Connecting to', WS_URL);
    try {
      socket = new unsafeWindow.WebSocket(WS_URL);
    } catch (e) {
      console.warn('[EchoClientBridge] WebSocket creation failed:', e);
      socket = null;
      scheduleReconnect();
      return;
    }
    socket.addEventListener('open', () => {
      console.log('[EchoClientBridge] Connected');
      offsetsSent = false;
      const panel = document.getElementById('ab-panel');
      if (panel) {
        updatePanelConnectionState(panel);
        showFeedback(panel, 'Bridge connected', 'ok');
      }
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
    });
    socket.addEventListener('close', () => {
      console.log('[EchoClientBridge] Connection closed — retrying in 3s');
      offsetsSent = false;
      socket = null;
      const panel = document.getElementById('ab-panel');
      if (panel) {
        updatePanelConnectionState(panel);
        showFeedback(panel, 'Bridge disconnected', 'err');
      }
      scheduleReconnect();
    });
    socket.addEventListener('error', () => {
      socket = null;
      const panel = document.getElementById('ab-panel');
      if (panel) updatePanelConnectionState(panel);
    });
  }

  function isSocketLive() {
    return !!socket && socket.readyState === 1;
  }

  function send(obj) {
    if (!isSocketLive()) return false;
    try {
      socket.send(JSON.stringify(obj));
      return true;
    }
    catch (e) {
      console.warn('[EchoClientBridge] Send error', e);
      return false;
    }
  }

  // ── Data access ───────────────────────────────────────────────────────────

  function getPlayerIdByName(name) {
    try {
      const names = unsafeWindow.aD.data.playerNamesData;
      if (!names) return null;
      const lower = String(name).toLowerCase();
      for (let i = 0; i < names.length; i++) {
        if (names[i] && String(names[i]).toLowerCase().includes(lower)) return i;
      }
      return null;
    } catch { return null; }
  }

  function resolvePlayerId(input) {
    const num = parseInt(input);
    if (!isNaN(num)) return num;
    return getPlayerIdByName(input);
  }

  function getGameStarted() {
    try { return unsafeWindow.aD.a5z(); }
    catch { return null; }
  }

  function getGameData() {
    try {
      const ag = unsafeWindow.ag;
      const ac = unsafeWindow.ac;
      if (!ag || !ac) return null;
      return { troopData: ag.hA, landData: ag.gw, borders: ag.go, offsets: ac.fA };
    } catch { return null; }
  }

  // ── Send helpers ──────────────────────────────────────────────────────────

  function sendOffsets(offsets) {
    if (!offsets) return;
    send({ type: 'offsets', offsets: Array.from(offsets) });
    console.log('[EchoClientBridge] Offsets sent:', Array.from(offsets));
  }

  function sendGameState(data) {
    if (data.borders) send({ type: 'borders', borders: Array.from(data.borders, (cell) => (cell ? Array.from(cell) : [])) });
    if (data.landData) send({ type: 'landData', landData: Array.from(data.landData) });
    if (data.troopData) send({ type: 'troopData', troopData: Array.from(data.troopData) });
  }

  // ── Game state monitor (rAF loop) ─────────────────────────────────────────

  function monitorGameState() {
    const currentState = getGameStarted();
    if (currentState === true && lastGameState !== true) {
      console.log('[EchoClientBridge] Game started');
      offsetsSent = false;
      lastSpawnPhase = null;
      send({ type: 'command', action: 'openingstart' });
      console.log('[EchoClientBridge] Sent openingstart command');
    }
    if (currentState !== true && lastGameState === true) {
      console.log('[EchoClientBridge] Game ended');
      offsetsSent = false;
      lastSpawnPhase = null;
    }
    lastGameState = currentState;
    if (currentState === true) {
      const data = getGameData();
      if (data) {
        if (!offsetsSent) { sendOffsets(data.offsets); offsetsSent = true; }
        const now = Date.now();
        if (now - lastSendTime >= UPDATE_INTERVAL_MS) { lastSendTime = now; sendGameState(data); }
      }
    }
    requestAnimationFrame(monitorGameState);
  }

  // ── Spawn phase monitor (rAF loop) ────────────────────────────────────────

  function monitorSpawnPhase() {
    try {
      const spawnPhase = unsafeWindow.bC.gU.hJ(0);
      const isSpawnPhase = !!spawnPhase;
      const wasSpawnPhase = !!lastSpawnPhase;
      if (isSpawnPhase !== wasSpawnPhase) {
        console.log(`[EchoClientBridge] Spawn phase changed: ${wasSpawnPhase} -> ${isSpawnPhase}`);
      }
      if (isSpawnPhase && !wasSpawnPhase) {
        try {
          const data = unsafeWindow.aD.data;
          const mapType = data.mapType;
          const mapIndex = mapType === 0 ? data.mapProceduralIndex : data.mapRealisticIndex;
          const mapWidth = unsafeWindow.bU.fJ;
          console.log(`[EchoClientBridge] Spawn phase active — mapType=${mapType} mapIndex=${mapIndex} mapWidth=${mapWidth}`);
          setTimeout(() => {
            send({ type: 'command', action: 'spawn', mapType, mapIndex, mapWidth });
            console.log(`[EchoClientBridge] Spawn command sent (after 2s delay)`);
          }, 2000);
        } catch (e) { console.warn('[EchoClientBridge] Failed to read map info for spawn:', e); }
      }
      lastSpawnPhase = (!isSpawnPhase && wasSpawnPhase) ? false : isSpawnPhase;
    } catch (e) { console.warn('[EchoClientBridge] monitorSpawnPhase error:', e); }
    requestAnimationFrame(monitorSpawnPhase);
  }

  // ── Wait for game functions ───────────────────────────────────────────────

  function waitForFunction() {
    try {
      if (typeof unsafeWindow.aD === 'object' && unsafeWindow.aD !== null && typeof unsafeWindow.aD.a5z === 'function') {
        console.log('[EchoClientBridge] Game functions ready — starting monitor');
        lastGameState = null;
        requestAnimationFrame(monitorGameState);
      } else { setTimeout(waitForFunction, 50); }
    } catch { setTimeout(waitForFunction, 50); }
  }

  function waitForSpawnFunction() {
    try {
      if (typeof unsafeWindow.bC === 'object' && unsafeWindow.bC !== null &&
          typeof unsafeWindow.bC.gU === 'object' && unsafeWindow.bC.gU !== null &&
          typeof unsafeWindow.bC.gU.hJ === 'function') {
        console.log('[EchoClientBridge] Spawn functions ready — starting spawn monitor');
        requestAnimationFrame(monitorSpawnPhase);
      } else { setTimeout(waitForSpawnFunction, 50); }
    } catch { setTimeout(waitForSpawnFunction, 50); }
  }

  // ── Premium UI styles ─────────────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById('ab-styles')) return;
    const s = document.createElement('style');
    s.id = 'ab-styles';
    s.textContent = `

      @import url('https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600&display=swap');

      /* ── Entrance ───────────────────────────────────────── */
      @keyframes ab-enter {
        from { opacity: 0; transform: translateY(10px) scale(0.98); }
        to   { opacity: 1; transform: translateY(0)    scale(1);    }
      }

      /* ── Status dot pulse ─────────────────────────────────── */
      @keyframes ab-dot-live {
        0%,100% { box-shadow: 0 0 0 0   rgba(74,222,128,0.55); }
        60%     { box-shadow: 0 0 0 4px rgba(74,222,128,0);    }
      }

      /* ── Invalid input shake ──────────────────────────────── */
      @keyframes ab-invalid-shake {
        0%,100% { transform: translateX(0); }
        20% { transform: translateX(-3px); }
        40% { transform: translateX(3px); }
        60% { transform: translateX(-2px); }
        80% { transform: translateX(2px); }
      }

      /* ══════════════════════════════════════════════════════
         PANEL ROOT
      ══════════════════════════════════════════════════════ */
      #ab-panel {
        position: fixed !important;
        top: 80px !important;
        right: 16px !important;
        z-index: 2147483647 !important;
        width: min(300px, calc(100vw - 24px)) !important;
        max-width: calc(100vw - 24px) !important;
        min-width: 0 !important;
        box-sizing: border-box !important;
        font-family: 'DM Sans', 'Segoe UI', system-ui, -apple-system, sans-serif !important;
        color: #f1f5f9 !important;
        user-select: none !important;
        pointer-events: all !important;
        cursor: grab !important;
        touch-action: none !important;
        display: block !important;
        visibility: visible !important;
        opacity: 1 !important;
        animation: ab-enter 0.4s cubic-bezier(0.16,1,0.3,1) both !important;
        filter: none !important;
        box-shadow: none !important;
      }
      #ab-panel.ab-dragging {
        transition: none !important;
        cursor: grabbing !important;
      }
      #ab-panel.ab-dragging * {
        cursor: grabbing !important;
      }

      /* ══════════════════════════════════════════════════════
         GLASS SHELL  (g-card style, à la glas.html)
      ══════════════════════════════════════════════════════ */
      .ab-glow-border {
        border-radius: 18px !important;
        padding: 0 !important;
        background: transparent !important;
        animation: none !important;
        box-shadow: none !important;
      }

      .ab-glass {
        position: relative !important;
        overflow: hidden !important;
        border-radius: 18px !important;
        padding: 14px !important;
        background: rgba(10,10,12,0.82) !important;
        border: 1px solid rgba(255,255,255,0.08) !important;
        backdrop-filter: blur(16px) saturate(1.3) !important;
        -webkit-backdrop-filter: blur(16px) saturate(1.3) !important;
        box-shadow:
          rgba(34,42,53,0.06) 0px 0px 24px,
          rgba(0,0,0,0.05) 0px 1px 1px,
          rgba(47,48,55,0.05) 0px 16px 68px,
          rgba(255,255,255,0.1) 0px 1px 0px inset !important;
        animation: none !important;
      }
      /* Top sheen, like .g-card::after */
      .ab-glass::before {
        content: '' !important;
        position: absolute !important; inset: 0 !important;
        border-radius: inherit !important;
        background: radial-gradient(ellipse at 50% 0%, rgba(255,255,255,0.07) 0%, transparent 65%) !important;
        opacity: 0.6 !important;
        pointer-events: none !important;
        z-index: 0 !important;
        animation: none !important;
      }
      .ab-glass::after { content: none !important; }
      .ab-glass > * { position: relative !important; z-index: 1 !important; }

      /* ══════════════════════════════════════════════════════
         HEADER
      ══════════════════════════════════════════════════════ */
      .ab-header {
        display: flex !important;
        justify-content: space-between !important;
        align-items: center !important;
        margin-bottom: 12px !important;
        padding: 0 0 10px !important;
        border-bottom: 1px solid rgba(255,255,255,0.07) !important;
        cursor: grab !important;
        touch-action: none !important;
      }
      .ab-header:active { cursor: grabbing !important; }

      /* Logo, like .nav-brand-icon */
      .ab-logo {
        width: 26px !important;
        height: 26px !important;
        border-radius: 50% !important;
        background: linear-gradient(135deg, rgba(255,255,255,0.18), rgba(255,255,255,0.05)) !important;
        border: 1px solid rgba(255,255,255,0.12) !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        flex-shrink: 0 !important;
        box-shadow: none !important;
      }
      .ab-logo svg path { fill: #f1f5f9 !important; fill-opacity: 0.95 !important; }

      /* Title, like .nav-brand-name */
      .ab-title {
        display: flex !important;
        align-items: center !important;
        gap: 9px !important;
        font-size: 13px !important;
        font-weight: 400 !important;
        letter-spacing: 0 !important;
        text-transform: none !important;
        text-shadow: none !important;
        background: none !important;
        -webkit-text-fill-color: initial !important;
        background-clip: initial !important;
        animation: none !important;
      }
      .ab-title-stack {
        display: flex !important;
        flex-direction: column !important;
        gap: 1px !important;
        line-height: 1.15 !important;
      }
      .ab-brand-main {
        font-family: 'Syne', sans-serif !important;
        font-size: 14px !important;
        font-weight: 700 !important;
        letter-spacing: -0.01em !important;
        background: linear-gradient(90deg, #fff, #d1d5db, #fff) !important;
        -webkit-background-clip: text !important;
        -webkit-text-fill-color: transparent !important;
        background-clip: text !important;
      }
      .ab-subtitle {
        font-size: 9px !important;
        font-weight: 500 !important;
        letter-spacing: 0.12em !important;
        text-transform: uppercase !important;
        color: #475569 !important;
        -webkit-text-fill-color: #475569 !important;
      }

      /* Header right cluster */
      .ab-header-right {
        display: flex !important;
        align-items: center !important;
        gap: 6px !important;
      }

      /* Version pill, like .panel-count */
      .ab-version {
        font-size: 9px !important;
        font-weight: 600 !important;
        letter-spacing: 0.06em !important;
        text-transform: uppercase !important;
        background: rgba(255,255,255,0.04) !important;
        border: 1px solid rgba(255,255,255,0.08) !important;
        border-radius: 9999px !important;
        padding: 3px 9px !important;
        color: #94a3b8 !important;
        -webkit-text-fill-color: #94a3b8 !important;
      }

      /* Minimise button, like .ab-min-btn but glassy + round */
      .ab-min-btn {
        width: 22px !important;
        height: 22px !important;
        border-radius: 50% !important;
        background: rgba(255,255,255,0.04) !important;
        border: 1px solid rgba(255,255,255,0.08) !important;
        color: #94a3b8 !important;
        -webkit-text-fill-color: #94a3b8 !important;
        font-size: 14px !important;
        line-height: 1 !important;
        cursor: pointer !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        flex-shrink: 0 !important;
        box-shadow: none !important;
        transition: background 0.2s, border-color 0.2s, color 0.2s !important;
      }
      .ab-min-btn:hover {
        background: rgba(255,255,255,0.09) !important;
        border-color: rgba(255,255,255,0.16) !important;
        color: #e2e8f0 !important;
        -webkit-text-fill-color: #e2e8f0 !important;
        box-shadow: none !important;
        transform: none !important;
      }
      .ab-min-btn:active { transform: scale(0.94) !important; }

      /* ══════════════════════════════════════════════════════
         COLLAPSIBLE BODY
      ══════════════════════════════════════════════════════ */
      .ab-body {
        overflow: hidden !important;
        max-height: 720px !important;
        transition: max-height 0.36s cubic-bezier(0.4,0,0.2,1), opacity 0.3s ease !important;
      }
      .ab-body.ab-collapsed {
        max-height: 0 !important;
        opacity: 0 !important;
      }

      /* ══════════════════════════════════════════════════════
         STATUS BAR  (like .proxy-stat)
      ══════════════════════════════════════════════════════ */
      .ab-status {
        display: flex !important;
        align-items: center !important;
        gap: 8px !important;
        padding: 9px 12px !important;
        background: rgba(255,255,255,0.03) !important;
        border: 1px solid rgba(255,255,255,0.06) !important;
        border-radius: 12px !important;
        margin-bottom: 10px !important;
        position: relative !important;
        overflow: hidden !important;
        box-shadow: none !important;
      }
      .ab-status::before,
      .ab-status::after { content: none !important; }

      .ab-dot {
        width: 6px !important;
        height: 6px !important;
        border-radius: 50% !important;
        flex-shrink: 0 !important;
        transition: background 0.3s, box-shadow 0.3s !important;
      }
      .ab-dot.on {
        background: #4ade80 !important;
        box-shadow: 0 0 6px rgba(74,222,128,0.7) !important;
        animation: ab-dot-live 2.2s ease-in-out infinite !important;
      }
      .ab-dot.off {
        background: #475569 !important;
        box-shadow: none !important;
      }

      .ab-status-txt {
        font-size: 11px !important;
        font-weight: 500 !important;
        color: #cbd5e1 !important;
        -webkit-text-fill-color: #cbd5e1 !important;
        letter-spacing: 0 !important;
        text-shadow: none !important;
      }

      /* ══════════════════════════════════════════════════════
         FEEDBACK BAR
      ══════════════════════════════════════════════════════ */
      .ab-feedback {
        min-height: 24px !important;
        display: flex !important;
        align-items: center !important;
        padding: 0 10px !important;
        margin: -2px 0 8px !important;
        border-radius: 10px !important;
        font-size: 11px !important;
        font-weight: 500 !important;
        color: #475569 !important;
        -webkit-text-fill-color: #475569 !important;
        background: rgba(255,255,255,0.02) !important;
        border: 1px solid rgba(255,255,255,0.05) !important;
        opacity: 0 !important;
        transform: translateY(-2px) !important;
        transition: opacity 0.18s ease, transform 0.18s ease, border-color 0.18s ease, background 0.18s ease, color 0.18s ease !important;
      }
      .ab-feedback.show {
        opacity: 1 !important;
        transform: translateY(0) !important;
      }
      .ab-feedback.ok {
        color: #4ade80 !important;
        -webkit-text-fill-color: #4ade80 !important;
        background: rgba(74,222,128,0.07) !important;
        border-color: rgba(74,222,128,0.18) !important;
      }
      .ab-feedback.err {
        color: #f87171 !important;
        -webkit-text-fill-color: #f87171 !important;
        background: rgba(248,113,113,0.07) !important;
        border-color: rgba(248,113,113,0.18) !important;
      }

      /* ══════════════════════════════════════════════════════
         SECTION HEADINGS  (like .section-eyebrow)
      ══════════════════════════════════════════════════════ */
      .ab-section {
        font-size: 10px !important;
        font-weight: 600 !important;
        letter-spacing: 0.12em !important;
        text-transform: uppercase !important;
        color: #334155 !important;
        -webkit-text-fill-color: #334155 !important;
        margin: 12px 0 8px !important;
        display: block !important;
      }
      .ab-section::before,
      .ab-section::after { content: none !important; }

      /* ══════════════════════════════════════════════════════
         ROWS / LABELS
      ══════════════════════════════════════════════════════ */
      .ab-row {
        display: flex !important;
        align-items: center !important;
        gap: 6px !important;
        margin: 6px 0 !important;
        min-height: 0 !important;
        padding: 0 !important;
        background: none !important;
        border: none !important;
        box-shadow: none !important;
      }
      .ab-row:not(.ab-toggle-row):hover {
        background: none !important;
        border: none !important;
        transition: none !important;
      }

      .ab-lbl {
        width: 62px !important;
        font-size: 10px !important;
        font-weight: 500 !important;
        color: #94a3b8 !important;
        -webkit-text-fill-color: #94a3b8 !important;
        flex-shrink: 0 !important;
        letter-spacing: 0 !important;
        text-shadow: none !important;
        white-space: nowrap !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
      }

      /* ══════════════════════════════════════════════════════
         INPUTS  —  like .form-input-sm
      ══════════════════════════════════════════════════════ */
      .ab-inp {
        height: 30px !important;
        box-sizing: border-box !important;
        background: rgba(255,255,255,0.04) !important;
        background-image: radial-gradient(ellipse at 50% 0%, rgba(255,255,255,0.06) 0%, transparent 65%) !important;
        border: 1px solid rgba(255,255,255,0.08) !important;
        border-radius: 9px !important;
        padding: 0 9px !important;
        font-size: 11px !important;
        font-weight: 400 !important;
        font-family: 'DM Sans', sans-serif !important;
        color: #e2e8f0 !important;
        -webkit-text-fill-color: #e2e8f0 !important;
        outline: none !important;
        cursor: text !important;
        transition: border-color 0.2s, background 0.2s !important;
        box-shadow: none !important;
      }
      .ab-inp:focus {
        border-color: rgba(255,255,255,0.22) !important;
        background: rgba(255,255,255,0.06) !important;
        box-shadow: none !important;
      }
      .ab-inp::placeholder {
        color: #475569 !important;
        -webkit-text-fill-color: #475569 !important;
      }
      .ab-inp-id  {
        flex: 1 1 auto !important;
        width: auto !important;
        min-width: 0 !important;
      }
      .ab-inp-pct {
        width: 38px !important;
        flex: 0 0 38px !important;
        text-align: center !important;
        padding: 0 4px !important;
      }

      /* ══════════════════════════════════════════════════════
         BUTTONS  —  pill-shaped, like .btn-solid / .btn-sm
      ══════════════════════════════════════════════════════ */
      .ab-btn {
        height: 30px !important;
        background: rgba(255,255,255,0.08) !important;
        border: 1px solid rgba(255,255,255,0.1) !important;
        color: #fff !important;
        -webkit-text-fill-color: #fff !important;
        padding: 0 14px !important;
        border-radius: 9999px !important;
        cursor: pointer !important;
        font-size: 11px !important;
        font-weight: 500 !important;
        font-family: 'DM Sans', sans-serif !important;
        letter-spacing: 0 !important;
        flex-shrink: 0 !important;
        position: relative !important;
        overflow: hidden !important;
        min-width: 46px !important;
        box-shadow: none !important;
        transition: background 0.2s, border-color 0.2s, color 0.2s !important;
      }
      .ab-btn::after,
      .ab-btn::before { content: none !important; }
      .ab-btn:hover {
        background: rgba(255,255,255,0.13) !important;
        transform: none !important;
        box-shadow: none !important;
      }
      .ab-btn:active {
        transform: none !important;
        filter: brightness(0.92) !important;
      }
      .ab-btn:disabled {
        opacity: 0.4 !important;
        filter: grayscale(0.4) !important;
        cursor: not-allowed !important;
        transform: none !important;
      }

      /* ── Donate  (violet tint, like .tag-pro) */
      .ab-purple {
        background: rgba(167,139,250,0.08) !important;
        border-color: rgba(167,139,250,0.22) !important;
        color: #c4b5fd !important;
        -webkit-text-fill-color: #c4b5fd !important;
      }
      .ab-purple:hover {
        background: rgba(167,139,250,0.16) !important;
        border-color: rgba(167,139,250,0.35) !important;
      }

      /* ── Self-donate  (sky tint) */
      .ab-blue {
        background: rgba(56,189,248,0.08) !important;
        border-color: rgba(56,189,248,0.22) !important;
        color: #7dd3fc !important;
        -webkit-text-fill-color: #7dd3fc !important;
      }
      .ab-blue:hover {
        background: rgba(56,189,248,0.16) !important;
        border-color: rgba(56,189,248,0.35) !important;
      }

      /* ── Start  (green tint, like .tag-free) */
      .ab-green {
        background: rgba(74,222,128,0.08) !important;
        border-color: rgba(74,222,128,0.22) !important;
        color: #4ade80 !important;
        -webkit-text-fill-color: #4ade80 !important;
      }
      .ab-green:hover {
        background: rgba(74,222,128,0.16) !important;
        border-color: rgba(74,222,128,0.35) !important;
      }

      /* ── Stop / Attack  (red tint) */
      .ab-red {
        background: rgba(248,113,113,0.08) !important;
        border-color: rgba(248,113,113,0.22) !important;
        color: #f87171 !important;
        -webkit-text-fill-color: #f87171 !important;
      }
      .ab-red:hover {
        background: rgba(248,113,113,0.16) !important;
        border-color: rgba(248,113,113,0.35) !important;
      }

      /* ── Opening phase  (amber tint) */
      .ab-ghost {
        background: rgba(251,191,36,0.08) !important;
        border-color: rgba(251,191,36,0.22) !important;
        color: #fbbf24 !important;
        -webkit-text-fill-color: #fbbf24 !important;
      }
      .ab-ghost:hover {
        background: rgba(251,191,36,0.16) !important;
        border-color: rgba(251,191,36,0.35) !important;
      }

      /* ══════════════════════════════════════════════════════
         DIVIDER
      ══════════════════════════════════════════════════════ */
      .ab-divider {
        height: 1px !important;
        border: none !important;
        background: rgba(255,255,255,0.07) !important;
        margin: 12px 0 !important;
      }

      /* ══════════════════════════════════════════════════════
         BOT-CONTROL ROW
      ══════════════════════════════════════════════════════ */
      .ab-ctrl-row {
        display: flex !important;
        gap: 6px !important;
        margin-top: 6px !important;
      }
      .ab-ctrl-row .ab-btn {
        flex: 1 !important;
        height: 32px !important;
        text-align: center !important;
        padding: 0 5px !important;
        font-size: 11px !important;
      }

      /* ══════════════════════════════════════════════════════
         KEYBOARD HINT
      ══════════════════════════════════════════════════════ */
      .ab-hint {
        font-size: 9px !important;
        font-weight: 500 !important;
        color: #334155 !important;
        -webkit-text-fill-color: #334155 !important;
        text-align: center !important;
        margin-top: 10px !important;
        letter-spacing: 0.08em !important;
        opacity: 1 !important;
      }

      /* ── Name-lookup toggle row, like .token-row ─────────── */
      .ab-toggle-row {
        align-items: flex-start !important;
        justify-content: flex-start !important;
        gap: 8px !important;
        padding: 8px 10px !important;
        border: 1px solid rgba(255,255,255,0.06) !important;
        border-radius: 10px !important;
        background: rgba(255,255,255,0.02) !important;
        margin: 6px 0 !important;
      }
      .ab-toggle {
        width: 13px !important;
        height: 13px !important;
        margin: 1px 0 0 !important;
        cursor: pointer !important;
        accent-color: #e2e8f0 !important;
        filter: none !important;
        flex-shrink: 0 !important;
      }
      .ab-toggle-label {
        font-size: 10.5px !important;
        color: #cbd5e1 !important;
        -webkit-text-fill-color: #cbd5e1 !important;
        font-weight: 500 !important;
        letter-spacing: 0 !important;
        flex-shrink: 0 !important;
      }
      .ab-target-note {
        font-size: 10px !important;
        line-height: 1.3 !important;
        color: #475569 !important;
        -webkit-text-fill-color: #475569 !important;
        font-weight: 400 !important;
        flex: 1 !important;
        min-width: 0 !important;
      }

      /* ── Self-donate readonly field + spacer ─────────────── */
      .ab-self-target {
        pointer-events: none !important;
        text-align: center !important;
        color: #64748b !important;
        -webkit-text-fill-color: #64748b !important;
        cursor: default !important;
        background: rgba(255,255,255,0.02) !important;
      }
      .ab-input-spacer {
        width: 80px !important;
        height: 30px !important;
        box-sizing: border-box !important;
        display: inline-flex !important;
        align-items: center !important;
        padding: 0 8px !important;
        border-radius: 9px !important;
        color: #475569 !important;
        -webkit-text-fill-color: #475569 !important;
        background: rgba(255,255,255,0.02) !important;
        border: 1px dashed rgba(255,255,255,0.07) !important;
        font-size: 10px !important;
        font-weight: 400 !important;
      }

      /* ══════════════════════════════════════════════════════
         RECENT-COMMANDS LOG  (like .proxy-list)
      ══════════════════════════════════════════════════════ */
      .ab-log {
        margin-top: 10px !important;
        padding: 10px 12px !important;
        border-radius: 12px !important;
        background: rgba(255,255,255,0.03) !important;
        border: 1px solid rgba(255,255,255,0.06) !important;
        box-shadow: none !important;
      }
      .ab-log-title {
        font-size: 9.5px !important;
        font-weight: 600 !important;
        letter-spacing: 0.1em !important;
        color: #334155 !important;
        -webkit-text-fill-color: #334155 !important;
        text-transform: uppercase !important;
        margin-bottom: 6px !important;
      }
      .ab-log-lines {
        display: flex !important;
        flex-direction: column !important;
        gap: 4px !important;
        min-height: 40px !important;
      }
      .ab-log-line {
        display: flex !important;
        justify-content: space-between !important;
        gap: 8px !important;
        font-size: 10.5px !important;
        line-height: 1.3 !important;
        color: #94a3b8 !important;
        -webkit-text-fill-color: #94a3b8 !important;
      }
      .ab-log-time {
        color: #334155 !important;
        -webkit-text-fill-color: #334155 !important;
        flex-shrink: 0 !important;
        font-family: 'SF Mono', 'DM Sans', monospace !important;
      }

      /* ══════════════════════════════════════════════════════
         UX STATES
      ══════════════════════════════════════════════════════ */
      .ab-inp.ab-invalid {
        border-color: rgba(248,113,113,0.6) !important;
        box-shadow: 0 0 0 2px rgba(248,113,113,0.15) !important;
        animation: ab-invalid-shake 0.28s ease !important;
      }

      #ab-panel.ab-offline .ab-command-btn {
        opacity: 0.4 !important;
        filter: grayscale(0.5) !important;
        cursor: not-allowed !important;
        pointer-events: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(s);
  }

  // ── Build premium UI panel ─────────────────────────────────────────────────

  function getSavedPanelPosition() {
    try {
      const raw = localStorage.getItem(PANEL_POS_KEY);
      if (!raw) return null;
      const pos = JSON.parse(raw);
      if (Number.isFinite(pos.left) && Number.isFinite(pos.top)) return pos;
    } catch {}
    return null;
  }

  function savePanelPosition(left, top) {
    try { localStorage.setItem(PANEL_POS_KEY, JSON.stringify({ left, top })); }
    catch {}
  }

  function clampPanelPosition(panel, left, top) {
    const rect = panel.getBoundingClientRect();
    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
    return {
      left: Math.min(Math.max(left, margin), maxLeft),
      top: Math.min(Math.max(top, margin), maxTop)
    };
  }

  function restorePanelPosition(panel) {
    const saved = getSavedPanelPosition();
    if (!saved) return;
    const pos = clampPanelPosition(panel, saved.left, saved.top);
    panel.style.setProperty('right', 'auto', 'important');
    panel.style.setProperty('left', `${pos.left}px`, 'important');
    panel.style.setProperty('top', `${pos.top}px`, 'important');
  }

  function getSavedCollapsed() {
    try { return localStorage.getItem(PANEL_COLLAPSED_KEY) === '1'; }
    catch { return false; }
  }

  function saveCollapsed(collapsed) {
    try { localStorage.setItem(PANEL_COLLAPSED_KEY, collapsed ? '1' : '0'); }
    catch {}
  }

  function showFeedback(panel, message, kind = 'ok') {
    const el = panel.querySelector('.ab-feedback');
    if (!el) return;
    if (feedbackTimer) clearTimeout(feedbackTimer);
    el.textContent = message;
    el.className = `ab-feedback show ${kind}`;
    feedbackTimer = setTimeout(() => {
      el.className = 'ab-feedback';
      feedbackTimer = null;
    }, 2400);
  }

  function addCommandLog(panel, message, kind = 'ok') {
    const lines = panel.querySelector('.ab-log-lines');
    if (!lines) return;
    const empty = lines.querySelector('.ab-log-empty');
    if (empty) empty.remove();

    const line = document.createElement('div');
    line.className = `ab-log-line ${kind}`;
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    line.innerHTML = `<span>${message}</span><span class="ab-log-time">${time}</span>`;
    lines.prepend(line);
    while (lines.children.length > COMMAND_LOG_LIMIT) lines.lastElementChild.remove();
  }

  function flashInvalid(...els) {
    els.filter(Boolean).forEach((el) => {
      el.classList.remove('ab-invalid');
      void el.offsetWidth;
      el.classList.add('ab-invalid');
      setTimeout(() => el.classList.remove('ab-invalid'), 650);
    });
  }

  function setBodyCollapsed(body, minBtn, collapsed) {
    body.classList.toggle('ab-collapsed', collapsed);
    body.style.maxHeight = collapsed ? '0px' : '720px';
    body.style.opacity = collapsed ? '0' : '1';
    minBtn.textContent = collapsed ? '+' : '-';
    minBtn.title = collapsed ? 'Expand' : 'Minimise';
  }

  function updatePanelConnectionState(panel) {
    const live = isSocketLive();
    panel.classList.toggle('ab-offline', !live);
    panel.querySelectorAll('.ab-command-btn').forEach((btn) => { btn.disabled = !live; });
    const dot = panel.querySelector('#ab-dot');
    const txt = panel.querySelector('#ab-status-txt');
    if (dot) dot.className = `ab-dot ${live ? 'on' : 'off'}`;
    if (txt) txt.textContent = live ? 'Connected' : 'Disconnected';
  }

  function installPanelDrag(panel, handle) {
    let drag = null;
    let previousUserSelect = '';
    let previousCursor = '';
    let resizeTimer = null;

    function isInteractiveTarget(target) {
      return target &&
        typeof target.closest === 'function' &&
        target.closest('button, input, textarea, select, a, label');
    }

    function beginDrag(e) {
      if (e.button != null && e.button !== 0) return;
      if (isInteractiveTarget(e.target)) return;

      const rect = panel.getBoundingClientRect();
      drag = {
        pointerId: e.pointerId,
        offsetX: e.clientX - rect.left,
        offsetY: e.clientY - rect.top
      };

      panel.style.setProperty('animation', 'none', 'important');
      panel.style.setProperty('right', 'auto', 'important');
      panel.style.setProperty('bottom', 'auto', 'important');
      panel.style.setProperty('left', `${rect.left}px`, 'important');
      panel.style.setProperty('top', `${rect.top}px`, 'important');
      panel.classList.add('ab-dragging');

      previousUserSelect = document.body.style.userSelect;
      previousCursor = document.documentElement.style.cursor;
      document.body.style.userSelect = 'none';
      document.documentElement.style.cursor = 'grabbing';

      document.addEventListener('pointermove', moveDrag, { capture: true, passive: false });
      document.addEventListener('pointerup', endDrag, { capture: true });
      document.addEventListener('pointercancel', endDrag, { capture: true });
      e.preventDefault();
    }

    function moveDrag(e) {
      if (!drag || e.pointerId !== drag.pointerId) return;
      const pos = clampPanelPosition(panel, e.clientX - drag.offsetX, e.clientY - drag.offsetY);
      panel.style.setProperty('left', `${pos.left}px`, 'important');
      panel.style.setProperty('top', `${pos.top}px`, 'important');
      e.preventDefault();
    }

    function endDrag(e) {
      if (!drag || (e && e.pointerId !== drag.pointerId)) return;
      document.removeEventListener('pointermove', moveDrag, { capture: true });
      document.removeEventListener('pointerup', endDrag, { capture: true });
      document.removeEventListener('pointercancel', endDrag, { capture: true });

      const rect = panel.getBoundingClientRect();
      const pos = clampPanelPosition(panel, rect.left, rect.top);
      panel.style.setProperty('left', `${pos.left}px`, 'important');
      panel.style.setProperty('top', `${pos.top}px`, 'important');
      panel.classList.remove('ab-dragging');
      savePanelPosition(pos.left, pos.top);
      document.body.style.userSelect = previousUserSelect;
      document.documentElement.style.cursor = previousCursor;
      drag = null;
    }

    handle.addEventListener('pointerdown', beginDrag, { passive: false });

    window.addEventListener('resize', () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!document.body || !document.body.contains(panel) || !panel.style.left) return;
        const rect = panel.getBoundingClientRect();
        const pos = clampPanelPosition(panel, rect.left, rect.top);
        panel.style.setProperty('left', `${pos.left}px`, 'important');
        panel.style.setProperty('top', `${pos.top}px`, 'important');
        savePanelPosition(pos.left, pos.top);
      }, RESIZE_DEBOUNCE_MS);
    });
  }

  function buildUI() {
    injectStyles();

    const panel = document.createElement('div');
    panel.id = 'ab-panel';

    // ── Animated gradient border wrapper
    const glowBorder = document.createElement('div');
    glowBorder.className = 'ab-glow-border';
    panel.appendChild(glowBorder);

    const glass = document.createElement('div');
    glass.className = 'ab-glass';
    glowBorder.appendChild(glass);

    // ── Header
    const header = document.createElement('div');
    header.className = 'ab-header';
    glass.appendChild(header);

    const title = document.createElement('div');
    title.className = 'ab-title';
    title.innerHTML = `
      <span class="ab-logo">
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M6.5 1L8.5 4.5H11.5L9 7L10 11L6.5 9L3 11L4 7L1.5 4.5H4.5L6.5 1Z"
            fill="white" fill-opacity="0.95"/>
        </svg>
      </span>
      <span class="ab-title-stack">
        <span class="ab-brand-main">EchoClient</span>
        <span class="ab-subtitle">Command Core</span>
      </span>
    `;
    header.appendChild(title);

    const headerRight = document.createElement('div');
    headerRight.className = 'ab-header-right';
    header.appendChild(headerRight);

    const verBadge = document.createElement('span');
    verBadge.className = 'ab-version';
    verBadge.textContent = 'v2.0';
    headerRight.appendChild(verBadge);

    const minBtn = document.createElement('button');
    minBtn.className = 'ab-min-btn';
    minBtn.textContent = '−';
    minBtn.title = 'Minimise';
    headerRight.appendChild(minBtn);

    // ── Collapsible body
    const body = document.createElement('div');
    body.className = 'ab-body';
    body.id = 'ab-body';
    glass.appendChild(body);

    let minimised = getSavedCollapsed();
    setBodyCollapsed(body, minBtn, minimised);
    minBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      minimised = !minimised;
      setBodyCollapsed(body, minBtn, minimised);
      saveCollapsed(minimised);
    });

    // ── Status bar
    const statusBar = document.createElement('div');
    statusBar.className = 'ab-status';
    const dot = document.createElement('span');
    dot.id = 'ab-dot';
    dot.className = 'ab-dot off';
    const statusTxt = document.createElement('span');
    statusTxt.id = 'ab-status-txt';
    statusTxt.className = 'ab-status-txt';
    statusTxt.textContent = 'Disconnected';
    statusBar.appendChild(dot);
    statusBar.appendChild(statusTxt);
    body.appendChild(statusBar);

    const feedback = document.createElement('div');
    feedback.className = 'ab-feedback';
    feedback.textContent = 'Ready';
    body.appendChild(feedback);

    // ── Section helper
    function section(label) {
      const el = document.createElement('div');
      el.className = 'ab-section';
      el.textContent = label;
      body.appendChild(el);
    }

    function sendCommand(command, label) {
      if (!isSocketLive()) {
        showFeedback(panel, 'Bridge disconnected. Start the local server first.', 'err');
        addCommandLog(panel, `${label} blocked`, 'err');
        return false;
      }
      if (!send(command)) {
        showFeedback(panel, `${label} failed to send`, 'err');
        addCommandLog(panel, `${label} failed`, 'err');
        return false;
      }
      showFeedback(panel, `${label} sent`, 'ok');
      addCommandLog(panel, label, 'ok');
      console.log(`[EchoClientBridge] Sent ${label}`);
      return true;
    }

    // ── Row helper (id + pct inputs)
    function addRow(labelText, idPrefix, btnClass, onSubmit) {
      const row = document.createElement('div');
      row.className = 'ab-row';
      row.innerHTML = `
        <span class="ab-lbl">${labelText}</span>
        <input id="ab-${idPrefix}" type="text" placeholder="ID / Name" class="ab-inp ab-inp-id">
        <input id="ab-${idPrefix}-pct" type="text" placeholder="%" class="ab-inp ab-inp-pct">
      `;
      const btn = document.createElement('button');
      btn.className = `ab-btn ab-command-btn ${btnClass}`;
      btn.textContent = 'Send';
      const targetInput = row.querySelector(`#ab-${idPrefix}`);
      const pctInput = row.querySelector(`#ab-${idPrefix}-pct`);
      const submit = () => onSubmit({ row, btn, targetInput, pctInput });
      btn.addEventListener('click', submit);
      [targetInput, pctInput].forEach((input) => {
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        });
      });
      row.appendChild(btn);
      body.appendChild(row);
      return { row, btn, targetInput, pctInput, submit };
    }

    section('Commands');

    // Name-based toggle
    const nameRow = document.createElement('div');
    nameRow.className = 'ab-row ab-toggle-row';
    nameRow.innerHTML = `
      <input type="checkbox" id="ab-namebased" class="ab-toggle">
      <span class="ab-toggle-label">Name lookup</span>
      <span class="ab-target-note">applies to target fields</span>
    `;
    body.appendChild(nameRow);

    function resolveTarget(inputId) {
      const val = document.getElementById(inputId).value.trim();
      if (!val) return null;
      const nameBased = document.getElementById('ab-namebased').checked;
      if (nameBased) {
        return getPlayerIdByName(val);
      } else {
        const num = parseInt(val);
        return isNaN(num) ? null : num;
      }
    }

    addRow('Donate', 'donate', 'ab-purple', ({ targetInput, pctInput }) => {
      const id  = resolveTarget('ab-donate');
      const pct = parseFloat(pctInput.value);
      const invalid = [];
      if (id == null) invalid.push(targetInput);
      if (isNaN(pct)) invalid.push(pctInput);
      if (invalid.length) {
        flashInvalid(...invalid);
        showFeedback(panel, 'Donate needs a valid target and percent.', 'err');
        addCommandLog(panel, 'Donate invalid', 'err');
        return;
      }
      sendCommand({ type: 'command', action: 'donate', percent: pct, targetPlayerId: id }, `Donate ${pct}% to #${id}`);
    });

    // Own-donate row (no id input)
    const ownRow = document.createElement('div');
    ownRow.className = 'ab-row ab-self-row';
    ownRow.innerHTML = `
      <span class="ab-lbl">Self Donate</span>
      <input id="ab-self-target" type="text" value="You" readonly tabindex="-1" class="ab-inp ab-inp-id ab-self-target">
      <input id="ab-owndonate-pct" type="text" placeholder="%" class="ab-inp ab-inp-pct">
    `;
    const ownBtn = document.createElement('button');
    ownBtn.className = 'ab-btn ab-command-btn ab-blue';
    ownBtn.textContent = 'Send';
    function submitOwnDonate() {
      const pctInput = document.getElementById('ab-owndonate-pct');
      const pct = parseFloat(document.getElementById('ab-owndonate-pct').value);
      try {
        const myId = unsafeWindow.aD.es;
        if (!isNaN(pct) && myId != null) {
          sendCommand({ type: 'command', action: 'donate', percent: pct, targetPlayerId: myId }, `Self donate ${pct}%`);
        } else {
          flashInvalid(pctInput);
          showFeedback(panel, 'Self Donate needs a valid percent.', 'err');
          addCommandLog(panel, 'Self donate invalid', 'err');
        }
      } catch (e) {
        flashInvalid(pctInput);
        showFeedback(panel, 'Could not read your player ID yet.', 'err');
        addCommandLog(panel, 'Self donate unavailable', 'err');
        console.warn('[EchoClientBridge] Could not get own player ID:', e);
      }
    }
    ownBtn.addEventListener('click', submitOwnDonate);
    ownRow.querySelector('#ab-owndonate-pct').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitOwnDonate();
      }
    });
    ownRow.appendChild(ownBtn);
    body.appendChild(ownRow);

    addRow('Attack', 'attack', 'ab-red', ({ targetInput, pctInput }) => {
      const id  = resolveTarget('ab-attack');
      const pct = parseFloat(pctInput.value);
      const invalid = [];
      if (id == null) invalid.push(targetInput);
      if (isNaN(pct)) invalid.push(pctInput);
      if (invalid.length) {
        flashInvalid(...invalid);
        showFeedback(panel, 'Attack needs a valid target and percent.', 'err');
        addCommandLog(panel, 'Attack invalid', 'err');
        return;
      }
      sendCommand({ type: 'command', action: 'attack', percent: pct, targetPlayerId: id }, `Attack #${id} with ${pct}%`);
    });

    // ── Divider + bot control
    const hr = document.createElement('hr');
    hr.className = 'ab-divider';
    body.appendChild(hr);

    section('Single Bot');

    // Bot ID row
    const botIdRow = document.createElement('div');
    botIdRow.className = 'ab-row';
    botIdRow.innerHTML = `
      <span class="ab-lbl">Bot PlayerId</span>
      <input id="ab-bot-id" type="text" placeholder="Id" class="ab-inp ab-inp-pct">
    `;
    body.appendChild(botIdRow);

    addRow('Donate', 'bot-donate', 'ab-purple', () => {
      const botId = parseInt(document.getElementById('ab-bot-id').value);
      const id    = resolveTarget('ab-bot-donate');
      const pct   = parseFloat(document.getElementById('ab-bot-donate-pct').value);
      if (!isNaN(botId) && id != null && !isNaN(pct)) {
        send({ type: 'command', action: 'botDonate', botMyId: botId, percent: pct, targetPlayerId: id });
        console.log(`[AlphaBotBridge] Bot ${botId} donate ${pct}% -> ${id}`);
      } else console.warn('[AlphaBotBridge] BotDonate: invalid input');
    });

    addRow('Attack', 'bot-attack', 'ab-red', () => {
      const botId = parseInt(document.getElementById('ab-bot-id').value);
      const id    = resolveTarget('ab-bot-attack');
      const pct   = parseFloat(document.getElementById('ab-bot-attack-pct').value);
      if (!isNaN(botId) && id != null && !isNaN(pct)) {
        send({ type: 'command', action: 'botAttack', botMyId: botId, percent: pct, targetPlayerId: id });
        console.log(`[AlphaBotBridge] Bot ${botId} attack ${pct}% -> ${id}`);
      } else console.warn('[AlphaBotBridge] BotAttack: invalid input');
    });

    // ── Divider + global bot control
    const hr2 = document.createElement('hr');
    hr2.className = 'ab-divider';
    body.appendChild(hr2);

    section('Bot Control');

    const ctrlRow = document.createElement('div');
    ctrlRow.className = 'ab-ctrl-row';
    function qBtn(label, cls, action, titleText = label, logLabel = label) {
      const b = document.createElement('button');
      b.className = `ab-btn ab-command-btn ${cls}`;
      b.textContent = label;
      b.title = titleText;
      b.addEventListener('click', () => {
        sendCommand({ type: 'command', action }, logLabel);
      });
      return b;
    }
    ctrlRow.appendChild(qBtn('▶ Start',  'ab-green',  'start', 'Start EchoClient automation', 'Start'));
    ctrlRow.appendChild(qBtn('■ Stop',   'ab-red',    'stop', 'Stop EchoClient automation', 'Stop'));
    ctrlRow.appendChild(qBtn('▶ Phase', 'ab-ghost',  'openingstart', 'Run opening phase command', 'Opening phase'));
    body.appendChild(ctrlRow);

    // ── TickDono row
    const tickRow = document.createElement('div');
    tickRow.className = 'ab-ctrl-row';
    tickRow.style.marginTop = '6px';

    const tickStartBtn = document.createElement('button');
    tickStartBtn.className = 'ab-btn ab-command-btn ab-blue';
    tickStartBtn.textContent = '⏱ TickDono';
    tickStartBtn.title = 'Start tick-based auto-donate (ratio > 100 → 20% to your player ID)';
    tickStartBtn.addEventListener('click', () => {
      try {
        const myId = unsafeWindow.aD.es;
        if (myId == null) { console.warn('[EchoClientBridge] TickDono: cannot get own player ID'); return; }
        sendCommand({ type: 'command', action: 'tickDonoStart', targetPlayerId: myId }, `TickDono start → player ${myId}`);
      } catch (e) { console.warn('[EchoClientBridge] TickDono start error:', e); }
    });

    const tickStopBtn = document.createElement('button');
    tickStopBtn.className = 'ab-btn ab-command-btn ab-red';
    tickStopBtn.textContent = '■ TickDono';
    tickStopBtn.title = 'Stop tick-based auto-donate';
    tickStopBtn.addEventListener('click', () => {
      sendCommand({ type: 'command', action: 'tickDonoStop' }, 'TickDono stop');
    });

    tickRow.appendChild(tickStartBtn);
    tickRow.appendChild(tickStopBtn);
    body.appendChild(tickRow);

    const hint = document.createElement('div');
    hint.className = 'ab-hint';
    hint.textContent = 'Q  start   ·   E  stop';
    body.appendChild(hint);

    const log = document.createElement('div');
    log.className = 'ab-log';
    log.innerHTML = `
      <div class="ab-log-title">Recent Commands</div>
      <div class="ab-log-lines">
        <div class="ab-log-line ab-log-empty"><span>No commands yet</span><span class="ab-log-time">--:--</span></div>
      </div>
    `;
    body.appendChild(log);

    document.body.appendChild(panel);
    restorePanelPosition(panel);
    installPanelDrag(panel, panel);
    updatePanelConnectionState(panel);

    // ── Live status updater
    setInterval(() => {
      updatePanelConnectionState(panel);
    }, 1000);
  }

  // ── Panel persistence — MutationObserver + fallback interval ────────────

  function ensurePanel() {
    if (!document.body) return;
    if (!document.getElementById('ab-panel'))  buildUI();
    if (!document.getElementById('ab-styles')) injectStyles();
  }

  function startPanelGuard() {
    if (panelObserver) panelObserver.disconnect();

    panelObserver = new MutationObserver(() => {
      if (panelCheckScheduled) return;
      panelCheckScheduled = true;
      requestAnimationFrame(() => {
        panelCheckScheduled = false;
        if (!document.getElementById('ab-panel')) {
          ensurePanel();
          // Re-attach observers after body might have changed
          if (document.body) panelObserver.observe(document.body, { childList: true });
        }
      });
    });

    // Watch document root (catches body replacement)
    panelObserver.observe(document.documentElement, { childList: true });
    // Watch body direct children (catches panel removal)
    if (document.body) panelObserver.observe(document.body, { childList: true });

    // Safety net fallback — catches any edge case the observer misses
    setInterval(ensurePanel, PANEL_GUARD_INTERVAL_MS);
  }

  // ── Keyboard control ─────────────────────────────────────────────────────

  document.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    if (key !== 'q' && key !== 'e') return;
    const tag = document.activeElement?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    const panel = document.getElementById('ab-panel');
    const action = key === 'q' ? 'start' : 'stop';
    const label = key === 'q' ? 'Start' : 'Stop';
    if (!isSocketLive()) {
      if (panel) {
        showFeedback(panel, 'Bridge disconnected. Start the local server first.', 'err');
        addCommandLog(panel, `${label} blocked`, 'err');
      }
      return;
    }
    const ok = send({ type: 'command', action });
    if (panel) {
      showFeedback(panel, ok ? `${label} sent` : `${label} failed to send`, ok ? 'ok' : 'err');
      addCommandLog(panel, ok ? label : `${label} failed`, ok ? 'ok' : 'err');
    }
    if (ok) console.log(`[EchoClientBridge] Sent ${action}`);
  });

  // ── Startup ───────────────────────────────────────────────────────────────

  function tryBuildUI() {
    if (!document.body) { setTimeout(tryBuildUI, 100); return; }
    if (!document.getElementById('ab-panel')) buildUI();
    startPanelGuard();
  }

  connect();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      tryBuildUI();
      waitForFunction();
      waitForSpawnFunction();
    });
  } else {
    tryBuildUI();
    waitForFunction();
    waitForSpawnFunction();
  }

})();