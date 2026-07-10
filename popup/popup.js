// ChatQueue AI — Popup Script

const $ = id => document.getElementById(id);

// ── Tab switching ─────────────────────────────────────────────────────
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    $(`tab-${tab.dataset.tab}`).classList.add("active");
    if (tab.dataset.tab === "status") renderStatus();
    if (tab.dataset.tab === "analytics") renderAnalytics();
    if (tab.dataset.tab === "trash") renderTrash();
    if (tab.dataset.tab === "archive") renderArchive();
    if (tab.dataset.tab === "settings") renderSettings();
  });
});

const ALLOWED_DOMAINS = ["claude.ai", "chatgpt.com", "gemini.google.com", "deepseek.com"];

function getDomainName(url) {
  try {
    const hostname = new URL(url).hostname;
    if (hostname.includes("claude.ai")) return "Claude";
    if (hostname.includes("chatgpt.com")) return "ChatGPT";
    if (hostname.includes("gemini.google.com")) return "Gemini";
    if (hostname.includes("deepseek.com")) return "DeepSeek";
  } catch {}
  return "";
}

function cleanUrlForComparison(urlStr) {
  try {
    const u = new URL(urlStr);
    let path = u.pathname.replace(/\/$/, "").toLowerCase();
    return u.hostname.toLowerCase() + path;
  } catch {
    return urlStr ? urlStr.toLowerCase() : "";
  }
}

// ── Use current tab button ────────────────────────────────────────────
$("btnCurrentTab").addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs[0];
    if (tab && tab.url) {
      const name = getDomainName(tab.url);
      if (name) {
        $("chatUrl").value = tab.url;
        updatePlatformBadge();
        saveDraft();
        toast(`✓ ${name} URL captured`);
        return;
      }
    }
    toast("Open a supported AI chat first");
  });
});

// ── Start ─────────────────────────────────────────────────────────────
$("btnStart").addEventListener("click", () => {
  const chatUrl      = $("chatUrl").value.trim();
  const prompt       = $("prompt").value.trim();
  const resetMinutes = parseInt($("resetMinutes").value) || 0;
  const checkInterval = parseInt($("checkInterval").value) || 60;

  const isValid = ALLOWED_DOMAINS.some(domain => {
    try {
      const parsed = new URL(chatUrl);
      return parsed.hostname.includes(domain) && chatUrl.startsWith("https://");
    } catch {
      return false;
    }
  });

  if (!isValid) {
    toast("⚠ Enter a valid AI chat URL"); return;
  }
  if (!prompt) {
    toast("⚠ Enter a resume prompt"); return;
  }

  // Save settings for persistence
  chrome.storage.local.set({ savedSettings: { chatUrl, prompt, resetMinutes, checkInterval } });

  // Add to prompt history
  chrome.storage.local.get("promptHistory", d => {
    let history = d.promptHistory || [];
    const domain = getDomainName(chatUrl);
    history = history.filter(h => h.prompt !== prompt);
    history.unshift({ prompt, timestamp: Date.now(), domain });
    if (history.length > 15) history.pop();
    chrome.storage.local.set({ promptHistory: history });
  });

  chrome.runtime.sendMessage({
    type: "START_RESUME",
    data: { chatUrl, prompt, resetMinutes, checkInterval }
  }, () => {
    toast("✓ ChatQueue AI started!");
    updateUI();
    // Switch to status tab
    setTimeout(() => {
      document.querySelector('[data-tab="status"]').click();
    }, 600);
  });
});

// ── Stop ──────────────────────────────────────────────────────────────
$("btnStop").addEventListener("click", () => {
  const chatUrl = $("chatUrl").value.trim();
  chrome.runtime.sendMessage({ type: "STOP_RESUME", chatUrl }, () => {
    toast("Stopped");
    updateUI();
  });
});

