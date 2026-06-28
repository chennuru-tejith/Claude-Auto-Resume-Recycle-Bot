// Claude Safeguard — Content Script v4
// Complete rewrite: correct header injection, reliable limit detection, task overview

let btnCheckInterval = null;
let usageFetchInterval = null;

let fabEnabled = true;
let autoCaptureEnabled = true;

function cleanUrlForComparison(urlStr) {
  try {
    const u = new URL(urlStr);
    let path = u.pathname.replace(/\/$/, "").toLowerCase();
    return u.hostname.toLowerCase() + path;
  } catch {
    return urlStr ? urlStr.toLowerCase() : "";
  }
}

try {
  chrome.storage.local.get(["fabEnabled", "autoCaptureEnabled"], d => {
    if (d) {
      if (d.fabEnabled === false) {
        fabEnabled = false;
        document.getElementById("ar-btn")?.remove();
      }
      if (d.autoCaptureEnabled === false) {
        autoCaptureEnabled = false;
      }
    }
  });
} catch {}

// ── Context guards ────────────────────────────────────────────────────
function isCtxValid() {
  try { return !!(chrome?.runtime?.id); } catch { return false; }
}

function estimateTokens(text) {
  if (!text) return 0;
  const charCount = text.length;
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  if (charCount === 0) return 0;
  const tokens = Math.ceil((charCount / 4 + wordCount / 0.75) / 2);
  return Math.max(1, tokens);
}
function safeSend(msg, cb) {
  if (!isCtxValid()) return;
  try { chrome.runtime.sendMessage(msg, cb || (() => chrome.runtime.lastError)); }
  catch { selfDestruct(); }
}
function safeGet(key, cb) {
  if (!isCtxValid()) return;
  try { chrome.storage.local.get(key, cb); } catch { selfDestruct(); }
}
function safeSet(obj, cb) {
  if (!isCtxValid()) return;
  try { chrome.storage.local.set(obj, cb); } catch {}
}
function selfDestruct() {
  try { mutObs.disconnect(); } catch {}
  try { clearInterval(pollInterval); } catch {}
  try { clearInterval(btnCheckInterval); } catch {}
  try { clearInterval(usageFetchInterval); } catch {}
  try { clearInterval(fastCheckInterval); } catch {}
  try { maintainKeepAlivePort(false); } catch {}
  try { document.getElementById("ar-btn")?.remove(); } catch {}
  try { document.getElementById("ar-panel")?.remove(); } catch {}
  try { document.getElementById("ar-styles")?.remove(); } catch {}
  try { document.getElementById("ar-page-usage-bar")?.remove(); } catch {}
}

// ── Message handler ───────────────────────────────────────────────────
try {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!isCtxValid()) return;
    if (msg.type === "CHECK_LIMIT") {
      const limited = isLimitActive();
      const canType = canSend();
      sendResponse({ limited, canType });
      return;
    }
    if (msg.type === "CHECK_AND_SEND") {
      doSend(msg.prompt, msg.force).then(sendResponse);
      return true;
    }
    if (msg.type === "STATE_UPDATED") {
      const currentClean = cleanUrlForComparison(location.href);
      const stateClean = cleanUrlForComparison(msg.state?.chatUrl);
      if (msg.state && currentClean === stateClean) {
        renderUI(msg.state);
        startFastPolling(msg.state);
      }
      return;
    }
    if (msg.type === "GET_RESET_INFO") {
      const ri = getResetInfo();
      sendResponse(ri || { mins: null });
      return;
    }
    if (msg.type === "GET_USAGE_INFO") {
      sendResponse(getUsageInfo());
      return;
    }
    if (msg.type === "TOGGLE_PANEL") {
      togglePanel();
      return;
    }
    if (msg.type === "GET_COMPOSER_TEXT") {
      sendResponse({ text: getAIComposerText() });
      return;
    }
    if (msg.type === "TOGGLE_SAFEGUARD") {
      const url = location.href;
      safeGet("queues", d => {
        const queues = d?.queues || {};
        const currentClean = cleanUrlForComparison(url);
        let q = null;
        for (const qUrl in queues) {
          if (cleanUrlForComparison(qUrl) === currentClean) {
            q = queues[qUrl];
            break;
          }
        }
        if (q?.active) {
          safeSend({ type: "STOP_RESUME", chatUrl: q.chatUrl }, () => showToast("⏹ Claude Safeguard stopped"));
        } else {
          if (!panelOpen) openPanel();
          showToast("Open panel — configure and click Start");
        }
      });
      return;
    }
    if (msg.type === "PLAY_NOTIFICATION_SOUND") {
      playNotificationSound(msg.soundPref);
      return;
    }
    if (msg.type === "SCRAPE_CONVERSATION") {
      const msgs = scrapeConversation();
      sendResponse({ messages: msgs, count: msgs.length });
      return;
    }
    if (msg.type === "SETTING_CHANGED") {
      if (msg.key === "fabEnabled") {
        fabEnabled = msg.val;
        if (!fabEnabled) {
          document.getElementById("ar-btn")?.remove();
        } else {
          injectBtn();
        }
      }
      if (msg.key === "autoCaptureEnabled") {
        autoCaptureEnabled = msg.val;
      }
      return;
    }
  });
} catch {}

let latestUsageData = null;

let cachedExcludedText = "";
let lastCacheTime = 0;

function getPageTextExcludingChat() {
  const now = Date.now();
  if (cachedExcludedText && (now - lastCacheTime < 500)) {
    return cachedExcludedText;
  }

  const excludeSelector = [
    '[data-testid="human-turn"]',
    '[data-testid="ai-turn"]',
    '[data-testid*="user-message"]',
    '[data-testid*="assistant-message"]',
    '[data-message-author-role]',
    'user-query',
    'message-content',
    'article',
    'pre',
    'code',
    '.chat-turn',
    '#ar-panel',
    '#ar-page-usage-bar',
    '#ar-toast'
  ].join(',');

  let text = "";
  function traverse(node) {
    if (!node) return;
    if (node.nodeType === Node.ELEMENT_NODE) {
      try {
        if (node.matches(excludeSelector)) return;
      } catch {}
    }
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.nodeValue + " ";
      return;
    }
    let child = node.firstChild;
    while (child) {
      traverse(child);
      child = child.nextSibling;
    }
  }

  try {
    traverse(document.body);
    cachedExcludedText = text.replace(/\s+/g, " ").trim();
  } catch (err) {
    cachedExcludedText = document.body?.innerText || "";
  }
  lastCacheTime = now;
  return cachedExcludedText;
}

const SITE_CONFIGS = {
  claude: {
    name: "Claude",
    matches: (url) => url.includes("claude.ai"),
    chatUrlPrefix: "https://claude.ai/chat/",
    inputSelector: 'div[contenteditable="true"][data-placeholder], div.ProseMirror[contenteditable="true"], div[contenteditable="true"]',
    sendBtnSelectors: [
      'button[aria-label="Send message"]',
      'button[aria-label="Send Message"]',
      'button[data-testid="send-button"]',
      'button[aria-label*="Send" i]'
    ],
    isLimitActive: () => {
      if (latestUsageData?.session?.pct >= 100 || latestUsageData?.weekly?.pct >= 100) return true;
      if (isAiResponding()) return false;
      if (checkInputPlaceholderForLimit()) return true;

      const body = getPageTextExcludingChat().toLowerCase();
      const limitPhrases = [
        "usage limit reached", "you've reached your limit",
        "try again in", "out of messages", "limit reached",
        "over the limit", "you've hit your", "out of free messages",
        "messages until", "quota exceeded", "please try again after",
        "resets at", "limit will reset"
      ];
      if (limitPhrases.some(p => body.includes(p))) return true;

      const input = getInput();
      if (input) {
        const editable = input.getAttribute("contenteditable");
        if (editable === "false" || editable === null) return true;
        const style = window.getComputedStyle(input);
        if (style.pointerEvents === "none") return true;
      }
      return false;
    },
    getResetInfo: () => {
      const usage = getUsageInfo();
      if (usage.session?.reset) {
        return { mins: usage.session.reset.mins, display: usage.session.reset.display, source: "session" };
      }
      const body = getPageTextExcludingChat();
      const bannerReset = parseResetTime(body);
      if (bannerReset && bannerReset.mins < 24 * 60) {
        return { mins: bannerReset.mins, display: bannerReset.display, source: "banner" };
      }
      return null;
    },
    scrapeTurns: () => {
      const messages = [];
      const humanTurns = document.querySelectorAll('[data-testid="human-turn"], [data-testid*="user-message"]');
      const assistantTurns = document.querySelectorAll('[data-testid="ai-turn"], [data-testid*="assistant-message"]');
      if (humanTurns.length > 0 || assistantTurns.length > 0) {
        const all = [...document.querySelectorAll('[data-testid="human-turn"], [data-testid="ai-turn"], [data-testid*="user-message"], [data-testid*="assistant-message"]')];
        for (const el of all) {
          const tid = el.getAttribute('data-testid') || '';
          const role = (tid.includes('human') || tid.includes('user')) ? 'human' : 'assistant';
          const text = extractCleanText(el);
          if (text) messages.push({ role, text });
        }
      }
      return messages;
    }
  },
  chatgpt: {
    name: "ChatGPT",
    matches: (url) => url.includes("chatgpt.com"),
    chatUrlPrefix: "https://chatgpt.com/",
    inputSelector: '#prompt-textarea, textarea[placeholder*="message" i], div[contenteditable="true"]',
    sendBtnSelectors: [
      'button[data-testid="send-button"]',
      'button[data-testid="fruitjuice-send-button"]',
      'button[aria-label="Send prompt" i]',
      'button[aria-label*="Send" i]'
    ],
    isLimitActive: () => {
      if (isAiResponding()) return false;
      if (checkInputPlaceholderForLimit()) return true;

      const body = getPageTextExcludingChat().toLowerCase();
      const limitPhrases = [
        "you've reached your gpt-4 limit",
        "you've reached your limit",
        "reached the limit for",
        "reached the message limit",
        "try again after",
        "try again in",
        "messages will reset",
        "gpt-4o limit",
        "rate limit exceeded",
        "too many requests",
        "quota exceeded",
        "wait until",
        "reset at",
        "resets at"
      ];
      if (limitPhrases.some(p => body.includes(p))) return true;

      const input = getInput();
      if (input) {
        if (input.disabled || input.getAttribute("disabled") !== null) return true;
        const style = window.getComputedStyle(input);
        if (style.pointerEvents === "none") return true;
      }
      return false;
    },
    getResetInfo: () => {
      const body = getPageTextExcludingChat();
      const bannerReset = parseResetTime(body);
      if (bannerReset && bannerReset.mins < 24 * 60) {
        return { mins: bannerReset.mins, display: bannerReset.display, source: "banner" };
      }
      return null;
    },
    scrapeTurns: () => {
      const messages = [];
      const turns = document.querySelectorAll('[data-message-author-role]');
      if (turns.length > 0) {
        for (const el of turns) {
          const role = el.getAttribute('data-message-author-role') === 'user' ? 'human' : 'assistant';
          const text = extractCleanText(el);
          if (text) messages.push({ role, text });
        }
      }
      return messages;
    }
  },
  gemini: {
    name: "Gemini",
    matches: (url) => url.includes("gemini.google.com"),
    chatUrlPrefix: "https://gemini.google.com/",
    inputSelector: 'div.ql-editor[contenteditable="true"], div[contenteditable="true"][role="textbox"], textarea',
    sendBtnSelectors: [
      'button[aria-label="Send message"]',
      'button[aria-label="Send Message"]',
      'button[class*="send-button" i]',
      'button[aria-label*="Send" i]'
    ],
    isLimitActive: () => {
      if (isAiResponding()) return false;
      if (checkInputPlaceholderForLimit()) return true;

      const body = getPageTextExcludingChat().toLowerCase();
      const limitPhrases = [
        "reached the daily limit",
        "limit reached",
        "try again in",
        "quota exceeded",
        "resource exhausted",
        "reached the limit",
        "daily limit",
        "try again after",
        "try again at",
        "please try again later",
        "exceeded the rate limit"
      ];
      if (limitPhrases.some(p => body.includes(p))) return true;

      const input = getInput();
      if (input) {
        const editable = input.getAttribute("contenteditable");
        if (editable === "false" || editable === null) return true;
        const style = window.getComputedStyle(input);
        if (style.pointerEvents === "none") return true;
      }
      return false;
    },
    getResetInfo: () => {
      const body = getPageTextExcludingChat();
      const bannerReset = parseResetTime(body);
      if (bannerReset && bannerReset.mins < 24 * 60) {
        return { mins: bannerReset.mins, display: bannerReset.display, source: "banner" };
      }
      return null;
    },
    scrapeTurns: () => {
      const messages = [];
      const turns = document.querySelectorAll('user-query, message-content');
      for (const el of turns) {
        const role = el.tagName.toLowerCase() === 'user-query' ? 'human' : 'assistant';
        const text = extractCleanText(el);
        if (text) messages.push({ role, text });
      }
      return messages;
    }
  },
  deepseek: {
    name: "DeepSeek",
    matches: (url) => url.includes("deepseek.com"),
    chatUrlPrefix: "https://chat.deepseek.com/",
    inputSelector: '#chat-input, textarea',
    sendBtnSelectors: [
      'div[class*="sendBtn"]',
      'button[class*="sendBtn"]',
      'button[aria-label*="Send" i]',
      'button:has(svg)'
    ],
    isLimitActive: () => {
      if (isAiResponding()) return false;
      if (checkInputPlaceholderForLimit()) return true;

      const body = getPageTextExcludingChat().toLowerCase();
      const limitPhrases = [
        "server capacity limited",
        "busy",
        "reached the limit",
        "please try again later",
        "try again in",
        "quota exceeded",
        "rate limit",
        "try again after",
        "try again at",
        "resets in"
      ];
      if (limitPhrases.some(p => body.includes(p))) return true;

      const input = getInput();
      if (input) {
        if (input.disabled || input.getAttribute("disabled") !== null) return true;
        const style = window.getComputedStyle(input);
        if (style.pointerEvents === "none") return true;
      }
      return false;
    },
    getResetInfo: () => {
      const body = getPageTextExcludingChat();
      const bannerReset = parseResetTime(body);
      if (bannerReset && bannerReset.mins < 24 * 60) {
        return { mins: bannerReset.mins, display: bannerReset.display, source: "banner" };
      }
      return null;
    },
    scrapeTurns: () => {
      return [];
    }
  }
};

function getSiteConfig() {
  const url = window.location.href;
  for (const key in SITE_CONFIGS) {
    if (SITE_CONFIGS[key].matches(url)) {
      return SITE_CONFIGS[key];
    }
  }
  return SITE_CONFIGS.claude;
}

function getOrgIdFromCookie() {
  try {
    return document.cookie
      .split('; ')
      .find((row) => row.startsWith('lastActiveOrg='))
      ?.split('=')[1] || null;
  } catch {
    return null;
  }
}

let cachedUsage = null;
let lastUsageFetchTime = 0;

