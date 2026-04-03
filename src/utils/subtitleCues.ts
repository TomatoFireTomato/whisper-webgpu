/** 与 Transcript 中校验规则一致，用于发送到 content script 的字幕块 */

export interface SubtitleChunk {
    text: string;
    timestamp: [number, number | null];
    /** 译文行（与原文同一时间轴） */
    translation?: string;
}

export interface SubtitleCue {
    start: number;
    end: number;
    text: string;
    translation?: string;
}

/** 注入 B 站页叠加层用的字轨（原文 + 译文） */
export type BilibiliOverlayCue = {
    start: number;
    end: number;
    text: string;
    translation: string;
};

export function filterValidChunks(
    chunks: SubtitleChunk[] | undefined,
): SubtitleChunk[] {
    if (!Array.isArray(chunks)) return [];
    return chunks.filter((it) => {
        if (!it || !Array.isArray(it.timestamp) || it.timestamp.length < 2)
            return false;
        if (typeof it.text !== "string") return false;
        if (typeof it.timestamp[0] !== "number" || typeof it.timestamp[1] !== "number")
            return false;
        return true;
    });
}

export function chunksToCues(chunks: SubtitleChunk[]): SubtitleCue[] {
    return filterValidChunks(chunks).map((c) => ({
        start: c.timestamp[0],
        end: c.timestamp[1] as number,
        text: c.text.trim(),
        translation:
            typeof c.translation === "string" ? c.translation.trim() : undefined,
    }));
}
