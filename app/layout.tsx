import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FirstMerge — good first issues that actually get merged",
  description:
    "Every other tool lists good-first-issues. FirstMerge ranks them by whether your PR will actually get merged — filtering out claimed, stale, and ghost-maintainer issues.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Apply the saved/system theme before first paint to avoid a flash. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
