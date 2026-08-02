import path from "node:path";
import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: {
    // Two lockfiles live in this repo (root and web/); pin the app root so
    // Turbopack doesn't infer the workspace root from the wrong one.
    root: path.dirname(fileURLToPath(import.meta.url)),
  },
};

export default nextConfig;
