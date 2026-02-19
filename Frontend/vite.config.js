import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
var here = path.dirname(fileURLToPath(import.meta.url));
var reactRoot = {
    // @react-three/fiber@9 has peer dep on React 19; ensure a single React copy.
    react: path.resolve(here, "..", "node_modules/react"),
    "react-dom": path.resolve(here, "..", "node_modules/react-dom")
};
export default defineConfig({
    plugins: [react()],
    resolve: {
        // Prevent "Invalid hook call" from multiple React copies.
        alias: reactRoot,
        dedupe: ["react", "react-dom"]
    },
    server: {
        port: 5173,
        strictPort: true,
        proxy: {
            "/api": {
                target: "http://localhost:8787",
                changeOrigin: true
            }
        }
    }
});