// ── Render status tab ─────────────────────────────────────────────────
function renderStatus() {
  const container = $("statusUsageContainer");
  if (container) container.style.display = "none";

  chrome.runtime.sendMessage({ type: "GET_STATUS" }, resp => {
    const queues = resp?.queues || {};
    const el = $("queueList");
    if (!el) return;

    const queueList = Object.values(queues);
    if (queueList.length === 0) {
      el.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🕒</div>
          <div class="empty-text">No active queues.<br>Go to Setup and click Start.</div>
        </div>`;
      return;
    }

    // Sort queueList: active first, then by startedAt descending
    queueList.sort((a, b) => {
      if (a.active && !b.active) return -1;
      if (!a.active && b.active) return 1;
      return (b.startedAt || 0) - (a.startedAt || 0);
    });

    let html = "";
    queueList.forEach(q => {
      const statusChip = {
        monitoring: `<span class="chip green">● Monitoring</span>`,
        waiting:    `<span class="chip yellow">● Waiting</span>`,
        checking:   `<span class="chip blue">● Checking</span>`,
        sending:    `<span class="chip blue">● Sending</span>`,
        done:       `<span class="chip green">✓ Done</span>`,
        failed:     `<span class="chip red">✗ Failed</span>`,
        stopped:    `<span class="chip gray">■ Stopped</span>`,
      }[q.status] || `<span class="chip gray">${q.status}</span>`;

      // Progress calculation
      let progress = 0;
      let progressLabel = "";
      if (q.limitDetectedAt && q.status === "waiting") {
        const elapsed = (Date.now() - q.limitDetectedAt) / 60000;
        progress = q.resetMinutes > 0
          ? Math.min(95, (elapsed / q.resetMinutes) * 100)
          : 95;
        const remaining = Math.max(0, q.resetMinutes - elapsed);
        progressLabel = `${Math.ceil(remaining)} min remaining`;
      } else if (q.status === "done") {
        progress = 100;
        progressLabel = "Complete";
      } else if (q.status === "monitoring") {
        progressLabel = "Watching for usage limit...";
      } else if (q.status === "checking") {
        progressLabel = "Checking if limit has reset...";
      }

      // Platform badge
      const platformName = getDomainName(q.chatUrl);
      let platformBadge = `<span class="chip gray">${platformName || "AI"}</span>`;
      if (platformName === "Claude") {
        platformBadge = `<span class="chip" style="background: rgba(249, 115, 22, 0.1); border: 1px solid rgba(249, 115, 22, 0.3); color: #f97316;">🟠 Claude</span>`;
      } else if (platformName === "ChatGPT") {
        platformBadge = `<span class="chip" style="background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.3); color: #10b981;">🟢 ChatGPT</span>`;
      } else if (platformName === "Gemini") {
        platformBadge = `<span class="chip" style="background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.3); color: #3b82f6;">🔵 Gemini</span>`;
      } else if (platformName === "DeepSeek") {
        platformBadge = `<span class="chip" style="background: rgba(139, 92, 246, 0.1); border: 1px solid rgba(139, 92, 246, 0.3); color: #8b5cf6;">🟣 DeepSeek</span>`;
      }

      // Chat URL display
      const urlShort = q.chatUrl
        ? ".../" + q.chatUrl.split("/").pop().slice(0, 20) + "..."
        : "—";

      // Elapsed time
      const elapsedMin = q.startedAt
        ? Math.floor((Date.now() - q.startedAt) / 60000)
        : 0;
      const runningTime = elapsedMin < 60 ? elapsedMin + " min" : Math.floor(elapsedMin/60) + "h " + (elapsedMin%60) + "m";

      html += `
        <div class="status-card" style="border-left: 3px solid ${q.active ? 'var(--accent)' : 'var(--border)'}; margin-bottom: 16px;">
          <div class="status-row">
            ${platformBadge}
            ${statusChip}
          </div>
          <div class="status-row" style="margin-top: 8px;">
            <span class="status-label">Chat</span>
            <span class="status-value" title="${q.chatUrl}"><a href="${q.chatUrl}" target="_blank" style="color: var(--blue); text-decoration: none;">${urlShort}</a></span>
          </div>
          <div class="status-row">
            <span class="status-label">Attempts</span>
            <span class="status-value">${q.attempts || 0}</span>
          </div>
          <div class="status-row">
            <span class="status-label">Running for</span>
            <span class="status-value">${runningTime}</span>
          </div>
          ${progressLabel ? `
          <div class="progress-bar" style="margin-top:8px">
            <div class="progress-fill" style="width:${progress}%"></div>
          </div>
          <div style="font-size:10px;color:var(--muted);margin-top:4px;font-family:'DM Mono',monospace;display:flex;justify-content:space-between;">
            <span>${progressLabel}</span>
          </div>` : ""}
          <div style="margin-top:10px; border-top: 1px solid var(--border); padding-top: 8px;">
            <div class="status-label" style="margin-bottom:4px">Prompt</div>
            <div style="font-size:11px;color:var(--muted);max-height:48px;overflow-y:auto;word-break:break-all;font-family:var(--font-mono);line-height:1.4;">
              ${escHtml(q.prompt || "—")}
            </div>
          </div>
          
          <div class="queue-card-actions" style="display: flex; gap: 6px; margin-top: 12px;">
            ${q.active ? `
              <button class="btn-ghost btn-focus-tab" data-url="${escHtml(q.chatUrl)}" style="padding: 6px; font-size: 10.5px; flex: 1;">🔍 Focus</button>
              <button class="btn-ghost btn-force-send" data-url="${escHtml(q.chatUrl)}" style="padding: 6px; font-size: 10.5px; flex: 1; color: var(--accent);">⚡ Force</button>
              <button class="btn-ghost btn-reload-tab" data-url="${escHtml(q.chatUrl)}" style="padding: 6px; font-size: 10.5px; flex: 1;">🔄 Reload</button>
              <button class="btn-stop btn-stop-queue" data-url="${escHtml(q.chatUrl)}" style="margin-top: 0; padding: 6px; font-size: 10.5px; flex: 1;">■ Stop</button>
            ` : `
              <button class="btn-ghost btn-focus-tab" data-url="${escHtml(q.chatUrl)}" style="padding: 6px; font-size: 10.5px; flex: 1;">🔍 Open Chat</button>
              <button class="btn-ghost btn-remove-queue" data-url="${escHtml(q.chatUrl)}" style="padding: 6px; font-size: 10.5px; flex: 1; text-align: center;">🗑 Remove</button>
            `}
          </div>
          
          <div class="queue-card-log-trigger" data-url="${escHtml(q.chatUrl)}">Show Log Preview ▾</div>
          <div class="queue-card-log-preview" style="display: none;">
            ${(q.log && q.log.length > 0) ? q.log.slice(-3).map(line => `<div style="margin-bottom: 2px;">${escHtml(line)}</div>`).join("") : "No log entries yet."}
          </div>
        </div>
      `;
    });

    el.innerHTML = html;

    // Attach listeners
    el.querySelectorAll(".btn-stop-queue").forEach(btn => {
      btn.onclick = () => {
        const url = btn.dataset.url;
        chrome.runtime.sendMessage({ type: "STOP_RESUME", chatUrl: url }, () => {
          toast("✓ Queue stopped");
          updateUI();
          renderStatus();
        });
      };
    });

    el.querySelectorAll(".btn-remove-queue").forEach(btn => {
      btn.onclick = () => {
        const url = btn.dataset.url;
        chrome.storage.local.get("queues", d => {
          const queues = d.queues || {};
          delete queues[url];
          chrome.storage.local.set({ queues }, () => {
            toast("✓ Queue removed from history");
            updateUI();
            renderStatus();
          });
        });
      };
    });

    el.querySelectorAll(".btn-focus-tab").forEach(btn => {
      btn.onclick = () => {
        const url = btn.dataset.url;
        chrome.tabs.query({}, tabs => {
          const cleanTarget = cleanUrlForComparison(url);
          const exact = tabs.find(t => t.url && cleanUrlForComparison(t.url) === cleanTarget);
          if (exact) {
            chrome.tabs.update(exact.id, { active: true }, () => {
              if (exact.windowId) chrome.windows.update(exact.windowId, { focused: true });
            });
          } else {
            toast("Opening chat tab...");
            chrome.tabs.create({ url });
          }
        });
      };
    });

    el.querySelectorAll(".btn-force-send").forEach(btn => {
      btn.onclick = () => {
        const url = btn.dataset.url;
        chrome.runtime.sendMessage({ type: "FORCE_SEND", chatUrl: url }, () => {
          toast("✓ Force send triggered!");
          updateUI();
          renderStatus();
        });
      };
    });

    el.querySelectorAll(".btn-reload-tab").forEach(btn => {
      btn.onclick = () => {
        const url = btn.dataset.url;
        chrome.runtime.sendMessage({ type: "RELOAD_QUEUE_TAB", chatUrl: url }, () => {
          toast("✓ Tab reload triggered");
          updateUI();
          renderStatus();
        });
      };
    });

    el.querySelectorAll(".queue-card-log-trigger").forEach(trigger => {
      trigger.onclick = () => {
        const preview = trigger.nextElementSibling;
        if (preview && preview.classList.contains("queue-card-log-preview")) {
          const isHidden = window.getComputedStyle(preview).display === "none";
          preview.style.display = isHidden ? "block" : "none";
          trigger.textContent = isHidden ? "Hide Log Preview ▴" : "Show Log Preview ▾";
        }
      };
    });

    // Fetch live usage from the active tab if it matches
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      let tab = tabs && tabs[0];
      if (tab && tab.url && ALLOWED_DOMAINS.some(d => tab.url.includes(d))) {
        fetchUsage(tab.id);
      }
    });

    function fetchUsage(tabId) {
      chrome.tabs.sendMessage(tabId, { type: "GET_USAGE_INFO" }, usage => {
        if (chrome.runtime.lastError || !usage) return;

        const sessionEl = $("statusSession");
        const weeklyEl  = $("statusWeekly");
        const usageCont = $("statusUsageContainer");

        if (usageCont) usageCont.style.display = "block";

        if (sessionEl && usage.session) {
          const pct = usage.session.pct;
          let color = "var(--green)";
          if (pct >= 100) color = "var(--red)";
          else if (pct >= 80) color = "var(--yellow)";
          const resetTxt = usage.session.reset ? ` · resets in ${usage.session.reset.display}` : "";
          sessionEl.innerHTML = `<span style="color:${color};font-weight:500">${pct}%</span>${resetTxt}`;
        }

        if (weeklyEl && usage.weekly) {
          const pct = usage.weekly.pct;
          let color = "var(--muted)";
          if (pct >= 80) color = "var(--yellow)";
          const resetTxt = usage.weekly.reset ? ` · resets in ${usage.weekly.reset.display}` : "";
          weeklyEl.innerHTML = `<span style="color:${color};font-weight:500">${pct}%</span>${resetTxt}`;
        }
      });
    }
  });
}

const EXPORT_TEMPLATES = {
  chatgpt: {
    name: 'ChatGPT', color: '#10a37f', icon: '🟢',
    wrap: (conv) => `I'm continuing a conversation from Claude AI. Here is the full conversation history so you have complete context:\n\n${conv}\n\nPlease continue from where the last response ended. Maintain the same context, coding style, and approach. Pick up the next task naturally.`
  },
  gemini: {
    name: 'Gemini', color: '#4285f4', icon: '🔵',
    wrap: (conv) => `I need to continue work from a previous session on Claude AI. Below is the complete conversation for context:\n\n${conv}\n\nPlease pick up from the last response and continue the work seamlessly. Keep the same approach and style.`
  },
  claude: {
    name: 'Claude', color: '#d97706', icon: '🟠',
    wrap: (conv) => `Here is a conversation from a previous Claude session that I need to continue:\n\n${conv}\n\nPlease continue from where we left off, maintaining the same approach and context.`
  },
  deepseek: {
    name: 'DeepSeek', color: '#6366f1', icon: '🟣',
    wrap: (conv) => `I'm transferring context from a Claude AI conversation. Here is the full discussion for you to continue from:\n\n${conv}\n\nPlease continue the work from where the last response ended. Maintain the same style and approach.`
  },
  custom: {
    name: 'Raw', color: '#8b8ba0', icon: '📄',
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

// ── Render Recycle Bin tab ────────────────────────────────────────────
function cleanRecycleBinRetention(bin) {
  if (!Array.isArray(bin)) return [];
  const now = Date.now();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  let cleanBin = bin.filter(item => {
    const deletedAt = item.deletedAt || now;
    return (now - deletedAt) < thirtyDaysMs;
  });
  if (cleanBin.length > 200) {
    cleanBin = cleanBin.slice(0, 200);
  }
  return cleanBin;
}

function renderTrash() {
  chrome.storage.local.get("recycleBin", d => {
    let bin = d.recycleBin || [];
    const cleaned = cleanRecycleBinRetention(bin);
    if (cleaned.length !== bin.length) {
      bin = cleaned;
      chrome.storage.local.set({ recycleBin: cleaned });
    }

    const list = $("trashList");
    if (!list) return;

    if (bin.length === 0) {
      list.innerHTML = `
        <div class="empty-state" style="padding: 24px 10px;">
          <div class="empty-icon">🗑</div>
          <div class="empty-text">Recycle Bin is empty.</div>
        </div>
      `;
      return;
    }

    const now = Date.now();
    list.innerHTML = bin.map((item, idx) => {
      const deletedAt = item.deletedAt || now;
      const msRemaining = (30 * 24 * 60 * 60 * 1000) - (now - deletedAt);
      const daysRemaining = Math.max(1, Math.ceil(msRemaining / (24 * 60 * 60 * 1000)));
      const expiryText = `Expires in ${daysRemaining} day${daysRemaining > 1 ? "s" : ""}`;
      const date = new Date(deletedAt).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      
      return `
        <div class="history-item" style="padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; align-items: stretch; margin-bottom: 4px;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <div style="font-weight: 600; font-size: 12px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 190px;" title="${escHtml(item.title)}">${escHtml(item.title)}</div>
            <span style="font-size: 8px; color: var(--muted);">${date}</span>
          </div>
          <div style="font-size: 10px; color: var(--muted); display: flex; justify-content: space-between; align-items: center;">
            <span>${item.messages.length} messages • <span style="color:var(--accent); font-weight:500;">${expiryText}</span></span>
            <div style="display: flex; gap: 6px;">
              <button class="btn-ghost btn-view-trash" data-idx="${idx}" style="padding: 2px 6px; font-size: 9px; height: 18px;">👁 View</button>
              <button class="btn-ghost btn-restore-trash" data-idx="${idx}" style="padding: 2px 6px; font-size: 9px; height: 18px; color: var(--accent);">📥 Restore</button>
              <button class="btn-ghost btn-delete-trash" data-idx="${idx}" style="padding: 2px 6px; font-size: 9px; height: 18px; color: var(--red);">✕</button>
            </div>
          </div>
        </div>
      `;
    }).join("");

    // Bind listeners
    list.querySelectorAll(".btn-view-trash").forEach(btn => {
      btn.onclick = () => {
        const idx = parseInt(btn.dataset.idx);
        const item = bin[idx];
        if (item) {
          activePreviewChat = item;
          $("previewModalTitle").textContent = item.title;
          renderPreviewMessages(item.messages);
          $("previewModal").style.display = "flex";
        }
      };
    });

    list.querySelectorAll(".btn-restore-trash").forEach(btn => {
      btn.onclick = () => {
        const idx = parseInt(btn.dataset.idx);
        const item = bin[idx];
        if (item) {
          const markdown = formatForExport(item.messages, 'custom');
          navigator.clipboard.writeText(markdown).then(() => {
            toast("✓ History copied to clipboard!");
            chrome.tabs.create({ url: "https://claude.ai/chat/" });
          });
        }
      };
    });

    list.querySelectorAll(".btn-delete-trash").forEach(btn => {
      btn.onclick = () => {
        const idx = parseInt(btn.dataset.idx);
        chrome.storage.local.get("recycleBin", data => {
          const binList = data.recycleBin || [];
          binList.splice(idx, 1);
          chrome.storage.local.set({ recycleBin: binList }, () => {
            toast("🗑 Chat permanently deleted");
            renderTrash();
          });
        });
      };
    });
  });
}

let archiveChats = [];

function renderArchive() {
  chrome.storage.local.get(["chatCache", "recycleBin"], d => {
    const cache = d.chatCache || {};
    const bin = d.recycleBin || [];
    const list = $("archiveChatList");
    if (!list) return;

    const activeChats = Object.keys(cache)
      .filter(uuid => cache[uuid])
      .map(uuid => ({
        ...cache[uuid],
        status: "Active"
      }));

    const deletedChats = bin
      .filter(item => item)
      .map(item => ({
        ...item,
        status: "Deleted"
      }));

    archiveChats = [...activeChats, ...deletedChats].sort((a, b) => {
      const timeA = a.deletedAt || a.lastUpdated || 0;
      const timeB = b.deletedAt || b.lastUpdated || 0;
      return timeB - timeA;
    });

    filterAndRenderArchiveList();
  });
}

function filterAndRenderArchiveList() {
  const list = $("archiveChatList");
  const query = $("archiveSearch")?.value.trim().toLowerCase() || "";
  
  const filtered = archiveChats.filter(chat => {
    return (chat.title || "").toLowerCase().includes(query);
  });

  if (filtered.length === 0) {
    list.innerHTML = `
      <div class="empty-state" style="padding: 24px 10px;">
        <div class="empty-icon">📦</div>
        <div class="empty-text">No conversations found.</div>
      </div>
    `;
    return;
  }

  list.innerHTML = filtered.map((chat, idx) => {
    const time = chat.deletedAt || chat.lastUpdated || Date.now();
    const isDeleted = chat.status === "Deleted";
    
    let dateLabel = new Date(time).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    if (isDeleted) {
      const msRemaining = (30 * 24 * 60 * 60 * 1000) - (Date.now() - time);
      const daysRemaining = Math.max(1, Math.ceil(msRemaining / (24 * 60 * 60 * 1000)));
      dateLabel = `${dateLabel} (${daysRemaining}d left)`;
    }

    const statusColor = isDeleted ? "var(--red)" : "var(--green)";
    const statusBg = isDeleted ? "rgba(239, 68, 68, 0.1)" : "rgba(16, 185, 129, 0.1)";
    const statusBorder = isDeleted ? "rgba(239, 68, 68, 0.2)" : "rgba(16, 185, 129, 0.2)";
    const uid = chat.uuid;

    return `
      <div class="history-item" style="padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; align-items: stretch; margin-bottom: 4px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <div style="font-weight: 600; font-size: 11.5px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 170px;" title="${escHtml(chat.title)}">${escHtml(chat.title || "Untitled Chat")}</div>
          <span style="font-size: 9px; font-weight: 600; padding: 1px 5px; border-radius: 4px; color: ${statusColor}; background: ${statusBg}; border: 1px solid ${statusBorder};">${chat.status}</span>
        </div>
        <div style="font-size: 10px; color: var(--muted); display: flex; justify-content: space-between; align-items: center;">
          <span>${chat.messages ? chat.messages.length : 0} messages • ${dateLabel}</span>
          <div style="display: flex; gap: 4px;">
            <button class="btn-ghost btn-arch-view" data-uid="${uid}" style="padding: 2px 4px; font-size: 9px; height: 18px; min-width: 28px;">👁</button>
            <button class="btn-ghost btn-arch-md" data-uid="${uid}" style="padding: 2px 4px; font-size: 9px; height: 18px; min-width: 28px;" title="Markdown">MD</button>
            <button class="btn-ghost btn-arch-doc" data-uid="${uid}" style="padding: 2px 4px; font-size: 9px; height: 18px; min-width: 28px;" title="Word">Doc</button>
            <button class="btn-ghost btn-arch-pdf" data-uid="${uid}" style="padding: 2px 4px; font-size: 9px; height: 18px; min-width: 28px;" title="PDF">PDF</button>
            <button class="btn-ghost btn-arch-json" data-uid="${uid}" style="padding: 2px 4px; font-size: 9px; height: 18px; min-width: 28px;" title="JSON">JSON</button>
          </div>
        </div>
      </div>
    `;
  }).join("");

  // Bind View listener
  list.querySelectorAll(".btn-arch-view").forEach(btn => {
    btn.onclick = () => {
      const uid = btn.dataset.uid;
      const chat = archiveChats.find(c => c.uuid === uid);
      if (chat) {
        activePreviewChat = chat;
        $("previewModalTitle").textContent = chat.title || "Untitled Chat";
        renderPreviewMessages(chat.messages);
        $("previewModal").style.display = "flex";
      }
    };
  });

  // Bind MD download listener
  list.querySelectorAll(".btn-arch-md").forEach(btn => {
    btn.onclick = () => {
      const uid = btn.dataset.uid;
      const chat = archiveChats.find(c => c.uuid === uid);
      if (chat) {
        const markdown = formatForExport(chat.messages, 'custom');
        downloadFile(markdown, `${(chat.title || "Untitled").replace(/[^a-zA-Z0-9]/g, "_")}.md`, 'text/markdown');
        toast("✓ Downloaded Markdown!");
      }
    };
  });

  // Bind Word document download listener
  list.querySelectorAll(".btn-arch-doc").forEach(btn => {
    btn.onclick = () => {
      const uid = btn.dataset.uid;
      const chat = archiveChats.find(c => c.uuid === uid);
      if (chat) {
        const docHtml = generateWordHtml(chat);
        downloadFile(docHtml, `${(chat.title || "Untitled").replace(/[^a-zA-Z0-9]/g, "_")}.doc`, 'application/msword');
        toast("✓ Downloaded Word Doc!");
      }
    };
  });

  // Bind PDF download listener
  list.querySelectorAll(".btn-arch-pdf").forEach(btn => {
    btn.onclick = () => {
      const uid = btn.dataset.uid;
      const chat = archiveChats.find(c => c.uuid === uid);
      if (chat) {
        chrome.storage.local.set({ printChatData: chat }, () => {
          chrome.tabs.create({ url: chrome.runtime.getURL("popup/print.html") });
        });
      }
    };
  });

  // Bind JSON download listener
  list.querySelectorAll(".btn-arch-json").forEach(btn => {
    btn.onclick = () => {
      const uid = btn.dataset.uid;
      const chat = archiveChats.find(c => c.uuid === uid);
      if (chat) {
        const json = JSON.stringify(chat, null, 2);
        downloadFile(json, `${(chat.title || "Untitled").replace(/[^a-zA-Z0-9]/g, "_")}.json`, 'application/json');
        toast("✓ Downloaded JSON!");
      }
    };
  });
}

function generateWordHtml(chat) {
  const messages = chat.messages || [];
  const artifacts = extractArtifactsFromMessages(messages);
  let wordArtifactsHtml = "";
  if (artifacts.length > 0) {
    wordArtifactsHtml = `
      <h2 style="color: #c026d3; border-bottom: 2px solid #f5d0fe; padding-bottom: 5px; margin-top: 20px;">📎 Recycled Artifacts & Documents (${artifacts.length})</h2>
    ` + artifacts.map(art => `
      <div style="border: 1px dashed #d1d5db; background: #f9fafb; padding: 12px; margin-bottom: 12px; border-radius: 6px;">
        <div style="font-weight: bold; font-size: 13px; color: #111827;">📄 ${escHtml(art.title)}</div>
        <div style="font-size: 11px; color: #c026d3; font-family: monospace; margin-bottom: 8px;">Type: ${escHtml(art.type)}</div>
        <pre style="background: #f3f4f6; padding: 10px; border: 1px solid #e5e7eb; font-family: Courier New, Courier, monospace; font-size: 11px; white-space: pre-wrap; margin:0;">${escHtml(art.content)}</pre>
      </div>
    `).join("");
  }

  const header = `
    <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
    <head>
      <title>${escHtml(chat.title || "Conversation")}</title>
      <style>
        body { font-family: 'Segoe UI', Arial, sans-serif; color: #1f2937; line-height: 1.6; padding: 20px; }
        h1 { color: #111827; font-size: 22px; border-bottom: 2px solid #e5e7eb; padding-bottom: 8px; margin-bottom: 5px; }
        .meta { font-size: 11px; color: #6b7280; margin-bottom: 20px; }
        .msg { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; margin-bottom: 12px; background: #f9fafb; }
        .msg-human { border-left: 5px solid #d946ef; background: #fdf4ff; }
        .msg-assistant { border-left: 5px solid #3b82f6; background: #eff6ff; }
        .label { font-weight: bold; text-transform: uppercase; font-size: 10px; margin-bottom: 4px; }
        .label-human { color: #c026d3; }
        .label-assistant { color: #2563eb; }
        .text { font-size: 13px; white-space: pre-wrap; }
      </style>
    </head>
    <body>
      <h1>💬 Claude Chat Archive: ${escHtml(chat.title || "Untitled Chat")}</h1>
      <div class="meta">UUID: ${chat.uuid} | Exported At: ${new Date().toLocaleString()}</div>
      ${wordArtifactsHtml}
      <h2 style="color: #111827; border-bottom: 2px solid #e5e7eb; padding-bottom: 5px; margin-top: 25px;">💬 Conversation History</h2>
  `;
  
  const body = messages.map(m => {
    const isHuman = m.role === "human";
    const typeClass = isHuman ? "msg-human" : "msg-assistant";
    const labelClass = isHuman ? "label-human" : "label-assistant";
    const label = isHuman ? "Human" : "Assistant";
    return `
      <div class="msg ${typeClass}">
        <div class="label ${labelClass}">${label}</div>
        <div class="text">${escHtml(m.text || "")}</div>
      </div>
    `;
  }).join("");
  
  const footer = "</body></html>";
  return header + body + footer;
}

function downloadFile(content, filename, contentType) {
  const blob = new Blob([content], { type: contentType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function extractArtifactsFromMessages(messages) {
  const artifacts = [];
  if (!messages) return artifacts;
  for (const m of messages) {
    if (!m.text) continue;
    const regex = /<antArtifact\s+([^>]*?)>([\s\S]*?)<\/antArtifact>/g;
    let match;
    while ((match = regex.exec(m.text)) !== null) {
      const attrsStr = match[1];
      const content = match[2];
      const idMatch = attrsStr.match(/identifier=["']([^"']*)["']/);
      const titleMatch = attrsStr.match(/title=["']([^"']*)["']/);
      const typeMatch = attrsStr.match(/type=["']([^"']*)["']/);
      artifacts.push({
        identifier: idMatch ? idMatch[1] : "artifact",
        title: titleMatch ? titleMatch[1] : "Untitled Document",
        type: typeMatch ? typeMatch[1] : "text/plain",
        content: content.trim()
      });
    }
  }
  return artifacts;
}

function renderPreviewMessages(messages) {
  const container = $("previewModalBody");
  if (!container) return;
  
  container.innerHTML = messages.map(m => {
    const isHuman = m.role === "human";
    const bg = isHuman ? "rgba(217, 70, 239, 0.05)" : "rgba(255, 255, 255, 0.02)";
    const border = isHuman ? "rgba(217, 70, 239, 0.15)" : "var(--border)";
    const color = isHuman ? "var(--accent)" : "#ffffff";
    const roleLabel = isHuman ? "Human" : "Assistant";
    
    return `
      <div style="background: ${bg}; border: 1px solid ${border}; border-radius: var(--radius-sm); padding: 8px 10px; margin-bottom: 8px;">
        <div style="font-size: 9px; font-weight: 600; text-transform: uppercase; color: ${color}; margin-bottom: 4px; font-family: var(--font-heading);">${roleLabel}</div>
        <div style="white-space: pre-wrap; font-family: var(--font-body); word-break: break-word;">${escHtml(m.text)}</div>
      </div>
    `;
  }).join("");
}

// ── Update overall UI state ───────────────────────────────────────────
function updateUI() {
  chrome.runtime.sendMessage({ type: "GET_STATUS" }, resp => {
    const queues = resp?.queues || {};
    const activeList = Object.values(queues).filter(q => q.active);
    const pill    = document.getElementById("headerPill");
    const pillTxt = $("headerPillText");
    const btnStart = $("btnStart");
    const btnStop  = $("btnStop");
    const currentUrl = $("chatUrl").value.trim();

    if (activeList.length === 0) {
      pill.className = "status-pill idle";
      pillTxt.textContent = "Idle";
    } else {
      const hasChecking = activeList.some(q => q.status === "checking" || q.status === "sending");
      const hasWaiting = activeList.some(q => q.status === "waiting");
      if (hasChecking) {
        pill.className = "status-pill checking";
      } else if (hasWaiting) {
        pill.className = "status-pill waiting";
      } else {
        pill.className = "status-pill active";
      }
      pillTxt.textContent = `${activeList.length} Active`;
    }

    const currentQueue = currentUrl ? queues[currentUrl] : null;
    if (currentQueue && currentQueue.active) {
      btnStart.style.display = "none";
      btnStop.style.display = "block";
    } else {
      btnStart.style.display = "block";
      btnStop.style.display = "none";
      btnStart.disabled = false;
    }
  });
}

// ── Toast notification ────────────────────────────────────────────────
let toastTimer = null;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

function escHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ── Token estimation ──────────────────────────────────────────────────
function estimateTokens(text) {
  if (!text) return 0;
  const charCount = text.length;
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  if (charCount === 0) return 0;
  const tokens = Math.ceil((charCount / 4 + wordCount / 0.75) / 2);
  return Math.max(1, tokens);
}

function updatePromptStats() {
  const text = $("prompt").value;
  const chars = text.length;
  const tokens = estimateTokens(text);
  $("promptCharCount").textContent = chars + " chars";
  $("promptTokenCount").textContent = tokens + " tokens";
}

// ── Prompt Templates Storage & Rendering ──────────────────────────────
const BUILTIN_TEMPLATES = [
  { name: "Continue coding", prompt: "Continue coding from where we left off. Pick up the next task and implement it." },
  { name: "Summarize progress", prompt: "Summarize our progress so far and outline the remaining tasks." },
  { name: "Debug the error", prompt: "Debug the last error we encountered. Analyze the issue and provide a fix." },
  { name: "Continue from where we left off", prompt: "Continue from where we left off. Next step:" }
];

function getTemplates(cb) {
  chrome.storage.local.get("customTemplates", d => {
    const custom = d?.customTemplates || [];
    cb([...BUILTIN_TEMPLATES, ...custom]);
  });
}

function saveCustomTemplate(name, prompt) {
  chrome.storage.local.get("customTemplates", d => {
    const arr = d?.customTemplates || [];
    arr.push({ name, prompt, custom: true });
    if (arr.length > 10) arr.shift();
    chrome.storage.local.set({ customTemplates: arr }, () => {
      renderTemplates();
    });
  });
}

function removeCustomTemplate(idx) {
  chrome.storage.local.get("customTemplates", d => {
    const arr = d?.customTemplates || [];
    arr.splice(idx, 1);
    chrome.storage.local.set({ customTemplates: arr }, () => {
      renderTemplates();
    });
  });
}

// ── Debounced Draft Auto-saving ──────────────────────────────────────
let popupSaveTimeout = null;
function saveDraft() {
  clearTimeout(popupSaveTimeout);
  popupSaveTimeout = setTimeout(() => {
    const chatUrl = $("chatUrl").value;
    const prompt = $("prompt").value;
    const resetMinutes = parseInt($("resetMinutes").value) || 0;
    const checkInterval = parseInt($("checkInterval").value) || 60;
    chrome.storage.local.set({ savedSettings: { chatUrl, prompt, resetMinutes, checkInterval } });
  }, 400);
}

// ── Sync Composer Text ───────────────────────────────────────────────
function requestComposerText() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs[0];
    if (!tab || !tab.url || !ALLOWED_DOMAINS.some(d => tab.url.includes(d))) {
      toast("Open a supported AI chat first");
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: "GET_COMPOSER_TEXT" }, resp => {
      if (chrome.runtime.lastError || !resp) {
        toast("⚠ Could not read AI input box");
        return;
      }
      if (resp.text) {
        $("prompt").value = resp.text;
        updatePromptStats();
        saveDraft();
        toast("✓ Synced from AI chat box");
      } else {
        toast("ℹ AI chat box is empty");
      }
    });
  });
}

// ── Update active platform badge ──────────────────────────────────────
function updatePlatformBadge() {
  const url = $("chatUrl").value;
  const name = getDomainName(url);
  const badge = $("activePlatformBadge");
  if (!badge) return;

  if (name === "Claude") {
    badge.textContent = "🟠 Claude";
    badge.style.cssText = "font-weight: 600; padding: 2px 8px; border-radius: 4px; font-size: 9px; background: rgba(249, 115, 22, 0.1); border: 1px solid rgba(249, 115, 22, 0.35); color: #f97316; letter-spacing: 0.3px;";
  } else if (name === "ChatGPT") {
    badge.textContent = "🟢 ChatGPT";
    badge.style.cssText = "font-weight: 600; padding: 2px 8px; border-radius: 4px; font-size: 9px; background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.35); color: #10b981; letter-spacing: 0.3px;";
  } else if (name === "Gemini") {
    badge.textContent = "🔵 Gemini";
    badge.style.cssText = "font-weight: 600; padding: 2px 8px; border-radius: 4px; font-size: 9px; background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.35); color: #3b82f6; letter-spacing: 0.3px;";
  } else if (name === "DeepSeek") {
    badge.textContent = "🟣 DeepSeek";
    badge.style.cssText = "font-weight: 600; padding: 2px 8px; border-radius: 4px; font-size: 9px; background: rgba(139, 92, 246, 0.1); border: 1px solid rgba(139, 92, 246, 0.35); color: #8b5cf6; letter-spacing: 0.3px;";
  } else {
    badge.textContent = "None";
    badge.style.cssText = "font-weight: 600; padding: 2px 8px; border-radius: 4px; font-size: 9px; background: rgba(255, 255, 255, 0.05); border: 1px solid var(--border); color: var(--muted); letter-spacing: 0.3px;";
  }
}

// ── Broadcaster for setting updates ──────────────────────────────────
function updateSetting(key, val) {
  chrome.storage.local.set({ [key]: val }, () => {
    chrome.tabs.query({}, tabs => {
      tabs.forEach(tab => {
        if (tab.url && ALLOWED_DOMAINS.some(d => tab.url.includes(d))) {
          chrome.tabs.sendMessage(tab.id, { type: "SETTING_CHANGED", key, val }, () => chrome.runtime.lastError);
        }
      });
    });
  });
}

// ── Render templates ──────────────────────────────────────────────────
function renderTemplates() {
  const container = $("templateChips");
  if (!container) return;
  getTemplates(templates => {
    container.innerHTML = templates.map((t, i) => {
      if (t.custom) {
        return `<span class="template-chip custom" data-idx="${i}" title="${escHtml(t.prompt)}" style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;">
          <span>${escHtml(t.name)}</span>
          <span class="template-chip-del" data-idx="${i}" title="Delete template">✕</span>
        </span>`;
      } else {
        return `<span class="template-chip" data-idx="${i}" title="${escHtml(t.prompt)}">${escHtml(t.name)}</span>`;
      }
    }).join("");

    container.querySelectorAll(".template-chip").forEach(chip => {
      chip.onclick = (e) => {
        if (e.target.classList.contains("template-chip-del")) {
          e.stopPropagation();
          const idx = parseInt(e.target.dataset.idx);
          const customIdx = idx - BUILTIN_TEMPLATES.length;
          removeCustomTemplate(customIdx);
          toast("✓ Template deleted");
          return;
        }
        const idx = parseInt(chip.dataset.idx);
        const tpl = templates[idx];
        if (tpl) {
          $("prompt").value = tpl.prompt;
          updatePromptStats();
          $("prompt").focus();
        }
      };
    });
  });
}

// ── Render settings panel ─────────────────────────────────────────────
function renderSettings() {
  chrome.storage.local.get(["soundPref", "ttsVoice", "theme", "fabEnabled", "autoCaptureEnabled", "promptHistory"], d => {
    $("selSound").value = d.soundPref || "chime";
    $("selTheme").value = d.theme || "default";
    $("chkFab").checked = d.fabEnabled !== false;
    $("chkAutoCapture").checked = d.autoCaptureEnabled !== false;

    // Show/hide TTS voice row
    const rowTts = $("rowTtsVoice");
    if (rowTts) {
      rowTts.style.display = d.soundPref === "tts" ? "flex" : "none";
    }

    // Populate and set voice selector
    populateTtsVoices(d.ttsVoice);

    // Apply active theme
    applyTheme(d.theme || "default");

    // Render history
    const history = d.promptHistory || [];
    const list = $("promptHistoryList");
    if (history.length === 0) {
      list.innerHTML = `
        <div class="empty-state" style="padding: 10px; font-size: 11px;">
          <div class="empty-text">No prompt history yet.</div>
        </div>
      `;
      return;
    }

    list.innerHTML = history.map((item, idx) => {
      const date = new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const brand = item.domain || "AI";
      return `
        <div class="history-item" data-idx="${idx}">
          <div class="history-text" title="${escHtml(item.prompt)}">${escHtml(item.prompt)}</div>
          <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
            <span style="font-size: 8px; font-weight: 600; padding: 1px 4px; border-radius: 3px; background: rgba(255,255,255,0.06); border: 1px solid var(--border);">${brand}</span>
            <span class="history-date">${date}</span>
          </div>
        </div>
      `;
    }).join("");

    // Bind click listeners to history items
    list.querySelectorAll(".history-item").forEach(item => {
      item.onclick = () => {
        const idx = parseInt(item.dataset.idx);
        const selected = history[idx];
        if (selected) {
          $("prompt").value = selected.prompt;
          updatePromptStats();
          saveDraft();
          toast("✓ Prompt loaded from history");
          document.querySelector('[data-tab="setup"]').click();
        }
      };
    });
  });
}

// ── Load saved settings on open ───────────────────────────────────────
chrome.storage.local.get(["savedSettings", "autoCaptureEnabled", "soundPref", "theme"], ({ savedSettings, autoCaptureEnabled, soundPref, theme }) => {
  if (savedSettings) {
    if (savedSettings.chatUrl)      $("chatUrl").value      = savedSettings.chatUrl;
    if (savedSettings.prompt)       $("prompt").value       = savedSettings.prompt;
    if (savedSettings.resetMinutes) $("resetMinutes").value = savedSettings.resetMinutes;
    if (savedSettings.checkInterval) $("checkInterval").value = savedSettings.checkInterval;
    updatePromptStats();
    updatePlatformBadge();
  }
  
  $("selSound").value = soundPref || "chime";
  $("selTheme").value = theme || "default";
  applyTheme(theme || "default");
  
  // If the prompt is still empty, auto-detect composer text
  if (autoCaptureEnabled !== false && !$("prompt").value.trim()) {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tab = tabs[0];
      if (tab && tab.url && ALLOWED_DOMAINS.some(d => tab.url.includes(d))) {
        chrome.tabs.sendMessage(tab.id, { type: "GET_COMPOSER_TEXT" }, resp => {
          if (!chrome.runtime.lastError && resp && resp.text) {
            $("prompt").value = resp.text;
            updatePromptStats();
            saveDraft();
          }
        });
      }
    });
  }
});

// ── Auto-detect timer from active Claude tab ─────────────────────────
function autoDetectTimer() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs[0];
    if (!tab || !tab.url || !ALLOWED_DOMAINS.some(d => tab.url.includes(d))) return;
    chrome.tabs.sendMessage(tab.id, { type: "GET_RESET_INFO" }, resp => {
      if (chrome.runtime.lastError || !resp) return;
      if (resp.mins) {
        $("resetMinutes").value = resp.mins;
        const hint = document.querySelector(".time-hint");
        if (hint) hint.textContent = `Auto-detected: ${resp.display}`;
        hint?.classList?.add("green");
      }
    });
  });
}

