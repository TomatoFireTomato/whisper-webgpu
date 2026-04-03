/**
 * 提示用户前往 Cobalt 网页自行解析并下载音频，再回到本扩展上传转写。
 * （扩展内不再请求 Cobalt API，避免 Cloudflare 等限制。）
 */
export function CobaltPageAudio() {
    return (
        <div className='rounded-xl border border-violet-200/80 bg-violet-50/40 p-4'>
            <h3 className='mb-2 text-sm font-semibold text-slate-800'>
                从网页视频获取音频
            </h3>
            <p className='text-xs leading-relaxed text-slate-600'>
                请在新标签页打开{" "}
                <a
                    className='font-medium text-violet-700 underline decoration-violet-300 underline-offset-2 hover:text-violet-900'
                    href='https://cobalt.tools/'
                    target='_blank'
                    rel='noreferrer'
                >
                    Cobalt
                </a>
                ，粘贴视频页链接并选择仅下载音频；下载完成后回到此处，用上方「点击或拖拽」上传该音频文件即可转写。使用第三方服务时请遵守其条款与版权规定。
            </p>
        </div>
    );
}
