import { AudioManager } from "./components/AudioManager";
import { ImportedSubtitlesPanel } from "./components/ImportedSubtitlesPanel";
import Transcript from "./components/Transcript";
import { TranscriberSettings } from "./components/TranscriberSettings";
import { useTranscriber } from "./hooks/useTranscriber";

// @ts-expect-error navigator.gpu may be undefined in typings
const IS_WEBGPU_AVAILABLE = !!navigator.gpu;

function App() {
    const transcriber = useTranscriber();

    return IS_WEBGPU_AVAILABLE ? (
        <div className='min-h-screen bg-gradient-to-br from-slate-100 via-white to-sky-50/60'>
            <div className='mx-auto max-w-6xl px-4 pb-16 pt-10 sm:px-6 lg:px-8'>
                <header className='mb-10 text-center'>
                    <p className='mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-sky-600'>
                        Browser · WebGPU
                    </p>
                    <h1 className='bg-gradient-to-r from-slate-900 via-slate-800 to-sky-800 bg-clip-text text-4xl font-extrabold tracking-tight text-transparent sm:text-5xl'>
                        Sidebar Whisper
                    </h1>
                    <p className='mx-auto mt-3 max-w-xl text-base text-slate-600 sm:text-lg'>
                        在浏览器中本地转写语音，数据不离开你的设备
                    </p>
                </header>

                <div className='grid gap-8 lg:grid-cols-12 lg:items-start'>
                    <aside className='lg:col-span-4'>
                        <TranscriberSettings transcriber={transcriber} />
                    </aside>
                    <div className='space-y-8 lg:col-span-8'>
                        <AudioManager transcriber={transcriber} />
                        <section className='rounded-2xl border border-slate-200/80 bg-white/90 p-5 shadow-lg shadow-slate-200/50 backdrop-blur-sm'>
                            <h2 className='mb-4 text-lg font-semibold tracking-tight text-slate-900'>
                                转写结果
                            </h2>
                            <Transcript
                                transcribedData={transcriber.output}
                                transcriber={transcriber}
                            />
                        </section>
                        <ImportedSubtitlesPanel transcriber={transcriber} />
                    </div>
                </div>
            </div>

            <footer className='border-t border-slate-200/80 bg-white/50 py-4 text-center text-sm text-slate-500'>
                Made with{" "}
                <a
                    className='font-medium text-sky-700 underline decoration-sky-300 underline-offset-2 hover:text-sky-900'
                    href='https://github.com/xenova/transformers.js'
                >
                    Transformers.js
                </a>
            </footer>
        </div>
    ) : (
        <div className='fixed z-10 flex h-screen w-screen items-center justify-center bg-black/90 text-center text-2xl font-semibold text-white'>
            <div>
                当前浏览器不支持 WebGPU
                <br />
                <span className='text-lg font-normal text-slate-300'>
                    请使用 Chrome、Edge 等支持 WebGPU 的浏览器
                </span>
            </div>
        </div>
    );
}

export default App;
