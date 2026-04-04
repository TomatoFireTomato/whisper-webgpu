import { env, pipeline, WhisperTextStreamer } from "@huggingface/transformers";

const ortWasmBase = new URL(
    /* @vite-ignore */ "../ort/",
    import.meta.url,
).href;
if (env.backends.onnx?.wasm) {
    env.backends.onnx.wasm.wasmPaths = ortWasmBase;
    env.backends.onnx.wasm.numThreads = 1;
}

const HF_OFFICIAL_HOST = "https://huggingface.co/";
const HF_MIRROR_HOST = "https://hf-mirror.com/";
const QWEN_MODEL = "onnx-community/Qwen2.5-0.5B-Instruct";
const POSTPROCESS_BATCH_SIZE = 6;

class PipelineFactory {
    static task = null;
    static model = null;
    static instance = null;

    static buildPipelineOptions(progress_callback = null) {
        return {
            device: "webgpu",
            progress_callback,
        };
    }

    static async getInstance(progress_callback = null) {
        if (this.instance === null) {
            this.instance = await pipeline(
                this.task,
                this.model,
                this.buildPipelineOptions(progress_callback),
            );
        }
        return this.instance;
    }
}

class AutomaticSpeechRecognitionPipelineFactory extends PipelineFactory {
    static task = "automatic-speech-recognition";
    static model = null;

    static buildPipelineOptions(progress_callback = null) {
        return {
            dtype: {
                encoder_model:
                    this.model === "onnx-community/whisper-large-v3-turbo"
                        ? "fp16"
                        : "fp32",
                decoder_model_merged: "q4",
            },
            device: "webgpu",
            progress_callback,
        };
    }
}

class TextGenerationPipelineFactory extends PipelineFactory {
    static task = "text-generation";
    static model = null;

    static buildPipelineOptions(progress_callback = null) {
        return {
            dtype: "q4",
            device: "webgpu",
            progress_callback,
        };
    }
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

async function disposeTextGeneration() {
    const p = TextGenerationPipelineFactory;
    if (p.instance !== null) {
        try {
            await p.instance.dispose();
        } catch (e) {
            console.warn("Text generation dispose:", e);
        }
        p.instance = null;
    }
}

async function waitForMemoryRelease(ms = 250) {
    await new Promise((r) => setTimeout(r, ms));
}

function serializeWorkerError(e) {
    if (e instanceof Error) return e;
    if (typeof e === "number") {
        return new Error(
            `ONNX/WASM 内部错误 ${e}（常见：显存或内存不足；可换更小模型、关闭其他标签页后重试）`,
        );
    }
    const s = String(e).trim();
    return new Error(s || "未知错误");
}

function normalizeChunks(chunks) {
    if (!Array.isArray(chunks)) return [];
    return chunks.map((c) => ({
        text: c.text ?? "",
        originalText:
            typeof c.originalText === "string" ? c.originalText : c.text ?? "",
        timestamp: [...(c.timestamp ?? [0, 0])],
        translation: typeof c.translation === "string" ? c.translation : "",
        correctionNote:
            typeof c.correctionNote === "string" ? c.correctionNote : "",
        finalised: c.finalised,
    }));
}

function buildTranscriptText(chunks) {
    return chunks.map((chunk) => chunk.text || "").join("").trim();
}

function chunkForPostProcess(chunks) {
    const batches = [];
    let current = [];
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const text = typeof chunk.text === "string" ? chunk.text.trim() : "";
        if (!text) continue;
        current.push({ id: i + 1, text });
        if (current.length >= POSTPROCESS_BATCH_SIZE) {
            batches.push(current);
            current = [];
        }
    }
    if (current.length > 0) batches.push(current);
    return batches;
}

function stripCodeFence(text) {
    return text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
}

function extractJsonArray(text) {
    const cleaned = stripCodeFence(text);
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    if (start === -1 || end === -1 || end < start) return "";
    return cleaned.slice(start, end + 1);
}

