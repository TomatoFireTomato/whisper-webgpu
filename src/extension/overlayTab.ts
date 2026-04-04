import type { SubtitleCue } from "../utils/subtitleCues";
import {
    buildBilibiliOverlayCues,
    DEFAULT_TRANSLATION_SERVICE,
    type TranslationServiceId,
} from "../utils/subtitleTranslate";

export type SendOverlayResult =
    | { ok: true }
    | { ok: false; error: string };

export type SendSubtitlesOptions = {
    /** Whisper 源语言代码，如 en、ja；缺省为 auto */
    sourceLang?: string;
    /** 页面字幕译文语言，默认 zh-CN */
    targetLang?: string;
    /** 翻译后端，与沉浸式「多服务」思路一致 */
    translationService?: TranslationServiceId;
};

type OverlayRuntimePayload = {
    cues: ReturnType<typeof buildBilibiliOverlayCues>;
    sourceLang: string;
    targetLang: string;
    translationService: TranslationServiceId;
    lookAheadCount: number;
    prefetchSeconds: number;
};

function bootPageSubtitleRuntime(payload: OverlayRuntimePayload): void {
    const globalKey = "__whisperWebgpuSubtitleRuntime";
    const runtime = (
        window as unknown as {
            [key: string]:
                | {
                      upsert: (data: OverlayRuntimePayload) => void;
                  }
                | undefined;
        }
    )[globalKey];
    runtime?.upsert(payload);
}

/**
 * 将字轨与翻译配置注入页面运行时，由页面侧按播放进度渐进翻译并持续显示。
 */
export async function sendSubtitlesToActiveTab(
    cues: SubtitleCue[],
    options: SendSubtitlesOptions = {},
): Promise<SendOverlayResult> {
    if (typeof chrome === "undefined" || !chrome.tabs?.query) {
        return Promise.resolve({
            ok: false,
            error: "仅在 Chrome 扩展模式下可用（请从已加载的扩展打开侧边栏）。",
        });
    }

    if (cues.length === 0) {
        return { ok: false, error: "没有可发送的字幕片段。" };
    }

    const sourceLang = options.sourceLang ?? "auto";
    const targetLang = options.targetLang ?? "zh-CN";
    const translationService =
        options.translationService ?? DEFAULT_TRANSLATION_SERVICE;

    const base = buildBilibiliOverlayCues(cues).map((cue) => ({
        ...cue,
        translation:
            translationService === "qwen-local" ? cue.translation : "",
    }));
    const payload: OverlayRuntimePayload = {
        cues: base,
        sourceLang,
        targetLang,
        translationService,
        lookAheadCount: 6,
        prefetchSeconds: 45,
    };

    return new Promise((resolve) => {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const tab = tabs[0];
            if (!tab?.id) {
                resolve({ ok: false, error: "未找到当前标签页。" });
                return;
            }

            const tabId = tab.id;

            if (!chrome.scripting?.executeScript) {
                resolve({
                    ok: false,
                    error: "无法注入字幕脚本（缺少 scripting 权限）。",
                });
                return;
            }

            chrome.scripting
                .executeScript({
                    target: { tabId },
                    files: ["page-subtitle-runtime.js"],
                })
                .then(async () => {
                    try {
                        await chrome.scripting.executeScript({
                            target: { tabId },
                            func: bootPageSubtitleRuntime,
                            args: [payload],
                        });
                        resolve({ ok: true });
                    } catch {
                        resolve({
                            ok: false,
                            error: "页面字幕运行时初始化失败，请刷新视频页后重试。",
                        });
                    }
                })
                .catch(() => {
                    resolve({
                        ok: false,
                        error: "注入失败。请确认当前为 B 站视频页，并已授予扩展访问该页。",
                    });
                });
        });
    });
}
