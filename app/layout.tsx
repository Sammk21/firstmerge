import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";
import { Analytics } from "@vercel/analytics/next"

export const metadata: Metadata = {
  title: "FirstMerge — good first issues worth your time",
  description:
    "FirstMerge scores every good-first-issue on how likely your PR is to land — checking it's unclaimed, the repo is active, and maintainers merge outside contributions.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      {/* Apply the saved/system theme before first paint to avoid a flash.
          Raw <script> tags inside React components warn in React 19 — next/script
          with beforeInteractive is the supported way: injected into <head> of the
          initial HTML and executed before hydration. */}
      <Script id="theme-init" strategy="beforeInteractive">
        {`(function(){try{var t=localStorage.getItem('theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`}
      </Script>
       <Analytics />
      <body>{children}</body>
    </html>
  );
}
