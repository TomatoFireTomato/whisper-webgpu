import React, { useCallback, useEffect, useRef, useState } from "react";
import AudioPlayer from "./AudioPlayer";
import { CobaltPageAudio } from "./CobaltPageAudio";
import { TranscribeButton } from "./TranscribeButton";
import Constants from "../utils/Constants";
import { Transcriber, TranscriberData } from "../hooks/useTranscriber";
import {
    chunksToSrt,
    saveBlob,
    stripFileExtension,
} from "../utils/subtitleExport";
import Progress from "./Progress";

type BatchStatus = "pending" | "processing" | "done" | "error";

type BatchItem = {
    id: string;
    file: File;
    fileName: string;
    status: BatchStatus;
    error?: string;
    chunkCount?: number;
    exported?: boolean;
};

type CorrectionChunk = {
    text: string;
    originalText?: string;
    correctionNote?: string;
};

async function resampleAudioBuffer(
    buffer: AudioBuffer,
    targetSampleRate: number,
) {
    if (buffer.sampleRate === targetSampleRate) {
        return buffer;
    }

    const frameCount = Math.max(
        1,
        Math.ceil(buffer.duration * targetSampleRate),
    );
    const offlineContext = new OfflineAudioContext(
        buffer.numberOfChannels,
        frameCount,
        targetSampleRate,
    );
    const source = offlineContext.createBufferSource();
    source.buffer = buffer;
    source.connect(offlineContext.destination);
    source.start(0);

    try {
        return await offlineContext.startRendering();
    } finally {
        source.disconnect();
    }
}

function isLikelyMp3File(file: File, arrayBuffer: ArrayBuffer) {
    const mimeType = file.type.toLowerCase();
    if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return true;
    if (file.name.toLowerCase().endsWith(".mp3")) return true;

    const bytes = new Uint8Array(arrayBuffer);
    if (
        bytes.length >= 3 &&
        bytes[0] === 0x49 &&
        bytes[1] === 0x44 &&
        bytes[2] === 0x33
    ) {
        return true;
    }
    if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
        return true;
    }

    return false;
}

function createAudioBufferFromChannels(
    channelData: Float32Array[],
    sampleRate: number,
) {
    const channelCount = Math.max(channelData.length, 1);
    const length = Math.max(channelData[0]?.length ?? 0, 1);
    const context = new OfflineAudioContext(channelCount, length, sampleRate);
    const buffer = context.createBuffer(channelCount, length, sampleRate);

    for (let i = 0; i < channelCount; i++) {
        const channel = channelData[i];
        if (!channel) continue;
        buffer.copyToChannel(new Float32Array(channel), i);
    }

    return buffer;
}

async function decodeAudioFile(arrayBuffer: ArrayBuffer) {
    const audioContext = new AudioContext();

    try {
        const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
        return await resampleAudioBuffer(decoded, Constants.SAMPLING_RATE);
    } finally {
        await audioContext.close().catch(() => undefined);
    }
}

async function decodeMp3WithWasm(arrayBuffer: ArrayBuffer) {
    const { MPEGDecoder } = await import("mpg123-decoder");
    const decoder = new MPEGDecoder();
    await decoder.ready;

    try {
        const decoded = decoder.decode(new Uint8Array(arrayBuffer));
        if (
            !decoded ||
            !Array.isArray(decoded.channelData) ||
            decoded.channelData.length === 0 ||
            !decoded.samplesDecoded
        ) {
            throw new Error("mp3 解码器没有返回可用的音频数据。");
        }

        const usableChannels = decoded.channelData.map((channel) =>
            channel.length === decoded.samplesDecoded
                ? channel
                : channel.slice(0, decoded.samplesDecoded),
        );
        const buffer = createAudioBufferFromChannels(
            usableChannels,
            decoded.sampleRate || Constants.SAMPLING_RATE,
        );

        return await resampleAudioBuffer(buffer, Constants.SAMPLING_RATE);
    } finally {
        decoder.free();
    }
}

