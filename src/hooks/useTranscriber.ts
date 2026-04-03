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

interface TranscriberUpdateData {
    data: {
        text: string;
        chunks: {
            text: string;
            timestamp: [number, number | null];
            translation?: string;
        }[];
        tps: number;
    };
}

export interface TranscriberData {
    isBusy: boolean;
    tps?: number;
    text: string;
    chunks: {
        text: string;
        timestamp: [number, number | null];
        translation?: string;
    }[];
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
    output?: TranscriberData;
    model: string;
    setModel: (model: string) => void;
    multilingual: boolean;
    setMultilingual: (model: boolean) => void;
    language?: string;
    setLanguage: (language: string) => void;
    useHfMirror: boolean;
    setUseHfMirror: (value: boolean) => void;
    /** B 站字幕翻译后端 */
    subtitleTranslateService: TranslationServiceId;
    setSubtitleTranslateService: (id: TranslationServiceId) => void;
    /** 本地缓存的转录历史（新→旧） */
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
        return `底层运行错误（代码 ${data}）。常见于 ONNX/WebGPU 显存或内存不足，可尝试更小 Whisper 模型、关闭占用 GPU 的页面，或仅使用转写。`;
    }
    if (data && typeof data === "object") {
        const o = data as { message?: unknown };
        if (typeof o.message === "string" && o.message.trim()) return o.message;
    }
    const s = String(data).trim();
    if (/^\d{5,}$/.test(s)) {
        return `底层运行错误（代码 ${s}）。常见于 WASM/内存不足：可换更小 Whisper、关闭其他标签页，或仅转写。`;
    }
    if (s.includes("Aborted")) {
        return "ONNX Runtime 已中止（Aborted），多与内存或 GPU 资源不足有关。可尝试更小 Whisper、关闭其他标签页。";
    }
    return s || "未知错误";
}

export function useTranscriber(): Transcriber {
    const pendingFileNameRef = useRef("未命名音频");

    const [transcriptHistory, setTranscriptHistory] = useState<
        TranscriptHistoryItem[]
    >(() => loadTranscriptHistory());

    const [transcript, setTranscript] = useState<TranscriberData | undefined>(
        () => {
            const h = loadTranscriptHistory();
            const first = h[0];
            if (!first) return undefined;
            return {
                isBusy: false,
                text: first.text,
                tps: first.tps,
                chunks: first.chunks,
            };
        },
    );
    const [isBusy, setIsBusy] = useState(false);
    const [isModelLoading, setIsModelLoading] = useState(false);

    const [progressItems, setProgressItems] = useState<ProgressItem[]>([]);

    const useHfMirrorRef = useRef(
        typeof localStorage !== "undefined" &&
            localStorage.getItem(HF_MIRROR_STORAGE_KEY) === "true",
    );

    const webWorker = useWorker((event) => {
        const message = event.data;
        switch (message.status) {
            case "progress":
                setProgressItems((prev) =>
                    prev.map((item) => {
                        if (item.file === message.file) {
                            return { ...item, progress: message.progress };
                        }
                        return item;
                    }),
                );
                break;
            case "update":
            case "complete": {
                const busy = message.status === "update";
                const updateMessage = message as TranscriberUpdateData;
                const d = updateMessage.data;
                setTranscript({
                    isBusy: busy,
                    text: d.text,
                    tps: d.tps,
                    chunks: d.chunks,
                });
                setIsBusy(busy);

                if (message.status === "complete") {
                    setIsBusy(false);
                    const rawChunks = d.chunks ?? [];
                    appendTranscriptHistory({
                        fileName: pendingFileNameRef.current,
                        text: d.text ?? "",
                        tps: d.tps,
                        chunks: rawChunks.map((c) => ({
                            text: c.text ?? "",
                            timestamp: [
                                Number(c.timestamp?.[0] ?? 0),
                                c.timestamp?.[1] != null
                                    ? Number(c.timestamp[1])
                                    : null,
                            ] as [number, number | null],
                            translation:
                                typeof c.translation === "string"
                                    ? c.translation
                                    : undefined,
                        })),
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
        useHfMirrorRef.current = useHfMirror;
    }, [useHfMirror]);

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
        setTranscript({
            isBusy: false,
            text: item.text,
            tps: item.tps,
            chunks: item.chunks,
        });
    }, []);

    const removeTranscriptHistoryItem = useCallback((id: string) => {
        removeTranscriptHistoryItemStorage(id);
        const h = loadTranscriptHistory();
        setTranscriptHistory(h);
        const first = h[0];
        setTranscript(
            first
                ? {
                      isBusy: false,
                      text: first.text,
                      tps: first.tps,
                      chunks: first.chunks,
                  }
                : undefined,
        );
    }, []);

    const clearTranscriptHistory = useCallback(() => {
        clearTranscriptHistoryStorage();
        setTranscriptHistory([]);
        setTranscript(undefined);
    }, []);

    const onInputChange = useCallback(() => {
        setTranscript(undefined);
    }, []);

    const postRequest = useCallback(
        async (
            audioData: AudioBuffer | undefined,
            meta?: { fileName?: string },
        ) => {
            if (audioData) {
                pendingFileNameRef.current =
                    meta?.fileName?.trim() || "未命名音频";
                setTranscript(undefined);
                setIsBusy(true);

                let audio;
                if (audioData.numberOfChannels === 2) {
                    const SCALING_FACTOR = Math.sqrt(2);

                    const left = audioData.getChannelData(0);
                    const right = audioData.getChannelData(1);

                    audio = new Float32Array(left.length);
                    for (let i = 0; i < audioData.length; ++i) {
                        audio[i] = (SCALING_FACTOR * (left[i] + right[i])) / 2;
                    }
                } else {
                    audio = audioData.getChannelData(0);
                }

                webWorker.postMessage({
                    audio,
                    model,
                    multilingual,
                    subtask: multilingual ? Constants.DEFAULT_SUBTASK : null,
                    language:
                        multilingual && language !== "auto" ? language : null,
                    useHfMirror,
                });
            }
        },
        [webWorker, model, multilingual, language, useHfMirror],
    );

    const transcriber = useMemo(() => {
        return {
            onInputChange,
            isBusy,
            isModelLoading,
            progressItems,
            start: postRequest,
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
        };
    }, [
        isBusy,
        isModelLoading,
        progressItems,
        postRequest,
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
    ]);

    return transcriber;
}
