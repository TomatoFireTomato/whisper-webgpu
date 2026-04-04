(() => {
    const GLOBAL_KEY = "__whisperWebgpuSubtitleRuntime";
    const ROOT_ID = "whisper-webgpu-bilibili-subtitle-overlay";
    const DEFAULT_SERVICE = "bing";
    const DEFAULT_LOOKAHEAD = 6;
    const DEFAULT_PREFETCH_SECONDS = 45;
    const BING_URL =
        "https://www.bing.com/ttranslatev3?isVertical=1&IG=&IID=translator.5024";
    const LINGVA_BASE = "https://lingva.ml";
    const LIBRE_BASE = "https://libretranslate.com";

    function clampNumber(v, fallback) {
        return typeof v === "number" && Number.isFinite(v) ? v : fallback;
    }

    function whisperLangToGoogle(code) {
        if (!code || typeof code !== "string") return "auto";
        const c = code.trim().toLowerCase();
        if (c === "zh" || c === "zh-cn") return "zh-CN";
        if (c === "zh-tw" || c === "zh-hk") return "zh-TW";
        return c;
    }

    function toBingLang(code) {
        const c = whisperLangToGoogle(code);
        if (c === "auto") return "auto-detect";
        if (c === "zh-CN" || c === "zh") return "zh-Hans";
        if (c === "zh-TW" || c === "zh-HK") return "zh-Hant";
        return c.split("-")[0] || c;
    }

    function toLingvaLang(code) {
        const c = whisperLangToGoogle(code);
        if (c === "auto") return "auto";
        if (c.startsWith("zh")) return "zh";
        return c.split("-")[0] || c;
    }

    function toMyMemoryPair(sl, tl) {
        const a = sl === "auto" ? "auto" : whisperLangToGoogle(sl).split("-")[0];
        const b = whisperLangToGoogle(tl).split("-")[0];
        return `${a}|${b}`;
    }

    function extractFromGtx(data) {
        if (!Array.isArray(data) || !Array.isArray(data[0])) return "";
        let s = "";
        for (const seg of data[0]) {
            if (Array.isArray(seg) && typeof seg[0] === "string") s += seg[0];
        }
        return s.trim();
    }

    async function translateGoogleGtx(text, sl, tl) {
        const q = encodeURIComponent(text);
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(
            sl,
        )}&tl=${encodeURIComponent(tl)}&dt=t&q=${q}`;
        const r = await fetch(url);
        if (!r.ok) throw new Error(`gtx ${r.status}`);
        return extractFromGtx(await r.json());
    }

    async function translateBing(text, sl, tl) {
        const r = await fetch(BING_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                fromLang: sl === "auto" ? "auto-detect" : toBingLang(sl),
                toLang: toBingLang(tl),
                text,
            }),
        });
        if (!r.ok) throw new Error(`bing ${r.status}`);
        const data = await r.json();
        const out =
            data &&
            Array.isArray(data.translations) &&
            data.translations[0] &&
            typeof data.translations[0].text === "string"
                ? data.translations[0].text
                : "";
        if (!out) throw new Error("bing bad response");
        return out.trim();
    }

    async function translateLingva(text, sl, tl) {
        if (text.length > 1800) throw new Error("lingva text too long");
        const s = toLingvaLang(sl);
        const t = toLingvaLang(tl);
        const path = `${encodeURIComponent(s)}/${encodeURIComponent(t)}/${encodeURIComponent(text)}`;
        const r = await fetch(`${LINGVA_BASE}/api/v1/${path}`);
        if (!r.ok) throw new Error(`lingva ${r.status}`);
        const data = await r.json();
        if (typeof data.translation !== "string") throw new Error("lingva bad");
        return data.translation.trim();
    }

    async function translateMyMemory(text, sl, tl) {
        const pair = toMyMemoryPair(sl, tl);
        const q = encodeURIComponent(text);
        const r = await fetch(
            `https://api.mymemory.translated.net/get?q=${q}&langpair=${encodeURIComponent(pair)}`,
        );
        if (!r.ok) throw new Error(`mymemory ${r.status}`);
        const data = await r.json();
        const out =
            data &&
            data.responseData &&
            typeof data.responseData.translatedText === "string"
                ? data.responseData.translatedText
                : "";
        if (!out) throw new Error("mymemory bad");
        return out.trim();
    }

    async function translateLibreTranslate(text, sl, tl) {
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
        const data = await r.json();
        if (typeof data.translatedText !== "string") throw new Error("libre bad");
        return data.translatedText.trim();
    }

    async function translateOne(text, sl, tl, service) {
        switch (service) {
            case "qwen-local":
                return "";
            case "google-gtx":
                return translateGoogleGtx(text, sl, tl);
            case "lingva":
                return translateLingva(text, sl, tl);
            case "mymemory":
                return translateMyMemory(text, sl, tl);
            case "libretranslate":
                return translateLibreTranslate(text, sl, tl);
            case "bing":
            default:
                return translateBing(text, sl, tl);
        }
    }

    function createRuntime() {
        let host = null;
        let root = null;
        let card = null;
        let lineSource = null;
        let lineTranslation = null;
        let video = null;
        let observer = null;
        let resizeObserver = null;
        let rafId = 0;
        let tickScheduled = false;

        let cues = [];
        let sourceLang = "auto";
        let targetLang = "zh-CN";
        let translationService = DEFAULT_SERVICE;
        let lookAheadCount = DEFAULT_LOOKAHEAD;
        let prefetchSeconds = DEFAULT_PREFETCH_SECONDS;
        let sessionToken = 0;
        let destroyed = false;
        let activeTranslations = 0;
        const translationCache = new Map();
        const pendingIndexes = new Set();

        function mountHost() {
            const nextHost =
                document.querySelector(".bpx-player-video-wrap") ||
                document.querySelector(".bilibili-player-video-wrap");
            if (!nextHost) return null;
            if (getComputedStyle(nextHost).position === "static") {
                nextHost.style.position = "relative";
            }
            return nextHost;
        }

        function ensureRoot() {
            if (!root) {
                root = document.createElement("div");
                root.id = ROOT_ID;
                root.setAttribute("data-whisper-webgpu", "1");
                root.style.cssText = [
                    "position:absolute",
                    "left:0",
                    "right:0",
                    "bottom:0",
                    "z-index:2147483000",
                    "pointer-events:none",
                    "text-align:center",
                    "padding:0 4% 0",
                    "box-sizing:border-box",
                    "opacity:0",
                    "visibility:hidden",
                    "transition:opacity .15s ease,visibility .15s ease",
                ].join(";");

                card = document.createElement("div");
                card.style.cssText = [
                    "display:inline-block",
                    "max-width:88%",
                    "padding:10px 14px",
                    "border-radius:10px 10px 0 0",
                    "background:rgba(0,0,0,0.48)",
                    "box-shadow:0 2px 16px rgba(0,0,0,.22),0 0 0 1px rgba(255,255,255,.06)",
                ].join(";");

                lineSource = document.createElement("div");
                lineSource.style.cssText = [
                    "font-size:clamp(16px,2.35vw,24px)",
                    "font-weight:700",
                    "letter-spacing:0.02em",
                    "color:#fff",
                    "line-height:1.35",
                    "margin-bottom:0.35em",
                    "text-shadow:0 1px 2px rgba(0,0,0,.45)",
                ].join(";");

                lineTranslation = document.createElement("div");
                lineTranslation.style.cssText = [
                    "font-size:clamp(13px,1.85vw,17px)",
                    "font-weight:500",
                    "opacity:0.9",
                    "color:rgba(255,255,255,.94)",
                    "line-height:1.4",
                    "text-shadow:0 1px 1px rgba(0,0,0,.35)",
                ].join(";");

                card.appendChild(lineSource);
                card.appendChild(lineTranslation);
                root.appendChild(card);
            }

            const nextHost = mountHost();
            if (!nextHost) return false;
            host = nextHost;
            if (!host.contains(root)) host.appendChild(root);
            bindResizeObserver();
            applyResponsiveLayout();
            return true;
        }

        function applyResponsiveLayout() {
            if (!host || !root || !card || !lineSource || !lineTranslation) return;

            const rect = host.getBoundingClientRect();
            const width = clampNumber(rect.width, 960);
            const height = clampNumber(rect.height, 540);
            const base = Math.min(width, height);

            const bottomInset = Math.max(6, Math.round(height * 0.015));
            const sidePadding = Math.max(14, Math.round(width * 0.04));
            const cardWidth = Math.max(280, Math.round(width * 0.82));
            const sourceSize = Math.max(
                16,
                Math.min(34, Math.round(base * 0.05)),
            );
            const translationSize = Math.max(
                13,
                Math.min(24, Math.round(sourceSize * 0.72)),
            );
            const cardPadY = Math.max(8, Math.round(sourceSize * 0.45));
            const cardPadX = Math.max(12, Math.round(sourceSize * 0.7));
            const radius = Math.max(8, Math.round(sourceSize * 0.45));

            root.style.padding = `0 ${sidePadding}px calc(${bottomInset}px + env(safe-area-inset-bottom, 0px))`;
            card.style.maxWidth = `${cardWidth}px`;
            card.style.padding = `${cardPadY}px ${cardPadX}px`;
            card.style.borderRadius = `${radius}px ${radius}px 0 0`;
            lineSource.style.fontSize = `${sourceSize}px`;
            lineSource.style.marginBottom = `${Math.max(4, Math.round(sourceSize * 0.25))}px`;
            lineTranslation.style.fontSize = `${translationSize}px`;
        }

        function bindResizeObserver() {
            if (!host || resizeObserver) return;
            resizeObserver = new ResizeObserver(() => {
                applyResponsiveLayout();
            });
            resizeObserver.observe(host);
        }

        function setOverlayVisible(visible) {
            if (!root || !lineSource || !lineTranslation) return;
            if (visible) {
                root.style.opacity = "1";
                root.style.visibility = "visible";
            } else {
                root.style.opacity = "0";
                root.style.visibility = "hidden";
                lineSource.textContent = "";
                lineTranslation.textContent = "";
            }
        }

        function findCueIndex(time) {
            for (let i = 0; i < cues.length; i++) {
                const cue = cues[i];
                if (time >= cue.start && time < cue.end) return i;
            }
            return -1;
        }

        function renderCurrentCue() {
            if (!video || !lineSource || !lineTranslation) {
                setOverlayVisible(false);
                return;
            }
            const idx = findCueIndex(video.currentTime);
            if (idx < 0) {
                setOverlayVisible(false);
                return;
            }
            const cue = cues[idx];
            const text = typeof cue.text === "string" ? cue.text.trim() : "";
            const translation =
                typeof cue.translation === "string" ? cue.translation.trim() : "";
            if (!text && !translation) {
                setOverlayVisible(false);
                return;
            }
            lineSource.textContent = text;
            lineTranslation.textContent = translation;
            setOverlayVisible(Boolean(text || translation));
        }

        function maybeUseOriginalText(sl, tl, text) {
            if (sl === tl) return text;
            if (sl !== "auto" && sl.split("-")[0] === tl.split("-")[0]) return text;
            return null;
        }

        async function translateCueAt(index, token) {
            if (destroyed || token !== sessionToken) return;
            const cue = cues[index];
            if (!cue) return;
            const raw = typeof cue.text === "string" ? cue.text.trim() : "";
            if (!raw) {
                pendingIndexes.delete(index);
                return;
            }

            const sl = whisperLangToGoogle(sourceLang);
            const tl = whisperLangToGoogle(targetLang);
            const sameLangText = maybeUseOriginalText(sl, tl, raw);
            if (sameLangText !== null) {
                cue.translation = sameLangText;
                translationCache.set(raw, sameLangText);
                pendingIndexes.delete(index);
                renderCurrentCue();
                return;
            }

            if (translationCache.has(raw)) {
                cue.translation = translationCache.get(raw) || "";
                pendingIndexes.delete(index);
                renderCurrentCue();
                return;
            }

            activeTranslations += 1;
            try {
                const translated = await translateOne(
                    raw,
                    sl,
                    tl,
                    translationService,
                ).catch(() => "");
                if (destroyed || token !== sessionToken) return;
                const finalText = translated || "";
                cue.translation = finalText;
                translationCache.set(raw, finalText);
                renderCurrentCue();
            } finally {
                activeTranslations = Math.max(0, activeTranslations - 1);
                pendingIndexes.delete(index);
                scheduleTick();
            }
        }

        function queueTranslation(index, token) {
            if (index < 0 || index >= cues.length) return;
            const cue = cues[index];
            if (!cue || !cue.text || cue.translation) return;
            if (pendingIndexes.has(index)) return;
            pendingIndexes.add(index);
            void translateCueAt(index, token);
        }

        function scheduleNearTranslations() {
            if (translationService === "qwen-local") return;
            if (!video) return;
            const token = sessionToken;
            const currentTime = clampNumber(video.currentTime, 0);
            let currentIndex = findCueIndex(currentTime);
            if (currentIndex < 0) {
                currentIndex = cues.findIndex((cue) => cue.end >= currentTime);
            }
            if (currentIndex < 0) return;

            let queued = 0;
            for (let i = currentIndex; i < cues.length && queued < lookAheadCount; i++) {
                const cue = cues[i];
                if (!cue) continue;
                if (cue.start > currentTime + prefetchSeconds) break;
                if (!cue.translation && cue.text && cue.text.trim()) {
                    queueTranslation(i, token);
                    queued += 1;
                }
            }
        }

        function scheduleTick() {
            if (tickScheduled || destroyed) return;
            tickScheduled = true;
            rafId = window.requestAnimationFrame(() => {
                tickScheduled = false;
                renderCurrentCue();
                if (activeTranslations < 2) {
                    scheduleNearTranslations();
                }
            });
        }

        function bindVideo() {
            const nextVideo =
                (host && host.querySelector("video")) || document.querySelector("video");
            if (video === nextVideo && video) return;

            if (video) {
                video.removeEventListener("timeupdate", scheduleTick);
                video.removeEventListener("seeked", scheduleTick);
                video.removeEventListener("play", scheduleTick);
            }

            video = nextVideo || null;
            if (!video) return;

            video.addEventListener("timeupdate", scheduleTick);
            video.addEventListener("seeked", scheduleTick);
            video.addEventListener("play", scheduleTick);
            scheduleTick();
        }

        observer = new MutationObserver(() => {
            if (destroyed) return;
            ensureRoot();
            bindVideo();
            scheduleTick();
        });
        observer.observe(document.body, { childList: true, subtree: true });

        return {
            upsert(payload) {
                sessionToken += 1;
                translationCache.clear();
                pendingIndexes.clear();
                activeTranslations = 0;
                cues = Array.isArray(payload.cues)
                    ? payload.cues.map((cue) => ({
                          start: clampNumber(cue.start, 0),
                          end: clampNumber(cue.end, 0),
                          text: typeof cue.text === "string" ? cue.text : "",
                          translation:
                              typeof cue.translation === "string"
                                  ? cue.translation
                                  : "",
                      }))
                    : [];
                sourceLang =
                    typeof payload.sourceLang === "string"
                        ? payload.sourceLang
                        : "auto";
                targetLang =
                    typeof payload.targetLang === "string"
                        ? payload.targetLang
                        : "zh-CN";
                translationService =
                    typeof payload.translationService === "string"
                        ? payload.translationService
                        : DEFAULT_SERVICE;
                lookAheadCount = clampNumber(
                    payload.lookAheadCount,
                    DEFAULT_LOOKAHEAD,
                );
                prefetchSeconds = clampNumber(
                    payload.prefetchSeconds,
                    DEFAULT_PREFETCH_SECONDS,
                );
                ensureRoot();
                bindVideo();
                scheduleTick();
            },
            dispose() {
                destroyed = true;
                sessionToken += 1;
                pendingIndexes.clear();
                translationCache.clear();
                if (observer) observer.disconnect();
                if (resizeObserver) resizeObserver.disconnect();
                if (video) {
                    video.removeEventListener("timeupdate", scheduleTick);
                    video.removeEventListener("seeked", scheduleTick);
                    video.removeEventListener("play", scheduleTick);
                }
                if (rafId) window.cancelAnimationFrame(rafId);
                if (root) root.remove();
                delete window[GLOBAL_KEY];
            },
        };
    }

    if (!window[GLOBAL_KEY]) {
        window[GLOBAL_KEY] = createRuntime();
    }
})();