function parseJsonResponse(raw) {
    const json = extractJsonArray(raw);
    if (!json) return null;
    try {
        return JSON.parse(json);
    } catch {
        return null;
    }
}

function parseCorrectionResponse(raw, batch) {
    const parsed = parseJsonResponse(raw);
    if (!Array.isArray(parsed)) return null;

    const byId = new Map();
    for (const item of parsed) {
        if (!item || typeof item !== "object") continue;
        const id = Number(item.id);
        if (!Number.isInteger(id)) continue;
        byId.set(id, {
            text:
                typeof item.text === "string" && item.text.trim()
                    ? item.text.trim()
                    : null,
            note:
                typeof item.note === "string" && item.note.trim()
                    ? item.note.trim()
                    : "",
        });
    }

    return batch.map((entry) => ({
        id: entry.id,
        text: byId.get(entry.id)?.text ?? entry.text,
        note: byId.get(entry.id)?.note ?? "",
    }));
}

function parseProcessResponse(raw, batch) {
    const parsed = parseJsonResponse(raw);
    if (!Array.isArray(parsed)) return null;

    const byId = new Map();
    for (const item of parsed) {
        if (!item || typeof item !== "object") continue;
        const id = Number(item.id);
        if (!Number.isInteger(id)) continue;
        byId.set(id, {
            text:
                typeof item.text === "string" && item.text.trim()
                    ? item.text.trim()
                    : null,
            translation:
                typeof item.translation === "string" && item.translation.trim()
                    ? item.translation.trim()
                    : "",
            note:
                typeof item.note === "string" && item.note.trim()
                    ? item.note.trim()
                    : "",
        });
    }

    return batch.map((entry) => ({
        id: entry.id,
        text: byId.get(entry.id)?.text ?? entry.text,
        translation: byId.get(entry.id)?.translation ?? "",
        note: byId.get(entry.id)?.note ?? "",
    }));
}

