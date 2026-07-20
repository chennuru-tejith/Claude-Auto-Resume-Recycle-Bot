// ChatQueue AI — Background Service Worker v5

const ALARM = "ar-monitor";
const MAX_ATTEMPTS = 120;

// ── Messages ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case "START_RESUME":
      startResume(msg.data);
      sendResponse({ ok: true });
      return false; // synchronous
    case "STOP_RESUME":
      stopResume(msg.chatUrl);
      sendResponse({ ok: true });
      return false; // synchronous
    case "LIMIT_DETECTED":
      onLimitDetected(msg.chatUrl || sender.tab?.url, msg.resetMinutes);
      sendResponse({ ok: true });
      return false; // synchronous
    case "GET_STATUS":
      chrome.storage.local.get("queues", d => {
        const queues = d.queues || {};
        const url = msg.chatUrl || sender.tab?.url || "";
        const state = url ? (queues[url] || null) : null;
        sendResponse({ state, queues });
      });
      return true; // asynchronous
    case "SET_SOUND_PREF":
      chrome.storage.local.set({ soundPref: msg.data.soundPref }, () => {
        sendResponse({ ok: true });
      });
      return true; // asynchronous
    case "GET_SOUND_PREF":
      chrome.storage.local.get("soundPref", d => {
        sendResponse({ soundPref: d.soundPref || "chime" });
      });
      return true; // asynchronous
    case "LOCAL_SEND_START":
      {
        const chatUrl = msg.chatUrl || sender.tab?.url;
        if (chatUrl) {
          updateState(chatUrl, s => { s.status = "sending"; return s; }, "In-page instant-send triggered...");
        }
        sendResponse({ ok: true });
        return false; // synchronous
      }
    case "LOCAL_SEND_SUCCESS":
      {
        const chatUrl = msg.chatUrl || sender.tab?.url;
        if (chatUrl) {
          incrementStat("stats_totalSends");
          updateState(chatUrl, s => { s.status = "done"; s.active = false; return s; },
            `✓ Prompt sent successfully via in-page instant checker! (${msg.method || "ok"})`);
          chrome.alarms.clear(ALARM);
          chrome.alarms.clear("ar-wait-end|" + chatUrl);
          if (fastBgTimeouts[chatUrl]) {
            clearTimeout(fastBgTimeouts[chatUrl]);
            delete fastBgTimeouts[chatUrl];
          }
        }

        if (sender.tab && sender.tab.id) {
          chrome.tabs.update(sender.tab.id, { active: true }, () => {
            if (sender.tab.windowId) {
              chrome.windows.update(sender.tab.windowId, { focused: true });
            }
          });
        }

        chrome.notifications.create({
          type: "basic",
          iconUrl: "icons/icon48.png",
          title: "ChatQueue AI ✓",
          message: "Your prompt was sent! The AI is responding."
        });
        sendResponse({ ok: true });
        return false; // synchronous
      }
    case "LOCAL_SEND_FAILED":
      {
        const chatUrl = msg.chatUrl || sender.tab?.url;
        if (chatUrl) {
          updateState(chatUrl, s => { s.status = "checking"; return s; },
            `Instant-send failed: ${msg.reason || "unknown"}. Re-entering checks...`);
        }
        sendResponse({ ok: true });
        return false; // synchronous
      }
    case "RECORD_USAGE":
      chrome.storage.local.get("usageHistory", d => {
        let history = d.usageHistory || [];
        history.push({ t: Date.now(), s: msg.data.session, w: msg.data.weekly });
        if (history.length > 50) history.shift();
        chrome.storage.local.set({ usageHistory: history });
      });
      sendResponse({ ok: true });
      return false; // synchronous
    case "FORCE_SEND":
      forceSend(msg.chatUrl);
      sendResponse({ ok: true });
      return false; // synchronous
    case "RELOAD_QUEUE_TAB":
      reloadQueueTab(msg.chatUrl);
      sendResponse({ ok: true });
      return false; // synchronous
    default:
      return false; // Unhandled type: do not return true to prevent port leaks
  }
});