async function decodeAudioFileWithMediaElement(
    url: string,
    onProgress?: (progress: number) => void,
) {
    const audio = new Audio();
    audio.src = url;
    audio.preload = "auto";
    audio.crossOrigin = "anonymous";
    audio.muted = true;
    audio.setAttribute("playsinline", "true");
    audio.playbackRate = 4;

    const audioContext = new AudioContext();
    const source = audioContext.createMediaElementSource(audio);
    const processor = audioContext.createScriptProcessor(4096, 2, 1);

    const chunks: Float32Array[] = [];
    let totalLength = 0;

    processor.onaudioprocess = (event) => {
        const input = event.inputBuffer;
        const mono = new Float32Array(input.length);

        if (input.numberOfChannels >= 2) {
            const left = input.getChannelData(0);
            const right = input.getChannelData(1);
            for (let i = 0; i < input.length; i++) {
                mono[i] = (left[i] + right[i]) / 2;
            }
        } else {
            mono.set(input.getChannelData(0));
        }

        chunks.push(mono);
        totalLength += mono.length;

        if (audio.duration > 0) {
            onProgress?.(Math.min(audio.currentTime / audio.duration, 1));
        }
    };

    source.connect(processor);
    processor.connect(audioContext.destination);

    try {
        await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
                audio.onloadedmetadata = null;
                audio.onerror = null;
                audio.onended = null;
                audio.ontimeupdate = null;
            };

            audio.onerror = () => {
                cleanup();
                reject(new Error("浏览器无法通过媒体元素读取这个音频文件。"));
            };
            audio.onended = () => {
                cleanup();
                resolve();
            };
            audio.ontimeupdate = () => {
                if (audio.duration > 0) {
                    onProgress?.(Math.min(audio.currentTime / audio.duration, 1));
                }
            };
            audio.onloadedmetadata = async () => {
                try {
                    await audioContext.resume();
                    await audio.play();
                } catch (error) {
                    cleanup();
                    reject(error);
                }
            };
        });

        const pcm = new Float32Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
            pcm.set(chunk, offset);
            offset += chunk.length;
        }

        const buffer = audioContext.createBuffer(1, pcm.length, audioContext.sampleRate);
        buffer.copyToChannel(pcm, 0);
        onProgress?.(1);
        return await resampleAudioBuffer(buffer, Constants.SAMPLING_RATE);
    } finally {
        audio.pause();
        audio.src = "";
        processor.disconnect();
        source.disconnect();
        await audioContext.close().catch(() => undefined);
    }
}

async function decodeWithFallbacks(
    file: File,
    arrayBuffer: ArrayBuffer,
    blobUrl: string,
    onProgress?: (progress: number) => void,
): Promise<AudioBuffer> {
    const allowMp3Fallback = isLikelyMp3File(file, arrayBuffer);
    try {
        return await decodeAudioFile(arrayBuffer);
    } catch (primaryError) {
        if (allowMp3Fallback) {
            try {
                return await decodeMp3WithWasm(arrayBuffer);
            } catch {
                onProgress?.(0);
                return await decodeAudioFileWithMediaElement(blobUrl, onProgress);
            }
        }
        onProgress?.(0);
        return await decodeAudioFileWithMediaElement(blobUrl, onProgress).catch(
            () => {
                throw primaryError;
            },
        );
    }
}

async function decodeFileToBuffer(
    file: File,
    onProgress?: (progress: number) => void,
): Promise<AudioBuffer> {
    const arrayBuffer = await file.arrayBuffer();
    const blobUrl = URL.createObjectURL(file);
    try {
        return await decodeWithFallbacks(file, arrayBuffer, blobUrl, onProgress);
    } finally {
        URL.revokeObjectURL(blobUrl);
    }
}

function getCorrectionSteps(chunks: CorrectionChunk[]) {
    return chunks
        .map((chunk, index) => {
            const original = chunk.originalText?.trim() ?? "";
            const corrected = chunk.text?.trim() ?? "";
            const note = chunk.correctionNote?.trim() ?? "";
            const changed =
                Boolean(note) ||
                (Boolean(original) &&
                    Boolean(corrected) &&
                    original !== corrected);
            return {
                id: index + 1,
                original,
                corrected,
                note,
                changed,
            };
        })
        .filter((chunk) => chunk.changed);
}

