import { useEffect, useMemo, useRef, useState } from "react";

import type {
    TranscriptChunk,
    Transcriber,
    TranscriberData,
} from "../hooks/useTranscriber";
import { chunksToCues, filterValidChunks } from "../utils/subtitleCues";
import { sendSubtitlesToActiveTab } from "../extension/overlayTab";
import type { TranscriptHistoryItem } from "../utils/transcriptHistory";
import Modal from "./modal/Modal";

interface Props {
    transcribedData: TranscriberData | undefined;
    transcriber: Transcriber;
}

type ChunkList = TranscriptChunk[];

type ViewRecord = {
    id: string;
    source: "current" | "history" | "imported";
    title: string;
    createdAt?: number;
    language?: string | null;
    rawText: string;
    rawChunks: ChunkList;
    qwenText: string;
    qwenChunks: ChunkList;
    correctionSummary: string[];
    hasQwenCorrection: boolean;
    hasQwenTranslation: boolean;
    isBusy: boolean;
    isCorrecting: boolean;
    isTranslating: boolean;
    isFinalizing: boolean;
    transcriptionProgress: number;
    correctionProgress: number;
    translationProgress: number;
};

type SendVariant = {
    id: string;
    label: string;
    chunks: ChunkList;
    language?: string | null;
};

function hasBilingualTranslation(chunks: ChunkList): boolean {
    return chunks.some((chunk) => Boolean(chunk.translation?.trim()));
}

function areChunkListsEquivalent(a: ChunkList, b: ChunkList): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        const left = a[i];
        const right = b[i];
        if ((left.text ?? "") !== (right.text ?? "")) return false;
        if ((left.translation ?? "") !== (right.translation ?? "")) return false;
        if ((left.originalText ?? "") !== (right.originalText ?? "")) return false;
        if ((left.correctionNote ?? "") !== (right.correctionNote ?? "")) return false;
        const [ls, le] = left.timestamp ?? [0, null];
        const [rs, re] = right.timestamp ?? [0, null];
        if (ls !== rs || le !== re) return false;
    }
    return true;
}

function mapTranscriptToRecord(
    data: TranscriberData,
    source: "current" | "history" = "current",
    createdAt?: number,
): ViewRecord {
    return {
        id:
            source === "current"
                ? "__current__"
                : `${source}-${createdAt ?? data.title}`,
        source,
        title: data.title,
        createdAt,
        language: data.language ?? null,
        rawText: data.text,
        rawChunks: data.chunks,
        qwenText: data.qwenText,
        qwenChunks: data.qwenChunks,
        correctionSummary: data.correctionSummary,
        hasQwenCorrection: data.hasQwenCorrection,
        hasQwenTranslation: data.hasQwenTranslation,
        isBusy: data.isBusy,
        isCorrecting: data.isCorrecting,
        isTranslating: data.isTranslating,
        isFinalizing: data.isFinalizing,
        transcriptionProgress: data.transcriptionProgress,
        correctionProgress: data.correctionProgress,
        translationProgress: data.translationProgress,
    };
}

function mapHistoryToRecord(item: TranscriptHistoryItem): ViewRecord {
    const qwenChunks = item.qwenChunks ?? [];
    return {
        id: item.id,
        source: "history",
        title: item.fileName,
        createdAt: item.createdAt,
        language: item.language ?? null,
        rawText: item.text,
        rawChunks: item.chunks,
        qwenText: item.qwenText ?? "",
        qwenChunks,
        correctionSummary: item.correctionSummary ?? [],
        hasQwenCorrection:
            item.hasQwenCorrection ?? qwenChunks.length > 0,
        hasQwenTranslation:
            item.hasQwenTranslation ?? hasBilingualTranslation(qwenChunks),
        isBusy: false,
        isCorrecting: false,
        isTranslating: false,
        isFinalizing: false,
        transcriptionProgress: item.transcriptionProgress ?? 100,
        correctionProgress: item.correctionProgress ?? 0,
        translationProgress:
            item.translationProgress ??
            (hasBilingualTranslation(qwenChunks) ? 100 : 0),
    };
}

function getTranslatedChunkPairs(chunks: ChunkList) {
    return chunks
        .map((chunk, index) => ({
            id: index + 1,
            text: chunk.text?.trim() ?? "",
            translation: chunk.translation?.trim() ?? "",
        }))
        .filter((chunk) => chunk.text && chunk.translation);
}