async function fetchClaudeUsage() {
  const orgId = getOrgIdFromCookie();
  if (!orgId) return null;
  
  const now = Date.now();
  if (cachedUsage && (now - lastUsageFetchTime < 15000)) {
    return cachedUsage;
  }
  
  try {
    const res = await fetch(`https://claude.ai/api/organizations/${orgId}/usage`);
    if (!res.ok) return null;
    const data = await res.json();
    
    const info = { session: null, weekly: null };
    
    if (data.five_hour && typeof data.five_hour.utilization === 'number') {
      info.session = {
        pct: Math.round(data.five_hour.utilization),
        reset: data.five_hour.resets_at ? parseResetTimeFromIso(data.five_hour.resets_at) : null
      };
    }
    if (data.seven_day && typeof data.seven_day.utilization === 'number') {
      info.weekly = {
        pct: Math.round(data.seven_day.utilization),
        reset: data.seven_day.resets_at ? parseResetTimeFromIso(data.seven_day.resets_at) : null
      };
    }
    
    cachedUsage = info;
    lastUsageFetchTime = now;
    return info;
  } catch (err) {
    console.warn("Claude Safeguard usage fetch error:", err);
    return null;
  }
}

async function runPeriodicUsageFetch() {
  if (!isCtxValid()) return;
  const config = getSiteConfig();
  if (config.name !== "Claude") return;
  const data = await fetchClaudeUsage();
  if (data) {
    latestUsageData = data;
    updateUsageBarOnPage();
    safeSend({
      type: "RECORD_USAGE",
      data: {
        session: data.session ? data.session.pct : null,
        weekly: data.weekly ? data.weekly.pct : null
      }
    });
    // Refresh setup/status UI if panel is open
    const activeTab = document.querySelector(".ar-tab.active")?.dataset?.tab;
    if (activeTab === "status") {
      refreshStatus();
    }
  }
}

function isAiResponding() {
  try {
    const stopSelectors = [
      'button[aria-label*="Stop" i]',
      'button[aria-label*="Cancel" i]',
      'button[data-testid="stop-button"]',
      'div[class*="stopBtn"]',
      'button:has(svg rect)', 
      'button svg[class*="stop"]'
    ];
    for (const selector of stopSelectors) {
      if (document.querySelector(selector)) return true;
    }
  } catch {}
  return false;
}

function checkInputPlaceholderForLimit() {
  try {
    const input = getInput();
    if (!input) return false;
    
    let text = (
      input.getAttribute("placeholder") || 
      input.placeholder || 
      input.getAttribute("data-placeholder") || 
      input.getAttribute("aria-label") || 
      ""
    ).toLowerCase();
    
    const phrases = [
      "limit reached",
      "reached your limit",
      "try again after",
      "try again in",
      "out of messages",
      "messages remaining",
      "resets at",
      "quota exceeded"
    ];
    
    return phrases.some(p => text.includes(p));
  } catch {}
  return false;
}

// ── Limit & input detection ───────────────────────────────────────────
function isLimitActive() {
  try {
    const config = getSiteConfig();
    return config.isLimitActive();
  } catch {
    return false;
  }
}

function canSend(ignoreLimit = false) {
  try {
    const input = getInput();
    if (!input) return false;
    if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {
      if (input.disabled || input.getAttribute("disabled") !== null) return false;
    } else {
      const editable = input.getAttribute("contenteditable");
      if (editable !== "true") return false;
    }
    const style = window.getComputedStyle(input);
    if (style.pointerEvents === "none") return false;
    if (!ignoreLimit && isLimitActive()) return false;
    return true;
  } catch {
    return false;
  }
}

function getInput() {
  const config = getSiteConfig();
  const els = document.querySelectorAll(config.inputSelector);
  for (const el of els) {
    if (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0) {
      return el;
    }
  }
  return els[0] || null;
}

function getAIComposerText() {
  const box = getInput();
  if (!box) return "";
  if (box.tagName === "TEXTAREA" || box.tagName === "INPUT") {
    return box.value.trim();
  }
  return box.innerText.trim();
}

function getSendBtn() {
  const config = getSiteConfig();
  for (const sel of config.sendBtnSelectors) {
    const els = document.querySelectorAll(sel);
    for (const el of els) {
      if (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0) {
        return el;
      }
    }
  }
  return null;
}

// ── Auto-read reset timer ─────────────────────────────────────────────
function parseAbsoluteResetTime(text) {
  const m = text.match(/(?:until|after|at)\s+(\d+)(?::(\d+))?\s*(am|pm|a\.m\.|p\.m\.)/i);
  if (m) {
    let hour = parseInt(m[1]);
    const min = m[2] ? parseInt(m[2]) : 0;
    let ampm = m[3].toLowerCase().replace(/\./g, '');
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    const now = new Date();
    const resetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, min, 0, 0);
    if (resetDate <= now) {
      resetDate.setDate(resetDate.getDate() + 1);
    }
    const diffMins = Math.max(1, Math.ceil((resetDate - now) / 60000));
    return { mins: diffMins, display: `until ${m[1]}${m[2] ? ":" + m[2] : ""} ${ampm.toUpperCase()}` };
  }
  const m24 = text.match(/(?:until|after|at)\s+(\d{1,2}):(\d{2})/i);
  if (m24) {
    const hour = parseInt(m24[1]);
    const min = parseInt(m24[2]);
    const now = new Date();
    const resetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, min, 0, 0);
    if (resetDate <= now) {
      resetDate.setDate(resetDate.getDate() + 1);
    }
    const diffMins = Math.max(1, Math.ceil((resetDate - now) / 60000));
    return { mins: diffMins, display: `until ${hour.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}` };
  }
  return null;
}

function parseResetTimeFromIso(isoString) {
  try {
    const resetTime = new Date(isoString);
    if (isNaN(resetTime.getTime())) return null;
    const now = new Date();
    const diffMs = resetTime - now;
    if (diffMs <= 0) return null;
    const mins = Math.max(1, Math.ceil(diffMs / 60000));
    let display = "";
    if (mins >= 24 * 60) {
      const days = Math.floor(mins / (24 * 60));
      const hours = Math.floor((mins % (24 * 60)) / 60);
      display = `${days}d ${hours}h`;
    } else if (mins >= 60) {
      const hours = Math.floor(mins / 60);
      const remMins = mins % 60;
      display = `${hours}h ${remMins}m`;
    } else {
      display = `${mins}m`;
    }
    return { mins, display };
  } catch {
    return null;
  }
}

function parseResetTime(text) {
  const abs = parseAbsoluteResetTime(text);
  if (abs) return abs;

  const m = text.match(/(?:resets|try\s+again)\s+in\s+([^.!\n]+)/i);
  if (m) {
    const timeStr = m[1].toLowerCase();
    const dayMatch = timeStr.match(/(\d+)\s*(?:d|day|days)/);
    const hourMatch = timeStr.match(/(\d+)\s*(?:h|hour|hours|hr|hrs)/);
    const minMatch = timeStr.match(/(\d+)\s*(?:m|minute|minutes|min|mins)/);

    let mins = 0;
    if (dayMatch) mins += parseInt(dayMatch[1]) * 24 * 60;
    if (hourMatch) mins += parseInt(hourMatch[1]) * 60;
    if (minMatch) mins += parseInt(minMatch[1]);

    if (mins > 0) {
      return { mins, display: m[1].trim() };
    }
  }
  return null;
}

function getUsageInfo() {
  if (latestUsageData) {
    return latestUsageData;
  }
  const info = { session: null, weekly: null };
  try {
    const leafEls = Array.from(document.querySelectorAll("*"))
      .filter(el => el.childElementCount === 0 && el.textContent.trim().length > 0);

    for (const el of leafEls) {
      const t = el.textContent.trim();

      // Match "Session: X%" or "Session: X% · resets in ..."
      const sessionMatch = t.match(/session[:\s]+(\d+)%/i);
      if (sessionMatch) {
        info.session = info.session || {};
        info.session.pct = parseInt(sessionMatch[1]);
        const resetPart = parseResetTime(t);
        if (resetPart) {
          info.session.reset = resetPart;
        }
      }

      // Match "Weekly: X%" or "Weekly: X% · resets in ..."
      const weeklyMatch = t.match(/weekly[:\s]+(\d+)%/i);
      if (weeklyMatch) {
        info.weekly = info.weekly || {};
        info.weekly.pct = parseInt(weeklyMatch[1]);
        const resetPart = parseResetTime(t);
        if (resetPart) {
          info.weekly.reset = resetPart;
        }
      }
    }

    // Also scan for standalone "resets in" near session/weekly labels
    if (info.session && !info.session.reset) {
      for (const el of leafEls) {
        const t = el.textContent.trim();
        if (/resets\s+in/i.test(t) && !(/weekly/i.test(t))) {
          const r = parseResetTime(t);
          if (r && r.mins < 24 * 60) { // Session resets are usually < 24h
            info.session.reset = r;
            break;
          }
        }
      }
    }
  } catch {}
  return info;
}

function getResetInfo() {
  try {
    const config = getSiteConfig();
    return config.getResetInfo();
  } catch {}
  return null;
}

// ── Prompt Templates ──────────────────────────────────────────────────
const BUILTIN_TEMPLATES = [
  { name: "Continue", prompt: "Continue from where we left off. Next step:" },
  { name: "Continue coding", prompt: "Continue coding from where we left off. Pick up the next task and implement it." },
  { name: "Summarize", prompt: "Summarize our progress so far and outline the remaining tasks." },
  { name: "Debug", prompt: "Debug the last error we encountered. Analyze the issue and provide a fix." },
];

function getTemplates(cb) {
  safeGet("customTemplates", d => {
    const custom = d?.customTemplates || [];
    cb([...BUILTIN_TEMPLATES, ...custom]);
  });
}

function saveCustomTemplate(name, prompt) {
  safeGet("customTemplates", d => {
    const arr = d?.customTemplates || [];
    arr.push({ name, prompt, custom: true });
    if (arr.length > 10) arr.shift();
    safeSet({ customTemplates: arr });
  });
}

function removeCustomTemplate(idx) {
  safeGet("customTemplates", d => {
    const arr = d?.customTemplates || [];
    arr.splice(idx, 1);
    safeSet({ customTemplates: arr });
  });
}

// ── Notification Sound ────────────────────────────────────────────────
function playNotificationSound(soundPref) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }

    if (soundPref === "beep") {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.18);
      setTimeout(() => ctx.close(), 1000);
    } else if (soundPref === "tts") {
      ctx.close();
      const platform = getSiteConfig().name;
      const utterance = new SpeechSynthesisUtterance(`Prompt sent to ${platform} successfully.`);
      utterance.rate = 1.05;
      utterance.pitch = 1.0;
      window.speechSynthesis.speak(utterance);
    } else if (soundPref === "chime" || soundPref === true) {
      const notes = [523.25, 659.25, 783.99]; // C5, E5, G5 chord arpeggio
      notes.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(freq, ctx.currentTime + i * 0.12);
        gain.gain.setValueAtTime(0.15, ctx.currentTime + i * 0.12);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.12 + 0.5);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + i * 0.12);
        osc.stop(ctx.currentTime + i * 0.12 + 0.5);
      });
      setTimeout(() => ctx.close(), 2000);
    } else {
      ctx.close();
    }
  } catch {}
}

function resolvePromptVariables(promptText) {
  if (!promptText) return "";
  let resolved = promptText;

  // 1. Resolve {{date}}
  if (resolved.includes("{{date}}")) {
    const d = new Date();
    const dateStr = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, '0') + "-" + String(d.getDate()).padStart(2, '0');
    resolved = resolved.replace(/\{\{date\}\}/g, dateStr);
  }

  // 2. Resolve {{time}}
  if (resolved.includes("{{time}}")) {
    const d = new Date();
    const timeStr = String(d.getHours()).padStart(2, '0') + ":" + String(d.getMinutes()).padStart(2, '0');
    resolved = resolved.replace(/\{\{time\}\}/g, timeStr);
  }

  // 3. Resolve {{last_response}}
  if (resolved.includes("{{last_response}}")) {
    const msgs = scrapeConversation();
    const lastAI = msgs.filter(m => m.role === "assistant").pop();
    const lastRespText = lastAI ? lastAI.text : "(no previous assistant response found)";
    resolved = resolved.replace(/\{\{last_response\}\}/g, lastRespText);
  }

  return resolved;
}

// ── Claude Recycle Bin & Cache Logic ──────────────────────────────────
let lastCacheSaveTime = 0;
let lastCacheMessageCount = 0;
let lastInteractedUuid = null;

function getCurrentChatUuid() {
  const m = location.href.match(/claude\.ai\/chat\/([0-9a-fA-F-]+)/i);
  return m ? m[1] : null;
}

function getChatTitle(uuid) {
  try {
    if (uuid) {
      const sidebarLink = document.querySelector(`a[href*="/chat/${uuid}"]`);
      if (sidebarLink) {
        const text = sidebarLink.textContent.trim();
        return text.replace(/\s+/g, " ").replace(/⋮$/, "").trim();
      }
    }
    const headerTitle = document.querySelector('div[class*="line-clamp-1"]');
    if (headerTitle) return headerTitle.textContent.trim();
    
    const msgs = scrapeConversation();
    const firstHuman = msgs.find(m => m.role === 'human');
    if (firstHuman && firstHuman.text) {
      return firstHuman.text.slice(0, 30).trim() + "...";
    }
  } catch {}
  return "Untitled Chat";
}

function updateLocalChatCache(force = false) {
  try {
    const uuid = getCurrentChatUuid();
    if (!uuid) return;

    const now = Date.now();
    if (!force && (now - lastCacheSaveTime < 5000)) return;

    const messages = scrapeConversation();
    if (!messages || messages.length === 0) return;

    if (!force && messages.length === lastCacheMessageCount && (now - lastCacheSaveTime < 15000)) return;

    const title = getChatTitle(uuid);
    
    safeGet("chatCache", d => {
      const cache = d?.chatCache || {};
      cache[uuid] = {
        uuid,
        title,
        messages,
        lastUpdated: now
      };
      safeSet({ chatCache: cache }, () => {
        lastCacheSaveTime = now;
        lastCacheMessageCount = messages.length;
      });
    });
  } catch {}
}

function recycleChat(uuid) {
  if (!uuid) return;
  try {
    safeGet(["chatCache", "recycleBin"], d => {
      const cache = d?.chatCache || {};
      const bin = d?.recycleBin || [];
      
      const chat = cache[uuid];
      if (chat) {
        if (!bin.some(c => c.uuid === uuid)) {
          bin.unshift({
            ...chat,
            deletedAt: Date.now()
          });
          if (bin.length > 50) bin.pop();
        }
        delete cache[uuid];
        safeSet({ chatCache: cache, recycleBin: bin }, () => {
          showToast("✓ Chat moved to Recycle Bin!");
          renderSidebarTrashList();
        });
      }
    });
  } catch {}
}

async function fetchClaudeChatFromApi(chatId) {
  try {
    const orgsResp = await fetch("https://claude.ai/api/organizations");
    const orgs = await orgsResp.json();
    const orgId = orgs[0]?.uuid;
    if (!orgId) return null;
    
    const chatResp = await fetch(`https://claude.ai/api/organizations/${orgId}/chats/${chatId}`);
    if (!chatResp.ok) return null;
    const chatData = await chatResp.json();
    
    const apiMessages = chatData.chat_messages || chatData.messages || [];
    const messages = [];
    
    for (const msg of apiMessages) {
      const sender = msg.sender || msg.role;
      const role = (sender === "human" || sender === "user") ? "human" : "assistant";
      
      let text = "";
      if (typeof msg.text === "string") {
        text = msg.text;
      } else if (Array.isArray(msg.content)) {
        text = msg.content.map(c => c.text || "").join("\n");
      } else if (msg.content && typeof msg.content === "string") {
        text = msg.content;
      }
      
      if (text) {
        messages.push({ role, text });
      }
    }
    
    return {
      uuid: chatId,
      title: chatData.name || chatData.title || "Untitled Chat",
      messages,
      lastUpdated: Date.now()
    };
  } catch (err) {
    console.warn("Failed to fetch chat details from Claude API:", err);
    return null;
  }
}

