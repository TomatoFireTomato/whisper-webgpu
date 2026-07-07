/** 字幕导出相关的共享工具：SRT 生成、文件下载、文件名处理 */

import { filterValidChunks, type SubtitleChunk } from "./subtitleCues";

export function formatSrtTime(seconds: number): string {
    if (typeof seconds !== "number" || !isFinite(seconds)) seconds = 0;
    const totalMs = Math.round(seconds * 1000);
    const ms = totalMs % 1000;
    const totalSec = Math.floor(totalMs / 1000);
    const s = totalSec % 60;
    const m = Math.floor((totalSec % 3600) / 60);
    const h = Math.floor(totalSec / 3600);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

export function chunksToSrt(chunks: SubtitleChunk[]): string {
    const filtered = filterValidChunks(chunks);
    const lines: string[] = [];
    for (let i = 0; i < filtered.length; i++) {
        const seg = filtered[i];
        const start = formatSrtTime(Number(seg.timestamp[0]));
        const end = formatSrtTime(Number(seg.timestamp[1] ?? seg.timestamp[0]));
        const text = (seg.text || "")
            .trim()
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "\n");
        const translation = seg.translation?.trim();
        lines.push(String(i + 1));
        lines.push(`${start} --> ${end}`);
        lines.push(text);
        if (translation) lines.push(translation);
        lines.push("");
    }
    return lines.join("\n").trim() + "\n";
}

export function saveBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
}

/** 去掉文件扩展名，作为导出字幕的基础名 */
export function stripFileExtension(name: string): string {
    return name.replace(/\.[^./\\]+$/, "") || name;
}
