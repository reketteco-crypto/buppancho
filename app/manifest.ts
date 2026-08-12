import type { MetadataRoute } from "next";
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "物販帳",
    short_name: "物販帳",
    description: "夫婦で使う物販・在庫・会計管理アプリ",
    start_url: "/",
    display: "standalone",
    background_color: "#f7f7f2",
    theme_color: "#176b52",
    lang: "ja",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