// ── Start ─────────────────────────────────────────────────────────────
function startResume(data) {
  const allowed = ["claude.ai", "chatgpt.com", "gemini.google.com", "deepseek.com"];
  const isValid = allowed.some(domain => {
    try {
      const parsed = new URL(data?.chatUrl);
      return parsed.hostname.includes(domain) && data.chatUrl.startsWith("https://");
    } catch {
      return false;
    }
  });
  if (!isValid) return;

  const chatUrl = data.chatUrl;
  const state = {
    active: true,
    chatUrl: chatUrl,
    prompt: data.prompt,
    resetMinutes: data.resetMinutes ?? 0,
    checkInterval: data.checkInterval || 60,
    status: "monitoring",
    startedAt: Date.now(),
    limitDetectedAt: null,
    attempts: 0,
    log: [`[${ts()}] ChatQueue AI started. Monitoring for usage limit...`]
  };

  chrome.storage.local.get("queues", d => {
    const queues = d.queues || {};
    queues[chatUrl] = state;

    // Prune logic: keep maximum 15 inactive queues in history to prevent storage bloat
    const queueList = Object.values(queues);
    if (queueList.length > 15) {
      const inactive = queueList.filter(q => !q.active);
      inactive.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
      const toRemoveCount = queueList.length - 15;
      for (let i = 0; i < Math.min(toRemoveCount, inactive.length); i++) {
        delete queues[inactive[i].chatUrl];
      }
    }

    chrome.storage.local.set({ queues, resumeState: state }, () => {
      chrome.alarms.clear(ALARM, () => {
        chrome.alarms.create(ALARM, { periodInMinutes: 1 });
      });
      broadcast(state);
      updateBadge(queues);
      setTimeout(() => checkImmediately(chatUrl), 2000);
    });
  });
}

// ── Stop ──────────────────────────────────────────────────────────────
function stopResume(chatUrl) {
  chrome.storage.local.get("queues", d => {
    const queues = d.queues || {};
    let lastStopped = null;
    if (chatUrl && queues[chatUrl]) {
      queues[chatUrl].active = false;
      queues[chatUrl].status = "stopped";
      queues[chatUrl].log.push(`[${ts()}] Stopped by user.`);
      lastStopped = queues[chatUrl];
    } else {
      for (const url in queues) {
        if (queues[url].active) {
          queues[url].active = false;
          queues[url].status = "stopped";
          queues[url].log.push(`[${ts()}] Stopped by user.`);
          lastStopped = queues[url];
        }
      }
    }
    chrome.storage.local.set({ queues, resumeState: lastStopped }, () => {
      const anyActive = Object.values(queues).some(q => q.active);
      if (!anyActive) {
        chrome.alarms.clear(ALARM);
        for (const url in fastBgTimeouts) {
          clearTimeout(fastBgTimeouts[url]);
          delete fastBgTimeouts[url];
        }
      }
      if (chatUrl && queues[chatUrl]) {
        broadcast(queues[chatUrl]);
      } else {
        Object.values(queues).forEach(q => broadcast(q));
      }
      updateBadge(queues);
    });
  });
}

// ── Alarm tick ────────────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name.startsWith("ar-wait-end|")) {
    const chatUrl = alarm.name.split("|").slice(1).join("|");
    chrome.storage.local.get("queues", d => {
      const queues = d.queues || {};
      const s = queues[chatUrl];
      if (!s || !s.active || s.status !== "waiting") return;
      
      s.status = "checking";
      s.log.push(`[${ts()}] Wait complete. Waking up tab and starting checks...`);
      
      chrome.storage.local.set({ queues }, () => {
        findOrOpenTab(chatUrl, (tabId) => {
          if (tabId) {
            chrome.tabs.update(tabId, { active: true });
          }
        });
        broadcast(s);
        updateBadge(queues);
      });
    });
    return;
  }

  if (alarm.name !== ALARM) return;
  
  chrome.storage.local.get("queues", d => {
    const queues = d.queues || {};
    let updated = false;

    // Check offline status
    if (navigator.onLine === false) {
      for (const url in queues) {
        if (queues[url].active && queues[url].status !== "waiting" && !queues[url].log[queues[url].log.length - 1].includes("offline")) {
          queues[url].log.push(`[${ts()}] Network offline. Pausing checks...`);
          updated = true;
        }
      }
      if (updated) {
        chrome.storage.local.set({ queues }, () => {
          Object.values(queues).forEach(q => broadcast(q));
        });
      }
      return;
    }

    for (const url in queues) {
      const s = queues[url];
      if (!s.active) continue;

      if (s.status === "monitoring") {
        checkImmediately(url);
      } else if (s.status === "waiting") {
        const elapsed = (Date.now() - s.limitDetectedAt) / 60000;
        const rem = s.resetMinutes - elapsed;
        if (rem <= 0) {
          s.status = "checking";
          s.log.push(`[${ts()}] Wait complete. Waking up tab and starting checks...`);
          updated = true;
          findOrOpenTab(url, (tabId) => {
            if (tabId) {
              chrome.tabs.update(tabId, { active: true });
            }
          });
        } else {
          s.log.push(`[${ts()}] Waiting... ${Math.ceil(rem)} min remaining`);
          updated = true;
        }
      } else if (s.status === "checking") {
        attemptSend(s);
      }
    }

    if (updated) {
      chrome.storage.local.set({ queues }, () => {
        Object.values(queues).forEach(q => broadcast(q));
        updateBadge(queues);
      });
    }
  });
});