let isSyncingChats = false;

async function syncAllSidebarChats() {
  if (isSyncingChats) return;
  if (!location.hostname.includes("claude.ai")) return;

  isSyncingChats = true;
  try {
    const chatLinks = Array.from(document.querySelectorAll('a[href*="/chat/"]'));
    const uuids = [];
    for (const link of chatLinks) {
      const m = link.href.match(/\/chat\/([0-9a-fA-F-]+)/i);
      if (m) {
        uuids.push(m[1]);
      }
    }

    if (uuids.length === 0) {
      isSyncingChats = false;
      return;
    }

    safeGet("chatCache", async d => {
      const cache = d?.chatCache || {};
      const now = Date.now();
      
      const toSync = uuids.filter(uuid => {
        const cached = cache[uuid];
        return !cached || (now - (cached.lastUpdated || 0) > 2 * 60 * 60 * 1000);
      });

      if (toSync.length === 0) {
        isSyncingChats = false;
        return;
      }

      for (const uuid of toSync) {
        if (!isCtxValid()) break;
        
        const chatData = await fetchClaudeChatFromApi(uuid);
        await new Promise(resolve => {
          safeGet("chatCache", curr => {
            const currentCache = curr?.chatCache || {};
            if (chatData) {
              currentCache[uuid] = chatData;
            } else {
              // Stub to prevent constant retries of failed/deleted chats
              if (!currentCache[uuid]) {
                currentCache[uuid] = {
                  uuid,
                  title: "Inaccessible Chat",
                  messages: [],
                  lastUpdated: Date.now()
                };
              } else {
                currentCache[uuid].lastUpdated = Date.now();
              }
            }
            safeSet({ chatCache: currentCache }, resolve);
          });
        });
        await new Promise(resolve => setTimeout(resolve, 2500));
      }
      isSyncingChats = false;
    });
  } catch (err) {
    isSyncingChats = false;
  }
}

function getClaudeSidebarContainer() {
  try {
    const firstChatLink = document.querySelector('a[href*="/chat/"]');
    if (firstChatLink) {
      let parent = firstChatLink.parentElement;
      while (parent && parent !== document.body) {
        if (parent.classList.contains('overflow-y-auto') || parent.scrollHeight > parent.clientHeight) {
          return parent;
        }
        parent = parent.parentElement;
      }
      return firstChatLink.parentElement;
    }
  } catch {}
  return document.querySelector('nav, [class*="sidebar"], [class*="navigation"]');
}

function injectRecycleBinIntoSidebar() {
  try {
    if (!location.hostname.includes("claude.ai")) return;
    
    const container = getClaudeSidebarContainer();
    if (!container) return;
    
    if (document.getElementById("cl-recycle-bin-section")) {
      renderSidebarTrashList();
      return;
    }
    
    const section = document.createElement("div");
    section.id = "cl-recycle-bin-section";
    section.style.marginTop = "16px";
    section.style.borderTop = "1px solid rgba(255,255,255,0.08)";
    section.style.paddingTop = "12px";
    section.style.paddingBottom = "12px";
    section.style.fontFamily = "system-ui, -apple-system, sans-serif";
    
    section.innerHTML = `
      <div id="cl-recycle-bin-hdr" style="display:flex; justify-content:space-between; align-items:center; padding: 6px 12px; cursor:pointer; user-select:none; color: rgba(255,255,255,0.5); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">
        <span style="display:flex; align-items:center; gap:6px;">🗑️ Recycled Chats</span>
        <span id="cl-recycle-bin-toggle" style="font-size:8px;">▲</span>
      </div>
      <div id="cl-recycle-bin-list" style="display:flex; flex-direction:column; gap:4px; margin-top:6px; padding:0 4px; max-height:200px; overflow-y:auto;">
        <!-- Items populated here -->
      </div>
    `;
    
    container.appendChild(section);
    
    const hdr = section.querySelector("#cl-recycle-bin-hdr");
    const list = section.querySelector("#cl-recycle-bin-list");
    const toggle = section.querySelector("#cl-recycle-bin-toggle");
    
    safeGet("recycleBinExpanded", d => {
      const expanded = d.recycleBinExpanded !== false;
      list.style.display = expanded ? "flex" : "none";
      toggle.textContent = expanded ? "▲" : "▼";
    });
    
    hdr.onclick = () => {
      const isVisible = list.style.display !== "none";
      list.style.display = isVisible ? "none" : "flex";
      toggle.textContent = isVisible ? "▼" : "▲";
      safeSet({ recycleBinExpanded: !isVisible });
    };
    
    renderSidebarTrashList();
  } catch {}
}

let lastSidebarTrashListJson = "";

function renderSidebarTrashList() {
  try {
    const list = document.getElementById("cl-recycle-bin-list");
    if (!list) return;
    
    safeGet("recycleBin", d => {
      const bin = d.recycleBin || [];
      const binJson = JSON.stringify(bin.map(b => ({ uuid: b.uuid, title: b.title, len: b.messages.length })));
      if (binJson === lastSidebarTrashListJson) return;
      lastSidebarTrashListJson = binJson;

      if (bin.length === 0) {
        list.innerHTML = `
          <div style="padding: 8px 12px; font-size:11px; color:rgba(255,255,255,0.3); text-align:center;">
            Recycle Bin is empty
          </div>
        `;
        return;
      }
      
      list.innerHTML = bin.map((item, idx) => {
        return `
          <div class="cl-trash-item" data-idx="${idx}" style="display:flex; align-items:center; justify-content:space-between; padding: 6px 12px; border-radius: 6px; cursor:pointer; font-size: 12.5px; color: rgba(255,255,255,0.8); transition: background 0.15s;" onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background='transparent'">
            <span class="cl-trash-title" style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding-right:8px;" title="${escHtml(item.title)}">${escHtml(item.title)}</span>
            <div style="display:flex; gap:6px; flex-shrink:0;">
              <button class="cl-trash-restore-btn" data-idx="${idx}" title="Restore Chat" style="background:transparent; border:none; padding:2px; cursor:pointer; font-size:10px; opacity:0.6; transition:opacity 0.15s;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.6'">📥</button>
              <button class="cl-trash-delete-btn" data-idx="${idx}" title="Delete Permanently" style="background:transparent; border:none; padding:2px; cursor:pointer; font-size:10px; opacity:0.6; transition:opacity 0.15s;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.6'">✕</button>
            </div>
          </div>
        `;
      }).join("");
      
      list.querySelectorAll(".cl-trash-title").forEach(titleEl => {
        titleEl.onclick = (e) => {
          e.stopPropagation();
          const idx = parseInt(titleEl.parentElement.dataset.idx);
          openSidebarPreviewModal(bin[idx]);
        };
      });
      
      list.querySelectorAll(".cl-trash-restore-btn").forEach(btn => {
        btn.onclick = (e) => {
          e.stopPropagation();
          const idx = parseInt(btn.dataset.idx);
          const item = bin[idx];
          if (item) {
            const markdown = formatForExport(item.messages, 'custom');
            navigator.clipboard.writeText(markdown).then(() => {
              showToast("✓ History copied! Opening new chat...");
              const newChatBtn = document.querySelector('a[href="/chat"], button:has(svg path[d*="M12 5v14"])');
              if (newChatBtn) {
                newChatBtn.click();
              } else {
                location.href = "https://claude.ai/chat/";
              }
            });
          }
        };
      });
      
      list.querySelectorAll(".cl-trash-delete-btn").forEach(btn => {
        btn.onclick = (e) => {
          e.stopPropagation();
          const idx = parseInt(btn.dataset.idx);
          if (confirm("Permanently delete this chat history?")) {
            safeGet("recycleBin", data => {
              const binList = data.recycleBin || [];
              binList.splice(idx, 1);
              safeSet({ recycleBin: binList }, () => {
                showToast("🗑️ Chat deleted permanently");
                lastSidebarTrashListJson = "";
                renderSidebarTrashList();
              });
            });
          }
        };
      });
    });
  } catch {}
}

function openSidebarPreviewModal(chat) {
  try {
    document.getElementById("cl-preview-modal")?.remove();
    
    const modal = document.createElement("div");
    modal.id = "cl-preview-modal";
    modal.style.position = "fixed";
    modal.style.top = "0";
    modal.style.left = "0";
    modal.style.width = "100%";
    modal.style.height = "100%";
    modal.style.background = "rgba(0,0,0,0.75)";
    modal.style.backdropFilter = "blur(8px)";
    modal.style.zIndex = "999999";
    modal.style.display = "flex";
    modal.style.alignItems = "center";
    modal.style.justifyContent = "center";
    modal.style.padding = "20px";
    modal.style.fontFamily = "system-ui, -apple-system, sans-serif";
    
    const messagesHtml = chat.messages.map(m => {
      const isHuman = m.role === "human";
      const bg = isHuman ? "rgba(217, 70, 239, 0.05)" : "rgba(255,255,255,0.02)";
      const border = isHuman ? "rgba(217, 70, 239, 0.15)" : "rgba(255,255,255,0.08)";
      const color = isHuman ? "#d946ef" : "#e5e7eb";
      const label = isHuman ? "Human" : "Assistant";
      return `
        <div style="background: ${bg}; border: 1px solid ${border}; border-radius: 8px; padding: 12px; margin-bottom: 12px; text-align: left;">
          <div style="font-size: 10px; font-weight: 700; text-transform: uppercase; color: ${color}; margin-bottom: 6px;">${label}</div>
          <div style="white-space: pre-wrap; font-size: 13px; line-height: 1.5; color: #f3f4f6;">${escHtml(m.text)}</div>
        </div>
      `;
    }).join("");
    
    modal.innerHTML = `
      <div style="background: #191919; border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; width: 100%; max-width: 600px; height: 80%; display: flex; flex-direction: column; box-shadow: 0 20px 50px rgba(0,0,0,0.5); overflow:hidden;">
        <div style="display:flex; justify-content:space-between; align-items:center; padding: 16px 20px; border-bottom: 1px solid rgba(255,255,255,0.08); background:#191919;">
          <div style="font-weight: 600; font-size: 15px; color: #fff; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:450px;">🗑️ Recycled: ${escHtml(chat.title)}</div>
          <button id="cl-modal-close" style="background:transparent; border:none; color:#888; font-size:18px; cursor:pointer; line-height:1;">✕</button>
        </div>
        <div style="flex:1; overflow-y:auto; padding: 20px; background:#111;">
          ${messagesHtml}
        </div>
        <div style="display:flex; gap:12px; padding: 16px 20px; border-top: 1px solid rgba(255,255,255,0.08); background:#191919;">
          <button id="cl-modal-copy" style="flex:1; background:#d946ef; color:#fff; border:none; border-radius:8px; padding: 10px; font-weight:600; cursor:pointer; font-size:13px; transition:background 0.2s;" onmouseover="this.style.background='#c026d3'" onmouseout="this.style.background='#d946ef'">📋 Copy Full History</button>
          <button id="cl-modal-download" style="flex:1; background:rgba(255,255,255,0.05); color:#fff; border:1px solid rgba(255,255,255,0.15); border-radius:8px; padding: 10px; font-weight:600; cursor:pointer; font-size:13px; transition:background 0.2s;" onmouseover="this.style.background='rgba(255,255,255,0.1)'" onmouseout="this.style.background='rgba(255,255,255,0.05)'">📥 Download .md</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    modal.querySelector("#cl-modal-close").onclick = () => modal.remove();
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    
    modal.querySelector("#cl-modal-copy").onclick = () => {
      const markdown = formatForExport(chat.messages, 'custom');
      navigator.clipboard.writeText(markdown).then(() => {
        showToast("✓ Copied to clipboard!");
      });
    };
    
    modal.querySelector("#cl-modal-download").onclick = () => {
      const markdown = formatForExport(chat.messages, 'custom');
      const blob = new Blob([markdown], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${chat.title.replace(/[^a-zA-Z0-9]/g, "_")}.md`;
      a.click();
      URL.revokeObjectURL(url);
      showToast("✓ Downloaded markdown!");
    };
  } catch {}
}

function setupRecycleBinListeners() {
  try {
    document.addEventListener("mouseover", e => {
      const link = e.target.closest('a[href*="/chat/"]');
      if (link) {
        const m = link.href.match(/\/chat\/([0-9a-fA-F-]+)/i);
        if (m) {
          lastInteractedUuid = m[1];
        }
      }
    }, { passive: true });

    document.addEventListener("click", e => {
      const link = e.target.closest('a[href*="/chat/"]');
      if (link) {
        const m = link.href.match(/\/chat\/([0-9a-fA-F-]+)/i);
        if (m) {
          lastInteractedUuid = m[1];
        }
      } else {
        const btn = e.target.closest('button, [role="button"], a');
        if (btn) {
          const text = btn.textContent.trim().toLowerCase();
          if (text.includes("delete")) {
            const uuid = lastInteractedUuid || getCurrentChatUuid();
            if (uuid) {
              updateLocalChatCache(true);
              fetchClaudeChatFromApi(uuid).then(chatData => {
                if (chatData) {
                  safeGet("chatCache", curr => {
                    const cache = curr?.chatCache || {};
                    cache[uuid] = chatData;
                    safeSet({ chatCache: cache });
                  });
                }
              });
            }
          }
          if (text === "delete" || text === "delete chat" || text === "confirm") {
            const uuid = lastInteractedUuid || getCurrentChatUuid();
            if (uuid) {
              recycleChat(uuid);
            }
          }
        }
      }
    }, { passive: true });
    
    setTimeout(injectRecycleBinIntoSidebar, 1500);
    setTimeout(syncAllSidebarChats, 4000);
    setInterval(syncAllSidebarChats, 5 * 60 * 1000);
  } catch {}
}

