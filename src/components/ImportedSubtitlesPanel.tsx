import { useRef, useState } from "react";

import type { TranscriptChunk, Transcriber } from "../hooks/useTranscriber";
import { chunksToCues, filterValidChunks } from "../utils/subtitleCues";
import { sendSubtitlesToActiveTab } from "../extension/overlayTab";

type ChunkList = TranscriptChunk[];

type ImportedRecord = {
    id: string;
    fileName: string;
    createdAt: number;
    chunks: ChunkList;
};

function buildTextFromChunks(chunks: ChunkList): string {
    return chunks.map((chunk) => chunk.text?.trim() ?? "").join(" ").trim();
}

function formatTime(seconds: number): string {
    if (typeof seconds !== "number" || !isFinite(seconds)) seconds = 0;
    const totalMs = Math.round(seconds * 1000);
    const ms = totalMs % 1000;
    const totalSec = Math.floor(totalMs / 1000);
    const s = totalSec % 60;
    const m = Math.floor((totalSec % 3600) / 60);
    const h = Math.floor(totalSec / 3600);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function jsonToSrt(json: ReturnType<typeof filterValidChunks>): string {
    const lines: string[] = [];
    for (let i = 0; i < json.length; i++) {
        const seg = json[i];
        const start = formatTime(Number(seg.timestamp[0]));
        const end = formatTime(Number(seg.timestamp[1] ?? seg.timestamp[0]));
        const text = (seg.text || "").trim().replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        const tr = (seg as { translation?: string }).translation?.trim();
        lines.push(String(i + 1));
        lines.push(`${start} --> ${end}`);
        lines.push(text);
        if (tr) lines.push(tr);
        lines.push("");
    }
    return lines.join("\n").trim() + "\n";
}

function parseSrtTime(value: string): number {
    const match = value.trim().match(/^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/);
    if (!match) return 0;
    const [, h, m, s, ms] = match;
    return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
}

function parseSrt(content: string): ChunkList {
    const blocks = content
        .replace(/\r/g, "")
        .split(/\n{2,}/)
        .map((block) => block.trim())
        .filter(Boolean);

    const chunks: ChunkList = [];
    for (const block of blocks) {
        const lines = block.split("\n").map((line) => line.trim());
        const timeLine = lines.find((line) => line.includes("-->"));
        if (!timeLine) continue;
        const [startText, endText] = timeLine.split("-->").map((part) => part.trim());
        const payloadLines = lines.slice(lines.indexOf(timeLine) + 1).filter(Boolean);
        if (payloadLines.length === 0) continue;
        chunks.push({
            text: payloadLines[0],
            translation: payloadLines.slice(1).join("\n"),
            timestamp: [parseSrtTime(startText), parseSrtTime(endText)],
        });
    }
    return chunks;
}

function parseImportedChunks(fileName: string, content: string): ChunkList {
    const lowerName = fileName.toLowerCase();
    if (lowerName.endsWith(".json")) {
        const parsed = JSON.parse(content) as unknown;
        if (!Array.isArray(parsed)) {
            throw new Error("JSON 字幕文件必须是数组。");
        }
        return parsed.map((item) => {
            const chunk = item as {
                text?: unknown;
                translation?: unknown;
                timestamp?: unknown;
                originalText?: unknown;
                correctionNote?: unknown;
            };
            if (
                !Array.isArray(chunk.timestamp) ||
                typeof chunk.timestamp[0] !== "number" ||
                typeof chunk.timestamp[1] !== "number"
            ) {
                throw new Error("JSON 字幕文件中的 timestamp 格式不正确。");
            }
            return {
                text: typeof chunk.text === "string" ? chunk.text : "",
                translation: typeof chunk.translation === "string" ? chunk.translation : "",
                originalText:
                    typeof chunk.originalText === "string" ? chunk.originalText : "",
                correctionNote:
                    typeof chunk.correctionNote === "string" ? chunk.correctionNote : "",
                timestamp: [chunk.timestamp[0], chunk.timestamp[1]],
            };
        });
    }
    if (lowerName.endsWith(".srt")) {
        return parseSrt(content);
    }
    throw new Error("目前仅支持导入 JSON 或 SRT 字幕文件。");
}

function hasBilingualTranslation(chunks: ChunkList): boolean {
    return chunks.some((chunk) => Boolean(chunk.translation?.trim()));
}

function formatHistoryTime(ts: number) {
    try {
        return new Date(ts).toLocaleString("zh-CN", {
            month: "numeric",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        });
    } catch {
        return "";
    }
}

export function ImportedSubtitlesPanel(props: { transcriber: Transcriber }) {
    const inputRef = useRef<HTMLInputElement>(null);
    const [records, setRecords] = useState<ImportedRecord[]>([]);
    const [overlayHint, setOverlayHint] = useState<string | null>(null);

    const saveBlob = (blob: Blob, filename: string) => {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        link.click();
        URL.revokeObjectURL(url);
    };

    const exportChunks = (
        chunks: ChunkList,
        filenameBase: string,
        format: "srt" | "txt" | "json",
    ) => {
        if (format === "srt") {
            saveBlob(
                new Blob([jsonToSrt(filterValidChunks(chunks))], { type: "text/srt" }),
                `${filenameBase}.srt`,
            );
            return;
        }
        if (format === "txt") {
            const lines = chunks.map((chunk) => {
                const text = chunk.text.trim();
                const translation = chunk.translation?.trim();
                return translation ? `${text}\n${translation}` : text;
            });
            saveBlob(
                new Blob([lines.filter(Boolean).join("\n\n")], { type: "text/plain" }),
                `${filenameBase}.txt`,
            );
            return;
        }
        saveBlob(
            new Blob([JSON.stringify(chunks, null, 2)], {
                type: "application/json",
            }),
            `${filenameBase}.json`,
        );
    };

    const sendToPage = async (chunks: ChunkList) => {
        setOverlayHint(null);
        const cues = chunksToCues(chunks);
        if (cues.length === 0) {
            setOverlayHint("没有可发送的字幕片段。");
            return;
        }
        const translated = hasBilingualTranslation(chunks);
        const result = await sendSubtitlesToActiveTab(cues, {
            sourceLang: "auto",
            targetLang: "zh-CN",
            translationService: translated
                ? "qwen-local"
                : props.transcriber.subtitleTranslateService,
        });
        if (!result.ok) {
            setOverlayHint(result.error);
            return;
        }
        setOverlayHint(
            translated
                ? "已把导入的双语字幕发送到页面。"
                : "已把导入的字幕发送到页面；若无现成译文，页面会继续按在线翻译流程处理。",
        );
    };

    return (
        <section className='rounded-2xl border border-slate-200/80 bg-white/90 p-5 shadow-lg shadow-slate-200/50 backdrop-blur-sm'>
            <input
                ref={inputRef}
                type='file'
                accept='.json,.srt'
                className='hidden'
                onChange={async (event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (!file) return;
                    try {
                        const content = await file.text();
                        const chunks = parseImportedChunks(file.name, content);
                        setRecords((prev) => [
                            {
                                id: crypto.randomUUID(),
                                fileName: file.name,
                                createdAt: Date.now(),
                                chunks,
                            },
                            ...prev,
                        ]);
                    } catch (error) {
                        alert(
                            error instanceof Error ? error.message : "导入字幕失败。",
                        );
                    }
                }}
            />

            <div className='mb-4 flex items-start justify-between gap-4'>
                <div>
                    <h2 className='text-lg font-semibold tracking-tight text-slate-900'>
                        手动导入字幕
                    </h2>
                    <p className='mt-1 text-xs text-slate-500'>
                        导入现成的 `JSON` 或 `SRT` 字幕文件，并直接发送到页面展示。
                    </p>
                </div>
                <button
                    type='button'
                    onClick={() => inputRef.current?.click()}
                    className='inline-flex items-center rounded-md bg-sky-600 px-3 py-2 text-xs font-medium text-white hover:bg-sky-700'
                >
                    导入字幕文件
                </button>
            </div>

            <div className='mb-4 rounded-xl border border-amber-100 bg-amber-50/80 px-4 py-3'>
                <p className='text-sm font-medium text-amber-900'>推荐流程</p>
                <p className='mt-1 text-xs text-amber-800'>
                    如果你追求更高质量，建议先在「转写结果」里导出原始字幕文件，再交给更强的大模型做修正和翻译，最后把处理好的字幕通过这里导入并发送到页面。
                </p>
            </div>

            {records.length === 0 ? (
                <p className='rounded-xl border border-dashed border-slate-200 bg-slate-50 px-4 py-5 text-sm text-slate-400'>
                    还没有导入字幕文件。
                </p>
            ) : (
                <ul className='space-y-2'>
                    {records.map((record) => (
                        <li
                            key={record.id}
                            className='rounded-xl border border-slate-200/90 bg-white p-3 shadow-sm'
                        >
                            <div className='flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between'>
                                <div className='min-w-0 flex-1'>
                                    <div className='text-sm font-semibold text-slate-900'>
                                        [导入] {record.fileName}
                                    </div>
                                    <div className='mt-0.5 text-xs text-slate-500'>
                                        {formatHistoryTime(record.createdAt)}
                                    </div>
                                    <div className='mt-1 line-clamp-2 text-xs text-slate-600'>
                                        {buildTextFromChunks(record.chunks).slice(0, 96) || "（无文本）"}
                                    </div>
                                </div>
                                <div className='flex shrink-0 flex-wrap items-center justify-end gap-1'>
                                    <button
                                        type='button'
                                        onClick={() => void sendToPage(record.chunks)}
                                        className='inline-flex items-center rounded-md bg-pink-600 px-2 py-1 text-xs font-medium text-white hover:bg-pink-700'
                                    >
                                        发送字幕
                                    </button>
                                    <div className='relative group'>
                                        <button
                                            type='button'
                                            className='inline-flex items-center rounded-md bg-emerald-600 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-700'
                                        >
                                            导出
                                        </button>
                                        <div className='invisible absolute right-0 top-full z-10 mt-1 min-w-24 rounded-lg border border-slate-200 bg-white p-1 opacity-0 shadow-lg transition group-hover:visible group-hover:opacity-100'>
                                            <button
                                                type='button'
                                                onClick={() =>
                                                    exportChunks(record.chunks, "imported-subtitles", "srt")
                                                }
                                                className='block w-full rounded-md px-3 py-2 text-left text-xs text-slate-700 hover:bg-slate-50'
                                            >
                                                SRT
                                            </button>
                                            <button
                                                type='button'
                                                onClick={() =>
                                                    exportChunks(record.chunks, "imported-subtitles", "txt")
                                                }
                                                className='block w-full rounded-md px-3 py-2 text-left text-xs text-slate-700 hover:bg-slate-50'
                                            >
                                                TXT
                                            </button>
                                            <button
                                                type='button'
                                                onClick={() =>
                                                    exportChunks(record.chunks, "imported-subtitles", "json")
                                                }
                                                className='block w-full rounded-md px-3 py-2 text-left text-xs text-slate-700 hover:bg-slate-50'
                                            >
                                                JSON
                                            </button>
                                        </div>
                                    </div>
                                    <button
                                        type='button'
                                        onClick={() =>
                                            setRecords((prev) =>
                                                prev.filter((item) => item.id !== record.id),
                                            )
                                        }
                                        className='rounded-md px-2 py-1 text-xs text-slate-400 hover:bg-rose-50 hover:text-rose-600'
                                    >
                                        删除
                                    </button>
                                </div>
                            </div>
                        </li>
                    ))}
                </ul>
            )}

            {overlayHint && (
                <p className='mt-3 border-t border-slate-100 pt-3 text-center text-xs text-slate-600'>
                    {overlayHint}
                </p>
            )}
        </section>
    );
}
