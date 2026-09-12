const { defineConfig } = require("vite");
const vue = require("@vitejs/plugin-vue");

module.exports = defineConfig({
    base: "/",
    build: {
        assetsDir: "assets",
        emptyOutDir: true,
        outDir: "../dist",
        sourcemap: false,
    },
    plugins: [vue()],
    publicDir: false,
    root: "ui-public/app",
    server: {
        host: true,
        port: 5174,
        strictPort: true,
    },
});
