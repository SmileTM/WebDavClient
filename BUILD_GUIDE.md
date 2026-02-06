# WebDev Client 全平台打包指南

本项目采用 **Web 前端 (React)** + **Node.js 后端** (桌面端) / **原生插件** (移动端) 的混合架构。

## 🛠 前置准备

确保你的开发环境已安装：
1. **Node.js** (v18+)
2. **Git**
3. **macOS 打包:** 需要 macOS 系统。
4. **iOS 打包:** 需要 macOS 系统 + Xcode。
5. **Android 打包:** 需要 Android Studio。

在开始之前，请确保根目录依赖已安装：
```bash
npm install
npm run install-all  # 安装 client 和 server 的所有依赖
```

---

## 🍏 macOS 桌面应用 (Electron)

桌面版会打包完整的 Node.js 服务端，功能最全（无权限限制）。

1. **构建前端与打包:**
   在项目根目录运行以下命令即可自动处理 `sharp` 库依赖并完成打包：
   ```bash
   npm run electron:build:mac
   ```

2. **输出产物:**
   打包完成后，安装包位于 `dist-electron/` 目录下（通常是 `.dmg` 文件）。

3. **开发调试:**
   如果想在开发模式下运行：
   ```bash
   npm run electron:dev
   ```

---

## 📱 iOS 移动应用 (Capacitor)

移动版采用“无 Server”模式，直接调用手机原生接口。

1. **构建前端:**
   ```bash
   cd client
   npm run build
   ```

2. **同步资源到 iOS 工程:**
   ```bash
   npx cap sync ios
   ```

3. **打开 Xcode 进行打包:**
   ```bash
   npx cap open ios
   ```
   *   Xcode 打开后，选择左上角的 `App` 项目。
   *   配置 "Signing & Capabilities" 中的 Team (你需要一个 Apple ID)。
   *   点击顶部 "Play" 按钮在模拟器运行，或选择 "Product" -> "Archive" 进行打包发布。

---

## 🤖 Android 移动应用 (Capacitor)

1. **构建前端:**
   ```bash
   cd client
   npm run build
   ```

2. **同步资源到 Android 工程:**
   ```bash
   npx cap sync android
   ```

3. **打开 Android Studio 进行打包:**
   ```bash
   npx cap open android
   ```
   *   Android Studio 打开后，等待 Gradle Sync 完成。
   *   点击顶部 "Run" (绿三角) 在模拟器/真机运行。
   *   点击 "Build" -> "Generate Signed Bundle / APK" 生成最终安装包。

---

## ⚠️ 常见问题与提示

*   **跨域问题 (CORS):**
    移动端已启用 `CapacitorHttp` 插件，可以直接连接大多数 WebDAV 服务。如果遇到连接失败，请检查 URL 是否正确，或者该 WebDAV 服务是否在防火墙内。

*   **文件权限:**
    *   **Android 11+:** 由于系统限制，App 只能访问自己的沙盒目录或 `Documents` 等公共目录。代码中已配置为默认操作 `Documents`。
    *   **iOS:** 文件存储在 App 的沙盒内，可以通过“文件”App 查看 (需要在 Info.plist 开启文件共享，Capacitor 默认已配置部分)。

*   **图标替换:**
    *   **Electron:** 替换 `build/icon.png` (需自行创建 build 文件夹并配置)。
    *   **Mobile:** 使用 `capacitor-assets` 工具自动生成图标：
        ```bash
        npx @capacitor/assets generate
        ```
