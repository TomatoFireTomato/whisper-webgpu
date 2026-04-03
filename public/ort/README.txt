本目录用于存放 ONNX Runtime Web（JSEP / WebGPU）的 WASM 静态文件，避免运行时从 CDN 下载。

请手动下载并放入本目录（文件名需与下列一致；若升级 @huggingface/transformers，请按新版本重新下载）。

一、版本
  当前项目依赖版本见：node_modules/@huggingface/transformers/package.json 的 "version" 字段。
  下文以 VERSION 表示该版本号（例如 3.8.1）。

二、下载地址（任选其一）
  1) 浏览器打开下列目录，按需保存文件到本目录：
     https://cdn.jsdelivr.net/npm/@huggingface/transformers@VERSION/dist/
  2) 国内镜像（若可用）：
     https://registry.npmmirror.com/@huggingface/transformers/VERSION/files/dist/

三、至少需要的文件（名称以官方 dist 为准）
  - ort-wasm-simd-threaded.jsep.mjs
  - ort-wasm-simd-threaded.jsep.wasm
  若模型较大，可能还有分片，例如：
  - ort-wasm-simd-threaded.jsep.wasm_0
  请打开浏览器开发者工具 → Network，若仍有缺失，按报错 URL 补全同名文件。

四、说明
  - 路径由 worker 中 import.meta.url 解析为 /ort/（开发）或构建产物根目录下的 ort/。
  - 放入文件后执行 npm run build，Chrome 扩展请重新加载 dist。
