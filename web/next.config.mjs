import path from "node:path";
import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: {
    // Two lockfiles live in this repo (root and web/); pin the app root
    // explicitly rather than letting Turbopack infer it. It's set one level
    // up (repo root, not web/) so app/intake can import the shared
    // intake/*.js contract files that live outside web/ — Turbopack refuses
    // to resolve anything outside its root.
    root: path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  },
};

export default nextConfig;
