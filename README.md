<p align="center">
  <img src="client/assets/icon.png" width="128" height="128" alt="WebDavClient Logo" />
</p>

# WebDavClient - 极简全能的私有云盘助手

> **打破设备界限，用最安全、优雅的方式管理你的数字资产。**
> A secure, beautiful, cross-platform file manager for Local & WebDAV drives.

![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Android%20%7C%20Web-lightgrey.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Security](https://img.shields.io/badge/security-AES--256%20Encrypted-green.svg)

## ✨ 核心特性 (Features)

WebDavClient 是一个集高颜值与高安全性于一体的跨平台文件管理工具。支持 **macOS / Windows 桌面端**、**Android 移动端** 以及 **Web 网页端**。

### 🎨 极致 UI 设计
*   **无边框悬浮岛 (Floating Island)**：侧边栏采用大圆角悬浮设计，配合磨砂玻璃背景，视觉体验轻盈通透。
*   **灵动操作栏 (Dynamic Action Bar)**：底部功能区随选中状态智能交互，常用操作（重命名、删除、移动）一触即达。
*   **自适应响应式**：
    *   **桌面端**：高效多列网格 + 悬浮侧栏。
    *   **移动端**：原生级沉浸式体验，支持触控手势。
*   **国际化**：内置中英双语，自动跟随系统或手动切换。

### 🚀 强大的文件管理
*   **多源聚合**：
    *   **本地存储**：直接管理本机文件系统。
    *   **WebDAV 挂载**：完美支持坚果云、Alist、Nextcloud、NAS 等任意 WebDAV 协议网盘。
*   **全能预览**：
    *   图片、PDF、代码文本直接查看。
    *   视频/音频流式播放，无需完全下载。
*   **跨盘流转**：支持在不同网盘（如本地与坚果云）之间直接**复制/移动**文件，进度实时显示。
*   **智能拖拽**：桌面端支持文件拖拽上传、下载及文件夹整理。

### 🛡️ 企业级安全 (New!)
*   **零信任存储**：所有网盘密码在写入磁盘前均经过 **AES-256** 高强度加密。
*   **接口脱敏**：前后端通信自动抹除敏感凭据，防止中间人攻击或网络抓包泄露。
*   **移动端安全**：Android/iOS 端采用系统级加密或应用层高强度混淆存储，防止 Root/越狱设备读取。
*   **隐私优先**：完全本地化运行，没有任何云端服务器中转您的数据。

---

## 🛠️ 技术栈 (Tech Stack)

*   **Core**: React 18, Vite, Tailwind CSS, Framer Motion.
*   **Desktop**: Electron (macOS/Windows/Linux).
*   **Mobile**: Capacitor (Android/iOS) + Native Plugins.
*   **Server**: Node.js + Express (Web模式 / 桌面端后台).
*   **Crypto**: Node.js Crypto / CryptoJS / Web Crypto API.

---

## ⚡ 快速开始 (Getting Started)

### 开发环境
*   Node.js (v18+)

### 1. 安装依赖
```bash
npm run install-all
```

### 2. 启动开发模式
```bash
# 启动 Web 端 + 服务端
npm run dev

# 启动 Electron 桌面端
npm run electron:dev
```

### 3. 构建发布
```bash
# 构建 Web
npm run build

# 构建 Electron 应用 (macOS/Windows)
npm run electron:build

# 构建 Android 应用
cd client && npx cap run android
```

---

## 📖 常见问题

**Q: 为什么选择 WebDAV?**
A: WebDAV 是最通用的文件协议，几乎所有 NAS (群晖/极空间) 和网盘 (坚果云) 都支持。通过 WebDavClient，你可以将它们像本地文件夹一样管理。

**Q: 移动端支持哪些功能?**
A: 移动端支持与桌面端完全一致的文件管理功能，并且通过底层 Native 优化，支持直连 WebDAV 服务器，速度更快。

---

## 📄 开源协议

MIT License.