// ── Conversation Scraping & Export ─────────────────────────────────────
function scrapeConversation() {
  const messages = [];
  try {
    const config = getSiteConfig();
    if (typeof config.scrapeTurns === "function") {
      const specific = config.scrapeTurns();
      if (specific && specific.length > 0) return specific;
    }

    // Strategy 1: Find turn containers with data-testid
    const humanTurns = document.querySelectorAll('[data-testid="human-turn"], [data-testid*="user-message"]');
    const assistantTurns = document.querySelectorAll('[data-testid="ai-turn"], [data-testid*="assistant-message"]');
    if (humanTurns.length > 0 || assistantTurns.length > 0) {
      const all = [...document.querySelectorAll('[data-testid="human-turn"], [data-testid="ai-turn"], [data-testid*="user-message"], [data-testid*="assistant-message"]')];
      for (const el of all) {
        const tid = el.getAttribute('data-testid') || '';
        const role = (tid.includes('human') || tid.includes('user')) ? 'human' : 'assistant';
        const text = extractCleanText(el);
        if (text) messages.push({ role, text });
      }
      if (messages.length > 0) return messages;
    }

    // Strategy 2: Look for conversation thread container and alternate children
    const threadSelectors = [
      '[class*="conversation"]', '[class*="thread"]', '[class*="chat-messages"]',
      '[role="log"]', '[role="main"] > div > div'
    ];
    for (const sel of threadSelectors) {
      const container = document.querySelector(sel);
      if (!container) continue;
      const children = Array.from(container.children).filter(c => {
        const r = c.getBoundingClientRect();
        return r.height > 20 && c.textContent.trim().length > 5;
      });
      if (children.length >= 2) {
        for (let i = 0; i < children.length; i++) {
          const text = extractCleanText(children[i]);
          if (!text) continue;
          messages.push({ role: i % 2 === 0 ? 'human' : 'assistant', text });
        }
        if (messages.length >= 2) return messages;
        messages.length = 0;
      }
    }

    // Strategy 3: Heuristic — find all substantial text blocks below header
    const mainArea = document.querySelector('main') || document.querySelector('[role="main"]') || document.body;
    const blocks = Array.from(mainArea.querySelectorAll('div, article, section')).filter(el => {
      const r = el.getBoundingClientRect();
      if (r.top < 80 || r.height < 30) return false;
      if (el.closest('#ar-panel') || el.closest('#ar-page-usage-bar')) return false;
      const text = el.innerText?.trim() || '';
      if (text.length < 10) return false;
      // Only leaf-ish blocks (not too many children with text)
      const childDivs = el.querySelectorAll(':scope > div');
      return childDivs.length < 5;
    });

    // Group blocks by vertical position to detect turn boundaries
    let lastRole = 'assistant'; // First real message is usually human
    for (const block of blocks) {
      const text = extractCleanText(block);
      if (!text || text.length < 10) continue;
      // Simple heuristic: check if it contains typical AI response markers
      const looksLikeAssistant = /```|\*\*|^(Here|I |Let me|Sure|Of course|The |This |To |You can)/m.test(text);
      const role = looksLikeAssistant ? 'assistant' : 'human';
      // Avoid consecutive same roles — alternate if needed
      if (messages.length > 0 && messages[messages.length - 1].role === role) {
        messages[messages.length - 1].text += '\n\n' + text;
      } else {
        messages.push({ role, text });
      }
    }
  } catch (err) {
    console.warn('Claude Safeguard: scrape error', err);
  }
  return messages;
}

function extractCleanText(el) {
  if (!el) return '';
  // Clone to avoid modifying the live DOM
  const clone = el.cloneNode(true);
  // Remove buttons, SVGs, and UI chrome
  clone.querySelectorAll('button, svg, [class*="copy"], [class*="toolbar"], [class*="action"]').forEach(e => e.remove());
  let text = clone.innerText || clone.textContent || '';
  // Normalize whitespace
  text = text.replace(/\t/g, '  ').replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

const EXPORT_TEMPLATES = {
  chatgpt: {
    name: 'ChatGPT',
    color: '#10a37f',
    icon: '🟢',
    wrap: (conv) => `I'm continuing a conversation from Claude AI. Here is the full conversation history so you have complete context:\n\n${conv}\n\nPlease continue from where the last response ended. Maintain the same context, coding style, and approach. Pick up the next task naturally.`
  },
  gemini: {
    name: 'Gemini',
    color: '#4285f4',
    icon: '🔵',
    wrap: (conv) => `I need to continue work from a previous session on Claude AI. Below is the complete conversation for context:\n\n${conv}\n\nPlease pick up from the last response and continue the work seamlessly. Keep the same approach and style.`
  },
  claude: {
    name: 'Claude',
    color: '#d97706',
    icon: '🟠',
    wrap: (conv) => `Here is a conversation from a previous Claude session that I need to continue:\n\n${conv}\n\nPlease continue from where we left off, maintaining the same approach and context.`
  },
  deepseek: {
    name: 'DeepSeek',
    color: '#6366f1',
    icon: '🟣',
    wrap: (conv) => `I'm transferring context from a Claude AI conversation. Here is the full discussion for you to continue from:\n\n${conv}\n\nPlease continue the work from where the last response ended. Maintain the same style and approach.`
  },
  custom: {
    name: 'Raw',
    color: '#8b8ba0',
    icon: '📄',
    wrap: (conv) => conv
  }
};

function formatForExport(messages, targetAI) {
  if (!messages || messages.length === 0) return '(No messages found in this conversation)';
  const conv = messages.map(m => {
    const label = m.role === 'human' ? 'Human' : 'Assistant';
    return `**${label}:**\n${m.text}`;
  }).join('\n\n---\n\n');
  const template = EXPORT_TEMPLATES[targetAI] || EXPORT_TEMPLATES.custom;
  return template.wrap(conv);
}


// ── Auto-Save Draft ───────────────────────────────────────────────────
let draftSaveTimeout = null;
function autoSaveDraft(prompt, url, mins, interval) {
  clearTimeout(draftSaveTimeout);
  draftSaveTimeout = setTimeout(() => {
    safeGet("savedSettings", d => {
      const existing = d?.savedSettings || {};
      safeSet({ savedSettings: {
        chatUrl: url !== undefined ? url : (existing.chatUrl || ""),
        prompt: prompt !== undefined ? prompt : (existing.prompt || ""),
        resetMinutes: mins !== undefined ? mins : (existing.resetMinutes || 0),
        checkInterval: interval !== undefined ? interval : (existing.checkInterval || 60)
      }});
    });
  }, 500);
}

// ── Send prompt ───────────────────────────────────────────────────────
async function doSend(prompt, force = false) {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  if (!canSend(force)) return { sent: false, reason: isLimitActive() ? "still_limited" : "not_ready" };

  const box = getInput();
  if (!box) return { sent: false, reason: "no_input" };

  const finalPrompt = resolvePromptVariables(prompt);

  box.focus();
  await wait(300);

  if (box.tagName === "TEXTAREA" || box.tagName === "INPUT") {
    box.value = "";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    box.dispatchEvent(new Event("change", { bubbles: true }));
    await wait(200);
    try {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set ||
                     Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      if (setter) {
        if (box._valueTracker) {
          try { box._valueTracker.setValue(""); } catch {}
        }
        setter.call(box, finalPrompt);
      } else {
        box.value = finalPrompt;
      }
    } catch {
      box.value = finalPrompt;
    }
    box.dispatchEvent(new Event("input", { bubbles: true }));
    box.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    box.focus();
    document.execCommand("selectAll", false, null);
    document.execCommand("delete", false, null);
    await wait(200);
    const success = document.execCommand("insertText", false, finalPrompt);
    if (!success || !box.innerText?.trim()) {
      box.innerText = finalPrompt;
      box.dispatchEvent(new Event("input", { bubbles: true }));
      box.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
  await wait(800);

  // Verify insertion
  const finalVal = (box.tagName === "TEXTAREA" || box.tagName === "INPUT") ? box.value : box.innerText;
  if (!finalVal || !finalVal.trim()) {
    const dt = new DataTransfer();
    dt.setData("text/plain", finalPrompt);
    box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
    await wait(800);
  }
  
  const verifiedVal = (box.tagName === "TEXTAREA" || box.tagName === "INPUT") ? box.value : box.innerText;
  if (!verifiedVal || !verifiedVal.trim()) return { sent: false, reason: "insert_failed" };

  await wait(300);

  // Click send button
  const btn = getSendBtn();
  if (btn) {
    if (btn.disabled || btn.getAttribute("disabled") !== null) {
      btn.disabled = false;
      btn.removeAttribute("disabled");
      btn.classList.remove("disabled");
    }
    btn.click();
    await wait(600);
    return { sent: true, method: "button" };
  }

  // Enter key fallback
  box.focus();
  ["keydown", "keypress", "keyup"].forEach(t =>
    box.dispatchEvent(new KeyboardEvent(t, {
      key: "Enter", code: "Enter", keyCode: 13,
      which: 13, bubbles: true, cancelable: true, shiftKey: false
    }))
  );
  await wait(600);
  return { sent: true, method: "enter" };
}

// ── Styles ────────────────────────────────────────────────────────────
function injectStyles() {
  if (document.getElementById("ar-styles")) return;
  const el = document.createElement("style");
  el.id = "ar-styles";
  el.textContent = `
    /* Premium Google Fonts Import */
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Outfit:wght@500;600;700&display=swap');

    /* Header button */
    #ar-btn {
      width: 32px;
      height: 32px;
      border-radius: 9px;
      border: 1px solid rgba(217, 70, 239, 0.22);
      background: rgba(20, 18, 33, 0.45);
      backdrop-filter: blur(8px);
      cursor: pointer;
      color: #d946ef; /* Orchid */
      display: inline-flex;
      align-items: center;
      justify-content: center;
      position: relative;
      flex-shrink: 0;
      transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
      vertical-align: middle;
      box-shadow: 0 2px 6px rgba(217, 70, 239, 0.12);
    }
    #ar-btn:hover {
      background: rgba(217, 70, 239, 0.12);
      border-color: #d946ef;
      color: #e879f9;
      box-shadow: 0 0 12px rgba(217, 70, 239, 0.35);
      transform: translateY(-1px);
    }
    
    /* Dark mode override */
    .dark #ar-btn, [class*="dark"] #ar-btn {
      color: #e879f9;
      border-color: rgba(217, 70, 239, 0.35);
      background: rgba(20, 18, 33, 0.6);
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
    }
    .dark #ar-btn:hover, [class*="dark"] #ar-btn:hover {
      color: #f472b6;
      border-color: #d946ef;
      background: rgba(217, 70, 239, 0.18);
      box-shadow: 0 0 14px rgba(217, 70, 239, 0.4);
    }
 
    #ar-btn:active {
      transform: translateY(0) scale(0.98);
    }
    #ar-btn svg {
      width: 18px;
      height: 18px;
      pointer-events: none;
      transition: color 0.25s;
    }
    #ar-btn:hover svg {
      color: currentColor;
    }
    #ar-btn:hover svg .ar-outer-ring {
      animation: ar-spin-ring 12s linear infinite;
    }
    #ar-btn:hover svg .ar-tick-hand {
      transform-origin: 12px 12px;
      transform: rotate(20deg);
    }
    @keyframes ar-spin-ring {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    #ar-badge {
      position:absolute; top:5px; right:5px; width:7px; height:7px;
      border-radius:50%; border:1.5px solid #1a1a1e; display:none;
    }
 
    /* State styles (Light Theme) */
    #ar-btn.s-mon {
      color: #10b981; border-color: rgba(16, 185, 129, 0.35); background: rgba(16, 185, 129, 0.06);
    }
    #ar-btn.s-mon:hover {
      color: #059669; border-color: rgba(16, 185, 129, 0.55); background: rgba(16, 185, 129, 0.12);
      box-shadow: 0 0 10px rgba(16, 185, 129, 0.2);
    }
    #ar-btn.s-mon #ar-badge { display:block; background:#10b981; border-color:#fff; animation:ar-p 2s infinite; }
 
    #ar-btn.s-wait {
      color: #f59e0b; border-color: rgba(245, 158, 11, 0.35); background: rgba(245, 158, 11, 0.06);
    }
    #ar-btn.s-wait:hover {
      color: #d97706; border-color: rgba(245, 158, 11, 0.55); background: rgba(245, 158, 11, 0.12);
      box-shadow: 0 0 10px rgba(245, 158, 11, 0.2);
    }
    #ar-btn.s-wait #ar-badge { display:block; background:#facc15; border-color:#fff; animation:ar-p 2s infinite; }
 
    #ar-btn.s-chk {
      color: #06b6d4; border-color: rgba(6, 182, 212, 0.35); background: rgba(6, 182, 212, 0.06);
    }
    #ar-btn.s-chk:hover {
      color: #0891b2; border-color: rgba(6, 182, 212, 0.55); background: rgba(6, 182, 212, 0.12);
      box-shadow: 0 0 10px rgba(6, 182, 212, 0.25);
    }
    #ar-btn.s-chk #ar-badge { display:block; background:#06b6d4; border-color:#fff; animation:ar-p 0.7s infinite; }
 
    #ar-btn.s-done {
      color: #10b981; border-color: rgba(16, 185, 129, 0.35); background: rgba(16, 185, 129, 0.06);
    }
    #ar-btn.s-done:hover {
      color: #059669; border-color: rgba(16, 185, 129, 0.55); background: rgba(16, 185, 129, 0.12);
      box-shadow: 0 0 10px rgba(16, 185, 129, 0.2);
    }
    #ar-btn.s-done #ar-badge { display:block; background:#10b981; border-color:#fff; }
 
    /* State styles (Dark Theme) */
    .dark #ar-btn.s-mon, [class*="dark"] #ar-btn.s-mon {
      color: #34d399; border-color: rgba(52, 211, 153, 0.35); background: rgba(52, 211, 153, 0.08);
    }
    .dark #ar-btn.s-mon:hover, [class*="dark"] #ar-btn.s-mon:hover {
      color: #6ee7b7; border-color: rgba(52, 211, 153, 0.55); background: rgba(52, 211, 153, 0.15);
      box-shadow: 0 0 10px rgba(52, 211, 153, 0.25);
    }
    .dark #ar-btn.s-mon #ar-badge, [class*="dark"] #ar-btn.s-mon #ar-badge { border-color:#1a1a1e; }
 
    .dark #ar-btn.s-wait, [class*="dark"] #ar-btn.s-wait {
      color: #fbbf24; border-color: rgba(251, 191, 36, 0.35); background: rgba(251, 191, 36, 0.08);
    }
    .dark #ar-btn.s-wait:hover, [class*="dark"] #ar-btn.s-wait:hover {
      color: #fde047; border-color: rgba(251, 191, 36, 0.55); background: rgba(251, 191, 36, 0.15);
      box-shadow: 0 0 10px rgba(251, 191, 36, 0.25);
    }
    .dark #ar-btn.s-wait #ar-badge, [class*="dark"] #ar-btn.s-wait #ar-badge { border-color:#1a1a1e; }
 
    .dark #ar-btn.s-chk, [class*="dark"] #ar-btn.s-chk {
      color: #67e8f9; border-color: rgba(103, 232, 249, 0.35); background: rgba(103, 232, 249, 0.08);
    }
    .dark #ar-btn.s-chk:hover, [class*="dark"] #ar-btn.s-chk:hover {
      color: #22d3ee; border-color: rgba(103, 232, 249, 0.55); background: rgba(103, 232, 249, 0.15);
      box-shadow: 0 0 10px rgba(103, 232, 249, 0.25);
    }
    .dark #ar-btn.s-chk #ar-badge, [class*="dark"] #ar-btn.s-chk #ar-badge { border-color:#1a1a1e; }
 
    .dark #ar-btn.s-done, [class*="dark"] #ar-btn.s-done {
      color: #34d399; border-color: rgba(52, 211, 153, 0.35); background: rgba(52, 211, 153, 0.08);
    }
    .dark #ar-btn.s-done:hover, [class*="dark"] #ar-btn.s-done:hover {
      color: #6ee7b7; border-color: rgba(52, 211, 153, 0.55); background: rgba(52, 211, 153, 0.15);
      box-shadow: 0 0 10px rgba(52, 211, 153, 0.25);
    }
    .dark #ar-btn.s-done #ar-badge, [class*="dark"] #ar-btn.s-done #ar-badge { border-color:#1a1a1e; }
 
    @keyframes ar-p { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.4;transform:scale(0.65)} }
 
    /* Floating Action Button (FAB) fallback */
    .ar-fab {
      transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1) !important;
    }
    .ar-fab:hover {
      background: linear-gradient(135deg, #d946ef, #8b5cf6) !important;
      transform: translateY(-2px) scale(1.05) !important;
      box-shadow: 0 8px 24px rgba(217, 70, 239, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.2) !important;
    }
    .ar-fab:active {
      transform: translateY(0) scale(0.98) !important;
    }
    .ar-fab svg {
      width: 20px !important;
      height: 20px !important;
      color: #ffffff !important;
    }
 
    /* FAB state overrides */
    .ar-fab.s-mon {
      background: linear-gradient(135deg, #10b981, #34d399) !important;
      box-shadow: 0 4px 16px rgba(16, 185, 129, 0.4) !important;
    }
    .ar-fab.s-mon:hover {
      box-shadow: 0 6px 20px rgba(16, 185, 129, 0.6) !important;
    }
 
    .ar-fab.s-wait {
      background: linear-gradient(135deg, #f59e0b, #fbbf24) !important;
      box-shadow: 0 4px 16px rgba(245, 158, 11, 0.4) !important;
    }
    .ar-fab.s-wait:hover {
      box-shadow: 0 6px 20px rgba(245, 158, 11, 0.6) !important;
    }
 
    .ar-fab.s-chk {
      background: linear-gradient(135deg, #06b6d4, #3b82f6) !important;
      box-shadow: 0 4px 16px rgba(6, 182, 212, 0.4) !important;
    }
    .ar-fab.s-chk:hover {
      box-shadow: 0 6px 20px rgba(6, 182, 212, 0.6) !important;
    }
 
    .ar-fab.s-done {
      background: linear-gradient(135deg, #10b981, #34d399) !important;
      box-shadow: 0 4px 16px rgba(16, 185, 129, 0.4) !important;
    }
 
    /* Panel — glassmorphic widget */
    #ar-panel {
      position:fixed; width:348px;
      background: rgba(12, 10, 20, 0.88);
      backdrop-filter: blur(18px);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius:16px; z-index:2147483647;
      box-shadow:0 16px 56px rgba(0,0,0,0.8), 0 0 14px rgba(217, 70, 239, 0.08);
      font-family: 'Inter', -apple-system, sans-serif;
      overflow:hidden; animation:ar-drop 0.25s cubic-bezier(0.34,1.56,0.64,1);
    }
    @keyframes ar-drop {
      from{opacity:0;transform:translateY(-10px) scale(0.97)}
      to  {opacity:1;transform:translateY(0)     scale(1)}
    }
 
    /* Header */
    .ar-hd {
      display:flex; align-items:center; justify-content:space-between;
      padding:14px 16px 12px;
      border-bottom:1px solid rgba(255,255,255,0.06);
      background: linear-gradient(160deg, rgba(217, 70, 239, 0.06) 0%, transparent 60%);
    }
    .ar-hd-l { display:flex; align-items:center; gap:10px; }
    .ar-ico {
      width:28px; height:28px; border-radius:7px; flex-shrink:0;
      background:linear-gradient(135deg, #d946ef, #8b5cf6);
      display:flex; align-items:center; justify-content:center;
      box-shadow: 0 0 8px rgba(217, 70, 239, 0.3);
    }
    .ar-ico svg { width:14px; height:14px; color:#fff; }
    .ar-ttl { font-family: 'Outfit', sans-serif; font-size:13.5px; font-weight:700; color:#ffffff; }
    .ar-sub { font-size:9.5px; color:#8b8ba0; margin-top:1px; }
    .ar-cls {
      width:22px; height:22px; border-radius:6px; border:none;
      background:rgba(255,255,255,0.05); color:#8b8ba0; font-size:12px;
      cursor:pointer; display:flex; align-items:center; justify-content:center;
      transition:all 0.15s;
    }
    .ar-cls:hover { background:rgba(255,255,255,0.1); color:#ffffff; }
 
    /* Tabs */
    .ar-tabs {
      display:flex; border-bottom:1px solid rgba(255,255,255,0.06);
      padding:0 14px;
      background: rgba(15, 13, 25, 0.1);
    }
    .ar-tab {
      padding:10px 12px 8px; font-family: 'Outfit', sans-serif; font-size:11.5px; font-weight:600; color:#8b8ba0;
      border-bottom:2px solid transparent; cursor:pointer; transition:all 0.15s;
      user-select:none; letter-spacing:0.2px;
    }
    .ar-tab:hover { color:#ffffff; }
    .ar-tab.active { color:#d946ef; border-bottom-color:#d946ef; text-shadow: 0 0 6px rgba(217, 70, 239, 0.25); }
 
    /* Tab content */
    .ar-tab-body { display:none; padding:15px 16px 16px; }
    .ar-tab-body.active { display:flex; flex-direction:column; gap:12px; }
 
    /* Status card */
    .ar-sc {
      display:flex; align-items:flex-start; gap:10px; padding:10px 12px;
      border-radius:10px; background:rgba(255,255,255,0.03);
      border:1px solid rgba(255,255,255,0.05);
    }
    .ar-sc-dot {
      width:7px; height:7px; border-radius:50%; flex-shrink:0; margin-top:4px;
      background:#4b5563;
    }
    .ar-sc.s-mon  .ar-sc-dot { background:#10b981; animation:ar-p 2s infinite; }
    .ar-sc.s-wait .ar-sc-dot { background:#f59e0b; animation:ar-p 2s infinite; }
    .ar-sc.s-chk  .ar-sc-dot { background:#06b6d4; animation:ar-p 0.7s infinite; }
    .ar-sc.s-done .ar-sc-dot { background:#10b981; }
    .ar-sc.s-fail .ar-sc-dot { background:#ef4444; }
    .ar-sc-info { flex:1; min-width:0; }
    .ar-sc-title { font-size:12.5px; font-weight:600; color:#ffffff; }
    .ar-sc-desc  { font-size:11px; color:#8b8ba0; margin-top:2px; line-height:1.5; }
 
    /* Progress */
    .ar-prog { margin-top:6px; }
    .ar-prog-bar { height:4px; background:rgba(255,255,255,0.05); border-radius:100px; overflow:hidden; }
    .ar-prog-fill { height:100%; background:linear-gradient(90deg, #d946ef, #06b6d4);
      border-radius:100px; transition:width 3s ease; box-shadow: 0 0 6px rgba(217, 70, 239, 0.3); }
    .ar-prog-lbl { font-size:10.5px; color:#8b8ba0; margin-top:5px; font-family: monospace; }
 
    /* Task info card */
    .ar-task {
      padding:11px 12px; border-radius:12px;
      background:rgba(255,255,255,0.02); border:1px solid rgba(255, 255, 255, 0.04);
    }
    .ar-task-row { display:flex; justify-content:space-between; align-items:center;
      margin-bottom:7px; }
    .ar-task-row:last-child { margin-bottom:0; }
    .ar-task-key { font-family: 'Outfit', sans-serif; font-size:9.5px; color:#8b8ba0; text-transform:uppercase;
      letter-spacing:0.5px; font-weight:600; }
    .ar-task-val { font-size:11px; color:#f3f4f6; text-align:right; font-weight: 550;
      max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .ar-task-val.green { color:#34d399; }
    .ar-task-val.yellow { color:#fbbf24; }
    .ar-task-val.muted { color:#6b7280; }
 
    /* Fields */
    .ar-lbl { font-family: 'Outfit', sans-serif; font-size:9.5px; font-weight:600; letter-spacing:0.6px;
      text-transform:uppercase; color:#8b8ba0; margin-bottom:5px; display:block; }
    .ar-inp, .ar-txa {
      width:100%; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.06);
      border-radius:8px; color:#f3f4f6; padding:8px 10px; font-family:inherit;
      font-size:12px; outline:none; resize:none; transition:all 0.2s;
      box-sizing:border-box;
    }
    .ar-txa { height:72px; line-height:1.6; }
    .ar-inp:focus,.ar-txa:focus {
      border-color: #d946ef; box-shadow:0 0 0 3px rgba(217, 70, 239, 0.15);
      background: rgba(10, 8, 18, 0.7);
    }
    .ar-row2 { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    .ar-hint { font-size:10px; color:#8b8ba0; margin-top:3px; }
    .ar-auto { font-size:10px; color:#10b981; margin-top:3px; font-weight: 500; }
 
    /* URL row */
    .ar-url-r { display:flex; gap:6px; }
    .ar-url-r .ar-inp { flex:1; }
    .ar-grab {
      padding:0 10px; background:rgba(255,255,255,0.04);
      border:1px solid rgba(255,255,255,0.06); border-radius:8px;
      color:#e5e7eb; font-size:11px; font-weight:500; cursor:pointer;
      white-space:nowrap; font-family:inherit; transition:all 0.15s; flex-shrink:0;
    }
    .ar-grab:hover { background:rgba(217, 70, 239, 0.1); border-color:#d946ef; color: #ffffff; }
 
    /* Buttons */
    .ar-btn-primary {
      width:100%; padding:10px; border:none; border-radius:9px;
      background:linear-gradient(135deg,#d946ef,#8b5cf6);
      color:#fff; font-family:inherit; font-size:13px; font-weight:700;
      cursor:pointer; letter-spacing:0.3px;
      box-shadow:0 3px 14px rgba(217,70,239,0.3);
      transition:all 0.2s;
    }
    .ar-btn-primary:hover { opacity:0.95; box-shadow: 0 4px 18px rgba(217,70,239,0.45); transform: translateY(-1px); }
    .ar-btn-primary:active { transform: translateY(1px) scale(0.99); }
    .ar-btn-primary:disabled { opacity:0.3; cursor:not-allowed; transform:none; box-shadow:none; }
    
    .ar-btn-danger {
      width:100%; padding:9px; border:1px solid rgba(239,68,68,0.3);
      border-radius:9px; background:transparent; color:#fca5a5;
      font-family:inherit; font-size:12px; font-weight:600; cursor:pointer;
      transition:all 0.15s; letter-spacing: 0.3px;
    }
    .ar-btn-danger:hover { background:rgba(239,68,68,0.08); border-color:#ef4444; color:#ffffff; }
 
    /* Log */
    .ar-log {
      background:rgba(8, 7, 12, 0.5); border:1px solid rgba(255,255,255,0.05);
      border-radius:10px; padding:11px; height:196px; overflow-y:auto;
      font-family: monospace; font-size:10.5px;
      color:#9ca3af; line-height:1.75;
      box-shadow: inset 0 2px 8px rgba(0,0,0,0.3);
    }
    .ar-log::-webkit-scrollbar { width:3px; }
    .ar-log::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.08); border-radius:2px; }
    .ar-log-line { display:block; border-left: 2px solid transparent; padding-left: 5px; margin-bottom: 2px; }
    .ar-log-line.ok  { color:#34d399; border-left-color:#10b981; }
    .ar-log-line.warn{ color:#fbbf24; border-left-color:#f59e0b; }
    .ar-log-line.info{ color:#67e8f9; border-left-color:#06b6d4; }
    .ar-log-line.err { color:#f87171; border-left-color:#ef4444; }
 
    /* Divider */
    .ar-div { height:1px; background:rgba(255,255,255,0.05); }
 
    /* Toast */
    #ar-toast {
      position:fixed; bottom:20px; left:50%;
      transform:translateX(-50%) translateY(8px);
      background:rgba(20, 18, 30, 0.95); border:1px solid rgba(255,255,255,0.1);
      border-radius:100px; padding:7px 16px;
      font-family: inherit;
      font-size:12px; color:#ffffff; opacity:0; pointer-events:none;
      transition:all 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275); z-index:2147483647; white-space:nowrap;
      box-shadow:0 8px 24px rgba(0,0,0,0.4), 0 0 10px rgba(217,70,239,0.1);
      backdrop-filter: blur(12px);
    }
    #ar-toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
 
    /* Token counters */
    .ar-prompt-stats {
      font-size: 10px;
      color: #8b8ba0;
      text-align: right;
      margin-top: 4.5px;
      font-family: monospace;
    }
    .ar-prompt-stats .stat-highlight {
      color: #d946ef;
      font-weight: 600;
    }

 
    /* Prompt Templates */
    .ar-templates {
      display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 6px;
    }
    .ar-tpl-chip {
      padding: 4px 10px; border-radius: 100px; border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.03); color: #8b8ba0; font-size: 10px;
      cursor: pointer; transition: all 0.15s; font-family: inherit; white-space: nowrap;
    }
    .ar-tpl-chip:hover {
      background: rgba(217, 70, 239, 0.08); border-color: #d946ef; color: #ffffff;
      box-shadow: 0 0 6px rgba(217, 70, 239, 0.15);
      transform: scale(1.02);
    }
    .ar-tpl-chip.custom { border-style: dashed; border-color: #8b5cf6; }
    .ar-tpl-del {
      margin-left: 5px; opacity: 0.4; font-weight: bold; cursor: pointer; transition: all 0.15s;
    }
    .ar-tpl-del:hover {
      opacity: 1; color: #ef4444 !important; transform: scale(1.1);
    }
    .ar-tpl-save {
      padding: 4px 10px; border-radius: 100px; border: 1px dashed rgba(217, 70, 239, 0.35);
      background: transparent; color: #d946ef; font-size: 10px;
      cursor: pointer; transition: all 0.15s; font-family: inherit;
    }
    .ar-tpl-save:hover { background: rgba(217, 70, 239, 0.06); color: #e879f9; border-color: #d946ef; }
 

 
    /* Force hide she-llac/claude-counter elements to prevent overlaps */
    [class*="cc-"],
    [id*="cc-"],
    .cc-tooltip,
    .cc-tooltipTrigger,
    .cc-header,
    .cc-headerItem,
    .cc-usageRow,
    .cc-usageGroup,
    .cc-usageText,
    .cc-bar {
      display: none !important;
    }
 
    /* Sleek Native Usage progress bar below composer */
    .ar-page-usage-bar {
      width: 100%;
      box-sizing: border-box;
      padding: 10px 16px 12px 16px;
      border-top: 1px solid var(--border-secondary, rgba(128, 128, 128, 0.08));
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      user-select: none;
      background: transparent;
      margin-top: 4px;
    }
    .ar-pub-row {
      display: flex;
      gap: 20px;
      width: 100%;
    }
    .ar-pub-col {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 0;
    }
    .ar-pub-meta {
      display: flex;
      align-items: center;
      font-size: 11px;
      line-height: 1;
      width: 100%;
    }
    .ar-pub-label {
      color: var(--text-secondary, #6b7280);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .ar-pub-pct {
      font-size: 11px;
      font-weight: 700;
      color: var(--text-primary, inherit);
      margin-left: 6px;
      padding: 2px 6px;
      background: var(--bg-tertiary, rgba(128, 128, 128, 0.08));
      border-radius: 4px;
      line-height: 1;
    }
    .ar-pub-reset {
      color: var(--text-tertiary, #9ca3af);
      font-size: 10px;
      margin-left: auto;
      font-family: monospace;
      font-weight: 500;
    }
    .ar-pub-progress-bg {
      height: 6px;
      background: var(--bg-tertiary, rgba(128, 128, 128, 0.12));
      border-radius: 100px;
      overflow: hidden;
      width: 100%;
    }
    .ar-pub-progress-fill {
      height: 100%;
      border-radius: 100px;
      transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1), background-color 0.3s;
      width: 0%;
    }
    .ar-pub-fill-green {
      background: linear-gradient(90deg, #10b981, #34d399);
    }
    .ar-pub-fill-yellow {
      background: linear-gradient(90deg, #f59e0b, #fbbf24);
    }
    .ar-pub-fill-red {
      background: linear-gradient(90deg, #ef4444, #f87171);
    }
    .ar-pub-fill-blue {
      background: linear-gradient(90deg, #6366f1, #a855f7);
    }
 
    /* Export tab */
    .ar-export-chips {
      display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px;
    }
    .ar-ai-chip {
      padding: 5px 12px; border-radius: 100px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(255,255,255,0.03); color: #8b8ba0;
      font-size: 11px; font-weight: 500; cursor: pointer;
      transition: all 0.2s; font-family: inherit;
      display: inline-flex; align-items: center; gap: 5px;
      user-select: none;
    }
    .ar-ai-chip:hover {
      background: rgba(255,255,255,0.06); color: #ffffff;
      transform: translateY(-1px);
    }
    .ar-ai-chip.selected {
      background: rgba(217, 70, 239, 0.12);
      border-color: #d946ef; color: #ffffff;
      box-shadow: 0 0 8px rgba(217, 70, 239, 0.2);
    }
    .ar-export-preview {
      width: 100%; height: 140px; resize: none;
      background: rgba(8, 7, 12, 0.5); border: 1px solid rgba(255,255,255,0.05);
      border-radius: 10px; padding: 10px; color: #9ca3af;
      font-family: monospace; font-size: 10.5px; line-height: 1.65;
      box-sizing: border-box; outline: none;
      box-shadow: inset 0 2px 8px rgba(0,0,0,0.3);
    }
    .ar-export-preview:focus {
      border-color: rgba(217, 70, 239, 0.3);
    }
    .ar-export-stats {
      display: flex; justify-content: space-between; align-items: center;
      font-size: 10px; color: #8b8ba0; margin-top: 6px;
      font-family: monospace;
    }
    .ar-export-stats .es-val {
      color: #d946ef; font-weight: 600;
    }
    .ar-export-stats .es-warn {
      color: #f59e0b; font-weight: 600;
    }
    .ar-export-btns {
      display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px;
    }
    .ar-btn-export {
      padding: 9px; border: none; border-radius: 9px;
      background: linear-gradient(135deg, #d946ef, #8b5cf6);
      color: #fff; font-family: inherit; font-size: 12px; font-weight: 600;
      cursor: pointer; letter-spacing: 0.2px;
      box-shadow: 0 3px 12px rgba(217,70,239,0.25);
      transition: all 0.2s;
    }
    .ar-btn-export:hover { opacity: 0.92; transform: translateY(-1px); box-shadow: 0 4px 16px rgba(217,70,239,0.4); }
    .ar-btn-export:active { transform: translateY(1px) scale(0.99); }
    .ar-btn-download {
      padding: 9px; border: 1px solid rgba(255,255,255,0.08);
      border-radius: 9px; background: rgba(255,255,255,0.03);
      color: #8b8ba0; font-family: inherit; font-size: 12px; font-weight: 500;
      cursor: pointer; transition: all 0.15s;
    }
    .ar-btn-download:hover { background: rgba(255,255,255,0.06); color: #ffffff; border-color: rgba(255,255,255,0.15); }
    .ar-export-empty {
      text-align: center; padding: 24px 16px; color: #5a5a6e;
      font-size: 12px; line-height: 1.8;
    }
    .ar-export-empty .ee-icon { font-size: 28px; margin-bottom: 8px; }
  `;
  document.head.appendChild(el);
}


function hasHeaderAnchor() {
  const shareBtn = Array.from(document.querySelectorAll("button, div[role='button'], a, span"))
    .find(el => el.textContent?.trim() === "Share" && el.getBoundingClientRect().top < 100 && el.getBoundingClientRect().height > 0);
  if (shareBtn && shareBtn.parentElement) return true;

  const upgradeBtn = Array.from(document.querySelectorAll("button, div[role='button'], a, span"))
    .find(el => el.textContent?.trim()?.toLowerCase()?.includes("upgrade") && el.getBoundingClientRect().top < 100 && el.getBoundingClientRect().height > 0);
  if (upgradeBtn && upgradeBtn.parentElement) return true;

  const allBtns = Array.from(document.querySelectorAll("button"));
  const vpW = window.innerWidth;
  const topRightBtns = allBtns.filter(b => {
    const r = b.getBoundingClientRect();
    return r.top < 80 && r.top >= 0 && r.left > vpW * 0.4 && r.width > 0 && r.height > 0;
  });
  if (topRightBtns.length > 0) return true;

  return false;
}

// ── Inject button into Claude header ─────────────────────────────────
function shouldShowBtn() {
  if (fabEnabled === false) return false;
  const url = window.location.href;
  return !url.includes("/login") && !url.includes("/signup");
}

function injectBtn() {
  if (!shouldShowBtn()) {
    document.getElementById("ar-btn")?.remove();
    return;
  }
  // Check if button exists AND is still connected to the DOM
  // (SPA navigation can detach elements without removing them from memory)
  const existing = document.getElementById("ar-btn");
  if (existing && existing.isConnected) return;
  if (existing && !existing.isConnected) existing.remove();

  const btn = document.createElement("button");
  btn.id    = "ar-btn";
  btn.title = "Claude Safeguard";
  btn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <circle class="ar-outer-ring" cx="12" cy="12" r="10" stroke-dasharray="3 3" stroke-opacity="0.4" style="transform-origin: 12px 12px;" />
      <circle cx="12" cy="12" r="8" />
      <path class="ar-tick-hand" d="M12 7v5l3 2" style="transform-origin: 12px 12px;" />
    </svg>
    <span id="ar-badge"></span>
  `;
  btn.onclick = e => { e.stopPropagation(); togglePanel(); };

  function tryInsert() {
    // Strategy 1: Find "Share" button in header (highly reliable on chat pages)
    const shareBtn = Array.from(document.querySelectorAll("button, div[role='button'], a, span"))
      .find(el => el.textContent?.trim() === "Share" && el.getBoundingClientRect().top < 100 && el.getBoundingClientRect().height > 0);
    if (shareBtn && shareBtn.parentElement) {
      btn.className = "";
      btn.style.cssText = "";
      shareBtn.parentElement.insertBefore(btn, shareBtn);
      return true;
    }

    // Strategy 2: Find "Upgrade" button in header
    const upgradeBtn = Array.from(document.querySelectorAll("button, div[role='button'], a, span"))
      .find(el => el.textContent?.trim()?.toLowerCase()?.includes("upgrade") && el.getBoundingClientRect().top < 100 && el.getBoundingClientRect().height > 0);
    if (upgradeBtn && upgradeBtn.parentElement) {
      btn.className = "";
      btn.style.cssText = "";
      upgradeBtn.parentElement.insertBefore(btn, upgradeBtn);
      return true;
    }

    // Strategy 3: Find any buttons in the top-right header area
    const allBtns = Array.from(document.querySelectorAll("button"));
    const vpW = window.innerWidth;
    const topRightBtns = allBtns.filter(b => {
      const r = b.getBoundingClientRect();
      return r.top < 80 && r.top >= 0 && r.left > vpW * 0.4 && r.width > 0 && r.height > 0;
    });

    if (topRightBtns.length > 0) {
      topRightBtns.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
      const anchor = topRightBtns[0];
      if (anchor?.parentElement) {
        btn.className = "";
        btn.style.cssText = "";
        anchor.parentElement.insertBefore(btn, anchor);
        return true;
      }
    }

    // Strategy 4: Find header/nav elements and append to container
    const headerEls = document.querySelectorAll('header, nav, [role="banner"], [data-testid="header"]');
    for (const hdr of headerEls) {
      const r = hdr.getBoundingClientRect();
      if (r.top < 80 && r.height > 0 && r.height < 100) {
        const containers = hdr.querySelectorAll('div, span');
        const rightmost = Array.from(containers)
          .filter(c => {
            const cr = c.getBoundingClientRect();
            return cr.left > vpW * 0.6 && cr.width > 0 && cr.height > 0;
          })
          .sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
        if (rightmost[0]) {
          btn.className = "";
          btn.style.cssText = "";
          rightmost[0].appendChild(btn);
          return true;
        }
      }
    }

    return false;
  }

  // Try immediately
  if (tryInsert()) {
    safeGet("resumeState", d => { if (d?.resumeState?.active) updateBtn(d.resumeState); });
    return;
  }

  // Retry with increasing delays
  const delays = [300, 600, 1000, 1500, 2000, 3000, 4000, 5000];
  let i = 0;
  function retry() {
    const ex = document.getElementById("ar-btn");
    if (ex && ex.isConnected) return; // already injected
    if (ex && !ex.isConnected) ex.remove();
    if (tryInsert()) {
      safeGet("resumeState", d => { if (d?.resumeState?.active) updateBtn(d.resumeState); });
      return;
    }
    i++;
    if (i < delays.length) setTimeout(retry, delays[i]);
    else {
      // Final fallback: floating action button (FAB) in the bottom-right corner
      // Guaranteed to be visible, clickable, and look premium!
      btn.className = "ar-fab";
      btn.style.cssText = `
        position: fixed !important;
        bottom: 24px !important;
        right: 24px !important;
        width: 44px !important;
        height: 44px !important;
        border-radius: 50% !important;
        background: #7c3aed !important;
        border: 1px solid rgba(255, 255, 255, 0.1) !important;
        color: #ffffff !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        z-index: 2147483646 !important;
        box-shadow: 0 4px 16px rgba(124, 58, 237, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.2) !important;
        cursor: pointer !important;
        transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1) !important;
      `;
      document.body.appendChild(btn);
      safeGet("resumeState", d => { if (d?.resumeState?.active) updateBtn(d.resumeState); });
    }
  }
  setTimeout(retry, delays[0]);
}

// ── Panel ─────────────────────────────────────────────────────────────
let panelOpen = false;
let pollInterval = null;

function togglePanel() { panelOpen ? closePanel() : openPanel(); }

function openPanel() {
  if (document.getElementById("ar-panel")) return;
  panelOpen = true;

  const resetInfo = getResetInfo();
  // Position panel under the button
  const arBtn = document.getElementById("ar-btn");
  const isFab = arBtn && arBtn.classList.contains("ar-fab");
  const btnRect = arBtn ? arBtn.getBoundingClientRect() : null;
  const activeConfig = getSiteConfig();

  const p = document.createElement("div");
  p.id = "ar-panel";
  if (isFab) {
    p.style.right = "24px";
    p.style.bottom = "80px";
    p.style.top = "auto";
  } else {
    const panelRight = btnRect ? (window.innerWidth - btnRect.right - 4) : 8;
    const panelTop   = btnRect ? (btnRect.bottom + 6) : 48;
    p.style.right = panelRight + "px";
    p.style.top   = panelTop  + "px";
    p.style.bottom = "auto";
  }
  p.innerHTML = `
    <div class="ar-hd">
      <div class="ar-hd-l">
        <div class="ar-ico">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/>
          </svg>
        </div>
        <div>
          <div class="ar-ttl">Claude Safeguard</div>
          <div class="ar-sub">Auto-resumes and recycles conversations</div>
        </div>
      </div>
      <button class="ar-cls" id="ar-close">✕</button>
    </div>

    <div class="ar-tabs">
      <div class="ar-tab active" data-tab="setup">Setup</div>
      <div class="ar-tab" data-tab="status">Status</div>
      <div class="ar-tab" data-tab="log">Log</div>
      <div class="ar-tab" data-tab="export">Export</div>
    </div>

    <!-- SETUP TAB -->
    <div class="ar-tab-body active" id="ar-t-setup">
      <div>
        <label class="ar-lbl">${activeConfig.name} Chat URL</label>
        <div class="ar-url-r">
          <input id="ar-url" class="ar-inp" type="text"
            placeholder="${activeConfig.chatUrlPrefix}..." />
          <button class="ar-grab" id="ar-grab">Use current</button>
        </div>
      </div>
      <div>
        <label class="ar-lbl">Prompt Templates</label>
        <div class="ar-templates" id="ar-templates"></div>
      </div>
      <div>
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <label class="ar-lbl" style="margin: 0;">Resume Prompt</label>
          <button class="ar-grab" id="ar-sync-composer" title="Sync with active AI chat input" style="font-size: 10px; padding: 2px 8px; border-radius: 100px; cursor: pointer;">🔄 Sync AI Input</button>
        </div>
        <textarea id="ar-prompt" class="ar-txa"
          placeholder="Continue from where we left off. Next step: ..."></textarea>
        <div class="ar-prompt-stats">
          <span id="ar-prompt-char-count">0 chars</span> | <span id="ar-prompt-token-count" class="stat-highlight">0 tokens</span>
          &nbsp;·&nbsp;<button class="ar-tpl-save" id="ar-save-tpl">+ Save as template</button>
        </div>
      </div>
      <div class="ar-row2">
        <div>
          <label class="ar-lbl">Resets in (min)</label>
          <input id="ar-mins" class="ar-inp" type="number"
            value="${resetInfo?.mins ?? 0}" min="0" max="600"/>
          ${resetInfo
            ? `<div class="ar-auto">✓ Auto-detected: ${resetInfo.display} (${resetInfo.source})</div>`
            : `<div class="ar-auto" style="color:#4ade80;">✓ No active limit — Session: ${getUsageInfo().session?.pct ?? '?'}%</div>`}
        </div>
        <div>
          <label class="ar-lbl">Check every (s)</label>
          <input id="ar-interval" class="ar-inp" type="number" value="60" min="15" max="300"/>
          <div class="ar-hint">Retry interval</div>
        </div>
      </div>
      <div class="ar-div"></div>
      <button class="ar-btn-primary" id="ar-start">▶&nbsp; Start Claude Safeguard</button>
      <button class="ar-btn-danger"  id="ar-stop" style="display:none">■&nbsp; Stop</button>
    </div>

    <!-- STATUS TAB -->
    <div class="ar-tab-body" id="ar-t-status">
      <div class="ar-sc" id="ar-sc">
        <div class="ar-sc-dot"></div>
        <div class="ar-sc-info">
          <div class="ar-sc-title" id="ar-sc-title">Idle</div>
          <div class="ar-sc-desc"  id="ar-sc-desc">Start from the Setup tab</div>
        </div>
      </div>
      <div class="ar-prog" id="ar-prog" style="display:none">
        <div class="ar-prog-bar"><div class="ar-prog-fill" id="ar-pf"></div></div>
        <div class="ar-prog-lbl" id="ar-pl"></div>
      </div>
      <div class="ar-task" id="ar-task">
        <div class="ar-task-row">
          <span class="ar-task-key">Status</span>
          <span class="ar-task-val muted" id="tk-status">—</span>
        </div>
        <div class="ar-task-row">
          <span class="ar-task-key">Session</span>
          <span class="ar-task-val muted" id="tk-session">—</span>
        </div>
        <div class="ar-task-row">
          <span class="ar-task-key">Weekly</span>
          <span class="ar-task-val muted" id="tk-weekly">—</span>
        </div>
        <div class="ar-task-row">
          <span class="ar-task-key">Prompt</span>
          <span class="ar-task-val muted" id="tk-prompt">—</span>
        </div>
        <div class="ar-task-row">
          <span class="ar-task-key">Chat</span>
          <span class="ar-task-val muted" id="tk-url">—</span>
        </div>
        <div class="ar-task-row">
          <span class="ar-task-key">Session Reset</span>
          <span class="ar-task-val muted" id="tk-time">—</span>
        </div>
        <div class="ar-task-row">
          <span class="ar-task-key">Attempts</span>
          <span class="ar-task-val muted" id="tk-attempts">0</span>
        </div>
      </div>
      <button class="ar-btn-danger" id="ar-stop2" style="display:none">■&nbsp; Stop Claude Safeguard</button>
    </div>

    <!-- LOG TAB -->
    <div class="ar-tab-body" id="ar-t-log">
      <div class="ar-log" id="ar-log">No log entries yet.</div>
    </div>

    <!-- EXPORT TAB -->
    <div class="ar-tab-body" id="ar-t-export">
      <div>
        <label class="ar-lbl">Target AI</label>
        <div class="ar-export-chips" id="ar-export-chips">
          <button class="ar-ai-chip selected" data-ai="chatgpt">🟢 ChatGPT</button>
          <button class="ar-ai-chip" data-ai="gemini">🔵 Gemini</button>
          <button class="ar-ai-chip" data-ai="claude">🟠 Claude</button>
          <button class="ar-ai-chip" data-ai="deepseek">🟣 DeepSeek</button>
          <button class="ar-ai-chip" data-ai="custom">📄 Raw</button>
        </div>
      </div>
      <div>
        <label class="ar-lbl">Preview</label>
        <textarea class="ar-export-preview" id="ar-export-preview" readonly placeholder="Click a target AI above, then scrape the conversation..."></textarea>
        <div class="ar-export-stats">
          <span>Messages: <span class="es-val" id="ar-ex-msg-count">0</span></span>
          <span>Tokens: <span class="es-val" id="ar-ex-tok-count">0</span></span>
          <span id="ar-ex-warn"></span>
        </div>
      </div>
      <div class="ar-export-btns">
        <button class="ar-btn-export" id="ar-export-copy">📋 Copy Context</button>
        <button class="ar-btn-download" id="ar-export-download">📥 Download .txt</button>
      </div>
    </div>
  `;

  document.body.appendChild(p);

  // ── Tab switching
  p.querySelectorAll(".ar-tab").forEach(tab => {
    tab.onclick = () => {
      p.querySelectorAll(".ar-tab").forEach(t => t.classList.remove("active"));
      p.querySelectorAll(".ar-tab-body").forEach(b => b.classList.remove("active"));
      tab.classList.add("active");
      p.querySelector(`#ar-t-${tab.dataset.tab}`).classList.add("active");
      if (tab.dataset.tab === "log") refreshLog();
      if (tab.dataset.tab === "status") refreshStatus();
      if (tab.dataset.tab === "export") refreshExport();
    };
  });

  // ── Update prompt stats
  const promptTa = p.querySelector("#ar-prompt");
  const charSpan = p.querySelector("#ar-prompt-char-count");
  const tokSpan  = p.querySelector("#ar-prompt-token-count");

  function updatePromptStats() {
    if (!promptTa || !charSpan || !tokSpan) return;
    const txt = promptTa.value || "";
    charSpan.textContent = `${txt.length} char${txt.length === 1 ? "" : "s"}`;
    const tokens = estimateTokens(txt);
    tokSpan.textContent = `${tokens} token${tokens === 1 ? "" : "s"}`;
  }

  const urlInp = p.querySelector("#ar-url");
  const minsInp = p.querySelector("#ar-mins");
  const intInp = p.querySelector("#ar-interval");

  function handlePanelInput() {
    const pr = promptTa ? promptTa.value : "";
    const ur = urlInp ? urlInp.value : "";
    const mi = minsInp ? parseInt(minsInp.value) || 0 : 0;
    const it = intInp ? parseInt(intInp.value) || 60 : 60;
    autoSaveDraft(pr, ur, mi, it);
  }

  if (promptTa) {
    promptTa.addEventListener("input", () => {
      updatePromptStats();
      handlePanelInput();
    });
  }
  if (urlInp) urlInp.addEventListener("input", handlePanelInput);
  if (minsInp) minsInp.addEventListener("input", handlePanelInput);
  if (intInp) intInp.addEventListener("input", handlePanelInput);

  // Sync composer button
  const syncBtn = p.querySelector("#ar-sync-composer");
  if (syncBtn && promptTa) {
    syncBtn.onclick = () => {
      const text = getAIComposerText();
      if (text) {
        promptTa.value = text;
        updatePromptStats();
        handlePanelInput();
        showToast("✓ Synced from AI chat box");
      } else {
        showToast("ℹ AI chat box is empty");
      }
    };
  }

  // ── Prompt Templates
  function renderTemplates() {
    const container = p.querySelector("#ar-templates");
    if (!container) return;
    getTemplates(templates => {
      container.innerHTML = templates.map((t, i) => {
        if (t.custom) {
          return `<span class="ar-tpl-chip custom" data-idx="${i}" title="${escH(t.prompt)}" style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;">
            <span class="ar-tpl-text" style="pointer-events:none;">${escH(t.name)}</span>
            <span class="ar-tpl-del" data-idx="${i}" title="Delete template">✕</span>
          </span>`;
        } else {
          return `<button class="ar-tpl-chip" data-idx="${i}" title="${escH(t.prompt)}">${escH(t.name)}</button>`;
        }
      }).join("");

      container.querySelectorAll(".ar-tpl-chip, span.ar-tpl-chip").forEach(chip => {
        chip.onclick = (e) => {
          if (e.target.classList.contains("ar-tpl-del")) {
            e.stopPropagation();
            const idx = parseInt(e.target.dataset.idx);
            const customIdx = idx - BUILTIN_TEMPLATES.length;
            removeCustomTemplate(customIdx);
            showToast("✓ Template deleted");
            setTimeout(renderTemplates, 300);
            return;
          }
          const idx = parseInt(chip.dataset.idx);
          const tpl = templates[idx];
          if (tpl && promptTa) {
            promptTa.value = tpl.prompt;
            updatePromptStats();
            showToast(`✓ Template: ${tpl.name}`);
          }
        };
      });
    });
  }
  renderTemplates();

  // ── Save as template
  const saveTplBtn = p.querySelector("#ar-save-tpl");
  if (saveTplBtn) {
    saveTplBtn.onclick = () => {
      const text = promptTa?.value?.trim();
      if (!text) { showToast("⚠ Enter a prompt first"); return; }
      const name = text.slice(0, 20).replace(/[^a-zA-Z0-9 ]/g, "") + (text.length > 20 ? "…" : "");
      saveCustomTemplate(name, text);
      showToast("✓ Saved as template");
      setTimeout(renderTemplates, 300);
    };
  }



  // ── Export tab handlers
  let currentExportAI = 'chatgpt';
  let lastExportText = '';

  function refreshExport() {
    const msgs = scrapeConversation();
    const formatted = formatForExport(msgs, currentExportAI);
    lastExportText = formatted;
    const preview = p.querySelector('#ar-export-preview');
    const msgCount = p.querySelector('#ar-ex-msg-count');
    const tokCount = p.querySelector('#ar-ex-tok-count');
    const warn = p.querySelector('#ar-ex-warn');
    if (preview) preview.value = formatted;
    if (msgCount) msgCount.textContent = msgs.length;
    const tokens = estimateTokens(formatted);
    if (tokCount) tokCount.textContent = tokens.toLocaleString();
    if (warn) {
      if (tokens > 100000) {
        warn.innerHTML = '<span class="es-warn">⚠ Very large</span>';
      } else if (tokens > 30000) {
        warn.innerHTML = '<span class="es-warn">⚠ Large context</span>';
      } else {
        warn.textContent = '';
      }
    }
  }

  // AI chip selection
  p.querySelectorAll('.ar-ai-chip').forEach(chip => {
    chip.onclick = () => {
      p.querySelectorAll('.ar-ai-chip').forEach(c => c.classList.remove('selected'));
      chip.classList.add('selected');
      currentExportAI = chip.dataset.ai;
      refreshExport();
    };
  });

  // Copy button
  const copyBtn = p.querySelector('#ar-export-copy');
  if (copyBtn) {
    copyBtn.onclick = async () => {
      refreshExport();
      if (!lastExportText || lastExportText.includes('No messages found')) {
        showToast('⚠ No messages to export');
        return;
      }
      try {
        await navigator.clipboard.writeText(lastExportText);
        const aiName = EXPORT_TEMPLATES[currentExportAI]?.name || currentExportAI;
        showToast(`✓ Copied for ${aiName}!`);
        copyBtn.textContent = '✓ Copied!';
        setTimeout(() => { copyBtn.textContent = '📋 Copy Context'; }, 2000);
      } catch {
        // Fallback
        const ta = document.createElement('textarea');
        ta.value = lastExportText;
        ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        showToast('✓ Copied to clipboard!');
      }
    };
  }

  // Download button
  const dlBtn = p.querySelector('#ar-export-download');
  if (dlBtn) {
    dlBtn.onclick = () => {
      refreshExport();
      if (!lastExportText || lastExportText.includes('No messages found')) {
        showToast('⚠ No messages to export');
        return;
      }
      const blob = new Blob([lastExportText], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const aiName = EXPORT_TEMPLATES[currentExportAI]?.name || 'export';
      const chatId = location.pathname.split('/').pop()?.slice(0, 8) || 'chat';
      const prefix = getSiteConfig().name.toLowerCase();
      a.download = `${prefix}-${chatId}-for-${aiName.toLowerCase()}.txt`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast('✓ Downloaded!');
    };
  }

  // ── Close
  p.querySelector("#ar-close").onclick = closePanel;
  setTimeout(() => document.addEventListener("click", outsideClickH), 200);

  // ── Grab current URL
  p.querySelector("#ar-grab").onclick = () => {
    p.querySelector("#ar-url").value = location.href;
    showToast("✓ Current chat URL set");
    handlePanelInput();
  };

  // ── Start
  p.querySelector("#ar-start").onclick = () => {
    const url      = p.querySelector("#ar-url").value.trim();
    const prompt   = p.querySelector("#ar-prompt").value.trim();
    const mins     = parseInt(p.querySelector("#ar-mins").value) || 0;
    const interval = parseInt(p.querySelector("#ar-interval").value) || 60;

    const allowed = ["claude.ai", "chatgpt.com", "gemini.google.com", "deepseek.com"];
    const isValid = allowed.some(domain => {
      try {
        const parsed = new URL(url);
        return parsed.hostname.includes(domain) && url.startsWith("https://");
      } catch {
        return false;
      }
    });

    if (!isValid) {
      showToast("⚠ Enter a valid AI chat URL"); return;
    }
    if (!prompt) { showToast("⚠ Enter a resume prompt"); return; }

    safeSet({ savedSettings: { chatUrl: url, prompt, resetMinutes: mins, checkInterval: interval } });
    safeSend({ type: "START_RESUME", data: { chatUrl: url, prompt, resetMinutes: mins, checkInterval: interval } }, () => {
      showToast("✓ Claude Safeguard started!");
      refreshStatus();
      // Switch to status tab
      p.querySelector('[data-tab="status"]').click();
    });
  };

    // ── Stop buttons
    [p.querySelector("#ar-stop"), p.querySelector("#ar-stop2")].forEach(btn => {
      if (btn) btn.onclick = () => {
        safeSend({ type: "STOP_RESUME", chatUrl: location.href }, () => { showToast("Stopped"); refreshStatus(); });
      };
    });

    // ── Load saved settings
    safeGet(["savedSettings", "queues"], d => {
      const sv = d.savedSettings;
      const queues = d.queues || {};
      const currentClean = cleanUrlForComparison(location.href);
      let st = null;
      for (const qUrl in queues) {
        if (cleanUrlForComparison(qUrl) === currentClean) {
          st = queues[qUrl];
          break;
        }
      }
      if (sv) {
        if (sv.chatUrl) p.querySelector("#ar-url").value = sv.chatUrl;
        if (sv.prompt)  {
          p.querySelector("#ar-prompt").value = sv.prompt;
          updatePromptStats();
        }
        if (sv.checkInterval) p.querySelector("#ar-interval").value = sv.checkInterval;
        if (!resetInfo && sv.resetMinutes) p.querySelector("#ar-mins").value = sv.resetMinutes;
      }
      const isChatPage = ["claude.ai", "chatgpt.com", "gemini.google.com", "deepseek.com"].some(d => location.href.includes(d));
      if (!p.querySelector("#ar-url").value && isChatPage) {
        p.querySelector("#ar-url").value = location.href;
        handlePanelInput();
      }
      
      // Auto-detect composer text if prompt is empty and autoCaptureEnabled !== false
      if (autoCaptureEnabled !== false && promptTa && !promptTa.value.trim()) {
        const text = getAIComposerText();
        if (text) {
          promptTa.value = text;
          updatePromptStats();
          handlePanelInput();
        }
      }
      
      if (st) renderUI(st);
    });

  // ── Poll every 4s to refresh status + log
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(() => {
    if (!isCtxValid() || !document.getElementById("ar-panel")) {
      clearInterval(pollInterval); pollInterval = null; return;
    }
    const activeTab = p.querySelector(".ar-tab.active")?.dataset?.tab;
    if (activeTab === "status") refreshStatus();
    if (activeTab === "log")    refreshLog();
    // Refresh auto-detect
    const ri = getResetInfo();
    if (ri && p.querySelector("#ar-start").style.display !== "none") {
      p.querySelector("#ar-mins").value = ri.mins;
    }
  }, 4000);
}

