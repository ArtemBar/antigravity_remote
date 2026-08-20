# 🚀 Antigravity Remote

High-throughput, unmetered remote access gateway for **Google Antigravity** with **Cloudflare Named Tunnels**, passkey authentication, dynamic port auto-discovery, and a built-in visual **Git Inspector**.

---

## ✨ Features

- 🌐 **Permanent Branded Domain:** Secure public HTTPS via Cloudflare Named Tunnel (`my-antigravity.yourdomain.com`) with **100% unlimited bandwidth** and unmetered throughput.
- 🎯 **Dynamic Port Auto-Discovery:** Automatically discovers and reconnects to Antigravity's active language server backend port across restarts.
- 🔒 **Protected Access:** Built-in dark-mode login card and instant URL token authentication (`?token=SECRET`).
- 🌿 **Built-in Visual Git Inspector:**
  - Word-by-word / character-level intra-line diffs.
  - Multi-project auto-detection in `~/dev`.
  - File-by-file collapsible diff cards with **Expand All** / **Collapse All** controls.
  - Full interactive commit history inspection.
  - Resizable and Fullscreen floating drawer inside the Antigravity web UI.
  - Full UTF-8 Russian / Cyrillic encoding support.
- ⚡ **Zero External Dependencies:** Built with 100% native Node.js standard libraries (`http`, `https`, `tls`, `zlib`, `child_process`).
- 🧹 **Clean Sockets & Zero Leaks:** gRPC stream lifecycle management with auto-recycling connection pool.

---

## 🚀 Quickstart

### 1. Instant Quick Tunnel (Zero config, no Cloudflare account needed):
```bash
./index.js
```
*Spins up an immediate, secure `https://xxxx.trycloudflare.com` tunnel with auto-generated passkey.*

### 2. Force Quick Tunnel via CLI:
```bash
./index.js --quick
```

### 3. Custom Branded Domain (Cloudflare Named Tunnel):
Copy `.env.example` to `.env` or pass environment variables:
```bash
SECRET_TOKEN="your_passkey" \
CUSTOM_DOMAIN="my-antigravity.yourdomain.com" \
TUNNEL_NAME="antigravity-tunnel" \
./index.js
```
*(Or use CLI flags: `./index.js --domain=my-antigravity.yourdomain.com --password=your_passkey`)*

---

## 🌿 Git Inspector Features

* **Inside Antigravity Web UI:** Click the floating **`[ 🌿 Git Inspector ]`** button in the bottom right corner.
* **Direct Web URL:** `https://my-antigravity.yourdomain.com/__git`
* **Features:**
  - 📂 **Uncommitted Changes:** Real-time diffs with staged vs unstaged tracking.
  - 📜 **Commit History:** Click any past commit to expand its multi-file collapsible diffs.
  - 🔍 **Intra-Word Highlighting:** Added words `<ins>` in green, deleted words `<del>` in red.

---

## 🔒 Security

When stopping the script (`Ctrl + C`):
- Cloudflare Tunnel terminates immediately.
- Local proxy closes port `64650`.
- All public access is instantly severed (Cloudflare returns `530 Origin Unreachable`).

---

## 📄 License
MIT © Artem Barinov
