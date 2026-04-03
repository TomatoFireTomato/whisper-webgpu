import { useRef, useEffect, useState, useCallback } from "react";

import { Transcriber, TranscriberData } from "../hooks/useTranscriber";
import { formatAudioTimestamp } from "../utils/AudioUtils";
import { chunksToCues, filterValidChunks } from "../utils/subtitleCues";
import { sendSubtitlesToActiveTab } from "../extension/overlayTab";
import type { TranscriptHistoryItem } from "../utils/transcriptHistory";

const STREAMING_ROW_ID = "__streaming__";

interface Props {
    transcribedData: TranscriberData | undefined;
    transcriber: Transcriber;
}

type ChunkList = NonNullable<TranscriberData["chunks"]>;

export default function Transcript({ transcribedData, transcriber }: Props) {
    const divRef = useRef<HTMLDivElement>(null);
    const [overlayHint, setOverlayHint] = useState<string | null>(null);
    const [expandedId, setExpandedId] = useState<string | null>(null);

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
        return (
            String(h).padStart(2, "0") +
            ":" +
            String(m).padStart(2, "0") +
            ":" +
            String(s).padStart(2, "0") +
            "," +
            String(ms).padStart(3, "0")
        );
    };

    const jsonToSrt = (json: ReturnType<typeof filterValidChunks>): string => {
        const lines: string[] = [];
        for (let i = 0; i < json.length; i++) {
            const seg = json[i];
            const start = formatTime(Number(seg.timestamp[0]));
            const end = formatTime(
                Number(seg.timestamp[1] ?? seg.timestamp[0]),
            );
            let text = (seg.text || "").trim();
            text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
            const tr = (seg as { translation?: string }).translation?.trim();
            lines.push(String(i + 1));
            lines.push(`${start} --> ${end}`);
            lines.push(text);
            if (tr) {
                lines.push(tr);
            }
            lines.push("");
        }
        return lines.join("\n").trim() + "\n";
    };

    const exportSRT = (chunks: ChunkList) => {
        let jsonData = JSON.stringify(chunks, null, 2);
        const regex = /( {4}"timestamp": )\[\s+(\S+)\s+(\S+)\s+\]/gm;
        jsonData = jsonData.replace(regex, "$1[$2 $3]");
        const parsed = JSON.parse(jsonData) as typeof chunks;
        const filteredData = filterValidChunks(parsed);
        const srtData = jsonToSrt(filteredData);
        const blob = new Blob([srtData], { type: "text/srt" });
        saveBlob(blob, "transcript.srt");
    };

    const exportTXT = (chunks: ChunkList) => {
        const text = chunks.map((chunk) => chunk.text).join("").trim();
        const blob = new Blob([text], { type: "text/plain" });
        saveBlob(blob, "transcript.txt");
    };

    const exportJSON = (chunks: ChunkList) => {
        let jsonData = JSON.stringify(chunks, null, 2);
        const regex = /( {4}"timestamp": )\[\s+(\S+)\s+(\S+)\s+\]/gm;
        jsonData = jsonData.replace(regex, "$1[$2 $3]");
        const blob = new Blob([jsonData], { type: "application/json" });
        saveBlob(blob, "transcript.json");
    };

    const pushSubtitlesToCurrentTab = async (chunks: ChunkList) => {
        setOverlayHint(null);
        const cues = chunksToCues(chunks);
        if (cues.length === 0) {
            setOverlayHint("没有可发送的字幕片段。");
            return;
        }
        setOverlayHint("正在翻译字幕并注入页面…");
        const sl = transcriber.multilingual
            ? transcriber.language === "auto" || !transcriber.language
                ? "auto"
                : transcriber.language
            : "en";
        const r = await sendSubtitlesToActiveTab(cues, {
            sourceLang: sl,
            targetLang: "zh-CN",
            translationService: transcriber.subtitleTranslateService,
        });
        if (!r.ok) {
            setOverlayHint(r.error);
            return;
        }
        setOverlayHint(
            "已在当前页播放器上显示双语字幕。刷新页面或离开视频会消失；再次发送可覆盖。",
        );
    };

    useEffect(() => {
        if (!transcribedData?.isBusy && expandedId === STREAMING_ROW_ID) {
            setExpandedId(null);
        }
    }, [transcribedData?.isBusy, expandedId]);

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

    const previewText = (item: TranscriptHistoryItem) => {
        const t = (item.text || "").trim();
        if (t.length <= 96) return t || "（无文本）";
        return t.slice(0, 96) + "…";
    };

    const toggleExpand = useCallback(
        (id: string) => {
            setExpandedId((prev) => {
                const next = prev === id ? null : id;
                if (next && next !== STREAMING_ROW_ID) {
                    transcriber.loadTranscriptFromHistory(next);
                }
                return next;
            });
        },
        [transcriber],
    );

    const streamingBusy = Boolean(transcribedData?.isBusy);
    const streamingChunks: ChunkList = transcribedData?.chunks ?? [];
    const hasStreamingRow = streamingBusy;

    const history = transcriber.transcriptHistory;
    const hasAnyRows = hasStreamingRow || history.length > 0;

    const btnClass =
        "inline-flex items-center rounded-md px-2 py-1 text-xs font-medium transition focus:outline-none focus:ring-2 focus:ring-offset-1";

    const renderRowActions = (
        chunks: ChunkList,
        opts: { disableSend?: boolean; disableExport?: boolean },
    ) => {
        const disableSend = opts.disableSend ?? false;
        const disableExport = opts.disableExport ?? false;
        return (
            <div
                className='flex shrink-0 flex-wrap items-center justify-end gap-1'
                onClick={(e) => e.stopPropagation()}
            >
                <button
                    type='button'
                    disabled={disableSend}
                    onClick={() => pushSubtitlesToCurrentTab(chunks)}
                    className={`${btnClass} bg-pink-600 text-white hover:bg-pink-700 focus:ring-pink-300 disabled:opacity-40`}
                >
                    发送字幕
                </button>
                <button
                    type='button'
                    disabled={disableExport}
                    onClick={() => exportSRT(chunks)}
                    className={`${btnClass} bg-emerald-600 text-white hover:bg-emerald-700 focus:ring-emerald-300 disabled:opacity-40`}
                >
                    SRT
                </button>
                <button
                    type='button'
                    disabled={disableExport}
                    onClick={() => exportTXT(chunks)}
                    className={`${btnClass} bg-emerald-600 text-white hover:bg-emerald-700 focus:ring-emerald-300 disabled:opacity-40`}
                >
                    TXT
                </button>
                <button
                    type='button'
                    disabled={disableExport}
                    onClick={() => exportJSON(chunks)}
                    className={`${btnClass} bg-emerald-600 text-white hover:bg-emerald-700 focus:ring-emerald-300 disabled:opacity-40`}
                >
                    JSON
                </button>
            </div>
        );
    };

    const renderChunkDetails = (
        chunks: ChunkList,
        tps: number | undefined,
        isBusy: boolean,
    ) => (
        <div className='space-y-2 border-t border-slate-100 pt-3'>
            {chunks.map((chunk, i) => (
                <div
                    key={`${i}-${chunk.text.slice(0, 20)}`}
                    className={`flex w-full flex-row rounded-lg p-2.5 ${
                        isBusy
                            ? "bg-sky-50/80"
                            : "bg-white ring-1 ring-slate-200/80"
                    }`}
                >
                    <div className='mr-4 shrink-0 text-xs text-slate-500'>
                        {formatAudioTimestamp(chunk.timestamp[0])}
                    </div>
                    <div className='min-w-0 flex-1 text-sm text-slate-800'>
                        {chunk.text}
                    </div>
                </div>
            ))}
            {typeof tps === "number" && !isBusy && (
                <p className='text-center text-xs text-slate-500'>
                    <span className='font-semibold text-slate-800'>
                        {tps.toFixed(2)}
                    </span>{" "}
                    tokens/second
                </p>
            )}
        </div>
    );

    return (
        <div
            ref={divRef}
            className='flex max-h-[min(32rem,58vh)] w-full flex-col overflow-y-auto rounded-xl border border-slate-100 bg-slate-50/50 p-3'
        >
            {history.length > 0 && (
                <div className='mb-3 flex items-center justify-end border-b border-slate-100 pb-2'>
                    <button
                        type='button'
                        onClick={() => {
                            if (
                                confirm("确定清空全部历史？此操作不可恢复。")
                            ) {
                                setExpandedId(null);
                                transcriber.clearTranscriptHistory();
                            }
                        }}
                        className='text-xs text-rose-600 hover:underline'
                    >
                        清空全部
                    </button>
                </div>
            )}

            {!hasAnyRows && (
                <p className='py-10 text-center text-sm text-slate-400'>
                    上传音频并开始转写后，每次结果会作为一行显示在这里；点击左侧可展开查看带时间戳的全文。
                </p>
            )}

            <ul className='space-y-2'>
                {hasStreamingRow && (
                    <li
                        className={`rounded-xl border border-slate-200/90 bg-white p-3 shadow-sm ${
                            streamingBusy ? "ring-1 ring-sky-200/80" : ""
                        }`}
                    >
                        <div className='flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between'>
                            <button
                                type='button'
                                onClick={() => toggleExpand(STREAMING_ROW_ID)}
                                className='min-w-0 flex-1 rounded-lg text-left hover:bg-slate-50/80'
                                aria-expanded={expandedId === STREAMING_ROW_ID}
                            >
                                <div className='flex items-start gap-2'>
                                    <svg
                                        className={`mt-0.5 h-4 w-4 shrink-0 text-slate-400 transition-transform ${
                                            expandedId === STREAMING_ROW_ID
                                                ? "rotate-180"
                                                : ""
                                        }`}
                                        viewBox='0 0 20 20'
                                        fill='currentColor'
                                        aria-hidden
                                    >
                                        <path
                                            fillRule='evenodd'
                                            d='M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z'
                                            clipRule='evenodd'
                                        />
                                    </svg>
                                    <div className='min-w-0'>
                                        <div className='text-sm font-semibold text-slate-900'>
                                            当前转写
                                            {streamingBusy && (
                                                <span className='ml-2 text-xs font-normal text-sky-600'>
                                                    进行中…
                                                </span>
                                            )}
                                        </div>
                                        <div className='mt-0.5 line-clamp-2 text-xs text-slate-500'>
                                            {(transcribedData?.text || "")
                                                .trim()
                                                .slice(0, 120) ||
                                                "等待识别…"}
                                            {(transcribedData?.text || "")
                                                .length > 120
                                                ? "…"
                                                : ""}
                                        </div>
                                    </div>
                                </div>
                            </button>
                            {renderRowActions(streamingChunks, {
                                disableSend:
                                    streamingBusy ||
                                    streamingChunks.length === 0,
                                disableExport: streamingChunks.length === 0,
                            })}
                        </div>
                        {expandedId === STREAMING_ROW_ID &&
                            (streamingChunks.length > 0 ? (
                                renderChunkDetails(
                                    streamingChunks,
                                    transcribedData?.tps,
                                    streamingBusy,
                                )
                            ) : (
                                <p className='border-t border-slate-100 pt-3 text-center text-xs text-slate-400'>
                                    等待识别片段…
                                </p>
                            ))}
                    </li>
                )}

                {history.map((item) => {
                    const open = expandedId === item.id;
                    const chunks = item.chunks as ChunkList;
                    return (
                        <li
                            key={item.id}
                            className='rounded-xl border border-slate-200/90 bg-white p-3 shadow-sm'
                        >
                            <div className='flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between'>
                                <button
                                    type='button'
                                    onClick={() => toggleExpand(item.id)}
                                    className='min-w-0 flex-1 rounded-lg text-left hover:bg-slate-50/80'
                                    aria-expanded={open}
                                >
                                    <div className='flex items-start gap-2'>
                                        <svg
                                            className={`mt-0.5 h-4 w-4 shrink-0 text-slate-400 transition-transform ${
                                                open ? "rotate-180" : ""
                                            }`}
                                            viewBox='0 0 20 20'
                                            fill='currentColor'
                                            aria-hidden
                                        >
                                            <path
                                                fillRule='evenodd'
                                                d='M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z'
                                                clipRule='evenodd'
                                            />
                                        </svg>
                                        <div className='min-w-0'>
                                            <div className='truncate text-sm font-semibold text-slate-900'>
                                                {item.fileName}
                                            </div>
                                            <div className='mt-0.5 text-xs text-slate-500'>
                                                {formatHistoryTime(
                                                    item.createdAt,
                                                )}
                                            </div>
                                            <div className='mt-1 line-clamp-2 text-xs text-slate-600'>
                                                {previewText(item)}
                                            </div>
                                        </div>
                                    </div>
                                </button>
                                <div
                                    className='flex shrink-0 flex-wrap items-center justify-end gap-1'
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    {renderRowActions(chunks, {
                                        disableSend: chunks.length === 0,
                                        disableExport: chunks.length === 0,
                                    })}
                                    <button
                                        type='button'
                                        title='删除此条'
                                        onClick={() => {
                                            if (expandedId === item.id) {
                                                setExpandedId(null);
                                            }
                                            transcriber.removeTranscriptHistoryItem(
                                                item.id,
                                            );
                                        }}
                                        className='rounded-md px-2 py-1 text-xs text-slate-400 hover:bg-rose-50 hover:text-rose-600'
                                    >
                                        删除
                                    </button>
                                </div>
                            </div>
                            {open &&
                                renderChunkDetails(
                                    chunks,
                                    item.tps,
                                    false,
                                )}
                        </li>
                    );
                })}
            </ul>

            {overlayHint && (
                <p className='mt-3 border-t border-slate-100 pt-3 text-center text-xs text-slate-600'>
                    {overlayHint}
                </p>
            )}

            {hasAnyRows && (
                <p className='mt-3 border-t border-slate-100 pt-3 text-left text-xs text-slate-500'>
                    使用「发送字幕到当前页」时，扩展会在 B
                    站播放器叠加双语字幕（先原文、后台翻译；翻译服务见设置）。
                </p>
            )}
        </div>
    );
}
