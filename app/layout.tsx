import type { Metadata } from "next";
import "./globals.css";

const fontFamily = '"Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif';

export const metadata: Metadata = {
  title: "LLM Benchmark | Local Inference",
  description: "Diagnóstico en tiempo real de modelos de lenguaje locales.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es" className="h-full antialiased">
      <body className="min-h-full flex flex-col" style={{ fontFamily }}>
        <head>
          <link
            href="https://fonts.googleapis.com/icon?family=Material+Icons"
            rel="stylesheet"
          />
        </head>
        {children}
      </body>
    </html>
  );
}
