/**
 * 转录历史与 UI 配置的 localStorage 持久化（扩展侧栏同源，关闭重开仍可读）。
 * 历史仅存文本与时间轴，不含音频二进制。
 */

const SETTINGS_KEY = "whisper-webgpu-ui-settings-v1";
const HISTORY_KEY = "whisper-webgpu-transcript-history-v1";
const MAX_HISTORY = 25;
const MAX_STORAGE_CHARS = 4_500_000;

export type PersistedUiSettings = {
    model?: string;
    multilingual?: boolean;
    language?: string;
};

export function loadUiSettings(): PersistedUiSettings {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (!raw) return {};
        const o = JSON.parse(raw) as unknown;
        if (!o || typeof o !== "object") return {};
        return o as PersistedUiSettings;
    } catch {
        return {};
    }
}

export function saveUiSettings(s: PersistedUiSettings): void {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    } catch {
        /* quota */
    }
}

export type TranscriptHistoryItem = {
    id: string;
    createdAt: number;
    fileName: string;
    text: string;
    tps?: number;
    chunks: {
        text: string;
        timestamp: [number, number | null];
        translation?: string;
    }[];
};

function trimHistoryIfNeeded(list: TranscriptHistoryItem[]): TranscriptHistoryItem[] {
    let next = list;
    while (next.length > MAX_HISTORY) {
        next = next.slice(1);
    }
    for (;;) {
        const str = JSON.stringify(next);
        if (str.length <= MAX_STORAGE_CHARS || next.length <= 1) break;
        next = next.slice(1);
    }
    return next;
}

export function loadTranscriptHistory(): TranscriptHistoryItem[] {
    try {
        const raw = localStorage.getItem(HISTORY_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(
            (x): x is TranscriptHistoryItem =>
                x &&
                typeof x === "object" &&
                typeof (x as TranscriptHistoryItem).id === "string" &&
                Array.isArray((x as TranscriptHistoryItem).chunks),
        );
    } catch {
        return [];
    }
}

function saveTranscriptHistory(list: TranscriptHistoryItem[]): void {
    try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
    } catch {
        try {
            const trimmed = trimHistoryIfNeeded(list.slice(-10));
            localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
        } catch {
            /* ignore */
        }
    }
}

export function appendTranscriptHistory(
    entry: Omit<TranscriptHistoryItem, "id" | "createdAt"> & {
        id?: string;
        createdAt?: number;
    },
): TranscriptHistoryItem {
    const item: TranscriptHistoryItem = {
        id: entry.id ?? crypto.randomUUID(),
        createdAt: entry.createdAt ?? Date.now(),
        fileName: entry.fileName || "未命名",
        text: entry.text,
        tps: entry.tps,
        chunks: entry.chunks,
    };
    const prev = loadTranscriptHistory();
    const next = trimHistoryIfNeeded([item, ...prev]);
    saveTranscriptHistory(next);
    return item;
}

export function removeTranscriptHistoryItem(id: string): void {
    const prev = loadTranscriptHistory();
    saveTranscriptHistory(prev.filter((x) => x.id !== id));
}

export function clearTranscriptHistory(): void {
    try {
        localStorage.removeItem(HISTORY_KEY);
    } catch {
        /* ignore */
    }
}