function closePanel() {
  document.getElementById("ar-panel")?.remove();
  document.removeEventListener("click", outsideClickH);
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  panelOpen = false;
}
function outsideClickH(e) {
  const pan = document.getElementById("ar-panel");
  const btn = document.getElementById("ar-btn");
  if (pan && !pan.contains(e.target) && !btn?.contains(e.target)) closePanel();
}

// ── Refresh status tab ────────────────────────────────────────────────
function refreshStatus() {
  safeGet("queues", d => {
    const queues = d?.queues || {};
    const currentClean = cleanUrlForComparison(location.href);
    let st = null;
    for (const qUrl in queues) {
      if (cleanUrlForComparison(qUrl) === currentClean) {
        st = queues[qUrl];
        break;
      }
    }
    if (st) renderUI(st);
  });
}

function refreshLog() {
  safeGet("queues", d => {
    const el = document.getElementById("ar-log");
    if (!el) return;
    const queues = d?.queues || {};
    const currentClean = cleanUrlForComparison(location.href);
    let log = null;
    for (const qUrl in queues) {
      if (cleanUrlForComparison(qUrl) === currentClean) {
        log = queues[qUrl]?.log;
        break;
      }
    }
    if (!log || log.length === 0) { el.textContent = "No log entries yet."; return; }
    el.innerHTML = log.map(line => {
      let cls = "";
      if (line.includes("✓") || line.includes("sent"))   cls = "ok";
      else if (line.includes("Wait") || line.includes("⚠")) cls = "warn";
      else if (line.includes("Check") || line.includes("#")) cls = "info";
      else if (line.includes("✗") || line.includes("fail") || line.includes("Error")) cls = "err";
      return `<span class="ar-log-line ${cls}">${escH(line)}</span>`;
    }).join("\n");
    el.scrollTop = el.scrollHeight;
  });
}

