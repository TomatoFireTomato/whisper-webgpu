# Sidebar Whisper 使用教程

**Sidebar Whisper** 是一款 Chrome 扩展：在**侧边栏**里用浏览器本地的 **Whisper + WebGPU** 做语音转文字，音频与转写过程**默认不离开你的设备**（模型与推理在本地完成）。

---

## 一、使用前准备

1. **浏览器**：建议使用 **Chrome** 或 **Edge**（Chromium 系），版本 **≥ 120**，且已开启 **WebGPU**。  
   - 若打开扩展后提示「不支持 WebGPU」，请更新浏览器或换用上述浏览器。

2. **安装扩展**（任选一种）：
   - **开发者模式加载**：解压构建产物中的 `dist` 文件夹 → 打开 `chrome://extensions` → 打开「开发者模式」→ **加载已解压的扩展程序** → 选择该 `dist` 目录。  
   - **从 GitHub 下载构建包**：仓库 **Releases** 下载 **`sidebar-whisper-dist.zip`**，解压后同上加载其中的 `dist`；也可以在 **Actions** → 最新成功的 **Build** → 底部 **Artifacts** 下载构建产物。

3. **打开方式**：点击浏览器工具栏上的扩展图标，会在**侧边栏**打开 Sidebar Whisper（无需新开标签页）。

---

## 二、准备音频

1. **本地文件**：在「音频」区域 **点击或拖拽** 常见音频格式（如 mp3、wav、m4a 等）。

