import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig(() => {
  // Use VITE_BASE_PATH if set, otherwise default to root
  // For GitHub Pages, GitHub Actions should set this via: gh-pages branch or GITHUB_REPOSITORY
  const base = process.env.VITE_BASE_PATH || '/';
  
  return {
    base,
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
  };
})