function buildFallbackCorrectionNote(originalText, correctedText) {
    const original = typeof originalText === "string" ? originalText.trim() : "";
    const corrected =
        typeof correctedText === "string" ? correctedText.trim() : "";

    if (!original || !corrected || original === corrected) return "";

    const normalizedOriginal = original.replace(/\s+/g, "");
    const normalizedCorrected = corrected.replace(/\s+/g, "");

    if (normalizedOriginal === normalizedCorrected) {
        return "调整了断句或空格格式。";
    }

    const punctuationPattern = /[.,!?;:，。！？；：“”"'、（）()\-[\]【】]/g;
    const strippedOriginal = original.replace(punctuationPattern, "");
    const strippedCorrected = corrected.replace(punctuationPattern, "");
    if (strippedOriginal === strippedCorrected) {
        return "修正了标点或语气停顿。";
    }

    if (
        Math.abs(corrected.length - original.length) >= 6 ||
        corrected.includes(" ") !== original.includes(" ")
    ) {
        return "结合上下文调整了句式和表达。";
    }

    return "根据上下文修正了识别文本。";
}

function parseTranslationResponse(raw, batch) {
    const parsed = parseJsonResponse(raw);
    if (!Array.isArray(parsed)) return null;

    const byId = new Map();
    for (const item of parsed) {
        if (!item || typeof item !== "object") continue;
        const id = Number(item.id);
        if (!Number.isInteger(id)) continue;
        byId.set(
            id,
            typeof item.translation === "string" ? item.translation.trim() : "",
        );
    }

    return batch.map((entry) => ({
        id: entry.id,
        translation: byId.get(entry.id) ?? "",
    }));
}

function hasTranslationText(value) {
    return typeof value === "string" && value.trim().length > 0;
}

function groupArray(items, size) {
    const groups = [];
    for (let i = 0; i < items.length; i += size) {
        groups.push(items.slice(i, i + size));
    }
    return groups;
}

function clampPercentage(value) {
    return Math.max(0, Math.min(100, Math.round(value)));
}

function countMatches(text, pattern) {
    const matches = text.match(pattern);
    return matches ? matches.length : 0;
}

function getScriptProfile(text) {
    const value = typeof text === "string" ? text : "";
    const compact = value.replace(/\s+/g, "");
    const letters = compact.length || 1;

    return {
        letters,
        latin: countMatches(compact, /[A-Za-z]/g),
        hiragana: countMatches(compact, /[\u3040-\u309F]/g),
        katakana: countMatches(compact, /[\u30A0-\u30FF]/g),
        hangul: countMatches(compact, /[\uAC00-\uD7AF]/g),
        han: countMatches(compact, /[\u4E00-\u9FFF]/g),
    };
}

function ratio(count, total) {
    return total > 0 ? count / total : 0;
}

function shouldRejectTranslatedCorrection(originalText, correctedText, sourceLanguage) {
    const original = typeof originalText === "string" ? originalText.trim() : "";
    const corrected =
        typeof correctedText === "string" ? correctedText.trim() : "";

    if (!original || !corrected || original === corrected) return false;

    const source = (sourceLanguage || "").toLowerCase();
    const originalProfile = getScriptProfile(original);
    const correctedProfile = getScriptProfile(corrected);

    const originalLatinRatio = ratio(
        originalProfile.latin,
        originalProfile.letters,
    );
    const correctedLatinRatio = ratio(
        correctedProfile.latin,
        correctedProfile.letters,
    );
    const originalHanRatio = ratio(originalProfile.han, originalProfile.letters);
    const correctedHanRatio = ratio(
        correctedProfile.han,
        correctedProfile.letters,
    );
    const originalKanaRatio = ratio(
        originalProfile.hiragana + originalProfile.katakana,
        originalProfile.letters,
    );
    const correctedKanaRatio = ratio(
        correctedProfile.hiragana + correctedProfile.katakana,
        correctedProfile.letters,
    );
    const originalHangulRatio = ratio(
        originalProfile.hangul,
        originalProfile.letters,
    );
    const correctedHangulRatio = ratio(
        correctedProfile.hangul,
        correctedProfile.letters,
    );

    if (
        (source.startsWith("ja") || originalKanaRatio > 0.12) &&
        originalKanaRatio > 0.12 &&
        correctedKanaRatio < 0.03 &&
        correctedHanRatio > 0.25
    ) {
        return true;
    }

    if (
        (source.startsWith("en") || originalLatinRatio > 0.6) &&
        originalLatinRatio > 0.6 &&
        correctedLatinRatio < 0.2 &&
        correctedHanRatio > 0.2
    ) {
        return true;
    }

    if (
        (source.startsWith("ko") || originalHangulRatio > 0.4) &&
        originalHangulRatio > 0.4 &&
        correctedHangulRatio < 0.1 &&
        correctedHanRatio > 0.2
    ) {
        return true;
    }

    return false;
}

function createCorrectionMessages(batch, sourceLanguage) {
    const source = sourceLanguage && sourceLanguage !== "auto" ? sourceLanguage : "原语言";
    return [
        {
            role: "system",
            content:
                "你是多语言字幕纠错助手。你的任务只是不改变语言地修正 ASR 字幕中的识别错误、错别字、语法和标点问题。text 字段必须保留原语言，绝对禁止翻译成中文或任何其他语言，绝对禁止解释、改写、总结、润色成另一种语言，绝对禁止合并或拆分字幕。若某条无法确定，就保留原文。只输出 JSON 数组，不要输出 markdown 或解释。JSON 结构固定为 [{\"id\":1,\"text\":\"修正后的原文\",\"note\":\"用简体中文概述本条主要修正；如果改动很小则留空\"}]。",
        },
        {
            role: "user",
            content: [
                `请处理以下 ${source} 字幕片段。`,
                "要求：",
                "1. text 字段必须保持原语言，不得翻译成中文或其他语言。",
                "2. 只修正识别错误、错别字、标点、语法和断句问题。",
                "3. note 字段用简体中文简要概述主要修正内容；若变化极小可留空。",
                "4. 保持 id 不变，数组长度不变。",
                "5. 只做最小必要修改；如果不确定就保留原文。",
                "",
                JSON.stringify(batch, null, 2),
            ].join("\n"),
        },
    ];
}

function createTranslationMessages(batch, sourceLanguage, targetLanguage) {
    const source = sourceLanguage && sourceLanguage !== "auto" ? sourceLanguage : "原语言";
    const target = targetLanguage || "简体中文";
    return [
        {
            role: "system",
            content:
                "你是多语言字幕翻译助手。请根据上下文将字幕翻译成目标语言，不得编造，不得合并或拆分字幕。只输出 JSON 数组，不要输出 markdown 或解释。JSON 结构固定为 [{\"id\":1,\"translation\":\"译文\"}]。",
        },
        {
            role: "user",
            content: [
                `请把以下 ${source} 字幕翻译成 ${target}。`,
                "要求：",
                "1. translation 字段写目标语言译文。",
                "2. 保持 id 不变，数组长度不变。",
                "3. 语言自然、简洁，适合视频字幕。",
                "",
                JSON.stringify(batch, null, 2),
            ].join("\n"),
        },
    ];
}

function createProcessMessages(batch, sourceLanguage, targetLanguage) {
    const source = sourceLanguage && sourceLanguage !== "auto" ? sourceLanguage : "原语言";
    const target = targetLanguage || "简体中文";
    return [
        {
            role: "system",
            content:
                "你是多语言字幕处理助手。请根据上下文同时完成两件事：1. 在 text 字段中保留原语言并保守修正识别错误、错别字、语法、标点和断句；绝对禁止把 text 翻译成中文或任何其他语言。2. 在 translation 字段中把修正后的字幕翻译成目标语言。不得编造，不得合并或拆分字幕。若无法确定 text，就保留原文；若 translation 难以判断，也要尽量给出自然简洁的字幕译文。只输出 JSON 数组，不要输出 markdown 或解释。JSON 结构固定为 [{\"id\":1,\"text\":\"修正后的原文\",\"translation\":\"译文\",\"note\":\"用简体中文概述本条主要修正；如果改动很小则留空\"}]。",
        },
        {
            role: "user",
            content: [
                `请处理以下 ${source} 字幕片段，并翻译成 ${target}。`,
                "要求：",
                "1. text 字段必须保持原语言，不得翻译成中文或其他语言。",
                "2. translation 字段写目标语言译文，适合视频字幕。",
                "3. note 字段用简体中文简要概述主要修正内容；若变化极小可留空。",
                "4. 保持 id 不变，数组长度不变。",
                "5. 只做最小必要修正；如果 text 不确定就保留原文。",
                "",
                JSON.stringify(batch, null, 2),
            ].join("\n"),
        },
    ];
}

function createTranslationRepairMessages(batch, sourceLanguage, targetLanguage) {
    const source = sourceLanguage && sourceLanguage !== "auto" ? sourceLanguage : "原语言";
    const target = targetLanguage || "简体中文";
    return [
        {
            role: "system",
            content:
                "你是多语言字幕翻译校对助手。请根据上下文为缺失译文的字幕补全翻译，并顺带校正用词一致性。每一条都必须返回非空 translation，不得遗漏，不得编造，不得合并或拆分字幕。只输出 JSON 数组，不要输出 markdown 或解释。JSON 结构固定为 [{\"id\":1,\"translation\":\"译文\"}]。",
        },
        {
            role: "user",
            content: [
                `请把以下 ${source} 字幕补全并校对为 ${target} 字幕。`,
                "要求：",
                "1. 所有条目都必须返回非空 translation。",
                "2. 结合前后文，修正用词不统一或明显不自然的翻译。",
                "3. 保持 id 不变，数组长度不变。",
                "",
                JSON.stringify(batch, null, 2),
            ].join("\n"),
        },
    ];
}

function collectMissingTranslationEntries(chunks, windowSize = 1) {
    const missing = [];
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (!chunk?.text?.trim() || hasTranslationText(chunk.translation)) continue;
        missing.push({
            id: i + 1,
            text: chunk.text.trim(),
            prev:
                chunks[i - windowSize]?.text?.trim() ||
                chunks[i - 1]?.text?.trim() ||
                "",
            next:
                chunks[i + windowSize]?.text?.trim() ||
                chunks[i + 1]?.text?.trim() ||
                "",
        });
    }
    return missing;
}

