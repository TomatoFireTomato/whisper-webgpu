# Whisper Web

ML-powered speech recognition directly in your browser! Built with [🤗 Transformers.js](https://github.com/xenova/transformers.js).

Check out the demo site [here](https://huggingface.co/spaces/Xenova/whisper-webgpu).

<<<<<<< HEAD
> [!IMPORTANT]  
> Experimental WebGPU support has been added to [this branch](https://github.com/xenova/whisper-web/tree/experimental-webgpu) ([demo](https://huggingface.co/spaces/Xenova/whisper-webgpu)), if you'd like to run with GPU acceleration!

https://github.com/xenova/whisper-web/assets/26504141/fb170d84-9678-41b5-9248-a112ecc74c27
=======
https://github.com/xenova/whisper-web/assets/26504141/5d6ed3d9-5f99-4d89-8e38-9d4fc8d5baaf
>>>>>>> 4866e0eb6dd5c63a74c4ff652a6c20fca74e530a

## Running locally

1. Clone the repo and install dependencies:

    ```bash
    git clone https://github.com/xenova/whisper-web.git
    cd whisper-web
    npm install
    ```

2. Run the development server:

    ```bash
    npm run dev
    ```
    > Firefox users need to change the `dom.workers.modules.enabled` setting in `about:config` to `true` to enable Web Workers.
    > Check out [this issue](https://github.com/xenova/whisper-web/issues/8) for more details.

3. Open the link (e.g., [http://localhost:5173/](http://localhost:5173/)) in your browser.
