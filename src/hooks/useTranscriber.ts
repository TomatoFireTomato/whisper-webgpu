import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorker } from "./useWorker";
import Constants from "../utils/Constants";
import {
    DEFAULT_TRANSLATION_SERVICE,
    isTranslationServiceId,
    type TranslationServiceId,
} from "../utils/subtitleTranslate";
import {
    appendTranscriptHistory,
    clearTranscriptHistory as clearTranscriptHistoryStorage,
    loadTranscriptHistory,
    loadUiSettings,
    removeTranscriptHistoryItem as removeTranscriptHistoryItemStorage,
    saveUiSettings,
    type TranscriptHistoryItem,
} from "../utils/transcriptHistory";

interface ProgressItem {
    file: string;
    loaded: number;
    progress: number;
    total: number;
    name: string;
    status: string;
}

export type TranscriptChunk = {
    text: string;
    originalText?: string;
    timestamp: [number, number | null];
    translation?: string;
    correctionNote?: string;
};

interface TranscriberUpdateData {
    data: {
        text: string;
        language?: string | null;
        chunks: TranscriptChunk[];
        tps?: number;
        transcriptionProgress?: number;
        correctionProgress?: number;
        correctionSummary?: string[];
        hasQwenCorrection?: boolean;
        hasQwenTranslation?: boolean;
        translationProgress?: number;
    };
}

export interface TranscriberData {
    title: string;
    currentHistoryId?: string | null;
    isBusy: boolean;
    isCorrecting: boolean;
    isTranslating: boolean;
    isFinalizing: boolean;
    tps?: number;
    text: string;
    language?: string | null;
    chunks: TranscriptChunk[];
    qwenText: string;
    qwenChunks: TranscriptChunk[];
    correctionSummary: string[];
    hasQwenCorrection: boolean;
    hasQwenTranslation: boolean;
    transcriptionProgress: number;
    correctionProgress: number;
    translationProgress: number;
}

export interface Transcriber {
    onInputChange: () => void;
    isBusy: boolean;
    isModelLoading: boolean;
    progressItems: ProgressItem[];
    start: (
        audioData: AudioBuffer | undefined,
        meta?: { fileName?: string },
    ) => void;
    processCurrentTranscriptWithQwen: () => void;
    output?: TranscriberData;
    model: string;
    setModel: (model: string) => void;
    multilingual: boolean;
    setMultilingual: (model: boolean) => void;
    language?: string;
    setLanguage: (language: string) => void;
    useHfMirror: boolean;
    setUseHfMirror: (value: boolean) => void;
    subtitleTranslateService: TranslationServiceId;
    setSubtitleTranslateService: (id: TranslationServiceId) => void;
    transcriptHistory: TranscriptHistoryItem[];
    loadTranscriptFromHistory: (id: string) => void;
    removeTranscriptHistoryItem: (id: string) => void;
    clearTranscriptHistory: () => void;
}

const HF_MIRROR_STORAGE_KEY = "whisper-use-hf-mirror";
const SUBTITLE_TRANSLATE_SERVICE_KEY = "whisper-subtitle-translate-service";

function formatWorkerError(data: unknown): string {
    if (data instanceof Error) {
        const m = data.message?.trim();
        return m || data.name || "Error";
    }
    if (typeof data === "number") {
        return `底层运行错误（代码 ${data}）。常见于 ONNX/WebGPU 显存或内存不足，可尝试更小模型、关闭占用 GPU 的页面后重试。`;
    }
    if (data && typeof data === "object") {
        const o = data as { message?: unknown };
        if (typeof o.message === "string" && o.message.trim()) return o.message;
    }
    return String(data).trim() || "未知错误";
}