// ── Init ──────────────────────────────────────────────────────────────
updateUI();
autoDetectTimer();
renderTemplates();

// ── Event Listeners ───────────────────────────────────────────────────
$("prompt").addEventListener("input", () => {
  updatePromptStats();
  saveDraft();
});
$("chatUrl").addEventListener("input", () => {
  updatePlatformBadge();
  saveDraft();
});
$("resetMinutes").addEventListener("input", saveDraft);
$("checkInterval").addEventListener("input", saveDraft);
$("btnSyncComposer").addEventListener("click", requestComposerText);

// Settings Listeners
$("selSound").addEventListener("change", () => {
  const val = $("selSound").value;
  chrome.storage.local.set({ soundPref: val }, () => {
    chrome.runtime.sendMessage({ type: "SET_SOUND_PREF", data: { soundPref: val } }, () => {
      chrome.tabs.query({}, tabs => {
        tabs.forEach(tab => {
          if (tab.url && ALLOWED_DOMAINS.some(d => tab.url.includes(d))) {
            chrome.tabs.sendMessage(tab.id, { type: "SETTING_CHANGED", key: "soundPref", val }, () => chrome.runtime.lastError);
          }
        });
      });
      toast("✓ Alert sound set to " + val.toUpperCase());
      const rowTts = $("rowTtsVoice");
      if (rowTts) rowTts.style.display = val === "tts" ? "flex" : "none";
    });
  });
});

