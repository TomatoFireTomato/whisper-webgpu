import Constants from "../utils/Constants";
import { Transcriber } from "../hooks/useTranscriber";
import {
    isTranslationServiceId,
    TRANSLATION_SERVICE_OPTIONS,
} from "../utils/subtitleTranslate";

function titleCase(str: string) {
    str = str.toLowerCase();
    return (str.match(/\w+.?/g) || [])
        .map((word) => {
            return word.charAt(0).toUpperCase() + word.slice(1);
        })
        .join("");
}

const LANGUAGES = {
    en: "english",
    zh: "chinese",
    de: "german",
    es: "spanish/castilian",
    ru: "russian",
    ko: "korean",
    fr: "french",
    ja: "japanese",
    pt: "portuguese",
    tr: "turkish",
    pl: "polish",
    ca: "catalan/valencian",
    nl: "dutch/flemish",
    ar: "arabic",
    sv: "swedish",
    it: "italian",
    id: "indonesian",
    hi: "hindi",
    fi: "finnish",
    vi: "vietnamese",
    he: "hebrew",
    uk: "ukrainian",
    el: "greek",
    ms: "malay",
    cs: "czech",
    ro: "romanian/moldavian/moldovan",
    da: "danish",
    hu: "hungarian",
    ta: "tamil",
    no: "norwegian",
    th: "thai",
    ur: "urdu",
    hr: "croatian",
    bg: "bulgarian",
    lt: "lithuanian",
    la: "latin",
    mi: "maori",
    ml: "malayalam",
    cy: "welsh",
    sk: "slovak",
    te: "telugu",
    fa: "persian",
    lv: "latvian",
    bn: "bengali",
    sr: "serbian",
    az: "azerbaijani",
    sl: "slovenian",
    kn: "kannada",
    et: "estonian",
    mk: "macedonian",
    br: "breton",
    eu: "basque",
    is: "icelandic",
    hy: "armenian",
    ne: "nepali",
    mn: "mongolian",
    bs: "bosnian",
    kk: "kazakh",
    sq: "albanian",
    sw: "swahili",
    gl: "galician",
    mr: "marathi",
    pa: "punjabi/panjabi",
    si: "sinhala/sinhalese",
    km: "khmer",
    sn: "shona",
    yo: "yoruba",
    so: "somali",
    af: "afrikaans",
    oc: "occitan",
    ka: "georgian",
    be: "belarusian",
    tg: "tajik",
    sd: "sindhi",
    gu: "gujarati",
    am: "amharic",
    yi: "yiddish",
    lo: "lao",
    uz: "uzbek",
    fo: "faroese",
    ht: "haitian creole/haitian",
    ps: "pashto/pushto",
    tk: "turkmen",
    nn: "nynorsk",
    mt: "maltese",
    sa: "sanskrit",
    lb: "luxembourgish/letzeburgesch",
    my: "myanmar/burmese",
    bo: "tibetan",
    tl: "tagalog",
    mg: "malagasy",
    as: "assamese",
    tt: "tatar",
    haw: "hawaiian",
    ln: "lingala",
    ha: "hausa",
    ba: "bashkir",
    jw: "javanese",
    su: "sundanese",
};

const MODELS = Object.entries({
    "onnx-community/whisper-tiny": 120,
    "onnx-community/whisper-base": 206,
    "onnx-community/whisper-small": 586,
    "onnx-community/whisper-large-v3-turbo": 1604,
    "onnx-community/distil-small.en": 538,
});

const selectClass =
    "mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 shadow-sm outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-200";

const labelClass = "text-xs font-semibold uppercase tracking-wide text-slate-500";