export function AudioManager(props: { transcriber: Transcriber }) {
    const [progress, setProgress] = useState<number | undefined>(undefined);
    const [audioData, setAudioData] = useState<
        | {
              buffer: AudioBuffer;
              url: string;
              mimeType: string;
              fileName: string;
          }
        | undefined
    >(undefined);
    const inputRef = useRef<HTMLInputElement>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [showCorrectionSteps, setShowCorrectionSteps] = useState(false);

    const [batchItems, setBatchItems] = useState<BatchItem[]>([]);
    const [isBatchRunning, setIsBatchRunning] = useState(false);
    const batchItemsRef = useRef<BatchItem[]>([]);
    const batchCancelRef = useRef(false);
    const batchIdRef = useRef(0);

    useEffect(() => {
        batchItemsRef.current = batchItems;
    }, [batchItems]);

    const loadFile = useCallback(
        (file: File) => {
            props.transcriber.onInputChange();
            setAudioData((prev) => {
                if (prev?.url) URL.revokeObjectURL(prev.url);
                return undefined;
            });
            setProgress(0);
            const blobUrl = URL.createObjectURL(file);
            const mimeType = file.type || "audio/*";

            const reader = new FileReader();
            reader.onprogress = (event) => {
                if (event.lengthComputable) {
                    setProgress(event.loaded / event.total);
                }
            };
            reader.onloadend = async () => {
                const arrayBuffer = reader.result as ArrayBuffer;
                if (!arrayBuffer) {
                    setProgress(undefined);
                    return;
                }
                try {
                    const decoded = await decodeWithFallbacks(
                        file,
                        arrayBuffer,
                        blobUrl,
                        setProgress,
                    );
                    setAudioData({
                        buffer: decoded,
                        url: blobUrl,
                        mimeType,
                        fileName: file.name || "音频",
                    });
                } catch (error) {
                    URL.revokeObjectURL(blobUrl);
                    const message =
                        error instanceof Error && error.message
                            ? error.message
                            : "无法解码这个音频文件。请尝试重新导出为 mp3、wav 或 m4a 后再试。";
                    alert(`音频加载失败：${message}`);
                } finally {
                    setProgress(undefined);
                }
            };
            reader.readAsArrayBuffer(file);
        },
        [props.transcriber],
    );

    const updateBatchItem = useCallback(
        (id: string, patch: Partial<BatchItem>) => {
            setBatchItems((prev) =>
                prev.map((item) =>
                    item.id === id ? { ...item, ...patch } : item,
                ),
            );
        },
        [],
    );

    const queueBatchFiles = useCallback(
        (files: File[]) => {
            setAudioData((prev) => {
                if (prev?.url) URL.revokeObjectURL(prev.url);
                return undefined;
            });
            setProgress(undefined);
            props.transcriber.onInputChange();
            setBatchItems(
                files.map((file) => ({
                    id: `batch-${batchIdRef.current++}`,
                    file,
                    fileName: file.name || "音频",
                    status: "pending" as BatchStatus,
                })),
            );
        },
        [props.transcriber],
    );

    const runBatch = useCallback(async () => {
        const queue = batchItemsRef.current.filter(
            (item) => item.status === "pending" || item.status === "error",
        );
        if (queue.length === 0) return;

        batchCancelRef.current = false;
        setIsBatchRunning(true);
        try {
            for (const item of queue) {
                if (batchCancelRef.current) break;
                updateBatchItem(item.id, {
                    status: "processing",
                    error: undefined,
                });
                try {
                    const buffer = await decodeFileToBuffer(item.file);
                    if (batchCancelRef.current) {
                        updateBatchItem(item.id, { status: "pending" });
                        break;
                    }
                    const result = await new Promise<TranscriberData>(
                        (resolve, reject) => {
                            props.transcriber.start(buffer, {
                                fileName: item.fileName,
                                onComplete: resolve,
                                onError: reject,
                            });
                        },
                    );
                    const srt = chunksToSrt(result.chunks);
                    const exported = srt.trim().length > 0;
                    if (exported) {
                        saveBlob(
                            new Blob([srt], { type: "text/srt" }),
                            `${stripFileExtension(item.fileName)}.srt`,
                        );
                    }
                    updateBatchItem(item.id, {
                        status: "done",
                        chunkCount: result.chunks.length,
                        exported,
                    });
                } catch (error) {
                    const message =
                        error instanceof Error && error.message
                            ? error.message
                            : "转写失败";
                    updateBatchItem(item.id, { status: "error", error: message });
                }
            }
        } finally {
            setIsBatchRunning(false);
            batchCancelRef.current = false;
        }
    }, [props.transcriber, updateBatchItem]);

    const stopBatch = useCallback(() => {
        batchCancelRef.current = true;
    }, []);

    const clearBatch = useCallback(() => {
        if (isBatchRunning) return;
        setBatchItems([]);
    }, [isBatchRunning]);

    const handleFiles = useCallback(
        (fileList: FileList | null) => {
            const files = fileList ? Array.from(fileList) : [];
            if (files.length === 0) return;
            if (files.length === 1) {
                setBatchItems([]);
                loadFile(files[0]);
            } else {
                queueBatchFiles(files);
            }
        },
        [loadFile, queueBatchFiles],
    );

    const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (isBatchRunning) {
            e.target.value = "";
            return;
        }
        handleFiles(e.target.files);
        e.target.value = "";
    };

    const onDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
        if (isBatchRunning) return;
        handleFiles(e.dataTransfer.files);
    };

    const onDragOver = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(true);
    };

    const onDragLeave = () => setIsDragging(false);

    return (
        <div className='space-y-6'>
            <section className='rounded-2xl border border-slate-200/80 bg-white/90 p-5 shadow-lg shadow-slate-200/50 backdrop-blur-sm'>
                <h2 className='mb-4 text-lg font-semibold tracking-tight text-slate-900'>
                    音频
                </h2>
                <input
                    ref={inputRef}
                    type='file'
                    multiple
                    accept='audio/*,.mp3,.wav,.m4a,.ogg,.webm,.flac'
                    className='hidden'
                    onChange={onInputChange}
                />
                <button
                    type='button'
                    disabled={isBatchRunning}
                    onClick={() => inputRef.current?.click()}
                    onDrop={onDrop}
                    onDragOver={onDragOver}
                    onDragLeave={onDragLeave}
                    className={`group relative flex w-full flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-14 text-center transition disabled:cursor-not-allowed disabled:opacity-60 ${
                        isDragging
                            ? "border-sky-400 bg-sky-50/80"
                            : "border-slate-300 bg-slate-50/50 hover:border-sky-300 hover:bg-sky-50/40"
                    }`}
                >
                    <span className='mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-sky-100 text-sky-600 transition group-hover:bg-sky-200'>
                        <UploadIcon />
                    </span>
                    <span className='text-base font-medium text-slate-800'>
                        点击或拖拽音频文件到此处
                    </span>
                    <span className='mt-1.5 text-sm text-slate-500'>
                        支持常见格式（mp3、wav、m4a 等）· 可一次选择多个文件批量转写
                    </span>
                </button>
                {progress !== undefined && (
                    <AudioDataBar progress={progress} />
                )}
                <CobaltPageAudio />
            </section>

            {batchItems.length > 0 && (
                <section className='rounded-2xl border border-slate-200/80 bg-white/90 p-5 shadow-lg shadow-slate-200/50 backdrop-blur-sm'>
                    <div className='mb-3 flex items-center justify-between'>
                        <h3 className='text-sm font-semibold text-slate-700'>
                            批量转写队列（
                            {
                                batchItems.filter((i) => i.status === "done")
                                    .length
                            }
                            /{batchItems.length}）
                        </h3>
                        <div className='flex items-center gap-2'>
                            {isBatchRunning ? (
                                <button
                                    type='button'
                                    onClick={stopBatch}
                                    className='rounded-md bg-rose-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-rose-700'
                                >
                                    停止
                                </button>
                            ) : (
                                <>
                                    <button
                                        type='button'
                                        disabled={
                                            props.transcriber.isBusy ||
                                            !batchItems.some(
                                                (i) =>
                                                    i.status === "pending" ||
                                                    i.status === "error",
                                            )
                                        }
                                        onClick={() => {
                                            void runBatch();
                                        }}
                                        className='rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-sky-700 disabled:opacity-40'
                                    >
                                        开始批量转写
                                    </button>
                                    <button
                                        type='button'
                                        onClick={clearBatch}
                                        className='rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50'
                                    >
                                        清空
                                    </button>
                                </>
                            )}
                        </div>
                    </div>
                    <p className='mb-3 text-xs text-slate-500'>
                        按顺序逐个转写，每完成一个会自动下载对应的 .srt 字幕文件。
                    </p>

                    {props.transcriber.progressItems.length > 0 && (
                        <div className='mb-3 rounded-xl border border-amber-100 bg-amber-50/80 p-3'>
                            <p className='mb-2 text-xs font-medium text-amber-900'>
                                正在加载模型文件（仅首次需要下载）
                            </p>
                            {props.transcriber.progressItems.map((data) => (
                                <div key={data.file}>
                                    <Progress
                                        text={data.file}
                                        percentage={data.progress}
                                    />
                                </div>
                            ))}
                        </div>
                    )}

                    <ul className='space-y-2'>
                        {batchItems.map((item, index) => (
                            <li
                                key={item.id}
                                className='rounded-xl border border-slate-200/90 bg-white p-3'
                            >
                                <div className='flex items-center justify-between gap-3'>
                                    <div className='min-w-0 flex-1'>
                                        <p className='truncate text-sm font-medium text-slate-800'>
                                            {index + 1}. {item.fileName}
                                        </p>
                                        <BatchStatusLine
                                            item={item}
                                            transcriber={props.transcriber}
                                        />
                                    </div>
                                    <BatchStatusBadge status={item.status} />
                                </div>
                                {item.status === "processing" && (
                                    <div className='mt-2'>
                                        <Progress
                                            text={
                                                props.transcriber.output
                                                    ?.isFinalizing
                                                    ? "正在收尾"
                                                    : "转写进度"
                                            }
                                            percentage={
                                                props.transcriber.output
                                                    ?.transcriptionProgress ?? 0
                                            }
                                        />
                                    </div>
                                )}
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {audioData && (
                <>
                    <section className='rounded-2xl border border-slate-200/80 bg-white/90 p-5 shadow-lg shadow-slate-200/50 backdrop-blur-sm'>
                        <h3 className='mb-3 text-sm font-semibold text-slate-700'>
                            预览
                        </h3>
                        <AudioPlayer
                            audioUrl={audioData.url}
                            mimeType={audioData.mimeType}
                        />
                    </section>

                    <div className='flex justify-center'>
                        <TranscribeButton
                            onClick={() => {
                                props.transcriber.start(audioData.buffer, {
                                    fileName: audioData.fileName,
                                });
                            }}
                            isModelLoading={props.transcriber.isModelLoading}
                            isTranscribing={props.transcriber.isBusy}
                            isFinalizing={
                                props.transcriber.output?.isFinalizing
                            }
                        />
                    </div>
                    {props.transcriber.output?.isBusy && (
                        <div className='space-y-3 rounded-2xl border border-sky-100 bg-sky-50/80 p-4 text-center'>
                            <p className='text-sm font-medium text-sky-900'>
                                {props.transcriber.output.isFinalizing
                                    ? "正在整理最终结果"
                                    : "正在转写文本"}
                            </p>
                            <Progress
                                text='转写进度'
                                percentage={
                                    props.transcriber.output
                                        .transcriptionProgress
                                }
                            />
                        </div>
                    )}
                    {props.transcriber.output?.isCorrecting && (
                        <div className='space-y-3 rounded-2xl border border-cyan-100 bg-cyan-50/80 p-4 text-center'>
                            <p className='text-sm font-medium text-cyan-900'>
                                正在使用 Qwen 处理字幕
                            </p>
                            <Progress
                                text='Qwen 处理进度'
                                percentage={
                                    Math.max(
                                        props.transcriber.output
                                            .correctionProgress,
                                        props.transcriber.output
                                            .translationProgress,
                                    )
                                }
                            />
                            {props.transcriber.output.qwenChunks.length > 0 && (
                                <div className='text-left'>
                                    <button
                                        type='button'
                                        onClick={() =>
                                            setShowCorrectionSteps(
                                                (prev) => !prev,
                                            )
                                        }
                                        className='text-xs font-medium text-cyan-700 hover:text-cyan-900'
                                    >
                                        {showCorrectionSteps
                                            ? "收起具体修正过程"
                                            : "展开具体修正过程"}
                                    </button>
                                    {showCorrectionSteps && (
                                        <CorrectionProcessPanel
                                            chunks={
                                                props.transcriber.output.qwenChunks
                                            }
                                        />
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                    {props.transcriber.progressItems.length > 0 && (
                        <div className='rounded-2xl border border-amber-100 bg-amber-50/80 p-4 text-center'>
                            <p className='mb-3 text-sm font-medium text-amber-900'>
                                正在加载模型文件（仅首次需要下载）
                            </p>
                            {props.transcriber.progressItems.map((data) => (
                                <div key={data.file}>
                                    <Progress
                                        text={data.file}
                                        percentage={data.progress}
                                    />
                                </div>
                            ))}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

function CorrectionProcessPanel(props: { chunks: CorrectionChunk[] }) {
    const steps = getCorrectionSteps(props.chunks);

    if (steps.length === 0) {
        return (
            <div className='mt-3 rounded-xl border border-sky-100 bg-white/80 p-3 text-xs text-slate-500'>
                修正过程已经开始，当前还没有可展示的明确修正项。
            </div>
        );
    }

    return (
        <div className='mt-3 max-h-72 space-y-2 overflow-y-auto rounded-xl border border-sky-100 bg-white/80 p-3'>
            {steps.map((step) => (
                <div
                    key={`${step.id}-${step.corrected.slice(0, 16)}`}
                    className='rounded-lg border border-slate-100 bg-slate-50 p-3'
                >
                    <p className='mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500'>
                        片段 {step.id}
                    </p>
                    {step.note && (
                        <p className='text-xs text-sky-700'>{step.note}</p>
                    )}
                    {step.original && step.original !== step.corrected && (
                        <p className='mt-2 text-sm text-slate-500 line-through decoration-slate-300'>
                            {step.original}
                        </p>
                    )}
                    <p className='mt-1 text-sm text-slate-800'>
                        {step.corrected || "处理中…"}
                    </p>
                </div>
            ))}
        </div>
    );
}

function BatchStatusLine(props: {
    item: BatchItem;
    transcriber: Transcriber;
}) {
    const { item, transcriber } = props;
    if (item.status === "processing") {
        const output = transcriber.output;
        return (
            <p className='mt-0.5 text-xs text-sky-600'>
                {output?.isFinalizing
                    ? "正在收尾…"
                    : `转写中 ${output?.transcriptionProgress ?? 0}%`}
            </p>
        );
    }
    if (item.status === "done") {
        return (
            <p className='mt-0.5 text-xs text-emerald-600'>
                {item.exported
                    ? `已完成 · 已导出字幕（${item.chunkCount ?? 0} 段）`
                    : "已完成 · 无可导出的字幕内容"}
            </p>
        );
    }
    if (item.status === "error") {
        return (
            <p className='mt-0.5 text-xs text-rose-600'>
                失败：{item.error ?? "未知错误"}
            </p>
        );
    }
    return <p className='mt-0.5 text-xs text-slate-400'>等待中</p>;
}

function BatchStatusBadge(props: { status: BatchStatus }) {
    const map: Record<BatchStatus, { label: string; className: string }> = {
        pending: { label: "等待", className: "bg-slate-100 text-slate-500" },
        processing: { label: "转写中", className: "bg-sky-100 text-sky-700" },
        done: { label: "完成", className: "bg-emerald-100 text-emerald-700" },
        error: { label: "失败", className: "bg-rose-100 text-rose-700" },
    };
    const { label, className } = map[props.status];
    return (
        <span
            className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}
        >
            {label}
        </span>
    );
}

function AudioDataBar(props: { progress: number }) {
    const pct = Math.round(props.progress * 100);
    return (
        <div className='mt-4'>
            <p className='mb-1 text-center text-xs text-slate-500'>
                读取中 {pct}%
            </p>
            <ProgressBar progress={`${pct}%`} />
        </div>
    );
}

function ProgressBar(props: { progress: string }) {
    return (
        <div className='mt-4 h-1.5 w-full overflow-hidden rounded-full bg-slate-200'>
            <div
                className='h-full rounded-full bg-gradient-to-r from-sky-500 to-cyan-500 transition-all duration-150'
                style={{ width: props.progress }}
            />
        </div>
    );
}

function UploadIcon() {
    return (
        <svg
            xmlns='http://www.w3.org/2000/svg'
            fill='none'
            viewBox='0 0 24 24'
            strokeWidth={1.5}
            stroke='currentColor'
            className='h-6 w-6'
        >
            <path
                strokeLinecap='round'
                strokeLinejoin='round'
                d='M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5'
            />
        </svg>
    );
}
