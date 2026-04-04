/**
 * 在 B 站视频页 MAIN world 执行：挂载叠加层，用 video.timeupdate 按时间轴显示（原文上、译文下）。
 * 本函数须保持无外部闭包依赖，仅使用参数与 document/window 全局。
 */

import type { BilibiliOverlayCue } from "../utils/subtitleCues";

type OverlayHandle = {
    dispose: () => void;
    setCues: (next: BilibiliOverlayCue[]) => void;
};

/**
 * 必须写死在函数体内：executeScript(MAIN) 只序列化本函数，不能闭包引用模块顶层变量，
 * 否则打包后会出现「Jl is not defined」一类错误。
 */
export function injectBilibiliSubtitleOverlay(
    cues: BilibiliOverlayCue[],
): void {
    const globalKey = "__whisperWebgpuBilibiliOverlay";
    const w = window as unknown as Record<string, OverlayHandle | undefined>;
    w[globalKey]?.dispose();

    let cuesMutable: BilibiliOverlayCue[] = cues.map((c) => ({
        start: c.start,
        end: c.end,
        text: c.text,
        translation: typeof c.translation === "string" ? c.translation : "",
    }));

    const rootId = "whisper-webgpu-bilibili-subtitle-overlay";

    const root = document.createElement("div");
    root.id = rootId;
    root.setAttribute("data-whisper-webgpu", "1");
    root.style.cssText = [
        "position:absolute",
        "left:0",
        "right:0",
        "bottom:0",
        "z-index:2147483000",
        "pointer-events:none",
        "text-align:center",
        "padding:0 4% max(10px,env(safe-area-inset-bottom,0px))",
        "box-sizing:border-box",
        "opacity:0",
        "visibility:hidden",
        "transition:opacity .15s ease,visibility .15s ease",
    ].join(";");

    const card = document.createElement("div");
    card.style.cssText = [
        "display:inline-block",
        "max-width:min(96vw,52em)",
        "padding:12px 16px",
        "border-radius:10px",
        "background:rgba(0,0,0,0.48)",
        "box-shadow:0 2px 16px rgba(0,0,0,.22),0 0 0 1px rgba(255,255,255,.06)",
    ].join(";");

    /** 原文：更醒目 */
    const lineSource = document.createElement("div");
    lineSource.style.cssText = [
        "font-size:clamp(16px,2.35vw,24px)",
        "font-weight:700",
        "letter-spacing:0.02em",
        "color:#fff",
        "line-height:1.35",
        "margin-bottom:0.35em",
        "text-shadow:0 1px 2px rgba(0,0,0,.45)",
    ].join(";");

    /** 译文：次要一行 */
    const lineTranslation = document.createElement("div");
    lineTranslation.style.cssText = [
        "font-size:clamp(16px,2.35vw,24px)",
        "font-weight:700",
        "opacity:0.9",
        "color:rgba(255,255,255,.94)",
        "line-height:1.35",
        "text-shadow:0 1px 2px rgba(0,0,0,.45)",
    ].join(";");

    card.appendChild(lineSource);
    card.appendChild(lineTranslation);
    root.appendChild(card);

    function mountHost(): HTMLElement | null {
        const wrap =
            document.querySelector(".bpx-player-video-wrap") ||
            document.querySelector(".bilibili-player-video-wrap");
        if (!wrap) return null;
        const el = wrap as HTMLElement;
        if (getComputedStyle(el).position === "static") {
            el.style.position = "relative";
        }
        return el;
    }

    let host = mountHost();
    if (!host) {
        return;
    }
    host.appendChild(root);

    const video =
        (host.querySelector("video") as HTMLVideoElement | null) ||
        (document.querySelector("video") as HTMLVideoElement | null);

    function findCue(t: number): BilibiliOverlayCue | null {
        for (let i = 0; i < cuesMutable.length; i++) {
            const c = cuesMutable[i];
            if (t >= c.start && t < c.end) return c;
        }
        return null;
    }

    function setOverlayVisible(visible: boolean): void {
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

    function tick(): void {
        if (!video) {
            setOverlayVisible(false);
            return;
        }
        const cur = findCue(video.currentTime);
        if (!cur) {
            setOverlayVisible(false);
            return;
        }
        const src = (cur.text || "").trim();
        const tr = (cur.translation || "").trim();
        if (!src && !tr) {
            setOverlayVisible(false);
            return;
        }
        lineSource.textContent = src;
        lineTranslation.textContent = tr;
        setOverlayVisible(true);
    }

    const onTime = () => {
        tick();
    };

    if (video) {
        video.addEventListener("timeupdate", onTime);
        tick();
    }

    const mo = new MutationObserver(() => {
        if (document.body.contains(root)) return;
        const h = mountHost();
        if (h && !h.querySelector("#" + rootId)) {
            host = h;
            h.appendChild(root);
            tick();
        }
    });
    mo.observe(document.body, { childList: true, subtree: true });

    const dispose = (): void => {
        mo.disconnect();
        if (video) video.removeEventListener("timeupdate", onTime);
        root.remove();
        delete w[globalKey];
    };

    const setCues = (next: BilibiliOverlayCue[]): void => {
        cuesMutable = next.map((c) => ({
            start: c.start,
            end: c.end,
            text: c.text,
            translation: typeof c.translation === "string" ? c.translation : "",
        }));
        tick();
    };

    w[globalKey] = { dispose, setCues };
}

/**
 * 在已注入的叠加层上更新字轨（渐进翻译完成后调用）。须与 inject 内 globalKey 一致且仅引用字面量。
 */
export function applyBilibiliSubtitleCuesUpdate(cues: BilibiliOverlayCue[]): void {
    const globalKey = "__whisperWebgpuBilibiliOverlay";
    const w = window as unknown as Record<string, OverlayHandle | undefined>;
    w[globalKey]?.setCues(cues);
}