async function getTextGenerator(progress_callback = null) {
    const p = TextGenerationPipelineFactory;
    if (p.model !== QWEN_MODEL) {
        p.model = QWEN_MODEL;
        if (p.instance !== null) {
            await p.instance.dispose();
            p.instance = null;
        }
    }
    return await p.getInstance(progress_callback);
}

async function runTranslationGeneration(
    generator,
    messages,
    maxNewTokens = 320,
) {
    const output = await generator(messages, {
        do_sample: false,
        max_new_tokens: maxNewTokens,
        repetition_penalty: 1.05,
    });
    return output?.[0]?.generated_text?.at?.(-1)?.content ?? "";
}

async function translateBatchWithRetry(
    generator,
    batch,
    sourceLanguage,
    targetLanguage,
) {
    const attempts = [
        {
            messages: createTranslationMessages(
                batch,
                sourceLanguage,
                targetLanguage,
            ),
            maxNewTokens: 320,
        },
        {
            messages: createTranslationRepairMessages(
                batch,
                sourceLanguage,
                targetLanguage,
            ),
            maxNewTokens: 320,
        },
    ];

    for (const attempt of attempts) {
        try {
            const assistant = await runTranslationGeneration(
                generator,
                attempt.messages,
                attempt.maxNewTokens,
            );
            const parsed = parseTranslationResponse(assistant, batch);
            if (!parsed) continue;

            const translatedCount = parsed.filter((item) =>
                hasTranslationText(item.translation),
            ).length;
            if (translatedCount === 0) continue;

            return parsed;
        } catch (error) {
            console.warn("Transcript translation batch attempt failed:", error);
        }
    }

    return null;
}