export default function Transcript({ transcribedData, transcriber }: Props) {
    const divRef = useRef<HTMLDivElement>(null);
    const [overlayHint, setOverlayHint] = useState<string | null>(null);
    const [detailModal, setDetailModal] = useState<ViewRecord | null>(null);
    const [openExportMenu, setOpenExportMenu] = useState<string | null>(null);
    const [sendModal, setSendModal] = useState<{
        title: string;
        variants: SendVariant[];
    } | null>(null);

    const saveBlob = (blob: Blob, filename: string) => {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        link.click();
        URL.revokeObjectURL(url);
    };

    const formatTime = (seconds: number): string => {
        if (typeof seconds !== "number" || !isFinite(seconds)) seconds = 0;
        const totalMs = Math.round(seconds * 1000);
        const ms = totalMs % 1000;
        const totalSec = Math.floor(totalMs / 1000);
        const s = totalSec % 60;
        const m = Math.floor((totalSec % 3600) / 60);
        const h = Math.floor(totalSec / 3600);
        return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
    };

    const jsonToSrt = (json: ReturnType<typeof filterValidChunks>): string => {
        const lines: string[] = [];
        for (let i = 0; i < json.length; i++) {
            const seg = json[i];
            const start = formatTime(Number(seg.timestamp[0]));
            const end = formatTime(Number(seg.timestamp[1] ?? seg.timestamp[0]));
            const text = (seg.text || "")
                .trim()
                .replace(/\r\n/g, "\n")
                .replace(/\r/g, "\n");
            const tr = (seg as { translation?: string }).translation?.trim();
            lines.push(String(i + 1));
            lines.push(`${start} --> ${end}`);
            lines.push(text);
            if (tr) lines.push(tr);
            lines.push("");
        }
        return lines.join("\n").trim() + "\n";
    };

    const exportChunks = (
        chunks: ChunkList,
        filenameBase: string,
        format: "srt" | "txt" | "json",
    ) => {
        if (format === "srt") {
            const filteredData = filterValidChunks(chunks);
            const srtData = jsonToSrt(filteredData);
            saveBlob(
                new Blob([srtData], { type: "text/srt" }),
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
                new Blob([lines.filter(Boolean).join("\n\n")], {
                    type: "text/plain",
                }),
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

    const pushSubtitlesToCurrentTab = async (
        chunks: ChunkList,
        language?: string | null,
    ) => {
        setOverlayHint(null);
        const cues = chunksToCues(chunks);
        if (cues.length === 0) {
            setOverlayHint("没有可发送的字幕片段。");
            return;
        }

        const translated = hasBilingualTranslation(chunks);
        setOverlayHint(
            translated
                ? "正在把现成双语字幕发送到页面…"
                : "正在把字幕发送到页面，后续会随播放继续翻译…",
        );

        const sourceLang = language ?? "auto";
        const result = await sendSubtitlesToActiveTab(cues, {
            sourceLang,
            targetLang: "zh-CN",
            translationService: translated
                ? "qwen-local"
                : transcriber.subtitleTranslateService,
        });
        if (!result.ok) {
            setOverlayHint(result.error);
            return;
        }
        setOverlayHint(
            translated
                ? "已在当前页播放器上显示双语字幕。当前发送的是现成字幕文件，不会再额外联网翻译。"
                : "已在当前页播放器上显示字幕。当前文件没有现成译文，页面会继续沿用在线翻译流程。",
        );
    };

    useEffect(() => {
        if (divRef.current) {
            const diff = Math.abs(
                divRef.current.offsetHeight +
                    divRef.current.scrollTop -
                    divRef.current.scrollHeight,
            );
            if (diff <= 100) {
                divRef.current.scrollTop = divRef.current.scrollHeight;
            }
        }
    });

    useEffect(() => {
        const onDocClick = () => setOpenExportMenu(null);
        document.addEventListener("click", onDocClick);
        return () => document.removeEventListener("click", onDocClick);
    }, []);

    const formatHistoryTime = (ts: number) => {
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
    };

    const currentRecord = useMemo(
        () =>
            transcribedData
                ? mapTranscriptToRecord(transcribedData, "current")
                : null,
        [transcribedData],
    );

    const historyRecords = useMemo(() => {
        const mapped = transcriber.transcriptHistory.map(mapHistoryToRecord);
        if (!currentRecord) return mapped;
        return mapped.filter((item, index) => {
            if (currentRecord.source === "current" && transcribedData?.currentHistoryId) {
                return item.id !== transcribedData.currentHistoryId;
            }
            if (index !== 0) return true;
            return !areChunkListsEquivalent(currentRecord.rawChunks, item.rawChunks);
        });
    }, [transcriber.transcriptHistory, currentRecord, transcribedData?.currentHistoryId]);

    const hasAnyRows = Boolean(currentRecord) || historyRecords.length > 0;

    const btnClass =
        "inline-flex items-center rounded-md px-2 py-1 text-xs font-medium transition focus:outline-none focus:ring-2 focus:ring-offset-1";

    const previewText = (record: ViewRecord) => {
        const text = (record.rawText || "").trim();
        return text.length <= 96 ? text || "（无文本）" : `${text.slice(0, 96)}…`;
    };

    const openSendChooser = (record: ViewRecord) => {
        const variants: SendVariant[] = [
            {
                id: "raw",
                label: "原始转写稿",
                chunks: record.rawChunks,
                language: record.language,
            },
        ];
        if (record.hasQwenCorrection && record.qwenChunks.length > 0) {
            variants.push({
                id: "qwen",
                label: record.hasQwenTranslation
                    ? "Qwen 双语稿"
                    : "Qwen 修正版",
                chunks: record.qwenChunks,
                language: record.language,
            });
        }
        if (variants.length === 1) {
            void pushSubtitlesToCurrentTab(
                variants[0].chunks,
                variants[0].language,
            );
            return;
        }
        setSendModal({
            title: `选择发送来源：${record.title}`,
            variants,
        });
    };

    const renderStatusPanel = (record: ViewRecord) => {
        const qwenPairs = getTranslatedChunkPairs(record.qwenChunks);
        return (
            <div className='space-y-4'>
                <div className='grid gap-2 rounded-lg bg-slate-50 p-3 text-xs text-slate-700 sm:grid-cols-2'>
                    <div>
                        <span className='font-semibold text-slate-900'>原始转写：</span>
                        {record.rawChunks.length > 0 ? "已保留" : "无"}
                    </div>
                    <div>
                        <span className='font-semibold text-slate-900'>Qwen 处理：</span>
                        {record.hasQwenTranslation
                            ? "已生成处理稿"
                            : record.isCorrecting || record.isTranslating
                              ? "处理中"
                              : "尚未执行"}
                    </div>
                    <div>
                        <span className='font-semibold text-slate-900'>处理进度：</span>
                        {Math.max(
                            record.correctionProgress,
                            record.translationProgress,
                        )}
                        %
                    </div>
                    <div>
                        <span className='font-semibold text-slate-900'>语言：</span>
                        {record.language || "auto"}
                    </div>
                </div>

                <div>
                    <p className='mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500'>
                        主要修正内容
                    </p>
                    {record.correctionSummary.length > 0 ? (
                        <ul className='space-y-1 text-sm text-slate-700'>
                            {record.correctionSummary.map((item, index) => (
                                <li key={`${index}-${item.slice(0, 16)}`}>- {item}</li>
                            ))}
                        </ul>
                    ) : (
                        <p className='text-sm text-slate-400'>
                            当前还没有可展示的修正摘要。
                        </p>
                    )}
                </div>

                <div>
                    <p className='mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500'>
                        可用文件
                    </p>
                    <div className='rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-700'>
                        <p>原始转写稿始终保留，可以单独导出或发送。</p>
                        <p className='mt-2'>
                            Qwen 处理稿与原始稿分开保存，不会覆盖原始内容。
                        </p>
                    </div>
                </div>

                <div>
                    <p className='mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500'>
                        翻译过程
                    </p>
                    {qwenPairs.length > 0 ? (
                        <div className='max-h-72 space-y-2 overflow-y-auto rounded-lg border border-slate-200 bg-white p-3'>
                            {qwenPairs.map((chunk) => (
                                <div
                                    key={`${chunk.id}-${chunk.text.slice(0, 16)}`}
                                    className='rounded-lg border border-slate-100 bg-slate-50 p-3'
                                >
                                    <p className='mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500'>
                                        片段 {chunk.id}
                                    </p>
                                    <p className='text-sm text-slate-800'>
                                        {chunk.text}
                                    </p>
                                    <p className='mt-2 text-sm text-indigo-700'>
                                        {chunk.translation}
                                    </p>
                                </div>
                            ))}
                        </div>
                    ) : record.isTranslating ? (
                        <p className='text-sm text-slate-400'>
                            正在翻译中，已有译文会在这里逐步显示。
                        </p>
                    ) : (
                        <p className='text-sm text-slate-400'>
                            当前还没有可展示的翻译片段。
                        </p>
                    )}
                </div>
            </div>
        );
    };

    const renderExportMenu = (record: ViewRecord) => {
        const exportMenuOpen = openExportMenu === record.id;
        const items = [
            {
                key: "raw-srt",
                label: "原始 SRT",
                onClick: () => exportChunks(record.rawChunks, "transcript-raw", "srt"),
            },
            {
                key: "raw-txt",
                label: "原始 TXT",
                onClick: () => exportChunks(record.rawChunks, "transcript-raw", "txt"),
            },
            {
                key: "raw-json",
                label: "原始 JSON",
                onClick: () =>
                    exportChunks(record.rawChunks, "transcript-raw", "json"),
            },
        ];
        if (record.hasQwenCorrection && record.qwenChunks.length > 0) {
            items.push(
                {
                    key: "qwen-srt",
                    label: "Qwen SRT",
                    onClick: () =>
                        exportChunks(record.qwenChunks, "transcript-qwen", "srt"),
                },
                {
                    key: "qwen-txt",
                    label: "Qwen TXT",
                    onClick: () =>
                        exportChunks(record.qwenChunks, "transcript-qwen", "txt"),
                },
                {
                    key: "qwen-json",
                    label: "Qwen JSON",
                    onClick: () =>
                        exportChunks(record.qwenChunks, "transcript-qwen", "json"),
                },
            );
        }

        return (
            <div className='relative'>
                <button
                    type='button'
                    disabled={record.rawChunks.length === 0}
                    onClick={(e) => {
                        e.stopPropagation();
                        setOpenExportMenu((prev) =>
                            prev === record.id ? null : record.id,
                        );
                    }}
                    className={`${btnClass} bg-emerald-600 text-white hover:bg-emerald-700 focus:ring-emerald-300 disabled:opacity-40`}
                >
                    导出
                </button>
                {exportMenuOpen && (
                    <div className='absolute right-0 top-full z-10 mt-1 min-w-28 rounded-lg border border-slate-200 bg-white p-1 shadow-lg'>
                        {items.map((item) => (
                            <button
                                key={item.key}
                                type='button'
                                onClick={() => {
                                    item.onClick();
                                    setOpenExportMenu(null);
                                }}
                                className='block w-full rounded-md px-3 py-2 text-left text-xs text-slate-700 hover:bg-slate-50'
                            >
                                {item.label}
                            </button>
                        ))}
                    </div>
                )}
            </div>
        );
    };

    const renderActions = (record: ViewRecord) => (
        <div
            className='flex shrink-0 flex-wrap items-center justify-end gap-1'
            onClick={(e) => e.stopPropagation()}
        >
            {record.source === "current" && (
                <>
                    <button
                        type='button'
                        disabled={
                            record.rawChunks.length === 0 ||
                            record.isBusy ||
                            record.isCorrecting ||
                            record.isTranslating
                        }
                        onClick={() =>
                            transcriber.processCurrentTranscriptWithQwen()
                        }
                        className={`${btnClass} bg-sky-600 text-white hover:bg-sky-700 focus:ring-sky-300 disabled:opacity-40`}
                    >
                        {record.isCorrecting || record.isTranslating
                            ? `Qwen 处理中 ${Math.max(
                                  record.correctionProgress,
                                  record.translationProgress,
                              )}%`
                              : record.hasQwenTranslation
                                ? "重新 Qwen 处理"
                                : "Qwen 处理"}
                    </button>
                </>
            )}
            {record.source === "history" && (
                <button
                    type='button'
                    onClick={() => transcriber.loadTranscriptFromHistory(record.id)}
                    className={`${btnClass} border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 focus:ring-slate-300`}
                >
                    设为当前
                </button>
            )}
            <button
                type='button'
                onClick={() => setDetailModal(record)}
                className={`${btnClass} border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 focus:ring-slate-300`}
            >
                查看详情
            </button>
            <button
                type='button'
                disabled={
                    record.rawChunks.length === 0 ||
                    record.isBusy ||
                    record.isCorrecting ||
                    record.isTranslating
                }
                onClick={() => openSendChooser(record)}
                className={`${btnClass} bg-pink-600 text-white hover:bg-pink-700 focus:ring-pink-300 disabled:opacity-40`}
            >
                发送字幕
            </button>
            {renderExportMenu(record)}
            {record.source === "history" && (
                <button
                    type='button'
                    title='删除此条'
                    onClick={() => {
                        transcriber.removeTranscriptHistoryItem(record.id);
                    }}
                    className='rounded-md px-2 py-1 text-xs text-slate-400 hover:bg-rose-50 hover:text-rose-600'
                >
                    删除
                </button>
            )}
        </div>
    );

    const records = [...(currentRecord ? [currentRecord] : []), ...historyRecords];

    return (
        <div
            ref={divRef}
            className='flex max-h-[min(32rem,58vh)] w-full flex-col overflow-y-auto rounded-xl border border-slate-100 bg-slate-50/50 p-3'
        >
            <div className='mb-3 flex items-center justify-end border-b border-slate-100 pb-2'>
                {transcriber.transcriptHistory.length > 0 && (
                    <button
                        type='button'
                        onClick={() => {
                            if (confirm("确定清空全部历史？此操作不可恢复。")) {
                                transcriber.clearTranscriptHistory();
                            }
                        }}
                        className='text-xs text-rose-600 hover:underline'
                    >
                        清空全部
                    </button>
                )}
            </div>

            {!hasAnyRows && (
                <p className='py-10 text-center text-sm text-slate-400'>
                    上传音频后会先生成原始转写稿；你可以选择直接导出、发送，或手动使用
                    Qwen 做一体化处理。
                </p>
            )}

            <ul className='space-y-2'>
                {records.map((record) => (
                    <li
                        key={record.id}
                        className={`rounded-xl border border-slate-200/90 bg-white p-3 shadow-sm ${
                            record.source === "current" &&
                            (record.isBusy ||
                                record.isCorrecting ||
                                record.isTranslating)
                                ? "ring-1 ring-sky-200/80"
                                : ""
                        }`}
                    >
                        <div className='flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between'>
                            <div className='min-w-0 flex-1'>
                                <div className='text-sm font-semibold text-slate-900'>
                                    {record.source === "current" ? "当前结果" : record.title}
                                    {record.source === "current" &&
                                        record.title &&
                                        record.title !== "当前结果" && (
                                            <span className='ml-2 text-xs font-normal text-slate-500'>
                                                {record.title}
                                            </span>
                                        )}
                                    {record.isBusy && (
                                        <span className='ml-2 text-xs font-normal text-sky-600'>
                                            {record.isFinalizing
                                                ? "正在收尾…"
                                                : `转写中 ${record.transcriptionProgress}%`}
                                        </span>
                                    )}
                                    {(record.isCorrecting ||
                                        record.isTranslating) && (
                                        <span className='ml-2 text-xs font-normal text-cyan-600'>
                                            Qwen 处理中{" "}
                                            {Math.max(
                                                record.correctionProgress,
                                                record.translationProgress,
                                            )}
                                            %
                                        </span>
                                    )}
                                </div>
                                {record.createdAt && (
                                    <div className='mt-0.5 text-xs text-slate-500'>
                                        {formatHistoryTime(record.createdAt)}
                                    </div>
                                )}
                                <div className='mt-1 line-clamp-2 text-xs text-slate-600'>
                                    {previewText(record)}
                                </div>
                            </div>
                            {renderActions(record)}
                        </div>
                    </li>
                ))}
            </ul>

            {overlayHint && (
                <p className='mt-3 border-t border-slate-100 pt-3 text-center text-xs text-slate-600'>
                    {overlayHint}
                </p>
            )}

            {hasAnyRows && (
                <p className='mt-3 border-t border-slate-100 pt-3 text-left text-xs text-slate-500'>
                    现在的流程是：转写完成后先保留原始字幕；是否使用 Qwen 处理由你手动决定。
                    发送字幕时可以选择原始稿或 Qwen 处理稿。
                </p>
            )}

            <Modal
                show={Boolean(detailModal)}
                onClose={() => setDetailModal(null)}
                onSubmit={() => setDetailModal(null)}
                title={detailModal?.title ?? "结果详情"}
                content={detailModal ? renderStatusPanel(detailModal) : <></>}
            />

            <Modal
                show={Boolean(sendModal)}
                onClose={() => setSendModal(null)}
                onSubmit={() => setSendModal(null)}
                title={sendModal?.title ?? "选择发送来源"}
                content={
                    sendModal ? (
                        <div className='space-y-2'>
                            {sendModal.variants.map((variant) => (
                                <button
                                    key={variant.id}
                                    type='button'
                                    onClick={() => {
                                        void pushSubtitlesToCurrentTab(
                                            variant.chunks,
                                            variant.language,
                                        );
                                        setSendModal(null);
                                    }}
                                    className='block w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-left text-sm text-slate-700 hover:bg-slate-50'
                                >
                                    {variant.label}
                                </button>
                            ))}
                        </div>
                    ) : (
                        <></>
                    )
                }
            />
        </div>
    );
}