// ── Immediately check limit state ────────────────────────────────────
function checkImmediately(chatUrl) {
  if (!chatUrl) return;
  chrome.storage.local.get("queues", d => {
    const queues = d.queues || {};
    const s = queues[chatUrl];
    if (!s || !s.active) return;

    findOrOpenTab(chatUrl, (tabId, wasCreated) => {
      if (!tabId) { addLog(chatUrl, "Could not find/open AI tab"); return; }

      ensureTabReady(tabId, ready => {
        if (!ready) { addLog(chatUrl, "AI tab load timed out"); return; }

        setTimeout(() => {
          chrome.tabs.sendMessage(tabId, { type: "CHECK_LIMIT" }, resp => {
            if (chrome.runtime.lastError || !resp) return;

            if (resp.limited) {
              chrome.tabs.sendMessage(tabId, { type: "GET_RESET_INFO" }, ri => {
                const mins = (ri && ri.mins) ? ri.mins : 0;
                onLimitDetected(chatUrl, mins);
              });
            } else if (resp.canType) {
              attemptSend(s);
            }
          });
        }, wasCreated ? 2500 : 500);
      });
    });
  });
}

// ── Limit detected ────────────────────────────────────────────────────
function onLimitDetected(chatUrl, detectedMins) {
  if (!chatUrl) return;
  chrome.storage.local.get("queues", d => {
    const queues = d.queues || {};
    const s = queues[chatUrl];
    if (!s || !s.active || s.limitDetectedAt) return;

    const minsToWait = detectedMins || s.resetMinutes || 180;
    s.limitDetectedAt = Date.now();
    s.status = "waiting";
    s.resetMinutes = minsToWait;
    s.log.push(`[${ts()}] Usage limit detected! Waiting ${minsToWait} min before checking...`);
    incrementStat("stats_limitHits");

    chrome.storage.local.set({ queues }, () => {
      broadcast(s);
      updateBadge(queues);

      const alarmName = "ar-wait-end|" + chatUrl;
      chrome.alarms.create(alarmName, { delayInMinutes: minsToWait });
    });
  });
}