// ── Render UI from state ──────────────────────────────────────────────
function renderUI(state) {
  updateBtn(state);
  updateStatusTab(state);
  updateSetupBtns(state);
}

function updateBtn(state) {
  const btn = document.getElementById("ar-btn");
  if (!btn) return;
  const isFab = btn.classList.contains("ar-fab");
  btn.className = isFab ? "ar-fab" : "";
  if (!state?.active) return;
  const cls = { monitoring:"s-mon", waiting:"s-wait", checking:"s-chk",
                sending:"s-chk", done:"s-done" }[state.status] || "s-mon";
  btn.classList.add(cls);
}

function updateSetupBtns(state) {
  const p = document.getElementById("ar-panel");
  if (!p) return;
  const start  = p.querySelector("#ar-start");
  const stop   = p.querySelector("#ar-stop");
  if (!start || !stop) return;
  if (state?.active && state.status !== "done") {
    start.style.display = "none"; stop.style.display = "block";
  } else {
    start.style.display = "block"; stop.style.display = "none";
  }
}

function updateStatusTab(state) {
  const p = document.getElementById("ar-panel");
  if (!p) return;

  const sc   = p.querySelector("#ar-sc");
  const sct  = p.querySelector("#ar-sc-title");
  const scd  = p.querySelector("#ar-sc-desc");
  const prog = p.querySelector("#ar-prog");
  const pf   = p.querySelector("#ar-pf");
  const pl   = p.querySelector("#ar-pl");
  const stop2 = p.querySelector("#ar-stop2");

  if (!sc || !state) return;

  const clsMap = { monitoring:"s-mon", waiting:"s-wait", checking:"s-chk",
                   sending:"s-chk", done:"s-done", failed:"s-fail" };
  sc.className = `ar-sc ${clsMap[state.status] || ""}`;

  const titles = { monitoring:"Monitoring", waiting:"Waiting for Reset",
                   checking:"Checking", sending:"Sending Prompt",
                   done:"Done!", stopped:"Stopped", failed:"Failed" };
  const descs = {
    monitoring: "Watching for usage limit banner automatically",
    waiting:    `Limit detected — sleeping ${state.resetMinutes ?? 0} min before checking`,
    checking:   "Testing if the limit has cleared...",
    sending:    "Typing and sending your resume prompt",
    done:       "Prompt was sent successfully! Check your chat.",
    stopped:    "Claude Safeguard was stopped manually",
    failed:     "Something went wrong — check the Log tab",
  };

  if (sct) sct.textContent = titles[state.status] || state.status;
  if (scd) scd.textContent = descs[state.status]  || "";

  // Progress bar
  if (prog && pf && pl) {
    if (state.status === "waiting" && state.limitDetectedAt) {
      const elapsed = (Date.now() - state.limitDetectedAt) / 60000;
      const total   = state.resetMinutes ?? 0;
      const pct     = total > 0 ? Math.min(96, (elapsed / total) * 100) : 96;
      const rem     = Math.max(0, total - elapsed);
      prog.style.display = "block";
      pf.style.width = pct + "%";
      pl.textContent = `${Math.ceil(rem)} min until first retry`;
    } else if (state.status === "done") {
      prog.style.display = "block";
      pf.style.width = "100%";
      pl.textContent = "Complete!";
    } else {
      prog.style.display = "none";
    }
  }

  // Task summary
  const tk = {
    status:   p.querySelector("#tk-status"),
    session:  p.querySelector("#tk-session"),
    weekly:   p.querySelector("#tk-weekly"),
    prompt:   p.querySelector("#tk-prompt"),
    url:      p.querySelector("#tk-url"),
    time:     p.querySelector("#tk-time"),
    attempts: p.querySelector("#tk-attempts"),
  };
  const statusColor = { done:"green", waiting:"yellow", monitoring:"green",
                        checking:"muted", failed:"err" };
  if (tk.status) {
    tk.status.textContent = titles[state.status] || "—";
    tk.status.className = `ar-task-val ${statusColor[state.status] || "muted"}`;
  }
  if (tk.prompt)   tk.prompt.textContent   = state.prompt   ? (state.prompt.slice(0,28) + (state.prompt.length>28?"…":"")) : "—";
  if (tk.url)      tk.url.textContent      = state.chatUrl  ? ("…/" + state.chatUrl.split("/").pop().slice(0,12) + "…") : "—";
  if (tk.attempts) tk.attempts.textContent = state.attempts || "0";

  // Live usage info from Claude's UI
  const usage = getUsageInfo();

  if (tk.session) {
    if (usage.session) {
      const pct = usage.session.pct;
      const resetTxt = usage.session.reset ? ` · resets ${usage.session.reset.display}` : "";
      tk.session.textContent = `${pct}%${resetTxt}`;
      tk.session.className = pct >= 100 ? "ar-task-val err" : pct >= 80 ? "ar-task-val yellow" : "ar-task-val green";
    } else {
      tk.session.textContent = "—";
      tk.session.className = "ar-task-val muted";
    }
  }

  if (tk.weekly) {
    if (usage.weekly) {
      const pct = usage.weekly.pct;
      const resetTxt = usage.weekly.reset ? ` · resets ${usage.weekly.reset.display}` : "";
      tk.weekly.textContent = `${pct}%${resetTxt}`;
      tk.weekly.className = pct >= 80 ? "ar-task-val yellow" : "ar-task-val muted";
    } else {
      tk.weekly.textContent = "—";
      tk.weekly.className = "ar-task-val muted";
    }
  }

  // Session reset time (used for Claude Safeguard countdown)
  const ri = getResetInfo();
  if (tk.time) {
    if (ri) {
      tk.time.textContent  = `${ri.display} (${ri.source})`;
      tk.time.className    = "ar-task-val yellow";
    } else if (state.status === "done") {
      tk.time.textContent = "Reset!";
      tk.time.className   = "ar-task-val green";
    } else {
      tk.time.textContent = "—";
      tk.time.className   = "ar-task-val muted";
    }
  }

  if (stop2) stop2.style.display = (state.active && state.status !== "done") ? "block" : "none";
}

