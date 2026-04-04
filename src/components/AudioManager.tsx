import React, { useCallback, useRef, useState } from "react";
import AudioPlayer from "./AudioPlayer";
import { CobaltPageAudio } from "./CobaltPageAudio";
import { TranscribeButton } from "./TranscribeButton";
import Constants from "../utils/Constants";
import { Transcriber } from "../hooks/useTranscriber";
import Progress from "./Progress";

type CorrectionChunk = {
    text: string;
    originalText?: string;
    correctionNote?: string;
};

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
                const audioCTX = new AudioContext({
                    sampleRate: Constants.SAMPLING_RATE,
                });
                const decoded = await audioCTX.decodeAudioData(
                    arrayBuffer.slice(0),
                );
                setProgress(undefined);
                setAudioData({
                    buffer: decoded,
                    url: blobUrl,
                    mimeType,
                    fileName: file.name || "音频",
                });
            };
            reader.readAsArrayBuffer(file);
        },
        [props.transcriber],
    );

    const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) loadFile(file);
        e.target.value = "";
    };

    const onDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
        const file = e.dataTransfer.files?.[0];
        if (file) loadFile(file);
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
                    accept='audio/*,.mp3,.wav,.m4a,.ogg,.webm,.flac'
                    className='hidden'
                    onChange={onInputChange}
                />
                <button
                    type='button'
                    onClick={() => inputRef.current?.click()}
                    onDrop={onDrop}
                    onDragOver={onDragOver}
                    onDragLeave={onDragLeave}
                    className={`group relative flex w-full flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-14 text-center transition ${
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
                        支持常见格式（mp3、wav、m4a 等）
                    </span>
                </button>
                {progress !== undefined && (
                    <AudioDataBar progress={progress} />
                )}
                <CobaltPageAudio />
            </section>

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
