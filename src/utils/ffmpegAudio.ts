/**
 * 用 ffmpeg.wasm 从视频/任意容器（mkv、mp4、mov、ts、flv 等）中抽取音轨。
 *
 * 采用单线程 core（约 2.6MB），不依赖 SharedArrayBuffer / COOP-COEP。
 * core 与 wasm 通过 `?url` 变成同源资产，满足扩展的严格 CSP：
 *   script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'
 */

import { FFmpeg } from "@ffmpeg/ffmpeg";
// 只用 @ffmpeg/core 的 exports 暴露的入口（`.` 与 `./wasm`），
// `?url` 让它们成为同源静态资产
import coreURL from "@ffmpeg/core?url";
import wasmURL from "@ffmpeg/core/wasm?url";
import Constants from "./Constants";

export type ExtractedAudio = { pcm: Float32Array; sampleRate: number };

let ffmpegPromise: Promise<FFmpeg> | null = null;

function loadFFmpeg(): Promise<FFmpeg> {
    if (!ffmpegPromise) {
        ffmpegPromise = (async () => {
            const ffmpeg = new FFmpeg();
            await ffmpeg.load({ coreURL, wasmURL });
            return ffmpeg;
        })().catch((error) => {
            // 加载失败时清空，允许下次重试
            ffmpegPromise = null;
            throw error;
        });
    }
    return ffmpegPromise;
}

function guessInputName(file: File): string {
    const match = /\.([a-z0-9]{1,5})$/i.exec(file.name || "");
    const ext = match ? match[1].toLowerCase() : "bin";
    return `input.${ext}`;
}

// 单个 wasm 实例无法并发执行，串行化所有任务（批量时逐个处理）
let queue: Promise<unknown> = Promise.resolve();

export function isFfmpegLoaded(): boolean {
    return ffmpegPromise !== null;
}

export async function extractAudioWithFfmpeg(
    file: File,
    onProgress?: (progress: number) => void,
): Promise<ExtractedAudio> {
    const run = queue.then(async () => {
        const ffmpeg = await loadFFmpeg();
        const inputName = guessInputName(file);
        const outputName = "output.f32le";

        const handleProgress = ({ progress }: { progress: number }) => {
            if (Number.isFinite(progress)) {
                onProgress?.(Math.min(Math.max(progress, 0), 1));
            }
        };

        ffmpeg.on("progress", handleProgress);
        try {
            await ffmpeg.writeFile(
                inputName,
                new Uint8Array(await file.arrayBuffer()),
            );
            const code = await ffmpeg.exec([
                "-i",
                inputName,
                "-vn",
                "-ac",
                "1",
                "-ar",
                String(Constants.SAMPLING_RATE),
                "-f",
                "f32le",
                "-acodec",
                "pcm_f32le",
                outputName,
            ]);
            if (code !== 0) {
                throw new Error("ffmpeg 无法从这个文件中提取音频轨道。");
            }

            const output = await ffmpeg.readFile(outputName);
            const bytes =
                typeof output === "string"
                    ? new TextEncoder().encode(output)
                    : output;
            // 复制出对齐的独立 buffer，脱离 wasm 内存
            const aligned = bytes.slice();
            const pcm = new Float32Array(
                aligned.buffer,
                0,
                Math.floor(aligned.byteLength / 4),
            );
            if (pcm.length === 0) {
                throw new Error("这个文件里没有可用的音频轨道。");
            }
            onProgress?.(1);
            return { pcm, sampleRate: Constants.SAMPLING_RATE };
        } finally {
            ffmpeg.off("progress", handleProgress);
            await ffmpeg.deleteFile(inputName).catch(() => undefined);
            await ffmpeg.deleteFile(outputName).catch(() => undefined);
        }
    });

    // 无论成功失败都保持队列串行
    queue = run.catch(() => undefined);
    return run;
}