export function TranscriberSettings(props: { transcriber: Transcriber }) {
    const names = Object.values(LANGUAGES).map(titleCase);

    const models = MODELS.filter(
        ([key]) =>
            !props.transcriber.multilingual || !key.includes("/distil-"),
    ).map(([key, value]) => ({
        key,
        size: value,
        id: `${key}${props.transcriber.multilingual || key.includes("/distil-") ? "" : ".en"}`,
    }));

    return (
        <section className='rounded-2xl border border-slate-200/80 bg-white/90 p-5 shadow-lg shadow-slate-200/50 backdrop-blur-sm lg:sticky lg:top-8'>
            <h2 className='mb-1 text-lg font-semibold tracking-tight text-slate-900'>
                转写配置
            </h2>
            <p className='mb-4 text-xs text-slate-500'>
                以下选项会保存在本机浏览器；关闭侧边栏再打开仍会恢复。
            </p>
            <div className='space-y-4'>
                <div>
                    <label className={labelClass} htmlFor='model-select'>
                        模型
                    </label>
                    <select
                        id='model-select'
                        className={selectClass}
                        value={props.transcriber.model}
                        onChange={(e) => {
                            props.transcriber.setModel(e.target.value);
                        }}
                    >
                        {models.map(({ key, id, size }) => (
                            <option key={key} value={id}>
                                {`${id} (${size}MB)`}
                            </option>
                        ))}
                    </select>
                </div>

                <div className='flex items-center justify-between gap-3 rounded-xl border border-slate-100 bg-slate-50/80 px-3 py-2.5'>
                    <div>
                        <label
                            htmlFor='hf-mirror'
                            className='text-sm font-medium text-slate-700'
                        >
                            使用国内镜像下载模型
                        </label>
                        <p className='mt-0.5 text-xs text-slate-500'>
                            默认从 Hugging Face 官方；勾选后使用 hf-mirror.com
                        </p>
                    </div>
                    <input
                        id='hf-mirror'
                        type='checkbox'
                        className='h-4 w-4 shrink-0 rounded border-slate-300 text-sky-600 focus:ring-sky-500'
                        checked={props.transcriber.useHfMirror}
                        onChange={(e) => {
                            props.transcriber.setUseHfMirror(e.target.checked);
                        }}
                    />
                </div>

                <div className='rounded-xl border border-slate-100 bg-slate-50/80 px-3 py-2.5'>
                    <p className='text-sm font-medium text-slate-700'>
                        B 站双语字幕
                    </p>
                    <p className='mt-0.5 text-xs text-slate-500'>
                        在 B 站视频页点「发送字幕到当前页」时，扩展会先用所选服务批量翻译，再在播放器上叠加显示（与沉浸式「先整轨翻译、再按时间轴显示」一致）。多语言模式下「源语言」用于翻译方向；关闭多语言时按英文转写源文译成中文。
                    </p>
                    <label
                        className={`${labelClass} mt-3 block`}
                        htmlFor='subtitle-translate-service'
                    >
                        字幕翻译服务
                    </label>
                    <select
                        id='subtitle-translate-service'
                        className={selectClass}
                        value={props.transcriber.subtitleTranslateService}
                        onChange={(e) => {
                            const v = e.target.value;
                            if (isTranslationServiceId(v)) {
                                props.transcriber.setSubtitleTranslateService(v);
                            }
                        }}
                    >
                        {TRANSLATION_SERVICE_OPTIONS.map((o) => (
                            <option key={o.id} value={o.id} title={o.hint}>
                                {o.label}
                            </option>
                        ))}
                    </select>
                    <p className='mt-1 text-xs text-slate-400'>
                        {
                            TRANSLATION_SERVICE_OPTIONS.find(
                                (o) =>
                                    o.id ===
                                    props.transcriber.subtitleTranslateService,
                            )?.hint
                        }
                    </p>
                </div>

                <div className='flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50/80 px-3 py-2.5'>
                    <label
                        htmlFor='multilingual'
                        className='text-sm font-medium text-slate-700'
                    >
                        多语言模式
                    </label>
                    <input
                        id='multilingual'
                        type='checkbox'
                        className='h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500'
                        checked={props.transcriber.multilingual}
                        onChange={(e) => {
                            let model = Constants.DEFAULT_MODEL;
                            if (!e.target.checked) {
                                model += ".en";
                            }
                            props.transcriber.setModel(model);
                            props.transcriber.setMultilingual(e.target.checked);
                        }}
                    />
                </div>

                {props.transcriber.multilingual && (
                    <>
                        <div>
                            <label className={labelClass} htmlFor='lang-select'>
                                源语言
                            </label>
                            <select
                                id='lang-select'
                                className={selectClass}
                                value={props.transcriber.language}
                                onChange={(e) => {
                                    props.transcriber.setLanguage(e.target.value);
                                }}
                            >
                                {Object.keys(LANGUAGES).map((key, i) => (
                                    <option key={key} value={key}>
                                        {names[i]}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </>
                )}
            </div>
        </section>
    );
}