$("selTtsVoice").addEventListener("change", () => {
  const val = $("selTtsVoice").value;
  chrome.storage.local.set({ ttsVoice: val }, () => {
    toast("✓ TTS Voice accent set");
  });
});

$("selTheme").addEventListener("change", () => {
  const val = $("selTheme").value;
  chrome.storage.local.set({ theme: val }, () => {
    applyTheme(val);
    toast("✓ Theme updated to " + val.toUpperCase());
  });
});

$("btnPlaySoundPreview").addEventListener("click", () => {
  const soundType = $("selSound").value;
  const voiceName = $("selTtsVoice").value;
  playLocalSoundPreview(soundType, voiceName);
});

$("chkFab").addEventListener("change", () => {
  updateSetting("fabEnabled", $("chkFab").checked);
  toast("✓ Floating badge " + ($("chkFab").checked ? "enabled" : "disabled"));
});

$("chkAutoCapture").addEventListener("change", () => {
  updateSetting("autoCaptureEnabled", $("chkAutoCapture").checked);
  toast("✓ Auto-capture " + ($("chkAutoCapture").checked ? "enabled" : "disabled"));
});

$("btnClearHistory").addEventListener("click", () => {
  chrome.storage.local.set({
    promptHistory: [],
    soundPref: "chime",
    ttsVoice: "",
    theme: "default",
    fabEnabled: true,
    autoCaptureEnabled: true
  }, () => {
    chrome.runtime.sendMessage({ type: "SET_SOUND_PREF", data: { soundPref: "chime" } });
    updateSetting("fabEnabled", true);
    updateSetting("autoCaptureEnabled", true);
    applyTheme("default");
    $("selSound").value = "chime";
    $("selTheme").value = "default";
    const rowTts = $("rowTtsVoice");
    if (rowTts) rowTts.style.display = "none";
    renderSettings();
    toast("🗑 History and settings cleared");
  });
});

