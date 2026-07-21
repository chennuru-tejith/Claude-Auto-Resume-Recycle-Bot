// ChatQueue AI - Main World Fetch Interceptor
// Injected natively by Chrome in the MAIN world to intercept and delay delete requests for conversation backup.

(function() {
  try {
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
      const url = args[0];
      const options = args[1];
      if (typeof url === 'string' && url.includes('/api/organizations/') && url.includes('/chats/') && options && options.method === 'DELETE') {
        const match = url.match(/\/chats\/([0-9a-fA-F-]+)/);
        if (match) {
          const chatId = match[1];
          window.postMessage({ type: 'CLAUDE_CHAT_DELETING', chatId }, '*');
          // Delay the actual delete request by 500ms to allow background pre-fetch to save history
          await new Promise(r => setTimeout(r, 500));
        }
      }
      return originalFetch.apply(this, args);
    };
  } catch (err) {
    console.log("ChatQueue AI: Main world fetch interceptor initialization error:", err);
  }
})();
