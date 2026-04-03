import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react()],
    base: "./",
    build: {
        rollupOptions: {
            input: {
                main: path.resolve(__dirname, "index.html"),
            },
            output: {
                entryFileNames: "assets/[name]-[hash].js",
                chunkFileNames: "assets/[name]-[hash].js",
                assetFileNames: "assets/[name]-[hash].[ext]",
            },
        },
    },
});