// ── Save as template click handler ────────────────────────────────────
$("btnSaveTemplate").addEventListener("click", () => {
  const text = $("prompt").value.trim();
  if (!text) { toast("⚠ Enter a prompt first"); return; }
  const name = text.slice(0, 20).replace(/[^a-zA-Z0-9 ]/g, "") + (text.length > 20 ? "…" : "");
  saveCustomTemplate(name, text);
  toast("✓ Saved as template");
});

// Auto-refresh status every 4 seconds when popup is open
setInterval(() => {
  const activeTab = document.querySelector(".tab.active");
  if (activeTab?.dataset.tab === "status") renderStatus();
  if (activeTab?.dataset.tab === "analytics") renderAnalytics();
  if (activeTab?.dataset.tab === "trash") renderTrash();
  if (activeTab?.dataset.tab === "archive") renderArchive();
  if (activeTab?.dataset.tab === "settings") renderSettings();
  updateUI();
}, 4000);

function applyTheme(themeName) {
  document.body.classList.remove("theme-cyberpunk", "theme-light", "theme-emerald");
  if (themeName !== "default") {
    document.body.classList.add(`theme-${themeName}`);
  }
}

function populateTtsVoices(selectedVoiceName) {
  if (typeof speechSynthesis === 'undefined') return;
  const select = $("selTtsVoice");
  if (!select) return;
  
  const voices = speechSynthesis.getVoices();
  select.innerHTML = voices.map(v => `<option value="${escHtml(v.name)}" ${v.name === selectedVoiceName ? "selected" : ""}>${escHtml(v.name)} (${escHtml(v.lang)})</option>`).join("");
}

