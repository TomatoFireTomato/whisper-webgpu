/**
 * B 站字幕批量翻译：与沉浸式类似，按「服务 id」路由到不同 HTTP 后端（扩展侧 fetch）。
 * 均为公开/非官方接口，稳定性因服务商而异；用户可在设置中切换。
 */

import type { BilibiliOverlayCue, SubtitleCue } from "./subtitleCues";

export const TRANSLATION_SERVICE_IDS = [
    "google-gtx",
    "bing",
    "lingva",
    "mymemory",
    "libretranslate",
] as const;

export type TranslationServiceId = (typeof TRANSLATION_SERVICE_IDS)[number];

export const DEFAULT_TRANSLATION_SERVICE: TranslationServiceId = "bing";

export function isTranslationServiceId(v: string): v is TranslationServiceId {
    return (TRANSLATION_SERVICE_IDS as readonly string[]).includes(v);
}

export const TRANSLATION_SERVICE_OPTIONS: {
    id: TranslationServiceId;
    label: string;
    hint: string;
}[] = [
    {
        id: "google-gtx",
        label: "Google Translate（gtx）",
        hint: "非官方网页端点，与诸多脚本相同",
    },
    {
        id: "bing",
        label: "Microsoft Bing（网页 ttranslatev3）",
        hint: "与沉浸式默认「bing」同类入口，偶发需刷新",
    },
    {
        id: "lingva",
        label: "Lingva（开源 Google 镜像）",
        hint: "默认 lingva.ml，长句受 URL 长度限制",
    },
    {
        id: "mymemory",
        label: "MyMemory",
        hint: "免费有额度，适合短句",
    },
    {
        id: "libretranslate",
        label: "LibreTranslate 公共实例",
        hint: "libretranslate.com，可能较慢或限流",
    },
];

/** Whisper 语言代码 → 各服务通用 sl/tl（偏 Google 风格） */
export function whisperLangToGoogle(code: string | undefined): string {
    if (!code || typeof code !== "string") return "auto";
    const c = code.trim().toLowerCase();
    if (c === "zh" || c === "zh-cn") return "zh-CN";
    if (c === "zh-tw" || c === "zh-hk") return "zh-TW";
    return c;
}

function toMyMemoryPair(sl: string, tl: string): string {
    const a = sl === "auto" ? "auto" : whisperLangToGoogle(sl).split("-")[0];
    const b = whisperLangToGoogle(tl).split("-")[0];
    return `${a}|${b}`;
}

function toBingLang(code: string): string {
    const c = whisperLangToGoogle(code);
    if (c === "auto") return "auto-detect";
    if (c === "zh-CN" || c === "zh") return "zh-Hans";
    if (c === "zh-TW" || c === "zh-HK") return "zh-Hant";
    return c.split("-")[0] || c;
}

function toLingvaLang(code: string): string {
    const c = whisperLangToGoogle(code);
    if (c === "auto") return "auto";
    if (c.startsWith("zh")) return "zh";
    return c.split("-")[0] || c;
}

function extractFromGtx(data: unknown): string {
    if (!Array.isArray(data) || !Array.isArray(data[0])) return "";
    let s = "";
    for (const seg of data[0]) {
        if (Array.isArray(seg) && typeof seg[0] === "string") s += seg[0];
    }
    return s.trim();
}

async function translateGoogleGtx(
    text: string,
    sl: string,
    tl: string,
): Promise<string> {
    const q = encodeURIComponent(text);
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t&q=${q}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`gtx ${r.status}`);
    return extractFromGtx(await r.json());
}

/** Bing 网页接口（与常见油猴/扩展同源思路，非 Cognitive 正式 API） */
async function translateBing(text: string, sl: string, tl: string): Promise<string> {
    const fromLang = sl === "auto" ? "auto-detect" : toBingLang(sl);
    const toLang = toBingLang(tl);
    const url =
        "https://www.bing.com/ttranslatev3?isVertical=1&IG=&IID=translator.5024";
    const r = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            fromLang,
            toLang,
            text,
        }),
    });
    if (!r.ok) throw new Error(`bing ${r.status}`);
    const data = (await r.json()) as {
        translations?: Array<{ text?: string }>;
    };
    const t = data?.translations?.[0]?.text;
    if (typeof t !== "string") throw new Error("bing bad response");
    return t.trim();
}

const LINGVA_BASE = "https://lingva.ml";

async function translateLingva(text: string, sl: string, tl: string): Promise<string> {
    if (text.length > 1800) throw new Error("lingva text too long");
    const s = toLingvaLang(sl);
    const t = toLingvaLang(tl);
    const path = `${encodeURIComponent(s)}/${encodeURIComponent(t)}/${encodeURIComponent(text)}`;
    const r = await fetch(`${LINGVA_BASE}/api/v1/${path}`);
    if (!r.ok) throw new Error(`lingva ${r.status}`);
    const data = (await r.json()) as { translation?: string };
    if (typeof data.translation !== "string") throw new Error("lingva bad");
    return data.translation.trim();
}