2. **在线视频**：扩展内不直接解析视频站链接。请先到 [Cobalt](https://cobalt.tools/) 等工具页面，粘贴视频链接并**只下载音频**，再回到本扩展上传下载好的文件。请遵守第三方服务与内容的版权规定。

---

## 三、转写设置（左侧「转写配置」）

- **模型**：按需选择体积与速度；设备内存/显存紧张时可先试较小模型。  
- **多语言模式**：开启后可选择**源语言**；关闭时按英文等默认逻辑。  
- **Hugging Face 镜像**：国内访问模型较慢时，可开启镜像加速下载。  
- **字幕翻译服务**：向 B 站页面发送双语字幕时，会使用此处选择的翻译后端（如 Bing、Google 等）；默认一般为 Bing。

设置会保存在本机浏览器，关闭侧边栏后再打开仍会保留。

---

## 四、开始转写

1. 选好音频并确认设置后，点击 **「开始转写」**（或同类按钮）。  
2. **首次使用**某模型时，需要从网络拉取模型文件，请耐心等待；进度会在界面中显示。  
3. 转写过程中可看到实时片段；完成后会显示速度与完整结果。

---

## 五、查看与管理结果

- **转写结果**以**列表**展示：每条记录一行，默认**收起**详细时间轴；点击左侧区域可**展开**查看逐句与时间戳。  
- **历史记录**会缓存在本地（不含音频），可展开列表、点击加载、删除单条或清空。  
- 每条记录右侧可 **导出 SRT / TXT / JSON**，或将字幕 **发送到当前标签页**（适用于 B 站等已适配页面；发送后会按播放进度叠加字幕，翻译在后台分批进行）。

---

## 六、常见问题

| 现象 | 建议 |
|------|------|
| 提示不支持 WebGPU | 换用最新 Chrome/Edge，检查 `chrome://gpu` |
| 转写报错或浏览器卡死 | 换更小模型、关闭占用 GPU 的页面、减少同时打开的标签 |
| 发送到网页无反应 | 确认当前标签为支持页面（如 B 站视频页），并已允许扩展访问该站 |
| 字幕翻译很慢 | 属正常现象；可先看到原文，译文会随进度更新 |

---

## 七、开发者与本仓库

本地开发与构建：

```bash
npm install
npm run dev          # 开发调试
npm run build        # 生成 dist，用于加载扩展
```

- **GitHub Actions**：
  - 推送到 `main` 会执行构建，并上传 **`sidebar-whisper-dist`** 与 **`sidebar-whisper-dist.zip`**；
  - 推送标签（如 `v1.0.0`）会自动创建 GitHub Release，并附带 **`sidebar-whisper-dist.zip`**；
  - `main` 分支推送/手动运行时同时部署 GitHub Pages，用于在线预览构建结果。
- 技术栈：基于 [Transformers.js](https://github.com/xenova/transformers.js) 与 Whisper 模型在浏览器中推理。

## 八、扩展 ID 与发布建议

### 1. 固定扩展 ID

为了让用户在**更新插件后尽量复用模型缓存**，必须长期保持**同一个扩展 ID**。

本仓库已支持通过构建环境变量 `EXTENSION_PUBLIC_KEY` 注入 `manifest.json` 中的 `key` 字段：

1. 在 Chrome Web Store Developer Dashboard 创建扩展条目；  
2. 获取该扩展的 **public key**；  
3. 在 GitHub 仓库的 **Settings → Secrets and variables → Actions** 中新增 secret：`EXTENSION_PUBLIC_KEY`；  
4. GitHub Actions 构建时会自动把该公钥写入 `manifest.json`，从而固定扩展 ID。  

如果本地手动构建，也可以先在 shell 中导出：

```bash
export EXTENSION_PUBLIC_KEY='你的扩展公钥'
npm run build
```

### 2. 推荐发布方式

最适合长期给别人使用的方式是：

1. **正式版**：发布到 **Chrome Web Store**  
   - 用户自动更新；
   - 扩展 ID 稳定；
   - 更新后更有机会继续使用已缓存的模型文件。

2. **预览版 / 测试版**：使用 **GitHub Release**  
   - 给测试用户下载 `sidebar-whisper-dist.zip`；
   - 适合快速验证新功能；
   - 不建议把“手动下载并覆盖安装”作为长期正式更新方式。

### 3. 建议的发布流程

日常开发：

```bash
git push origin main
```

发布测试包：

```bash
git tag v1.0.0
git push origin v1.0.0
```

之后 GitHub Actions 会自动：

1. 构建扩展；
2. 打包 `sidebar-whisper-dist.zip`；
3. 创建对应的 GitHub Release；
4. 把 zip 附件挂到 Release 页面；
5. 如果已配置 Chrome Web Store 发布凭据，则自动上传并发布到商店。

正式发布时：

1. 打 tag 并推送；
2. GitHub Actions 自动构建 Release；
3. 若已配置商店发布凭据，则自动上传到 Chrome Web Store 的同一个扩展条目并发布更新。

这样做可以同时兼顾：

- GitHub 上方便下载测试版；
- Chrome Web Store 上稳定更新正式版；
- 扩展 ID 保持不变，模型缓存更容易沿用。

### 4. 一键发包到 Chrome Web Store

本仓库已经接入了自动发布工作流：推送 `v*` tag 时，除了生成 GitHub Release，还会在配置完整时自动上传并发布到 Chrome Web Store。

你需要在 GitHub 仓库里配置以下内容：

#### GitHub Secrets

- `EXTENSION_PUBLIC_KEY`
  - 你的 Chrome 扩展 public key，用来固定扩展 ID。

- `CWS_SERVICE_ACCOUNT_JSON`
  - 具有 Chrome Web Store API 权限的 Google Cloud service account JSON。

#### GitHub Repository Variables

- `CWS_EXTENSION_ID`
  - 你的 Chrome 扩展 ID。

- `CWS_PUBLISHER_ID`
  - 你的 Chrome Web Store publisher ID。

#### 发布命令

```bash
git tag v1.0.0
git push origin v1.0.0
```

工作流会自动执行：

1. 构建扩展；
2. 生成 `sidebar-whisper-dist.zip`；
3. 创建 GitHub Release；
4. 上传 zip 附件；
5. 调用 Chrome Web Store API 上传并发布该版本。

如果没有配置 `CWS_SERVICE_ACCOUNT_JSON`、`CWS_EXTENSION_ID` 或 `CWS_PUBLISHER_ID`，工作流会只生成 GitHub Release，不会尝试商店发布。