// In case voices load after popup open
if (typeof speechSynthesis !== 'undefined' && speechSynthesis.onvoiceschanged !== undefined) {
  speechSynthesis.onvoiceschanged = () => {
    chrome.storage.local.get("ttsVoice", d => populateTtsVoices(d.ttsVoice));
  };
}

function playLocalSoundPreview(soundType, voiceName) {
  try {
    if (soundType === "chime") {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const notes = [523.25, 659.25, 783.99]; // C5, E5, G5
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
    } else if (soundType === "beep") {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.4);
      setTimeout(() => ctx.close(), 1000);
    } else if (soundType === "tts") {
      if (typeof speechSynthesis !== "undefined") {
        const utterance = new SpeechSynthesisUtterance("Claude Safeguard is ready!");
        if (voiceName) {
          const voice = speechSynthesis.getVoices().find(v => v.name === voiceName);
          if (voice) utterance.voice = voice;
        }
        speechSynthesis.speak(utterance);
      }
    }
  } catch {}
}

function renderAnalytics() {
  chrome.storage.local.get(["stats_totalSends", "stats_limitHits", "usageHistory"], d => {
    const sends = d.stats_totalSends || 0;
    const hits = d.stats_limitHits || 0;
    const history = d.usageHistory || [];

    const sendsVal = $("valTotalSends");
    const hitsVal = $("valLimitHits");
    const chartContainer = $("chartSvgContainer");

    if (sendsVal) sendsVal.textContent = sends;
    if (hitsVal) hitsVal.textContent = hits;

    if (!chartContainer) return;

    if (history.length < 2) {
      chartContainer.innerHTML = `<span style="color:var(--muted); font-size:11px;">Insufficient history checkpoints (${history.length}/2)</span>`;
      return;
    }

    // Draw interactive SVG line chart of last 15 utilization points
    const points = history.slice(-15);
    const width = 300;
    const height = 110;
    const padding = 15;
    const maxVal = 100;
    const xStride = (width - padding * 2) / (points.length - 1);

    const coordinates = points.map((p, i) => {
      const x = padding + i * xStride;
      const sVal = typeof p.s === "number" ? p.s : 0;
      const y = height - padding - (sVal / maxVal) * (height - padding * 2);
      return { x, y, val: sVal };
    });

    const pathData = coordinates.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(" ");
    const areaPathData = `${pathData} L ${coordinates[coordinates.length - 1].x.toFixed(1)} ${(height - padding).toFixed(1)} L ${coordinates[0].x.toFixed(1)} ${(height - padding).toFixed(1)} Z`;
    const dots = coordinates.map(c => `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="3.5" fill="var(--accent)" stroke="#fff" stroke-width="1.2"><title>${c.val}% utilization</title></circle>`).join("");

    chartContainer.innerHTML = `
      <svg width="${width}" height="${height}" style="overflow:visible;">
        <defs>
          <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.32"/>
            <stop offset="100%" stop-color="var(--accent)" stop-opacity="0.0"/>
          </linearGradient>
        </defs>
        
        <line x1="${padding}" y1="${padding}" x2="${width - padding}" y2="${padding}" stroke="var(--border)" stroke-width="0.7" stroke-dasharray="2 2" />
        <line x1="${padding}" y1="${height/2}" x2="${width - padding}" y2="${height/2}" stroke="var(--border)" stroke-width="0.7" stroke-dasharray="2 2" />
        <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="var(--border)" stroke-width="1" />
        
        <path d="${areaPathData}" fill="url(#chartGrad)" />
        <path d="${pathData}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" />
        ${dots}
        
        <text x="${padding}" y="${padding - 4}" fill="var(--muted)" font-size="8" font-family="var(--font-mono)">100%</text>
        <text x="${padding}" y="${height - padding + 10}" fill="var(--muted)" font-size="8" font-family="var(--font-mono)">Time ➜</text>
      </svg>
    `;
  });
}