async function translateMyMemory(
    text: string,
    sl: string,
    tl: string,
): Promise<string> {
    const pair = toMyMemoryPair(sl, tl);
    const q = encodeURIComponent(text);
    const url = `https://api.mymemory.translated.net/get?q=${q}&langpair=${encodeURIComponent(pair)}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`mymemory ${r.status}`);
    const data = (await r.json()) as {
        responseData?: { translatedText?: string };
    };
    const out = data?.responseData?.translatedText;
    if (typeof out !== "string") throw new Error("mymemory bad");
    return out.trim();
}

const LIBRE_BASE = "https://libretranslate.com";

async function translateLibreTranslate(
    text: string,
    sl: string,
    tl: string,
): Promise<string> {
    const source = sl === "auto" ? "auto" : whisperLangToGoogle(sl).split("-")[0];
    const target = whisperLangToGoogle(tl).split("-")[0];
    const r = await fetch(`${LIBRE_BASE}/translate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            q: text,
            source: source === "auto" ? "auto" : source,
            target,
            format: "text",
        }),
    });
    if (!r.ok) throw new Error(`libre ${r.status}`);
    const data = (await r.json()) as { translatedText?: string };
    if (typeof data.translatedText !== "string") throw new Error("libre bad");
    return data.translatedText.trim();
}

async function translateOne(
    text: string,
    sl: string,
    tl: string,
    service: TranslationServiceId,
): Promise<string> {
    switch (service) {
        case "google-gtx":
            return translateGoogleGtx(text, sl, tl);
        case "bing":
            return translateBing(text, sl, tl);
        case "lingva":
            return translateLingva(text, sl, tl);
        case "mymemory":
            return translateMyMemory(text, sl, tl);
        case "libretranslate":
            return translateLibreTranslate(text, sl, tl);
        default:
            return translateGoogleGtx(text, sl, tl);
    }
}

export async function translateLinesBatch(
    texts: string[],
    slRaw: string,
    tlRaw: string,
    service: TranslationServiceId,
    concurrency = 4,
): Promise<string[]> {
    const sl = whisperLangToGoogle(slRaw);
    const tl = whisperLangToGoogle(tlRaw);
    if (sl === tl || (sl !== "auto" && sl.split("-")[0] === tl.split("-")[0])) {
        return texts.map((t) => t);
    }
    const out: string[] = new Array(texts.length);
    for (let i = 0; i < texts.length; i += concurrency) {
        const slice = texts.slice(i, i + concurrency);
        const results = await Promise.all(
            slice.map((raw) =>
                !raw.trim()
                    ? Promise.resolve("")
                    : translateOne(raw, sl, tl, service).catch(() => ""),
            ),
        );
        for (let k = 0; k < results.length; k++) {
            out[i + k] = results[k];
        }
    }
    return out;
}

/** 构建叠加层字轨（不发起网络请求）；与 `translateCuesForBilibili` 首段逻辑一致 */
export function buildBilibiliOverlayCues(cues: SubtitleCue[]): BilibiliOverlayCue[] {
    return cues.map((c) => ({
        start: c.start,
        end: c.end,
        text: c.text,
        translation:
            typeof c.translation === "string" && c.translation.trim()
                ? c.translation.trim()
                : "",
    }));
}

/**
 * 按批翻译并合并进 base；每完成一批可选回调（用于页面叠加层渐进更新）。
 */
export async function fillBilibiliOverlayTranslations(
    base: BilibiliOverlayCue[],
    cues: SubtitleCue[],
    options: {
        sourceLang: string;
        targetLang: string;
        service: TranslationServiceId;
    },
    concurrency: number,
    onBatch?: (merged: BilibiliOverlayCue[]) => void | Promise<void>,
): Promise<void> {
    const { sourceLang, targetLang, service } = options;
    const sl = whisperLangToGoogle(sourceLang);
    const tl = whisperLangToGoogle(targetLang);

    const needIdx: number[] = [];
    const needText: string[] = [];
    for (let i = 0; i < base.length; i++) {
        if (!base[i].translation && cueNeedsTranslation(cues[i])) {
            needIdx.push(i);
            needText.push(cues[i].text);
        }
    }
    if (needIdx.length === 0) return;

    if (sl === tl || (sl !== "auto" && sl.split("-")[0] === tl.split("-")[0])) {
        for (const i of needIdx) {
            base[i].translation = cues[i].text;
        }
        if (onBatch) {
            await onBatch(base.map((c) => ({ ...c })));
        }
        return;
    }

    for (let i = 0; i < needText.length; i += concurrency) {
        const slice = needText.slice(i, i + concurrency);
        const results = await Promise.all(
            slice.map((raw) =>
                !raw.trim()
                    ? Promise.resolve("")
                    : translateOne(raw, sl, tl, service).catch(() => ""),
            ),
        );
        for (let k = 0; k < results.length; k++) {
            base[needIdx[i + k]]!.translation = results[k] ?? "";
        }
        if (onBatch) {
            await onBatch(base.map((c) => ({ ...c })));
        }
    }
}

export async function translateCuesForBilibili(
    cues: SubtitleCue[],
    options: {
        sourceLang: string;
        targetLang: string;
        service: TranslationServiceId;
    },
): Promise<BilibiliOverlayCue[]> {
    const base = buildBilibiliOverlayCues(cues);
    await fillBilibiliOverlayTranslations(base, cues, options, 4);
    return base;
}

function cueNeedsTranslation(c: SubtitleCue): boolean {
    return typeof c.text === "string" && c.text.trim().length > 0;
}