function applyParsedTranslations(chunks, parsed) {
    let applied = 0;
    for (const item of parsed ?? []) {
        const idx = item.id - 1;
        if (!chunks[idx]) continue;
        if (!hasTranslationText(item.translation)) continue;
        chunks[idx].translation = item.translation;
        applied += 1;
    }
    return applied;
}

function postTranslationUpdate(normalizedChunks, language, translationProgress) {
    self.postMessage({
        status: "translation_update",
        data: {
            text: buildTranscriptText(normalizedChunks),
            chunks: normalizedChunks,
            hasQwenTranslation: normalizedChunks.some((chunk) =>
                Boolean(chunk.translation?.trim()),
            ),
            language,
            translationProgress: clampPercentage(translationProgress),
        },
    });
}

function postCorrectionUpdate(result, correctionSummary, correctionProgress) {
    self.postMessage({
        status: "correction_update",
        data: {
            text: result.text,
            chunks: result.chunks,
            tps: result.tps,
            correctionProgress,
            correctionSummary,
            hasQwenCorrection: true,
            hasQwenTranslation: result.chunks.some((chunk) =>
                Boolean(chunk.translation?.trim()),
            ),
            language: result.language,
        },
    });
}

function postQwenProcessUpdate(result, correctionSummary, progress) {
    self.postMessage({
        status: "qwen_update",
        data: {
            text: result.text,
            chunks: result.chunks,
            tps: result.tps,
            correctionProgress: progress,
            correctionSummary,
            hasQwenCorrection: true,
            hasQwenTranslation: result.chunks.some((chunk) =>
                Boolean(chunk.translation?.trim()),
            ),
            language: result.language,
            translationProgress: progress,
        },
    });
}