function toTranscriptData(
    data: Partial<TranscriberData> & {
        text: string;
        chunks: TranscriptChunk[];
    },
): TranscriberData {
    return {
        isBusy: data.isBusy ?? false,
        title: data.title ?? "当前结果",
        currentHistoryId: data.currentHistoryId ?? null,
        isCorrecting: data.isCorrecting ?? false,
        isTranslating: data.isTranslating ?? false,
        isFinalizing: data.isFinalizing ?? false,
        tps: data.tps,
        text: data.text,
        language: data.language ?? null,
        chunks: data.chunks,
        qwenText: data.qwenText ?? "",
        qwenChunks: data.qwenChunks ?? [],
        correctionSummary: data.correctionSummary ?? [],
        hasQwenCorrection: data.hasQwenCorrection ?? false,
        hasQwenTranslation: data.hasQwenTranslation ?? false,
        transcriptionProgress: data.transcriptionProgress ?? 0,
        correctionProgress: data.correctionProgress ?? 0,
        translationProgress: data.translationProgress ?? 0,
    };
}

function mapHistoryToTranscript(item: TranscriptHistoryItem): TranscriberData {
    return toTranscriptData({
        title: item.fileName,
        currentHistoryId: item.id,
        text: item.text,
        tps: item.tps,
        language: item.language,
        chunks: item.chunks,
        qwenText: item.qwenText ?? "",
        qwenChunks: item.qwenChunks ?? [],
        correctionSummary: item.correctionSummary ?? [],
        hasQwenCorrection: item.hasQwenCorrection ?? false,
        hasQwenTranslation: item.hasQwenTranslation ?? false,
        transcriptionProgress: item.transcriptionProgress ?? 100,
        correctionProgress: item.correctionProgress ?? 0,
        translationProgress: item.translationProgress ?? 0,
    });
}

function persistCurrentHistoryItem(
    updater: (items: TranscriptHistoryItem[]) => TranscriptHistoryItem[],
) {
    try {
        localStorage.setItem(
            "whisper-webgpu-transcript-history-v1",
            JSON.stringify(updater(loadTranscriptHistory())),
        );
    } catch {
        /* ignore */
    }
}