// ── Attempt to send ───────────────────────────────────────────────────
function attemptSend(state) {
  const chatUrl = state.chatUrl;
  const attempt = (state.attempts || 0) + 1;

  if (attempt >= MAX_ATTEMPTS) {
    addLog(chatUrl, `✗ Gave up after ${MAX_ATTEMPTS} attempts.`);
    updateState(chatUrl, s => { s.active = false; s.status = "failed"; return s; });
    return;
  }

  updateState(chatUrl, s => { s.attempts = attempt; return s; });
  addLog(chatUrl, `Check #${attempt} — testing if limit has reset...`);

  findOrOpenTab(chatUrl, (tabId, wasCreated) => {
    if (!tabId) {
      addLog(chatUrl, "Could not reach AI tab. Will retry next cycle.");
      return;
    }

    const reloadAndProceed = () => {
      chrome.tabs.reload(tabId, { bypassCache: true }, () => {
        ensureTabReady(tabId, ready => {
          if (!ready) {
            addLog(chatUrl, "Tab reload timed out. Will retry next cycle.");
            return;
          }
          setTimeout(() => runCheck(true), 3500);
        });
      });
    };

    const runCheck = (isFresh) => {
      chrome.tabs.get(tabId, tab => {
        if (chrome.runtime.lastError || !tab) {
          addLog(chatUrl, "Tab was closed. Will retry next cycle.");
          return;
        }

        if (tab.url) {
          const cleanTabUrl = tab.url.toLowerCase();
          const isLoginRedirect = ["/login", "/auth", "/signin", "/sign-in", "/signup", "/sign-up", "auth.chatgpt.com"].some(keyword => cleanTabUrl.includes(keyword));
          if (isLoginRedirect) {
            addLog(chatUrl, "✗ Stopped: Authorization or Login page detected. Please open the page and log in.");
            updateState(chatUrl, s => { s.active = false; s.status = "failed"; return s; });
            return;
          }

          try {
            const tabHost = new URL(tab.url).hostname.toLowerCase();
            const targetHost = new URL(chatUrl).hostname.toLowerCase();
            const getBaseDomain = host => host.split('.').slice(-2).join('.');
            if (getBaseDomain(tabHost) !== getBaseDomain(targetHost)) {
              addLog(chatUrl, `Tab navigated to external site (${tabHost}). Re-routing to ${targetHost}...`);
              chrome.tabs.update(tabId, { url: chatUrl });
              return;
            }
          } catch (err) {}
        }
        chrome.tabs.sendMessage(tabId, { type: "CHECK_LIMIT" }, resp => {
          if (chrome.runtime.lastError || !resp) {
            if (!isFresh) {
              addLog(chatUrl, "Tab unresponsive. Reloading connection...");
              reloadAndProceed();
            } else {
              addLog(chatUrl, "Content script not responding. Retrying...");
            }
            return;
          }

          if (resp.limited) {
            addLog(chatUrl, `Still limited. Retrying...`);
            scheduleFastBackgroundCheck(chatUrl, 10000);
            return;
          }

          if (resp.canType) {
            chrome.tabs.update(tabId, { active: true }, () => {
              chrome.tabs.get(tabId, tab => {
                if (!chrome.runtime.lastError && tab && tab.windowId) {
                  chrome.windows.update(tab.windowId, { focused: true });
                }
              });
            });

            addLog(chatUrl, "Limit has RESET! Sending prompt now...");
            updateState(chatUrl, s => { s.status = "sending"; return s; });

            chrome.storage.local.get("soundPref", sp => {
              const sound = sp.soundPref || "chime";

              chrome.tabs.sendMessage(tabId, {
                type: "CHECK_AND_SEND",
                prompt: state.prompt,
                soundPref: sound
              }, result => {
                if (chrome.runtime.lastError || !result) {
                  addLog(chatUrl, "Send failed — will retry next cycle.");
                  updateState(chatUrl, s => { s.status = "checking"; return s; });
                  return;
                }

                if (result.sent) {
                  incrementStat("stats_totalSends");
                  addLog(chatUrl, `✓ Prompt sent successfully! (${result.method || "ok"})`);
                  updateState(chatUrl, s => { s.status = "done"; s.active = false; return s; });

                  const alarmName = "ar-wait-end|" + chatUrl;
                  chrome.alarms.clear(alarmName);

                  chrome.notifications.create({
                    type: "basic",
                    iconUrl: "icons/icon48.png",
                    title: "ChatQueue AI ✓",
                    message: "Your prompt was sent! The AI is responding."
                  });

                  if (sound !== "none") {
                    chrome.tabs.sendMessage(tabId, { type: "PLAY_NOTIFICATION_SOUND", soundPref: sound },
                      () => chrome.runtime.lastError);
                  }

                  chrome.tabs.update(tabId, { active: true });

                } else if (result.reason === "still_limited") {
                  addLog(chatUrl, "Page says still limited. Retrying...");
                  updateState(chatUrl, s => { s.status = "checking"; return s; });
                } else {
                  addLog(chatUrl, `Send failed: ${result.reason}. Retrying...`);
                  updateState(chatUrl, s => { s.status = "checking"; return s; });
                }
              });
            });
          } else {
            addLog(chatUrl, "Cannot type yet. Still waiting...");
          }
        });
      });
    };

    if (wasCreated) {
      ensureTabReady(tabId, ready => {
        if (!ready) {
          addLog(chatUrl, "Created tab load timed out. Retrying next cycle.");
          return;
        }
        setTimeout(() => runCheck(true), 3500);
      });
    } else {
      chrome.tabs.sendMessage(tabId, { type: "CHECK_LIMIT" }, resp => {
        if (chrome.runtime.lastError || !resp) {
          addLog(chatUrl, "Tab not responding. Reloading tab...");
          reloadAndProceed();
        } else {
          runCheck(false);
        }
      });
    }
  });
}