async function correctTranscript(result, sourceLanguage) {
    const batches = chunkForPostProcess(result.chunks);
    if (batches.length === 0) {
        return {
            ...result,
            correctionSummary: [],
            correctionProgress: 100,
            hasQwenCorrection: false,
            hasQwenTranslation: false,
        };
    }

    const generator = await getTextGenerator((data) => self.postMessage(data));
    const correctionSummary = [];

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];
        try {
            const output = await generator(
                createCorrectionMessages(batch, sourceLanguage ?? result.language),
                {
                    do_sample: false,
                    max_new_tokens: 360,
                    repetition_penalty: 1.05,
                },
            );
            const assistant =
                output?.[0]?.generated_text?.at?.(-1)?.content ?? "";
            const parsed = parseCorrectionResponse(assistant, batch);
            if (!parsed) continue;

            for (const item of parsed) {
                const idx = item.id - 1;
                if (!result.chunks[idx]) continue;
                const originalText =
                    result.chunks[idx].originalText || result.chunks[idx].text;
                result.chunks[idx].originalText = originalText;
                const rejectedAsTranslation = shouldRejectTranslatedCorrection(
                    originalText,
                    item.text,
                    result.language ?? sourceLanguage,
                );
                const safeCorrectedText = rejectedAsTranslation
                    ? originalText
                    : item.text;
                result.chunks[idx].text = safeCorrectedText;
                const correctionNote =
                    rejectedAsTranslation
                        ? ""
                        : safeCorrectedText === originalText
                          ? item.note
                        : item.note ||
                          buildFallbackCorrectionNote(
                              originalText,
                              safeCorrectedText,
                          );
                result.chunks[idx].correctionNote = correctionNote;
                if (correctionNote) correctionSummary.push(correctionNote);
            }

            result.text = buildTranscriptText(result.chunks);
            postCorrectionUpdate(
                result,
                correctionSummary,
                Math.round(
                    ((batchIndex + 1) / Math.max(batches.length, 1)) * 100,
                ),
            );
        } catch (error) {
            console.warn("Transcript correction failed:", error);
        }
    }

    await disposeTextGeneration();
    await waitForMemoryRelease(100);

    return {
        ...result,
        correctionSummary,
        correctionProgress: 100,
        hasQwenCorrection: true,
        hasQwenTranslation: false,
    };
}

async function translateTranscript({ chunks, language, targetLanguage = "zh-CN" }) {
    const normalizedChunks = normalizeChunks(chunks);
    const batches = chunkForPostProcess(normalizedChunks);
    if (batches.length === 0) {
        return {
            text: buildTranscriptText(normalizedChunks),
            chunks: normalizedChunks,
            hasQwenTranslation: false,
        };
    }

    const generator = await getTextGenerator((data) => self.postMessage(data));
    postTranslationUpdate(normalizedChunks, language, 3);

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];
        const parsed = await translateBatchWithRetry(
            generator,
            batch,
            language,
            targetLanguage,
        );
        if (parsed) {
            applyParsedTranslations(normalizedChunks, parsed);
        }

        postTranslationUpdate(
            normalizedChunks,
            language,
            5 + ((batchIndex + 1) / Math.max(batches.length, 1)) * 65,
        );
    }

    const missingEntries = collectMissingTranslationEntries(normalizedChunks);
    if (missingEntries.length > 0) {
        const repairGroups = groupArray(missingEntries, 4);
        for (let repairIndex = 0; repairIndex < repairGroups.length; repairIndex++) {
            const group = repairGroups[repairIndex];
            const parsed = await translateBatchWithRetry(
                generator,
                group,
                language,
                targetLanguage,
            );
            if (parsed) {
                applyParsedTranslations(normalizedChunks, parsed);
            }

            postTranslationUpdate(
                normalizedChunks,
                language,
                70 +
                    ((repairIndex + 1) / Math.max(repairGroups.length, 1)) * 20,
            );
        }
    }

    const finalMissingEntries = collectMissingTranslationEntries(normalizedChunks, 2);
    for (let missingIndex = 0; missingIndex < finalMissingEntries.length; missingIndex++) {
        const entry = finalMissingEntries[missingIndex];
        const parsed = await translateBatchWithRetry(
            generator,
            [entry],
            language,
            targetLanguage,
        );
        if (parsed) {
            applyParsedTranslations(normalizedChunks, parsed);
        }

        postTranslationUpdate(
            normalizedChunks,
            language,
            90 +
                ((missingIndex + 1) / Math.max(finalMissingEntries.length, 1)) *
                    8,
        );
    }

    for (const chunk of normalizedChunks) {
        if (chunk.text?.trim() && !hasTranslationText(chunk.translation)) {
            chunk.translation = chunk.text.trim();
        }
    }

    postTranslationUpdate(normalizedChunks, language, 100);

    await disposeTextGeneration();
    await waitForMemoryRelease(100);

    return {
        text: buildTranscriptText(normalizedChunks),
        chunks: normalizedChunks,
        hasQwenTranslation: normalizedChunks.some((chunk) =>
            Boolean(chunk.translation?.trim()),
        ),
        translationProgress: 100,
    };
}

