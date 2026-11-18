import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * 字体目录 `fonts/` 里的文件要能按 `/fonts/<文件名>` 取到：
 * 桌面版由启动脚本的静态服务提供，热更新模式（Vite）这里补一条同样的路由，
 * 免得开发时字体回退成系统字形、看起来「没实装」。
 */
const FONT_MIME: Record<string, string> = {
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function fontsDirPlugin(): Plugin {
  const root = fileURLToPath(new URL("../../fonts", import.meta.url));
  return {
    name: "jeek-fonts-dir",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "/";
        if (!url.startsWith("/fonts/")) return next();
        const rel = decodeURIComponent(url.split("?")[0].slice("/fonts/".length));
        const file = path.resolve(root, rel);
        if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader("Content-Type", FONT_MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.end(fs.readFileSync(file));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), fontsDirPlugin()],
  server: { port: 5173, strictPort: false },
  build: { outDir: "dist", emptyOutDir: true },
});
