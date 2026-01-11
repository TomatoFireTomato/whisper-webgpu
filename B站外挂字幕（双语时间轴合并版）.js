// ==UserScript==
// @name         B站外挂字幕（双语时间轴合并版）
// @namespace    http://tampermonkey.net/
// @version      0.3
// @description  为B站视频加载本地字幕文件，自动将相同时间轴的两条字幕合并为双语显示
// @author       You
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/bangumi/play/*
// @grant        none
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    /* ========== 字幕显示区域 ========== */
    const subtitleBox = document.createElement('div');
    subtitleBox.style.position = 'absolute';
    subtitleBox.style.bottom = '12%';
    subtitleBox.style.left = '50%';
    subtitleBox.style.transform = 'translateX(-50%)';
    subtitleBox.style.width = '80%';
    subtitleBox.style.textAlign = 'center';
    subtitleBox.style.zIndex = '9999';
    subtitleBox.style.pointerEvents = 'none';

    subtitleBox.innerHTML = `
        <div id="sub-line-1" style="
            font-size: 24px;
            color: white;
            text-shadow: 2px 2px 4px black;
        "></div>
        <div id="sub-line-2" style="
            margin-top: 4px;
            font-size: 20px;
            color: #ddd;
            text-shadow: 2px 2px 4px black;
        "></div>
    `;

    function mountSubtitleBox() {
        const container = document.querySelector('.bpx-player-video-wrap');
        if (container && !container.querySelector('#sub-line-1')) {
            container.style.position = 'relative';
            container.appendChild(subtitleBox);
        }
    }

    mountSubtitleBox();
    new MutationObserver(mountSubtitleBox).observe(document.body, {
        childList: true,
        subtree: true
    });

    const line1 = subtitleBox.querySelector('#sub-line-1');
    const line2 = subtitleBox.querySelector('#sub-line-2');

    /* ========== 文件选择 ========== */
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.srt';
    fileInput.style.position = 'fixed';
    fileInput.style.top = '10px';
    fileInput.style.right = '10px';
    fileInput.style.zIndex = '9999';
    document.body.appendChild(fileInput);

    let subtitles = [];

    /* ========== SRT 解析 & 双语合并 ========== */
    function parseSRT(text) {
        const blocks = text.trim().split(/\n\s*\n/);
        const temp = [];

        for (const block of blocks) {
            const lines = block.split('\n').map(l => l.trim());
            if (lines.length < 3) continue;

            const [start, end] = lines[1]
                .split('-->')
                .map(t => parseTime(t.trim()));

            const content = lines.slice(2).join('<br>');
            temp.push({ start, end, text: content });
        }

        const result = [];
        for (let i = 0; i < temp.length; i += 2) {
            const a = temp[i];
            const b = temp[i + 1];

            if (b && a.start === b.start && a.end === b.end) {
                result.push({
                    start: a.start,
                    end: a.end,
                    line1: a.text,
                    line2: b.text
                });
            } else {
                // 容错：单语
                result.push({
                    start: a.start,
                    end: a.end,
                    line1: a.text,
                    line2: ''
                });
                i--;
            }
        }
        return result;
    }

    function parseTime(t) {
        const [h, m, s] = t.split(':');
        return (+h) * 3600 + (+m) * 60 + parseFloat(s.replace(',', '.'));
    }

    fileInput.addEventListener('change', e => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = e => {
            subtitles = parseSRT(e.target.result);
            console.log('[外挂字幕] 已加载字幕条数:', subtitles.length);
        };
        reader.readAsText(file);
    });

    /* ========== 视频时间同步 ========== */
    function bindVideo() {
        const video = document.querySelector('video');
        if (!video) return false;

        video.addEventListener('timeupdate', () => {
            const t = video.currentTime;
            const sub = subtitles.find(s => t >= s.start && t <= s.end);

            if (sub) {
                line1.innerHTML = sub.line1 || '';
                line2.innerHTML = sub.line2 || '';
            } else {
                line1.innerHTML = '';
                line2.innerHTML = '';
            }
        });
        return true;
    }

    const timer = setInterval(() => {
        if (bindVideo()) clearInterval(timer);
    }, 500);
})();