async function processTranscript({
    chunks,
    text,
    language,
    tps,
    targetLanguage = "zh-CN",
}) {
    const normalizedChunks = normalizeChunks(chunks);
    const batches = chunkForPostProcess(normalizedChunks);
    if (batches.length === 0) {
        return {
            text: text || buildTranscriptText(normalizedChunks),
            chunks: normalizedChunks,
            tps,
            language: language ?? null,
            correctionSummary: [],
            correctionProgress: 100,
            translationProgress: 100,
            hasQwenCorrection: false,
            hasQwenTranslation: false,
        };
    }

    const generator = await getTextGenerator((data) => self.postMessage(data));
    const correctionSummary = [];
    const result = {
        text: text || buildTranscriptText(normalizedChunks),
        chunks: normalizedChunks,
        tps,
        language: language ?? null,
    };

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];
        try {
            const output = await generator(
                createProcessMessages(batch, language, targetLanguage),
                {
                    do_sample: false,
                    max_new_tokens: 420,
                    repetition_penalty: 1.05,
                },
            );
            const assistant =
                output?.[0]?.generated_text?.at?.(-1)?.content ?? "";
            const parsed = parseProcessResponse(assistant, batch);
            if (!parsed) continue;

            for (const item of parsed) {
                const idx = item.id - 1;
                if (!result.chunks[idx]) continue;
                const originalText =
                    result.chunks[idx].originalText || result.chunks[idx].text;
                result.chunks[idx].originalText = originalText;
                const rejectedAsTranslation = shouldRejectTranslatedCorrection(
                    originalText,
                    item.text,
                    result.language ?? language,
                );
                const safeCorrectedText = rejectedAsTranslation
                    ? originalText
                    : item.text;
                result.chunks[idx].text = safeCorrectedText;
                result.chunks[idx].translation = hasTranslationText(
                    item.translation,
                )
                    ? item.translation
                    : safeCorrectedText;
                const correctionNote =
                    rejectedAsTranslation
                        ? ""
                        : safeCorrectedText === originalText
                          ? item.note
                          : item.note ||
                            buildFallbackCorrectionNote(
                                originalText,
                                safeCorrectedText,
                            );
                result.chunks[idx].correctionNote = correctionNote;
                if (correctionNote) correctionSummary.push(correctionNote);
            }

            result.text = buildTranscriptText(result.chunks);
            postQwenProcessUpdate(
                result,
                correctionSummary,
                Math.round(
                    ((batchIndex + 1) / Math.max(batches.length, 1)) * 100,
                ),
            );
        } catch (error) {
            console.warn("Transcript process failed:", error);
        }
    }

    for (const chunk of result.chunks) {
        if (chunk.text?.trim() && !hasTranslationText(chunk.translation)) {
            chunk.translation = chunk.text.trim();
        }
    }

    await disposeTextGeneration();
    await waitForMemoryRelease(100);

    return {
        ...result,
        correctionSummary,
        correctionProgress: 100,
        translationProgress: 100,
        hasQwenCorrection: true,
        hasQwenTranslation: result.chunks.some((chunk) =>
            Boolean(chunk.translation?.trim()),
        ),
    };
}

