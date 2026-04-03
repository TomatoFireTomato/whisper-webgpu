import { env, pipeline, WhisperTextStreamer } from "@huggingface/transformers";

// ONNX Runtime WASM：使用本地 public/ort/
const ortWasmBase = new URL(
    /* @vite-ignore */ "../ort/",
    import.meta.url,
).href;
if (env.backends.onnx?.wasm) {
    env.backends.onnx.wasm.wasmPaths = ortWasmBase;
    // 单线程 WASM，减少子 Worker + 双模型时的总内存（扩展/低内存设备更稳）
    env.backends.onnx.wasm.numThreads = 1;
}

const HF_OFFICIAL_HOST = "https://huggingface.co/";
const HF_MIRROR_HOST = "https://hf-mirror.com/";

class PipelineFactory {
    static task = null;
    static model = null;
    static instance = null;

    static async getInstance(progress_callback = null) {
        if (this.instance === null) {
            // pipeline() 返回 Promise，必须 await，否则 instance 不是可 dispose 的对象
            this.instance = await pipeline(this.task, this.model, {
                dtype: {
                    encoder_model:
                        this.model === "onnx-community/whisper-large-v3-turbo"
                            ? "fp16"
                            : "fp32",
                    decoder_model_merged: "q4",
                },
                device: "webgpu",
                progress_callback,
            });
        }

        return this.instance;
    }
}

class AutomaticSpeechRecognitionPipelineFactory extends PipelineFactory {
    static task = "automatic-speech-recognition";
    static model = null;
}

async function disposeAutomaticSpeechRecognition() {
    const p = AutomaticSpeechRecognitionPipelineFactory;
    if (p.instance !== null) {
        try {
            await p.instance.dispose();
        } catch (e) {
            console.warn("ASR dispose:", e);
        }
        p.instance = null;
    }
}

/** 将 worker 抛出的非 Error（如 ORT 数字码）转成可读 Error 再发到主线程 */
function serializeWorkerError(e) {
    if (e instanceof Error) return e;
    if (typeof e === "number") {
        return new Error(
            `ONNX/WASM 内部错误 ${e}（常见：显存或内存不足；可换更小 Whisper、关闭其他标签页，或仅使用转写）`,
        );
    }
    const s = String(e);
    if (/^\d{5,}$/.test(s.trim())) {
        return new Error(
            `ONNX/WASM 内部错误 ${s.trim()}（常见：内存不足；可尝试更小识别模型或暂不翻译）`,
        );
    }
    return new Error(s);
}

function normalizeChunks(chunks) {
    if (!Array.isArray(chunks)) return [];
    return chunks.map((c) => ({
        text: c.text ?? "",
        timestamp: [...(c.timestamp ?? [0, 0])],
        finalised: c.finalised,
    }));
}

self.addEventListener("message", async (event) => {
    const transcript = await transcribe(event.data);
    if (transcript === null) return;

    self.postMessage({
        status: "complete",
        data: transcript,
    });
});

const transcribe = async ({
    audio,
    model,
    subtask,
    language,
    useHfMirror = false,
}) => {
    env.remoteHost = useHfMirror ? HF_MIRROR_HOST : HF_OFFICIAL_HOST;

    const isDistilWhisper = model.startsWith("distil-whisper/");

    const p = AutomaticSpeechRecognitionPipelineFactory;
    if (p.model !== model) {
        p.model = model;

        if (p.instance !== null) {
            await p.instance.dispose();
            p.instance = null;
        }
    }

    const transcriber = await p.getInstance((data) => {
        self.postMessage(data);
    });

    const time_precision =
        transcriber.processor.feature_extractor.config.chunk_length /
        transcriber.model.config.max_source_positions;

    const chunks = [];

    const chunk_length_s = isDistilWhisper ? 20 : 30;
    const stride_length_s = isDistilWhisper ? 3 : 5;

    let chunk_count = 0;
    let start_time;
    let num_tokens = 0;
    let tps;
    const streamer = new WhisperTextStreamer(transcriber.tokenizer, {
        time_precision,
        on_chunk_start: (x) => {
            const offset = (chunk_length_s - stride_length_s) * chunk_count;
            chunks.push({
                text: "",
                timestamp: [offset + x, null],
                finalised: false,
                offset,
            });
        },
        token_callback_function: () => {
            start_time ??= performance.now();
            if (num_tokens++ > 0) {
                tps = (num_tokens / (performance.now() - start_time)) * 1000;
            }
        },
        callback_function: (x) => {
            if (chunks.length === 0) return;
            chunks.at(-1).text += x;

            self.postMessage({
                status: "update",
                data: {
                    text: "",
                    chunks,
                    tps,
                },
            });
        },
        on_chunk_end: (x) => {
            const current = chunks.at(-1);
            current.timestamp[1] = x + current.offset;
            current.finalised = true;
        },
        on_finalize: () => {
            start_time = null;
            num_tokens = 0;
            ++chunk_count;
        },
    });

    const output = await transcriber(audio, {
        top_k: 0,
        do_sample: false,
        chunk_length_s,
        stride_length_s,
        language,
        task: subtask,
        return_timestamps: true,
        force_full_sequences: false,
        streamer,
    }).catch((error) => {
        console.error(error);
        self.postMessage({
            status: "error",
            data: serializeWorkerError(error),
        });
        return null;
    });

    if (output === null) return null;

    const resultChunks = normalizeChunks(output.chunks ?? chunks);

    const result = {
        tps,
        ...output,
        chunks: resultChunks,
    };

    await disposeAutomaticSpeechRecognition();
    await new Promise((r) => setTimeout(r, 150));

    return result;
};