// ── Find or open AI tab ───────────────────────────────────────────────
function cleanUrlForComparison(urlStr) {
  try {
    const u = new URL(urlStr);
    let path = u.pathname.replace(/\/$/, "").toLowerCase();
    return u.hostname.toLowerCase() + path;
  } catch {
    return urlStr ? urlStr.toLowerCase() : "";
  }
}

function findOrOpenTab(chatUrl, callback) {
  try {
    const domain = new URL(chatUrl).hostname;
    const baseDomain = domain.split('.').slice(-2).join('.');
    const queryUrl = `*://*.${baseDomain}/*`;

    chrome.tabs.query({ url: queryUrl }, tabs => {
      const cleanTarget = cleanUrlForComparison(chatUrl);
      const exact = tabs.find(t => {
        if (!t.url) return false;
        const cleanTab = cleanUrlForComparison(t.url);
        return cleanTab === cleanTarget || cleanTab.startsWith(cleanTarget + "/");
      });
      if (exact) { callback(exact.id, false); return; }
      if (tabs[0]) { callback(tabs[0].id, false); return; }
      chrome.tabs.create({ url: chatUrl, active: false }, t => callback(t.id, true));
    });
  } catch (err) {
    chrome.tabs.create({ url: chatUrl, active: false }, t => callback(t.id, true));
  }
}

// ── Ensure tab is fully loaded ────────────────────────────────────────
function ensureTabReady(tabId, callback) {
  chrome.tabs.get(tabId, tab => {
    if (chrome.runtime.lastError || !tab) {
      callback(false);
      return;
    }
    if (tab.status === "complete") {
      callback(true);
    } else {
      let resolved = false;
      const listener = (tid, changeInfo) => {
        if (tid === tabId && changeInfo.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          if (!resolved) {
            resolved = true;
            callback(true);
          }
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        if (!resolved) {
          resolved = true;
          callback(false);
        }
      }, 15000);
    }
  });
}

// ── State helpers ─────────────────────────────────────────────────────
function updateState(chatUrl, mutator, logMsg) {
  if (!chatUrl) return;
  chrome.storage.local.get("queues", d => {
    const queues = d.queues || {};
    const s = queues[chatUrl];
    if (!s) return;
    const updated = mutator(s);
    if (!updated) return;
    if (logMsg) {
      updated.log = updated.log || [];
      updated.log.push(`[${ts()}] ${logMsg}`);
      if (updated.log.length > 80) updated.log = updated.log.slice(-80);
    }
    queues[chatUrl] = updated;
    chrome.storage.local.set({ queues, resumeState: updated }, () => {
      broadcast(updated);
      updateBadge(queues);
    });
  });
}

function addLog(chatUrl, msg) {
  updateState(chatUrl, s => {
    s.log = s.log || [];
    s.log.push(`[${ts()}] ${msg}`);
    if (s.log.length > 80) s.log = s.log.slice(-80);
    return s;
  });
}

function broadcast(state) {
  if (!state) return;
  chrome.tabs.query({}, tabs => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: "STATE_UPDATED", state },
        () => chrome.runtime.lastError);
    }
  });
}

function ts() {
  return new Date().toLocaleTimeString("en-IN", { hour12: false });
}

function updateBadge(queues) {
  if (!queues) {
    chrome.action.setBadgeText({ text: "" });
    return;
  }
  const activeList = Object.values(queues).filter(q => q.active);
  const count = activeList.length;

  if (count === 0) {
    const allQueues = Object.values(queues);
    const finished = allQueues.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0];
    if (finished) {
      if (finished.status === "done") {
        chrome.action.setBadgeText({ text: "DONE" });
        chrome.action.setBadgeBackgroundColor({ color: "#4ade80" });
        return;
      } else if (finished.status === "failed") {
        chrome.action.setBadgeText({ text: "ERR" });
        chrome.action.setBadgeBackgroundColor({ color: "#f87171" });
        return;
      }
    }
    chrome.action.setBadgeText({ text: "" });
    return;
  }

  chrome.action.setBadgeText({ text: `${count}Q` });
  chrome.action.setBadgeBackgroundColor({ color: "#d946ef" });
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name === "chatqueue-keepalive") {
    port.onDisconnect.addListener(() => {});
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get("queues", d => {
    if (!d.queues) {
      chrome.storage.local.set({ queues: {} });
    }
  });
  updateBadge({});
});