// ── Preview Modal & Recycle Bin Event Listeners ───────────────────────
let activePreviewChat = null;

$("btnClearTrash").addEventListener("click", () => {
  chrome.storage.local.set({ recycleBin: [] }, () => {
    toast("🗑 Recycle Bin cleared");
    renderTrash();
  });
});

$("btnClosePreview").addEventListener("click", () => {
  $("previewModal").style.display = "none";
});

$("btnCopyPreview").addEventListener("click", () => {
  if (activePreviewChat) {
    const markdown = formatForExport(activePreviewChat.messages, 'custom');
    navigator.clipboard.writeText(markdown).then(() => {
      toast("✓ Copied to clipboard!");
    });
  }
});

$("btnDownloadPreview").addEventListener("click", () => {
  if (activePreviewChat) {
    const markdown = formatForExport(activePreviewChat.messages, 'custom');
    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activePreviewChat.title.replace(/[^a-zA-Z0-9]/g, "_")}.md`;
    a.click();
    URL.revokeObjectURL(url);
    toast("✓ Markdown file downloaded!");
  }
});

$("btnWordPreview").addEventListener("click", () => {
  if (activePreviewChat) {
    const docHtml = generateWordHtml(activePreviewChat);
    downloadFile(docHtml, `${(activePreviewChat.title || "Untitled").replace(/[^a-zA-Z0-9]/g, "_")}.doc`, 'application/msword');
    toast("✓ Downloaded Word Doc!");
  }
});

$("btnPdfPreview").addEventListener("click", () => {
  if (activePreviewChat) {
    chrome.storage.local.set({ printChatData: activePreviewChat }, () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("popup/print.html") });
    });
  }
});

// Archive search and global backup triggers
const archiveSearchInput = $("archiveSearch");
if (archiveSearchInput) {
  archiveSearchInput.addEventListener("input", filterAndRenderArchiveList);
}

const btnExportAllJson = $("btnExportAllJson");
if (btnExportAllJson) {
  btnExportAllJson.addEventListener("click", () => {
    chrome.storage.local.get(["chatCache", "recycleBin"], d => {
      const backup = {
        exportedAt: Date.now(),
        chatCache: d.chatCache || {},
        recycleBin: d.recycleBin || []
      };
      const json = JSON.stringify(backup, null, 2);
      downloadFile(json, `claude_backup_archive_${Date.now()}.json`, 'application/json');
      toast("✓ Exported all conversations!");
    });
  });
}