export function useTranscriber(): Transcriber {
    const pendingFileNameRef = useRef("未命名音频");

    const [transcriptHistory, setTranscriptHistory] = useState<
        TranscriptHistoryItem[]
    >(() => loadTranscriptHistory());
    const [transcript, setTranscript] = useState<TranscriberData | undefined>(
        () => {
            const first = loadTranscriptHistory()[0];
            return first ? mapHistoryToTranscript(first) : undefined;
        },
    );
    const transcriptRef = useRef<TranscriberData | undefined>(transcript);
    useEffect(() => {
        transcriptRef.current = transcript;
    }, [transcript]);

    const [isBusy, setIsBusy] = useState(false);
    const [isModelLoading, setIsModelLoading] = useState(false);
    const [progressItems, setProgressItems] = useState<ProgressItem[]>([]);

    const webWorker = useWorker((event) => {
        const message = event.data;
        switch (message.status) {
            case "progress":
                setProgressItems((prev) =>
                    prev.map((item) =>
                        item.file === message.file
                            ? { ...item, progress: message.progress }
                            : item,
                    ),
                );
                break;
            case "update":
            case "complete": {
                const d = (message as TranscriberUpdateData).data;
                const busy = message.status === "update";
                const next = toTranscriptData({
                    title: pendingFileNameRef.current,
                    currentHistoryId: null,
                    isBusy: busy,
                    isCorrecting: false,
                    isTranslating: false,
                    isFinalizing:
                        busy && (d.transcriptionProgress ?? 0) >= 99,
                    text: d.text,
                    tps: d.tps,
                    language: d.language,
                    chunks: d.chunks,
                    transcriptionProgress: d.transcriptionProgress ?? 0,
                    correctionProgress: 0,
                    translationProgress: 0,
                    qwenText: "",
                    qwenChunks: [],
                    correctionSummary: [],
                    hasQwenCorrection: false,
                    hasQwenTranslation: false,
                });
                setTranscript(next);
                setIsBusy(busy);

                if (message.status === "complete") {
                    const saved = appendTranscriptHistory({
                        fileName: pendingFileNameRef.current,
                        text: next.text,
                        tps: next.tps,
                        language: next.language,
                        chunks: next.chunks,
                        qwenText: "",
                        qwenChunks: [],
                        correctionSummary: [],
                        hasQwenCorrection: false,
                        hasQwenTranslation: false,
                        transcriptionProgress: next.transcriptionProgress,
                        correctionProgress: 0,
                        translationProgress: 0,
                    });
                    setTranscript((prev) =>
                        prev
                            ? {
                                  ...prev,
                                  title: saved.fileName,
                                  currentHistoryId: saved.id,
                              }
                            : prev,
                    );
                    setTranscriptHistory(loadTranscriptHistory());
                }
                break;
            }
            case "qwen_update":
            case "qwen_complete": {
                const d = (message as TranscriberUpdateData).data;
                const done = message.status === "qwen_complete";
                setIsBusy(!done);
                setTranscript((prev) =>
                    prev
                        ? toTranscriptData({
                              ...prev,
                              title: prev.title,
                              currentHistoryId: prev.currentHistoryId,
                              isBusy: false,
                              isCorrecting: !done,
                              isTranslating: !done,
                              isFinalizing: false,
                              qwenText: d.text,
                              qwenChunks: d.chunks,
                              correctionSummary: d.correctionSummary ?? [],
                              hasQwenCorrection:
                                  d.hasQwenCorrection ?? true,
                              hasQwenTranslation:
                                  d.hasQwenTranslation ?? false,
                              correctionProgress:
                                  d.correctionProgress ?? (done ? 100 : 0),
                              translationProgress:
                                  d.translationProgress ?? (done ? 100 : 0),
                          })
                        : prev,
                );

                if (done) {
                    persistCurrentHistoryItem((items) => {
                        if (!items[0]) return items;
                        items[0] = {
                            ...items[0],
                            qwenText: d.text,
                            qwenChunks: d.chunks,
                            correctionSummary: d.correctionSummary ?? [],
                            hasQwenCorrection:
                                d.hasQwenCorrection ?? true,
                            hasQwenTranslation:
                                d.hasQwenTranslation ?? true,
                            correctionProgress:
                                d.correctionProgress ?? 100,
                            translationProgress:
                                d.translationProgress ?? 100,
                        };
                        return items;
                    });
                    setTranscriptHistory(loadTranscriptHistory());
                }
                break;
            }
            case "initiate":
                setIsModelLoading(true);
                setProgressItems((prev) => [...prev, message]);
                break;
            case "ready":
                setIsModelLoading(false);
                break;
            case "error":
                setIsBusy(false);
                setTranscript((prev) =>
                    prev
                        ? {
                              ...prev,
                              isBusy: false,
                              isCorrecting: false,
                              isTranslating: false,
                              isFinalizing: false,
                          }
                        : prev,
                );
                setIsModelLoading(false);
                alert(`发生错误: ${formatWorkerError(message.data)}`);
                break;
            case "done":
                setProgressItems((prev) =>
                    prev.filter((item) => item.file !== message.file),
                );
                break;
            default:
                break;
        }
    });

    const [model, setModel] = useState<string>(() => {
        const s = loadUiSettings().model;
        return typeof s === "string" && s ? s : Constants.DEFAULT_MODEL;
    });
    const [multilingual, setMultilingual] = useState<boolean>(() => {
        const s = loadUiSettings().multilingual;
        return typeof s === "boolean" ? s : Constants.DEFAULT_MULTILINGUAL;
    });
    const [language, setLanguage] = useState<string>(() => {
        const s = loadUiSettings().language;
        return typeof s === "string" && s ? s : Constants.DEFAULT_LANGUAGE;
    });
    const [useHfMirror, setUseHfMirror] = useState<boolean>(() => {
        try {
            return localStorage.getItem(HF_MIRROR_STORAGE_KEY) === "true";
        } catch {
            return false;
        }
    });
    const [subtitleTranslateService, setSubtitleTranslateService] =
        useState<TranslationServiceId>(() => {
            try {
                const v = localStorage.getItem(SUBTITLE_TRANSLATE_SERVICE_KEY);
                if (v && isTranslationServiceId(v)) return v;
            } catch {
                /* ignore */
            }
            return DEFAULT_TRANSLATION_SERVICE;
        });

    useEffect(() => {
        try {
            localStorage.setItem(
                SUBTITLE_TRANSLATE_SERVICE_KEY,
                subtitleTranslateService,
            );
        } catch {
            /* ignore */
        }
    }, [subtitleTranslateService]);

    useEffect(() => {
        try {
            localStorage.setItem(
                HF_MIRROR_STORAGE_KEY,
                useHfMirror ? "true" : "false",
            );
        } catch {
            /* ignore */
        }
    }, [useHfMirror]);

    useEffect(() => {
        saveUiSettings({
            model,
            multilingual,
            language,
        });
    }, [model, multilingual, language]);

    const loadTranscriptFromHistory = useCallback((id: string) => {
        const item = loadTranscriptHistory().find((x) => x.id === id);
        if (!item) return;
        setTranscript(mapHistoryToTranscript(item));
    }, []);

    const removeTranscriptHistoryItem = useCallback((id: string) => {
        removeTranscriptHistoryItemStorage(id);
        const history = loadTranscriptHistory();
        setTranscriptHistory(history);
        setTranscript(history[0] ? mapHistoryToTranscript(history[0]) : undefined);
    }, []);

    const clearTranscriptHistory = useCallback(() => {
        clearTranscriptHistoryStorage();
        setTranscriptHistory([]);
        setTranscript(undefined);
    }, []);

    const onInputChange = useCallback(() => {
        setTranscript(undefined);
    }, []);

    const start = useCallback(
        (audioData: AudioBuffer | undefined, meta?: { fileName?: string }) => {
            if (!audioData) return;

            pendingFileNameRef.current = meta?.fileName?.trim() || "未命名音频";
            setTranscript(undefined);
            setIsBusy(true);

            let audio;
            if (audioData.numberOfChannels === 2) {
                const left = audioData.getChannelData(0);
                const right = audioData.getChannelData(1);
                const SCALING_FACTOR = Math.sqrt(2);
                audio = new Float32Array(left.length);
                for (let i = 0; i < audioData.length; ++i) {
                    audio[i] = (SCALING_FACTOR * (left[i] + right[i])) / 2;
                }
            } else {
                audio = audioData.getChannelData(0);
            }

            webWorker.postMessage({
                action: "transcribe",
                audio,
                audioDuration: audioData.duration,
                model,
                multilingual,
                subtask: multilingual ? Constants.DEFAULT_SUBTASK : null,
                language: multilingual && language !== "auto" ? language : null,
                useHfMirror,
            });
        },
        [webWorker, model, multilingual, language, useHfMirror],
    );

    const processCurrentTranscriptWithQwen = useCallback(() => {
        const current = transcriptRef.current;
        if (!current || current.chunks.length === 0) return;
        setIsBusy(true);
        setTranscript((prev) =>
            prev
                ? {
                      ...prev,
                      isCorrecting: true,
                      isTranslating: false,
                      isFinalizing: false,
                      correctionProgress: 0,
                      translationProgress: 0,
                      qwenText: "",
                      qwenChunks: [],
                      correctionSummary: [],
                      hasQwenCorrection: false,
                      hasQwenTranslation: false,
                  }
                : prev,
        );
        webWorker.postMessage({
            action: "process",
            language: current.language ?? language ?? "auto",
            text: current.text,
            tps: current.tps,
            chunks: current.chunks,
        });
    }, [webWorker, language]);

    return useMemo(
        () => ({
            onInputChange,
            isBusy,
            isModelLoading,
            progressItems,
            start,
            processCurrentTranscriptWithQwen,
            output: transcript,
            model,
            setModel,
            multilingual,
            setMultilingual,
            language,
            setLanguage,
            useHfMirror,
            setUseHfMirror,
            subtitleTranslateService,
            setSubtitleTranslateService,
            transcriptHistory,
            loadTranscriptFromHistory,
            removeTranscriptHistoryItem,
            clearTranscriptHistory,
        }),
        [
            onInputChange,
            isBusy,
            isModelLoading,
            progressItems,
            start,
            processCurrentTranscriptWithQwen,
            transcript,
            model,
            multilingual,
            language,
            useHfMirror,
            subtitleTranslateService,
            transcriptHistory,
            loadTranscriptFromHistory,
            removeTranscriptHistoryItem,
            clearTranscriptHistory,
        ],
    );
}