// ── Toast ─────────────────────────────────────────────────────────────
function showToast(msg) {
  let t = document.getElementById("ar-toast");
  if (!t) { t = document.createElement("div"); t.id = "ar-toast"; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2200);
}

function escH(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function escHtml(s) {
  return escH(s);
}



let keepAlivePort = null;
function maintainKeepAlivePort(isActive) {
  if (isActive) {
    if (!keepAlivePort && isCtxValid()) {
      try {
        keepAlivePort = chrome.runtime.connect({ name: "safeguard-keepalive" });
        keepAlivePort.onDisconnect.addListener(() => {
          keepAlivePort = null;
          setTimeout(() => {
            safeGet("queues", d => {
              const queues = d?.queues || {};
              const s = queues[location.href];
              if (s?.active) maintainKeepAlivePort(true);
            });
          }, 5000);
        });
      } catch {}
    }
  } else {
    if (keepAlivePort) {
      try { keepAlivePort.disconnect(); } catch {}
      keepAlivePort = null;
    }
  }
}

let fastCheckInterval = null;

function startFastPolling(state) {
  if (fastCheckInterval) clearInterval(fastCheckInterval);
  if (!state || !state.active || state.status === "done" || state.status === "failed") {
    maintainKeepAlivePort(false);
    return;
  }

  maintainKeepAlivePort(true);

  fastCheckInterval = setInterval(() => {
    if (!isCtxValid()) {
      clearInterval(fastCheckInterval);
      maintainKeepAlivePort(false);
      return;
    }
    
    safeGet("queues", d => {
      const queues = d?.queues || {};
      const currentClean = cleanUrlForComparison(location.href);
      let s = null;
      for (const qUrl in queues) {
        if (cleanUrlForComparison(qUrl) === currentClean) {
          s = queues[qUrl];
          break;
        }
      }
      if (!s || !s.active || s.status === "done" || s.status === "failed") {
        clearInterval(fastCheckInterval);
        maintainKeepAlivePort(false);
        return;
      }
      
      if (s.status === "checking" || s.status === "monitoring" || s.status === "waiting") {
        if (canSend()) {
          clearInterval(fastCheckInterval);
          maintainKeepAlivePort(false);
          executeLocalSend(s);
        }
      }
    });
  }, 800);
}

function executeLocalSend(state) {
  safeSend({ type: "LOCAL_SEND_START" });
  
  doSend(state.prompt).then(result => {
    if (result && result.sent) {
      safeSend({ type: "LOCAL_SEND_SUCCESS", method: result.method });
    } else {
      safeSend({ type: "LOCAL_SEND_FAILED", reason: result ? result.reason : "unknown" });
      setTimeout(() => {
        safeGet("queues", d => {
          const queues = d?.queues || {};
          const currentClean = cleanUrlForComparison(location.href);
          let s = null;
          for (const qUrl in queues) {
            if (cleanUrlForComparison(qUrl) === currentClean) {
              s = queues[qUrl];
              break;
            }
          }
          if (s) startFastPolling(s);
        });
      }, 5000);
    }
  });
}

function getUsageBarAnchor() {
  const input = getInput();
  if (!input) return null;
  
  let anchor = input.parentElement;
  while (anchor && anchor !== document.body) {
    if (anchor.tagName === 'FORM') return anchor;
    if (anchor.classList.contains('bg-background') || 
        anchor.querySelector('button[aria-label="Send message"]') ||
        anchor.querySelector('button[data-testid="send-button"]')) {
      return anchor;
    }
    anchor = anchor.parentElement;
  }
  return input.parentElement;
}

function updateUsageBarOnPage() {
  if (!isCtxValid()) return;
  const config = getSiteConfig();
  if (config.name !== "Claude") {
    document.getElementById("ar-page-usage-bar")?.remove();
    return;
  }
  const anchor = getUsageBarAnchor();
  if (!anchor) {
    document.getElementById("ar-page-usage-bar")?.remove();
    return;
  }
  
  let bar = document.getElementById("ar-page-usage-bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "ar-page-usage-bar";
    bar.className = "ar-page-usage-bar";
    bar.innerHTML = `
      <div class="ar-pub-row">
        <div class="ar-pub-col">
          <div class="ar-pub-meta">
            <span class="ar-pub-label">Session:</span>
            <span class="ar-pub-pct" id="ar-pub-session-pct">—</span>
            <span class="ar-pub-reset" id="ar-pub-session-reset"></span>
          </div>
          <div class="ar-pub-progress-bg">
            <div class="ar-pub-progress-fill" id="ar-pub-session-fill" style="width: 0%"></div>
          </div>
        </div>
        <div class="ar-pub-col">
          <div class="ar-pub-meta">
            <span class="ar-pub-label">Weekly:</span>
            <span class="ar-pub-pct" id="ar-pub-weekly-pct">—</span>
            <span class="ar-pub-reset" id="ar-pub-weekly-reset"></span>
          </div>
          <div class="ar-pub-progress-bg">
            <div class="ar-pub-progress-fill" id="ar-pub-weekly-fill" style="width: 0%"></div>
          </div>
        </div>
      </div>
    `;
    anchor.parentNode.insertBefore(bar, anchor.nextSibling);
  }
  
  const info = getUsageInfo();
  
  const sessPct = document.getElementById("ar-pub-session-pct");
  const sessReset = document.getElementById("ar-pub-session-reset");
  const sessFill = document.getElementById("ar-pub-session-fill");
  
  const weekPct = document.getElementById("ar-pub-weekly-pct");
  const weekReset = document.getElementById("ar-pub-weekly-reset");
  const weekFill = document.getElementById("ar-pub-weekly-fill");
  
  if (sessPct && sessReset && sessFill) {
    if (info.session) {
      const pct = info.session.pct;
      sessPct.textContent = `${pct}%`;
      sessFill.style.width = `${pct}%`;
      sessFill.className = "ar-pub-progress-fill " + (pct >= 100 ? "ar-pub-fill-red" : pct >= 80 ? "ar-pub-fill-yellow" : "ar-pub-fill-green");
      if (info.session.reset) {
        sessReset.textContent = `· resets in ${info.session.reset.display}`;
      } else {
        sessReset.textContent = "";
      }
    } else {
      sessPct.textContent = "—";
      sessFill.style.width = "0%";
      sessReset.textContent = "";
    }
  }
  
  if (weekPct && weekReset && weekFill) {
    if (info.weekly) {
      const pct = info.weekly.pct;
      weekPct.textContent = `${pct}%`;
      weekFill.style.width = `${pct}%`;
      weekFill.className = "ar-pub-progress-fill " + (pct >= 100 ? "ar-pub-fill-red" : pct >= 80 ? "ar-pub-fill-yellow" : "ar-pub-fill-blue");
      if (info.weekly.reset) {
        weekReset.textContent = `· resets in ${info.weekly.reset.display}`;
      } else {
        weekReset.textContent = "";
      }
    } else {
      weekPct.textContent = "—";
      weekFill.style.width = "0%";
      weekReset.textContent = "";
    }
  }
}

// ── MutationObserver ──────────────────────────────────────────────────
let dbT = null;
const mutObs = new MutationObserver(() => {
  if (!isCtxValid()) { mutObs.disconnect(); selfDestruct(); return; }
  clearTimeout(dbT);
  dbT = setTimeout(() => {
    if (!isCtxValid()) { selfDestruct(); return; }
    if (isLimitActive()) {
      const ri = getResetInfo();
      safeSend({ type: "LIMIT_DETECTED", resetMinutes: ri ? ri.mins : 0 });
    }
    // Update local chat cache
    updateLocalChatCache();
    // Update native usage bar
    updateUsageBarOnPage();
  }, 900);


});
try { mutObs.observe(document.body, { childList: true, subtree: true }); } catch {}

let lastCheckedUrl = "";

function stopFastPollingLocal() {
  if (fastCheckInterval) {
    clearInterval(fastCheckInterval);
    fastCheckInterval = null;
  }
}

function resetUiToDefault() {
  updateBtn(null);
  updateSetupBtns(null);
  const p = document.getElementById("ar-panel");
  if (p) {
    const sct  = p.querySelector("#ar-sc-title");
    const scd  = p.querySelector("#ar-sc-desc");
    const sc   = p.querySelector("#ar-sc");
    if (sct) sct.textContent = "Idle";
    if (scd) scd.textContent = "No active queue session on this chat thread.";
    if (sc) sc.className = "ar-sc";
    
    const prog = p.querySelector("#ar-prog");
    if (prog) prog.style.display = "none";
    
    const stop2 = p.querySelector("#ar-stop2");
    if (stop2) stop2.style.display = "none";
  }
}

function handleUrlChange(url) {
  if (!isCtxValid()) return;
  
  const urlInput = document.querySelector("#ar-url");
  if (urlInput) {
    urlInput.value = url;
    const promptTa = document.querySelector("#ar-prompt");
    const minsInp = document.querySelector("#ar-mins");
    const intInp = document.querySelector("#ar-interval");
    const pr = promptTa ? promptTa.value : "";
    const mi = minsInp ? parseInt(minsInp.value) || 0 : 0;
    const it = intInp ? parseInt(intInp.value) || 60 : 60;
    autoSaveDraft(pr, url, mi, it);
  }

  safeGet("queues", d => {
    const queues = d?.queues || {};
    const currentClean = cleanUrlForComparison(url);
    
    let matchedState = null;
    for (const qUrl in queues) {
      if (cleanUrlForComparison(qUrl) === currentClean) {
        matchedState = queues[qUrl];
        break;
      }
    }

    if (matchedState) {
      renderUI(matchedState);
      if (matchedState.active) {
        startFastPolling(matchedState);
        maintainKeepAlivePort(true);
      } else {
        stopFastPollingLocal();
        maintainKeepAlivePort(false);
      }
    } else {
      resetUiToDefault();
      stopFastPollingLocal();
      maintainKeepAlivePort(false);
    }
  });
}

// ── Boot ──────────────────────────────────────────────────────────────
function boot() {
  injectStyles();
  setupRecycleBinListeners();

  // Start periodic check for button presence to handle SPA navigations reliably
  clearInterval(btnCheckInterval);
  btnCheckInterval = setInterval(() => {
    if (!isCtxValid()) { clearInterval(btnCheckInterval); return; }
    
    injectRecycleBinIntoSidebar();
    
    const currentUrl = location.href;
    if (currentUrl !== lastCheckedUrl) {
      lastCheckedUrl = currentUrl;
      handleUrlChange(currentUrl);
    }

    if (!shouldShowBtn()) {
      document.getElementById("ar-btn")?.remove();
      closePanel();
    } else {
      const ex = document.getElementById("ar-btn");
      if (!ex || !ex.isConnected) {
        if (ex) ex.remove();
        injectBtn();
      } else if (ex.classList.contains("ar-fab")) {
        // It's currently in fallback FAB mode. Check if the header has loaded now!
        if (hasHeaderAnchor()) {
          ex.remove();
          injectBtn(); // Upgrade it to header injection!
        }
      }
    }
  }, 2000);

  // Periodic usage checks
  clearInterval(usageFetchInterval);
  runPeriodicUsageFetch();
  usageFetchInterval = setInterval(runPeriodicUsageFetch, 30000);

  if (shouldShowBtn()) {
    injectBtn();
  }
  
  // Instant URL initialization
  lastCheckedUrl = location.href;
  handleUrlChange(lastCheckedUrl);
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