async function transcribe({
    audio,
    model,
    subtask,
    language,
    audioDuration = 0,
    useHfMirror = false,
}) {
    env.remoteHost = useHfMirror ? HF_MIRROR_HOST : HF_OFFICIAL_HOST;
    let inputAudio = audio;

    const isDistilWhisper = model.startsWith("distil-whisper/");

    const p = AutomaticSpeechRecognitionPipelineFactory;
    if (p.model !== model) {
        p.model = model;
        if (p.instance !== null) {
            await p.instance.dispose();
            p.instance = null;
        }
    }

    const transcriber = await p.getInstance((data) => self.postMessage(data));

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
    const getTranscriptionProgress = () => {
        if (!audioDuration || audioDuration <= 0) return 0;
        let currentEnd = 0;
        for (const chunk of chunks) {
            const end = chunk?.timestamp?.[1];
            if (typeof end === "number" && end > currentEnd) currentEnd = end;
        }
        return Math.max(
            0,
            Math.min(99, Math.round((currentEnd / audioDuration) * 100)),
        );
    };

    const streamer = new WhisperTextStreamer(transcriber.tokenizer, {
        time_precision,
        on_chunk_start: (x) => {
            const offset = (chunk_length_s - stride_length_s) * chunk_count;
            chunks.push({
                text: "",
                originalText: "",
                timestamp: [offset + x, null],
                correctionNote: "",
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
            const current = chunks.at(-1);
            current.text += x;
            current.originalText = current.text;

            self.postMessage({
                status: "update",
                data: {
                    text: buildTranscriptText(chunks),
                    chunks,
                    tps,
                    transcriptionProgress: getTranscriptionProgress(),
                    language,
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

    const output = await transcriber(inputAudio, {
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
    inputAudio = null;

    if (output === null) return null;

    const resultChunks = normalizeChunks(output.chunks ?? chunks);
    const result = {
        tps,
        text:
            typeof output.text === "string"
                ? output.text
                : buildTranscriptText(resultChunks),
        language: output.language ?? language ?? null,
        chunks: resultChunks,
    };

    chunks.length = 0;
    if (Array.isArray(output.chunks)) output.chunks.length = 0;

    await disposeAutomaticSpeechRecognition();
    await waitForMemoryRelease();

    return {
        ...result,
        transcriptionProgress: 100,
    };
}

self.addEventListener("message", async (event) => {
    const payload = event.data ?? {};
    const action = payload.action ?? "transcribe";

    try {
        if (action === "process") {
            const processed = await processTranscript(payload);
            self.postMessage({
                status: "qwen_complete",
                data: processed,
            });
            return;
        }

        if (action === "correct") {
            const corrected = await correctTranscript({
                tps: payload.tps,
                text:
                    typeof payload.text === "string"
                        ? payload.text
                        : buildTranscriptText(normalizeChunks(payload.chunks)),
                language: payload.language ?? null,
                chunks: normalizeChunks(payload.chunks),
            }, payload.language ?? null);
            self.postMessage({
                status: "correction_complete",
                data: corrected,
            });
            return;
        }

        if (action === "translate") {
            const translated = await translateTranscript(payload);
            self.postMessage({
                status: "translation_complete",
                data: translated,
            });
            return;
        }

        const transcript = await transcribe(payload);
        if (transcript === null) return;
        self.postMessage({
            status: "complete",
            data: transcript,
        });
    } catch (error) {
        self.postMessage({
            status: "error",
            data: serializeWorkerError(error),
        });
    }
});