// ── Keyboard shortcuts ─────────────────────────────────────────────────
chrome.commands.onCommand.addListener(command => {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs[0];
    if (!tab || !tab.url) return;
    const allowedDomains = ["claude.ai", "chatgpt.com", "gemini.google.com", "deepseek.com"];
    try {
      const parsed = new URL(tab.url);
      if (!allowedDomains.some(d => parsed.hostname.includes(d))) return;

      if (command === "toggle-panel") {
        chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PANEL" },
          () => chrome.runtime.lastError);
      }
      if (command === "toggle-chatqueue") {
        chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_CHATQUEUE" },
          () => chrome.runtime.lastError);
      }
    } catch {}
  });
});

// ── Fast background check loop helper ──────────────────────────────────
let fastBgTimeouts = {};
function scheduleFastBackgroundCheck(chatUrl, ms) {
  if (!chatUrl) return;
  if (fastBgTimeouts[chatUrl]) clearTimeout(fastBgTimeouts[chatUrl]);
  fastBgTimeouts[chatUrl] = setTimeout(() => {
    chrome.storage.local.get("queues", d => {
      const queues = d.queues || {};
      const s = queues[chatUrl];
      if (s && s.active && s.status === "checking") {
        attemptSend(s);
      }
    });
  }, ms);
}

function incrementStat(key) {
  chrome.storage.local.get(key, d => {
    const val = (d[key] || 0) + 1;
    chrome.storage.local.set({ [key]: val });
  });
}

function forceSend(chatUrl) {
  if (!chatUrl) return;
  chrome.storage.local.get("queues", d => {
    const queues = d.queues || {};
    const s = queues[chatUrl];
    if (!s) return;
    
    updateState(chatUrl, state => { state.status = "sending"; return state; }, "Force send requested by user...");
    
    findOrOpenTab(chatUrl, (tabId, wasCreated) => {
      if (!tabId) {
        addLog(chatUrl, "Could not find/open tab for force send.");
        return;
      }
      
      const sendAction = () => {
        chrome.storage.local.get("soundPref", sp => {
          const sound = sp.soundPref || "chime";
          chrome.tabs.sendMessage(tabId, {
            type: "CHECK_AND_SEND",
            prompt: s.prompt,
            soundPref: sound,
            force: true
          }, result => {
            if (chrome.runtime.lastError || !result) {
              addLog(chatUrl, "Force send failed: tab unresponsive.");
              updateState(chatUrl, state => { state.status = "checking"; return state; });
              return;
            }
            if (result.sent) {
              incrementStat("stats_totalSends");
              addLog(chatUrl, `✓ Prompt sent via Force Send!`);
              updateState(chatUrl, state => { state.status = "done"; state.active = false; return state; });
              
              const alarmName = "ar-wait-end|" + chatUrl;
              chrome.alarms.clear(alarmName);
              
              chrome.notifications.create({
                type: "basic",
                iconUrl: "icons/icon48.png",
                title: "ChatQueue AI ✓",
                message: "Your prompt was force sent!"
              });
              if (sound !== "none") {
                chrome.tabs.sendMessage(tabId, { type: "PLAY_NOTIFICATION_SOUND", soundPref: sound }, () => chrome.runtime.lastError);
              }
              chrome.tabs.update(tabId, { active: true });
            } else {
              addLog(chatUrl, `Force send failed: ${result.reason || "unknown"}.`);
              updateState(chatUrl, state => { state.status = "checking"; return state; });
            }
          });
        });
      };
      
      if (wasCreated) {
        ensureTabReady(tabId, ready => {
          if (!ready) {
            addLog(chatUrl, "Tab load timed out for force send.");
            return;
          }
          setTimeout(sendAction, 3500);
        });
      } else {
        sendAction();
      }
    });
  });
}

function reloadQueueTab(chatUrl) {
  if (!chatUrl) return;
  findOrOpenTab(chatUrl, (tabId, wasCreated) => {
    if (tabId && !wasCreated) {
      chrome.tabs.reload(tabId, { bypassCache: true }, () => {
        addLog(chatUrl, "Tab manually reloaded by user.");
      });
    } else {
      addLog(chatUrl, "Opening tab to load/reload...");
    }
  });
}
