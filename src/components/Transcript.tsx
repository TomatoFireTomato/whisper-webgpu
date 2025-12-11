import { useRef, useEffect } from "react";

import { TranscriberData } from "../hooks/useTranscriber";
import { formatAudioTimestamp } from "../utils/AudioUtils";

interface Props {
    transcribedData: TranscriberData | undefined;
}

export default function Transcript({ transcribedData }: Props) {
    const divRef = useRef<HTMLDivElement>(null);

    const saveBlob = (blob: Blob, filename: string) => {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        link.click();
        URL.revokeObjectURL(url);
    };
    let formatTime = (seconds: number): string => {
        // seconds maybe float
        if(typeof seconds !== 'number' || !isFinite(seconds)) seconds = 0;
        const totalMs = Math.round(seconds * 1000);
        const ms = totalMs % 1000;
        const totalSec = Math.floor(totalMs / 1000);
        const s = totalSec % 60;
        const m = Math.floor((totalSec % 3600) / 60);
        const h = Math.floor(totalSec / 3600);
        return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0') + ',' + String(ms).padStart(3,'0');
      }

    let jsonToSrt = (json: any): string => {
        // produce SRT, keep index order
        const lines = [];
        for(let i=0;i<json.length;i++){

          const seg = json[i];
          console.log('seg', seg);
          const start = formatTime(seg.timestamp[0]);
          const end = formatTime(seg.timestamp[1]?? start);
          // normalize text: trim and replace multiple spaces and newlines with single space
          let text = (seg.text || '').trim();
          // preserve intentional newlines encoded as \n in the text
          // but collapse repeated newlines/spaces
          text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          // ensure lines in subtitle are separated by \n
          // we will not forcibly wrap; user can edit preview if needed
          lines.push(String(i+1));
          lines.push(`${start} --> ${end}`);
          lines.push(text);
          lines.push('');
        }
        return lines.join('\n').trim() + '\n';
      }

    const exportSRT = () => {
        let jsonData = JSON.stringify(transcribedData?.chunks ?? [], null, 2);

        // post-process the JSON to make it more readable
        const regex = /( {4}"timestamp": )\[\s+(\S+)\s+(\S+)\s+\]/gm;
        jsonData = jsonData.replace(regex, "$1[$2 $3]");
        jsonData = JSON.parse(jsonData);
        // 使用过滤后的数据
        const filteredData = validateJson(jsonData);
       
        const srtData = jsonToSrt(filteredData);
        const blob = new Blob([srtData], { type: "text/srt" });
        saveBlob(blob, "transcript.srt");
    };


  const validateJson = (json: any) => {
    if(!Array.isArray(json)) throw new Error('JSON 顶层必须是数组。');
    // 过滤掉无效的项，而不是抛出错误
    return json.filter((it) => {
      // 如果缺少基本结构，过滤掉
      if(!it || !Array.isArray(it.timestamp) || it.timestamp.length < 2) return false;
      if(typeof it.text !== 'string') return false;
      // 如果 timestamp 中有非数字，过滤掉
      if(typeof it.timestamp[0] !== 'number' || typeof it.timestamp[1] !== 'number') return false;
      return true;
    });
  }

    const exportTXT = () => {
        const chunks = transcribedData?.chunks ?? [];
        const text = chunks
            .map((chunk) => chunk.text)
            .join("")
            .trim();

        const blob = new Blob([text], { type: "text/plain" });
        saveBlob(blob, "transcript.txt");
    };
    const exportJSON = () => {
        let jsonData = JSON.stringify(transcribedData?.chunks ?? [], null, 2);

        // post-process the JSON to make it more readable
        const regex = /( {4}"timestamp": )\[\s+(\S+)\s+(\S+)\s+\]/gm;
        jsonData = jsonData.replace(regex, "$1[$2 $3]");

        const blob = new Blob([jsonData], { type: "application/json" });
        saveBlob(blob, "transcript.json");
    };

    // Scroll to the bottom when the component updates
    useEffect(() => {
        if (divRef.current) {
            const diff = Math.abs(
                divRef.current.offsetHeight +
                    divRef.current.scrollTop -
                    divRef.current.scrollHeight,
            );

            if (diff <= 100) {
                // We're close enough to the bottom, so scroll to the bottom
                divRef.current.scrollTop = divRef.current.scrollHeight;
            }
        }
    });

    return (
        <div
            ref={divRef}
            className='w-full flex flex-col my-2 p-4 max-h-[20rem] overflow-y-auto'
        >
            {transcribedData?.chunks &&
                transcribedData.chunks.map((chunk, i) => (
                    <div
                        key={`${i}-${chunk.text}`}
                        className={`w-full flex flex-row mb-2 ${transcribedData?.isBusy ? "bg-gray-100" : "bg-white"} rounded-lg p-4 shadow-xl shadow-black/5 ring-1 ring-slate-700/10`}
                    >
                        <div className='mr-5'>
                            {formatAudioTimestamp(chunk.timestamp[0])}
                        </div>
                        {chunk.text}
                    </div>
                ))}
            {transcribedData?.tps && (
                <p className='text-sm text-center mt-4 mb-1'>
                    <span className='font-semibold text-black'>
                        {transcribedData?.tps.toFixed(2)}
                    </span>{" "}
                    <span className='text-gray-500'>tokens/second</span>
                </p>
            )}
            {transcribedData && !transcribedData.isBusy && (
                <div className='w-full text-right'>
                    <button
                        onClick={exportSRT}
                        className='text-white bg-green-500 hover:bg-green-600 focus:ring-4 focus:ring-green-300 font-medium rounded-lg text-sm px-4 py-2 text-center mr-2 dark:bg-green-600 dark:hover:bg-green-700 dark:focus:ring-green-800 inline-flex items-center'
                    >
                        Export SRT
                    </button>
                    <button
                        onClick={exportTXT}
                        className='text-white bg-green-500 hover:bg-green-600 focus:ring-4 focus:ring-green-300 font-medium rounded-lg text-sm px-4 py-2 text-center mr-2 dark:bg-green-600 dark:hover:bg-green-700 dark:focus:ring-green-800 inline-flex items-center'
                    >
                        Export TXT
                    </button>
                    <button
                        onClick={exportJSON}
                        className='text-white bg-green-500 hover:bg-green-600 focus:ring-4 focus:ring-green-300 font-medium rounded-lg text-sm px-4 py-2 text-center mr-2 dark:bg-green-600 dark:hover:bg-green-700 dark:focus:ring-green-800 inline-flex items-center'
                    >
                        Export JSON
                    </button>
                </div>
            )}
        </div>
    );
}
