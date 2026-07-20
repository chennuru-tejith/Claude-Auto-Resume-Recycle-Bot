# ⏱️ ChatQueue AI: Ultimate Auto-Resume Queue & Backup Hub for AI Chatbots

[![GitHub license](https://img.shields.io/github/license/chennuru-tejith/Claude-Chat-Resume-Bot?style=for-the-badge&color=7c3aed)](https://github.com/chennuru-tejith/Claude-Chat-Resume-Bot/blob/main/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/chennuru-tejith/Claude-Chat-Resume-Bot?style=for-the-badge&color=10b981)](https://github.com/chennuru-tejith/Claude-Chat-Resume-Bot/stargazers)
[![GitHub issues](https://img.shields.io/github/issues/chennuru-tejith/Claude-Chat-Resume-Bot?style=for-the-badge&color=3b82f6)](https://github.com/chennuru-tejith/Claude-Chat-Resume-Bot/issues)
[![Platform](https://img.shields.io/badge/Platform-Chrome%20%7C%20Edge%20%7C%20Brave%20%7C%20Opera-violet?style=for-the-badge)](#)

> **Recover deleted Claude chats, auto-backup conversations, and auto-submit prompts when rate limits reset! The ultimate local-first browser extension providing a native Recycle Bin, Chat History Backup, and Auto-Resume Queue for Claude, ChatGPT, Gemini, and DeepSeek.**

---

## 🔍 Why You Need ChatQueue AI

### 1. Claude Deleted Chat Recovery (The Missing Recycle Bin)
Anthropic's Claude AI does not provide a backup, restore, or trash bin utility. If you click **Delete chat** by mistake, your conversation is **permanently lost** from their servers. 
**ChatQueue AI** solves this by running a secure, automated background sync that caches your chat threads locally. It injects a native **Recycled Chats** section directly into Claude's sidebar so you can preview, download, or restore deleted chats with a single click.

### 2. Auto-Resume Queue (Bypass Rate Limits)
Tired of hitting "You've reached your usage limit" and waiting around? ChatQueue AI monitors rate limit warnings on Claude, ChatGPT, Gemini, and DeepSeek, reads the reset timers (e.g. *try again after 3:15 PM* or *in 45 minutes*), counts down, and **automatically sends your prompt** the second your limit is cleared.

---

## ⚡️ Key Features

### 🗑️ Claude Recycle Bin & Deleted Chat Recovery
*   **Sidebar Accordion Folder**: Injects a collapsible **Recycled Chats** panel natively inside Claude's sidebar layout. Fully matches the official brown-grey theme.
*   **Background API Sync Caching**: Periodically scans and backs up all your active sidebar conversation histories to local storage via secure, client-side REST requests. No manual actions required!
*   **Instant Pre-Fetching on Delete**: When you click the initial "Delete" option on any chat, the extension pre-fetches the conversation history in the background before you click "Confirm", ensuring a 100% complete backup.
*   **In-Page Dialogue Previews**: Click any recycled chat in the sidebar to open a premium dark overlay modal directly on the page to read your messages.
*   **Native Restore & Copy**: Click the restore icon (`📥`) to copy the conversation history to the clipboard and open a new chat to resume work instantly.
*   **Markdown Export**: Download any recycled chat as a clean `.md` markdown file.

### 🔄 Rate-Limit Auto-Resume & Submit Queue
*   **Universal AI Support**: Works seamlessly on **Claude**, **ChatGPT**, **Gemini**, and **DeepSeek**.
*   **Adaptive Countdown Parsing**: Reads absolute reset times from page banners and calculates retry intervals.
*   **Context-Aware Limit Checking**: Smart logic checks composer placeholders/attributes for rate limit indicators while ignoring temporarily disabled text boxes during active AI generation.
*   **TTS Voice & Audio Alerts**: Plays gentle chimes or speaks voice notifications once your prompt is successfully queued and sent.

---

## 🚀 Installation Guide

### Step 1: Download the Extension
Download the latest release zip package from the repository:
- **[Download ChatQueue AI ZIP Package](chatqueue-ai.zip)**

### Step 2: Install in Google Chrome / Brave / Edge
1.  Extract the downloaded ZIP package to a folder on your computer.
2.  Open your browser and navigate to the extensions page (e.g., `chrome://extensions/` for Chrome or `brave://extensions/` for Brave).
3.  Enable **Developer mode** (toggle in the top-right corner).
4.  Click **Load unpacked** in the top-left corner.
5.  Select the folder containing the extracted extension files.

---

## 🔒 Privacy & Security

*   **100% Local-First**: Your conversation backups, prompt histories, and settings are saved securely in `chrome.storage.local`.
*   **Zero Telemetry**: No tracking, analytics scripts, or third-party servers. All data stays on your machine.
*   **Secure API Fetching**: Uses standard native browser credentials (cookies) in the active tab context. No API keys are required.

---

## 📄 License

This extension is open-source software licensed under the **MIT License**. Check out the [LICENSE](LICENSE) file for details regarding permission, warranty, and copyright.
