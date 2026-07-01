document.addEventListener("DOMContentLoaded", () => {
  chrome.storage.local.get("printChatData", d => {
    const chat = d?.printChatData;
    if (!chat) return;
    
    document.getElementById("chatTitle").textContent = chat.title || "Untitled Chat";
    document.getElementById("chatMeta").textContent = `Title: ${chat.title || "Untitled Chat"} | ID: ${chat.uuid} | Exported: ${new Date().toLocaleString()}`;
    
    // Render Artifacts
    const artifacts = extractArtifacts(chat.messages);
    const artContainer = document.getElementById("chatArtifacts");
    if (artifacts.length > 0) {
      artContainer.innerHTML = `
        <div style="margin-bottom: 30px; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; background: #fdf4ff; page-break-inside: avoid;">
          <h2 style="color: #c026d3; font-size: 15px; margin-top: 0; border-bottom: 1px solid #f5d0fe; padding-bottom: 8px; margin-bottom: 15px;">📎 Recycled Artifacts & Documents (${artifacts.length})</h2>
          ${artifacts.map(art => `
            <div class="art-box">
              <div class="art-title">📄 ${escapeHtml(art.title)}</div>
              <div class="art-type">Type: ${escapeHtml(art.type)}</div>
              <pre class="art-content">${escapeHtml(art.content)}</pre>
            </div>
          `).join("")}
        </div>
      `;
    }
    
    // Render Messages
    const msgContainer = document.getElementById("chatHistory");
    msgContainer.innerHTML = chat.messages.map(m => {
      const isHuman = m.role === "human";
      const border = isHuman ? "#d946ef" : "#3b82f6";
      const bg = isHuman ? "#fdf4ff" : "#f9fafb";
      const color = isHuman ? "#c026d3" : "#2563eb";
      const label = isHuman ? "Human" : "Assistant";
      const labelClass = isHuman ? "label-human" : "label-assistant";
      const typeClass = isHuman ? "msg-human" : "msg-assistant";
      return `
        <div class="msg ${typeClass}">
          <div class="label ${labelClass}">${label}</div>
          <div class="text">${escapeHtml(m.text)}</div>
        </div>
      `;
    }).join("");
    
    // Bind print button
    document.getElementById("btnPrint").onclick = () => {
      window.print();
    };
    
    // Auto print
    setTimeout(() => {
      window.print();
    }, 500);
  });
});

function extractArtifacts(messages) {
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

function escapeHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
